/**
 * loadSitePhotosForExport — resolve the loan for an analysis (analysis → loan via the shared
 * resolver), read its Chunk-1 servicer_inputs 'site_photos' refs, and load each blob into a
 * buffer for embedding at export. EXPORT/RENDER-ONLY: reads the blob store + servicer_inputs;
 * no write, no re-mint. Only the loan's OWN photos are loaded (resolved by its loanInPoolId).
 *
 * Chunk 4 — each loaded buffer is jimp-resized (downscaled + JPEG re-encoded) before embed,
 * which also yields the pixel dims for aspect-correct placement. Unsupported image types
 * (webp/heic/…) are skipped by extension; anything jimp still can't decode is skipped too
 * (resize returns null) rather than crashing the export.
 */
import type { RecordGraphStore } from '../../storage/record-graph-store.js';
import type { RevisionId, ContentHash } from '@cre/contracts';
import { parseSitePhotos } from '@cre/contracts';
import { recordGraphStore as defaultGraph } from '../../storage/record-graph-store.js';
import { resolveLoanForRoot } from '../pool/resolve-loan-for-root.js';
import { getServicerInput } from '../servicer-inputs.service.js';
import { blobStore as defaultBlobStore } from '../../storage/blob-store.js';
import type { SitePhotoImage } from './site-photos-grid.js';
import { resizeForEmbed, type ResizedImage } from './site-photos-resize.js';

/** exceljs image extension from a filename, or null when unsupported (skip — don't corrupt). */
export function exportImageExtension(fileName: string): 'png' | 'jpeg' | 'gif' | null {
  const m = /\.([a-z0-9]+)$/i.exec((fileName ?? '').trim());
  const e = m ? m[1]!.toLowerCase() : '';
  if (e === 'png') return 'png';
  if (e === 'jpg' || e === 'jpeg') return 'jpeg';
  if (e === 'gif') return 'gif';
  return null;
}

export interface SitePhotosExportDeps {
  readonly graph?: Pick<RecordGraphStore, 'getRevisionEnvelope'>;
  readonly resolve?: typeof resolveLoanForRoot;
  readonly getInput?: typeof getServicerInput;
  readonly getBlob?: (hash: ContentHash) => Promise<Buffer | null>;
  readonly resize?: (buf: Buffer) => Promise<ResizedImage | null>;
}

/** Ordered (by ref.order) list of the loan's site photos, ready to embed. [] when none. */
export async function loadSitePhotosForExport(
  graphRevisionId: string | null | undefined,
  deps: SitePhotosExportDeps = {},
): Promise<SitePhotoImage[]> {
  if (!graphRevisionId) return [];
  const graph = deps.graph ?? defaultGraph;
  const resolve = deps.resolve ?? resolveLoanForRoot;
  const getInput = deps.getInput ?? getServicerInput;
  const getBlob = deps.getBlob ?? ((h: ContentHash) => defaultBlobStore.getBlob(h));
  const resize = deps.resize ?? resizeForEmbed;

  const env = graph.getRevisionEnvelope(graphRevisionId as RevisionId);
  if (env === null) return [];
  const res = resolve(env.doctrineEvaluationId);
  if (!res.resolved) return [];

  const refs = [...parseSitePhotos(getInput(res.poolId, res.loanInPoolId, 'site_photos')?.value ?? null).photos]
    .sort((a, b) => a.order - b.order);

  const out: SitePhotoImage[] = [];
  for (const ref of refs) {
    const ext = exportImageExtension(ref.fileName);
    if (ext === null) continue; // unsupported type → skip (never mis-embed)
    const buf = await getBlob(ref.hash as ContentHash);
    if (buf === null) continue; // blob missing → skip
    // Chunk 4 — shrink + get aspect dims. jimp can't decode it → skip gracefully.
    const r = await resize(buf);
    if (r === null) continue;
    out.push({ buffer: r.buffer, extension: r.extension, caption: `Photo ${out.length + 1}`, width: r.width, height: r.height });
  }
  return out;
}
