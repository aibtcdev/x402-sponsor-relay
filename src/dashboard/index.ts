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
  const statsService = new StatsService(c.env.RELAY_KV, logger);
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
            error: e instanceof Error ? e.message : "Unknown error",
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
  const statsService = new StatsService(c.env.RELAY_KV, logger);
  const healthService = new SettlementHealthService(c.env, logger);

  const period = c.req.query("period") === "7d" ? "7d" : "24h";

  try {
    // 7d only needs chart data — skip getOverview() (26 reads) and getStatus() (2 reads)
    if (period === "7d") {
      const dailyChartData = await statsService.getDailyChartData(7);
      return c.json(
        { hourlyData: dailyChartData, period: "7d" as const },
        200,
        { "Cache-Control": "public, max-age=60" }
      );
    }

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
