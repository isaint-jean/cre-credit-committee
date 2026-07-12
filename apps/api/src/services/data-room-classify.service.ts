/**
 * Data-Room classify-on-stage (Data-Room Phase 2a/2b).
 *
 * COMPOSITION of existing primitives — no new ML, no byte/header reading. Runs
 * TWO independent, deterministic-or-refuse classifiers over a staged file's NAME
 * and combines them via a pure truth-table into an auto/confirm verdict.
 *
 *   DOC-TYPE axis — `inferSlotFromFilename` (lifted to @cre/shared, filename
 *     regex only; exactly-1-hit → SourceDocSlot, 0 or ≥2 hits → null). It can
 *     ONLY emit the 7 slotted tier-(a/b) taxonomy ids, so tier-(c) room-only
 *     doc-types (legal/title/insurance/…) are structurally un-inferable → the
 *     doc-type axis is NEVER "confident" for them → they can NEVER auto-file.
 *
 *   LOAN axis — the SAME normalize bridge `resolveLoanForRoot`'s Hop-2 PASS-2
 *     uses (parse-bmark-tape-xlsx normalizers), retargeted from a graph-root name
 *     to the dropped FILENAME: run the filename through `normalizeForMatch` (to
 *     peel extension + slot hints + prefixes into a bare property core) then
 *     `normalizePropertyName` so it lands in the SAME keyspace the pool side is
 *     normalized into, and compare against each pool loan's normalized
 *     originatorLoanRef / propertyName. Exactly-1 distinct loanInPoolId →
 *     confident; 0 or ≥2 → refuse (null). No third normalizer, no new fuzzy risk.
 *
 * THE PERMANENT SAFETY BAR: auto-route ONLY when BOTH axes are exactly-1-
 * confident. Single-axis-confident NEVER auto-routes — it goes to the confirm
 * tray pre-filled with whatever WAS confident. See `verdictFor`.
 *
 * Pure over its inputs (poolLoans is passed in) — no DB, no I/O here.
 */

import {
  inferSlotFromFilename,
  normalizeForMatch,
  classifyDocTypeFromContent,
  matchFileToDeal,
  type UWRecordLike,
} from '@cre/shared';
import {
  CATEGORIES_IN_ORDER,
  DOC_TYPE_CATEGORY,
  type DocTypeCategory,
} from '@cre/contracts';
import {
  normalizePropertyName,
} from './parse-bmark-tape-xlsx.js';
import { extractFrontMatterText } from './data-room/page1-text.service.js';
import { classifyByLlm, type LlmRouteCall } from './data-room/llm-smart-route.service.js';

/** The minimal loan-name shape the loan axis matches against. Mirrors
 *  PoolStore.listLoanNameKeys() rows (already pool-scoped by the caller). */
export interface PoolLoanNameKey {
  readonly loanInPoolId: string;
  readonly originatorLoanRef: string | null;
  readonly propertyName: string | null;
}

/** Two independent classifier hints for one staged file. Either axis may be
 *  null (= not confident / refused). */
export interface ClassifyHints {
  /** A DOC_TYPE_TAXONOMY id (equal to the SourceDocSlot for the 7 slotted
   *  types), or null when the doc-type axis refused (0 or ≥2 pattern hits, or a
   *  tier-(c) room-only doc which has no pattern at all). */
  readonly docType: string | null;
  /** The single pool loan the filename resolved to, or null when the loan axis
   *  refused (0 or ≥2 matches). */
  readonly loanInPoolId: string | null;
}

/**
 * Retargeted loan axis: normalize the FILENAME through the SAME bridge
 * `resolveLoanForRoot` Hop-2 PASS-2 uses, compare to each pool loan's normalized
 * originatorLoanRef / propertyName, reduce to DISTINCT loanInPoolId, and refuse
 * unless exactly one distinct loan matches.
 */
export function classifyLoanFromFilename(
  fileName: string,
  poolLoans: ReadonlyArray<PoolLoanNameKey>,
): string | null {
  // Filename → bare property core (strips extension + slot hints + NNN- prefix +
  // manual-status suffixes) → the pool keyspace normalizer. Two-step so the
  // filename gets the stripping it needs while the pool-side comparison stays
  // byte-identical to resolveLoanForRoot's (both sides through normalizePropertyName).
  const core = normalizeForMatch(fileName);
  const targetKey = normalizePropertyName(core);
  if (targetKey === null) return null; // name-less filename → refuse.

  const distinct = new Set<string>();
  for (const loan of poolLoans) {
    const originatorKey = normalizePropertyName(loan.originatorLoanRef);
    const propertyKey = normalizePropertyName(loan.propertyName);
    if (originatorKey === targetKey || propertyKey === targetKey) {
      distinct.add(loan.loanInPoolId);
    }
  }

  // Refuse-when-≠1: exactly one distinct loan, else null.
  if (distinct.size === 1) return [...distinct][0]!;
  return null;
}

/**
 * LOAN axis, CONTENT tier (Data-Room content-routing SLICE 1).
 *
 * The property name is on every appraisal / PCA / ASR cover page ("Sunroad
 * Centrum"), so when a file's NAME refuses (cryptic vendor filename like
 * "23-414408.1 …" or a bare "Appraisal_…"), we point the SAME conservative
 * fuzzy matcher (`matchFileToDeal`, lifted to @cre/shared) at the page-1 text.
 *
 * The matcher is name-oriented, so we adapt each pool loan into the UWRecordLike
 * shape it reads: propertyName → dealName, originatorLoanRef → fileName. It
 * normalizes both sides through the SAME `normalizeForMatch` bridge and scores
 * exact / substring / token-overlap, with the PORTFOLIO GUARD (2+ strong matches
 * → refuse) as the load-bearing piece. We accept ONLY the matcher's
 * `auto_attach` bucket — its single-unambiguous verdict — mapping every other
 * bucket (needs_pick / unmatched) to null. Same deterministic-or-refuse
 * discipline as the filename/folder loan tiers; NO-LLM, pure text scoring.
 *
 * `pageText` is a full page-1 blob (prose), not a bare name, so a raw
 * exact-normalize would never hit; the matcher's substring + token-overlap paths
 * are what let "…Sunroad Centrum, San Diego, CA…" resolve to the Sunroad loan.
 */
export function classifyLoanFromContent(
  pageText: string,
  poolLoans: ReadonlyArray<PoolLoanNameKey>,
): string | null {
  if (pageText.trim().length === 0) return null;

  // Adapt pool loan-name keys into the matcher's UWRecordLike shape. The
  // matcher's FUZZY paths (substring / token-overlap) score against `dealName`
  // only, using `fileName` for the exact-normalized check — so a prose page-1
  // blob (never an exact hit) needs the loan's actual name in `dealName`. Some
  // pool rows carry the name in propertyName, others (like Sunroad) in
  // originatorLoanRef; feed the FIRST non-empty name as `dealName` so the fuzzy
  // paths engage regardless of which column holds it, and keep the other in
  // `fileName` for the exact path.
  const records: UWRecordLike[] = poolLoans.map((loan) => {
    const property = loan.propertyName ?? '';
    const ref = loan.originatorLoanRef ?? '';
    const primary = property.trim().length > 0 ? property : ref;
    const secondary = primary === property ? ref : property;
    return { id: loan.loanInPoolId, dealName: primary, fileName: secondary };
  });

  const result = matchFileToDeal(pageText, records);

  // A property name inside a page-1 PROSE blob scores as a SUBSTRING hit (0.85),
  // not an exact-normalized hit — so the matcher buckets a single clean content
  // match as `needs_pick`, not `auto_attach` (which is exact-only). For the
  // CONTENT tier we therefore read the CANDIDATES directly and apply the SAME
  // portfolio guard: accept iff EXACTLY ONE distinct loan clears the strong
  // threshold (score ≥ 0.7) and NO OTHER loan is also strong. 2+ strong → refuse
  // (ambiguous). This keeps the exact deterministic-or-refuse discipline; it just
  // reads the strong-match set instead of the exact-only auto bucket.
  const STRONG = 0.7;
  const strong = result.candidates.filter((c) => c.score >= STRONG);
  const distinctStrong = new Set(strong.map((c) => c.uwRecord.id));
  if (distinctStrong.size === 1) return [...distinctStrong][0]!;
  return null;
}

/**
 * Run BOTH axes over one staged filename against the target pool's loans.
 * `poolLoans` MUST already be scoped to the target pool by the caller.
 */
export function classifyStagedFile(
  fileName: string,
  poolLoans: ReadonlyArray<PoolLoanNameKey>,
): ClassifyHints {
  // Doc-type axis: inferSlotFromFilename returns a SourceDocSlot which, for the
  // 7 slotted types, IS the taxonomy id 1:1 (cf is a single composite id). Cast
  // to the taxonomy-id string the store expects.
  const slot = inferSlotFromFilename(fileName);
  return {
    docType: slot === null ? null : (slot as string),
    loanInPoolId: classifyLoanFromFilename(fileName, poolLoans),
  };
}

// ---------------------------------------------------------------------------
// 2b — verdictFor (pure truth-table)
// ---------------------------------------------------------------------------

export interface Verdict {
  readonly action: 'auto' | 'confirm';
  /** Whatever WAS confident, so a confirm-needed file opens pre-filled on the
   *  confident axis. For `auto`, both are present. */
  readonly prefill: {
    readonly docType?: string;
    readonly loanInPoolId?: string;
  };
}

/**
 * THE truth table (the crux). Auto-route ONLY when BOTH axes are non-null.
 * Every other cell → confirm, pre-filled with whatever's non-null. Pure.
 *
 * | docType | loan    | action  | prefill            |
 * |---------|---------|---------|--------------------|
 * | set     | set     | auto    | {docType, loan}    |
 * | set     | null    | confirm | {docType}          |
 * | null    | set     | confirm | {loan}             |
 * | null    | null    | confirm | {}                 |
 *
 * Tier-(c) docs can never have a non-null docType (no pattern) → they land at
 * best in row 3 (confirm, loan pre-filled) and NEVER auto-file. Structural.
 */
export function verdictFor(
  docType: string | null,
  loanInPoolId: string | null,
): Verdict {
  const prefill: { docType?: string; loanInPoolId?: string } = {};
  if (docType !== null) prefill.docType = docType;
  if (loanInPoolId !== null) prefill.loanInPoolId = loanInPoolId;

  const action: Verdict['action'] =
    docType !== null && loanInPoolId !== null ? 'auto' : 'confirm';

  return { action, prefill };
}

// ---------------------------------------------------------------------------
// Piece B Phase 2 — classifyEntryFromPath (pure PATH parse)
// ---------------------------------------------------------------------------

/**
 * Bank subfolder-label → canonical DocTypeCategory synonym map. The ONLY new
 * data in this phase. Keys are lowercased folder labels a bank might use;
 * values are one of the 5 CATEGORIES_IN_ORDER names. A folder that maps to NO
 * entry here → no category hint (undefined) → NO cross-check, NOT a
 * contradiction. Keep small and conservative — an unrecognized folder must
 * never manufacture a false conflict.
 */
const SUBFOLDER_CATEGORY_SYNONYMS: Readonly<Record<string, DocTypeCategory>> = {
  // Third-Party Reports
  appraisal: 'Third-Party Reports',
  appraisals: 'Third-Party Reports',
  'third party': 'Third-Party Reports',
  'third-party': 'Third-Party Reports',
  'third party reports': 'Third-Party Reports',
  'third-party reports': 'Third-Party Reports',
  reports: 'Third-Party Reports',
  pca: 'Third-Party Reports',
  environmental: 'Third-Party Reports',
  // Legal
  legal: 'Legal',
  'loan docs': 'Legal',
  'loan documents': 'Legal',
  title: 'Legal',
  closing: 'Legal',
  insurance: 'Legal',
  leases: 'Legal',
  // Excels
  financials: 'Excels',
  financial: 'Excels',
  models: 'Excels',
  model: 'Excels',
  excels: 'Excels',
  excel: 'Excels',
  // ASRs
  asr: 'ASRs',
  asrs: 'ASRs',
  // General
  general: 'General',
  other: 'General',
  misc: 'General',
};

/** Map a raw bank subfolder label → canonical category, or undefined when the
 *  folder isn't recognized (→ no category hint, NOT a contradiction). */
function categoryFromSubfolder(folder: string): DocTypeCategory | undefined {
  const key = folder.trim().toLowerCase();
  const hit = SUBFOLDER_CATEGORY_SYNONYMS[key];
  // Defensive: only ever emit a canonical category name.
  return hit !== undefined && CATEGORIES_IN_ORDER.includes(hit) ? hit : undefined;
}

/** The result of a pure path classify — ClassifyHints plus a browse-category
 *  hint and a cross-check contradiction flag for Phase 3's tray routing. */
export interface PathClassifyHints extends ClassifyHints {
  /** The human browse-category this entry most likely belongs to, from the
   *  subfolder label (shape 1) or derived from docType (shape 2). Undefined
   *  when there's no folder hint AND no docType to derive from. */
  readonly categoryHint?: DocTypeCategory;
  /** True only when a shape-1 subfolder category hint EXISTS and CONTRADICTS
   *  DOC_TYPE_CATEGORY[docType]. A tray signal — Phase 3 must NOT auto-file on
   *  a contradiction. The docType/loanInPoolId hints are still the best guesses. */
  readonly contradiction?: boolean;
  /** Tier-3.5 provenance — "routed by AI — {reason}" — present ONLY when the LLM
   *  tier actually FILLED an axis. Display-only / score-neutral: the caller writes
   *  it into `data_room_doc.notes` so a human sees + can override an AI-routed doc.
   *  Undefined for every deterministically-routed or HELD file. */
  readonly aiRouteNote?: string;
}

/**
 * PURE path-parse classifier. Takes an entry's internal path within a bank zip
 * (or a loose drop) and the pool's loan-name keys, and returns the best
 * ClassifyHints + a browse category + a cross-check contradiction signal.
 *
 * ★ PURE — no I/O, no store, no DB. `loanNameKeys` is a PARAMETER (Phase 3's
 *   caller supplies the pool's keys); this fn fetches nothing. It REUSES the
 *   exact loan-match bridge (`classifyLoanFromFilename`, refuse-when-≠1) and
 *   docType-infer (`inferSlotFromFilename`) of the filename classifier above —
 *   no new classifier logic. Category is a CROSS-CHECK, never a routing key.
 *
 * The 3 path shapes (split on '/', ignoring a leading `*.zip/` root):
 *   - Loan/Category/file (3+ segments): folder[0] → loan; file → docType;
 *     folder[-2] → category hint (synonym map) → CROSS-CHECK vs
 *     DOC_TYPE_CATEGORY[docType] → contradiction flag.
 *   - Loan/file (2 segments): folder[0] → loan; file → docType; category
 *     DERIVED from docType (no subfolder → no cross-check).
 *   - file (1 segment): loose drop — docType from filename only; loan UNKNOWN
 *     (→ tray in Phase 3). Same as a loose bare-file drop.
 */
export function classifyEntryFromPath(
  internalPath: string,
  loanNameKeys: ReadonlyArray<PoolLoanNameKey>,
): PathClassifyHints {
  // Split on '/', drop empties (leading/trailing/double slashes), and strip a
  // leading `*.zip/` archive-root segment if present (the bank's own zip name
  // is not a path shape segment).
  let segments = internalPath.split('/').filter((s) => s.length > 0);
  if (segments.length > 1 && /\.zip$/i.test(segments[0]!)) {
    segments = segments.slice(1);
  }

  // Degenerate: nothing usable → all hints null/undefined.
  if (segments.length === 0) {
    return { docType: null, loanInPoolId: null };
  }

  const file = segments[segments.length - 1]!;
  const docType = inferSlotFromFilename(file); // null when un-inferable (tier-c)

  // Shape 3 — bare file (1 segment): loose drop. docType only, loan UNKNOWN.
  if (segments.length === 1) {
    return {
      docType: docType === null ? null : (docType as string),
      loanInPoolId: null,
      // Category derived from docType if we could infer one; else no hint.
      ...(docType !== null ? { categoryHint: DOC_TYPE_CATEGORY[docType as string] } : {}),
    };
  }

  // Shapes 1 & 2 both start with a loan folder.
  const loanFolder = segments[0]!;
  const loanInPoolId = classifyLoanFromFilename(loanFolder, loanNameKeys); // refuse-when-≠1

  // Shape 2 — Loan/file (2 segments): no subfolder → category DERIVED from
  // docType, no cross-check possible.
  if (segments.length === 2) {
    return {
      docType: docType === null ? null : (docType as string),
      loanInPoolId,
      ...(docType !== null ? { categoryHint: DOC_TYPE_CATEGORY[docType as string] } : {}),
    };
  }

  // Shape 1 — Loan/Category/file (3+ segments): the middle folder just before
  // the file is the category subfolder. Cross-check it against the docType's
  // canonical category.
  const subfolder = segments[segments.length - 2]!;
  const folderCategory = categoryFromSubfolder(subfolder); // undefined = unrecognized

  // Best category hint: prefer the recognized subfolder label; else derive from
  // docType; else undefined.
  const derivedCategory =
    docType !== null ? DOC_TYPE_CATEGORY[docType as string] : undefined;
  const categoryHint = folderCategory ?? derivedCategory;

  // CROSS-CHECK — contradiction ONLY when BOTH a recognized folder category AND
  // a derived docType category exist and they DISAGREE. Unrecognized folder
  // (undefined) or un-inferable docType (null) → no cross-check, no false flag.
  const contradiction =
    folderCategory !== undefined &&
    derivedCategory !== undefined &&
    folderCategory !== derivedCategory;

  return {
    docType: docType === null ? null : (docType as string),
    loanInPoolId,
    ...(categoryHint !== undefined ? { categoryHint } : {}),
    ...(contradiction ? { contradiction: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// Data-Room content-routing SLICE 1 — the UNIFIED cascade (loose + zip, one path)
// ---------------------------------------------------------------------------

/** One file to classify. `internalPath` present ⇒ a zip entry (folder tier is
 *  live); absent ⇒ a loose drop (folder tier skipped). `bytes` feeds the tier-3
 *  content scan, parsed at most ONCE and ONLY when a tier-3 fallback is needed. */
export interface ClassifyFileInput {
  /** Zip entry's internal path (e.g. `Sunroad Centrum/Reports/appraisal.pdf`),
   *  or undefined for a loose file drop. */
  readonly internalPath?: string;
  /** Leaf display name — the filename tier's input for BOTH loose and zip. */
  readonly fileName: string;
  /** Raw bytes for the tier-3 content scan. */
  readonly bytes: Buffer;
}

/**
 * THE unified per-axis cascade — ONE path for loose drops AND zip entries.
 * The zip is only a delivery mechanism: the folder is just the top tier, present
 * for a zip entry (via `internalPath`) and absent for a loose file. Both axes
 * resolve first-confident-wins:
 *
 *   LOAN:     folder(zip top folder) → filename → content
 *   DOC-TYPE: filename → content            (folder gives category, not doc-type)
 *
 * Content is the tier-3 fallback: the front-matter window (first-N-pages, a
 * superset of page-1) is parsed AT MOST ONCE, and ONLY when at least one axis is
 * still unresolved after folder + filename — so a file whose name already
 * resolves both axes never gets scanned (cheap). categoryHint and contradiction
 * from the folder tier are preserved unchanged; the returned shape is the SAME
 * `PathClassifyHints` (⊇ `ClassifyHints`), so `verdictFor` / assign / underwrite
 * downstream are UNCHANGED.
 *
 * Tiers 1-3 are NO-LLM: deterministic regex / string-scoring; `extractFrontMatterText`
 * uses the unpdf/xlsx parsers only, so they run with credits depleted. Tier 3.5
 * (LLM smart-route) is the ONLY LLM tier — it fires ONLY when an axis is STILL
 * null after tiers 1-3 (the same hard-doc guard tier-3 uses) AND credits are
 * available; on no-credits / error / malformed output it is a NO-OP and the doc
 * HELDs exactly as today (fail-safe). It writes into the SAME loanInPoolId/docType
 * locals → same `PathClassifyHints` out → verdictFor/assign/underwrite untouched.
 */
export async function classifyFileCascade(
  input: ClassifyFileInput,
  poolLoans: ReadonlyArray<PoolLoanNameKey>,
  deps?: { readonly llmCall?: LlmRouteCall },
): Promise<PathClassifyHints> {
  const { internalPath, fileName, bytes } = input;

  // ── Tier 1 (folder) — ONLY for zip entries. Reuse the pure path classifier;
  //    it yields folder→loan, filename→docType, and the category/contradiction
  //    cross-check. For a loose file there is no folder tier. ──────────────────
  const folderHints: PathClassifyHints | null =
    internalPath !== undefined ? classifyEntryFromPath(internalPath, poolLoans) : null;

  // ── Tier 2 (filename) — always available for both loose and zip. ───────────
  const filenameLoan = classifyLoanFromFilename(fileName, poolLoans);
  const filenameSlot = inferSlotFromFilename(fileName);
  const filenameDocType: string | null = filenameSlot === null ? null : (filenameSlot as string);

  // First-confident per axis across tiers 1→2 (folder loan wins over filename
  // loan when a zip folder resolved it; doc-type has no folder tier).
  let loanInPoolId: string | null = folderHints?.loanInPoolId ?? filenameLoan;
  let docType: string | null = folderHints?.docType ?? filenameDocType;

  // ── Tier 3 (content) — the fallback. Parse the FRONT-MATTER window ONCE, and
  //    ONLY if an axis is still unresolved. Skip the scan entirely when both axes
  //    already resolved (the cheap fast-path). The front-matter window (first N
  //    pages, a superset of page-1) recovers files whose page-1 is unusable —
  //    e.g. a CBRE appraisal cover that extracts LETTER-SPACED
  //    ("S U N R O A D  C E N TR U M") where page 2 carries clean "Sunroad
  //    Centrum" that fuzzy-matches. BOTH axes (loan + doc-type) share the same
  //    deeper text (parse-once still). ──────────────────────────────────────────
  // `pageText` is parsed AT MOST ONCE here and REUSED by Tier 3.5 below (no
  // second parse). '' when tiers 1-2 already resolved both axes (never reached)
  // or on any parser failure.
  let pageText = '';
  let aiRouteNote: string | undefined;
  if (loanInPoolId === null || docType === null) {
    pageText = await extractFrontMatterText(bytes); // parse-once; '' on any failure
    if (pageText.length > 0) {
      if (loanInPoolId === null) {
        loanInPoolId = classifyLoanFromContent(pageText, poolLoans);
      }
      if (docType === null) {
        const contentSlot = classifyDocTypeFromContent(pageText);
        docType = contentSlot === null ? null : (contentSlot as string);
      }
    }
  }

  // ── Tier 3.5 (LLM smart-route) — the ONLY LLM tier. Fires ONLY when an axis is
  //    STILL null after regex/fuzzy (the SAME hard-doc guard tier-3 uses), so the
  //    ~7 files that auto-routed on folder/filename never reach it — cheap by
  //    construction. Credit-gated + fail-safe: no-credits/error/malformed → NO-OP
  //    → the doc HELDs exactly as today. The LLM can only FILL a null axis (it is
  //    validated against the pool loans + taxonomy and held below its confidence
  //    floor), never overwrite a deterministically-resolved one — so the honest
  //    floor survives and verdictFor's both-axes-confident bar still applies. ──
  if (loanInPoolId === null || docType === null) {
    const llm = await classifyByLlm(fileName, pageText, poolLoans, deps?.llmCall);
    if (loanInPoolId === null && llm.loanInPoolId !== null) loanInPoolId = llm.loanInPoolId;
    if (docType === null && llm.docType !== null) docType = llm.docType;
    // Provenance recorded ONLY when the LLM actually filled an axis (§ guard 3).
    if (llm.note !== null) aiRouteNote = llm.note;
  }

  // ── Category + contradiction: PRESERVE the folder tier's cross-check when it
  //    exists (a zip entry with a recognized subfolder). Otherwise DERIVE a
  //    category hint from the (possibly content-resolved) docType — same rule the
  //    loose/2-segment shapes use. No new contradiction is manufactured from a
  //    content-resolved docType (there's no folder to cross-check against it). ──
  let categoryHint: DocTypeCategory | undefined = folderHints?.categoryHint;
  const contradiction: boolean = folderHints?.contradiction === true;
  if (categoryHint === undefined && docType !== null) {
    categoryHint = DOC_TYPE_CATEGORY[docType];
  }

  return {
    docType,
    loanInPoolId,
    ...(categoryHint !== undefined ? { categoryHint } : {}),
    ...(contradiction ? { contradiction: true } : {}),
    ...(aiRouteNote !== undefined ? { aiRouteNote } : {}),
  };
}
