import { toMoney } from '@gateway/database';
import type { Settlement } from '@gateway/database';

export interface AdminSettlementResponse {
  id: string;
  merchant_id: string;
  network: string;
  asset: string;
  gross_amount: string;
  fee_amount: string;
  network_fee: string;
  net_amount: string;
  status: string;
  tx_hash: string | null;
  approved_by: string | null;
  approved_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface AdminSettlementsListResponse {
  settlements: AdminSettlementResponse[];
  next_cursor: string | null;
}

export function toAdminSettlementResponse(row: Settlement): AdminSettlementResponse {
  return {
    id: row.id,
    merchant_id: row.merchantId,
    network: row.network,
    asset: row.assetSymbol,
    gross_amount: toMoney(row.grossAmount, row.assetSymbol, row.assetDecimals).toDecimalString(),
    fee_amount: toMoney(row.feeAmount, row.assetSymbol, row.assetDecimals).toDecimalString(),
    network_fee: toMoney(row.networkFee, row.assetSymbol, row.assetDecimals).toDecimalString(),
    net_amount: toMoney(row.netAmount, row.assetSymbol, row.assetDecimals).toDecimalString(),
    status: row.status,
    tx_hash: row.txHash,
    approved_by: row.approvedBy,
    approved_at: row.approvedAt?.toISOString() ?? null,
    completed_at: row.completedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
  };
}
