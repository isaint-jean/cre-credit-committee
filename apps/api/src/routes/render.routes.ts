/**
 * Render routes — exposes already-completed analyses as a flat payload the
 * Excel workbook can iterate. Read-only. No underwriting computation.
 *
 * The route is the ONLY place permitted to know about both Analysis and
 * RenderInput; it composes a RenderInput and hands it to the pure render
 * service. It is also the only place permitted to resolve
 * structuralVariantKey — either by accepting the explicit query param OR by
 * calling resolveStructuralVariant(). No other source, no fallback.
 */
import { Router, Request, Response } from 'express';
import { store } from '../storage/sqlite-store.js';
import { applyDocumentCompletenessDisplay } from '../services/document-completeness.service.js';
import { servicerInputWorkbookCells } from '../services/servicer-inputs.service.js';
import {
  buildRenderPayload,
  getAssetClassVariantModeTabs,
  getManagedNamespace,
  RenderSchemaError,
} from '../services/render.service.js';
import {
  getModesForVariant,
  getSchemaAddresses,
  getSchemaSourcesByAddress,
  getVariantsForAssetClass,
} from '../services/render-schema.js';
import {
  assertUnderwritingModeRegistered,
  assertVariantRegistered,
  resolveStructuralVariant,
} from '../services/resolve-structural-variant.js';
import {
  getAllMigrations,
  getMigrationManifest,
} from '../services/render-migrations.js';
import { adaptAnalysisToAdjustedInputs } from '../services/analysis-to-adjusted-inputs.adapter.js';
import { buildFloorBindings } from '../services/build-floor-bindings.js';
import { projectLegacyAnalysisFromGraph } from '../services/project-legacy-analysis-from-graph.js';
import { resolveAnalysisForRead } from '../services/resolve-analysis-for-read.js';
import { canAccessAnalysis } from '../middleware/deal-access.js';
import { resolvePortfolioExport } from '../services/export-portfolio-dispatch.service.js';
import { MalformedAnalysisIdError } from '../util/dispatch-by-id-format.js';
import { recordGraphStore } from '../storage/record-graph-store.js';
import { hydrateUnderwritingContext } from '../services/hydrate-underwriting-context.js';
import {
  buildObservabilityEvent,
  emitObservabilityEvent,
  persistObservabilityEvent,
} from '../services/underwriting-observability.service.js';
import {
  computeReadiness,
  readObservabilityWindow,
} from '../services/migration-readiness.service.js';
import {
  applyRenderPayloadToTemplate,
  assertTemplateCanSatisfySchema,
  TemplateIntegrityError,
  validateTemplateCompatibility,
} from '../services/template-engine.service.js';
import { RENDER_CONTRACT_VERSION } from '@cre/shared';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openCompsStore, propertyKeyFor } from '../services/comps-store.js';
import { rankComps, type CompRow, type SubjectVector } from '../services/rank-comps.js';
import { parseCmbsComps } from '../services/extract-cmbs-comps.js';
import type { CompsTableRow } from '@cre/shared';
import type { RevisionId } from '@cre/contracts';
import type {
  AdjustedInputs,
  Analysis,
  AssetType,
  MigrationManifest,
  RenderConservatismStatus,
  RenderInput,
  RenderLibraryBaselineMeta,
  RenderPayload,
  StructuralVariantKey,
  TemplateType,
  UnderwritingMode,
} from '@cre/shared';

export const renderRoutes = Router();

const VALID_ASSET_TYPES: AssetType[] = [
  'office', 'multifamily', 'retail', 'industrial',
  'hotel', 'self_storage', 'mixed_use', 'manufactured_housing',
];

function buildConservatismStatus(
  analysis: Analysis,
  adjustedInputs: AdjustedInputs,
): RenderConservatismStatus {
  const findings = analysis.crossCheckFindings ?? [];
  const flags = findings
    .filter((f) => f.severity === 'high' || f.severity === 'critical')
    .map((f) => `${f.metric} [${f.flag}]`);
  const approved = analysis.overallAdjustmentBias === 'conservative' && flags.length === 0;
  return { approved, flags, floorBindings: buildFloorBindings(adjustedInputs) };
}

const VALID_UNDERWRITING_MODES: UnderwritingMode[] = ['single_loan', 'roll_up'];

function buildLibraryBaselineMeta(analysis: Analysis): RenderLibraryBaselineMeta {
  // TODO(library): wire to getLibraryBaselines() once exposed for completed
  // analyses. Architecture contract §4 requires baseline distributions, not
  // point values — keep null sentinels so Excel renders "—" rather than
  // fabricating numbers.
  return {
    assetType: analysis.assetType,
    sampleSize: null,
    vacancyMedian: null,
    expenseRatioMedian: null,
    capRateMedian: null,
    degraded: false,
  };
}

// ── CMBS office-comps composition (v25) ──────────────────────────────────────
// The render ROUTE is the only place permitted to open the comp corpus on disk.
// The pure engine (render.service / buildTables) never touches a db — it only
// reads RenderInput.compsTable. This helper: derives a deal-driven SubjectVector
// from the hydrated property atoms, ranks the office comp corpus against it,
// takes the top-6, and maps each → CompsTableRow (pulling display fields from the
// comps.db row + re-parsing the EX-102 raw blob for yearLastRenovated/loanStatus
// which the corpus schema doesn't carry). A missing comps.db is a clean skip
// (returns undefined → no compsTable → zero rendered rows). NEVER throws.
const COMPS_REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const COMPS_DB_PATH = resolve(COMPS_REPO, 'data/comps/comps.db');
const COMPS_RAW_DIR = resolve(COMPS_REPO, 'data/comps/raw');

function fmtPct(n: number | null): string | null {
  return n === null ? null : `${(n * 100).toFixed(1)}%`;
}
function fmtMoney(n: number | null): number | null {
  return n === null ? null : Math.round(n);
}

interface ComposedComps {
  table: CompsTableRow[];
  commentary: string[] | undefined;
}

function composeCompsTable(
  underwritingContext: RenderInput['underwritingContext'],
  adjustedInputs: AdjustedInputs,
  subjectCurrentOccupancy: number | null,
): ComposedComps | undefined {
  try {
    if (!existsSync(COMPS_DB_PATH)) return undefined;
    const p = underwritingContext.property ?? null;
    const subjectName = (p?.name as string | null) ?? null;
    const subjectAddress = (p?.street as string | null) ?? null;
    const subjectCity = (p?.city as string | null) ?? 'San Diego';
    const subjectState = (p?.state as string | null) ?? 'CA';
    const subjectSF = (p?.totalSquareFeet as number | null) ?? 274_758;
    // Loan-basis value (deal-driven): the computed implied value. null is fine —
    // rankComps treats a null subject value as "value sub-score absent".
    const subjectValue = adjustedInputs.metrics.impliedValue ?? null;
    // Vintage reference: deal note/origination date when available, else the
    // BMARK 2024-V8 issuance month (Sunroad resolves to 2024-08).
    const noteDate = (p as { noteDate?: unknown } | null)?.noteDate;
    const vintageRef =
      typeof noteDate === 'string' && noteDate.length >= 7 ? noteDate : '2024-08-01';
    const subject: SubjectVector = {
      propertyType: 'Office',
      city: subjectCity,
      state: subjectState,
      netRentableSF: subjectSF,
      vintageRef,
      value: subjectValue,
      propertyKey: propertyKeyFor(subjectName, subjectAddress),
    };

    const db = openCompsStore(COMPS_DB_PATH);
    let topRanked;
    let rowByKey: Map<string, Record<string, unknown>>;
    // The self-excluded subject's OWN EX-102 row (asset#22 of BMARK 2024-V8) —
    // used for the comp-set commentary so subject and comps share the
    // securitization basis (apples-to-apples). null if not found in the corpus.
    let subjectRow: Record<string, unknown> | null = null;
    try {
      const rows = db
        .prepare(
          "SELECT dealName, assetNumber, propertyName, address, city, state, zip, " +
            "netRentableSF, value, noi, occupancyPct, yearBuilt, capRate, loanPieceAmount, " +
            "filingDate, largestTenant, propertyType, propertyKey, fieldCoverage, rawBlobHash " +
            "FROM comps WHERE propertyType='Office'",
        )
        .all() as Array<Record<string, unknown>>;
      // Robust self-exclusion. rankComps already drops the exact propertyKey
      // match, but a deal-derived subject key ("Sunroad Centrum Office One" /
      // "…Blvd") need not equal the corpus EX-102 key ("Sunroad Centrum" /
      // "…BOULEVARD") for the deal's OWN comp row — the subject would then leak
      // in as comp #1. Belt-and-suspenders: also exclude any office row that is
      // unmistakably the subject property (same city+state AND SF within 0.5%).
      const subjCityNorm = subjectCity.toLowerCase().trim();
      const subjStateNorm = subjectState.toUpperCase().trim();
      const isSubjectRow = (r: Record<string, unknown>): boolean => {
        if (r.propertyKey === subject.propertyKey) return true;
        const c = String(r.city ?? '').toLowerCase().trim();
        const s = String(r.state ?? '').toUpperCase().trim();
        const sf = typeof r.netRentableSF === 'number' ? r.netRentableSF : null;
        return (
          c === subjCityNorm && s === subjStateNorm &&
          sf !== null && subjectSF > 0 && Math.abs(sf - subjectSF) / subjectSF <= 0.005
        );
      };
      const corpusRows = rows.filter((r) => !isSubjectRow(r));
      // Capture the subject's own corpus row (first match) for the commentary.
      subjectRow = rows.find((r) => isSubjectRow(r)) ?? null;
      const ranker = rankComps(corpusRows as unknown as CompRow[], subject);
      // Top-4 — the blue-box comp grid has exactly 4 slots (r7–r10). See
      // docs/recon/2026-06-29-bluebox-cellmap.md.
      topRanked = ranker.ranked.slice(0, 4);
      // Index the full corpus row by (dealName#assetNumber) so we can pull the
      // display fields the RankedComp doesn't carry.
      rowByKey = new Map(rows.map((r) => [`${r.dealName}#${r.assetNumber}`, r]));
    } finally {
      db.close();
    }

    // Keep the corpus rows for the top-4 (in rank order) for the commentary
    // producer, which needs raw numeric fields (capRate/noi/sf/occ/yearBuilt).
    const topCorpusRows = topRanked.map(
      (rc) => rowByKey.get(`${rc.dealName}#${rc.assetNumber}`) ?? {},
    );

    const table = topRanked.map((rc): CompsTableRow => {
      const r = rowByKey.get(`${rc.dealName}#${rc.assetNumber}`) ?? {};
      const propertyName = (r.propertyName as string | null) ?? rc.propertyName ?? null;
      const address = (r.address as string | null) ?? null;
      const city = (r.city as string | null) ?? rc.city ?? null;
      const state = (r.state as string | null) ?? rc.state ?? null;
      const yearBuilt = (r.yearBuilt as number | null) ?? null;
      const occupancyPct = (r.occupancyPct as number | null) ?? null;
      const loanPieceAmount = (r.loanPieceAmount as number | null) ?? null;
      const netRentableSF = (r.netRentableSF as number | null) ?? null;
      const noi = (r.noi as number | null) ?? null;
      const filingDate = (r.filingDate as string | null) ?? null;

      // yearLastRenovated + loanStatus are NOT in the corpus schema — re-parse the
      // EX-102 raw blob (best-effort; default loanStatus 'Current' / renov null).
      let yearRenov: number | null = null;
      let loanStatus = 'Current';
      const rawBlobHash = r.rawBlobHash as string | null;
      if (rawBlobHash) {
        try {
          const rawPath = resolve(COMPS_RAW_DIR, `${rawBlobHash}.xml`);
          if (existsSync(rawPath)) {
            const xml = readFileSync(rawPath, 'utf8');
            const parsed = parseCmbsComps(xml, { sourceDeal: String(r.dealName ?? '') });
            const match = parsed.comps.find(
              (c) => String(c.assetNumber ?? '') === String(r.assetNumber ?? ''),
            );
            if (match) {
              yearRenov = match.yearLastRenovated ?? null;
              // EX-102 paymentStatusLoanCode: "0" = Current/Performing at
              // issuance vintage. Normalize the performing code to a readable
              // label; pass any other (delinquency) code through verbatim.
              const raw = (match.loanStatus ?? '').trim();
              loanStatus = raw === '' || raw === '0' ? 'Current' : raw;
            }
          }
        } catch {
          /* raw re-parse best-effort — keep defaults */
        }
      }

      const cityState =
        city && state ? `${city}, ${state}` : city ?? state ?? null;
      const dealNote = `SEC EX-102 · ${rc.dealName} · asset#${rc.assetNumber}` +
        (filingDate ? ` · filed ${filingDate}` : '');
      const debtYield =
        noi !== null && loanPieceAmount && loanPieceAmount > 0
          ? fmtPct(noi / loanPieceAmount)
          : null;
      // Q ($/SF) is computed by the template's own `=O/J` formula — NOT bound.

      const row: CompsTableRow = {
        loanName: propertyName,
        address,
        cityState,
        distance: null, // no geocoding
        loanStatus,
        totalSf: netRentableSF, // drives the template's Q = O/J $/SF formula
        yearBuilt,
        yearRenov,
        occup: occupancyPct !== null ? fmtPct(occupancyPct) : null,
        dealNote,
        balance: loanPieceAmount !== null ? `${fmtMoney(loanPieceAmount)} (piece)` : null,
        debtYield: debtYield !== null ? `${debtYield} (piece)` : null,
        nulls: [],
      };
      // Record genuinely-null display fields for MISSING_DATA_FILL.
      row.nulls = (Object.keys(row) as Array<keyof CompsTableRow>)
        .filter((k) => k !== 'nulls' && (row[k] === null || row[k] === undefined))
        .map((k) => String(k));
      return row;
    });

    const commentary = composeCompsCommentary(
      subjectRow,
      topCorpusRows,
      subjectSF,
      subjectCurrentOccupancy,
    );
    return { table, commentary };
  } catch (err) {
    console.error('[comps] composeCompsTable error (swallowed):', (err as Error)?.message);
    return undefined;
  }
}

// ── SEC comp-set commentary (v25 · FIX-4 basis-comparability) ────────────────
// Deterministic, NO LLM. Authors 8 lines of standard sales-comparison framing
// from the subject + top-4 comps (all sharing the Form ABS-EE securitization
// basis). Every {…} is filled from real numbers; qualitative words are computed
// by comparison. A null subject value degrades that one line gracefully (never
// prints "null"). Returns undefined when there's nothing to say (no comps).
//
// ★ STRUCTURAL GUARD (FIX-4): every line is a CommentaryPoint carrying an explicit
//   `basis` classification. Directional language (above/below/stronger/larger/…)
//   is emitted ONLY when basis === 'COMPARABLE'. The other two bases are
//   non-directional by construction:
//     - NON_COMPARABLE → comp values shown "for reference only" (e.g. piece-level
//       debt yield: EX-102 balances are pari-passu pieces, not whole-loan, so
//       cross-deal DY is an artifact — no subject-vs-comp claim).
//     - PRESENT_BOTH → both subject bases shown and framed against comps on the
//       matching basis (e.g. stabilized-underwrite occupancy / cap rate, where the
//       subject's figure is a projection vs comps' at-securitization snapshot).
//   This makes a future mismatched metric structurally unable to ship a false
//   directional read — the basis flag, not prose, gates the directional words.
type CommentaryBasis = 'COMPARABLE' | 'NON_COMPARABLE' | 'PRESENT_BOTH';
interface CommentaryPoint {
  readonly basis: CommentaryBasis;
  readonly text: string;
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function isSanDiego(r: Record<string, unknown>): boolean {
  return String(r.city ?? '').toLowerCase().trim() === 'san diego';
}

function composeCompsCommentary(
  subjectRow: Record<string, unknown> | null,
  comps: Array<Record<string, unknown>>,
  subjectSfFallback: number,
  subjectCurrentOccupancy: number | null,
): string[] | undefined {
  if (comps.length === 0) return undefined;

  // Subject metrics (from its own EX-102 row; fall back to the deal SF).
  const subjYr = subjectRow ? num(subjectRow.yearBuilt) : null;
  const subjSf = (subjectRow ? num(subjectRow.netRentableSF) : null) ?? num(subjectSfFallback);
  // Subject occupancy in comps.db = its securitization underwrite (100% stabilized);
  // the asset is in active lease-up so its CURRENT in-place occupancy is materially
  // lower — passed separately (subjectCurrentOccupancy, 0..1 fraction, may be null).
  const subjOccRaw = subjectRow ? num(subjectRow.occupancyPct) : null;
  const subjCurOcc = num(subjectCurrentOccupancy);
  const subjCapRaw = subjectRow ? num(subjectRow.capRate) : null;
  const subjNoi = subjectRow ? num(subjectRow.noi) : null;
  const subjLoanPiece = subjectRow ? num(subjectRow.loanPieceAmount) : null;
  const subjDyRaw =
    subjNoi !== null && subjLoanPiece && subjLoanPiece > 0 ? subjNoi / subjLoanPiece : null;

  // Comp-set distributions.
  const compYrs = comps.map((r) => num(r.yearBuilt)).filter((x): x is number => x !== null);
  const compSfs = comps.map((r) => num(r.netRentableSF)).filter((x): x is number => x !== null);
  const compOccs = comps.map((r) => num(r.occupancyPct)).filter((x): x is number => x !== null);
  const compCaps = comps.map((r) => num(r.capRate)).filter((x): x is number => x !== null);
  const compDys = comps
    .map((r) => {
      const n = num(r.noi);
      const lp = num(r.loanPieceAmount);
      return n !== null && lp && lp > 0 ? n / lp : null;
    })
    .filter((x): x is number => x !== null);

  const sdCount = comps.filter(isSanDiego).length;
  const socalCount = comps.length - sdCount;
  const filingYears = comps
    .map((r) => {
      const fd = String(r.filingDate ?? '');
      const m = fd.match(/(\d{4})/);
      return m ? Number(m[1]) : null;
    })
    .filter((x): x is number => x !== null);
  const vintageYearMin = filingYears.length ? Math.min(...filingYears) : null;
  const vintageYearMax = filingYears.length ? Math.max(...filingYears) : null;

  const pct1 = (x: number) => (x * 100).toFixed(1);
  const sf = (x: number) => Math.round(x).toLocaleString('en-US');
  const compYrMin = compYrs.length ? Math.min(...compYrs) : null;
  const compYrMax = compYrs.length ? Math.max(...compYrs) : null;
  const sfMin = compSfs.length ? Math.min(...compSfs) : null;
  const sfMax = compSfs.length ? Math.max(...compSfs) : null;
  const occMin = compOccs.length ? Math.min(...compOccs) : null;
  const occMax = compOccs.length ? Math.max(...compOccs) : null;
  const occMed = median(compOccs);
  const dyMin = compDys.length ? Math.min(...compDys) : null;
  const dyMax = compDys.length ? Math.max(...compDys) : null;
  const capMin = compCaps.length ? Math.min(...compCaps) : null;
  const capMax = compCaps.length ? Math.max(...compCaps) : null;

  const points: CommentaryPoint[] = [];

  // L1 — comp-set framing. (Pure framing; no subject-vs-comp claim → COMPARABLE
  // is harmless but classify as COMPARABLE since it's a factual set description.)
  const vintageSpan =
    vintageYearMin !== null && vintageYearMax !== null
      ? vintageYearMin === vintageYearMax
        ? `${vintageYearMin}`
        : `${vintageYearMin}–${vintageYearMax}`
      : 'recent vintages';
  points.push({
    basis: 'COMPARABLE',
    text:
      `Comp set: ${comps.length} institutionally-financed office loans from CMBS Form ABS-EE ` +
      `disclosures (${sdCount} San Diego, ${socalCount} broader SoCal), securitized ${vintageSpan}.`,
  });

  // L2 — vintage → COMPARABLE (verified fine; directional language allowed).
  if (subjYr !== null && compYrMin !== null && compYrMax !== null) {
    const compSpan = compYrMin === compYrMax ? `${compYrMin}` : `${compYrMin}–${compYrMax}`;
    const rel = subjYr > compYrMax ? 'newer than all' : subjYr < compYrMin ? 'older than all' : 'within range';
    const modern =
      subjYr >= compYrMax
        ? 'a more modern asset with lower deferred-capex risk than the peer set'
        : 'broadly comparable in age to the peer set';
    points.push({
      basis: 'COMPARABLE',
      text: `Vintage — subject built ${subjYr} vs comps ${compSpan}; the subject is ${rel}, ${modern}.`,
    });
  } else {
    points.push({
      basis: 'COMPARABLE',
      text:
        `Vintage — subject build year not disclosed in the SEC filing; ` +
        `comps ${compYrMin !== null && compYrMax !== null ? `${compYrMin}–${compYrMax}` : 'span recent vintages'}.`,
    });
  }

  // L3 — occupancy → PRESENT_BOTH. Comps' occupancy is AT-SECURITIZATION
  // (EX-102 physicalOccupancySecuritizationPercentage). The subject's comps.db
  // figure is its securitization underwrite (100% stabilized) BUT the asset is in
  // active lease-up — its ACTUAL current occupancy is lower (subjCurOcc). Show both
  // bases; the directional claim ("below the comp range") is on the CURRENT basis,
  // which is the matching apples-to-apples comparison, and flags transitional risk.
  if (occMin !== null && occMax !== null && occMed !== null) {
    if (subjCurOcc !== null) {
      points.push({
        basis: 'PRESENT_BOTH',
        text:
          `Occupancy — comps reflect at-securitization occupancy ${pct1(occMin)}%–${pct1(occMax)}% ` +
          `(median ${pct1(occMed)}%); the subject underwrites to 100% stabilized but is in active lease-up ` +
          `(current ~${pct1(subjCurOcc)}%), so on a CURRENT basis it sits below the comp range — a ` +
          `transitional risk; stabilized is a projection.`,
      });
    } else {
      points.push({
        basis: 'PRESENT_BOTH',
        text:
          `Occupancy — comps reflect at-securitization occupancy ${pct1(occMin)}%–${pct1(occMax)}% ` +
          `(median ${pct1(occMed)}%); the subject underwrites to 100% stabilized; as the asset is in ` +
          `active lease-up, current occupancy is materially lower, so the stabilized figure is a ` +
          `projection, not in-place — a transitional risk.`,
      });
    }
  } else if (occMin !== null && occMax !== null) {
    points.push({
      basis: 'PRESENT_BOTH',
      text:
        `Occupancy — comps reflect at-securitization occupancy ${pct1(occMin)}%–${pct1(occMax)}%; ` +
        `the subject underwrites to 100% stabilized but is in active lease-up, so the stabilized figure ` +
        `is a projection, not in-place — a transitional risk.`,
    });
  }

  // L4 — size → COMPARABLE (verified fine; directional language allowed).
  if (sfMin !== null && sfMax !== null && subjSf !== null) {
    const largerThan = compSfs.filter((x) => subjSf > x).length;
    const sizeRel =
      largerThan === compSfs.length
        ? `larger than all ${compSfs.length} of the comp set`
        : largerThan === 0
          ? `smaller than the comp set`
          : `larger than ${largerThan} of ${compSfs.length}`;
    points.push({
      basis: 'COMPARABLE',
      text: `Size — subject ${sf(subjSf)} SF vs comps ${sf(sfMin)}–${sf(sfMax)} SF; ${sizeRel}.`,
    });
  } else if (sfMin !== null && sfMax !== null) {
    points.push({
      basis: 'COMPARABLE',
      text: `Size — comps ${sf(sfMin)}–${sf(sfMax)} SF; subject size not disclosed.`,
    });
  }

  // L5 — debt yield → NON_COMPARABLE. EX-102 balances are pari-passu PIECES, not
  // whole-loan, so cross-deal debt yield is an artifact (a piece-level DY can look
  // "stronger" while the real whole-loan DY is below the comps). Show the comps'
  // piece-level range FOR REFERENCE ONLY; no subject-vs-comp directional claim.
  if (dyMin !== null && dyMax !== null) {
    points.push({
      basis: 'NON_COMPARABLE',
      text:
        `Debt yield — EX-102 balances are pari-passu pieces, not whole-loan, so cross-deal debt yield ` +
        `is not directly comparable (comps' piece-level ${pct1(dyMin)}%–${pct1(dyMax)}% shown for ` +
        `reference only).`,
    });
  }

  // L6 — valuation / cap rate → PRESENT_BOTH (basis flag). The subject's NOI is a
  // STABILIZED underwrite (the asset is in lease-up and cannot produce that NOI
  // in-place), so its cap rate is a stabilized-underwrite cap rate; comps' caps are
  // at-securitization. Comparable on an UNDERWRITTEN basis, but the subject embeds
  // a stabilization projection — no clean aggressive/in-line/conservative claim.
  if (capMin !== null && capMax !== null && subjCapRaw !== null) {
    points.push({
      basis: 'PRESENT_BOTH',
      text:
        `Valuation — the subject's ${pct1(subjCapRaw)}% cap rate is a stabilized underwrite ` +
        `(NOI reflects projected stabilization, not in-place lease-up); comps' ` +
        `${pct1(capMin)}%–${pct1(capMax)}% are at-securitization. Comparable on an underwritten basis, ` +
        `but the subject's embeds a stabilization projection.`,
    });
  } else if (capMin !== null && capMax !== null) {
    points.push({
      basis: 'PRESENT_BOTH',
      text:
        `Valuation — comp-set at-securitization cap rates ${pct1(capMin)}%–${pct1(capMax)}%; ` +
        `subject cap rate not disclosed in the filing.`,
    });
  }

  // L7 — implication → balanced. Lean on the COMPARABLE axes (vintage, quality,
  // location, stabilized occupancy); flag leverage as non-comparable on a piece
  // basis; name current lease-up (transitional occupancy + NOI) as the key watch
  // item. Do NOT lean on debt yield.
  points.push({
    basis: 'PRESENT_BOTH',
    text:
      `Implication — favorable on vintage/quality/location; occupancy the key watch ` +
      `(current lease-up); leverage non-comparable (piece basis).`,
  });

  // L8 — basis (static) → NON_COMPARABLE framing of the source itself.
  points.push({
    basis: 'NON_COMPARABLE',
    text:
      `Basis — SEC as-underwritten LOAN comps (Form ABS-EE EX-102); piece-level balances; ` +
      `no lease comps (not in SEC filings).`,
  });

  // The template-engine writes B15–B22 as plain text. The basis flag has already
  // gated the directional wording above (directional words only where COMPARABLE),
  // so the emitted transport is the text — the guard lives in the producer.
  return points.map((p) => p.text);
}

/**
 * GET /api/underwriting/render?dealId=...&assetClass=...&structuralVariantKey=...
 *
 * Returns a RenderPayload — flat cell-bindings, visible tabs, drivers.
 * The workbook iterates and writes; it never computes.
 *
 * `structuralVariantKey` resolution (memory/architecture_render_versioning.md):
 *   - If the query param is provided, it MUST be registered for the asset
 *     class; otherwise hard 400.
 *   - If absent, resolveStructuralVariant() is called. Any failure is hard.
 *   - There is NO implicit default variant.
 */
function parseClientVersion(req: Request): number | null {
  const raw = req.query.clientContractVersion;
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : NaN;
}

interface PayloadResolution {
  status: 'ok';
  payload: RenderPayload;
  analysis: Analysis;
  assetClass: AssetType;
  structuralVariantKey: StructuralVariantKey;
  underwritingMode: UnderwritingMode;
}
interface PayloadFailure {
  status: 'error';
  httpStatus: number;
  body: Record<string, unknown>;
}
type PayloadResult = PayloadResolution | PayloadFailure;

interface ComposeOptions {
  requireUwModel?: boolean;
  /**
   * Contract version to render against. Defaults to RENDER_CONTRACT_VERSION
   * (the /render contract). /export passes the active template's
   * compatibleContractVersion so the payload matches the artifact the
   * template registry pinned the export to.
   */
  contractVersion?: number;
}

/**
 * Compose a RenderPayload for a deal using identical resolution rules for
 * /render and /export. Both endpoints MUST share this — there is one render
 * pipeline, never a parallel one.
 */
function composeRenderPayloadFromQuery(
  req: Request,
  opts: ComposeOptions = {},
): PayloadResult {
  const requireUwModel = opts.requireUwModel ?? true;
  const targetContractVersion = opts.contractVersion ?? RENDER_CONTRACT_VERSION;
  const dealId = String(req.query.dealId ?? '').trim();
  const assetClassRaw = req.query.assetClass ? String(req.query.assetClass).trim() : '';
  const variantKeyRaw = req.query.structuralVariantKey
    ? String(req.query.structuralVariantKey).trim()
    : '';
  const underwritingModeRaw = req.query.underwritingMode
    ? String(req.query.underwritingMode).trim()
    : '';
  const clientVersion = parseClientVersion(req);

  if (!dealId) {
    return { status: 'error', httpStatus: 400, body: { error: 'dealId is required' } };
  }
  // Chunk 3b (dark): gate the deal BEFORE any render/export work or bytes flow (the
  // stream trap — /export streams a file). Pass-through when the flag is off / for
  // admin; fail-closed on an unresolvable id. Covers BOTH /render and /export.
  const ru = req.user;
  if (ru && !canAccessAnalysis(ru.userId, ru.role, dealId)) {
    return { status: 'error', httpStatus: 403, body: { error: 'DEAL_ACCESS_DENIED' } };
  }
  if (!assetClassRaw) {
    return {
      status: 'error',
      httpStatus: 400,
      body: { error: 'assetClass is required', code: 'ASSET_CLASS_REQUIRED' },
    };
  }
  if (!VALID_ASSET_TYPES.includes(assetClassRaw as AssetType)) {
    return {
      status: 'error',
      httpStatus: 400,
      body: { error: `Unknown assetClass: ${assetClassRaw}` },
    };
  }
  if (!underwritingModeRaw) {
    return {
      status: 'error',
      httpStatus: 400,
      body: {
        error: 'underwritingMode is required (no implicit default)',
        code: 'UNDERWRITING_MODE_REQUIRED',
        validUnderwritingModes: VALID_UNDERWRITING_MODES,
      },
    };
  }
  if (!VALID_UNDERWRITING_MODES.includes(underwritingModeRaw as UnderwritingMode)) {
    return {
      status: 'error',
      httpStatus: 400,
      body: {
        error: `Unknown underwritingMode: ${underwritingModeRaw}`,
        code: 'UNDERWRITING_MODE_UNKNOWN',
        validUnderwritingModes: VALID_UNDERWRITING_MODES,
      },
    };
  }
  if (clientVersion !== null && Number.isNaN(clientVersion)) {
    return {
      status: 'error',
      httpStatus: 400,
      body: { error: 'clientContractVersion must be a positive integer' },
    };
  }
  if (clientVersion !== null && clientVersion > RENDER_CONTRACT_VERSION) {
    return {
      status: 'error',
      httpStatus: 409,
      body: {
        error: 'Workbook is newer than backend.',
        code: 'CLIENT_AHEAD_OF_BACKEND',
        clientContractVersion: clientVersion,
        backendContractVersion: RENDER_CONTRACT_VERSION,
      },
    };
  }

  // Unified-Read: resolve dealId for BOTH id formats via the shared resolver
  // (graph 64-hex → lineage root → latest revision's bridged legacy row;
  // legacy uuid → latest revision in lineage). The prior direct
  // store.getAnalysis(dealId) 404'd whenever the deal was viewed via its 64-hex
  // graph id (Sunroad's lineage root 3454c89f… — the banked sibling of the
  // download-memo bug). Malformed ids surface as the existing 400 shape.
  let stored;
  try {
    stored = resolveAnalysisForRead(dealId, recordGraphStore, store);
  } catch (err) {
    if (err instanceof MalformedAnalysisIdError) {
      return {
        status: 'error',
        httpStatus: 400,
        body: { error: err.message, code: 'MALFORMED_ANALYSIS_ID' },
      };
    }
    throw err;
  }
  if (!stored) {
    return {
      status: 'error',
      httpStatus: 404,
      body: { error: `No analysis found for dealId=${dealId}` },
    };
  }
  // Read-time projection: promoted-from-graph records have uwModel=null in the
  // stored row. projectLegacyAnalysisFromGraph synthesizes one from the graph
  // substrate (AdjustedInputs + StressOutputs + PropertyMetadata) when the
  // record carries a graphRevisionId. Legacy records (no graphRevisionId) pass
  // through unchanged. With the synthesized model present, the requireUwModel
  // gate below passes on its own — the gate is intentionally NOT lifted.
  const analysis = projectLegacyAnalysisFromGraph(stored, recordGraphStore);
  if (requireUwModel && !analysis.uwModel) {
    return {
      status: 'error',
      httpStatus: 409,
      body: {
        error: 'Analysis has not produced an underwriting model yet.',
        status: analysis.status,
        currentStep: analysis.currentStep,
      },
    };
  }

  const adjustedInputs = adaptAnalysisToAdjustedInputs(analysis);
  if (!adjustedInputs) {
    return {
      status: 'error',
      httpStatus: 409,
      body: { error: 'Could not adapt analysis to AdjustedInputs.' },
    };
  }

  const assetClass = assetClassRaw as AssetType;
  const underwritingMode = underwritingModeRaw as UnderwritingMode;

  let structuralVariantKey: StructuralVariantKey;
  try {
    if (variantKeyRaw) {
      const k = variantKeyRaw as StructuralVariantKey;
      assertVariantRegistered(assetClass, k, targetContractVersion);
      structuralVariantKey = k;
    } else {
      structuralVariantKey = resolveStructuralVariant(
        assetClass,
        adjustedInputs,
        {},
        targetContractVersion,
      );
    }
    assertUnderwritingModeRegistered(
      assetClass,
      structuralVariantKey,
      underwritingMode,
      targetContractVersion,
    );
  } catch (err) {
    if (err instanceof RenderSchemaError) {
      return {
        status: 'error',
        httpStatus: 400,
        body: { error: err.message, code: err.code, details: err.details },
      };
    }
    throw err;
  }

  // v10 schema: per-tenant Rent Roll rows + the RRP toggle on Property & Loan
  // Summary!AA3 read from RenderInput.rentRoll. Resolve via the same three-
  // call chain bp-spire uses: revision envelope → doctrine evaluation →
  // RentRoll. null when the deal has no rent roll (DoctrineEvaluation.rentRollId
  // is null and HY3 surfaced null in the bundle) — honest-blank flows from
  // the v10 selectors with no additional handling.
  const envelopeForRR = analysis.graphRevisionId
    ? recordGraphStore.getRevisionEnvelope(analysis.graphRevisionId as RevisionId)
    : null;
  const doctrineForRR = envelopeForRR
    ? recordGraphStore.getDoctrineEvaluation(envelopeForRR.doctrineEvaluationId)
    : null;
  const rentRoll = doctrineForRR?.rentRollId
    ? recordGraphStore.getRentRoll(doctrineForRR.rentRollId)
    : null;

  const underwritingContext = hydrateUnderwritingContext({
    analysis,
    adjustedInputs,
    mode: underwritingMode,
    // Physical-occupancy atoms (row 7) need the rent-roll SF.
    rentRoll,
  });

  // v25 — CMBS office-comps. Composed HERE (the only disk-access layer); the
  // pure engine reads RenderInput.compsTable / compsCommentary. Office only +
  // missing-corpus skip.
  // Subject CURRENT (in-place) physical occupancy off the appraisal extraction
  // (0..1 fraction; null when the deal has no appraisal record). The asset is in
  // active lease-up, so this differs materially from the 100% stabilized
  // securitization underwrite — needed for the PRESENT_BOTH occupancy line.
  const subjectCurrentOccupancy =
    typeof analysis.appraisalExtraction?.currentOccupancyPhysical === 'number' &&
    Number.isFinite(analysis.appraisalExtraction.currentOccupancyPhysical)
      ? analysis.appraisalExtraction.currentOccupancyPhysical
      : null;
  const composedComps =
    assetClass === 'office'
      ? composeCompsTable(underwritingContext, adjustedInputs, subjectCurrentOccupancy)
      : undefined;
  const compsTable = composedComps?.table;
  const compsCommentary = composedComps?.commentary;

  const renderInput: RenderInput = {
    meta: {
      dealId: analysis.id,
      dealName: analysis.name,
      generatedAt: new Date().toISOString(),
    },
    assetClass,
    structuralVariantKey,
    underwritingMode,
    adjustedInputs,
    underwritingContext,
    drivers: analysis.crossCheckFindings ?? [],
    conservatismStatus: buildConservatismStatus(analysis, adjustedInputs),
    libraryBaselineMeta: buildLibraryBaselineMeta(analysis),
    rentRoll,
    compsTable,
    compsCommentary,
  };

  let payload: RenderPayload;
  try {
    payload = buildRenderPayload(renderInput, {
      contractVersion: targetContractVersion,
      onProjected: ({ resolvedContext, cellBindings, payload: built }) => {
        // Best-effort observability. Wrapped in try/catch by render.service.ts;
        // any throw here is also caught by the surrounding code path. NEVER
        // mutates inputs. NEVER blocks the export.
        try {
          const event = buildObservabilityEvent({
            analysisId: analysis.id,
            analysis,
            adjustedInputs,
            resolvedContext,
            cellBindings,
            contractVersion: built.contractVersion,
            assetClass: built.assetClass,
            variantKey: built.structuralVariantKey,
            mode: built.underwritingMode,
            generatedAt: built.generatedAt,
          });
          if (event) {
            emitObservabilityEvent(event);
            persistObservabilityEvent(store.rawDb(), event);
          }
        } catch (err) {
          console.error('[observability] route hook error (swallowed):', (err as Error)?.message);
        }
      },
    });
  } catch (err) {
    if (err instanceof RenderSchemaError) {
      return {
        status: 'error',
        httpStatus: 500,
        body: { error: err.message, code: err.code, details: err.details },
      };
    }
    throw err;
  }
  if (clientVersion !== null && clientVersion < payload.contractVersion) {
    payload.migrationsFromClient = getMigrationManifest(clientVersion, payload.contractVersion);
  }

  // v19 Document-Completeness Ledger — downstream display layer. Reads the
  // projected cellBindings + this deal's sourceDocuments ∪ populated overlays,
  // and fills the 3 schema-declared sentinel cells (A55-A57) with the section
  // text. Pure display: mutates only those cells, never an underwriting value,
  // never feeds projection. Swallowed like the observability hook — a ledger
  // failure must never block the export (the cells degrade to blank sentinels).
  try {
    const erForDocs = doctrineForRR
      ? recordGraphStore.getExtractionResult(doctrineForRR.extractionResultId)
      : null;
    const sourceDocumentKinds = (erForDocs?.sourceDocuments ?? []).map((d) => d.kind);
    applyDocumentCompletenessDisplay(payload, {
      sourceDocumentKinds,
      overlayPresence: {
        t12Extraction: !!analysis.t12Extraction,
        issuerUwExtraction: !!analysis.issuerUwExtraction,
        sourcesAndUses: !!analysis.sourcesAndUses,
        pcaExtraction: !!analysis.pcaExtraction,
        partiesExtraction: !!analysis.partiesExtraction,
        appraisalExtraction: !!analysis.appraisalExtraction,
      },
    });
  } catch (err) {
    console.error('[doc-completeness] display fill error (swallowed):', (err as Error)?.message);
  }

  // Phase 2 — servicer narrative notes (site visit, broker feedback) — DISPLAY-ONLY.
  // Each filled note flows into ITS OWN cell (the 'hitl' scaffold anticipates one per
  // field: site visit → Site Inspection, broker → Market); empty → NO injection (the
  // tab stays in its existing blank state, byte-identical). Pure display: mutates only
  // those cells, never an underwriting value, never feeds projection. Swallowed like
  // the doc-completeness fill — a failure must never block the export.
  try {
    for (const cell of servicerInputWorkbookCells(analysis.graphRevisionId)) {
      payload.cellBindings[cell.address] = cell.value;
    }
  } catch (err) {
    console.error('[servicer-inputs] display fill error (swallowed):', (err as Error)?.message);
  }

  return { status: 'ok', payload, analysis, assetClass, structuralVariantKey, underwritingMode };
}

renderRoutes.get('/render', (req: Request, res: Response) => {
  const result = composeRenderPayloadFromQuery(req);
  if (result.status === 'error') {
    res.status(result.httpStatus).json(result.body);
    return;
  }
  res.json(result.payload);
});

/**
 * GET /api/underwriting/export
 *   ?dealId=...&assetClass=...&structuralVariantKey=...
 *   &profile=bank|bp_spire&templateType=single_loan|roll_up
 *
 * The single, canonical Excel export pipeline. Both the "Bank Underwriter"
 * and "BP Spire Underwriter" buttons MUST converge here; they differ only in
 * the `profile` (input configuration) and the resulting filename. There is
 * NO separate render or analysis path for BP Spire — it is the same system
 * with different input configuration.
 *
 * Mandatory pipeline (memory/architecture_render_versioning.md):
 *   1. resolveRenderPayload()              — composeRenderPayloadFromQuery
 *   2. loadActiveTemplate(templateType)    — store.getActiveTemplate
 *   3. validateTemplateCompatibility()     — code-declared envelope check
 *   4. assertTemplateCanSatisfySchema()    — workbook ↔ schema binding check
 *   5. applyRenderPayloadToTemplate()      — write values, hide tabs, tables
 *   6. stream .xlsx
 *
 * Failures at steps 3 or 4 abort the export with HTTP 409. There is no
 * partial rendering, no fallback template selection, and no auto-patching
 * of missing sheets / ranges / tables.
 */
const VALID_PROFILES = ['bank', 'bp_spire'] as const;
type ExportProfile = (typeof VALID_PROFILES)[number];
const VALID_TEMPLATE_TYPES: TemplateType[] = ['single_loan', 'roll_up'];

renderRoutes.get('/export', async (req: Request, res: Response) => {
  const profileRaw = req.query.profile ? String(req.query.profile).trim() : '';
  if (!profileRaw || !VALID_PROFILES.includes(profileRaw as ExportProfile)) {
    res.status(400).json({
      error: `profile is required and must be one of: ${VALID_PROFILES.join(', ')}`,
      code: 'EXPORT_PROFILE_REQUIRED',
    });
    return;
  }
  const profile = profileRaw as ExportProfile;

  const templateTypeRaw = req.query.templateType
    ? String(req.query.templateType).trim()
    : 'single_loan';
  if (!VALID_TEMPLATE_TYPES.includes(templateTypeRaw as TemplateType)) {
    res.status(400).json({
      error: `Unknown templateType: ${templateTypeRaw}`,
      code: 'TEMPLATE_TYPE_UNKNOWN',
    });
    return;
  }
  const templateType = templateTypeRaw as TemplateType;

  // ── PORTFOLIO DISPATCH (ADDITIVE) ────────────────────────────────────────
  // roll_up mode AND the resolved deal carries extractionResult.properties
  // (N>1) → compose the proven portfolio workbook (N per-property leaf tabs +
  // 4 roll-up tabs) and stream it. ELSE → fall through to the EXISTING single-
  // property pipeline below, byte-unchanged. This is the ONE additive branch;
  // it fires BEFORE the template-registry lookup because the portfolio render
  // composes from the on-disk template directly (no roll_up artifact / no
  // schema-key coupling). A single-property deal never enters here (the helper
  // returns null unless mode==='roll_up' AND properties present). Malformed ids
  // surface the SAME 400 as the existing path.
  {
    const dealIdForDispatch = String(req.query.dealId ?? '').trim();
    const underwritingModeForDispatch = req.query.underwritingMode
      ? String(req.query.underwritingMode).trim()
      : '';
    let portfolio;
    try {
      portfolio = await resolvePortfolioExport({
        dealId: dealIdForDispatch,
        underwritingMode: underwritingModeForDispatch,
        recordGraphStore,
        store,
      });
    } catch (err) {
      if (err instanceof MalformedAnalysisIdError) {
        res.status(400).json({ error: err.message, code: 'MALFORMED_ANALYSIS_ID' });
        return;
      }
      throw err;
    }
    if (portfolio) {
      const safeName =
        portfolio.analysisName.replace(/[^a-zA-Z0-9_\- ]/g, '').substring(0, 60).trim() ||
        'Portfolio';
      const profileLabel = profile === 'bank' ? 'Bank' : 'BPSpire';
      const fileName = `${profileLabel}_UW_${safeName}.xlsx`;
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      res.setHeader('X-Underwriting-Mode', 'roll_up');
      res.setHeader('X-Export-Profile', profile);
      res.setHeader('X-Template-Type', 'roll_up');
      res.setHeader('X-Portfolio-Property-Count', String(portfolio.components.length));
      res.setHeader(
        'X-Portfolio-Sheets',
        `${portfolio.workbook.leafSheetNames.length}leaf+${portfolio.workbook.rollUpSheetNames.length}rollup`,
      );
      res.send(portfolio.workbook.buffer);
      return;
    }
  }

  // Step 1 — load active template artifact. Pulled before payload composition
  // so we can render at the template's compatibleContractVersion. The
  // template registry is the SINGLE compatibility source — schema slice for
  // that version is the only thing the payload pipeline reads.
  const template = store.getActiveTemplate(templateType);
  if (!template) {
    res.status(409).json({
      error: `No active underwriting template of type "${templateType}". Upload one in Underwriting Insights → Templates before exporting.`,
      code: 'TEMPLATE_NOT_FOUND',
    });
    return;
  }
  if (!template.templateMetadata) {
    res.status(409).json({
      error: `Active ${templateType} template (v${template.version}) is not registered in the template registry. Refusing to export — register the artifact in template-registry.ts before use.`,
      code: 'TEMPLATE_NOT_REGISTERED',
      details: {
        templateType,
        templateVersion: template.version,
        templateId: template.id,
      },
    });
    return;
  }

  // Step 2 — resolve RenderPayload at the template's contract version.
  const result = composeRenderPayloadFromQuery(req, {
    contractVersion: template.templateMetadata.compatibleContractVersion,
  });
  if (result.status === 'error') {
    res.status(result.httpStatus).json(result.body);
    return;
  }

  // Step 3 — code-declared compatibility envelope (BLOCKING).
  try {
    validateTemplateCompatibility(template.templateMetadata, result.payload);
  } catch (err) {
    if (err instanceof TemplateIntegrityError) {
      res.status(409).json({ error: err.message, code: err.code, details: err.details });
      return;
    }
    throw err;
  }

  // Step 4 — workbook ↔ schema binding (BLOCKING). Verifies every schema
  // address resolves to a real Excel target and every visible tab / table
  // sheet exists in the artifact. Pure read; no mutations.
  try {
    await assertTemplateCanSatisfySchema(template.fileData, result.payload);
  } catch (err) {
    if (err instanceof TemplateIntegrityError) {
      res.status(409).json({ error: err.message, code: err.code, details: err.details });
      return;
    }
    throw err;
  }

  // Step 5 — apply the payload. Pre-validated; failures here are unexpected.
  let applied;
  try {
    applied = await applyRenderPayloadToTemplate(template.fileData, result.payload);
  } catch (err: any) {
    res.status(500).json({
      error: err?.message || 'Failed to apply RenderPayload to template',
      code: 'EXPORT_RENDER_FAILED',
    });
    return;
  }

  // Step 6 — stream .xlsx.
  const safeName = result.analysis.name.replace(/[^a-zA-Z0-9_\- ]/g, '').substring(0, 60).trim() || 'Underwriting';
  const profileLabel = profile === 'bank' ? 'Bank' : 'BPSpire';
  const fileName = `${profileLabel}_UW_${safeName}.xlsx`;

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('X-Render-Contract-Version', String(result.payload.contractVersion));
  res.setHeader('X-Structural-Variant-Key', result.payload.structuralVariantKey);
  res.setHeader('X-Underwriting-Mode', result.payload.underwritingMode);
  res.setHeader('X-Export-Profile', profile);
  res.setHeader('X-Template-Type', templateType);
  res.setHeader('X-Template-Version', String(template.templateMetadata.templateVersion));
  res.setHeader('X-Render-Bindings-Written', String(applied.writtenAddresses.length));
  res.setHeader('X-Render-Bindings-Unresolved', String(applied.unresolvedAddresses.length));

  // Export-time observability log (per debug requirement §5). One line per
  // export. resolvedContextHits + adjustedInputsHits + emptyCellCount
  // computed from the final payload's cellBindings.
  try {
    const bindings = result.payload.cellBindings;
    let emptyCellCount = 0;
    for (const v of Object.values(bindings)) {
      if (v === null || v === '' || v === undefined) emptyCellCount++;
    }
    let resolvedContextHits = 0;
    let adjustedInputsHits = 0;
    for (const addr of Object.keys(bindings)) {
      const sources = getSchemaSourcesByAddress(
        result.payload.assetClass,
        result.payload.structuralVariantKey,
        result.payload.underwritingMode,
        result.payload.contractVersion,
      ).get(addr);
      const src = sources && sources.size ? [...sources][0] : null;
      if (src === 'resolvedContext') resolvedContextHits++;
      else if (src === 'adjustedInputs') adjustedInputsHits++;
    }
    process.stdout.write(JSON.stringify({
      kind: 'EXPORT_OBSERVABILITY',
      analysisId: result.analysis.id,
      contractVersion: result.payload.contractVersion,
      assetClass: result.payload.assetClass,
      mode: result.payload.underwritingMode,
      totalCells: Object.keys(bindings).length,
      resolvedContextHits,
      adjustedInputsHits,
      emptyCellCount,
    }) + '\n');
  } catch (err) {
    console.error('[export] observability log skipped:', (err as Error)?.message);
  }

  res.send(applied.populatedBuffer);
});

/**
 * GET /api/underwriting/render-config — static asset-class → variant → tabs
 * AND the canonical address set per (asset class, variant). Lets the workbook
 * hydrate its hidden _Config sheet AND run integrity validation on
 * Workbook_Open without needing a deal.
 */
renderRoutes.get('/render-config', (req: Request, res: Response) => {
  const clientVersion = parseClientVersion(req);
  if (clientVersion !== null && Number.isNaN(clientVersion)) {
    res.status(400).json({ error: 'clientContractVersion must be a positive integer' });
    return;
  }
  if (clientVersion !== null && clientVersion > RENDER_CONTRACT_VERSION) {
    res.status(409).json({
      error: 'Workbook is newer than backend.',
      code: 'CLIENT_AHEAD_OF_BACKEND',
      clientContractVersion: clientVersion,
      backendContractVersion: RENDER_CONTRACT_VERSION,
    });
    return;
  }

  const assetClassVariantModeTabs = getAssetClassVariantModeTabs();
  const variantsByAssetClass: Record<string, StructuralVariantKey[]> = {};
  // Deterministic per-asset-class default: the alphabetically-first registered
  // variant. Workbook reads this on assetClass change; it MUST NOT infer.
  const assetClassVariantDefaults: Record<string, StructuralVariantKey> = {};
  const modesByAssetClassVariant: Record<
    string,
    Record<string, UnderwritingMode[]>
  > = {};
  const addressesByAssetClassVariantMode: Record<
    string,
    Record<string, Record<string, string[]>>
  > = {};
  const managedNamespaceByAssetClassVariantMode: Record<
    string,
    Record<string, Record<string, ReturnType<typeof getManagedNamespace>>>
  > = {};
  for (const ac of Object.keys(assetClassVariantModeTabs) as AssetType[]) {
    const variantKeys = getVariantsForAssetClass(ac);
    variantsByAssetClass[ac] = variantKeys;
    assetClassVariantDefaults[ac] = variantKeys[0];
    modesByAssetClassVariant[ac] = {};
    addressesByAssetClassVariantMode[ac] = {};
    managedNamespaceByAssetClassVariantMode[ac] = {};
    for (const vk of variantKeys) {
      const modes = getModesForVariant(ac, vk);
      modesByAssetClassVariant[ac][vk] = modes;
      addressesByAssetClassVariantMode[ac][vk] = {};
      managedNamespaceByAssetClassVariantMode[ac][vk] = {};
      for (const mode of modes) {
        addressesByAssetClassVariantMode[ac][vk][mode] = getSchemaAddresses(ac, vk, mode);
        managedNamespaceByAssetClassVariantMode[ac][vk][mode] = getManagedNamespace(ac, vk, mode);
      }
    }
  }
  let migrationsFromClient: MigrationManifest | undefined;
  try {
    if (clientVersion !== null && clientVersion < RENDER_CONTRACT_VERSION) {
      migrationsFromClient = getMigrationManifest(clientVersion);
    }
  } catch (err) {
    if (err instanceof RenderSchemaError) {
      res.status(400).json({ error: err.message, code: err.code, details: err.details });
      return;
    }
    throw err;
  }

  res.json({
    contractVersion: RENDER_CONTRACT_VERSION,
    assetClassVariantModeTabs,
    variantsByAssetClass,
    assetClassVariantDefaults,
    modesByAssetClassVariant,
    addressesByAssetClassVariantMode,
    managedNamespaceByAssetClassVariantMode,
    migrationsFromClient,
  });
});

/**
 * GET /api/underwriting/render-migrations?fromVersion=N
 *
 * Returns the migration chain from `fromVersion` to current. Used by tools
 * and CI to verify deployed workbooks are compatible. If `fromVersion` is
 * omitted, returns the entire migration history.
 */
renderRoutes.get('/render-migrations', (req: Request, res: Response) => {
  const raw = req.query.fromVersion;
  if (raw === undefined || raw === '') {
    res.json({
      contractVersion: RENDER_CONTRACT_VERSION,
      all: getAllMigrations(),
    });
    return;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    res.status(400).json({ error: 'fromVersion must be a positive integer' });
    return;
  }
  try {
    res.json(getMigrationManifest(n));
  } catch (err) {
    if (err instanceof RenderSchemaError) {
      res.status(400).json({ error: err.message, code: err.code, details: err.details });
      return;
    }
    throw err;
  }
});

/**
 * GET /api/underwriting/migration-readiness?contractVersion=N&windowSize=M
 *
 * Field-by-field readiness verdict per the governance spec. Reads the last
 * `windowSize` events from underwriting_observability_log for the given
 * contractVersion and computes coverage / stability / fallback-pressure
 * against the per-group thresholds in field-migration-state.ts.
 *
 * Pure read. The response is the SOLE permitted basis for declaring a
 * state transition in FIELD_STATE_REGISTRY.
 */
renderRoutes.get('/migration-readiness', (req: Request, res: Response) => {
  const cvRaw = req.query.contractVersion;
  const cv = cvRaw === undefined || cvRaw === '' ? RENDER_CONTRACT_VERSION : Number(cvRaw);
  if (!Number.isInteger(cv) || cv < 1) {
    res.status(400).json({ error: 'contractVersion must be a positive integer' });
    return;
  }
  const winRaw = req.query.windowSize;
  const win = winRaw === undefined || winRaw === '' ? 200 : Number(winRaw);
  if (!Number.isInteger(win) || win < 1 || win > 10_000) {
    res.status(400).json({ error: 'windowSize must be an integer in [1, 10000]' });
    return;
  }
  try {
    const events = readObservabilityWindow(store.rawDb(), cv, win);
    const report = computeReadiness(events, cv);
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message, code: 'MIGRATION_READINESS_FAILED' });
  }
});
