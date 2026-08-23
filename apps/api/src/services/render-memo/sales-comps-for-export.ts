/**
 * loadSalesCompsForExport — resolve the loan for an analysis, read its servicer-entered
 * 'sales_comps' (servicer_inputs), and load + resize each comp's photo for embedding at
 * export. Mirrors loadSitePhotosForExport: EXPORT/RENDER-ONLY, reads blobs + servicer_inputs,
 * no write, no re-mint. The comp FIELDS pass through as-is; the photo (when present + decodable)
 * is jimp-resized to a bounded size with its pixel dims for aspect-correct placement.
 */
import type { RecordGraphStore } from '../../storage/record-graph-store.js';
import type { RevisionId, ContentHash, SaleComp } from '@cre/contracts';
import { parseSalesComps } from '@cre/contracts';
import { recordGraphStore as defaultGraph } from '../../storage/record-graph-store.js';
import { resolveLoanForRoot } from '../pool/resolve-loan-for-root.js';
import { getServicerInput } from '../servicer-inputs.service.js';
import { blobStore as defaultBlobStore } from '../../storage/blob-store.js';
import { exportImageExtension } from './site-photos-for-export.js';
import { resizeForEmbed, type ResizedImage } from './site-photos-resize.js';

/** A comp ready to fill: the fields + an optional resized photo (buffer + dims). */
export interface SaleCompForExport extends SaleComp {
  readonly image?: { readonly buffer: Buffer; readonly width: number; readonly height: number; readonly extension: 'jpeg' };
}

export interface SalesCompsExportDeps {
  readonly graph?: Pick<RecordGraphStore, 'getRevisionEnvelope'>;
  readonly resolve?: typeof resolveLoanForRoot;
  readonly getInput?: typeof getServicerInput;
  readonly getBlob?: (hash: ContentHash) => Promise<Buffer | null>;
  readonly resize?: (buf: Buffer) => Promise<ResizedImage | null>;
}

/** The loan's sale comps (in order), each with its photo resized for embed. [] when none. */
export async function loadSalesCompsForExport(
  graphRevisionId: string | null | undefined,
  deps: SalesCompsExportDeps = {},
): Promise<SaleCompForExport[]> {
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

  const comps = parseSalesComps(getInput(res.poolId, res.loanInPoolId, 'sales_comps')?.value ?? null).comps;

  const out: SaleCompForExport[] = [];
  for (const c of comps) {
    // Fields always pass through; the photo is optional + best-effort (skip if undecodable).
    let image: SaleCompForExport['image'];
    if (c.photoHash !== null && exportImageExtension(c.photoFileName ?? '') !== null) {
      const buf = await getBlob(c.photoHash as ContentHash);
      if (buf !== null) {
        const r = await resize(buf);
        if (r !== null) image = { buffer: r.buffer, width: r.width, height: r.height, extension: r.extension };
      }
    }
    out.push({ ...c, image });
  }
  return out;
}
