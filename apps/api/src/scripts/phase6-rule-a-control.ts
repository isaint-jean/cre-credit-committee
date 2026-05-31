/**
 * Phase 6 control test — prove Rule A (P-III-14) fires when the deal
 * actually violates the 3% floor. No LLM, no ingest — just the pure
 * engine against two synthetic FieldBags differing only on mgmt fee %.
 *
 *   cd apps/api && npx tsx src/scripts/phase6-rule-a-control.ts
 */
import { evaluatePrinciple } from '@cre/handbook-engine';
import { handbook } from '@cre/handbook-data';
import type { FieldBag } from '@cre/contracts';

const ruleA = handbook.principles.find((p) => p.id === 'P-III-14');
if (!ruleA) { console.error('FATAL: P-III-14 not found'); process.exit(1); }

(async () => {
console.log('=== Rule A control: P-III-14 ===');
console.log(`title: ${ruleA.title}`);
console.log(`executionModes: ${ruleA.executionModes}`);
console.log(`threshold: lt 0.03`);
console.log('');

// Case 1: Sunroad-as-observed (~3.35% — above floor, should SKIP no_band_matched)
const bag1: FieldBag = { mgmt_fee_pct_of_egi: 0.033540411450462417 };
const r1 = await evaluatePrinciple(ruleA, bag1);
console.log(`Case 1 — mgmt_fee_pct_of_egi=3.354% (real Sunroad):`);
console.log(`  result: ${r1.status === 'fired' ? `FIRED severity=${r1.flag.severity}  msg="${r1.flag.flag_message}"` : `SKIPPED reason=${r1.skip.reason}`}`);
console.log('');

// Case 2: synthetic 2.5% (below floor — should FIRE medium)
const bag2: FieldBag = { mgmt_fee_pct_of_egi: 0.025 };
const r2 = await evaluatePrinciple(ruleA, bag2);
console.log(`Case 2 — mgmt_fee_pct_of_egi=2.5% (synthetic below floor):`);
console.log(`  result: ${r2.status === 'fired' ? `FIRED severity=${r2.flag.severity}  msg="${r2.flag.flag_message}"` : `SKIPPED reason=${r2.skip.reason}`}`);
console.log('');

// Case 3: 0% (self-managed — should FIRE)
const bag3: FieldBag = { mgmt_fee_pct_of_egi: 0 };
const r3 = await evaluatePrinciple(ruleA, bag3);
console.log(`Case 3 — mgmt_fee_pct_of_egi=0% (synthetic self-managed):`);
console.log(`  result: ${r3.status === 'fired' ? `FIRED severity=${r3.flag.severity}  msg="${r3.flag.flag_message}"` : `SKIPPED reason=${r3.skip.reason}`}`);
console.log('');

// Case 4: undefined (no EGI → metric undefined)
const bag4: FieldBag = {};
const r4 = await evaluatePrinciple(ruleA, bag4);
console.log(`Case 4 — mgmt_fee_pct_of_egi=undefined (metric not in bag):`);
console.log(`  result: ${r4.status === 'fired' ? `FIRED` : `SKIPPED reason=${r4.skip.reason}${r4.skip.detail ? ` (${r4.skip.detail})` : ''}`}`);
})().catch((e) => { console.error(e); process.exit(2); });
