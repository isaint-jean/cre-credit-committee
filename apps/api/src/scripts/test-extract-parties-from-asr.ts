/**
 * test-extract-parties-from-asr — unit tests for the pure text→names parser.
 * The PDF-loading wrapper is intentionally NOT tested here (the PDF is a
 * non-essential input we don't want fixtures for); the regex semantics are
 * what's load-bearing for the Borrower-tab cells.
 *
 *   cd apps/api && npx tsx src/scripts/test-extract-parties-from-asr.ts
 */
import { parsePartiesFromAsrText } from '../services/extract-parties-from-asr.js';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function fail(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assertEqual<T>(a: T, b: T, m: string): void {
  if (a === b) ok(m);
  else fail(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`);
}

const SUNROAD_BORROWER = 'Sunroad Centrum Office One Partners, LP';
const SUNROAD_SPONSOR  = 'Sunroad Holding Corporation';

/* -------- Borrower Summary page (verbatim Goldman ASR format p.6) ------- */

console.log('Borrower Summary page (CMBS Goldman format, "Borrower Entity Name:" + "Sponsor / Guarantor:"):');
{
  const page6 = [
    'Ownership & Management',
    'Borrower Summary',
    'Borrower Entity Name: Sunroad Centrum Office One Partners, LP',
    'Entity Type: LLC',
    'Sponsor / Guarantor: Sunroad Holding Corporation Entity State: California',
    'Sponsor Net Worth: $57,372,000 Non-Consolidation Opinion: Yes',
    'Sponsor Liquidity: $29,845,000 Independent Director: Yes',
    'Management Company:',
    'Sunroad Asset Management Affiliated with Borrower: Yes',
    'Management Fee: 3.0% SF Under Management: TBD',
  ].join('\n');
  const result = parsePartiesFromAsrText([page6]);
  assertEqual(result.borrowerName, SUNROAD_BORROWER, 'borrowerName captures full string INCLUDING ", LP" (no truncation at comma)');
  assertEqual(result.sponsorName,  SUNROAD_SPONSOR,  'sponsorName captures full string (no bleed into "Entity State:" suffix)');
  assertEqual(result.pageReferences?.borrowerName, 1, 'pageReferences.borrowerName = 1 (single-page input)');
  assertEqual(result.pageReferences?.sponsorName,  1, 'pageReferences.sponsorName  = 1');
}

/* -------- Loan-terms restatement form ("Borrower:" / "Sponsor:") -------- */

console.log('\nLoan-terms table restatement ("Borrower: …" / "Sponsor: …" on the same row):');
{
  // Mimics the p.7 loan-terms table layout where columns wrap into one line.
  const page7 = [
    'Remaining Amort Term (mos): 0 Trade Payables Max Amount: 2.0%',
    'Interest Only Term (mos): 60 Borrower: Sunroad Centrum Office',
    'One Partners, LP',
    'Remaining IO Term (mos): 60 Sponsor: Sunroad Holding',
    'Corporation',
    'Prepayment Type: Defeasance Recourse Carveout Guarantor(s): Sunroad Holding',
    'Corporation',
  ].join('\n');
  const result = parsePartiesFromAsrText([page7]);
  assertEqual(result.borrowerName, SUNROAD_BORROWER, 'restatement form captures borrower across line wrap (preserves ", LP")');
  assertEqual(result.sponsorName,  SUNROAD_SPONSOR,  'restatement form captures sponsor across line wrap');
}

/* -------- No-match safety: no label present → null (not "", not nearby) -- */

console.log('\nNo labels present → null (not empty string, not a mis-grab of nearby text):');
{
  const noPartiesText = [
    'Transaction Overview',
    'Goldman Sachs Bank USA to provide an $85.0 million loan to refinance Sunroad Centrum.',
    'The Property is a 274,758 SF office building located in San Diego, CA.',
    'Recent Leasing & Transition to Multi-Tenant Asset.',
  ].join('\n');
  const result = parsePartiesFromAsrText([noPartiesText]);
  assertEqual(result.borrowerName, null, 'borrowerName === null when no Borrower / Borrower Entity Name label appears');
  assertEqual(result.sponsorName,  null, 'sponsorName === null when no Sponsor / Sponsor / Guarantor label appears');
}

/* -------- Empty input safety ---- */

console.log('\nEmpty input array → both null:');
{
  const result = parsePartiesFromAsrText([]);
  assertEqual(result.borrowerName, null, 'empty pages → borrowerName null');
  assertEqual(result.sponsorName,  null, 'empty pages → sponsorName null');
}

/* ----- Recourse Carveout Guarantor must NOT match "Borrower:" pattern --- */

console.log('\nRecourse Carveout Guarantor line does NOT capture borrowerName via the "Borrower:" form:');
{
  // Guard against the negative-lookbehind on the borrower regex letting the
  // Carveout-Guarantor label through.
  const text = [
    'Prepayment Type: Defeasance Recourse Carveout Guarantor(s): Sunroad Holding',
    'Corporation',
  ].join('\n');
  const result = parsePartiesFromAsrText([text]);
  assertEqual(result.borrowerName, null, 'no "Borrower:" line → borrowerName stays null (Recourse Carveout Guarantor doesn\'t leak through)');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
