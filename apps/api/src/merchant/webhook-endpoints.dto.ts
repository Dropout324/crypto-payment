import { ArrayUnique, IsArray, IsBoolean, IsOptional, IsString, IsUrl } from 'class-validator';

export class CreateWebhookEndpointDto {
  @IsUrl({ require_tld: false, protocols: ['https', 'http'] })
  url!: string;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  event_types?: string[];
}

export class UpdateWebhookEndpointDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  event_types?: string[];
}
