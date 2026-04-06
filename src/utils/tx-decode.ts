/**
 * Transaction payload decode utilities.
 *
 * Extracts token type and transfer amount from a deserialized Stacks transaction
 * without requiring full payment verification. Used by /sponsor to record accurate
 * token attribution in stats rather than falling back to STX/0.
 */
import {
  PayloadType,
  ClarityType,
  addressToString,
  type StacksTransactionWire,
  type AddressWire,
  type LengthPrefixedStringWire,
  type ClarityValue,
} from "@stacks/transactions";
import type { TokenType } from "../types";

// Known SIP-010 token contract addresses (mirrors settlement.ts)
const SBTC_CONTRACT_NAME = "sbtc-token";

const USDCX_CIRCLE_CONTRACT_MAINNET = "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE";
const USDCX_CIRCLE_CONTRACT_NAME = "usdcx";
const USDCX_AEUSDC_CONTRACT_MAINNET = "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9";
const USDCX_AEUSDC_CONTRACT_NAME = "token-aeusdc";

const SIP010_TRANSFER_FUNCTION = "transfer";

/**
 * Result of extracting transfer details from a deserialized transaction.
 */
export interface TransferDetails {
  tokenType: TokenType;
  amount: string;
}

/** Fallback for unrecognized or unparseable payloads. */
const FALLBACK: TransferDetails = { tokenType: "STX", amount: "0" };

/**
 * Detect whether a contract is a known sBTC contract.
 *
 * On mainnet, sBTC has a fixed deployer address. On testnet, any deployer can
 * deploy sbtc-token, so we match by contract name only (same approach as
 * settlement.ts matchTokenContract in testnet mode).
 */
function isKnownSbtc(contractName: string): boolean {
  return contractName === SBTC_CONTRACT_NAME;
}

/**
 * Detect whether a contract is a known USDCx contract.
 *
 * Accepts both mainnet deployer+name pairs and testnet lookalikes by name.
 */
function isKnownUsdcx(address: string, contractName: string): boolean {
  const upper = address.toUpperCase();
  // Exact mainnet match
  if (
    (upper === USDCX_CIRCLE_CONTRACT_MAINNET && contractName === USDCX_CIRCLE_CONTRACT_NAME) ||
    (upper === USDCX_AEUSDC_CONTRACT_MAINNET && contractName === USDCX_AEUSDC_CONTRACT_NAME)
  ) {
    return true;
  }
  // Testnet fallback: match by contract name only
  return contractName === USDCX_CIRCLE_CONTRACT_NAME || contractName === USDCX_AEUSDC_CONTRACT_NAME;
}

/**
 * Extract token type and transfer amount from a deserialized Stacks transaction.
 *
 * Handles:
 * - TokenTransfer (STX): reads amount directly from payload
 * - ContractCall with known SIP-010 transfer function: reads amount from functionArgs[0]
 * - Fallback for unrecognized payloads: returns { tokenType: "STX", amount: "0" }
 *
 * Never throws — all extraction is wrapped in try/catch.
 */
export function extractTransferDetails(tx: StacksTransactionWire): TransferDetails {
  try {
    const payloadType = tx.payload.payloadType;

    if (payloadType === PayloadType.TokenTransfer) {
      // STX transfer: amount is a bigint in @stacks/transactions v7+
      const amount = (tx.payload.amount as bigint).toString();
      return { tokenType: "STX", amount };
    }

    if (payloadType === PayloadType.ContractCall) {
      // Extract contract identity
      const contractAddress = addressToString(
        tx.payload.contractAddress as unknown as AddressWire
      );
      const contractName = (
        tx.payload.contractName as unknown as LengthPrefixedStringWire
      ).content;
      const functionName = (
        tx.payload.functionName as unknown as LengthPrefixedStringWire
      ).content;

      // Only support SIP-010 transfer function for token identification
      if (functionName !== SIP010_TRANSFER_FUNCTION) {
        return FALLBACK;
      }

      // Determine token type
      let tokenType: TokenType;
      if (isKnownSbtc(contractName)) {
        tokenType = "sBTC";
      } else if (isKnownUsdcx(contractAddress, contractName)) {
        tokenType = "USDCx";
      } else {
        // Unrecognized token contract — fall back
        return FALLBACK;
      }

      // SIP-010 transfer args: [amount (uint), from (principal), to (principal), memo (optional)]
      const args = tx.payload.functionArgs as ClarityValue[];
      if (!args || args.length < 1) {
        return { tokenType, amount: "0" };
      }

      const amountCV = args[0];
      if (amountCV.type !== ClarityType.UInt) {
        return { tokenType, amount: "0" };
      }

      return { tokenType, amount: String(amountCV.value) };
    }

    return FALLBACK;
  } catch {
    return FALLBACK;
  }
}
