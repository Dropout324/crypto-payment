'use client';

import { useRouter } from 'next/navigation';
import { apiPost } from '@/lib/api-client';

export function LogoutButton() {
  const router = useRouter();

  async function onClick() {
    await apiPost('/v1/auth/logout');
    router.push('/login');
    router.refresh();
  }

  return (
    <button onClick={onClick} className="text-sm text-zinc-400 hover:text-zinc-100">
      Sign out
    </button>
  );
}
