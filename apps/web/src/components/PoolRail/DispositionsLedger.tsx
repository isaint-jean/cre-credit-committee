/**
 * DispositionsLedger — buyer-authoritative departures, the core differentiator.
 *
 * Renders each Disposition with originator label, buyer label, the override flag,
 * and an "OVERRIDE" badge when they diverge (`override === true` ⇔ originatorLabel
 * !== buyerLabel; integrity rule P5 from the pool layer).
 */
import type { Disposition, DispositionKind } from '@cre/contracts';

function LabelChip({ kind }: { readonly kind: DispositionKind }) {
  const tone = kind === 'kicked'
    ? 'bg-risk-high/15 text-risk-high border-risk-high/30'
    : 'bg-text-muted/15 text-text-secondary border-border-secondary';
  return (
    <span className={`text-xs px-2 py-0.5 rounded border font-mono ${tone}`}>
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
        <div className="border border-border-primary rounded overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-bg-tertiary">
              <tr className="text-left text-text-secondary text-xs uppercase tracking-wide">
                <th className="px-3 py-2 font-medium">Loan</th>
                <th className="px-3 py-2 font-medium">Originator label</th>
                <th className="px-3 py-2 font-medium">Buyer label</th>
                <th className="px-3 py-2 font-medium">Override</th>
                <th className="px-3 py-2 font-medium">Reasons</th>
                <th className="px-3 py-2 font-medium">Recorded</th>
              </tr>
            </thead>
            <tbody>
              {dispositions.map(d => (
                <tr key={d.id} className="border-t border-border-primary">
                  <td className="px-3 py-2 text-text-secondary font-mono text-xs">{d.loanInPoolId.slice(0, 8)}…</td>
                  <td className="px-3 py-2"><LabelChip kind={d.originatorLabel} /></td>
                  <td className="px-3 py-2 flex items-center gap-2">
                    <LabelChip kind={d.buyerLabel} />
                    <span className="text-[10px] text-text-muted uppercase">authoritative</span>
                  </td>
                  <td className="px-3 py-2">
                    {d.override ? (
                      <span className="text-xs px-2 py-0.5 rounded bg-risk-medium/15 text-risk-medium border border-risk-medium/30 font-semibold">
                        OVERRIDE
                      </span>
                    ) : (
                      <span className="text-text-muted text-xs">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-text-secondary text-xs max-w-md">
                    {d.reasons.length === 0
                      ? <span className="text-text-muted">—</span>
                      : <span>{d.reasons.join('; ')}</span>}
                  </td>
                  <td className="px-3 py-2 text-text-muted text-xs">
                    {new Date(d.recordedAt).toLocaleDateString()}{' '}
                    <span className="text-text-muted/70">· {d.recordedBy.userId}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
