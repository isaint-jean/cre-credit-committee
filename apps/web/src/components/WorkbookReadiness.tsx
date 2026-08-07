// WorkbookReadiness — P3b field-level intake completeness panel on the modern
// analysis surface (RenderedAnalysisView). Reconciled to the mockup's
// WorkbookReadiness (docs/mockups/cre-two-facing-mockup.jsx ~line 516).
//
// ADVISORY ONLY. Nothing here blocks anything: the "Create workbook" CTA is
// ALWAYS enabled and wired straight to the real /underwriting/export. The panel
// fetches GET /analyses/:id/intake-completeness and surfaces the honest ceiling
// per field — sourced / in-a-doc-confirm / add-source / your-call — carrying the
// ?side accent (ochre originator, steel buyer) for P1/P2 consistency.

'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api-client';
import type { IntakeCompleteness, IntakeFieldResult, IntakeState } from '@/lib/api-client';
import { useSide } from '@/lib/side-context';
import { sideAccent } from '@/lib/side-accent';
import { AddDocumentControl } from './AddDocumentControl';

// Per-state chrome, mirroring the mockup's FSTATE map. `not-in-any-doc` gets the
// "add source" affordance; `in-PDF-not-extracted` gets "confirm / enter".
const STATE_META: Record<
  Exclude<IntakeState, 'populated' | 'decision-blank' | 'not-applicable'>,
  { label: string; text: string; bg: string; cta: string }
> = {
  'in-PDF-not-extracted': {
    label: 'in a doc — confirm',
    text: 'text-originator',
    bg: 'bg-originator-soft',
    cta: 'Confirm / enter',
  },
  'not-in-any-doc': {
    label: 'no source yet',
    text: 'text-warn',
    bg: 'bg-[#F3E2DB]',
    cta: 'Add source',
  },
};

function ReadinessMeter({ sourced, total, pct }: { sourced: number; total: number; pct: number }): React.ReactElement {
  return (
    <div className="text-right">
      <div className="font-mono text-[11px] text-text-secondary">
        {sourced} / {total} data points sourced
      </div>
      <div className="mt-1 h-1.5 w-36 overflow-hidden rounded-full bg-paper">
        <div
          className={'h-full ' + (pct === 100 ? 'bg-cleared' : 'bg-originator')}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function NeedRow({ f }: { f: IntakeFieldResult }): React.ReactElement {
  const meta =
    f.state === 'not-in-any-doc' ? STATE_META['not-in-any-doc'] : STATE_META['in-PDF-not-extracted'];
  return (
    <div className="flex items-start gap-3 rounded-lg bg-paper px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-text-primary">{f.field}</span>
          {f.searchStatus === 'unavailable' ? (
            // ★ Could-not-search → UNVERIFIED, never "confirmed missing".
            <span className="rounded bg-[#FBECC8] px-1.5 py-px font-mono text-[9.5px] text-warn" title="The document search could not run (credits/error). This field is UNVERIFIED — not confirmed missing.">
              unverified — search unavailable
            </span>
          ) : (
            <span
              className={'rounded px-1.5 py-px font-mono text-[9.5px] ' + meta.text + ' ' + meta.bg}
              title={f.searchStatus === 'searched' ? 'Searched every document on the deal — genuinely not found.' : undefined}
            >
              {f.searchStatus === 'searched' ? 'searched — not found' : meta.label}
            </span>
          )}
          {f.criticality.startsWith('Required') ? (
            <span className="rounded bg-[#F3E2DB] px-1.5 py-px font-mono text-[9.5px] text-warn">
              required
            </span>
          ) : null}
        </div>
        <div className="mt-0.5 text-xs text-text-secondary">
          Blocks <span className="text-text-primary">{f.blocks}</span>
          {f.sources.length > 0 ? <> · usually in {f.sources.join(' / ')}</> : null}
        </div>
      </div>
      {/*
        Inline field-entry / add-source is not built yet — there is no endpoint to
        confirm-or-enter a value or attach a source from here. Rather than leave a
        dead-clickable button (which silently no-ops), render it HONESTLY DISABLED
        with the real path in the title: add/confirm the fact in the deal room's
        data room, then re-underwrite. Re-enable with an onClick when that flow
        exists.
      */}
      <button
        type="button"
        disabled
        aria-disabled="true"
        title={
          f.state === 'not-in-any-doc'
            ? 'No source yet. Add the document to the deal room’s data room, then re-underwrite. (Inline entry isn’t available yet.)'
            : 'This fact is in a document but wasn’t auto-extracted. Confirm it in the deal room’s data room, then re-underwrite. (Inline entry isn’t available yet.)'
        }
        className="cursor-not-allowed whitespace-nowrap rounded-md border border-line bg-white px-2.5 py-1 font-mono text-[10.5px] text-text-secondary opacity-50"
      >
        {meta.cta}
      </button>
    </div>
  );
}

// Humanize the pre-flight source_doc_types into calm reading for the originator
// checklist. Faithful to the dependency map — just prettier labels, no new data.
const SOURCE_LABEL: Record<string, string> = {
  seller_uw: 'seller UW', t12: 'T-12', in_place: 'in-place statement', rent_roll: 'rent roll',
  appraisal: 'appraisal', asr: 'ASR', pca: 'PCA', loan_terms: 'loan terms',
};
const humanizeSource = (s: string): string => SOURCE_LABEL[s] ?? s.replace(/_/g, ' ');

// Originator-facing checklist row: the missing fact + what it UNLOCKS for the buyer
// (reuses pre-flight's `feeds`) + which document to drop (reuses `sources`). Read-only.
function BuyerNeedRow({ f }: { f: IntakeFieldResult }): React.ReactElement {
  const docs = f.sources.map(humanizeSource).join(' / ');
  return (
    <div className="flex items-start gap-3 rounded-lg bg-paper px-3 py-2.5">
      <span className="mt-0.5 select-none text-text-secondary" aria-hidden="true">☐</span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-text-primary">{f.field}</span>
          {f.criticality.startsWith('Required') ? (
            <span className="rounded bg-[#F3E2DB] px-1.5 py-px font-mono text-[9.5px] text-warn">required</span>
          ) : null}
          {f.searchStatus === 'unavailable' ? (
            <span className="rounded bg-[#FBECC8] px-1.5 py-px font-mono text-[9.5px] text-warn" title="The document search could not run (credits/error). This field is UNVERIFIED — not confirmed missing.">
              unverified — search unavailable
            </span>
          ) : null}
        </div>
        <div className="mt-0.5 text-xs text-text-secondary">
          Unlocks <span className="text-text-primary">{f.feeds}</span> for the buyer
          {docs.length > 0 ? <> · drop the {docs}</> : null}
        </div>
      </div>
    </div>
  );
}

interface Props {
  /** URL analysis id — the deal id passed to GET /analyses/:id/intake-completeness. */
  readonly analysisId: string;
  /** Page refetch after an inline document append (re-derives the child revision).
   *  Wired from RenderedAnalysisView's onRevisionSaved so the checklist updates. */
  readonly onAppended?: () => void | Promise<void>;
}

export function WorkbookReadiness({ analysisId, onAppended }: Props): React.ReactElement | null {
  const side = useSide();
  const accent = sideAccent(side);
  const [data, setData] = useState<IntakeCompleteness | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generated, setGenerated] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [open, setOpen] = useState(true);   // panel collapse (originator checklist)

  useEffect(() => {
    let cancelled = false;
    api
      .getIntakeCompleteness(analysisId)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load');
      });
    return () => {
      cancelled = true;
    };
  }, [analysisId]);

  // Buyer → "Create workbook"; originator → "Generate seller underwriting".
  const ctaLabel = side === 'originator' ? 'Generate seller underwriting' : 'Create workbook';
  const artifactLabel = side === 'originator' ? 'Seller underwriting' : 'Workbook';

  const handleGenerate = useCallback(async (): Promise<void> => {
    if (data === null) return;
    setGenerating(true);
    setExportError(null);
    try {
      // Buyer rail exports the full populated workbook (bp_spire profile);
      // originator gets the bank-profile seller package. Never gated on
      // completeness — the export builds at any readiness.
      const profile = side === 'originator' ? 'bank' : 'bp_spire';
      await api.exportUnderwriting(
        data.dealId,
        { profile, assetClass: data.assetClass, underwritingMode: 'single_loan' },
        `${artifactLabel.replace(/\s+/g, '_')}.xlsx`,
      );
      setGenerated(true);
    } catch (e: unknown) {
      setExportError(e instanceof Error ? e.message : 'Export failed');
    } finally {
      setGenerating(false);
    }
  }, [data, side, artifactLabel]);

  const headingText = side === 'originator' ? 'What the buyers need from you' : 'Workbook readiness';
  // Error/loading copy is side-aware so the originator (= bank) never sees workbook /
  // "readiness" framing — that surface is the buyers' checklist, not a workbook.
  const unavailableText = side === 'originator' ? 'Couldn’t load what the buyers need' : 'Readiness unavailable';
  if (error !== null) {
    return (
      <section className="rounded-xl border border-line bg-white p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-700">{headingText}</h2>
        <p className="mt-2 text-sm text-text-secondary">{unavailableText}: {error}</p>
      </section>
    );
  }
  if (data === null) {
    return (
      <section className="rounded-xl border border-line bg-white p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-700">{headingText}</h2>
        <p className="mt-2 text-sm text-text-secondary">Loading…</p>
      </section>
    );
  }

  const { summary } = data;
  const pct = summary.total > 0 ? Math.round((summary.sourced / summary.total) * 100) : 0;
  const populated = data.fields.filter((f) => f.state === 'populated');

  // ── Originator-facing reframe ────────────────────────────────────────────────
  // The bank does NOT get the workbook (that's the buyer's product). For the
  // originator, this is a CHECKLIST of what to drop into the data room so buyers
  // have full scope — each row's "unlock" reuses pre-flight's `feeds`, the doc to
  // provide reuses `sources`. No create/download-workbook CTA on this side. The
  // "Go to data room" button is HELD (disabled) — see note: the only data room is
  // pool-scoped (/pools/[poolId]/data-room) and not reliably reachable from a bare
  // analysis id, so we do NOT wire a dead/ambiguous link. Titled/boxed/collapsible
  // to match BuyerDiffPanel / Red Flags. View-only.
  if (side === 'originator') {
    const needs = summary.needs;
    const requiredCount = summary.requiredMissing.length;
    return (
      <section className="rounded-xl border border-line bg-white">{/* no overflow-hidden: the Add-Document popover floats below the button */}
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left"
        >
          <span className="flex items-center gap-2">
            <span className="select-none text-text-secondary" aria-hidden="true">{open ? '▾' : '▸'}</span>
            <span className="text-[15px] font-semibold text-text-primary">What the buyers need from you</span>
          </span>
          <span className="font-mono text-[11px] text-text-secondary">
            {needs.length === 0
              ? 'all provided'
              : `${needs.length} to add${requiredCount > 0 ? ` · ${requiredCount} required` : ''}`}
          </span>
        </button>

        {open ? (
          <div className="border-t border-line px-5 pb-5 pt-3">
            <p className="mb-3 max-w-xl text-xs text-text-secondary">
              Drop these into the data room so buyers have the full scope to analyze this deal. Each item
              notes what it unlocks for the buyer.
            </p>

            {summary.searchUnavailable ? (
              <div className="mb-3 rounded-lg border-l-4 border-warn bg-[#FBECC8] px-3 py-2.5 text-xs text-text-primary">
                <span className="font-semibold">⚠ Document search unavailable.</span> The exhaustive search
                couldn’t run, so items below are <span className="font-semibold">unverified</span> — they may
                already be in your documents. Re-open once the search is available.
              </div>
            ) : null}

            {needs.length === 0 ? (
              <div className="rounded-lg bg-paper px-3 py-2.5 text-sm text-cleared">
                Everything the buyers need is already in the data room.
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {needs.map((f) => (
                  <BuyerNeedRow key={f.id} f={f} />
                ))}
              </div>
            )}

            {populated.length > 0 ? (
              <details className="mt-3 border-t border-line pt-3">
                <summary className="cursor-pointer font-mono text-[11px] text-text-secondary">
                  {populated.length} already in the data room
                </summary>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {populated.map((f) => (
                    <span key={f.id} className="rounded bg-[#E2F0E8] px-1.5 py-px font-mono text-[10px] text-cleared">
                      ✓ {f.field}
                    </span>
                  ))}
                </div>
              </details>
            ) : null}

            {/* Add documents — wired to the EXISTING inline uploader (AddDocumentControl
                → api.appendDocument → re-ingest as a child revision → page refetch).
                Always works and keeps the originator on-page; reuses the shared control
                (no new uploader built). Replaces the earlier held pool-scoped link. */}
            <div className="mt-4 flex items-center gap-3 border-t border-line pt-4">
              <AddDocumentControl analysisId={analysisId} onAppended={onAppended ?? (() => {})} />
              <span className="text-[11px] text-text-secondary">
                Drop a document straight into the deal — it re-underwrites on the new revision.
              </span>
            </div>
          </div>
        ) : null}
      </section>
    );
  }

  return (
    <section className={'rounded-xl border border-line border-t-2 bg-white p-5 ' + accent.borderTop}>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-700">Workbook readiness</h2>
          <p className="mt-1 max-w-xl text-xs text-text-secondary">
            Nothing here blocks you — the workbook builds at any completeness, fills what it can, and marks the
            rest. Prompts ask for the missing <em>fact</em>, not a document.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <ReadinessMeter sourced={summary.sourced} total={summary.total} pct={pct} />
          <button
            type="button"
            onClick={() => { void handleGenerate(); }}
            disabled={generating}
            className="flex items-center gap-2 rounded-lg bg-ink px-4 py-2.5 font-mono text-xs text-white disabled:opacity-70"
          >
            {generating ? 'Creating…' : ctaLabel}
          </button>
        </div>
      </div>

      <p className="mb-3 font-mono text-[11px] text-text-secondary">
        {summary.sourced} of {summary.total} data points sourced · {summary.needs.length} flagged for follow-up ·{' '}
        {summary.decisionBlanks.length} left for your judgment.
      </p>

      {generated ? (
        <div className="mb-4 rounded-lg border border-line bg-paper px-3 py-2.5">
          <div className="font-mono text-xs text-cleared">
            {artifactLabel} created — stamped provisional
          </div>
          <div className="mt-1 text-xs text-text-secondary">
            {summary.sourced} of {summary.total} data points sourced · {summary.needs.length} flagged for follow-up
            in the output · {summary.decisionBlanks.length} left for your judgment.
          </div>
        </div>
      ) : null}

      {exportError !== null ? (
        <div className="mb-4 rounded-lg border border-red-300 bg-red-50 px-3 py-2.5 text-xs text-red-800">
          Could not create the workbook: {exportError}
        </div>
      ) : null}

      {summary.searchUnavailable ? (
        // ★ Wholesale search failure — the blanks below are UNVERIFIED, NOT
        // confirmed missing. Loud + distinct so a failed search is never mistaken
        // for "these facts aren't in your documents."
        <div className="mb-4 rounded-lg border-l-4 border-warn bg-[#FBECC8] px-3 py-2.5 text-xs text-text-primary">
          <span className="font-semibold">⚠ Document search unavailable.</span> The exhaustive search
          couldn’t run (AI credits/error), so the unsourced fields below are <span className="font-semibold">unverified</span> —
          they have <span className="font-semibold">not</span> been confirmed missing. They may well be in your documents;
          re-open this once the search is available.
        </div>
      ) : null}

      {summary.requiredMissing.length > 0 ? (
        <div className="mb-4 rounded-lg border-l-4 border-warn bg-[#F3E2DB] px-3 py-2.5 text-xs text-warn">
          <span className="font-semibold">{summary.requiredMissing.length} required data point
            {summary.requiredMissing.length === 1 ? '' : 's'} not yet sourced</span> —{' '}
          {summary.requiredMissing.map((f) => f.field).join(', ')}. The workbook still generates; these render as
          honest blanks.
        </div>
      ) : null}

      {(data.assumedInputs?.length ?? 0) > 0 ? (
        <div className="mb-4 rounded-lg border-l-4 border-[#C99A2E] bg-[#FBF3DD] px-3 py-2.5 text-xs text-text-primary">
          <div className="mb-1 font-semibold">Assumed inputs — used by the score, NOT sourced from the documents</div>
          <div className="text-text-secondary">
            {data.assumedInputs!.map((a) => {
              const v = a.assumedValue;
              const disp = v == null ? '—' : v > 0 && v < 1 ? `${(v * 100).toFixed(2)}%` : Math.abs(v) >= 1_000_000 ? `$${(v / 1_000_000).toFixed(1)}M` : v.toLocaleString();
              return (
                <span key={a.path} className="mr-3 inline-block whitespace-nowrap" title={a.note ?? a.reason ?? a.ruleId ?? ''}>
                  <span className="font-mono">{a.label}: {disp}</span>
                  {a.feedsCoverage ? <span className="ml-1 rounded bg-[#F3E2DB] px-1 py-px font-mono text-[9px] text-warn">drives DSCR/coverage</span> : null}
                  {a.note ? <span className="ml-1 rounded bg-paper px-1 py-px font-mono text-[9px] text-text-secondary">display only ⓘ</span> : null}
                </span>
              );
            })}
          </div>
          <div className="mt-1 text-[11px] text-text-secondary">These are market-benchmark / default assumptions (e.g. 640’s rate — the ASR is pre-pricing and states no coupon). Coverage metrics rest on them.</div>
        </div>
      ) : null}

      {summary.needs.length > 0 ? (
        <>
          <div className="mb-2 font-mono text-[11px] text-text-secondary">
            STILL NEEDED — BY FACT, NOT BY DOCUMENT
          </div>
          <div className="flex flex-col gap-2">
            {summary.needs.map((f) => (
              <NeedRow key={f.id} f={f} />
            ))}
          </div>
        </>
      ) : null}

      {summary.decisionBlanks.length > 0 ? (
        <div className="mt-3 border-t border-line pt-3 text-xs text-text-secondary">
          <span className="font-mono text-[11px]">Not missing — your call:</span>{' '}
          {summary.decisionBlanks.map((d) => d.field).join(', ')} — left blank for the underwriter, set in the deal
          room.
        </div>
      ) : null}

      {populated.length > 0 ? (
        <details className="mt-3 border-t border-line pt-3">
          <summary className="cursor-pointer font-mono text-[11px] text-text-secondary">
            {populated.length} data points sourced (collapsed)
          </summary>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {populated.map((f) => (
              <span
                key={f.id}
                title={
                  f.sourcedBy === 'document-search'
                    ? `Found by searching the deal's documents${f.sourceDoc ? ` — ${f.sourceDoc}` : ''}${f.sourceQuote ? `: “${f.sourceQuote}”` : ''}`
                    : undefined
                }
                className="rounded bg-[#E2F0E8] px-1.5 py-px font-mono text-[10px] text-cleared"
              >
                {f.field}
                {f.sourcedBy === 'document-search' ? <span className="ml-1 opacity-60">⌕</span> : null}
              </span>
            ))}
          </div>
          <p className="mt-2 font-mono text-[10px] text-text-secondary">
            <span className="opacity-60">⌕</span> = found by searching every document on the deal (hover for the source + quote).
          </p>
        </details>
      ) : null}

      {(data.summary.notApplicable?.length ?? 0) > 0 ? (
        <div className="mt-3 border-t border-line pt-3 text-xs text-text-secondary">
          <span className="font-mono text-[11px]">Not applicable to this deal:</span>{' '}
          {data.summary.notApplicable!.map((f) => f.field).join(', ')} — searched the documents; this deal doesn’t have it
          (e.g. no government anchor tenant), so it isn’t counted as missing.
        </div>
      ) : null}
    </section>
  );
}
