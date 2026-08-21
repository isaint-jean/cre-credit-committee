/**
 * resizeForEmbed — Chunk 4. Shrinks a site-photo buffer before it is embedded in the
 * workbook: jimp decodes, downscales to a max long-edge (default 1200px), and re-encodes
 * as JPEG (~q80). A 4 MB phone photo → ~100–300 KB, so a 16-photo workbook is a few MB
 * rather than tens of MB. Returns the resized bytes + the resized pixel dimensions so the
 * grid can place the image aspect-correct (fit, not stretch).
 *
 * ONLY downscales — a photo already under the cap is left at its own resolution (never
 * upscaled). jimp is pure-JS (no native binary → clean Fly deploy). If jimp cannot decode
 * the buffer (corrupt bytes, or a webp/heic that slipped the extension filter), returns
 * null so the caller SKIPS that photo gracefully instead of crashing the export.
 *
 * EXPORT/RENDER-ONLY, MINT-SAFE: operates on an in-memory buffer at export time; never
 * writes the blob store, never re-mints.
 */
import { Jimp } from 'jimp';

export interface ResizedImage {
  readonly buffer: Buffer;
  readonly width: number;   // resized pixel width  (drives aspect-fit placement)
  readonly height: number;  // resized pixel height
  readonly extension: 'jpeg';
}

export async function resizeForEmbed(input: Buffer, maxEdge = 1200, quality = 80): Promise<ResizedImage | null> {
  try {
    const img = await Jimp.read(input);
    // Downscale ONLY — leave a small photo at its own resolution (scaleToFit would upscale).
    if (Math.max(img.width, img.height) > maxEdge) img.scaleToFit({ w: maxEdge, h: maxEdge });
    const out = await img.getBuffer('image/jpeg', { quality });
    return { buffer: Buffer.from(out), width: img.width, height: img.height, extension: 'jpeg' };
  } catch {
    return null; // undecodable (corrupt / webp / heic) → skip, don't crash the export
  }
}
