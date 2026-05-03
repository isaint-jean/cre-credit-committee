/**
 * Canonical financial-value normalizer.
 *
 * SINGLE SOURCE OF TRUTH for converting raw ingestion values (strings, numbers,
 * percent-suffixed text, magnitude-suffixed text, parenthetical negatives,
 * AI JSON values) into the strict numeric form the underwriting model expects.
 *
 * No other layer is permitted to perform numeric parsing. Every ingestion
 * call site (regex extraction, AI extraction, seller-metric mapping,
 * derivation fallback) MUST route values through normalizeFinancialValue
 * before assignment.
 *
 * Field-kind contract (post-normalization units):
 *   - 'currency'      → dollars (number)
 *   - 'rate'          → decimal fraction (6.75% → 0.0675)
 *   - 'cap_rate'      → decimal fraction (4.5% → 0.045)
 *   - 'ratio'         → unitless multiple (1.25x → 1.25)
 *   - 'count'         → integer/number
 *   - 'raw_number'    → number with no unit interpretation (caller decides)
 *
 * "Bare" numerics (e.g. "4.5" with no % suffix) require the caller to supply
 * a FieldKind so context-dependent scaling is explicit and never inferred.
 */

export type FieldKind =
  | 'currency'
  | 'rate'
  | 'cap_rate'
  | 'ratio'
  | 'count'
  | 'raw_number';

const MAGNITUDE_SUFFIXES: Record<string, number> = {
  k: 1_000,
  thousand: 1_000,
  m: 1_000_000,
  mm: 1_000_000,
  mil: 1_000_000,
  million: 1_000_000,
  b: 1_000_000_000,
  bn: 1_000_000_000,
  bil: 1_000_000_000,
  billion: 1_000_000_000,
};

interface ParsedRaw {
  numeric: number;
  hadPercent: boolean;
  magnitudeMultiplier: number;
  hadCurrencyMark: boolean;
}

function parseRaw(input: string): ParsedRaw | null {
  let s = input.trim();
  if (!s) return null;

  const hadCurrencyMark = /[$£€¥]/.test(s);
  s = s.replace(/[$£€¥,\s]/g, '');

  // Parenthetical negatives: (123) or ($123) → -123
  const parenMatch = s.match(/^\(([^)]+)\)$/);
  let negFromParen = false;
  if (parenMatch) {
    s = parenMatch[1];
    negFromParen = true;
  }

  // Trailing percent
  let hadPercent = false;
  if (s.endsWith('%')) {
    hadPercent = true;
    s = s.slice(0, -1);
  }

  // Trailing magnitude suffix (longest match wins so "million" beats "m")
  let magnitudeMultiplier = 1;
  const lower = s.toLowerCase();
  const sortedSuffixes = Object.keys(MAGNITUDE_SUFFIXES).sort((a, b) => b.length - a.length);
  for (const suf of sortedSuffixes) {
    if (lower.endsWith(suf)) {
      const numericPart = s.slice(0, s.length - suf.length).trim();
      if (numericPart && /^[-+]?\d/.test(numericPart) && !/[a-zA-Z]/.test(numericPart)) {
        magnitudeMultiplier = MAGNITUDE_SUFFIXES[suf];
        s = numericPart;
        break;
      }
    }
  }

  // Bare "bps" / "basis points" suffix on rates (e.g. "550bps" → 5.5%)
  if (/bps$|basispoints?$|bp$/i.test(s)) {
    const numericPart = s.replace(/(bps|basispoints?|bp)$/i, '').trim();
    const n = Number(numericPart);
    if (Number.isFinite(n)) {
      return {
        numeric: negFromParen ? -n : n,
        hadPercent: true,
        magnitudeMultiplier: 0.01,
        hadCurrencyMark,
      };
    }
    return null;
  }

  if (!/^[-+]?(\d+(\.\d+)?|\.\d+)([eE][-+]?\d+)?$/.test(s)) return null;

  let n = Number(s);
  if (!Number.isFinite(n)) return null;
  if (negFromParen) n = -n;

  return { numeric: n, hadPercent, magnitudeMultiplier, hadCurrencyMark };
}

/**
 * Heuristic: a bare number in a 'rate' or 'cap_rate' context is interpreted as
 * a percentage (e.g. AI prompt says "6.75 for 6.75%") UNLESS the value is
 * already in plausible decimal-fraction range (≤ 1).
 *
 * Cap rate plausible range: 0.005 (0.5%) – 0.30 (30%) as decimal,
 *                           or 0.5 – 30 as percent.
 * Interest rate plausible range: 0.001 (0.1%) – 0.25 (25%) as decimal,
 *                                or 0.1 – 25 as percent.
 *
 * If the number is > 1 we treat it as a percent value (divide by 100).
 * If 0 < number ≤ 1 we treat it as already decimal.
 * Zero or negative → null (rates cannot be ≤ 0).
 */
function interpretBareRate(n: number): number | null {
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n <= 1) return n;
  return n / 100;
}

/**
 * Normalize an arbitrary ingestion input into the canonical numeric form
 * for the given field kind. Returns null for anything that cannot be
 * unambiguously interpreted.
 *
 * No other code path is permitted to perform numeric parsing.
 */
export function normalizeFinancialValue(
  input: unknown,
  kind: FieldKind = 'raw_number',
): number | null {
  if (input === null || input === undefined) return null;

  // Booleans and arrays are never valid financial values.
  if (typeof input === 'boolean' || Array.isArray(input)) return null;

  // Numeric input: skip parsing, but still apply field-kind interpretation.
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return null;
    return interpretByKind({ numeric: input, hadPercent: false, magnitudeMultiplier: 1, hadCurrencyMark: false }, kind);
  }

  // Object with a {value} field — common AI shape. Recurse into .value once.
  if (typeof input === 'object') {
    const v = (input as { value?: unknown }).value;
    if (v === undefined) return null;
    return normalizeFinancialValue(v, kind);
  }

  if (typeof input !== 'string') return null;

  const parsed = parseRaw(input);
  if (!parsed) return null;

  return interpretByKind(parsed, kind);
}

function interpretByKind(parsed: ParsedRaw, kind: FieldKind): number | null {
  const { numeric, hadPercent, magnitudeMultiplier, hadCurrencyMark } = parsed;

  switch (kind) {
    case 'currency': {
      // Percent on a currency field is a parsing mismatch — reject rather than
      // silently produce a corrupt dollar amount.
      if (hadPercent) return null;
      const v = numeric * magnitudeMultiplier;
      if (!Number.isFinite(v)) return null;
      // Domain rule: 0 is treated as "missing" for currency fields so the
      // ingestion fall-through chain (?? operator) advances to the next
      // source instead of locking in a zero. Negative dollar amounts ARE
      // valid (e.g. vacancy loss line items) and pass through unchanged.
      if (v === 0) return null;
      return v;
    }

    case 'rate':
    case 'cap_rate': {
      // Currency mark on a rate field is a mismatch.
      if (hadCurrencyMark) return null;
      let v = numeric * magnitudeMultiplier;
      if (hadPercent) {
        // Explicit percent → divide by 100 to reach decimal fraction.
        // (For the bps path, magnitudeMultiplier=0.01 has already converted
        //  basis points to percent — the /100 then takes percent → decimal.)
        v = v / 100;
      } else {
        // Bare number — decide via heuristic.
        const interpreted = interpretBareRate(v);
        if (interpreted === null) return null;
        v = interpreted;
      }
      return Number.isFinite(v) && v > 0 ? v : null;
    }

    case 'ratio': {
      if (hadCurrencyMark || hadPercent) return null;
      const v = numeric * magnitudeMultiplier;
      return Number.isFinite(v) ? v : null;
    }

    case 'count': {
      if (hadCurrencyMark || hadPercent) return null;
      const v = numeric * magnitudeMultiplier;
      return Number.isFinite(v) ? v : null;
    }

    case 'raw_number':
    default: {
      const v = numeric * magnitudeMultiplier;
      return Number.isFinite(v) ? v : null;
    }
  }
}

/**
 * Convenience helpers — explicit field-kind wrappers so call sites can't
 * accidentally pick the wrong interpretation.
 */
export const normalizeCurrency = (input: unknown): number | null =>
  normalizeFinancialValue(input, 'currency');

export const normalizeRate = (input: unknown): number | null =>
  normalizeFinancialValue(input, 'rate');

export const normalizeCapRate = (input: unknown): number | null =>
  normalizeFinancialValue(input, 'cap_rate');

export const normalizeRatio = (input: unknown): number | null =>
  normalizeFinancialValue(input, 'ratio');

export const normalizeCount = (input: unknown): number | null =>
  normalizeFinancialValue(input, 'count');

/**
 * Canonical kind for each ingestion-layer core field. Every call site that
 * normalizes by CoreFieldName MUST go through this map — never inline a kind.
 */
export const CORE_FIELD_KIND: Record<
  'noi' | 'loanAmount' | 'interestRate' | 'capRate' | 'propertyValue' | 'debtService' | 'dscr',
  FieldKind
> = {
  noi:           'currency',
  loanAmount:    'currency',
  propertyValue: 'currency',
  debtService:   'currency',
  interestRate:  'rate',
  capRate:       'cap_rate',
  dscr:          'ratio',
};
