// Runtime shape guard for RenderedAnalysis (post-6.8 consumer migration).
//
// The TYPES are imported directly from @cre/contracts (single source of truth across
// server and client). Only the RUNTIME guard lives here in apps/web - guards are
// validation logic, not types, and the contract package is intentionally type-and-
// constant-only ("do not move server-only logic or helpers into the shared contract
// package").
//
// Even with shared TS types, runtime validation is still required: the network
// response is an `unknown` payload at the wire boundary; only after this guard
// returns true can we treat it as RenderedAnalysis.

import type { RenderedAnalysis } from '@cre/contracts';

// Pure shape check on the structural keys that uniquely identify a RenderedAnalysis
// payload at the wire boundary. No id-format inspection (id-format awareness lives
// only at the server-side dispatch boundary - locked invariant).
export function isRenderedAnalysis(value: unknown): value is RenderedAnalysis {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.rootId !== 'string') return false;
  if (typeof v.id !== 'string') return false;
  const meta = v.metadata as Record<string, unknown> | undefined;
  if (typeof meta !== 'object' || meta === null) return false;
  if (typeof meta.renderVersion !== 'string') return false;
  return true;
}
