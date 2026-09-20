import { describe, expect, it } from 'vitest';
import { buildPaymentUri } from '../src/domain/payment-uri.js';
import { Network } from '../src/domain/network.js';

describe('buildPaymentUri', () => {
  it('builds a BIP-21 URI for Bitcoin', () => {
    const address = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
    expect(buildPaymentUri(Network.BITCOIN, 'BTC', address, '0.001')).toBe(
      `bitcoin:${address}?amount=0.001`,
    );
  });

  it('builds an EIP-681 native-transfer URI for an EVM native coin', () => {
    const address = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
    // 0.001 ETH at 18 decimals = 1_000_000_000_000_000 wei.
    expect(buildPaymentUri(Network.ETHEREUM, 'ETH', address, '0.001')).toBe(
      `ethereum:${address}@1?value=1000000000000000`,
    );
  });

  it('builds an EIP-681 transfer-call URI for an ERC-20 token, keyed off the contract', () => {
    const address = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
    // 1 USDT on Ethereum at 6 decimals = 1_000_000 smallest units.
    const uri = buildPaymentUri(Network.ETHEREUM, 'USDT', address, '1');
    expect(uri).toBe(
      `ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7@1/transfer?address=${address}&uint256=1000000`,
    );
  });

  it('uses the asset chain id for a testnet, not the mainnet chain id', () => {
    const address = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
    expect(buildPaymentUri(Network.ETHEREUM_SEPOLIA, 'ETH', address, '1')).toBe(
      `ethereum:${address}@11155111?value=1000000000000000000`,
    );
  });

  it('returns null for an asset that does not exist on the given network', () => {
    const address = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
    expect(buildPaymentUri(Network.ETHEREUM, 'NOPE', address, '1')).toBeNull();
  });
});
