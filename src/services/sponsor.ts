import {
  sponsorTransaction,
  deserializeTransaction,
  getAddressFromPrivateKey,
  AuthType,
  PayloadType,
  AddressHashMode,
  addressHashModeToVersion,
  addressFromVersionHash,
  addressToString,
  type StacksTransactionWire,
} from "@stacks/transactions";
import { STACKS_MAINNET, STACKS_TESTNET } from "@stacks/network";
import {
  generateNewAccount,
  generateWallet,
} from "@stacks/wallet-sdk";
import { SERVICE_DEGRADED_RETRY_AFTER_S } from "../types";
import type { Env, Logger, FeeTransactionType, FeePriority, WalletStatus, WalletsResponse, HandSubmitResult, SponsorHeld } from "../types";
import { getHiroBaseUrl, getHiroHeaders, stripHexPrefix, decodeClarityUint } from "../utils";
import { FeeService } from "./fee";

/**
 * Typed error thrown by submitToHand() when the DO returns a 4xx validation
 * rejection (e.g., STALE_SENDER_NONCE). Callers catch this to fail fast
 * with an accurate error code instead of falling through to the legacy path.
 */
interface HandSubmitValidationError extends Error {
  code: string;
  isHandSubmitValidation: true;
}

function isHandSubmitValidationError(e: unknown): e is HandSubmitValidationError {
  return e instanceof Error && (e as HandSubmitValidationError).isHandSubmitValidation === true;
}

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
  /** Seconds the caller should wait before retrying (set for LOW_HEADROOM and similar transient errors) */
  retryAfter?: number;
}

/**
 * Result of transaction sponsoring (discriminated union)
 */
export type SponsorResult = SponsorSuccess | SponsorFailure | SponsorHeld;

// Module-level cache for derived sponsor keys (accountIndex → privateKey).
// Env vars cannot change during a worker instance's lifetime — when secrets are
// updated via `wrangler secret put`, workers restart with fresh instances.
const cachedSponsorKeys: Map<number, string> = new Map();

// Validation constants
const MAX_ACCOUNT_INDEX = 1000;
const MAX_WALLET_COUNT = 10;
const VALID_MNEMONIC_LENGTHS = [12, 24];

/**
 * Per-wallet chaining limit (mirrors NonceDO's CHAINING_LIMIT = 20).
 * Used to compute pool capacity for fee pressure calculations.
 * Pool capacity = SPONSOR_WALLET_COUNT * CHAINING_LIMIT_PER_WALLET.
 */
const CHAINING_LIMIT_PER_WALLET = 20;

// Nonce fetch retry configuration
const NONCE_FETCH_MAX_ATTEMPTS = 3;
const NONCE_FETCH_BASE_DELAY_MS = 500;
/** Cap retry delay at 5s to stay well within Worker request time limits */
const NONCE_FETCH_MAX_DELAY_MS = 5000;

/** Timeout for Hiro API nonce fetch requests (ms) */
const HIRO_NONCE_TIMEOUT_MS = 10000;
/** Timeout for Hiro API wallet balance fetch requests (ms) */
const HIRO_BALANCE_TIMEOUT_MS = 10000;

/**
 * Error body returned by NonceDO on assignment failure.
 * Shared between fetchNonceFromDO return type and JSON parsing.
 */
interface NonceDOErrorBody {
  error?: string;
  code?: string;
  mempoolDepth?: number;
  estimatedDrainSeconds?: number;
  retryAfterSeconds?: number;
  /** From ALL_WALLETS_DEGRADED — number of circuit-broken wallets */
  degradedCount?: number;
  /** From ALL_WALLETS_DEGRADED — total in-flight nonces */
  totalReserved?: number;
  /** From ALL_WALLETS_DEGRADED — total pool capacity */
  totalCapacity?: number;
}

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
      let wallet = await generateWallet({
        secretKey: this.env.SPONSOR_MNEMONIC,
        // Empty password is intentional: the mnemonic is the sole secret in this
        // server-side context, no additional user passphrase is used.
        password: "",
      });

      // Generate accounts up to the needed index
      // generateNewAccount returns a new wallet object (wallet-sdk v7)
      for (let i = wallet.accounts.length; i <= accountIndex; i++) {
        wallet = generateNewAccount(wallet);
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
   * Derive a c32check-encoded Stacks address from a transaction's spending condition.
   * Shared by validateTransaction() and validateNonSponsoredTransaction().
   */
  private deriveSenderAddress(transaction: StacksTransactionWire): string {
    const network = this.getNetwork();
    const { hashMode, signer } = transaction.auth.spendingCondition;
    const version = addressHashModeToVersion(hashMode as AddressHashMode, network);
    return addressToString(addressFromVersionHash(version, signer));
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
   * Select fee priority tier based on current pool pressure.
   *
   * Pool pressure = totalReserved / poolCapacity
   * where poolCapacity = walletCount * CHAINING_LIMIT_PER_WALLET.
   *
   * Thresholds:
   *   < 25% → low_priority    (saves fees during normal load)
   *   25-60% → medium_priority (standard priority)
   *   > 60% → high_priority   (burst load — reduce RBF risk)
   *
   * Returns "medium_priority" as a safe default when pool capacity cannot be determined.
   */
  private selectFeePriority(totalReserved: number, walletCount: number): FeePriority {
    const poolCapacity = walletCount * CHAINING_LIMIT_PER_WALLET;
    if (poolCapacity <= 0) {
      return "medium_priority";
    }
    const pressure = Math.min(1, totalReserved / poolCapacity);
    if (pressure < 0.25) return "low_priority";
    if (pressure < 0.60) return "medium_priority";
    return "high_priority";
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
          signal: AbortSignal.timeout(HIRO_NONCE_TIMEOUT_MS),
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
        wallets?: Array<{
          walletIndex: number;
          changed: boolean;
          reason: string;
        }>;
      };
      const walletsChanged = data.wallets?.filter((w) => w.changed).length ?? 0;
      this.logger.info("Nonce DO resync completed", {
        walletsChanged,
        walletCount: data.wallets?.length ?? 0,
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
   * Derive Stacks addresses for all configured wallets.
   * Returns a map of walletIndex (as string) → Stacks address.
   */
  private async deriveWalletAddresses(): Promise<Record<string, string>> {
    const network = this.getNetwork();
    const walletCount = this.getWalletCount();
    const addresses: Record<string, string> = {};
    for (let i = 0; i < walletCount; i++) {
      const key = await this.getSponsorKeyForWallet(i);
      if (key) {
        addresses[String(i)] = getAddressFromPrivateKey(key, network);
      }
    }
    return addresses;
  }

  /**
   * Fetch the sponsor account nonce from NonceDO when available.
   * Passes walletCount and per-wallet addresses so NonceDO can do round-robin
   * and seed each wallet's pool from the correct on-chain nonce.
   * Returns both nonce and walletIndex so SponsorService can pick the right key.
   *
   * On NonceDO error: returns a structured error with code instead of null,
   * so callers can propagate the correct HTTP status (e.g. 429 for chaining limit).
   */
  private async fetchNonceFromDO(
    sponsorAddress: string
  ): Promise<
    | { ok: true; nonce: bigint; walletIndex: number; totalReserved: number }
    | ({ ok: false; error: string; status: number } & NonceDOErrorBody)
  > {
    if (!this.env.NONCE_DO) {
      this.logger.debug("Nonce DO not configured; skipping DO nonce fetch");
      return { ok: false, error: "NONCE_DO not configured", status: 503 };
    }

    const walletCount = this.getWalletCount();
    const addresses = walletCount > 1 ? await this.deriveWalletAddresses() : undefined;

    try {
      const stub = this.env.NONCE_DO.get(this.env.NONCE_DO.idFromName("sponsor"));
      const response = await stub.fetch("https://nonce-do/assign", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sponsorAddress, walletCount, addresses }),
      });

      if (!response.ok) {
        // Parse the error body so callers can propagate specific codes (e.g. 429)
        let errorBody: NonceDOErrorBody = {};
        try {
          errorBody = (await response.json()) as NonceDOErrorBody;
        } catch {
          // response may not be JSON
        }
        this.logger.warn("Nonce DO responded with error", {
          status: response.status,
          code: errorBody.code,
          error: errorBody.error,
          mempoolDepth: errorBody.mempoolDepth,
          estimatedDrainSeconds: errorBody.estimatedDrainSeconds,
        });
        return {
          ok: false,
          code: errorBody.code,
          error: errorBody.error ?? `NonceDO error ${response.status}`,
          status: response.status,
          mempoolDepth: errorBody.mempoolDepth,
          estimatedDrainSeconds: errorBody.estimatedDrainSeconds,
          retryAfterSeconds: errorBody.retryAfterSeconds,
          totalReserved: errorBody.totalReserved,
          totalCapacity: errorBody.totalCapacity,
        };
      }

      const data = (await response.json()) as { nonce?: number; walletIndex?: number; totalReserved?: number };
      if (typeof data?.nonce !== "number") {
        this.logger.warn("Nonce DO response missing nonce field");
        return { ok: false, error: "NonceDO response missing nonce field", status: 500 };
      }

      const walletIndex = typeof data.walletIndex === "number" ? data.walletIndex : 0;
      const totalReserved = typeof data.totalReserved === "number" ? data.totalReserved : 0;
      return { ok: true, nonce: BigInt(data.nonce), walletIndex, totalReserved };
    } catch (e) {
      this.logger.warn("Failed to fetch nonce from NonceDO", {
        error: e instanceof Error ? e.message : String(e),
      });
      return { ok: false, error: e instanceof Error ? e.message : String(e), status: 503 };
    }
  }

  /**
   * Submit a transaction to the NonceDO hand-submit endpoint.
   * The DO adds it to the sender's hand and checks for a gapless run.
   * Returns the HandSubmitResult, or null if the DO is unavailable (fall back to legacy path).
   *
   * @param mode - "hold" (default): insert into hand even if held (async callers like /relay).
   *               "immediate": reject without inserting if a gap exists (sync callers like /sponsor).
   */
  private async submitToHand(
    senderAddress: string,
    senderNonce: number,
    txHex: string,
    mode: "hold" | "immediate" = "hold"
  ): Promise<HandSubmitResult | null> {
    if (!this.env.NONCE_DO) return null;
    try {
      const stub = this.env.NONCE_DO.get(this.env.NONCE_DO.idFromName("sponsor"));
      const response = await stub.fetch("https://nonce-do/hand-submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ senderAddress, senderNonce, txHex, mode }),
      });

      if (!response.ok) {
        const text = await response.text();
        this.logger.warn("NonceDO /hand-submit error", {
          status: response.status,
          body: text,
        });
        // Propagate 4xx validation errors (e.g., STALE_SENDER_NONCE) so callers
        // can fail fast with an accurate code. Only return null for 5xx/timeouts
        // (unavailable) to fall through to the legacy path.
        if (response.status >= 400 && response.status < 500) {
          let parsed: { error?: string; code?: string } = {};
          try { parsed = JSON.parse(text); } catch { /* use defaults */ }
          const err = new Error(parsed.error ?? `NonceDO rejected with ${response.status}`);
          (err as HandSubmitValidationError).code = parsed.code ?? "DO_VALIDATION_ERROR";
          (err as HandSubmitValidationError).isHandSubmitValidation = true;
          throw err;
        }
        return null;
      }

      return (await response.json()) as HandSubmitResult;
    } catch (e) {
      this.logger.warn("Failed to call NonceDO /hand-submit", {
        error: e instanceof Error ? e.message : String(e),
      });
      return null;
    }
  }

  /**
   * Fast O(1) pre-validation of transaction hex before expensive deserialization.
   *
   * Checks:
   * 1. Valid hex string (even length, only 0-9a-fA-F chars)
   * 2. Minimum length (at least 2 bytes = 4 hex chars)
   * 3. Version byte (byte 0): 0x00 for mainnet, 0x80 for testnet
   * 4. Auth type byte (byte 1): 0x04 (Standard) or 0x05 (Sponsored)
   *
   * Input must already have the 0x prefix stripped (use stripHexPrefix first).
   */
  private preValidateTxHex(cleanHex: string): { valid: true } | { valid: false; reason: string } {
    // Must be a valid hex string (even length, only hex chars)
    if (cleanHex.length === 0) {
      return { valid: false, reason: "Transaction hex is empty" };
    }
    if (cleanHex.length % 2 !== 0) {
      return { valid: false, reason: "Transaction hex has odd length — not valid hex" };
    }
    if (!/^[0-9a-fA-F]+$/.test(cleanHex)) {
      return { valid: false, reason: "Transaction hex contains non-hex characters" };
    }

    // Must have at least 2 bytes (version + auth type)
    if (cleanHex.length < 4) {
      return { valid: false, reason: "Transaction hex too short — must be at least 2 bytes" };
    }

    // Check version byte (byte 0)
    const versionByte = parseInt(cleanHex.slice(0, 2), 16);
    const isMainnet = this.env.STACKS_NETWORK === "mainnet";
    const expectedVersionByte = isMainnet ? 0x00 : 0x80;
    if (versionByte !== expectedVersionByte) {
      return {
        valid: false,
        reason: `Invalid transaction version byte 0x${versionByte.toString(16).padStart(2, "0")} for ${this.env.STACKS_NETWORK} — expected 0x${expectedVersionByte.toString(16).padStart(2, "0")}`,
      };
    }

    // Check auth type byte (byte 1): 0x04 = Standard, 0x05 = Sponsored
    const authTypeByte = parseInt(cleanHex.slice(2, 4), 16);
    if (authTypeByte !== 0x04 && authTypeByte !== 0x05) {
      return {
        valid: false,
        reason: `Invalid auth type byte 0x${authTypeByte.toString(16).padStart(2, "0")} — expected 0x04 (Standard) or 0x05 (Sponsored)`,
      };
    }

    return { valid: true };
  }

  /**
   * Validate and deserialize a non-sponsored (standard auth) transaction for self-pay settlement.
   * Rejects sponsored transactions — callers that want to sponsor should use validateTransaction().
   */
  validateNonSponsoredTransaction(txHex: string): TransactionValidationResult {
    const cleanHex = stripHexPrefix(txHex);

    // Fast pre-validation: check hex format and header bytes before expensive deserialization
    const preCheck = this.preValidateTxHex(cleanHex);
    if (!preCheck.valid) {
      return {
        valid: false,
        error: "Malformed transaction payload",
        details: preCheck.reason,
      };
    }

    let transaction: StacksTransactionWire;
    try {
      transaction = deserializeTransaction(cleanHex);
    } catch (e) {
      this.logger.info("Failed to deserialize transaction", {
        error: e instanceof Error ? e.message : "Unknown error",
      });
      return {
        valid: false,
        error: "Invalid transaction",
        details: "Could not deserialize transaction hex",
      };
    }

    // Reject sponsored transactions — self-pay requires standard auth
    if (transaction.auth.authType === AuthType.Sponsored) {
      this.logger.info("Self-pay transaction must not be sponsored");
      return {
        valid: false,
        error: "Transaction must not be sponsored for self-pay settlement",
        details: "Remove sponsored: true when building the transaction for X-Settlement: self-pay",
      };
    }

    return {
      valid: true,
      transaction,
      senderAddress: this.deriveSenderAddress(transaction),
    };
  }

  /**
   * Validate and deserialize a transaction
   */
  validateTransaction(txHex: string): TransactionValidationResult {
    const cleanHex = stripHexPrefix(txHex);

    // Fast pre-validation: check hex format and header bytes before expensive deserialization
    const preCheck = this.preValidateTxHex(cleanHex);
    if (!preCheck.valid) {
      return {
        valid: false,
        error: "Malformed transaction payload",
        details: preCheck.reason,
      };
    }

    // Deserialize the transaction
    let transaction: StacksTransactionWire;
    try {
      transaction = deserializeTransaction(cleanHex);
    } catch (e) {
      this.logger.info("Failed to deserialize transaction", {
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
      this.logger.info("Transaction not sponsored", {
        auth_type: transaction.auth.authType,
      });
      return {
        valid: false,
        error: "Transaction must be sponsored",
        details: "Build transaction with sponsored: true",
      };
    }

    return {
      valid: true,
      transaction,
      senderAddress: this.deriveSenderAddress(transaction),
    };
  }

  /**
   * Sponsor a validated transaction using round-robin wallet selection.
   *
   * When NONCE_DO is configured, routes through the gin rummy hand-submit path:
   * the tx is added to the sender's hand and checked for a gapless run. If a run
   * exists, the nonce is assigned and sponsoring proceeds. If the tx fills a gap,
   * it is held and SponsorHeld is returned.
   *
   * Falls back to the legacy fetchNonceFromDO path when hand-submit is unavailable.
   *
   * @param transaction - The deserialized sponsored transaction to sign
   * @param originalTxHex - Original hex for hand-submit (defaults to re-serialized)
   * @param mode - "hold" (default): queue tx even if held (for /relay and /settle async paths).
   *               "immediate": reject without queuing if a gap exists (for /sponsor sync path).
   */
  async sponsorTransaction(
    transaction: StacksTransactionWire,
    originalTxHex?: string,
    mode: "hold" | "immediate" = "hold"
  ): Promise<SponsorResult> {
    const network = this.getNetwork();

    // Pre-fetch the sponsor nonce from NonceDO (authoritative coordinator).
    // When NONCE_DO is configured, it also returns walletIndex for key selection
    // and totalReserved for pool-pressure-aware fee tier selection.
    // If the DO is unreachable we fail fast (503) rather than silently falling back
    // to the uncoordinated Hiro path which causes nonce races.
    // When NONCE_DO is NOT configured (e.g. local dev), we fall back to Hiro with a warning.
    let sponsorNonce: bigint | undefined;
    let walletIndex = 0;
    // Track whether NonceDO assigned a nonce so we can release it on any failure path
    let nonceFromDO = false;
    let assignedNonceValue: number | undefined;
    // Pool pressure data from NonceDO for fee tier selection (0 = no data / low pressure)
    let totalReserved = 0;

    if (this.env.NONCE_DO) {
      // --- Gin rummy dispatch path ---
      // Extract sender identity from the deserialized transaction
      const senderNonce = Number(transaction.auth.spendingCondition.nonce);
      // Use the provided originalTxHex, or re-serialize the transaction as fallback
      const txHexForHand = originalTxHex ?? transaction.serialize();

      // Derive senderAddress from the transaction's spending condition hash
      const senderAddress = this.deriveSenderAddress(transaction);

      let handResult: HandSubmitResult | null;
      try {
        handResult = await this.submitToHand(senderAddress, senderNonce, txHexForHand, mode);
      } catch (e) {
        if (isHandSubmitValidationError(e)) {
          // DO returned a 4xx validation rejection (e.g., STALE_SENDER_NONCE).
          // Fail fast with an accurate code instead of falling to legacy path.
          this.logger.warn("NonceDO validation rejection", { code: e.code, error: e.message });
          return {
            success: false,
            error: e.message,
            details: `NonceDO rejected: ${e.code}`,
            code: e.code,
          };
        }
        throw e;
      }

      if (handResult !== null) {
        if (!handResult.dispatched) {
          // Tx is held — gap exists in the sender's nonce sequence
          this.logger.info(
            mode === "immediate"
              ? "Nonce gap — rejected (immediate mode, not enqueued)"
              : "Transaction held in sender hand — nonce gap",
            {
              senderAddress,
              senderNonce,
              nextExpected: handResult.nextExpected,
              missingNonces: handResult.missingNonces,
              mode,
            }
          );
          return {
            success: false,
            held: true,
            nextExpected: handResult.nextExpected,
            missingNonces: handResult.missingNonces,
            handSize: handResult.handSize,
            expiresAt: handResult.expiresAt,
            holdReason: handResult.missingNonces.length > 0 ? "gap" : "capacity",
            // Forward recently-expired nonce info so agents can understand why their
            // previously-submitted nonces disappeared from the queue after the 5-min timeout.
            ...(handResult.recentlyExpired && { recentlyExpired: handResult.recentlyExpired }),
          } satisfies SponsorHeld;
        }

        // Dispatched — use the assigned nonce and wallet index from the DO
        sponsorNonce = BigInt(handResult.sponsorNonce);
        walletIndex = handResult.walletIndex;
        nonceFromDO = true;
        assignedNonceValue = handResult.sponsorNonce;
        this.logger.debug("Transaction dispatched via hand-submit", {
          senderAddress,
          senderNonce,
          sponsorNonce: handResult.sponsorNonce,
          walletIndex,
        });
      } else {
        // hand-submit failed (DO unavailable or error) — fall back to legacy assign path
        this.logger.warn("hand-submit unavailable; falling back to legacy assign path");

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

        const doResult = await this.fetchNonceFromDO(wallet0Address);
        if (doResult.ok) {
          sponsorNonce = doResult.nonce;
          walletIndex = doResult.walletIndex;
          totalReserved = doResult.totalReserved;
          nonceFromDO = true;
          assignedNonceValue = Number(doResult.nonce);
          this.logger.debug("Using legacy NonceDO sponsor nonce (hand-submit fallback)", {
            sponsorNonce: sponsorNonce.toString(),
            walletIndex,
            totalReserved,
          });
        } else {
          // Propagate specific error codes from NonceDO
          const isChainingLimit = doResult.code === "CHAINING_LIMIT_EXCEEDED";
          const isLowHeadroom = doResult.code === "LOW_HEADROOM";
          const isAllDegraded = doResult.code === "ALL_WALLETS_DEGRADED";
          let code: string;
          if (isAllDegraded) {
            code = "SERVICE_DEGRADED";
          } else if (isChainingLimit) {
            code = "RATE_LIMIT_EXCEEDED";
          } else if (isLowHeadroom) {
            code = "LOW_HEADROOM";
          } else {
            code = "NONCE_DO_UNAVAILABLE";
          }
          this.logger.error("NonceDO nonce assignment failed", {
            code: doResult.code,
            error: doResult.error,
            status: doResult.status,
            mempoolDepth: doResult.mempoolDepth,
            estimatedDrainSeconds: doResult.estimatedDrainSeconds,
            retryAfterSeconds: doResult.retryAfterSeconds,
          });

          let details: string;
          let retryAfter: number | undefined;
          if (isAllDegraded) {
            const totalReserved = doResult.totalReserved ?? 0;
            const totalCapacity = doResult.totalCapacity ?? 0;
            details =
              `All sponsor wallets are circuit-broken due to nonce contention. ` +
              `${totalReserved} nonces in-flight out of ${totalCapacity} capacity. ` +
              `Retry in ${SERVICE_DEGRADED_RETRY_AFTER_S}s after the pool recovers.`;
            retryAfter = SERVICE_DEGRADED_RETRY_AFTER_S;
          } else if (isChainingLimit && doResult.mempoolDepth !== undefined && doResult.estimatedDrainSeconds !== undefined) {
            details = `All sponsor wallets at chaining limit (mempool depth: ${doResult.mempoolDepth}); retry in ~${doResult.estimatedDrainSeconds}s`;
          } else if (isChainingLimit) {
            details = "All sponsor wallets at chaining limit; retry in a few seconds";
          } else if (isLowHeadroom && doResult.retryAfterSeconds !== undefined) {
            details = `Nonce pool headroom is low; retry in ~${doResult.retryAfterSeconds}s`;
            retryAfter = doResult.retryAfterSeconds;
          } else if (isLowHeadroom) {
            details = "Nonce pool headroom is low; retry in a few seconds";
          } else {
            details = "NonceDO did not return a nonce; retry in a few seconds";
          }

          return {
            success: false,
            error: doResult.error,
            details,
            code,
            retryAfter,
          };
        }
      }
    } else {
      // NONCE_DO not configured — fall back to Hiro with a warning (local dev / unconfigured)
      this.logger.warn(
        "NONCE_DO not configured; falling back to uncoordinated Hiro nonce fetch"
      );
      // walletIndex stays 0 (initialized above) — single-wallet fallback

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
      // Release the reserved nonce back to pool since we can't sign
      if (nonceFromDO && assignedNonceValue !== undefined) {
        await releaseNonceDO(this.env, this.logger, assignedNonceValue, undefined, walletIndex);
      }
      return {
        success: false,
        error: "Service not configured",
        details: `Could not derive key for wallet index ${walletIndex}. Set SPONSOR_MNEMONIC.`,
      };
    }

    // Select fee tier based on pool pressure (see selectFeePriority for thresholds)
    let fee: number | undefined;
    const walletCount = this.getWalletCount();
    const feePriority = this.selectFeePriority(totalReserved, walletCount);
    try {
      const feeService = new FeeService(this.env, this.logger);
      const feeType = this.payloadToFeeType(transaction.payload.payloadType);
      const { fees, source: feeSource } = await feeService.getEstimates();
      const feeTiers = fees[feeType] ?? fees.contract_call;
      fee = feeTiers[feePriority];
      const poolCapacity = walletCount * CHAINING_LIMIT_PER_WALLET;
      this.logger.info("Using clamped fee from FeeService", {
        feeType,
        fee,
        feeSource,
        feePriority,
        poolPressurePct: poolCapacity > 0 ? Math.round((totalReserved / poolCapacity) * 100) : 0,
        totalReserved,
        poolCapacity,
      });
    } catch (e) {
      // On failure, let @stacks/transactions estimate the fee (fallback)
      this.logger.warn("Failed to get clamped fee, falling back to node estimate", {
        error: e instanceof Error ? e.message : String(e),
      });
      fee = undefined;
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
      // Release the reserved nonce back to pool since broadcast never happened
      if (nonceFromDO && assignedNonceValue !== undefined) {
        await releaseNonceDO(this.env, this.logger, assignedNonceValue, undefined, walletIndex);
      }
      return {
        success: false,
        error: "Failed to sponsor transaction",
        details: e instanceof Error ? e.message : "Unknown error",
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Wallet status monitoring
  // ---------------------------------------------------------------------------

  /** Balance thresholds in microSTX for classifying wallet health */
  private static readonly LOW_BALANCE_WARNING = "1000000";   // 1 STX
  private static readonly DEPLETED_THRESHOLD = "100000";     // 0.1 STX

  /**
   * Fetch the STX balance for a sponsor wallet address from Hiro.
   * Caches the result in RELAY_KV for 60 seconds to avoid hammering the API.
   * Returns balance as a microSTX string, or "0" on failure.
   */
  private async fetchWalletBalance(address: string): Promise<string> {
    const cacheKey = `wallet_balance:${address}`;

    // Try cache first
    if (this.env.RELAY_KV) {
      try {
        const cached = await this.env.RELAY_KV.get(cacheKey);
        if (cached !== null) {
          return cached;
        }
      } catch (_e) {
        // Cache miss — proceed to live fetch
      }
    }

    // Live fetch from Hiro
    const url = `${getHiroBaseUrl(this.env.STACKS_NETWORK)}/v2/accounts/${address}?proof=0`;
    const headers = getHiroHeaders(this.env.HIRO_API_KEY);
    try {
      const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(HIRO_BALANCE_TIMEOUT_MS),
      });
      if (!response.ok) {
        this.logger.warn("Hiro account endpoint error for wallet balance", {
          address,
          status: response.status,
        });
        return "0";
      }
      const data = (await response.json()) as { balance?: string };
      const rawBalance = typeof data?.balance === "string" ? data.balance : "0";
      // Hiro /v2/accounts returns balance as Clarity-encoded hex (e.g. "0x000...1451535f").
      // Decode to decimal microSTX string for display.
      const balance = decodeClarityUint(rawBalance);

      // Cache the result for 60 seconds
      if (this.env.RELAY_KV) {
        await this.env.RELAY_KV.put(cacheKey, balance, { expirationTtl: 60 }).catch(() => {});
      }

      return balance;
    } catch (e) {
      this.logger.warn("Failed to fetch wallet balance from Hiro", {
        address,
        error: e instanceof Error ? e.message : String(e),
      });
      return "0";
    }
  }

  /**
   * Fetch per-wallet fee stats from NonceDO /wallet-fees/:index.
   * Returns zeroed stats on failure.
   */
  private async fetchWalletFeeStats(walletIndex: number): Promise<{
    totalFeesSpent: string;
    txCount: number;
    txCountToday: number;
    feesToday: string;
    gapFillFeesTotal: string;
    gapFillCount: number;
  }> {
    const empty = { totalFeesSpent: "0", txCount: 0, txCountToday: 0, feesToday: "0", gapFillFeesTotal: "0", gapFillCount: 0 };
    if (!this.env.NONCE_DO) {
      return empty;
    }
    try {
      const stub = this.env.NONCE_DO.get(this.env.NONCE_DO.idFromName("sponsor"));
      const response = await stub.fetch(`https://nonce-do/wallet-fees/${walletIndex}`, {
        method: "GET",
      });
      if (!response.ok) {
        return empty;
      }
      const data = (await response.json()) as Partial<typeof empty>;
      return {
        totalFeesSpent: typeof data.totalFeesSpent === "string" ? data.totalFeesSpent : "0",
        txCount: typeof data.txCount === "number" ? data.txCount : 0,
        txCountToday: typeof data.txCountToday === "number" ? data.txCountToday : 0,
        feesToday: typeof data.feesToday === "string" ? data.feesToday : "0",
        gapFillFeesTotal: typeof data.gapFillFeesTotal === "string" ? data.gapFillFeesTotal : "0",
        gapFillCount: typeof data.gapFillCount === "number" ? data.gapFillCount : 0,
      };
    } catch (e) {
      this.logger.warn("Failed to fetch wallet fee stats from NonceDO", {
        walletIndex,
        error: e instanceof Error ? e.message : String(e),
      });
      return empty;
    }
  }

  /**
   * Fetch the current pool state for all wallets from NonceDO /stats.
   * Returns a map of walletIndex → { available, reserved, maxNonce }.
   */
  private async fetchNoncePoolStats(): Promise<Map<number, { available: number; reserved: number; maxNonce: number }>> {
    const result = new Map<number, { available: number; reserved: number; maxNonce: number }>();
    if (!this.env.NONCE_DO) {
      return result;
    }
    try {
      const stub = this.env.NONCE_DO.get(this.env.NONCE_DO.idFromName("sponsor"));
      const response = await stub.fetch("https://nonce-do/stats", { method: "GET" });
      if (!response.ok) {
        return result;
      }
      const data = (await response.json()) as { wallets?: Array<{ walletIndex: number; available: number; reserved: number; maxNonce: number }> };
      for (const w of data.wallets ?? []) {
        result.set(w.walletIndex, {
          available: w.available ?? 0,
          reserved: w.reserved ?? 0,
          maxNonce: w.maxNonce ?? 0,
        });
      }
    } catch (e) {
      this.logger.warn("Failed to fetch nonce pool stats from NonceDO", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
    return result;
  }

  /**
   * Classify wallet health based on current STX balance.
   */
  private classifyWalletStatus(balance: string): "healthy" | "low_balance" | "depleted" {
    try {
      const b = BigInt(balance || "0");
      if (b >= BigInt(SponsorService.LOW_BALANCE_WARNING)) return "healthy";
      if (b >= BigInt(SponsorService.DEPLETED_THRESHOLD)) return "low_balance";
      return "depleted";
    } catch {
      return "depleted";
    }
  }

  /**
   * Get the status of all configured sponsor wallets.
   * Fetches balances from Hiro (60s cache), fee stats from NonceDO,
   * and pool state from NonceDO. Returns a WalletsResponse for GET /wallets.
   */
  async getWalletStatuses(): Promise<WalletsResponse> {
    const network = this.getNetwork();
    const walletCount = this.getWalletCount();

    // Fetch pool stats once (all wallets in one NonceDO call)
    const poolStats = await this.fetchNoncePoolStats();

    // Build per-wallet status in parallel
    const walletPromises: Promise<WalletStatus>[] = [];
    for (let i = 0; i < walletCount; i++) {
      walletPromises.push((async (walletIndex: number): Promise<WalletStatus> => {
        const key = await this.getSponsorKeyForWallet(walletIndex);
        const address = key ? getAddressFromPrivateKey(key, network) : `wallet-${walletIndex}-unconfigured`;

        const [balance, feeStats] = await Promise.all([
          key ? this.fetchWalletBalance(address) : Promise.resolve("0"),
          this.fetchWalletFeeStats(walletIndex),
        ]);

        const pool = poolStats.get(walletIndex) ?? { available: 0, reserved: 0, maxNonce: 0 };
        const status = this.classifyWalletStatus(balance);

        return {
          index: walletIndex,  // integer loop counter, never null
          address,
          balance,
          totalFeesSpent: feeStats.totalFeesSpent ?? "0",
          txCount: feeStats.txCount ?? 0,
          txCountToday: feeStats.txCountToday ?? 0,
          feesToday: feeStats.feesToday ?? "0",
          gapFillFeesTotal: feeStats.gapFillFeesTotal ?? "0",
          gapFillCount: feeStats.gapFillCount ?? 0,
          pool,
          status,
        };
      })(i));
    }

    const wallets = await Promise.all(walletPromises);

    // Aggregate totals
    let totalBalance = BigInt(0);
    let totalFeesSpent = BigInt(0);
    let totalTxCount = 0;
    for (const w of wallets) {
      try { totalBalance += BigInt(w.balance || "0"); } catch { /* skip */ }
      try { totalFeesSpent += BigInt(w.totalFeesSpent || "0"); } catch { /* skip */ }
      totalTxCount += w.txCount;
    }

    return {
      wallets,
      totals: {
        totalBalance: totalBalance.toString(),
        totalFeesSpent: totalFeesSpent.toString(),
        totalTxCount,
        walletCount,
      },
      thresholds: {
        lowBalanceWarning: SponsorService.LOW_BALANCE_WARNING,
        depletedThreshold: SponsorService.DEPLETED_THRESHOLD,
      },
    };
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

/**
 * Determines whether a transaction's sponsor authorization slot is already filled.
 *
 * Returns `true` when the transaction is ready to broadcast as-is:
 *   - Non-sponsored transactions (authType !== Sponsored) — no sponsor needed
 *   - Sponsored transactions where the sponsor has already set a non-zero fee
 *     and a non-zero signer hash
 *
 * Returns `false` when the sponsor slot is empty and sponsoring is required:
 *   - Sponsored transactions where fee === 0n (no fee set yet)
 *   - Sponsored transactions where the signer is all-zeros (placeholder hash)
 *   - Sponsored transactions missing the sponsorSpendingCondition entirely
 *
 * This is the canonical check for detecting client-built "stub" sponsored transactions
 * (built with `sponsored: true, fee: 0n`) that need the relay to fill in the sponsor slot.
 */
export function hasSponsorSignature(transaction: StacksTransactionWire): boolean {
  if (transaction.auth.authType !== AuthType.Sponsored) {
    return true;
  }

  if (!("sponsorSpendingCondition" in transaction.auth)) {
    return false;
  }

  const sponsorCondition = transaction.auth.sponsorSpendingCondition;

  if (sponsorCondition.fee === 0n) {
    return false;
  }

  // All-zeros signer = placeholder hash (20 bytes = 40 hex chars)
  const signerHex = sponsorCondition.signer.replace(/^0x/, "");
  if (signerHex.length > 0 && /^0+$/.test(signerHex)) {
    return false;
  }

  return true;
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
 * Record the broadcast outcome for a nonce in the NonceDO intent ledger.
 * Closes the observability loop by writing http_status, node_url, txid, and
 * error_reason directly into nonce_intents.
 *
 * On success (txid non-empty): state → 'broadcasted', records txid/http_status/broadcast_node.
 * On conflict (ConflictingNonceInMempool): state → 'conflict'.
 * On other failure: state → 'failed' with error_reason and http_status.
 *
 * Call via executionCtx.waitUntil() as fire-and-forget alongside releaseNonceDO().
 * Never throws — all errors are logged as warnings.
 *
 * @param nonce - The sponsor nonce used for this broadcast
 * @param walletIndex - Wallet index that owns this nonce
 * @param txid - Transaction ID on success; undefined on failure
 * @param httpStatus - HTTP status code returned by the broadcast node (0 for network exceptions)
 * @param nodeUrl - Base URL of the broadcast node; undefined when not available
 * @param errorReason - Error string on failure; undefined on success
 */
export async function recordBroadcastOutcomeDO(
  env: Env,
  logger: Logger,
  nonce: number,
  walletIndex: number,
  txid: string | undefined,
  httpStatus: number | undefined,
  nodeUrl: string | undefined,
  errorReason: string | undefined
): Promise<void> {
  if (!env.NONCE_DO) {
    return;
  }
  try {
    const stub = env.NONCE_DO.get(env.NONCE_DO.idFromName("sponsor"));
    const response = await stub.fetch("https://nonce-do/broadcast-outcome", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nonce, walletIndex, txid, httpStatus, nodeUrl, errorReason }),
    });
    if (!response.ok) {
      const body = await response.text();
      logger.warn("Nonce DO broadcast-outcome record failed", {
        status: response.status,
        body,
        nonce,
        walletIndex,
      });
    }
  } catch (e) {
    logger.warn("Failed to record broadcast outcome in NonceDO", {
      error: e instanceof Error ? e.message : String(e),
      nonce,
      walletIndex,
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
  fee?: string,
  errorReason?: string
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
        ...(errorReason ? { errorReason } : {}),
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
        ...(errorReason ? { errorReason } : {}),
      });
    }
  } catch (e) {
    logger.warn("Failed to release nonce to NonceDO", {
      error: e instanceof Error ? e.message : String(e),
      nonce,
      walletIndex,
      ...(txid ? { txid } : {}),
      ...(fee ? { fee } : {}),
      ...(errorReason ? { errorReason } : {}),
    });
  }
}

/**
 * Record a sender transaction in the NonceDO dispatch queue after successful broadcast.
 * This allows the reconciliation loop to track, flush, and replay stuck transactions.
 *
 * Call via executionCtx.waitUntil() as fire-and-forget alongside recordBroadcastOutcomeDO().
 * Never throws — all errors are logged as warnings.
 */
/**
 * Fire-and-forget nonce lifecycle calls after a successful broadcast.
 * Consolidates the four parallel DO calls (release, recordTxid, broadcastOutcome,
 * queueDispatch) into a single waitUntil-friendly promise.
 * Never throws — all errors are logged as warnings.
 */
export async function nonceLifecycleOnBroadcastSuccess(
  env: Env,
  logger: Logger,
  opts: {
    sponsorNonce: number;
    walletIndex: number;
    txid: string;
    fee?: string;
    senderTxHex: string;
    senderAddress: string;
    senderNonce: number;
  }
): Promise<void> {
  // Record broadcast outcome FIRST so ledgerBroadcastOutcome() runs while state is
  // still non-terminal. If releaseNonceDO() ran first the nonce would already be
  // terminal and the outcome write would be skipped.
  try {
    await recordBroadcastOutcomeDO(
      env, logger, opts.sponsorNonce, opts.walletIndex,
      opts.txid, 200, undefined, undefined
    );
  } catch (e) {
    logger.warn("Failed to record broadcast outcome", { error: String(e) });
  }

  // Now release nonce and queue dispatch in parallel (order-independent)
  await Promise.all([
    releaseNonceDO(env, logger, opts.sponsorNonce, opts.txid, opts.walletIndex, opts.fee),
    recordNonceTxid(env, logger, opts.txid, opts.sponsorNonce),
    queueDispatchDO(
      env, logger, opts.walletIndex,
      opts.senderTxHex, opts.senderAddress,
      opts.senderNonce, opts.sponsorNonce,
      opts.fee ?? null
    ),
  ]).catch((e) => {
    logger.warn("Failed nonce lifecycle after broadcast success", { error: String(e) });
  });
}

export async function queueDispatchDO(
  env: Env,
  logger: Logger,
  walletIndex: number,
  senderTxHex: string,
  senderAddress: string,
  senderNonce: number,
  sponsorNonce: number,
  fee?: string | null
): Promise<void> {
  if (!env.NONCE_DO) {
    return;
  }
  try {
    const stub = env.NONCE_DO.get(env.NONCE_DO.idFromName("sponsor"));
    const response = await stub.fetch("https://nonce-do/queue-dispatch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        walletIndex,
        senderTxHex,
        senderAddress,
        senderNonce,
        sponsorNonce,
        fee: fee ?? null,
      }),
    });
    if (!response.ok) {
      const body = await response.text();
      logger.warn("Nonce DO queue-dispatch failed", {
        status: response.status,
        body,
        walletIndex,
        sponsorNonce,
      });
    }
  } catch (e) {
    logger.warn("Failed to record queue dispatch in NonceDO", {
      error: e instanceof Error ? e.message : String(e),
      walletIndex,
      sponsorNonce,
    });
  }
}
