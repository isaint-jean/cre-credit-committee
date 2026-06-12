/**
 * Shared API package paths — resolved RELATIVE TO THIS FILE'S LOCATION,
 * so scripts work regardless of who clones the repo (no hard-coded
 * `/Users/<name>/...` literals).
 *
 * Project module mode: ESM (apps/api/tsconfig.json carries
 * `"module": "ESNext"` and the codebase already uses
 * `fileURLToPath(import.meta.url)` in sibling scripts). The CJS branch
 * is therefore not needed.
 *
 * Layout assumption:
 *   apps/api/src/lib/paths.ts   ← THIS FILE
 *   apps/api/                   ← API package root  (two dirs up from here)
 *     ├── fixtures/             ← FIXTURES_DIR (inputs: cf.xlsx, pca.pdf, …)
 *     └── data/                 ← OUTPUTS_DIR (outputs: phase*.db, …)
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filenameHere = fileURLToPath(import.meta.url);
const __dirnameHere = path.dirname(__filenameHere);

/** Absolute path to the `apps/api` package root. */
export const API_ROOT = path.resolve(__dirnameHere, '..', '..');

/** Inputs (test fixtures committed alongside source). */
export const FIXTURES_DIR = path.join(API_ROOT, 'fixtures');

/** Script outputs (sqlite snapshots, redump captures, etc.). */
export const OUTPUTS_DIR = path.join(API_ROOT, 'data');
