import type { Context } from "hono";

/**
 * LogsRPC interface (from worker-logs service)
 * Defined locally since worker-logs isn't a published package
 */
export interface LogsRPC {
  info(
    appId: string,
    message: string,
    context?: Record<string, unknown>
  ): Promise<void>;
  warn(
    appId: string,
    message: string,
    context?: Record<string, unknown>
  ): Promise<void>;
  error(
    appId: string,
    message: string,
    context?: Record<string, unknown>
  ): Promise<void>;
  debug(
    appId: string,
    message: string,
    context?: Record<string, unknown>
  ): Promise<void>;
}

/**
 * Logger interface for request-scoped logging
 */
export interface Logger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  debug(message: string, context?: Record<string, unknown>): void;
}

/**
 * Environment bindings for Cloudflare Worker
 */
export interface Env {
  /** 24-word mnemonic phrase for sponsor wallet (preferred) */
  SPONSOR_MNEMONIC?: string;
  /** Account index to derive from mnemonic (default: 0) */
  SPONSOR_ACCOUNT_INDEX?: string;
  /** Hex-encoded private key (fallback if no mnemonic) */
  SPONSOR_PRIVATE_KEY?: string;
  STACKS_NETWORK: "mainnet" | "testnet";
  FACILITATOR_URL: string;
  // LOGS is a service binding to worker-logs, typed loosely to avoid complex Service<> generics
  LOGS?: unknown;
  // KV namespace for dashboard stats storage
  RELAY_KV?: KVNamespace;
}

/**
 * Token types supported by the relay
 */
export type TokenType = "STX" | "sBTC" | "USDCx";

/**
 * Token types as expected by the facilitator API
 */
export type FacilitatorTokenType = "STX" | "SBTC" | "USDCX";

/**
 * Settlement options for x402 payment verification
 */
export interface SettleOptions {
  /** Expected recipient address */
  expectedRecipient: string;
  /** Minimum amount required (in smallest unit - microSTX, sats, etc.) */
  minAmount: string;
  /** Token type (defaults to STX) */
  tokenType?: TokenType;
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
export interface RelayRequest {
  /** Hex-encoded signed sponsored transaction */
  transaction: string;
  /** Settlement options for x402 payment verification */
  settle: SettleOptions;
}

/**
 * Facilitator settle request format
 */
export interface FacilitatorSettleRequest {
  signed_transaction: string;
  expected_recipient: string;
  min_amount: number;
  network: string;
  token_type: FacilitatorTokenType;
  expected_sender?: string;
  resource?: string;
  method?: string;
}

/**
 * Facilitator settle response format
 */
export interface FacilitatorSettleResponse {
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
 * Settlement result in API response format
 */
export interface SettlementResult {
  success: boolean;
  status: string;
  sender?: string;
  recipient?: string;
  amount?: string;
  blockHeight?: number;
}

/**
 * Response from /relay endpoint
 */
export interface RelayResponse {
  /** Transaction ID if successful */
  txid?: string;
  /** Settlement status */
  settlement?: SettlementResult;
  /** Error message if failed */
  error?: string;
  /** Additional details */
  details?: string;
  /** Whether the client can retry the request */
  retryable?: boolean;
}

/**
 * Error codes for structured error responses
 */
export type RelayErrorCode =
  | "MISSING_TRANSACTION"
  | "MISSING_SETTLE_OPTIONS"
  | "INVALID_SETTLE_OPTIONS"
  | "INVALID_TRANSACTION"
  | "NOT_SPONSORED"
  | "RATE_LIMIT_EXCEEDED"
  | "SPONSOR_CONFIG_ERROR"
  | "SPONSOR_FAILED"
  | "FACILITATOR_TIMEOUT"
  | "FACILITATOR_ERROR"
  | "FACILITATOR_INVALID_RESPONSE"
  | "SETTLEMENT_FAILED"
  | "INTERNAL_ERROR";

/**
 * Structured error response with retry guidance
 */
export interface RelayErrorResponse {
  error: string;
  code: RelayErrorCode;
  details?: string;
  retryable: boolean;
  retryAfter?: number; // seconds
}

/**
 * Variables stored in Hono context by middleware
 */
export interface AppVariables {
  requestId: string;
  logger: Logger;
}

/**
 * Typed Hono context for this application
 */
export type AppContext = Context<{ Bindings: Env; Variables: AppVariables }>;

// =============================================================================
// Dashboard Types
// =============================================================================

/**
 * Token stats for dashboard display
 */
export interface TokenStats {
  count: number;
  volume: string;
  percentage: number;
}

/**
 * Fee statistics for tracking sponsor costs
 */
export interface FeeStats {
  /** Total fees paid in microSTX */
  total: string;
  /** Number of transactions with fee data */
  count: number;
  /** Minimum fee paid */
  min: string;
  /** Maximum fee paid */
  max: string;
}

/**
 * Daily statistics stored in KV
 */
export interface DailyStats {
  date: string;
  transactions: {
    total: number;
    success: number;
    failed: number;
  };
  tokens: {
    STX: { count: number; volume: string };
    sBTC: { count: number; volume: string };
    USDCx: { count: number; volume: string };
  };
  errors: {
    validation: number;
    rateLimit: number;
    sponsoring: number;
    facilitator: number;
    internal: number;
  };
  /** Fee statistics for the day */
  fees?: FeeStats;
}

/**
 * Hourly stats for granular 24h view
 */
export interface HourlyStats {
  hour: string;
  transactions: number;
  success: number;
  failed: number;
  tokens: {
    STX: number;
    sBTC: number;
    USDCx: number;
  };
  /** Total fees paid this hour in microSTX */
  fees?: string;
}

/**
 * Facilitator health check record
 */
export interface FacilitatorHealthCheck {
  timestamp: string;
  status: "healthy" | "degraded" | "down";
  latencyMs: number;
  httpStatus: number;
  error?: string;
}

/**
 * Dashboard overview data for API response
 */
export interface DashboardOverview {
  period: "24h" | "7d";
  transactions: {
    total: number;
    success: number;
    failed: number;
    trend: "up" | "down" | "stable";
    previousTotal: number;
  };
  tokens: {
    STX: TokenStats;
    sBTC: TokenStats;
    USDCx: TokenStats;
  };
  fees: {
    /** Total fees paid today in microSTX */
    total: string;
    /** Average fee per transaction in microSTX */
    average: string;
    /** Minimum fee paid today */
    min: string;
    /** Maximum fee paid today */
    max: string;
    /** Fee trend vs previous day */
    trend: "up" | "down" | "stable";
    /** Total fees paid previous day */
    previousTotal: string;
  };
  facilitator: {
    status: "healthy" | "degraded" | "down" | "unknown";
    avgLatencyMs: number;
    uptime24h: number;
    lastCheck: string | null;
  };
  hourlyData: Array<{ hour: string; transactions: number; success: number; fees?: string }>;
}

/**
 * Error categories for metrics tracking
 */
export type ErrorCategory =
  | "validation"
  | "rateLimit"
  | "sponsoring"
  | "facilitator"
  | "internal";
