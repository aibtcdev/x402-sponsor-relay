import type { Service } from "cloudflare:workers";

// LogsRPC interface (from worker-logs service)
interface LogsRPC {
  info(appId: string, message: string, context?: Record<string, unknown>): Promise<void>;
  warn(appId: string, message: string, context?: Record<string, unknown>): Promise<void>;
  error(appId: string, message: string, context?: Record<string, unknown>): Promise<void>;
  debug(appId: string, message: string, context?: Record<string, unknown>): Promise<void>;
}

export interface Env {
  // Sponsor private key for signing transactions
  SPONSOR_PRIVATE_KEY: string;
  // Stacks network (mainnet or testnet)
  STACKS_NETWORK: string;
  // Universal logging service (RPC binding)
  LOGS: Service<LogsRPC>;
}

const APP_ID = "x402-relay";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const requestId = crypto.randomUUID();

    // Health check endpoint
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok", network: env.STACKS_NETWORK }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // TODO: Implement sponsor relay endpoint
    if (url.pathname === "/relay" && request.method === "POST") {
      // Log the incoming request (fire-and-forget)
      ctx.waitUntil(
        env.LOGS.info(APP_ID, "Relay request received", {
          request_id: requestId,
          method: request.method,
          url: request.url,
        })
      );

      // TODO: Implement relay logic
      return new Response(JSON.stringify({ error: "Not implemented" }), {
        status: 501,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("x402 Stacks Sponsor Relay", {
      headers: { "Content-Type": "text/plain" },
    });
  },
};
