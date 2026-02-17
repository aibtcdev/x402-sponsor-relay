import type {
  Env,
  Logger,
  SettleOptions,
  TokenType,
  FacilitatorTokenType,
  FacilitatorSettleRequest,
  FacilitatorSettleResponse,
  SettlementResult,
} from "../types";
import { hexToBytes } from "@stacks/common";
import { txidFromBytes } from "@stacks/transactions";
import { HealthMonitor } from "./health-monitor";

const FACILITATOR_TIMEOUT_MS = 30000; // 30 seconds
const HEALTH_CHECK_TIMEOUT_MS = 5000; // 5 seconds for health checks
const HIRO_TIMEOUT_MS = 5000; // 5 seconds for tx lookups
const RBF_RECOVERY_ATTEMPTS = 3;
const RBF_RECOVERY_DELAY_MS = 2000;

/**
 * Map token types to facilitator format
 */
const TOKEN_TYPE_MAP: Record<TokenType, FacilitatorTokenType> = {
  STX: "STX",
  sBTC: "SBTC",
  USDCx: "USDCX",
};

/**
 * Successful facilitator result
 */
export interface FacilitatorSuccess {
  success: true;
  txid: string;
  settlement: SettlementResult;
}

/**
 * Failed facilitator result
 */
export interface FacilitatorFailure {
  success: false;
  error: string;
  details: string;
  httpStatus: number;
}

/**
 * Result of facilitator settle call (discriminated union)
 */
export type FacilitatorResult = FacilitatorSuccess | FacilitatorFailure;

/**
 * Settle options validation success
 */
export interface SettleValidationSuccess {
  valid: true;
}

/**
 * Settle options validation failure
 */
export interface SettleValidationFailure {
  valid: false;
  error: string;
  details: string;
}

/**
 * Result of settle options validation (discriminated union)
 */
export type SettleValidationResult =
  | SettleValidationSuccess
  | SettleValidationFailure;

type ParsedTransferEvent = {
  tokenKind: "STX" | "FT";
  assetId?: string;
  amount: string;
  sender?: string;
  recipient?: string;
};

type HiroTxResponse = {
  tx_id?: string;
  tx_status?: string;
  sender_address?: string;
  block_height?: number;
  events?: unknown[];
};

/**
 * Service for interacting with the x402 facilitator
 */
export class FacilitatorService {
  private env: Env;
  private logger: Logger;
  private healthMonitor: HealthMonitor;

  constructor(env: Env, logger: Logger) {
    this.env = env;
    this.logger = logger;
    this.healthMonitor = new HealthMonitor(env.RELAY_KV, logger);
  }

  private isDroppedReplaceByFee(details: string): boolean {
    return /dropped_replace_by_fee/i.test(details);
  }

  private with0x(txid: string): string {
    return txid.startsWith("0x") ? txid : `0x${txid}`;
  }

  private computeTxidFromSponsoredTx(sponsoredTxHex: string): string | null {
    try {
      const raw = sponsoredTxHex.startsWith("0x")
        ? sponsoredTxHex.slice(2)
        : sponsoredTxHex;
      return this.with0x(txidFromBytes(hexToBytes(raw)));
    } catch (e) {
      this.logger.warn("Failed to compute txid from sponsored tx", {
        error: e instanceof Error ? e.message : "Unknown error",
      });
      return null;
    }
  }

  private hiroBaseUrl(): string {
    return this.env.STACKS_NETWORK === "mainnet"
      ? "https://api.hiro.so"
      : "https://api.testnet.hiro.so";
  }

  private hiroHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.env.HIRO_API_KEY) {
      headers["x-hiro-api-key"] = this.env.HIRO_API_KEY;
    }
    return headers;
  }

  private parseTransferEvent(event: unknown): ParsedTransferEvent | null {
    if (typeof event !== "object" || event === null) return null;
    const e = event as {
      event_type?: string;
      asset?: { amount?: string | number; sender?: string; recipient?: string; asset_id?: string };
      stx_transfer_event?: { amount?: string | number; sender?: string; recipient?: string };
      ft_transfer_event?: {
        amount?: string | number;
        sender?: string;
        recipient?: string;
        asset_identifier?: string;
      };
    };

    if (e.event_type === "stx_asset" || e.event_type === "stx_transfer_event") {
      const amount = e.asset?.amount ?? e.stx_transfer_event?.amount;
      const sender = e.asset?.sender ?? e.stx_transfer_event?.sender;
      const recipient = e.asset?.recipient ?? e.stx_transfer_event?.recipient;
      if (amount === undefined || amount === null) return null;
      return {
        tokenKind: "STX",
        amount: String(amount),
        sender,
        recipient,
      };
    }

    if (
      e.event_type === "fungible_token_asset" ||
      e.event_type === "ft_transfer_event"
    ) {
      const amount = e.asset?.amount ?? e.ft_transfer_event?.amount;
      const sender = e.asset?.sender ?? e.ft_transfer_event?.sender;
      const recipient = e.asset?.recipient ?? e.ft_transfer_event?.recipient;
      const assetId = e.asset?.asset_id ?? e.ft_transfer_event?.asset_identifier;
      if (amount === undefined || amount === null) return null;
      return {
        tokenKind: "FT",
        assetId,
        amount: String(amount),
        sender,
        recipient,
      };
    }

    return null;
  }

  private tokenMatches(tokenType: TokenType, event: ParsedTransferEvent): boolean {
    if (tokenType === "STX") {
      return event.tokenKind === "STX";
    }
    if (event.tokenKind !== "FT") {
      return false;
    }
    const asset = (event.assetId || "").toLowerCase();
    if (tokenType === "sBTC") {
      return asset.includes("sbtc");
    }
    if (tokenType === "USDCx") {
      return asset.includes("usdc");
    }
    return false;
  }

  private buildRecoveredSettlement(
    tx: HiroTxResponse,
    settle: SettleOptions
  ): SettlementResult | null {
    const minAmount = BigInt(settle.minAmount);
    const tokenType = settle.tokenType || "STX";

    if (settle.expectedSender && tx.sender_address && settle.expectedSender !== tx.sender_address) {
      return null;
    }

    const events = Array.isArray(tx.events) ? tx.events : [];
    for (const rawEvent of events) {
      const parsed = this.parseTransferEvent(rawEvent);
      if (!parsed) continue;
      if (!this.tokenMatches(tokenType, parsed)) continue;
      if (!parsed.recipient || parsed.recipient !== settle.expectedRecipient) continue;
      if (settle.expectedSender && parsed.sender && parsed.sender !== settle.expectedSender) continue;

      try {
        const amount = BigInt(parsed.amount);
        if (amount < minAmount) continue;
      } catch {
        continue;
      }

      return {
        success: true,
        status: "confirmed",
        sender: parsed.sender || tx.sender_address || settle.expectedSender,
        recipient: parsed.recipient,
        amount: parsed.amount,
        blockHeight: tx.block_height,
      };
    }

    return null;
  }

  private async recoverDroppedRbfSettlement(
    sponsoredTxHex: string,
    settle: SettleOptions,
    facilitatorTxid?: string
  ): Promise<FacilitatorSuccess | null> {
    const txid = facilitatorTxid
      ? this.with0x(facilitatorTxid)
      : this.computeTxidFromSponsoredTx(sponsoredTxHex);
    if (!txid) return null;

    const url = `${this.hiroBaseUrl()}/extended/v1/tx/${txid}`;
    const headers = this.hiroHeaders();

    for (let attempt = 1; attempt <= RBF_RECOVERY_ATTEMPTS; attempt++) {
      try {
        const response = await fetch(url, {
          headers,
          signal: AbortSignal.timeout(HIRO_TIMEOUT_MS),
        });

        if (!response.ok) {
          this.logger.warn("Hiro tx lookup failed during RBF recovery", {
            txid,
            status: response.status,
            attempt,
          });
        } else {
          const tx = (await response.json()) as HiroTxResponse;
          const status = tx.tx_status || "unknown";

          if (status === "success") {
            const recovered = this.buildRecoveredSettlement(tx, settle);
            if (recovered) {
              this.logger.info("Recovered settlement after dropped_replace_by_fee", {
                txid,
                attempt,
              });
              return {
                success: true,
                txid: this.with0x(tx.tx_id || txid),
                settlement: recovered,
              };
            }
            this.logger.warn("Tx confirmed but could not validate transfer details", {
              txid,
              expectedRecipient: settle.expectedRecipient,
              minAmount: settle.minAmount,
            });
            return null;
          }

          if (
            status !== "pending" &&
            status !== "dropped_replace_by_fee" &&
            status !== "unknown"
          ) {
            this.logger.warn("RBF recovery aborted on terminal tx status", {
              txid,
              status,
            });
            return null;
          }
        }
      } catch (e) {
        this.logger.warn("Hiro tx lookup error during RBF recovery", {
          txid,
          attempt,
          error: e instanceof Error ? e.message : "Unknown error",
        });
      }

      if (attempt < RBF_RECOVERY_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, RBF_RECOVERY_DELAY_MS));
      }
    }

    return null;
  }

  /**
   * Check facilitator health by calling its /health endpoint directly.
   * Records the result in HealthMonitor for dashboard display.
   * Returns true if healthy, false otherwise.
   */
  async checkHealth(): Promise<boolean> {
    const startTime = performance.now();

    try {
      const response = await fetch(`${this.env.FACILITATOR_URL}/health`, {
        method: "GET",
        signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
      });

      const latencyMs = Math.round(performance.now() - startTime);

      if (!response.ok) {
        this.logger.warn("Facilitator health check failed", {
          status: response.status,
          latencyMs,
        });

        await this.healthMonitor.recordCheck({
          status: HealthMonitor.determineCheckStatus(response.status, latencyMs),
          latencyMs,
          httpStatus: response.status,
          error: `HTTP ${response.status}`,
        });

        return false;
      }

      // Parse response to verify it's valid JSON with status
      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const data = (await response.json()) as { status?: string };
        if (data.status !== "ok") {
          this.logger.warn("Facilitator reported unhealthy status", {
            status: data.status,
            latencyMs,
          });

          await this.healthMonitor.recordCheck({
            status: "degraded",
            latencyMs,
            httpStatus: response.status,
            error: `Reported status: ${data.status}`,
          });

          return false;
        }
      }

      // Record healthy check
      await this.healthMonitor.recordCheck({
        status: HealthMonitor.determineCheckStatus(response.status, latencyMs),
        latencyMs,
        httpStatus: response.status,
      });

      this.logger.debug("Facilitator health check passed", { latencyMs });
      return true;
    } catch (e) {
      const latencyMs = Math.round(performance.now() - startTime);
      const isTimeout = e instanceof Error && e.name === "TimeoutError";

      this.logger.error(
        isTimeout
          ? "Facilitator health check timed out"
          : "Facilitator health check failed",
        { error: e instanceof Error ? e.message : "Unknown error" }
      );

      await this.healthMonitor.recordCheck({
        status: "down",
        latencyMs,
        httpStatus: isTimeout ? 504 : 500,
        error: e instanceof Error ? e.message : "Unknown error",
      });

      return false;
    }
  }

  /**
   * Validate settle options
   */
  validateSettleOptions(settle: SettleOptions): SettleValidationResult {
    if (!settle.expectedRecipient || !settle.minAmount) {
      return {
        valid: false,
        error: "Invalid settle options",
        details: "expectedRecipient and minAmount are required",
      };
    }

    // Validate minimum amount is numeric
    if (!/^\d+$/.test(settle.minAmount)) {
      return {
        valid: false,
        error: "Invalid minimum amount",
        details: "settle.minAmount must be a numeric string",
      };
    }

    // Validate token type if provided
    const tokenType = settle.tokenType || "STX";
    if (!TOKEN_TYPE_MAP[tokenType]) {
      return {
        valid: false,
        error: "Invalid token type",
        details: `Unsupported token type: ${tokenType}. Valid types: STX, sBTC, USDCx`,
      };
    }

    return { valid: true };
  }

  /**
   * Call the facilitator settle endpoint
   */
  async settle(
    sponsoredTxHex: string,
    settle: SettleOptions
  ): Promise<FacilitatorResult> {
    const tokenType = settle.tokenType || "STX";
    const mappedTokenType = TOKEN_TYPE_MAP[tokenType];

    // Build facilitator request
    const settleRequest: FacilitatorSettleRequest = {
      signed_transaction: sponsoredTxHex,
      expected_recipient: settle.expectedRecipient,
      min_amount: parseInt(settle.minAmount, 10),
      network: this.env.STACKS_NETWORK || "testnet",
      token_type: mappedTokenType,
      expected_sender: settle.expectedSender,
      resource: settle.resource,
      method: settle.method,
    };

    this.logger.info("Calling facilitator settle", {
      facilitator_url: this.env.FACILITATOR_URL,
      expected_recipient: settleRequest.expected_recipient,
      min_amount: settleRequest.min_amount,
    });

    const startTime = performance.now();

    try {
      const response = await fetch(
        `${this.env.FACILITATOR_URL}/api/v1/settle`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(settleRequest),
          signal: AbortSignal.timeout(FACILITATOR_TIMEOUT_MS),
        }
      );

      const latencyMs = Math.round(performance.now() - startTime);

      // Handle non-JSON responses (e.g., 502/504 gateway errors)
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        const text = await response.text();
        this.logger.error("Facilitator returned non-JSON response", {
          status: response.status,
          content_type: contentType,
          body_preview: text.slice(0, 200),
        });

        // Record health check for non-JSON response
        await this.healthMonitor.recordCheck({
          status: HealthMonitor.determineCheckStatus(response.status, latencyMs),
          latencyMs,
          httpStatus: response.status,
          error: `Non-JSON response: ${text.slice(0, 50)}`,
        });

        return {
          success: false,
          error: "Facilitator error",
          details: `Unexpected response (${response.status}): ${text.slice(0, 100)}`,
          httpStatus: 502,
        };
      }

      const settleResponse =
        (await response.json()) as FacilitatorSettleResponse;

      if (!response.ok) {
        this.logger.error("Facilitator settle failed", {
          status: response.status,
          error: settleResponse.error,
          validation_errors: settleResponse.validation_errors,
        });

        // Record health check for failed response
        await this.healthMonitor.recordCheck({
          status: HealthMonitor.determineCheckStatus(response.status, latencyMs),
          latencyMs,
          httpStatus: response.status,
          error: settleResponse.error,
        });

        const details =
          settleResponse.validation_errors?.join(", ") ||
          settleResponse.error ||
          "Unknown error";

        if (this.isDroppedReplaceByFee(details)) {
          const recovered = await this.recoverDroppedRbfSettlement(
            sponsoredTxHex,
            settle,
            settleResponse.tx_id
          );
          if (recovered) {
            return recovered;
          }
        }

        return {
          success: false,
          error: "Settlement failed",
          details,
          httpStatus: response.status,
        };
      }

      // Validate response has txid
      if (!settleResponse.tx_id) {
        this.logger.error("Facilitator response missing tx_id", {
          settlement_status: settleResponse.status,
        });

        // Record health check for invalid response
        await this.healthMonitor.recordCheck({
          status: "degraded",
          latencyMs,
          httpStatus: response.status,
          error: "Missing tx_id in response",
        });

        return {
          success: false,
          error: "Settlement response invalid",
          details: "Missing transaction ID in facilitator response",
          httpStatus: 502,
        };
      }

      // Record successful health check
      await this.healthMonitor.recordCheck({
        status: HealthMonitor.determineCheckStatus(response.status, latencyMs),
        latencyMs,
        httpStatus: response.status,
      });

      return {
        success: true,
        txid: settleResponse.tx_id,
        settlement: {
          success: settleResponse.success,
          status: settleResponse.status || "unknown",
          sender: settleResponse.sender_address,
          recipient: settleResponse.recipient_address,
          amount: settleResponse.amount?.toString(),
          blockHeight: settleResponse.block_height,
        },
      };
    } catch (e) {
      const latencyMs = Math.round(performance.now() - startTime);
      const isTimeout = e instanceof Error && e.name === "TimeoutError";

      this.logger.error(
        isTimeout ? "Facilitator request timed out" : "Failed to call facilitator",
        { error: e instanceof Error ? e.message : "Unknown error" }
      );

      // Record health check for error/timeout
      await this.healthMonitor.recordCheck({
        status: "down",
        latencyMs,
        httpStatus: isTimeout ? 504 : 500,
        error: e instanceof Error ? e.message : "Unknown error",
      });

      return {
        success: false,
        error: isTimeout ? "Facilitator timeout" : "Failed to settle transaction",
        details: e instanceof Error ? e.message : "Unknown error",
        httpStatus: isTimeout ? 504 : 500,
      };
    }
  }
}
