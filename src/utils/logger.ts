import type { Logger, LogsRPC } from "../types";
import { shouldEmitLog } from "./log-sampling";

const APP_ID = "x402-relay";

type WaitUntilLike = Pick<ExecutionContext, "waitUntil">;
type LogLevel = keyof Logger;

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
  const enqueueLog = (
    level: LogLevel,
    message: string,
    context?: Record<string, unknown>
  ) => {
    const mergedContext = {
      ...baseContext,
      ...context,
    };
    if (!shouldEmitLog(level, message, mergedContext)) return;

    try {
      const result = logs[level](APP_ID, message, mergedContext);
      const promise = Promise.resolve(result).catch(() => {});
      try {
        ctx.waitUntil(promise);
      } catch {
        // Logging must never affect request or queue behavior.
      }
    } catch {
      // Logging must never affect request or queue behavior.
    }
  };

  return {
    info: (message, context) => {
      enqueueLog("info", message, context);
    },
    warn: (message, context) => {
      enqueueLog("warn", message, context);
    },
    error: (message, context) => {
      enqueueLog("error", message, context);
    },
    debug: (message, context) => {
      enqueueLog("debug", message, context);
    },
  };
}

function createConsoleLogger(baseContext: Record<string, unknown>): Logger {
  return {
    info: (message, context) => {
      const mergedContext = { ...baseContext, ...context };
      if (shouldEmitLog("info", message, mergedContext)) {
        console.log(`[INFO] ${message}`, mergedContext);
      }
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
