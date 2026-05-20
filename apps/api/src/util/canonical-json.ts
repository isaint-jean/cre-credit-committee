/**
 * Canonical JSON serialization — RFC 8785 (JCS), focused subset for our domain.
 *
 * Produces a UTF-8 string in canonical form:
 *   - object keys lexicographically sorted (UTF-16 code-unit order, matching Array.sort default)
 *   - no whitespace
 *   - ECMAScript Number.prototype.toString() for finite numbers
 *   - JSON-style string escape (delegated to JSON.stringify on individual strings)
 *   - arrays preserved in declared order
 *
 * Constraints (validated; throws `CanonicalJsonError` on violation):
 *   - no `undefined` values (use `null`)
 *   - no NaN, Infinity, -Infinity
 *   - no functions, symbols, BigInt
 *   - no Maps, Sets, Dates, or other class instances — only plain objects + arrays + primitives
 *   - no cycles
 *
 * NFC normalization is NOT applied. Callers feeding Unicode strings with combining marks must
 * normalize upstream if cross-platform replay matters; for ASCII / typical financial-document
 * strings this is a non-issue. Documented limitation.
 */

export class CanonicalJsonError extends Error {
  override readonly name = 'CanonicalJsonError';
  constructor(message: string, public readonly path: readonly (string | number)[]) {
    super(`canonical-json error at ${formatPath(path)}: ${message}`);
  }
}

function formatPath(path: readonly (string | number)[]): string {
  if (path.length === 0) return '<root>';
  return path.map(p => typeof p === 'number' ? `[${p}]` : `.${p}`).join('');
}

export function canonicalize(value: unknown): string {
  return canonicalizeAt(value, [], new WeakSet());
}

function canonicalizeAt(
  value: unknown,
  path: readonly (string | number)[],
  seen: WeakSet<object>,
): string {
  if (value === null) return 'null';
  if (value === undefined) {
    throw new CanonicalJsonError('undefined is not permitted; use null', path);
  }

  switch (typeof value) {
    case 'boolean': return value ? 'true' : 'false';
    case 'number':  return canonicalizeNumber(value, path);
    case 'string':  return canonicalizeString(value);
    case 'bigint':  throw new CanonicalJsonError('bigint is not permitted', path);
    case 'function':throw new CanonicalJsonError('function is not permitted', path);
    case 'symbol':  throw new CanonicalJsonError('symbol is not permitted', path);
    case 'object':  break; // handled below
    default:        throw new CanonicalJsonError(`unsupported value type: ${typeof value}`, path);
  }

  // value is non-null object | array
  const obj = value as object;
  if (seen.has(obj)) {
    throw new CanonicalJsonError('cycle detected', path);
  }
  seen.add(obj);
  try {
    if (Array.isArray(value)) {
      const parts = value.map((v, i) => canonicalizeAt(v, [...path, i], seen));
      return `[${parts.join(',')}]`;
    }
    if (value instanceof Map) {
      throw new CanonicalJsonError('Map is not permitted; use plain object', path);
    }
    if (value instanceof Set) {
      throw new CanonicalJsonError('Set is not permitted; use array', path);
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      const ctorName = (proto as { constructor?: { name?: string } } | null)?.constructor?.name ?? 'unknown';
      throw new CanonicalJsonError(
        `class instances are not permitted; only plain objects (got ${ctorName})`,
        path,
      );
    }

    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const parts = keys.map(k =>
      `${canonicalizeString(k)}:${canonicalizeAt(record[k], [...path, k], seen)}`,
    );
    return `{${parts.join(',')}}`;
  } finally {
    seen.delete(obj);
  }
}

function canonicalizeNumber(n: number, path: readonly (string | number)[]): string {
  if (!Number.isFinite(n)) {
    throw new CanonicalJsonError(
      `non-finite number is not permitted (got ${String(n)})`,
      path,
    );
  }
  // ECMAScript Number.prototype.toString() — JCS-compatible for finite numbers.
  // (-0).toString() === '0' (sign dropped), matching JCS canonical form.
  return n.toString();
}

function canonicalizeString(s: string): string {
  // JSON-style escape for string content. JSON.stringify on a string produces a valid
  // JCS-compatible quoted form for our domain (escapes \", \\, control chars; uses \uXXXX for
  // some chars).
  return JSON.stringify(s);
}
