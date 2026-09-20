import { type AssetConfig, type NetworkValue, findAssetByContract, findNativeAsset } from '@gateway/shared';

/**
 * Resolve a detected transfer's asset the way SPEC section 4 requires: by
 * contract ADDRESS, never by a symbol the token itself claims to have.
 * `tokenContract: null` means a native-coin transfer.
 */
export function resolveTransferAsset(network: NetworkValue, tokenContract: string | null): AssetConfig | null {
  return tokenContract === null ? findNativeAsset(network) : findAssetByContract(network, tokenContract);
}
