import type {
  Logger,
  ApiKeyMetadata,
  ApiKeyUsage,
  ApiKeyFeeStats,
  ApiKeyValidationResult,
  ApiKeyErrorCode,
  RateLimitTier,
  TokenType,
  AggregateKeyStats,
  ApiKeyStatsEntry,
  ApiKeyStatus,
} from "../types";
import { TIER_LIMITS } from "../types";

/**
 * Rate limit check result
 */
export type RateLimitResult =
  | { allowed: true; remaining: { minute: number; daily: number } }
  | {
      allowed: false;
      code: "RATE_LIMIT_EXCEEDED" | "DAILY_LIMIT_EXCEEDED";
      retryAfter: number;
    };

/**
 * Spending cap check result
 */
export type SpendingCapResult =
  | { allowed: true; remaining: bigint | null }
  | { allowed: false; code: "SPENDING_CAP_EXCEEDED"; retryAfter: number };

/**
 * Usage data to record
 */
export interface UsageData {
  success: boolean;
  tokenType: TokenType;
  amount: string;
  fee?: string;
}

/**
 * API Key format: x402_sk_<env>_<32-char-hex>
 * Example: x402_sk_test_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6
 */
const API_KEY_REGEX = /^x402_sk_(test|live)_[a-f0-9]{32}$/;

/**
 * Create an empty ApiKeyUsage object for a given date
 * Used when initializing usage records that don't exist yet
 */
function createEmptyUsage(date: string): ApiKeyUsage {
  return {
    date,
    requests: 0,
    success: 0,
    failed: 0,
    volume: { STX: "0", sBTC: "0", USDCx: "0" },
    feesPaid: "0",
  };
}

/**
 * Hash an API key for secure storage
 * Uses SHA-256 to generate a deterministic hash
 */
async function hashApiKey(apiKey: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(apiKey);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * AuthService handles API key validation, rate limiting, and usage tracking
 */
export class AuthService {
  constructor(
    private kv: KVNamespace | undefined,
    private logger: Logger
  ) {}

  /**
   * Validate an API key format
   */
  isValidKeyFormat(apiKey: string): boolean {
    return API_KEY_REGEX.test(apiKey);
  }

  /**
   * Extract environment from API key
   */
  getKeyEnvironment(apiKey: string): "test" | "live" | null {
    const match = apiKey.match(/^x402_sk_(test|live)_/);
    return match ? (match[1] as "test" | "live") : null;
  }

  /**
   * Validate an API key and return metadata if valid
   */
  async validateKey(apiKey: string): Promise<ApiKeyValidationResult> {
    // Check format first
    if (!this.isValidKeyFormat(apiKey)) {
      return {
        valid: false,
        code: "INVALID_API_KEY",
        error: "Invalid API key format",
      };
    }

    // Check if KV is available
    if (!this.kv) {
      this.logger.warn(
        "API_KEYS_KV not configured, allowing key in grace mode"
      );
      return {
        valid: false,
        code: "INVALID_API_KEY",
        error: "API key validation unavailable",
      };
    }

    // Hash the API key for secure lookup (keys are stored by hash, not plaintext)
    const keyHash = await hashApiKey(apiKey);

    // Lookup key in KV by hash
    const metadata = await this.kv.get<ApiKeyMetadata>(`key:${keyHash}`, "json");

    if (!metadata) {
      return {
        valid: false,
        code: "INVALID_API_KEY",
        error: "API key not found",
      };
    }

    // Check if key is active
    if (!metadata.active) {
      return {
        valid: false,
        code: "REVOKED_API_KEY",
        error: "API key has been revoked",
      };
    }

    // Check if key is expired
    const now = new Date();
    const expiresAt = new Date(metadata.expiresAt);
    if (now > expiresAt) {
      return {
        valid: false,
        code: "EXPIRED_API_KEY",
        error: "API key has expired",
      };
    }

    return { valid: true, metadata };
  }

  /**
   * Check rate limits for an API key
   */
  async checkRateLimit(
    keyId: string,
    tier: RateLimitTier
  ): Promise<RateLimitResult> {
    const limits = TIER_LIMITS[tier];

    // Unlimited tier bypasses all checks
    if (limits.requestsPerMinute === Infinity) {
      return {
        allowed: true,
        remaining: { minute: Infinity, daily: Infinity },
      };
    }

    if (!this.kv) {
      // No KV, allow but log warning
      this.logger.warn(
        "API_KEYS_KV not configured, skipping rate limit check"
      );
      return {
        allowed: true,
        remaining: {
          minute: limits.requestsPerMinute,
          daily: limits.dailyLimit,
        },
      };
    }

    const now = new Date();
    const minuteKey = `usage:minute:${keyId}:${Math.floor(now.getTime() / 60000)}`;
    const dailyKey = `usage:daily:${keyId}:${now.toISOString().split("T")[0]}`;

    // Get current counts
    const [minuteCount, dailyUsage] = await Promise.all([
      this.kv.get<number>(minuteKey, "json"),
      this.kv.get<ApiKeyUsage>(dailyKey, "json"),
    ]);

    const currentMinute = minuteCount || 0;
    const currentDaily = dailyUsage?.requests || 0;

    // Check per-minute limit
    if (currentMinute >= limits.requestsPerMinute) {
      const secondsUntilReset = 60 - (now.getSeconds() % 60);
      return {
        allowed: false,
        code: "RATE_LIMIT_EXCEEDED",
        retryAfter: secondsUntilReset,
      };
    }

    // Check daily limit
    if (currentDaily >= limits.dailyLimit) {
      // Calculate seconds until midnight UTC
      const tomorrow = new Date(now);
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      tomorrow.setUTCHours(0, 0, 0, 0);
      const secondsUntilMidnight = Math.ceil(
        (tomorrow.getTime() - now.getTime()) / 1000
      );
      return {
        allowed: false,
        code: "DAILY_LIMIT_EXCEEDED",
        retryAfter: secondsUntilMidnight,
      };
    }

    // Increment minute counter (TTL: 2 minutes)
    await this.kv.put(minuteKey, JSON.stringify(currentMinute + 1), {
      expirationTtl: 120,
    });

    return {
      allowed: true,
      remaining: {
        minute: limits.requestsPerMinute - currentMinute - 1,
        daily: limits.dailyLimit - currentDaily - 1,
      },
    };
  }

  /**
   * Record usage for an API key
   */
  async recordUsage(keyId: string, data: UsageData): Promise<void> {
    if (!this.kv) {
      this.logger.warn("API_KEYS_KV not configured, skipping usage recording");
      return;
    }

    const date = new Date().toISOString().split("T")[0];
    const dailyKey = `usage:daily:${keyId}:${date}`;

    // Get existing usage or create new
    const existing = await this.kv.get<ApiKeyUsage>(dailyKey, "json");
    const usage: ApiKeyUsage = existing || createEmptyUsage(date);

    // Update counters
    usage.requests += 1;
    if (data.success) {
      usage.success += 1;
    } else {
      usage.failed += 1;
    }

    // Add volume for token type
    const currentVolume = BigInt(usage.volume[data.tokenType]);
    const addedVolume = BigInt(data.amount);
    usage.volume[data.tokenType] = (currentVolume + addedVolume).toString();

    // Add fees if provided
    if (data.fee) {
      const currentFees = BigInt(usage.feesPaid);
      const addedFees = BigInt(data.fee);
      usage.feesPaid = (currentFees + addedFees).toString();
    }

    // Store with 90-day TTL
    await this.kv.put(dailyKey, JSON.stringify(usage), {
      expirationTtl: 90 * 24 * 60 * 60,
    });
  }

  /**
   * Get usage for an API key for a specific date
   */
  async getUsage(keyId: string, date: string): Promise<ApiKeyUsage | null> {
    if (!this.kv) {
      return null;
    }
    return this.kv.get<ApiKeyUsage>(`usage:daily:${keyId}:${date}`, "json");
  }

  /**
   * Get usage for an API key for the last N days
   */
  async getUsageHistory(
    keyId: string,
    days: number = 7
  ): Promise<ApiKeyUsage[]> {
    if (!this.kv) {
      return [];
    }

    const usage: ApiKeyUsage[] = [];
    const today = new Date();

    for (let i = 0; i < days; i++) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split("T")[0];
      const dayUsage = await this.kv.get<ApiKeyUsage>(
        `usage:daily:${keyId}:${dateStr}`,
        "json"
      );
      if (dayUsage) {
        usage.push(dayUsage);
      }
    }

    return usage;
  }

  // =============================================================================
  // Fee Monitoring Methods
  // =============================================================================

  /**
   * Check if an API key has remaining spending capacity for a given fee
   */
  async checkSpendingCap(
    keyId: string,
    tier: RateLimitTier,
    estimatedFee: bigint
  ): Promise<SpendingCapResult> {
    const limits = TIER_LIMITS[tier];

    // Unlimited tier bypasses spending cap
    if (limits.dailyFeeCapMicroStx === null) {
      return { allowed: true, remaining: null };
    }

    if (!this.kv) {
      this.logger.warn(
        "API_KEYS_KV not configured, skipping spending cap check"
      );
      return { allowed: true, remaining: null };
    }

    const date = new Date().toISOString().split("T")[0];
    const dailyKey = `usage:daily:${keyId}:${date}`;
    const existing = await this.kv.get<ApiKeyUsage>(dailyKey, "json");

    const currentSpent = BigInt(existing?.feesPaid || "0");
    const cap = BigInt(limits.dailyFeeCapMicroStx);
    const remaining = cap - currentSpent;

    // Check if adding this fee would exceed the cap
    if (currentSpent + estimatedFee > cap) {
      // Calculate seconds until midnight UTC for retry
      const now = new Date();
      const tomorrow = new Date(now);
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      tomorrow.setUTCHours(0, 0, 0, 0);
      const secondsUntilMidnight = Math.ceil(
        (tomorrow.getTime() - now.getTime()) / 1000
      );

      this.logger.warn("Spending cap exceeded", {
        keyId,
        tier,
        currentSpent: currentSpent.toString(),
        estimatedFee: estimatedFee.toString(),
        cap: cap.toString(),
      });

      return {
        allowed: false,
        code: "SPENDING_CAP_EXCEEDED",
        retryAfter: secondsUntilMidnight,
      };
    }

    return { allowed: true, remaining };
  }

  /**
   * Record fee spent for an API key
   * This updates the feesPaid field in the daily usage record
   */
  async recordFeeSpent(keyId: string, feeAmount: bigint): Promise<void> {
    if (!this.kv) {
      this.logger.warn("API_KEYS_KV not configured, skipping fee recording");
      return;
    }

    const date = new Date().toISOString().split("T")[0];
    const dailyKey = `usage:daily:${keyId}:${date}`;

    // Get existing usage or create new
    const existing = await this.kv.get<ApiKeyUsage>(dailyKey, "json");
    const usage: ApiKeyUsage = existing || createEmptyUsage(date);

    // Add fee to total
    const currentFees = BigInt(usage.feesPaid);
    usage.feesPaid = (currentFees + feeAmount).toString();

    // Store with 90-day TTL
    await this.kv.put(dailyKey, JSON.stringify(usage), {
      expirationTtl: 90 * 24 * 60 * 60,
    });

    this.logger.debug("Fee recorded for API key", {
      keyId,
      feeAmount: feeAmount.toString(),
      totalToday: usage.feesPaid,
    });
  }

  /**
   * Get remaining spending capacity for an API key
   * Returns null for unlimited tier
   */
  async getRemainingSpendingCap(
    keyId: string,
    tier: RateLimitTier
  ): Promise<bigint | null> {
    const limits = TIER_LIMITS[tier];

    // Unlimited tier has no cap
    if (limits.dailyFeeCapMicroStx === null) {
      return null;
    }

    if (!this.kv) {
      return null;
    }

    const date = new Date().toISOString().split("T")[0];
    const dailyKey = `usage:daily:${keyId}:${date}`;
    const existing = await this.kv.get<ApiKeyUsage>(dailyKey, "json");

    const currentSpent = BigInt(existing?.feesPaid || "0");
    const cap = BigInt(limits.dailyFeeCapMicroStx);

    return cap - currentSpent;
  }

  /**
   * Get fee statistics for an API key
   */
  async getKeyFeeStats(
    keyId: string,
    tier: RateLimitTier
  ): Promise<ApiKeyFeeStats> {
    const limits = TIER_LIMITS[tier];
    const dailyCap = limits.dailyFeeCapMicroStx;

    // Get today's usage
    const date = new Date().toISOString().split("T")[0];
    const todayUsage = await this.getUsage(keyId, date);
    const todaySpent = todayUsage?.feesPaid || "0";

    // Calculate remaining
    let remaining: string | null = null;
    let capExceeded = false;
    if (dailyCap !== null) {
      const cap = BigInt(dailyCap);
      const spent = BigInt(todaySpent);
      remaining = (cap - spent).toString();
      capExceeded = spent >= cap;
    }

    // Get 7-day history
    const usageHistory = await this.getUsageHistory(keyId, 7);
    const history = usageHistory.map((u) => ({
      date: u.date,
      feesPaid: u.feesPaid,
    }));

    return {
      keyId,
      dailyCap: dailyCap !== null ? dailyCap.toString() : null,
      todaySpent,
      remaining,
      capExceeded,
      history,
    };
  }

  // =============================================================================
  // Admin methods (for CLI tool)
  // =============================================================================

  /**
   * Create a new API key
   */
  async createKey(
    appName: string,
    contactEmail: string,
    tier: RateLimitTier,
    environment: "test" | "live"
  ): Promise<{ apiKey: string; metadata: ApiKeyMetadata }> {
    if (!this.kv) {
      throw new Error("API_KEYS_KV not configured");
    }

    // Check if app already has a key
    const existingKeyId = await this.kv.get(`app:${appName}`);
    if (existingKeyId) {
      throw new Error(`Application "${appName}" already has an API key`);
    }

    // Generate random 32-char hex
    const randomBytes = new Uint8Array(16);
    crypto.getRandomValues(randomBytes);
    const hex = Array.from(randomBytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const apiKey = `x402_sk_${environment}_${hex}`;

    // Create key ID (hash of key for internal reference)
    const keyIdBytes = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(apiKey)
    );
    const keyId = Array.from(new Uint8Array(keyIdBytes).slice(0, 8))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const now = new Date();
    const expiresAt = new Date(now);
    expiresAt.setDate(expiresAt.getDate() + 30); // 30-day expiration

    const metadata: ApiKeyMetadata = {
      keyId,
      appName,
      contactEmail,
      tier,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      active: true,
    };

    // Hash the API key for secure storage (plaintext key is only shown once)
    const keyHash = await hashApiKey(apiKey);

    // Store hash -> metadata mapping (key is never stored in plaintext)
    await this.kv.put(`key:${keyHash}`, JSON.stringify(metadata));

    // Store app -> keyId mapping (for lookup by name)
    await this.kv.put(`app:${appName}`, keyId);

    // Store keyId -> keyHash mapping (for admin operations like revoke/renew)
    await this.kv.put(`keyId:${keyId}`, keyHash);

    this.logger.info("API key created", { appName, keyId, tier });

    return { apiKey, metadata };
  }

  /**
   * Revoke an API key
   */
  async revokeKey(apiKey: string): Promise<boolean> {
    if (!this.kv) {
      throw new Error("API_KEYS_KV not configured");
    }

    const keyHash = await hashApiKey(apiKey);
    const metadata = await this.kv.get<ApiKeyMetadata>(`key:${keyHash}`, "json");
    if (!metadata) {
      return false;
    }

    metadata.active = false;
    await this.kv.put(`key:${keyHash}`, JSON.stringify(metadata));

    this.logger.info("API key revoked", {
      keyId: metadata.keyId,
      appName: metadata.appName,
    });
    return true;
  }

  /**
   * Renew an API key (extend expiration by 30 days from now)
   */
  async renewKey(apiKey: string): Promise<ApiKeyMetadata | null> {
    if (!this.kv) {
      throw new Error("API_KEYS_KV not configured");
    }

    const keyHash = await hashApiKey(apiKey);
    const metadata = await this.kv.get<ApiKeyMetadata>(`key:${keyHash}`, "json");
    if (!metadata) {
      return null;
    }

    const now = new Date();
    const expiresAt = new Date(now);
    expiresAt.setDate(expiresAt.getDate() + 30);

    metadata.expiresAt = expiresAt.toISOString();
    await this.kv.put(`key:${keyHash}`, JSON.stringify(metadata));

    this.logger.info("API key renewed", {
      keyId: metadata.keyId,
      expiresAt: metadata.expiresAt,
    });
    return metadata;
  }

  /**
   * Get metadata for an API key
   */
  async getKeyMetadata(apiKey: string): Promise<ApiKeyMetadata | null> {
    if (!this.kv) {
      return null;
    }
    const keyHash = await hashApiKey(apiKey);
    return this.kv.get<ApiKeyMetadata>(`key:${keyHash}`, "json");
  }

  /**
   * List all API keys (returns metadata only, not the actual keys)
   */
  async listKeys(): Promise<ApiKeyMetadata[]> {
    if (!this.kv) {
      return [];
    }

    const keys: ApiKeyMetadata[] = [];
    let cursor: string | undefined;

    do {
      const result = await this.kv.list({ prefix: "key:", cursor });
      for (const key of result.keys) {
        const metadata = await this.kv.get<ApiKeyMetadata>(key.name, "json");
        if (metadata) {
          keys.push(metadata);
        }
      }
      cursor = result.list_complete ? undefined : result.cursor;
    } while (cursor);

    return keys;
  }

  // =============================================================================
  // Dashboard Aggregate Stats
  // =============================================================================

  /**
   * Get aggregate statistics across all API keys for the dashboard
   * Returns total active keys, total fees today, and top keys by usage
   */
  async getAggregateKeyStats(): Promise<AggregateKeyStats> {
    const emptyStats: AggregateKeyStats = {
      totalActiveKeys: 0,
      totalFeesToday: "0",
      topKeys: [],
    };

    if (!this.kv) {
      this.logger.warn(
        "API_KEYS_KV not configured, returning empty aggregate stats"
      );
      return emptyStats;
    }

    const today = new Date().toISOString().split("T")[0];
    const usagePrefix = `usage:daily:`;
    const todaySuffix = `:${today}`;

    // Collect usage data for today
    const usageEntries: Array<{
      keyId: string;
      usage: ApiKeyUsage;
    }> = [];

    let cursor: string | undefined;
    let iterationCount = 0;
    const maxIterations = 10; // Limit KV list operations

    try {
      do {
        const result = await this.kv.list({
          prefix: usagePrefix,
          cursor,
          limit: 50,
        });

        for (const key of result.keys) {
          // Only process today's usage records
          if (key.name.endsWith(todaySuffix)) {
            const usage = await this.kv.get<ApiKeyUsage>(key.name, "json");
            if (usage) {
              // Extract keyId from key name: usage:daily:<keyId>:<date>
              const parts = key.name.split(":");
              if (parts.length >= 3) {
                const keyId = parts[2];
                usageEntries.push({ keyId, usage });
              }
            }
          }
        }

        cursor = result.list_complete ? undefined : result.cursor;
        iterationCount++;
      } while (cursor && iterationCount < maxIterations);

      if (iterationCount >= maxIterations) {
        this.logger.warn("Aggregate stats: reached iteration limit", {
          maxIterations,
          entriesFound: usageEntries.length,
        });
      }
    } catch (error) {
      this.logger.error("Failed to fetch aggregate key stats", {
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return emptyStats;
    }

    // Count active keys by listing key: prefix
    let totalActiveKeys = 0;

    try {
      let keyCursor: string | undefined = undefined;
      let shouldContinue = true;
      let keyIterations = 0;

      while (shouldContinue && keyIterations < maxIterations) {
        const listOptions: { prefix: string; limit: number; cursor?: string } = {
          prefix: "key:",
          limit: 100,
        };
        if (keyCursor) {
          listOptions.cursor = keyCursor;
        }

        const keyListResult = await this.kv.list(listOptions);

        for (const key of keyListResult.keys) {
          const metadata = await this.kv.get<ApiKeyMetadata>(key.name, "json");
          if (metadata?.active) {
            const expiresAt = new Date(metadata.expiresAt);
            if (expiresAt > new Date()) {
              totalActiveKeys++;
            }
          }
        }

        if (keyListResult.list_complete) {
          shouldContinue = false;
        } else {
          keyCursor = keyListResult.cursor;
        }
        keyIterations++;
      }
    } catch (error) {
      this.logger.error("Failed to count active keys", {
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }

    // Calculate total fees today
    let totalFeesToday = BigInt(0);
    for (const entry of usageEntries) {
      totalFeesToday += BigInt(entry.usage.feesPaid || "0");
    }

    // Sort by requests and get top 5
    const sortedEntries = usageEntries
      .sort((a, b) => b.usage.requests - a.usage.requests)
      .slice(0, 5);

    // Build top keys with anonymized prefixes and status
    const topKeys: ApiKeyStatsEntry[] = await Promise.all(
      sortedEntries.map(async (entry) => {
        // Determine status based on usage
        let status: ApiKeyStatus = "active";

        // Check if approaching daily limit (simple heuristic)
        // We'd need the tier info to do proper checking, so we use usage patterns
        const requests = entry.usage.requests;
        const fees = BigInt(entry.usage.feesPaid || "0");

        // If fees are high relative to standard tier cap, mark as potentially capped
        // Standard tier cap: 1000 STX = 1_000_000_000 microSTX
        // Free tier cap: 100 STX = 100_000_000 microSTX
        if (fees >= BigInt(100_000_000)) {
          // Approaching free tier cap
          status = "capped";
        }

        // If requests are very high, might be rate limited
        if (requests >= 100) {
          // Free tier daily limit
          // Keep current status if already capped, otherwise check rate
          if (status !== "capped" && requests >= 1000) {
            status = "rate_limited";
          }
        }

        return {
          keyPrefix: entry.keyId.slice(0, 12),
          requestsToday: entry.usage.requests,
          feesToday: entry.usage.feesPaid,
          status,
        };
      })
    );

    return {
      totalActiveKeys,
      totalFeesToday: totalFeesToday.toString(),
      topKeys,
    };
  }
}
