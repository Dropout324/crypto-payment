import { Money } from '../money/money.js';
import { findAsset } from './asset.js';
import { getNetworkConfig, type NetworkValue } from './network.js';

/**
 * A scannable payment URI for a deposit address - BIP-21 for Bitcoin,
 * EIP-681 for EVM. A wallet app that scans one of these can prefill the
 * recipient, amount, and (for a token) the contract to call, instead of a
 * payer copying the address and typing the amount by hand.
 *
 * Returns null when there is nothing sensible to build (unknown asset, or a
 * network family this doesn't cover yet) - callers should fall back to
 * showing the bare address, never treat a null as an error.
 */
export function buildPaymentUri(
  network: NetworkValue,
  assetSymbol: string,
  address: string,
  amountDecimal: string,
): string | null {
  const config = getNetworkConfig(network);

  if (config.family === 'bitcoin') {
    // BIP-21. `amount` is plain BTC (not satoshis) - the same convention
    // this gateway already uses for `crypto_amount` on a BTC invoice.
    return `bitcoin:${address}?amount=${amountDecimal}`;
  }

  if (config.family === 'evm') {
    if (config.chainId === null) return null;

    // No fallback to the network's native asset: the caller always passes an
    // already-validated invoice/deposit asset, so an unresolvable symbol
    // here means the input was wrong, not "assume they meant the native coin".
    const asset = findAsset(network, assetSymbol);
    if (!asset) return null;

    const units = Money.fromDecimal(amountDecimal, asset.symbol, asset.decimals).units;

    if (asset.contractAddress === null) {
      // EIP-681 native transfer - `value` is wei (the asset's smallest unit).
      return `ethereum:${address}@${config.chainId}?value=${units}`;
    }

    // EIP-681 function-call form for an ERC-20 `transfer(address,uint256)`.
    return `ethereum:${asset.contractAddress}@${config.chainId}/transfer?address=${address}&uint256=${units}`;
  }

  return null;
}
