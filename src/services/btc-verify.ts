import * as bitcoinMessage from "bitcoinjs-message";
import type { Logger } from "../types";

/**
 * Standard messages for BTC signature verification
 */
export const BTC_MESSAGES = {
  /** Base message for registration and self-service paths */
  BASE: "Bitcoin will be the currency of AIs",
  /** Format for self-service path with timestamp: "Bitcoin will be the currency of AIs | {ISO-timestamp}" */
  SELF_SERVICE_PATTERN: /^Bitcoin will be the currency of AIs \| ([0-9T:.Z-]+)$/,
} as const;

/** Maximum age for timestamp in self-service messages (5 minutes) */
const MAX_TIMESTAMP_AGE_MS = 5 * 60 * 1000;

/** Maximum clock skew tolerance for future timestamps (1 minute) */
const MAX_FUTURE_TOLERANCE_MS = 60 * 1000;

/**
 * Result of BTC signature verification
 */
export type BtcVerifyResult =
  | { valid: true; path: "registration" | "self-service"; timestamp?: string }
  | { valid: false; error: string; code: BtcVerifyErrorCode };

/**
 * Error codes for BTC verification failures
 */
export type BtcVerifyErrorCode =
  | "INVALID_SIGNATURE"
  | "STALE_TIMESTAMP"
  | "INVALID_MESSAGE_FORMAT"
  | "VERIFICATION_ERROR";

/**
 * BtcVerifyService handles Bitcoin signature verification using BIP-137 standard
 * Supports two paths:
 * 1. Registration: bare message "Bitcoin will be the currency of AIs"
 * 2. Self-service: message with timestamp "Bitcoin will be the currency of AIs | {ISO-timestamp}"
 */
export class BtcVerifyService {
  constructor(private logger: Logger) {}

  /**
   * Verify a BIP-137 signature against a Bitcoin address and message
   */
  verify(
    btcAddress: string,
    message: string,
    signature: string
  ): BtcVerifyResult {
    try {
      // Determine path: registration (bare message) or self-service (with timestamp)
      if (message === BTC_MESSAGES.BASE) {
        return this.verifyAndReturn(btcAddress, message, signature, "registration");
      }

      // Check for self-service path (message with timestamp)
      const timestampMatch = message.match(BTC_MESSAGES.SELF_SERVICE_PATTERN);
      if (!timestampMatch) {
        this.logger.warn("Invalid message format", { message });
        return {
          valid: false,
          error: `Message must be either "${BTC_MESSAGES.BASE}" or "${BTC_MESSAGES.BASE} | {ISO-timestamp}"`,
          code: "INVALID_MESSAGE_FORMAT",
        };
      }

      // Validate timestamp freshness
      const timestamp = timestampMatch[1];
      const timestampError = this.validateTimestamp(timestamp);
      if (timestampError) {
        return timestampError;
      }

      return this.verifyAndReturn(btcAddress, message, signature, "self-service", timestamp);
    } catch (error) {
      this.logger.error("BTC verification error", {
        error: error instanceof Error ? error.message : "Unknown error",
        btcAddress,
      });
      return {
        valid: false,
        error: "Signature verification failed due to internal error",
        code: "VERIFICATION_ERROR",
      };
    }
  }

  /**
   * Verify signature and return a typed result for the given path
   */
  private verifyAndReturn(
    btcAddress: string,
    message: string,
    signature: string,
    path: "registration" | "self-service",
    timestamp?: string
  ): BtcVerifyResult {
    if (!this.verifySignature(btcAddress, message, signature)) {
      this.logger.warn(`${path} signature verification failed`, { btcAddress, message });
      return {
        valid: false,
        error: `Invalid signature for ${path} message`,
        code: "INVALID_SIGNATURE",
      };
    }

    this.logger.info(`${path} signature verified`, { btcAddress, ...(timestamp && { timestamp }) });
    return { valid: true, path, timestamp };
  }

  /**
   * Validate timestamp format and freshness, returning an error result if invalid
   */
  private validateTimestamp(timestamp: string): BtcVerifyResult | null {
    const timestampDate = new Date(timestamp);
    if (isNaN(timestampDate.getTime())) {
      this.logger.warn("Invalid timestamp format", { timestamp });
      return {
        valid: false,
        error: "Timestamp must be a valid ISO 8601 date string",
        code: "INVALID_MESSAGE_FORMAT",
      };
    }

    const age = Date.now() - timestampDate.getTime();

    if (age > MAX_TIMESTAMP_AGE_MS) {
      const ageMinutes = Math.floor(age / 1000 / 60);
      this.logger.warn("Timestamp too old", { timestamp, ageMinutes, maxMinutes: 5 });
      return {
        valid: false,
        error: `Timestamp must be within 5 minutes. Current age: ${ageMinutes} minutes`,
        code: "STALE_TIMESTAMP",
      };
    }

    if (age < -MAX_FUTURE_TOLERANCE_MS) {
      this.logger.warn("Timestamp is in the future", { timestamp, age });
      return {
        valid: false,
        error: "Timestamp cannot be more than 1 minute in the future",
        code: "STALE_TIMESTAMP",
      };
    }

    return null;
  }

  /**
   * Low-level signature verification using bitcoinjs-message
   */
  private verifySignature(
    address: string,
    message: string,
    signature: string
  ): boolean {
    try {
      const signatureBuffer = Buffer.from(signature, "base64");
      return bitcoinMessage.verify(message, address, signatureBuffer);
    } catch (error) {
      this.logger.error("Low-level signature verification error", {
        error: error instanceof Error ? error.message : "Unknown error",
        address,
      });
      return false;
    }
  }

  /**
   * Generate a self-service message with current timestamp
   * Helper method for clients generating self-service messages
   */
  static generateSelfServiceMessage(): string {
    return `${BTC_MESSAGES.BASE} | ${new Date().toISOString()}`;
  }
}
