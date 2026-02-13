import type {
  Env,
  Logger,
  FeeEstimates,
  HiroMempoolFeesResponse,
  FeeClampConfig,
  FeeTransactionType,
  FeePriority,
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

    const until = new Date(Date.now() + retryAfterSeconds * 1000);
    await this.kv.put(KV_KEY_RATE_LIMITED, until.toISOString(), {
      expirationTtl: retryAfterSeconds,
    });
    this.logger.warn("Recorded rate limit from Hiro API", { retryAfterSeconds });
  }

  /**
   * Fetch fee estimates from Hiro API
   */
  private async fetchFromHiro(): Promise<HiroMempoolFeesResponse | null> {
    const baseUrl = this.getHiroBaseUrl();
    const url = `${baseUrl}/extended/v2/mempool/fees`;

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };

      if (this.hiroApiKey) {
        headers["X-Hiro-API-Key"] = this.hiroApiKey;
      }

      this.logger.debug("Fetching fees from Hiro API", { url });
      const response = await fetch(url, { headers });

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

      const data = (await response.json()) as HiroMempoolFeesResponse;
      this.logger.info("Fetched fees from Hiro API", { data });
      return data;
    } catch (e) {
      this.logger.error("Error fetching fees from Hiro API", {
        error: e instanceof Error ? e.message : String(e),
      });
      return null;
    }
  }

  /**
   * Apply clamps to raw fee estimates
   */
  private applyClamps(raw: HiroMempoolFeesResponse, config: FeeClampConfig): FeeEstimates {
    const clampValue = (value: number, floor: number, ceiling: number): number => {
      return Math.min(ceiling, Math.max(floor, value));
    };

    return {
      token_transfer: {
        low_priority: clampValue(
          raw.token_transfer.low_priority,
          config.token_transfer.floor,
          config.token_transfer.ceiling
        ),
        medium_priority: clampValue(
          raw.token_transfer.medium_priority,
          config.token_transfer.floor,
          config.token_transfer.ceiling
        ),
        high_priority: clampValue(
          raw.token_transfer.high_priority,
          config.token_transfer.floor,
          config.token_transfer.ceiling
        ),
      },
      contract_call: {
        low_priority: clampValue(
          raw.contract_call.low_priority,
          config.contract_call.floor,
          config.contract_call.ceiling
        ),
        medium_priority: clampValue(
          raw.contract_call.medium_priority,
          config.contract_call.floor,
          config.contract_call.ceiling
        ),
        high_priority: clampValue(
          raw.contract_call.high_priority,
          config.contract_call.floor,
          config.contract_call.ceiling
        ),
      },
      smart_contract: {
        low_priority: clampValue(
          raw.smart_contract.low_priority,
          config.smart_contract.floor,
          config.smart_contract.ceiling
        ),
        medium_priority: clampValue(
          raw.smart_contract.medium_priority,
          config.smart_contract.floor,
          config.smart_contract.ceiling
        ),
        high_priority: clampValue(
          raw.smart_contract.high_priority,
          config.smart_contract.floor,
          config.smart_contract.ceiling
        ),
      },
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
    // Check rate limit status
    const { limited, retryAfter } = await this.isRateLimited();
    if (limited) {
      this.logger.warn("Skipping Hiro fetch due to rate limit", { retryAfter });
      // Fall through to cache or defaults
    }

    // Try cache first
    if (this.kv && !limited) {
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
      token_transfer: {
        low_priority: config.token_transfer.floor,
        medium_priority: config.token_transfer.floor,
        high_priority: config.token_transfer.floor,
      },
      contract_call: {
        low_priority: config.contract_call.floor,
        medium_priority: config.contract_call.floor,
        high_priority: config.contract_call.floor,
      },
      smart_contract: {
        low_priority: config.smart_contract.floor,
        medium_priority: config.smart_contract.floor,
        high_priority: config.smart_contract.floor,
      },
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
