import type { ReconciliationDiscrepancy } from '@gateway/database';

export interface AdminDiscrepancyResponse {
  id: string;
  run_id: string;
  kind: string;
  severity: string;
  subject_type: string;
  subject_id: string;
  network: string | null;
  expected_value: string | null;
  actual_value: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
  created_at: string;
}

export interface AdminDiscrepanciesListResponse {
  discrepancies: AdminDiscrepancyResponse[];
  next_cursor: string | null;
}

export function toAdminDiscrepancyResponse(row: ReconciliationDiscrepancy): AdminDiscrepancyResponse {
  return {
    id: row.id,
    run_id: row.runId,
    kind: row.kind,
    severity: row.severity,
    subject_type: row.subjectType,
    subject_id: row.subjectId,
    network: row.network,
    expected_value: row.expectedValue,
    actual_value: row.actualValue,
    resolved_by: row.resolvedBy,
    resolved_at: row.resolvedAt?.toISOString() ?? null,
    resolution_note: row.resolutionNote,
    created_at: row.createdAt.toISOString(),
  };
}
