import { IsString, Length } from 'class-validator';

export class TestWebhookDto {
  @IsString()
  @Length(1, 64)
  endpoint_id!: string;
}
