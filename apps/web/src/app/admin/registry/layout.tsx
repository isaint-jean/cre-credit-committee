'use client';

// Shared layout for /admin/registry/* — three nav tabs across the top, active
// tab visually highlighted. Scoped intentionally to /registry only; the
// broader /admin/* family does not have a shared layout (see Ticket #12
// recon notes).

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS: readonly { href: string; label: string }[] = [
  { href: '/admin/registry/library-snapshots', label: 'Library Snapshots' },
  { href: '/admin/registry/market-benchmarks', label: 'Market Benchmarks' },
  { href: '/admin/registry/credit-manifestos', label: 'Credit Manifestos' },
];

export default function RegistryLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-text-primary">Registry</h1>
        <p className="text-sm text-text-secondary">
          Content-addressed pinned upstream inputs to the judgment engine.
        </p>
      </div>

      <div className="flex gap-2 mb-6 border-b border-border-primary pb-px">
        {TABS.map((tab) => {
          const isActive = pathname.startsWith(tab.href);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={`px-4 py-2 rounded-t text-sm transition-colors ${
                isActive
                  ? 'bg-accent text-bg-primary font-semibold'
                  : 'bg-bg-secondary text-text-secondary hover:text-text-primary border border-border-primary'
              }`}
            >
              {tab.label}
            </Link>
          );
        })}
      </div>

      {children}
    </div>
  );
}
