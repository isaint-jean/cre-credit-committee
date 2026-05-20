/**
 * Evolution-manifest lint — runs in CI, NOT at runtime.
 *
 * The runtime invariant (boot-time assertions in render-schema.ts and
 * template-registry.ts) catches structural drift. This script catches a
 * different class of mistake: someone touched the schema or registry without
 * leaving the trail (a migration entry, a contract-version bump) that lets
 * future readers — and downstream workbooks — understand what changed.
 *
 * Failures:
 *   - render-schema.ts changed but RENDER_CONTRACT_VERSION did NOT bump and
 *     no migration entry was added — silent contract drift.
 *   - RENDER_CONTRACT_VERSION bumped but render-migrations.ts has no matching
 *     append step.
 *   - RENDER_CONTRACT_VERSION bumped but render-schema.ts does not register
 *     a SCHEMA_V<N> slice for the new version.
 *   - template-registry.ts grew a new (templateType, templateVersion) row but
 *     no compatibility envelope review marker accompanies it (// REVIEW(template-evolution)).
 *
 * Compares HEAD against a base ref (default: origin/main, override via
 * BASE_REF env). Exit 0 on pass, exit 1 with diagnostics on fail.
 *
 * Run: tsx apps/api/src/scripts/check-evolution-manifest.ts
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE_REF = process.env.BASE_REF ?? 'origin/main';
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '../../../..');

const SCHEMA_PATH    = 'apps/api/src/services/render-schema.ts';
const REGISTRY_PATH  = 'apps/api/src/services/template-registry.ts';
const MIGRATION_PATH = 'apps/api/src/services/render-migrations.ts';
const VERSION_PATH   = 'packages/shared/src/types/render.ts';

interface Issue {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

function git(args: string): string {
  try {
    return execSync(`git ${args}`, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch (err) {
    return '';
  }
}

function fileChanged(path: string): boolean {
  const out = git(`diff --name-only ${BASE_REF}...HEAD -- ${path}`);
  return out.split('\n').filter(Boolean).length > 0;
}

function readAtRef(ref: string, path: string): string | null {
  try {
    return execSync(`git show ${ref}:${path}`, { cwd: REPO_ROOT, encoding: 'utf8' });
  } catch {
    return null;
  }
}

function readHead(path: string): string {
  const abs = resolve(REPO_ROOT, path);
  if (!existsSync(abs)) return '';
  return readFileSync(abs, 'utf8');
}

function extractVersion(src: string): number | null {
  const m = src.match(/export\s+const\s+RENDER_CONTRACT_VERSION\s*=\s*(\d+)/);
  return m ? Number(m[1]) : null;
}

function extractRegisteredSchemaVersions(src: string): number[] {
  // Matches `4: SCHEMA_V4,` or `4: SCHEMA_V4`.
  const m = src.match(/SCHEMA_BY_CONTRACT_VERSION[^=]*=\s*\{([\s\S]*?)\};/);
  if (!m) return [];
  const body = m[1];
  const versions: number[] = [];
  const re = /(\d+)\s*:\s*SCHEMA_V/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    versions.push(Number(match[1]));
  }
  return versions.sort((a, b) => a - b);
}

function extractMigrationToVersions(src: string): number[] {
  const out = new Set<number>();
  const re = /toVersion\s*:\s*(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.add(Number(m[1]));
  return [...out].sort((a, b) => a - b);
}

function extractRegistryRowKeys(src: string): string[] {
  // Matches REGISTRY entries: `templateType: 'single_loan', templateVersion: 1,`
  const out: string[] = [];
  const re = /templateType:\s*'([^']+)',\s*templateVersion:\s*(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.push(`${m[1]}|${m[2]}`);
  return out.sort();
}

function diff<T>(a: T[], b: T[]): T[] {
  const set = new Set(b);
  return a.filter((x) => !set.has(x));
}

function checkRegistryRowsHaveReviewMarkers(src: string, addedRowKeys: string[]): boolean {
  if (addedRowKeys.length === 0) return true;
  // Each new row must be accompanied by a `// REVIEW(template-evolution)`
  // comment within 5 lines above its templateType: line. The marker forces a
  // human to look at the compatibility envelope before merge — not a runtime
  // gate, just a paper trail.
  const lines = src.split('\n');
  for (const key of addedRowKeys) {
    const [templateType, version] = key.split('|');
    const targetLine = `templateType: '${templateType}', templateVersion: ${version}`;
    const idx = lines.findIndex((l) => l.includes(targetLine));
    if (idx < 0) continue;
    const window = lines.slice(Math.max(0, idx - 5), idx).join('\n');
    if (!window.includes('REVIEW(template-evolution)')) return false;
  }
  return true;
}

function main(): void {
  const issues: Issue[] = [];

  const baseExists = git(`rev-parse --verify ${BASE_REF}`).length > 0;
  if (!baseExists) {
    process.stderr.write(
      `[evolution-manifest] base ref "${BASE_REF}" not found; skipping check.\n` +
        `Set BASE_REF or fetch the ref to enable.\n`,
    );
    process.exit(0);
  }

  const schemaChanged    = fileChanged(SCHEMA_PATH);
  const registryChanged  = fileChanged(REGISTRY_PATH);
  const migrationChanged = fileChanged(MIGRATION_PATH);
  const versionChanged   = fileChanged(VERSION_PATH);

  const headVersion = extractVersion(readHead(VERSION_PATH));
  const baseVersionSrc = readAtRef(BASE_REF, VERSION_PATH);
  const baseVersion = baseVersionSrc ? extractVersion(baseVersionSrc) : null;

  const headSchema = readHead(SCHEMA_PATH);
  const headRegistry = readHead(REGISTRY_PATH);
  const headMigration = readHead(MIGRATION_PATH);

  const headSchemaVersions    = extractRegisteredSchemaVersions(headSchema);
  const headMigrationVersions = extractMigrationToVersions(headMigration);

  // 1. Version bumped → schema must register a SCHEMA_V<N> slice for the new version.
  if (
    versionChanged &&
    baseVersion !== null &&
    headVersion !== null &&
    headVersion > baseVersion
  ) {
    if (!headSchemaVersions.includes(headVersion)) {
      issues.push({
        code: 'CONTRACT_VERSION_BUMP_WITHOUT_SCHEMA_SLICE',
        message:
          `RENDER_CONTRACT_VERSION bumped to v${headVersion} but ` +
          `SCHEMA_BY_CONTRACT_VERSION has no entry for it. Add a SCHEMA_V${headVersion} ` +
          `slice in render-schema.ts.`,
        details: {
          baseVersion,
          headVersion,
          registeredSchemaVersions: headSchemaVersions,
        },
      });
    }
    if (!headMigrationVersions.includes(headVersion)) {
      issues.push({
        code: 'CONTRACT_VERSION_BUMP_WITHOUT_MIGRATION',
        message:
          `RENDER_CONTRACT_VERSION bumped to v${headVersion} but ` +
          `render-migrations.ts has no matching toVersion entry.`,
        details: { baseVersion, headVersion, migrationToVersions: headMigrationVersions },
      });
    }
  }

  // 2. Schema changed but neither version bumped nor migration appended → silent drift.
  if (schemaChanged && !versionChanged && !migrationChanged) {
    issues.push({
      code: 'SCHEMA_CHANGE_WITHOUT_MANIFEST',
      message:
        `${SCHEMA_PATH} changed but neither RENDER_CONTRACT_VERSION nor ` +
        `render-migrations.ts moved. If the change is purely structural ` +
        `(comments/formatting), document it in commit message; otherwise ` +
        `bump the contract version and append a migration step.`,
    });
  }

  // 3. Registry grew a new row → human must have reviewed compatibility envelope.
  const baseRegistrySrc = readAtRef(BASE_REF, REGISTRY_PATH) ?? '';
  const baseRegistryKeys = extractRegistryRowKeys(baseRegistrySrc);
  const headRegistryKeys = extractRegistryRowKeys(headRegistry);
  const addedRows = diff(headRegistryKeys, baseRegistryKeys);
  if (addedRows.length && !checkRegistryRowsHaveReviewMarkers(headRegistry, addedRows)) {
    issues.push({
      code: 'TEMPLATE_REGISTRY_ROW_MISSING_REVIEW_MARKER',
      message:
        `New template-registry row(s) added without a ` +
        `// REVIEW(template-evolution) marker within 5 lines above. The ` +
        `marker forces a human to look at the compatibility envelope ` +
        `before merge.`,
      details: { addedRows },
    });
  }

  // 4. Migration appended but registry / schema both untouched.
  if (migrationChanged && !schemaChanged && !registryChanged) {
    issues.push({
      code: 'MIGRATION_WITHOUT_CARRIER_CHANGE',
      message:
        `${MIGRATION_PATH} changed but neither schema nor registry did. ` +
        `Migration entries describe shipped changes — append-only history. ` +
        `If you're correcting the description text only, say so in the commit.`,
    });
  }

  if (issues.length === 0) {
    process.stdout.write('[evolution-manifest] ok\n');
    process.exit(0);
  }

  process.stderr.write(`[evolution-manifest] ${issues.length} issue(s):\n`);
  for (const i of issues) {
    process.stderr.write(`  - [${i.code}] ${i.message}\n`);
    if (i.details) {
      process.stderr.write(`    ${JSON.stringify(i.details)}\n`);
    }
  }
  process.exit(1);
}

main();
