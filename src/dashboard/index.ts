import { Hono } from "hono";
import type { Env, AppVariables } from "../types";
import { StatsService, SettlementHealthService } from "../services";
import { overviewPage, emptyStatePage } from "./pages/overview";
import { buildDashboardData } from "./helpers";

/**
 * Dashboard router - public stats display
 */
export const dashboard = new Hono<{
  Bindings: Env;
  Variables: AppVariables;
}>();

/**
 * GET /dashboard - Main overview page (HTML)
 */
dashboard.get("/", async (c) => {
  const logger = c.get("logger");
  const statsService = new StatsService(c.env, logger);
  const healthService = new SettlementHealthService(c.env, logger);

  try {
    const [overview, health] = await Promise.all([
      statsService.getOverview(),
      healthService.getStatus(),
    ]);

    // Populate health KV in the background when no cached data exists
    if (health.status === "unknown") {
      c.executionCtx.waitUntil(
        healthService.checkHealth().catch((e) => {
          logger.warn("Background health check failed", {
            error: e instanceof Error ? e.message : String(e),
          });
        })
      );
    }

    const dashboardData = buildDashboardData(overview, health);
    const network = c.env.STACKS_NETWORK;

    const hasData =
      dashboardData.transactions.total > 0 || health.recentChecks.length > 0;

    if (!hasData) {
      return c.html(emptyStatePage(network));
    }

    return c.html(overviewPage(dashboardData, network), 200, {
      "Cache-Control": "public, max-age=30",
    });
  } catch (e) {
    logger.error("Failed to render dashboard", {
      error: e instanceof Error ? e.message : "Unknown error",
    });
    return c.html(emptyStatePage(c.env.STACKS_NETWORK));
  }
});

/**
 * GET /dashboard/api/stats - Stats JSON for AJAX refresh
 * Accepts optional ?period=7d query param for 7-day daily view (default: 24h hourly)
 */
dashboard.get("/api/stats", async (c) => {
  const logger = c.get("logger");
  const statsService = new StatsService(c.env, logger);

  const period = c.req.query("period") === "7d" ? "7d" : "24h";

  try {
    // 7d only needs chart data — skip getOverview() and getStatus()
    if (period === "7d") {
      const dailyChartData = await statsService.getDailyChartData(7);
      return c.json(
        { hourlyData: dailyChartData, period: "7d" as const },
        200,
        { "Cache-Control": "public, max-age=60" }
      );
    }

    const healthService = new SettlementHealthService(c.env, logger);
    const [overview, health] = await Promise.all([
      statsService.getOverview(),
      healthService.getStatus(),
    ]);

    const dashboardData = buildDashboardData(overview, health);

    return c.json(dashboardData, 200, {
      "Cache-Control": "public, max-age=15",
    });
  } catch (e) {
    logger.error("Failed to get stats", {
      error: e instanceof Error ? e.message : "Unknown error",
    });
    return c.json({ error: "Failed to retrieve stats" }, 500);
  }
});

/**
 * GET /dashboard/api/nonce - Nonce pool state in dashboard-friendly shape.
 * Stable API contract so the dashboard doesn't depend on /nonce/state's raw internal shape.
 */
dashboard.get("/api/nonce", async (c) => {
  const logger = c.get("logger");

  // Graceful degraded response when NONCE_DO is unavailable
  const unavailable = {
    totalCapacity: 0,
    usedCapacity: 0,
    healthStatus: "unavailable" as const,
    recommendation: null,
    healInProgress: false,
    wallets: [] as Array<{
      index: number;
      health: "healthy" | "degraded" | "down";
      available: number;
      reserved: number;
      gaps: number[];
    }>,
  };

  if (!c.env.NONCE_DO) {
    return c.json(unavailable, 200);
  }

  try {
    const stub = c.env.NONCE_DO.get(c.env.NONCE_DO.idFromName("sponsor"));
    const response = await stub.fetch("https://nonce-do/nonce-state");

    if (!response.ok) {
      logger.warn("Nonce DO nonce-state request failed for dashboard", {
        status: response.status,
      });
      return c.json(unavailable, 200);
    }

    const raw = (await response.json()) as {
      wallets: Array<{
        walletIndex: number;
        available: number;
        reserved: number;
        gaps: number[];
        healthy: boolean;
        circuitBreakerOpen: boolean;
      }>;
      healthy: boolean;
      healInProgress: boolean;
      totalAvailable: number;
      totalReserved: number;
      totalCapacity: number;
      recommendation: string | null;
    };

    // Map per-wallet health to a simple three-state enum
    const wallets = (raw.wallets ?? []).map((w) => {
      let health: "healthy" | "degraded" | "down";
      if (!w.healthy || (w.gaps && w.gaps.length > 0)) {
        health = "down";
      } else if (w.circuitBreakerOpen) {
        health = "degraded";
      } else {
        health = "healthy";
      }
      return {
        index: w.walletIndex,
        health,
        available: w.available,
        reserved: w.reserved,
        gaps: w.gaps ?? [],
      };
    });

    // Derive top-level health status
    let healthStatus: "healthy" | "degraded" | "unavailable";
    if (raw.healthy === true && !raw.recommendation) {
      healthStatus = "healthy";
    } else {
      healthStatus = "degraded";
    }

    const result = {
      totalCapacity: raw.totalCapacity ?? 0,
      usedCapacity: raw.totalReserved ?? 0,
      healthStatus,
      recommendation: raw.recommendation ?? null,
      healInProgress: raw.healInProgress ?? false,
      wallets,
    };

    return c.json(result, 200, {
      "Cache-Control": "public, max-age=10",
    });
  } catch (e) {
    logger.error("Failed to get nonce state for dashboard", {
      error: e instanceof Error ? e.message : "Unknown error",
    });
    return c.json(unavailable, 200);
  }
});

/**
 * GET /dashboard/api/health - Settlement health JSON
 */
dashboard.get("/api/health", async (c) => {
  const logger = c.get("logger");
  const healthService = new SettlementHealthService(c.env, logger);

  try {
    const health = await healthService.getStatus();
    return c.json(health, 200, {
      "Cache-Control": "public, max-age=15",
    });
  } catch (e) {
    logger.error("Failed to get health", {
      error: e instanceof Error ? e.message : "Unknown error",
    });
    return c.json({ error: "Failed to retrieve health status" }, 500);
  }
});
