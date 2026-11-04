// JSON shapes returned by the agent-bond contract. Amounts are yoctoNEAR strings.

export type PaymentStatus = "Pending" | "Challenged" | "Paid" | "Rejected";

export interface Policy {
  instant_limit: string;
  max_payment: string;
  daily_limit: string;
  challenge_window_secs: number;
  allowlist: string[];
  denylist: string[];
}

export interface Agent {
  sponsor: string;
  bond: string;
  budget: string;
  policy: Policy;
  frozen: boolean;
  reputation: number;
  spent_today: string;
  day: number;
  pending_count: number;
  pending_total: string;
}

export interface Payment {
  id: number;
  agent: string;
  to: string;
  amount: string;
  memo: string;
  status: PaymentStatus;
  created_at: string; // ns since epoch
  unlocks_at: string; // ns since epoch
  challenger: string | null;
  evidence: string | null;
}

export const YOCTO = 10n ** 24n;

/** "8" or "0.1" NEAR -> yoctoNEAR bigint. */
export function nearToYocto(near: string | number): bigint {
  const [whole = "0", frac = ""] = String(near).split(".");
  const padded = (frac + "0".repeat(24)).slice(0, 24);
  return BigInt(whole) * YOCTO + BigInt(padded || "0");
}

/** yoctoNEAR -> human string with up to `digits` decimals. */
export function yoctoToNear(yocto: string | bigint, digits = 3): string {
  const v = BigInt(yocto);
  const whole = v / YOCTO;
  const frac = (v % YOCTO).toString().padStart(24, "0").slice(0, digits);
  return digits > 0 ? `${whole}.${frac}` : `${whole}`;
}
