import type { SecretsProvider } from '@gateway/security';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/env.js';

/**
 * `loadConfig()` with no arguments (every other call site) reads secrets
 * from `process.env` via the default `EnvSecretsProvider` - already
 * exercised by every other test in this suite booting the app. This is the
 * one test that swaps in a different `SecretsProvider`, which is the entire
 * point of Phase 8's secrets-management seam: proving a KMS/Vault-backed
 * provider could plug in here without `loadConfig()` changing at all.
 */
function fakeSecrets(overrides: Record<string, string>): SecretsProvider {
  return {
    getSecret: (name) => overrides[name],
    requireSecret: (name) => {
      const value = overrides[name];
      if (value === undefined) throw new Error(`missing required environment variable: ${name}`);
      return value;
    },
  };
}

describe('loadConfig secrets seam', () => {
  it('reads secret fields from the injected SecretsProvider, not from env', () => {
    const config = loadConfig(
      { NODE_ENV: 'test', ENCRYPTION_KEY_ID: 'test-key' },
      fakeSecrets({
        DATABASE_URL: 'postgresql://from-provider/db',
        JWT_ACCESS_SECRET: 'access-secret-from-provider',
        JWT_REFRESH_SECRET: 'refresh-secret-from-provider',
        ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
        REDIS_URL: 'redis://from-provider:6379',
      }),
    );

    expect(config.databaseUrl).toBe('postgresql://from-provider/db');
    expect(config.jwtAccessSecret).toBe('access-secret-from-provider');
    expect(config.jwtRefreshSecret).toBe('refresh-secret-from-provider');
    expect(config.redisUrl).toBe('redis://from-provider:6379');
  });

  it('surfaces the provider missing-secret error rather than falling back silently', () => {
    expect(() => loadConfig({ NODE_ENV: 'test' }, fakeSecrets({}))).toThrow(/DATABASE_URL/);
  });
});
