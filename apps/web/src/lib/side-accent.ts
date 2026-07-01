/**
 * side-accent — P2 helper mapping the active `?side` (originator | buyer | null)
 * to the P1 token classes, so the pool-picker and loan-tape screens share ONE
 * source of side-identity styling.
 *
 * Explicit literal class strings (not template concatenation) so Tailwind's JIT
 * keeps every class. `null` side = the platform-neutral teal `accent`.
 *
 * FRONTEND-ONLY: pure token lookup, no state, no backend.
 */
import type { Side } from './side-context';

export interface SideAccent {
  /** e.g. "text-originator" — the accent text color. */
  readonly text: string;
  /** e.g. "border-t-originator" — top edge accent (flowcard rail). */
  readonly borderTop: string;
  /** e.g. "hover:border-originator" — hover ring. */
  readonly hoverBorder: string;
  /** e.g. "bg-originator-soft" — tinted fill (chips/badges). */
  readonly softBg: string;
  /** e.g. "border-originator" — solid accent border. */
  readonly border: string;
  /** Human label for the side. */
  readonly label: string;
}

const ORIGINATOR: SideAccent = {
  text: 'text-originator',
  borderTop: 'border-t-originator',
  hoverBorder: 'hover:border-originator',
  softBg: 'bg-originator-soft',
  border: 'border-originator',
  label: 'Originator',
};

const BUYER: SideAccent = {
  text: 'text-buyer',
  borderTop: 'border-t-buyer',
  hoverBorder: 'hover:border-buyer',
  softBg: 'bg-buyer-soft',
  border: 'border-buyer',
  label: 'B-piece buyer',
};

/** Platform-neutral teal when no side is selected. */
const NEUTRAL: SideAccent = {
  text: 'text-accent',
  borderTop: 'border-t-accent',
  hoverBorder: 'hover:border-accent',
  softBg: 'bg-accent-soft',
  border: 'border-accent',
  label: 'Platform',
};

export function sideAccent(side: Side | null): SideAccent {
  if (side === 'originator') return ORIGINATOR;
  if (side === 'buyer') return BUYER;
  return NEUTRAL;
}

/** Append `?side=…` to an href when a side is active; pass-through otherwise. */
export function withSide(href: string, side: Side | null): string {
  if (side === null) return href;
  const sep = href.includes('?') ? '&' : '?';
  return `${href}${sep}side=${side}`;
}
