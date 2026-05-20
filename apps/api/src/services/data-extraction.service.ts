/**
 * Data Extraction Layer
 *
 * Reliably extracts, validates, and traces all required credit inputs from
 * ASRs and underwriting documents before underwriting begins.
 *
 * Capabilities:
 *  - Flexible field mapping via synonym recognition
 *  - Fallback derivation logic for missing fields
 *  - Extraction confidence scoring (high / medium / low)
 *  - Source traceability for every extracted value
 *  - Pre-validation gate to block underwriting on incomplete data
 */

import type {
  ParsedDocument,
  DocumentSection,
  CoreFieldName,
  DescriptorFieldName,
  StructuralFieldName,
  ExtractedField,
  ExtractedDescriptor,
  ExtractionResult,
  ExtractionConfidence,
  PreValidationGateResult,
  SellerExtractedMetrics,
} from '@cre/shared';
import {
  impliedValuePrimitive,
  normalizeFinancialValue,
  CORE_FIELD_KIND,
} from '@cre/shared';

// ---------------------------------------------------------------------------
// 1) Synonym Maps — canonical field names to known label variants
// ---------------------------------------------------------------------------

const FIELD_SYNONYMS: Record<CoreFieldName, string[]> = {
  noi: [
    'NOI',
    'Net Operating Income',
    'Stabilized NOI',
    'In-Place NOI',
    'Underwritten NOI',
    'Pro Forma NOI',
    'Adjusted NOI',
    'Net Income',
  ],
  loanAmount: [
    'Loan Amount',
    'Loan Proceeds',
    'Facility Size',
    'Total Debt',
    'Mortgage Amount',
    'First Mortgage',
    'Senior Loan',
    'Loan Balance',
    'Principal Balance',
    'Original Balance',
    'Cut-off Balance',
  ],
  interestRate: [
    'Interest Rate',
    'Coupon',
    'SOFR + Spread',
    'All-in Rate',
    'Note Rate',
    'Mortgage Rate',
    'Fixed Rate',
    'Floating Rate',
    'Coupon Rate',
    'Weighted Average Rate',
    'All-In Coupon',
  ],
  capRate: [
    'Cap Rate',
    'Exit Cap',
    'Going-in Yield',
    'Going-In Cap Rate',
    'Capitalization Rate',
    'Terminal Cap Rate',
    'Reversionary Cap Rate',
    'Exit Cap Rate',
    'Stabilized Cap Rate',
  ],
  propertyValue: [
    'Property Value',
    'Appraised Value',
    'As-Is Value',
    'Stabilized Value',
    'Market Value',
    'Valuation',
    'Implied Value',
    'As-Stabilized Value',
    'As-Complete Value',
  ],
};

// ---------------------------------------------------------------------------
// 2) Label-pattern builder
// ---------------------------------------------------------------------------
//
// All numeric parsing is delegated to the canonical normalizer
// (normalizeFinancialValue from @cre/shared). This file is permitted ONLY to
// locate the raw token after a label; interpretation is the normalizer's job.

/**
 * Build a regex pattern that matches a label followed by a raw value token.
 *
 * Separator class includes `|` (table-pipe), tab, colon, equals, and the
 * various dash glyphs. The captured value token is intentionally permissive —
 * it grabs anything that looks like a financial scalar (digits, $, %, commas,
 * decimals, suffixes like "M"/"MM"/"K"/"bps", parenthetical negatives) so the
 * canonical normalizer can interpret it.
 */
function buildLabelPattern(label: string): RegExp {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Capture group: optional currency mark / sign / paren, digits with commas
  // and optional decimal, optional magnitude or percent suffix.
  const valueToken =
    `(\\(?\\s*[$£€¥]?\\s*[-+]?[\\d,]+(?:\\.\\d+)?\\s*` +
    `(?:%|bps|bp|basis\\s*points?|MM|M|K|B|BN|million|billion|thousand|mil|bil)?\\s*\\)?)`;
  return new RegExp(
    `${escaped}[\\s:=\\-–—\\t|]*${valueToken}`,
    'i',
  );
}

// ---------------------------------------------------------------------------
// 3) Field extraction from document text
// ---------------------------------------------------------------------------

interface RawMatch {
  value: number;
  confidence: ExtractionConfidence;
  originalLabel: string;
  sourceLocation: string;
  method: 'exact_match' | 'synonym_match';
}

/**
 * Search all sections for a field using its synonym list.
 * Returns the best match (highest confidence, first occurrence).
 */
function searchFieldInSections(
  fieldName: CoreFieldName,
  sections: DocumentSection[],
  sourceLabel: string, // e.g. "ASR" or "Seller UW"
): RawMatch | null {
  const synonyms = FIELD_SYNONYMS[fieldName];
  let bestMatch: RawMatch | null = null;

  for (const section of sections) {
    const text = section.content;
    // Also search tabular data if present
    const tableText = section.tables
      ? section.tables.map(t =>
          [t.headers.join(' | '), ...t.rows.map(r => r.join(' | '))].join('\n')
        ).join('\n')
      : '';
    const combinedText = text + '\n' + tableText;

    for (let si = 0; si < synonyms.length; si++) {
      const synonym = synonyms[si];
      const pattern = buildLabelPattern(synonym);
      const match = combinedText.match(pattern);

      if (match && match[1]) {
        const numericValue = normalizeFinancialValue(match[1], CORE_FIELD_KIND[fieldName]);
        if (numericValue === null || numericValue === 0) continue;

        // First synonym in the list is the canonical label — exact match
        const isExact = si === 0;
        const confidence: ExtractionConfidence = isExact ? 'high' : 'high';
        // Both exact and synonym matches from the document are high confidence
        // because we found the label in the text. "medium" is reserved for derived values.

        const candidate: RawMatch = {
          value: numericValue,
          confidence,
          originalLabel: synonym,
          sourceLocation: `${sourceLabel} — "${section.title}" (p. ${section.pageStart}–${section.pageEnd})`,
          method: isExact ? 'exact_match' : 'synonym_match',
        };

        // Prefer exact matches over synonym matches
        if (!bestMatch || (isExact && bestMatch.method === 'synonym_match')) {
          bestMatch = candidate;
          if (isExact) break; // Can't do better
        }
      }
    }
    if (bestMatch?.method === 'exact_match') break; // Stop searching sections
  }

  return bestMatch;
}

/**
 * Search for a field across multiple document sources.
 */
function searchField(
  fieldName: CoreFieldName,
  asrDoc: ParsedDocument,
  uwDoc?: ParsedDocument | null,
): RawMatch | null {
  // Try seller UW first (more authoritative for financial figures)
  if (uwDoc) {
    const uwMatch = searchFieldInSections(fieldName, uwDoc.sections, 'Seller UW');
    if (uwMatch) return uwMatch;
  }
  // Fall back to ASR
  return searchFieldInSections(fieldName, asrDoc.sections, 'ASR');
}

// ---------------------------------------------------------------------------
// 4) Fallback derivation logic
// ---------------------------------------------------------------------------

interface FieldValues {
  noi: number | null;
  loanAmount: number | null;
  interestRate: number | null;
  capRate: number | null;
  propertyValue: number | null;
}

/**
 * Attempt to derive missing fields from available ones.
 *
 * Cap rate is treated as a decimal fraction throughout (system invariant:
 * 4.5% = 0.045). Upstream parsing is responsible for normalizing inputs.
 *
 * Implied Value derivation delegates to the SSOT primitive
 * (impliedValuePrimitive) — do NOT inline NOI/capRate division here.
 */
function deriveField(
  fieldName: CoreFieldName,
  known: FieldValues,
): { value: number; formula: string } | null {
  switch (fieldName) {
    case 'propertyValue': {
      // Property value = implied value when derived from NOI and cap rate.
      if (known.noi == null || known.capRate == null) break;
      const v = impliedValuePrimitive(known.noi, known.capRate);
      if (v === null) break;
      return { value: v, formula: 'NOI / Cap Rate' };
    }

    case 'capRate': {
      // Inverse of impliedValuePrimitive: cap_rate = NOI / property_value.
      // Returns decimal fraction (e.g. 0.045), consistent with the SSOT unit.
      if (known.noi == null || known.propertyValue == null || known.propertyValue <= 0) break;
      if (!Number.isFinite(known.noi) || !Number.isFinite(known.propertyValue)) break;
      const v = known.noi / known.propertyValue;
      if (!Number.isFinite(v)) break;
      return { value: v, formula: 'NOI / Property Value' };
    }

    case 'noi': {
      // Inverse of impliedValuePrimitive: NOI = property_value * cap_rate.
      if (known.propertyValue == null || known.capRate == null || known.capRate <= 0) break;
      if (!Number.isFinite(known.propertyValue) || !Number.isFinite(known.capRate)) break;
      const v = known.propertyValue * known.capRate;
      if (!Number.isFinite(v)) break;
      return { value: v, formula: 'Property Value * Cap Rate' };
    }

    // Loan Amount and Interest Rate cannot be derived — they are contractual terms
    case 'loanAmount':
    case 'interestRate':
      return null;
  }

  return null;
}

// ---------------------------------------------------------------------------
// 5) Also check AI-extracted seller metrics for values
// ---------------------------------------------------------------------------

/**
 * If the AI already extracted seller metrics, use them as a secondary source.
 * These get 'medium' confidence since they came from AI extraction,
 * not direct label matching.
 */
function checkSellerMetrics(
  fieldName: CoreFieldName,
  sellerMetrics: SellerExtractedMetrics | null,
): ExtractedField | null {
  if (!sellerMetrics) return null;

  const mapping: Record<CoreFieldName, keyof SellerExtractedMetrics> = {
    noi: 'noi',
    loanAmount: 'loanAmount',
    interestRate: 'interestRate',
    capRate: 'capRate',
    propertyValue: 'propertyValue',
  };

  const key = mapping[fieldName];
  const metric = sellerMetrics[key];
  if (!metric) return null;

  // Route AI-supplied value through the canonical normalizer. AI may emit
  // strings ("$25M", "6.75%") or already-numeric values; normalization is
  // idempotent on properly typed input.
  const normalized = normalizeFinancialValue(metric.value, CORE_FIELD_KIND[fieldName]);
  if (normalized === null || normalized === 0) return null;

  return {
    value: normalized,
    confidence: 'medium',
    originalLabel: key,
    sourceLocation: metric.source || 'AI-extracted seller metric',
    method: 'synonym_match',
  };
}

// ---------------------------------------------------------------------------
// 5b) Descriptor extraction (string-valued)
// ---------------------------------------------------------------------------
//
// Extracts property identity, addressing, classification, and counterparty
// names. Different mechanic from numeric extraction: we capture the raw
// string after a label, trim, and reject obvious provenance leaks (filenames,
// filesystem paths) at the source. No semantic interpretation here — values
// are stored verbatim for downstream consumers.

const DESCRIPTOR_SYNONYMS: Record<DescriptorFieldName, string[]> = {
  propertyName: [
    'Property Name', 'Property', 'Asset Name', 'Asset', 'Project Name', 'Subject Property',
  ],
  street: [
    'Street Address', 'Property Address', 'Address', 'Site Address',
  ],
  city: ['City', 'Municipality'],
  state: ['State', 'Province'],
  zip: ['ZIP', 'Postal Code', 'Zip Code'],
  propertyType: [
    'Property Type', 'Asset Type', 'Asset Class', 'Property Class', 'Use', 'Property Use',
  ],
  borrowerName: ['Borrower', 'Borrower Name', 'Obligor'],
  sponsorName: ['Sponsor', 'Sponsor Name', 'Key Principal', 'Sponsorship'],
};

/**
 * Build a regex that matches a label followed by a free-text value. Captures
 * the run of non-newline / non-pipe characters after the label separator, up
 * to a sensible terminator. Tighter than the numeric pattern — descriptors
 * are short noun phrases, never multi-line content.
 */
function buildDescriptorPattern(label: string): RegExp {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Capture group: anything except line-ending / pipe / tab. Bounded length
  // to prevent runaway matches into adjacent paragraphs.
  return new RegExp(
    `${escaped}[\\s:=\\-–—\\t|]+([^\\n\\r\\t|]{1,200}?)(?=\\s{2,}|\\n|\\r|\\t|\\|| {3,}|$)`,
    'i',
  );
}

/**
 * Reject obvious non-values: filenames, filesystem paths, raw URLs, single
 * punctuation tokens, all-numeric strings (which usually belong to numeric
 * fields). ZIP code is the one descriptor that is legitimately pure-numeric
 * — pass `allowNumeric: true` for it.
 *
 * Returns null when the value should be discarded; trimmed string otherwise.
 */
function cleanDescriptorValue(raw: string, allowNumeric = false): string | null {
  const trimmed = raw.trim().replace(/\s{2,}/g, ' ');
  if (!trimmed) return null;
  if (trimmed.length < 2) return null;
  if (!allowNumeric && /^[\d.,$%-]+$/.test(trimmed)) return null;
  // Reject provenance / path leaks at the source.
  if (/[A-Za-z]:[\\/]/.test(trimmed)) return null;        // Windows drive letter
  if (/\\\\[^\\\s]+\\/.test(trimmed)) return null;        // UNC
  if (/\/Users\/|\/Volumes\/|\/private\/|\/tmp\/|\/home\//.test(trimmed)) return null;
  if (/\S+\.(pdf|xlsx?|xlsm|docx?|pptx?|csv|txt|zip)\b/i.test(trimmed)) return null;
  if (/\bAFSBR\b/i.test(trimmed)) return null;
  return trimmed;
}

interface RawDescriptorMatch {
  value: string;
  confidence: ExtractionConfidence;
  originalLabel: string;
  sourceLocation: string;
  method: 'exact_match' | 'synonym_match';
}

function searchDescriptorInSections(
  fieldName: DescriptorFieldName,
  sections: DocumentSection[],
  sourceLabel: string,
): RawDescriptorMatch | null {
  const synonyms = DESCRIPTOR_SYNONYMS[fieldName];
  let best: RawDescriptorMatch | null = null;

  for (const section of sections) {
    const text = section.content;
    const tableText = section.tables
      ? section.tables.map(t =>
          [t.headers.join(' | '), ...t.rows.map(r => r.join(' | '))].join('\n')
        ).join('\n')
      : '';
    const combined = text + '\n' + tableText;

    for (let si = 0; si < synonyms.length; si++) {
      const synonym = synonyms[si];
      const pattern = buildDescriptorPattern(synonym);
      const match = combined.match(pattern);
      if (!match || !match[1]) continue;
      const cleaned = cleanDescriptorValue(match[1], fieldName === 'zip');
      if (!cleaned) continue;

      const isExact = si === 0;
      const candidate: RawDescriptorMatch = {
        value: cleaned,
        confidence: 'high',
        originalLabel: synonym,
        sourceLocation: `${sourceLabel} — "${section.title}" (p. ${section.pageStart}–${section.pageEnd})`,
        method: isExact ? 'exact_match' : 'synonym_match',
      };
      if (!best || (isExact && best.method === 'synonym_match')) {
        best = candidate;
        if (isExact) break;
      }
    }
    if (best?.method === 'exact_match') break;
  }
  return best;
}

function searchDescriptor(
  fieldName: DescriptorFieldName,
  asrDoc: ParsedDocument,
  uwDoc?: ParsedDocument | null,
): RawDescriptorMatch | null {
  if (uwDoc) {
    const m = searchDescriptorInSections(fieldName, uwDoc.sections, 'Seller UW');
    if (m) return m;
  }
  return searchDescriptorInSections(fieldName, asrDoc.sections, 'ASR');
}

const DESCRIPTOR_FIELDS: DescriptorFieldName[] = [
  'propertyName', 'street', 'city', 'state', 'zip',
  'propertyType', 'borrowerName', 'sponsorName',
];

function extractDescriptors(
  asrDoc: ParsedDocument,
  uwDoc?: ParsedDocument | null,
): Record<DescriptorFieldName, ExtractedDescriptor> {
  const out = {} as Record<DescriptorFieldName, ExtractedDescriptor>;
  for (const fieldName of DESCRIPTOR_FIELDS) {
    const m = searchDescriptor(fieldName, asrDoc, uwDoc);
    out[fieldName] = m
      ? { value: m.value, confidence: m.confidence, originalLabel: m.originalLabel, sourceLocation: m.sourceLocation, method: m.method }
      : { value: null, confidence: 'low', originalLabel: null, sourceLocation: null, method: 'not_found' };
  }
  return out;
}

// ---------------------------------------------------------------------------
// 5c) Structural numeric extraction
// ---------------------------------------------------------------------------
//
// Loan term, amortization, IO period (months); year built; building size;
// unit count; occupancy. Reuses the numeric label-pattern + normalizer
// machinery from §2-§3 but with field-specific synonyms and unit handling.

const STRUCTURAL_SYNONYMS: Record<StructuralFieldName, string[]> = {
  loanTermMonths: [
    'Loan Term', 'Term', 'Maturity (months)', 'Maturity (years)', 'Loan Maturity',
    'Term to Maturity', 'Balloon Term',
  ],
  amortizationMonths: [
    'Amortization', 'Amortization Term', 'Amort Period', 'Amort', 'Amortization Period',
  ],
  ioMonths: [
    'Interest Only Period', 'IO Period', 'I/O Period', 'Interest-Only', 'IO',
    'Interest Only',
  ],
  yearBuilt: ['Year Built', 'Built', 'Year of Construction', 'Construction Year'],
  totalSquareFeet: [
    'Net Rentable Area', 'NRA', 'Rentable Square Feet', 'Total Square Feet',
    'Total SF', 'Building Size', 'Gross Building Area', 'GBA',
  ],
  units: ['Units', 'Total Units', 'Unit Count', 'Number of Units'],
  occupancy: ['Occupancy', 'Occupancy Rate', 'Physical Occupancy', 'Economic Occupancy'],
};

/**
 * Field-kind for structural numerics — uses the canonical FieldKind enum
 * from @cre/shared. occupancy is a percent → ratio; everything else is a
 * count/integer.
 */
const STRUCTURAL_KIND: Record<StructuralFieldName, 'rate' | 'count'> = {
  loanTermMonths:     'count',
  amortizationMonths: 'count',
  ioMonths:           'count',
  yearBuilt:          'count',
  totalSquareFeet:    'count',
  units:              'count',
  occupancy:          'rate',
};

/**
 * Build a structural-numeric pattern that captures BOTH the numeric token
 * AND any trailing unit word (years|yrs|months|mos|%). Time-period fields
 * use this to distinguish "10 years" from "10 months" without inferring.
 *
 * Value token is intentionally tighter than the core-field pattern: just
 * digits, optional decimal, no magnitude suffix. Magnitude suffix handling
 * is unnecessary for structural fields (terms, sizes, units, occupancy)
 * and would otherwise greedily eat the whitespace before the unit word,
 * preventing the unit detector from firing.
 */
function buildStructuralLabelPattern(label: string): RegExp {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Group 1: numeric value (digits + optional decimal).
  // Group 2: optional unit word — years/yrs/months/mos/percent.
  const valueToken = `([\\d,]+(?:\\.\\d+)?)`;
  const unitToken = `(?:\\s*(years?|yrs?|months?|mos?|%)\\b)?`;
  return new RegExp(
    `${escaped}[\\s:=\\-–—\\t|]*${valueToken}${unitToken}`,
    'i',
  );
}

/**
 * Some structural fields are commonly stated in years even though we want
 * months internally. Detection looks at BOTH the matched label AND the unit
 * word captured immediately after the value token (e.g. "Loan Term: 10 years"
 * captures unit="years" → multiply by 12).
 */
function normalizeStructuralValue(
  fieldName: StructuralFieldName,
  rawToken: string,
  matchedLabel: string,
  unitToken: string | undefined,
): number | null {
  const v = normalizeFinancialValue(rawToken, STRUCTURAL_KIND[fieldName]);
  if (v === null) return null;
  const isTimePeriod =
    fieldName === 'loanTermMonths' ||
    fieldName === 'amortizationMonths' ||
    fieldName === 'ioMonths';
  if (isTimePeriod) {
    const yearsByLabel = /years/i.test(matchedLabel);
    const yearsByUnit  = !!unitToken && /^(years?|yrs?)$/i.test(unitToken);
    if (yearsByLabel || yearsByUnit) return Math.round(v * 12);
  }
  return v;
}

function searchStructuralInSections(
  fieldName: StructuralFieldName,
  sections: DocumentSection[],
  sourceLabel: string,
): { value: number; confidence: ExtractionConfidence; originalLabel: string; sourceLocation: string; method: 'exact_match' | 'synonym_match' } | null {
  const synonyms = STRUCTURAL_SYNONYMS[fieldName];
  let best: ReturnType<typeof searchStructuralInSections> | null = null;

  for (const section of sections) {
    const tableText = section.tables
      ? section.tables.map(t =>
          [t.headers.join(' | '), ...t.rows.map(r => r.join(' | '))].join('\n')
        ).join('\n')
      : '';
    const combined = section.content + '\n' + tableText;

    for (let si = 0; si < synonyms.length; si++) {
      const synonym = synonyms[si];
      const pattern = buildStructuralLabelPattern(synonym);
      const m = combined.match(pattern);
      if (!m || !m[1]) continue;
      const v = normalizeStructuralValue(fieldName, m[1], synonym, m[2]);
      if (v === null || v <= 0) continue;
      const isExact = si === 0;
      const candidate = {
        value: v,
        confidence: 'high' as ExtractionConfidence,
        originalLabel: synonym,
        sourceLocation: `${sourceLabel} — "${section.title}" (p. ${section.pageStart}–${section.pageEnd})`,
        method: (isExact ? 'exact_match' : 'synonym_match') as 'exact_match' | 'synonym_match',
      };
      if (!best || (isExact && best.method === 'synonym_match')) {
        best = candidate;
        if (isExact) break;
      }
    }
    if (best?.method === 'exact_match') break;
  }
  return best;
}

const STRUCTURAL_FIELDS: StructuralFieldName[] = [
  'loanTermMonths', 'amortizationMonths', 'ioMonths',
  'yearBuilt', 'totalSquareFeet', 'units', 'occupancy',
];

function extractStructural(
  asrDoc: ParsedDocument,
  uwDoc?: ParsedDocument | null,
): Record<StructuralFieldName, ExtractedField> {
  const out = {} as Record<StructuralFieldName, ExtractedField>;
  for (const fieldName of STRUCTURAL_FIELDS) {
    let match = null;
    if (uwDoc) match = searchStructuralInSections(fieldName, uwDoc.sections, 'Seller UW');
    if (!match) match = searchStructuralInSections(fieldName, asrDoc.sections, 'ASR');
    out[fieldName] = match
      ? { value: match.value, confidence: match.confidence, originalLabel: match.originalLabel, sourceLocation: match.sourceLocation, method: match.method }
      : { value: null, confidence: 'low', originalLabel: null, sourceLocation: null, method: 'not_found' };
  }
  return out;
}

// ---------------------------------------------------------------------------
// 5d) Comparables / CMBS linkage references
// ---------------------------------------------------------------------------
//
// Surface a flat list of strings the source documents mention as comp / CMBS
// references — deal codes, sales-comp property names, lease-comp tenants.
// No resolution to an external comp database happens here; the extractor
// only collects literals so a future retrieval layer can act on them.

const COMP_LINKAGE_PATTERNS: ReadonlyArray<RegExp> = [
  // "CMBS Deal Code: BMARK 2023-V4" — captures full deal-name including
  // optional year-version suffix.
  /\bCMBS\s+(?:Deal\s+)?(?:Code|ID|Identifier)[:\s]+([A-Z][A-Z0-9]{2,8}(?:\s+\d{4}[-A-Z0-9]+)?)\b/gi,
  // "Comp #3: ..." — captures the number and the descriptor that follows.
  /\bComp\s+(?:#|No\.?|Number)\s*(\d+)[:\s]+([^\n\r\t|]{3,80})/gi,
  // Bare deal-name pattern, e.g. "BMARK 2023-V4" mentioned alongside CMBS.
  /\bCMBS\s+([A-Z]{2,5}\s+\d{4}-[A-Z0-9]+)\b/g,
];

function extractComparablesLinkageRefs(
  asrDoc: ParsedDocument,
  uwDoc?: ParsedDocument | null,
): string[] {
  const refs = new Set<string>();
  const docs = [asrDoc, uwDoc].filter(Boolean) as ParsedDocument[];
  for (const doc of docs) {
    for (const section of doc.sections) {
      const text = section.content;
      for (const re of COMP_LINKAGE_PATTERNS) {
        const fresh = new RegExp(re.source, re.flags); // reset stateful regex
        let m: RegExpExecArray | null;
        while ((m = fresh.exec(text)) !== null) {
          const captured = m.slice(1).filter(Boolean).join(' — ').trim();
          if (captured && captured.length <= 200) refs.add(captured);
        }
      }
    }
  }
  return [...refs];
}

// ---------------------------------------------------------------------------
// 6) Main extraction function
// ---------------------------------------------------------------------------

const REQUIRED_FIELDS: CoreFieldName[] = ['noi', 'loanAmount', 'interestRate', 'capRate', 'propertyValue'];

export function extractCoreFields(
  asrDoc: ParsedDocument,
  uwDoc?: ParsedDocument | null,
  sellerMetrics?: SellerExtractedMetrics | null,
): ExtractionResult {
  const fields: Record<CoreFieldName, ExtractedField> = {} as any;

  // --- Phase 1: Direct search with synonym recognition ---
  for (const fieldName of REQUIRED_FIELDS) {
    const match = searchField(fieldName, asrDoc, uwDoc);
    if (match) {
      fields[fieldName] = {
        value: match.value,
        confidence: match.confidence,
        originalLabel: match.originalLabel,
        sourceLocation: match.sourceLocation,
        method: match.method,
      };
    }
  }

  // --- Phase 2: Fill gaps from AI-extracted seller metrics ---
  for (const fieldName of REQUIRED_FIELDS) {
    if (fields[fieldName]?.value) continue; // Already found
    const fromSeller = checkSellerMetrics(fieldName, sellerMetrics ?? null);
    if (fromSeller) {
      fields[fieldName] = fromSeller;
    }
  }

  // --- Phase 3: Fallback derivation ---
  const knownValues: FieldValues = {
    noi: fields.noi?.value ?? null,
    loanAmount: fields.loanAmount?.value ?? null,
    interestRate: fields.interestRate?.value ?? null,
    capRate: fields.capRate?.value ?? null,
    propertyValue: fields.propertyValue?.value ?? null,
  };

  for (const fieldName of REQUIRED_FIELDS) {
    if (fields[fieldName]?.value) continue; // Already found
    const derived = deriveField(fieldName, knownValues);
    if (derived) {
      fields[fieldName] = {
        value: derived.value,
        confidence: 'medium',
        originalLabel: null,
        sourceLocation: 'Derived from other extracted fields',
        method: 'derived',
        derivationFormula: derived.formula,
      };
      // Update known values so subsequent derivations can use this
      knownValues[fieldName] = derived.value;
    }
  }

  // --- Phase 4: Mark anything still missing ---
  for (const fieldName of REQUIRED_FIELDS) {
    if (!fields[fieldName]) {
      fields[fieldName] = {
        value: null,
        confidence: 'low',
        originalLabel: null,
        sourceLocation: null,
        method: 'not_found',
      };
    }
  }

  // --- Compute summary ---
  const missingFields = REQUIRED_FIELDS.filter(f => fields[f].value === null);
  const lowConfidenceFields = REQUIRED_FIELDS.filter(
    f => fields[f].confidence === 'low' && fields[f].value !== null
  );

  console.log('[DataExtraction] Results:');
  for (const f of REQUIRED_FIELDS) {
    const ef = fields[f];
    const status = ef.value !== null
      ? `${ef.value} [${ef.confidence}] via ${ef.method}`
      : 'MISSING';
    console.log(`[DataExtraction]   ${f}: ${status}${ef.originalLabel ? ` (label: "${ef.originalLabel}")` : ''}${ef.sourceLocation ? ` from ${ef.sourceLocation}` : ''}`);
  }

  // --- Phase 5: descriptors + structural + comp-linkage extraction ---
  const descriptors = extractDescriptors(asrDoc, uwDoc);
  const structural = extractStructural(asrDoc, uwDoc);
  const comparablesLinkageRefs = extractComparablesLinkageRefs(asrDoc, uwDoc);

  const descriptorPresent = DESCRIPTOR_FIELDS.filter((f) => descriptors[f].value !== null);
  const structuralPresent = STRUCTURAL_FIELDS.filter((f) => structural[f].value !== null);
  console.log(`[DataExtraction]   descriptors: ${descriptorPresent.length}/${DESCRIPTOR_FIELDS.length} present (${descriptorPresent.join(', ') || 'none'})`);
  console.log(`[DataExtraction]   structural:  ${structuralPresent.length}/${STRUCTURAL_FIELDS.length} present (${structuralPresent.join(', ') || 'none'})`);
  console.log(`[DataExtraction]   comp-refs:   ${comparablesLinkageRefs.length}`);

  return {
    fields,
    descriptors,
    structural,
    comparablesLinkageRefs,
    allRequiredPresent: missingFields.length === 0,
    missingFields,
    lowConfidenceFields,
    extractedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// 7) Pre-validation gate
// ---------------------------------------------------------------------------

/**
 * Pre-validation gate: checks that all required fields are present or derivable
 * BEFORE allowing the underwriting pipeline to proceed.
 *
 * If this returns passed=false, the pipeline MUST stop.
 */
export function runPreValidationGate(extraction: ExtractionResult): PreValidationGateResult {
  const fieldStatus: PreValidationGateResult['fieldStatus'] = {} as any;
  const derivedFields: CoreFieldName[] = [];
  const missingCriticalFields: CoreFieldName[] = [];

  for (const fieldName of REQUIRED_FIELDS) {
    const ef = extraction.fields[fieldName];
    const present = ef.value !== null;
    const derived = ef.method === 'derived';

    if (derived) derivedFields.push(fieldName);
    if (!present) missingCriticalFields.push(fieldName);

    let issue: string | undefined;
    if (!present) {
      issue = `Missing Critical Input: ${fieldName} could not be found or derived`;
    } else if (ef.confidence === 'low') {
      issue = `Low confidence: value is ambiguous and requires manual review`;
    }

    fieldStatus[fieldName] = {
      present,
      derived,
      confidence: present ? ef.confidence : null,
      issue,
    };
  }

  const passed = missingCriticalFields.length === 0;
  const message = passed
    ? `All ${REQUIRED_FIELDS.length} required fields present${derivedFields.length > 0 ? ` (${derivedFields.length} derived)` : ''}`
    : `Incomplete Input Data \u2013 Cannot Underwrite. Missing: ${missingCriticalFields.join(', ')}`;

  console.log(`[PreValidation] ${passed ? 'PASSED' : 'BLOCKED'}: ${message}`);

  return {
    passed,
    message,
    fieldStatus,
    derivedFields,
    missingCriticalFields,
  };
}

// ---------------------------------------------------------------------------
// 8) Validate derivation math
// ---------------------------------------------------------------------------

/**
 * Verify that all derived metrics are mathematically valid.
 * Returns a list of issues found (empty = all valid).
 */
export function validateDerivedMetrics(extraction: ExtractionResult): string[] {
  const issues: string[] = [];
  const f = extraction.fields;

  // Post-normalization unit contract (enforced by normalizeFinancialValue):
  //   capRate, interestRate → decimal fraction (0.045 = 4.5%)
  //   noi, propertyValue, loanAmount → dollars
  //
  // Verifications below MUST use those units. No /100 or *100 scaling here —
  // any mismatch indicates an ingestion-layer bug, not a unit conversion.

  // If property value was derived from NOI / Cap Rate, verify against SSOT.
  if (f.propertyValue.method === 'derived' && f.noi.value && f.capRate.value) {
    const expected = f.noi.value / f.capRate.value;
    const actual = f.propertyValue.value!;
    const diff = Math.abs(expected - actual);
    if (diff > 0.01) {
      issues.push(
        `Derived propertyValue (${actual}) does not match NOI/CapRate (${expected.toFixed(2)})`
      );
    }
  }

  // If cap rate was derived from NOI / Value, verify (decimal fraction).
  if (f.capRate.method === 'derived' && f.noi.value && f.propertyValue.value) {
    const expected = f.noi.value / f.propertyValue.value;
    const actual = f.capRate.value!;
    const diff = Math.abs(expected - actual);
    if (diff > 0.0001) {
      issues.push(
        `Derived capRate (${actual}) does not match NOI/Value (${expected.toFixed(4)})`
      );
    }
  }

  // Range checks expressed in decimal fraction (0.005–0.30 = 0.5%–30%).
  if (f.capRate.value !== null && (f.capRate.value <= 0 || f.capRate.value > 0.30)) {
    issues.push(
      `Cap rate ${(f.capRate.value * 100).toFixed(2)}% is outside reasonable range (0-30%)`
    );
  }
  if (f.interestRate.value !== null && (f.interestRate.value <= 0 || f.interestRate.value > 0.25)) {
    issues.push(
      `Interest rate ${(f.interestRate.value * 100).toFixed(2)}% is outside reasonable range (0-25%)`
    );
  }
  if (f.noi.value !== null && f.noi.value < 0) {
    issues.push(`NOI is negative ($${f.noi.value}) — property is operating at a loss`);
  }

  if (issues.length > 0) {
    console.warn('[DataExtraction] Derived metric validation issues:', issues);
  }

  return issues;
}
