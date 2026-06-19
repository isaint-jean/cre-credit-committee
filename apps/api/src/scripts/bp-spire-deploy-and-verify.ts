/**
 * BP SPIRE TEMPLATE — upload + activate + export verification (one-shot).
 *
 * Replicates the HTTP route flow without standing up an Express server:
 *   - POST /api/uw-intelligence/templates  → analyzeTemplateStructure + store.uploadTemplate
 *   - POST /api/uw-intelligence/templates/:id/activate (already done by upload — auto-activates)
 *   - GET  /api/uw-intelligence/templates/active/single_loan → store.getActiveTemplate
 *   - GET  /api/underwriting/export?... → composeRenderPayloadFromQuery + validate + applyRenderPayloadToTemplate
 *
 * Writes the produced workbook to /tmp/sunroad-export-test.xlsx (and to
 * /mnt/user-data/outputs if it exists) so Isabelle can open it.
 *
 * NOT committed.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { store } from '/Users/isabellesaint-jean/Code/cre-credit-committee/apps/api/src/storage/sqlite-store.js';
import { recordGraphStore } from '/Users/isabellesaint-jean/Code/cre-credit-committee/apps/api/src/storage/record-graph-store.js';
import { analyzeTemplateStructure } from '/Users/isabellesaint-jean/Code/cre-credit-committee/apps/api/src/services/template-engine.service.js';
import { applyRenderPayloadToTemplate } from '/Users/isabellesaint-jean/Code/cre-credit-committee/apps/api/src/services/template-engine.service.js';
import { projectLegacyAnalysisFromGraph } from '/Users/isabellesaint-jean/Code/cre-credit-committee/apps/api/src/services/project-legacy-analysis-from-graph.js';
import {
  validateTemplateCompatibility,
  assertTemplateCanSatisfySchema,
} from '/Users/isabellesaint-jean/Code/cre-credit-committee/apps/api/src/services/template-engine.service.js';
import { adaptAnalysisToAdjustedInputs } from '/Users/isabellesaint-jean/Code/cre-credit-committee/apps/api/src/services/analysis-to-adjusted-inputs.adapter.js';
import { hydrateUnderwritingContext } from '/Users/isabellesaint-jean/Code/cre-credit-committee/apps/api/src/services/hydrate-underwriting-context.js';
import { buildRenderPayload } from '/Users/isabellesaint-jean/Code/cre-credit-committee/apps/api/src/services/render.service.js';
import {
  resolveStructuralVariant,
  assertUnderwritingModeRegistered,
} from '/Users/isabellesaint-jean/Code/cre-credit-committee/apps/api/src/services/resolve-structural-variant.js';
import { RENDER_CONTRACT_VERSION } from '@cre/shared';

const TEMPLATE_PATH = '/Users/isabellesaint-jean/Downloads/Intelligence/Blank UW/Blank_UW_Template_v2.xlsm';
const SUNROAD_ID = '71edb76c-eb1b-4b3d-8669-bffa7b3b9737';
const OUT_LOCAL = '/tmp/sunroad-export-test.xlsx';

function section(t: string): void {
  console.log('');
  console.log('================================================================');
  console.log(t);
  console.log('================================================================');
}

(async () => {
  section('STEP 1 — Probe active template (script validates; it does not install)');
  // Single source of truth for template installation is the remediation
  // script chain (remediate-template-registry-v6.ts → -v10.ts). This script
  // does NOT seed templates anymore — fall back to a hard error pointing the
  // operator at the canonical install path so a fresh DB / dev environment
  // can't quietly create an unregistered uw_templates row (the v3/v4/v5
  // pollution shape the registry gate now also rejects from inside
  // store.uploadTemplate).
  const existing = store.getActiveTemplate('single_loan');
  if (!existing || !existing.templateMetadata) {
    console.error(
      '  ✗ No active registered single_loan template in uw_templates.\n' +
      '    Run apps/api/src/scripts/remediate-template-registry-v10.ts first ' +
      '(or the v6 remediation if the DB is at a pre-v10 state). ' +
      'This script validates the export pipeline; it no longer installs templates.',
    );
    process.exit(2);
  }
  console.log(`  ✓ Active template present: id=${existing.id} version=${existing.version} name="${existing.fileName}"`);

  section('STEP 2 — Verify probe (templates/active/single_loan)');
  const probe = store.getActiveTemplate('single_loan');
  if (!probe) { console.error('  ✗ probe returned null after upload — should be the row we just inserted'); process.exit(2); }
  console.log(`  ✓ active template: id=${probe.id} version=${probe.version} name="${probe.fileName}"`);
  console.log(`  ✓ Piece-1 UI gate will now flip to hasActiveTemplate=true → buttons render.`);

  section('STEP 3 — Run the export pipeline for Sunroad');
  // Replicate render.routes.ts:403-510 inline.
  const stored = store.getAnalysis(SUNROAD_ID);
  if (!stored) { console.error('  ✗ Sunroad analysis not found'); process.exit(2); }
  const analysis = projectLegacyAnalysisFromGraph(stored, recordGraphStore);
  console.log(`  analysis.name: ${analysis.name}`);
  console.log(`  analysis.graphRevisionId: ${analysis.graphRevisionId?.slice(0, 16)}…`);
  console.log(`  analysis.uwModel: ${analysis.uwModel === null ? 'null (unexpected)' : 'present (synthesized from graph)'}`);

  if (!analysis.uwModel) {
    console.error('  ✗ uwModel still null after projection — export pipeline requires it');
    process.exit(2);
  }

  const adjustedInputs = adaptAnalysisToAdjustedInputs(analysis);
  if (!adjustedInputs) {
    console.error('  ✗ adaptAnalysisToAdjustedInputs returned null');
    process.exit(2);
  }
  console.log(`  adjustedInputs.id: ${(adjustedInputs as { id?: string }).id?.slice(0, 16) ?? '?'}…`);

  const assetClass = 'office' as const;
  const underwritingMode = 'single_loan' as const;
  // Use the joined probe (which carries templateMetadata from the registry).
  // uploadTemplate's return doesn't include metadata.
  const targetContractVersion = probe.templateMetadata?.compatibleContractVersion ?? RENDER_CONTRACT_VERSION;
  console.log(`  targetContractVersion: ${targetContractVersion}`);

  const structuralVariantKey = resolveStructuralVariant(
    assetClass,
    adjustedInputs,
    {},
    targetContractVersion,
  );
  console.log(`  structuralVariantKey: ${structuralVariantKey}`);
  assertUnderwritingModeRegistered(assetClass, structuralVariantKey, underwritingMode, targetContractVersion);

  // Fetch the rent-roll record for v10 schema entries (per-tenant Rent Roll
  // rows + the RRP toggle). Pulls via the DoctrineEvaluation.rentRollId
  // pointer; null when the deal has no rent roll.
  const envelopeForRR = analysis.graphRevisionId
    ? recordGraphStore.getRevisionEnvelope(analysis.graphRevisionId as never)
    : null;
  const doctrineForRR = envelopeForRR
    ? recordGraphStore.getDoctrineEvaluation(envelopeForRR.doctrineEvaluationId)
    : null;
  const rentRoll = doctrineForRR?.rentRollId
    ? recordGraphStore.getRentRoll(doctrineForRR.rentRollId)
    : null;
  console.log(`  rentRoll: ${rentRoll ? `${rentRoll.lines.length} lines (id=${rentRoll.id.slice(0, 16)}…)` : 'null'}`);

  const renderInput = {
    meta: {
      dealId: analysis.id,
      dealName: analysis.name,
      generatedAt: new Date().toISOString(),
    },
    assetClass,
    structuralVariantKey,
    underwritingMode,
    adjustedInputs,
    underwritingContext: hydrateUnderwritingContext({
      analysis,
      adjustedInputs,
      mode: underwritingMode,
    }),
    drivers: analysis.crossCheckFindings ?? [],
    conservatismStatus: 'neutral' as const,
    libraryBaselineMeta: { librarySnapshotId: null, marketBenchmarksId: null },
    rentRoll,
  };

  const payload = buildRenderPayload(renderInput as never, {
    contractVersion: targetContractVersion,
  });
  console.log(`  ✓ payload built: contractVersion=${payload.contractVersion} bindings=${Object.keys(payload.cellBindings).length} tabs=${payload.visibleTabs.length}`);

  section('STEP 4 — Validate compatibility + schema');
  validateTemplateCompatibility(probe.templateMetadata!, payload);
  console.log(`  ✓ validateTemplateCompatibility passed`);
  await assertTemplateCanSatisfySchema(probe.fileData, payload);
  console.log(`  ✓ assertTemplateCanSatisfySchema passed — every schema address resolves`);

  section('STEP 5 — applyRenderPayloadToTemplate (the real populator)');
  const applied = await applyRenderPayloadToTemplate(probe.fileData, payload);
  console.log(`  ✓ populated workbook produced: ${applied.populatedBuffer.length} bytes`);
  console.log(`  writtenAddresses: ${applied.writtenAddresses.length}`);
  console.log(`  unresolvedAddresses: ${applied.unresolvedAddresses.length}`);
  console.log(`  hiddenSheets: ${applied.hiddenSheets?.length ?? 0}`);

  // Save to local /tmp + try /mnt/user-data/outputs (the user-accessible drop spot).
  writeFileSync(OUT_LOCAL, applied.populatedBuffer);
  console.log(`  → wrote ${OUT_LOCAL}`);
  const OUT_USER = '/mnt/user-data/outputs';
  if (existsSync(OUT_USER)) {
    const userPath = `${OUT_USER}/Sunroad_BPSpire_UW.xlsx`;
    writeFileSync(userPath, applied.populatedBuffer);
    console.log(`  → wrote ${userPath}`);
  } else {
    console.log(`  (${OUT_USER} does not exist — workbook saved only at ${OUT_LOCAL})`);
  }

  section('STEP 6 — Cell-value spot check on a few key bindings');
  // Show what was written by sampling specific addresses Isabelle will recognize.
  const samples = [
    'Property_Name',
    'Current_Balance',
    'Coupon',
    'Amortization_Term',
    'Concluded_Cap_Rate',
    'Concluded_Value',
    // Sheet-prefixed addresses (Operating_ProForma → 'Operating History and Pro Forma' for office)
    'Operating History and Pro Forma!P9',
    'Operating History and Pro Forma!P6',
    'Operating History and Pro Forma!P31',
    'Operating History and Pro Forma!I16',
    'Operating History and Pro Forma!J16',
    // Going-in caveats
    'Operating History and Pro Forma!J35',
    'Operating History and Pro Forma!J48',
    'Operating History and Pro Forma!J50',
    // Appraisal-ingest checksums
    'Operating History and Pro Forma!J9',
    'Operating History and Pro Forma!J6',
    'Operating History and Pro Forma!J15',
    'Operating History and Pro Forma!J22',
    'Operating History and Pro Forma!J31',
    'Operating History and Pro Forma!J32',
    'Operating History and Pro Forma!J38',
    'Conclusions & Escrows!Appraised_Value',
    'Conclusions & Escrows!D47',
    'Conclusions & Escrows!D48',
    'Conclusions & Escrows!D49',
    'Property Detail - Comm!B3',
  ];
  for (const addr of samples) {
    const v = payload.cellBindings[addr];
    const display = v === null ? 'null (awaiting_input / red-fill)'
      : v === undefined ? 'undefined (not bound — would show "BLANK ADDRESS" in red)'
      : JSON.stringify(v);
    console.log(`  ${addr.padEnd(60)} = ${display}`);
  }
  console.log('');
  console.log('  All bindings (sample of first 10):');
  const all = Object.entries(payload.cellBindings).slice(0, 25);
  for (const [a, v] of all) {
    const d = v === null ? '<null/red>' : v === undefined ? '<undef>' : String(v).slice(0, 60);
    console.log(`    ${a.padEnd(60)} = ${d}`);
  }

  section('DONE');
  console.log('Template uploaded, activated, export pipeline ran end-to-end, workbook saved.');
  console.log(`Open: ${OUT_LOCAL}`);
  process.exit(0);
})().catch((e) => {
  console.error('FATAL:', e);
  if (e && (e as { code?: string }).code) console.error('  code:', (e as { code: string }).code);
  if (e && (e as { details?: unknown }).details) console.error('  details:', JSON.stringify((e as { details: unknown }).details, null, 2));
  process.exit(2);
});
