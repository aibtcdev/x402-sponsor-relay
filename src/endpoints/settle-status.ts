import { BaseEndpoint } from "./BaseEndpoint";
import { SettlementService } from "../services";
import { Error500Response } from "../schemas/responses";
import type { AppContext } from "../types";

/**
 * GET /settle/status/:txid
 *
 * Returns the relay's internal view of a transaction's settlement status.
 * Includes settlement status, wallet index, broadcast timestamp, and
 * optionally proxies the Hiro API tx status for comparison.
 */
export class SettleStatus extends BaseEndpoint {
  schema = {
    tags: ["x402 V2"],
    summary: "Get transaction settlement status",
    description:
      "Returns the relay's internal view of a previously-settled transaction. " +
      "Includes status (broadcast/pending/confirmed/failed), sponsor wallet info, " +
      "and timestamps. Pass ?live=true to also fetch the current Hiro API status.",
    responses: {
      "200": {
        description: "Transaction status found",
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              required: ["success", "txid", "status", "network", "broadcastAt"],
              properties: {
                success: { type: "boolean" as const },
                txid: { type: "string" as const },
                status: {
                  type: "string" as const,
                  enum: ["broadcast", "pending", "confirmed", "failed"],
                },
                payer: { type: "string" as const },
                network: { type: "string" as const },
                walletIndex: { type: "number" as const },
                sponsorNonce: { type: "number" as const, nullable: true },
                sponsorFee: { type: "string" as const },
                broadcastAt: { type: "string" as const },
                confirmedAt: { type: "string" as const },
                blockHeight: { type: "number" as const },
                errorReason: { type: "string" as const },
                hiroStatus: {
                  type: "object" as const,
                  nullable: true,
                  description: "Live Hiro API tx status (only when ?live=true)",
                  properties: {
                    txStatus: { type: "string" as const },
                    blockHeight: { type: "number" as const },
                  },
                },
              },
            },
          },
        },
      },
      "404": {
        description: "Transaction not found in relay records",
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              properties: {
                success: { type: "boolean" as const, example: false },
                error: { type: "string" as const },
              },
            },
          },
        },
      },
      "500": Error500Response,
    },
  };

  async handle(c: AppContext) {
    const logger = this.getLogger(c);
    // Normalize txid: accept with or without 0x prefix, store/lookup with 0x
    const rawTxid = c.req.param("txid")!;
    const txid = rawTxid.startsWith("0x") ? rawTxid : `0x${rawTxid}`;

    try {
      const settlementService = new SettlementService(c.env, logger);
      const record = await settlementService.getTxStatus(txid);

      if (!record) {
        return c.json({ success: false, error: "Transaction not found in relay records" }, 404);
      }

      // Optionally fetch live Hiro API status
      let hiroStatus: { txStatus: string; blockHeight?: number } | null = null;
      const live = c.req.query("live");
      if (live === "true") {
        hiroStatus = await settlementService.fetchHiroTxStatus(txid);
      }

      return c.json({
        success: true,
        txid: record.txid,
        status: record.status,
        payer: record.payer,
        network: record.network,
        walletIndex: record.walletIndex,
        sponsorNonce: record.sponsorNonce,
        sponsorFee: record.sponsorFee,
        broadcastAt: record.broadcastAt,
        confirmedAt: record.confirmedAt,
        blockHeight: record.blockHeight,
        errorReason: record.errorReason,
        ...(hiroStatus ? { hiroStatus } : {}),
      });
    } catch (e) {
      logger.error("Error fetching tx status", {
        txid,
        error: e instanceof Error ? e.message : String(e),
      });
      return c.json({ success: false, error: "Internal error" }, 500);
    }
  }
}
