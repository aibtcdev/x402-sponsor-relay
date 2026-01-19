import {
  sponsorTransaction,
  deserializeTransaction,
  AuthType,
  type StacksTransactionWire,
} from "@stacks/transactions";
import { STACKS_MAINNET, STACKS_TESTNET } from "@stacks/network";
import {
  generateNewAccount,
  generateWallet,
} from "@stacks/wallet-sdk";
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

// Module-level cache for derived sponsor key (persists across requests in same worker instance)
let cachedSponsorKey: string | null = null;
let cachedMnemonicHash: string | null = null;

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
   * Derive private key from mnemonic phrase
   * Results are cached at module level to avoid re-derivation per request
   */
  private async deriveSponsorKey(): Promise<string | null> {
    if (!this.env.SPONSOR_MNEMONIC) {
      return null;
    }

    // Simple hash to detect mnemonic changes (just use first/last words + length)
    const mnemonicHash = `${this.env.SPONSOR_MNEMONIC.slice(0, 20)}-${this.env.SPONSOR_MNEMONIC.length}`;

    // Return cached key if mnemonic hasn't changed
    if (cachedSponsorKey && cachedMnemonicHash === mnemonicHash) {
      return cachedSponsorKey;
    }

    const accountIndex = parseInt(this.env.SPONSOR_ACCOUNT_INDEX || "0", 10);

    this.logger.info("Deriving sponsor key from mnemonic", { accountIndex });

    try {
      const wallet = await generateWallet({
        secretKey: this.env.SPONSOR_MNEMONIC,
        password: "",
      });

      // Generate accounts up to the needed index
      for (let i = wallet.accounts.length; i <= accountIndex; i++) {
        generateNewAccount(wallet);
      }

      const account = wallet.accounts[accountIndex];
      if (!account) {
        this.logger.error("Failed to derive account", { accountIndex });
        return null;
      }

      // Cache the derived key
      cachedSponsorKey = account.stxPrivateKey;
      cachedMnemonicHash = mnemonicHash;

      this.logger.info("Sponsor key derived successfully");
      return cachedSponsorKey;
    } catch (e) {
      this.logger.error("Failed to derive sponsor key from mnemonic", {
        error: e instanceof Error ? e.message : "Unknown error",
      });
      return null;
    }
  }

  /**
   * Get the sponsor private key (from mnemonic or direct config)
   */
  private async getSponsorKey(): Promise<string | null> {
    // Prefer mnemonic derivation
    if (this.env.SPONSOR_MNEMONIC) {
      return this.deriveSponsorKey();
    }

    // Fall back to direct private key
    if (this.env.SPONSOR_PRIVATE_KEY) {
      return this.env.SPONSOR_PRIVATE_KEY;
    }

    return null;
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
    const sponsorKey = await this.getSponsorKey();

    if (!sponsorKey) {
      this.logger.error("Sponsor key not configured");
      return {
        success: false,
        error: "Service not configured",
        details: "Set SPONSOR_MNEMONIC or SPONSOR_PRIVATE_KEY",
      };
    }

    const network = this.getNetwork();

    try {
      const sponsoredTx = await sponsorTransaction({
        transaction,
        sponsorPrivateKey: sponsorKey,
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
        const sponsorFee = sponsoredTx.auth.sponsorSpendingCondition.fee;
        const sponsorFeeStr = sponsorFee.toString();
        // Defensive check for negative fees
        if (sponsorFeeStr.startsWith("-")) {
          this.logger.warn(
            "Negative fee detected in sponsored transaction; using fee of 0 instead",
            { rawFee: sponsorFeeStr }
          );
        } else {
          fee = sponsorFeeStr;
        }
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
