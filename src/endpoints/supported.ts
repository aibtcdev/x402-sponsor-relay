import { BaseEndpoint } from "./BaseEndpoint";
import type { AppContext, X402SupportedResponseV2 } from "../types";
import { CAIP2_NETWORKS } from "../types";

/**
 * Supported endpoint - x402 V2 supported payment kinds
 * GET /supported (spec section 7.3)
 *
 * Returns the static list of payment kinds, extensions, and signers
 * supported by this relay acting as an x402 V2 facilitator.
 */
export class Supported extends BaseEndpoint {
  schema = {
    tags: ["x402 V2"],
    summary: "Get supported x402 V2 payment kinds",
    description:
      "x402 V2 facilitator supported endpoint (spec section 7.3). Returns the static configuration of payment kinds supported by this relay: x402Version 2, scheme 'exact', on the configured Stacks network.",
    responses: {
      "200": {
        description: "Supported payment kinds configuration",
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              required: ["kinds", "extensions", "signers"],
              properties: {
                kinds: {
                  type: "array" as const,
                  items: {
                    type: "object" as const,
                    properties: {
                      x402Version: { type: "number" as const, example: 2 },
                      scheme: { type: "string" as const, example: "exact" },
                      network: { type: "string" as const, example: "stacks:2147483648" },
                    },
                  },
                },
                extensions: {
                  type: "array" as const,
                  items: { type: "string" as const },
                  description: "Supported protocol extensions (empty for base spec)",
                },
                signers: {
                  type: "object" as const,
                  description: "Map of network to supported signer addresses (empty = any signer accepted)",
                  additionalProperties: {
                    type: "array" as const,
                    items: { type: "string" as const },
                  },
                },
              },
            },
          },
        },
      },
    },
  };

  async handle(c: AppContext) {
    const logger = this.getLogger(c);
    logger.info("x402 V2 supported request received");

    const network = CAIP2_NETWORKS[c.env.STACKS_NETWORK];

    const response: X402SupportedResponseV2 = {
      kinds: [
        {
          x402Version: 2,
          scheme: "exact",
          network,
        },
      ],
      extensions: [],
      signers: {
        "stacks:*": [],
      },
    };

    return c.json(response, 200);
  }
}
