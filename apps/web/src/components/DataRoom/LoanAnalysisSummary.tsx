'use client';

/**
 * Loan analysis summary (data-room differentiator, Tier 1 + 1.5) — READ-ONLY.
 *
 * Given a resolved analysisId (from the tree file leaf), surfaces the engine's
 * DEAL-LEVEL verdict for that loan alongside its documents: score / rating band /
 * red flags (doctrine + data-quality) / mitigants (Tier 1), plus the per-field
 * "what the engine pulled, and from which document" map from intake-completeness
 * (Tier 1.5). Reuses the existing endpoints + contracts verbatim — no engine
 * changes, no re-derivation, no mutation. analysisId === null → "No underwriting yet".
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, type GetAnalysisResponse } from '@/lib/api-client';
import type { IntakeCompleteness } from '@/lib/api-client';

type FlagTone = 'critical' | 'warning' | 'info';
function toneClass(sev: string): string {
  const s = sev.toLowerCase() as FlagTone;
  if (s === 'critical') return 'border-risk-high/30 bg-risk-high/10 text-risk-high';
  if (s === 'warning') return 'border-accent/30 bg-accent-soft text-accent';
  return 'border-border-primary bg-bg-tertiary text-text-secondary';
}

/** Tier 2 (a) — the loan's missing ingest docs (set-difference; no engine call).
 *  Renders even for an un-underwritten loan / with credits exhausted. */
function MissingDocs({ poolId, loanInPoolId, depth }: { poolId: string | null; loanInPoolId: string; depth: number }) {
  const [missing, setMissing] = useState<Array<{ slot: string; label: string; blocks: string }> | null>(null);
  const pad = { paddingLeft: `${8 + depth * 16 + 16}px` } as const;
  useEffect(() => {
    if (!poolId) return;
    let cancelled = false;
    api.getMissingDocs(poolId, loanInPoolId).then((r) => { if (!cancelled) setMissing(r.missing); }).catch(() => { if (!cancelled) setMissing([]); });
    return () => { cancelled = true; };
  }, [poolId, loanInPoolId]);
  if (!missing || missing.length === 0) return null;
  return (
    <div className="mt-2" style={pad}>
      <p className="text-[11px] uppercase tracking-wide text-text-secondary">Request from bank</p>
      <ul className="mt-1 space-y-0.5">
        {missing.map((m) => (
          <li key={m.slot} className="text-xs text-text-secondary">
            <span className="text-risk-high">⚠ {m.label}</span> not provided by bank — blocks {m.blocks}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function LoanAnalysisSummary({ analysisId, poolId, loanInPoolId, depth }: { analysisId: string | null; poolId: string | null; loanInPoolId: string; depth: number }) {
  const [resp, setResp] = useState<GetAnalysisResponse | null>(null);
  const [intake, setIntake] = useState<IntakeCompleteness | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'loaded' | 'error'>('idle');
  const [showSources, setShowSources] = useState(false);
  const [showFin, setShowFin] = useState(false);
  const pad = { paddingLeft: `${8 + depth * 16 + 16}px` } as const;

  useEffect(() => {
    if (!analysisId) return;
    let cancelled = false;
    setState('loading');
    (async () => {
      try {
        const [a, ic] = await Promise.all([
          api.getAnalysis(analysisId),
          api.getIntakeCompleteness(analysisId).catch(() => null),
        ]);
        if (!cancelled) { setResp(a); setIntake(ic); setState('loaded'); }
      } catch {
        if (!cancelled) setState('error');
      }
    })();
    return () => { cancelled = true; };
  }, [analysisId]);

  if (!analysisId) {
    return (
      <div>
        <div className="py-1 text-xs text-text-secondary" style={pad}>No underwriting yet for this loan.</div>
        <MissingDocs poolId={poolId} loanInPoolId={loanInPoolId} depth={depth} />
      </div>
    );
  }
  if (state === 'loading' || state === 'idle') {
    return <div className="py-1 text-xs text-text-secondary" style={pad}>Loading the engine&apos;s verdict…</div>;
  }
  if (state === 'error' || !resp) {
    return <div className="py-1 text-xs text-text-secondary" style={pad}>Engine verdict unavailable.</div>;
  }

  const analysisHref = `/analysis/${analysisId}`;

  if (resp.kind !== 'rendered') {
    return (
      <div className="py-1 text-xs" style={pad}>
        Underwriting available — <Link href={analysisHref} className="text-accent hover:underline">open the full analysis →</Link>
      </div>
    );
  }

  const r = resp.body;
  const score = r.summary?.finalScore?.displayValue ?? String(r.summary?.finalScore?.value ?? '—');
  const band = r.summary?.ratingBand?.displayValue ?? '';
  const flags = [...(r.doctrine?.flags ?? []), ...(r.dataQuality?.flags ?? [])];
  const mitigations = r.mitigations ?? [];
  const sourced = (intake?.fields ?? []).filter((f) => f.sourceDoc && f.sourceDoc.length > 0);

  return (
    <div className="rounded-md border border-border-primary bg-bg-tertiary/40 py-2 pr-3 text-sm" style={pad}>
      {/* Loan-level — the opinion is about the LOAN this doc fed, not the single file. */}
      <p className="mb-1 text-[11px] uppercase tracking-wide text-text-secondary">Loan verdict</p>
      {/* Tier 1 — the verdict */}
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-lg font-semibold text-text-primary">{score}</span>
        {band && <span className="rounded border border-border-primary px-2 py-0.5 text-xs text-text-secondary">{band}</span>}
        <Link href={analysisHref} className="ml-auto text-xs text-accent hover:underline">Open full analysis →</Link>
      </div>

      {flags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {flags.map((f) => (
            <span key={f.code} className={`rounded border px-1.5 py-0.5 text-xs ${toneClass(f.severity)}`} title={f.code}>
              {f.label}
            </span>
          ))}
        </div>
      )}
      {flags.length === 0 && <p className="mt-2 text-xs text-text-secondary">No red flags raised.</p>}

      {mitigations.length > 0 && (
        <div className="mt-2">
          <p className="text-xs font-medium text-text-secondary">Mitigants</p>
          <ul className="mt-1 list-disc pl-5 text-xs text-text-primary">
            {mitigations.map((m, i) => <li key={m.principleIds?.join(',') || i}>{m.title}</li>)}
          </ul>
        </div>
      )}

      {/* Tier 1.5 — what the engine pulled, and from which document */}
      {sourced.length > 0 && (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setShowSources((s) => !s)}
            className="text-xs text-accent hover:underline"
          >
            {showSources ? '▾' : '▸'} What the engine pulled — {sourced.length} field{sourced.length === 1 ? '' : 's'} + source doc
          </button>
          {showSources && (
            <ul className="mt-1 space-y-1">
              {sourced.map((f) => (
                <li key={f.id} className="text-xs">
                  <span className="text-text-primary">{f.field}</span>
                  <span className="text-text-secondary"> ← {f.sourceDoc}</span>
                  {f.sourceQuote && <span className="block truncate pl-3 italic text-text-secondary" title={f.sourceQuote}>“{f.sourceQuote}”</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Tier 2 (a) — missing ingest docs (set-difference, no engine call). */}
      <MissingDocs poolId={poolId} loanInPoolId={loanInPoolId} depth={0} />

      {/* Tier 2 (b) — reconciled income/expense from the already-fetched analysis. */}
      {((r.incomeLines?.length ?? 0) > 0 || (r.expenseLines?.length ?? 0) > 0) && (
        <div className="mt-3">
          <button type="button" onClick={() => setShowFin((s) => !s)} className="text-xs text-accent hover:underline">
            {showFin ? '▾' : '▸'} Income &amp; expenses (reconciled)
          </button>
          {showFin && (
            <div className="mt-1 space-y-0.5 text-xs">
              {r.incomeLines.length > 0 && <p className="font-medium text-text-secondary">Income</p>}
              {r.incomeLines.map((l) => (
                <div key={`i-${l.name}`} className="flex justify-between gap-4">
                  <span className="text-text-primary">{l.name}</span>
                  <span className="shrink-0 text-text-secondary">{l.adjusted?.displayValue ?? '—'}</span>
                </div>
              ))}
              {r.expenseLines.length > 0 && <p className="mt-1 font-medium text-text-secondary">Expenses</p>}
              {r.expenseLines.map((l) => (
                <div key={`e-${l.name}`} className="flex justify-between gap-4">
                  <span className="text-text-primary">{l.name}</span>
                  <span className="shrink-0 text-text-secondary">{l.adjusted?.displayValue ?? '—'}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
