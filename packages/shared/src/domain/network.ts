import { AppError, ErrorCode } from '../errors/app-error.js';

/**
 * Supported blockchain networks.
 *
 * A network is identified by its own enum member, never by chain id alone, so
 * that a mainnet/testnet mix-up is a compile error rather than a lost payment.
 */
export const Network = {
  BITCOIN: 'BITCOIN',
  BITCOIN_TESTNET: 'BITCOIN_TESTNET',
  ETHEREUM: 'ETHEREUM',
  ETHEREUM_SEPOLIA: 'ETHEREUM_SEPOLIA',
  POLYGON: 'POLYGON',
  POLYGON_AMOY: 'POLYGON_AMOY',
  BSC: 'BSC',
  BSC_TESTNET: 'BSC_TESTNET',
} as const;

export type NetworkValue = (typeof Network)[keyof typeof Network];

/** How a network addresses a payment — drives the deposit-address strategy. */
export type AddressModel = 'utxo' | 'account';

export interface NetworkConfig {
  readonly network: NetworkValue;
  readonly displayName: string;
  readonly family: 'bitcoin' | 'evm';
  readonly addressModel: AddressModel;
  readonly isTestnet: boolean;
  /** EVM chain id; null for non-EVM networks. */
  readonly chainId: number | null;
  readonly nativeAsset: string;
  readonly nativeDecimals: number;
  /** Approximate seconds between blocks — used for ETA display and monitor lag alerts. */
  readonly averageBlockSeconds: number;
  /**
   * Blocks kept "hot" for reorg handling. Any block within this depth of the
   * tip may still be reorganised, so confirmations are recomputed for them.
   */
  readonly reorgDepth: number;
  readonly explorerTxUrl: (hash: string) => string;
  readonly explorerAddressUrl: (address: string) => string;
}

export const NETWORKS: Readonly<Record<NetworkValue, NetworkConfig>> = Object.freeze({
  [Network.BITCOIN]: {
    network: Network.BITCOIN,
    displayName: 'Bitcoin',
    family: 'bitcoin',
    addressModel: 'utxo',
    isTestnet: false,
    chainId: null,
    nativeAsset: 'BTC',
    nativeDecimals: 8,
    averageBlockSeconds: 600,
    reorgDepth: 6,
    explorerTxUrl: (hash) => `https://mempool.space/tx/${hash}`,
    explorerAddressUrl: (address) => `https://mempool.space/address/${address}`,
  },
  [Network.BITCOIN_TESTNET]: {
    network: Network.BITCOIN_TESTNET,
    displayName: 'Bitcoin Testnet',
    family: 'bitcoin',
    addressModel: 'utxo',
    isTestnet: true,
    chainId: null,
    nativeAsset: 'BTC',
    nativeDecimals: 8,
    averageBlockSeconds: 600,
    reorgDepth: 10,
    explorerTxUrl: (hash) => `https://mempool.space/testnet/tx/${hash}`,
    explorerAddressUrl: (address) => `https://mempool.space/testnet/address/${address}`,
  },
  [Network.ETHEREUM]: {
    network: Network.ETHEREUM,
    displayName: 'Ethereum',
    family: 'evm',
    addressModel: 'account',
    isTestnet: false,
    chainId: 1,
    nativeAsset: 'ETH',
    nativeDecimals: 18,
    averageBlockSeconds: 12,
    reorgDepth: 12,
    explorerTxUrl: (hash) => `https://etherscan.io/tx/${hash}`,
    explorerAddressUrl: (address) => `https://etherscan.io/address/${address}`,
  },
  [Network.ETHEREUM_SEPOLIA]: {
    network: Network.ETHEREUM_SEPOLIA,
    displayName: 'Ethereum Sepolia',
    family: 'evm',
    addressModel: 'account',
    isTestnet: true,
    chainId: 11155111,
    nativeAsset: 'ETH',
    nativeDecimals: 18,
    averageBlockSeconds: 12,
    reorgDepth: 12,
    explorerTxUrl: (hash) => `https://sepolia.etherscan.io/tx/${hash}`,
    explorerAddressUrl: (address) => `https://sepolia.etherscan.io/address/${address}`,
  },
  [Network.POLYGON]: {
    network: Network.POLYGON,
    displayName: 'Polygon',
    family: 'evm',
    addressModel: 'account',
    isTestnet: false,
    chainId: 137,
    nativeAsset: 'POL',
    nativeDecimals: 18,
    averageBlockSeconds: 2,
    reorgDepth: 128,
    explorerTxUrl: (hash) => `https://polygonscan.com/tx/${hash}`,
    explorerAddressUrl: (address) => `https://polygonscan.com/address/${address}`,
  },
  [Network.POLYGON_AMOY]: {
    network: Network.POLYGON_AMOY,
    displayName: 'Polygon Amoy',
    family: 'evm',
    addressModel: 'account',
    isTestnet: true,
    chainId: 80002,
    nativeAsset: 'POL',
    nativeDecimals: 18,
    averageBlockSeconds: 2,
    reorgDepth: 128,
    explorerTxUrl: (hash) => `https://amoy.polygonscan.com/tx/${hash}`,
    explorerAddressUrl: (address) => `https://amoy.polygonscan.com/address/${address}`,
  },
  [Network.BSC]: {
    network: Network.BSC,
    displayName: 'BNB Smart Chain',
    family: 'evm',
    addressModel: 'account',
    isTestnet: false,
    chainId: 56,
    nativeAsset: 'BNB',
    nativeDecimals: 18,
    averageBlockSeconds: 3,
    reorgDepth: 15,
    explorerTxUrl: (hash) => `https://bscscan.com/tx/${hash}`,
    explorerAddressUrl: (address) => `https://bscscan.com/address/${address}`,
  },
  [Network.BSC_TESTNET]: {
    network: Network.BSC_TESTNET,
    displayName: 'BNB Smart Chain Testnet',
    family: 'evm',
    addressModel: 'account',
    isTestnet: true,
    chainId: 97,
    nativeAsset: 'BNB',
    nativeDecimals: 18,
    averageBlockSeconds: 3,
    reorgDepth: 15,
    explorerTxUrl: (hash) => `https://testnet.bscscan.com/tx/${hash}`,
    explorerAddressUrl: (address) => `https://testnet.bscscan.com/address/${address}`,
  },
});

export function getNetworkConfig(network: NetworkValue): NetworkConfig {
  const config = NETWORKS[network];
  if (!config) throw new Error(`unknown network: ${network}`);
  return config;
}

export function isNetwork(value: string): value is NetworkValue {
  return Object.prototype.hasOwnProperty.call(NETWORKS, value);
}

/**
 * Enforces test/live key separation (Phase 17 pass 1) at the one place every
 * network-touching write already passes through: invoice creation and
 * deposit-address registration. `ApiKey.livemode` was stored and returned in
 * every response but never checked against the network a request actually
 * named - a test-mode key could create a mainnet invoice (and a live key a
 * testnet one) with nothing to stop it. `livemode=true` may only touch a
 * `isTestnet=false` network, and `livemode=false` only a `isTestnet=true`
 * one - imported from `@gateway/shared` by both `invoices.service.ts` and
 * `addresses.service.ts` rather than duplicated.
 */
export function assertNetworkMatchesLivemode(livemode: boolean, networkConfig: NetworkConfig): void {
  if (livemode === networkConfig.isTestnet) {
    throw new AppError(
      ErrorCode.NETWORK_LIVEMODE_MISMATCH,
      403,
      livemode
        ? `this is a live API key; ${networkConfig.displayName} is a testnet and cannot be used in live mode`
        : `this is a test API key; ${networkConfig.displayName} is a mainnet and cannot be used in test mode`,
    );
  }
}
