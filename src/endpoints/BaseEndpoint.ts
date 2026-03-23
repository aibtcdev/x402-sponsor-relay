import { OpenAPIRoute } from "chanfana";
import type {
  AppContext,
  Logger,
  RelayErrorCode,
  RelayErrorResponse,
  RelaySuccessResponse,
  SettlementResult,
} from "../types";
import { buildExplorerUrl } from "../utils";

/**
 * Base endpoint class with common helpers
 */
export class BaseEndpoint extends OpenAPIRoute {
  /**
   * Get the logger from context
   */
  protected getLogger(c: AppContext): Logger {
    return c.get("logger");
  }

  /**
   * Get the request ID from context
   */
  protected getRequestId(c: AppContext): string {
    return c.get("requestId");
  }

  /**
   * Return a success response with requestId
   * Use for simple endpoints that don't return transaction data
   */
  protected ok<T extends object>(
    c: AppContext,
    data: T,
    headers?: Record<string, string>
  ) {
    const response = {
      success: true as const,
      requestId: this.getRequestId(c),
      ...data,
    };
    if (headers) {
      for (const [key, value] of Object.entries(headers)) {
        c.header(key, value);
      }
    }
    return c.json(response);
  }

  /**
   * Return a success response with transaction details
   * Includes txid, explorerUrl, and optional settlement, sponsoredTx, and receiptId
   */
  protected okWithTx(
    c: AppContext,
    opts: {
      txid: string;
      settlement?: SettlementResult;
      sponsoredTx?: string;
      receiptId?: string;
    }
  ) {
    const response: RelaySuccessResponse = {
      success: true,
      requestId: this.getRequestId(c),
      txid: opts.txid,
      explorerUrl: buildExplorerUrl(opts.txid, c.env.STACKS_NETWORK),
      ...(opts.settlement && { settlement: opts.settlement }),
      ...(opts.sponsoredTx && { sponsoredTx: opts.sponsoredTx }),
      ...(opts.receiptId && { receiptId: opts.receiptId }),
    };
    return c.json(response);
  }

  /**
   * Map a sponsor failure to a structured error response.
   * Shared by /relay and /sponsor to avoid duplicated nested ternary logic.
   */
  protected sponsorFailureResponse(
    c: AppContext,
    failure: { error: string; details: string; code?: string; retryAfter?: number },
    statsWaitUntil: Promise<void>
  ) {
    c.executionCtx.waitUntil(statsWaitUntil);

    let code: RelayErrorCode;
    let status: number;
    let retryable: boolean;
    let retryAfter: number | undefined;

    if (failure.code === "LOW_HEADROOM") {
      code = "LOW_HEADROOM";
      status = 503;
      retryable = true;
      retryAfter = failure.retryAfter ?? 10;
    } else if (failure.code === "NONCE_DO_UNAVAILABLE") {
      code = "NONCE_DO_UNAVAILABLE";
      status = 503;
      retryable = true;
      retryAfter = 3;
    } else if (failure.error === "Service not configured") {
      code = "SPONSOR_CONFIG_ERROR";
      status = 500;
      retryable = false;
    } else {
      code = "SPONSOR_FAILED";
      status = 500;
      retryable = true;
    }

    return this.err(c, {
      error: failure.error,
      code,
      status,
      details: failure.details,
      retryable,
      retryAfter,
    });
  }

  /**
   * Schedule a delayed nonce DO resync after a nonce conflict.
   * Fire-and-forget via waitUntil -- never blocks the response.
   * Pass the promise from sponsorService.resyncNonceDODelayed().
   */
  protected scheduleNonceResync(
    c: AppContext,
    resyncPromise: Promise<void>,
    logger: Logger
  ): void {
    c.executionCtx.waitUntil(
      resyncPromise.catch((e) => {
        logger.warn("resyncNonceDODelayed failed after nonce conflict", {
          error: String(e),
        });
      })
    );
  }

  /**
   * Map a client rejection reason from BroadcastAndConfirmResult to a structured
   * error response. The switch covers known reasons (NotEnoughFunds, BadNonce,
   * ConflictingNonceInMempool) with specific codes/statuses, and falls through
   * to a generic BROADCAST_REJECTED response for any other client rejection.
   *
   * Shared by /relay (sponsored + self-pay) and /sponsor to avoid duplicating
   * the same if/else chain across three call sites.
   */
  protected clientRejectionResponse(
    c: AppContext,
    clientRejection: string,
    details: string
  ): Response {
    switch (clientRejection) {
      case "NotEnoughFunds":
        return this.err(c, {
          error: "Sender has insufficient funds — top up the wallet and re-sign the transaction",
          code: "CLIENT_INSUFFICIENT_FUNDS",
          status: 422,
          details: `${details} (node reason: ${clientRejection})`,
          retryable: false,
        });
      case "BadNonce":
        return this.err(c, {
          error: "Sender nonce is invalid — re-sign the transaction with the correct account nonce",
          code: "CLIENT_BAD_NONCE",
          status: 422,
          details: `${details} (node reason: ${clientRejection})`,
          retryable: true,
        });
      case "ConflictingNonceInMempool":
        return this.err(c, {
          error: "Sender nonce conflicts with a pending mempool transaction — wait and retry",
          code: "CLIENT_NONCE_CONFLICT",
          status: 409,
          details: `${details} (node reason: ${clientRejection})`,
          retryable: true,
          retryAfter: 30,
        });
      default:
        // Recognized as a client rejection but no specific mapping — 422 (client tx invalid)
        return this.err(c, {
          error: `Transaction rejected by the Stacks node: ${clientRejection}`,
          code: "BROADCAST_REJECTED",
          status: 422,
          details: `${details} (node reason: ${clientRejection})`,
          retryable: true,
        });
    }
  }

  /**
   * Return a structured error response with retry guidance
   */
  protected err(
    c: AppContext,
    opts: {
      error: string;
      code: RelayErrorCode;
      status: number;
      details?: string;
      retryable: boolean;
      retryAfter?: number;
    }
  ) {
    const response: RelayErrorResponse = {
      success: false,
      error: opts.error,
      code: opts.code,
      retryable: opts.retryable,
      requestId: this.getRequestId(c),
    };

    if (opts.details) {
      response.details = opts.details;
    }

    if (opts.retryAfter !== undefined) {
      response.retryAfter = opts.retryAfter;
      c.header("Retry-After", opts.retryAfter.toString());
    }

    return c.json(response, opts.status as 400 | 401 | 402 | 404 | 409 | 422 | 429 | 500 | 502 | 503 | 504);
  }
}
