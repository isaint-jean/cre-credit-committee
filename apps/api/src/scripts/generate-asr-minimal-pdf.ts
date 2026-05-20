/**
 * One-shot generator for apps/api/fixtures/asr-minimal.pdf.
 *
 * The fixture is consumed by test-asr-adapter-integration.ts. We use pdfkit
 * (already a dependency of apps/api) to synthesize a minimal PDF that:
 *   1. Has at least one ASR-recognized section header (EXECUTIVE SUMMARY,
 *      PROPERTY DESCRIPTION) so parseDocument's section detection produces
 *      a non-empty sections array.
 *   2. Is byte-deterministic across regeneration. pdfkit's output is stable
 *      when CreationDate, ModDate, Producer, and Creator are pinned via the
 *      info option. Verified empirically: identical SHA-256 across runs.
 *
 * How to run:
 *
 *   npx tsx apps/api/src/scripts/generate-asr-minimal-pdf.ts
 *
 * (from the repo root, or from apps/api with the path adjusted).
 *
 * After regenerating, UPDATE EXPECTED_FIXTURE_SHA in
 * apps/api/src/scripts/test-asr-adapter-integration.ts (case 4) to match
 * the new hash printed below. Otherwise the byte-stability assertion fails
 * on the first CI run after the regeneration.
 *
 * If pdfkit ever loses byte-determinism (version bump, internal refactor),
 * the byte-stability test catches it as a regression — you'll see the
 * fixture hash drift run-to-run. At that point either pin a different
 * version of pdfkit or document a content-equivalence fallback here.
 */

import PDFDocument from 'pdfkit';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.resolve(SCRIPT_DIR, '../../fixtures/asr-minimal.pdf');

/**
 * Pinned info fields. Changing any of these breaks byte-determinism
 * and forces an EXPECTED_FIXTURE_SHA update in the integration test.
 * Treat them as part of the fixture's content contract.
 */
const PINNED_INFO = {
  CreationDate: new Date('2026-01-01T00:00:00.000Z'),
  ModDate: new Date('2026-01-01T00:00:00.000Z'),
  Producer: 'asr-minimal-fixture',
  Creator: 'asr-minimal-fixture',
} as const;

async function generatePdf(): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ info: PINNED_INFO });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Content: two ASR-recognized section headers (per pdf-parser.service.ts
    // detectSections() regex) plus minimal body text. Two headers means
    // parseDocument's section-closing-on-next-header behavior produces at
    // least one populated section regardless of how it handles the trailing
    // section.
    doc.fontSize(14).text('EXECUTIVE SUMMARY', 50, 50);
    doc.fontSize(11).moveDown(0.5).text(
      'Test fixture for the ASR adapter integration test. This document is ' +
      'synthesized via generate-asr-minimal-pdf.ts and its bytes are ' +
      'byte-deterministic across regeneration when the pinned info fields ' +
      'in this script are unchanged.',
    );

    doc.fontSize(14).moveDown(1).text('PROPERTY DESCRIPTION');
    doc.fontSize(11).moveDown(0.5).text(
      '123 Main Street, Testville, CA 90000. A minimal placeholder property ' +
      'used to give parseDocument enough content to thread through to the ' +
      'ASR adapter without exercising any real AI extractor.',
    );

    doc.end();
  });
}

(async () => {
  const bytes = await generatePdf();
  const sha = createHash('sha256').update(bytes).digest('hex');

  writeFileSync(FIXTURE_PATH, bytes);

  console.log(`wrote ${bytes.length} bytes to ${FIXTURE_PATH}`);
  console.log(`SHA-256: ${sha}`);
  console.log('');
  console.log(`Update EXPECTED_FIXTURE_SHA in test-asr-adapter-integration.ts to:`);
  console.log(`  '${sha}'`);
})().catch((e) => {
  console.error('generator failed:', e);
  process.exit(1);
});
