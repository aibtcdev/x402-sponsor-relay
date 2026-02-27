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
  /** Number of sponsor wallets to rotate through (default: "1", max: 10).
   *  Derives BIP-44 accounts 0..N-1 from the mnemonic for round-robin sponsoring. */
  SPONSOR_WALLET_COUNT?: string;
  /** Hex-encoded private key (fallback if no mnemonic) */
  SPONSOR_PRIVATE_KEY?: string;
  STACKS_NETWORK: "mainnet" | "testnet";
  /** Optional Hiro API key for higher rate limits */
  HIRO_API_KEY?: string;
  /** Recipient address for nonce gap-fill transactions (default: SPEB8Z3TAY2130B8M5THXZEQQ4D6S3RMYT37WTAC) */
  FLUSH_RECIPIENT?: string;
  // LOGS is a service binding to worker-logs, typed loosely to avoid complex Service<> generics
  LOGS?: unknown;
  // KV namespace for receipts, dedup, fee cache, and health checks
  RELAY_KV?: KVNamespace;
  // KV namespace for API key storage
  API_KEYS_KV?: KVNamespace;
  // Durable Object namespace for nonce coordination
  NONCE_DO?: DurableObjectNamespace;
  // Durable Object namespace for atomic stats (replaces KV read-modify-write)
  STATS_DO?: DurableObjectNamespace;
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
  /** Stacks address used to provision this key (optional, only for STX-provisioned keys) */
  stxAddress?: string;
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

// =============================================================================
// x402 V2 Types (Coinbase x402 V2 spec compatible)
// =============================================================================

/**
 * CAIP-2 network identifiers for Stacks
 */
export const CAIP2_NETWORKS = {
  mainnet: "stacks:1",
  testnet: "stacks:2147483648",
} as const;

/**
 * Payment requirements for x402 V2 spec (defines acceptable payment method)
 */
export interface X402PaymentRequirementsV2 {
  /** Payment scheme (e.g., "exact") */
  scheme: string;
  /** CAIP-2 network identifier (e.g., "stacks:1" for mainnet) */
  network: string;
  /** Amount in smallest unit as string */
  amount: string;
  /** Asset identifier: "STX", "sBTC", or CAIP-19 contract address */
  asset: string;
  /** Recipient Stacks address */
  payTo: string;
  /** Maximum timeout in seconds for settlement (optional) */
  maxTimeoutSeconds?: number;
  /** Optional extra fields for scheme-specific data */
  extra?: Record<string, unknown>;
}

/**
 * Resource info describing the protected resource (x402 V2)
 */
export interface X402ResourceInfo {
  /** URL of the protected resource */
  url: string;
  /** Human-readable description of the resource */
  description?: string;
  /** MIME type of the resource */
  mimeType?: string;
}

/**
 * Stacks scheme-specific payment payload (x402 V2)
 * Contains the signed sponsored transaction hex
 */
export interface X402PayloadV2 {
  /** Hex-encoded signed sponsored transaction */
  transaction: string;
}

/**
 * Payment-identifier extension payload (x402 V2 extension)
 * Provides a client-controlled idempotency key that survives transaction rebuilds.
 * Pattern: [a-zA-Z0-9_-]+, length 16-128, pay_ prefix recommended.
 */
export interface PaymentIdentifierExtension {
  /** Extension info object containing the idempotency key */
  info: {
    /** Idempotency key (16-128 chars, pattern: [a-zA-Z0-9_-]+) */
    id: string;
  };
}

/**
 * Typed extensions object for x402 V2 paymentPayload.
 * Maps known extension keys to their typed payloads.
 */
export interface PaymentPayloadExtensions {
  /** Client-controlled idempotency key extension */
  "payment-identifier"?: PaymentIdentifierExtension;
}

/**
 * Client's payment authorization (x402 V2 paymentPayload)
 */
export interface X402PaymentPayloadV2 {
  /** x402 protocol version (must be 2) */
  x402Version: number;
  /** Optional resource info */
  resource?: X402ResourceInfo;
  /** The payment requirements that were accepted (optional — not validated by relay) */
  accepted?: X402PaymentRequirementsV2;
  /** Scheme-specific payload containing the transaction */
  payload: X402PayloadV2;
  /** Optional protocol extensions */
  extensions?: PaymentPayloadExtensions;
}

/**
 * Request body for POST /settle (x402 V2)
 * Also accepts x402Version at top level for library compatibility
 */
export interface X402SettleRequestV2 {
  /** x402 protocol version (optional at top level, library compat) */
  x402Version?: number;
  /** Client's payment authorization */
  paymentPayload: X402PaymentPayloadV2;
  /** Server's payment requirements to validate against */
  paymentRequirements: X402PaymentRequirementsV2;
}

/**
 * Response from POST /settle (x402 V2 SettlementResponse)
 */
export interface X402SettlementResponseV2 {
  /** Whether settlement succeeded */
  success: boolean;
  /** Error reason code if settlement failed (x402 V2 error code) */
  errorReason?: string;
  /** Payer Stacks address (present on success or partial failure) */
  payer?: string;
  /** Transaction ID on the network */
  transaction: string;
  /** CAIP-2 network identifier */
  network: string;
  /** Optional protocol extensions */
  extensions?: Record<string, unknown>;
}

/**
 * Request body for POST /verify (x402 V2)
 * Same wire format as settle request per the x402 V2 spec
 */
export type X402VerifyRequestV2 = X402SettleRequestV2;

/**
 * Response from POST /verify (x402 V2)
 */
export interface X402VerifyResponseV2 {
  /** Whether the payment is valid */
  isValid: boolean;
  /** Reason for invalidity if isValid is false */
  invalidReason?: string;
  /** Payer Stacks address (if determinable) */
  payer?: string;
}

/**
 * A supported payment kind (for GET /supported response)
 */
export interface X402SupportedKind {
  /** x402 protocol version */
  x402Version: number;
  /** Payment scheme supported (e.g., "exact") */
  scheme: string;
  /** CAIP-2 network identifier */
  network: string;
  /** Optional extra fields for scheme-specific data */
  extra?: Record<string, unknown>;
}

/**
 * Response from GET /supported (x402 V2)
 */
export interface X402SupportedResponseV2 {
  /** List of supported payment kinds */
  kinds: X402SupportedKind[];
  /** Supported protocol extensions */
  extensions: string[];
  /** Map of network to supported signer addresses */
  signers: Record<string, string[]>;
}

/**
 * x402 V2 error codes per spec
 */
export const X402_V2_ERROR_CODES = {
  INSUFFICIENT_FUNDS: "insufficient_funds",
  INVALID_NETWORK: "invalid_network",
  INVALID_PAYLOAD: "invalid_payload",
  INVALID_PAYMENT_REQUIREMENTS: "invalid_payment_requirements",
  INVALID_SCHEME: "invalid_scheme",
  UNSUPPORTED_SCHEME: "unsupported_scheme",
  UNRECOGNIZED_ASSET: "unrecognized_asset",
  INVALID_X402_VERSION: "invalid_x402_version",
  INVALID_TRANSACTION_STATE: "invalid_transaction_state",
  UNEXPECTED_VERIFY_ERROR: "unexpected_verify_error",
  UNEXPECTED_SETTLE_ERROR: "unexpected_settle_error",
  RECIPIENT_MISMATCH: "recipient_mismatch",
  AMOUNT_INSUFFICIENT: "amount_insufficient",
  SENDER_MISMATCH: "sender_mismatch",
  TRANSACTION_NOT_FOUND: "transaction_not_found",
  TRANSACTION_PENDING: "transaction_pending",
  TRANSACTION_FAILED: "transaction_failed",
  BROADCAST_FAILED: "broadcast_failed",
  CONFLICTING_NONCE: "conflicting_nonce",
  PAYMENT_IDENTIFIER_CONFLICT: "payment_identifier_conflict",
  PAYMENT_IDENTIFIER_REQUIRED: "payment_identifier_required",
} as const;

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
  /** Maximum timeout in seconds for settlement (optional, caps broadcastAndConfirm polling) */
  maxTimeoutSeconds?: number;
}

// =============================================================================
// SIP-018 Auth Types
// =============================================================================

/**
 * SIP-018 structured data signature for optional authentication
 */
export interface Sip018Auth {
  /** RSV signature of the structured data */
  signature: string;
  /** Structured data message that was signed */
  message: {
    /** Action being performed ("relay" or "sponsor") */
    action: string;
    /** Nonce (unix timestamp ms) for replay protection */
    nonce: string;
    /** Expiry timestamp (unix ms) for time-bound authorization */
    expiry: string;
  };
}

/**
 * SIP-018 domain constants for x402-sponsor-relay
 * Domain binds signatures to this specific application
 */
export const SIP018_DOMAIN = {
  /** Mainnet domain: chain-id u1 */
  mainnet: {
    name: "x402-sponsor-relay",
    version: "1",
    chainId: 1,
  },
  /** Testnet domain: chain-id u2147483648 */
  testnet: {
    name: "x402-sponsor-relay",
    version: "1",
    chainId: 2147483648,
  },
} as const;

/**
 * Request body for /relay endpoint
 */
export interface RelayRequest {
  /** Hex-encoded signed sponsored transaction */
  transaction: string;
  /** Settlement options for x402 payment verification */
  settle: SettleOptions;
  /** Optional SIP-018 authentication */
  auth?: Sip018Auth;
}

/**
 * Settlement result in API response format
 */
export interface SettlementResult {
  success: boolean;
  status: "pending" | "confirmed" | "failed";
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
  /** Settlement details */
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
  | "SETTLEMENT_VERIFICATION_FAILED"
  | "SETTLEMENT_BROADCAST_FAILED"
  | "NONCE_CONFLICT"
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
  | "INVALID_FEE_CONFIG"
  | "INVALID_STX_SIGNATURE"
  | "MISSING_STX_ADDRESS"
  | "INVALID_AUTH_SIGNATURE"
  | "AUTH_EXPIRED"
  | "NONCE_RESET_FAILED"
  | "NONCE_DO_UNAVAILABLE"
  | "UNSUPPORTED_ADDRESS_TYPE"
  | "INVALID_BTC_ADDRESS";

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
  /** Optional SIP-018 authentication */
  auth?: Sip018Auth;
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
  /** BIP-137 or BIP-322 signature of the message (Base64-encoded).
   *  P2PKH (1...) and P2SH (3...) wallets produce BIP-137 signatures (65 bytes).
   *  P2WPKH (bc1q...) and P2TR (bc1p...) wallets produce BIP-322 signatures (witness-serialized). */
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

/**
 * Request body for POST /keys/provision-stx endpoint
 */
export interface ProvisionStxRequest {
  /** Stacks address used to sign the message */
  stxAddress: string;
  /** RSV signature of the message */
  signature: string;
  /** Message that was signed (for verification) */
  message: string;
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
 * Daily statistics (stored in StatsDO SQLite)
 */
export interface DailyStats {
  date: string;
  transactions: {
    total: number;
    success: number;
    failed: number;
    /** Number of failures caused by client errors (bad params, nonce conflicts, rate limits).
     *  These are excluded from relay success rate calculations. */
    clientErrors?: number;
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
    settlement: number;
    internal: number;
  };
  /** Fee statistics for the day */
  fees?: FeeStats;
}

/**
 * Health check record (settlement health)
 */
export interface HealthCheck {
  timestamp: string;
  status: "healthy" | "degraded" | "down";
  latencyMs: number;
  httpStatus: number;
  error?: string;
}

/**
 * Dashboard overview data for API response
 */
/**
 * Per-endpoint transaction breakdown for the dashboard
 */
export interface EndpointBreakdown {
  relay: { total: number; success: number; failed: number };
  sponsor: { total: number; success: number; failed: number };
  settle: { total: number; success: number; failed: number; clientErrors: number };
  verify: { total: number };
}

export interface DashboardOverview {
  period: "24h" | "7d";
  transactions: {
    total: number;
    success: number;
    failed: number;
    trend: "up" | "down" | "stable";
    previousTotal: number;
    /** Number of failures caused by client errors in the rolling 24h window */
    clientErrors?: number;
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
  settlement?: {
    status: "healthy" | "degraded" | "down" | "unknown";
    avgLatencyMs: number;
    uptime24h: number;
    lastCheck: string | null;
  };
  hourlyData: Array<{ hour: string; transactions: number; success: number; fees?: string }>;
  /** API key aggregate statistics (optional, only present if API_KEYS_KV is configured) */
  apiKeys?: AggregateKeyStats;
  /** Per-endpoint transaction breakdown (today's calendar-day counters) */
  endpointBreakdown?: EndpointBreakdown;
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
  /** Number of keys whose expiresAt is in the past (regardless of active flag) */
  expiredKeys: number;
  /** Number of keys with active === false (revoked) */
  revokedKeys: number;
  /** Number of keys created within the last 7 days */
  newKeysLast7Days: number;
}

/**
 * Endpoint that processed a transaction
 */
export type RelayEndpointName = "relay" | "sponsor" | "settle" | "verify";

/**
 * Individual transaction log entry (stored in StatsDO SQLite)
 */
export interface TransactionLogEntry {
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Which endpoint processed this transaction */
  endpoint: RelayEndpointName;
  /** Whether the transaction was successful */
  success: boolean;
  /** Token type */
  tokenType: TokenType;
  /** Payment amount in smallest unit */
  amount: string;
  /** Sponsor fee in microSTX (only for relay/sponsor) */
  fee?: string;
  /** On-chain txid (if broadcast succeeded) */
  txid?: string;
  /** Sender address (if known) */
  sender?: string;
  /** Recipient address (if known) */
  recipient?: string;
  /** Settlement status */
  status?: "confirmed" | "pending" | "failed";
  /** Block height (if confirmed) */
  blockHeight?: number;
  /** Sponsor wallet address that paid the fee (optional, for per-wallet tracking) */
  sponsorAddress?: string;
  /** Sponsor wallet index (0-based) that paid the fee (optional, for per-wallet tracking) */
  walletIndex?: number;
  /**
   * Whether this failure was caused by the client (bad params, bad nonce, rate limit exceeded).
   * When true, this entry is counted as a client error rather than a relay failure,
   * allowing the relay success rate to exclude client-caused failures.
   */
  clientError?: boolean;
}

// =============================================================================
// Wallet Monitoring Types
// =============================================================================

/**
 * Status of a single sponsor wallet
 */
export interface WalletStatus {
  /** 0-based wallet index (BIP-44 account index) */
  index: number;
  /** Stacks address for this wallet */
  address: string;
  /** Current STX balance in microSTX (as string to avoid overflow) */
  balance: string;
  /** Cumulative fees paid by this wallet since tracking began (microSTX string) */
  totalFeesSpent: string;
  /** Total number of transactions sponsored by this wallet */
  txCount: number;
  /** Number of transactions sponsored today */
  txCountToday: number;
  /** Total fees paid today in microSTX (as string) */
  feesToday: string;
  /** Cumulative fees paid for gap-fill transactions (microSTX string) */
  gapFillFeesTotal: string;
  /** Number of gap-fill transactions broadcast by the alarm for this wallet */
  gapFillCount: number;
  /** Live nonce pool state */
  pool: {
    available: number;
    reserved: number;
    maxNonce: number;
  };
  /** Health status based on current balance */
  status: "healthy" | "low_balance" | "depleted";
}

/**
 * Response from GET /wallets endpoint
 */
export interface WalletsResponse {
  /** Per-wallet status array (ordered by wallet index) */
  wallets: WalletStatus[];
  /** Aggregate totals across all wallets */
  totals: {
    totalBalance: string;
    totalFeesSpent: string;
    totalTxCount: number;
    walletCount: number;
  };
  /** Balance thresholds used to classify wallet health */
  thresholds: {
    /** Balance below this value triggers low_balance warning (microSTX) */
    lowBalanceWarning: string;
    /** Balance below this value marks wallet as depleted (microSTX) */
    depletedThreshold: string;
  };
}

/**
 * Error categories for metrics tracking
 */
export type ErrorCategory =
  | "validation"
  | "rateLimit"
  | "sponsoring"
  | "settlement"
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
 * Fee estimates for all transaction types.
 * Also matches the shape of Hiro API GET /extended/v2/mempool/fees response.
 * Note: smart_contract is optional because the Hiro API may omit it when
 * there is insufficient mempool data for that tier. Callers that need
 * smart_contract fees should fall back to contract_call values.
 */
export interface FeeEstimates {
  token_transfer: FeePriorityTiers;
  contract_call: FeePriorityTiers;
  smart_contract?: FeePriorityTiers;
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

// Native Settlement Types

/**
 * Extracted payment verification data from a transaction
 */
export interface SettlementVerification {
  /**
   * Sender hash160 as a 40-character hex string extracted from the transaction
   * (for traceability). This is a raw hash160 value, NOT a human-readable
   * Stacks address, and its format differs from `recipient`.
   */
  sender: string;
  /** Recipient address extracted from the transaction (human-readable form) */
  recipient: string;
  /** Amount in smallest unit (microSTX, sats, etc.) as string */
  amount: string;
  /** Token type detected from the transaction */
  tokenType: TokenType;
  /** The deserialized transaction (avoids re-deserialization for broadcast) */
  transaction: import("@stacks/transactions").StacksTransactionWire;
}

/**
 * Result of native payment parameter verification
 */
export type SettlementVerifyResult =
  | { valid: true; data: SettlementVerification }
  | { valid: false; error: string; details: string };

/**
 * Cached deduplication result stored in KV
 * Prevents double-broadcast and double-receipt-creation
 */
export interface DedupResult {
  /** Blockchain transaction ID */
  txid: string;
  /** Receipt ID if one was created */
  receiptId?: string;
  /** Transaction status at time of dedup record */
  status: "confirmed" | "pending";
  /** Sender hash160 hex (for consistent response shape on dedup hits) */
  sender: string;
  /** Recipient address */
  recipient: string;
  /** Amount in smallest unit */
  amount: string;
  /** Block height if confirmed */
  blockHeight?: number;
  /** Hex-encoded fully-sponsored transaction for consistent dedup responses */
  sponsoredTx?: string;
  /** Unix timestamp (ms) when this dedup entry was recorded */
  recordedAt?: number;
}

/**
 * Result from broadcasting a transaction and polling for confirmation
 */
export type BroadcastAndConfirmResult =
  | { txid: string; status: "confirmed"; blockHeight: number }
  | { txid: string; status: "pending" }
  | { error: string; details: string; retryable: boolean; nonceConflict?: boolean };
