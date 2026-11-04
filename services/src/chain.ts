import { Account, JsonRpcProvider, teraToGas, nearToYocto as sdkNearToYocto } from "near-api-js";
import type { KeyPairString } from "near-api-js";
import type { Agent, Payment } from "./types.js";

/** Everything the guardian and demo agent need from the contract. */
export interface BondChain {
  recentPayments(limit: number): Promise<Payment[]>;
  getAgent(agentId: string): Promise<Agent | null>;
  /** Agent action. Returns the new payment id. */
  requestPayment(to: string, amountYocto: bigint, memo: string): Promise<number>;
  /** Anyone can challenge by staking 0.1 NEAR. */
  challenge(paymentId: number, evidence: string): Promise<void>;
  /** Guardian only. */
  resolve(paymentId: number, upheld: boolean): Promise<void>;
  /** Anyone, after the window closes. */
  finalize(paymentId: number): Promise<void>;
}

export interface NearChainConfig {
  rpcUrl: string;
  contractId: string;
  accountId: string; // the account that signs
  privateKey: string; // ed25519:...
}

export class NearChain implements BondChain {
  private provider: JsonRpcProvider;
  private account: Account;

  constructor(private cfg: NearChainConfig) {
    this.provider = new JsonRpcProvider({ url: cfg.rpcUrl });
    this.account = new Account(cfg.accountId, this.provider, cfg.privateKey as KeyPairString);
  }

  private view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    return this.provider.callFunction({
      contractId: this.cfg.contractId,
      method,
      args,
    }) as Promise<T>;
  }

  private call(methodName: string, args: Record<string, unknown>, deposit = 0n) {
    return this.account.callFunction({
      contractId: this.cfg.contractId,
      methodName,
      args,
      gas: teraToGas("100"),
      deposit,
    });
  }

  recentPayments(limit: number) {
    return this.view<Payment[]>("recent_payments", { limit });
  }

  getAgent(agentId: string) {
    return this.view<Agent | null>("get_agent", { agent_id: agentId });
  }

  async requestPayment(to: string, amountYocto: bigint, memo: string): Promise<number> {
    const result = await this.call("request_payment", {
      to,
      amount: amountYocto.toString(),
      memo,
    });
    if (typeof result === "number") return result;
    // Fallback if the SDK does not hand back the return value: newest payment from this agent.
    const recent = await this.recentPayments(20);
    const mine = recent.find((p) => p.agent === this.cfg.accountId && p.to === to && p.memo === memo);
    if (!mine) throw new Error("request_payment succeeded but the payment id could not be found");
    return mine.id;
  }

  async challenge(paymentId: number, evidence: string) {
    await this.call("challenge", { payment_id: paymentId, evidence }, sdkNearToYocto("0.1"));
  }

  async resolve(paymentId: number, upheld: boolean) {
    await this.call("resolve", { payment_id: paymentId, upheld });
  }

  async finalize(paymentId: number) {
    await this.call("finalize", { payment_id: paymentId });
  }
}

export function nearChainFromEnv(prefix: "GUARDIAN" | "AGENT" | "SPONSOR"): NearChain {
  const need = (k: string) => {
    const v = process.env[k];
    if (!v) throw new Error(`Missing env var ${k} (see .env.example)`);
    return v;
  };
  return new NearChain({
    rpcUrl: process.env.NEAR_RPC_URL ?? "https://test.rpc.fastnear.com",
    contractId: need("BOND_CONTRACT"),
    accountId: need(`${prefix}_ACCOUNT`),
    privateKey: need(`${prefix}_KEY`),
  });
}
