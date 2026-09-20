import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';

export default async function RootPage() {
  const session = await getSession();

  if (!session) redirect('/login');
  if (session.user.platform_role !== 'USER') redirect('/admin');
  redirect('/dashboard');
}
