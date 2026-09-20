import { NavLink } from './NavLink';
import { LogoutButton } from './LogoutButton';

interface NavItem {
  href: string;
  label: string;
}

export function DashboardShell({
  title,
  navItems,
  userEmail,
  extra,
  children,
}: {
  title: string;
  navItems: NavItem[];
  userEmail: string;
  extra?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen">
      <aside className="flex w-56 shrink-0 flex-col border-r border-zinc-800 bg-zinc-950 p-4">
        <div className="mb-6 text-sm font-semibold">{title}</div>
        {extra}
        <nav className="flex flex-col gap-1">
          {navItems.map((item) => (
            <NavLink key={item.href} href={item.href} label={item.label} />
          ))}
        </nav>
        <div className="mt-auto flex flex-col gap-2 border-t border-zinc-800 pt-4">
          <span className="truncate text-xs text-zinc-500">{userEmail}</span>
          <LogoutButton />
        </div>
      </aside>
      <main className="flex-1 overflow-x-auto p-8">{children}</main>
    </div>
  );
}
