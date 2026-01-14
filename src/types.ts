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
  SPONSOR_PRIVATE_KEY: string;
  STACKS_NETWORK: "mainnet" | "testnet";
  FACILITATOR_URL: string;
  // LOGS is a service binding to worker-logs, typed loosely to avoid complex Service<> generics
  LOGS?: unknown;
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
