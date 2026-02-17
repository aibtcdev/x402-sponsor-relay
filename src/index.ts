import { Hono } from "hono";
import { cors } from "hono/cors";
import { fromHono } from "chanfana";
import type { Env, AppVariables } from "./types";
import { loggerMiddleware, authMiddleware, requireAuthMiddleware } from "./middleware";
import { Health, Relay, Sponsor, DashboardStats, Verify, Access, Provision, ProvisionStx, Fees, FeesConfig } from "./endpoints";
import { dashboard } from "./dashboard";
import { discovery } from "./routes/discovery";
import { VERSION } from "./version";

// Create Hono app with type safety
const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// Apply global middleware
app.use("/*", cors());
app.use("/*", loggerMiddleware);

// Apply auth middleware to /sponsor and /fees/config endpoints before registering routes
// authMiddleware validates API keys and sets auth context
// requireAuthMiddleware rejects requests without valid API key (no grace period)
app.use("/sponsor", authMiddleware);
app.use("/sponsor", requireAuthMiddleware);
app.use("/fees/config", authMiddleware);
app.use("/fees/config", requireAuthMiddleware);

// Initialize Chanfana for OpenAPI documentation
// NOTE: docs_url changed to /api-docs so /docs is free for AX discovery JSON index
const openapi = fromHono(app, {
  docs_url: "/api-docs",
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
      { name: "Relay", description: "Transaction relay endpoints (x402 facilitator)" },
      { name: "Sponsor", description: "Transaction sponsor endpoints (direct broadcast)" },
      { name: "Verify", description: "Payment receipt verification" },
      { name: "Access", description: "Protected resource access" },
      { name: "Provision", description: "API key provisioning via Bitcoin signature" },
      { name: "Fees", description: "Fee estimation endpoints" },
      { name: "Dashboard", description: "Public statistics endpoints" },
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
    // Security scheme for API key authentication
    // Cast needed as Chanfana types don't expose components directly
    ...({
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "API Key",
            description: "API key in format: x402_sk_<env>_<32-char-hex>",
          },
        },
      },
    } as Record<string, unknown>),
  },
});

// Register endpoints with Chanfana
// Type cast needed as Chanfana expects endpoint classes
openapi.get("/health", Health as unknown as typeof Health);
openapi.post("/relay", Relay as unknown as typeof Relay);
openapi.post("/sponsor", Sponsor as unknown as typeof Sponsor);
openapi.get("/verify/:receiptId", Verify as unknown as typeof Verify);
openapi.post("/access", Access as unknown as typeof Access);
openapi.post("/keys/provision", Provision as unknown as typeof Provision);
openapi.post("/keys/provision-stx", ProvisionStx as unknown as typeof ProvisionStx);
openapi.get("/fees", Fees as unknown as typeof Fees);
openapi.post("/fees/config", FeesConfig as unknown as typeof FeesConfig);
openapi.get("/stats", DashboardStats as unknown as typeof DashboardStats);

// Mount dashboard routes (HTML pages, not OpenAPI)
app.route("/dashboard", dashboard);

// Mount AX discovery routes (plaintext/JSON for AI agents)
// Registers: /llms.txt, /llms-full.txt, /docs, /docs/:topic, /.well-known/agent.json
app.route("/", discovery);

// Root endpoint - service info
app.get("/", (c) => {
  return c.json({
    service: "x402-sponsor-relay",
    version: VERSION,
    description:
      "Gasless transactions for AI agents on the Stacks blockchain",
    docs: "/api-docs",
    openapi: "/openapi.json",
    agentDiscovery: "/llms.txt",
    dashboard: "/dashboard",
    endpoints: {
      relay: "POST /relay - Submit sponsored transaction for settlement (x402)",
      sponsor: "POST /sponsor - Sponsor and broadcast transaction (direct, requires API key)",
      verify: "GET /verify/:receiptId - Verify a payment receipt",
      access: "POST /access - Access protected resource with receipt",
      provision: "POST /keys/provision - Provision API key via Bitcoin signature",
      provisionStx: "POST /keys/provision-stx - Provision API key via Stacks signature",
      fees: "GET /fees - Get clamped fee estimates",
      feesConfig: "POST /fees/config - Update fee clamps (admin, requires API key)",
      health: "GET /health - Health check with network info",
      stats: "GET /stats - Relay statistics (JSON)",
      dashboard: "GET /dashboard - Public dashboard (HTML)",
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
  const requestId = c.get("requestId") || "unknown";
  if (logger) {
    logger.error("Unhandled error", {
      error: err.message,
      stack: err.stack,
    });
  }
  return c.json(
    {
      success: false,
      requestId,
      error: "Internal server error",
      code: "INTERNAL_ERROR",
      details: err.message,
      retryable: true,
    },
    500
  );
});

// 404 handler
app.notFound((c) => {
  const requestId = c.get("requestId") || "unknown";
  return c.json(
    {
      success: false,
      requestId,
      error: "Not found",
      code: "NOT_FOUND",
      details: `Route ${c.req.method} ${c.req.path} not found`,
      retryable: false,
    },
    404
  );
});

export default app;
