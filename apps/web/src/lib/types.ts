// Response shapes traced from apps/api's controllers/services (Phase 7
// surface). Money fields are decimal strings end to end - never coerce to
// number, the API never does either (see docs/decisions/0001-money-representation.md).

export interface PublicUser {
  id: string;
  email: string;
  full_name: string | null;
  platform_role: 'USER' | 'SUPPORT' | 'COMPLIANCE_OFFICER' | 'ADMIN';
}

export interface Membership {
  merchant_id: string;
  merchant_name: string;
  merchant_slug: string;
  merchant_status: string;
  role: 'OWNER' | 'ADMIN' | 'DEVELOPER' | 'VIEWER';
}

export interface MeResponse {
  user: PublicUser;
  memberships: Membership[];
}

export type Envelope<K extends string, T> = { [P in K]: T[] } & { next_cursor: string | null };

export interface Balance {
  network: string;
  asset: string;
  available: string;
}
export interface BalanceResponse {
  balances: Balance[];
}

export interface InvoiceResponse {
  id: string;
  order_id: string;
  external_reference: string | null;
  status: string;
  amount: string;
  currency: string;
  asset: string;
  network: string;
  crypto_amount: string;
  received_amount: string;
  confirmed_amount: string;
  payment_address: string | null;
  payment_uri: string | null;
  confirmation_count: number;
  required_confirmations: number;
  transaction_hash: string | null;
  callback_url: string | null;
  metadata: Record<string, unknown>;
  expires_at: string;
  detected_at: string | null;
  paid_at: string | null;
  created_at: string;
  updated_at: string;
}
export type ListInvoicesResponse = Envelope<'invoices', InvoiceResponse>;

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
export type ListTransactionsResponse = Envelope<'transactions', MerchantTransferResponse>;

export interface ApiKeyResponse {
  id: string;
  name: string;
  key_prefix: string;
  livemode: boolean;
  scopes: string[];
  status: string;
  last_used_at: string | null;
  created_at: string;
}

export interface CreatedApiKeyResponse extends ApiKeyResponse {
  /** Returned exactly once, at creation - never recoverable afterwards. */
  plaintext: string;
}

export interface WebhookEndpointResponse {
  id: string;
  url: string;
  event_types: string[];
  enabled: boolean;
  secret_fingerprint: string;
  consecutive_failures: number;
  disabled_reason: string | null;
  created_at: string;
}

export interface CreatedWebhookEndpointResponse extends WebhookEndpointResponse {
  /** Returned exactly once - encrypted at rest afterwards, never recoverable. */
  secret: string;
}

export interface TestWebhookResult {
  delivered: boolean;
  http_status: number | null;
  response_time_ms: number;
  error: string | null;
}

export interface MemberResponse {
  id: string;
  user_id: string;
  email: string;
  full_name: string | null;
  role: 'OWNER' | 'ADMIN' | 'DEVELOPER' | 'VIEWER';
  created_at: string;
}

export interface MerchantSettingsResponse {
  id: string;
  name: string;
  slug: string;
  status: string;
  settlement_currency: string;
  wallet_mode: string;
  underpayment_policy: string;
  overpayment_policy: string;
  underpayment_tolerance_bps: number;
  overpayment_tolerance_bps: number;
  invoice_expiry_seconds: number;
  fee_bps: number;
}

export interface AdminMerchantResponse {
  id: string;
  name: string;
  slug: string;
  status: string;
  country_code: string | null;
  wallet_mode: string;
  kyb_status: string;
  fee_bps: number;
  created_at: string;
}
export type ListAdminMerchantsResponse = Envelope<'merchants', AdminMerchantResponse>;

export interface AdminComplianceCheckResponse {
  id: string;
  subject_type: string;
  subject_id: string;
  check_type: string;
  provider: string;
  status: string;
  risk_score: number | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  notes: string | null;
  created_at: string;
}
export type ListAdminComplianceResponse = Envelope<'compliance_checks', AdminComplianceCheckResponse>;

export interface AdminDiscrepancyResponse {
  id: string;
  run_id: string;
  kind: string;
  severity: string;
  subject_type: string;
  subject_id: string;
  network: string | null;
  expected_value: string | null;
  actual_value: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
  created_at: string;
}
export type ListAdminDiscrepanciesResponse = Envelope<'discrepancies', AdminDiscrepancyResponse>;

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
export type ListAdminRefundsResponse = Envelope<'refunds', AdminRefundResponse>;

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
export type ListAdminSettlementsResponse = Envelope<'settlements', AdminSettlementResponse>;

export interface AdminAuditLogResponse {
  id: string;
  actor_type: string;
  actor_id: string | null;
  user_id: string | null;
  merchant_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}
export interface ListAdminAuditLogsResponse {
  audit_logs: AdminAuditLogResponse[];
  next_cursor: string | null;
}

// GET /v1/public/invoices/:id - unauthenticated, the hosted payment page's
// only data source. A strict subset of InvoiceResponse: no
// external_reference, callback_url or metadata (see the note in
// apps/api/src/invoices/invoices.mapper.ts).
export interface PublicInvoiceResponse {
  id: string;
  order_id: string;
  status: string;
  merchant_name: string;
  amount: string;
  currency: string;
  asset: string;
  network: string;
  crypto_amount: string;
  received_amount: string;
  confirmed_amount: string;
  payment_address: string | null;
  payment_uri: string | null;
  confirmation_count: number;
  required_confirmations: number;
  transaction_hash: string | null;
  expires_at: string;
  paid_at: string | null;
}
