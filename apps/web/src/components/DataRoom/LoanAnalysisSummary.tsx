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

export function LoanAnalysisSummary({ analysisId, depth }: { analysisId: string | null; depth: number }) {
  const [resp, setResp] = useState<GetAnalysisResponse | null>(null);
  const [intake, setIntake] = useState<IntakeCompleteness | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'loaded' | 'error'>('idle');
  const [showSources, setShowSources] = useState(false);
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
    return <div className="py-1 text-xs text-text-secondary" style={pad}>No underwriting yet for this loan.</div>;
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
    </div>
  );
}
