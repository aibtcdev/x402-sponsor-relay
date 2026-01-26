/**
 * Admin CLI for managing API keys
 *
 * Usage:
 *   npm run keys -- <command> [options]
 *
 * Commands:
 *   create --app <name> --email <email> [--tier <tier>] [--env <test|live>]
 *   list
 *   info <api-key>
 *   revoke <api-key>
 *   renew <api-key>
 *   usage <api-key> [--days <n>]
 *
 * Environment:
 *   WRANGLER_ENV    Environment to use (staging, production, or local)
 *   KV_NAMESPACE_ID Override KV namespace ID
 *
 * Examples:
 *   npm run keys -- create --app "My App" --email "dev@example.com"
 *   npm run keys -- create --app "My App" --email "dev@example.com" --tier standard
 *   npm run keys -- list
 *   npm run keys -- info x402_sk_test_...
 *   npm run keys -- revoke x402_sk_test_...
 *   npm run keys -- renew x402_sk_test_...
 *   npm run keys -- usage x402_sk_test_... --days 7
 */

import { execSync } from "child_process";
import type {
  RateLimitTier,
  ApiKeyMetadata,
  ApiKeyUsage,
} from "../src/types";
import { TIER_LIMITS } from "../src/types";

// API Key format: x402_sk_<env>_<32-char-hex>
const API_KEY_REGEX = /^x402_sk_(test|live)_[a-f0-9]{32}$/;

// Valid rate limit tiers
const VALID_TIERS: RateLimitTier[] = ["free", "standard", "unlimited"];

// Valid key environments
const VALID_ENVS: Array<"test" | "live"> = ["test", "live"];

// Basic email validation regex
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Get environment from WRANGLER_ENV or default to local
const wranglerEnv = process.env.WRANGLER_ENV || "";
const envFlag = wranglerEnv ? `--env ${wranglerEnv}` : "";

/**
 * Execute a wrangler KV command
 */
function wranglerKv(subcommand: string, args: string): string {
  const cmd = `npx wrangler kv key ${subcommand} ${args} ${envFlag} --binding API_KEYS_KV --remote`;
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
  } catch (e) {
    const error = e as { stderr?: string; stdout?: string };
    throw new Error(error.stderr || error.stdout || "Command failed");
  }
}

/**
 * Get a value from KV
 */
function kvGet<T>(key: string): T | null {
  try {
    const result = wranglerKv("get", `"${key}"`);
    return JSON.parse(result) as T;
  } catch {
    return null;
  }
}

/**
 * Put a value to KV
 * Note: Escapes single quotes in value to prevent shell injection
 */
function kvPut(key: string, value: string, ttl?: number): void {
  const ttlArg = ttl ? `--ttl ${ttl}` : "";
  // Escape single quotes in value to prevent shell injection
  const escapedValue = value.replace(/'/g, "'\\''");
  wranglerKv("put", `"${key}" '${escapedValue}' ${ttlArg}`);
}

/**
 * List keys with a prefix
 */
function kvList(prefix: string): string[] {
  const cmd = `npx wrangler kv key list ${envFlag} --binding API_KEYS_KV --remote --prefix "${prefix}"`;
  try {
    const result = execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    const keys = JSON.parse(result) as Array<{ name: string }>;
    return keys.map((k) => k.name);
  } catch {
    return [];
  }
}

/**
 * Generate a random 32-character hex string
 */
function generateRandomHex(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Hash an API key (full SHA-256 hash for secure storage)
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
 * Generate a key ID (short hash of the API key for display)
 */
async function generateKeyId(apiKey: string): Promise<string> {
  const fullHash = await hashApiKey(apiKey);
  return fullHash.slice(0, 16);
}

/**
 * Create a new API key
 */
async function createKey(
  appName: string,
  contactEmail: string,
  tier: RateLimitTier = "free",
  environment: "test" | "live" = "test"
): Promise<void> {
  console.log(`Creating API key for "${appName}"...`);

  // Check if app already has a key
  const existingKeyId = kvGet<string>(`app:${appName}`);
  if (existingKeyId) {
    console.error(`Error: Application "${appName}" already has an API key`);
    process.exit(1);
  }

  // Generate API key
  const hex = generateRandomHex();
  const apiKey = `x402_sk_${environment}_${hex}`;
  const keyId = await generateKeyId(apiKey);
  const keyHash = await hashApiKey(apiKey);

  // Set expiration (30 days)
  const now = new Date();
  const expiresAt = new Date(now);
  expiresAt.setDate(expiresAt.getDate() + 30);

  const metadata: ApiKeyMetadata = {
    keyId,
    appName,
    contactEmail,
    tier,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    active: true,
  };

  // Store in KV (key is stored by hash, never in plaintext)
  kvPut(`key:${keyHash}`, JSON.stringify(metadata));
  kvPut(`app:${appName}`, keyId);
  kvPut(`keyId:${keyId}`, keyHash);

  console.log("\n=== API KEY CREATED ===");
  console.log(`API Key: ${apiKey}`);
  console.log(`Key ID: ${keyId}`);
  console.log(`App Name: ${appName}`);
  console.log(`Contact: ${contactEmail}`);
  console.log(`Tier: ${tier}`);
  console.log(`Expires: ${expiresAt.toISOString()}`);
  console.log(`\nRate Limits (${tier} tier):`);
  console.log(`  - ${TIER_LIMITS[tier].requestsPerMinute} requests/minute`);
  console.log(`  - ${TIER_LIMITS[tier].dailyLimit} requests/day`);
  console.log("\nIMPORTANT: Save this API key securely. It cannot be retrieved again.");
}

/**
 * List all API keys
 */
function listKeys(): void {
  console.log("Fetching API keys...\n");

  const keyNames = kvList("key:");
  if (keyNames.length === 0) {
    console.log("No API keys found.");
    return;
  }

  console.log("=== API KEYS ===\n");
  console.log("Key ID          | App Name           | Tier      | Active | Expires");
  console.log("----------------+--------------------+-----------+--------+----------------------");

  for (const keyName of keyNames) {
    const metadata = kvGet<ApiKeyMetadata>(keyName);
    if (metadata) {
      const expiresDate = new Date(metadata.expiresAt);
      const isExpired = expiresDate < new Date();
      const status = !metadata.active ? "Revoked" : isExpired ? "Expired" : "Active";

      console.log(
        `${metadata.keyId.padEnd(15)} | ` +
          `${metadata.appName.slice(0, 18).padEnd(18)} | ` +
          `${metadata.tier.padEnd(9)} | ` +
          `${status.padEnd(6)} | ` +
          `${expiresDate.toISOString().split("T")[0]}`
      );
    }
  }
}

/**
 * Get info about an API key
 */
async function getKeyInfo(apiKey: string): Promise<void> {
  if (!API_KEY_REGEX.test(apiKey)) {
    console.error("Error: Invalid API key format");
    process.exit(1);
  }

  const keyHash = await hashApiKey(apiKey);
  const metadata = kvGet<ApiKeyMetadata>(`key:${keyHash}`);
  if (!metadata) {
    console.error("Error: API key not found");
    process.exit(1);
  }

  const expiresDate = new Date(metadata.expiresAt);
  const isExpired = expiresDate < new Date();

  console.log("=== API KEY INFO ===\n");
  console.log(`Key ID: ${metadata.keyId}`);
  console.log(`App Name: ${metadata.appName}`);
  console.log(`Contact: ${metadata.contactEmail}`);
  console.log(`Tier: ${metadata.tier}`);
  console.log(`Created: ${metadata.createdAt}`);
  console.log(`Expires: ${metadata.expiresAt}`);
  console.log(`Active: ${metadata.active ? "Yes" : "No (Revoked)"}`);
  console.log(`Status: ${!metadata.active ? "Revoked" : isExpired ? "Expired" : "Valid"}`);
  console.log(`\nRate Limits (${metadata.tier} tier):`);
  console.log(`  - ${TIER_LIMITS[metadata.tier].requestsPerMinute} requests/minute`);
  console.log(`  - ${TIER_LIMITS[metadata.tier].dailyLimit} requests/day`);
}

/**
 * Revoke an API key
 */
async function revokeKey(apiKey: string): Promise<void> {
  if (!API_KEY_REGEX.test(apiKey)) {
    console.error("Error: Invalid API key format");
    process.exit(1);
  }

  const keyHash = await hashApiKey(apiKey);
  const metadata = kvGet<ApiKeyMetadata>(`key:${keyHash}`);
  if (!metadata) {
    console.error("Error: API key not found");
    process.exit(1);
  }

  if (!metadata.active) {
    console.log("API key is already revoked.");
    return;
  }

  metadata.active = false;
  kvPut(`key:${keyHash}`, JSON.stringify(metadata));

  console.log("=== API KEY REVOKED ===");
  console.log(`Key ID: ${metadata.keyId}`);
  console.log(`App Name: ${metadata.appName}`);
  console.log("\nThe key has been deactivated and can no longer be used.");
}

/**
 * Renew an API key (extend expiration by 30 days)
 */
async function renewKey(apiKey: string): Promise<void> {
  if (!API_KEY_REGEX.test(apiKey)) {
    console.error("Error: Invalid API key format");
    process.exit(1);
  }

  const keyHash = await hashApiKey(apiKey);
  const metadata = kvGet<ApiKeyMetadata>(`key:${keyHash}`);
  if (!metadata) {
    console.error("Error: API key not found");
    process.exit(1);
  }

  const now = new Date();
  const expiresAt = new Date(now);
  expiresAt.setDate(expiresAt.getDate() + 30);

  metadata.expiresAt = expiresAt.toISOString();
  kvPut(`key:${keyHash}`, JSON.stringify(metadata));

  console.log("=== API KEY RENEWED ===");
  console.log(`Key ID: ${metadata.keyId}`);
  console.log(`App Name: ${metadata.appName}`);
  console.log(`New Expiration: ${metadata.expiresAt}`);
}

/**
 * Get usage statistics for an API key
 */
async function getKeyUsage(apiKey: string, days: number = 7): Promise<void> {
  if (!API_KEY_REGEX.test(apiKey)) {
    console.error("Error: Invalid API key format");
    process.exit(1);
  }

  const metadata = kvGet<ApiKeyMetadata>(`key:${apiKey}`);
  if (!metadata) {
    console.error("Error: API key not found");
    process.exit(1);
  }

  console.log(`=== USAGE FOR ${metadata.appName} (last ${days} days) ===\n`);
  console.log("Date       | Requests | Success | Failed | STX Volume    | Fees Paid");
  console.log("-----------+----------+---------+--------+---------------+-------------");

  let totalRequests = 0;
  let totalSuccess = 0;
  let totalFailed = 0;
  let totalVolume = BigInt(0);
  let totalFees = BigInt(0);

  for (let i = 0; i < days; i++) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split("T")[0];

    const usage = kvGet<ApiKeyUsage>(`usage:daily:${metadata.keyId}:${dateStr}`);

    if (usage) {
      totalRequests += usage.requests;
      totalSuccess += usage.success;
      totalFailed += usage.failed;
      totalVolume += BigInt(usage.volume.STX);
      totalFees += BigInt(usage.feesPaid);

      console.log(
        `${dateStr} | ` +
          `${usage.requests.toString().padStart(8)} | ` +
          `${usage.success.toString().padStart(7)} | ` +
          `${usage.failed.toString().padStart(6)} | ` +
          `${usage.volume.STX.padStart(13)} | ` +
          `${usage.feesPaid.padStart(11)}`
      );
    } else {
      console.log(
        `${dateStr} | ` +
          `${"-".padStart(8)} | ` +
          `${"-".padStart(7)} | ` +
          `${"-".padStart(6)} | ` +
          `${"-".padStart(13)} | ` +
          `${"-".padStart(11)}`
      );
    }
  }

  console.log("-----------+----------+---------+--------+---------------+-------------");
  console.log(
    `TOTAL      | ` +
      `${totalRequests.toString().padStart(8)} | ` +
      `${totalSuccess.toString().padStart(7)} | ` +
      `${totalFailed.toString().padStart(6)} | ` +
      `${totalVolume.toString().padStart(13)} | ` +
      `${totalFees.toString().padStart(11)}`
  );

  const limits = TIER_LIMITS[metadata.tier];
  console.log(`\nDaily Limit: ${limits.dailyLimit} requests/day`);
}

/**
 * Parse command line arguments
 */
function parseArgs(): { command: string; args: Record<string, string> } {
  const args = process.argv.slice(2);
  const command = args[0] || "help";
  const parsed: Record<string, string> = {};

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = args[i + 1];
      if (value && !value.startsWith("--")) {
        parsed[key] = value;
        i++;
      } else {
        parsed[key] = "true";
      }
    } else if (!parsed._positional) {
      parsed._positional = arg;
    }
  }

  return { command, args: parsed };
}

/**
 * Show help
 */
function showHelp(): void {
  console.log(`
API Key Management CLI

Usage:
  npm run keys -- <command> [options]

Commands:
  create    Create a new API key
  list      List all API keys
  info      Get details about an API key
  revoke    Revoke an API key
  renew     Extend API key expiration
  usage     View usage statistics

Options for 'create':
  --app <name>      Application name (required)
  --email <email>   Contact email (required)
  --tier <tier>     Rate limit tier: free, standard, unlimited (default: free)
  --env <env>       Key environment: test, live (default: test)

Options for 'usage':
  --days <n>        Number of days to show (default: 7)

Environment:
  WRANGLER_ENV      Wrangler environment (staging, production)

Examples:
  npm run keys -- create --app "My App" --email "dev@example.com"
  npm run keys -- create --app "Premium App" --email "dev@example.com" --tier standard
  npm run keys -- list
  npm run keys -- info x402_sk_test_a1b2c3d4...
  npm run keys -- revoke x402_sk_test_a1b2c3d4...
  npm run keys -- renew x402_sk_test_a1b2c3d4...
  npm run keys -- usage x402_sk_test_a1b2c3d4... --days 30

Rate Limit Tiers:
  free       ${TIER_LIMITS.free.requestsPerMinute} req/min, ${TIER_LIMITS.free.dailyLimit} req/day
  standard   ${TIER_LIMITS.standard.requestsPerMinute} req/min, ${TIER_LIMITS.standard.dailyLimit} req/day
  unlimited  No limits
`);
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const { command, args } = parseArgs();

  switch (command) {
    case "create": {
      if (!args.app || !args.email) {
        console.error("Error: --app and --email are required");
        console.error("Usage: npm run keys -- create --app <name> --email <email>");
        process.exit(1);
      }

      // Validate email format
      if (!EMAIL_REGEX.test(args.email)) {
        console.error(`Error: Invalid email format "${args.email}"`);
        process.exit(1);
      }

      // Validate tier
      const tier = args.tier || "free";
      if (!VALID_TIERS.includes(tier as RateLimitTier)) {
        console.error(`Error: Invalid tier "${tier}". Valid tiers are: ${VALID_TIERS.join(", ")}`);
        process.exit(1);
      }

      // Validate environment
      const env = args.env || "test";
      if (!VALID_ENVS.includes(env as "test" | "live")) {
        console.error(`Error: Invalid env "${env}". Valid environments are: ${VALID_ENVS.join(", ")}`);
        process.exit(1);
      }

      await createKey(args.app, args.email, tier as RateLimitTier, env as "test" | "live");
      break;
    }

    case "list":
      listKeys();
      break;

    case "info":
      if (!args._positional) {
        console.error("Error: API key is required");
        console.error("Usage: npm run keys -- info <api-key>");
        process.exit(1);
      }
      await getKeyInfo(args._positional);
      break;

    case "revoke":
      if (!args._positional) {
        console.error("Error: API key is required");
        console.error("Usage: npm run keys -- revoke <api-key>");
        process.exit(1);
      }
      await revokeKey(args._positional);
      break;

    case "renew":
      if (!args._positional) {
        console.error("Error: API key is required");
        console.error("Usage: npm run keys -- renew <api-key>");
        process.exit(1);
      }
      await renewKey(args._positional);
      break;

    case "usage":
      if (!args._positional) {
        console.error("Error: API key is required");
        console.error("Usage: npm run keys -- usage <api-key> [--days <n>]");
        process.exit(1);
      }
      await getKeyUsage(args._positional, parseInt(args.days || "7", 10));
      break;

    case "help":
    default:
      showHelp();
      break;
  }
}

main().catch((e) => {
  console.error("Error:", e.message);
  process.exit(1);
});
