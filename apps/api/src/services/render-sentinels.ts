// Render sentinel utilities (Batch 6.7).
//
// Pure helpers that map raw values + flags to display strings. The single place where
// missing-data explanation logic lives. Keep this module SMALL and pure - no producers,
// no storage, no calculators, no clock, no env, no random.
//
// Read-pole semantics is permitted here per the locked architecture model: render is
// where missing data becomes "Insufficient data" / "-" badges. But this module must not
// recompute, re-derive, or aggregate values from upstream records.

import type { RenderBadge, RenderBadgeSeverity } from '@cre/contracts';

export const NULL_SENTINEL = '-' as const;
export const INSUFFICIENT_DATA_LABEL = 'Insufficient data' as const;

// Convert a numeric value to its display form. null -> sentinel. Otherwise stringify
// the number directly. Locale formatting (currency / percent) is the consumer's job;
// this module produces canonical strings so render output stays byte-stable.
export function applyNumericSentinel(value: number | null): string {
  if (value === null) return NULL_SENTINEL;
  return String(value);
}

// Convert a string-valued field to display form. null -> sentinel. Otherwise passthrough.
export function applyStringSentinel(value: string | null | undefined): string {
  if (value === null) return NULL_SENTINEL;
  if (value === undefined) return NULL_SENTINEL;
  return value;
}

// Build a render badge from a typed flag code. v1 uses the code itself as the label;
// label-translation (i18n / human-readable) is a future concern.
export function badgeFromFlag(code: string, severity: RenderBadgeSeverity): RenderBadge {
  return { code, label: code, severity };
}
