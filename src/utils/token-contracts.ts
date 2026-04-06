/**
 * Shared SIP-010 token contract constants.
 *
 * Used by both settlement verification (settlement.ts) and transaction
 * payload decoding (tx-decode.ts) to identify known token contracts.
 */

// sBTC
export const SBTC_CONTRACT_MAINNET = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4";
export const SBTC_CONTRACT_NAME = "sbtc-token";

// USDCx — two known mainnet contracts that both represent USDC on Stacks
export const USDCX_CIRCLE_CONTRACT_MAINNET = "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE";
export const USDCX_CIRCLE_CONTRACT_NAME = "usdcx";
export const USDCX_AEUSDC_CONTRACT_MAINNET = "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9";
export const USDCX_AEUSDC_CONTRACT_NAME = "token-aeusdc";

// SIP-010 transfer function name
export const SIP010_TRANSFER_FUNCTION = "transfer";
