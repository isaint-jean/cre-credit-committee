// Strict dispatch by analysis-id format (Batch 6.8 - decision D5).
//
// Centralizes the id-format classification used at every analysis-bearing route entry.
// Pure function; no I/O; deterministic.
//
// Convention:
//   - UUID v4 (8-4-4-4-12 lowercase hex with dashes, version nibble = 4) -> 'legacy'.
//     Legacy uuid ids are issued by the legacy spine (sqlite-store).
//   - 64-character lowercase hex (no dashes) -> 'graph'. Content-hash ids are issued
//     by the new spine (record-graph store) and produced by the contracts package's
//     compute*Id factories.
//   - Anything else -> throw MalformedAnalysisIdError. Silent fallback would defeat
//     the point of strict dispatch.
//
// This is the single classification site. Route handlers MUST NOT replicate the
// regex matching inline; future changes (e.g., adding a third id format) land here.

export type IdFormat = 'legacy' | 'graph';

export class MalformedAnalysisIdError extends Error {
  override readonly name = 'MalformedAnalysisIdError';
  readonly providedId: string;

  constructor(providedId: string) {
    super(
      'analysis id does not match a known format ' +
        '(expected uuid-v4 for legacy or 64-char content-hash for graph): ' +
        JSON.stringify(providedId),
    );
    this.providedId = providedId;
  }
}

const UUID_V4_PATTERN = new RegExp(
  '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
);

const CONTENT_HASH_PATTERN = new RegExp('^[0-9a-f]{64}$');

export function dispatchByIdFormat(id: string): IdFormat {
  if (UUID_V4_PATTERN.test(id)) return 'legacy';
  if (CONTENT_HASH_PATTERN.test(id)) return 'graph';
  throw new MalformedAnalysisIdError(id);
}
