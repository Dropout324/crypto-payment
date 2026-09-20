import { IsOptional, IsString, Length } from 'class-validator';

/**
 * Registers a merchant-controlled deposit address into the pool invoice
 * creation draws from (Mode B - see ADR 0002). Not in SPEC section 15's
 * literal endpoint list, but required for that list's
 * `POST /v1/payment-invoices` to have anywhere to get a destination from
 * when the gateway does not control any keys itself.
 */
export class RegisterAddressDto {
  @IsString()
  @Length(1, 40)
  network!: string;

  @IsString()
  @Length(1, 20)
  asset!: string;

  @IsString()
  @Length(1, 200)
  address!: string;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  label?: string;
}
