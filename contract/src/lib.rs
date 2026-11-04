//! AgentBond: an AI agent can only spend what a human has put at stake for it.
//!
//! Flow:
//!   1. A sponsor calls `register_agent`, attaching a bond (collateral) plus a spending budget.
//!   2. The agent calls `request_payment`. Small payments go out instantly; larger ones are
//!      escrowed in a challenge window. How much can be in flight at once is capped by the bond
//!      and grows with the agent's reputation.
//!   3. Anyone can `challenge` a pending payment (with a small stake). The guardian then
//!      `resolve`s it. If upheld: payment is cancelled, the bond is slashed, the agent is frozen.
//!   4. Unchallenged payments are released by `finalize` after the window and raise reputation.

use near_sdk::json_types::U64;
use near_sdk::serde_json::json;
use near_sdk::store::IterableMap;
use near_sdk::{env, near, require, AccountId, NearToken, PanicOnDefault, Promise};

const ZERO: NearToken = NearToken::from_yoctonear(0);
const CHALLENGE_STAKE: NearToken = NearToken::from_millinear(100); // 0.1 NEAR
const DAY_NS: u64 = 86_400_000_000_000;
const SECOND_NS: u64 = 1_000_000_000;
const SLASH_BPS: u128 = 2_500; // 25% of the bond per upheld challenge
const MAX_REPUTATION: i32 = 50;
const REPUTATION_PENALTY: i32 = 10;
const MAX_EVIDENCE_LEN: usize = 1_000;
const MAX_MEMO_LEN: usize = 280;

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Policy {
    /// Payments up to this size are paid immediately, with no challenge window.
    pub instant_limit: NearToken,
    /// Hard cap for a single payment.
    pub max_payment: NearToken,
    /// Max total the agent may pay out per UTC day.
    pub daily_limit: NearToken,
    /// How long larger payments wait before they can be finalized.
    pub challenge_window_secs: u64,
    /// If non-empty, the agent may only pay these accounts.
    pub allowlist: Vec<AccountId>,
    /// The agent may never pay these accounts.
    pub denylist: Vec<AccountId>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Agent {
    pub sponsor: AccountId,
    pub bond: NearToken,
    pub budget: NearToken,
    pub policy: Policy,
    pub frozen: bool,
    pub reputation: i32,
    pub spent_today: NearToken,
    pub day: u64,
    pub pending_count: u32,
    pub pending_total: NearToken,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, PartialEq, Debug)]
pub enum PaymentStatus {
    Pending,
    Challenged,
    Paid,
    Rejected,
}

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Payment {
    pub id: u64,
    pub agent: AccountId,
    pub to: AccountId,
    pub amount: NearToken,
    pub memo: String,
    pub status: PaymentStatus,
    pub created_at: U64,
    pub unlocks_at: U64,
    pub challenger: Option<AccountId>,
    pub evidence: Option<String>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    guardian: AccountId,
    agents: IterableMap<AccountId, Agent>,
    payments: IterableMap<u64, Payment>,
    next_payment_id: u64,
    insurance_pool: NearToken,
}

#[near]
impl Contract {
    #[init]
    pub fn new(guardian: AccountId) -> Self {
        Self {
            guardian,
            agents: IterableMap::new(b"a".to_vec()),
            payments: IterableMap::new(b"p".to_vec()),
            next_payment_id: 0,
            insurance_pool: ZERO,
        }
    }

    // ---------------------------------------------------------------- sponsor

    /// Stake a bond for `agent_id`. The attached deposit must cover `bond`; whatever is left
    /// over becomes the agent's spendable budget.
    #[payable]
    pub fn register_agent(&mut self, agent_id: AccountId, bond: NearToken, policy: Policy) {
        let sponsor = env::predecessor_account_id();
        let deposit = env::attached_deposit();
        require!(self.agents.get(&agent_id).is_none(), "agent already registered");
        require!(sponsor != agent_id, "sponsor and agent must be different accounts");
        require!(bond > ZERO, "bond must be greater than zero");
        require!(deposit >= bond, "attached deposit must cover the bond");
        require!(
            policy.instant_limit <= policy.max_payment && policy.max_payment <= policy.daily_limit,
            "policy must satisfy instant_limit <= max_payment <= daily_limit"
        );

        let budget = deposit.saturating_sub(bond);
        self.agents.insert(
            agent_id.clone(),
            Agent {
                sponsor: sponsor.clone(),
                bond,
                budget,
                policy,
                frozen: false,
                reputation: 0,
                spent_today: ZERO,
                day: env::block_timestamp() / DAY_NS,
                pending_count: 0,
                pending_total: ZERO,
            },
        );
        log_event(
            "agent_registered",
            json!({ "agent": agent_id, "sponsor": sponsor, "bond": bond, "budget": budget }),
        );
    }

    /// Add spendable budget for an agent (sponsor only).
    #[payable]
    pub fn top_up(&mut self, agent_id: AccountId) {
        let agent = self.agent_mut(&agent_id);
        require!(env::predecessor_account_id() == agent.sponsor, "only the sponsor can top up");
        agent.budget = agent.budget.saturating_add(env::attached_deposit());
    }

    /// Un-freeze an agent after a slash (sponsor only). The bond stays reduced.
    pub fn unfreeze(&mut self, agent_id: AccountId) {
        let agent = self.agent_mut(&agent_id);
        require!(env::predecessor_account_id() == agent.sponsor, "only the sponsor can unfreeze");
        agent.frozen = false;
        log_event("agent_unfrozen", json!({ "agent": agent_id }));
    }

    /// Withdraw bond and remaining budget and remove the agent (sponsor only).
    /// Requires that nothing is still in the challenge window.
    pub fn unstake(&mut self, agent_id: AccountId) -> Promise {
        let agent = self.agent_mut(&agent_id).clone();
        require!(env::predecessor_account_id() == agent.sponsor, "only the sponsor can unstake");
        require!(agent.pending_count == 0, "agent still has pending payments");
        self.agents.remove(&agent_id);
        let refund = agent.bond.saturating_add(agent.budget);
        log_event("agent_unstaked", json!({ "agent": agent_id, "refund": refund }));
        Promise::new(agent.sponsor).transfer(refund)
    }

    // ------------------------------------------------------------------ agent

    /// Called by the agent account. Returns the payment id.
    pub fn request_payment(&mut self, to: AccountId, amount: NearToken, memo: String) -> u64 {
        let agent_id = env::predecessor_account_id();
        require!(memo.len() <= MAX_MEMO_LEN, "memo too long");
        require!(amount > ZERO, "amount must be greater than zero");

        let now = env::block_timestamp();
        let id = self.next_payment_id;
        let agent = self
            .agents
            .get_mut(&agent_id)
            .unwrap_or_else(|| env::panic_str("caller is not a registered agent"));

        require!(!agent.frozen, "agent is frozen");
        require!(amount <= agent.policy.max_payment, "amount above max_payment");
        require!(amount <= agent.budget, "insufficient budget");
        require!(
            agent.policy.allowlist.is_empty() || agent.policy.allowlist.contains(&to),
            "recipient not on allowlist"
        );
        require!(!agent.policy.denylist.contains(&to), "recipient is denylisted");

        let today = now / DAY_NS;
        if agent.day != today {
            agent.day = today;
            agent.spent_today = ZERO;
        }
        let spent = agent.spent_today.saturating_add(amount);
        require!(spent <= agent.policy.daily_limit, "daily limit exceeded");

        let instant = amount <= agent.policy.instant_limit;
        if !instant {
            let in_flight = agent.pending_total.saturating_add(amount);
            require!(
                in_flight <= exposure_cap(agent),
                "payment would exceed what the bond backs"
            );
        }

        agent.budget = agent.budget.saturating_sub(amount);
        agent.spent_today = spent;

        let (status, unlocks_at) = if instant {
            (PaymentStatus::Paid, now)
        } else {
            agent.pending_count += 1;
            agent.pending_total = agent.pending_total.saturating_add(amount);
            (
                PaymentStatus::Pending,
                now + agent.policy.challenge_window_secs * SECOND_NS,
            )
        };

        self.next_payment_id += 1;
        self.payments.insert(
            id,
            Payment {
                id,
                agent: agent_id.clone(),
                to: to.clone(),
                amount,
                memo,
                status,
                created_at: U64(now),
                unlocks_at: U64(unlocks_at),
                challenger: None,
                evidence: None,
            },
        );
        log_event(
            if instant { "payment_paid" } else { "payment_pending" },
            json!({ "id": id, "agent": agent_id, "to": to, "amount": amount }),
        );
        if instant {
            let _ = Promise::new(to).transfer(amount);
        }
        id
    }

    // -------------------------------------------------------- challenge / settle

    /// Anyone can challenge a pending payment while its window is open, by attaching the
    /// challenge stake (0.1 NEAR). Excess deposit is refunded.
    #[payable]
    pub fn challenge(&mut self, payment_id: u64, evidence: String) {
        let deposit = env::attached_deposit();
        require!(deposit >= CHALLENGE_STAKE, "attach the 0.1 NEAR challenge stake");
        require!(evidence.len() <= MAX_EVIDENCE_LEN, "evidence too long");
        let challenger = env::predecessor_account_id();
        let now = env::block_timestamp();

        let payment = self
            .payments
            .get_mut(&payment_id)
            .unwrap_or_else(|| env::panic_str("no such payment"));
        require!(payment.status == PaymentStatus::Pending, "payment is not pending");
        require!(now < payment.unlocks_at.0, "challenge window has closed");

        payment.status = PaymentStatus::Challenged;
        payment.challenger = Some(challenger.clone());
        payment.evidence = Some(evidence);
        log_event(
            "payment_challenged",
            json!({ "id": payment_id, "challenger": challenger }),
        );

        let excess = deposit.saturating_sub(CHALLENGE_STAKE);
        if excess > ZERO {
            let _ = Promise::new(challenger).transfer(excess);
        }
    }

    /// Guardian decides a challenge.
    /// upheld = true : payment cancelled and refunded to the agent's budget, bond slashed
    ///                 (half to the challenger, half to the insurance pool), agent frozen.
    /// upheld = false: payment is released to the recipient and the challenger's stake goes
    ///                 to the insurance pool.
    pub fn resolve(&mut self, payment_id: u64, upheld: bool) {
        require!(env::predecessor_account_id() == self.guardian, "only the guardian can resolve");

        let payment = self
            .payments
            .get_mut(&payment_id)
            .unwrap_or_else(|| env::panic_str("no such payment"));
        require!(payment.status == PaymentStatus::Challenged, "payment is not challenged");
        let agent = self
            .agents
            .get_mut(&payment.agent)
            .unwrap_or_else(|| env::panic_str("agent missing"));
        let challenger = payment
            .challenger
            .clone()
            .unwrap_or_else(|| env::panic_str("challenger missing"));

        agent.pending_count -= 1;
        agent.pending_total = agent.pending_total.saturating_sub(payment.amount);

        if upheld {
            payment.status = PaymentStatus::Rejected;
            agent.budget = agent.budget.saturating_add(payment.amount);

            let slash = NearToken::from_yoctonear(agent.bond.as_yoctonear() * SLASH_BPS / 10_000);
            agent.bond = agent.bond.saturating_sub(slash);
            agent.frozen = true;
            agent.reputation = (agent.reputation - REPUTATION_PENALTY).max(-MAX_REPUTATION);

            let reward = NearToken::from_yoctonear(slash.as_yoctonear() / 2);
            self.insurance_pool = self
                .insurance_pool
                .saturating_add(slash.saturating_sub(reward));
            log_event(
                "agent_slashed",
                json!({
                    "id": payment_id, "agent": payment.agent, "slashed": slash,
                    "challenger_reward": reward, "reputation": agent.reputation
                }),
            );
            let _ = Promise::new(challenger).transfer(CHALLENGE_STAKE.saturating_add(reward));
        } else {
            payment.status = PaymentStatus::Paid;
            agent.reputation = (agent.reputation + 1).min(MAX_REPUTATION);
            self.insurance_pool = self.insurance_pool.saturating_add(CHALLENGE_STAKE);
            log_event(
                "challenge_rejected",
                json!({ "id": payment_id, "agent": payment.agent }),
            );
            let _ = Promise::new(payment.to.clone()).transfer(payment.amount);
        }
    }

    /// Release an unchallenged payment once its window has passed. Anyone can call this.
    pub fn finalize(&mut self, payment_id: u64) {
        let now = env::block_timestamp();
        let payment = self
            .payments
            .get_mut(&payment_id)
            .unwrap_or_else(|| env::panic_str("no such payment"));
        require!(payment.status == PaymentStatus::Pending, "payment is not pending");
        require!(now >= payment.unlocks_at.0, "challenge window still open");
        let agent = self
            .agents
            .get_mut(&payment.agent)
            .unwrap_or_else(|| env::panic_str("agent missing"));

        payment.status = PaymentStatus::Paid;
        agent.pending_count -= 1;
        agent.pending_total = agent.pending_total.saturating_sub(payment.amount);
        agent.reputation = (agent.reputation + 1).min(MAX_REPUTATION);
        log_event(
            "payment_paid",
            json!({ "id": payment_id, "agent": payment.agent, "to": payment.to, "amount": payment.amount }),
        );
        let _ = Promise::new(payment.to.clone()).transfer(payment.amount);
    }

    // ------------------------------------------------------------------ views

    pub fn get_agent(&self, agent_id: AccountId) -> Option<Agent> {
        self.agents.get(&agent_id).cloned()
    }

    pub fn list_agents(&self, from_index: u32, limit: u32) -> Vec<(AccountId, Agent)> {
        self.agents
            .iter()
            .skip(from_index as usize)
            .take(limit as usize)
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }

    pub fn get_payment(&self, payment_id: u64) -> Option<Payment> {
        self.payments.get(&payment_id).cloned()
    }

    /// Newest payments first.
    pub fn recent_payments(&self, limit: u32) -> Vec<Payment> {
        let mut out = Vec::new();
        let mut id = self.next_payment_id;
        while id > 0 && out.len() < limit as usize {
            id -= 1;
            if let Some(p) = self.payments.get(&id) {
                out.push(p.clone());
            }
        }
        out
    }

    /// How much value the agent may have in the challenge window at once.
    pub fn get_exposure_cap(&self, agent_id: AccountId) -> NearToken {
        exposure_cap(self.agents.get(&agent_id).unwrap_or_else(|| env::panic_str("no such agent")))
    }

    pub fn get_guardian(&self) -> AccountId {
        self.guardian.clone()
    }

    pub fn get_insurance_pool(&self) -> NearToken {
        self.insurance_pool
    }
}

impl Contract {
    fn agent_mut(&mut self, agent_id: &AccountId) -> &mut Agent {
        self.agents
            .get_mut(agent_id)
            .unwrap_or_else(|| env::panic_str("no such agent"))
    }
}

/// bond x (1.0 .. 3.0), scaling with reputation (0..=20 counts).
fn exposure_cap(agent: &Agent) -> NearToken {
    let boost = agent.reputation.clamp(0, 20) as u128;
    NearToken::from_yoctonear(agent.bond.as_yoctonear() / 10 * (10 + boost))
}

fn log_event(event: &str, data: near_sdk::serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({ "standard": "agent-bond", "version": "1.0.0", "event": event, "data": data })
    ));
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;

    const WINDOW_SECS: u64 = 60;

    fn guardian() -> AccountId { accounts(0) }
    fn sponsor() -> AccountId { accounts(1) }
    fn agent() -> AccountId { accounts(2) }
    fn vendor() -> AccountId { accounts(3) }
    fn attacker() -> AccountId { accounts(4) }

    fn near(n: u128) -> NearToken { NearToken::from_near(n) }

    fn ctx(who: AccountId, deposit: NearToken, ts: u64) -> VMContextBuilder {
        let mut b = VMContextBuilder::new();
        b.predecessor_account_id(who)
            .attached_deposit(deposit)
            .block_timestamp(ts);
        b
    }

    fn policy() -> Policy {
        Policy {
            instant_limit: near(1),
            max_payment: near(10),
            daily_limit: near(20),
            challenge_window_secs: WINDOW_SECS,
            allowlist: vec![],
            denylist: vec![],
        }
    }

    /// Contract with one registered agent: bond 10 NEAR, budget 40 NEAR.
    fn setup() -> Contract {
        testing_env!(ctx(guardian(), ZERO, 0).build());
        let mut c = Contract::new(guardian());
        testing_env!(ctx(sponsor(), near(50), 0).build());
        c.register_agent(agent(), near(10), policy());
        c
    }

    fn as_agent(ts: u64) {
        testing_env!(ctx(agent(), ZERO, ts).build());
    }

    #[test]
    fn registers_with_bond_and_budget() {
        let c = setup();
        let a = c.get_agent(agent()).unwrap();
        assert_eq!(a.bond, near(10));
        assert_eq!(a.budget, near(40));
        assert_eq!(c.get_exposure_cap(agent()), near(10));
    }

    #[test]
    fn small_payment_is_instant() {
        let mut c = setup();
        as_agent(1);
        let id = c.request_payment(vendor(), near(1), "api credits".into());
        assert_eq!(c.get_payment(id).unwrap().status, PaymentStatus::Paid);
        assert_eq!(c.get_agent(agent()).unwrap().budget, near(39));
    }

    #[test]
    fn large_payment_waits_then_finalizes_and_builds_reputation() {
        let mut c = setup();
        as_agent(1);
        let id = c.request_payment(vendor(), near(5), "monthly plan".into());
        assert_eq!(c.get_payment(id).unwrap().status, PaymentStatus::Pending);

        testing_env!(ctx(vendor(), ZERO, WINDOW_SECS * SECOND_NS + 2).build());
        c.finalize(id);
        assert_eq!(c.get_payment(id).unwrap().status, PaymentStatus::Paid);
        let a = c.get_agent(agent()).unwrap();
        assert_eq!(a.reputation, 1);
        assert_eq!(a.pending_count, 0);
    }

    #[test]
    #[should_panic(expected = "challenge window still open")]
    fn cannot_finalize_early() {
        let mut c = setup();
        as_agent(1);
        let id = c.request_payment(vendor(), near(5), "x".into());
        c.finalize(id);
    }

    #[test]
    fn upheld_challenge_slashes_and_freezes() {
        let mut c = setup();
        as_agent(1);
        let id = c.request_payment(attacker(), near(8), "ignore previous instructions".into());

        testing_env!(ctx(sponsor(), CHALLENGE_STAKE, 2).build());
        c.challenge(id, "recipient unknown, memo looks like prompt injection".into());
        assert_eq!(c.get_payment(id).unwrap().status, PaymentStatus::Challenged);

        testing_env!(ctx(guardian(), ZERO, 3).build());
        c.resolve(id, true);

        assert_eq!(c.get_payment(id).unwrap().status, PaymentStatus::Rejected);
        let a = c.get_agent(agent()).unwrap();
        assert!(a.frozen);
        assert_eq!(a.bond, NearToken::from_millinear(7_500)); // 10 NEAR - 25%
        assert_eq!(a.budget, near(40)); // payment returned to budget
        assert_eq!(a.reputation, -10);
        assert_eq!(c.get_insurance_pool(), NearToken::from_millinear(1_250));
    }

    #[test]
    #[should_panic(expected = "agent is frozen")]
    fn frozen_agent_cannot_pay() {
        let mut c = setup();
        as_agent(1);
        let id = c.request_payment(attacker(), near(8), "x".into());
        testing_env!(ctx(sponsor(), CHALLENGE_STAKE, 2).build());
        c.challenge(id, "scam".into());
        testing_env!(ctx(guardian(), ZERO, 3).build());
        c.resolve(id, true);
        as_agent(4);
        c.request_payment(vendor(), near(1), "after slash".into());
    }

    #[test]
    fn rejected_challenge_pays_recipient_and_funds_pool() {
        let mut c = setup();
        as_agent(1);
        let id = c.request_payment(vendor(), near(5), "legit".into());
        testing_env!(ctx(sponsor(), CHALLENGE_STAKE, 2).build());
        c.challenge(id, "false alarm".into());
        testing_env!(ctx(guardian(), ZERO, 3).build());
        c.resolve(id, false);

        assert_eq!(c.get_payment(id).unwrap().status, PaymentStatus::Paid);
        assert!(!c.get_agent(agent()).unwrap().frozen);
        assert_eq!(c.get_insurance_pool(), CHALLENGE_STAKE);
    }

    #[test]
    #[should_panic(expected = "only the guardian can resolve")]
    fn only_guardian_resolves() {
        let mut c = setup();
        as_agent(1);
        let id = c.request_payment(vendor(), near(5), "x".into());
        testing_env!(ctx(sponsor(), CHALLENGE_STAKE, 2).build());
        c.challenge(id, "x".into());
        c.resolve(id, true); // still the sponsor
    }

    #[test]
    #[should_panic(expected = "payment would exceed what the bond backs")]
    fn bond_limits_pending_exposure() {
        let mut c = setup();
        as_agent(1);
        c.request_payment(vendor(), near(6), "a".into());
        c.request_payment(vendor(), near(6), "b".into()); // 12 > 10 NEAR bond cap
    }

    #[test]
    #[should_panic(expected = "daily limit exceeded")]
    fn daily_limit_enforced() {
        let mut c = setup();
        as_agent(1);
        for _ in 0..21 {
            c.request_payment(vendor(), near(1), "drip".into());
        }
    }

    #[test]
    #[should_panic(expected = "recipient is denylisted")]
    fn denylist_blocks_payment() {
        testing_env!(ctx(guardian(), ZERO, 0).build());
        let mut c = Contract::new(guardian());
        let mut p = policy();
        p.denylist = vec![attacker()];
        testing_env!(ctx(sponsor(), near(50), 0).build());
        c.register_agent(agent(), near(10), p);
        as_agent(1);
        c.request_payment(attacker(), near(1), "x".into());
    }

    #[test]
    fn unstake_returns_everything_when_idle() {
        let mut c = setup();
        testing_env!(ctx(sponsor(), ZERO, 5).build());
        let _ = c.unstake(agent());
        assert!(c.get_agent(agent()).is_none());
    }
}
