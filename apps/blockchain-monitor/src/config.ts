import { Network, getNetworkConfig, type NetworkValue } from '@gateway/shared';

/**
 * Environment access for the monitor, centralised and fail-fast - mirrors
 * `apps/worker/src/config.ts` and `apps/api/src/config/env.ts`.
 *
 * A network with no RPC URL configured simply has no entry here - `main.ts`
 * treats "not configured" as "disabled", not as an error, matching the
 * README's documented behaviour (".env.example: leave a network's URL empty
 * to disable its monitor").
 */

export interface EvmNetworkRpcConfig {
  network: NetworkValue;
  url: string;
  fallbackUrl?: string;
}

export interface BitcoinNetworkRpcConfig {
  network: NetworkValue;
  url: string;
  rpcUser?: string;
  rpcPassword?: string;
}

export interface MonitorConfig {
  nodeEnv: string;
  databaseUrl: string;
  pollIntervalMs: number;
  blockBatchSize: number;
  evmNetworks: EvmNetworkRpcConfig[];
  bitcoinNetworks: BitcoinNetworkRpcConfig[];
  /** `/health`, `/ready`, `/metrics` - never a publicly routed port (ADR 0019). */
  healthPort: number;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
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

/** Each entry pairs the network with the env vars that configure its RPC access. Order here is only iteration order. */
// Every mainnet network gets a fallbackKey - a single RPC provider is a
// single point of failure for confirmation processing on that network, and
// `validateProductionConfig` below requires one be set before a production
// boot proceeds. Testnets don't: a testnet outage isn't a real-money
// incident, so there's nothing to fail over to in practice.
const EVM_NETWORK_ENV: ReadonlyArray<{ network: NetworkValue; urlKey: string; fallbackKey?: string }> = [
  { network: Network.ETHEREUM, urlKey: 'ETHEREUM_RPC_URL', fallbackKey: 'ETHEREUM_RPC_FALLBACK_URL' },
  { network: Network.ETHEREUM_SEPOLIA, urlKey: 'ETHEREUM_SEPOLIA_RPC_URL' },
  { network: Network.POLYGON, urlKey: 'POLYGON_RPC_URL', fallbackKey: 'POLYGON_RPC_FALLBACK_URL' },
  { network: Network.POLYGON_AMOY, urlKey: 'POLYGON_AMOY_RPC_URL' },
  { network: Network.BSC, urlKey: 'BSC_RPC_URL', fallbackKey: 'BSC_RPC_FALLBACK_URL' },
  { network: Network.BSC_TESTNET, urlKey: 'BSC_TESTNET_RPC_URL' },
];

/**
 * Bitcoin has no fallback URL column (yet): a single self-hosted `bitcoind`
 * is the expected topology (unlike the EVM networks, which lean on
 * third-party RPC providers), so `validateProductionConfig` does not demand
 * one - see the comment there.
 */
const BITCOIN_NETWORK_ENV: ReadonlyArray<{ network: NetworkValue; urlKey: string; userKey: string; passwordKey: string }> = [
  { network: Network.BITCOIN, urlKey: 'BITCOIN_RPC_URL', userKey: 'BITCOIN_RPC_USER', passwordKey: 'BITCOIN_RPC_PASSWORD' },
  { network: Network.BITCOIN_TESTNET, urlKey: 'BITCOIN_TESTNET_RPC_URL', userKey: 'BITCOIN_TESTNET_RPC_USER', passwordKey: 'BITCOIN_TESTNET_RPC_PASSWORD' },
];

export function loadMonitorConfig(env: NodeJS.ProcessEnv = process.env): MonitorConfig {
  const evmNetworks: EvmNetworkRpcConfig[] = [];
  for (const entry of EVM_NETWORK_ENV) {
    const url = env[entry.urlKey];
    if (!url) continue; // not configured - this network's monitor is disabled
    const fallbackUrl = entry.fallbackKey ? env[entry.fallbackKey] || undefined : undefined;
    evmNetworks.push({ network: entry.network, url, fallbackUrl });
  }

  const bitcoinNetworks: BitcoinNetworkRpcConfig[] = [];
  for (const entry of BITCOIN_NETWORK_ENV) {
    const url = env[entry.urlKey];
    if (!url) continue; // not configured - this network's monitor is disabled
    bitcoinNetworks.push({ network: entry.network, url, rpcUser: env[entry.userKey] || undefined, rpcPassword: env[entry.passwordKey] || undefined });
  }

  return {
    nodeEnv: env.NODE_ENV ?? 'development',
    databaseUrl: required(env, 'DATABASE_URL'),
    pollIntervalMs: int(env, 'MONITOR_POLL_INTERVAL_MS', 5000),
    blockBatchSize: int(env, 'MONITOR_BLOCK_BATCH_SIZE', 50),
    evmNetworks,
    bitcoinNetworks,
    healthPort: int(env, 'MONITOR_HEALTH_PORT', 9466),
  };
}

/**
 * Production-readiness gate (Phase 11): a production monitor with no network
 * configured at all would boot successfully and confirm nothing, silently -
 * and a mainnet network configured with only one RPC provider has no
 * failover if that provider has an outage, which Phase 24's mainnet
 * validation exercises directly. Testnets are exempt - see the comment on
 * `EVM_NETWORK_ENV` above.
 */
export function validateProductionConfig(config: MonitorConfig): void {
  if (config.nodeEnv !== 'production') return;
  const problems: string[] = [];

  if (config.evmNetworks.length === 0 && config.bitcoinNetworks.length === 0) {
    problems.push('no network RPC URL configured (EVM or Bitcoin) - the monitor would start and confirm nothing');
  }
  for (const entry of config.evmNetworks) {
    if (!getNetworkConfig(entry.network).isTestnet && !entry.fallbackUrl) {
      problems.push(`${entry.network}: no fallback RPC URL configured for a mainnet network - a single provider outage stops confirmation processing on it`);
    }
  }

  if (problems.length > 0) {
    throw new Error(`refusing to start in production with unsafe configuration:\n  - ${problems.join('\n  - ')}`);
  }
}
