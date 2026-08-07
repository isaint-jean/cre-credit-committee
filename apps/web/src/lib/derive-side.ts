import type { Side } from './side-context';

/**
 * deriveSide — role-siloing chunk 3 (the keystone bridge).
 *
 * The effective `?side` view is DERIVED from the logged-in user's role:
 *   - ORIGINATOR → 'originator' (FORCED; the URL ?side cannot override).
 *   - BUYER      → 'buyer'      (FORCED).
 *   - ADMIN, every internal role (VIEWER/ANALYST/CREDIT_OFFICER/COMMITTEE_MEMBER),
 *     and logged-out/loading → keep the URL-driven value (?side, else Platform/null).
 *
 * This turns every existing useSide() consumer into real role-driven siloing without
 * rewriting them, while preserving ADMIN's ?side override (how QA views each side).
 * Pure — no React, no I/O — so it is unit-testable in isolation.
 */
export function deriveSide(role: string | null | undefined, urlSide: Side | null): Side | null {
  const r = (role ?? '').toUpperCase();
  if (r === 'ORIGINATOR') return 'originator';
  if (r === 'BUYER') return 'buyer';
  return urlSide;
}
