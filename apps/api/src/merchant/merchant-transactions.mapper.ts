import { toMoney } from '@gateway/database';
import type { TokenTransfer } from '@gateway/database';

export interface MerchantTransferResponse {
  id: string;
  network: string;
  tx_hash: string;
  transfer_index: number;
  asset: string;
  amount: string;
  match_status: string;
  confirmations: number;
  invoice_id: string | null;
  detected_at: string;
}

export interface MerchantTransactionsResponse {
  transactions: MerchantTransferResponse[];
  next_cursor: string | null;
}

export function toMerchantTransferResponse(t: TokenTransfer): MerchantTransferResponse {
  return {
    id: t.id,
    network: t.network,
    tx_hash: t.txHash,
    transfer_index: t.transferIndex,
    asset: t.assetSymbol,
    amount: toMoney(t.amount, t.assetSymbol, t.assetDecimals).toDecimalString(),
    match_status: t.matchStatus,
    confirmations: t.confirmations,
    invoice_id: t.invoiceId,
    detected_at: t.detectedAt.toISOString(),
  };
}
