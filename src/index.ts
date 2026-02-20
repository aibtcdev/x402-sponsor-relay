import { Hono } from "hono";
import { cors } from "hono/cors";
import { fromHono } from "chanfana";
import type { Env, AppVariables, Logger } from "./types";
import { loggerMiddleware, authMiddleware, requireAuthMiddleware } from "./middleware";
import { Health, Relay, Sponsor, DashboardStats, TransactionLog, Verify, Access, Provision, ProvisionStx, Fees, FeesConfig, NonceStatsEndpoint, NonceReset, Settle, VerifyV2, Supported, Wallets } from "./endpoints";
import { dashboard } from "./dashboard";
import { discovery } from "./routes/discovery";
import { VERSION } from "./version";
import { SettlementHealthService } from "./services";
export { NonceDO } from "./durable-objects/nonce-do";
export { StatsDO } from "./durable-objects/stats-do";

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
app.use("/nonce/reset", authMiddleware);
app.use("/nonce/reset", requireAuthMiddleware);

// Initialize Chanfana for OpenAPI documentation
const openapi = fromHono(app, {
  docs_url: "/docs",
  openapi_url: "/openapi.json",
  schema: {
    info: {
      title: "x402 Stacks Sponsor Relay",
      version: VERSION,
      description:
        "A Cloudflare Worker enabling gasless transactions for AI agents on the Stacks blockchain. Accepts pre-signed sponsored transactions, sponsors them, and performs native settlement verification directly.",
    },
    tags: [
      { name: "Health", description: "Service health endpoints" },
      { name: "Relay", description: "Transaction relay endpoints (native settlement)" },
      { name: "Sponsor", description: "Transaction sponsor endpoints (direct broadcast)" },
      { name: "Verify", description: "Payment receipt verification" },
      { name: "Access", description: "Protected resource access" },
      { name: "Provision", description: "API key provisioning via Bitcoin signature" },
      { name: "Fees", description: "Fee estimation endpoints" },
      { name: "Dashboard", description: "Public statistics endpoints" },
      { name: "Nonce", description: "Nonce coordinator diagnostics" },
      { name: "x402 V2", description: "x402 V2 facilitator API (spec-compliant)" },
      { name: "Wallets", description: "Sponsor wallet monitoring (balance, fees, pool state)" },
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
    // Security scheme — spread as Record<string, unknown> since Chanfana
    // doesn't type the components property
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

// Register endpoints with Chanfana (casts needed for extended endpoint classes)
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
openapi.get("/stats/transactions", TransactionLog as unknown as typeof TransactionLog);
openapi.get("/nonce/stats", NonceStatsEndpoint as unknown as typeof NonceStatsEndpoint);
openapi.post("/nonce/reset", NonceReset as unknown as typeof NonceReset);
openapi.post("/settle", Settle as unknown as typeof Settle);
// Note: POST /verify (V2 facilitator) and GET /verify/:receiptId (receipt check)
// share the /verify path but use different HTTP methods — no route collision.
openapi.post("/verify", VerifyV2 as unknown as typeof VerifyV2);
openapi.get("/supported", Supported as unknown as typeof Supported);
openapi.get("/wallets", Wallets as unknown as typeof Wallets);

// --------------------------------------------------------------------------
// Admin: one-time KV → StatsDO backfill (remove after migration)
// --------------------------------------------------------------------------
app.use("/admin/backfill", authMiddleware);
app.use("/admin/backfill", requireAuthMiddleware);

/**
 * Old KV shapes (removed from types.ts during StatsDO migration)
 */
interface OldHourlyStats {
  hour: string;
  transactions: number;
  success: number;
  failed: number;
  tokens: { STX: number; sBTC: number; USDCx: number };
  fees?: string;
}

interface OldDailyStats {
  date: string;
  transactions: { total: number; success: number; failed: number };
  tokens: {
    STX: { count: number; volume: string };
    sBTC: { count: number; volume: string };
    USDCx: { count: number; volume: string };
  };
  errors: {
    validation: number;
    rateLimit: number;
    sponsoring: number;
    settlement: number;
    internal: number;
  };
  fees?: { total: string; count: number; min: string; max: string };
}

interface OldTxLogEntry {
  timestamp: string;
  endpoint: string;
  success: boolean;
  tokenType: string;
  amount: string;
  fee?: string;
  txid?: string;
  sender?: string;
  recipient?: string;
  status?: string;
  blockHeight?: number;
}

/** List all KV keys with a given prefix (handles pagination) */
async function listAllKvKeys(kv: KVNamespace, prefix: string) {
  const keys: string[] = [];
  let cursor: string | undefined;
  let done = false;
  while (!done) {
    const result = await kv.list({ prefix, cursor });
    keys.push(...result.keys.map((k) => k.name));
    if (result.list_complete) {
      done = true;
    } else {
      cursor = result.cursor;
    }
  }
  return keys;
}

app.post("/admin/backfill", async (c) => {
  const logger = c.get("logger");
  const kv = c.env.RELAY_KV;
  const statsDo = c.env.STATS_DO;

  if (!kv) return c.json({ error: "RELAY_KV not available" }, 500);
  if (!statsDo) return c.json({ error: "STATS_DO not available" }, 500);

  logger.info("Starting KV → StatsDO backfill");

  // 1. Read daily stats from KV
  const dailyKeys = await listAllKvKeys(kv, "stats:daily:");
  const daily: Array<Record<string, unknown>> = [];
  for (const key of dailyKeys) {
    const data = await kv.get<OldDailyStats>(key, "json");
    if (!data) continue;
    daily.push({
      date: data.date,
      total: data.transactions.total,
      success: data.transactions.success,
      failed: data.transactions.failed,
      stx_count: data.tokens.STX.count,
      stx_volume: data.tokens.STX.volume,
      sbtc_count: data.tokens.sBTC.count,
      sbtc_volume: data.tokens.sBTC.volume,
      usdcx_count: data.tokens.USDCx.count,
      usdcx_volume: data.tokens.USDCx.volume,
      fee_total: data.fees?.total ?? "0",
      fee_count: data.fees?.count ?? 0,
      fee_min: data.fees?.min ?? null,
      fee_max: data.fees?.max ?? null,
      err_validation: data.errors.validation,
      err_rate_limit: data.errors.rateLimit,
      err_sponsoring: data.errors.sponsoring,
      err_settlement: data.errors.settlement,
      err_internal: data.errors.internal,
    });
  }

  // 2. Read hourly stats from KV
  const hourlyKeys = await listAllKvKeys(kv, "stats:hourly:");
  const hourly: Array<Record<string, unknown>> = [];
  for (const key of hourlyKeys) {
    const data = await kv.get<OldHourlyStats>(key, "json");
    if (!data) continue;
    hourly.push({
      hour: data.hour,
      total: data.transactions,
      success: data.success,
      failed: data.failed,
      stx_count: data.tokens.STX,
      sbtc_count: data.tokens.sBTC,
      usdcx_count: data.tokens.USDCx,
      fee_total: data.fees ?? "0",
    });
  }

  // 3. Read transaction log entries from KV
  const txLogKeys = await listAllKvKeys(kv, "tx:log:");
  const txLog: Array<Record<string, unknown>> = [];
  for (const key of txLogKeys) {
    const entries = await kv.get<OldTxLogEntry[]>(key, "json");
    if (!entries) continue;
    for (const e of entries) {
      txLog.push({
        endpoint: e.endpoint,
        timestamp: new Date(e.timestamp).getTime(),
        success: e.success ? 1 : 0,
        token: e.tokenType,
        amount: e.amount || "0",
        fee: e.fee ?? null,
        txid: e.txid ?? null,
        sender: e.sender ?? null,
        recipient: e.recipient ?? null,
        status: e.status ?? null,
        block_height: e.blockHeight ?? null,
      });
    }
  }

  logger.info("KV data read complete", {
    dailyKeys: dailyKeys.length,
    hourlyKeys: hourlyKeys.length,
    txLogKeys: txLogKeys.length,
    txLogEntries: txLog.length,
  });

  // 4. Send to StatsDO /backfill
  const stub = statsDo.get(statsDo.idFromName("global"));
  const resp = await stub.fetch(
    new Request("http://do/backfill", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ daily, hourly, txLog }),
    })
  );

  const result = await resp.json();
  logger.info("Backfill complete", result as Record<string, unknown>);

  return c.json({
    success: true,
    kvKeysRead: {
      daily: dailyKeys.length,
      hourly: hourlyKeys.length,
      txLog: txLogKeys.length,
      txLogEntries: txLog.length,
    },
    imported: result,
  });
});

// Mount dashboard routes (HTML pages, not OpenAPI)
app.route("/dashboard", dashboard);

// Mount AX discovery routes (plaintext/JSON for AI agents)
// Registers: /llms.txt, /llms-full.txt, /topics, /topics/:topic, /.well-known/agent.json
app.route("/", discovery);

// Root endpoint - service info
app.get("/", (c) => {
  return c.json({
    service: "x402-sponsor-relay",
    version: VERSION,
    description:
      "Gasless transactions for AI agents on the Stacks blockchain",
    docs: "/docs",
    openapi: "/openapi.json",
    agentDiscovery: "/llms.txt",
    dashboard: "/dashboard",
    endpoints: {
      relay: "POST /relay - Submit sponsored transaction for native settlement",
      sponsor: "POST /sponsor - Sponsor and broadcast transaction (direct, requires API key)",
      verify: "GET /verify/:receiptId - Verify a payment receipt",
      access: "POST /access - Access protected resource with receipt",
      provision: "POST /keys/provision - Provision API key via Bitcoin signature",
      provisionStx: "POST /keys/provision-stx - Provision API key via Stacks signature",
      fees: "GET /fees - Get clamped fee estimates",
      feesConfig: "POST /fees/config - Update fee clamps (admin, requires API key)",
      health: "GET /health - Health check with network info",
      stats: "GET /stats - Relay statistics (JSON)",
      transactionLog: "GET /stats/transactions - Recent individual transactions",
      nonceStats: "GET /nonce/stats - Nonce coordinator stats",
      nonceReset: "POST /nonce/reset - Trigger on-demand nonce recovery (admin, requires API key)",
      dashboard: "GET /dashboard - Public dashboard (HTML)",
      wallets: "GET /wallets - Sponsor wallet status (balance, fees, pool)",
      settle: "POST /settle - x402 V2 facilitator settle",
      verifyV2: "POST /verify - x402 V2 facilitator verify",
      supported: "GET /supported - x402 V2 supported payment kinds",
    },
    payment: {
      tokens: ["STX", "sBTC", "USDCx"],
      flow: "Agent signs sponsored tx -> POST /relay sponsors + settles natively",
    },
    related: {
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

/** Minimal no-op logger for use outside of HTTP request context (e.g., cron) */
function createNoOpLogger(): Logger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
}

export default {
  fetch: app.fetch.bind(app),

  /**
   * Scheduled handler — runs on the cron trigger defined in wrangler.jsonc.
   * Executes a settlement health check every 5 minutes to populate KV history
   * so that the dashboard uptime24h metric is accurate.
   */
  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    const logger = createNoOpLogger();
    const healthService = new SettlementHealthService(env, logger);
    ctx.waitUntil(healthService.checkHealth());
  },
};
