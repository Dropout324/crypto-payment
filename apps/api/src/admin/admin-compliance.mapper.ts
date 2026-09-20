import type { ComplianceCheck } from '@gateway/database';

export interface AdminComplianceCheckResponse {
  id: string;
  subject_type: string;
  subject_id: string;
  check_type: string;
  provider: string;
  status: string;
  risk_score: number | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  notes: string | null;
  created_at: string;
}

export interface AdminComplianceListResponse {
  compliance_checks: AdminComplianceCheckResponse[];
  next_cursor: string | null;
}

export function toAdminComplianceCheckResponse(row: ComplianceCheck): AdminComplianceCheckResponse {
  return {
    id: row.id,
    subject_type: row.subjectType,
    subject_id: row.subjectId,
    check_type: row.checkType,
    provider: row.provider,
    status: row.status,
    risk_score: row.riskScore,
    reviewed_by: row.reviewedBy,
    reviewed_at: row.reviewedAt?.toISOString() ?? null,
    notes: row.notes,
    created_at: row.createdAt.toISOString(),
  };
}
