import { nearChainFromEnv } from "../chain.js";
import { yoctoToNear } from "../types.js";
import { pickDecider, runAgent } from "./agent.js";
import { SCENARIOS } from "./scenarios.js";

const name = process.argv[2] ?? "honest";
const task = SCENARIOS[name];
if (!task) {
  console.error(`unknown scenario "${name}". Use: ${Object.keys(SCENARIOS).join(", ")}`);
  process.exit(1);
}

const chain = nearChainFromEnv("AGENT");
const result = await runAgent(chain, task, pickDecider(process.env.AGENT_MODE));
if (!result || "error" in result) process.exit(result ? 2 : 0);

// Watch what the guardian does with it.
for (let i = 0; i < 45; i++) {
  const p = (await chain.recentPayments(20)).find((x) => x.id === result.paymentId);
  if (p && p.status !== "Pending") {
    console.log(`payment #${p.id}: ${p.status}`);
    break;
  }
  await new Promise((r) => setTimeout(r, 2000));
}
const me = process.env.AGENT_ACCOUNT!;
const agent = await chain.getAgent(me);
if (agent) {
  console.log(
    `agent ${me}: frozen=${agent.frozen} reputation=${agent.reputation} bond=${yoctoToNear(agent.bond)} NEAR budget=${yoctoToNear(agent.budget)} NEAR`,
  );
}
