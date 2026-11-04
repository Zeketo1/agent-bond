# AgentBond

**An AI agent can only spend what a human has put at stake for it. If it misbehaves, the bond is slashed.**

Built for the NEAR Hackathon (tracks: AI Security & Defense, Agent Economy, Autonomous Business).

## The problem

Agent wallets today are all-or-nothing. Either the agent holds the key, and one prompt injection drains it, or a human approves every payment, and the agent is not autonomous. Spending limits help, but nothing makes an agent *accountable*, and nothing lets a third party trust one.

## What AgentBond does

1. A **sponsor** (a person or a DAO) stakes NEAR as a **bond** for an **agent account**, plus a spending budget and a policy: instant limit, per-payment cap, daily cap, challenge window, allow and deny lists.
2. The agent can pay on its own, within the policy:
   - Small payments go out instantly.
   - Larger payments are held in escrow for a **challenge window**.
   - The total held at once is capped by the bond: from 1x the bond up to 3x as the agent builds a clean record.
3. Anyone can **challenge** a held payment by staking 0.1 NEAR. A **guardian** rules on it.
4. If the challenge is upheld, the payment is cancelled and refunded to the agent's budget. 25% of the bond is **slashed**: half goes to the challenger, half to an insurance pool. The agent is **frozen** and its reputation drops by 10.
5. Unchallenged payments are released after the window and add +1 reputation.

The bond is what makes autonomy safe to grant: the most an agent can put at risk is bounded by what a human has staked on it.

## How NEAR is used

- **Smart contract on NEAR** (`contract/`, Rust, near-sdk 5): holds the bonds and budgets, enforces the policy, runs the challenge window, slashes. The chain enforces the rules, not a server.
- **NEAR testnet** for the live demo. The contract is deployed at [`bond-9dbe1f.testnet`](https://testnet.nearblocks.io/address/bond-9dbe1f.testnet).
- **NEAR AI Cloud** (optional): the guardian can ask a private model to review payments that its rules are unsure about. Inference runs in a TEE. Without an API key, the guardian uses rules only.

## What is in the repo

| Folder | What it is |
|---|---|
| `contract/` | The bond contract (Rust). 12 unit tests. |
| `services/` | Guardian service, demo agent, in-memory ledger for offline runs, testnet setup script (TypeScript). 6 tests. |
| `dashboard/` | Live dashboard. Plain HTML/CSS/JS, no build step. Reads testnet RPC directly. |
| `PLAN.md` | Original design notes and schedule. |

## Try it

### 1. Offline demo (about 1 minute, no accounts, no network)

Needs Node.js 22 or newer.

```bash
cd services
npm install
npm test
npm run demo:offline
```

You will see: the sponsor stakes a bond, the agent pays a legitimate invoice (finalized after the window), then a poisoned page makes the agent try to pay an attacker. The guardian challenges it, the bond is slashed, the agent is frozen, and the attacker receives nothing.

The offline run uses an in-memory copy of the contract rules (`services/src/mock-chain.ts`). The Rust contract is the source of truth; the live testnet run below uses the real thing.

### 2. Contract tests

Needs Rust (https://rustup.rs) with the `wasm32-unknown-unknown` target.

```bash
cd contract
cargo test
cargo build --target wasm32-unknown-unknown --release
```

On Windows, one dependency wants NASM. Avoid installing it by setting this first:

```powershell
$env:AWS_LC_SYS_PREBUILT_NASM = "1"
```

### 3. Live demo on NEAR testnet

Testnet NEAR is free. This creates six throwaway testnet accounts through the public faucet, deploys the contract you just built, and registers an agent. It writes keys to `services/.env` (git-ignored) and refuses to run if that file exists.

```bash
cd services
npm run setup:testnet
```

Then, in two terminals:

```bash
npm run guardian
```

```bash
npm run agent:honest
npm run agent:injected
```

- `agent:honest` pays a 0.5 NEAR invoice. The guardian lets it through; it is finalized after the 30-second window.
- `agent:injected` reads a page with a hidden instruction and tries to pay 0.8 NEAR to an attacker account. The guardian challenges and slashes it within a few seconds.

After a slash the agent is frozen. To start over with a fresh agent on the same contract (no faucet needed), run `npm run reset:agent`. Set `CHALLENGE_WINDOW_SECS` (default 30) before either setup command to change the challenge window. The guardian must challenge inside that window; if it is offline until the window closes, anyone can release the payment.

Watch it live:

```bash
cd dashboard
node serve.mjs
```

Open http://localhost:5173 (it reads the contract from `dashboard/config.json`, or use `?contract=<account>`).

### What a real run looked like (testnet, contract `bond-0b8798.testnet`)

| Step | Result |
|---|---|
| Honest invoice, 0.5 NEAR to the vendor | Risk 0.00, finalized after the window, reputation 0 to 1 |
| Poisoned page, 0.8 NEAR to the attacker | Risk 1.00, challenged and upheld |
| Agent after the slash | Bond 1.0 to 0.75 NEAR, frozen, reputation -9 |
| Insurance pool | 0.125 NEAR |
| Attacker | Received nothing |

## The guardian

The dashboard is a viewer: it only reads from testnet, and nothing on the page can challenge or slash a payment. The guardian is a separate service you run. It holds the key of the contract's guardian account and signs the challenge and finalize transactions. A hosted dashboard therefore shows what has already happened; to create new activity, run the guardian and agent from this repo (see "Try it").

`services/src/guardian/` reviews payments in the challenge window:

- **Rules (always on):** recipient the sponsor has never dealt with, memo that tries to override instructions or applies pressure or secrecy, empty memo, amount near the per-payment cap. A score of 0.6 or more is challenged.
- **Private AI review (optional):** when the rules score a payment in the unsure band, it asks a NEAR AI model for a second opinion. The memo is treated as untrusted data.
- Safe payments are finalized once the window has passed.

The demo agent is deliberately gullible: it follows whatever "pay X NEAR to Y" appears last on a page, as a stand-in for a prompt-injectable LLM. That keeps the demo deterministic. Setting `AGENT_MODE=llm` plus a NEAR AI key lets a real model play the agent instead, which is non-deterministic.

## Known limitations

- **One guardian account**, set when the contract is initialized. It is also the challenger in the demo, so it earns the reward. Multi-guardian voting (for example through Sputnik DAO) is future work.
- **No unstake cooldown.** The sponsor can withdraw as long as nothing is pending.
- **"Refund" means back to the agent's budget.** Instant payments (at or below the instant limit) cannot be challenged.
- **Native NEAR only.** No stablecoin bonds yet, and no cross-chain payments through NEAR Intents (which has no testnet).
- **The dashboard infers the original bond** from the number of slashes, because the contract does not store it.
- **Not audited.** This is hackathon code. Do not put real funds in it.

## Security notes

- `services/.env` holds testnet private keys. It is git-ignored; never commit it.
- Everything the dashboard shows from the chain (memos, account ids) is escaped before display, since agents and attackers control that text.

## AI assistance and third-party code

Disclosed as the hackathon rules ask:

- The contract, services, dashboard and this README were written with **Claude (Anthropic) through Claude Code**, directed and reviewed by the project owner. The contract and service tests were run on the author's machine, and the live testnet run above was performed for real.
- Libraries: [`near-sdk`](https://crates.io/crates/near-sdk) 5 (Rust), [`near-api-js`](https://www.npmjs.com/package/near-api-js) 7, `tsx` and `typescript` (dev tooling). The dashboard uses the Schibsted Grotesk font from Google Fonts. No templates were used.
- The project was started during the hackathon window. There is no pre-existing code and no product on another chain, so there is no baseline to separate out.

## License

MIT. See [LICENSE](LICENSE).
