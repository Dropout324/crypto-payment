'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export function NavLink({ href, label }: { href: string; label: string }) {
  const pathname = usePathname();
  const active = href === pathname || (href !== '/dashboard' && href !== '/admin' && pathname.startsWith(href));

  return (
    <Link
      href={href}
      className={`rounded-md px-2 py-1.5 text-sm ${
        active ? 'bg-zinc-900 text-white' : 'text-zinc-400 hover:bg-zinc-900 hover:text-white'
      }`}
    >
      {label}
    </Link>
  );
}
