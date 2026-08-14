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
/* Narrative-field config — one entry per fillable narrative field. Each maps  */
/* to its own workbook 'hitl' cell + memo label. Adding a field is one entry.  */
/* -------------------------------------------------------------------------- */

export interface ServicerNarrativeFieldConfig {
  readonly fieldType: ServicerInputFieldType;
  /** Attribution label shown in the memo + prefixed into the workbook cell. */
  readonly label: string;
  /** The workbook cell this field's note flows into — a distinct 'hitl' cell per
   *  field. Site visit → Site Inspection tab; broker feedback → Market tab (each
   *  otherwise near-blank; the scaffold anticipates analyst input at these cells). */
  readonly workbookAddress: string;
}

export const SERVICER_NARRATIVE_FIELDS: readonly ServicerNarrativeFieldConfig[] = [
  { fieldType: 'site_visit',      label: 'Servicer site visit',      workbookAddress: 'Site Inspection!B10' },
  { fieldType: 'broker_feedback', label: 'Servicer broker feedback', workbookAddress: 'Market!B10' },
  // tab_commentary is deferred (needs Isabelle's tab list) — no cell yet.
];

function configFor(fieldType: ServicerInputFieldType): ServicerNarrativeFieldConfig | undefined {
  return SERVICER_NARRATIVE_FIELDS.find((f) => f.fieldType === fieldType);
}

/* -------------------------------------------------------------------------- */
/* Workbook flow — one 'hitl' cell per present narrative field.                */
/* -------------------------------------------------------------------------- */

/**
 * The additive workbook cells for ALL present servicer narrative notes on this
 * analysis. A present note lands in its field's 'hitl' cell (attributed); an
 * empty/absent note is OMITTED → NO injection (byte-identical). One resolve of the
 * analysis→loan join; a read per configured field.
 */
export function servicerInputWorkbookCells(graphRevisionId: string | null | undefined): Array<{ address: string; value: string }> {
  const loan = resolveLoanForAnalysis(graphRevisionId);
  if (loan === null) return [];
  const cells: Array<{ address: string; value: string }> = [];
  for (const cfg of SERVICER_NARRATIVE_FIELDS) {
    const note = getServicerInput(loan.poolId, loan.loanInPoolId, cfg.fieldType);
    const text = note?.value?.trim();
    if (text) cells.push({ address: cfg.workbookAddress, value: `${cfg.label}: ${text}` });
  }
  return cells;
}

/* -------------------------------------------------------------------------- */
/* Memo flow — the due-diligence red-flags blocks (one per present field).     */
/* -------------------------------------------------------------------------- */

export interface ServicerMemoNote {
  readonly label: string;
  readonly text: string;
  readonly author: string;
  readonly at: string;
}

/**
 * All present servicer narrative notes projected into the memo shape (label +
 * text + who/when), in config order. Empty when none — the memo adds nothing.
 */
export function servicerNotesForAnalysis(graphRevisionId: string | null | undefined): ServicerMemoNote[] {
  const loan = resolveLoanForAnalysis(graphRevisionId);
  if (loan === null) return [];
  const notes: ServicerMemoNote[] = [];
  for (const cfg of SERVICER_NARRATIVE_FIELDS) {
    const note = getServicerInput(loan.poolId, loan.loanInPoolId, cfg.fieldType);
    const text = note?.value?.trim();
    if (text && note) notes.push({ label: cfg.label, text, author: note.author, at: note.updatedAt });
  }
  return notes;
}

/* --- thin per-field helpers (site-visit compatibility; unit-testable) ------ */

export const SITE_VISIT_WORKBOOK_ADDRESS = configFor('site_visit')!.workbookAddress;

/** One field's workbook cell (present → cell; empty → null). */
export function servicerInputWorkbookCell(note: ServicerInput | null, fieldType: ServicerInputFieldType): { address: string; value: string } | null {
  const cfg = configFor(fieldType);
  const text = note?.value?.trim();
  if (!cfg || !text) return null;
  return { address: cfg.workbookAddress, value: `${cfg.label}: ${text}` };
}
export function siteVisitWorkbookCell(note: ServicerInput | null): { address: string; value: string } | null {
  return servicerInputWorkbookCell(note, 'site_visit');
}

export interface ServicerSiteVisitMemo { readonly text: string; readonly author: string; readonly at: string; }
/** Project one note into the memo input shape, or undefined when empty. */
export function siteVisitMemoInput(note: ServicerInput | null): ServicerSiteVisitMemo | undefined {
  const text = note?.value?.trim();
  if (!text || !note) return undefined;
  return { text, author: note.author, at: note.updatedAt };
}
