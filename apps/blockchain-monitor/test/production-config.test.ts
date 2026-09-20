import { describe, expect, it } from 'vitest';
import { loadMonitorConfig, validateProductionConfig } from '../src/config.js';

describe('validateProductionConfig', () => {
  it('is a no-op outside production, even with no network configured', () => {
    const config = loadMonitorConfig({ NODE_ENV: 'development', DATABASE_URL: 'postgresql://x/y' });
    expect(() => validateProductionConfig(config)).not.toThrow();
  });

  it('rejects production with no network configured', () => {
    const config = loadMonitorConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgresql://x/y' });
    expect(() => validateProductionConfig(config)).toThrow(/no network RPC URL configured/);
  });

  it('accepts production with only a Bitcoin network configured, no EVM network', () => {
    const config = loadMonitorConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://x/y',
      BITCOIN_RPC_URL: 'https://bitcoin.example.com',
      BITCOIN_RPC_USER: 'gateway',
      BITCOIN_RPC_PASSWORD: 'secret',
    });
    expect(() => validateProductionConfig(config)).not.toThrow();
  });

  it('rejects a mainnet network with no fallback RPC URL', () => {
    const config = loadMonitorConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://x/y',
      ETHEREUM_RPC_URL: 'https://mainnet.example.com',
    });
    expect(() => validateProductionConfig(config)).toThrow(/ETHEREUM: no fallback RPC URL configured/);
  });

  it('accepts a mainnet network that has a fallback RPC URL configured', () => {
    const config = loadMonitorConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://x/y',
      ETHEREUM_RPC_URL: 'https://mainnet.example.com',
      ETHEREUM_RPC_FALLBACK_URL: 'https://mainnet-backup.example.com',
      POLYGON_RPC_URL: 'https://polygon.example.com',
      POLYGON_RPC_FALLBACK_URL: 'https://polygon-backup.example.com',
      BSC_RPC_URL: 'https://bsc.example.com',
      BSC_RPC_FALLBACK_URL: 'https://bsc-backup.example.com',
    });
    expect(() => validateProductionConfig(config)).not.toThrow();
  });

  it('does not require a fallback for a testnet network in production', () => {
    const config = loadMonitorConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://x/y',
      ETHEREUM_SEPOLIA_RPC_URL: 'https://sepolia.example.com',
    });
    expect(() => validateProductionConfig(config)).not.toThrow();
  });
});
