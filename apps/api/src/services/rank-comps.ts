/**
 * Relevance ranker for CMBS office comps vs a subject property (Sunroad).
 *
 * Stage 1 hard filter (Office) → pari-passu collapse (one row per propertyKey,
 * best-coverage instance kept, dealCount annotated) → Stage 2 scoring:
 *   - geo TIER-PRIMARY ordering: primary sort = tier index
 *     (San Diego 0 < SoCal 1 < CA 2 < gateway 3 < national 4);
 *   - within-tier secondary sort = blend of vintage/size/value ONLY
 *     (geo constant in a tier), weights 0.30/0.20/0.10 renormalized over the
 *     present three.
 * Cross-tier `composite` (geo+blend) is retained as an AUDIT field + the
 * relevance-floor sufficiency gate (≥3 ≥0.45). Credit-tenant tag is post-rank,
 * NON-scoring (tenant name ≠ tenant credit).
 *
 * Read-only — pure scoring over queried comp rows.
 */

export interface SubjectVector {
  readonly propertyType: 'Office';
  readonly city: string;
  readonly state: string;
  readonly netRentableSF: number;
  readonly vintageRef: string;
  readonly value: number | null;
  readonly propertyKey: string;
}

export interface CompRow {
  dealName: string; assetNumber: string; propertyName: string | null;
  city: string | null; state: string | null; netRentableSF: number | null;
  value: number | null; filingDate: string | null; largestTenant: string | null;
  propertyType: string; propertyKey: string; fieldCoverage: number | null;
}

export interface RankedComp {
  dealName: string; assetNumber: string; propertyName: string | null;
  city: string | null; state: string | null;
  tier: string; tierIndex: number; withinTier: number;
  composite: number; // cross-tier audit field (geo+blend), used for the floor
  sub: { geo: number | null; vintage: number | null; size: number | null; value: number | null };
  confidence: number; rationale: string; creditTenantTag: boolean;
  dealCount: number; dealNames: string[];
  provenance: { deal: string; assetNumber: string; filingDate: string | null };
}

const W = { geo: 0.40, vintage: 0.30, size: 0.20, value: 0.10 } as const;
const WT = { vintage: 0.30, size: 0.20, value: 0.10 } as const; // within-tier (geo dropped)

const SD_METRO = new Set(['san diego', 'carlsbad', 'chula vista', 'escondido', 'oceanside', 'la jolla', 'del mar', 'poway', 'national city']);
const SOCAL = new Set(['los angeles', 'long beach', 'anaheim', 'santa ana', 'irvine', 'newport beach', 'culver city', 'commerce', 'pasadena', 'burbank', 'glendale', 'torrance', 'el segundo', 'santa monica', 'riverside', 'san bernardino', 'ontario', 'costa mesa', 'brea', 'cerritos', 'woodland hills', 'sherman oaks', 'beverly hills', 'marina del rey', 'ventura', 'oxnard', 'thousand oaks', 'city of industry', 'orange', 'fullerton', 'carson', 'inglewood']);
const BAY = new Set(['san francisco', 'san jose', 'oakland', 'fremont', 'sunnyvale', 'mountain view', 'palo alto', 'santa clara', 'redwood city', 'san mateo', 'menlo park', 'berkeley', 'emeryville', 'south san francisco', 'cupertino', 'milpitas']);
const GATEWAY_STATE = new Set(['NY', 'MA', 'DC', 'WA']);

/** Geo tier off city/state vs San Diego subject. tierIndex: 0 best (same metro) … 4 national. */
function geoTier(city: string | null, state: string | null): { score: number; label: string; tierIndex: number } {
  const c = (city ?? '').toLowerCase().trim();
  const s = (state ?? '').toUpperCase().trim();
  if (SD_METRO.has(c)) return { score: 1.0, label: 'San Diego metro', tierIndex: 0 };
  if (s === 'CA' && SOCAL.has(c)) return { score: 0.75, label: 'SoCal', tierIndex: 1 };
  if (s === 'CA' && BAY.has(c)) return { score: 0.3, label: 'Bay (gateway)', tierIndex: 3 };
  if (s === 'CA') return { score: 0.5, label: 'rest of CA', tierIndex: 2 };
  if (GATEWAY_STATE.has(s)) return { score: 0.3, label: 'coastal-gateway', tierIndex: 3 };
  return { score: 0.1, label: 'national', tierIndex: 4 };
}

function monthsBetween(a: string, b: string): number {
  const da = new Date(a), db = new Date(b);
  return Math.abs((da.getFullYear() - db.getFullYear()) * 12 + (da.getMonth() - db.getMonth()));
}

const CREDIT_TENANT = /general services|gsa\b|united states|federal|department of|u\.?s\.? gov|state of |county of |city of |internal revenue|social security|veterans/i;

export interface RankResult {
  ranked: RankedComp[];        // tier-primary ordered
  floorCleared: boolean;
  cut: number;                 // count clearing composite ≥0.45
  message: string | null;
}

/** Collapse office candidates sharing propertyKey → one row (max field-coverage kept). */
function collapsePariPassu(comps: CompRow[]): Array<CompRow & { _dealCount: number; _dealNames: string[] }> {
  const groups = new Map<string, CompRow[]>();
  for (const c of comps) {
    const k = c.propertyKey || `${c.dealName}#${c.assetNumber}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(c);
  }
  const out: Array<CompRow & { _dealCount: number; _dealNames: string[] }> = [];
  for (const g of groups.values()) {
    const best = [...g].sort((a, b) => (b.fieldCoverage ?? 0) - (a.fieldCoverage ?? 0))[0];
    out.push({ ...best, _dealCount: g.length, _dealNames: [...new Set(g.map((x) => x.dealName))] });
  }
  return out;
}

export function rankComps(comps: CompRow[], subject: SubjectVector): RankResult {
  const FLOOR = 0.45;
  const office = comps.filter((c) => c.propertyType === 'Office' && c.propertyKey !== subject.propertyKey);
  const collapsed = collapsePariPassu(office);
  const out: RankedComp[] = [];
  for (const c of collapsed) {
    const geo = geoTier(c.city, c.state);
    const sub: RankedComp['sub'] = { geo: geo.score, vintage: null, size: null, value: null };
    let monthsDiff: number | null = null;
    if (c.filingDate) { monthsDiff = monthsBetween(c.filingDate, subject.vintageRef); sub.vintage = Math.max(0, Math.min(1, 1 - monthsDiff / 24)); }
    if (c.netRentableSF && c.netRentableSF > 0) sub.size = 1 - Math.min(1, Math.abs(Math.log(c.netRentableSF / subject.netRentableSF)) / Math.log(3));
    if (c.value && c.value > 0 && subject.value && subject.value > 0) sub.value = 1 - Math.min(1, Math.abs(Math.log(c.value / subject.value)) / Math.log(4));
    // within-tier blend (vintage/size/value renormalized over present)
    let wn = 0, wd = 0; for (const k of ['vintage', 'size', 'value'] as const) { const v = sub[k]; if (v !== null) { wn += WT[k] * v; wd += WT[k]; } }
    const withinTier = wd > 0 ? wn / wd : 0;
    // cross-tier composite (audit + floor)
    let cn = 0, cd = 0; for (const k of ['geo', 'vintage', 'size', 'value'] as const) { const v = sub[k]; if (v !== null) { cn += W[k] * v; cd += W[k]; } }
    const composite = cd > 0 ? cn / cd : 0;
    const parts: string[] = [];
    if (monthsDiff !== null) { const nv = new Date(c.filingDate!) >= new Date(subject.vintageRef); parts.push(`${monthsDiff} mo ${nv ? 'newer' : 'older'}`); }
    if (c.netRentableSF) { const r = c.netRentableSF / subject.netRentableSF; parts.push(r >= 1 ? `~${Math.round((r - 1) * 100)}% larger` : `~${Math.round((1 - r) * 100)}% smaller`); }
    out.push({
      dealName: c.dealName, assetNumber: c.assetNumber, propertyName: c.propertyName, city: c.city, state: c.state,
      tier: geo.label, tierIndex: geo.tierIndex, withinTier: Math.round(withinTier * 1000) / 1000,
      composite: Math.round(composite * 1000) / 1000, sub, confidence: Math.round(cd * 100) / 100,
      rationale: parts.join(', '), creditTenantTag: CREDIT_TENANT.test(c.largestTenant ?? ''),
      dealCount: c._dealCount, dealNames: c._dealNames,
      provenance: { deal: c.dealName, assetNumber: c.assetNumber, filingDate: c.filingDate },
    });
  }
  // TIER-PRIMARY ordering: tier index asc, then within-tier similarity desc
  out.sort((a, b) => a.tierIndex - b.tierIndex || b.withinTier - a.withinTier);
  const cut = out.filter((x) => x.composite >= FLOOR).length;
  const topComposite = Math.max(0, ...out.map((x) => x.composite));
  const floorCleared = topComposite >= FLOOR && cut >= 3;
  return { ranked: out, floorCleared, cut, message: floorCleared ? null : 'insufficient relevant comps in corpus' };
}
