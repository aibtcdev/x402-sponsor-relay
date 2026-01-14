import { Hono } from "hono";
import { cors } from "hono/cors";
import { fromHono } from "chanfana";
import type { Env, AppVariables } from "./types";
import { loggerMiddleware } from "./middleware";
import { Health, Relay } from "./endpoints";
import { VERSION } from "./version";

// Create Hono app with type safety
const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// Apply global middleware
app.use("/*", cors());
app.use("/*", loggerMiddleware);

// Initialize Chanfana for OpenAPI documentation
const openapi = fromHono(app, {
  docs_url: "/docs",
  openapi_url: "/openapi.json",
  schema: {
    info: {
      title: "x402 Stacks Sponsor Relay",
      version: VERSION,
      description:
        "A Cloudflare Worker enabling gasless transactions for AI agents on the Stacks blockchain. Accepts pre-signed sponsored transactions, sponsors them, and calls the x402 facilitator for settlement verification.",
    },
    tags: [
      { name: "Health", description: "Service health endpoints" },
      { name: "Relay", description: "Transaction relay endpoints" },
    ],
    servers: [
      {
        url: "https://x402-relay.aibtc.dev",
        description: "Staging (testnet)",
      },
      {
        url: "https://x402-relay.aibtc.com",
        description: "Production (mainnet)",
      },
    ],
  },
});

// Register endpoints with Chanfana
// Type cast needed as Chanfana expects endpoint classes
openapi.get("/health", Health as unknown as typeof Health);
openapi.post("/relay", Relay as unknown as typeof Relay);

// Root endpoint - service info
app.get("/", (c) => {
  return c.json({
    service: "x402-sponsor-relay",
    version: VERSION,
    description:
      "Gasless transactions for AI agents on the Stacks blockchain",
    docs: "/docs",
    endpoints: {
      relay: "POST /relay - Submit sponsored transaction for settlement",
      health: "GET /health - Health check with network info",
    },
    payment: {
      tokens: ["STX", "sBTC", "USDCx"],
      flow: "Agent signs sponsored tx -> Relay sponsors -> Facilitator settles",
    },
    related: {
      facilitator: "https://facilitator.stacksx402.com",
      github: "https://github.com/aibtcdev/x402-sponsor-relay",
    },
  });
});

// Global error handling
app.onError((err, c) => {
  const logger = c.get("logger");
  if (logger) {
    logger.error("Unhandled error", {
      error: err.message,
      stack: err.stack,
    });
  }
  return c.json(
    {
      error: "Internal server error",
      details: err.message,
    },
    500
  );
});

// 404 handler
app.notFound((c) => {
  return c.json(
    {
      error: "Not found",
      details: `Route ${c.req.method} ${c.req.path} not found`,
    },
    404
  );
});

export default app;
