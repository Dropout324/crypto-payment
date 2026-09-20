import { IsEmail, IsString, Length } from 'class-validator';

export class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @Length(1, 1024)
  password!: string;
}
