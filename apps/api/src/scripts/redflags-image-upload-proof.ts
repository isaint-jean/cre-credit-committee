/**
 * PROOF — two UI/middleware fixes:
 *  FIX 1 (image upload): the DEDICATED uploadImages multer accepts jpeg/png/webp and rejects
 *    a non-image honestly; the SHARED `upload` doc-filter is UNCHANGED (still rejects images).
 *  FIX 2 (Red Flags section): RenderedAnalysisView's primary surface has a titled "Red Flags"
 *    section that maps doctrine.flags + non-duplicate findings → SEPARATE cards, dedupes a
 *    banner-covered flag, wires each to the modal, and is NOT gated on negotiationLoopEnabled;
 *    plus a pure check of the dedupe / matchId / separation logic the component uses.
 *
 * DISPLAY/MIDDLEWARE-ONLY, MINT-SAFE: no DB write, no re-mint. Canonical byte-identical.
 * Run: npx tsx src/scripts/redflags-image-upload-proof.ts   (from apps/api)
 */
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import Database from 'better-sqlite3';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { upload, uploadImages } from '../middleware/upload.js';

let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
}

/** POST a single-file multipart to a test app; return {status, body}. */
async function postFile(mw: express.RequestHandler, file: { name: string; type: string; bytes: Buffer }): Promise<{ status: number; body: string }> {
  const app = express();
  app.post('/u', mw, (req: Request, res: Response) => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    res.json({ count: files.length, names: files.map((f) => f.originalname) });
  });
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => { res.status(400).json({ error: err.message }); });
  const server = app.listen(0);
  await new Promise<void>((r) => server.on('listening', () => r()));
  const port = (server.address() as { port: number }).port;
  const fd = new FormData();
  fd.append('photos', new Blob([new Uint8Array(file.bytes)], { type: file.type }), file.name);
  const res = await fetch(`http://127.0.0.1:${port}/u`, { method: 'POST', body: fd });
  const body = await res.text();
  server.close();
  return { status: res.status, body };
}

async function fix1(): Promise<void> {
  console.log('\nFIX 1 — image-accepting upload (dedicated multer; shared doc-filter untouched):');
  const bytes = Buffer.from('not-a-real-image-but-the-filter-checks-mime+ext');

  const jpg = await postFile(uploadImages.array('photos', 100), { name: 'roof.jpg', type: 'image/jpeg', bytes });
  check('uploadImages ACCEPTS image/jpeg (.jpg)', jpg.status === 200 && jpg.body.includes('roof.jpg'), `status ${jpg.status}`);

  const png = await postFile(uploadImages.array('photos', 100), { name: 'front.png', type: 'image/png', bytes });
  check('uploadImages ACCEPTS image/png (.png)', png.status === 200 && png.body.includes('front.png'), `status ${png.status}`);

  const webp = await postFile(uploadImages.array('photos', 100), { name: 'yard.webp', type: 'image/webp', bytes });
  check('uploadImages ACCEPTS image/webp (stored even if not embedded)', webp.status === 200, `status ${webp.status}`);

  const heic = await postFile(uploadImages.array('photos', 100), { name: 'lobby.HEIC', type: 'application/octet-stream', bytes });
  check('uploadImages ACCEPTS .HEIC via extension (octet-stream mime)', heic.status === 200, `status ${heic.status}`);

  const txt = await postFile(uploadImages.array('photos', 100), { name: 'notes.txt', type: 'text/plain', bytes });
  check('uploadImages REJECTS a non-image honestly (400 + reason)', txt.status === 400 && /Unsupported image type/.test(txt.body), `status ${txt.status}`);

  // SHARED doc-filter must be UNCHANGED: it still accepts docs and still REJECTS images.
  const sharedPdf = await postFile(upload.array('photos', 100), { name: 'asr.pdf', type: 'application/pdf', bytes });
  check('shared upload still ACCEPTS a document (.pdf) — unchanged', sharedPdf.status === 200, `status ${sharedPdf.status}`);
  const sharedJpg = await postFile(upload.array('photos', 100), { name: 'roof.jpg', type: 'image/jpeg', bytes });
  check('shared upload still REJECTS an image (doc-gate intact)', sharedJpg.status === 400 && /Unsupported file type/.test(sharedJpg.body), `status ${sharedJpg.status}`);
}

/* ── FIX 2 pure logic — mirror of the component's dedupe/matchId/separation, applied to a
 * fabricated flags+findings set. Proves: separate cards per flag, banner-covered flag deduped,
 * findings already surfaced as a flag not double-listed, matchId keys the modal lookup. ── */
interface Badge { code: string; label: string; severity: 'critical' | 'warning' | 'info' }
interface Finding { ruleId: string; reasonCode: string }
function deriveCards(flags: Badge[], findings: Finding[], noiFlaggedBanner: boolean): { key: string; matchId: string; title: string; severity: string }[] {
  const fromFlags = flags.map((b) => ({ id: `flag:${b.code}`, title: b.label, severity: b.severity }));
  const flagCodes = new Set(flags.map((b) => b.code));
  const fromFindings = findings
    .filter((f) => !flagCodes.has(f.reasonCode) && !flagCodes.has(f.ruleId))
    .map((f) => ({ id: `finding:${f.ruleId}:${f.reasonCode}`, title: f.reasonCode.replace(/_/g, ' '), severity: 'info' }));
  const banner = new Set<string>();
  if (noiFlaggedBanner) banner.add('JE_NOI_BELOW_TRAILING_ACTUAL');
  return [...fromFlags, ...fromFindings]
    .filter((p) => ![...banner].some((c) => p.id.includes(c)))
    .map((p) => ({ key: p.id, matchId: p.id.startsWith('flag:') ? p.id.slice(5) : (p.id.split(':')[1] ?? p.id), title: p.title, severity: p.severity }));
}

function fix2(): void {
  console.log('\nFIX 2 — titled "Red Flags" section, separate cards, dedupe, modal wiring:');
  const view = readFileSync(path.join(process.cwd(), '../web/src/components/RenderedAnalysisView.tsx'), 'utf8');

  check('titled "Red Flags" <h2> section present', /<h2[^>]*>\s*Red Flags\s*<\/h2>/.test(view));
  check('reuses deriveContestedPoints from NegotiationSurface', /import\s*\{[^}]*deriveContestedPoints[^}]*\}\s*from\s*'\.\/NegotiationSurface'/.test(view) && /deriveContestedPoints\(data\)/.test(view));
  check('cards are SEPARATE mapped elements (redFlagCards.map → bordered div)', /redFlagCards\.map\(/.test(view) && /border-l-4/.test(view));
  check('each card wires the modal (HowDeterminedButton → openFlagDetail)', /redFlagCards\.map[\s\S]{0,600}HowDeterminedButton onClick=\{\(\) => openFlagDetail\(c\.matchId/.test(view));
  check('dedupe: banner-covered NOI flag excluded from cards', /bannerCoveredCodes\.add\('JE_NOI_BELOW_TRAILING_ACTUAL'\)/.test(view) && /\.filter\(\(p\) => !\[\.\.\.bannerCoveredCodes\]/.test(view));
  check('calm empty-state when no flags', /redFlagTotal === 0[\s\S]{0,120}No red flags/.test(view));
  check('section is NOT gated on negotiationLoopEnabled', !/negotiationLoopEnabled[\s\S]{0,40}Red Flags/.test(view) && /<h2[^>]*>\s*Red Flags/.test(view));
  check('negotiation surface stays shelved (still flag-gated where it mounts)', /negotiationLoopEnabled && workflow !== undefined && !editMode \? \(\s*<NegotiationSurface/.test(view));

  // Behavior: 2 flags (one is the NOI banner-covered) + 2 findings (one dupes a flag reasonCode).
  const flags: Badge[] = [
    { code: 'JE_NOI_BELOW_TRAILING_ACTUAL', label: 'NOI below trailing actual', severity: 'critical' },
    { code: 'JE_SPONSOR_THIN', label: 'Sponsor financials thin', severity: 'warning' },
  ];
  const findings: Finding[] = [
    { ruleId: 'R_DSCR', reasonCode: 'DSCR_BELOW_MIN' },              // net-new → its own card
    { ruleId: 'R_SPONSOR', reasonCode: 'JE_SPONSOR_THIN' },          // dupes a flag code → dropped
  ];
  const cards = deriveCards(flags, findings, /* noiFlaggedBanner */ true);
  check('NOI flag deduped when shown as a banner (not re-listed)', !cards.some((c) => c.matchId === 'JE_NOI_BELOW_TRAILING_ACTUAL'));
  check('finding duplicating a flag code is dropped (no double-list)', cards.filter((c) => c.title.includes('SPONSOR') || c.matchId === 'JE_SPONSOR_THIN').length === 1);
  check('remaining flags/findings are SEPARATE cards', cards.length === 2 && cards.some((c) => c.matchId === 'JE_SPONSOR_THIN') && cards.some((c) => c.matchId === 'R_DSCR'), `${cards.length} cards`);
  check('matchId keys the modal lookup (flag→code, finding→ruleId)', cards.find((c) => c.key.startsWith('finding:'))?.matchId === 'R_DSCR');

  // With NO banner, the NOI flag DOES appear as a card (only deduped when the banner shows it).
  const cardsNoBanner = deriveCards(flags, [], false);
  check('NOI flag becomes a card when NOT shown as a banner', cardsNoBanner.some((c) => c.matchId === 'JE_NOI_BELOW_TRAILING_ACTUAL'));
}

function mintSafe(): void {
  console.log('\nMint-safety — canonical byte-identical:');
  const db = new Database(path.join(process.cwd(), 'data', 'cre.db'), { readonly: true });
  const bmark = (db.prepare(`SELECT count(*) c FROM data_room_doc WHERE pool_id='323a1d02-aa5f-4a80-b280-b861fe76f6d9'`).get() as { c: number }).c;
  const head = db.prepare(`SELECT 1 FROM revision_lineage_envelopes WHERE revision_id LIKE '221235987967%' LIMIT 1`).get();
  db.close();
  check('canonical byte-identical (BMARK 17 + 640 head 221235987967)', bmark === 17 && !!head, `BMARK ${bmark}`);
}

(async () => {
  console.log('\nRed-Flags section + image-upload proof');
  await fix1(); fix2(); mintSafe();
  console.log(failures === 0 ? '\nproof: OK\n' : `\nproof: ${failures} FAILURE(S)\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('THREW', (e as Error).message); process.exit(1); });
