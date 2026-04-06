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
import {
  SBTC_CONTRACT_MAINNET,
  SBTC_CONTRACT_NAME,
  USDCX_CIRCLE_CONTRACT_MAINNET,
  USDCX_CIRCLE_CONTRACT_NAME,
  USDCX_AEUSDC_CONTRACT_MAINNET,
  USDCX_AEUSDC_CONTRACT_NAME,
  SIP010_TRANSFER_FUNCTION,
} from "./token-contracts";

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
 * On mainnet, sBTC has a fixed deployer address — require address+name match.
 * On testnet, any deployer can deploy sbtc-token, so match by name only
 * (mirrors settlement.ts matchTokenContract behavior).
 */
function isKnownSbtc(address: string, contractName: string, network: "mainnet" | "testnet"): boolean {
  if (contractName !== SBTC_CONTRACT_NAME) return false;
  if (network === "mainnet") return address.toUpperCase() === SBTC_CONTRACT_MAINNET;
  return true;
}

/**
 * Detect whether a contract is a known USDCx contract.
 *
 * On mainnet, require exact deployer+name pair match.
 * On testnet, allow name-only matching for any deployer.
 */
function isKnownUsdcx(address: string, contractName: string, network: "mainnet" | "testnet"): boolean {
  const upper = address.toUpperCase();
  // Exact mainnet deployer+name match
  if (
    (upper === USDCX_CIRCLE_CONTRACT_MAINNET && contractName === USDCX_CIRCLE_CONTRACT_NAME) ||
    (upper === USDCX_AEUSDC_CONTRACT_MAINNET && contractName === USDCX_AEUSDC_CONTRACT_NAME)
  ) {
    return true;
  }
  // Testnet fallback: match by contract name only
  if (network === "testnet") {
    return contractName === USDCX_CIRCLE_CONTRACT_NAME || contractName === USDCX_AEUSDC_CONTRACT_NAME;
  }
  return false;
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
 *
 * @param tx - Deserialized Stacks transaction
 * @param network - Network context for token contract matching (mainnet requires deployer address)
 */
export function extractTransferDetails(tx: StacksTransactionWire, network: "mainnet" | "testnet" = "testnet"): TransferDetails {
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
      if (isKnownSbtc(contractAddress, contractName, network)) {
        tokenType = "sBTC";
      } else if (isKnownUsdcx(contractAddress, contractName, network)) {
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
