/**
 * LINT FIXTURE — DELIBERATE VIOLATION.
 *
 * This file deliberately violates architecture §D7 (HARD INVARIANT — legacy
 * adapter isolation) by importing `analysis-to-adjusted-inputs.adapter.ts`
 * from inside a doctrine module (which is part of the new spine).
 *
 * Expected to be flagged by:
 *   - dependency-cruiser rule: `no-legacy-adapter-in-new-spine`
 *
 * Excluded from normal lint:boundaries / build by `__fixtures__/` exclusion.
 * Scanned only by `apps/api/src/scripts/test-extraction-isolation.ts`.
 *
 * DO NOT REMOVE THIS FILE — its purpose is to break the build if the policy
 * ever fails to fire.
 */

import * as adapter from '../../analysis-to-adjusted-inputs.adapter.js';

// `void` to defeat unused-import elision; the import edge is what matters.
export const _forbidden = adapter;
