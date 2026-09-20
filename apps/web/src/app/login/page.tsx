import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { LoginForm } from '@/components/LoginForm';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const session = await getSession();
  if (session) redirect(next ?? '/');

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 px-4">
      <div className="text-center">
        <h1 className="text-lg font-semibold">Crypto Payment Gateway</h1>
        <p className="text-sm text-zinc-400">Sign in to your dashboard</p>
      </div>
      <LoginForm nextPath={next ?? '/'} />
    </main>
  );
}
