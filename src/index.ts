import {
  sponsorTransaction,
  deserializeTransaction,
  AuthType,
} from "@stacks/transactions";
import { STACKS_MAINNET, STACKS_TESTNET } from "@stacks/network";

// Augment Env with secrets and config
declare global {
  interface Env {
    SPONSOR_PRIVATE_KEY: string;
    STACKS_NETWORK: string;
    FACILITATOR_URL: string;
  }
}

/**
 * LogsRPC interface (from worker-logs service)
 * Defined locally since worker-logs isn't a published package
 */
interface LogsRPC {
  info(appId: string, message: string, context?: Record<string, unknown>): Promise<void>;
  warn(appId: string, message: string, context?: Record<string, unknown>): Promise<void>;
  error(appId: string, message: string, context?: Record<string, unknown>): Promise<void>;
  debug(appId: string, message: string, context?: Record<string, unknown>): Promise<void>;
}

/**
 * Settlement options for x402 payment verification
 */
interface SettleOptions {
  /** Expected recipient address */
  expectedRecipient: string;
  /** Minimum amount required (in smallest unit - microSTX, sats, etc.) */
  minAmount: string;
  /** Token type (defaults to STX) */
  tokenType?: "STX" | "sBTC" | "USDCx";
  /** Expected sender address (optional) */
  expectedSender?: string;
  /** API resource being accessed (optional, for tracking) */
  resource?: string;
  /** HTTP method being used (optional, for tracking) */
  method?: string;
}

/**
 * Request body for /relay endpoint
 */
interface RelayRequest {
  /** Hex-encoded signed sponsored transaction */
  transaction: string;
  /** Settlement options for x402 payment verification */
  settle: SettleOptions;
}

/**
 * Facilitator settle request format
 */
interface FacilitatorSettleRequest {
  signed_transaction: string;
  expected_recipient: string;
  min_amount: number;
  network: string;
  token_type: "STX" | "SBTC" | "USDCX";
  expected_sender?: string;
  resource?: string;
  method?: string;
}

/**
 * Facilitator settle response format
 */
interface FacilitatorSettleResponse {
  success: boolean;
  tx_id?: string;
  status?: "pending" | "confirmed" | "failed";
  sender_address?: string;
  recipient_address?: string;
  amount?: number;
  block_height?: number;
  error?: string;
  validation_errors?: string[];
}

/**
 * Response from /relay endpoint
 */
interface RelayResponse {
  /** Transaction ID if successful */
  txid?: string;
  /** Settlement status */
  settlement?: {
    success: boolean;
    status: string;
    sender?: string;
    recipient?: string;
    amount?: string;
    blockHeight?: number;
  };
  /** Error message if failed */
  error?: string;
  /** Additional details */
  details?: string;
}

const APP_ID = "x402-relay";

/**
 * Get network instance from env
 */
function getNetwork(env: Env) {
  return env.STACKS_NETWORK === "mainnet" ? STACKS_MAINNET : STACKS_TESTNET;
}

/**
 * Simple rate limiting using in-memory map
 * In production, use Durable Objects or KV for distributed rate limiting
 */
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 10; // requests per window
const RATE_WINDOW_MS = 60 * 1000; // 1 minute

function checkRateLimit(address: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(address);

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(address, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }

  if (entry.count >= RATE_LIMIT) {
    return false;
  }

  entry.count++;
  return true;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const requestId = crypto.randomUUID();
    const logs = env.LOGS as unknown as LogsRPC;

    // CORS headers for all responses
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // Health check endpoint
    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          status: "ok",
          network: env.STACKS_NETWORK,
          version: "0.1.0",
        }),
        {
          headers: { "Content-Type": "application/json", ...corsHeaders },
        }
      );
    }

    // Sponsor relay endpoint
    if (url.pathname === "/relay" && request.method === "POST") {
      ctx.waitUntil(
        logs.info(APP_ID, "Relay request received", {
          request_id: requestId,
        })
      );

      try {
        // Parse request body
        const body = (await request.json()) as RelayRequest;

        if (!body.transaction) {
          return new Response(
            JSON.stringify({ error: "Missing transaction field" } as RelayResponse),
            { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
          );
        }

        if (!body.settle) {
          return new Response(
            JSON.stringify({ error: "Missing settle options" } as RelayResponse),
            { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
          );
        }

        if (!body.settle.expectedRecipient || !body.settle.minAmount) {
          return new Response(
            JSON.stringify({
              error: "Invalid settle options",
              details: "expectedRecipient and minAmount are required",
            } as RelayResponse),
            { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
          );
        }

        // Remove 0x prefix if present
        const txHex = body.transaction.startsWith("0x")
          ? body.transaction.slice(2)
          : body.transaction;

        // Deserialize the transaction
        let transaction;
        try {
          transaction = deserializeTransaction(txHex);
        } catch (e) {
          ctx.waitUntil(
            logs.warn(APP_ID, "Failed to deserialize transaction", {
              request_id: requestId,
              error: e instanceof Error ? e.message : "Unknown error",
            })
          );
          return new Response(
            JSON.stringify({
              error: "Invalid transaction",
              details: "Could not deserialize transaction hex",
            } as RelayResponse),
            { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
          );
        }

        // Verify it's a sponsored transaction
        if (transaction.auth.authType !== AuthType.Sponsored) {
          ctx.waitUntil(
            logs.warn(APP_ID, "Transaction not sponsored", {
              request_id: requestId,
              auth_type: transaction.auth.authType,
            })
          );
          return new Response(
            JSON.stringify({
              error: "Transaction must be sponsored",
              details: "Build transaction with sponsored: true",
            } as RelayResponse),
            { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
          );
        }

        // Get sender address for rate limiting
        const senderAddress = transaction.auth.spendingCondition.signer;
        const senderHex = Buffer.from(senderAddress).toString("hex");

        // Check rate limit
        if (!checkRateLimit(senderHex)) {
          ctx.waitUntil(
            logs.warn(APP_ID, "Rate limit exceeded", {
              request_id: requestId,
              sender: senderHex,
            })
          );
          return new Response(
            JSON.stringify({
              error: "Rate limit exceeded",
              details: `Maximum ${RATE_LIMIT} requests per minute`,
            } as RelayResponse),
            { status: 429, headers: { "Content-Type": "application/json", ...corsHeaders } }
          );
        }

        // Check for sponsor private key
        if (!env.SPONSOR_PRIVATE_KEY) {
          ctx.waitUntil(logs.error(APP_ID, "Sponsor key not configured", { request_id: requestId }));
          return new Response(
            JSON.stringify({
              error: "Service not configured",
              details: "Sponsor key missing",
            } as RelayResponse),
            { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
          );
        }

        const network = getNetwork(env);

        // Sponsor the transaction
        let sponsoredTx;
        try {
          sponsoredTx = await sponsorTransaction({
            transaction,
            sponsorPrivateKey: env.SPONSOR_PRIVATE_KEY,
            network,
          });
        } catch (e) {
          ctx.waitUntil(
            logs.error(APP_ID, "Failed to sponsor transaction", {
              request_id: requestId,
              error: e instanceof Error ? e.message : "Unknown error",
            })
          );
          return new Response(
            JSON.stringify({
              error: "Failed to sponsor transaction",
              details: e instanceof Error ? e.message : "Unknown error",
            } as RelayResponse),
            { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
          );
        }

        // Serialize sponsored transaction for facilitator
        const sponsoredTxHex = Buffer.from(sponsoredTx.serialize()).toString("hex");

        // Validate and parse minimum amount
        const rawMinAmount = body.settle.minAmount;
        if (!/^\d+$/.test(rawMinAmount)) {
          ctx.waitUntil(
            logs.warn(APP_ID, "Invalid minimum amount", {
              request_id: requestId,
              raw_min_amount: rawMinAmount,
            })
          );
          return new Response(
            JSON.stringify({
              error: "Invalid minimum amount",
              details: "settle.minAmount must be a numeric string",
            } as RelayResponse),
            { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
          );
        }
        const minAmount = parseInt(rawMinAmount, 10);

        // Validate and map token type to facilitator format
        const tokenTypeMap: Record<string, "STX" | "SBTC" | "USDCX"> = {
          STX: "STX",
          sBTC: "SBTC",
          USDCx: "USDCX",
        };
        const rawTokenType = body.settle.tokenType || "STX";
        const mappedTokenType = tokenTypeMap[rawTokenType];
        if (!mappedTokenType) {
          ctx.waitUntil(
            logs.warn(APP_ID, "Unsupported token type", {
              request_id: requestId,
              token_type: rawTokenType,
            })
          );
          return new Response(
            JSON.stringify({
              error: "Invalid token type",
              details: `Unsupported token type: ${rawTokenType}. Valid types: STX, sBTC, USDCx`,
            } as RelayResponse),
            { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
          );
        }

        // Build facilitator settle request
        const settleRequest: FacilitatorSettleRequest = {
          signed_transaction: sponsoredTxHex,
          expected_recipient: body.settle.expectedRecipient,
          min_amount: minAmount,
          network: env.STACKS_NETWORK || "testnet",
          token_type: mappedTokenType,
          expected_sender: body.settle.expectedSender,
          resource: body.settle.resource,
          method: body.settle.method,
        };

        // Call facilitator settle endpoint with timeout
        const FACILITATOR_TIMEOUT_MS = 30000; // 30 seconds
        let settleResponse: FacilitatorSettleResponse;
        try {
          ctx.waitUntil(
            logs.info(APP_ID, "Calling facilitator settle", {
              request_id: requestId,
              facilitator_url: env.FACILITATOR_URL,
              expected_recipient: settleRequest.expected_recipient,
              min_amount: settleRequest.min_amount,
            })
          );

          const response = await fetch(`${env.FACILITATOR_URL}/api/v1/settle`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(settleRequest),
            signal: AbortSignal.timeout(FACILITATOR_TIMEOUT_MS),
          });

          // Handle non-JSON responses (e.g., 502/504 gateway errors)
          const contentType = response.headers.get("content-type") || "";
          if (!contentType.includes("application/json")) {
            const text = await response.text();
            ctx.waitUntil(
              logs.error(APP_ID, "Facilitator returned non-JSON response", {
                request_id: requestId,
                status: response.status,
                content_type: contentType,
                body_preview: text.slice(0, 200),
              })
            );
            return new Response(
              JSON.stringify({
                error: "Facilitator error",
                details: `Unexpected response (${response.status}): ${text.slice(0, 100)}`,
              } as RelayResponse),
              { status: 502, headers: { "Content-Type": "application/json", ...corsHeaders } }
            );
          }

          settleResponse = (await response.json()) as FacilitatorSettleResponse;

          if (!response.ok) {
            ctx.waitUntil(
              logs.error(APP_ID, "Facilitator settle failed", {
                request_id: requestId,
                status: response.status,
                error: settleResponse.error,
                validation_errors: settleResponse.validation_errors,
              })
            );
            return new Response(
              JSON.stringify({
                error: "Settlement failed",
                details: settleResponse.validation_errors?.join(", ") || settleResponse.error || "Unknown error",
              } as RelayResponse),
              { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
            );
          }
        } catch (e) {
          const isTimeout = e instanceof Error && e.name === "TimeoutError";
          ctx.waitUntil(
            logs.error(APP_ID, isTimeout ? "Facilitator request timed out" : "Failed to call facilitator", {
              request_id: requestId,
              error: e instanceof Error ? e.message : "Unknown error",
            })
          );
          return new Response(
            JSON.stringify({
              error: isTimeout ? "Facilitator timeout" : "Failed to settle transaction",
              details: e instanceof Error ? e.message : "Unknown error",
            } as RelayResponse),
            { status: isTimeout ? 504 : 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
          );
        }

        // Validate response has txid
        const txid = settleResponse.tx_id;
        if (!txid) {
          ctx.waitUntil(
            logs.error(APP_ID, "Facilitator response missing tx_id", {
              request_id: requestId,
              settlement_status: settleResponse.status,
            })
          );
          return new Response(
            JSON.stringify({
              error: "Settlement response invalid",
              details: "Missing transaction ID in facilitator response",
            } as RelayResponse),
            { status: 502, headers: { "Content-Type": "application/json", ...corsHeaders } }
          );
        }
        ctx.waitUntil(
          logs.info(APP_ID, "Transaction sponsored and settled", {
            request_id: requestId,
            txid,
            sender: senderHex,
            settlement_status: settleResponse.status,
          })
        );

        return new Response(
          JSON.stringify({
            txid,
            settlement: {
              success: settleResponse.success,
              status: settleResponse.status || "unknown",
              sender: settleResponse.sender_address,
              recipient: settleResponse.recipient_address,
              amount: settleResponse.amount?.toString(),
              blockHeight: settleResponse.block_height,
            },
          } as RelayResponse),
          {
            status: 200,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          }
        );
      } catch (e) {
        ctx.waitUntil(
          logs.error(APP_ID, "Unexpected error", {
            request_id: requestId,
            error: e instanceof Error ? e.message : "Unknown error",
          })
        );
        return new Response(
          JSON.stringify({
            error: "Internal server error",
            details: e instanceof Error ? e.message : "Unknown error",
          } as RelayResponse),
          { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      }
    }

    // Default response
    return new Response("x402 Stacks Sponsor Relay\n\nPOST /relay - Submit sponsored transaction for settlement\nGET /health - Health check\n\nDocs: https://github.com/aibtcdev/x402-sponsor-relay", {
      headers: { "Content-Type": "text/plain", ...corsHeaders },
    });
  },
};
