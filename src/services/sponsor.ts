import {
  sponsorTransaction,
  deserializeTransaction,
  AuthType,
  type StacksTransactionWire,
} from "@stacks/transactions";
import { STACKS_MAINNET, STACKS_TESTNET } from "@stacks/network";
import type { Env, Logger } from "../types";

/**
 * Result of transaction validation
 */
export interface ValidationResult {
  valid: boolean;
  transaction?: StacksTransactionWire;
  senderAddress?: string;
  error?: string;
  details?: string;
}

/**
 * Result of transaction sponsoring
 */
export interface SponsorResult {
  success: boolean;
  sponsoredTxHex?: string;
  error?: string;
  details?: string;
}

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
  validateTransaction(txHex: string): ValidationResult {
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

      const sponsoredTxHex = Buffer.from(sponsoredTx.serialize()).toString(
        "hex"
      );

      return {
        success: true,
        sponsoredTxHex,
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
