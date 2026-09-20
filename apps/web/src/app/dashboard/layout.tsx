import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { resolveCurrentMerchantId } from '@/lib/merchant';
import { DashboardShell } from '@/components/DashboardShell';
import { MerchantSwitcher } from '@/components/MerchantSwitcher';

const NAV = [
  { href: '/dashboard', label: 'Overview' },
  { href: '/dashboard/invoices', label: 'Invoices' },
  { href: '/dashboard/transactions', label: 'Transactions' },
  { href: '/dashboard/api-keys', label: 'API keys' },
  { href: '/dashboard/webhooks', label: 'Webhooks' },
  { href: '/dashboard/members', label: 'Team' },
  { href: '/dashboard/settings', label: 'Settings' },
];

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login?next=/dashboard');

  if (session.memberships.length === 0) {
    return (
      <main className="flex min-h-screen items-center justify-center p-8 text-center">
        <div>
          <h1 className="text-lg font-semibold">No merchant access</h1>
          <p className="mt-2 text-sm text-zinc-400">Your account isn&apos;t a member of any merchant yet.</p>
        </div>
      </main>
    );
  }

  const currentMerchantId = await resolveCurrentMerchantId(session.memberships);

  return (
    <DashboardShell
      title="Merchant dashboard"
      navItems={NAV}
      userEmail={session.user.email}
      extra={<MerchantSwitcher memberships={session.memberships} currentId={currentMerchantId!} />}
    >
      {children}
    </DashboardShell>
  );
}
