import type { SigningRequest } from '@gateway/signing';

export interface AdminSigningRequestResponse {
  id: string;
  merchant_id: string;
  network: string;
  asset: string;
  from_address: string;
  to_address: string;
  /** Smallest unit - this package has no per-asset decimals context (it is chain/asset-agnostic by design, ADR 0013). */
  amount: string;
  requested_by: string;
  requested_at: string;
  status: 'PENDING_APPROVAL' | 'SIGNED' | 'REJECTED';
  approvals: string[];
  rejected_by: string | null;
  rejection_reason: string | null;
  /** Present only in the direct response to the call that produced it - see `HsmBackedSigningBackend`'s doc comment for exactly what this signs. The durable record lives in the audit trail (`signing_request.signed`), not this row. */
  raw_tx_hex: string | null;
}

export interface AdminSigningRequestState {
  request: SigningRequest;
  status: 'PENDING_APPROVAL' | 'SIGNED' | 'REJECTED';
  approvals: readonly string[];
  rejectedBy?: string;
  rejectionReason?: string;
  rawTxHex?: string;
}

export function toAdminSigningResponse(state: AdminSigningRequestState): AdminSigningRequestResponse {
  return {
    id: state.request.id,
    merchant_id: state.request.merchantId,
    network: state.request.network,
    asset: state.request.asset,
    from_address: state.request.fromAddress,
    to_address: state.request.toAddress,
    amount: state.request.amount.toString(),
    requested_by: state.request.requestedBy,
    requested_at: state.request.requestedAt.toISOString(),
    status: state.status,
    approvals: [...state.approvals],
    rejected_by: state.rejectedBy ?? null,
    rejection_reason: state.rejectionReason ?? null,
    raw_tx_hex: state.rawTxHex ?? null,
  };
}
