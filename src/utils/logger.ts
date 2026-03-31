import type { Logger, LogsRPC } from "../types";

const APP_ID = "x402-relay";

type WaitUntilLike = Pick<ExecutionContext, "waitUntil">;

/**
 * Type guard to check if LOGS binding has required RPC methods.
 */
export function isLogsRPC(logs: unknown): logs is LogsRPC {
  return (
    typeof logs === "object" &&
    logs !== null &&
    typeof (logs as LogsRPC).info === "function" &&
    typeof (logs as LogsRPC).warn === "function" &&
    typeof (logs as LogsRPC).error === "function" &&
    typeof (logs as LogsRPC).debug === "function"
  );
}

function createRpcLogger(
  logs: LogsRPC,
  ctx: WaitUntilLike,
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

export function createWorkerLogger(
  logs: unknown,
  ctx: WaitUntilLike | undefined,
  baseContext: Record<string, unknown>
): Logger {
  if (ctx && isLogsRPC(logs)) {
    return createRpcLogger(logs, ctx, baseContext);
  }

  return createConsoleLogger(baseContext);
}
