import { IsIn, IsOptional, IsString, IsUrl, Length, Matches, MaxLength } from 'class-validator';

/** SPEC section 16 request shape, field-for-field. */
export class CreateInvoiceDto {
  @IsString()
  @Length(1, 255)
  order_id!: string;

  @IsString()
  @Matches(/^-?\d+(\.\d+)?$/, { message: 'amount must be a plain decimal string, e.g. "100.00"' })
  amount!: string;

  @IsString()
  @Length(3, 10)
  currency!: string;

  @IsString()
  @Length(1, 20)
  asset!: string;

  @IsString()
  @Length(1, 40)
  network!: string;

  @IsOptional()
  @IsUrl({ require_tld: false, protocols: ['https', 'http'] })
  callback_url?: string;

  @IsOptional()
  @IsUrl({ require_tld: false, protocols: ['https', 'http'] })
  redirect_url?: string;

  @IsOptional()
  @IsString()
  external_reference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  metadata?: Record<string, unknown>;
}

export class CancelInvoiceDto {
  @IsOptional()
  @IsIn(['requested_by_merchant', 'duplicate', 'customer_requested', 'other'])
  reason?: string;
}
