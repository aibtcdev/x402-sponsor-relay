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
  /** Optional Hiro API key for higher rate limits */
  HIRO_API_KEY?: string;
  // LOGS is a service binding to worker-logs, typed loosely to avoid complex Service<> generics
  LOGS?: unknown;
  // KV namespace for dashboard stats storage
  RELAY_KV?: KVNamespace;
  // KV namespace for API key storage
  API_KEYS_KV?: KVNamespace;
}

/**
 * Token types supported by the relay
 */
export type TokenType = "STX" | "sBTC" | "USDCx";

// =============================================================================
// API Key Types
// =============================================================================

/**
 * Rate limit tiers for API keys
 */
export type RateLimitTier = "free" | "standard" | "unlimited";

/**
 * Configuration for a rate limit tier
 */
export interface TierConfig {
  /** Maximum requests allowed per minute */
  requestsPerMinute: number;
  /** Maximum requests allowed per day */
  dailyLimit: number;
  /** Maximum sponsor fees per day in microSTX (null = unlimited) */
  dailyFeeCapMicroStx: number | null;
}

/**
 * Rate limit configuration per tier
 */
export const TIER_LIMITS: Record<RateLimitTier, TierConfig> = {
  free: { requestsPerMinute: 10, dailyLimit: 100, dailyFeeCapMicroStx: 100_000_000 }, // 100 STX/day
  standard: { requestsPerMinute: 60, dailyLimit: 10000, dailyFeeCapMicroStx: 1_000_000_000 }, // 1000 STX/day
  unlimited: { requestsPerMinute: Infinity, dailyLimit: Infinity, dailyFeeCapMicroStx: null },
};

/**
 * Metadata stored for each API key
 */
export interface ApiKeyMetadata {
  /** Unique key identifier (hash of the actual key) */
  keyId: string;
  /** Application name */
  appName: string;
  /** Contact email for the key owner */
  contactEmail: string;
  /** Rate limit tier */
  tier: RateLimitTier;
  /** When the key was created */
  createdAt: string;
  /** When the key expires (30 days from creation by default) */
  expiresAt: string;
  /** Whether the key is active (false if revoked) */
  active: boolean;
  /** Bitcoin address used to provision this key (optional, only for BTC-provisioned keys) */
  btcAddress?: string;
}

/**
 * Usage statistics for an API key (stored per day)
 */
export interface ApiKeyUsage {
  /** Date in YYYY-MM-DD format */
  date: string;
  /** Total requests made */
  requests: number;
  /** Successful requests */
  success: number;
  /** Failed requests */
  failed: number;
  /** Volume by token type */
  volume: {
    STX: string;
    sBTC: string;
    USDCx: string;
  };
  /** Total fees paid in microSTX */
  feesPaid: string;
}

/**
 * Fee statistics for an API key
 */
export interface ApiKeyFeeStats {
  /** API key ID */
  keyId: string;
  /** Daily fee cap for this key's tier in microSTX (null = unlimited) */
  dailyCap: string | null;
  /** Fees spent today in microSTX */
  todaySpent: string;
  /** Remaining spending capacity in microSTX (null = unlimited) */
  remaining: string | null;
  /** Whether the key has exceeded its spending cap */
  capExceeded: boolean;
  /** Last 7 days of fee data */
  history: Array<{ date: string; feesPaid: string }>;
}

/**
 * Result of API key validation
 */
export type ApiKeyValidationResult =
  | { valid: true; metadata: ApiKeyMetadata }
  | { valid: false; code: ApiKeyErrorCode; error: string };

/**
 * API key error codes
 */
export type ApiKeyErrorCode =
  | "MISSING_API_KEY"
  | "INVALID_API_KEY"
  | "EXPIRED_API_KEY"
  | "REVOKED_API_KEY"
  | "DAILY_LIMIT_EXCEEDED"
  | "SPENDING_CAP_EXCEEDED";

/**
 * Auth context stored in Hono variables
 */
export interface AuthContext {
  /** API key metadata if authenticated */
  metadata: ApiKeyMetadata | null;
  /** Whether auth is in grace period (no key provided but allowed) */
  gracePeriod: boolean;
}

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
 * Payment receipt stored after successful relay settlement
 * Used for verifying payments and granting access to resources
 */
export interface PaymentReceipt {
  /** Unique receipt identifier */
  receiptId: string;
  /** When the receipt was created (ISO 8601) */
  createdAt: string;
  /** When the receipt expires (ISO 8601) */
  expiresAt: string;
  /** Agent's Stacks address (from the signed transaction) */
  senderAddress: string;
  /** The fully-sponsored transaction hex */
  sponsoredTx: string;
  /** Fee paid by sponsor in microSTX */
  fee: string;
  /** Blockchain transaction ID */
  txid: string;
  /** Settlement details from facilitator */
  settlement: SettlementResult;
  /** Original settle options (resource, method, recipient, amount, tokenType) */
  settleOptions: SettleOptions;
  /** Whether this receipt has been consumed (for one-time-use access) */
  consumed: boolean;
  /** Number of times this receipt has been used for access */
  accessCount: number;
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
  | "DAILY_LIMIT_EXCEEDED"
  | "SPONSOR_CONFIG_ERROR"
  | "SPONSOR_FAILED"
  | "BROADCAST_FAILED"
  | "FACILITATOR_TIMEOUT"
  | "FACILITATOR_ERROR"
  | "FACILITATOR_INVALID_RESPONSE"
  | "SETTLEMENT_FAILED"
  | "NOT_FOUND"
  | "INTERNAL_ERROR"
  | "MISSING_API_KEY"
  | "INVALID_API_KEY"
  | "EXPIRED_API_KEY"
  | "REVOKED_API_KEY"
  | "SPENDING_CAP_EXCEEDED"
  | "MISSING_RECEIPT_ID"
  | "INVALID_RECEIPT"
  | "RECEIPT_EXPIRED"
  | "RECEIPT_CONSUMED"
  | "RESOURCE_MISMATCH"
  | "PROXY_FAILED"
  | "ALREADY_PROVISIONED"
  | "INVALID_SIGNATURE"
  | "STALE_TIMESTAMP"
  | "MISSING_BTC_ADDRESS"
  | "MISSING_SIGNATURE"
  | "INVALID_MESSAGE_FORMAT"
  | "FEE_FETCH_FAILED"
  | "FEE_RATE_LIMITED";

/**
 * Structured error response with retry guidance
 */
export interface RelayErrorResponse {
  success: false;
  error: string;
  code: RelayErrorCode;
  details?: string;
  retryable: boolean;
  retryAfter?: number; // seconds
  requestId: string;
}

/**
 * Base success response (for simple endpoints like health, stats)
 */
export interface BaseSuccessResponse {
  success: true;
  requestId: string;
}

/**
 * Success response with transaction details
 */
export interface RelaySuccessResponse extends BaseSuccessResponse {
  txid: string;
  explorerUrl: string;
  settlement?: SettlementResult;
  /** Hex-encoded fully-sponsored transaction (can be used as X-PAYMENT header value) */
  sponsoredTx?: string;
  /** Receipt token for verifying payment via GET /verify/:receiptId */
  receiptId?: string;
}

// =============================================================================
// Sponsor Endpoint Types
// =============================================================================

/**
 * Request body for /sponsor endpoint
 */
export interface SponsorRequest {
  /** Hex-encoded signed sponsored transaction */
  transaction: string;
}

/**
 * Success response for /sponsor endpoint
 */
export interface SponsorSuccessResponse extends BaseSuccessResponse {
  txid: string;
  explorerUrl: string;
  /** Fee paid by sponsor in microSTX */
  fee: string;
}

// =============================================================================
// Provision Endpoint Types
// =============================================================================

/**
 * Request body for POST /keys/provision endpoint
 */
export interface ProvisionRequest {
  /** Bitcoin address used to sign the message */
  btcAddress: string;
  /** BIP-137 signature of the message */
  signature: string;
  /** Message that was signed (for verification) */
  message: string;
}

/**
 * Success response for /keys/provision endpoint
 */
export interface ProvisionSuccessResponse extends BaseSuccessResponse {
  /** The generated API key (only shown once) */
  apiKey: string;
  /** Key metadata */
  metadata: ApiKeyMetadata;
}

// =============================================================================
// Access Endpoint Types
// =============================================================================

/**
 * Request body for /access endpoint
 */
export interface AccessRequest {
  /** Receipt ID from a successful relay transaction */
  receiptId: string;
  /** Resource path being accessed (must match receipt.settleOptions.resource) */
  resource?: string;
  /** Optional downstream service URL for proxying */
  targetUrl?: string;
}

/**
 * Success response for /access endpoint
 */
export interface AccessSuccessResponse extends BaseSuccessResponse {
  /** Whether access was granted */
  granted: boolean;
  /** Receipt information */
  receipt: {
    receiptId: string;
    senderAddress: string;
    resource?: string;
    accessCount: number;
  };
  /** Resource data (if relay-hosted) or proxy result (if proxied) */
  data?: unknown;
  /** Proxy response details (if targetUrl was provided) */
  proxy?: {
    status: number;
    statusText: string;
    headers?: Record<string, string>;
    body?: unknown;
  };
}

/**
 * Variables stored in Hono context by middleware
 */
export interface AppVariables {
  requestId: string;
  logger: Logger;
  /** Auth context from API key middleware (null during grace period or if not authenticated) */
  auth?: AuthContext;
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
  /** API key aggregate statistics (optional, only present if API_KEYS_KV is configured) */
  apiKeys?: AggregateKeyStats;
}

/**
 * Status indicator for an API key
 */
export type ApiKeyStatus = "active" | "rate_limited" | "capped";

/**
 * Entry for a single API key in the aggregate stats
 */
export interface ApiKeyStatsEntry {
  /** First 12 characters of keyId for anonymization */
  keyPrefix: string;
  /** Number of requests made today */
  requestsToday: number;
  /** Total fees sponsored today in microSTX */
  feesToday: string;
  /** Current status of the key */
  status: ApiKeyStatus;
}

/**
 * Aggregate statistics across all API keys
 */
export interface AggregateKeyStats {
  /** Total number of active API keys */
  totalActiveKeys: number;
  /** Total fees sponsored today in microSTX */
  totalFeesToday: string;
  /** Top keys by request count (max 5) */
  topKeys: ApiKeyStatsEntry[];
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

// =============================================================================
// Fee Estimation Types
// =============================================================================

/**
 * Transaction types for fee estimation
 */
export type FeeTransactionType = "token_transfer" | "contract_call" | "smart_contract";

/**
 * Priority levels for fee estimation
 */
export type FeePriority = "low_priority" | "medium_priority" | "high_priority";

/**
 * Fee tiers for a single transaction type
 */
export interface FeePriorityTiers {
  low_priority: number;
  medium_priority: number;
  high_priority: number;
}

/**
 * Fee estimates for all transaction types
 */
export interface FeeEstimates {
  token_transfer: FeePriorityTiers;
  contract_call: FeePriorityTiers;
  smart_contract: FeePriorityTiers;
}

/**
 * Response from Hiro API GET /extended/v2/mempool/fees
 */
export interface HiroMempoolFeesResponse {
  token_transfer: FeePriorityTiers;
  contract_call: FeePriorityTiers;
  smart_contract: FeePriorityTiers;
}

/**
 * Floor and ceiling clamps for a transaction type
 */
export interface FeeClamp {
  floor: number;
  ceiling: number;
}

/**
 * Clamp configuration for all transaction types
 */
export interface FeeClampConfig {
  token_transfer: FeeClamp;
  contract_call: FeeClamp;
  smart_contract: FeeClamp;
}

/**
 * Response from GET /fees endpoint
 */
export interface FeesResponse {
  /** Clamped fee estimates */
  fees: FeeEstimates;
  /** Source of the fee data */
  source: "hiro" | "cache" | "default";
  /** Whether this data came from cache */
  cached: boolean;
}
