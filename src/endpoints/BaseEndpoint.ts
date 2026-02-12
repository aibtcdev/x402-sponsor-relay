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
  protected ok<T extends object>(c: AppContext, data: T) {
    const response = {
      success: true as const,
      requestId: this.getRequestId(c),
      ...data,
    };
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

    return c.json(response, opts.status as 400 | 401 | 402 | 404 | 429 | 500 | 502 | 504);
  }
}
