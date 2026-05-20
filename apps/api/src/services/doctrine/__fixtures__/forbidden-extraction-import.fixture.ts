/**
 * LINT FIXTURE — DELIBERATE VIOLATION.
 *
 * This file deliberately violates architecture §2.3 (`ExtractionResult`
 * isolation) in two ways, exercising BOTH enforcement layers:
 *
 *   1. Imports `ExtractionResult` symbol from `@cre/contracts` —
 *      flagged by the ESLint rule `no-restricted-imports` (importNames).
 *
 *   2. Imports the data-extraction service module —
 *      flagged by the dep-cruiser rule `no-extraction-in-non-judgment-producers`
 *      (path-based: services/data-extraction.service is in the to.path
 *      deny-list for the doctrine producer).
 *
 * Excluded from normal lint:boundaries / build by `__fixtures__/` exclusion.
 * Scanned only by `apps/api/src/scripts/test-extraction-isolation.ts`.
 *
 * DO NOT REMOVE THIS FILE — its purpose is to break the build if the policy
 * ever fails to fire.
 */

import type { ExtractionResult } from '@cre/contracts';
import * as extractionService from '../../data-extraction.service.js';

export type _ForbiddenInDoctrine = ExtractionResult;
export const _forbiddenServiceRef = extractionService;
