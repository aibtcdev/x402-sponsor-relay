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
}

/**
 * Failed sponsoring result
 */
export interface SponsorFailure {
  success: false;
  error: string;
  details: string;
}

/**
 * Result of transaction sponsoring (discriminated union)
 */
export type SponsorResult = SponsorSuccess | SponsorFailure;

// Module-level cache for derived sponsor key.
// Env vars cannot change during a worker instance's lifetime - when secrets are
// updated via `wrangler secret put`, workers restart with fresh instances.
let cachedSponsorKey: string | null = null;
let cachedAccountIndex: number | null = null;

// Validation constants
const MAX_ACCOUNT_INDEX = 1000;
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
   * Derive private key from mnemonic phrase
   * Results are cached at module level to avoid re-derivation per request
   */
  private async deriveSponsorKey(): Promise<string | null> {
    if (!this.env.SPONSOR_MNEMONIC) {
      return null;
    }

    // Validate mnemonic format (12 or 24 words)
    const words = this.env.SPONSOR_MNEMONIC.trim().split(/\s+/);
    if (!VALID_MNEMONIC_LENGTHS.includes(words.length)) {
      this.logger.error("Invalid SPONSOR_MNEMONIC; must be 12 or 24 words");
      return null;
    }

    // Parse and validate account index
    const accountIndex = parseInt(this.env.SPONSOR_ACCOUNT_INDEX || "0", 10);

    if (
      !Number.isInteger(accountIndex) ||
      accountIndex < 0 ||
      accountIndex > MAX_ACCOUNT_INDEX
    ) {
      this.logger.error("Invalid SPONSOR_ACCOUNT_INDEX; must be 0-1000");
      return null;
    }

    // Return cached key if available (env can't change during worker lifetime)
    if (cachedSponsorKey !== null && cachedAccountIndex === accountIndex) {
      return cachedSponsorKey;
    }

    this.logger.info("Deriving sponsor key from mnemonic");

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
      cachedSponsorKey = account.stxPrivateKey;
      cachedAccountIndex = accountIndex;

      this.logger.info("Sponsor key derived successfully");
      return cachedSponsorKey;
    } catch (e) {
      this.logger.error("Failed to derive sponsor key from mnemonic", {
        error: e instanceof Error ? e.message : "Unknown error",
      });
      return null;
    }
  }

  /**
   * Get the sponsor private key (from mnemonic or direct config)
   */
  private async getSponsorKey(): Promise<string | null> {
    // Prefer mnemonic derivation
    if (this.env.SPONSOR_MNEMONIC) {
      return this.deriveSponsorKey();
    }

    // Fall back to direct private key
    if (this.env.SPONSOR_PRIVATE_KEY) {
      return this.env.SPONSOR_PRIVATE_KEY;
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
   * Fetch the sponsor account nonce from Hiro API with retry-with-backoff.
   * Retries on 429 (rate limit) and network errors up to NONCE_FETCH_MAX_ATTEMPTS.
   * Uses HIRO_API_KEY if configured for higher rate limits.
   * Returns the nonce as a bigint, or null if all attempts fail.
   */
  private async fetchNonceWithRetry(sponsorAddress: string): Promise<bigint | null> {
    const url = `${getHiroBaseUrl(this.env.STACKS_NETWORK)}/v2/accounts/${sponsorAddress}?proof=0`;
    const headers = getHiroHeaders(this.env.HIRO_API_KEY);

    for (let attempt = 1; attempt <= NONCE_FETCH_MAX_ATTEMPTS; attempt++) {
      try {
        const response = await fetch(url, {
          headers,
          signal: AbortSignal.timeout(5000),
        });

        if (response.status === 429) {
          const retryAfter = response.headers.get("Retry-After");
          const baseDelayMs = NONCE_FETCH_BASE_DELAY_MS * Math.pow(2, attempt - 1);
          let delayMs = baseDelayMs;

          if (retryAfter !== null) {
            const parsedSeconds = parseInt(retryAfter, 10);
            const retryAfterDelayMs = parsedSeconds * 1000;
            if (Number.isFinite(retryAfterDelayMs) && retryAfterDelayMs > 0) {
              delayMs = retryAfterDelayMs;
            }
          }

          // Cap delay to prevent exceeding Worker request time limits
          delayMs = Math.min(delayMs, NONCE_FETCH_MAX_DELAY_MS);
          this.logger.warn("Hiro API rate limited on nonce fetch, retrying", {
            attempt,
            delayMs,
          });
          if (attempt < NONCE_FETCH_MAX_ATTEMPTS) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
          continue;
        }

        if (!response.ok) {
          this.logger.warn("Hiro API error on nonce fetch", {
            attempt,
            status: response.status,
          });
          if (attempt < NONCE_FETCH_MAX_ATTEMPTS) {
            const delayMs = NONCE_FETCH_BASE_DELAY_MS * Math.pow(2, attempt - 1);
            await new Promise((resolve) => setTimeout(resolve, delayMs));
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
        if (attempt < NONCE_FETCH_MAX_ATTEMPTS) {
          const delayMs = NONCE_FETCH_BASE_DELAY_MS * Math.pow(2, attempt - 1);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }

    this.logger.error("Failed to fetch sponsor nonce after all retries", {
      attempts: NONCE_FETCH_MAX_ATTEMPTS,
    });
    return null;
  }

  /**
   * Fetch the sponsor account nonce from NonceDO when available.
   */
  private async fetchNonceFromDO(
    sponsorAddress: string
  ): Promise<bigint | null> {
    if (!this.env.NONCE_DO) {
      this.logger.debug("Nonce DO not configured; skipping DO nonce fetch");
      return null;
    }

    try {
      const stub = this.env.NONCE_DO.get(this.env.NONCE_DO.idFromName("sponsor"));
      const response = await stub.fetch("https://nonce-do/assign", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sponsorAddress }),
      });

      if (!response.ok) {
        this.logger.warn("Nonce DO responded with error", {
          status: response.status,
        });
        return null;
      }

      const data = (await response.json()) as { nonce?: number };
      if (typeof data?.nonce !== "number") {
        this.logger.warn("Nonce DO response missing nonce field");
        return null;
      }

      return BigInt(data.nonce);
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
   * Sponsor a validated transaction
   */
  async sponsorTransaction(
    transaction: StacksTransactionWire
  ): Promise<SponsorResult> {
    const sponsorKey = await this.getSponsorKey();

    if (!sponsorKey) {
      this.logger.error("Sponsor key not configured");
      return {
        success: false,
        error: "Service not configured",
        details: "Set SPONSOR_MNEMONIC or SPONSOR_PRIVATE_KEY",
      };
    }

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

    // Pre-fetch the sponsor nonce with retry-with-backoff to avoid hitting Hiro
    // API rate limits from the internal fetchNonce() call inside sponsorTransaction().
    // Passing sponsorNonce explicitly skips the internal nonce fetch entirely.
    let sponsorNonce: bigint | undefined;
    try {
      const sponsorAddress = getAddressFromPrivateKey(sponsorKey, network);
      const doNonce = await this.fetchNonceFromDO(sponsorAddress);
      if (doNonce !== null) {
        sponsorNonce = doNonce;
        this.logger.debug("Using NonceDO sponsor nonce", {
          sponsorNonce: sponsorNonce.toString(),
        });
      } else {
        const fetchedNonce = await this.fetchNonceWithRetry(sponsorAddress);
        if (fetchedNonce !== null) {
          sponsorNonce = fetchedNonce;
          this.logger.debug("Using fallback sponsor nonce", {
            sponsorNonce: sponsorNonce.toString(),
          });
        } else {
          // Fall back to letting @stacks/transactions fetch the nonce internally
          this.logger.warn(
            "Nonce pre-fetch failed, falling back to internal nonce fetch"
          );
        }
      }
    } catch (e) {
      this.logger.warn(
        "Error during nonce pre-fetch, falling back to internal nonce fetch",
        {
          error: e instanceof Error ? e.message : String(e),
        }
      );
    }

    try {
      const sponsoredTx = await sponsorTransaction({
        transaction,
        sponsorPrivateKey: sponsorKey,
        network,
        fee,
        ...(sponsorNonce !== undefined ? { sponsorNonce } : {}),
      });

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

      this.logger.info("Transaction sponsored", { fee: actualFee });

      return {
        success: true,
        sponsoredTxHex,
        fee: actualFee,
      };
    } catch (e) {
      this.logger.error("Failed to sponsor transaction", {
        error: e instanceof Error ? e.message : "Unknown error",
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
