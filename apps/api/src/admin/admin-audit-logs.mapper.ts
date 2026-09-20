import type { AuditLog } from '@gateway/database';

export interface AdminAuditLogResponse {
  id: string;
  actor_type: string;
  actor_id: string | null;
  user_id: string | null;
  merchant_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
  before: unknown;
  after: unknown;
  metadata: unknown;
  created_at: string;
}

export interface AdminAuditLogsListResponse {
  audit_logs: AdminAuditLogResponse[];
  next_cursor: string | null;
}

export function toAdminAuditLogResponse(row: AuditLog): AdminAuditLogResponse {
  return {
    id: row.id,
    actor_type: row.actorType,
    actor_id: row.actorId,
    user_id: row.userId,
    merchant_id: row.merchantId,
    action: row.action,
    resource_type: row.resourceType,
    resource_id: row.resourceId,
    ip_address: row.ipAddress,
    user_agent: row.userAgent,
    before: row.before,
    after: row.after,
    metadata: row.metadata,
    created_at: row.createdAt.toISOString(),
  };
}
