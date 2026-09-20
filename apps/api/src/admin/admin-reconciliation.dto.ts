import { IsString, Length } from 'class-validator';

export class ResolveDiscrepancyDto {
  @IsString()
  @Length(1, 2000)
  resolution_note!: string;
}
