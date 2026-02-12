import { BaseEndpoint } from "./BaseEndpoint";
import { ReceiptService } from "../services";
import type { AppContext, AccessRequest, AccessSuccessResponse } from "../types";
import { Error400Response, Error404Response, Error500Response, Error502Response } from "../schemas";

/**
 * Access endpoint - access protected resources with payment receipt
 * POST /access
 */
export class Access extends BaseEndpoint {
  schema = {
    tags: ["Access"],
    summary: "Access protected resource with receipt",
    description:
      "Present a payment receipt to access a protected resource. The relay validates the receipt (exists, not expired/consumed, resource matches) and either returns data directly or proxies to a downstream service with the sponsored tx hex as X-Payment header. Marks receipt as consumed after successful access.",
    request: {
      body: {
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              properties: {
                receiptId: {
                  type: "string" as const,
                  format: "uuid",
                  description: "Receipt ID from a successful relay transaction",
                },
                resource: {
                  type: "string" as const,
                  description: "Resource path being accessed (must match receipt)",
                },
                targetUrl: {
                  type: "string" as const,
                  format: "uri",
                  description: "Optional downstream service URL for proxying",
                },
              },
              required: ["receiptId"],
            },
          },
        },
      },
    },
    responses: {
      "200": {
        description: "Access granted",
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              properties: {
                success: { type: "boolean" as const, example: true },
                requestId: { type: "string" as const, format: "uuid" },
                granted: { type: "boolean" as const, example: true },
                receipt: {
                  type: "object" as const,
                  properties: {
                    receiptId: { type: "string" as const },
                    senderAddress: { type: "string" as const },
                    resource: { type: "string" as const },
                    accessCount: { type: "number" as const },
                  },
                },
                data: {
                  type: "object" as const,
                  description: "Resource data (if relay-hosted)",
                },
                proxy: {
                  type: "object" as const,
                  description: "Proxy response (if targetUrl provided)",
                  properties: {
                    status: { type: "number" as const },
                    statusText: { type: "string" as const },
                    headers: { type: "object" as const },
                    body: { type: "object" as const },
                  },
                },
              },
            },
          },
        },
      },
      "400": Error400Response,
      "404": Error404Response,
      "500": Error500Response,
      "502": Error502Response,
    },
  };

  async handle(c: AppContext) {
    const logger = this.getLogger(c);

    try {
      // Parse request body
      const body = (await c.req.json()) as AccessRequest;

      // Validate receiptId
      if (!body.receiptId) {
        return this.err(c, {
          error: "Missing receipt ID",
          code: "MISSING_RECEIPT_ID",
          status: 400,
          retryable: false,
        });
      }

      logger.info("Access request", {
        receiptId: body.receiptId,
        resource: body.resource,
        hasTargetUrl: !!body.targetUrl,
      });

      // Retrieve receipt
      const receiptService = new ReceiptService(c.env.RELAY_KV, logger);
      const receipt = await receiptService.getReceipt(body.receiptId);

      if (!receipt) {
        return this.err(c, {
          error: "Receipt not found or expired",
          code: "NOT_FOUND",
          status: 404,
          retryable: false,
        });
      }

      // Check if receipt is consumed
      if (receipt.consumed) {
        return this.err(c, {
          error: "Receipt has already been consumed",
          code: "RECEIPT_CONSUMED",
          status: 400,
          details: "This receipt has already been used for access",
          retryable: false,
        });
      }

      // Verify resource matches if provided
      if (body.resource && receipt.settleOptions.resource !== body.resource) {
        return this.err(c, {
          error: "Resource mismatch",
          code: "RESOURCE_MISMATCH",
          status: 400,
          details: `Receipt is for resource '${receipt.settleOptions.resource}', not '${body.resource}'`,
          retryable: false,
        });
      }

      // If targetUrl is provided, proxy the request
      if (body.targetUrl) {
        // Validate targetUrl to prevent SSRF - only allow HTTPS to public hosts
        let parsedUrl: URL;
        try {
          parsedUrl = new URL(body.targetUrl);
        } catch {
          return this.err(c, {
            error: "Invalid target URL",
            code: "INVALID_RECEIPT",
            status: 400,
            retryable: false,
          });
        }

        if (parsedUrl.protocol !== "https:") {
          return this.err(c, {
            error: "Target URL must use HTTPS",
            code: "INVALID_RECEIPT",
            status: 400,
            retryable: false,
          });
        }

        // Block internal/private hostnames
        const hostname = parsedUrl.hostname.toLowerCase();
        const blockedPatterns = ["localhost", "127.0.0.1", "0.0.0.0", "[::1]", ".local", ".internal"];
        if (blockedPatterns.some((p) => hostname === p || hostname.endsWith(p))) {
          return this.err(c, {
            error: "Target URL must not point to internal hosts",
            code: "INVALID_RECEIPT",
            status: 400,
            retryable: false,
          });
        }

        logger.info("Proxying request to downstream service", {
          receiptId: body.receiptId,
          targetUrl: body.targetUrl,
        });

        try {
          const proxyResponse = await fetch(body.targetUrl, {
            method: receipt.settleOptions.method || "GET",
            headers: {
              "X-Payment": receipt.sponsoredTx,
              "Content-Type": "application/json",
            },
          });

          const proxyBody = await proxyResponse.text();
          let parsedBody: unknown;
          try {
            parsedBody = JSON.parse(proxyBody);
          } catch {
            parsedBody = proxyBody;
          }

          // Only consume receipt on successful downstream response
          if (!proxyResponse.ok) {
            logger.warn("Downstream service returned error, receipt NOT consumed", {
              receiptId: body.receiptId,
              proxyStatus: proxyResponse.status,
            });
            return this.err(c, {
              error: "Downstream service returned an error",
              code: "PROXY_FAILED",
              status: 502,
              details: `Downstream returned ${proxyResponse.status} ${proxyResponse.statusText}`,
              retryable: true,
            });
          }

          // Mark receipt as consumed only after successful downstream response
          await receiptService.markConsumed(body.receiptId);

          logger.info("Access granted via proxy", {
            receiptId: body.receiptId,
            proxyStatus: proxyResponse.status,
            accessCount: receipt.accessCount + 1,
          });

          const response: AccessSuccessResponse = {
            success: true,
            requestId: this.getRequestId(c),
            granted: true,
            receipt: {
              receiptId: receipt.receiptId,
              senderAddress: receipt.senderAddress,
              resource: receipt.settleOptions.resource,
              accessCount: receipt.accessCount + 1,
            },
            proxy: {
              status: proxyResponse.status,
              statusText: proxyResponse.statusText,
              headers: Object.fromEntries(proxyResponse.headers.entries()),
              body: parsedBody,
            },
          };

          return c.json(response);
        } catch (e) {
          logger.error("Proxy request failed", {
            receiptId: body.receiptId,
            targetUrl: body.targetUrl,
            error: e instanceof Error ? e.message : "Unknown error",
          });
          return this.err(c, {
            error: "Failed to proxy request to downstream service",
            code: "PROXY_FAILED",
            status: 502,
            details: e instanceof Error ? e.message : "Unknown error",
            retryable: true,
          });
        }
      }

      // No targetUrl - return relay-hosted resource data
      // For now, return mock data acknowledging access
      const mockData = {
        message: "Access granted to relay-hosted resource",
        resource: receipt.settleOptions.resource || "default",
        timestamp: new Date().toISOString(),
        payment: {
          txid: receipt.txid,
          amount: receipt.settlement.amount,
          sender: receipt.senderAddress,
          recipient: receipt.settlement.recipient,
        },
      };

      // Mark receipt as consumed
      await receiptService.markConsumed(body.receiptId);

      logger.info("Access granted (relay-hosted)", {
        receiptId: body.receiptId,
        resource: receipt.settleOptions.resource,
        accessCount: receipt.accessCount + 1,
      });

      const response: AccessSuccessResponse = {
        success: true,
        requestId: this.getRequestId(c),
        granted: true,
        receipt: {
          receiptId: receipt.receiptId,
          senderAddress: receipt.senderAddress,
          resource: receipt.settleOptions.resource,
          accessCount: receipt.accessCount + 1,
        },
        data: mockData,
      };

      return c.json(response);
    } catch (e) {
      logger.error("Access request failed", {
        error: e instanceof Error ? e.message : "Unknown error",
      });
      return this.err(c, {
        error: "Internal server error",
        code: "INTERNAL_ERROR",
        status: 500,
        details: e instanceof Error ? e.message : "Unknown error",
        retryable: true,
      });
    }
  }
}
