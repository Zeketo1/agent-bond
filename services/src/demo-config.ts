import { nearToYocto, type Policy } from "./types.js";

// Demo scale: small enough for faucet-funded accounts (10 NEAR each).
export const BOND = "1";
export const BUDGET = "3";

export const demoPolicy = (): Policy => ({
  instant_limit: nearToYocto("0.01").toString(),
  max_payment: nearToYocto("1").toString(),
  daily_limit: nearToYocto("2").toString(),
  // Long enough to start the guardian by hand while recording: CHALLENGE_WINDOW_SECS=90
  challenge_window_secs: Number(process.env.CHALLENGE_WINDOW_SECS ?? 30),
  allowlist: [],
  denylist: [],
});
