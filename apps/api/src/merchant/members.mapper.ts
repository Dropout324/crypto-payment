export interface MemberRow {
  id: string;
  userId: string;
  role: string;
  createdAt: Date;
  user: { email: string; fullName: string | null };
}

export interface MemberResponse {
  id: string;
  user_id: string;
  email: string;
  full_name: string | null;
  role: string;
  created_at: string;
}

export function toMemberResponse(row: MemberRow): MemberResponse {
  return {
    id: row.id,
    user_id: row.userId,
    email: row.user.email,
    full_name: row.user.fullName,
    role: row.role,
    created_at: row.createdAt.toISOString(),
  };
}
