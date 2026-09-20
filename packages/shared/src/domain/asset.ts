import { Network, type NetworkValue } from './network.js';

/**
 * ASSET ALLOWLIST.
 *
 * The gateway credits ONLY assets listed here. Anything else that lands on a
 * deposit address is recorded as UNSUPPORTED_ASSET_RECEIVED and queued for
 * manual review - never credited, never silently dropped.
 *
 * Why an allowlist and not "any ERC-20":
 *  - anyone can deploy a contract whose name/symbol is "USDT"; only the
 *    contract ADDRESS is authoritative;
 *  - decimals differ per deployment (USDT is 6 dp on Ethereum but 18 dp on
 *    BSC) and a mismatch misprices by 10^12;
 *  - fee-on-transfer and rebasing tokens break the assumption that a Transfer
 *    event amount equals the amount actually received;
 *  - an asset with no reliable price feed cannot back a fiat-denominated
 *    invoice.
 */

/** How the token behaves on transfer - anything but `standard` needs special handling. */
export type TransferSemantics = 'standard' | 'fee_on_transfer' | 'rebasing';

export interface AssetConfig {
  /** Stable key: `${network}:${symbol}`. */
  readonly id: string;
  readonly symbol: string;
  readonly displayName: string;
  readonly network: NetworkValue;
  /**
   * Lowercased token contract address, or `null` for the network's native coin.
   * Compared lowercased everywhere; never compare by symbol.
   */
  readonly contractAddress: string | null;
  readonly decimals: number;
  /** Default confirmation threshold; merchants may raise it, never lower it below this. */
  readonly requiredConfirmations: number;
  /**
   * Deposits below this are recorded but never open an invoice on their own -
   * they would cost more to sweep than they are worth (dust).
   */
  readonly minDepositUnits: bigint;
  readonly transferSemantics: TransferSemantics;
  /** Price feed symbols, in priority order. Empty = no fiat pricing allowed. */
  readonly priceFeedSymbols: readonly string[];
  readonly enabled: boolean;
}

function asset(config: Omit<AssetConfig, 'id'>): AssetConfig {
  return Object.freeze({
    ...config,
    id: `${config.network}:${config.symbol}`,
    contractAddress: config.contractAddress ? config.contractAddress.toLowerCase() : null,
  });
}

/**
 * NOTE FOR DEPLOYMENT: every contract address below must be re-verified against
 * the issuer's official documentation before this list is used with real funds.
 * They are checked into source so that a compromised database row cannot
 * redirect settlement to an attacker's token.
 */
const ASSET_LIST: readonly AssetConfig[] = Object.freeze([
  asset({
    symbol: 'BTC',
    displayName: 'Bitcoin',
    network: Network.BITCOIN,
    contractAddress: null,
    decimals: 8,
    requiredConfirmations: 2,
    minDepositUnits: 10_000n, // 0.0001 BTC
    transferSemantics: 'standard',
    priceFeedSymbols: ['BTC'],
    enabled: true,
  }),
  asset({
    symbol: 'ETH',
    displayName: 'Ether',
    network: Network.ETHEREUM,
    contractAddress: null,
    decimals: 18,
    requiredConfirmations: 12,
    minDepositUnits: 1_000_000_000_000_000n, // 0.001 ETH
    transferSemantics: 'standard',
    priceFeedSymbols: ['ETH'],
    enabled: true,
  }),
  asset({
    symbol: 'USDT',
    displayName: 'Tether USD',
    network: Network.ETHEREUM,
    contractAddress: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    decimals: 6,
    requiredConfirmations: 12,
    minDepositUnits: 1_000_000n, // 1 USDT
    transferSemantics: 'standard',
    priceFeedSymbols: ['USDT'],
    enabled: true,
  }),
  asset({
    symbol: 'USDC',
    displayName: 'USD Coin',
    network: Network.ETHEREUM,
    contractAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    decimals: 6,
    requiredConfirmations: 12,
    minDepositUnits: 1_000_000n,
    transferSemantics: 'standard',
    priceFeedSymbols: ['USDC'],
    enabled: true,
  }),
  asset({
    symbol: 'POL',
    displayName: 'Polygon Ecosystem Token',
    network: Network.POLYGON,
    contractAddress: null,
    decimals: 18,
    requiredConfirmations: 128,
    minDepositUnits: 1_000_000_000_000_000_000n, // 1 POL
    transferSemantics: 'standard',
    priceFeedSymbols: ['POL', 'MATIC'],
    enabled: true,
  }),
  asset({
    symbol: 'USDT',
    displayName: 'Tether USD (Polygon)',
    network: Network.POLYGON,
    contractAddress: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
    decimals: 6,
    requiredConfirmations: 128,
    minDepositUnits: 1_000_000n,
    transferSemantics: 'standard',
    priceFeedSymbols: ['USDT'],
    enabled: true,
  }),
  asset({
    symbol: 'USDC',
    displayName: 'USD Coin (Polygon native)',
    network: Network.POLYGON,
    contractAddress: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
    decimals: 6,
    requiredConfirmations: 128,
    minDepositUnits: 1_000_000n,
    transferSemantics: 'standard',
    priceFeedSymbols: ['USDC'],
    enabled: true,
  }),
  asset({
    symbol: 'BNB',
    displayName: 'BNB',
    network: Network.BSC,
    contractAddress: null,
    decimals: 18,
    requiredConfirmations: 15,
    minDepositUnits: 1_000_000_000_000_000n, // 0.001 BNB
    transferSemantics: 'standard',
    priceFeedSymbols: ['BNB'],
    enabled: true,
  }),
  asset({
    // 18 decimals, NOT 6 - the BSC deployment differs from Ethereum's.
    symbol: 'USDT',
    displayName: 'Tether USD (BSC)',
    network: Network.BSC,
    contractAddress: '0x55d398326f99059fF775485246999027B3197955',
    decimals: 18,
    requiredConfirmations: 15,
    minDepositUnits: 1_000_000_000_000_000_000n,
    transferSemantics: 'standard',
    priceFeedSymbols: ['USDT'],
    enabled: true,
  }),
  asset({
    symbol: 'USDC',
    displayName: 'USD Coin (BSC)',
    network: Network.BSC,
    contractAddress: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    decimals: 18,
    requiredConfirmations: 15,
    minDepositUnits: 1_000_000_000_000_000_000n,
    transferSemantics: 'standard',
    priceFeedSymbols: ['USDC'],
    enabled: true,
  }),
  // --- Testnet assets, for development and staging only. ---
  asset({
    symbol: 'ETH',
    displayName: 'Sepolia Ether',
    network: Network.ETHEREUM_SEPOLIA,
    contractAddress: null,
    decimals: 18,
    requiredConfirmations: 3,
    minDepositUnits: 1_000_000_000_000n,
    transferSemantics: 'standard',
    priceFeedSymbols: ['ETH'],
    enabled: true,
  }),
  asset({
    symbol: 'BTC',
    displayName: 'Testnet Bitcoin',
    network: Network.BITCOIN_TESTNET,
    contractAddress: null,
    decimals: 8,
    requiredConfirmations: 1,
    minDepositUnits: 1_000n,
    transferSemantics: 'standard',
    priceFeedSymbols: ['BTC'],
    enabled: true,
  }),
]);

const BY_ID = new Map<string, AssetConfig>(ASSET_LIST.map((a) => [a.id, a]));
const BY_CONTRACT = new Map<string, AssetConfig>(
  ASSET_LIST.filter((a) => a.contractAddress !== null).map((a) => [
    `${a.network}:${a.contractAddress}`,
    a,
  ]),
);

export function assetId(network: NetworkValue, symbol: string): string {
  return `${network}:${symbol}`;
}

/** Look up an allowlisted asset. Returns null for anything unknown or disabled. */
export function findAsset(network: NetworkValue, symbol: string): AssetConfig | null {
  const found = BY_ID.get(assetId(network, symbol));
  return found && found.enabled ? found : null;
}

export function requireAsset(network: NetworkValue, symbol: string): AssetConfig {
  const found = findAsset(network, symbol);
  if (!found) {
    throw new Error(`asset ${symbol} is not supported on ${network}`);
  }
  return found;
}

/**
 * Resolve an on-chain token contract to an allowlisted asset. This is the
 * function the blockchain monitor uses - matching on contract address, never
 * on the symbol reported by the contract itself.
 */
export function findAssetByContract(
  network: NetworkValue,
  contractAddress: string,
): AssetConfig | null {
  const found = BY_CONTRACT.get(`${network}:${contractAddress.toLowerCase()}`);
  return found && found.enabled ? found : null;
}

/** Native coin of a network (contractAddress === null). */
export function findNativeAsset(network: NetworkValue): AssetConfig | null {
  const found = ASSET_LIST.find((a) => a.network === network && a.contractAddress === null);
  return found && found.enabled ? found : null;
}

export function listAssets(
  options: { network?: NetworkValue; enabledOnly?: boolean } = {},
): AssetConfig[] {
  const enabledOnly = options.enabledOnly ?? true;
  return ASSET_LIST.filter(
    (a) =>
      (options.network === undefined || a.network === options.network) &&
      (!enabledOnly || a.enabled),
  );
}

export function isPriceable(config: AssetConfig): boolean {
  return config.priceFeedSymbols.length > 0;
}
