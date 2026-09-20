import { IsEmail, IsIn } from 'class-validator';

const ASSIGNABLE_ROLES = ['OWNER', 'ADMIN', 'DEVELOPER', 'VIEWER'] as const;

export class AddMemberDto {
  /** Must already have a `User` account - there is no invite-by-email/signup flow yet, so this attaches an existing user. */
  @IsEmail()
  email!: string;

  @IsIn(ASSIGNABLE_ROLES)
  role!: (typeof ASSIGNABLE_ROLES)[number];
}

export class UpdateMemberRoleDto {
  @IsIn(ASSIGNABLE_ROLES)
  role!: (typeof ASSIGNABLE_ROLES)[number];
}
