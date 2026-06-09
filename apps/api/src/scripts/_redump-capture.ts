/**
 * Read-only follow-up to capture-end-to-end.ts — opens the existing DB,
 * finds the 3 ingested AdjustedInputs (Sunroad current, Showcase current,
 * Showcase future-state), and re-dumps with correct engine versions so
 * mits + narrative populate. No LLM calls.
 */
import path from 'node:path';
import fs from 'node:fs';
import { NARRATIVE_ENGINE_VERSION, MITIGATION_ENGINE_VERSION } from '@cre/contracts';
import { RecordGraphStore } from '../storage/record-graph-store.js';

const REPO = '/Users/isabellesaint-jean/Desktop/CRE Credit Comittee';
const DB_PATH = path.join(REPO, 'apps/api/data/end-to-end-capture.db');
const OUT_PATH = '/tmp/end-to-end-capture.out';

function fmt(n: any): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'null';
  return `$${(n as number).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}
function fmtRate(n: any): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'null';
  return `${((n as number) * 100).toFixed(2)}%`;
}
function fmtNum(n: any): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'null';
  return (n as number).toFixed(2);
}
function ratingBandDisplay(d: any, ai: any): string {
  if (!d) return 'null';
  const base = d.ratingBand;
  if (d.coverage.insufficientCoverageGate) return `${base} (insufficient coverage)`;
  if (d.coverage.bandCapApplied) {
    const n = d.coverage.excludedRiskDimRuleIds.length;
    return `${base} (capped — ${n} risk dimension${n === 1 ? '' : 's'} unevaluated)`;
  }
  if (ai?.dataConfidence === 'unvalidated') return `${base} (provisional)`;
  return base;
}

/** Iterate every revision envelope row in the DB. */
function loadAllPasses(store: RecordGraphStore): any[] {
  const db = (store as any).db; // raw SQLite handle
  const rows = db.prepare(
    `SELECT revision_id, adjusted_inputs_id, doctrine_evaluation_id, created_at
     FROM revision_lineage_envelopes ORDER BY created_at ASC`,
  ).all() as Array<{ revision_id: string; adjusted_inputs_id: string; doctrine_evaluation_id: string; created_at: string }>;
  return rows;
}

function dumpPass(label: string, futureState: boolean, ai: any, doctrine: any, mits: any, narrative: any, out: string[]) {
  const tag = futureState ? '⚠ FUTURE-STATE — rent-roll-seeded' : '';
  out.push(`\n${'='.repeat(70)}`);
  out.push(`PASS: ${label}  ${tag}`);
  out.push('='.repeat(70));
  if (!ai) { out.push('  (no AdjustedInputs)'); return; }
  const m = ai.metrics;
  out.push(`\n--- DETERMINISTIC FIGURES ---`);
  out.push(`  NOI                          ${fmt(m.noi)}`);
  out.push(`  DSCR (concluded)             ${fmtNum(m.dscr)}`);
  out.push(`  Debt Yield                   ${fmtRate(m.debtYield)}`);
  out.push(`  LTV (Appraisal)              ${fmtRate(m.ltvAppraisal)}`);
  out.push(`  Cap Rate (going-in, adj)     ${fmtRate(ai.assumptions?.capRate?.adjusted)}`);
  out.push(`  Cap Rate (terminal, adj)     ${fmtRate(ai.assumptions?.terminalCapRate?.adjusted)}`);
  out.push(`  Concluded Cap (analyst)      ${fmtRate(ai.assumptions?.concludedCapRate?.adjusted ?? null)}`);
  out.push(`  Value (implied)              ${fmt(m.value)}`);
  out.push(`  Trailing Actual NOI          ${fmt(m.trailingActualNoi)}`);
  out.push(`  In-Place NOI                 ${fmt(m.inPlaceNoi)}`);
  out.push(`  Issuer-CF UW NOI             ${fmt(m.issuerCfUwNoi)}`);
  out.push(`  Top-1 Income Share           ${m.top1IncomeShare !== null ? `${(m.top1IncomeShare*100).toFixed(1)}%` : 'null'}`);
  out.push(`  Pct Income Expiring (term)   ${m.pctIncomeExpiringWithinTerm !== null ? `${(m.pctIncomeExpiringWithinTerm*100).toFixed(1)}%` : 'null'}`);
  out.push(`  Total OpEx (adj)             ${fmt(ai.expenses?.totalOperatingExpenses?.adjusted)}`);

  // Income build-up (raw → adjusted + per-rule recovery deltas). Mirrors
  // capture-end-to-end.ts's dump — the income-recovery rigor leg.
  const rawAdjLine = (li: any, label: string) => {
    if (!li) { out.push(`  ${label.padEnd(28)} (slot absent)`); return; }
    const raw = li.raw, adj = li.adjusted;
    let delta = '';
    if (typeof raw === 'number' && typeof adj === 'number' && Number.isFinite(raw) && Number.isFinite(adj)) {
      const d = adj - raw;
      delta = d === 0 ? ' (Δ 0)' : `  (Δ ${d >= 0 ? '+' : ''}${fmt(d)})`;
    }
    out.push(`  ${label.padEnd(28)} raw=${fmt(raw).padEnd(15)} adj=${fmt(adj)}${delta}`);
    if (Array.isArray(li.adjustments) && li.adjustments.length > 0) {
      for (const a of li.adjustments) {
        out.push(`      • ${a.ruleId.padEnd(40)} delta=${fmt(a.delta)}  "${(a.reason ?? '').slice(0, 90)}"`);
      }
    }
  };
  rawAdjLine(ai.income?.grossRentalIncome, 'Gross Rental Income');
  rawAdjLine(ai.income?.otherIncome,       'Other Income (incl. recoveries)');
  rawAdjLine(ai.income?.vacancyPct,        'Vacancy %');
  rawAdjLine(ai.income?.concessionsPct,    'Concessions %');
  rawAdjLine(ai.income?.effectiveGrossIncome, 'Effective Gross Income');
  out.push(`  dataConfidence               ${ai.dataConfidence}`);
  out.push(`  dataQualityFlags             [${(ai.dataQualityFlags ?? []).join(', ')}]`);

  out.push(`\n--- DOCTRINE EVALUATION ---`);
  out.push(`  ratingBand (raw)             ${doctrine.ratingBand}`);
  out.push(`  ratingBand displayValue      "${ratingBandDisplay(doctrine, ai)}"`);
  out.push(`  finalScore                   ${doctrine.finalScore?.toFixed(2)}`);
  out.push(`  mechanicalScore              ${doctrine.mechanicalScore?.toFixed(2)}`);
  out.push(`  coverage.evaluatedPct        ${(doctrine.coverage.evaluatedPct * 100).toFixed(1)}%`);
  out.push(`  coverage.bandCapApplied      ${doctrine.coverage.bandCapApplied}`);
  out.push(`  coverage.insufficientGate    ${doctrine.coverage.insufficientCoverageGate}`);
  out.push(`  coverage.excludedRiskDims    [${doctrine.coverage.excludedRiskDimRuleIds.join(', ')}]`);
  out.push(`  flags                        [${doctrine.flags.map((f:any) => f.flagId ?? f).join(', ')}]`);

  out.push(`\n--- MITIGATION PROPOSALS (deterministic) ---`);
  if (!mits || mits.proposals.length === 0) {
    out.push('  (no proposals — mitigation engine produced empty set for this deal)');
  } else {
    for (const pr of mits.proposals) {
      out.push(`\n  [${pr.id}]  lever=${pr.lever}  leverKind=${pr.leverKind}  severity=${pr.severity}`);
      out.push(`    title: ${pr.title}`);
      out.push(`    description: ${pr.description}`);
      out.push(`    principleIds: [${pr.principleIds.join(', ')}]`);
      if (pr.requiredEquity !== undefined) out.push(`    requiredEquity (sponsor cut): ${fmt(pr.requiredEquity)}`);
      if (pr.requiredReserve !== undefined) out.push(`    requiredReserve (upfront escrow): ${fmt(pr.requiredReserve)}`);
      if (pr.targetMetric) out.push(`    targetMetric (binding): ${pr.targetMetric}`);
      if (pr.coverageStatement) out.push(`    coverageStatement: ${pr.coverageStatement}`);
      if (pr.structuralChanges?.length) {
        out.push(`    structuralChanges:`);
        for (const s of pr.structuralChanges) out.push(`      - ${s}`);
      }
      if (pr.recalcBefore) out.push(`    before: NOI=${fmt(pr.recalcBefore.noi)} DSCR=${fmtNum(pr.recalcBefore.dscr)} DY=${fmtRate(pr.recalcBefore.debtYield)} LTV=${fmtRate(pr.recalcBefore.ltv)}`);
      if (pr.recalcAfter)  out.push(`    after:  NOI=${fmt(pr.recalcAfter.noi)} DSCR=${fmtNum(pr.recalcAfter.dscr)} DY=${fmtRate(pr.recalcAfter.debtYield)} LTV=${fmtRate(pr.recalcAfter.ltv)}`);
      out.push(`    riskReduction: ${pr.riskReduction}`);
    }
  }

  out.push(`\n--- PIECE A NARRATIVE (LLM-generated) ---`);
  if (!narrative) {
    out.push('  (no narrative — not found at current engine version)');
  } else {
    out.push(`  engineVersion: ${narrative.engineVersion}`);
    const slots = [
      ['executive_summary',        narrative.executiveSummary],
      ['red_flag_assessment',      narrative.redFlagAssessment],
      ['mitigation_suggestions',   narrative.mitigationSuggestions],
      ['committee_recommendation', narrative.committeeRecommendation],
    ] as const;
    for (const [name, text] of slots) {
      out.push(`\n  --- ${name} ---`);
      out.push(text || '(empty)');
    }
  }
}

function main() {
  if (!fs.existsSync(DB_PATH)) { console.error(`DB not found: ${DB_PATH}`); process.exit(1); }
  const store = new RecordGraphStore(DB_PATH);
  const envelopes = loadAllPasses(store);
  console.log(`found ${envelopes.length} revision envelopes`);
  console.log(`narrative engine version: ${NARRATIVE_ENGINE_VERSION}`);
  console.log(`mitigation engine version: ${MITIGATION_ENGINE_VERSION}`);

  // The 3 passes were stamped via dealRef on the extraction — but envelopes don't
  // carry dealRef. We have to look at AdjustedInputs vs the 3 expected orders:
  //   1. Sunroad current
  //   2. Showcase current
  //   3. Showcase future-state (rent-roll-seeded)
  const labels = [
    { label: 'SUNROAD (current intake, Office)', future: false },
    { label: 'SHOWCASE pass 1 (current intake, Retail, no rent roll slot)', future: false },
    { label: 'SHOWCASE pass 2 (FUTURE-STATE — Eightfold Rent Roll seeded)', future: true },
  ];
  if (envelopes.length !== labels.length) {
    console.warn(`expected ${labels.length} envelopes, found ${envelopes.length} — order may be off`);
  }

  const out: string[] = [];
  out.push(`END-TO-END CAPTURE  ${new Date().toISOString()}`);
  out.push(`engine: current (doctrine v1.3, narrative ${NARRATIVE_ENGINE_VERSION}, mitigation ${MITIGATION_ENGINE_VERSION})`);

  envelopes.forEach((env, i) => {
    const lab = labels[i] ?? { label: `(pass ${i+1})`, future: false };
    const ai = store.getAdjustedInputs(env.adjusted_inputs_id);
    const doctrine = store.getDoctrineEvaluation(env.doctrine_evaluation_id);
    const mits = store.getLatestMitigationProposalSetForAdjustedInputs(env.adjusted_inputs_id, MITIGATION_ENGINE_VERSION);
    const narrative = store.getLatestNarrativeForAdjustedInputs(env.adjusted_inputs_id, NARRATIVE_ENGINE_VERSION);
    console.log(`  pass ${i+1}: adjInputs=${env.adjusted_inputs_id.slice(0,8)}  mits=${mits ? mits.proposals.length : 'null'}  narrative=${narrative ? 'present' : 'null'}`);
    dumpPass(lab.label, lab.future, ai, doctrine, mits, narrative, out);
  });

  const text = out.join('\n');
  fs.writeFileSync(OUT_PATH, text);
  console.log(`\nwrote ${text.length} chars to ${OUT_PATH}`);
}
main();
