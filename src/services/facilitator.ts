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
import { HealthMonitor } from "./health-monitor";

const FACILITATOR_TIMEOUT_MS = 30000; // 30 seconds

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

        return {
          success: false,
          error: "Settlement failed",
          details:
            settleResponse.validation_errors?.join(", ") ||
            settleResponse.error ||
            "Unknown error",
          httpStatus: 400,
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
