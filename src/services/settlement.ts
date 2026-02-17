import {
  deserializeTransaction,
  broadcastTransaction,
  PayloadType,
  ClarityType,
  addressToString,
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

// Known SIP-010 token contract addresses
const SBTC_CONTRACT_MAINNET = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4";
const SBTC_CONTRACT_TESTNET = "ST1F7QA2MDF17S807EPA36TSS8AMEQ4ASGQBP8WN4";
const SBTC_CONTRACT_NAME = "sbtc-token";
const SIP010_TRANSFER_FUNCTION = "transfer";

// Polling configuration
const MAX_POLL_TIME_MS = 60_000;
const INITIAL_POLL_DELAY_MS = 2_000;
const POLL_BACKOFF_FACTOR = 1.5;
const MAX_POLL_DELAY_MS = 8_000;

// KV dedup configuration
const DEDUP_TTL_SECONDS = 300;
const DEDUP_KEY_PREFIX = "dedup:";

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
   * Get the Stacks network instance based on environment configuration
   */
  private getNetwork() {
    return this.env.STACKS_NETWORK === "mainnet"
      ? STACKS_MAINNET
      : STACKS_TESTNET;
  }

  /**
   * Get the Hiro API base URL based on environment configuration
   */
  private getHiroBaseUrl(): string {
    return this.env.STACKS_NETWORK === "mainnet"
      ? "https://api.hiro.so"
      : "https://api.testnet.hiro.so";
  }

  /**
   * Build headers for Hiro API requests, including optional API key
   */
  private getHiroHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.env.HIRO_API_KEY) {
      headers["x-hiro-api-key"] = this.env.HIRO_API_KEY;
    }
    return headers;
  }

  /**
   * Strip 0x prefix and deserialize a transaction hex string
   */
  private deserializeTx(txHex: string): StacksTransactionWire {
    const cleanHex = txHex.startsWith("0x") ? txHex.slice(2) : txHex;
    return deserializeTransaction(cleanHex);
  }

  /**
   * Compute SHA-256 hash of the normalized transaction hex for dedup keys.
   * Strips 0x prefix before hashing so the same tx always produces the same key.
   */
  private async computeTxHash(txHex: string): Promise<string> {
    const normalized = txHex.startsWith("0x") ? txHex.slice(2) : txHex;
    const data = new TextEncoder().encode(normalized);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const bytes = new Uint8Array(hashBuffer);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
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
    if (tokenType !== "STX" && tokenType !== "sBTC") {
      return {
        valid: false,
        error: "Invalid token type",
        details: `Unsupported token type: ${tokenType}. Valid types: STX, sBTC`,
      };
    }

    return { valid: true };
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
      this.logger.warn("Failed to deserialize transaction for payment verification", {
        error: e instanceof Error ? e.message : String(e),
      });
      return {
        valid: false,
        error: "Cannot deserialize transaction",
        details: e instanceof Error ? e.message : "Unknown deserialization error",
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
      if (
        contractAddressStr === SBTC_CONTRACT_MAINNET ||
        contractAddressStr === SBTC_CONTRACT_TESTNET
      ) {
        if (contractNameStr !== SBTC_CONTRACT_NAME) {
          return {
            valid: false,
            error: "Unsupported contract",
            details: `Expected contract name '${SBTC_CONTRACT_NAME}', got '${contractNameStr}'`,
          };
        }
        tokenType = "sBTC";
      } else {
        // Reject unknown SIP-010 contracts — only known tokens are supported
        return {
          valid: false,
          error: "Unsupported token contract",
          details: `Unsupported SIP-010 token contract: ${contractAddressStr}.${contractNameStr}`,
        };
      }

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
   * - Initial delay: 2s, backoff factor: 1.5x, max delay: 8s, max time: 60s
   *
   * Returns:
   * - { txid, status: "confirmed", blockHeight } on confirmation
   * - { txid, status: "pending" } on timeout (60s elapsed)
   * - { error, details } on broadcast failure or transaction abort/drop
   */
  async broadcastAndConfirm(
    transaction: StacksTransactionWire
  ): Promise<BroadcastAndConfirmResult> {
    // Broadcast to Stacks node
    let txid: string;
    try {
      const network = this.getNetwork();
      const result = (await broadcastTransaction({
        transaction,
        network,
      })) as { txid?: string; error?: string; reason?: string };

      if (result.error || !result.txid) {
        this.logger.error("Broadcast failed", {
          error: result.error,
          reason: result.reason,
        });
        return {
          error: "Broadcast failed",
          details: result.error || result.reason || "No txid in broadcast response",
          retryable: true,
        };
      }

      txid = result.txid;
      this.logger.info("Transaction broadcast successful", { txid });
    } catch (e) {
      this.logger.error("Broadcast threw exception", {
        error: e instanceof Error ? e.message : String(e),
      });
      return {
        error: "Broadcast failed",
        details: e instanceof Error ? e.message : "Unknown broadcast error",
        retryable: true,
      };
    }

    // Poll for confirmation with exponential backoff
    const hiroBaseUrl = this.getHiroBaseUrl();
    const hiroHeaders = this.getHiroHeaders();
    const pollUrl = `${hiroBaseUrl}/extended/v1/tx/${txid}`;

    const startTime = Date.now();
    let delay = 0; // First poll is immediate after broadcast

    while (true) {
      // Check for timeout before sleeping
      const elapsed = Date.now() - startTime;
      if (elapsed >= MAX_POLL_TIME_MS) {
        this.logger.info("Transaction confirmation timeout, returning pending", {
          txid,
          elapsedMs: elapsed,
        });
        return { txid, status: "pending" };
      }

      // Wait before polling (immediate on first iteration)
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      // Poll Hiro API
      try {
        const response = await fetch(pollUrl, {
          headers: hiroHeaders,
          signal: AbortSignal.timeout(10_000),
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

          if (txStatus?.startsWith("abort_") || txStatus?.startsWith("dropped_")) {
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
  }

  /**
   * Check KV for a cached deduplication result for the given transaction hex.
   * Returns the cached result if found, or null if not found or KV unavailable.
   */
  async checkDedup(sponsoredTxHex: string): Promise<DedupResult | null> {
    if (!this.env.RELAY_KV) {
      return null;
    }

    try {
      const txHash = await this.computeTxHash(sponsoredTxHex);
      const key = `${DEDUP_KEY_PREFIX}${txHash}`;
      const cached = await this.env.RELAY_KV.get(key);

      if (!cached) {
        return null;
      }

      const result = JSON.parse(cached) as DedupResult;
      this.logger.info("Dedup hit: returning cached result", {
        txHash: txHash.slice(0, 16) + "...",
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
      await this.env.RELAY_KV.put(key, JSON.stringify(result), {
        expirationTtl: DEDUP_TTL_SECONDS,
      });

      this.logger.debug("Dedup result recorded in KV", {
        txHash: txHash.slice(0, 16) + "...",
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
