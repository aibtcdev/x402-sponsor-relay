import {
  publicKeyFromSignatureRsv,
  getAddressFromPublicKey,
  encodeStructuredDataBytes,
  tupleCV,
  uintCV,
  stringAsciiCV,
  type ClarityValue,
} from "@stacks/transactions";
import {
  hashMessage,
  verifyMessageSignatureRsv,
} from "@stacks/encryption";
import { bytesToHex, hexToBytes } from "@stacks/common";
import { sha256 } from "@noble/hashes/sha2.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import type { Logger, Sip018Auth } from "../types";
import { SIP018_DOMAIN } from "../types";

/**
 * Expand a hex signature into recovery candidates covering RSV, VRS, and raw r||s formats.
 *
 * Stacks signers disagree on byte ordering and recovery-id convention:
 *   - @stacks/encryption signMessageHashRsv → 65-byte RSV (r||s||v), v ∈ {0,1}
 *   - Leather wallet older paths / some BIP-137 signers → 65-byte VRS (v||r||s), v ∈ {27,28}
 *   - @noble/curves raw output → 64-byte r||s, recovery bit separate
 *
 * Returns up to 4 candidates; each is tried in order and the first whose recovered
 * pubkey hashes to the expected address wins.
 */
function signatureCandidates(sigHex: string): Array<{ rsBytes: Uint8Array; recoveryId: 0 | 1 }> {
  const sigBytes = hexToBytes(sigHex.replace(/^0x/, ""));
  const out: Array<{ rsBytes: Uint8Array; recoveryId: 0 | 1 }> = [];

  if (sigBytes.length === 64) {
    // Raw r||s — recovery id is unknown, try both
    out.push({ rsBytes: sigBytes, recoveryId: 0 });
    out.push({ rsBytes: sigBytes, recoveryId: 1 });
  } else if (sigBytes.length === 65) {
    // RSV layout: r(32) || s(32) || v(1)
    const vRsv = sigBytes[64];
    const recRsv = vRsv === 27 || vRsv === 28 ? ((vRsv - 27) as 0 | 1) : (vRsv as 0 | 1);
    if (recRsv === 0 || recRsv === 1) {
      out.push({ rsBytes: sigBytes.slice(0, 64) as Uint8Array, recoveryId: recRsv });
    }
    // VRS layout: v(1) || r(32) || s(32)
    const vVrs = sigBytes[0];
    const recVrs = vVrs === 27 || vVrs === 28 ? ((vVrs - 27) as 0 | 1) : (vVrs as 0 | 1);
    if (recVrs === 0 || recVrs === 1) {
      out.push({ rsBytes: sigBytes.slice(1, 65) as Uint8Array, recoveryId: recVrs });
    }
  }

  return out;
}

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
  | "STALE_TIMESTAMP"
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
   * Verify a SIP-018 structured data signature.
   *
   * Accepts three wire formats to handle wallet diversity:
   *   - 65-byte RSV (r||s||v)  — produced by @stacks/encryption.signMessageHashRsv
   *   - 65-byte VRS (v||r||s)  — produced by some BIP-137 / Leather wallet paths
   *   - 64-byte raw r||s       — tries both recoveryId 0 and 1
   * Recovery bytes 27/28 (BIP-137 convention) are normalized to 0/1.
   * If expectedAddress is supplied the recovered pubkey is checked against both
   * mainnet (version 22) and testnet (version 26) address encodings so that
   * callers need not know which network the signer used.
   */
  verifySip018(opts: {
    signature: string;
    domain: ClarityValue;
    message: ClarityValue;
    expectedAddress?: string;
  }): StxVerifyResult {
    try {
      const encodedBytes = encodeStructuredDataBytes({
        message: opts.message,
        domain: opts.domain,
      });
      const hash = sha256(encodedBytes);

      const candidates = signatureCandidates(opts.signature);
      if (candidates.length === 0) {
        return {
          valid: false,
          error: "Unrecognized signature format: must be 64 or 65 bytes hex",
          code: "INVALID_SIGNATURE",
        };
      }

      for (const { rsBytes, recoveryId } of candidates) {
        let pubkeyHex: string;
        try {
          const sig = secp256k1.Signature.fromBytes(rsBytes).addRecoveryBit(recoveryId);
          pubkeyHex = sig.recoverPublicKey(hash).toHex(true);
        } catch {
          continue;
        }

        if (opts.expectedAddress) {
          // Check both mainnet and testnet address encodings
          for (const net of ["mainnet", "testnet"] as const) {
            if (getAddressFromPublicKey(pubkeyHex, net) === opts.expectedAddress) {
              this.logger.info("SIP-018 signature verified", { stxAddress: opts.expectedAddress });
              return { valid: true, stxAddress: opts.expectedAddress, publicKey: pubkeyHex, path: "sip018" };
            }
          }
        } else {
          const recoveredAddress = getAddressFromPublicKey(pubkeyHex, this.network);
          this.logger.info("SIP-018 signature verified", { stxAddress: recoveredAddress });
          return { valid: true, stxAddress: recoveredAddress, publicKey: pubkeyHex, path: "sip018" };
        }
      }

      const errMsg = opts.expectedAddress
        ? `Signature address mismatch: no candidate matched ${opts.expectedAddress}`
        : "Could not recover public key from signature";
      this.logger.warn("SIP-018 signature verification failed", { error: errMsg });
      return { valid: false, error: errMsg, code: "INVALID_SIGNATURE" };
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
   * Verify a SIP-018 auth payload from a request body.
   * Validates structure, expiry, nonce, builds domain/message tuples, and verifies signature.
   * Used by /relay and /sponsor endpoints for optional SIP-018 authentication.
   *
   * Returns null if auth is valid, or an error object if validation fails.
   */
  verifySip018Auth(auth: Sip018Auth, expectedAction: "relay" | "sponsor"): Sip018AuthError | null {
    // Validate auth structure
    if (!auth.signature || !auth.message?.action || !auth.message?.nonce || !auth.message?.expiry) {
      return {
        error: "Invalid auth structure: signature, message.action, message.nonce, and message.expiry are required",
        code: "INVALID_AUTH_SIGNATURE",
      };
    }

    // Validate action matches the endpoint
    if (auth.message.action !== expectedAction) {
      return {
        error: `Invalid auth action: expected "${expectedAction}", got "${auth.message.action}"`,
        code: "INVALID_AUTH_SIGNATURE",
      };
    }

    // Check expiry
    const expiry = parseInt(auth.message.expiry, 10);
    if (isNaN(expiry) || expiry < Date.now()) {
      return {
        error: "Auth signature has expired",
        code: "AUTH_EXPIRED",
      };
    }

    // Parse nonce
    const nonce = parseInt(auth.message.nonce, 10);
    if (isNaN(nonce)) {
      return {
        error: "Invalid nonce: must be a valid unix timestamp",
        code: "INVALID_AUTH_SIGNATURE",
      };
    }

    // Build SIP-018 domain tuple based on network
    const domain = this.network === "mainnet"
      ? SIP018_DOMAIN.mainnet
      : SIP018_DOMAIN.testnet;
    const domainTuple = tupleCV({
      name: stringAsciiCV(domain.name),
      version: stringAsciiCV(domain.version),
      "chain-id": uintCV(domain.chainId),
    });

    // Build message tuple from auth payload
    const messageTuple = tupleCV({
      action: stringAsciiCV(auth.message.action),
      nonce: uintCV(nonce),
      expiry: uintCV(expiry),
    });

    // Verify SIP-018 signature
    const verifyResult = this.verifySip018({
      signature: auth.signature,
      domain: domainTuple,
      message: messageTuple,
    });

    if (!verifyResult.valid) {
      this.logger.warn("SIP-018 auth verification failed", { error: verifyResult.error });
      return {
        error: verifyResult.error,
        code: "INVALID_AUTH_SIGNATURE",
      };
    }

    // Log verified signer for audit trail
    this.logger.info("SIP-018 auth verified", {
      signer: verifyResult.stxAddress,
      action: auth.message.action,
      nonce: auth.message.nonce,
      expiry: auth.message.expiry,
    });

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

/**
 * Error from SIP-018 auth verification.
 * Returned by verifySip018Auth when validation fails.
 */
export interface Sip018AuthError {
  error: string;
  code: "INVALID_AUTH_SIGNATURE" | "AUTH_EXPIRED";
}
