import { EnvSecretsProvider, type SecretsProvider } from '@gateway/security';

/**
 * Environment access, centralised and fail-fast.
 *
 * Every value the API depends on is read exactly once, here, and validated
 * before the server starts accepting traffic - a missing `DATABASE_URL`
 * should crash on boot, not on the first request that happens to touch it.
 *
 * Actual secrets (connection strings, signing keys, third-party API keys) go
 * through the injected `SecretsProvider` rather than `env` directly - see
 * `@gateway/security`'s `secrets-provider.ts`. Everything else (ports,
 * timeouts, feature flags) is plain config, not a secret, and stays a direct
 * env read.
 */

export interface AppConfig {
  nodeEnv: string;
  port: number;
  host: string;
  corsAllowedOrigins: string[];
  databaseUrl: string;
  jwtAccessSecret: string;
  jwtRefreshSecret: string;
  jwtAccessTtlSeconds: number;
  jwtRefreshTtlSeconds: number;
  jwtIssuer: string;
  jwtAudience: string;
  rateLimitAuthPerMinute: number;
  encryptionKey: string;
  encryptionKeyId: string;
  invoiceDefaultExpirySeconds: number;
  invoiceMaxExpirySeconds: number;
  exchangeRateProviders: string[];
  exchangeRateTimeoutMs: number;
  exchangeRateMaxAgeSeconds: number;
  exchangeRateCacheTtlSeconds: number;
  coingeckoApiKey: string | undefined;
  binanceApiBase: string;
  rateLimitApiPerMinute: number;
  rateLimitInvoiceCreatePerMinute: number;
  rateLimitTrustProxy: boolean;
  webhookReplayWindowSeconds: number;
  redisUrl: string;
  redisCacheDb: number;
  /** Separate from `port` - see ADR 0019: `/metrics` is never served on the public listener. */
  metricsEnabled: boolean;
  metricsPort: number;
  /** Upper bound on how long SIGTERM/SIGINT waits for in-flight requests before forcing close (main.ts). */
  shutdownTimeoutMs: number;
  /**
   * `disabled` (default) wires `DisabledSigningBackend` - fail-closed, no
   * signature can ever be produced. `emulated-hsm-staging` wires
   * `HsmBackedSigningBackend` over `EmulatedHsmKeyStore` - a software
   * emulation for demonstrating the signing architecture, never a real
   * KMS/HSM. `validateProductionConfig` refuses anything but `disabled` in
   * production (see ADR 0026) - Mode A (custodial signing) is not live.
   */
  signingBackend: 'disabled' | 'emulated-hsm-staging';
  /** Lowercased destination addresses the signing policy allows. Empty by default - nothing is allowlisted until an operator configures one. */
  signingAllowedDestinations: string[];
  signingMaxAmountPerTx: bigint;
  signingMaxAmountPerWindow: bigint;
  signingWindowSeconds: number;
  signingRequiredApprovals: number;
}

/** For required config that is a label, not a secret (e.g. a key *id*, not the key itself). */
function requiredEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`missing required environment variable: ${key}`);
  return value;
}

function int(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) throw new Error(`${key} must be an integer, got "${raw}"`);
  return parsed;
}

function csv(env: NodeJS.ProcessEnv, key: string, fallback: string[]): string[] {
  const raw = env[key];
  if (!raw) return fallback;
  return raw.split(',').map((v) => v.trim()).filter(Boolean);
}

function bool(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  return raw.toLowerCase() === 'true';
}

function bigintEnv(env: NodeJS.ProcessEnv, key: string, fallback: bigint): bigint {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  try {
    return BigInt(raw);
  } catch {
    throw new Error(`${key} must be an integer (smallest units), got "${raw}"`);
  }
}

/**
 * `secrets` defaults to reading `env` (via `EnvSecretsProvider`) so every
 * existing call site (`loadConfig()`, no arguments) is unaffected. Passing a
 * different `SecretsProvider` - a KMS/Vault-backed one - is the whole point
 * of the seam: this function's own logic never changes when the secrets
 * backend does.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  secrets: SecretsProvider = new EnvSecretsProvider(env),
): AppConfig {
  return {
    nodeEnv: env.NODE_ENV ?? 'development',
    port: int(env, 'API_PORT', 4000),
    host: env.API_HOST ?? '0.0.0.0',
    corsAllowedOrigins: csv(env, 'CORS_ALLOWED_ORIGINS', ['http://localhost:3000']),
    databaseUrl: secrets.requireSecret('DATABASE_URL'),
    jwtAccessSecret: secrets.requireSecret('JWT_ACCESS_SECRET'),
    jwtRefreshSecret: secrets.requireSecret('JWT_REFRESH_SECRET'),
    jwtAccessTtlSeconds: int(env, 'JWT_ACCESS_TTL_SECONDS', 900),
    jwtRefreshTtlSeconds: int(env, 'JWT_REFRESH_TTL_SECONDS', 2_592_000),
    jwtIssuer: env.JWT_ISSUER ?? 'crypto-payment-gateway',
    jwtAudience: env.JWT_AUDIENCE ?? 'gateway-dashboard',
    rateLimitAuthPerMinute: int(env, 'RATE_LIMIT_AUTH_PER_MINUTE', 10),
    encryptionKey: secrets.requireSecret('ENCRYPTION_KEY'),
    encryptionKeyId: requiredEnv(env, 'ENCRYPTION_KEY_ID'),
    invoiceDefaultExpirySeconds: int(env, 'INVOICE_DEFAULT_EXPIRY_SECONDS', 900),
    invoiceMaxExpirySeconds: int(env, 'INVOICE_MAX_EXPIRY_SECONDS', 86_400),
    exchangeRateProviders: csv(env, 'EXCHANGE_RATE_PROVIDERS', ['coingecko', 'binance']),
    exchangeRateTimeoutMs: int(env, 'EXCHANGE_RATE_TIMEOUT_MS', 3000),
    exchangeRateMaxAgeSeconds: int(env, 'EXCHANGE_RATE_MAX_AGE_SECONDS', 120),
    exchangeRateCacheTtlSeconds: int(env, 'EXCHANGE_RATE_CACHE_TTL_SECONDS', 30),
    coingeckoApiKey: secrets.getSecret('COINGECKO_API_KEY'),
    binanceApiBase: env.BINANCE_API_BASE ?? 'https://api.binance.com',
    rateLimitApiPerMinute: int(env, 'RATE_LIMIT_API_PER_MINUTE', 120),
    rateLimitInvoiceCreatePerMinute: int(env, 'RATE_LIMIT_INVOICE_CREATE_PER_MINUTE', 60),
    rateLimitTrustProxy: bool(env, 'RATE_LIMIT_TRUST_PROXY', false),
    webhookReplayWindowSeconds: int(env, 'WEBHOOK_REPLAY_WINDOW_SECONDS', 300),
    redisUrl: secrets.requireSecret('REDIS_URL'),
    redisCacheDb: int(env, 'REDIS_CACHE_DB', 0),
    metricsEnabled: bool(env, 'METRICS_ENABLED', true),
    metricsPort: int(env, 'METRICS_PORT', 9464),
    shutdownTimeoutMs: int(env, 'SHUTDOWN_TIMEOUT_MS', 10_000),
    signingBackend: env.SIGNING_BACKEND === 'emulated-hsm-staging' ? 'emulated-hsm-staging' : 'disabled',
    signingAllowedDestinations: csv(env, 'SIGNING_ALLOWED_DESTINATIONS', []).map((a) => a.toLowerCase()),
    signingMaxAmountPerTx: bigintEnv(env, 'SIGNING_MAX_AMOUNT_PER_TX', 0n),
    signingMaxAmountPerWindow: bigintEnv(env, 'SIGNING_MAX_AMOUNT_PER_WINDOW', 0n),
    signingWindowSeconds: int(env, 'SIGNING_WINDOW_SECONDS', 86_400),
    signingRequiredApprovals: int(env, 'SIGNING_REQUIRED_APPROVALS', 2),
  };
}

export const APP_CONFIG = 'APP_CONFIG';

/**
 * Catches the two ways a production boot most plausibly carries a
 * development-shaped config forward unnoticed: a placeholder secret copied
 * straight from `.env.example`/`secret.example.yaml` and never replaced, and
 * a CORS origin that still names `localhost` or allows plain HTTP (which
 * nothing behind a real reverse-proxy/TLS setup would ever send as an
 * `Origin` header). `ENCRYPTION_KEY`'s own shape (32 bytes) is already
 * enforced by `EnvKeyProvider` at construction - not re-checked here.
 *
 * Called once at boot, before the app starts accepting traffic (`main.ts`);
 * a no-op outside `NODE_ENV=production` so development and test configs are
 * never held to this bar.
 */
const PLACEHOLDER_SECRET_PATTERNS = [/change_?me/i, /replace_with/i, /^secret$/i, /^password$/i, /^example$/i, /^placeholder$/i, /^test$/i];

export function validateProductionConfig(config: AppConfig): void {
  if (config.nodeEnv !== 'production') return;
  const problems: string[] = [];

  for (const [name, value] of [
    ['JWT_ACCESS_SECRET', config.jwtAccessSecret],
    ['JWT_REFRESH_SECRET', config.jwtRefreshSecret],
  ] as const) {
    if (value.length < 32) problems.push(`${name} must be at least 32 characters in production, got ${value.length}`);
    if (PLACEHOLDER_SECRET_PATTERNS.some((pattern) => pattern.test(value))) {
      problems.push(`${name} looks like a placeholder value (from .env.example or secret.example.yaml), not a real secret`);
    }
  }
  if (config.jwtAccessSecret === config.jwtRefreshSecret) {
    problems.push('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must not be equal');
  }

  if (config.corsAllowedOrigins.length === 0) {
    problems.push('CORS_ALLOWED_ORIGINS must not be empty in production');
  }
  for (const origin of config.corsAllowedOrigins) {
    if (origin === '*') problems.push('CORS_ALLOWED_ORIGINS must not be "*" in production');
    else if (origin.includes('localhost') || origin.includes('127.0.0.1')) {
      problems.push(`CORS_ALLOWED_ORIGINS must not contain a localhost origin in production: "${origin}"`);
    } else if (!origin.startsWith('https://')) {
      problems.push(`CORS_ALLOWED_ORIGINS entry must be an https:// origin in production: "${origin}"`);
    }
  }

  if (config.signingBackend !== 'disabled') {
    problems.push(
      `SIGNING_BACKEND must be "disabled" in production - "${config.signingBackend}" is a software emulation for demonstrating the signing architecture (ADR 0026), never a real KMS/HSM, and Mode A (custodial signing) is not live`,
    );
  }

  if (problems.length > 0) {
    throw new Error(`refusing to start in production with unsafe configuration:\n  - ${problems.join('\n  - ')}`);
  }
}
