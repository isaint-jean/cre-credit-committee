/**
 * ★ FALSIFICATION PROOF — does the LLM-primary appraisal extractor read the REAL
 * Lexington Grand values that the regex read 0/66 on? Runs a LIVE LLM call on the
 * real non-Sunroad appraisal and prints the extracted, cite-or-discard-grounded
 * core. Also runs the full adapter to show the merged 0/66 → real-core result.
 *
 * Read-only. Requires an Anthropic API key (skips gracefully if absent).
 *
 *   cd apps/api && npx tsx src/scripts/proof-appraisal-llm-lexington.ts [path-to.pdf]
 */
import { readFileSync } from 'node:fs';
import { loadAppraisalText, extractCbreAppraisal } from '../services/extract-cbre-appraisal.js';
import {
  extractCbreAppraisalLlm,
  appraisalCreditsAvailable,
  InMemoryAppraisalLlmCache,
} from '../services/extract-cbre-appraisal-llm.js';
import { runAppraisalAdapter } from '../services/extraction/adapters/appraisal.adapter.js';
import { computeBufferContentHash } from '../util/content-hash.js';

const PATH = process.argv[2] ?? '/Users/isabellesaint-jean/Downloads/Final Appraisal - Lexington Grand.pdf';

function pct(n: number | null): string { return n === null ? 'null' : `${(n * 100).toFixed(2)}%`; }
function usd(n: number | null): string { return n === null ? 'null' : `$${n.toLocaleString('en-US')}`; }

(async () => {
  if (!appraisalCreditsAvailable()) {
    console.log('⚠ No Anthropic API key — the live falsification proof needs one. Skipping.');
    console.log('  (The deterministic pipeline is proven in test:appraisal-llm.)');
    process.exit(0);
  }

  const buffer = readFileSync(PATH);
  const hash = computeBufferContentHash(buffer);
  console.log(`Lexington Grand appraisal — ${(buffer.length / 1e6).toFixed(2)} MB, hash ${hash.slice(0, 12)}`);

  // 1. Regex COLD (the 0/66 baseline).
  const regex = await extractCbreAppraisal(buffer);
  console.log('\n── REGEX (cold, the current extractor) ──');
  console.log(`  asIsValue=${usd(regex.asIsValue ?? null)}  cap=${pct(regex.overallCapRate ?? null)}  stabNOI=${usd(regex.stabilizedProForma?.netOperatingIncome ?? null)}  occ=${pct(regex.currentOccupancyPhysical ?? null)}  yearBuilt=${regex.yearBuilt ?? 'null'}`);

  // 2. LLM-primary — the fix.
  const text = await loadAppraisalText(buffer);
  const cache = new InMemoryAppraisalLlmCache();
  const llm = await extractCbreAppraisalLlm(text, hash, { cache });
  console.log('\n── LLM-PRIMARY (cite-or-discard grounded) ──');
  console.log(`  asIsValue               : ${usd(llm.asIsValue)}`);
  console.log(`  asStabilizedValue       : ${usd(llm.asStabilizedValue)}`);
  console.log(`  overallCapRate          : ${pct(llm.overallCapRate)}`);
  console.log(`  terminalCapRate         : ${pct(llm.terminalCapRate)}`);
  console.log(`  stabilizedNoi           : ${usd(llm.stabilizedNoi)}`);
  console.log(`  currentOccupancyPhysical: ${pct(llm.currentOccupancyPhysical)}`);
  console.log(`  yearBuilt               : ${llm.yearBuilt ?? 'null'}`);
  console.log(`  city / state            : ${llm.city ?? 'null'} / ${llm.state ?? 'null'}`);
  console.log(`  interestAppraised       : ${llm.interestAppraised ?? 'null'}`);
  console.log(`  methodology             : ${llm.methodology ?? 'null'}`);
  console.log(`  llmCalled=${llm.llmCalled} fromCache=${llm.fromCache}`);

  console.log('\n  ── CITE TRACES (every value grounded in a verbatim doc quote) ──');
  for (const t of llm.traces) {
    if (t.sourceQuote === null && !t.cited) continue;
    console.log(`   ${t.cited ? '✓' : '✗'} ${t.field.padEnd(26)} "${(t.sourceQuote ?? '').slice(0, 70)}"`);
  }

  // 3. Cache proof — second call is $0.
  const llm2 = await extractCbreAppraisalLlm(text, hash, { cache });
  console.log(`\n  cache: 2nd call fromCache=${llm2.fromCache} llmCalled=${llm2.llmCalled} (║ $0 re-underwrite)`);

  // 4. Full adapter — the merged 0/66 → real-core result the composer would see.
  const outcome = await runAppraisalAdapter({ buffer, kind: 'appraisal' } as never);
  const v = (outcome as { value?: typeof regex }).value;
  console.log('\n── ADAPTER (regex + LLM fallback, what the composer gets) ──');
  console.log(`  status=${(outcome as { status: string }).status}`);
  if (v) console.log(`  asIsValue=${usd(v.asIsValue ?? null)}  cap=${pct(v.overallCapRate ?? null)}  stabNOI=${usd(v.stabilizedProForma?.netOperatingIncome ?? null)}  occ=${pct(v.currentOccupancyPhysical ?? null)}  city=${v.city ?? 'null'}/${v.state ?? 'null'}`);

  const gate = llm.asIsValue !== null && llm.overallCapRate !== null && llm.currentOccupancyPhysical !== null;
  console.log(`\n${gate ? '✓ FALSIFICATION GATE MET' : '✗ GATE NOT MET'} — the 0/66 regex is now a real extraction of the core.`);
  process.exit(gate ? 0 : 1);
})().catch((e) => { console.error('FATAL:', e?.stack ?? e); process.exit(1); });
