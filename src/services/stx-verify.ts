import {
  publicKeyFromSignatureRsv,
  getAddressFromPublicKey,
  encodeStructuredDataBytes,
  type ClarityValue,
} from "@stacks/transactions";
import {
  hashMessage,
  verifyMessageSignatureRsv,
} from "@stacks/encryption";
import { bytesToHex } from "@stacks/common";
import { sha256 } from "@noble/hashes/sha256";
import type { Logger } from "../types";

/**
 * Standard messages for Stacks signature verification
 */
export const STX_MESSAGES = {
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
 * Result of Stacks signature verification
 */
export type StxVerifyResult =
  | { valid: true; stxAddress: string; publicKey: string; path: "plain-message" | "sip018" }
  | { valid: false; error: string; code: StxVerifyErrorCode };

/**
 * Error codes for Stacks verification failures
 */
export type StxVerifyErrorCode =
  | "INVALID_SIGNATURE"
  | "EXPIRED_AUTH"
  | "INVALID_MESSAGE_FORMAT"
  | "VERIFICATION_ERROR";

/**
 * StxVerifyService handles Stacks signature verification
 * Supports two verification modes:
 * 1. Plain message: SIWS-style message signing with RSV signatures
 * 2. SIP-018: Structured data signing with domain-bound ClarityValues
 */
export class StxVerifyService {
  constructor(
    private logger: Logger,
    private network: "mainnet" | "testnet"
  ) {}

  /**
   * Verify a plain Stacks message signature (SIWS-style)
   * Recovers the signer's Stacks address from an RSV signature of a plain string message.
   */
  verifyMessage(signature: string, message: string): StxVerifyResult {
    try {
      // Hash the message using Stacks prefix
      const messageHash = hashMessage(message);
      const messageHashHex = bytesToHex(messageHash);

      // Recover public key from signature
      const recoveredPubKey = publicKeyFromSignatureRsv(messageHashHex, signature);

      // Derive Stacks address from public key
      const recoveredAddress = getAddressFromPublicKey(recoveredPubKey, this.network);

      // Verify signature
      const valid = verifyMessageSignatureRsv({
        signature,
        message,
        publicKey: recoveredPubKey,
      });

      if (!valid) {
        this.logger.warn("Plain message signature verification failed", {
          message,
          recoveredAddress,
        });
        return {
          valid: false,
          error: "Invalid signature for message",
          code: "INVALID_SIGNATURE",
        };
      }

      this.logger.info("Plain message signature verified", {
        stxAddress: recoveredAddress,
        message,
      });

      return {
        valid: true,
        stxAddress: recoveredAddress,
        publicKey: recoveredPubKey,
        path: "plain-message",
      };
    } catch (error) {
      this.logger.error("Plain message verification error", {
        error: error instanceof Error ? error.message : "Unknown error",
        message,
      });
      return {
        valid: false,
        error: "Signature verification failed due to internal error",
        code: "VERIFICATION_ERROR",
      };
    }
  }

  /**
   * Verify a SIP-018 structured data signature
   * Recovers the signer's Stacks address from an RSV signature of SIP-018 encoded data.
   */
  verifySip018(opts: {
    signature: string;
    domain: ClarityValue;
    message: ClarityValue;
    expectedAddress?: string;
  }): StxVerifyResult {
    try {
      // Encode structured data according to SIP-018
      const encodedBytes = encodeStructuredDataBytes({
        message: opts.message,
        domain: opts.domain,
      });

      // Hash the encoded bytes
      const hash = sha256(encodedBytes);
      const hashHex = bytesToHex(hash);

      // Recover public key from signature
      const recoveredPubKey = publicKeyFromSignatureRsv(hashHex, opts.signature);

      // Derive Stacks address from public key
      const recoveredAddress = getAddressFromPublicKey(recoveredPubKey, this.network);

      // If expectedAddress is provided, verify it matches
      if (opts.expectedAddress && recoveredAddress !== opts.expectedAddress) {
        this.logger.warn("SIP-018 signature address mismatch", {
          expected: opts.expectedAddress,
          recovered: recoveredAddress,
        });
        return {
          valid: false,
          error: `Signature address mismatch: expected ${opts.expectedAddress}, got ${recoveredAddress}`,
          code: "INVALID_SIGNATURE",
        };
      }

      this.logger.info("SIP-018 signature verified", {
        stxAddress: recoveredAddress,
      });

      return {
        valid: true,
        stxAddress: recoveredAddress,
        publicKey: recoveredPubKey,
        path: "sip018",
      };
    } catch (error) {
      this.logger.error("SIP-018 verification error", {
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return {
        valid: false,
        error: "Signature verification failed due to internal error",
        code: "VERIFICATION_ERROR",
      };
    }
  }

  /**
   * Verify a self-service provisioning message with timestamp freshness check
   * Supports both bare message and timestamped message patterns
   */
  verifyProvisionMessage(signature: string, message: string): StxVerifyResult {
    try {
      // Check for bare message (registration path)
      if (message === STX_MESSAGES.BASE) {
        return this.verifyMessage(signature, message);
      }

      // Check for self-service path (message with timestamp)
      const timestampMatch = message.match(STX_MESSAGES.SELF_SERVICE_PATTERN);
      if (!timestampMatch) {
        this.logger.warn("Invalid message format", { message });
        return {
          valid: false,
          error: `Message must be either "${STX_MESSAGES.BASE}" or "${STX_MESSAGES.BASE} | {ISO-timestamp}"`,
          code: "INVALID_MESSAGE_FORMAT",
        };
      }

      // Validate timestamp freshness
      const timestamp = timestampMatch[1];
      const timestampError = this.validateTimestamp(timestamp);
      if (timestampError) {
        return timestampError;
      }

      // Verify the message signature
      return this.verifyMessage(signature, message);
    } catch (error) {
      this.logger.error("Provision message verification error", {
        error: error instanceof Error ? error.message : "Unknown error",
        message,
      });
      return {
        valid: false,
        error: "Signature verification failed due to internal error",
        code: "VERIFICATION_ERROR",
      };
    }
  }

  /**
   * Validate timestamp format and freshness, returning an error result if invalid
   */
  private validateTimestamp(timestamp: string): StxVerifyResult | null {
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
        code: "EXPIRED_AUTH",
      };
    }

    if (age < -MAX_FUTURE_TOLERANCE_MS) {
      this.logger.warn("Timestamp is in the future", { timestamp, age });
      return {
        valid: false,
        error: "Timestamp cannot be more than 1 minute in the future",
        code: "EXPIRED_AUTH",
      };
    }

    return null;
  }

  /**
   * Generate a self-service message with current timestamp
   * Helper method for clients generating self-service messages
   */
  static generateSelfServiceMessage(): string {
    return `${STX_MESSAGES.BASE} | ${new Date().toISOString()}`;
  }
}
