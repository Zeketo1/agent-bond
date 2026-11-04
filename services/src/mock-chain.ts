// In-memory stand-in for the contract, for offline demos and tests. It mirrors the rules in
// contract/src/lib.rs (limits, bond-backed exposure cap, challenge window, 25% slash). The real
// contract is the source of truth; this exists so the guardian and agent can be developed and
// tested without a network.

import type { BondChain } from "./chain.js";
import { nearToYocto, type Agent, type Payment, type Policy } from "./types.js";

const CHALLENGE_STAKE = nearToYocto("0.1");
const SLASH_BPS = 2500n;
const MAX_REP = 50;
const DAY_SECS = 86_400;

export class MockLedger {
  nowSecs = 1_000_000;
  agents = new Map<string, Agent>();
  payments: Payment[] = [];
  insurancePool = 0n;
  /** Everything sent out of the contract, for assertions and demo output. */
  transfers: { to: string; amount: bigint; why: string }[] = [];

  constructor(public guardian: string) {}

  advance(secs: number) {
    this.nowSecs += secs;
  }

  registerAgent(sponsor: string, agentId: string, bondNear: string, budgetNear: string, policy: Policy) {
    this.agents.set(agentId, {
      sponsor,
      bond: nearToYocto(bondNear).toString(),
      budget: nearToYocto(budgetNear).toString(),
      policy,
      frozen: false,
      reputation: 0,
      spent_today: "0",
      day: Math.floor(this.nowSecs / DAY_SECS),
      pending_count: 0,
      pending_total: "0",
    });
  }

  as(actor: string): BondChain {
    return new MockChain(this, actor);
  }
}

class MockChain implements BondChain {
  constructor(private l: MockLedger, private actor: string) {}

  async recentPayments(limit: number) {
    return structuredClone(this.l.payments.slice(-limit).reverse());
  }

  async getAgent(agentId: string) {
    const a = this.l.agents.get(agentId);
    return a ? structuredClone(a) : null;
  }

  async requestPayment(to: string, amount: bigint, memo: string) {
    const a = this.l.agents.get(this.actor);
    if (!a) throw new Error("caller is not a registered agent");
    if (a.frozen) throw new Error("agent is frozen");
    if (amount > BigInt(a.policy.max_payment)) throw new Error("amount above max_payment");
    if (amount > BigInt(a.budget)) throw new Error("insufficient budget");
    if (a.policy.allowlist.length && !a.policy.allowlist.includes(to)) {
      throw new Error("recipient not on allowlist");
    }
    if (a.policy.denylist.includes(to)) throw new Error("recipient is denylisted");

    const today = Math.floor(this.l.nowSecs / DAY_SECS);
    if (a.day !== today) {
      a.day = today;
      a.spent_today = "0";
    }
    const spent = BigInt(a.spent_today) + amount;
    if (spent > BigInt(a.policy.daily_limit)) throw new Error("daily limit exceeded");

    const instant = amount <= BigInt(a.policy.instant_limit);
    if (!instant) {
      const boost = BigInt(Math.min(Math.max(a.reputation, 0), 20));
      const cap = (BigInt(a.bond) / 10n) * (10n + boost);
      if (BigInt(a.pending_total) + amount > cap) {
        throw new Error("payment would exceed what the bond backs");
      }
    }

    a.budget = (BigInt(a.budget) - amount).toString();
    a.spent_today = spent.toString();
    const id = this.l.payments.length;
    const now = this.l.nowSecs;
    if (instant) {
      this.l.transfers.push({ to, amount, why: "instant payment" });
    } else {
      a.pending_count += 1;
      a.pending_total = (BigInt(a.pending_total) + amount).toString();
    }
    this.l.payments.push({
      id,
      agent: this.actor,
      to,
      amount: amount.toString(),
      memo,
      status: instant ? "Paid" : "Pending",
      created_at: (BigInt(now) * 1_000_000_000n).toString(),
      unlocks_at: (BigInt(instant ? now : now + a.policy.challenge_window_secs) * 1_000_000_000n).toString(),
      challenger: null,
      evidence: null,
    });
    return id;
  }

  async challenge(paymentId: number, evidence: string) {
    const p = this.l.payments[paymentId];
    if (!p) throw new Error("no such payment");
    if (p.status !== "Pending") throw new Error("payment is not pending");
    if (BigInt(this.l.nowSecs) * 1_000_000_000n >= BigInt(p.unlocks_at)) {
      throw new Error("challenge window has closed");
    }
    p.status = "Challenged";
    p.challenger = this.actor;
    p.evidence = evidence;
  }

  async resolve(paymentId: number, upheld: boolean) {
    if (this.actor !== this.l.guardian) throw new Error("only the guardian can resolve");
    const p = this.l.payments[paymentId];
    if (!p || p.status !== "Challenged") throw new Error("payment is not challenged");
    const a = this.l.agents.get(p.agent)!;
    const amount = BigInt(p.amount);
    a.pending_count -= 1;
    a.pending_total = (BigInt(a.pending_total) - amount).toString();

    if (upheld) {
      p.status = "Rejected";
      a.budget = (BigInt(a.budget) + amount).toString();
      const slash = (BigInt(a.bond) * SLASH_BPS) / 10_000n;
      a.bond = (BigInt(a.bond) - slash).toString();
      a.frozen = true;
      a.reputation = Math.max(a.reputation - 10, -MAX_REP);
      const reward = slash / 2n;
      this.l.insurancePool += slash - reward;
      this.l.transfers.push({ to: p.challenger!, amount: CHALLENGE_STAKE + reward, why: "challenge reward" });
    } else {
      p.status = "Paid";
      a.reputation = Math.min(a.reputation + 1, MAX_REP);
      this.l.insurancePool += CHALLENGE_STAKE;
      this.l.transfers.push({ to: p.to, amount, why: "payment after rejected challenge" });
    }
  }

  async finalize(paymentId: number) {
    const p = this.l.payments[paymentId];
    if (!p || p.status !== "Pending") throw new Error("payment is not pending");
    if (BigInt(this.l.nowSecs) * 1_000_000_000n < BigInt(p.unlocks_at)) {
      throw new Error("challenge window still open");
    }
    const a = this.l.agents.get(p.agent)!;
    p.status = "Paid";
    a.pending_count -= 1;
    a.pending_total = (BigInt(a.pending_total) - BigInt(p.amount)).toString();
    a.reputation = Math.min(a.reputation + 1, MAX_REP);
    this.l.transfers.push({ to: p.to, amount: BigInt(p.amount), why: "payment finalized" });
  }
}
