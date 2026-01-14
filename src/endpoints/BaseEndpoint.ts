import { OpenAPIRoute } from "chanfana";
import type { AppContext, Logger } from "../types";

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
   * Return a standardized error response
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
   * Return a standardized success response
   */
  protected successResponse<T extends Record<string, unknown>>(
    c: AppContext,
    data: T
  ) {
    return c.json(data);
  }
}
