import { toMoney } from '@gateway/database';
import type { Refund } from '@gateway/database';

export interface AdminRefundResponse {
  id: string;
  invoice_id: string;
  merchant_id: string;
  network: string;
  asset: string;
  amount: string;
  destination_address: string;
  status: string;
  compliance_status: string;
  reason: string | null;
  requested_by: string;
  approved_by: string | null;
  approved_at: string | null;
  rejected_by: string | null;
  rejected_at: string | null;
  created_at: string;
}

export interface AdminRefundsListResponse {
  refunds: AdminRefundResponse[];
  next_cursor: string | null;
}

export function toAdminRefundResponse(row: Refund): AdminRefundResponse {
  return {
    id: row.id,
    invoice_id: row.invoiceId,
    merchant_id: row.merchantId,
    network: row.network,
    asset: row.assetSymbol,
    amount: toMoney(row.amount, row.assetSymbol, row.assetDecimals).toDecimalString(),
    destination_address: row.destinationAddress,
    status: row.status,
    compliance_status: row.complianceStatus,
    reason: row.reason,
    requested_by: row.requestedBy,
    approved_by: row.approvedBy,
    approved_at: row.approvedAt?.toISOString() ?? null,
    rejected_by: row.rejectedBy,
    rejected_at: row.rejectedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
  };
}
