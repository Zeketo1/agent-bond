import type { BondChain } from "../chain.js";
import { yoctoToNear } from "../types.js";
import { assess, type RiskAssessment } from "./risk.js";

export interface GuardianAction {
  paymentId: number;
  action: "challenged+slashed" | "finalized" | "resolved-clean" | "left-pending" | "error";
  assessment?: RiskAssessment;
  detail?: string;
}

export interface GuardianDeps {
  chain: BondChain; // signed by the guardian account
  trustedRecipients: Set<string>;
  nowNs: () => bigint;
  log?: (line: string) => void;
}

/**
 * One review pass. Looks at recent payments and:
 *  - Pending + risky   -> challenge, then resolve as upheld (slash)
 *  - Pending + safe    -> finalize once the window has passed
 *  - Challenged by someone else -> assess and resolve either way
 * `seen` remembers payments already acted on, so repeated passes are idempotent.
 */
export async function reviewOnce(deps: GuardianDeps, seen: Set<number>): Promise<GuardianAction[]> {
  const { chain, trustedRecipients, log = () => {} } = deps;
  const actions: GuardianAction[] = [];
  const payments = await chain.recentPayments(50);

  for (const p of payments.reverse()) {
    if (seen.has(p.id) || (p.status !== "Pending" && p.status !== "Challenged")) continue;
    try {
      const agent = await chain.getAgent(p.agent);
      if (!agent) continue;
      const a = await assess(p, { agent, trustedRecipients });
      const summary = `#${p.id} ${yoctoToNear(p.amount)} NEAR -> ${p.to} risk=${a.score.toFixed(2)}`;

      if (p.status === "Challenged") {
        await chain.resolve(p.id, a.challenge);
        seen.add(p.id);
        actions.push({ paymentId: p.id, action: a.challenge ? "challenged+slashed" : "resolved-clean", assessment: a });
        log(`${summary} third-party challenge ${a.challenge ? "upheld" : "rejected"}`);
      } else if (a.challenge) {
        await chain.challenge(p.id, a.reasons.join("; ").slice(0, 900));
        await chain.resolve(p.id, true);
        seen.add(p.id);
        actions.push({ paymentId: p.id, action: "challenged+slashed", assessment: a });
        log(`${summary} CHALLENGED and slashed: ${a.reasons.join("; ")}`);
      } else if (deps.nowNs() >= BigInt(p.unlocks_at)) {
        await chain.finalize(p.id);
        seen.add(p.id);
        actions.push({ paymentId: p.id, action: "finalized", assessment: a });
        log(`${summary} looks fine, finalized`);
      } else {
        actions.push({ paymentId: p.id, action: "left-pending", assessment: a });
      }
    } catch (e) {
      actions.push({ paymentId: p.id, action: "error", detail: (e as Error).message });
      log(`#${p.id} error: ${(e as Error).message}`);
    }
  }
  return actions;
}
