import { describe, expect, it } from 'vitest';
import { loadWorkerConfig, validateProductionConfig } from '../src/config.js';

describe('validateProductionConfig', () => {
  it('is a no-op outside production even with the SSRF guard disabled', () => {
    const config = loadWorkerConfig({ NODE_ENV: 'development', DATABASE_URL: 'postgresql://x/y', WEBHOOK_BLOCK_PRIVATE_NETWORKS: 'false' });
    expect(() => validateProductionConfig(config)).not.toThrow();
  });

  it('accepts production with the SSRF guard left on (the default)', () => {
    const config = loadWorkerConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgresql://x/y' });
    expect(() => validateProductionConfig(config)).not.toThrow();
  });

  it('rejects production with WEBHOOK_BLOCK_PRIVATE_NETWORKS=false', () => {
    const config = loadWorkerConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgresql://x/y', WEBHOOK_BLOCK_PRIVATE_NETWORKS: 'false' });
    expect(() => validateProductionConfig(config)).toThrow(/WEBHOOK_BLOCK_PRIVATE_NETWORKS=false/);
  });
});
