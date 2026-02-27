import type { Logger } from "../types";

const PAYMENT_ID_TTL_SECONDS = 300;
const PAYMENT_ID_KEY_PREFIX = "payid:";

/**
 * Shape of a cached payment-identifier entry stored in KV.
 * Keyed by payid:<id> with a 300s TTL.
 *
 * The response field is typed as `unknown` so both /settle (X402SettlementResponseV2)
 * and /verify (X402VerifyResponseV2) can cache their responses without unsafe casts.
 * Callers are responsible for casting the response to the expected shape on cache hit.
 */
export interface CachedPaymentIdEntry {
  /** SHA-256 hex hash of canonical { paymentPayload, paymentRequirements } JSON */
  payloadHash: string;
  /** The response returned to the original caller (shape depends on endpoint) */
  response: unknown;
  /** Unix timestamp (ms) when this entry was recorded */
  recordedAt: number;
}

/**
 * Result of a payment-identifier cache lookup.
 *
 * - "miss"     — id not found in KV (proceed with normal settlement)
 * - "hit"      — id found and payload hash matches (return cached response)
 * - "conflict" — id found but payload hash differs (reject with 409 conflict)
 */
export type PaymentIdCheckResult =
  | { status: "miss" }
  | { status: "hit"; response: unknown }
  | { status: "conflict" };

/**
 * KV cache layer for the payment-identifier extension (x402 V2).
 *
 * Provides client-controlled idempotency: clients include a stable id in
 * extensions["payment-identifier"].info.id across retries, and this service
 * ensures:
 * - Same id + same payload → cached response (idempotent retry)
 * - Same id + different payload → conflict (prevent accidental reuse)
 * - Absent id → pass-through (backward compatible)
 *
 * Uses RELAY_KV with "payid:" key prefix and 300s TTL.
 */
export class PaymentIdService {
  constructor(
    private kv: KVNamespace | undefined,
    private logger: Logger
  ) {}

  /**
   * Compute SHA-256 hash of the canonical request payload for conflict fingerprinting.
   *
   * The hash covers the full { paymentPayload, paymentRequirements } object so
   * that any change to transaction bytes, amount, recipient, or network produces
   * a different fingerprint — triggering a conflict for mismatched reuse.
   */
  async computePayloadHash(
    paymentPayload: unknown,
    paymentRequirements: unknown
  ): Promise<string> {
    const canonical = JSON.stringify({ paymentPayload, paymentRequirements });
    const data = new TextEncoder().encode(canonical);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const bytes = new Uint8Array(hashBuffer);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  /**
   * Look up a payment-identifier in KV and determine cache status.
   *
   * Returns:
   * - { status: "miss" }                         — not in KV (proceed with settlement)
   * - { status: "hit", response }                — cached response (return to caller)
   * - { status: "conflict" }                     — id reused with different payload (reject)
   *
   * Fails open: if KV is unavailable or throws, returns { status: "miss" } so
   * settlement proceeds normally rather than blocking the request.
   */
  async checkPaymentId(
    id: string,
    payloadHash: string
  ): Promise<PaymentIdCheckResult> {
    if (!this.kv) {
      return { status: "miss" };
    }

    const key = `${PAYMENT_ID_KEY_PREFIX}${id}`;

    try {
      const entry = await this.kv.get<CachedPaymentIdEntry>(key, "json");

      if (entry === null) {
        return { status: "miss" };
      }

      if (entry.payloadHash === payloadHash) {
        this.logger.debug("payment-identifier cache hit", {
          id,
          payloadHash: payloadHash.slice(0, 16) + "...",
        });
        return { status: "hit", response: entry.response };
      }

      // Hash mismatch: same id used with a different payload — conflict
      this.logger.warn("payment-identifier conflict: id reused with different payload", {
        id,
        cachedHash: entry.payloadHash.slice(0, 16) + "...",
        incomingHash: payloadHash.slice(0, 16) + "...",
        cachedAt: new Date(entry.recordedAt).toISOString(),
      });
      return { status: "conflict" };
    } catch (e) {
      this.logger.warn("payment-identifier KV lookup failed, proceeding as miss", {
        id,
        error: e instanceof Error ? e.message : String(e),
      });
      return { status: "miss" };
    }
  }

  /**
   * Store a settlement response under the payment-identifier key with 300s TTL.
   *
   * Should be called after a successful (or deterministically failed) settlement
   * so that subsequent retries with the same id + payload receive the cached result.
   *
   * Non-blocking: errors are logged as warnings but do not throw, so a KV write
   * failure never prevents the settle response from being returned to the client.
   */
  async recordPaymentId(
    id: string,
    payloadHash: string,
    response: unknown
  ): Promise<void> {
    if (!this.kv) {
      return;
    }

    const key = `${PAYMENT_ID_KEY_PREFIX}${id}`;
    const entry: CachedPaymentIdEntry = {
      payloadHash,
      response,
      recordedAt: Date.now(),
    };

    try {
      await this.kv.put(key, JSON.stringify(entry), {
        expirationTtl: PAYMENT_ID_TTL_SECONDS,
      });
      this.logger.debug("payment-identifier response cached", {
        id,
        payloadHash: payloadHash.slice(0, 16) + "...",
        ttlSeconds: PAYMENT_ID_TTL_SECONDS,
      });
    } catch (e) {
      this.logger.warn("payment-identifier KV write failed (non-blocking)", {
        id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
}
