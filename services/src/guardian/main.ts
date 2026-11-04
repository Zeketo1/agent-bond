import { nearChainFromEnv } from "../chain.js";
import { reviewOnce } from "./guardian.js";

// Recipients the sponsor trusts, comma-separated in TRUSTED_RECIPIENTS.
const trusted = new Set(
  (process.env.TRUSTED_RECIPIENTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
const chain = nearChainFromEnv("GUARDIAN");
const seen = new Set<number>();
const intervalMs = Number(process.env.GUARDIAN_POLL_MS ?? 3000);

console.log(`guardian watching ${process.env.BOND_CONTRACT}; trusted: ${[...trusted].join(", ") || "(none)"}`);
for (;;) {
  await reviewOnce(
    { chain, trustedRecipients: trusted, nowNs: () => BigInt(Date.now()) * 1_000_000n, log: console.log },
    seen,
  );
  await new Promise((r) => setTimeout(r, intervalMs));
}
