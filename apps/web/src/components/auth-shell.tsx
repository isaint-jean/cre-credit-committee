'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect } from 'react';
import { AuthProvider, useAuth } from '@/lib/auth';
import { SideProvider, useSide, type Side } from '@/lib/side-context';
import { roleRoute } from '@/lib/role-routing';

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

// Chunk-of-four fix 4: "Kicks" nav link removed (the /admin/kicks route + kicks_registry
// stay — nav-only removal). The "Library" dropdown (UW Library / UW Insights / Registry)
// was also removed from the header; the underlying /admin/registry routes + the
// LibrarySnapshot / MarketBenchmarks data the ENGINE reads are UNTOUCHED.
const PRIMARY_NAV: readonly NavItem[] = [
  { href: '/pools',           label: 'Deals' },
  { href: '/admin/criteria',  label: 'Criteria' },
];

function isActive(pathname: string, href: string): boolean {
  // Exact match or subroute match — guards against /admin/underwriting-library
  // matching /admin/underwriting-insights (shared prefix).
  if (pathname === href) return true;
  return pathname.startsWith(href + '/');
}

function primaryLinkClasses(active: boolean): string {
  // Dark chrome bar (mockup TopBar) — nav links read on the ink ground.
  return active
    ? 'text-white font-semibold border-b-2 border-white/70 pb-1 -mb-px transition-colors'
    : 'text-white/55 hover:text-white transition-colors';
}

/* -------------------------------------------------------------------------- */
/* Breadcrumb (P1) — derived from usePathname() + side context.               */
/*                                                                            */
/* Crumb spine: Home › {Side} › (Deals) › Deal › Loan › Deal room.            */
/*   /                                       → Home                            */
/*   ?side=originator|buyer (any path)       → "Originator" / "B-piece buyer"  */
/*                                             (side accent color)             */
/*   /pools                                   → Deals                          */
/*   /pools/[poolId]                          → Deal                           */
/*   /pools/[poolId]/loans/[…]                → Loan                           */
/*   /analysis/[id]                           → Deal room                      */
/* Only the crumbs relevant to the current path are shown.                    */
/* -------------------------------------------------------------------------- */

interface Crumb {
  readonly label: string;
  readonly href?: string;
  readonly side?: Side; // when set, render in the side accent color
}

const SIDE_LABEL: Record<Side, string> = {
  originator: 'Originator',
  buyer: 'B-piece buyer',
};

function buildCrumbs(pathname: string, side: Side | null): Crumb[] {
  const crumbs: Crumb[] = [{ label: 'Home', href: '/' }];

  // Side crumb — carried on the URL, independent of path depth.
  if (side) {
    crumbs.push({ label: SIDE_LABEL[side], side });
  }

  const sideQuery = side ? `?side=${side}` : '';

  if (pathname === '/pools') {
    crumbs.push({ label: 'Deals' });
  } else if (pathname.startsWith('/pools/')) {
    // /pools/[poolId] and deeper.
    const parts = pathname.split('/').filter(Boolean); // ['pools', poolId, 'loans', loanId]
    crumbs.push({ label: 'Deals', href: `/pools${sideQuery}` });
    if (parts.length >= 2) {
      const poolHref = `/pools/${parts[1]}${sideQuery}`;
      const isLoan = parts.length >= 4 && parts[2] === 'loans';
      crumbs.push({ label: 'Deal', href: isLoan ? poolHref : undefined });
      if (isLoan) crumbs.push({ label: 'Loan' });
    }
  } else if (pathname.startsWith('/analysis/')) {
    crumbs.push({ label: 'Deal room' });
  }

  return crumbs;
}

function sideAccentClass(side: Side): string {
  return side === 'originator' ? 'text-originator' : 'text-buyer';
}

function Breadcrumb({ pathname, side }: { pathname: string; side: Side | null }) {
  const crumbs = buildCrumbs(pathname, side);
  // Nothing meaningful beyond "Home" on the bare home page — hide the row.
  if (crumbs.length <= 1) return null;

  return (
    <div className="bg-ink border-t border-white/10 px-6 py-2">
      <nav
        aria-label="Breadcrumb"
        className="max-w-6xl mx-auto flex items-center gap-1.5 font-mono text-[11px]"
      >
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          const color = c.side ? sideAccentClass(c.side) : last ? 'text-white' : 'text-white/45';
          const content = c.href && !last ? (
            <a href={c.href} className={`${color} hover:text-white transition-colors`}>
              {c.label}
            </a>
          ) : (
            <span className={color} aria-current={last ? 'page' : undefined}>
              {c.label}
            </span>
          );
          return (
            <span key={`${c.label}-${i}`} className="flex items-center gap-1.5">
              {i > 0 && <span aria-hidden className="text-white/25">›</span>}
              {content}
            </span>
          );
        })}
      </nav>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* AppContent                                                                 */
/* -------------------------------------------------------------------------- */

function AppContent({ children }: { children: React.ReactNode }) {
  const { user, logout, isLoading } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const side = useSide();

  const isLoginPage = pathname === '/login';

  // Chunk 6 — ADMIN-only "View as" switch. Sets/clears ?side on the current URL
  // (originator/buyer → ?side=X; platform → clear) so the admin's existing chunk-3
  // ?side override drives the view without hand-editing the URL. Other query params
  // are preserved. No new permission/backend logic — pure navigation.
  const setSideView = (target: Side | null): void => {
    const params = new URLSearchParams(searchParams.toString());
    if (target === null) params.delete('side');
    else params.set('side', target);
    const qs = params.toString();
    router.push(qs.length > 0 ? `${pathname}?${qs}` : pathname);
  };

  useEffect(() => {
    if (isLoading) return;
    // Existing behavior: unauth → /login (unchanged).
    if (!user && !isLoginPage) {
      router.push('/login');
      return;
    }
    // Chunk 4 — per-role landing + cross-role deep-link guard. The deal roles
    // (ORIGINATOR/BUYER) land in their own world and get no admin surface; ADMIN
    // and internal roles are unaffected (roleRoute returns null for them). Admin
    // keeps the two-door home. See lib/role-routing.ts for the honest scope note.
    if (user) {
      const target = roleRoute(user.role, pathname);
      if (target !== null && target !== pathname) {
        router.replace(target);
      }
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

  return (
    <>
      {/* Two-facing port (P1) — dark chrome bar reconciled to the mockup TopBar
       *  (docs/mockups/cre-two-facing-mockup.jsx lines 86-120): split
       *  ochre/steel wordmark on the ink ground. Nav links + Library menu +
       *  auth (email / Sign Out) are PRESERVED, restyled for the dark bar. */}
      <header className="bg-ink px-6 py-3 flex items-center justify-between">
        <a href="/" className="flex items-center gap-3 text-left">
          <div
            className="w-[22px] h-[22px] rounded-[5px] flex-none"
            style={{
              background:
                'linear-gradient(135deg, #A8742A 0 50%, #2F5E86 50% 100%)',
            }}
            aria-hidden
          />
          <div>
            <div className="font-display font-bold tracking-[0.02em] text-white text-sm leading-none">
              CRE CREDIT COMMITTEE
            </div>
            <div className="font-mono text-[10px] text-white/45 mt-[3px]">
              the credit committee, as software
            </div>
          </div>
        </a>
        <nav className="flex items-center gap-5 text-xs">
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

          {/* "Library" dropdown (UW Library / UW Insights / Registry) removed from the
              header (leftover scaffolding). The /admin/registry routes + the LibrarySnapshot
              / MarketBenchmarks data the engine reads are untouched — nav-only removal. */}

          {/* Chunk 6 — ADMIN-only "View as" switch (QA both sides without editing URLs).
              Non-admins are role-forced (chunk 3) and never see it. */}
          {user.role === 'ADMIN' ? (
            <>
              <span className="text-white/25">|</span>
              <div className="flex items-center gap-0.5" role="group" aria-label="View as">
                <span className="text-white/40 mr-1 text-[10px] uppercase tracking-wide">View as</span>
                {([['originator', 'Originator'], ['buyer', 'Buyer'], [null, 'Platform']] as const).map(([val, label]) => {
                  const active = side === val;
                  return (
                    <button
                      key={label}
                      type="button"
                      onClick={() => setSideView(val)}
                      aria-pressed={active}
                      className={`rounded px-2 py-0.5 text-[11px] transition-colors ${
                        active ? 'bg-white/15 text-white font-semibold' : 'text-white/50 hover:text-white'
                      }`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </>
          ) : null}

          <span className="text-white/25">|</span>
          <span className="text-white/45">{user.email}</span>
          <button
            onClick={logout}
            className="text-white/55 hover:text-white transition-colors"
          >
            Sign Out
          </button>
        </nav>
      </header>
      <Breadcrumb pathname={pathname} side={side} />
      <main>{children}</main>
    </>
  );
}

export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <SideProvider>
        <AppContent>{children}</AppContent>
      </SideProvider>
    </AuthProvider>
  );
}
