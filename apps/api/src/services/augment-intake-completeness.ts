/**
 * augmentIntakeCompletenessWithSourcing — wires the EXHAUSTIVE SOURCING PASS into
 * the intake-completeness / coverage read.
 *
 * ★ DOCTRINE: no field is declared "missing" until every document on the deal has
 * been searched for it. This augmentation takes the base completeness (K resolved
 * against the graph ExtractionResult) and, for each field that WOULD be reported
 * missing, runs an LLM search across the deal's WHOLE routed doc set. A field
 * found (with a cited quote) is upgraded to `populated` (sourcedBy
 * 'document-search'); a field whose deal-applicability search fails (GSA tenancy
 * on a non-GSA deal) is marked `not-applicable`; only a field the search cannot
 * find anywhere stays a blank — now an EARNED, trustworthy blank.
 *
 * Cheap + deterministic: results are cached by (docSetHash + fieldId + version).
 * The doc-set hash is taken from the manifest (no parse), so once a deal is
 * searched the augmentation skips the expensive gather+parse entirely. No
 * credits / any error → the base result passes through unchanged (never fabricates,
 * never crashes). READ-ONLY — the graph / score are untouched.
 */

import type {
  IntakeCompleteness,
  IntakeFieldResult,
} from './intake-completeness.service.js';
import { summarizeIntakeFields } from './intake-completeness.service.js';
import { listPoolDocs, listHeldDocs } from './data-room-store.service.js';
import {
  gatherDealDocTexts,
  sourceOneField,
  docSetHashFromFileHashes,
  buildCacheKey,
  defaultCache,
  exhaustiveSourcingCreditsAvailable,
  EXHAUSTIVE_SOURCING_VERSION,
  type FieldQuery,
  type FieldSourcingResult,
  type ExhaustiveSourcingDeps,
} from './exhaustive-field-sourcing.js';

/**
 * Per-field search queries. Only fields that could plausibly live in a deal doc
 * carry a query — a field with no query is left to its base state (still honest).
 * `gsa_lease_terms` is APPLICABILITY, not sourcing: not-found ⇒ not-applicable.
 */
const FIELD_QUERIES: Record<string, FieldQuery> = {
  gpr: { id: 'gpr', field: 'Gross potential rent (GPR)', hint: 'The gross potential rent / potential gross revenue (annual), from the rent roll, operating statement, or ASR underwriting cash flow.', keywords: ['gross potential rent', 'potential gross', 'gross revenue', 'gpr', 'scheduled base rent'], preferDocTypes: ['seller_uw', 'cf', 'asr', 'rent_roll', 'appraisal'] },
  in_place_noi: { id: 'in_place_noi', field: 'In-place / T12 NOI', hint: 'The in-place or trailing-twelve-month (T-12) net operating income (NOI) for the property.', keywords: ['net operating income', 'noi', 'trailing', 't-12', 't12'], preferDocTypes: ['seller_uw', 'cf', 'asr', 'appraisal'] },
  opex: { id: 'opex', field: 'Operating expenses (by line)', hint: 'The total operating expenses (or expense line items) from the operating statement / T-12 / appraisal.', keywords: ['total operating expenses', 'operating expenses', 'total expenses'], preferDocTypes: ['seller_uw', 'cf', 'asr', 'appraisal'] },
  reimbursements: { id: 'reimbursements', field: 'Reimbursements / recoveries', hint: 'Tenant expense reimbursements / recoveries (CAM, tax, insurance recoveries).', keywords: ['reimbursement', 'recoveries', 'cam', 'expense recovery'], preferDocTypes: ['seller_uw', 'cf', 'appraisal', 'rent_roll'] },
  stabilized_noi: { id: 'stabilized_noi', field: 'Stabilized pro-forma NOI', hint: 'The stabilized / pro-forma / as-stabilized net operating income projected by the appraisal, seller underwriting, or ASR.', keywords: ['stabilized noi', 'stabilized net operating', 'pro forma noi', 'as stabilized', 'underwritten noi'], preferDocTypes: ['appraisal', 'seller_uw', 'asr'] },
  stabilized_value: { id: 'stabilized_value', field: 'Stabilized / prospective value', hint: 'The as-stabilized / prospective / upon-stabilization appraised value.', keywords: ['as stabilized', 'prospective value', 'stabilized value', 'upon stabilization', 'as-stabilized'], preferDocTypes: ['appraisal', 'asr'] },
  extraordinary_assumptions: { id: 'extraordinary_assumptions', field: 'Extraordinary assumptions / hypotheticals', hint: 'Any extraordinary assumptions or hypothetical conditions stated by the appraisal.', keywords: ['extraordinary assumption', 'hypothetical condition'], preferDocTypes: ['appraisal'] },
  interest_rate: { id: 'interest_rate', field: 'Interest rate / coupon', hint: 'The loan interest rate / coupon (a numeric annual rate).', keywords: ['interest rate', 'coupon', 'per annum', '% rate', 'fixed rate of'], preferDocTypes: ['asr', 'seller_uw'] },
  maturity: { id: 'maturity', field: 'Maturity / term', hint: 'The loan maturity date or loan term / tenor.', keywords: ['maturity date', 'maturity', 'loan term', 'term of', 'year loan'], preferDocTypes: ['asr', 'seller_uw'] },
  environmental_status: { id: 'environmental_status', field: 'Environmental status (Phase I REC)', hint: 'The Phase I ESA conclusion — whether recognized environmental conditions (RECs) were identified and whether the environmental condition is acceptable.', keywords: ['recognized environmental condition', 'no evidence of recognized', 'rec', 'phase i', 'environmental condition'], preferDocTypes: ['phase_i_esa', 'asr', 'appraisal', 'pca'] },
  sponsor_net_worth: { id: 'sponsor_net_worth', field: 'Sponsor net worth & liquidity', hint: 'The sponsor / guarantor net worth and liquidity figures.', keywords: ['net worth', 'liquidity', 'guarantor', 'sponsor'], preferDocTypes: ['asr', 'seller_uw', 'appraisal'] },
  sponsor_track_record: { id: 'sponsor_track_record', field: 'Sponsor track record / prior defaults', hint: 'The sponsor track record, experience, portfolio, or any prior defaults / bankruptcies.', keywords: ['track record', 'prior default', 'bankruptcy', 'portfolio', 'experience'], preferDocTypes: ['asr', 'seller_uw'] },
  borrower_spe: { id: 'borrower_spe', field: 'Borrower / SPE structure', hint: 'The borrower single-purpose-entity (SPE) / bankruptcy-remote structure.', keywords: ['single purpose', 'special purpose entity', 'spe', 'bankruptcy remote', 'borrower is a'], preferDocTypes: ['asr', 'seller_uw'] },
};

/** Deal-APPLICABILITY probes (not sourcing): a not-found here means the field
 *  does not apply to this deal, so it is marked not-applicable rather than
 *  missing. */
const APPLICABILITY_QUERIES: Record<string, FieldQuery> = {
  gsa_lease_terms: { id: 'gsa_lease_terms', field: 'GSA / government anchor tenant', hint: 'Whether a U.S. GSA (General Services Administration) or federal-government agency is an ANCHOR TENANT at the property. Only found:true if a government agency actually leases space here — NOT mere regulatory mentions.', keywords: ['gsa', 'general services administration', 'government tenant', 'federal government', 'u.s. government lease'], preferDocTypes: ['rent_roll', 'appraisal', 'asr', 'seller_uw'] },
};

/** States that mean "would be reported missing" — the trigger for a search. */
function isMissingState(f: IntakeFieldResult): boolean {
  return f.state === 'in-PDF-not-extracted' || f.state === 'not-in-any-doc';
}

/**
 * Augment a base completeness result with the exhaustive sourcing pass.
 *
 * @param base           completeness from computeIntakeCompleteness (graph-resolved).
 * @param poolId         the deal's pool.
 * @param loanInPoolId   the deal's loan (data-room doc address).
 * @param deps           injectable LLM seam / credit gate / cache (tests).
 */
export async function augmentIntakeCompletenessWithSourcing(
  base: IntakeCompleteness,
  poolId: string,
  loanInPoolId: string,
  deps: ExhaustiveSourcingDeps = {},
): Promise<IntakeCompleteness> {
  const version = deps.version ?? EXHAUSTIVE_SOURCING_VERSION;
  const cache = deps.cache ?? defaultCache;
  const hasCredits = deps.creditsAvailable ?? exhaustiveSourcingCreditsAvailable;

  // Which fields would be reported missing AND have a query (sourcing or applicability)?
  const targets = base.fields.filter(
    (f) => isMissingState(f) && (FIELD_QUERIES[f.id] || APPLICABILITY_QUERIES[f.id]),
  );
  if (targets.length === 0) return base;

  // docSetHash from the MANIFEST (no parse) → cheap cache peek. Must include the
  // SAME set gatherDealDocTexts searches — ROUTED + HELD docs (FIX 3) — so adding
  // a held doc busts the cache and it gets searched (else a new held file would
  // be silently missed behind a stale cache).
  const routedHashes = listPoolDocs(poolId).filter((d) => d.loanInPoolId === loanInPoolId).map((d) => d.fileHash);
  const heldHashes = listHeldDocs(poolId).filter((h) => h.hintLoanInPoolId === loanInPoolId).map((h) => h.fileHash);
  const fileHashes = [...routedHashes, ...heldHashes];
  if (fileHashes.length === 0) return base; // no docs to search → base stands
  const dsh = docSetHashFromFileHashes(fileHashes);

  // Peek the cache; only gather+parse if something is uncached.
  const results = new Map<string, FieldSourcingResult>();
  const uncached: IntakeFieldResult[] = [];
  for (const f of targets) {
    const cached = cache.get(buildCacheKey(dsh, f.id, version));
    if (cached) results.set(f.id, { ...cached, searched: false });
    else uncached.push(f);
  }

  if (uncached.length > 0) {
    if (!hasCredits()) {
      // ★ CANNOT SEARCH (no credits). DON'T silently return base — that would make
      // a failed search indistinguishable from "genuinely missing" (the exact
      // bug). Mark every un-searched target UNAVAILABLE so the UI shows them as
      // UNVERIFIED, not confirmed missing. No gather/parse (nothing to search).
      for (const f of uncached) {
        results.set(f.id, {
          id: f.id, found: false, value: null, sourceQuote: null, docName: null,
          status: 'unavailable', searched: false,
        });
      }
      const applied = applyResults(base.fields, results);
      return { fields: applied, summary: summarizeIntakeFields(applied) };
    }
    const docs = await gatherDealDocTexts(poolId, loanInPoolId);
    if (docs.length === 0) return base;
    // Search the uncached fields CONCURRENTLY — first-load latency = the slowest
    // single search, not their sum. Each result caches independently, so a
    // partial run (client disconnect) still makes progress. sourceOneField never
    // throws (fail-safe), so Promise.all won't reject.
    const searched = await Promise.all(
      uncached.map(async (f) => {
        const q = FIELD_QUERIES[f.id] ?? APPLICABILITY_QUERIES[f.id];
        return q ? [f.id, await sourceOneField(q, docs, dsh, deps)] as const : null;
      }),
    );
    for (const s of searched) if (s) results.set(s[0], s[1]);
  }

  const upgraded = applyResults(base.fields, results);
  return { fields: upgraded, summary: summarizeIntakeFields(upgraded) };
}

/** Apply the per-field sourcing results — the THREE outcomes — to the roster. */
function applyResults(
  fields: readonly IntakeFieldResult[],
  results: Map<string, FieldSourcingResult>,
): IntakeFieldResult[] {
  return fields.map((f) => {
    const r = results.get(f.id);
    if (!r) return f;
    if (r.status === 'found') {
      // Sourcing hit → populated + citation. Applicability hit (GSA) → the field
      // DOES apply and its evidence exists, so it becomes a normal sourced field.
      return {
        ...f,
        state: 'populated',
        sourcedBy: 'document-search',
        ...(r.sourceQuote ? { sourceQuote: r.sourceQuote } : {}),
        ...(r.docName ? { sourceDoc: r.docName } : {}),
      };
    }
    if (r.status === 'unavailable') {
      // ★ COULD NOT SEARCH (credits/error) → leave the base missing state but flag
      // it UNVERIFIED. Never a confirmed missing; the UI must say "search
      // unavailable — unverified" so a failed search is NOT mistaken for a gap.
      return { ...f, searchStatus: 'unavailable' as const };
    }
    // r.status === 'absent' → the search RAN and found nothing anywhere.
    if (APPLICABILITY_QUERIES[f.id]) {
      return { ...f, state: 'not-applicable' as const }; // GSA: no gov tenant → n/a
    }
    return { ...f, searchStatus: 'searched' as const }; // EARNED blank
  });
}
