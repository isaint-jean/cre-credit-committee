/**
 * Boot-time invariant assertion for the committee-memo FORMAT snapshot.
 *
 * Mirrors `mitigation-engine-boot-check.ts`. One check: FORMAT_DRIFT —
 * recompute the canonical hash of the frozen memo format (section
 * order, headings, callout labels, null sentinel) and compare against
 * the manifest entry for COMMITTEE_MEMO_VERSION. Throws
 * `CommitteeMemoBootCheckError` on any failure; caller (apps/api/src/
 * index.ts) propagates so the process exits non-zero before the HTTP
 * listener.
 */

import {
  COMMITTEE_MEMO_MANIFEST,
  COMMITTEE_MEMO_VERSION,
} from '@cre/contracts';
import { buildCommitteeMemoHashSnapshot } from '../services/render-memo/committee-memo-format.js';
import { computeContentHash } from './content-hash.js';

export class CommitteeMemoBootCheckError extends Error {
  override readonly name = 'CommitteeMemoBootCheckError';
  constructor(
    public readonly code:
      | 'COMMITTEE_MEMO_MANIFEST_MISSING_VERSION'
      | 'COMMITTEE_MEMO_FORMAT_DRIFT',
    message: string,
  ) {
    super(`[${code}] ${message}`);
  }
}

export function computeCurrentCommitteeMemoHash(): string {
  return computeContentHash(buildCommitteeMemoHashSnapshot());
}

export function performCommitteeMemoBootCheck(): void {
  const expectedHash = COMMITTEE_MEMO_MANIFEST[COMMITTEE_MEMO_VERSION];
  if (!expectedHash || expectedHash === '__COMMITTEE_MEMO_V1_HASH__') {
    throw new CommitteeMemoBootCheckError(
      'COMMITTEE_MEMO_MANIFEST_MISSING_VERSION',
      `no manifest entry for COMMITTEE_MEMO_VERSION='${COMMITTEE_MEMO_VERSION}'. Run \`npm run committee-memo:print-hash\` and append the result to COMMITTEE_MEMO_MANIFEST.`,
    );
  }
  const currentHash = computeCurrentCommitteeMemoHash();
  if (currentHash !== expectedHash) {
    throw new CommitteeMemoBootCheckError(
      'COMMITTEE_MEMO_FORMAT_DRIFT',
      `committee-memo format state for version '${COMMITTEE_MEMO_VERSION}' hashes to ${currentHash}, ` +
        `manifest expects ${expectedHash}. Either revert the change OR bump COMMITTEE_MEMO_VERSION ` +
        `and append a new manifest entry.`,
    );
  }
}
