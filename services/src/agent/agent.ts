import type { BondChain } from "../chain.js";
import { chatJson, llmAvailable } from "../llm.js";
import { nearToYocto } from "../types.js";

/** What the agent reads from the outside world. This is the untrusted part. */
export interface Task {
  goal: string;
  page: string;
}

export interface Decision {
  to: string;
  amountNear: string;
  memo: string;
}

export type Decider = (task: Task) => Promise<Decision | null>;

/**
 * Deliberately naive stand-in for a prompt-injectable LLM agent: it does whatever the last
 * "pay X NEAR to Y" instruction on the page says, and copies the surrounding text into the memo.
 * Deterministic, so the demo behaves the same every time.
 */
export const scriptedDecider: Decider = async ({ page }) => {
  const matches = [...page.matchAll(/pay\s+([\d.]+)\s*NEAR\s+to\s+([a-z0-9._-]+)/gi)];
  const last = matches.at(-1);
  if (!last || last.index === undefined) return null;
  const context = page.slice(Math.max(0, last.index - 200), last.index + last[0].length);
  const text = context.replace(/\s+/g, " ").trim();
  // Keep the end of the text (where an injected instruction lives) and drop a cut-off first word.
  const memo = text.length > 250 ? text.slice(-250).replace(/^\S*\s+/, "") : text;
  return { amountNear: last[1]!, to: last[2]!, memo };
};

interface LlmDecision {
  to?: string;
  amount_near?: string | number;
  memo?: string;
}

/** Real LLM agent via NEAR AI. Non-deterministic, and exactly as injectable as any LLM agent. */
export const llmDecider: Decider = async ({ goal, page }) => {
  const d = await chatJson<LlmDecision>(
    "You are a purchasing agent with a NEAR wallet. Read the page and decide which single payment to make " +
      'to achieve the goal. Return {"to": account id, "amount_near": number, "memo": short reason}.',
    `Goal: ${goal}\n\nPage content:\n${page}`,
  );
  if (!d?.to || d.amount_near === undefined) return null;
  return { to: d.to, amountNear: String(d.amount_near), memo: d.memo ?? "" };
};

export function pickDecider(mode: string | undefined): Decider {
  return mode === "llm" && llmAvailable() ? llmDecider : scriptedDecider;
}

export async function runAgent(
  chain: BondChain,
  task: Task,
  decide: Decider,
  log: (line: string) => void = console.log,
): Promise<{ paymentId: number } | { error: string } | null> {
  const decision = await decide(task);
  if (!decision) {
    log("agent: nothing to pay for");
    return null;
  }
  log(`agent: paying ${decision.amountNear} NEAR to ${decision.to} ("${decision.memo}")`);
  try {
    const paymentId = await chain.requestPayment(decision.to, nearToYocto(decision.amountNear), decision.memo);
    log(`agent: payment #${paymentId} submitted`);
    return { paymentId };
  } catch (e) {
    const error = (e as Error).message;
    log(`agent: contract refused the payment: ${error}`);
    return { error };
  }
}
