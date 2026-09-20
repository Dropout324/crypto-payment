import { toMoney, toMoneyOrNull } from '@gateway/database';
import { getNetworkConfig, type NetworkValue } from '@gateway/shared';
import type { BlockchainTransaction, TokenTransfer } from '@gateway/database';

export interface TransactionTransferResponse {
  id: string;
  transfer_index: number;
  asset: string;
  amount: string;
  from_address: string | null;
  to_address: string;
  match_status: string;
  confirmations: number;
}

export interface TransactionResponse {
  network: string;
  tx_hash: string;
  status: string;
  block_number: string | null;
  confirmations: number;
  fee_amount: string | null;
  first_seen_at: string;
  mined_at: string | null;
  confirmed_at: string | null;
  transfers: TransactionTransferResponse[];
}

export function toTransactionResponse(tx: BlockchainTransaction, transfers: TokenTransfer[]): TransactionResponse {
  const networkConfig = getNetworkConfig(tx.network as NetworkValue);

  return {
    network: tx.network,
    tx_hash: tx.txHash,
    status: tx.status,
    block_number: tx.blockNumber !== null ? tx.blockNumber.toString() : null,
    confirmations: tx.confirmations,
    fee_amount: toMoneyOrNull(tx.feeAmount, networkConfig.nativeAsset, networkConfig.nativeDecimals)?.toDecimalString() ?? null,
    first_seen_at: tx.firstSeenAt.toISOString(),
    mined_at: tx.minedAt?.toISOString() ?? null,
    confirmed_at: tx.confirmedAt?.toISOString() ?? null,
    transfers: transfers.map((t) => ({
      id: t.id,
      transfer_index: t.transferIndex,
      asset: t.assetSymbol,
      amount: toMoney(t.amount, t.assetSymbol, t.assetDecimals).toDecimalString(),
      from_address: t.fromAddress,
      to_address: t.toAddress,
      match_status: t.matchStatus,
      confirmations: t.confirmations,
    })),
  };
}
