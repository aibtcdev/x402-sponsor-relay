import {
  deserializeTransaction,
  PayloadType,
  ClarityType,
  addressToString,
  addressFromVersionHash,
  addressHashModeToVersion,
  AddressHashMode,
  type ClarityValue,
  type StacksTransactionWire,
  type AddressWire,
  type LengthPrefixedStringWire,
} from "@stacks/transactions";
import { STACKS_MAINNET, STACKS_TESTNET } from "@stacks/network";
import type {
  Env,
  Logger,
  SettleOptions,
  TokenType,
  SettlementVerifyResult,
  DedupResult,
  BroadcastAndConfirmResult,
} from "../types";
import { getHiroBaseUrl, getHiroHeaders, NONCE_CONFLICT_REASONS, stripHexPrefix } from "../utils";
import { extractSponsorNonce } from "./sponsor";

// Known SIP-010 token contract addresses
const SBTC_CONTRACT_MAINNET = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4";
const SBTC_CONTRACT_NAME = "sbtc-token";

// USDCx — two known mainnet contracts that both represent USDC on Stacks
const USDCX_CIRCLE_CONTRACT_MAINNET = "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE";
const USDCX_CIRCLE_CONTRACT_NAME = "usdcx";
const USDCX_AEUSDC_CONTRACT_MAINNET = "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9";
const USDCX_AEUSDC_CONTRACT_NAME = "token-aeusdc";

const SIP010_TRANSFER_FUNCTION = "transfer";

// Polling configuration
const MAX_POLL_TIME_MS = 60_000;
const INITIAL_POLL_DELAY_MS = 2_000;
const POLL_BACKOFF_FACTOR = 1.5;
const MAX_POLL_DELAY_MS = 8_000;

// Hiro API timeout configuration
/** Timeout for each broadcast attempt POST to Hiro /v2/transactions (ms).
 *  Reduced from 20s to 12s to leave budget for up to 3 attempts (worst case: 39s total). */
const HIRO_BROADCAST_TIMEOUT_MS = 12_000;
/** Timeout for each Hiro poll request during confirmation polling (ms) */
const HIRO_POLL_TIMEOUT_MS = 10_000;
/** Timeout for liveness check against Hiro /extended/v1/tx/:txid (ms) */
const HIRO_LIVENESS_TIMEOUT_MS = 10_000;

// Broadcast retry configuration
/** Maximum number of broadcast attempts (1 initial + 2 retries) */
const BROADCAST_MAX_ATTEMPTS = 3;
/** Delay in ms after the first failed broadcast attempt */
const BROADCAST_RETRY_BASE_DELAY_MS = 1_000;
/** Delay in ms after the second failed broadcast attempt (cap) */
const BROADCAST_RETRY_MAX_DELAY_MS = 2_000;

// KV dedup configuration
const DEDUP_TTL_SECONDS = 300;
const DEDUP_KEY_PREFIX = "dedup:";
/** Only verify liveness of pending dedup entries older than this (ms) */
const DEDUP_LIVENESS_AGE_MS = 60_000;

/** Shape of Hiro GET /extended/v1/tx/{txid} response (subset) */
interface HiroTxResponse {
  tx_status?: string;
  block_height?: number;
  tx_id?: string;
}

/**
 * Native settlement service that replaces the external facilitator.
 *
 * Responsibilities:
 * - Verify payment parameters locally by deserializing the sponsored transaction
 * - Broadcast directly to Stacks node
 * - Poll Hiro API for confirmation with exponential backoff (max 60s)
 * - Deduplicate requests by SHA-256 hash of transaction hex stored in KV
 */
export class SettlementService {
  private env: Env;
  private logger: Logger;

  constructor(env: Env, logger: Logger) {
    this.env = env;
    this.logger = logger;
  }

  /**
   * Strip 0x prefix and deserialize a transaction hex string
   */
  private deserializeTx(txHex: string): StacksTransactionWire {
    return deserializeTransaction(stripHexPrefix(txHex));
  }

  /**
   * Compute SHA-256 hash of the normalized transaction hex for dedup keys.
   * Strips 0x prefix before hashing so the same tx always produces the same key.
   */
  private async computeTxHash(txHex: string): Promise<string> {
    const data = new TextEncoder().encode(stripHexPrefix(txHex));
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const bytes = new Uint8Array(hashBuffer);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  /**
   * Returns true if a Hiro tx_status string indicates a terminal (dead) transaction.
   * Terminal statuses start with "abort_" or "dropped_".
   */
  private isTxStatusTerminal(txStatus: string | undefined): boolean {
    return txStatus?.startsWith("abort_") === true || txStatus?.startsWith("dropped_") === true;
  }

  /** Truncate a hex hash to a short prefix for log context. */
  private truncateHash(hash: string): string {
    return hash.slice(0, 16) + "...";
  }

  /**
   * Extract a Stacks address string from a principal ClarityValue.
   * Handles both standard principal (type: "address") and
   * contract principal (type: "contract", value: "addr.contract-name").
   */
  private principalCVToAddress(cv: ClarityValue): string | null {
    if (cv.type === ClarityType.PrincipalStandard) {
      // value is the address string directly in v7
      return cv.value as string;
    }
    if (cv.type === ClarityType.PrincipalContract) {
      // value is "address.contract-name" in v7
      const parts = (cv.value as string).split(".");
      return parts[0] ?? null;
    }
    return null;
  }

  // Mainnet: exact address + name. Testnet: name-only (deployer drifts across SDKs).
  private isSbtcContract(address: string, contractName: string): boolean {
    if (contractName !== SBTC_CONTRACT_NAME) return false;
    if (this.env.STACKS_NETWORK === "testnet") return true;
    return address.toUpperCase() === SBTC_CONTRACT_MAINNET;
  }

  private isUsdcxContract(address: string, contractName: string): boolean {
    const upper = address.toUpperCase();
    return (
      (upper === USDCX_CIRCLE_CONTRACT_MAINNET && contractName === USDCX_CIRCLE_CONTRACT_NAME) ||
      (upper === USDCX_AEUSDC_CONTRACT_MAINNET && contractName === USDCX_AEUSDC_CONTRACT_NAME)
    );
  }

  /**
   * Validate settle options (expectedRecipient, minAmount, tokenType)
   */
  validateSettleOptions(settle: SettleOptions):
    | { valid: true }
    | { valid: false; error: string; details: string } {
    if (!settle.expectedRecipient || !settle.minAmount) {
      return {
        valid: false,
        error: "Invalid settle options",
        details: "expectedRecipient and minAmount are required",
      };
    }

    // Minimum amount must be a non-negative integer string
    if (!/^\d+$/.test(settle.minAmount)) {
      return {
        valid: false,
        error: "Invalid minimum amount",
        details: "settle.minAmount must be a numeric string",
      };
    }

    // Token type must be one of the currently supported values
    const tokenType = settle.tokenType || "STX";
    if (tokenType !== "STX" && tokenType !== "sBTC" && tokenType !== "USDCx") {
      return {
        valid: false,
        error: "Invalid token type",
        details: `Unsupported token type: ${tokenType}. Valid types: STX, sBTC, USDCx`,
      };
    }

    return { valid: true };
  }

  /**
   * Convert the hash160 signer from a transaction's spending condition to
   * a human-readable Stacks address string.
   *
   * The `signer` field in SpendingConditionWire is a 40-char hex hash160
   * (not a human-readable address). This method uses the hashMode to derive
   * the correct AddressVersion and then c32check-encodes it.
   */
  senderToAddress(transaction: StacksTransactionWire, network: "mainnet" | "testnet"): string {
    const { hashMode, signer } = transaction.auth.spendingCondition;
    const stacksNetwork = network === "mainnet" ? STACKS_MAINNET : STACKS_TESTNET;
    const version = addressHashModeToVersion(hashMode as AddressHashMode, stacksNetwork);
    const addrWire = addressFromVersionHash(version, signer);
    return addressToString(addrWire);
  }

  /**
   * Map an x402 V2 asset identifier to the relay's internal TokenType.
   *
   * Handles:
   * - "STX" → "STX"
   * - "SBTC" or "sBTC" (case-insensitive) → "sBTC"
   * - "USDCX" or "USDCx" (case-insensitive) → "USDCx"
   * - CAIP-19 Stacks FT identifiers whose contract address is known → mapped token
   * - Bare Stacks contract principals (e.g., "SM3...Q4.sbtc-token") → mapped token
   * - Unknown → null (caller should return unsupported_scheme error)
   */
  mapAssetToTokenType(asset: string): TokenType | null {
    if (asset === "STX") return "STX";
    const upper = asset.toUpperCase();
    if (upper === "SBTC") return "sBTC";
    if (upper === "USDCX") return "USDCx";

    // Try CAIP-19 format: stacks:<chainId>/sip010:<addr>.<name>.<token>
    const ftContract = this.extractStacksFtContract(asset);
    if (ftContract) {
      return this.matchTokenContract(ftContract.address, ftContract.contractName);
    }

    // Try bare contract principal: "address.contract-name"
    return this.matchBareContractPrincipal(asset);
  }

  // Map a known contract address + name to its TokenType, or null if unrecognized.
  private matchTokenContract(address: string, contractName: string): TokenType | null {
    if (this.isSbtcContract(address, contractName)) return "sBTC";
    if (this.isUsdcxContract(address, contractName)) return "USDCx";
    return null;
  }

  // Parse "address.contract-name" and match against known tokens.
  private matchBareContractPrincipal(asset: string): TokenType | null {
    const dotIndex = asset.indexOf(".");
    if (dotIndex === -1) return null;
    return this.matchTokenContract(
      asset.substring(0, dotIndex).toUpperCase(),
      asset.substring(dotIndex + 1)
    );
  }

  // Parse CAIP-19 format: stacks:<chainId>/sip010:<addr>.<name>.<token>
  // Returns { address (uppercase), contractName } or null.
  private extractStacksFtContract(asset: string): { address: string; contractName: string } | null {
    if (!asset.toLowerCase().startsWith("stacks:")) return null;
    const parts = asset.split("/");
    if (parts.length < 2) return null;
    const assetSpec = parts[1]; // e.g., "sip010:SP1234.my-token.my-token"
    if (!assetSpec.toLowerCase().startsWith("sip010:")) return null;
    const afterType = assetSpec.substring(7); // strip "sip010:"
    if (!afterType) return null;
    const dotParts = afterType.split(".");
    const contractPrincipal = dotParts[0];
    const contractName = dotParts[1];
    if (!contractPrincipal || !contractName) return null;
    return { address: contractPrincipal.toUpperCase(), contractName };
  }

  /**
   * Verify payment parameters by deserializing the sponsored transaction
   * and extracting sender, recipient, amount, and token type.
   *
   * For STX transfers: reads payload.recipient and payload.amount directly.
   * For SIP-010 contract calls (sBTC, USDCx): reads transfer function args
   *   [amount, from, to, memo] where index 0=amount, 1=from, 2=to.
   *
   * Validates:
   * - recipient matches settle.expectedRecipient (case-insensitive)
   * - amount >= settle.minAmount
   *
   * On success, returns the deserialized transaction for reuse by broadcastAndConfirm.
   */
  verifyPaymentParams(
    sponsoredTxHex: string,
    settle: SettleOptions
  ): SettlementVerifyResult {
    let transaction: StacksTransactionWire;
    try {
      transaction = this.deserializeTx(sponsoredTxHex);
    } catch (e) {
      // Include relay network in the error details to help callers detect
      // testnet-vs-mainnet mismatches (#110). A common root cause is building
      // a transaction for one network and submitting it to the other.
      const deserializeError = e instanceof Error ? e.message : "Unknown deserialization error";
      this.logger.warn("Failed to deserialize transaction for payment verification", {
        error: deserializeError,
        relayNetwork: this.env.STACKS_NETWORK,
      });
      return {
        valid: false,
        error: "Cannot deserialize transaction",
        details: `${deserializeError} — relay is configured for ${this.env.STACKS_NETWORK}. ` +
          `Ensure your transaction was built for the correct network.`,
      };
    }

    // The signer field is a hash160 hex string (40 chars) — not a human-readable
    // Stacks address. Included in the result for traceability only.
    const sender = transaction.auth.spendingCondition.signer;

    let recipient: string;
    let amount: string;
    let tokenType: TokenType;

    const payloadType = transaction.payload.payloadType;

    if (payloadType === PayloadType.TokenTransfer) {
      // STX token transfer
      // payload.recipient is a ClarityValue with type "address" and value = "SP..."
      const recipientCV = transaction.payload.recipient as ClarityValue;
      const extractedRecipient = this.principalCVToAddress(recipientCV);
      if (!extractedRecipient) {
        return {
          valid: false,
          error: "Cannot extract recipient from STX transfer",
          details: `Unexpected recipient CV type: ${(recipientCV as { type: string }).type}`,
        };
      }
      recipient = extractedRecipient;

      // payload.amount is a bigint in v7
      amount = (transaction.payload.amount as bigint).toString();
      tokenType = "STX";
    } else if (payloadType === PayloadType.ContractCall) {
      // SIP-010 contract call (sBTC, USDCx, or other token)
      // ContractCall payload uses Wire types: AddressWire for contractAddress,
      // LengthPrefixedStringWire for contractName and functionName
      const contractAddressStr = addressToString(
        transaction.payload.contractAddress as unknown as AddressWire
      );
      const contractNameStr = (
        transaction.payload.contractName as unknown as LengthPrefixedStringWire
      ).content;
      const functionNameStr = (
        transaction.payload.functionName as unknown as LengthPrefixedStringWire
      ).content;

      // Only support the SIP-010 transfer function
      if (functionNameStr !== SIP010_TRANSFER_FUNCTION) {
        return {
          valid: false,
          error: "Unsupported contract function",
          details: `Expected 'transfer' function, got '${functionNameStr}'`,
        };
      }

      // Determine token type from contract address
      const matchedToken = this.matchTokenContract(contractAddressStr, contractNameStr);
      if (!matchedToken) {
        return {
          valid: false,
          error: "Unsupported token contract",
          details: `Unsupported SIP-010 token contract: ${contractAddressStr}.${contractNameStr}`,
        };
      }
      tokenType = matchedToken;

      // SIP-010 transfer args: [amount (uint), from (principal), to (principal), memo (optional)]
      const args = transaction.payload.functionArgs as ClarityValue[];

      if (!args || args.length < 3) {
        return {
          valid: false,
          error: "Invalid SIP-010 transfer arguments",
          details: `Expected at least 3 args (amount, from, to), got ${args?.length ?? 0}`,
        };
      }

      // args[0] = amount (uint)
      const amountCV = args[0];
      if (amountCV.type !== ClarityType.UInt) {
        return {
          valid: false,
          error: "Invalid amount argument in SIP-010 transfer",
          details: `Expected uint, got ${amountCV.type}`,
        };
      }
      amount = String(amountCV.value);

      // args[2] = to/recipient (principal)
      const recipientCV = args[2];
      const extractedRecipient = this.principalCVToAddress(recipientCV);
      if (!extractedRecipient) {
        return {
          valid: false,
          error: "Cannot extract recipient from SIP-010 transfer",
          details: `Unexpected recipient CV type: ${recipientCV.type}`,
        };
      }
      recipient = extractedRecipient;
    } else {
      return {
        valid: false,
        error: "Unsupported transaction type",
        details: `Payload type ${payloadType} is not supported. Expected TokenTransfer or ContractCall.`,
      };
    }

    // Validate token type matches what the caller claimed
    const expectedTokenType = settle.tokenType || "STX";
    if (tokenType !== expectedTokenType) {
      this.logger.warn("Token type mismatch", {
        expected: expectedTokenType,
        actual: tokenType,
      });
      return {
        valid: false,
        error: "Token type mismatch",
        details: `Transaction uses ${tokenType}, but settle.tokenType is ${expectedTokenType}`,
      };
    }

    // Validate recipient matches expected (case-insensitive Stacks address comparison)
    if (
      recipient.toLowerCase() !== settle.expectedRecipient.toLowerCase()
    ) {
      this.logger.warn("Recipient mismatch", {
        expected: settle.expectedRecipient,
        actual: recipient,
      });
      return {
        valid: false,
        error: "Recipient mismatch",
        details: `Transaction sends to ${recipient}, expected ${settle.expectedRecipient}`,
      };
    }

    // Validate amount meets minimum requirement
    let amountBigInt: bigint;
    let minAmountBigInt: bigint;
    try {
      amountBigInt = BigInt(amount);
      minAmountBigInt = BigInt(settle.minAmount);
    } catch {
      return {
        valid: false,
        error: "Amount comparison failed",
        details: "Could not parse amount or minAmount as integer",
      };
    }

    if (amountBigInt < minAmountBigInt) {
      this.logger.warn("Amount below minimum", {
        amount,
        minAmount: settle.minAmount,
      });
      return {
        valid: false,
        error: "Insufficient payment amount",
        details: `Transaction amount ${amount} is less than required minimum ${settle.minAmount}`,
      };
    }

    // Note: expectedSender validation is handled upstream by SponsorService
    // via transaction signature verification. The signer hash160 cannot be
    // directly compared to a Stacks address without c32check decoding.

    this.logger.debug("Payment verification succeeded", {
      recipient,
      amount,
      tokenType,
    });

    return {
      valid: true,
      data: {
        sender,
        recipient,
        amount,
        tokenType,
        transaction,
      },
    };
  }

  /**
   * Broadcast a pre-deserialized transaction and poll for confirmation.
   *
   * Polls Hiro API GET /extended/v1/tx/{txid} with exponential backoff:
   * - Initial delay: 2s, backoff factor: 1.5x, max delay: 8s
   * - Default max time: 60s (configurable via maxPollTimeMs)
   *
   * Returns:
   * - { txid, status: "confirmed", blockHeight } on confirmation
   * - { txid, status: "pending" } on timeout
   * - { error, details } on broadcast failure or transaction abort/drop
   *
   * @param transaction - Pre-deserialized Stacks transaction
   * @param maxPollTimeMs - Optional max poll time in ms (default: MAX_POLL_TIME_MS = 60s).
   *   Callers with shorter upstream timeouts can pass a lower value to get a
   *   "pending" response before their own timeout fires, avoiding 500 empty-body errors.
   */
  async broadcastAndConfirm(
    transaction: StacksTransactionWire,
    maxPollTimeMs?: number
  ): Promise<BroadcastAndConfirmResult> {
    // Resolve effective poll time: caller override or default constant
    const effectivePollTimeMs = maxPollTimeMs != null && maxPollTimeMs > 0
      ? Math.min(maxPollTimeMs, MAX_POLL_TIME_MS)
      : MAX_POLL_TIME_MS;

    // Extract sponsor nonce once for structured logging in all failure paths
    const sponsorNonceForLog = extractSponsorNonce(transaction);

    // Broadcast to Stacks node via direct fetch to /v2/transactions.
    // Using direct fetch instead of broadcastTransaction() from @stacks/transactions
    // to avoid unhandled throws on non-JSON node responses and gain structured
    // Ok/Err handling regardless of the node's response content type.
    //
    // Retry logic: up to BROADCAST_MAX_ATTEMPTS attempts with exponential backoff.
    // Retries on HTTP 5xx/522 and network/timeout errors.
    // Immediate return on nonce conflicts (4xx) — do not retry.

    // Serialize transaction bytes once, outside the retry loop
    const txHex = transaction.serialize();
    if (
      typeof txHex !== "string" ||
      txHex.length === 0 ||
      txHex.length % 2 !== 0 ||
      !/^[0-9a-fA-F]+$/.test(txHex)
    ) {
      this.logger.error("Failed to serialize transaction to valid hex", {
        txHexSample: String(txHex).slice(0, 64),
      });
      return {
        error: "Broadcast failed",
        details: "Serialized transaction is not a valid hex string",
        retryable: false,
      };
    }
    const bytePairs = txHex.match(/.{2}/g);
    if (!bytePairs) {
      this.logger.error("Hex serialization produced no byte pairs", {
        txHexSample: txHex.slice(0, 64),
      });
      return {
        error: "Broadcast failed",
        details: "Serialized transaction hex could not be converted to bytes",
        retryable: false,
      };
    }
    const txBytes = new Uint8Array(bytePairs.map((b) => parseInt(b, 16)));

    const hiroBaseUrl = getHiroBaseUrl(this.env.STACKS_NETWORK);
    const broadcastUrl = `${hiroBaseUrl}/v2/transactions`;
    const broadcastHeaders: Record<string, string> = {
      "Content-Type": "application/octet-stream",
      ...getHiroHeaders(this.env.HIRO_API_KEY),
    };

    let txid = "";
    let lastBroadcastError: BroadcastAndConfirmResult | undefined;

    for (let attempt = 1; attempt <= BROADCAST_MAX_ATTEMPTS; attempt++) {
      try {
        const broadcastResponse = await fetch(broadcastUrl, {
          method: "POST",
          headers: broadcastHeaders,
          body: txBytes,
          signal: AbortSignal.timeout(HIRO_BROADCAST_TIMEOUT_MS),
        });

        const responseText = await broadcastResponse.text();

        if (broadcastResponse.ok) {
          // Success: body is a JSON-quoted txid string, e.g. "\"0x1234...\""
          let parsedTxid: string;
          try {
            parsedTxid = JSON.parse(responseText) as string;
          } catch {
            // Some nodes return the txid without JSON quoting
            parsedTxid = responseText.trim().replace(/^"|"$/g, "");
          }

          if (!parsedTxid || typeof parsedTxid !== "string") {
            this.logger.error("Broadcast returned OK but unparseable txid", {
              responseText: responseText.slice(0, 200),
            });
            return {
              error: "Broadcast failed",
              details: "Node returned OK but txid could not be parsed",
              retryable: true,
            };
          }

          txid = parsedTxid;
          this.logger.info("Transaction broadcast successful", { txid, attempt });
          break; // Success — exit retry loop and fall through to polling
        }

        // Non-OK response: parse error body and decide whether to retry
        let errorMessage = `HTTP ${broadcastResponse.status}`;
        let errorDetails = responseText.slice(0, 500);

        try {
          const errorJson = JSON.parse(responseText) as {
            error?: string;
            reason?: string;
            message?: string;
          };
          if (errorJson.error || errorJson.reason || errorJson.message) {
            errorMessage = errorJson.error ?? errorJson.message ?? errorMessage;
            errorDetails = errorJson.reason ?? errorDetails;
          }
        } catch {
          // Body is not JSON — use raw text as details
        }

        const conflictDetails = `${errorMessage}: ${errorDetails}`;
        const isNonceConflict = NONCE_CONFLICT_REASONS.some(
          (reason) => conflictDetails.includes(reason)
        );

        if (isNonceConflict) {
          // Include sender identity for attribution (#114).
          // The signer field is the hash160 of the sender's public key (not a
          // human-readable address, but sufficient for log correlation).
          const senderSigner = transaction.auth.spendingCondition.signer;
          const senderNonce = Number(transaction.auth.spendingCondition.nonce);

          if (sponsorNonceForLog === null) {
            // No relay-assigned sponsor nonce: this is a client pre-signed tx.
            // Log at INFO — the nonce conflict is the client's problem, not the relay's.
            this.logger.info("Broadcast rejected due to client nonce conflict (pre-signed tx)", {
              status: broadcastResponse.status,
              details: conflictDetails,
              senderSigner,
              senderNonce,
            });
          } else {
            // Relay assigned a sponsor nonce: unexpected conflict on relay side.
            this.logger.warn("Broadcast rejected due to nonce conflict", {
              status: broadcastResponse.status,
              details: conflictDetails,
              sponsorNonce: sponsorNonceForLog,
              senderSigner,
              senderNonce,
            });
          }
          // Nonce conflicts are not retriable at the broadcast level
          return {
            error: "Nonce conflict",
            details: conflictDetails,
            retryable: true,
            nonceConflict: true,
          };
        }

        // HTTP 4xx (non-nonce): reject immediately, no retry
        if (broadcastResponse.status >= 400 && broadcastResponse.status < 500) {
          this.logger.error("Broadcast failed with 4xx, not retrying", {
            status: broadcastResponse.status,
            error: errorMessage,
            details: errorDetails,
          });
          return {
            error: "Broadcast failed",
            details: conflictDetails,
            retryable: false,
          };
        }

        // HTTP 5xx or 522 (Cloudflare timeout): log and retry
        const retryDelay = attempt === 1 ? BROADCAST_RETRY_BASE_DELAY_MS : BROADCAST_RETRY_MAX_DELAY_MS;
        this.logger.warn(`Broadcast attempt ${attempt}/${BROADCAST_MAX_ATTEMPTS} failed: ${conflictDetails}, retrying in ${retryDelay}ms`, {
          status: broadcastResponse.status,
          attempt,
          maxAttempts: BROADCAST_MAX_ATTEMPTS,
          retryDelayMs: retryDelay,
        });
        lastBroadcastError = {
          error: "Broadcast failed",
          details: conflictDetails,
          retryable: true,
        };
        if (attempt < BROADCAST_MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, retryDelay));
        }
      } catch (e) {
        // Network error, AbortError (timeout), or TypeError — retry on transient failures
        const errMsg = e instanceof Error ? e.message : String(e);
        const retryDelay = attempt === 1 ? BROADCAST_RETRY_BASE_DELAY_MS : BROADCAST_RETRY_MAX_DELAY_MS;
        this.logger.warn(`Broadcast attempt ${attempt}/${BROADCAST_MAX_ATTEMPTS} failed: ${errMsg}, retrying in ${retryDelay}ms`, {
          error: errMsg,
          attempt,
          maxAttempts: BROADCAST_MAX_ATTEMPTS,
          retryDelayMs: retryDelay,
        });
        lastBroadcastError = {
          error: "Broadcast failed",
          details: errMsg,
          retryable: true,
        };
        if (attempt < BROADCAST_MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, retryDelay));
        }
      }
    }

    // All attempts exhausted — return the last error
    if (lastBroadcastError) {
      this.logger.error("Broadcast failed after all attempts", {
        maxAttempts: BROADCAST_MAX_ATTEMPTS,
        lastError: "error" in lastBroadcastError ? lastBroadcastError.details : "unknown",
      });
      return lastBroadcastError;
    }

    // Poll for confirmation with exponential backoff
    const hiroHeaders = getHiroHeaders(this.env.HIRO_API_KEY);
    const pollUrl = `${hiroBaseUrl}/extended/v1/tx/${txid}`;

    const startTime = Date.now();
    let delay = 0; // First poll is immediate after broadcast

    while (true) {
      // Check for timeout before sleeping
      const elapsed = Date.now() - startTime;
      if (elapsed >= effectivePollTimeMs) {
        this.logger.info("Transaction confirmation timeout, returning pending", {
          txid,
          elapsedMs: elapsed,
          maxPollTimeMs: effectivePollTimeMs,
        });
        return { txid, status: "pending" };
      }

      // Wait before polling (immediate on first iteration).
      // Cap sleep by remaining time so we don't overshoot the budget.
      if (delay > 0) {
        const remainingMs = effectivePollTimeMs - (Date.now() - startTime);
        if (remainingMs <= 0) break;
        await new Promise((resolve) => setTimeout(resolve, Math.min(delay, remainingMs)));
      }

      // Poll Hiro API. Cap per-request timeout by remaining budget.
      try {
        const remainingForPoll = effectivePollTimeMs - (Date.now() - startTime);
        if (remainingForPoll <= 0) break;
        const pollTimeout = Math.min(HIRO_POLL_TIMEOUT_MS, remainingForPoll);
        const response = await fetch(pollUrl, {
          headers: hiroHeaders,
          signal: AbortSignal.timeout(pollTimeout),
        });

        if (response.ok) {
          const data = (await response.json()) as HiroTxResponse;
          const txStatus = data.tx_status;

          if (txStatus === "success") {
            if (typeof data.block_height !== "number") {
              // Success without block height — keep polling until it's available
              this.logger.warn("Transaction success reported without block height, continuing to poll", {
                txid,
                elapsedMs: elapsed,
              });
            } else {
              this.logger.info("Transaction confirmed", {
                txid,
                blockHeight: data.block_height,
                elapsedMs: elapsed,
              });
              return {
                txid,
                status: "confirmed",
                blockHeight: data.block_height,
              };
            }
          }

          if (this.isTxStatusTerminal(txStatus)) {
            this.logger.warn("Transaction aborted or dropped", {
              txid,
              txStatus,
            });
            return {
              error: "Transaction failed on-chain",
              details: `tx_status: ${txStatus}`,
              retryable: false,
            };
          }

          // Status is "pending" or something else — continue polling
          this.logger.debug("Transaction not yet confirmed", {
            txid,
            txStatus,
            elapsedMs: elapsed,
          });
        } else if (response.status === 404) {
          // Transaction not yet indexed — continue polling
          this.logger.debug("Transaction not yet indexed", {
            txid,
            elapsedMs: elapsed,
          });
        } else {
          // Non-200/404 response — log but continue polling
          this.logger.warn("Unexpected response from Hiro API during polling", {
            txid,
            status: response.status,
            elapsedMs: elapsed,
          });
        }
      } catch (e) {
        // Network error during polling — log and continue
        this.logger.warn("Error polling for confirmation", {
          txid,
          error: e instanceof Error ? e.message : String(e),
          elapsedMs: elapsed,
        });
      }

      // Set delay: first iteration starts the backoff series, then exponential growth
      delay = delay === 0 ? INITIAL_POLL_DELAY_MS : Math.min(delay * POLL_BACKOFF_FACTOR, MAX_POLL_DELAY_MS);
    }

    // Reached here via break (remaining time exhausted mid-loop)
    this.logger.info("Transaction confirmation timeout, returning pending", {
      txid,
      elapsedMs: Date.now() - startTime,
      maxPollTimeMs: effectivePollTimeMs,
    });
    return { txid, status: "pending" };
  }

  /**
   * Check whether a txid is still alive in the mempool or confirmed on-chain.
   * Used to validate "pending" dedup entries before returning them to callers.
   *
   * Returns true  if the tx is pending, success, or the API is unreachable (fail-open).
   * Returns false if the tx is 404 (never indexed / evicted) or abort_xx / dropped_xx.
   */
  private async verifyTxidAlive(txid: string): Promise<boolean> {
    try {
      const hiroBaseUrl = getHiroBaseUrl(this.env.STACKS_NETWORK);
      const url = `${hiroBaseUrl}/extended/v1/tx/${txid}`;

      const response = await fetch(url, {
        headers: getHiroHeaders(this.env.HIRO_API_KEY),
        signal: AbortSignal.timeout(HIRO_LIVENESS_TIMEOUT_MS),
      });

      if (response.status === 404) {
        this.logger.debug("Txid not found, treating as dead", { txid });
        return false;
      }

      if (!response.ok) {
        this.logger.debug("Hiro API error during liveness check, assuming alive", {
          txid,
          status: response.status,
        });
        return true;
      }

      const data = (await response.json()) as HiroTxResponse;
      if (this.isTxStatusTerminal(data.tx_status)) {
        this.logger.debug("Txid has terminal status", { txid, txStatus: data.tx_status });
        return false;
      }

      this.logger.debug("Txid is alive", { txid, txStatus: data.tx_status });
      return true;
    } catch (e) {
      this.logger.debug("Liveness check failed, assuming alive", {
        txid,
        error: e instanceof Error ? e.message : String(e),
      });
      return true;
    }
  }

  /**
   * Check KV for a cached deduplication result for the given transaction hex.
   * Returns the cached result if found, or null if not found or KV unavailable.
   *
   * For "pending" entries, performs a liveness check against the Hiro API.
   * If the txid is dead (dropped or never indexed), the stale entry is deleted
   * and null is returned so the caller can retry with a fresh broadcast.
   */
  async checkDedup(sponsoredTxHex: string): Promise<DedupResult | null> {
    if (!this.env.RELAY_KV) {
      return null;
    }

    try {
      // Note: dedup keys are SHA-256 of the original unsigned agent tx hex
      // (body.transaction in /relay, txHex in /settle). This means the same
      // agent payload will match even across different sponsoring attempts,
      // enabling true idempotency for retried submissions.
      const txHash = await this.computeTxHash(sponsoredTxHex);
      const key = `${DEDUP_KEY_PREFIX}${txHash}`;
      const cached = await this.env.RELAY_KV.get(key);

      if (!cached) {
        return null;
      }

      const result = JSON.parse(cached) as DedupResult;

      // For "pending" entries older than DEDUP_LIVENESS_AGE_MS, verify the txid is
      // still alive. Fresh entries are trusted to avoid adding Hiro API latency to
      // the hot path on every dedup hit.
      const entryAge = result.recordedAt ? Date.now() - result.recordedAt : Infinity;
      if (result.status === "pending" && entryAge > DEDUP_LIVENESS_AGE_MS) {
        const alive = await this.verifyTxidAlive(result.txid);
        if (!alive) {
          this.logger.warn("Dedup stale: pending txid is dead, invalidating cache entry", {
            txHash: this.truncateHash(txHash),
            txid: result.txid,
          });
          await this.env.RELAY_KV.delete(key);
          return null;
        }
      }

      this.logger.info("Dedup hit: returning cached result", {
        txHash: this.truncateHash(txHash),
        txid: result.txid,
        status: result.status,
      });
      return result;
    } catch (e) {
      this.logger.warn("Error checking dedup in KV", {
        error: e instanceof Error ? e.message : String(e),
      });
      return null;
    }
  }

  /**
   * Store a deduplication result in KV with a 5-minute TTL.
   * Prevents double-broadcast and double-receipt-creation for retried requests.
   */
  async recordDedup(
    sponsoredTxHex: string,
    result: DedupResult
  ): Promise<void> {
    if (!this.env.RELAY_KV) {
      return;
    }

    try {
      const txHash = await this.computeTxHash(sponsoredTxHex);
      const key = `${DEDUP_KEY_PREFIX}${txHash}`;
      await this.env.RELAY_KV.put(
        key,
        JSON.stringify({ ...result, recordedAt: Date.now() }),
        { expirationTtl: DEDUP_TTL_SECONDS }
      );

      this.logger.debug("Dedup result recorded in KV", {
        txHash: this.truncateHash(txHash),
        txid: result.txid,
        status: result.status,
        ttlSeconds: DEDUP_TTL_SECONDS,
      });
    } catch (e) {
      this.logger.warn("Error recording dedup in KV", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
}
