/**
 * DEMO — the sanctioned human→dim-9 path end-to-end on a real deal.
 *
 * A reviewer, having read the §4 external-DD finding as CONTEXT, enters an
 * explicit HumanSponsorAssessment. It rides onto AdjustedInputs → new content
 * hash → new head (re-score, not a silent mutation). dim-9 resolves from
 * HITL/inert to a real ±0.20 modifier; the score moves; attributed to who/when.
 *
 *   cd apps/api && npx tsx src/scripts/demo-human-dim9.ts --db /tmp/cre.temp.db
 *
 * READ-then-WRITE against the given DB (default: a temp copy). Prove on temp.
 */
import { SqliteStore } from '../storage/sqlite-store.js';
import { RecordGraphStore } from '../storage/record-graph-store.js';
import { applyRevisionDelta } from '../services/apply-revision-delta.js';
import { renderMemoForAnalysis } from '../services/render-memo/render-memo-for-analysis.js';
import { STUB_LLM_DEPS } from './_narrative-test-deps.js';
import type { HumanSponsorAssessment, RevisionId } from '@cre/contracts';

const argv = process.argv.slice(2);
const dbPath = argv.includes('--db') ? argv[argv.indexOf('--db') + 1] : '/tmp/cre.temp.db';
const TARGET = 'ad9e9e90-a598-4617-8cc0-3a10a64b8d00'; // Sunroad Centrum (final ASR + appraisal)

function hr(t: string): void { console.log('\n════════════════════════════════════════\n' + t + '\n════════════════════════════════════════'); }
// Match the section by its <h2> heading text (avoids matching the word elsewhere).
function sec(html: string, heading: string): string {
  for (const s of html.split('<section')) if (s.includes(`>${heading}</h2>`)) return '<section' + s.split('</section>')[0];
  return '';
}
function txt(html: string): string { return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }

(async () => {
  const sqs = new SqliteStore(dbPath);
  const rgs = new RecordGraphStore(dbPath);

  hr(`DEMO: human → dim-9 on Sunroad   [db=${dbPath}]`);
  const a = sqs.getAnalysis(TARGET)!;
  const parentEnv = rgs.getRevisionEnvelope(a.graphRevisionId as RevisionId)!;
  const parentEval = rgs.getDoctrineEvaluation(parentEnv.doctrineEvaluationId)!;
  const parentSnap = rgs.getDoctrineRenderSnapshot(parentEnv.doctrineEvaluationId)! as any;
  const parentDim9 = parentSnap.dimOutputs?.['sponsor-borrower-quality'];
  console.log(`  deal            : "${a.name}"`);
  console.log(`  parent head     : ${parentEnv.revisionId.slice(0, 18)}…`);
  console.log(`  parent rating   : band=${parentSnap.rating?.band ?? 'null'}  ratedRisk=${parentSnap.rating?.ratedRisk ?? 'null'}  recommendation=${parentSnap.rating?.recommendation}`);
  console.log(`  parent dim-9    : applicability=${parentDim9?.applicability}  (modifier=${parentDim9?.derivedOutputs?.sponsorModifierValue ?? '—'})   ← HITL/inert, no human judgment yet`);

  // The reviewer's explicit five-factor judgment. Fixed enteredAt → deterministic
  // head. Note references the DD finding as CONTEXT (not as the source of any factor).
  const assessment: HumanSponsorAssessment = {
    experience: 'Strong', financialStrength: 'Neutral', alignment: 'Neutral',
    priorCreditEvents: 'Weak', managementQuality: 'Neutral',
    enteredBy: 'isaint-jean@mapaon.com', enteredAt: '2026-07-26T18:00:00.000Z',
    note: 'Entered after reviewing the §4 external-DD result; a prior workout is on record — my call, not the search’s.',
    provenance: 'human',
  };

  hr('REVIEWER ENTERS THE ASSESSMENT → NEW HEAD (re-score)');
  const res = await applyRevisionDelta(
    { parentRevisionId: parentEnv.revisionId, delta: { kind: 'sponsor-assessment', assessment }, triggerSource: 'USER_EDIT', adjustmentOrigin: ['human sponsor assessment entered after external-DD review'] },
    rgs,
    STUB_LLM_DEPS,
  );
  const childEnv = res.envelope;
  const childSnap = rgs.getDoctrineRenderSnapshot(childEnv.doctrineEvaluationId)! as any;
  const childDim9 = childSnap.dimOutputs?.['sponsor-borrower-quality'];
  console.log(`  NEW head        : ${childEnv.revisionId.slice(0, 18)}…   (≠ parent: ${childEnv.revisionId !== parentEnv.revisionId ? '✓ new head' : '✗ SAME'})`);
  console.log(`  child rating    : band=${childSnap.rating?.band ?? 'null'}  ratedRisk=${childSnap.rating?.ratedRisk ?? 'null'}  recommendation=${childSnap.rating?.recommendation}`);
  // The HITL parent's modifier is 0, so its ratedRisk IS the common base
  // (postOverrideRisk). The applied modifier = head.ratedRisk − parent.ratedRisk.
  const baseRisk = parentSnap.rating?.ratedRisk as number;
  const childMod = ((childSnap.rating?.ratedRisk as number) - baseRisk);
  console.log(`  child dim-9     : applicability=${childDim9?.applicability}  modifier=${childMod >= 0 ? '+' : ''}${childMod.toFixed(2)}   ← resolved from HITL to a real ±modifier`);
  console.log(`  score moved     : ${baseRisk.toFixed(3)} → ${(childSnap.rating?.ratedRisk as number).toFixed(3)}  (${(childSnap.rating?.ratedRisk ?? 0) !== (parentSnap.rating?.ratedRisk ?? 0) ? '✓ changed' : 'no change'})`);
  console.log(`  attributed      : entered ${assessment.enteredAt.slice(0, 10)} by ${assessment.enteredBy}  (provenance=${assessment.provenance})`);
  console.log(`  inputDiff shows : ${res.provenance.inputDiff.changedFields.map((f: any) => f.path).join(', ') || '(none)'}`);

  hr('§4 RENDER (new head) — human judgment DISTINCT from the DD finding');
  const childAnalysis = { ...a, graphRevisionId: childEnv.revisionId };
  const memo = renderMemoForAnalysis(childAnalysis as never, rgs);
  if (memo.ok) {
    console.log('  ' + txt(sec(memo.html, 'Sponsor Assessment')).replace(/^Sponsor Assessment\s*/, '§4→ ').slice(0, 900));
    // Determinism — re-render byte-identical §4.
    const memo2 = renderMemoForAnalysis(childAnalysis as never, rgs);
    console.log(`\n  determinism: re-render §4 byte-identical: ${memo2.ok && sec(memo.html, 'Sponsor Assessment') === sec(memo2.html, 'Sponsor Assessment') ? '✓' : '✗'}`);
  } else {
    console.log('  memo render failed:', memo.reason);
  }

  hr('FACTOR-4 SEVERE → +0.20 floor (asymmetry, doctrine unchanged)');
  const severe: HumanSponsorAssessment = {
    ...assessment, experience: 'Strong', financialStrength: 'Strong', alignment: 'Strong', managementQuality: 'Strong',
    priorCreditEvents: 'Severe', enteredAt: '2026-07-26T18:05:00.000Z',
    note: 'Prior fraud/default on record — disqualifying event.',
  };
  const resSevere = await applyRevisionDelta(
    { parentRevisionId: childEnv.revisionId, delta: { kind: 'sponsor-assessment', assessment: severe }, triggerSource: 'USER_EDIT' },
    rgs, STUB_LLM_DEPS,
  );
  const severeSnap = rgs.getDoctrineRenderSnapshot(resSevere.envelope.doctrineEvaluationId)! as any;
  // modifier = severe.ratedRisk − base (the HITL parent's ratedRisk); clamp at 1.
  const severeRisk = severeSnap.rating?.ratedRisk as number;
  const severeMod = Math.min(1, severeRisk) - Math.min(1, baseRisk);
  const floored = Math.abs(severeMod - 0.20) < 1e-9 || severeRisk >= 1; // clamps to 1 if base+0.20 exceeds
  console.log(`  factor-4 Severe (else all-Strong) → ratedRisk ${baseRisk.toFixed(3)} → ${severeRisk.toFixed(3)}  (modifier ${severeMod >= 0 ? '+' : ''}${severeMod.toFixed(2)})`);
  console.log(`  ${floored ? '✓ floored at +0.20 — an otherwise-Strong sponsor does NOT offset a disqualifying event' : '✗ expected +0.20 floor'}`);

  hr('IDEMPOTENCY — the SAME assessment (same enteredAt) is a no-op');
  const again = await applyRevisionDelta(
    { parentRevisionId: parentEnv.revisionId, delta: { kind: 'sponsor-assessment', assessment }, triggerSource: 'USER_EDIT' },
    rgs, STUB_LLM_DEPS,
  );
  console.log(`  re-entering the identical assessment → head ${again.envelope.revisionId.slice(0, 18)}…  (${again.envelope.revisionId === childEnv.revisionId ? '✓ same head, idempotent' : '✗ made a new head'})`);

  process.exit(0);
})().catch((e) => { console.error('FATAL:', e?.stack || e); process.exit(2); });
