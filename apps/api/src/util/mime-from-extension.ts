/**
 * mimeFromExtension — derive a file's MIME type from its filename extension.
 *
 * Used at the data-room DOWNLOAD/serve endpoints as a fallback when the STORED
 * mime is absent or generic ('application/octet-stream'). ZIP-unpacked docs are
 * deliberately stored octet-stream at ingest (the classifier routes on
 * filename/content, not mime), which is fine for ingest but leaves the download
 * endpoint serving Content-Type: application/octet-stream → the browser can't
 * identify the file ("unknown" / blank inline render). Deriving the type from the
 * extension at SERVE time fixes existing AND all future ZIP-dropped docs without
 * touching the ingest path or the DB.
 */

const GENERIC_MIME = 'application/octet-stream';

/** Extension (no dot, lowercase) → MIME. Unknown → octet-stream (safe default). */
const EXT_TO_MIME: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  csv: 'text/csv',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  txt: 'text/plain',
};

/** Map a filename's extension (case-insensitive) to its MIME; unknown → octet-stream. */
export function mimeFromExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  if (dot < 0 || dot === fileName.length - 1) return GENERIC_MIME;
  const ext = fileName.slice(dot + 1).toLowerCase();
  return EXT_TO_MIME[ext] ?? GENERIC_MIME;
}

/**
 * Resolve the Content-Type to serve: trust a real stored mime, else derive from
 * the filename extension. A stored mime that is absent/empty or the generic
 * octet-stream is overridden by the extension-derived type; anything else wins.
 */
export function resolveServeMime(storedMime: string | null | undefined, fileName: string): string {
  if (storedMime && storedMime !== GENERIC_MIME) return storedMime;
  return mimeFromExtension(fileName);
}
