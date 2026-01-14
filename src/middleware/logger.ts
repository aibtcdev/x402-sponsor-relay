import type { Context, Next } from "hono";
import type { Env, Logger, LogsRPC, AppVariables } from "../types";

const APP_ID = "x402-relay";

/**
 * Create a logger that sends to worker-logs RPC service
 */
function createRpcLogger(
  logs: LogsRPC,
  ctx: ExecutionContext,
  baseContext: Record<string, unknown>
): Logger {
  return {
    info: (message, context) => {
      ctx.waitUntil(logs.info(APP_ID, message, { ...baseContext, ...context }));
    },
    warn: (message, context) => {
      ctx.waitUntil(logs.warn(APP_ID, message, { ...baseContext, ...context }));
    },
    error: (message, context) => {
      ctx.waitUntil(
        logs.error(APP_ID, message, { ...baseContext, ...context })
      );
    },
    debug: (message, context) => {
      ctx.waitUntil(
        logs.debug(APP_ID, message, { ...baseContext, ...context })
      );
    },
  };
}

/**
 * Create a console logger fallback for local development
 */
function createConsoleLogger(baseContext: Record<string, unknown>): Logger {
  return {
    info: (message, context) => {
      console.log(`[INFO] ${message}`, { ...baseContext, ...context });
    },
    warn: (message, context) => {
      console.warn(`[WARN] ${message}`, { ...baseContext, ...context });
    },
    error: (message, context) => {
      console.error(`[ERROR] ${message}`, { ...baseContext, ...context });
    },
    debug: (message, context) => {
      console.debug(`[DEBUG] ${message}`, { ...baseContext, ...context });
    },
  };
}

/**
 * Logger middleware - creates request-scoped logger and stores in context
 */
export async function loggerMiddleware(
  c: Context<{ Bindings: Env; Variables: AppVariables }>,
  next: Next
) {
  const requestId = crypto.randomUUID();
  const baseContext = {
    request_id: requestId,
    path: c.req.path,
    method: c.req.method,
  };

  // Use RPC logger if available, else console fallback
  const logger = c.env.LOGS
    ? createRpcLogger(c.env.LOGS as LogsRPC, c.executionCtx, baseContext)
    : createConsoleLogger(baseContext);

  c.set("requestId", requestId);
  c.set("logger", logger);

  return next();
}
