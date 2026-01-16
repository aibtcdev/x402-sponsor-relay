import {
  sponsorTransaction,
  deserializeTransaction,
  AuthType,
  type StacksTransactionWire,
} from "@stacks/transactions";
import { STACKS_MAINNET, STACKS_TESTNET } from "@stacks/network";
import type { Env, Logger } from "../types";

/**
 * Successful transaction validation result
 */
export interface TransactionValidationSuccess {
  valid: true;
  transaction: StacksTransactionWire;
  senderAddress: string;
}

/**
 * Failed transaction validation result
 */
export interface TransactionValidationFailure {
  valid: false;
  error: string;
  details: string;
}

/**
 * Result of transaction validation (discriminated union)
 */
export type TransactionValidationResult =
  | TransactionValidationSuccess
  | TransactionValidationFailure;

/**
 * Successful sponsoring result
 */
export interface SponsorSuccess {
  success: true;
  sponsoredTxHex: string;
  /** Fee in microSTX paid by sponsor */
  fee: string;
}

/**
 * Failed sponsoring result
 */
export interface SponsorFailure {
  success: false;
  error: string;
  details: string;
}

/**
 * Result of transaction sponsoring (discriminated union)
 */
export type SponsorResult = SponsorSuccess | SponsorFailure;

/**
 * Service for validating and sponsoring Stacks transactions
 */
export class SponsorService {
  private env: Env;
  private logger: Logger;

  constructor(env: Env, logger: Logger) {
    this.env = env;
    this.logger = logger;
  }

  /**
   * Get the Stacks network instance based on environment
   */
  private getNetwork() {
    return this.env.STACKS_NETWORK === "mainnet"
      ? STACKS_MAINNET
      : STACKS_TESTNET;
  }

  /**
   * Validate and deserialize a transaction
   */
  validateTransaction(txHex: string): TransactionValidationResult {
    // Remove 0x prefix if present
    const cleanHex = txHex.startsWith("0x") ? txHex.slice(2) : txHex;

    // Deserialize the transaction
    let transaction: StacksTransactionWire;
    try {
      transaction = deserializeTransaction(cleanHex);
    } catch (e) {
      this.logger.warn("Failed to deserialize transaction", {
        error: e instanceof Error ? e.message : "Unknown error",
      });
      return {
        valid: false,
        error: "Invalid transaction",
        details: "Could not deserialize transaction hex",
      };
    }

    // Verify it's a sponsored transaction
    if (transaction.auth.authType !== AuthType.Sponsored) {
      this.logger.warn("Transaction not sponsored", {
        auth_type: transaction.auth.authType,
      });
      return {
        valid: false,
        error: "Transaction must be sponsored",
        details: "Build transaction with sponsored: true",
      };
    }

    // Extract sender address for rate limiting
    const senderAddress = Buffer.from(
      transaction.auth.spendingCondition.signer
    ).toString("hex");

    return {
      valid: true,
      transaction,
      senderAddress,
    };
  }

  /**
   * Sponsor a validated transaction
   */
  async sponsorTransaction(
    transaction: StacksTransactionWire
  ): Promise<SponsorResult> {
    if (!this.env.SPONSOR_PRIVATE_KEY) {
      this.logger.error("Sponsor key not configured");
      return {
        success: false,
        error: "Service not configured",
        details: "Sponsor key missing",
      };
    }

    const network = this.getNetwork();

    try {
      const sponsoredTx = await sponsorTransaction({
        transaction,
        sponsorPrivateKey: this.env.SPONSOR_PRIVATE_KEY,
        network,
      });

      // v7: serialize() returns hex string directly
      const sponsoredTxHex = sponsoredTx.serialize();

      // Extract fee from the sponsor's spending condition
      // For sponsored transactions, the fee is set by the sponsor
      let fee = "0";
      if (
        sponsoredTx.auth.authType === AuthType.Sponsored &&
        "sponsorSpendingCondition" in sponsoredTx.auth
      ) {
        fee = sponsoredTx.auth.sponsorSpendingCondition.fee.toString();
      }

      this.logger.info("Transaction sponsored", { fee });

      return {
        success: true,
        sponsoredTxHex,
        fee,
      };
    } catch (e) {
      this.logger.error("Failed to sponsor transaction", {
        error: e instanceof Error ? e.message : "Unknown error",
      });
      return {
        success: false,
        error: "Failed to sponsor transaction",
        details: e instanceof Error ? e.message : "Unknown error",
      };
    }
  }
}
