'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { AuthProvider, useAuth } from '@/lib/auth';

/* -------------------------------------------------------------------------- */
/* Nav config — single source of truth for primary + Library menu.            */
/*                                                                            */
/* PRIMARY: Deals · Criteria · Kicks.                                         */
/*   - "Deals" (/pools) is the workspace; the rail surface set by PR5–6.      */
/*   - "Criteria" daily-workflow surface; stays primary.                      */
/*   - "Kicks" stays primary — institutional memory; the same kicks_registry  */
/*     table the pool layer's Disposition[kicked]→Kick connector will feed.   */
/*                                                                            */
/* LIBRARY MENU: UW Library · UW Insights · Registry.                         */
/*   - Demoted reference surfaces — needed but analyst-rare.                  */
/*   - ★ Registry seeds the engine's ingest (library/benchmarks/manifesto) —  */
/*     New Analysis is gated on it. Demoted, not removed. Do not delete.      */
/*                                                                            */
/* REMOVED FROM NAV (page still exists): "New Analysis" (/analysis/new). The  */
/* ingest path is intact and routable by URL; analysis will be launched FROM  */
/* a loan row in a pool in the next slice. Removing the nav LINK is not the   */
/* same as removing the PAGE — registry-gated ingest still works.             */
/* -------------------------------------------------------------------------- */

interface NavItem {
  readonly href: string;
  readonly label: string;
}

const PRIMARY_NAV: readonly NavItem[] = [
  { href: '/pools',           label: 'Deals' },
  { href: '/admin/criteria',  label: 'Criteria' },
  { href: '/admin/kicks',     label: 'Kicks' },
];

const LIBRARY_NAV: readonly NavItem[] = [
  { href: '/admin/underwriting-library',  label: 'UW Library' },
  { href: '/admin/underwriting-insights', label: 'UW Insights' },
  // Registry seeds the engine's ingest (library/benchmarks/manifesto) —
  // New Analysis is gated on it. Demoted, not removed. Do not delete.
  { href: '/admin/registry',              label: 'Registry' },
];

function isActive(pathname: string, href: string): boolean {
  // Exact match or subroute match — guards against /admin/underwriting-library
  // matching /admin/underwriting-insights (shared prefix).
  if (pathname === href) return true;
  return pathname.startsWith(href + '/');
}

function primaryLinkClasses(active: boolean): string {
  return active
    ? 'text-text-primary font-semibold border-b-2 border-accent pb-1 -mb-px transition-colors'
    : 'text-text-secondary hover:text-text-primary transition-colors';
}

/* -------------------------------------------------------------------------- */
/* AppContent                                                                 */
/* -------------------------------------------------------------------------- */

function AppContent({ children }: { children: React.ReactNode }) {
  const { user, logout, isLoading } = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  const isLoginPage = pathname === '/login';

  useEffect(() => {
    // Existing behavior: unauth → /login (unchanged).
    if (!isLoading && !user && !isLoginPage) {
      router.push('/login');
      return;
    }
    // New (PR 7): authenticated user lands on '/' → send to their workspace.
    // Splash page (/) stays in the file system; if a future PR wants to make
    // it visible to unauth visitors, that requires a SEPARATE change to the
    // unauth redirect rule above. Today's behavior remains: unauth at '/' →
    // /login, authed at '/' → /pools, splash is never rendered.
    if (!isLoading && user && pathname === '/') {
      router.replace('/pools');
    }
  }, [user, isLoading, isLoginPage, pathname, router]);

  // Show nothing while checking auth state
  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-sm text-text-muted">Loading...</div>
      </div>
    );
  }

  // Login page renders without header
  if (isLoginPage) {
    return <>{children}</>;
  }

  // Not logged in, will redirect
  if (!user) {
    return null;
  }

  // Whether the Library menu's parent button shows the active style.
  const libraryActive = LIBRARY_NAV.some((it) => isActive(pathname, it.href));

  return (
    <>
      <header className="border-b border-border-primary bg-bg-secondary px-6 py-3 flex items-center justify-between">
        {/* Visual pass PR 1 — brand mark from the prototype: teal gradient square w/
         *  tiny house SVG, Plex Serif name, "B-Piece Pool Rail" eyebrow in brand teal. */}
        <div className="flex items-center gap-3">
          <div
            className="w-[34px] h-[34px] rounded-[9px] grid place-items-center flex-none"
            style={{
              background: 'linear-gradient(150deg, #3FA7A0, #2C7570)',
              boxShadow:
                '0 0 0 1px rgba(63,167,160,0.35), 0 6px 18px -8px rgba(63,167,160,0.5)',
            }}
            aria-hidden
          >
            <svg viewBox="0 0 24 24" fill="none" className="w-[19px] h-[19px]">
              <path
                d="M4 19h16M6 19V9l6-4 6 4v10M10 19v-5h4v5"
                stroke="#06100f"
                strokeWidth="1.8"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            </svg>
          </div>
          <div>
            <div className="font-serif font-semibold text-base text-text-primary leading-none">
              CRE Credit Committee
            </div>
            <div className="text-[10.5px] uppercase tracking-[0.16em] text-accent font-semibold mt-1">
              B-Piece Pool Rail
            </div>
          </div>
        </div>
        <nav className="flex items-center gap-5 text-xs text-text-secondary">
          {PRIMARY_NAV.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <a
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={primaryLinkClasses(active)}
              >
                {item.label}
              </a>
            );
          })}

          {/* Library — secondary menu (HTML <details> for zero-JS accessibility). */}
          <details className="relative group">
            <summary
              aria-current={libraryActive ? 'page' : undefined}
              className={`list-none cursor-pointer select-none flex items-center gap-1
                          ${libraryActive
                            ? 'text-text-primary font-semibold border-b-2 border-accent pb-1 -mb-px'
                            : 'text-text-secondary hover:text-text-primary'} transition-colors`}
            >
              Library
              <span aria-hidden className="text-[10px] transition-transform group-open:rotate-180">▾</span>
            </summary>
            <div
              role="menu"
              className="absolute right-0 mt-2 min-w-44 bg-bg-secondary border border-border-primary
                         rounded shadow-lg py-1 z-50"
            >
              {LIBRARY_NAV.map((item) => {
                const active = isActive(pathname, item.href);
                return (
                  <a
                    key={item.href}
                    href={item.href}
                    role="menuitem"
                    aria-current={active ? 'page' : undefined}
                    className={`block px-3 py-1.5 text-xs transition-colors ${
                      active
                        ? 'bg-accent/15 text-accent'
                        : 'text-text-secondary hover:text-text-primary hover:bg-bg-tertiary'
                    }`}
                  >
                    {item.label}
                  </a>
                );
              })}
            </div>
          </details>

          <span className="text-text-muted">|</span>
          <span className="text-text-muted">{user.email}</span>
          <button
            onClick={logout}
            className="hover:text-text-primary transition-colors"
          >
            Sign Out
          </button>
        </nav>
      </header>
      <main>{children}</main>
    </>
  );
}

export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <AppContent>{children}</AppContent>
    </AuthProvider>
  );
}
