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
  ExtractedField,
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

  return {
    fields,
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
