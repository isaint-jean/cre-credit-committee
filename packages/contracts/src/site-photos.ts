/**
 * Site-photos payload — the servicer's uploaded site-visit photos, associated to a loan.
 * The image BYTES live in the content-addressed blob store; only these small refs ride the
 * servicer_inputs TEXT column (fieldType 'site_photos'), exactly like the checklist JSON.
 *
 * ★ DISPLAY/EXPORT-ONLY, MINT-SAFE. Servicer human input — never touches the doctrine hash.
 * Chunk 1 = capture (upload/list/serve/delete); Chunk 3 embeds these into the workbook's
 * Site Photos grid at export; Chunk 4 adds resize/shrink.
 */

export interface SitePhotoRef {
  /** Content hash of the image bytes in the blob store. */
  readonly hash: string;
  /** Display order (0-based, contiguous after edits). */
  readonly order: number;
  /** Original upload filename — drives the served Content-Type + a caption. */
  readonly fileName: string;
}

export interface SitePhotosPayload {
  readonly photos: readonly SitePhotoRef[];
}

export const EMPTY_SITE_PHOTOS: SitePhotosPayload = { photos: [] };

/** Parse the stored JSON defensively — malformed / legacy → empty (never throws). */
export function parseSitePhotos(raw: string | null | undefined): SitePhotosPayload {
  if (!raw) return EMPTY_SITE_PHOTOS;
  try {
    const o = JSON.parse(raw) as Partial<SitePhotosPayload>;
    const photos = Array.isArray(o.photos)
      ? o.photos
          .filter((p): p is SitePhotoRef => !!p && typeof p.hash === 'string' && typeof p.fileName === 'string')
          .map((p, i) => ({ hash: p.hash, order: typeof p.order === 'number' ? p.order : i, fileName: p.fileName }))
      : [];
    return { photos };
  } catch {
    return EMPTY_SITE_PHOTOS;
  }
}

/** Serialize a photo list back to the stored JSON, re-indexing order contiguously. */
export function serializeSitePhotos(photos: readonly SitePhotoRef[]): string {
  return JSON.stringify({ photos: photos.map((p, i) => ({ hash: p.hash, order: i, fileName: p.fileName })) });
}
