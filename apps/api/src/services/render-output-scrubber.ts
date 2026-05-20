/**
 * Render output scrubber — provenance leak detection.
 *
 * Two consumers:
 *   - render.service.ts uses assertNoProvenanceLeak() as a HARD GATE that
 *     fails the render when any projected cell binding's value carries a
 *     filesystem path or known ingestion marker. A leak is a producer-side
 *     bug (route / resolver / judgment / extractor) and must be fixed
 *     upstream — never papered over silently here.
 *   - template-engine.service.ts uses matchProvenancePattern() to redact
 *     template-resident strings (cells, rich-text runs, hyperlinks, header /
 *     footer, workbook properties, post-write XML sweep) where the offending
 *     content predates our writes and originates from the artifact itself.
 *     That sweep is best-effort and IS allowed to redact, because the
 *     artifact is the source of truth and we cannot refuse to export it.
 *
 * Patterns matched (case-insensitive):
 *   - Windows UNC paths:        \\server\share\...
 *   - Windows drive paths:      C:\..., D:\...
 *   - POSIX absolute paths:     /Users/..., /Volumes/..., /home/..., /tmp/...,
 *                               /private/..., /var/..., /opt/...
 *   - file:// URIs
 *   - Known ingestion markers:  AFSBR, INGEST_, parser_trace, etc.
 *
 * The token set mirrors FORBIDDEN_TOKENS_BOOT in render-schema.ts (kept in
 * sync manually; the boot-time guard there exists specifically to catch
 * forbidden range NAMES, not values, so the duplication is intentional —
 * different surfaces, same vocabulary).
 */

// String patterns that indicate a filesystem-provenance leak. Each entry is
// a regex tested against the candidate string with the `i` flag.
const PROVENANCE_PATTERNS: ReadonlyArray<RegExp> = [
  // Windows UNC paths.
  /\\\\[A-Za-z0-9._-]+\\[^\\]+/,
  // Windows drive paths (C:\, Z:/, etc.).
  /\b[A-Za-z]:[\\/][A-Za-z0-9 _.-]/,
  // POSIX absolute paths, restricted to the directories that typically
  // appear in dev / CI / Mac environments. Avoid matching generic "/" leads
  // so that legitimate slash-joined display strings (e.g. "CA / 92121",
  // "Submarket / MSA") aren't falsely flagged.
  /(?:^|[\s"'(])\/(?:Users|Volumes|home|tmp|private|var|opt)\//,
  // file:// URIs.
  /\bfile:\/\//,
  // Known ingestion / debug markers.
  /\bAFSBR\b/,
  /\b(?:ingest_trace|ingestion_trace|parser_trace|extraction_trace|debug_trace)\b/,
  /\b(?:source_file|source_path|origin_path|upload_path|document_origin)\b/,
];

/**
 * True iff `s` matches any provenance pattern. Caller decides whether to
 * redact (template scrubber path) or hard-fail (render-side gate).
 */
export function matchProvenancePattern(s: string): boolean {
  if (typeof s !== 'string' || s.length === 0) return false;
  for (const re of PROVENANCE_PATTERNS) {
    if (re.test(s)) return true;
  }
  return false;
}

/**
 * Render-side hard gate. Iterates every cell binding's value and throws if
 * any string value matches a provenance pattern. Non-string values pass.
 * The message identifies the first offending cell so the producer-side fix
 * is unambiguous; subsequent offenders are NOT enumerated (fail fast).
 *
 * Signature: tolerant — `cellBindings` may be a Record, Map, or an array
 * of { address?, range?, value }. The function picks values out of any of
 * these shapes.
 */
export function assertNoProvenanceLeak(cellBindings: unknown): void {
  if (cellBindings === null || cellBindings === undefined) return;

  const entries: Array<{ address: string; value: unknown }> = [];

  if (Array.isArray(cellBindings)) {
    for (let i = 0; i < cellBindings.length; i++) {
      const b = cellBindings[i] as { address?: unknown; range?: unknown; value?: unknown };
      const address = (typeof b?.address === 'string' && b.address)
        || (typeof b?.range === 'string' && b.range)
        || `#${i}`;
      entries.push({ address, value: b?.value });
    }
  } else if (cellBindings instanceof Map) {
    for (const [k, v] of cellBindings) entries.push({ address: String(k), value: v });
  } else if (typeof cellBindings === 'object') {
    for (const [k, v] of Object.entries(cellBindings as Record<string, unknown>)) {
      // Common shape: { [address]: { value } } or { [address]: value }
      if (v !== null && typeof v === 'object' && 'value' in (v as object)) {
        entries.push({ address: k, value: (v as { value: unknown }).value });
      } else {
        entries.push({ address: k, value: v });
      }
    }
  }

  for (const { address, value } of entries) {
    if (typeof value !== 'string') continue;
    if (matchProvenancePattern(value)) {
      throw new Error(
        `PROVENANCE_LEAK: cell binding ${address} carries a filesystem / ingestion marker (${JSON.stringify(value).slice(0, 200)}). ` +
        `Fix the producer (route / resolver / judgment engine / extractor) — do not strip here.`,
      );
    }
  }
}
