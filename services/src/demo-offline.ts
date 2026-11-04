// Runs the whole story against the in-memory ledger: no network, no accounts, no keys.
//   npm run demo:offline
import { pickDecider, runAgent } from "./agent/agent.js";
import { ATTACKER, HONEST, INJECTED, VENDOR } from "./agent/scenarios.js";
import { reviewOnce } from "./guardian/guardian.js";
import { MockLedger } from "./mock-chain.js";
import { nearToYocto, yoctoToNear, type Policy } from "./types.js";

const GUARDIAN = "guardian.testnet";
const SPONSOR = "sponsor.testnet";
const AGENT = "agent.testnet";

const policy: Policy = {
  instant_limit: nearToYocto("1").toString(),
  max_payment: nearToYocto("10").toString(),
  daily_limit: nearToYocto("20").toString(),
  challenge_window_secs: 60,
  allowlist: [],
  denylist: [],
};

const ledger = new MockLedger(GUARDIAN);
ledger.registerAgent(SPONSOR, AGENT, "10", "40", policy);
const guardianChain = ledger.as(GUARDIAN);
const agentChain = ledger.as(AGENT);
const seen = new Set<number>();
const nowNs = () => BigInt(ledger.nowSecs) * 1_000_000_000n;
const pass = () =>
  reviewOnce({ chain: guardianChain, trustedRecipients: new Set([VENDOR]), nowNs, log: (l) => console.log(`  guardian: ${l}`) }, seen);

const show = async (title: string) => {
  const a = (await agentChain.getAgent(AGENT))!;
  console.log(
    `  [${title}] bond=${yoctoToNear(a.bond, 2)} budget=${yoctoToNear(a.budget, 2)} reputation=${a.reputation} frozen=${a.frozen} pool=${yoctoToNear(ledger.insurancePool, 3)}`,
  );
};

console.log("\n1. Sponsor stakes 10 NEAR bond + 40 NEAR budget for the agent");
await show("start");

console.log("\n2. Agent pays a legitimate invoice");
const decide = pickDecider("scripted");
await runAgent(agentChain, HONEST, decide, (l) => console.log(`  ${l}`));
await pass();
ledger.advance(61);
console.log("  ...challenge window passes");
await pass();
await show("after honest payment");

console.log("\n3. Agent reads a poisoned page and tries to pay an attacker");
await runAgent(agentChain, INJECTED, decide, (l) => console.log(`  ${l}`));
await pass();
await show("after attack");

console.log("\n4. Frozen agent tries again");
await runAgent(agentChain, INJECTED, decide, (l) => console.log(`  ${l}`));

console.log(`\nTransfers out of the contract:`);
for (const t of ledger.transfers) console.log(`  ${yoctoToNear(t.amount, 2)} NEAR -> ${t.to} (${t.why})`);
console.log(`\nAttacker received: ${ledger.transfers.filter((t) => t.to === ATTACKER).length === 0 ? "nothing" : "FUNDS (bug!)"}`);
