/**
 * Phase 0 — caching spike (throwaway, will not be committed).
 *
 *   cd apps/api && npx tsx src/scripts/phase0-context-hash-spike.ts
 *
 * Question: can we compute a STABLE per-principle context hash that is
 * byte-identical across repeated assembles, so a cache keyed on
 * (principleId, contextHash, engineVersion, modelVersion) yields
 * deterministic HE ids?
 *
 * Uses the existing Sunroad graph in apps/api/data/cre.db. No LLM calls,
 * no mutations.
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { recordGraphStore } from '../storage/record-graph-store.js';
import { canonicalize } from '../util/canonical-json.js';

const REPO = '/Users/isabellesaint-jean/Desktop/CRE Credit Comittee';
const HANDBOOK_PATH = `${REPO}/packages/handbook-data/src/handbook.json`;
const handbookJson = JSON.parse(readFileSync(HANDBOOK_PATH, 'utf8'));

const TARGET_PRINCIPLES = [
  'P-II-1', 'P-II-6', 'P-II-7', 'P-III-6', 'P-III-8', 'P-III-9', 'P-III-10',
];

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function findPrinciple(id: string): any | null {
  for (const p of (handbookJson.principles ?? [])) {
    if (p.id === id) return p;
  }
  for (const c of (handbookJson.clusters ?? [])) {
    for (const p of (c.principles ?? [])) {
      if (p?.id === id) return p;
    }
  }
  return null;
}

function curateAdjustedInputs(ai: any): unknown {
  return {
    income: {
      grossRentalIncome: ai.income.grossRentalIncome,
      vacancyPct: ai.income.vacancyPct,
      concessionsPct: ai.income.concessionsPct,
      otherIncome: ai.income.otherIncome,
      effectiveGrossIncome: ai.income.effectiveGrossIncome,
    },
    expenses: { totalOperatingExpenses: ai.expenses.totalOperatingExpenses },
    capitalReserves: { monthlyReplacementReserves: ai.capitalReserves.monthlyReplacementReserves },
    loan: ai.loan,
    assumptions: ai.assumptions,
    metrics: ai.metrics,
    confidenceReduction: ai.confidenceReduction,
    topLevelAdjustments: ai.topLevelAdjustments,
    dataQualityFlags: ai.dataQualityFlags,
  };
}

function curateStressOutputs(so: any): unknown {
  return {
    method: so.method,
    scenarios: so.scenarios.map((s: any) => ({
      name: s.name, noi: s.noi, dscr: s.dscr, value: s.value,
      ltv: s.ltv, debtYield: s.debtYield,
      breaches: s.breaches, skipped: s.skipped,
    })),
    stressEngineVersion: so.stressEngineVersion,
  };
}

function curateNarrativeFacts(nf: any): unknown {
  if (nf === null || nf === undefined) return null;
  const { id, ...body } = nf;
  void id;
  return body;
}

function buildContext(principleId: string, graph: any, deterministicFiredFlags: readonly unknown[]): unknown {
  const p = findPrinciple(principleId);
  if (!p) throw new Error(`principle ${principleId} not found in handbook`);
  return {
    principle: {
      id: p.id,
      title: p.title,
      principleText: p.principleText,
      severity: p.severity,
      injectionPoints: [...p.injectionPoints].sort(),
    },
    deal: {
      assetType: graph.ap?.propertyType ?? 'unknown',
      adjustedInputs: curateAdjustedInputs(graph.ai),
      stressOutputs: curateStressOutputs(graph.so),
      assetProfile: graph.ap,
      propertyMetadata: graph.pm,
      narrativeFacts: curateNarrativeFacts(graph.nf),
    },
    handbookEngineVersion: '1.1.0',
    modelVersion: 'claude-sonnet-4-5-20250929',
    deterministicFiredFlags,
  };
}

function loadGraph() {
  const db = (recordGraphStore as any).db;
  const rows = db.prepare('SELECT revision_id FROM revision_lineage_envelopes LIMIT 1').all();
  if (rows.length === 0) throw new Error('no revision envelopes in db');
  const envelope = recordGraphStore.getRevisionEnvelope(rows[0].revision_id);
  if (!envelope) throw new Error('envelope not loaded');
  const de = recordGraphStore.getDoctrineEvaluation(envelope.doctrineEvaluationId);
  if (!de) throw new Error('DE not found');
  const ai = recordGraphStore.getAdjustedInputs(de.adjustedInputsId);
  if (!ai) throw new Error('AI not found');
  const so = recordGraphStore.getStressOutputs(de.stressOutputsId);
  if (!so) throw new Error('SO not found');
  const ap = recordGraphStore.getAssetProfile(de.assetProfileId);
  if (!ap) throw new Error('AssetProfile not found');
  const pm = recordGraphStore.getPropertyMetadataByExtractionResultId(de.extractionResultId);
  const nfRow = db.prepare('SELECT payload FROM narrative_facts WHERE id = ?').get(de.narrativeFactsId);
  const nf = nfRow ? JSON.parse(nfRow.payload) : null;
  const he = recordGraphStore.getLatestHandbookEvaluationForAdjustedInputs(ai.id);
  const deterministicFiredFlags = he?.firedFlags ?? [];
  return { envelope, de, ai, so, ap, pm, nf, deterministicFiredFlags };
}

function runPass() {
  const g = loadGraph();
  const out = new Map<string, { contextJson: string; contextHash: string }>();
  for (const pid of TARGET_PRINCIPLES) {
    const ctx = buildContext(pid, { ai: g.ai, so: g.so, ap: g.ap, pm: g.pm, nf: g.nf }, g.deterministicFiredFlags);
    const canonical = canonicalize(ctx);
    out.set(pid, { contextJson: canonical, contextHash: sha256(canonical) });
  }
  return { g, hashes: out };
}

console.log('=========================================================');
console.log('Phase 0 — Context-hash stability spike');
console.log('=========================================================');

const pass1 = runPass();
console.log(`Loaded graph: rootRevision=${pass1.g.envelope.revisionId.slice(0, 16)}…  AI.id=${pass1.g.ai.id.slice(0, 16)}…`);
console.log(`  HE deterministic firedFlags: ${pass1.g.deterministicFiredFlags.length}`);
console.log(`  PropertyMetadata: ${pass1.g.pm ? 'present' : 'null'}`);
console.log(`  NarrativeFacts: ${pass1.g.nf ? 'present' : 'null'}`);
console.log('');

const pass2 = runPass();

console.log('Per-principle context hash (pass 1 vs pass 2):');
let allMatch = true;
for (const pid of TARGET_PRINCIPLES) {
  const h1 = pass1.hashes.get(pid)!;
  const h2 = pass2.hashes.get(pid)!;
  const match = h1.contextHash === h2.contextHash;
  if (!match) allMatch = false;
  console.log(`  ${pid.padEnd(12)} ${match ? '✓ MATCH' : '✗ MISMATCH'}  hash=${h1.contextHash.slice(0, 16)}…  bytes=${h1.contextJson.length}`);
  if (!match) {
    let firstDiff = -1;
    for (let i = 0; i < Math.min(h1.contextJson.length, h2.contextJson.length); i++) {
      if (h1.contextJson[i] !== h2.contextJson[i]) { firstDiff = i; break; }
    }
    if (firstDiff === -1) firstDiff = Math.min(h1.contextJson.length, h2.contextJson.length);
    console.log(`    first diff at byte ${firstDiff}:`);
    console.log(`    pass1: ${h1.contextJson.slice(Math.max(0, firstDiff - 30), firstDiff + 80)}`);
    console.log(`    pass2: ${h2.contextJson.slice(Math.max(0, firstDiff - 30), firstDiff + 80)}`);
  }
}
console.log('');

console.log('=========================================================');
console.log(allMatch
  ? 'GATE: ALL 7 STABLE — option (a) viable. Proceed to Phase 1.'
  : 'GATE: STABILITY FAILED — DO NOT proceed. Report root cause above.');
console.log('=========================================================');
process.exit(allMatch ? 0 : 1);
