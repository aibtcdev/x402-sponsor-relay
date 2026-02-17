import type {
  Env,
  Logger,
  FeeEstimates,
  FeeClampConfig,
  FeeClamp,
  FeeTransactionType,
  FeePriority,
  FeePriorityTiers,
} from "../types";

/**
 * Default clamp configuration (code defaults)
 */
const DEFAULT_CLAMPS: FeeClampConfig = {
  token_transfer: { floor: 180, ceiling: 3000 },
  contract_call: { floor: 3000, ceiling: 50000 },
  smart_contract: { floor: 10000, ceiling: 50000 },
};

/**
 * KV keys for fee caching
 */
const KV_KEY_ESTIMATES = "fee:estimates";
const KV_KEY_CONFIG = "fee:config";
const KV_KEY_RATE_LIMITED = "fee:rate_limited_until";

/**
 * Cache TTL in seconds
 */
const CACHE_TTL_SECONDS = 60;

/**
 * Service for fetching and clamping fee estimates from Hiro API
 */
export class FeeService {
  private kv: KVNamespace | undefined;
  private network: "mainnet" | "testnet";
  private logger: Logger;
  private hiroApiKey?: string;

  constructor(env: Env, logger: Logger) {
    this.kv = env.RELAY_KV;
    this.network = env.STACKS_NETWORK;
    this.logger = logger;
    this.hiroApiKey = env.HIRO_API_KEY;
  }

  /**
   * Get the Hiro API base URL for the current network
   */
  private getHiroBaseUrl(): string {
    return this.network === "mainnet"
      ? "https://api.hiro.so"
      : "https://api.testnet.hiro.so";
  }

  /**
   * Get clamp configuration from KV or fall back to defaults
   */
  async getClampConfig(): Promise<FeeClampConfig> {
    if (!this.kv) {
      this.logger.debug("KV not available, using default clamps");
      return DEFAULT_CLAMPS;
    }

    try {
      const configJson = await this.kv.get(KV_KEY_CONFIG);
      if (!configJson) {
        this.logger.debug("No clamp config in KV, using defaults");
        return DEFAULT_CLAMPS;
      }

      const config = JSON.parse(configJson) as FeeClampConfig;

      // Validate required keys and types before trusting KV data
      const txTypes: FeeTransactionType[] = ["token_transfer", "contract_call", "smart_contract"];
      for (const txType of txTypes) {
        const clamp = config[txType];
        if (
          !clamp ||
          typeof clamp.floor !== "number" ||
          typeof clamp.ceiling !== "number" ||
          clamp.floor <= 0 ||
          clamp.ceiling <= 0 ||
          clamp.floor >= clamp.ceiling
        ) {
          this.logger.warn("Invalid clamp config in KV, using defaults", { txType, clamp });
          return DEFAULT_CLAMPS;
        }
      }

      this.logger.debug("Loaded clamp config from KV", { config });
      return config;
    } catch (e) {
      this.logger.warn("Failed to load clamp config from KV", {
        error: e instanceof Error ? e.message : String(e),
      });
      return DEFAULT_CLAMPS;
    }
  }

  /**
   * Set clamp configuration in KV (for admin endpoint)
   */
  async setClampConfig(config: FeeClampConfig): Promise<void> {
    if (!this.kv) {
      throw new Error("KV not available, cannot store clamp config");
    }

    await this.kv.put(KV_KEY_CONFIG, JSON.stringify(config));

    // Invalidate cached fee estimates so new clamps take effect immediately
    try {
      await this.kv.delete(KV_KEY_ESTIMATES);
      this.logger.debug("Invalidated cached fee estimates after config update");
    } catch (e) {
      this.logger.warn("Failed to invalidate cached fee estimates", {
        error: e instanceof Error ? e.message : String(e),
      });
    }

    this.logger.info("Updated clamp config in KV", { config });
  }

  /**
   * Check if we're currently rate limited
   */
  private async isRateLimited(): Promise<{ limited: boolean; retryAfter?: number }> {
    if (!this.kv) {
      return { limited: false };
    }

    try {
      const limitedUntil = await this.kv.get(KV_KEY_RATE_LIMITED);
      if (!limitedUntil) {
        return { limited: false };
      }

      const until = new Date(limitedUntil);
      const now = new Date();
      if (now < until) {
        const retryAfter = Math.ceil((until.getTime() - now.getTime()) / 1000);
        this.logger.warn("Rate limited by Hiro API", { retryAfter });
        return { limited: true, retryAfter };
      }

      // Rate limit expired, clear it
      await this.kv.delete(KV_KEY_RATE_LIMITED);
      return { limited: false };
    } catch (e) {
      this.logger.warn("Failed to check rate limit status", {
        error: e instanceof Error ? e.message : String(e),
      });
      return { limited: false };
    }
  }

  /**
   * Record a rate limit from Hiro API
   */
  private async recordRateLimit(retryAfterSeconds: number): Promise<void> {
    if (!this.kv) {
      return;
    }

    // Normalize: if retryAfterSeconds is NaN (e.g. unparseable Retry-After header),
    // fall back to 60. Cloudflare KV requires a minimum TTL of 60 seconds.
    const safeRetryAfter = Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : 60;
    const kvTtl = Math.max(safeRetryAfter, 60);
    const until = new Date(Date.now() + kvTtl * 1000);
    await this.kv.put(KV_KEY_RATE_LIMITED, until.toISOString(), {
      expirationTtl: kvTtl,
    });
    this.logger.warn("Recorded rate limit from Hiro API", { retryAfterSeconds });
  }

  /**
   * Fetch fee estimates from Hiro API
   */
  private async fetchFromHiro(): Promise<FeeEstimates | null> {
    const baseUrl = this.getHiroBaseUrl();
    const url = `${baseUrl}/extended/v2/mempool/fees`;

    try {
      const headers: Record<string, string> = {};
      if (this.hiroApiKey) {
        headers["X-Hiro-API-Key"] = this.hiroApiKey;
      }

      this.logger.debug("Fetching fees from Hiro API", { url });
      const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(5000),
      });

      if (response.status === 429) {
        const retryAfter = response.headers.get("Retry-After");
        const retryAfterSeconds = retryAfter ? parseInt(retryAfter, 10) : 60;
        this.logger.warn("Rate limited by Hiro API", {
          retryAfter: retryAfterSeconds,
        });
        await this.recordRateLimit(retryAfterSeconds);
        return null;
      }

      if (!response.ok) {
        this.logger.error("Failed to fetch fees from Hiro API", {
          status: response.status,
          statusText: response.statusText,
        });
        return null;
      }

      const data = (await response.json()) as FeeEstimates;

      // Guard against malformed responses — validate all expected fields exist
      // and are finite numbers. Avoids truthiness checks so that 0 is allowed.
      const isValidNumber = (value: unknown): value is number =>
        typeof value === "number" && Number.isFinite(value);

      const tokenTransfer = data?.token_transfer;
      const contractCall = data?.contract_call;
      const smartContract = data?.smart_contract;

      if (
        !tokenTransfer ||
        !contractCall ||
        !smartContract ||
        !isValidNumber(tokenTransfer.low_priority) ||
        !isValidNumber(tokenTransfer.medium_priority) ||
        !isValidNumber(tokenTransfer.high_priority) ||
        !isValidNumber(contractCall.low_priority) ||
        !isValidNumber(contractCall.medium_priority) ||
        !isValidNumber(contractCall.high_priority) ||
        !isValidNumber(smartContract.low_priority) ||
        !isValidNumber(smartContract.medium_priority) ||
        !isValidNumber(smartContract.high_priority)
      ) {
        this.logger.warn("Hiro API fee response missing or invalid fields", {
          hasTokenTransfer: !!tokenTransfer,
          hasContractCall: !!contractCall,
          hasSmartContract: !!smartContract,
        });
        return null;
      }

      this.logger.debug("Fetched fees from Hiro API", { data });
      return data;
    } catch (e) {
      this.logger.error("Error fetching fees from Hiro API", {
        error: e instanceof Error ? e.message : String(e),
      });
      return null;
    }
  }

  /**
   * Clamp a single value between floor and ceiling
   */
  private clamp(value: number, floor: number, ceiling: number): number {
    return Math.min(ceiling, Math.max(floor, value));
  }

  /**
   * Build uniform priority tiers where all levels share the same value
   */
  private uniformTiers(value: number): FeePriorityTiers {
    return { low_priority: value, medium_priority: value, high_priority: value };
  }

  /**
   * Clamp all priority tiers for a single transaction type
   */
  private clampTiers(tiers: FeePriorityTiers, bounds: FeeClamp): FeePriorityTiers {
    return {
      low_priority: this.clamp(tiers.low_priority, bounds.floor, bounds.ceiling),
      medium_priority: this.clamp(tiers.medium_priority, bounds.floor, bounds.ceiling),
      high_priority: this.clamp(tiers.high_priority, bounds.floor, bounds.ceiling),
    };
  }

  /**
   * Apply clamps to raw fee estimates
   */
  private applyClamps(raw: FeeEstimates, config: FeeClampConfig): FeeEstimates {
    return {
      token_transfer: this.clampTiers(raw.token_transfer, config.token_transfer),
      contract_call: this.clampTiers(raw.contract_call, config.contract_call),
      smart_contract: this.clampTiers(raw.smart_contract, config.smart_contract),
    };
  }

  /**
   * Get fee estimates from cache or fetch from Hiro
   * Returns { fees, source, cached }
   */
  async getEstimates(): Promise<{
    fees: FeeEstimates;
    source: "hiro" | "cache" | "default";
    cached: boolean;
  }> {
    // Try cache first (always, even when rate limited)
    if (this.kv) {
      try {
        const cachedJson = await this.kv.get(KV_KEY_ESTIMATES);
        if (cachedJson) {
          const cached = JSON.parse(cachedJson) as FeeEstimates;
          this.logger.debug("Using cached fee estimates");
          return { fees: cached, source: "cache", cached: true };
        }
      } catch (e) {
        this.logger.warn("Failed to read cached fees", {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    // Fetch from Hiro if not rate limited
    const { limited } = await this.isRateLimited();
    if (!limited) {
      const hiroData = await this.fetchFromHiro();
      if (hiroData) {
        const config = await this.getClampConfig();
        const clamped = this.applyClamps(hiroData, config);

        // Store in cache
        if (this.kv) {
          try {
            await this.kv.put(KV_KEY_ESTIMATES, JSON.stringify(clamped), {
              expirationTtl: CACHE_TTL_SECONDS,
            });
            this.logger.debug("Cached fee estimates", { ttl: CACHE_TTL_SECONDS });
          } catch (e) {
            this.logger.warn("Failed to cache fee estimates", {
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }

        return { fees: clamped, source: "hiro", cached: false };
      }
    }

    // Fallback: use floor values from clamp config
    this.logger.warn("Using default floor-based fees");
    const config = await this.getClampConfig();
    const defaults: FeeEstimates = {
      token_transfer: this.uniformTiers(config.token_transfer.floor),
      contract_call: this.uniformTiers(config.contract_call.floor),
      smart_contract: this.uniformTiers(config.smart_contract.floor),
    };

    return { fees: defaults, source: "default", cached: false };
  }

  /**
   * Get fee for a specific transaction type and priority
   * Convenience method for sponsor service
   */
  async getFeeForType(
    txType: FeeTransactionType,
    priority: FeePriority = "medium_priority"
  ): Promise<number> {
    const { fees } = await this.getEstimates();
    return fees[txType][priority];
  }
}
