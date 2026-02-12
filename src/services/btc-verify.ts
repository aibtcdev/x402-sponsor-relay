import * as bitcoinMessage from "bitcoinjs-message";
import type { Logger } from "../types";

/**
 * Standard messages for BTC signature verification
 */
export const BTC_MESSAGES = {
  /** Base message for registration and self-service paths */
  BASE: "Bitcoin will be the currency of AIs",
  /** Format for self-service path with timestamp: "Bitcoin will be the currency of AIs | {ISO-timestamp}" */
  SELF_SERVICE_PATTERN: /^Bitcoin will be the currency of AIs \| (.+)$/,
} as const;

/**
 * Maximum age for timestamp in self-service messages (5 minutes)
 */
const MAX_TIMESTAMP_AGE_MS = 5 * 60 * 1000;

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
   *
   * @param btcAddress - Bitcoin address (any format: P2PKH, P2SH, Bech32, etc.)
   * @param message - Message that was signed
   * @param signature - Base64-encoded signature
   * @returns Verification result with path detection and timestamp validation
   */
  async verify(
    btcAddress: string,
    message: string,
    signature: string
  ): Promise<BtcVerifyResult> {
    try {
      // Check if this is a registration path (bare message)
      if (message === BTC_MESSAGES.BASE) {
        const isValid = this.verifySignature(btcAddress, message, signature);

        if (!isValid) {
          this.logger.warn("Registration signature verification failed", {
            btcAddress,
            message,
          });
          return {
            valid: false,
            error: "Invalid signature for registration message",
            code: "INVALID_SIGNATURE",
          };
        }

        this.logger.info("Registration signature verified", { btcAddress });
        return { valid: true, path: "registration" };
      }

      // Check if this is a self-service path (message with timestamp)
      const timestampMatch = message.match(BTC_MESSAGES.SELF_SERVICE_PATTERN);
      if (!timestampMatch) {
        this.logger.warn("Invalid message format", { message });
        return {
          valid: false,
          error: `Message must be either "${BTC_MESSAGES.BASE}" or "${BTC_MESSAGES.BASE} | {ISO-timestamp}"`,
          code: "INVALID_MESSAGE_FORMAT",
        };
      }

      const timestamp = timestampMatch[1];

      // Validate timestamp format and freshness
      const timestampDate = new Date(timestamp);
      if (isNaN(timestampDate.getTime())) {
        this.logger.warn("Invalid timestamp format", { timestamp });
        return {
          valid: false,
          error: "Timestamp must be a valid ISO 8601 date string",
          code: "INVALID_MESSAGE_FORMAT",
        };
      }

      const now = new Date();
      const age = now.getTime() - timestampDate.getTime();

      if (age > MAX_TIMESTAMP_AGE_MS) {
        const ageMinutes = Math.floor(age / 1000 / 60);
        this.logger.warn("Timestamp too old", {
          timestamp,
          ageMinutes,
          maxMinutes: MAX_TIMESTAMP_AGE_MS / 1000 / 60,
        });
        return {
          valid: false,
          error: `Timestamp must be within 5 minutes. Current age: ${ageMinutes} minutes`,
          code: "STALE_TIMESTAMP",
        };
      }

      // Timestamp is from the future (allow small clock skew)
      if (age < -60000) {
        // Allow 1 minute future
        this.logger.warn("Timestamp is in the future", { timestamp, age });
        return {
          valid: false,
          error: "Timestamp cannot be more than 1 minute in the future",
          code: "STALE_TIMESTAMP",
        };
      }

      // Verify signature with timestamped message
      const isValid = this.verifySignature(btcAddress, message, signature);

      if (!isValid) {
        this.logger.warn("Self-service signature verification failed", {
          btcAddress,
          message,
        });
        return {
          valid: false,
          error: "Invalid signature for self-service message",
          code: "INVALID_SIGNATURE",
        };
      }

      this.logger.info("Self-service signature verified", {
        btcAddress,
        timestamp,
      });
      return { valid: true, path: "self-service", timestamp };
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
   * Low-level signature verification using bitcoinjs-message
   *
   * @param address - Bitcoin address
   * @param message - Message that was signed
   * @param signature - Base64-encoded signature
   * @returns true if signature is valid
   */
  private verifySignature(
    address: string,
    message: string,
    signature: string
  ): boolean {
    try {
      // bitcoinjs-message expects Buffer for signature
      // Convert base64 string to Buffer
      const signatureBuffer = Buffer.from(signature, "base64");

      // Verify the signature
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
   * Get the current timestamp in ISO 8601 format for self-service signing
   * Helper method for clients generating self-service messages
   *
   * @returns ISO 8601 timestamp string
   */
  static getCurrentTimestamp(): string {
    return new Date().toISOString();
  }

  /**
   * Generate a self-service message with current timestamp
   * Helper method for clients generating self-service messages
   *
   * @returns Message string ready for signing
   */
  static generateSelfServiceMessage(): string {
    return `${BTC_MESSAGES.BASE} | ${this.getCurrentTimestamp()}`;
  }
}
