/**
 * Standalone runner for the render-snapshot boot check (PR i).
 *
 *   npm run check:render-snapshot
 *
 * Exits 0 on success, 1 on any failure.
 */

import {
  performRenderSnapshotBootCheck,
  RenderSnapshotBootCheckError,
} from '../util/render-snapshot-boot-check.js';

try {
  performRenderSnapshotBootCheck();
  console.log('render-snapshot boot check: ok');
  process.exit(0);
} catch (err) {
  if (err instanceof RenderSnapshotBootCheckError) {
    console.error(`render-snapshot boot check FAILED: ${err.message}`);
  } else {
    console.error('render-snapshot boot check FAILED with unexpected error:', err);
  }
  process.exit(1);
}
