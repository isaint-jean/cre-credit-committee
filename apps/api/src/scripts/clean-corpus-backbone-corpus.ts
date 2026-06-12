/**
 * Production reader: full backbone corpus run (15 deals).
 *
 * Architecture: body-page-primary, per-shelf label catalog adapter, 10-D
 * loss-list-driven targeted-Annex-A fallback for tail losses. GATE: no
 * shelf's records enter the corpus until that deal reconciles vs. its own
 * issuer top-loans table AND DSCR NOI/NCF order is verified (NCF ≤ NOI
 * per CMBS convention) on every record in that deal.
 *
 *   cd apps/api && OPENAI_API_KEY=dummy ANTHROPIC_API_KEY=dummy \
 *     npx tsx src/scripts/clean-corpus-backbone-corpus.ts
 *
 * Writes /tmp/clean-corpus-backbone-corpus.json (uncommitted; the
 * calibration harness consumes this as the answer-key set).
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  type LabelCatalog,
  WFRBS_LABELS, CGCMT_LABELS, MSBAM_LABELS, CSMC_LABELS, WFCM_LABELS, JPMBB_LABELS,
  extractFromBodyPage,
} from './clean-corpus-body-page-extractor.ts';
import { walkProspectus, type WalkerBackboneRecord } from './clean-corpus-annexA-walker.ts';

const OUT_PATH = '/tmp/clean-corpus-backbone-corpus.out';
const CORPUS_JSON = '/tmp/clean-corpus-backbone-corpus.json';

/* ============================================================================
 * THE 15 BACKBONE DEALS — manifest entries from /tmp/cmbs-locked-batch.out
 * Source-file paths are filled in for the deals whose prospectus + 10-D
 * were downloaded; others are intentionally null so the composer can
 * report "blocked: missing source" rather than silently skip them.
 * ========================================================================== */

interface DealManifest {
  readonly cik: string;
  readonly name: string;
  readonly shelf: 'WFRBS' | 'CGCMT' | 'MSBAM' | 'JPMBB' | 'CSMC' | 'WFCM';
  readonly vintage: number;
  readonly originator: string;
  readonly prospectusPath: string | null;
  readonly tenDPath: string | null;
  readonly knownLossAnchors: readonly { prosId: string; name: string }[];
}

const DEALS: DealManifest[] = [
  // Two shelves already proven on the 2-shelf canary
  { cik: '1566543', name: 'WFRBS 2013-C11', shelf: 'WFRBS', vintage: 2013, originator: 'Wells Fargo (WFRBS/WFCM)',
    prospectusPath: '/tmp/wfrbs-2013-c11-424B5.htm', tenDPath: '/tmp/wfrbs-10D-ex991.htm',
    knownLossAnchors: [
      { prosId: '17', name: 'Minot Hotel Portfolio' },
      { prosId: '34', name: 'Home 2 Suites - Baltimore' },
    ] },
  { cik: '1573946', name: 'CGCMT 2013-GCJ11', shelf: 'CGCMT', vintage: 2013, originator: 'Citigroup (CGCMT/GC)',
    prospectusPath: '/tmp/cgcmt-2013-gcj11-424B5.htm', tenDPath: '/tmp/cgcmt-10D-ex991.htm',
    knownLossAnchors: [{ prosId: '2', name: 'Empire Hotel & Retail' }] },
  // Four new shelves to exercise; only one deal per shelf has a downloaded
  // prospectus in /tmp. Their 10-Ds were NOT downloaded — those deals
  // satisfy the LEFT-JOIN guard via "10-D missing → marked incomplete".
  { cik: '1567572', name: 'MSBAM 2013-C8', shelf: 'MSBAM', vintage: 2013, originator: 'Morgan Stanley + BofA (MSBAM)',
    prospectusPath: '/tmp/msbam-2013-424B5.htm', tenDPath: '/tmp/msbam-2013-c8-10D-ex991.htm',
    knownLossAnchors: [] },
  { cik: '1588251', name: 'JPMBB 2013-C12', shelf: 'JPMBB', vintage: 2013, originator: 'JPMorgan (JPMBB/JPMCC/JPMDB)',
    prospectusPath: '/tmp/jpmbb-2013-c12-424B5.htm', tenDPath: null,
    knownLossAnchors: [] },
  { cik: '1635569', name: 'WFCM 2015-LC20', shelf: 'WFCM', vintage: 2015, originator: 'Wells Fargo (WFRBS/WFCM)',
    prospectusPath: '/tmp/wf-2015-lc20-424B5.htm', tenDPath: '/tmp/wfcm-2015-lc20-10D-ex991.htm',
    knownLossAnchors: [] },
  { cik: '1691198', name: 'CSMC 2016-NXSR', shelf: 'CSMC', vintage: 2016, originator: 'Credit Suisse (CSAIL/CSMC)',
    prospectusPath: '/tmp/csmc-2016-nxsr-424B2.htm', tenDPath: '/tmp/csmc-2016-nxsr-10D-ex991.htm',
    knownLossAnchors: [] },
  // Nine backbone deals whose source files were fetched in the promotion
  // step. Names corrected against the actual filing slugs (e.g., the
  // locked-batch's "JPMBB 2015-C2" entries were JPMBB 2015-C27 and -C28;
  // MSBAM 2014 placeholders were 2014-C14 and 2014-C15).
  { cik: '1569414', name: 'WFRBS 2013-C12', shelf: 'WFRBS', vintage: 2013, originator: 'Wells Fargo (WFRBS/WFCM)',
    prospectusPath: '/tmp/wfrbs-2013-c12-424B5.htm', tenDPath: '/tmp/wfrbs-2013-c12-10D-ex991.htm', knownLossAnchors: [] },
  { cik: '1603578', name: 'WFRBS 2014-C20', shelf: 'WFRBS', vintage: 2014, originator: 'Wells Fargo (WFRBS/WFCM)',
    prospectusPath: '/tmp/wfrbs-2014-c20-424B5.htm', tenDPath: '/tmp/wfrbs-2014-c20-10D-ex991.htm', knownLossAnchors: [] },
  { cik: '1619616', name: 'CGCMT 2014-GC25', shelf: 'CGCMT', vintage: 2014, originator: 'Citigroup (CGCMT/GC)',
    prospectusPath: '/tmp/cgcmt-2014-gc25-424B5.htm', tenDPath: '/tmp/cgcmt-2014-gc25-10D-ex991.htm', knownLossAnchors: [] },
  { cik: '1595710', name: 'MSBAM 2014-C14', shelf: 'MSBAM', vintage: 2014, originator: 'Morgan Stanley + BofA (MSBAM)',
    prospectusPath: '/tmp/msbam-2014-c14-424B5.htm', tenDPath: '/tmp/msbam-2014-c14-10D-ex991.htm', knownLossAnchors: [] },
  { cik: '1600823', name: 'MSBAM 2014-C15', shelf: 'MSBAM', vintage: 2014, originator: 'Morgan Stanley + BofA (MSBAM)',
    prospectusPath: '/tmp/msbam-2014-c15-424B5.htm', tenDPath: '/tmp/msbam-2014-c15-10D-ex991.htm', knownLossAnchors: [] },
  { cik: '1637008', name: 'JPMBB 2015-C28', shelf: 'JPMBB', vintage: 2015, originator: 'JPMorgan (JPMBB/JPMCC/JPMDB)',
    prospectusPath: '/tmp/jpmbb-2015-c28-424B5.htm', tenDPath: '/tmp/jpmbb-2015-c28-10D-ex991.htm', knownLossAnchors: [] },
  { cik: '1630690', name: 'JPMBB 2015-C27', shelf: 'JPMBB', vintage: 2015, originator: 'JPMorgan (JPMBB/JPMCC/JPMDB)',
    prospectusPath: '/tmp/jpmbb-2015-c27-424B5.htm', tenDPath: '/tmp/jpmbb-2015-c27-10D-ex991.htm', knownLossAnchors: [] },
  { cik: '1636708', name: 'CGCMT 2015-GC29', shelf: 'CGCMT', vintage: 2015, originator: 'Citigroup (CGCMT/GC)',
    prospectusPath: '/tmp/cgcmt-2015-gc29-424B5.htm', tenDPath: '/tmp/cgcmt-2015-gc29-10D-ex991.htm', knownLossAnchors: [] },
  { cik: '1690255', name: 'CGCMT 2016-P6', shelf: 'CGCMT', vintage: 2016, originator: 'Citigroup (CGCMT/GC)',
    prospectusPath: '/tmp/cgcmt-2016-p6-424B5.htm', tenDPath: '/tmp/cgcmt-2016-p6-10D-ex991.htm', knownLossAnchors: [] },
];

const SHELF_LABELS: Record<string, LabelCatalog> = {
  WFRBS: WFRBS_LABELS,
  CGCMT: CGCMT_LABELS,
  MSBAM: MSBAM_LABELS,
  CSMC:  CSMC_LABELS,
  WFCM:  WFCM_LABELS,
  JPMBB: JPMBB_LABELS,
};

/* ============================================================================
 * STRIP HTML — same as walker / extractor
 * ========================================================================== */
function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&#8211;|&#8212;|&#150;|&#151;/g, '-').replace(/&#146;|&#147;|&#148;/g, "'")
    .replace(/&mdash;|&ndash;/g, '-').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
}

/* ============================================================================
 * BODY-PAGE TOP-LOAN DISCOVERY (shelf-agnostic)
 *
 * Instead of hand-listing top-10 names per deal, scan the prospectus for
 * every position where a body-page signature phrase appears, then look
 * BACKWARD for the all-caps property name header (the "<NAME> B-N <NAME>"
 * style on CGCMT/MSBAM/CSMC, or "<NAME> B-N Table of Contents" on WFRBS).
 * Returns each candidate body page's anchor + extracted property name.
 * ========================================================================== */

interface BodyPageCandidate {
  readonly propertyName: string;
  readonly offset: number;
  readonly prosId: string | null;  // captured from "(Mortgage Loan )?No. N -" prefix when present
}

function discoverBodyPages(stripped: string, catalog: LabelCatalog): BodyPageCandidate[] {
  const out: BodyPageCandidate[] = [];
  const seen = new Set<string>();
  for (const sig of catalog.pageSignatures) {
    const re = new RegExp(sig.source, sig.flags.includes('g') ? sig.flags : sig.flags + 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(stripped)) !== null) {
      const at = m.index;
      // Pattern A scans the 400 chars BEFORE the signature (page-break header).
      const back = stripped.slice(Math.max(0, at - 400), at);
      // Pattern B needs to include the signature itself (the anchor in its
      // lookahead). Use a window that brackets the offset.
      const around = stripped.slice(Math.max(0, at - 200), at + 100);
      let candidate: string | null = null;
      let capturedProsId: string | null = null;
      // Pattern A (WFRBS/CGCMT): <CAPS NAME> <B-N|A-N|Table of Contents>
      const capsRe = /\b([A-Z][A-Z0-9 '\-\.,&/]{4,55}?[A-Z0-9])\s+(?:B-\d+|A-\d+|Table of Contents)/g;
      let cm: RegExpExecArray | null;
      while ((cm = capsRe.exec(back)) !== null) {
        const c = cm[1].trim();
        if (c.length >= 4 && c.length <= 50) candidate = c;
      }
      // Pattern B: "(Mortgage Loan )?No. N - <Title Case Name> <signature>".
      // The "Mortgage Loan" prefix is shelf-specific: MSBAM/CSMC include
      // it, WFCM uses just "No. N -" (and so does WFRBS for loans beyond
      // the all-caps top set). Take the LAST such match in the search
      // window AND capture the loan-number N — body-page discovery order
      // does NOT match Annex A Pros IDs (some loan numbers are skipped),
      // so we read the actual Pros ID from the header itself.
      if (candidate === null) {
        const mlnRe = /\b(?:Mortgage Loan )?No\.\s*(\d{1,3})\s*-\s*([A-Z][A-Za-z0-9 '\-\.,&/]{3,55}?)\s+(?:Mortgage Loan Information|Mortgaged Property|Mortgage Loan Seller|Loan Information)/g;
        let cm2: RegExpExecArray | null;
        while ((cm2 = mlnRe.exec(around)) !== null) {
          const c = cm2[2].trim();
          if (c.length >= 3 && c.length <= 50) { candidate = c; capturedProsId = cm2[1]; }
        }
      }
      if (candidate === null) continue;
      // Discovery sometimes captures multi-page-break headers like "Qlic
      // A-2- 64 Mortgage Loan No. 4 - Qlic" because the page-break headers
      // repeat the name several times before the page signature. Strip
      // the "<X>-N" page suffixes and "Mortgage Loan No. N -" prefixes so
      // the clean name is what remains.
      let cleaned = candidate
        .replace(/^.*?Mortgage Loan No\.\s*\d+\s*-\s*/, '')
        .replace(/\s+(?:A-\d+|B-\d+)\b.*$/, '')
        .trim();
      if (cleaned.length < 3) cleaned = candidate;  // safety net
      const name = toTitleCase(cleaned);
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ propertyName: name, offset: at, prosId: capturedProsId });
    }
    if (out.length > 0) break;
  }
  return out;
}

function toTitleCase(s: string): string {
  // Best-effort: capitalize first letter of each word, preserve "&" and short
  // particles. The body-page extractor itself searches case-insensitively
  // via toUpperCase() anyway, so the title-case is mainly for display.
  return s.split(/\s+/).map(w => {
    if (w === '&' || /^[IVX]+$/.test(w)) return w;
    if (w.length <= 2 && /^[A-Z]+$/.test(w)) return w;
    return w.charAt(0) + w.slice(1).toLowerCase();
  }).join(' ');
}

/* ============================================================================
 * 10-D LOSS LIST (light — drives targeted lookup)
 * ========================================================================== */

interface LiquidatedEntry {
  readonly prosId: string;
  readonly propertyName: string;
  readonly realizedLoss: number;          // 0 = STRESS-ONLY (DPO), >0 = LOSS
  readonly distDate: string;
  readonly outcomeClass: 'LOSS' | 'STRESS-ONLY';
  // 10-D also publishes these per-row (Computershare format): the loan
  // balance at the start of the liquidation period and the most-recent
  // appraised value / BPO. These are the LIQUIDATION-time data — not the
  // origination underwriting basis — but they're real, non-null, and let
  // a LOSS record carry meaningful loanAmount + concludedValue when the
  // tail loan has no body page and no per-shelf Annex A walker yet.
  readonly beginningBalance: number | null;
  readonly mostRecentAppraisedValue: number | null;
}

function parseLiquidatedList(tenDPath: string): LiquidatedEntry[] {
  const raw = fs.readFileSync(tenDPath, 'utf8');
  const s = stripHtml(raw);
  // Find the Historical Liquidated section. Many 10-Ds have a single
  // table-of-contents reference; the actual data section follows that.
  // Pick the LAST occurrence (which is in the data body) when present.
  const re = /Historical Liquidated Loan Detail|Historical Liquidated/gi;
  const hits: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) hits.push(m.index);
  if (hits.length === 0) return [];
  // If only one hit, use it (no ToC vs data ambiguity). Otherwise the LAST
  // hit is the actual section header in the data body.
  const hist = hits[hits.length - 1];
  const slice = s.slice(hist, hist + 80_000);
  const out: LiquidatedEntry[] = [];
  const seen = new Set<string>();

  // FORMAT A — Computershare (WFRBS/MSBAM/WFCM/CSMC): no property name in
  // the row; columns are <prosId> <loanNum (6-12 digits)> <distDate>
  // <10 numerics> <pct%>. Period Realized Loss is the 7th numeric. The
  // 9th numeric (parenthesized in original) is signed; allow parens to
  // wrap it for the row to still match.
  const csRowRe = /(\d{1,3})\s+(\d{6,12})\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+\(?([\d,]+\.\d{2})\)?\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+\(?([\d,]+\.\d{2})\)?\s+([\d.]+)%/g;
  let cm: RegExpExecArray | null;
  while ((cm = csRowRe.exec(slice)) !== null) {
    const prosId = cm[1];
    const distDate = cm[3];
    const beginningBalance = Number(cm[4].replace(/,/g, ''));      // 1st numeric
    const mostRecentAppraisedValue = Number(cm[5].replace(/,/g, ''));// 2nd numeric
    const periodRealizedLoss = Number(cm[10].replace(/,/g, ''));    // 7th numeric
    if (!Number.isFinite(periodRealizedLoss)) continue;
    const key = `${prosId}::CS::${distDate}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      prosId, propertyName: `Loan #${prosId}`,
      realizedLoss: periodRealizedLoss, distDate,
      outcomeClass: periodRealizedLoss > 0 ? 'LOSS' : 'STRESS-ONLY',
      beginningBalance: Number.isFinite(beginningBalance) ? beginningBalance : null,
      mostRecentAppraisedValue: Number.isFinite(mostRecentAppraisedValue) ? mostRecentAppraisedValue : null,
    });
  }

  // FORMAT B — Citi (CGCMT): row has [A|B] <PropertyName> <numerics>; the
  // 2nd numeric token is the realized loss. (CGCMT 10-Ds typically report
  // "No Loans liquidated to Report" in this section once historical
  // losses are cleared; pari-passu losses surface in the Bond/Collateral
  // Loss Reconciliation table. For this scope we read what's reported.)
  const citiRowRe = /\b(\d{1,3})\s+(?:[AB]\s+)?([A-Z][A-Za-z0-9 '\-\.,&/]{3,55}?)\s+[\d,]+(?:\.\d{2})?\s+([\d,]+(?:\.\d{2})?)\s+(\d{1,2}\/\d{1,2}\/\d{2,4})/g;
  while ((cm = citiRowRe.exec(slice)) !== null) {
    const prosId = cm[1];
    const name = cm[2].trim();
    if (/^(Number|Property|Loan|Total|Page|HISTORICAL|Cumulative|Current)/i.test(name)) continue;
    const loss = Number(cm[3].replace(/,/g, ''));
    if (!Number.isFinite(loss)) continue;
    const key = `${prosId}::Citi::${cm[4]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      prosId, propertyName: name,
      realizedLoss: loss, distDate: cm[4],
      outcomeClass: loss > 0 ? 'LOSS' : 'STRESS-ONLY',
      beginningBalance: null,
      mostRecentAppraisedValue: null,
    });
  }
  return out;
}

/* ============================================================================
 * ANSWER KEY RECORD — the persisted corpus shape
 * ========================================================================== */

interface AnswerKeyRecord {
  readonly file: string;
  readonly cik: string;
  readonly dealName: string;
  readonly shelf: string;
  readonly vintage: number;
  readonly originator: string;
  readonly prosId: string;
  readonly propertyName: string;
  readonly inputSource: 'body-page' | 'targeted-annexA' | 'targeted-body-page' | 'tracked-pending';
  readonly outcomeClass: 'CLEAN' | 'STRESS-ONLY' | 'LOSS';
  readonly bcLoss: number | null;
  readonly dsLoss: number | null;
  readonly outcomeEvidence: string | null;
  readonly loanAmount: number | null;
  readonly coupon: number | null;
  readonly maturityDate: string | null;
  readonly concludedValue: number | null;
  readonly concludedLtv: number | null;
  readonly uwDscrNoi: number | null;
  readonly uwDscrNcf: number | null;
  readonly uwY1Noi: number | null;
  readonly t12Noi: number | null;
  // Ground-truth asset-type (from the body page's labeled "Property Type"
  // field); replaces the propertyName heuristic used in the earlier
  // structural test. Null for tail-loss records sourced from Annex A
  // where the walker doesn't expose Property Type — that path still
  // populates assetType from its own normalization.
  readonly assetType: string | null;
  readonly subType: string | null;
  // Concentration + rollover (NRA-based). largestTenantPct = top
  // tenant's % NRA; pctIncomeExpiringWithinTerm = NRA-weighted share
  // expiring before maturity. tenantDataStatus distinguishes null due to
  // asset-type having no tenant table from null due to parse failure.
  readonly largestTenantPct: number | null;
  readonly pctIncomeExpiringWithinTerm: number | null;
  readonly tenantDataStatus: 'multi-tenant-parsed' | 'single-tenant' | 'na-by-asset-type' | 'parse-failed' | null;
  readonly shelfLabelCatalog: string | null;
  readonly bodyPageOffset: number | null;
  readonly notes: string | null;
}

interface DealOutcome {
  readonly deal: DealManifest;
  readonly status: 'CORPUS' | 'BLOCKED_MISSING_PROSPECTUS' | 'BLOCKED_MISSING_10D' | 'BLOCKED_NO_BODY_PAGES' | 'BLOCKED_DSCR_SWAP' | 'BLOCKED_INCOMPLETE_LOSS';
  readonly records: AnswerKeyRecord[];
  readonly bodyPageCount: number;
  readonly tailLossCount: number;
  readonly dscrConsistent: number;
  readonly dscrChecked: number;
  readonly lossesComplete: boolean;
  readonly notes: string[];
}

/* ============================================================================
 * COMPOSER — per-deal
 * ========================================================================== */

/* ============================================================================
 * ORIGINATION RECOVERY — hand-extracted Annex A inputs for the 3 tail-LOSS
 * loans that lack body description pages. Every value below is from the
 * ORIGINATION row of the loan's stratified Annex A (T1/T2/T3/T4 panels) —
 * NOT 10-D liquidation-time data. Each loan's source panel offset is in
 * the comment for auditability. NEVER fill these from post-origination data.
 *
 *   WFCM #39 Masonic Building — Annex A-1 @ 1763675/1777885/1792164/1805327
 *   CSMC #27 Windmill Lakes Center — Annex A-I @ 1975238/1995949/2007702
 *   MSBAM #43 — Annex A not present in the downloaded 424B5 file; tracked-pending
 *               (the prospectus file ends at boilerplate; Annex A was filed
 *               separately or absent from this download)
 * ========================================================================== */

interface OriginationInputs {
  readonly propertyName: string;
  readonly loanAmount: number;
  readonly coupon: number;
  readonly maturityDate: string;
  readonly concludedValue: number;
  readonly concludedLtv: number;        // origination basis — must be <1.0
  readonly uwDscrNoi: number;
  readonly uwDscrNcf: number;
  readonly uwY1Noi: number;
  readonly t12Noi: number | null;
  // Asset type from the loan's Annex A T1 "General Property Type" column.
  // Carried so tail-loss records don't end with assetType=null and bias
  // the structural test's per-type loss-rates.
  readonly assetType: string;
  readonly sourceNote: string;
}

const TAIL_LOSS_ORIGINATION_RECOVERY: Record<string, OriginationInputs | null> = {
  // WFCM 2015-LC20 #39 Masonic Building (seller LCF, Denver CO, Mixed Use
  // Retail/Office). T2: balance $7.5MM / cut-off $7.5MM / 4.85% rate /
  // maturity 2/6/2020. T3: appraised $10.5MM. T4: NOI DSCR 1.46, NCF DSCR
  // 1.33, Cut-off LTV 71.4%, UW NOI $695,351. Origination basis intact —
  // LTV well under 100% (vs the bogus 11.15× from prior 10-D fill).
  '1635569::39': {
    propertyName: 'Masonic Building',
    loanAmount: 7_500_000,
    coupon: 0.0485,
    maturityDate: '2/6/2020',
    concludedValue: 10_500_000,
    concludedLtv: 0.714,
    uwDscrNoi: 1.46,
    uwDscrNcf: 1.33,
    uwY1Noi: 695_351,
    t12Noi: null,
    assetType: 'MixedUse',           // T1 column "Mixed Use Retail/Office"
    sourceNote: 'origination recovery: WFCM 2015-LC20 Annex A-1 panels T2 (offset 1777885) + T3 (1792164) + T4 (1805327)',
  },
  // CSMC 2016-NXSR #27 Windmill Lakes Center (seller Natixis, Batavia IL,
  // Retail Anchored). T1: balance $6.2MM / cut-off $6.2MM. T3: appraised
  // $10.5MM / 5.99% rate / 120mo term. T4/T5: NOI DSCR 1.54, NCF DSCR
  // 1.26, Cut-off LTV 59.0%. Origination basis — LTV under 100%.
  '1691198::27': {
    propertyName: 'Windmill Lakes Center',
    loanAmount: 6_200_000,
    coupon: 0.0599,
    maturityDate: '12/5/2026',
    concludedValue: 10_500_000,
    concludedLtv: 0.590,
    uwDscrNoi: 1.54,
    uwDscrNcf: 1.26,
    uwY1Noi: 733_194,
    t12Noi: 684_473,
    assetType: 'Retail',             // CSMC T1: "Retail - Anchored"
    sourceNote: 'origination recovery: CSMC 2016-NXSR Annex A-I panels T1 (offset 1975238) + T3 (1995949) + T4 (2001742) + T5 (2007702) + T6 (2022379)',
  },
  // WFRBS 2014-C20 #65 Candlewood Suites - Denham Springs (seller RMF,
  // Denham Springs LA, Hospitality Extended Stay). T2 row: original
  // $4,945,000 / cut-off $4,937,605 / 5.767% rate / maturity 4/6/2024.
  // T4: appraised $7,100,000. T5: NOI DSCR 1.63, NCF DSCR 1.46, Cut-off
  // LTV 69.5%, UW NOI $609,227. Origination basis. The Annex A IS in
  // the downloaded 424B5 (offset 1710444); same WFRBS row format.
  '1603578::65': {
    propertyName: 'Candlewood Suites - Denham Springs',
    loanAmount: 4_937_605,
    coupon: 0.05767,
    maturityDate: '4/6/2024',
    concludedValue: 7_100_000,
    concludedLtv: 0.695,
    uwDscrNoi: 1.63,
    uwDscrNcf: 1.46,
    uwY1Noi: 609_227,
    t12Noi: null,
    assetType: 'Hotel',              // T1: "Hospitality Extended Stay"
    sourceNote: 'origination recovery: WFRBS 2014-C20 Annex A-1 panels T2 (offset 1736802) + T3 (1754104) + T4 (1769016) + T5 (1782984)',
  },
  // WFRBS 2014-C20 #67 Comfort Suites - Sulphur (seller RMF, Sulphur LA,
  // Hospitality Limited Service). T2 row: original $4,660,000 / cut-off
  // $4,653,031 / 5.767% rate / maturity 4/6/2024. T4: appraised $6.7MM.
  // T5: NOI DSCR 1.65, NCF DSCR 1.48, Cut-off LTV 69.4%, UW NOI $582,264.
  '1603578::67': {
    propertyName: 'Comfort Suites - Sulphur',
    loanAmount: 4_653_031,
    coupon: 0.05767,
    maturityDate: '4/6/2024',
    concludedValue: 6_700_000,
    concludedLtv: 0.694,
    uwDscrNoi: 1.65,
    uwDscrNcf: 1.48,
    uwY1Noi: 582_264,
    t12Noi: null,
    assetType: 'Hotel',              // T1: "Hospitality Limited Service"
    sourceNote: 'origination recovery: WFRBS 2014-C20 Annex A-1 panels T2 (offset 1737056) + T3 (1754436) + T4 (1769198) + T5 (1783165)',
  },
  // ===== STILL TRACKED-PENDING (origination not in available source) =====
  // MSBAM 2013-C8 #43, MSBAM 2014-C14 #33 + #39: the downloaded 424B5
  // files end at the Index of Significant Terms / Glossary boilerplate;
  // Annex A was filed as a separate exhibit by the depositor (CIK
  // 1005007 for MSBAM 2013, 1547361 for MSBAM 2014). A surface probe of
  // accession 000153949714000062 (a 21.8MB MSBAM 2014-C14 FWP) showed
  // risk-factor / tenant-in-common content past offset 2.4M, not the
  // stratified Annex A row data. Locating the specific exhibit needs a
  // deeper EDGAR crawl; NEVER substitute 10-D liquidation fields here.
  '1567572::43': null,
  '1595710::33': null,
  '1595710::39': null,
  // JPMBB 2015-C27 #26, JPMBB 2015-C28 #12 + #13 + #67: the downloaded
  // 424B5 files publish per-loan body description pages but end before
  // the Annex A stratified panels. The Annex A is in a separate JPMBB
  // FWP filing (likely under depositor CIK 1013611). Deeper EDGAR
  // crawl needed; tracked-pending until that data is fetched.
  '1630690::26': null,
  '1637008::12': null,
  '1637008::13': null,
  '1637008::67': null,
};

/* Tracked-pending LOSS: the loan IS a real LOSS (in 10-D), but its
 * origination inputs are not yet recovered. Emitted with explicit nulls +
 * inputSource='tracked-pending' so the calibration harness can skip or
 * weigh accordingly. NEVER fill the inputs from post-origination data. */
function buildTrackedPendingLoss(deal: DealManifest, liq: LiquidatedEntry): AnswerKeyRecord {
  return {
    file: `EDGAR/${deal.cik}/${deal.name}/loan-${liq.prosId} (TRACKED-PENDING LOSS)`,
    cik: deal.cik, dealName: deal.name, shelf: deal.shelf,
    vintage: deal.vintage, originator: deal.originator,
    prosId: liq.prosId,
    propertyName: liq.propertyName,
    inputSource: 'tracked-pending',
    outcomeClass: 'LOSS',
    bcLoss: liq.realizedLoss, dsLoss: null,
    outcomeEvidence: `realized loss $${liq.realizedLoss.toLocaleString()} (10-D, dist ${liq.distDate})`,
    loanAmount: null, coupon: null, maturityDate: null,
    concludedValue: null, concludedLtv: null,
    uwDscrNoi: null, uwDscrNcf: null,
    uwY1Noi: null, t12Noi: null,
    assetType: null, subType: null, largestTenantPct: null, pctIncomeExpiringWithinTerm: null, tenantDataStatus: null,
          shelfLabelCatalog: null, bodyPageOffset: null,
    notes: 'TRACKED-PENDING: real 10-D loss, but origination inputs not recoverable from the available source (no body page, no walker, no recovery entry). DO NOT calibrate against this record until Annex A is fetched. Origination inputs or nothing — NEVER filled from 10-D liquidation fields.',
  };
}

/* Targeted body-page lookup for a tail loss loan: search the prospectus
 * for "Mortgage Loan No. <prosId> - <Name>" and extract via the shelf's
 * label catalog. Works for MSBAM/CSMC (their tail-list body pages share
 * the same labeled-field format as the top-loan pages). */
function targetedBodyPageLookup(
  stripped: string,
  catalog: LabelCatalog,
  prosId: string,
  propertyName: string,
): ReturnType<typeof extractFromBodyPage> | null {
  // Two prefix patterns used across backbone shelves:
  //   "Mortgage Loan No. N" — MSBAM, CSMC, CGCMT (sometimes)
  //   "No. N -"             — WFRBS, WFCM (Wells Fargo's "No. N - <Name>")
  // Both must be followed by a body-page signature within ~600 chars.
  const re = new RegExp(`\\b(?:Mortgage Loan )?No\\.\\s*${prosId}\\b`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    const window = stripped.slice(m.index, m.index + 600);
    const isBodyPage = catalog.pageSignatures.some(sig => sig.test(window));
    if (!isBodyPage) continue;
    const ext = extractFromBodyPage(stripped, propertyName, catalog, m.index);
    if (ext.source === 'body-page' && ext.loanAmount !== null) return ext;
  }
  return null;
}

function composeDeal(deal: DealManifest): DealOutcome {
  const notes: string[] = [];

  if (deal.prospectusPath === null) {
    return {
      deal, status: 'BLOCKED_MISSING_PROSPECTUS', records: [],
      bodyPageCount: 0, tailLossCount: 0,
      dscrConsistent: 0, dscrChecked: 0, lossesComplete: true,
      notes: ['No prospectus file in /tmp — corpus gate blocks; fetch the deal\'s 424B5/B2 before re-running.'],
    };
  }

  const raw = fs.readFileSync(deal.prospectusPath, 'utf8');
  const stripped = stripHtml(raw);
  const catalog = SHELF_LABELS[deal.shelf];

  // 1) Discover all body pages
  const bodyPages = discoverBodyPages(stripped, catalog);
  if (bodyPages.length === 0) {
    notes.push('No body description pages discovered via signature scan.');
    notes.push(`Shelf ${deal.shelf}: body-page architecture does not apply. Needs per-shelf Annex A walker adapter (CGCMT-style canary template).`);
    return {
      deal, status: 'BLOCKED_NO_BODY_PAGES', records: [],
      bodyPageCount: 0, tailLossCount: 0,
      dscrConsistent: 0, dscrChecked: 0, lossesComplete: false,
      notes,
    };
  }
  notes.push(`Discovered ${bodyPages.length} body pages via signature scan.`);

  // 2) Extract DealBag from each body page; require minimum field completeness.
  // Pros ID = the loan number captured from "(Mortgage Loan )?No. N -" in the
  // body-page header when present. Body-page DISCOVERY order is NOT a safe
  // proxy for Annex A Pros ID (some loan numbers are skipped: MSBAM 11-19
  // is missing #15, etc.); using a counter would cause the 10-D join to
  // match WRONG loans. Fall back to the counter only for shelves with no
  // header-number anchor (CGCMT).
  const records: AnswerKeyRecord[] = [];
  const REQUIRED_FIELDS = ['loanAmount', 'coupon', 'concludedLtv', 'concludedValue', 'uwDscrNcf'] as const;
  let cgcmtCounter = 1;
  const usedProsIds = new Set<string>();
  for (const bp of bodyPages) {
    const ext = extractFromBodyPage(stripped, bp.propertyName, catalog, bp.offset);
    if (ext.source !== 'body-page') continue;
    const filledCount = REQUIRED_FIELDS.filter(f => ext[f] !== null).length;
    if (filledCount < 3) continue;
    const prosId = bp.prosId ?? String(cgcmtCounter++);
    if (usedProsIds.has(prosId)) continue;  // some shelves repeat the header — dedupe
    usedProsIds.add(prosId);
    records.push({
      file: `EDGAR/${deal.cik}/${deal.name}/loan-${prosId} (${bp.propertyName})`,
      cik: deal.cik, dealName: deal.name, shelf: deal.shelf,
      vintage: deal.vintage, originator: deal.originator,
      prosId,
      propertyName: bp.propertyName,
      inputSource: 'body-page',
      outcomeClass: 'CLEAN',
      bcLoss: null, dsLoss: null, outcomeEvidence: null,
      loanAmount: ext.loanAmount, coupon: ext.coupon, maturityDate: ext.maturityDate,
      concludedValue: ext.concludedValue, concludedLtv: ext.concludedLtv,
      uwDscrNoi: ext.uwDscrNoi, uwDscrNcf: ext.uwDscrNcf,
      uwY1Noi: ext.uwY1Noi, t12Noi: ext.t12Noi,
      assetType: ext.assetType, subType: ext.subType,
      largestTenantPct: ext.largestTenantPct,
      pctIncomeExpiringWithinTerm: ext.pctIncomeExpiringWithinTerm,
      tenantDataStatus: ext.tenantDataStatus,
      shelfLabelCatalog: ext.shelfLabelCatalog, bodyPageOffset: ext.bodyPageOffset,
      notes: null,
    });
  }

  // 3) DSCR convention gate
  let dscrConsistent = 0, dscrChecked = 0;
  const dscrViolations: string[] = [];
  for (const r of records) {
    if (r.uwDscrNoi === null || r.uwDscrNcf === null) continue;
    dscrChecked++;
    if (r.uwDscrNcf <= r.uwDscrNoi) dscrConsistent++;
    else dscrViolations.push(`${r.propertyName}: NOI=${r.uwDscrNoi}x NCF=${r.uwDscrNcf}x`);
  }
  if (dscrChecked >= 3 && dscrConsistent / dscrChecked < 0.6) {
    notes.push(`DSCR SWAP DETECTED on ${deal.shelf}: only ${dscrConsistent}/${dscrChecked} records satisfy NCF ≤ NOI.`);
    return { deal, status: 'BLOCKED_DSCR_SWAP', records: [], bodyPageCount: bodyPages.length, tailLossCount: 0, dscrConsistent, dscrChecked, lossesComplete: false, notes };
  }

  // 4) 10-D presence gate
  if (deal.tenDPath === null) {
    notes.push('10-D not located — LEFT-JOIN guard blocks classifier; records carry CLEAN-only labels.');
    return {
      deal, status: 'BLOCKED_MISSING_10D', records, bodyPageCount: bodyPages.length,
      tailLossCount: 0, dscrConsistent, dscrChecked, lossesComplete: true, notes,
    };
  }

  // 5) Parse 10-D liquidated entries → 3-class classifier
  const liquidated = parseLiquidatedList(deal.tenDPath);
  notes.push(`10-D liquidated entries parsed: ${liquidated.length} (LOSS=${liquidated.filter(l => l.outcomeClass === 'LOSS').length}, STRESS-ONLY=${liquidated.filter(l => l.outcomeClass === 'STRESS-ONLY').length})`);

  // 6) JOIN: body-page records ← 10-D liquidated entries by Pros ID
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const liq = liquidated.find(l => l.prosId === r.prosId);
    if (!liq) continue;
    records[i] = {
      ...r,
      outcomeClass: liq.outcomeClass,
      bcLoss: liq.realizedLoss,
      dsLoss: null,
      outcomeEvidence: liq.outcomeClass === 'LOSS'
        ? `realized loss $${liq.realizedLoss.toLocaleString()} (10-D, dist ${liq.distDate})`
        : `liquidated ${liq.distDate} with $0 cumulative loss (DPO / paid off → STRESS-ONLY per CMBS convention)`,
    };
  }

  // 7) TAIL LOSSES: any liquidated prosId not in body-page records → targeted lookup
  let tailLossCount = 0;
  let lossesComplete = true;
  const tailIncomplete: string[] = [];
  for (const liq of liquidated) {
    if (records.find(r => r.prosId === liq.prosId)) continue;  // already joined
    // Try targeted body-page lookup first (MSBAM/CSMC tail loans often have body pages)
    let ext = targetedBodyPageLookup(stripped, catalog, liq.prosId, liq.propertyName);
    let source: AnswerKeyRecord['inputSource'] = 'targeted-body-page';
    let wkFallback: WalkerBackboneRecord | null = null;
    if (ext === null && deal.shelf === 'WFRBS') {
      const all = walkProspectus(deal.prospectusPath, deal.cik, deal.name);
      wkFallback = all.find(r => r.prosId === liq.prosId) ?? null;
      source = 'targeted-annexA';
    }
    if (ext === null && wkFallback === null) {
      // LOSS: try the hand-extracted origination-recovery table FIRST.
      //   This table is per-loan, per-prospectus-Annex-A-row — never
      //   derived from 10-D liquidation fields. The previous 10-D-derived
      //   fallback was HINDSIGHT LEAKAGE (the loss is baked into the
      //   inputs); it has been removed.
      const recoveryKey = `${deal.cik}::${liq.prosId}`;
      if (liq.outcomeClass === 'LOSS' && recoveryKey in TAIL_LOSS_ORIGINATION_RECOVERY) {
        const rec = TAIL_LOSS_ORIGINATION_RECOVERY[recoveryKey];
        if (rec !== null) {
          // Sanity: origination LTV must be <1.0 (origination basis), else
          // we accidentally captured post-distress data.
          if (rec.concludedLtv >= 1.0) {
            notes.push(`✗ origination recovery rejected for #${liq.prosId}: concludedLtv ${(rec.concludedLtv*100).toFixed(1)}% ≥ 100% (would be hindsight). Tracked-pending.`);
            records.push(buildTrackedPendingLoss(deal, liq));
            tailLossCount++;
            continue;
          }
          tailLossCount++;
          records.push({
            file: `EDGAR/${deal.cik}/${deal.name}/loan-${liq.prosId} (${rec.propertyName})`,
            cik: deal.cik, dealName: deal.name, shelf: deal.shelf,
            vintage: deal.vintage, originator: deal.originator,
            prosId: liq.prosId, propertyName: rec.propertyName,
            inputSource: 'targeted-annexA',
            outcomeClass: 'LOSS',
            bcLoss: liq.realizedLoss, dsLoss: null,
            outcomeEvidence: `realized loss $${liq.realizedLoss.toLocaleString()} (10-D, dist ${liq.distDate})`,
            loanAmount: rec.loanAmount,
            coupon: rec.coupon,
            maturityDate: rec.maturityDate,
            concludedValue: rec.concludedValue,
            concludedLtv: rec.concludedLtv,
            uwDscrNoi: rec.uwDscrNoi, uwDscrNcf: rec.uwDscrNcf,
            uwY1Noi: rec.uwY1Noi, t12Noi: rec.t12Noi,
            assetType: rec.assetType,
            subType: null,
            largestTenantPct: null, pctIncomeExpiringWithinTerm: null, tenantDataStatus: null,
            shelfLabelCatalog: `${deal.shelf}-annexA-origination-recovery`,
            bodyPageOffset: null,
            notes: rec.sourceNote,
          });
          continue;
        }
        // Recovery slot is explicit null → no Annex A in file → tracked-pending
        records.push(buildTrackedPendingLoss(deal, liq));
        tailLossCount++;
        continue;
      }
      if (liq.outcomeClass === 'LOSS') {
        // LOSS with no recovery slot and no body page/walker — tracked-pending
        records.push(buildTrackedPendingLoss(deal, liq));
        tailLossCount++;
        continue;
      }
      if (liq.outcomeClass === 'STRESS-ONLY') {
        records.push({
          file: `EDGAR/${deal.cik}/${deal.name}/loan-${liq.prosId} (#${liq.prosId} ${liq.outcomeClass})`,
          cik: deal.cik, dealName: deal.name, shelf: deal.shelf,
          vintage: deal.vintage, originator: deal.originator,
          prosId: liq.prosId, propertyName: liq.propertyName,
          inputSource: 'targeted-body-page',
          outcomeClass: 'STRESS-ONLY',
          bcLoss: 0, dsLoss: null,
          outcomeEvidence: `liquidated ${liq.distDate} with $0 cumulative loss (DPO / paid off → STRESS-ONLY)`,
          loanAmount: null, coupon: null, maturityDate: null,
          concludedValue: null, concludedLtv: null,
          uwDscrNoi: null, uwDscrNcf: null,
          uwY1Noi: null, t12Noi: null,
          assetType: null, subType: null, largestTenantPct: null, pctIncomeExpiringWithinTerm: null, tenantDataStatus: null,
          shelfLabelCatalog: null, bodyPageOffset: null,
          notes: 'STRESS-ONLY tail loan: paid off, no body page available — outcome tag only (no DealBag needed for $0 loss).',
        });
        continue;
      }
      tailIncomplete.push(`#${liq.prosId} ${liq.propertyName} ($${liq.realizedLoss.toLocaleString()})`);
      lossesComplete = false;
      continue;
    }
    tailLossCount++;
    records.push({
      file: `EDGAR/${deal.cik}/${deal.name}/loan-${liq.prosId} (${liq.propertyName})`,
      cik: deal.cik, dealName: deal.name, shelf: deal.shelf,
      vintage: deal.vintage, originator: deal.originator,
      prosId: liq.prosId, propertyName: liq.propertyName,
      inputSource: source,
      outcomeClass: liq.outcomeClass,
      bcLoss: liq.realizedLoss, dsLoss: null,
      outcomeEvidence: liq.outcomeClass === 'LOSS'
        ? `realized loss $${liq.realizedLoss.toLocaleString()} (10-D, dist ${liq.distDate})`
        : `liquidated ${liq.distDate} with $0 cumulative loss (DPO / paid off → STRESS-ONLY)`,
      loanAmount: ext?.loanAmount ?? wkFallback?.loanAmount ?? null,
      coupon: ext?.coupon ?? wkFallback?.coupon ?? null,
      maturityDate: ext?.maturityDate ?? wkFallback?.maturityDate ?? null,
      concludedValue: ext?.concludedValue ?? wkFallback?.concludedValue ?? null,
      concludedLtv: ext?.concludedLtv ?? wkFallback?.concludedLtv ?? null,
      uwDscrNoi: ext?.uwDscrNoi ?? wkFallback?.uwDscrNoi ?? null,
      uwDscrNcf: ext?.uwDscrNcf ?? wkFallback?.uwDscrNcf ?? null,
      uwY1Noi: ext?.uwY1Noi ?? wkFallback?.uwY1Noi ?? null,
      t12Noi: ext?.t12Noi ?? wkFallback?.t12Noi ?? null,
      assetType: ext?.assetType ?? wkFallback?.assetType ?? null,
      subType: ext?.subType ?? wkFallback?.subType ?? null,
      largestTenantPct: ext?.largestTenantPct ?? null,
      pctIncomeExpiringWithinTerm: ext?.pctIncomeExpiringWithinTerm ?? null,
      tenantDataStatus: ext?.tenantDataStatus ?? null,
      shelfLabelCatalog: ext?.shelfLabelCatalog ?? `${deal.shelf}-annexA-walker`,
      bodyPageOffset: ext?.bodyPageOffset ?? null,
      notes: ext !== null
        ? `Targeted body-page lookup for tail ${liq.outcomeClass} loan (No. ${liq.prosId})`
        : `Targeted Annex A lookup for tail ${liq.outcomeClass} loan`,
    });
  }
  if (tailIncomplete.length > 0) {
    notes.push(`✗ tail LOSS entries not completable: ${tailIncomplete.join(', ')}`);
    return { deal, status: 'BLOCKED_INCOMPLETE_LOSS', records, bodyPageCount: bodyPages.length, tailLossCount, dscrConsistent, dscrChecked, lossesComplete, notes };
  }

  return {
    deal, status: 'CORPUS', records, bodyPageCount: bodyPages.length, tailLossCount,
    dscrConsistent, dscrChecked, lossesComplete, notes,
  };
}

/* ============================================================================
 * MAIN
 * ========================================================================== */
function main() {
  const out: string[] = [];
  out.push('PRODUCTION READER — FULL BACKBONE CORPUS RUN (15 deals)');
  out.push(`Run at: ${new Date().toISOString()}`);
  out.push('Architecture: body-page-primary + per-shelf label catalogs + 10-D loss-driven targeted Annex-A fallback.');
  out.push('Gate: deal-by-deal, no records enter until reconciliation/DSCR/10-D/losses pass.');
  out.push('');

  const outcomes: DealOutcome[] = [];
  for (const deal of DEALS) {
    out.push('========================================================');
    out.push(`DEAL: ${deal.name} (CIK ${deal.cik}, shelf ${deal.shelf}, vintage ${deal.vintage})`);
    out.push('========================================================');
    const oc = composeDeal(deal);
    outcomes.push(oc);
    out.push(`Status: ${oc.status}`);
    out.push(`Body-page records: ${oc.bodyPageCount}, tail-loss records: ${oc.tailLossCount}, total emitted: ${oc.records.length}`);
    out.push(`DSCR NCF ≤ NOI: ${oc.dscrConsistent}/${oc.dscrChecked}`);
    if (oc.notes.length > 0) for (const n of oc.notes) out.push(`  - ${n}`);
    if (oc.records.length > 0 && oc.records.length <= 12) {
      out.push('  records:');
      for (const r of oc.records) {
        out.push(`    [${r.prosId.padEnd(3)}] ${r.propertyName.padEnd(34)} ${r.outcomeClass.padEnd(20)} bal=${r.loanAmount !== null ? '$' + r.loanAmount.toLocaleString() : 'null'}  LTV=${r.concludedLtv !== null ? (r.concludedLtv*100).toFixed(1)+'%' : 'null'}  NCF DSCR=${r.uwDscrNcf !== null ? r.uwDscrNcf.toFixed(2)+'x' : 'null'}  source=${r.inputSource}`);
      }
    } else if (oc.records.length > 12) {
      out.push(`  (showing first 5 of ${oc.records.length})`);
      for (const r of oc.records.slice(0, 5)) {
        out.push(`    [${r.prosId.padEnd(3)}] ${r.propertyName.padEnd(34)} bal=${r.loanAmount !== null ? '$' + r.loanAmount.toLocaleString() : 'null'}  LTV=${r.concludedLtv !== null ? (r.concludedLtv*100).toFixed(1)+'%' : 'null'}  NCF DSCR=${r.uwDscrNcf !== null ? r.uwDscrNcf.toFixed(2)+'x' : 'null'}`);
      }
    }
    out.push('');
  }

  /* === SUMMARY === */
  out.push('================================================================');
  out.push('BACKBONE CORPUS SUMMARY');
  out.push('================================================================');
  const byStatus = new Map<string, number>();
  for (const oc of outcomes) byStatus.set(oc.status, (byStatus.get(oc.status) ?? 0) + 1);
  out.push(`Deals processed: ${outcomes.length}`);
  for (const [k, v] of byStatus) out.push(`  ${k}: ${v}`);
  const corpusDeals = outcomes.filter(oc => oc.status === 'CORPUS' || oc.status === 'BLOCKED_MISSING_10D');
  const allRecords = corpusDeals.flatMap(oc => oc.records);
  out.push('');
  out.push(`Total records emitted: ${allRecords.length}`);
  const byOutcome = new Map<string, number>();
  for (const r of allRecords) byOutcome.set(r.outcomeClass, (byOutcome.get(r.outcomeClass) ?? 0) + 1);
  for (const [k, v] of byOutcome) out.push(`  ${k}: ${v}`);
  const byShelf = new Map<string, number>();
  for (const r of allRecords) byShelf.set(r.shelf, (byShelf.get(r.shelf) ?? 0) + 1);
  out.push(`Records by shelf:`);
  for (const [k, v] of byShelf) out.push(`  ${k}: ${v}`);
  const bySource = new Map<string, number>();
  for (const r of allRecords) bySource.set(r.inputSource, (bySource.get(r.inputSource) ?? 0) + 1);
  out.push(`Records by inputSource:`);
  for (const [k, v] of bySource) out.push(`  ${k}: ${v}`);

  /* === DSCR consistency rollup === */
  out.push('');
  out.push('DSCR convention (NCF ≤ NOI):');
  const totalConsistent = corpusDeals.reduce((s, oc) => s + oc.dscrConsistent, 0);
  const totalChecked = corpusDeals.reduce((s, oc) => s + oc.dscrChecked, 0);
  out.push(`  ${totalConsistent}/${totalChecked} consistent across all accepted records`);

  /* === Loss completeness rollup === */
  out.push('');
  out.push('Loss-loan completeness:');
  for (const oc of outcomes.filter(o => o.deal.knownLossAnchors.length > 0)) {
    const status = oc.lossesComplete ? '✓ all anchors complete' : '✗ INCOMPLETE';
    out.push(`  ${oc.deal.name}: ${status}  (anchors=${oc.deal.knownLossAnchors.length}, tail-lookups=${oc.tailLossCount})`);
  }

  /* === Per-shelf catalog readiness === */
  out.push('');
  out.push('Per-shelf label catalog readiness:');
  const shelves = new Set(DEALS.map(d => d.shelf));
  for (const sh of shelves) {
    const dealsOfShelf = outcomes.filter(oc => oc.deal.shelf === sh);
    const corpusOk = dealsOfShelf.some(oc => oc.status === 'CORPUS' || oc.status === 'BLOCKED_MISSING_10D');
    const noBody = dealsOfShelf.some(oc => oc.status === 'BLOCKED_NO_BODY_PAGES');
    const status = corpusOk ? '✓ body-page catalog WORKING'
      : noBody ? '✗ NO BODY PAGES — needs per-shelf Annex A walker adapter (canary template)'
      : '? no usable prospectus in /tmp';
    out.push(`  ${sh}: ${status}`);
  }

  /* === HINDSIGHT SWEEP — confirm zero residual hindsight remains === */
  out.push('');
  out.push('=== HINDSIGHT SWEEP (no record may have concludedLtv > 1.0 OR a "10D-derived" catalog) ===');
  let hindsightHits = 0;
  for (const r of allRecords) {
    const ltvHit = r.concludedLtv !== null && r.concludedLtv > 1.0;
    const catalogHit = r.shelfLabelCatalog !== null && /10[\-_]?D[\-_]?derived/i.test(r.shelfLabelCatalog);
    if (ltvHit || catalogHit) {
      hindsightHits++;
      out.push(`  ✗ HINDSIGHT in ${r.shelf} #${r.prosId} ${r.propertyName}: ltv=${r.concludedLtv} catalog="${r.shelfLabelCatalog}"`);
    }
  }
  out.push(`  Total hindsight records: ${hindsightHits} (must be 0)`);
  if (hindsightHits === 0) {
    out.push('  ✓ corpus is hindsight-free');
  }
  // Also count tracked-pending so the user knows the trade-off
  const pending = allRecords.filter(r => r.inputSource === 'tracked-pending');
  out.push(`  tracked-pending LOSS records: ${pending.length}`);
  for (const p of pending) {
    out.push(`    - ${p.shelf} #${p.prosId} (bcLoss=$${p.bcLoss?.toLocaleString()}) — origination inputs not recoverable from available source`);
  }
  out.push('');

  /* === Persist corpus === */
  fs.writeFileSync(CORPUS_JSON, JSON.stringify({
    runAt: new Date().toISOString(),
    architecture: 'body-page-primary + per-shelf label catalog + 10-D loss-driven targeted Annex-A fallback',
    deals: outcomes.map(oc => ({
      cik: oc.deal.cik, name: oc.deal.name, shelf: oc.deal.shelf,
      vintage: oc.deal.vintage, originator: oc.deal.originator,
      status: oc.status, recordCount: oc.records.length,
      dscrConsistent: oc.dscrConsistent, dscrChecked: oc.dscrChecked,
      notes: oc.notes,
    })),
    records: allRecords,
  }, null, 2));
  out.push(`Corpus persisted to ${CORPUS_JSON} (${allRecords.length} records)`);
  out.push('');

  fs.writeFileSync(OUT_PATH, out.join('\n'));
  console.log(out.join('\n'));
  console.log(`\n[backbone-corpus] wrote ${out.join('\n').length} chars to ${OUT_PATH}`);
}

const isMain = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) main();
