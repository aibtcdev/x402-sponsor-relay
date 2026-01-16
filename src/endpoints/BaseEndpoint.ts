import { OpenAPIRoute } from "chanfana";
import type { AppContext, Logger, RelayErrorCode, RelayErrorResponse } from "../types";

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
   * Return a standardized error response (legacy)
   */
  protected errorResponse(
    c: AppContext,
    error: string,
    status: number,
    details?: string
  ) {
    const response: { error: string; details?: string } = { error };
    if (details) {
      response.details = details;
    }
    return c.json(response, status as 400 | 401 | 402 | 404 | 429 | 500 | 502 | 504);
  }

  /**
   * Return a structured error response with retry guidance
   */
  protected structuredError(
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
      error: opts.error,
      code: opts.code,
      retryable: opts.retryable,
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
