import { IsIn, IsNumberString, IsOptional, IsString, Length, Matches } from 'class-validator';

export class SubmitSigningRequestDto {
  @IsString()
  @Length(1, 64)
  merchant_id!: string;

  @IsString()
  @Length(1, 32)
  network!: string;

  @IsString()
  @Length(1, 32)
  asset!: string;

  @IsString()
  @Length(1, 128)
  from_address!: string;

  @IsString()
  @Length(1, 128)
  to_address!: string;

  /** Smallest unit, as a decimal string - never a JSON number (precision). */
  @IsNumberString()
  @Matches(/^[0-9]+$/, { message: 'amount must be a non-negative integer, in smallest units' })
  amount!: string;
}

export class RejectSigningRequestDto {
  @IsOptional()
  @IsString()
  @Length(1, 2000)
  reason?: string;
}

export class SigningRequestStatusQueryDto {
  @IsOptional()
  @IsIn(['PENDING_APPROVAL', 'SIGNED', 'REJECTED'])
  status?: 'PENDING_APPROVAL' | 'SIGNED' | 'REJECTED';
}
