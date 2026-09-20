import { Inject, Injectable } from '@nestjs/common';
import type { DatabaseClient } from '@gateway/database';
import { PRISMA_CLIENT } from '../database/prisma.module.js';

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

/** Read-only projection of the merchant's own settlement/payment policy for the dashboard's settings page. */
@Injectable()
export class MerchantSettingsService {
  constructor(@Inject(PRISMA_CLIENT) private readonly db: DatabaseClient) {}

  async get(merchantId: string): Promise<MerchantSettingsResponse> {
    const merchant = await this.db.merchant.findUniqueOrThrow({ where: { id: merchantId } });

    return {
      id: merchant.id,
      name: merchant.name,
      slug: merchant.slug,
      status: merchant.status,
      settlement_currency: merchant.settlementCurrency,
      wallet_mode: merchant.walletMode,
      underpayment_policy: merchant.underpaymentPolicy,
      overpayment_policy: merchant.overpaymentPolicy,
      underpayment_tolerance_bps: merchant.underpaymentToleranceBps,
      overpayment_tolerance_bps: merchant.overpaymentToleranceBps,
      invoice_expiry_seconds: merchant.invoiceExpirySeconds,
      fee_bps: merchant.feeBps,
    };
  }
}
