import { describe, expect, it } from 'vitest';
import { loadConfig, validateProductionConfig } from '../src/config/env.js';
import type { SecretsProvider } from '@gateway/security';

/**
 * Phase 11 (production readiness): `NODE_ENV=production` must refuse to boot
 * with a development-shaped config - a placeholder secret never replaced, or
 * a CORS origin that could never be a real browser's `Origin` header behind
 * TLS. This is the test the exit criteria ("configuration validation refuses
 * unsafe production configuration") points at.
 */
function secretsFrom(overrides: Record<string, string>): SecretsProvider {
  return {
    getSecret: (name) => overrides[name],
    requireSecret: (name) => {
      const value = overrides[name];
      if (value === undefined) throw new Error(`missing required environment variable: ${name}`);
      return value;
    },
  };
}

const REAL_SECRETS = {
  DATABASE_URL: 'postgresql://gateway:s3cret@postgres.internal:5432/gateway',
  JWT_ACCESS_SECRET: 'a'.repeat(48),
  JWT_REFRESH_SECRET: 'b'.repeat(48),
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  REDIS_URL: 'redis://redis.internal:6379',
};

function productionConfig(envOverrides: Record<string, string> = {}, secretOverrides: Record<string, string> = {}) {
  return loadConfig(
    { NODE_ENV: 'production', ENCRYPTION_KEY_ID: 'prod-1', CORS_ALLOWED_ORIGINS: 'https://app.example.com', ...envOverrides },
    secretsFrom({ ...REAL_SECRETS, ...secretOverrides }),
  );
}

describe('validateProductionConfig', () => {
  it('is a no-op outside production', () => {
    const config = loadConfig(
      { NODE_ENV: 'development', ENCRYPTION_KEY_ID: 'dev-1', CORS_ALLOWED_ORIGINS: 'http://localhost:3000' },
      secretsFrom({ ...REAL_SECRETS, JWT_ACCESS_SECRET: 'short', JWT_REFRESH_SECRET: 'short' }),
    );
    expect(() => validateProductionConfig(config)).not.toThrow();
  });

  it('accepts a real production-shaped config', () => {
    expect(() => validateProductionConfig(productionConfig())).not.toThrow();
  });

  it('rejects a JWT secret shorter than 32 characters', () => {
    const config = productionConfig({}, { JWT_ACCESS_SECRET: 'short' });
    expect(() => validateProductionConfig(config)).toThrow(/JWT_ACCESS_SECRET must be at least 32 characters/);
  });

  it('rejects a placeholder JWT secret copied from .env.example', () => {
    const config = productionConfig({}, { JWT_ACCESS_SECRET: 'replace_with_48_random_bytes_xxxxxxxxxxxxxxxx' });
    expect(() => validateProductionConfig(config)).toThrow(/looks like a placeholder value/);
  });

  it('rejects a placeholder JWT secret copied from secret.example.yaml', () => {
    const config = productionConfig({}, { JWT_ACCESS_SECRET: 'CHANGE_ME_48_RANDOM_BYTES_xxxxxxxxxxxxxxxxxxx' });
    expect(() => validateProductionConfig(config)).toThrow(/looks like a placeholder value/);
  });

  it('rejects identical access and refresh secrets', () => {
    const config = productionConfig({}, { JWT_REFRESH_SECRET: REAL_SECRETS.JWT_ACCESS_SECRET });
    expect(() => validateProductionConfig(config)).toThrow(/must not be equal/);
  });

  it('rejects an empty CORS_ALLOWED_ORIGINS', () => {
    // A literal empty string falls back to loadConfig's own default
    // (['http://localhost:3000']) rather than an empty array - a single
    // whitespace entry is what actually survives csv()'s split/trim/filter
    // as an empty array, which is the case this rule exists for.
    const config = productionConfig({ CORS_ALLOWED_ORIGINS: ' ' });
    expect(() => validateProductionConfig(config)).toThrow(/CORS_ALLOWED_ORIGINS must not be empty/);
  });

  it('rejects a wildcard CORS origin', () => {
    const config = productionConfig({ CORS_ALLOWED_ORIGINS: '*' });
    expect(() => validateProductionConfig(config)).toThrow(/must not be "\*"/);
  });

  it('rejects a localhost CORS origin', () => {
    const config = productionConfig({ CORS_ALLOWED_ORIGINS: 'http://localhost:3000' });
    expect(() => validateProductionConfig(config)).toThrow(/must not contain a localhost origin/);
  });

  it('rejects a plain http:// CORS origin', () => {
    const config = productionConfig({ CORS_ALLOWED_ORIGINS: 'http://app.example.com' });
    expect(() => validateProductionConfig(config)).toThrow(/must be an https:\/\/ origin/);
  });

  it('rejects a non-disabled SIGNING_BACKEND - Mode A custodial signing is not live', () => {
    const config = productionConfig({ SIGNING_BACKEND: 'emulated-hsm-staging' });
    expect(() => validateProductionConfig(config)).toThrow(/SIGNING_BACKEND must be "disabled" in production/);
  });

  it('accepts SIGNING_BACKEND left unset (defaults to disabled)', () => {
    expect(() => validateProductionConfig(productionConfig())).not.toThrow();
  });

  it('collects every problem in one error rather than stopping at the first', () => {
    const config = productionConfig({ CORS_ALLOWED_ORIGINS: '*' }, { JWT_ACCESS_SECRET: 'short' });
    try {
      validateProductionConfig(config);
      expect.unreachable('expected validateProductionConfig to throw');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toMatch(/JWT_ACCESS_SECRET must be at least 32 characters/);
      expect(message).toMatch(/must not be "\*"/);
    }
  });
});
