// Start over with a fresh agent on the contract from .env, without the faucet:
//   npm run reset:agent
// The sponsor withdraws the old agent's remaining bond and budget, creates a new sub-account
// for the agent, and registers it with the demo bond, budget and policy. Updates AGENT_* in .env.
// Use it after an agent has been slashed and frozen, or to re-record the demo.
// Set CHALLENGE_WINDOW_SECS (default 30) to change the challenge window for the new agent.

import { Account, JsonRpcProvider, KeyPair, teraToGas } from "near-api-js";
import type { KeyPairString } from "near-api-js";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { BOND, BUDGET, demoPolicy } from "./demo-config.js";
import { nearToYocto } from "./types.js";

const ENV_PATH = new URL("../.env", import.meta.url);
const env = Object.fromEntries(
  readFileSync(ENV_PATH, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const need = (k: string) => env[k] || (console.error(`Missing ${k} in .env. Run npm run setup:testnet first.`), process.exit(1));

const provider = new JsonRpcProvider({ url: need("NEAR_RPC_URL") });
const contract = need("BOND_CONTRACT");
const sponsorId = need("SPONSOR_ACCOUNT");
const sponsor = new Account(sponsorId, provider, need("SPONSOR_KEY") as KeyPairString);
const oldAgent = need("AGENT_ACCOUNT");

const call = (methodName: string, args: Record<string, unknown>, deposit = 0n) =>
  sponsor.callFunction({ contractId: contract, methodName, args, gas: teraToGas("30"), deposit });

console.log(`withdrawing ${oldAgent}...`);
try {
  await call("unstake", { agent_id: oldAgent });
} catch (e) {
  console.log(`  skipped (${(e as Error).message.split("\n")[0]})`);
}

const key = KeyPair.fromRandom("ed25519");
const prefix = `agent-${randomBytes(2).toString("hex")}`;
const newAgent = `${prefix}.${sponsorId}`;
console.log(`creating ${newAgent}...`);
await sponsor.createSubAccount({
  accountOrPrefix: prefix,
  publicKey: key.getPublicKey(),
  nearToTransfer: nearToYocto("0.3"),
});

console.log("registering it with a fresh bond and budget...");
await call(
  "register_agent",
  { agent_id: newAgent, bond: nearToYocto(BOND).toString(), policy: demoPolicy() },
  nearToYocto(String(Number(BOND) + Number(BUDGET))),
);

const text = readFileSync(ENV_PATH, "utf8")
  .replace(/^AGENT_ACCOUNT=.*$/m, `AGENT_ACCOUNT=${newAgent}`)
  .replace(/^AGENT_KEY=.*$/m, `AGENT_KEY=${key.toString()}`);
writeFileSync(ENV_PATH, text, { mode: 0o600 });
console.log(`Done. New agent: ${newAgent} (contract ${contract}). Open the dashboard on the same contract.`);
