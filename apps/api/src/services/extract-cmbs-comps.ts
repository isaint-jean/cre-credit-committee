import { DOMParser } from '@xmldom/xmldom';
import type { CompRecord, CmbsPropertyType, CmbsCompExtraction } from '@cre/contracts';

/**
 * Deterministic, namespace-aware parser for a CMBS EX-102 Asset Data File
 * (Schedule AL XML, ABS-EE / Reg AB II). Emits one CompRecord per PROPERTY.
 * NO AI — pure XML→struct, which is the reliability win (federally-defined
 * fields). Validated against BMARK 2024-V8 / Sunroad Centrum (asset #22) to
 * the dollar.
 *
 * Structure (confirmed): <assetData> → <assets> (one per loan) → loan-level
 * fields as direct children + one-or-more <property> children with the
 * property-level financials. Multi-property loans emit multiple comps that
 * share the loan-level fields.
 */

/** EX-102 propertyTypeCode → decoded type. */
const PROPERTY_TYPE_MAP: Readonly<Record<string, CmbsPropertyType>> = {
  OF: 'Office', IN: 'Industrial', MF: 'Multifamily', RT: 'Retail',
  SS: 'Self-Storage', MU: 'Mixed-Use', LO: 'Lodging', HC: 'Health-Care',
  MH: 'Multifamily', WH: 'Industrial', // MHC→MF-ish, Warehouse→Industrial (best-effort)
};

/** valuationSourceSecuritizationCode → label (best-effort; raw passed through). */
const VALUATION_SOURCE_MAP: Readonly<Record<string, string>> = {
  MAI: 'MAI appraisal', BPO: 'Broker price opinion', INT: 'Internal valuation',
};

function decodePropertyType(code: string | null): CmbsPropertyType {
  if (code === null) return 'Other';
  return PROPERTY_TYPE_MAP[code.toUpperCase()] ?? 'Other';
}

/** First descendant element's trimmed text, or null. */
function text(el: Element, tag: string): string | null {
  const m = el.getElementsByTagName(tag);
  const t = m.length > 0 ? m[0].textContent : null;
  return t !== null && t.trim().length > 0 ? t.trim() : null;
}

/** Numeric (commas stripped), or null. */
function num(el: Element, tag: string): number | null {
  const t = text(el, tag);
  if (t === null) return null;
  const n = Number(t.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** EX-102 dates are MM-DD-YYYY → ISO YYYY-MM-DD (else pass through). */
function isoDate(el: Element, tag: string): string | null {
  const t = text(el, tag);
  if (t === null) return null;
  const m = t.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  return m ? `${m[3]}-${m[1]}-${m[2]}` : t;
}

/** Parse one EX-102 XML string into comp records. */
export function parseCmbsComps(
  xml: string,
  meta: { sourceDeal: string; filingDate?: string | null; filingAccession?: string | null },
): CmbsCompExtraction {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const root = doc.documentElement as unknown as Element;
  const assetBlocks = root.getElementsByTagName('assets');
  const comps: CompRecord[] = [];

  for (let i = 0; i < assetBlocks.length; i++) {
    const loan = assetBlocks[i] as unknown as Element;
    // loan-level (direct children, not inside <property>)
    const assetNumber = text(loan, 'assetNumber');
    const loanPieceAmount = num(loan, 'originalLoanAmount');
    const interestRate = num(loan, 'originalInterestRatePercentage');
    const originationDate = isoDate(loan, 'originationDate');
    const originatorName = text(loan, 'originatorName');

    const properties = loan.getElementsByTagName('property');
    for (let j = 0; j < properties.length; j++) {
      const p = properties[j] as unknown as Element;
      const value = num(p, 'valuationSecuritizationAmount');
      const noi = num(p, 'netOperatingIncomeSecuritizationAmount');
      const typeCodeRaw = text(p, 'propertyTypeCode');
      const valSrcRaw = text(p, 'valuationSourceSecuritizationCode');

      comps.push({
        sourceDeal: meta.sourceDeal,
        assetNumber,
        filingDate: meta.filingDate ?? null,
        filingAccession: meta.filingAccession ?? null,
        propertyName: text(p, 'propertyName'),
        address: text(p, 'propertyAddress'),
        city: text(p, 'propertyCity'),
        state: text(p, 'propertyState'),
        zip: text(p, 'propertyZip'),
        county: text(p, 'propertyCounty'),
        propertyType: decodePropertyType(typeCodeRaw),
        propertyTypeCodeRaw: typeCodeRaw,
        netRentableSF: num(p, 'netRentableSquareFeetSecuritizationNumber') ?? num(p, 'netRentableSquareFeetNumber'),
        yearBuilt: num(p, 'yearBuiltNumber'),
        value,
        valuationDate: isoDate(p, 'valuationSecuritizationDate'),
        valuationSource: valSrcRaw ? (VALUATION_SOURCE_MAP[valSrcRaw.toUpperCase()] ?? valSrcRaw) : null,
        valuationSourceCodeRaw: valSrcRaw,
        noi,
        ncf: num(p, 'netCashFlowFlowSecuritizationAmount'),
        revenue: num(p, 'revenueSecuritizationAmount'),
        operatingExpenses: num(p, 'operatingExpensesSecuritizationAmount'),
        financialsDate: isoDate(p, 'financialsSecuritizationDate'),
        occupancyPct: num(p, 'physicalOccupancySecuritizationPercentage'),
        dscr: num(p, 'debtServiceCoverageNetOperatingIncomeSecuritizationPercentage'),
        capRate: noi !== null && value !== null && value > 0 ? Math.round((noi / value) * 1e6) / 1e6 : null,
        loanPieceAmount,
        ltvPiece: loanPieceAmount !== null && value !== null && value > 0
          ? Math.round((loanPieceAmount / value) * 1e4) / 1e4 : null,
        ltvBasis: 'piece_only',
        ltvReliable: false,
        interestRate,
        originationDate,
        originatorName,
        largestTenant: text(p, 'largestTenant'),
        largestTenantSF: num(p, 'squareFeetLargestTenantNumber'),
        largestTenantLeaseExpiry: isoDate(p, 'leaseExpirationLargestTenantDate'),
      });
    }
  }

  return {
    sourceDeal: meta.sourceDeal,
    filingDate: meta.filingDate ?? null,
    filingAccession: meta.filingAccession ?? null,
    comps,
    assetCount: assetBlocks.length,
  };
}
