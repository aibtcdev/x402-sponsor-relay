import { BaseEndpoint } from "./BaseEndpoint";
import type { AppContext } from "../types";
import { VERSION } from "../version";

/**
 * Health check endpoint
 * GET /health
 *
 * Top-level `status` reflects nonce pool health so consumers checking
 * `status === "ok"` correctly detect an unhealthy relay without digging
 * into /nonce/state fields.
 */
export class Health extends BaseEndpoint {
  schema = {
    tags: ["Health"],
    summary: "Service health summary",
    description:
      "Returns the relay service health summary with network and version. Use GET /status/sponsor for sponsor readiness and GET /wallets for operator wallet details.",
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
                status: {
                  type: "string" as const,
                  enum: ["ok", "degraded"],
                  description:
                    "'ok' when the nonce pool is healthy, 'degraded' when the pool reports unhealthy " +
                    "(circuit breaker open, gaps detected, or low capacity). " +
                    "Consumers should treat any non-'ok' value as unhealthy.",
                  example: "ok",
                },
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
    let poolHealthy: boolean | null = null;

    if (c.env.NONCE_DO) {
      try {
        const stub = c.env.NONCE_DO.get(c.env.NONCE_DO.idFromName("sponsor"));
        const response = await stub.fetch("https://nonce-do/nonce-state");
        if (response.ok) {
          const state = (await response.json()) as { healthy?: boolean };
          poolHealthy = state.healthy ?? null;
        }
      } catch {
        // Coordinator unreachable — stay "ok", logged separately by /nonce/state
      }
    }

    const status = poolHealthy === false ? "degraded" : "ok";

    return this.ok(c, {
      status,
      network: c.env.STACKS_NETWORK,
      version: VERSION,
    });
  }
}
