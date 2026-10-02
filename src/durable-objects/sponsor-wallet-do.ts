import {
  deserializeTransaction,
  getAddressFromPrivateKey,
  sponsorTransaction,
  type StacksTransactionWire,
} from "@stacks/transactions";
import { STACKS_MAINNET, STACKS_TESTNET } from "@stacks/network";
import type { BroadcastOnlyResult, Env, Logger } from "../types";
import { SettlementService } from "../services/settlement";
import { getHiroBaseUrl, getHiroHeaders, stripHexPrefix } from "../utils";
import { createWorkerLogger } from "../utils/logger";

const HIRO_NONCE_TIMEOUT_MS = 10_000;
/** Default cap on sponsor fees spent per UTC day (µSTX) — override with SPONSOR_DAILY_BUDGET_USTX */
export const DEFAULT_DAILY_BUDGET_USTX = 10_000_000n;

/** Persisted fee spend for the current UTC day. */
export interface BudgetStore {
  get(): Promise<{ day: string; spent: string } | undefined>;
  put(value: { day: string; spent: string }): Promise<void>;
}

export interface SponsorWalletRequest {
  txHex: string;
  sponsorKey: string;
  fee: string;
  /** Origin (payer) address — one sponsored payment per sender may be in flight */
  senderAddress: string;
}

/** Why a sender's payment was refused before signing (maps to the RPC SENDER_NONCE_* codes). */
export type SenderNonceCode = "SENDER_NONCE_DUPLICATE" | "SENDER_NONCE_STALE" | "SENDER_NONCE_GAP";

export type SponsorWalletResult =
  | { ok: true; txid: string; sponsorNonce: number; fee: string }
  | ({ ok: false; senderNonceCode?: SenderNonceCode } & Extract<BroadcastOnlyResult, { error: string }>);

interface HiroNonces {
  possible_next_nonce: number;
  last_executed_tx_nonce?: number | null;
  last_mempool_tx_nonce?: number | null;
  detected_missing_nonces?: number[];
}

/** How long a sponsored payment counts as in flight if Hiro has not yet seen it execute. */
const SENDER_IN_FLIGHT_MS = 10 * 60_000;

/**
 * Sponsors and broadcasts one transaction at a time for a single sponsor wallet.
 *
 * Nothing is reserved ahead of broadcast. The next nonce comes from Hiro (the lowest
 * detected missing nonce first, so a gap is filled before anything else is chained
 * behind it), then from a local `nonce + 1` after each accepted broadcast — Hiro's
 * `possible_next_nonce` lags a just-broadcast tx. Any failure drops the cached nonce so
 * the next call re-reads the chain. A sponsor-side nonce rejection is retried once with
 * a fresh nonce. This is the pattern used by Xverse's and Tony's x402 sponsor services.
 *
 * One sponsored payment per sender may be in flight. A sponsored tx needs both its sender
 * nonce and its sponsor nonce to be next in line; if one sender's payments reach this lock
 * out of sender-nonce order, sender order and sponsor order cross and every one of them
 * waits on another forever. So a sender's payment is refused (retryable) while it has any
 * pending tx, and its nonce must be exactly the sender's next nonce.
 */
export class SponsorWallet {
  private nextNonce: bigint | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  /** Sender → nonce + time of the last payment sponsored here (covers Hiro mempool lag). */
  private readonly inFlight = new Map<string, { nonce: number; at: number }>();

  constructor(
    private readonly env: Env,
    private readonly logger: Logger,
    private readonly broadcast: (tx: StacksTransactionWire) => Promise<BroadcastOnlyResult>,
    private readonly fetchNonces: (address: string) => Promise<HiroNonces>,
    private readonly budget: BudgetStore
  ) {}

  sponsorAndBroadcast(req: SponsorWalletRequest): Promise<SponsorWalletResult> {
    const run = this.tail.then(() => this.run(req));
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async run({ txHex, sponsorKey, fee, senderAddress }: SponsorWalletRequest): Promise<SponsorWalletResult> {
    const network = this.env.STACKS_NETWORK === "mainnet" ? STACKS_MAINNET : STACKS_TESTNET;
    const address = getAddressFromPrivateKey(sponsorKey, network);
    const senderNonce = Number(deserializeTransaction(stripHexPrefix(txHex)).auth.spendingCondition.nonce);

    const senderRefusal = await this.checkSender(senderAddress, senderNonce);
    if (senderRefusal) return senderRefusal;

    // Daily budget: bounds what any caller — including a leaked binding or a bug — can burn.
    const day = new Date().toISOString().slice(0, 10);
    const stored = await this.budget.get();
    const spent = stored?.day === day ? BigInt(stored.spent) : 0n;
    const limit = BigInt(this.env.SPONSOR_DAILY_BUDGET_USTX ?? DEFAULT_DAILY_BUDGET_USTX);
    if (spent + BigInt(fee) > limit) {
      this.logger.error("sponsor_daily_budget_reached", { address, spent: spent.toString(), limit: limit.toString() });
      return {
        ok: false,
        error: "Daily sponsor budget reached",
        details: `Spent ${spent} of ${limit} µSTX today (UTC)`,
        retryable: true,
        responsible: "sponsor",
      };
    }

    for (let attempt = 1; ; attempt++) {
      let nonce: bigint;
      try {
        nonce = this.nextNonce ?? (await this.chainNextNonce(address));
      } catch (e) {
        return {
          ok: false,
          error: "Could not read sponsor nonce",
          details: e instanceof Error ? e.message : String(e),
          retryable: true,
          responsible: "network",
        };
      }

      const sponsored = await sponsorTransaction({
        transaction: deserializeTransaction(stripHexPrefix(txHex)),
        sponsorPrivateKey: sponsorKey,
        fee: BigInt(fee),
        sponsorNonce: nonce,
        network,
      });
      const result = await this.broadcast(sponsored);

      if ("txid" in result) {
        this.nextNonce = nonce + 1n;
        this.inFlight.set(senderAddress, { nonce: senderNonce, at: Date.now() });
        await this.budget.put({ day, spent: (spent + BigInt(fee)).toString() });
        this.logger.info("sponsor_broadcast_ok", { address, nonce: Number(nonce), txid: result.txid, fee });
        return { ok: true, txid: result.txid, sponsorNonce: Number(nonce), fee };
      }

      this.nextNonce = null;
      this.logger.warn("sponsor_broadcast_failed", {
        address,
        nonce: Number(nonce),
        attempt,
        error: result.error,
        responsible: result.responsible,
      });
      // Our nonce was stale (lagging cache or another writer): re-read the chain once.
      const sponsorNonceRejected = result.nonceConflict === true && result.responsible !== "sender";
      if (!sponsorNonceRejected || attempt >= 2) return { ok: false, ...result };
    }
  }

  private async checkSender(
    sender: string,
    senderNonce: number
  ): Promise<Extract<SponsorWalletResult, { ok: false }> | null> {
    const refuse = (code: SenderNonceCode, details: string) => ({
      ok: false as const,
      senderNonceCode: code,
      error: code === "SENDER_NONCE_DUPLICATE" ? "Previous payment from this sender is still pending" : "Sender nonce out of order",
      details,
      retryable: code !== "SENDER_NONCE_STALE",
      responsible: "sender" as const,
    });

    let info: HiroNonces;
    try {
      info = await this.fetchNonces(sender);
    } catch (e) {
      return {
        ok: false, error: "Could not read sender nonce", details: e instanceof Error ? e.message : String(e),
        retryable: true, responsible: "network",
      };
    }
    const executed = info.last_executed_tx_nonce ?? -1;
    const recent = this.inFlight.get(sender);
    if (recent && (recent.nonce <= executed || Date.now() - recent.at > SENDER_IN_FLIGHT_MS)) {
      this.inFlight.delete(sender);
    }
    if (info.last_mempool_tx_nonce != null || this.inFlight.has(sender)) {
      return refuse("SENDER_NONCE_DUPLICATE", "Wait for your previous transaction to confirm, then re-sign and resend");
    }
    if (senderNonce < info.possible_next_nonce) {
      return refuse("SENDER_NONCE_STALE", `Nonce ${senderNonce} is already used; next is ${info.possible_next_nonce}`);
    }
    if (senderNonce > info.possible_next_nonce) {
      return refuse("SENDER_NONCE_GAP", `Nonce ${senderNonce} skips ahead; next is ${info.possible_next_nonce}`);
    }
    return null;
  }

  private async chainNextNonce(address: string): Promise<bigint> {
    const info = await this.fetchNonces(address);
    const missing = info.detected_missing_nonces ?? [];
    return BigInt(missing.length > 0 ? Math.min(...missing) : info.possible_next_nonce);
  }
}

async function fetchHiroNonces(env: Env, address: string): Promise<HiroNonces> {
  const res = await fetch(`${getHiroBaseUrl(env.STACKS_NETWORK)}/extended/v1/address/${address}/nonces`, {
    headers: getHiroHeaders(env.HIRO_API_KEY),
    signal: AbortSignal.timeout(HIRO_NONCE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Hiro nonces responded ${res.status}`);
  const data = (await res.json()) as Partial<HiroNonces>;
  if (typeof data.possible_next_nonce !== "number") throw new Error("Hiro nonces missing possible_next_nonce");
  return {
    possible_next_nonce: data.possible_next_nonce,
    last_executed_tx_nonce: data.last_executed_tx_nonce,
    last_mempool_tx_nonce: data.last_mempool_tx_nonce,
    detected_missing_nonces: data.detected_missing_nonces,
  };
}

/**
 * One instance per sponsor wallet (`idFromName("wallet-<index>")`). A Durable Object is
 * single-instance, so the in-memory lock and nonce cache in SponsorWallet hold across all
 * Worker isolates. State is memory-only: after an eviction the next call re-reads Hiro.
 */
export class SponsorWalletDO {
  private readonly wallet: SponsorWallet;
  private readonly state: DurableObjectState;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    const logger = createWorkerLogger(env.LOGS, undefined, { component: "sponsor-wallet-do" });
    const settlement = new SettlementService(env, logger);
    this.wallet = new SponsorWallet(
      env,
      logger,
      (tx) => settlement.broadcastOnly(tx),
      (address) => fetchHiroNonces(env, address),
      {
        get: () => state.storage.get<{ day: string; spent: string }>("budget"),
        put: (value) => state.storage.put("budget", value),
      }
    );
  }

  async fetch(request: Request): Promise<Response> {
    // GET: today's fee spend (read by the alert cron)
    if (request.method === "GET") {
      const day = new Date().toISOString().slice(0, 10);
      const stored = await this.state.storage.get<{ day: string; spent: string }>("budget");
      return Response.json({ day, spent: stored?.day === day ? stored.spent : "0" });
    }
    const req = (await request.json()) as SponsorWalletRequest;
    return Response.json(await this.wallet.sponsorAndBroadcast(req));
  }
}
