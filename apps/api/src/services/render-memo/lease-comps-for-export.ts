/**
 * loadLeaseCompsForExport — resolve the loan for an analysis, read its servicer-entered
 * 'lease_comps' (servicer_inputs), and load + resize each comp's photo for embedding at export.
 * Mirrors loadSalesCompsForExport: EXPORT/RENDER-ONLY, reads blobs + servicer_inputs, no write,
 * no re-mint. The fields pass through as-is; the photo (when present + decodable) is jimp-resized.
 */
import type { RecordGraphStore } from '../../storage/record-graph-store.js';
import type { RevisionId, ContentHash, LeaseComp } from '@cre/contracts';
import { parseLeaseComps } from '@cre/contracts';
import { recordGraphStore as defaultGraph } from '../../storage/record-graph-store.js';
import { resolveLoanForRoot } from '../pool/resolve-loan-for-root.js';
import { getServicerInput } from '../servicer-inputs.service.js';
import { blobStore as defaultBlobStore } from '../../storage/blob-store.js';
import { exportImageExtension } from './site-photos-for-export.js';
import { resizeForEmbed, type ResizedImage } from './site-photos-resize.js';

/** A lease comp ready to fill: the fields + an optional resized photo (buffer + dims). */
export interface LeaseCompForExport extends LeaseComp {
  readonly image?: { readonly buffer: Buffer; readonly width: number; readonly height: number; readonly extension: 'jpeg' };
}

export interface LeaseCompsExportDeps {
  readonly graph?: Pick<RecordGraphStore, 'getRevisionEnvelope'>;
  readonly resolve?: typeof resolveLoanForRoot;
  readonly getInput?: typeof getServicerInput;
  readonly getBlob?: (hash: ContentHash) => Promise<Buffer | null>;
  readonly resize?: (buf: Buffer) => Promise<ResizedImage | null>;
}

/** The loan's lease comps (in order), each with its photo resized for embed. [] when none. */
export async function loadLeaseCompsForExport(
  graphRevisionId: string | null | undefined,
  deps: LeaseCompsExportDeps = {},
): Promise<LeaseCompForExport[]> {
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

  const comps = parseLeaseComps(getInput(res.poolId, res.loanInPoolId, 'lease_comps')?.value ?? null).comps;

  const out: LeaseCompForExport[] = [];
  for (const c of comps) {
    let image: LeaseCompForExport['image'];
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
