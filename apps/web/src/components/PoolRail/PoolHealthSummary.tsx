/**
 * PoolHealthSummary — roll-up counts for the current tape and disposition history.
 * Pure projection over the membership/disposition arrays the rail already loaded.
 */
import type { Disposition, LoanMembership } from '@cre/contracts';

export function PoolHealthSummary({
  membership,
  dispositions,
}: {
  readonly membership: readonly LoanMembership[];
  readonly dispositions: readonly Disposition[];
}) {
  const total = membership.length;
  const clean = membership.filter(m => m.status === 'clean').length;
  const conditioned = membership.filter(m => m.status === 'conditioned').length;
  const kickFlagged = membership.filter(m => m.status === 'kick-flagged').length;
  const underReview = membership.filter(m => m.status === 'under-review').length;
  const departed = dispositions.length;
  const overrides = dispositions.filter(d => d.override).length;

  const cells: Array<{ label: string; value: number; tone: string }> = [
    { label: 'Current tape',     value: total,       tone: 'text-text-primary' },
    { label: 'Clean',            value: clean,       tone: 'text-score-strong' },
    { label: 'Conditioned',      value: conditioned, tone: 'text-accent' },
    { label: 'Kick-flagged',     value: kickFlagged, tone: 'text-risk-high' },
    { label: 'Under review',     value: underReview, tone: 'text-text-secondary' },
    { label: 'Departed (total)', value: departed,    tone: 'text-text-secondary' },
    { label: 'Overrides',        value: overrides,   tone: 'text-risk-medium' },
  ];

  return (
    <section className="mb-6 grid grid-cols-7 gap-3">
      {cells.map(c => (
        <div key={c.label} className="bg-bg-secondary border border-border-primary rounded p-3">
          <div className="text-[10px] uppercase tracking-wide text-text-muted mb-1">{c.label}</div>
          <div className={`text-xl font-semibold ${c.tone}`}>{c.value}</div>
        </div>
      ))}
    </section>
  );
}
