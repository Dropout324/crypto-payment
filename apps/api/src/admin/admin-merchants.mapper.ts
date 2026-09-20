import type { Merchant } from '@gateway/database';

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

export interface AdminMerchantsListResponse {
  merchants: AdminMerchantResponse[];
  next_cursor: string | null;
}

export function toAdminMerchantResponse(merchant: Merchant): AdminMerchantResponse {
  return {
    id: merchant.id,
    name: merchant.name,
    slug: merchant.slug,
    status: merchant.status,
    country_code: merchant.countryCode,
    wallet_mode: merchant.walletMode,
    kyb_status: merchant.kybStatus,
    fee_bps: merchant.feeBps,
    created_at: merchant.createdAt.toISOString(),
  };
}
