import { BaseEndpoint } from "./BaseEndpoint";
import { FeeService } from "../services";
import type { AppContext, FeesResponse } from "../types";
import { Error500Response } from "../schemas";

/**
 * Fee estimation endpoint
 * GET /fees
 */
export class Fees extends BaseEndpoint {
  schema = {
    tags: ["Fees"],
    summary: "Get clamped fee estimates",
    description:
      "Returns fee estimates for all transaction types (token_transfer, contract_call, smart_contract) " +
      "with per-type floor/ceiling clamps applied. Fetches from Hiro API with 60s KV caching. " +
      "Prevents overpayment from mempool poisoning by capping maximum fees.",
    responses: {
      "200": {
        description: "Fee estimates retrieved successfully",
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              properties: {
                success: { type: "boolean" as const, example: true },
                requestId: {
                  type: "string" as const,
                  format: "uuid",
                  description: "Unique request identifier for tracking",
                },
                fees: {
                  type: "object" as const,
                  description: "Clamped fee estimates in microSTX",
                  properties: {
                    token_transfer: {
                      type: "object" as const,
                      properties: {
                        low_priority: { type: "number" as const, example: 180 },
                        medium_priority: { type: "number" as const, example: 180 },
                        high_priority: { type: "number" as const, example: 180 },
                      },
                    },
                    contract_call: {
                      type: "object" as const,
                      properties: {
                        low_priority: { type: "number" as const, example: 3000 },
                        medium_priority: { type: "number" as const, example: 50000 },
                        high_priority: { type: "number" as const, example: 50000 },
                      },
                    },
                    smart_contract: {
                      type: "object" as const,
                      properties: {
                        low_priority: { type: "number" as const, example: 10000 },
                        medium_priority: { type: "number" as const, example: 40000 },
                        high_priority: { type: "number" as const, example: 40000 },
                      },
                    },
                  },
                },
                source: {
                  type: "string" as const,
                  enum: ["hiro", "cache", "default"],
                  description: "Source of fee data (hiro=fresh, cache=cached, default=fallback)",
                },
                cached: {
                  type: "boolean" as const,
                  description: "Whether this data came from cache",
                },
              },
            },
          },
        },
      },
      "500": Error500Response,
    },
  };

  async handle(c: AppContext) {
    const logger = this.getLogger(c);

    try {
      const feeService = new FeeService(c.env, logger);
      const result = await feeService.getEstimates();

      const response: FeesResponse = {
        fees: result.fees,
        source: result.source,
        cached: result.cached,
      };

      return this.ok(c, response);
    } catch (e) {
      logger.error("Failed to get fee estimates", {
        error: e instanceof Error ? e.message : "Unknown error",
      });
      return this.err(c, {
        error: "Failed to retrieve fee estimates",
        code: "FEE_FETCH_FAILED",
        status: 500,
        details: e instanceof Error ? e.message : "Unknown error",
        retryable: true,
        retryAfter: 5,
      });
    }
  }
}
