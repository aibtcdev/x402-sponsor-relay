import { BaseEndpoint } from "./BaseEndpoint";
import type { AppContext } from "../types";
import { VERSION } from "../version";

/**
 * Health check endpoint
 * GET /health
 */
export class Health extends BaseEndpoint {
  schema = {
    tags: ["Health"],
    summary: "Health check with network info",
    responses: {
      "200": {
        description: "Service health status",
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
                status: { type: "string" as const, example: "ok" },
                network: { type: "string" as const, example: "testnet" },
                version: { type: "string" as const, example: VERSION },
              },
            },
          },
        },
      },
    },
  };

  async handle(c: AppContext) {
    return this.ok(c, {
      status: "ok",
      network: c.env.STACKS_NETWORK,
      version: VERSION,
    });
  }
}
