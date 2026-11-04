# AgentBond — plan (NEAR Hackathon, deadline 2026-11-14 23:59 UTC)

**One line:** an agent can only spend what a human has put at stake for it. Misbehave and the bond is slashed.

## Problem
Agent wallets today are all-or-nothing: either the agent holds the key (a prompt injection drains it) or a human approves every payment (no autonomy). Spending limits exist, but nothing makes an agent *accountable* or lets a third party trust it.

## Idea
1. A **sponsor** (human or DAO) stakes NEAR as a **bond** for an **agent account**.
2. The agent's spending power is a function of its bond and **reputation** (e.g. exposure <= bond x multiplier).
3. Payments over a threshold enter a short **challenge window**. A **guardian** (AI policy engine + anyone) can challenge.
4. A proven violation **slashes** the bond (victim compensation + insurance pool), freezes the agent and drops its reputation.
5. Clean history raises limits over time. Bond releases after a cooldown.

Tracks to enter: `security` (primary), `agents`, `business`.

## Architecture
| Piece | Tech | Notes |
|---|---|---|
| Bond contract | Rust, near-sdk-rs, testnet | stake, policy, request_payment, challenge, slash, release, reputation |
| Guardian service | TypeScript/Node | watches pending payments, scores recipient + memo, challenges; uses NEAR AI private inference for intent check |
| Demo agent | TypeScript + NEAR AI | does paid tasks (buys API access); one honest run, one prompt-injected run |
| Dashboard | Next.js | bond, reputation, live payment feed, slash events; judge-friendly |
| Repo extras | MIT LICENSE, README "do X, see Y", `pre-hackathon` / `hackathon-submission` tags | judged first by Claude Code/Codex running the README |

### Contract surface (v1)
- `stake(agent_id, policy)` payable: per-tx cap, daily cap, recipient allowlist/denylist, challenge window
- `request_payment(to, amount, memo)` agent only; small -> instant, large -> pending
- `challenge(payment_id, evidence)` guardian or anyone (needs a small challenger stake)
- `resolve(payment_id, verdict)` guardian role; slash or reject challenge
- `finalize(payment_id)` after the window, anyone
- `unstake()` after cooldown with no open challenges
- views: `get_agent`, `get_reputation`, `pending_payments`

### Out of scope (stretch only)
NEP-141 stablecoin bonds, cross-chain payments via NEAR Intents (mainnet only, no testnet), multi-guardian voting via Sputnik DAO.

## Schedule
| Day | Date | Goal |
|---|---|---|
| 1 | Nov 2 | Rust toolchain, repo scaffold, contract skeleton, finalize policy model |
| 2-3 | Nov 3-4 | Contract: stake, policy, request_payment, finalize + unit tests |
| 4 | Nov 5 | Contract: challenge, resolve, slash, reputation; deploy to testnet |
| 5-6 | Nov 6-7 | Guardian service + NEAR AI intent check; demo agent honest/injected scripts |
| 7-9 | Nov 8-10 | Dashboard (live feed, bond meter, slash timeline) |
| 10 | Nov 11 | End-to-end demo script, edge cases, security pass on contract |
| 11 | Nov 12 | README, architecture diagram, LICENSE, hosted demo, tags |
| 12 | Nov 13 | Demo video + X post draft, final run-through on a clean machine |
| 13 | Nov 14 | Buffer, submit before 23:59 UTC (human confirms payload) |

## Demo story (90 seconds)
1. Sponsor stakes 10 NEAR for an agent. Dashboard shows the bond meter.
2. Agent pays a legit API vendor. Instant, reputation +1.
3. A poisoned web page prompt-injects the agent to send 8 NEAR to an attacker.
4. Payment goes pending, guardian flags it, challenge upheld. Bond slashed, victim refunded, agent frozen. Dashboard shows the timeline.

## Rules to respect (from HACKATHON.md)
- Nothing created, signed, deployed, spent or posted without the user's explicit OK. Mainnet account for payout is created by the human.
- Public repo + LICENSE; list all AI-generated parts and libraries in the README.
- Keys in env vars only; never commit the submission payload.
- Re-read the live HACKATHON.md before submitting.
