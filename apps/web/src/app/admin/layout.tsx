import { requirePlatformRole } from '@/lib/session';
import { DashboardShell } from '@/components/DashboardShell';

const BASE_NAV = [
  { href: '/admin/merchants', label: 'Merchants' },
  { href: '/admin/compliance', label: 'Compliance' },
  { href: '/admin/reconciliation', label: 'Reconciliation' },
  { href: '/admin/refunds', label: 'Refunds' },
  { href: '/admin/settlements', label: 'Settlements' },
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await requirePlatformRole();
  // AUDIT_LOGS_READ excludes SUPPORT (see admin-audit-logs.controller.ts) -
  // hide the nav entry for a role that would only hit a 403 clicking it.
  const nav = session.user.platform_role === 'SUPPORT' ? BASE_NAV : [...BASE_NAV, { href: '/admin/audit-logs', label: 'Audit log' }];

  return (
    <DashboardShell title="Admin" navItems={nav} userEmail={session.user.email}>
      {children}
    </DashboardShell>
  );
}
