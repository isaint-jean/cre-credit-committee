/**
 * 3rd-ISSUER APPRAISAL DIAGNOSTIC (read-only, nothing minted).
 *
 * Runs the EXISTING CBRE-tuned appraisal extractor (extract-cbre-appraisal.ts /
 * runAppraisalAdapter) COLD on a non-CBRE appraisal PDF, then reports the truth,
 * field by field:
 *   SURVIVED  — regex/anchor actually matched a plausible value
 *   NULL      — clean fail-safe (honest blank)
 *   HARDCODED — the field is a literal Sunroad/CBRE constant; on a non-Sunroad
 *               property it is a WRONG value emitted with false confidence (the
 *               dangerous class — worse than a null).
 *
 * Then Stage 2 feeds the extracted appraisal into computePreFlightLedgerAndUnlocks
 * and prints how the readiness ledger classifies the appraisal-fed intake fields
 * (as_is_value / cap_rate / stabilized_noi / …) — proving whether pre-flight
 * honestly shows BLANK/MISSING when the extractor fails, or false-positives.
 *
 *   cd apps/api && npx tsx src/scripts/diagnose-3rd-issuer-appraisal.ts <path-to-appraisal.pdf>
 *
 * NOTHING is written to cre.db. Pure compute over the provided file.
 */
import { readFileSync } from 'node:fs';
import { extractCbreAppraisal } from '../services/extract-cbre-appraisal.js';
import { runAppraisalAdapter } from '../services/extraction/adapters/appraisal.adapter.js';
import { computePreFlightLedgerAndUnlocks } from '../services/pre-flight-readiness.service.js';
import type { AppraisalExtraction, ExtractionResult, SourceDocumentKind } from '@cre/contracts';

/* Tier 1b removed the 7 hardcoded identity literals — they are now extract-or-null.
   This map is empty; the Sunroad-leak scan below asserts no Sunroad literal survives. */
const HARDCODED_FIELDS: Record<string, string> = {};

/* Forbidden Sunroad/CBRE-Sunroad literals — NONE may appear on a non-Sunroad deal. */
const SUNROAD_LEAK_LITERALS = ['San Diego', 'Sunroad', 'CB23US057102', 'Spectrum Center'];

/* The score-relevant appraisal core (what a fix must cover FIRST). */
const SCORE_CORE = new Set([
  'asIsValue', 'asStabilizedValue', 'overallCapRate', 'terminalCapRate',
  'stabilizedProForma.netOperatingIncome', 'currentOccupancyPhysical',
]);

function fmt(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'number') return v.toLocaleString('en-US');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function classify(field: string, value: unknown): { tag: string; note: string } {
  if (field in HARDCODED_FIELDS) {
    return { tag: 'HARDCODED', note: HARDCODED_FIELDS[field]! };
  }
  if (value === null || value === undefined) return { tag: 'NULL', note: 'clean fail-safe' };
  if (typeof value === 'object') {
    // nested pro-forma / leasing — recurse-print handled by caller
    return { tag: 'OBJECT', note: '' };
  }
  return { tag: 'SURVIVED', note: SCORE_CORE.has(field) ? '★ score-relevant' : '' };
}

/** Flatten one level of nested pro-forma/leasing objects into dotted keys. */
function flatten(appr: AppraisalExtraction): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = [];
  for (const [k, v] of Object.entries(appr)) {
    if (k === 'pageReferences') continue;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v)) out.push([`${k}.${k2}`, v2]);
    } else {
      out.push([k, v]);
    }
  }
  return out;
}

function hr(t: string): void {
  console.log('\n════════════════════════════════════════════════════════════');
  console.log(t);
  console.log('════════════════════════════════════════════════════════════');
}

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) {
    console.error('usage: diagnose-3rd-issuer-appraisal.ts <path-to-appraisal.pdf>');
    console.error('  (drop the non-CBRE appraisal PDF anywhere and pass its path)');
    process.exit(2);
  }
  const buffer = readFileSync(path);
  console.log(`Input: ${path} (${(buffer.length / 1e6).toFixed(2)} MB)`);

  // ─── STAGE 1 — run the CBRE extractor cold ─────────────────────────────
  hr('STAGE 1 — extract-cbre-appraisal COLD on the non-CBRE appraisal');
  const appr = await extractCbreAppraisal(buffer);
  const adapterOutcome = await runAppraisalAdapter({
    buffer,
    kind: 'appraisal' as SourceDocumentKind,
  } as never);

  const rows = flatten(appr);
  const counts = { survived: 0, nul: 0, hardcoded: 0 };
  const dangerous: string[] = [];
  console.log('\n  FIELD                                          TAG        VALUE / NOTE');
  console.log('  ' + '-'.repeat(90));
  for (const [field, value] of rows) {
    const { tag, note } = classify(field, value);
    if (tag === 'OBJECT') continue;
    if (tag === 'SURVIVED') counts.survived++;
    else if (tag === 'NULL') counts.nul++;
    else if (tag === 'HARDCODED') { counts.hardcoded++; dangerous.push(`${field} = ${fmt(value)} (${note})`); }
    const val = tag === 'HARDCODED' ? `${fmt(value)}  ⚠ ${note}` : (note ? `${fmt(value)}  ${note}` : fmt(value));
    console.log(`  ${field.padEnd(46)} ${tag.padEnd(10)} ${val}`);
  }

  hr('STAGE 1 VERDICT');
  const total = counts.survived + counts.nul + counts.hardcoded;
  console.log(`  SURVIVED (regex matched): ${counts.survived}/${total}`);
  console.log(`  NULL (clean fail-safe):   ${counts.nul}/${total}`);
  console.log(`  HARDCODED (WRONG value):  ${counts.hardcoded}/${total}  ← dangerous, non-null garbage`);
  console.log(`  adapter status:           ${(adapterOutcome as { status?: string }).status ?? '(n/a)'}`);
  console.log('\n  ⚠ DANGEROUS WRONG-VALUE FIELDS (emitted with false confidence on this property):');
  for (const d of dangerous) console.log(`    - ${d}`);
  // Tier-1b safety scan: no Sunroad literal may appear anywhere in the output.
  const outStr = JSON.stringify(appr);
  const leaks = SUNROAD_LEAK_LITERALS.filter((lit) => outStr.includes(lit));
  console.log(`\n  SUNROAD-LEAK SCAN: ${leaks.length === 0 ? '✓ CLEAN — no Sunroad literal in output' : '✗ LEAK: ' + leaks.join(', ')}`);
  console.log(`  identity extracted: source=${appr.source ?? 'null'} · report=${appr.reportName ?? 'null'} · city=${appr.city ?? 'null'} · state=${appr.state ?? 'null'} · interest=${appr.interestAppraised ?? 'null'} · leased=${appr.currentLeasedPct ?? 'null'} · method=${appr.methodology ?? 'null'}`);
  console.log('\n  Score-relevant core:');
  for (const f of ['asIsValue', 'asStabilizedValue', 'overallCapRate', 'terminalCapRate', 'stabilizedProForma.netOperatingIncome', 'currentOccupancyPhysical']) {
    const v = rows.find(([k]) => k === f)?.[1];
    console.log(`    ${f.padEnd(46)} ${v === null || v === undefined ? 'NULL (broke)' : `${fmt(v)}  ← SURVIVED (scrutinize: real or wrong-match?)`}`);
  }

  // ─── STAGE 2 — pre-flight honesty on this issuer ───────────────────────
  hr('STAGE 2 — pre-flight readiness ledger honesty (appraisal-fed fields)');
  const extraction = {
    id: 'diag-3rd-issuer-appraisal',
    analysisAsOfDate: '2026-08-07T00:00:00Z',
    extractionEngineVersion: '1.9',
    dealRef: 'DIAG-3RD-ISSUER',
    rentRoll: null, inPlace: null, t12Actual: null, pca: null,
    appraisal: appr,
    // Mirror the projector (project-legacy-analysis-from-graph.ts:321): real deals
    // expose the appraisal as an `appraisalExtraction` overlay — that is the field
    // the intake bindings (`appraisalExtraction.asIsValue`, …) actually read. Set it
    // so Stage 2 is a FAITHFUL test: a successful extraction resolves to PRODUCE,
    // a broken one to BLANK. (A bare spine `.appraisal` never satisfies the binding.)
    appraisalExtraction: appr,
    sellerUw: null, sellerUwOperatingStatement: null, asr: null,
    loanTerms: null, parties: null, annexA: null,
    sourceDocuments: [{ kind: 'appraisal', contentHash: 'x'.repeat(64), filename: path }],
    extractorVersions: {},
  } as unknown as ExtractionResult;

  const readiness = computePreFlightLedgerAndUnlocks(extraction, ['appraisal']);
  const APPRAISAL_FED = new Set([
    'as_is_value', 'stabilized_value', 'cap_rate', 'stabilized_noi',
    'physical_occupancy', 'year_built', 'vacancy_credit_loss', 'opex', 'reimbursements',
  ]);
  const allFields = [
    ...readiness.ledger.produce, ...readiness.ledger.blankInDoc, ...readiness.ledger.missing,
  ];
  console.log('\n  appraisal-fed intake field           STATE                      (pre-flight honesty)');
  console.log('  ' + '-'.repeat(80));
  for (const f of allFields) {
    if (!APPRAISAL_FED.has(f.id)) continue;
    const state = readiness.ledger.produce.includes(f) ? 'PRODUCE (populated)'
      : readiness.ledger.blankInDoc.includes(f) ? 'BLANK-in-doc (¬extracted)'
      : 'MISSING';
    const honest = state.startsWith('PRODUCE')
      ? '← claims populated (verify the value is REAL, not a wrong-match)'
      : '← honestly blank ✓';
    console.log(`  ${f.id.padEnd(36)} ${state.padEnd(26)} ${honest}`);
  }
  console.log(`\n  ledger: PRODUCE ${readiness.ledger.produce.length} / BLANK ${readiness.ledger.blankInDoc.length} / MISSING ${readiness.ledger.missing.length}`);
  console.log('\n  NOTE: pre-flight faithfully REFLECTS the extraction — it is a READ, not a');
  console.log('  validator. If the CBRE extractor wrong-matched a value, pre-flight relays that');
  console.log('  value as PRODUCE. Honesty = it never invents populated; it cannot catch a bad match.');

  console.log('\n✓ diagnostic complete — nothing written to cre.db.');
}

main().catch((e) => { console.error('FATAL:', e?.stack ?? e); process.exit(1); });
