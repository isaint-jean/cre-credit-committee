/**
 * site-visit-checklist-catalog — the STATIC content registry for the per-loan
 * site-visit / PCR checklist (mirrors flag-categories.ts: a render-time registry,
 * no engine coupling). buildChecklist(assetType) generates the grouped item list
 * from the loan's AssetType.
 *
 * ★ DISPLAY-ONLY. Nothing here feeds the mint / doctrine hash. The checklist STATE
 *   (which items are checked, servicer-added items, the AM-visit toggle) is stored
 *   as a JSON payload on servicer_inputs (fieldType 'site_visit_checklist') — an
 *   additive annotation that never re-scores.
 *
 * v1 = BASE checklists only. Five asset types (Office / Multifamily / Retail /
 *   Industrial / Hotel) carry their own list; every other AssetType (SelfStorage,
 *   MHC, MixedUse, Other) and null/unknown fall back to the generic 'Other' list —
 *   the checklist is NEVER empty. The TRIGGERED map + the 'flood' key exist so the
 *   catalog is v2-ready, but NO trigger is activated in v1 (buildChecklist is called
 *   with no active triggers).
 *
 * Item wording is condensed from Isabelle's draft; she can refine it later. The `⚠`
 *   watch-items are marked `watch: true` (the UI renders the marker).
 */

import type { AssetType } from './asset.js';

/** Bump when the catalog's items change materially; stored on the payload for
 *  forward-compat (a stale `checked[]` id that no longer exists is simply ignored). */
export const CHECKLIST_CATALOG_VERSION = 1;

export interface ChecklistItem {
  /** Stable slug — the key stored in the payload's `checked[]`. Never renumber. */
  readonly id: string;
  readonly text: string;
  /** A red-flag / "look closely" item (the draft's ⚠). Display-only emphasis. */
  readonly watch?: boolean;
}

export interface ChecklistGroup {
  readonly key: string;
  readonly label: string;
  readonly items: readonly ChecklistItem[];
}

/** The five asset types with a dedicated list; everything else → 'Other'. */
export type ChecklistAssetKey = 'Office' | 'Multifamily' | 'Retail' | 'Industrial' | 'Hotel' | 'Other';

export interface Checklist {
  /** The list actually used (after fallback resolution). */
  readonly assetKey: ChecklistAssetKey;
  /** The raw loan AssetType this was built from (null when unknown). */
  readonly sourceAssetType: AssetType | null;
  readonly groups: readonly ChecklistGroup[];
  readonly version: number;
}

/* -------------------------------------------------------------------------- */
/* BASE — one item list per asset key. Ids are group-prefixed + stable.        */
/* -------------------------------------------------------------------------- */

const OFFICE: readonly ChecklistItem[] = [
  { id: 'office-parking', text: 'Parking ratio & surface condition (alligatoring / ponding)', watch: true },
  { id: 'office-envelope', text: 'Building envelope & water-intrusion staining' },
  { id: 'office-roof', text: 'Roof age / ponding / patching (fresh patching only is a tell)', watch: true },
  { id: 'office-hvac', text: 'HVAC age & maintenance log (missing / brand-new log is a tell)', watch: true },
  { id: 'office-elevators', text: 'Elevators — cab condition + current inspection cert' },
  { id: 'office-common', text: 'Common areas / restrooms condition' },
  { id: 'office-lifesafety', text: 'Life safety — sprinklers / alarms / exit signage / fire cert' },
  { id: 'office-ada', text: 'ADA compliance' },
  { id: 'office-occupancy', text: 'Physical vs. reported occupancy — walk the floors; is "leased" space dark?', watch: true },
  { id: 'office-buildout', text: 'Tenant build-out & signs of move-out' },
  { id: 'office-signage', text: 'Suite signage matches the rent roll (watch for ghost tenants)', watch: true },
  { id: 'office-relet', text: 'Vacated-space re-lease readiness' },
];

const MULTIFAMILY: readonly ChecklistItem[] = [
  { id: 'mf-envelope', text: 'Envelope / roofs / gutters / drainage' },
  { id: 'mf-parking', text: 'Parking & walkways (trip hazards)', watch: true },
  { id: 'mf-amenities', text: 'Amenities — pool / gym / clubhouse' },
  { id: 'mf-landscape', text: 'Landscaping / lighting' },
  { id: 'mf-unitsample', text: 'Inspect a random unit sample across floors + occupied/vacant (not just model units)', watch: true },
  { id: 'mf-interiors', text: 'Unit interiors — flooring / appliances / HVAC / water damage / mold' },
  { id: 'mf-turns', text: 'Vacant turn quality — truly rent-ready?' },
  { id: 'mf-downunits', text: 'Down units vs. reported vacancy', watch: true },
  { id: 'mf-mechanical', text: 'Mechanical / boiler / electrical' },
  { id: 'mf-lifesafety', text: 'Life safety — detectors / egress / lighting' },
  { id: 'mf-activity', text: 'Physical activity vs. reported occupancy at a normal hour', watch: true },
  { id: 'mf-mgmt', text: 'Management / leasing office presence' },
  { id: 'mf-workorders', text: 'Work-order backlog (large open backlog is a tell)', watch: true },
];

const RETAIL: readonly ChecklistItem[] = [
  { id: 'retail-pylon', text: 'Pylon / monument signage & visibility' },
  { id: 'retail-access', text: 'Ingress / egress & traffic access' },
  { id: 'retail-parking', text: 'Parking field condition & adequacy' },
  { id: 'retail-facade', text: 'Façade / storefronts (long-vacant "coming soon" paper)', watch: true },
  { id: 'retail-anchor', text: 'Anchor tenant physically operating — dark-but-paying?', watch: true },
  { id: 'retail-traffic', text: 'Foot traffic vs. reported sales at peak' },
  { id: 'retail-mix', text: 'Tenant mix matches the rent roll' },
  { id: 'retail-cotenancy', text: 'Co-tenancy / kick-out exposure' },
  { id: 'retail-roof', text: 'Roof condition (large capex risk)', watch: true },
  { id: 'retail-cam', text: 'CAM / common-area upkeep' },
  { id: 'retail-lifesafety', text: 'Life safety & ADA' },
];

const INDUSTRIAL: readonly ChecklistItem[] = [
  { id: 'ind-clearheight', text: 'Clear height / column spacing / dock-door count' },
  { id: 'ind-truckcourt', text: 'Truck court depth & maneuverability' },
  { id: 'ind-slab', text: 'Slab condition (cracking / heaving)', watch: true },
  { id: 'ind-roof', text: 'Roof — age / membrane / ponding' },
  { id: 'ind-firesuppression', text: 'Fire suppression — ESFR vs. standard (use-mismatch)', watch: true },
  { id: 'ind-use', text: 'Actual use vs. permitted/reported (heavy mfg? cold storage?)', watch: true },
  { id: 'ind-environmental', text: 'Environmental tells — staining / drums / floor drains / chemical storage' },
  { id: 'ind-power', text: 'Power capacity vs. tenant need' },
  { id: 'ind-office', text: 'Office build-out %' },
  { id: 'ind-relet', text: 'Single-tenant re-leasability' },
];

const HOTEL: readonly ChecklistItem[] = [
  { id: 'hotel-exterior', text: 'Exterior / roof / parking / pool / signage' },
  { id: 'hotel-guestrooms', text: 'Guest-room sample across floors — FF&E age (PIP overdue?)', watch: true },
  { id: 'hotel-public', text: 'Public spaces / restaurant / meeting / back-of-house' },
  { id: 'hotel-brand', text: 'Brand / flag standards & PIP compliance (franchise-agreement condition)', watch: true },
  { id: 'hotel-kitchen', text: 'Kitchen / food-service & health-code condition' },
  { id: 'hotel-mechanical', text: 'Elevators, HVAC & major mechanical' },
  { id: 'hotel-lifesafety', text: 'Life safety — sprinklers / alarms / egress / fire cert' },
  { id: 'hotel-activity', text: 'Physical activity vs. reported occupancy / ADR at a normal hour', watch: true },
  { id: 'hotel-staffing', text: 'Staffing & management presence' },
  { id: 'hotel-deferred', text: 'Deferred maintenance / renovation-reserve adequacy' },
];

/** Generic fallback — SelfStorage / MHC / MixedUse / Other / null / unknown. */
const OTHER: readonly ChecklistItem[] = [
  { id: 'other-access', text: 'Site access, signage & curb appeal' },
  { id: 'other-envelope', text: 'Building envelope, roof & water intrusion' },
  { id: 'other-parking', text: 'Parking, paving & drainage' },
  { id: 'other-mechanical', text: 'Major mechanical / electrical / plumbing condition' },
  { id: 'other-lifesafety', text: 'Life safety — sprinklers / alarms / egress / fire cert' },
  { id: 'other-ada', text: 'ADA compliance' },
  { id: 'other-occupancy', text: 'Physical occupancy / use vs. reported', watch: true },
  { id: 'other-deferred', text: 'Deferred maintenance & open work orders', watch: true },
  { id: 'other-environmental', text: 'Environmental tells — staining / drums / storage' },
  { id: 'other-sample', text: 'Tenant / unit sample walk (not just the front)' },
];

const BASE: Record<ChecklistAssetKey, readonly ChecklistItem[]> = {
  Office: OFFICE,
  Multifamily: MULTIFAMILY,
  Retail: RETAIL,
  Industrial: INDUSTRIAL,
  Hotel: HOTEL,
  Other: OTHER,
};

/* -------------------------------------------------------------------------- */
/* TRIGGERED — v2 risk add-ons. STUBBED in v1: the map + the 'flood' key exist */
/* (catalog-ready) but buildChecklist activates NONE of them yet.              */
/* -------------------------------------------------------------------------- */

export type ChecklistTriggerKey = 'flood' | 'rollover' | 'pca';

/**
 * Risk-triggered add-on items, keyed by a trigger. ★ v1 STUB — these are NOT wired
 * to any engine signal yet. 'flood' has no engine signal at all (net-new); 'rollover'
 * and 'pca' map to real signals that v2 will feed. buildChecklist ignores all of
 * them until a caller passes activeTriggers (v2).
 */
export const TRIGGERED: Record<ChecklistTriggerKey, readonly ChecklistItem[]> = {
  // NET-NEW: no flood signal exists today — this key is catalog-ready only.
  flood: [
    { id: 'flood-status', text: 'Confirm FEMA flood-zone status & any flood-zone history', watch: true },
    { id: 'flood-waterlines', text: 'Ground-floor / basement water lines, sump pumps & drainage' },
    { id: 'flood-elevation', text: 'Elevation of critical equipment (electrical / mechanical) above flood level', watch: true },
    { id: 'flood-damage', text: 'Prior water-damage staining & remediation quality' },
  ],
  // v2 — maps to ROLLOVER_WITHIN_TERM.
  rollover: [
    { id: 'trig-rollover-occupancy', text: 'Physically verify occupancy vs. rent roll (rollover exposure)', watch: true },
    { id: 'trig-rollover-signage', text: 'Confirm expiring/near-term tenants are still operating' },
  ],
  // v2 — maps to PCA_IMMEDIATE_REPAIRS_COVERED.
  pca: [
    { id: 'trig-pca-repairs', text: 'Confirm the PCA immediate repairs were completed', watch: true },
    { id: 'trig-pca-reserve', text: 'Verify deferred-maintenance items vs. the reserve funding' },
  ],
};

/* -------------------------------------------------------------------------- */
/* Resolver + builder                                                          */
/* -------------------------------------------------------------------------- */

/** Map a loan AssetType (or null) to the checklist list key — the five dedicated
 *  types keep their list; everything else (incl. null/unknown) → 'Other'. */
export function resolveChecklistAssetKey(assetType: AssetType | null | undefined): ChecklistAssetKey {
  switch (assetType) {
    case 'Office':
    case 'Multifamily':
    case 'Retail':
    case 'Industrial':
    case 'Hotel':
      return assetType;
    default:
      return 'Other';
  }
}

/**
 * Build the checklist for a loan. v1 callers pass no triggers → BASE list only.
 * activeTriggers is reserved for v2 (engine-flag add-ons); unknown/empty is fine.
 * The result is NEVER empty (the 'Other' fallback always yields items).
 */
export function buildChecklist(
  assetType: AssetType | null | undefined,
  activeTriggers: readonly ChecklistTriggerKey[] = [],
): Checklist {
  const assetKey = resolveChecklistAssetKey(assetType);
  const groups: ChecklistGroup[] = [
    { key: 'base', label: `${assetKey === 'Other' ? 'Site visit' : assetKey} — site visit`, items: BASE[assetKey] },
  ];
  for (const t of activeTriggers) {
    const items = TRIGGERED[t];
    if (items && items.length > 0) groups.push({ key: `trigger-${t}`, label: `Risk add-on — ${t}`, items });
  }
  return { assetKey, sourceAssetType: assetType ?? null, groups, version: CHECKLIST_CATALOG_VERSION };
}

/* -------------------------------------------------------------------------- */
/* Payload shape — the JSON stored on servicer_inputs.value (fieldType          */
/* 'site_visit_checklist'). Structured state; NEVER re-scores.                  */
/* -------------------------------------------------------------------------- */

export interface ChecklistAddedItem {
  readonly id: string;
  readonly text: string;
}

export interface ChecklistPayload {
  /** Catalog item ids the servicer has checked off. */
  readonly checked: readonly string[];
  /** Servicer-authored extra items (their own additions). */
  readonly added: readonly ChecklistAddedItem[];
  /** "Prefer Asset Manager to visit" designation (records only, in v1). */
  readonly preferAssetManagerVisit: boolean;
  /** The loan AssetType the checklist was rendered from (provenance). */
  readonly assetType: AssetType | null;
  /** Catalog version this state was saved against (forward-compat). */
  readonly version: number;
}

export const EMPTY_CHECKLIST_PAYLOAD: ChecklistPayload = {
  checked: [],
  added: [],
  preferAssetManagerVisit: false,
  assetType: null,
  version: CHECKLIST_CATALOG_VERSION,
};

/** Parse a stored payload string defensively — malformed / legacy → empty. */
export function parseChecklistPayload(raw: string | null | undefined): ChecklistPayload {
  if (!raw) return EMPTY_CHECKLIST_PAYLOAD;
  try {
    const o = JSON.parse(raw) as Partial<ChecklistPayload>;
    return {
      checked: Array.isArray(o.checked) ? o.checked.filter((x): x is string => typeof x === 'string') : [],
      added: Array.isArray(o.added)
        ? o.added.filter((x): x is ChecklistAddedItem => !!x && typeof x.id === 'string' && typeof x.text === 'string')
        : [],
      preferAssetManagerVisit: o.preferAssetManagerVisit === true,
      assetType: (o.assetType ?? null) as AssetType | null,
      version: typeof o.version === 'number' ? o.version : CHECKLIST_CATALOG_VERSION,
    };
  } catch {
    return EMPTY_CHECKLIST_PAYLOAD;
  }
}

/** A one-line completion summary for the workbook cell / memo note (v2 flow). */
export function summarizeChecklist(payload: ChecklistPayload, totalItems: number): string {
  const done = payload.checked.length;
  const am = payload.preferAssetManagerVisit ? '; Asset Manager visit requested' : '';
  return `Site-visit checklist: ${done}/${totalItems} complete${am}`;
}
