import { describe, expect, it } from 'vitest';
import {
  findAsset,
  findAssetByContract,
  findNativeAsset,
  listAssets,
  requireAsset,
} from '../src/domain/asset.js';
import { findFiatCurrency, requireFiatCurrency } from '../src/domain/fiat.js';
import {
  InvoiceStatus,
  isPayableStatus,
  isReviewStatus,
  isTerminalStatus,
} from '../src/domain/invoice-status.js';
import { NETWORKS, Network, getNetworkConfig, isNetwork } from '../src/domain/network.js';
import { ID_PREFIXES, isId, newId, parseIdKind } from '../src/ids/id.js';

describe('asset allowlist', () => {
  it('resolves an allowlisted asset per network', () => {
    const usdtEth = requireAsset(Network.ETHEREUM, 'USDT');
    expect(usdtEth.decimals).toBe(6);
    expect(usdtEth.contractAddress).toBe('0xdac17f958d2ee523a2206206994597c13d831ec7');
  });

  it('keeps per-network decimals distinct for the same symbol', () => {
    // The single most dangerous cross-chain assumption: USDT is not 6 dp everywhere.
    expect(requireAsset(Network.ETHEREUM, 'USDT').decimals).toBe(6);
    expect(requireAsset(Network.POLYGON, 'USDT').decimals).toBe(6);
    expect(requireAsset(Network.BSC, 'USDT').decimals).toBe(18);
  });

  it('rejects an asset that is not listed for the network', () => {
    expect(findAsset(Network.BITCOIN, 'USDT')).toBeNull();
    expect(findAsset(Network.ETHEREUM, 'DOGE')).toBeNull();
    expect(() => requireAsset(Network.ETHEREUM, 'SCAM')).toThrow(/not supported/);
  });

  it('matches tokens by contract address, case-insensitively', () => {
    const upper = findAssetByContract(Network.ETHEREUM, '0xDAC17F958D2EE523A2206206994597C13D831EC7');
    expect(upper?.symbol).toBe('USDT');
    expect(upper?.decimals).toBe(6);
  });

  it('does not match a contract deployed on a different network', () => {
    // The Ethereum USDT contract address must not resolve on Polygon.
    expect(findAssetByContract(Network.POLYGON, '0xdac17f958d2ee523a2206206994597c13d831ec7')).toBeNull();
  });

  it('returns null for an unknown contract - the monitor must not credit it', () => {
    expect(
      findAssetByContract(Network.ETHEREUM, '0x0000000000000000000000000000000000000bad'),
    ).toBeNull();
  });

  it('exposes the native coin of each network', () => {
    expect(findNativeAsset(Network.ETHEREUM)?.symbol).toBe('ETH');
    expect(findNativeAsset(Network.BSC)?.symbol).toBe('BNB');
    expect(findNativeAsset(Network.BITCOIN)?.symbol).toBe('BTC');
  });

  it('lists assets filtered by network', () => {
    const ethereumAssets = listAssets({ network: Network.ETHEREUM }).map((a) => a.symbol);
    expect(ethereumAssets).toEqual(expect.arrayContaining(['ETH', 'USDT', 'USDC']));
  });

  it('stores contract addresses lowercased and frozen', () => {
    for (const config of listAssets()) {
      expect(Object.isFrozen(config)).toBe(true);
      if (config.contractAddress) {
        expect(config.contractAddress).toBe(config.contractAddress.toLowerCase());
      }
      expect(config.requiredConfirmations).toBeGreaterThan(0);
      expect(config.minDepositUnits).toBeGreaterThan(0n);
    }
  });
});

describe('network registry', () => {
  it('separates mainnet from testnet', () => {
    expect(getNetworkConfig(Network.ETHEREUM).isTestnet).toBe(false);
    expect(getNetworkConfig(Network.ETHEREUM_SEPOLIA).isTestnet).toBe(true);
    expect(getNetworkConfig(Network.ETHEREUM).chainId).toBe(1);
    expect(getNetworkConfig(Network.ETHEREUM_SEPOLIA).chainId).toBe(11155111);
  });

  it('declares a reorg depth for every network', () => {
    for (const config of Object.values(NETWORKS)) {
      expect(config.reorgDepth).toBeGreaterThan(0);
      expect(config.averageBlockSeconds).toBeGreaterThan(0);
    }
  });

  it('validates network identifiers', () => {
    expect(isNetwork('ETHEREUM')).toBe(true);
    expect(isNetwork('SOLANA')).toBe(false);
  });
});

describe('fiat currencies', () => {
  it('resolves supported currencies with ISO minor units', () => {
    expect(requireFiatCurrency('usd').decimals).toBe(2);
    expect(requireFiatCurrency('JPY').decimals).toBe(0);
    expect(requireFiatCurrency('IDR').decimals).toBe(2);
  });

  it('rejects unknown currencies', () => {
    expect(findFiatCurrency('XXX')).toBeNull();
    expect(() => requireFiatCurrency('XXX')).toThrow(/unsupported currency/);
  });
});

describe('invoice status classification', () => {
  it('classifies terminal states', () => {
    expect(isTerminalStatus(InvoiceStatus.PAID)).toBe(true);
    expect(isTerminalStatus(InvoiceStatus.REFUNDED)).toBe(true);
    expect(isTerminalStatus(InvoiceStatus.PENDING)).toBe(false);
  });

  it('classifies states that need a human', () => {
    expect(isReviewStatus(InvoiceStatus.UNDERPAID)).toBe(true);
    expect(isReviewStatus(InvoiceStatus.LATE_PAYMENT_REVIEW)).toBe(true);
    expect(isReviewStatus(InvoiceStatus.RECONCILIATION_REQUIRED)).toBe(true);
    expect(isReviewStatus(InvoiceStatus.PAID)).toBe(false);
  });

  it('classifies states that may still receive funds', () => {
    expect(isPayableStatus(InvoiceStatus.PENDING)).toBe(true);
    expect(isPayableStatus(InvoiceStatus.UNDERPAID)).toBe(true);
    expect(isPayableStatus(InvoiceStatus.EXPIRED)).toBe(false);
    expect(isPayableStatus(InvoiceStatus.CANCELLED)).toBe(false);
  });
});

describe('identifiers', () => {
  it('generates prefixed ULIDs', () => {
    const id = newId('invoice');
    expect(id.startsWith('inv_')).toBe(true);
    expect(isId('invoice', id)).toBe(true);
    expect(isId('merchant', id)).toBe(false);
    expect(parseIdKind(id)).toBe('invoice');
  });

  it('produces monotonically increasing ids within the same millisecond', () => {
    const ids = Array.from({ length: 200 }, () => newId('ledgerEntry'));
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('uses a unique prefix per entity kind', () => {
    const prefixes = Object.values(ID_PREFIXES);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });
});
