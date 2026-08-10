/**
 * rescan-held-on-loan-arrival — Chunk 2 of the continuous-tape engine: the
 * orphan-backlog auto-attach.
 *
 * A doc that arrives before its loan is durably parked in HELD (loan axis refused
 * because the loan wasn't a pool member yet). When a NEW loan later appears (tape
 * advance/freeze → loan_in_pool insert), this re-scans the HELD backlog against the
 * NOW-CURRENT loan set: any held doc that now CONFIDENTLY matches a loan is
 * auto-attached (held → routed) via the SAME `identifyHeldDoc` move, then the loan
 * is run through Chunk 3's `reevaluateAndEnqueueIfReady` — so a doc that arrived
 * early attaches AND triggers its own underwrite the moment its loan shows up.
 *
 * DISCIPLINE (reused, not reinvented):
 *   - Loan match = the EXACT classifier the drop path uses: `classifyLoanFromFilename`
 *     (exact-normalized, refuse-unless-exactly-one) → `classifyLoanFromContent` (fuzzy
 *     ≥ auto-route threshold, portfolio-guard). A non-null return IS the confidence
 *     bar — ambiguous/low-confidence → null → the doc STAYS held (never force-guessed).
 *   - A held doc with no resolved docType hint (hintDocType null) can't be routed
 *     (identify needs both axes) → stays held.
 *   - Attach via `identifyHeldDoc` (persist-then-delete) so the ROUTED|HELD state
 *     machine stays consistent.
 *   - Underwrite via Chunk 3's dedup-safe primitive → an attach that completes a loan
 *     underwrites it; a loan still partial stays partial (Chunk 1 holds).
 */

import type { PoolId, LoanInPoolId } from '@cre/contracts';
import { PoolStore } from '../../storage/pool-store.js';
import type { UnderwriteJobStore } from '../../storage/underwrite-job-store.js';
import {
  listHeldDocs as defaultListHeldDocs,
  identifyHeldDoc as defaultIdentifyHeldDoc,
  type HeldDoc,
} from '../data-room-store.service.js';
import {
  classifyLoanFromFilename,
  classifyLoanFromContent,
  type PoolLoanNameKey,
} from '../data-room-classify.service.js';
import { blobStore as defaultBlobStore } from '../../storage/blob-store.js';
import { extractFrontMatterText } from '../data-room/page1-text.service.js';
import { reevaluateAndEnqueueIfReady as defaultReeval, type ReevalDeps } from './batch-settle-fanout.service.js';
import type { ContentHash } from '@cre/contracts';

export interface RescanHeldDeps extends ReevalDeps {
  readonly listHeldDocs?: typeof defaultListHeldDocs;
  readonly listLoanNameKeys?: (poolId: string) => ReadonlyArray<PoolLoanNameKey>;
  readonly identifyHeldDoc?: typeof defaultIdentifyHeldDoc;
  readonly reevaluateAndEnqueueIfReady?: typeof defaultReeval;
  /** Fetch a held doc's front-matter text for the CONTENT tier (cryptic filenames).
   *  Best-effort — a miss/throw skips the content tier for that doc. */
  readonly getHeldText?: (poolId: string, fileHash: string) => Promise<string>;
}

export interface RescanHeldResult {
  /** Held docs auto-attached to a now-present loan (held → routed). */
  readonly attached: ReadonlyArray<{ fileHash: string; loanInPoolId: string; docType: string; via: 'filename' | 'content' }>;
  /** How many held docs remain held (ambiguous / no docType / no match). */
  readonly stillHeld: number;
  /** Loans the attach just triggered an underwrite for (crossed into ready). */
  readonly enqueued: ReadonlyArray<{ loanInPoolId: string; jobId: string }>;
}

async function defaultGetHeldText(poolId: string, fileHash: string): Promise<string> {
  const bytes = await defaultBlobStore.getBlob(fileHash as ContentHash);
  if (bytes === null) return '';
  try {
    return await extractFrontMatterText(bytes);
  } catch {
    return '';
  }
}

/**
 * Re-scan the pool's HELD backlog against the current loan set and auto-attach the
 * newly-confident matches, then underwrite any loan an attach completed.
 */
export async function rescanHeldOnLoanArrival(
  poolId: string,
  deps: RescanHeldDeps = {},
): Promise<RescanHeldResult> {
  const listHeldDocs = deps.listHeldDocs ?? defaultListHeldDocs;
  const identifyHeldDoc = deps.identifyHeldDoc ?? defaultIdentifyHeldDoc;
  const reevaluateAndEnqueueIfReady = deps.reevaluateAndEnqueueIfReady ?? defaultReeval;
  const getHeldText = deps.getHeldText ?? defaultGetHeldText;
  const listLoanNameKeys =
    deps.listLoanNameKeys ?? ((p: string) => (deps.poolStore ?? new PoolStore()).listLoanNameKeysForPool(p as PoolId));

  const held: ReadonlyArray<HeldDoc> = listHeldDocs(poolId);
  const loans = listLoanNameKeys(poolId);

  const attached: Array<{ fileHash: string; loanInPoolId: string; docType: string; via: 'filename' | 'content' }> = [];
  const touchedLoans = new Set<string>();

  for (const h of held) {
    // Need a resolved docType to route (identify requires both axes). No docType
    // hint → can't auto-attach → stays held.
    if (h.hintDocType === null) continue;

    // Loan match — filename first (cheap), then content (cryptic vendor filenames).
    // A non-null return is the classifier's own confidence verdict.
    let loanMatch = classifyLoanFromFilename(h.fileName, loans);
    let via: 'filename' | 'content' = 'filename';
    if (loanMatch === null) {
      const text = await getHeldText(poolId, h.fileHash);
      if (text.trim().length > 0) {
        loanMatch = classifyLoanFromContent(text, loans);
        via = 'content';
      }
    }
    if (loanMatch === null) continue; // ambiguous / no confident match → stays held

    const res = await identifyHeldDoc({ poolId, fileHash: h.fileHash, loanInPoolId: loanMatch, docType: h.hintDocType });
    if (res.status === 'error') continue; // couldn't route (e.g. taxonomy hiccup) → stays held

    attached.push({ fileHash: h.fileHash, loanInPoolId: loanMatch, docType: h.hintDocType, via });
    touchedLoans.add(loanMatch);
  }

  // Chunk 3 — underwrite any loan an attach just completed (dedup-safe; partial stays partial).
  const enqueued: Array<{ loanInPoolId: string; jobId: string }> = [];
  for (const loanInPoolId of touchedLoans) {
    const r = reevaluateAndEnqueueIfReady(poolId, loanInPoolId as LoanInPoolId, deps);
    if (r.enqueued && r.jobId !== null) enqueued.push({ loanInPoolId, jobId: r.jobId });
  }

  return { attached, stillHeld: held.length - attached.length, enqueued };
}
