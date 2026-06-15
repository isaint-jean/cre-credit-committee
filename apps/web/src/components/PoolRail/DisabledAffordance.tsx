/**
 * DisabledAffordance — placeholder for write actions wired in the next UI slice.
 *
 * PR5 is read-only. Mutation surfaces (advance tape / resolve / record disposition
 * / freeze) are SHOWN but NOT wired — so the rail reveals its full intended shape
 * with the write paths visibly inert, not absent. The next slice replaces these
 * with real buttons that POST to /api/pools/:poolId/tapes etc.
 */
import type { ReactNode } from 'react';

export function DisabledAffordance({
  label,
  hint,
  icon,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly icon?: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled
      aria-disabled="true"
      title={hint ?? 'Next UI slice'}
      className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded
                 border border-border-secondary text-text-muted bg-bg-tertiary
                 cursor-not-allowed opacity-60"
    >
      {icon}
      <span>{label}</span>
      <span className="text-[10px] uppercase tracking-wide text-text-muted/70 ml-1">next slice</span>
    </button>
  );
}
