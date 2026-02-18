import { Hono } from "hono";
import type { Env, AppVariables, DashboardOverview } from "../types";
import { StatsService, HealthMonitor } from "../services";
import { overviewPage, emptyStatePage } from "./pages/overview";

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
  const healthMonitor = new HealthMonitor(c.env.RELAY_KV, logger);

  try {
    // Get stats and health data in parallel
    const [overview, health] = await Promise.all([
      statsService.getOverview(),
      healthMonitor.getStatus(),
    ]);

    // Merge health data into overview
    const dashboardData: DashboardOverview = {
      ...overview,
      settlement: {
        status: health.status,
        avgLatencyMs: health.avgLatencyMs,
        uptime24h: health.uptime24h,
        lastCheck: health.lastCheck?.timestamp || null,
      },
    };

    const network = c.env.STACKS_NETWORK;

    // Check if we have any data
    const hasData =
      dashboardData.transactions.total > 0 || health.recentChecks.length > 0;

    if (!hasData) {
      return c.html(emptyStatePage(network));
    }

    return c.html(overviewPage(dashboardData, network));
  } catch (e) {
    logger?.error("Failed to render dashboard", {
      error: e instanceof Error ? e.message : "Unknown error",
    });
    return c.html(emptyStatePage(c.env.STACKS_NETWORK));
  }
});

/**
 * GET /dashboard/api/stats - Stats JSON for AJAX refresh
 */
dashboard.get("/api/stats", async (c) => {
  const logger = c.get("logger");
  const statsService = new StatsService(c.env.RELAY_KV, logger);
  const healthMonitor = new HealthMonitor(c.env.RELAY_KV, logger);

  try {
    const [overview, health] = await Promise.all([
      statsService.getOverview(),
      healthMonitor.getStatus(),
    ]);

    const dashboardData: DashboardOverview = {
      ...overview,
      settlement: {
        status: health.status,
        avgLatencyMs: health.avgLatencyMs,
        uptime24h: health.uptime24h,
        lastCheck: health.lastCheck?.timestamp || null,
      },
    };

    return c.json(dashboardData);
  } catch (e) {
    logger?.error("Failed to get stats", {
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
  const healthMonitor = new HealthMonitor(c.env.RELAY_KV, logger);

  try {
    const health = await healthMonitor.getStatus();
    return c.json(health);
  } catch (e) {
    logger?.error("Failed to get health", {
      error: e instanceof Error ? e.message : "Unknown error",
    });
    return c.json({ error: "Failed to retrieve health status" }, 500);
  }
});
