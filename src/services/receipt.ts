import type { Logger, PaymentReceipt, SettlementResult, SettleOptions } from "../types";

const DEFAULT_RECEIPT_TTL_SECONDS = 2592000; // 30 days
const KV_PREFIX = "receipt:";

export class ReceiptService {
  constructor(
    private kv: KVNamespace | undefined,
    private logger: Logger
  ) {}

  /**
   * Store a payment receipt after successful settlement
   */
  async storeReceipt(data: {
    receiptId: string;
    senderAddress: string;
    sponsoredTx: string;
    fee: string;
    txid: string;
    settlement: SettlementResult;
    settleOptions: SettleOptions;
    ttlSeconds?: number;
  }): Promise<PaymentReceipt | null> {
    if (!this.kv) {
      this.logger.warn("RELAY_KV not available, skipping receipt storage");
      return null;
    }

    const ttl = data.ttlSeconds || DEFAULT_RECEIPT_TTL_SECONDS;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttl * 1000);

    const receipt: PaymentReceipt = {
      receiptId: data.receiptId,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      senderAddress: data.senderAddress,
      sponsoredTx: data.sponsoredTx,
      fee: data.fee,
      txid: data.txid,
      settlement: data.settlement,
      settleOptions: data.settleOptions,
      consumed: false,
      accessCount: 0,
    };

    try {
      await this.kv.put(
        `${KV_PREFIX}${data.receiptId}`,
        JSON.stringify(receipt),
        { expirationTtl: ttl }
      );
      this.logger.info("Payment receipt stored", {
        receiptId: data.receiptId,
        senderAddress: data.senderAddress,
        txid: data.txid,
        expiresAt: expiresAt.toISOString(),
      });
      return receipt;
    } catch (e) {
      this.logger.error("Failed to store payment receipt", {
        receiptId: data.receiptId,
        error: e instanceof Error ? e.message : "Unknown error",
      });
      return null;
    }
  }

  /**
   * Retrieve a payment receipt by ID
   * Returns null if not found or expired
   */
  async getReceipt(receiptId: string): Promise<PaymentReceipt | null> {
    if (!this.kv) {
      this.logger.warn("RELAY_KV not available, cannot retrieve receipt");
      return null;
    }

    try {
      const receipt = await this.kv.get<PaymentReceipt>(
        `${KV_PREFIX}${receiptId}`,
        "json"
      );
      return receipt;
    } catch (e) {
      this.logger.error("Failed to retrieve payment receipt", {
        receiptId,
        error: e instanceof Error ? e.message : "Unknown error",
      });
      return null;
    }
  }

  /**
   * Mark a receipt as consumed (for one-time-use access patterns)
   * Increments accessCount and optionally sets consumed=true
   */
  async markConsumed(
    receiptId: string,
    setConsumed: boolean = true
  ): Promise<boolean> {
    if (!this.kv) {
      return false;
    }

    try {
      const receipt = await this.getReceipt(receiptId);
      if (!receipt) {
        return false;
      }

      receipt.accessCount += 1;
      if (setConsumed) {
        receipt.consumed = true;
      }

      // Preserve remaining TTL
      const remainingMs = new Date(receipt.expiresAt).getTime() - Date.now();
      const remainingSeconds = Math.max(Math.ceil(remainingMs / 1000), 1);

      await this.kv.put(
        `${KV_PREFIX}${receiptId}`,
        JSON.stringify(receipt),
        { expirationTtl: remainingSeconds }
      );

      this.logger.debug("Receipt marked as consumed", {
        receiptId,
        accessCount: receipt.accessCount,
        consumed: receipt.consumed,
      });

      return true;
    } catch (e) {
      this.logger.error("Failed to mark receipt as consumed", {
        receiptId,
        error: e instanceof Error ? e.message : "Unknown error",
      });
      return false;
    }
  }
}
