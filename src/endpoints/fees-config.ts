import { BaseEndpoint } from "./BaseEndpoint";
import { FeeService } from "../services";
import type { AppContext, FeeClampConfig, FeeTransactionType } from "../types";
import {
  Error400Response,
  Error401Response,
  Error500Response,
} from "../schemas";

/**
 * Fees Config endpoint - update clamp configuration
 * POST /fees/config
 *
 * Allows admins with API keys to update the fee clamp configuration
 * stored in KV without requiring a redeploy.
 */
export class FeesConfig extends BaseEndpoint {
  schema = {
    tags: ["Fees"],
    summary: "Update fee clamp configuration",
    description:
      "Update the floor and ceiling values for fee clamping. Requires API key authentication. Changes take effect immediately via KV storage.",
    security: [{ bearerAuth: [] }],
    request: {
      body: {
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              properties: {
                token_transfer: {
                  type: "object" as const,
                  properties: {
                    floor: {
                      type: "number" as const,
                      description: "Minimum fee in microSTX",
                      example: 180,
                    },
                    ceiling: {
                      type: "number" as const,
                      description: "Maximum fee in microSTX",
                      example: 3000,
                    },
                  },
                },
                contract_call: {
                  type: "object" as const,
                  properties: {
                    floor: {
                      type: "number" as const,
                      description: "Minimum fee in microSTX",
                      example: 3000,
                    },
                    ceiling: {
                      type: "number" as const,
                      description: "Maximum fee in microSTX",
                      example: 50000,
                    },
                  },
                },
                smart_contract: {
                  type: "object" as const,
                  properties: {
                    floor: {
                      type: "number" as const,
                      description: "Minimum fee in microSTX",
                      example: 10000,
                    },
                    ceiling: {
                      type: "number" as const,
                      description: "Maximum fee in microSTX",
                      example: 50000,
                    },
                  },
                },
              },
              description:
                "Partial update: only provided transaction types will be updated. Omit a type to keep its current values.",
            },
          },
        },
      },
    },
    responses: {
      "200": {
        description: "Configuration updated successfully",
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              properties: {
                success: { type: "boolean" as const, example: true },
                requestId: {
                  type: "string" as const,
                  format: "uuid",
                  description: "Unique request identifier for tracking",
                  example: "550e8400-e29b-41d4-a716-446655440000",
                },
                config: {
                  type: "object" as const,
                  description: "Updated clamp configuration",
                  properties: {
                    token_transfer: {
                      type: "object" as const,
                      properties: {
                        floor: { type: "number" as const },
                        ceiling: { type: "number" as const },
                      },
                    },
                    contract_call: {
                      type: "object" as const,
                      properties: {
                        floor: { type: "number" as const },
                        ceiling: { type: "number" as const },
                      },
                    },
                    smart_contract: {
                      type: "object" as const,
                      properties: {
                        floor: { type: "number" as const },
                        ceiling: { type: "number" as const },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "400": Error400Response,
      "401": Error401Response,
      "500": Error500Response,
    },
  };

  /** Transaction types to validate in order */
  private static readonly TX_TYPES: FeeTransactionType[] = [
    "token_transfer",
    "contract_call",
    "smart_contract",
  ];

  /**
   * Validate clamp configuration, returning an error message or null if valid
   */
  private validateConfig(config: FeeClampConfig): string | null {
    for (const txType of FeesConfig.TX_TYPES) {
      const clamp = config[txType];
      if (typeof clamp.floor !== "number" || clamp.floor <= 0) {
        return `${txType}.floor must be a positive number`;
      }
      if (typeof clamp.ceiling !== "number" || clamp.ceiling <= 0) {
        return `${txType}.ceiling must be a positive number`;
      }
      if (clamp.floor >= clamp.ceiling) {
        return `${txType}.floor must be less than ceiling`;
      }
    }
    return null;
  }

  async handle(c: AppContext) {
    const logger = this.getLogger(c);
    logger.info("Fees config update request received");

    try {
      // Auth is guaranteed by requireAuthMiddleware
      const auth = c.get("auth")!;
      logger.info("Admin updating fee config", { keyId: auth.metadata?.keyId });

      // Parse request body
      const body = (await c.req.json()) as Partial<FeeClampConfig>;

      // Get current config
      const feeService = new FeeService(c.env, logger);
      const currentConfig = await feeService.getClampConfig();

      // Merge with provided updates (partial update)
      const updatedConfig: FeeClampConfig = {
        token_transfer: body.token_transfer || currentConfig.token_transfer,
        contract_call: body.contract_call || currentConfig.contract_call,
        smart_contract: body.smart_contract || currentConfig.smart_contract,
      };

      // Validate merged config
      const validationError = this.validateConfig(updatedConfig);
      if (validationError) {
        return this.err(c, {
          error: "Invalid clamp configuration",
          code: "INVALID_TRANSACTION",
          status: 400,
          details: validationError,
          retryable: false,
        });
      }

      // Store updated config
      await feeService.setClampConfig(updatedConfig);

      logger.info("Fee clamp configuration updated", { config: updatedConfig });

      return this.ok(c, {
        config: updatedConfig,
      });
    } catch (e) {
      logger.error("Failed to update fee config", {
        error: e instanceof Error ? e.message : "Unknown error",
      });
      return this.err(c, {
        error: "Failed to update configuration",
        code: "INTERNAL_ERROR",
        status: 500,
        details: e instanceof Error ? e.message : "Unknown error",
        retryable: true,
      });
    }
  }
}
