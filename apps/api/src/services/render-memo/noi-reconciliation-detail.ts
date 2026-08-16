/**
 * buildNoiReconciliationDetail — assemble the sourced side-by-side "receipts" for the
 * NOI-reconciliation red flag, AT RENDER TIME, from values already on the ExtractionResult
 * + the concluded NOI. DISPLAY-ONLY / mint-safe: nothing here is minted onto the finding
 * or the content-hashed graph; it is read and formatted at memo/deal-room render.
 *
 * Only figures that are actually PRESENT become rows (no null rows — honest). Source is the
 * DOCUMENT the figure came from; NO page number (that provenance is not captured — see the
 * v2 note; fabricating a page would break grounding).
 */
import type { ExtractionResult } from '@cre/contracts';
import type { NoiReconciliationDetail, NoiReconciliationRow } from '@cre/contracts';

function fmtUsd(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

/** The NOI figures the reconciliation flags compare, in display order. */
interface Candidate {
  readonly label: string;
  readonly value: number | null | undefined;
  readonly sourceDocument: string;
}

export function buildNoiReconciliationDetail(
  extraction: ExtractionResult,
  concludedNoi: number | null | undefined,
): NoiReconciliationDetail {
  const t12 = extraction.t12Actual?.noi ?? null;
  const asr = extraction.asr?.underwrittenNOI ?? null;
  const seller = extraction.sellerUw?.underwrittenNOI ?? null;

  const candidates: Candidate[] = [
    { label: 'Concluded NOI (as underwritten)', value: concludedNoi, sourceDocument: 'Engine — concluded underwriting' },
    { label: 'Trailing-12 actual NOI', value: t12, sourceDocument: 'Operating statement (T-12)' },
    { label: 'ASR-disclosed underwritten NOI', value: asr, sourceDocument: 'Asset Summary Report (ASR)' },
    { label: 'Seller underwritten NOI', value: seller, sourceDocument: 'Seller underwriting' },
  ];

  const rows: NoiReconciliationRow[] = candidates
    .filter((c): c is Candidate & { value: number } => typeof c.value === 'number' && Number.isFinite(c.value))
    .map((c) => ({ label: c.label, valueFormatted: fmtUsd(c.value), sourceDocument: c.sourceDocument }));

  return { rows, variance: buildVariance(concludedNoi ?? null, t12, asr) };
}

/** Deterministic variance summary vs concluded NOI — only for present comparisons. */
function buildVariance(concluded: number | null, t12: number | null, asr: number | null): string | null {
  if (concluded === null || !Number.isFinite(concluded) || concluded === 0) return null;
  const parts: string[] = [];
  if (t12 !== null && Number.isFinite(t12) && t12 !== 0) {
    const pct = ((concluded - t12) / Math.abs(t12)) * 100;
    const dir = pct >= 0 ? 'above' : 'below';
    parts.push(`${Math.abs(pct).toFixed(1)}% ${dir} the T-12 actual`);
  }
  if (asr !== null && Number.isFinite(asr) && asr !== 0) {
    const ratio = concluded >= asr ? concluded / asr : asr / concluded;
    const dir = concluded >= asr ? 'above' : 'below';
    parts.push(`${ratio.toFixed(1)}× ${dir} the ASR-disclosed NOI`);
  }
  if (parts.length === 0) return null;
  return `Concluded NOI is ${parts.join('; ')}.`;
}
