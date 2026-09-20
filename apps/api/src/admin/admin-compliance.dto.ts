import { IsIn, IsOptional, IsString, Length } from 'class-validator';

export class ReviewComplianceCheckDto {
  @IsIn(['APPROVE', 'REJECT'])
  decision!: 'APPROVE' | 'REJECT';

  @IsOptional()
  @IsString()
  @Length(1, 2000)
  note?: string;
}
