/**
 * InboxService — builds and broadcasts contract-calls to the arc-inbox contract.
 *
 * After validating an x402 payment, this service constructs a `post-message`
 * contract-call signed by the sponsor wallet and broadcasts it to the Stacks
 * network. The sponsor wallet becomes tx-sender on-chain, acting as the
 * relay intermediary. The payment tx proves who actually sent the message.
 */

import {
  makeContractCall,
  getAddressFromPrivateKey,
  stringUtf8CV,
  type StacksTransactionWire,
} from "@stacks/transactions";
import { STACKS_MAINNET, STACKS_TESTNET } from "@stacks/network";
import {
  generateWallet,
} from "@stacks/wallet-sdk";
import type { Env, Logger } from "../types";
import { getHiroBaseUrl, getHiroHeaders } from "../utils";

/**
 * arc-inbox contract addresses per network.
 * Deployer: SP2GHQRCRMYY4S8PMBR49BEKX144VR437YT42SF3B (arc0.btc)
 */
const ARC_INBOX_CONTRACT = {
  mainnet: {
    address: "SP2GHQRCRMYY4S8PMBR49BEKX144VR437YT42SF3B",
    name: "arc-inbox",
  },
  testnet: {
    address: "ST2GHQRCRMYY4S8PMBR49BEKX144VR437YMPD0AEH",
    name: "arc-inbox",
  },
} as const;

/** Maximum message content length (matches contract's string-utf8 1024) */
export const MAX_CONTENT_LENGTH = 1024;

/** Minimum payment: 1 STX = 1_000_000 microSTX */
export const MIN_PAYMENT_STX = "1000000";

/** Minimum payment: 1000 sats sBTC */
export const MIN_PAYMENT_SBTC = "1000";

/** Timeout for Hiro API read-only call (ms) */
const HIRO_READ_TIMEOUT_MS = 10_000;
/** Timeout for Hiro API nonce fetch (ms) */
const HIRO_NONCE_TIMEOUT_MS = 10_000;
/** Timeout for Hiro API broadcast (ms) */
const HIRO_BROADCAST_TIMEOUT_MS = 12_000;
/** Timeout for Hiro API poll (ms) */
const HIRO_POLL_TIMEOUT_MS = 10_000;

/** Polling configuration */
const MAX_POLL_TIME_MS = 30_000;
const INITIAL_POLL_DELAY_MS = 2_000;
const POLL_BACKOFF_FACTOR = 1.5;
const MAX_POLL_DELAY_MS = 8_000;

/** Broadcast retry configuration */
const BROADCAST_MAX_ATTEMPTS = 3;
const BROADCAST_RETRY_BASE_DELAY_MS = 1_000;
const BROADCAST_RETRY_MAX_DELAY_MS = 2_000;

export interface InboxPostResult {
  success: true;
  inboxTxid: string;
  messageId: number;
  status: "pending" | "confirmed";
  blockHeight?: number;
}

export interface InboxPostFailure {
  success: false;
  error: string;
  details: string;
  retryable: boolean;
}

export type InboxPostOutcome = InboxPostResult | InboxPostFailure;

/**
 * Module-level cache for derived keys (same pattern as SponsorService).
 * Worker instances restart on secret updates — safe to cache indefinitely.
 */
const cachedInboxKeys: Map<number, string> = new Map();

export class InboxService {
  private env: Env;
  private logger: Logger;

  constructor(env: Env, logger: Logger) {
    this.env = env;
    this.logger = logger;
  }

  private getNetwork() {
    return this.env.STACKS_NETWORK === "mainnet"
      ? STACKS_MAINNET
      : STACKS_TESTNET;
  }

  private getContract() {
    return ARC_INBOX_CONTRACT[this.env.STACKS_NETWORK];
  }

  /**
   * Derive the sponsor wallet private key for inbox contract-calls.
   * Uses wallet index 0 (primary sponsor wallet).
   */
  private async getSponsorKey(): Promise<string | null> {
    const cached = cachedInboxKeys.get(0);
    if (cached) return cached;

    if (this.env.SPONSOR_MNEMONIC) {
      const words = this.env.SPONSOR_MNEMONIC.trim().split(/\s+/);
      if (words.length !== 12 && words.length !== 24) {
        this.logger.error("Invalid SPONSOR_MNEMONIC for inbox service");
        return null;
      }
      try {
        const wallet = await generateWallet({
          secretKey: this.env.SPONSOR_MNEMONIC,
          password: "",
        });
        const account = wallet.accounts[0];
        if (!account) return null;
        cachedInboxKeys.set(0, account.stxPrivateKey);
        return account.stxPrivateKey;
      } catch (e) {
        this.logger.error("Failed to derive inbox sponsor key", {
          error: e instanceof Error ? e.message : String(e),
        });
        return null;
      }
    }

    if (this.env.SPONSOR_PRIVATE_KEY) {
      cachedInboxKeys.set(0, this.env.SPONSOR_PRIVATE_KEY);
      return this.env.SPONSOR_PRIVATE_KEY;
    }

    return null;
  }

  /**
   * Fetch the current message-count from the arc-inbox contract.
   * Returns null if the read-only call fails (contract may not be deployed).
   */
  async getMessageCount(): Promise<number | null> {
    const contract = this.getContract();
    const hiroBase = getHiroBaseUrl(this.env.STACKS_NETWORK);
    const url = `${hiroBase}/v2/contracts/call-read/${contract.address}/${contract.name}/get-message-count`;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...getHiroHeaders(this.env.HIRO_API_KEY),
        },
        body: JSON.stringify({
          sender: contract.address,
          arguments: [],
        }),
        signal: AbortSignal.timeout(HIRO_READ_TIMEOUT_MS),
      });

      if (!response.ok) {
        this.logger.warn("Failed to read message-count from contract", {
          status: response.status,
        });
        return null;
      }

      const data = (await response.json()) as {
        okay?: boolean;
        result?: string;
      };

      if (!data.okay || !data.result) {
        this.logger.warn("Contract read-only call returned not-okay", { data });
        return null;
      }

      // Result is a Clarity hex value. For uint, format is 0x0100000000000000000000000000000005
      // Type prefix 01 = uint, followed by 16 hex chars (128-bit big-endian)
      const hex = data.result.replace("0x", "");
      if (hex.startsWith("01") && hex.length === 34) {
        const valueHex = hex.slice(2); // strip type prefix
        return Number(BigInt("0x" + valueHex));
      }

      this.logger.warn("Unexpected message-count result format", {
        result: data.result,
      });
      return null;
    } catch (e) {
      this.logger.warn("Error fetching message-count", {
        error: e instanceof Error ? e.message : String(e),
      });
      return null;
    }
  }

  /**
   * Fetch the current nonce for the sponsor wallet from Hiro API.
   * Uses direct Hiro fetch (not NonceDO) to avoid nonce pool conflicts
   * with the main sponsoring flow.
   */
  private async fetchNonce(address: string): Promise<bigint | null> {
    const url = `${getHiroBaseUrl(this.env.STACKS_NETWORK)}/v2/accounts/${address}?proof=0`;
    try {
      const response = await fetch(url, {
        headers: getHiroHeaders(this.env.HIRO_API_KEY),
        signal: AbortSignal.timeout(HIRO_NONCE_TIMEOUT_MS),
      });
      if (!response.ok) {
        this.logger.warn("Failed to fetch nonce for inbox tx", {
          status: response.status,
        });
        return null;
      }
      const data = (await response.json()) as { nonce?: number };
      if (typeof data?.nonce !== "number") return null;
      return BigInt(data.nonce);
    } catch (e) {
      this.logger.warn("Error fetching inbox nonce", {
        error: e instanceof Error ? e.message : String(e),
      });
      return null;
    }
  }

  /**
   * Build, sign, and broadcast a contract-call to arc-inbox.post-message.
   *
   * The sponsor wallet (index 0) is the signer — it becomes tx-sender on-chain.
   * This is a regular (non-sponsored) transaction; the relay pays its own fee.
   */
  async postMessage(content: string): Promise<InboxPostOutcome> {
    // Validate content
    if (!content || content.length === 0) {
      return {
        success: false,
        error: "Empty message content",
        details: "Content must not be empty",
        retryable: false,
      };
    }
    if (content.length > MAX_CONTENT_LENGTH) {
      return {
        success: false,
        error: "Message content too long",
        details: `Content length ${content.length} exceeds maximum ${MAX_CONTENT_LENGTH}`,
        retryable: false,
      };
    }

    // Get sponsor key
    const sponsorKey = await this.getSponsorKey();
    if (!sponsorKey) {
      return {
        success: false,
        error: "Inbox service not configured",
        details: "Set SPONSOR_MNEMONIC or SPONSOR_PRIVATE_KEY",
        retryable: false,
      };
    }

    const network = this.getNetwork();
    const contract = this.getContract();
    const senderAddress = getAddressFromPrivateKey(sponsorKey, network);

    // Fetch nonce
    const nonce = await this.fetchNonce(senderAddress);
    if (nonce === null) {
      return {
        success: false,
        error: "Failed to fetch nonce for inbox transaction",
        details: "Could not determine nonce from Hiro API",
        retryable: true,
      };
    }

    // Get current message count for estimated messageId
    const currentCount = await this.getMessageCount();
    const estimatedMessageId = currentCount !== null ? currentCount + 1 : 0;

    // Build the contract-call transaction
    let transaction: StacksTransactionWire;
    try {
      transaction = await makeContractCall({
        contractAddress: contract.address,
        contractName: contract.name,
        functionName: "post-message",
        functionArgs: [stringUtf8CV(content)],
        senderKey: sponsorKey,
        network,
        nonce,
      });
    } catch (e) {
      this.logger.error("Failed to build inbox contract-call", {
        error: e instanceof Error ? e.message : String(e),
      });
      return {
        success: false,
        error: "Failed to build contract-call",
        details: e instanceof Error ? e.message : String(e),
        retryable: false,
      };
    }

    // Broadcast
    const broadcastResult = await this.broadcastAndPoll(transaction);
    if (!broadcastResult.success) {
      return broadcastResult;
    }

    return {
      success: true,
      inboxTxid: broadcastResult.txid,
      messageId: estimatedMessageId,
      status: broadcastResult.status,
      blockHeight: broadcastResult.blockHeight,
    };
  }

  /**
   * Broadcast a signed transaction and poll for confirmation.
   * Simplified version of SettlementService.broadcastAndConfirm for
   * relay-originated transactions.
   */
  private async broadcastAndPoll(
    transaction: StacksTransactionWire
  ): Promise<
    | { success: true; txid: string; status: "pending" | "confirmed"; blockHeight?: number }
    | { success: false; error: string; details: string; retryable: boolean }
  > {
    const txHex = transaction.serialize();
    if (typeof txHex !== "string" || txHex.length === 0) {
      return {
        success: false,
        error: "Failed to serialize transaction",
        details: "Serialized transaction is empty",
        retryable: false,
      };
    }

    const bytePairs = txHex.match(/.{2}/g);
    if (!bytePairs) {
      return {
        success: false,
        error: "Failed to serialize transaction",
        details: "Could not convert hex to bytes",
        retryable: false,
      };
    }
    const txBytes = new Uint8Array(bytePairs.map((b) => parseInt(b, 16)));

    const hiroBaseUrl = getHiroBaseUrl(this.env.STACKS_NETWORK);
    const broadcastUrl = `${hiroBaseUrl}/v2/transactions`;
    const headers: Record<string, string> = {
      "Content-Type": "application/octet-stream",
      ...getHiroHeaders(this.env.HIRO_API_KEY),
    };

    let txid = "";

    // Broadcast with retries
    for (let attempt = 1; attempt <= BROADCAST_MAX_ATTEMPTS; attempt++) {
      try {
        const response = await fetch(broadcastUrl, {
          method: "POST",
          headers,
          body: txBytes,
          signal: AbortSignal.timeout(HIRO_BROADCAST_TIMEOUT_MS),
        });

        const responseText = await response.text();

        if (response.ok) {
          try {
            txid = JSON.parse(responseText) as string;
          } catch {
            txid = responseText.trim().replace(/^"|"$/g, "");
          }
          this.logger.info("Inbox contract-call broadcast successful", { txid, attempt });
          break;
        }

        // 4xx: don't retry
        if (response.status >= 400 && response.status < 500) {
          return {
            success: false,
            error: "Inbox broadcast rejected",
            details: responseText.slice(0, 500),
            retryable: false,
          };
        }

        // 5xx: retry
        if (attempt < BROADCAST_MAX_ATTEMPTS) {
          const delay = attempt === 1
            ? BROADCAST_RETRY_BASE_DELAY_MS
            : BROADCAST_RETRY_MAX_DELAY_MS;
          await new Promise((r) => setTimeout(r, delay));
        }
      } catch (e) {
        if (attempt === BROADCAST_MAX_ATTEMPTS) {
          return {
            success: false,
            error: "Inbox broadcast failed",
            details: e instanceof Error ? e.message : String(e),
            retryable: true,
          };
        }
        const delay = attempt === 1
          ? BROADCAST_RETRY_BASE_DELAY_MS
          : BROADCAST_RETRY_MAX_DELAY_MS;
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    if (!txid) {
      return {
        success: false,
        error: "Inbox broadcast failed after all attempts",
        details: "No txid received",
        retryable: true,
      };
    }

    // Poll for confirmation (shorter timeout than relay — 30s)
    const pollUrl = `${hiroBaseUrl}/extended/v1/tx/${txid}`;
    const hiroHeaders = getHiroHeaders(this.env.HIRO_API_KEY);
    const startTime = Date.now();
    let delay = 0;

    while (true) {
      const elapsed = Date.now() - startTime;
      if (elapsed >= MAX_POLL_TIME_MS) {
        return { success: true, txid, status: "pending" };
      }

      if (delay > 0) {
        const remaining = MAX_POLL_TIME_MS - (Date.now() - startTime);
        if (remaining <= 0) break;
        await new Promise((r) => setTimeout(r, Math.min(delay, remaining)));
      }

      try {
        const remaining = MAX_POLL_TIME_MS - (Date.now() - startTime);
        if (remaining <= 0) break;
        const response = await fetch(pollUrl, {
          headers: hiroHeaders,
          signal: AbortSignal.timeout(Math.min(HIRO_POLL_TIMEOUT_MS, remaining)),
        });

        if (response.ok) {
          const data = (await response.json()) as {
            tx_status?: string;
            block_height?: number;
          };
          if (data.tx_status === "success" && typeof data.block_height === "number") {
            return {
              success: true,
              txid,
              status: "confirmed",
              blockHeight: data.block_height,
            };
          }
          if (data.tx_status?.startsWith("abort_")) {
            return {
              success: false,
              error: "Inbox transaction aborted on-chain",
              details: `tx_status: ${data.tx_status}`,
              retryable: false,
            };
          }
        }
      } catch {
        // Network error during polling — continue
      }

      delay = delay === 0 ? INITIAL_POLL_DELAY_MS : Math.min(delay * POLL_BACKOFF_FACTOR, MAX_POLL_DELAY_MS);
    }

    return { success: true, txid, status: "pending" };
  }
}
