import { IsArray, IsBoolean, IsIn, IsOptional, IsString, Length } from 'class-validator';
import { ALL_API_KEY_SCOPES } from '../auth/api-key-scope.guard.js';

export class CreateApiKeyDto {
  @IsString()
  @Length(1, 100)
  name!: string;

  @IsOptional()
  @IsBoolean()
  livemode?: boolean;

  /**
   * Omit to grant every scope (full access) - the same behaviour a key had
   * before scope enforcement existed, so keys created without an explicit
   * list are unaffected. Any unrecognised scope string is rejected outright:
   * half-accepting a typo'd scope (silently never enforceable) is worse than
   * refusing it.
   */
  @IsOptional()
  @IsArray()
  @IsIn(ALL_API_KEY_SCOPES, { each: true })
  scopes?: string[];
}
