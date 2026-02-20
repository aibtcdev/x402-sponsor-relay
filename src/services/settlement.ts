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

// Known SIP-010 token contract addresses
const SBTC_CONTRACT_MAINNET = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4";
const SBTC_CONTRACT_TESTNET = "ST1F7QA2MDF17S807EPA36TSS8AMEQ4ASGQBP8WN4";
const SBTC_CONTRACT_NAME = "sbtc-token";
const USDCX_CONTRACT_MAINNET = "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9";
const USDCX_CONTRACT_NAME = "token-aeusdc";
const SIP010_TRANSFER_FUNCTION = "transfer";

// Polling configuration
const MAX_POLL_TIME_MS = 60_000;
const INITIAL_POLL_DELAY_MS = 2_000;
const POLL_BACKOFF_FACTOR = 1.5;
const MAX_POLL_DELAY_MS = 8_000;

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

    // Try to parse a Stacks FT CAIP-19 identifier and extract the contract address.
    const contractAddr = this.extractStacksFtContractAddress(asset);
    if (contractAddr === SBTC_CONTRACT_MAINNET || contractAddr === SBTC_CONTRACT_TESTNET) {
      return "sBTC";
    }
    if (contractAddr === USDCX_CONTRACT_MAINNET) {
      return "USDCx";
    }

    // Try bare contract principal format: "address.contract-name"
    const bareMatch = this.matchBareContractPrincipal(asset);
    if (bareMatch !== null) {
      return bareMatch;
    }

    return null;
  }

  /**
   * Match a bare Stacks contract principal (address.contract-name) against
   * known token contracts. Returns the mapped TokenType or null if unrecognized.
   *
   * Handles:
   * - "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token" → "sBTC" (mainnet)
   * - "ST1F7QA2MDF17S807EPA36TSS8AMEQ4ASGQBP8WN4.sbtc-token"  → "sBTC" (testnet)
   * - "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9.token-aeusdc" → "USDCx"
   */
  private matchBareContractPrincipal(asset: string): TokenType | null {
    const dotIndex = asset.indexOf(".");
    if (dotIndex === -1) return null;
    const address = asset.substring(0, dotIndex).toUpperCase();
    const contractName = asset.substring(dotIndex + 1);

    if (
      (address === SBTC_CONTRACT_MAINNET || address === SBTC_CONTRACT_TESTNET) &&
      contractName === SBTC_CONTRACT_NAME
    ) {
      return "sBTC";
    }
    if (address === USDCX_CONTRACT_MAINNET && contractName === USDCX_CONTRACT_NAME) {
      return "USDCx";
    }
    return null;
  }

  /**
   * Extract the Stacks FT contract principal from a CAIP-19 asset identifier.
   *
   * Expected format: stacks:<chainId>/sip010:<contractAddr>.<contractName>.<tokenName>
   * Returns the uppercase contract address, or null if not a valid Stacks FT CAIP-19.
   */
  private extractStacksFtContractAddress(asset: string): string | null {
    if (!asset.toLowerCase().startsWith("stacks:")) return null;
    const parts = asset.split("/");
    if (parts.length < 2) return null;
    const assetSpec = parts[1]; // e.g., "sip010:SP1234.my-token.my-token"
    if (!assetSpec.toLowerCase().startsWith("sip010:")) return null;
    const afterType = assetSpec.substring(7); // strip "sip010:"
    if (!afterType) return null;
    const [contractPrincipal] = afterType.split(".");
    return contractPrincipal ? contractPrincipal.toUpperCase() : null;
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
      } else if (contractAddressStr === USDCX_CONTRACT_MAINNET) {
        if (contractNameStr !== USDCX_CONTRACT_NAME) {
          return {
            valid: false,
            error: "Unsupported contract",
            details: `Expected contract name '${USDCX_CONTRACT_NAME}', got '${contractNameStr}'`,
          };
        }
        tokenType = "USDCx";
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
    // Broadcast to Stacks node via direct fetch to /v2/transactions.
    // Using direct fetch instead of broadcastTransaction() from @stacks/transactions
    // to avoid unhandled throws on non-JSON node responses and gain structured
    // Ok/Err handling regardless of the node's response content type.
    let txid: string;
    try {
      const hiroBaseUrl = getHiroBaseUrl(this.env.STACKS_NETWORK);
      const broadcastUrl = `${hiroBaseUrl}/v2/transactions`;

      // Serialize transaction to bytes (serialize() returns hex in @stacks/transactions v7)
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

      const broadcastHeaders: Record<string, string> = {
        "Content-Type": "application/octet-stream",
        ...getHiroHeaders(this.env.HIRO_API_KEY),
      };

      const broadcastResponse = await fetch(broadcastUrl, {
        method: "POST",
        headers: broadcastHeaders,
        body: txBytes,
        signal: AbortSignal.timeout(15_000),
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
        this.logger.info("Transaction broadcast successful", { txid });
      } else {
        // Error: try to parse JSON error body; fall back to raw text
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
          this.logger.warn("Broadcast rejected due to nonce conflict", {
            status: broadcastResponse.status,
            details: conflictDetails,
          });
          return {
            error: "Nonce conflict",
            details: conflictDetails,
            retryable: true,
            nonceConflict: true,
          };
        }

        this.logger.error("Broadcast failed", {
          status: broadcastResponse.status,
          error: errorMessage,
          details: errorDetails,
        });
        return {
          error: "Broadcast failed",
          details: conflictDetails,
          retryable: true,
        };
      }
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
    const hiroBaseUrl = getHiroBaseUrl(this.env.STACKS_NETWORK);
    const hiroHeaders = getHiroHeaders(this.env.HIRO_API_KEY);
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
        signal: AbortSignal.timeout(5_000),
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
