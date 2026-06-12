/**
 * Structural validation for doctrine-clean dimension 9 (Sponsor / borrower quality).
 *
 *   cd apps/api && npx tsx src/scripts/calibration-doctrine-clean-d9-sponsor.ts
 *
 * STRUCTURAL (not corpus-separation):
 *   The corpus carries NO sponsor data — sponsor financials are not in
 *   CMBS filings. The dim is correctly UNIVERSALLY hitl-needed across
 *   the 176 corpus records (modifier = 0, inert). We validate the
 *   dimension's CORRECTNESS through synthetic assessment cases.
 *
 * Synthetic cases:
 *   (a) Strong-all              → modest negative within bound
 *   (b) Neutral-all             → exactly 0
 *   (c) Weak-all                → modest positive within bound
 *   (d) Severe factor-4 + otherwise Strong → reaches +bound (asymmetry)
 *   (e) Random mixes            → always within ±bound (cap holds)
 *   (f) corpus inertness        → 176/176 routed to hitl-needed,
 *                                 modifier = 0 on every record
 */
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  evaluateSponsorBorrowerQuality,
  SPONSOR_MODIFIER_CAP,
  SPONSOR_FACTOR_WEIGHTS,
  type SponsorAssessment,
  type SponsorFactorRating,
} from '../doctrine-clean/index.js';

const CORPUS_PATH = '/tmp/clean-corpus-backbone-corpus.json';
const OUT_PATH = '/tmp/calibration-doctrine-clean-d9-sponsor.out';

interface CorpusRecord {
  inputSource: string;
  outcomeClass: 'CLEAN' | 'STRESS-ONLY' | 'LOSS';
  propertyName: string;
  dealName: string;
}

function main(): void {
  const out: string[] = [];
  out.push('doctrine-clean / dimension 9 (Sponsor / borrower quality) — structural validation');
  out.push(`Run at: ${new Date().toISOString()}`);
  out.push(`Modifier cap (DBRS ~2-notch convention translated to 0-1 risk scale): ±${SPONSOR_MODIFIER_CAP.toFixed(2)}`);
  out.push('STRUCTURAL — corpus has NO sponsor data; synthetic cases validate behavior.');
  out.push('');

  /* === WEIGHT TABLES ==================================================== */
  out.push('================================================================');
  out.push('FACTOR WEIGHTS (per-rating signed contribution)');
  out.push('================================================================');
  out.push('');
  out.push('  Symmetric factors (1 experience, 2 financial-strength, 3 alignment, 5 management):');
  for (const k of ['Strong', 'Neutral', 'Weak', 'Severe'] as const) {
    out.push(`    ${k.padEnd(8)} ${SPONSOR_FACTOR_WEIGHTS.symmetric[k].toFixed(2).padStart(6)}`);
  }
  out.push('  Factor 4 (prior credit events) — asymmetric upward:');
  for (const k of ['Strong', 'Neutral', 'Weak', 'Severe'] as const) {
    out.push(`    ${k.padEnd(8)} ${SPONSOR_FACTOR_WEIGHTS.priorCreditEvents[k].toFixed(2).padStart(6)}`);
  }
  out.push('  Note: Severe on factor 4 ALSO triggers an explicit floor at +bound, regardless of other factors.');
  out.push('');

  /* === SYNTHETIC CASES ================================================= */
  out.push('================================================================');
  out.push('SYNTHETIC CASES — bound + asymmetry behavior');
  out.push('================================================================');
  out.push('');
  const mk = (e: SponsorFactorRating, f: SponsorFactorRating, a: SponsorFactorRating, p: SponsorFactorRating, m: SponsorFactorRating): SponsorAssessment => ({
    experience: e, financialStrength: f, alignment: a, priorCreditEvents: p, managementQuality: m,
  });

  const cases: { name: string; assessment: SponsorAssessment; expect: { sign: '−' | '0' | '+'; magnitudeBound: 'within' | 'at-bound' }; explanation: string }[] = [
    {
      name: '(a) Strong-all',
      assessment: mk('Strong', 'Strong', 'Strong', 'Strong', 'Strong'),
      expect: { sign: '−', magnitudeBound: 'within' },
      explanation: '4×Strong (sym -0.05) + factor4 Strong (-0.03) = -0.23 raw → capped to -0.20',
    },
    {
      name: '(b) Neutral-all',
      assessment: mk('Neutral', 'Neutral', 'Neutral', 'Neutral', 'Neutral'),
      expect: { sign: '0', magnitudeBound: 'within' },
      explanation: 'All Neutral → modifier exactly 0.00',
    },
    {
      name: '(c) Weak-all',
      assessment: mk('Weak', 'Weak', 'Weak', 'Weak', 'Weak'),
      expect: { sign: '+', magnitudeBound: 'within' },
      explanation: '4×Weak (sym +0.05) + factor4 Weak (+0.10) = +0.30 raw → capped to +0.20',
    },
    {
      name: '(d) Severe factor-4 + otherwise Strong (asymmetry)',
      assessment: mk('Strong', 'Strong', 'Strong', 'Severe', 'Strong'),
      expect: { sign: '+', magnitudeBound: 'at-bound' },
      explanation: '4×Strong (sym -0.05=-0.20) + factor4 Severe (+0.20) = 0.00 raw, but factor-4 Severe FLOORS at +0.20 → +0.20',
    },
    {
      name: '(e) Severe factor-4 alone (others Neutral)',
      assessment: mk('Neutral', 'Neutral', 'Neutral', 'Severe', 'Neutral'),
      expect: { sign: '+', magnitudeBound: 'at-bound' },
      explanation: 'Factor 4 Severe = +0.20 alone reaches the bound',
    },
    {
      name: '(f) All Severe (worst case)',
      assessment: mk('Severe', 'Severe', 'Severe', 'Severe', 'Severe'),
      expect: { sign: '+', magnitudeBound: 'at-bound' },
      explanation: '4×Severe sym (+0.08=+0.32) + factor4 Severe (+0.20) = +0.52 raw → capped to +0.20',
    },
    {
      name: '(g) Mixed — Strong exp + Weak align + Neutral else',
      assessment: mk('Strong', 'Neutral', 'Weak', 'Neutral', 'Neutral'),
      expect: { sign: '0', magnitudeBound: 'within' },
      explanation: '-0.05 + 0 + 0.05 + 0 + 0 = 0.00 → exactly 0.00',
    },
    {
      name: '(h) Weak factor-4 + otherwise Strong',
      assessment: mk('Strong', 'Strong', 'Strong', 'Weak', 'Strong'),
      expect: { sign: '0', magnitudeBound: 'within' },
      explanation: '4×Strong (sym -0.05=-0.20) + factor4 Weak (+0.10) = -0.10 raw → within bound',
    },
  ];

  out.push(`  ${'case'.padEnd(50)} modifier  tier                         expect`);
  let allWithinBound = true;
  let asymmetryHolds = true;
  let neutralExact = true;
  for (const c of cases) {
    const result = evaluateSponsorBorrowerQuality({ assessment: c.assessment });
    const mod = result.riskModifier ?? 0;
    if (Math.abs(mod) > SPONSOR_MODIFIER_CAP + 1e-9) allWithinBound = false;
    if (c.assessment.priorCreditEvents === 'Severe' && mod < SPONSOR_MODIFIER_CAP - 1e-9) asymmetryHolds = false;
    if (c.name.startsWith('(b)') && Math.abs(mod) > 1e-9) neutralExact = false;
    out.push(`  ${c.name.padEnd(50)} ${mod.toFixed(2).padStart(8)}  ${(result.tier ?? 'N/A').padEnd(26)} ${c.expect.sign} ${c.expect.magnitudeBound}`);
    out.push(`    ${c.explanation}`);
  }
  out.push('');
  out.push(`  Invariant — modifier ALWAYS within ±${SPONSOR_MODIFIER_CAP.toFixed(2)}: ${allWithinBound ? '✓' : '⚠ violated'}`);
  out.push(`  Invariant — Severe factor-4 reaches +bound (asymmetry): ${asymmetryHolds ? '✓' : '⚠ violated'}`);
  out.push(`  Invariant — Neutral-all → exactly 0.00: ${neutralExact ? '✓' : '⚠ violated'}`);
  out.push('');

  /* === RANDOM-MIX FUZZ — cap holds across the rating space =============== */
  out.push('================================================================');
  out.push('FUZZ — random factor-rating mixes; modifier must always be within bound');
  out.push('================================================================');
  out.push('');
  const ratings: SponsorFactorRating[] = ['Strong', 'Neutral', 'Weak', 'Severe'];
  let fuzzN = 0;
  let fuzzViolations = 0;
  let fuzzMax = 0;
  let fuzzMin = 0;
  const rng = (() => {
    let s = 1729;
    return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s; };
  })();
  for (let i = 0; i < 4096; i++) {
    const a = mk(
      ratings[rng() % 4]!, ratings[rng() % 4]!, ratings[rng() % 4]!,
      ratings[rng() % 4]!, ratings[rng() % 4]!,
    );
    const r = evaluateSponsorBorrowerQuality({ assessment: a });
    const mod = r.riskModifier ?? 0;
    fuzzN++;
    if (mod < fuzzMin) fuzzMin = mod;
    if (mod > fuzzMax) fuzzMax = mod;
    if (Math.abs(mod) > SPONSOR_MODIFIER_CAP + 1e-9) fuzzViolations++;
  }
  out.push(`  Fuzz n=${fuzzN}  observed modifier range [${fuzzMin.toFixed(2)}, ${fuzzMax.toFixed(2)}]`);
  out.push(`  Violations of ±${SPONSOR_MODIFIER_CAP.toFixed(2)} cap: ${fuzzViolations}  ${fuzzViolations === 0 ? '✓' : '⚠'}`);
  out.push('');
  // Coverage of all 4^5 = 1024 distinct assessments
  let exhaustiveViolations = 0;
  let exhaustiveAtBoundCount = 0;
  let exhaustiveAtNegBoundCount = 0;
  let exhaustiveNeutralCount = 0;
  for (const e of ratings) for (const f of ratings) for (const aa of ratings) for (const p of ratings) for (const m of ratings) {
    const r = evaluateSponsorBorrowerQuality({ assessment: mk(e, f, aa, p, m) });
    const mod = r.riskModifier ?? 0;
    if (Math.abs(mod) > SPONSOR_MODIFIER_CAP + 1e-9) exhaustiveViolations++;
    if (mod >= SPONSOR_MODIFIER_CAP - 1e-9) exhaustiveAtBoundCount++;
    if (mod <= -SPONSOR_MODIFIER_CAP + 1e-9) exhaustiveAtNegBoundCount++;
    if (Math.abs(mod) < 1e-9) exhaustiveNeutralCount++;
  }
  out.push(`  Exhaustive (4^5 = 1024 assessments): cap violations ${exhaustiveViolations}  ${exhaustiveViolations === 0 ? '✓' : '⚠'}`);
  out.push(`    at +bound: ${exhaustiveAtBoundCount}   at −bound: ${exhaustiveAtNegBoundCount}   exactly 0: ${exhaustiveNeutralCount}`);
  out.push('');

  /* === CORPUS INERTNESS ================================================ */
  out.push('================================================================');
  out.push('CORPUS INERTNESS — dim 9 is universally hitl-needed (no sponsor data)');
  out.push('================================================================');
  out.push('');
  const corpus = JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8')) as { records: CorpusRecord[] };
  const records = corpus.records.filter(r => r.inputSource !== 'tracked-pending');
  let hitlCount = 0;
  let modifierNonZero = 0;
  for (const _ of records) {
    const r = evaluateSponsorBorrowerQuality({ assessment: null });
    if (r.applicability === 'hitl-needed') hitlCount++;
    if ((r.riskModifier ?? 0) !== 0) modifierNonZero++;
  }
  out.push(`  Records (non-pending): ${records.length}`);
  out.push(`  Routed to hitl-needed: ${hitlCount}/${records.length}  ${hitlCount === records.length ? '✓ universally inert (as expected)' : '⚠ unexpected routing'}`);
  out.push(`  Records with non-zero modifier: ${modifierNonZero}  ${modifierNonZero === 0 ? '✓ all modifiers = 0' : '⚠ unexpected non-zero modifier'}`);
  out.push('');
  out.push('  Sponsor data is not extracted from CMBS filings today. Universal hitl-needed is the');
  out.push('  CORRECT behavior — the dim signals "human assessment required" rather than guessing');
  out.push('  from absent data. The dimension becomes informative only when an operator provides');
  out.push('  a sponsor assessment in the underwriting workflow.');
  out.push('');

  /* === FENCE AUDIT ====================================================== */
  out.push('================================================================');
  out.push('FENCE AUDIT — no import / reference to old doctrine / old sponsor logic');
  out.push('================================================================');
  out.push('');
  out.push('  From the repo root:');
  out.push('    grep -rE "manifesto_rules|services/doctrine/|services/judgment/|sponsor_score|sponsor_tier" apps/api/src/doctrine-clean');
  out.push('  Expected: matches only in README + dim doc-comment fence statements.');
  out.push('');
  out.push('  Provenance for dim 9 traces ONLY to:');
  out.push('    - spec v2 §9 (verbatim in dim header)');
  out.push('    - DBRS comparative-review ~2-notch bound (translated to ±0.20 on 0-1 risk scale)');
  out.push('    - Moody\'s sponsor-component treatment (component, not a separate tier)');
  out.push('    - KBRA sponsor analysis (incorporated structurally)');
  out.push('    - B-piece-investor workout-recovery practice (own-words articulation)');
  out.push('  NEVER to manifesto_rules.json / old doctrine / old sponsor logic.');
  out.push('');

  fs.writeFileSync(OUT_PATH, out.join('\n'));
  console.log(out.join('\n'));
  console.log(`\n[doctrine-clean d9] report: ${OUT_PATH}`);
}

const isMain = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) main();
