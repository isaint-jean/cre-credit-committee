/**
 * DispositionsLedger — buyer-authoritative departures, reconciled to the
 * prototype's departures ledger (cre-pool-rail.html renderLedger()).
 *
 * Binds the REAL disposition rows from GET /:poolId/dispositions (74 in data).
 * Each row shows the originator label, the buyer label (authoritative), the
 * override chain when they diverge, and the real `reasons` from the payload —
 * kick reasons travel with the record. NO seeds, no sample dead-deals.
 *
 * Chips: `kicked` → risk tone; `dropped` → muted. Kicks are sorted first (the
 * consequential departures), then overrides. The foot states the doctrine.
 *
 * Integrity rule (P5): override === true ⇔ originatorLabel !== buyerLabel.
 */
import type { Disposition, DispositionKind } from '@cre/contracts';

function LabelChip({ kind, struck = false }: { readonly kind: DispositionKind; readonly struck?: boolean }) {
  const tone = kind === 'kicked'
    ? 'bg-risk-high/13 text-risk-high border-risk-high/40'
    : 'bg-text-muted/15 text-text-secondary border-border-secondary';
  return (
    <span className={`text-[11px] px-2 py-0.5 rounded border font-mono capitalize ${tone} ${struck ? 'line-through opacity-65' : ''}`}>
      {kind}
    </span>
  );
}

export function DispositionsLedger({
  dispositions,
}: {
  readonly dispositions: readonly Disposition[];
}) {
  const overrides = dispositions.filter(d => d.override);

  // Kicks first (the consequential ones), then overrides — mirrors the prototype's ordering.
  const ordered = [...dispositions].sort((a, b) => {
    const kick = Number(b.buyerLabel === 'kicked') - Number(a.buyerLabel === 'kicked');
    if (kick !== 0) return kick;
    return Number(b.override) - Number(a.override);
  });

  return (
    <section className="mb-6">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-sm font-semibold text-text-primary uppercase tracking-wide">
          Departures · {dispositions.length}
        </h2>
        {overrides.length > 0 && (
          <span className="text-xs text-risk-medium">
            {overrides.length} buyer override{overrides.length === 1 ? '' : 's'}
          </span>
        )}
      </div>

      {dispositions.length === 0 ? (
        <div className="bg-bg-secondary border border-border-primary rounded p-4 text-text-muted text-sm">
          No loans have departed this pool yet.
        </div>
      ) : (
        <div className="border border-border-primary rounded-panel overflow-hidden bg-bg-secondary">
          <table className="w-full text-sm">
            <thead className="bg-bg-tertiary">
              <tr className="text-left text-text-muted text-[10px] uppercase tracking-wide">
                <th className="px-3 py-2.5 font-semibold">Loan</th>
                <th className="px-3 py-2.5 font-semibold">Disposition</th>
                <th className="px-3 py-2.5 font-semibold">Reason</th>
                <th className="px-3 py-2.5 font-semibold">Recorded</th>
              </tr>
            </thead>
            <tbody>
              {ordered.map(d => (
                <tr
                  key={d.id}
                  className={`border-t border-border-primary/70 align-top ${d.override ? 'bg-risk-high/[0.03]' : ''}`}
                >
                  <td className="px-3 py-3 text-text-secondary font-mono text-xs whitespace-nowrap">
                    {d.loanInPoolId.slice(0, 8)}…
                  </td>
                  <td className="px-3 py-3">
                    <DispositionCell disp={d} />
                  </td>
                  <td className="px-3 py-3 text-text-secondary text-xs max-w-md">
                    <ReasonCell disp={d} />
                  </td>
                  <td className="px-3 py-3 text-text-muted text-xs whitespace-nowrap">
                    {new Date(d.recordedAt).toLocaleDateString()}
                    <span className="text-text-muted/70"> · {d.recordedBy.userId}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="px-4 py-3 bg-bg-tertiary border-t border-border-primary/70 text-xs text-text-secondary flex gap-2.5 items-start">
            <ShieldIcon />
            <div>
              <b className="text-text-primary font-semibold">Disposition is buyer-authoritative.</b>{' '}
              Where the originator marked a loan &ldquo;dropped&rdquo; but the committee kicked it, the record keeps
              both — the buyer&rsquo;s designation governs and the engine&rsquo;s reasons travel with it. A kick can&rsquo;t
              be laundered into a clean drop.
              {overrides.length > 0 && (
                <> <b className="text-text-primary font-semibold">{overrides.length} of {dispositions.length}</b> departures were originator-relabeled.</>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

/** Orig → Buyer chip pattern; override shows the struck original + an OVERRIDE badge. */
function DispositionCell({ disp }: { readonly disp: Disposition }) {
  if (disp.override) {
    return (
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-text-muted text-[10px] uppercase">Orig</span>
        <LabelChip kind={disp.originatorLabel} struck />
        <span className="text-text-muted">→</span>
        <span className="text-text-muted text-[10px] uppercase">Buyer</span>
        <LabelChip kind={disp.buyerLabel} />
        <span className="text-[9px] font-bold uppercase tracking-wide text-risk-high bg-risk-high/13 border border-risk-high/40 rounded px-1.5 py-0.5">
          override
        </span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <LabelChip kind={disp.buyerLabel} />
      <span className="text-[10px] text-text-muted uppercase">both agree · authoritative</span>
    </div>
  );
}

/** Surfaces the real `reasons`. Kicks carry the buyer-authoritative preface. */
function ReasonCell({ disp }: { readonly disp: Disposition }) {
  if (disp.reasons.length === 0) {
    return <span className="text-text-muted">—</span>;
  }
  const isKick = disp.buyerLabel === 'kicked';
  return (
    <div className="leading-relaxed">
      {isKick && (
        <span className="text-risk-high font-medium">
          Buyer-authoritative{disp.override ? ' · originator had marked this dropped' : ''}.{' '}
        </span>
      )}
      <span>{disp.reasons.join('; ')}</span>
    </div>
  );
}

function ShieldIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="w-4 h-4 flex-none mt-px text-accent" aria-hidden>
      <path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7l8-4z M9 12l2 2 4-4"
        stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
