import {
  sponsorTransaction,
  deserializeTransaction,
  getAddressFromPrivateKey,
  AuthType,
  PayloadType,
  type StacksTransactionWire,
} from "@stacks/transactions";
import { STACKS_MAINNET, STACKS_TESTNET } from "@stacks/network";
import {
  generateNewAccount,
  generateWallet,
} from "@stacks/wallet-sdk";
import type { Env, Logger, FeeTransactionType } from "../types";
import { getHiroBaseUrl, getHiroHeaders } from "../utils";
import { FeeService } from "./fee";

/**
 * Successful transaction validation result
 */
export interface TransactionValidationSuccess {
  valid: true;
  transaction: StacksTransactionWire;
  senderAddress: string;
}

/**
 * Failed transaction validation result
 */
export interface TransactionValidationFailure {
  valid: false;
  error: string;
  details: string;
}

/**
 * Result of transaction validation (discriminated union)
 */
export type TransactionValidationResult =
  | TransactionValidationSuccess
  | TransactionValidationFailure;

/**
 * Successful sponsoring result
 */
export interface SponsorSuccess {
  success: true;
  sponsoredTxHex: string;
  /** Fee in microSTX paid by sponsor */
  fee: string;
  /** Index of the wallet that signed this transaction (for nonce release routing) */
  walletIndex: number;
}

/**
 * Failed sponsoring result
 */
export interface SponsorFailure {
  success: false;
  error: string;
  details: string;
  /** Optional machine-readable error code for callers */
  code?: string;
}

/**
 * Result of transaction sponsoring (discriminated union)
 */
export type SponsorResult = SponsorSuccess | SponsorFailure;

// Module-level cache for derived sponsor keys (accountIndex → privateKey).
// Env vars cannot change during a worker instance's lifetime — when secrets are
// updated via `wrangler secret put`, workers restart with fresh instances.
const cachedSponsorKeys: Map<number, string> = new Map();

// Validation constants
const MAX_ACCOUNT_INDEX = 1000;
const MAX_WALLET_COUNT = 10;
const VALID_MNEMONIC_LENGTHS = [12, 24];

// Nonce fetch retry configuration
const NONCE_FETCH_MAX_ATTEMPTS = 3;
const NONCE_FETCH_BASE_DELAY_MS = 500;
/** Cap retry delay at 5s to stay well within Worker request time limits */
const NONCE_FETCH_MAX_DELAY_MS = 5000;

/**
 * Service for validating and sponsoring Stacks transactions
 */
export class SponsorService {
  private env: Env;
  private logger: Logger;

  constructor(env: Env, logger: Logger) {
    this.env = env;
    this.logger = logger;
  }

  /**
   * Parse and validate SPONSOR_WALLET_COUNT from env.
   * Returns a number in [1, MAX_WALLET_COUNT], defaulting to 1.
   */
  private getWalletCount(): number {
    const raw = this.env.SPONSOR_WALLET_COUNT;
    if (!raw) return 1;
    const n = parseInt(raw, 10);
    if (!Number.isInteger(n) || n < 1 || n > MAX_WALLET_COUNT) {
      this.logger.warn("Invalid SPONSOR_WALLET_COUNT; using 1", { raw });
      return 1;
    }
    return n;
  }

  /**
   * Derive private key for a specific account index from the mnemonic phrase.
   * Results are cached at module level to avoid re-derivation per request.
   */
  private async deriveSponsorKeyForIndex(accountIndex: number): Promise<string | null> {
    if (!this.env.SPONSOR_MNEMONIC) {
      return null;
    }

    // Validate mnemonic format (12 or 24 words)
    const words = this.env.SPONSOR_MNEMONIC.trim().split(/\s+/);
    if (!VALID_MNEMONIC_LENGTHS.includes(words.length)) {
      this.logger.error("Invalid SPONSOR_MNEMONIC; must be 12 or 24 words");
      return null;
    }

    // Validate account index range
    if (
      !Number.isInteger(accountIndex) ||
      accountIndex < 0 ||
      accountIndex > MAX_ACCOUNT_INDEX
    ) {
      this.logger.error("Invalid account index; must be 0-1000", { accountIndex });
      return null;
    }

    // Return cached key if available
    const cached = cachedSponsorKeys.get(accountIndex);
    if (cached !== undefined) {
      return cached;
    }

    this.logger.info("Deriving sponsor key from mnemonic", { accountIndex });

    try {
      const wallet = await generateWallet({
        secretKey: this.env.SPONSOR_MNEMONIC,
        // Empty password is intentional: the mnemonic is the sole secret in this
        // server-side context, no additional user passphrase is used.
        password: "",
      });

      // Generate accounts up to the needed index
      for (let i = wallet.accounts.length; i <= accountIndex; i++) {
        generateNewAccount(wallet);
      }

      const account = wallet.accounts[accountIndex];
      if (!account) {
        this.logger.error("Failed to derive account", { accountIndex });
        return null;
      }

      // Cache the derived key
      cachedSponsorKeys.set(accountIndex, account.stxPrivateKey);

      this.logger.info("Sponsor key derived successfully", { accountIndex });
      return account.stxPrivateKey;
    } catch (e) {
      this.logger.error("Failed to derive sponsor key from mnemonic", {
        accountIndex,
        error: e instanceof Error ? e.message : "Unknown error",
      });
      return null;
    }
  }

  /**
   * Get the sponsor private key for a specific wallet index.
   * walletIndex maps directly to the BIP-44 account index derived from the mnemonic.
   * Falls back to SPONSOR_PRIVATE_KEY only for walletIndex=0.
   */
  private async getSponsorKeyForWallet(walletIndex: number): Promise<string | null> {
    if (this.env.SPONSOR_MNEMONIC) {
      return this.deriveSponsorKeyForIndex(walletIndex);
    }

    // SPONSOR_PRIVATE_KEY fallback is only valid for wallet 0
    if (this.env.SPONSOR_PRIVATE_KEY && walletIndex === 0) {
      return this.env.SPONSOR_PRIVATE_KEY;
    }

    if (walletIndex !== 0) {
      this.logger.error(
        "Multi-wallet rotation requires SPONSOR_MNEMONIC; SPONSOR_PRIVATE_KEY only supports wallet 0",
        { walletIndex }
      );
    }

    return null;
  }

  /**
   * Get the Stacks network instance based on environment
   */
  private getNetwork() {
    return this.env.STACKS_NETWORK === "mainnet"
      ? STACKS_MAINNET
      : STACKS_TESTNET;
  }

  /**
   * Map PayloadType to FeeTransactionType for fee estimation
   */
  private payloadToFeeType(payloadType: PayloadType): FeeTransactionType {
    switch (payloadType) {
      case PayloadType.TokenTransfer:
        return "token_transfer";
      case PayloadType.ContractCall:
        return "contract_call";
      case PayloadType.SmartContract:
      case PayloadType.VersionedSmartContract:
        return "smart_contract";
      default:
        // Default to contract_call for unknown payload types
        this.logger.warn("Unknown payload type, defaulting to contract_call", {
          payloadType,
        });
        return "contract_call";
    }
  }

  /**
   * Compute the capped exponential backoff delay for a retry attempt.
   * For 429 responses, honours the Retry-After header when present.
   */
  private getRetryDelayMs(attempt: number, retryAfterHeader?: string | null): number {
    let delayMs = NONCE_FETCH_BASE_DELAY_MS * Math.pow(2, attempt - 1);

    if (retryAfterHeader != null) {
      const retryAfterMs = parseInt(retryAfterHeader, 10) * 1000;
      if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
        delayMs = retryAfterMs;
      }
    }

    return Math.min(delayMs, NONCE_FETCH_MAX_DELAY_MS);
  }

  /**
   * Fetch the sponsor account nonce from Hiro API with retry-with-backoff.
   * Retries on 429 (rate limit) and network errors up to NONCE_FETCH_MAX_ATTEMPTS.
   * Uses HIRO_API_KEY if configured for higher rate limits.
   * Returns the nonce as a bigint, or null if all attempts fail.
   */
  private async fetchNonceWithRetry(sponsorAddress: string): Promise<bigint | null> {
    const url = `${getHiroBaseUrl(this.env.STACKS_NETWORK)}/v2/accounts/${sponsorAddress}?proof=0`;
    const headers = getHiroHeaders(this.env.HIRO_API_KEY);

    for (let attempt = 1; attempt <= NONCE_FETCH_MAX_ATTEMPTS; attempt++) {
      const isLastAttempt = attempt === NONCE_FETCH_MAX_ATTEMPTS;

      try {
        const response = await fetch(url, {
          headers,
          signal: AbortSignal.timeout(5000),
        });

        if (response.status === 429) {
          this.logger.warn("Hiro API rate limited on nonce fetch, retrying", { attempt });
          if (!isLastAttempt) {
            const delayMs = this.getRetryDelayMs(attempt, response.headers.get("Retry-After"));
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
          continue;
        }

        if (!response.ok) {
          this.logger.warn("Hiro API error on nonce fetch", { attempt, status: response.status });
          if (!isLastAttempt) {
            await new Promise((resolve) => setTimeout(resolve, this.getRetryDelayMs(attempt)));
          }
          continue;
        }

        const data = (await response.json()) as { nonce?: number };
        if (typeof data?.nonce !== "number") {
          this.logger.warn("Hiro API nonce response missing nonce field", { attempt });
          return null;
        }

        this.logger.debug("Fetched sponsor nonce", { nonce: data.nonce, attempt });
        return BigInt(data.nonce);
      } catch (e) {
        this.logger.warn("Error fetching nonce from Hiro API", {
          attempt,
          error: e instanceof Error ? e.message : String(e),
        });
        if (!isLastAttempt) {
          await new Promise((resolve) => setTimeout(resolve, this.getRetryDelayMs(attempt)));
        }
      }
    }

    this.logger.error("Failed to fetch sponsor nonce after all retries", {
      attempts: NONCE_FETCH_MAX_ATTEMPTS,
    });
    return null;
  }

  /**
   * Fire-and-forget: trigger an immediate gap-aware nonce resync in the NonceDO.
   * Call this via executionCtx.waitUntil() after a BadNonce or ConflictingNonceInMempool
   * broadcast failure so the DO self-heals before the next request arrives.
   * Never throws — all errors are logged as warnings.
   */
  async resyncNonceDO(): Promise<void> {
    if (!this.env.NONCE_DO) {
      this.logger.debug("Nonce DO not configured; skipping resync");
      return;
    }

    try {
      const stub = this.env.NONCE_DO.get(this.env.NONCE_DO.idFromName("sponsor"));
      const response = await stub.fetch("https://nonce-do/resync", {
        method: "POST",
      });

      if (!response.ok) {
        const body = await response.text();
        this.logger.warn("Nonce DO resync responded with error", {
          status: response.status,
          body,
        });
        return;
      }

      const data = (await response.json()) as {
        success?: boolean;
        action?: string;
        changed?: boolean;
        reason?: string;
      };
      this.logger.info("Nonce DO resync completed", {
        changed: data.changed,
        reason: data.reason,
      });
    } catch (e) {
      this.logger.warn("Failed to resync NonceDO", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /**
   * Delayed resync: waits delayMs before calling resyncNonceDO so Hiro's mempool
   * index has time to catch up after a conflicting transaction is broadcast.
   * Call via executionCtx.waitUntil() after a nonce conflict broadcast failure.
   * Never throws — all errors are logged as warnings.
   */
  async resyncNonceDODelayed(delayMs = 2000): Promise<void> {
    try {
      await new Promise((r) => setTimeout(r, delayMs));
      await this.resyncNonceDO();
    } catch (e) {
      this.logger.warn("Failed to run delayed NonceDO resync", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /**
   * Fetch the sponsor account nonce from NonceDO when available.
   * Passes walletCount so NonceDO can do round-robin across N wallets.
   * Returns both nonce and walletIndex so SponsorService can pick the right key.
   */
  private async fetchNonceFromDO(
    sponsorAddress: string
  ): Promise<{ nonce: bigint; walletIndex: number } | null> {
    if (!this.env.NONCE_DO) {
      this.logger.debug("Nonce DO not configured; skipping DO nonce fetch");
      return null;
    }

    const walletCount = this.getWalletCount();

    try {
      const stub = this.env.NONCE_DO.get(this.env.NONCE_DO.idFromName("sponsor"));
      const response = await stub.fetch("https://nonce-do/assign", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sponsorAddress, walletCount }),
      });

      if (!response.ok) {
        this.logger.warn("Nonce DO responded with error", {
          status: response.status,
        });
        return null;
      }

      const data = (await response.json()) as { nonce?: number; walletIndex?: number };
      if (typeof data?.nonce !== "number") {
        this.logger.warn("Nonce DO response missing nonce field");
        return null;
      }

      const walletIndex = typeof data.walletIndex === "number" ? data.walletIndex : 0;
      return { nonce: BigInt(data.nonce), walletIndex };
    } catch (e) {
      this.logger.warn("Failed to fetch nonce from NonceDO", {
        error: e instanceof Error ? e.message : String(e),
      });
      return null;
    }
  }

  /**
   * Validate and deserialize a transaction
   */
  validateTransaction(txHex: string): TransactionValidationResult {
    // Remove 0x prefix if present
    const cleanHex = txHex.startsWith("0x") ? txHex.slice(2) : txHex;

    // Deserialize the transaction
    let transaction: StacksTransactionWire;
    try {
      transaction = deserializeTransaction(cleanHex);
    } catch (e) {
      this.logger.warn("Failed to deserialize transaction", {
        error: e instanceof Error ? e.message : "Unknown error",
      });
      return {
        valid: false,
        error: "Invalid transaction",
        details: "Could not deserialize transaction hex",
      };
    }

    // Verify it's a sponsored transaction
    if (transaction.auth.authType !== AuthType.Sponsored) {
      this.logger.warn("Transaction not sponsored", {
        auth_type: transaction.auth.authType,
      });
      return {
        valid: false,
        error: "Transaction must be sponsored",
        details: "Build transaction with sponsored: true",
      };
    }

    // Extract sender address for rate limiting
    const senderAddress = Buffer.from(
      transaction.auth.spendingCondition.signer
    ).toString("hex");

    return {
      valid: true,
      transaction,
      senderAddress,
    };
  }

  /**
   * Sponsor a validated transaction using round-robin wallet selection.
   *
   * When NONCE_DO is configured, fetchNonceFromDO returns both nonce and walletIndex.
   * The walletIndex determines which BIP-44 account key is used for signing.
   * The walletIndex is included in SponsorSuccess so callers can route release calls.
   */
  async sponsorTransaction(
    transaction: StacksTransactionWire
  ): Promise<SponsorResult> {
    const network = this.getNetwork();

    // Determine fee from FeeService to prevent overpayment
    let fee: number | undefined;
    try {
      const feeService = new FeeService(this.env, this.logger);
      const feeType = this.payloadToFeeType(transaction.payload.payloadType);
      fee = await feeService.getFeeForType(feeType, "medium_priority");
      this.logger.info("Using clamped fee from FeeService", {
        feeType,
        fee,
      });
    } catch (e) {
      // On failure, let @stacks/transactions estimate the fee (fallback)
      this.logger.warn("Failed to get clamped fee, falling back to node estimate", {
        error: e instanceof Error ? e.message : String(e),
      });
      fee = undefined;
    }

    // Pre-fetch the sponsor nonce from NonceDO (authoritative coordinator).
    // When NONCE_DO is configured, it also returns walletIndex for key selection.
    // If the DO is unreachable we fail fast (503) rather than silently falling back
    // to the uncoordinated Hiro path which causes nonce races.
    // When NONCE_DO is NOT configured (e.g. local dev), we fall back to Hiro with a warning.
    let sponsorNonce: bigint | undefined;
    let walletIndex = 0;

    if (this.env.NONCE_DO) {
      // Derive wallet 0 address first for nonce fetch request.
      // The DO will do round-robin internally and return the actual walletIndex used.
      const wallet0Key = await this.getSponsorKeyForWallet(0);
      if (!wallet0Key) {
        this.logger.error("Sponsor key not configured");
        return {
          success: false,
          error: "Service not configured",
          details: "Set SPONSOR_MNEMONIC or SPONSOR_PRIVATE_KEY",
        };
      }
      const wallet0Address = getAddressFromPrivateKey(wallet0Key, network);

      // NONCE_DO is configured — it is the authoritative source; fail fast if unavailable
      const doResult = await this.fetchNonceFromDO(wallet0Address);
      if (doResult !== null) {
        sponsorNonce = doResult.nonce;
        walletIndex = doResult.walletIndex;
        this.logger.debug("Using NonceDO sponsor nonce", {
          sponsorNonce: sponsorNonce.toString(),
          walletIndex,
        });
      } else {
        this.logger.error(
          "NonceDO is configured but unavailable; refusing to fall back to uncoordinated nonce"
        );
        return {
          success: false,
          error: "Nonce coordination service unavailable",
          details: "NonceDO did not return a nonce; retry in a few seconds",
          code: "NONCE_DO_UNAVAILABLE",
        };
      }
    } else {
      // NONCE_DO not configured — fall back to Hiro with a warning (local dev / unconfigured)
      this.logger.warn(
        "NONCE_DO not configured; falling back to uncoordinated Hiro nonce fetch"
      );
      walletIndex = 0; // single-wallet fallback always uses index 0

      const wallet0Key = await this.getSponsorKeyForWallet(0);
      if (!wallet0Key) {
        this.logger.error("Sponsor key not configured");
        return {
          success: false,
          error: "Service not configured",
          details: "Set SPONSOR_MNEMONIC or SPONSOR_PRIVATE_KEY",
        };
      }
      const sponsorAddress = getAddressFromPrivateKey(wallet0Key, network);
      const fetchedNonce = await this.fetchNonceWithRetry(sponsorAddress);
      if (fetchedNonce !== null) {
        sponsorNonce = fetchedNonce;
        this.logger.debug("Using Hiro fallback sponsor nonce", {
          sponsorNonce: sponsorNonce.toString(),
        });
      } else {
        // Let @stacks/transactions fetch internally as last resort
        this.logger.warn(
          "Hiro nonce fetch failed; falling back to internal nonce fetch"
        );
      }
    }

    // Get the sponsor key for the wallet index selected by NonceDO
    const sponsorKey = await this.getSponsorKeyForWallet(walletIndex);
    if (!sponsorKey) {
      this.logger.error("Sponsor key not configured for wallet", { walletIndex });
      return {
        success: false,
        error: "Service not configured",
        details: `Could not derive key for wallet index ${walletIndex}. Set SPONSOR_MNEMONIC.`,
      };
    }

    try {
      const sponsorOpts = {
        transaction,
        sponsorPrivateKey: sponsorKey,
        network,
        fee,
        sponsorNonce,
      };
      const sponsoredTx = await sponsorTransaction(sponsorOpts);

      // v7: serialize() returns hex string directly
      const sponsoredTxHex = sponsoredTx.serialize();

      // Extract fee from the sponsor's spending condition
      // For sponsored transactions, the fee is set by the sponsor
      let actualFee = "0";
      if (
        sponsoredTx.auth.authType === AuthType.Sponsored &&
        "sponsorSpendingCondition" in sponsoredTx.auth
      ) {
        const sponsorFee = sponsoredTx.auth.sponsorSpendingCondition.fee;
        const sponsorFeeStr = sponsorFee.toString();
        // Defensive check for negative fees
        if (sponsorFeeStr.startsWith("-")) {
          this.logger.warn(
            "Negative fee detected in sponsored transaction; using fee of 0 instead",
            { rawFee: sponsorFeeStr }
          );
        } else {
          actualFee = sponsorFeeStr;
        }
      }

      this.logger.info("Transaction sponsored", { fee: actualFee, walletIndex });

      return {
        success: true,
        sponsoredTxHex,
        fee: actualFee,
        walletIndex,
      };
    } catch (e) {
      this.logger.error("Failed to sponsor transaction", {
        error: e instanceof Error ? e.message : "Unknown error",
        walletIndex,
      });
      return {
        success: false,
        error: "Failed to sponsor transaction",
        details: e instanceof Error ? e.message : "Unknown error",
      };
    }
  }
}

export function extractSponsorNonce(
  transaction: StacksTransactionWire
): number | null {
  if (transaction.auth.authType !== AuthType.Sponsored) {
    return null;
  }

  if (!("sponsorSpendingCondition" in transaction.auth)) {
    return null;
  }

  const nonceNumber = Number(transaction.auth.sponsorSpendingCondition.nonce);

  if (!Number.isFinite(nonceNumber)) {
    return null;
  }

  return nonceNumber;
}

export async function recordNonceTxid(
  env: Env,
  logger: Logger,
  txid: string,
  nonce: number
): Promise<void> {
  if (!env.NONCE_DO) {
    return;
  }

  try {
    const stub = env.NONCE_DO.get(env.NONCE_DO.idFromName("sponsor"));
    const response = await stub.fetch("https://nonce-do/record", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ txid, nonce }),
    });

    if (!response.ok) {
      const body = await response.text();
      logger.warn("Nonce DO record failed", {
        status: response.status,
        body,
        txid,
        nonce,
      });
    }
  } catch (e) {
    logger.warn("Failed to record nonce txid", {
      error: e instanceof Error ? e.message : "Unknown error",
      txid,
      nonce,
    });
  }
}

/**
 * Release a nonce from the NonceDO reservation pool after a broadcast attempt.
 *
 * When txid is provided (broadcast succeeded): marks the nonce as consumed —
 * it is removed from reserved and NOT returned to available for reuse.
 * If fee is also provided, it is recorded in NonceDO's cumulative wallet stats.
 *
 * When txid is absent (broadcast failed): returns the nonce to available[]
 * in sorted order so it can be reused for the next request.
 *
 * walletIndex specifies which wallet pool to release to (default: 0).
 * Must match the walletIndex returned by the NonceDO /assign response.
 *
 * Call via executionCtx.waitUntil() as fire-and-forget — never blocks the response.
 * Never throws — all errors are logged as warnings.
 */
export async function releaseNonceDO(
  env: Env,
  logger: Logger,
  nonce: number,
  txid?: string,
  walletIndex: number = 0,
  fee?: string
): Promise<void> {
  if (!env.NONCE_DO) {
    return;
  }

  try {
    const stub = env.NONCE_DO.get(env.NONCE_DO.idFromName("sponsor"));
    const response = await stub.fetch("https://nonce-do/release", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        nonce,
        walletIndex,
        ...(txid ? { txid } : {}),
        ...(fee ? { fee } : {}),
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      logger.warn("Nonce DO release failed", {
        status: response.status,
        body,
        nonce,
        walletIndex,
        ...(txid ? { txid } : {}),
        ...(fee ? { fee } : {}),
      });
    }
  } catch (e) {
    logger.warn("Failed to release nonce to NonceDO", {
      error: e instanceof Error ? e.message : String(e),
      nonce,
      walletIndex,
      ...(txid ? { txid } : {}),
      ...(fee ? { fee } : {}),
    });
  }
}
