/**
 * servicer-inputs.service — read/write + display-flow helpers for the fillable
 * servicer human-input fields (Phase 2). DISPLAY-ONLY: additive annotation that
 * flows into the workbook + memo but NEVER re-scores (mint untouched).
 */

import {
  servicerInputsStore,
  type ServicerInput,
  type ServicerInputFieldType,
} from '../storage/servicer-inputs-store.js';
import { resolveLoanForRoot } from './pool/resolve-loan-for-root.js';

/** All human inputs for a loan (any field). */
export function getServicerInputs(poolId: string, loanInPoolId: string): ServicerInput[] {
  return servicerInputsStore().listForLoan(poolId, loanInPoolId);
}

/** One field for a loan, or null. */
export function getServicerInput(
  poolId: string,
  loanInPoolId: string,
  fieldType: ServicerInputFieldType,
): ServicerInput | null {
  return servicerInputsStore().getOne(poolId, loanInPoolId, fieldType);
}

/** Upsert one field (author + timestamp stamped server-side). */
export function upsertServicerInput(args: {
  poolId: string;
  loanInPoolId: string;
  fieldType: ServicerInputFieldType;
  value: string;
  author: string;
}): ServicerInput {
  return servicerInputsStore().upsert({ ...args, now: new Date().toISOString() });
}

/**
 * Resolve the (poolId, loanInPoolId) for a graph root/revision — the analysis→loan
 * join the memo + workbook exports use to fetch servicer inputs. Best-effort: null
 * when the analysis isn't pooled or resolution is ambiguous (→ no annotation, the
 * export stays byte-identical).
 */
export function resolveLoanForAnalysis(graphRevisionId: string | null | undefined): { poolId: string; loanInPoolId: string } | null {
  if (!graphRevisionId) return null;
  const r = resolveLoanForRoot(graphRevisionId);
  return r.resolved ? { poolId: r.poolId, loanInPoolId: r.loanInPoolId } : null;
}

/** The servicer site-visit note for an analysis (via the loan join), or null. */
export function getSiteVisitForAnalysis(graphRevisionId: string | null | undefined): ServicerInput | null {
  const loan = resolveLoanForAnalysis(graphRevisionId);
  if (loan === null) return null;
  return getServicerInput(loan.poolId, loan.loanInPoolId, 'site_visit');
}

/* -------------------------------------------------------------------------- */
/* Workbook flow — the Site Inspection cell.                                   */
/* -------------------------------------------------------------------------- */

/** The Site Inspection worksheet cell the site-visit note flows into. The tab is
 *  otherwise near-blank (only numberOfBuildings at C6); B10 is an empty note area.
 *  The 'hitl' scaffold anticipates analyst input here — a filled note lands in it. */
export const SITE_VISIT_WORKBOOK_ADDRESS = 'Site Inspection!B10';

/**
 * Produce the additive workbook cell for a site-visit note. Returns null when the
 * note is empty/absent → NO injection (the tab stays in its existing blank state,
 * so the export is byte-identical). When present → the note lands in the Site
 * Inspection cell, attributed to the servicer.
 */
export function siteVisitWorkbookCell(note: ServicerInput | null): { address: string; value: string } | null {
  const text = note?.value?.trim();
  if (!text) return null;
  return { address: SITE_VISIT_WORKBOOK_ADDRESS, value: `Servicer site visit: ${text}` };
}

/* -------------------------------------------------------------------------- */
/* Memo flow — the due-diligence red-flags block.                              */
/* -------------------------------------------------------------------------- */

export interface ServicerSiteVisitMemo {
  readonly text: string;
  readonly author: string;
  readonly at: string;
}

/** Project the site-visit note into the memo input shape, or undefined when empty. */
export function siteVisitMemoInput(note: ServicerInput | null): ServicerSiteVisitMemo | undefined {
  const text = note?.value?.trim();
  if (!text || !note) return undefined;
  return { text, author: note.author, at: note.updatedAt };
}
