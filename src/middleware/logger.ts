import type { Context, Next } from "hono";
import type { Env, AppVariables } from "../types";
import { createWorkerLogger } from "../utils";

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

  // Use RPC logger if LOGS binding is available and valid, else console fallback
  const logger = createWorkerLogger(c.env.LOGS, c.executionCtx, baseContext);

  c.set("requestId", requestId);
  c.set("logger", logger);

  return next();
}
