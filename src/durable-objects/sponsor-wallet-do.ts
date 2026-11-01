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

/** Persisted fee spend for the current UTC day, one counter per budget name. */
export interface BudgetStore {
  get(name: string): Promise<{ day: string; spent: string } | undefined>;
  put(name: string, value: { day: string; spent: string }): Promise<void>;
}

/** x402 payments spend "budget" (read by /status/sponsor and the alert cron); /sponsor spends its own. */
export type BudgetName = "budget" | "budget:sponsor";

export interface SponsorWalletRequest {
  txHex: string;
  sponsorKey: string;
  fee: string;
  /** Origin (payer) address — one sponsored payment per sender may be in flight */
  senderAddress: string;
  /** Daily budget this fee counts against (default "budget") */
  budget?: BudgetName;
}

/** Why a sender's payment was refused before signing (maps to the RPC SENDER_NONCE_* codes). */
export type SenderNonceCode = "SENDER_NONCE_DUPLICATE" | "SENDER_NONCE_STALE" | "SENDER_NONCE_GAP";

export type SponsorWalletResult =
  | { ok: true; txid: string; sponsorNonce: number; fee: string; /** Already sponsored earlier; this call broadcast nothing */ replayed?: boolean }
  | ({
      ok: false;
      senderNonceCode?: SenderNonceCode;
      /** The sender's next nonce per Hiro, on a SENDER_NONCE_STALE / SENDER_NONCE_GAP refusal */
      expectedNonce?: number;
    } & Extract<BroadcastOnlyResult, { error: string }>);

interface HiroNonces {
  possible_next_nonce: number;
  last_executed_tx_nonce?: number | null;
  last_mempool_tx_nonce?: number | null;
  detected_missing_nonces?: number[];
}

/** How long a sponsored payment counts as in flight if Hiro has not yet seen it execute. */
const SENDER_IN_FLIGHT_MS = 10 * 60_000;

/** How long a sponsored payment's txids are kept so a resubmit of the same tx finds them. */
export const SENT_TTL_MS = 24 * 60 * 60_000;
/** Waits before each Hiro lookup of a txid whose broadcast got no answer (timeout, 5xx). */
const NO_ANSWER_CHECK_DELAYS_MS = [1_000, 2_000, 3_000];
/** A nonce conflict means the occupant is already at the node: one immediate lookup. */
const NONCE_CONFLICT_CHECK_DELAYS_MS = [0];

/** Txids this wallet may have put on the network for one client-signed tx. */
export interface SentRecord {
  sends: Array<{ txid: string; sponsorNonce: number }>;
  fee: string;
  at: number;
}

/** Persisted SentRecords, keyed by the hash of the client-signed tx. */
export interface SentStore {
  get(key: string): Promise<SentRecord | undefined>;
  put(key: string, value: SentRecord): Promise<void>;
}

/** Hiro tx_status for a txid, or null when Hiro has not seen it (or could not be read). */
export type TxStatusLookup = (txid: string) => Promise<string | null>;

/** Key for a client-signed tx: SHA-256 of its hex, so the same bytes map to the same payment. */
export async function sentKey(txHex: string): Promise<string> {
  const bytes = new TextEncoder().encode(stripHexPrefix(txHex).toLowerCase());
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Pending or mined: the node took it. Abort or dropped: it will not settle the payment. */
const isLanded = (status: string | null) => status === "pending" || status === "success";

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
    private readonly budget: BudgetStore,
    private readonly txStatus: TxStatusLookup = async () => null,
    private readonly sent: SentStore = noSentStore(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
  ) {}

  /**
   * The txid of an earlier sponsorship of this exact client tx that the node took
   * (pending or mined), or null. Lets a client that resubmits after a failure answer
   * — while the first broadcast in fact landed — get the real txid back.
   */
  async findSent(txHex: string): Promise<Extract<SponsorWalletResult, { ok: true }> | null> {
    const record = await this.sent.get(await sentKey(txHex));
    if (!record || Date.now() - record.at > SENT_TTL_MS) return null;
    for (const send of record.sends) {
      if (isLanded(await this.txStatus(send.txid))) {
        return { ok: true, txid: send.txid, sponsorNonce: send.sponsorNonce, fee: record.fee, replayed: true };
      }
    }
    return null;
  }

  sponsorAndBroadcast(req: SponsorWalletRequest): Promise<SponsorWalletResult> {
    const run = this.tail.then(() => this.run(req));
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async run({ txHex, sponsorKey, fee, senderAddress, budget: budgetName = "budget" }: SponsorWalletRequest): Promise<SponsorWalletResult> {
    const network = this.env.STACKS_NETWORK === "mainnet" ? STACKS_MAINNET : STACKS_TESTNET;
    const address = getAddressFromPrivateKey(sponsorKey, network);
    const senderNonce = Number(deserializeTransaction(stripHexPrefix(txHex)).auth.spendingCondition.nonce);

    const prior = await this.findSent(txHex);
    if (prior) {
      this.logger.info("sponsor_resubmit_found", { address, txid: prior.txid, sponsorNonce: prior.sponsorNonce });
      return prior;
    }

    const senderRefusal = await this.checkSender(senderAddress, senderNonce);
    if (senderRefusal) return senderRefusal;

    // Daily budget: bounds what any caller — including a leaked binding or a bug — can burn.
    const day = new Date().toISOString().slice(0, 10);
    const stored = await this.budget.get(budgetName);
    const spent = stored?.day === day ? BigInt(stored.spent) : 0n;
    const limit = BigInt(this.env.SPONSOR_DAILY_BUDGET_USTX ?? DEFAULT_DAILY_BUDGET_USTX);
    if (spent + BigInt(fee) > limit) {
      this.logger.error("sponsor_daily_budget_reached", { address, budget: budgetName, spent: spent.toString(), limit: limit.toString() });
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
      // Deterministic (RFC 6979 signatures): known before broadcast, so a lost answer can be checked.
      const txid = sponsored.txid();
      const result = await this.broadcast(sponsored);

      const accept = async (landedTxid: string): Promise<SponsorWalletResult> => {
        this.nextNonce = nonce + 1n;
        this.inFlight.set(senderAddress, { nonce: senderNonce, at: Date.now() });
        await this.budget.put(budgetName, { day, spent: (spent + BigInt(fee)).toString() });
        return { ok: true, txid: landedTxid, sponsorNonce: Number(nonce), fee };
      };

      if ("txid" in result) {
        await this.recordSent(txHex, result.txid, Number(nonce), fee);
        this.logger.info("sponsor_broadcast_ok", { address, nonce: Number(nonce), txid: result.txid, fee });
        return accept(result.txid);
      }

      // No node answer (timeout, 5xx), or a nonce conflict that may be with this very tx after
      // a retried send: the node may hold it. Write the txid down first so a resubmit can find
      // it, then ask Hiro whether it landed.
      const unclear = result.httpStatus === undefined || result.nonceConflict === true;
      if (unclear) {
        await this.recordSent(txHex, txid, Number(nonce), fee);
        const delays = result.httpStatus === undefined ? NO_ANSWER_CHECK_DELAYS_MS : NONCE_CONFLICT_CHECK_DELAYS_MS;
        if (await this.awaitSeen(txid, delays)) {
          this.logger.warn("sponsor_broadcast_unclear_but_landed", { address, nonce: Number(nonce), txid, fee, error: result.error });
          return accept(txid);
        }
        // The node may still hold it and Hiro not have indexed it yet: keep the sender in
        // flight so a later call is refused (retryable) instead of sponsored a second time.
        // (A sponsor-nonce conflict below still retries once with a fresh sponsor nonce; both
        // copies spend the same sender nonce, so at most one can mine.)
        this.inFlight.set(senderAddress, { nonce: senderNonce, at: Date.now() });
      }

      // A node rejection (4xx) other than a nonce conflict left this nonce unused: keep it,
      // since Hiro may still lag our last broadcast. Otherwise re-read the chain next time.
      const rejected = result.httpStatus !== undefined && result.httpStatus >= 400 && result.httpStatus < 500;
      this.nextNonce = rejected && !result.nonceConflict ? nonce : null;
      this.logger.warn("sponsor_broadcast_failed", {
        address,
        nonce: Number(nonce),
        attempt,
        txid,
        unclear,
        error: result.error,
        responsible: result.responsible,
      });
      // Our nonce was stale (lagging cache or another writer): re-read the chain once.
      const sponsorNonceRejected = result.nonceConflict === true && result.responsible !== "sender";
      if (!sponsorNonceRejected || attempt >= 2) return { ok: false, ...result };
    }
  }

  /** Add a txid to the record for this client tx (a retry with a new sponsor nonce adds a second). */
  private async recordSent(txHex: string, txid: string, sponsorNonce: number, fee: string): Promise<void> {
    const key = await sentKey(txHex);
    const prev = await this.sent.get(key);
    const sends = (prev?.sends ?? []).filter((s) => s.txid !== txid);
    await this.sent.put(key, { sends: [...sends, { txid, sponsorNonce }], fee, at: Date.now() });
  }

  /** Whether Hiro shows the txid pending or mined within a few seconds (it lags a fresh broadcast). */
  private async awaitSeen(txid: string, delays: number[]): Promise<boolean> {
    for (const delay of delays) {
      if (delay > 0) await this.sleep(delay);
      if (isLanded(await this.txStatus(txid))) return true;
    }
    return false;
  }

  private async checkSender(
    sender: string,
    senderNonce: number
  ): Promise<Extract<SponsorWalletResult, { ok: false }> | null> {
    const refuse = (code: SenderNonceCode, details: string, expectedNonce?: number) => ({
      ok: false as const,
      senderNonceCode: code,
      ...(expectedNonce !== undefined && { expectedNonce }),
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
      return refuse("SENDER_NONCE_STALE", `Nonce ${senderNonce} is already used; next is ${info.possible_next_nonce}`, info.possible_next_nonce);
    }
    if (senderNonce > info.possible_next_nonce) {
      return refuse("SENDER_NONCE_GAP", `Nonce ${senderNonce} skips ahead; next is ${info.possible_next_nonce}`, info.possible_next_nonce);
    }
    return null;
  }

  private async chainNextNonce(address: string): Promise<bigint> {
    const info = await this.fetchNonces(address);
    const missing = info.detected_missing_nonces ?? [];
    return BigInt(missing.length > 0 ? Math.min(...missing) : info.possible_next_nonce);
  }
}

function noSentStore(): SentStore {
  const records = new Map<string, SentRecord>();
  return { get: async (k) => records.get(k), put: async (k, v) => { records.set(k, v); } };
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
        get: (name) => state.storage.get<{ day: string; spent: string }>(name),
        put: (name, value) => state.storage.put(name, value),
      },
      async (txid) => (await settlement.fetchHiroTxStatus(txid))?.txStatus ?? null,
      {
        get: (key) => state.storage.get<SentRecord>(`sent:${key}`),
        put: async (key, value) => {
          await state.storage.put(`sent:${key}`, value);
          if ((await state.storage.getAlarm()) === null) await state.storage.setAlarm(Date.now() + SENT_TTL_MS);
        },
      }
    );
  }

  /** Drop SentRecords older than SENT_TTL_MS; re-arm while any remain. */
  async alarm(): Promise<void> {
    const records = await this.state.storage.list<SentRecord>({ prefix: "sent:" });
    const cutoff = Date.now() - SENT_TTL_MS;
    const expired = [...records].filter(([, r]) => r.at < cutoff).map(([k]) => k);
    for (let i = 0; i < expired.length; i += 128) await this.state.storage.delete(expired.slice(i, i + 128));
    if (records.size > expired.length) await this.state.storage.setAlarm(Date.now() + SENT_TTL_MS);
  }

  async fetch(request: Request): Promise<Response> {
    // GET: today's fee spend (read by the alert cron)
    if (request.method === "GET") {
      const day = new Date().toISOString().slice(0, 10);
      const stored = await this.state.storage.get<{ day: string; spent: string }>("budget");
      return Response.json({ day, spent: stored?.day === day ? stored.spent : "0" });
    }
    // POST /lookup: an earlier sponsorship of this client tx that landed, or null
    if (new URL(request.url).pathname === "/lookup") {
      const { txHex } = (await request.json()) as { txHex: string };
      return Response.json(await this.wallet.findSent(txHex));
    }
    const req = (await request.json()) as SponsorWalletRequest;
    return Response.json(await this.wallet.sponsorAndBroadcast(req));
  }
}
