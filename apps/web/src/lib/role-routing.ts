/**
 * roleRoute — role-siloing chunk 4. Post-login landing + cross-role deep-link guard,
 * as a pure function of (role, pathname) → redirect target (or null to stay).
 *
 * The two deal roles are routed into their own world; ADMIN and the internal
 * credit-shop roles are UNAFFECTED (admin is the QA/oversight role; internal roles
 * keep their existing access):
 *   - ORIGINATOR / BUYER at '/' (the two-door home) → '/pools' (their deals list;
 *     side is role-forced by chunk 3, so /pools renders their side — no door-picking).
 *   - ORIGINATOR / BUYER hitting an admin surface ('/admin/*') → '/pools' (the deal
 *     roles get no admin surface).
 *   - everyone else, and every other path → null (no redirect).
 *
 * NOTE (honest scope): this is a CLIENT-side guard. It stops the deal roles from
 * landing on / navigating to admin surfaces, but the admin PAGE data reads are only
 * `requireAuth`-gated on the server today (registry reads, etc. are authenticated,
 * not ADMIN-gated). A full server guard (gating admin reads to ADMIN) is deferred.
 * Writes are already permission-gated (originator/buyer lack registry:write etc.).
 *
 * Pure — no React, no I/O — unit-testable in isolation.
 */
export function roleRoute(role: string | null | undefined, pathname: string): string | null {
  const r = (role ?? '').toUpperCase();
  const isDealRole = r === 'ORIGINATOR' || r === 'BUYER';
  if (!isDealRole) return null; // ADMIN + internal roles + logged-out: unaffected
  if (pathname === '/') return '/pools'; // land in their world, not the two-door home
  if (pathname === '/admin' || pathname.startsWith('/admin/')) return '/pools'; // no admin surface
  return null;
}
