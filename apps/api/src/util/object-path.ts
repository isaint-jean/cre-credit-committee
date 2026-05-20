/**
 * Dotted-path read/write helpers for nested object access.
 *
 * Extracted in Batch 6.3 from `apps/api/src/routes/analysis.routes.ts` so the revision
 * creator can share the same path semantics. Behavior is byte-identical to the original
 * inline helpers — this is a refactor, not a logic change.
 */

export function getNestedValue(obj: any, path: string): any {
  return path.split('.').reduce((o, k) => o?.[k], obj);
}

export function setNestedValue(obj: any, path: string, value: any): void {
  const keys = path.split('.');
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    current = current[keys[i]];
    if (!current) return;
  }
  current[keys[keys.length - 1]] = value;
}
