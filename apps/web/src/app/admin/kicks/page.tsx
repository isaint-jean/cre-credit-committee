'use client';

/**
 * /admin/kicks — browse + filter the institutional-memory corpus of rejected
 * deals (kicks_registry table, populated from the Master Kick List xlsx in #34).
 * Per CRE Credit Handbook §III, analysts consult prior kicks in the same
 * submarket × asset type when reviewing new deals; this page makes that
 * consultation queryable.
 *
 * UI naming convention: the database column is `zf_comments` (ZF = initials
 * of the spreadsheet maintainer, internal jargon). The UI label says
 * "Comments" everywhere. Same for "zf_uw_review_comment" → "UW Review Comment".
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api-client';
import { ASSET_TYPES, ASSET_TYPE_LABELS, type AssetType, type Kick } from '@cre/contracts';

type SortDir = 'asc' | 'desc';

interface Filters {
  assetTypes: AssetType[];
  state: string;
  msa: string;
  sponsor: string;
  vintage: number | null;
  singleTenant: 'any' | 'yes' | 'no';
  search: string;
}

interface Facets {
  assetTypes: AssetType[];
  states: string[];
  vintages: number[];
  topSponsors: string[];
  topMsas: string[];
}

interface ListResponse {
  kicks: Kick[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

const DEFAULT_FILTERS: Filters = {
  assetTypes: [],
  state: '',
  msa: '',
  sponsor: '',
  vintage: null,
  singleTenant: 'any',
  search: '',
};

const PAGE_SIZE_CHOICES = [25, 50, 100, 200];

function fmtCurrency(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

function fmtPercent(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined) return '—';
  return `${(n * 100).toFixed(digits)}%`;
}

function fmtDscr(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return `${n.toFixed(2)}x`;
}

function fmtNumber(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return n.toLocaleString('en-US');
}

function truncate(s: string | null | undefined, max: number): string {
  if (!s) return '';
  if (s.length <= max) return s;
  return s.slice(0, max).trim() + '…';
}

function filtersFromSearchParams(sp: URLSearchParams): Filters {
  const assetTypes = sp.getAll('assetType').filter((v): v is AssetType =>
    (ASSET_TYPES as readonly string[]).includes(v),
  );
  const vintageRaw = sp.get('vintage');
  const vintage = vintageRaw !== null && /^\d+$/.test(vintageRaw) ? Number(vintageRaw) : null;
  const stRaw = sp.get('singleTenant');
  const singleTenant: Filters['singleTenant'] =
    stRaw === 'yes' || stRaw === 'no' ? stRaw : 'any';
  return {
    assetTypes,
    state: sp.get('state') ?? '',
    msa: sp.get('msa') ?? '',
    sponsor: sp.get('sponsor') ?? '',
    vintage,
    singleTenant,
    search: sp.get('search') ?? '',
  };
}

function buildSearchParams(args: {
  filters: Filters;
  sortBy: string;
  sortDir: SortDir;
  page: number;
  pageSize: number;
}): URLSearchParams {
  const qs = new URLSearchParams();
  for (const t of args.filters.assetTypes) qs.append('assetType', t);
  if (args.filters.state) qs.set('state', args.filters.state);
  if (args.filters.msa) qs.set('msa', args.filters.msa);
  if (args.filters.sponsor) qs.set('sponsor', args.filters.sponsor);
  if (args.filters.vintage !== null) qs.set('vintage', String(args.filters.vintage));
  if (args.filters.singleTenant !== 'any') qs.set('singleTenant', args.filters.singleTenant);
  if (args.filters.search) qs.set('search', args.filters.search);
  if (args.sortBy !== 'imported_at') qs.set('sortBy', args.sortBy);
  if (args.sortDir !== 'desc') qs.set('sortDir', args.sortDir);
  if (args.page !== 1) qs.set('page', String(args.page));
  if (args.pageSize !== 50) qs.set('pageSize', String(args.pageSize));
  return qs;
}

// ---------------------------------------------------------------------------
// Sortable column descriptors
// ---------------------------------------------------------------------------

const SORTABLE: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'asset_type', label: 'Asset Type' },
  { key: 'property_name', label: 'Property + Location' },
  { key: 'sponsor', label: 'Sponsor' },
  { key: 'vintage', label: 'Vintage' },
  { key: 'cut_off_balance_dollars', label: 'Loan Amount' },
  { key: 'dscr', label: 'DSCR' },
  { key: 'ltv_at_cutoff', label: 'LTV' },
  { key: 'debt_yield', label: 'Debt Yield' },
];

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function KicksAdminPage() {
  const router = useRouter();
  const sp = useSearchParams();

  // Initial state from URL.
  const [filters, setFilters] = useState<Filters>(() => filtersFromSearchParams(sp ?? new URLSearchParams()));
  const [draftFilters, setDraftFilters] = useState<Filters>(filters);
  const [sortBy, setSortBy] = useState<string>(sp?.get('sortBy') ?? 'imported_at');
  const [sortDir, setSortDir] = useState<SortDir>((sp?.get('sortDir') as SortDir) === 'asc' ? 'asc' : 'desc');
  const [page, setPage] = useState<number>(Number(sp?.get('page') ?? '1') || 1);
  const [pageSize, setPageSize] = useState<number>(Number(sp?.get('pageSize') ?? '50') || 50);

  const [data, setData] = useState<ListResponse | null>(null);
  const [facets, setFacets] = useState<Facets | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterBarOpen, setFilterBarOpen] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Sync URL on every relevant state change.
  useEffect(() => {
    const qs = buildSearchParams({ filters, sortBy, sortDir, page, pageSize });
    const q = qs.toString();
    router.replace(`/admin/kicks${q ? `?${q}` : ''}`);
  }, [filters, sortBy, sortDir, page, pageSize, router]);

  // Load facets once.
  useEffect(() => {
    let cancelled = false;
    api.getKicksFacets()
      .then((f) => { if (!cancelled) setFacets(f); })
      .catch(() => { /* facets failure is non-fatal */ });
    return () => { cancelled = true; };
  }, []);

  // Load data when query inputs change.
  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params: Parameters<typeof api.listKicks>[0] = {
        assetTypes: filters.assetTypes.length > 0 ? filters.assetTypes : undefined,
        state: filters.state || undefined,
        msa: filters.msa || undefined,
        sponsor: filters.sponsor || undefined,
        vintage: filters.vintage ?? undefined,
        singleTenant: filters.singleTenant === 'any' ? undefined : filters.singleTenant === 'yes',
        search: filters.search || undefined,
        sortBy,
        sortDir,
        page,
        pageSize,
      };
      const result: ListResponse = await api.listKicks(params);
      setData(result);
    } catch (e: any) {
      setError(e?.message || 'Failed to load kicks');
    } finally {
      setLoading(false);
    }
  }, [filters, sortBy, sortDir, page, pageSize]);

  useEffect(() => { loadData(); }, [loadData]);

  const totalKicks = facets ? data?.total ?? 0 : 0;
  const summaryLine = useMemo(() => {
    if (!facets || !data) return '';
    const assetTypesCount = facets.assetTypes.length;
    const statesCount = facets.states.length;
    // We show the corpus size (unfiltered) by computing it from facets when no filters; otherwise the
    // filtered total. Simpler: always show filtered total, and let the count-row below clarify.
    return `${data.total.toLocaleString()} kicks across ${assetTypesCount} asset types in ${statesCount} states`;
  }, [facets, data]);

  // Filter helpers.
  function applyFilters() {
    setFilters(draftFilters);
    setPage(1);
  }
  function clearFilters() {
    setDraftFilters(DEFAULT_FILTERS);
    setFilters(DEFAULT_FILTERS);
    setPage(1);
  }
  function toggleAssetType(t: AssetType) {
    setDraftFilters((d) => {
      const has = d.assetTypes.includes(t);
      return { ...d, assetTypes: has ? d.assetTypes.filter((x) => x !== t) : [...d.assetTypes, t] };
    });
  }

  function handleSortClick(key: string) {
    if (key === sortBy) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(key);
      setSortDir('desc');
    }
  }

  return (
    <div className="max-w-screen-2xl mx-auto px-6 py-6">
      {/* Header */}
      <div className="mb-4">
        <h1 className="text-xl font-bold text-text-primary">Kicks</h1>
        <p className="text-xs text-text-secondary mt-1">
          Institutional memory: historical loan rejections. Per the credit handbook, consult prior kicks in the same submarket and asset type when reviewing new deals.
        </p>
        {summaryLine && (
          <p className="text-xs text-text-muted mt-0.5">{summaryLine}</p>
        )}
      </div>

      {/* Filter bar */}
      <div className="card mb-4">
        <button
          onClick={() => setFilterBarOpen((v) => !v)}
          className="w-full flex items-center justify-between mb-2"
        >
          <span className="text-xs font-semibold text-accent uppercase tracking-wider">Filters</span>
          <span className="text-xs text-text-muted">{filterBarOpen ? '▼' : '▶'}</span>
        </button>

        {filterBarOpen && (
          <div className="space-y-3">
            {/* Asset type multi-select */}
            <div>
              <label className="text-xs text-text-secondary block mb-1">Asset Type</label>
              <div className="flex flex-wrap gap-1">
                {ASSET_TYPES.map((t) => {
                  const active = draftFilters.assetTypes.includes(t);
                  return (
                    <button
                      key={t}
                      onClick={() => toggleAssetType(t)}
                      className={`text-xs px-2 py-1 rounded transition-colors ${
                        active
                          ? 'bg-accent text-bg-primary font-semibold'
                          : 'bg-bg-secondary text-text-secondary hover:text-text-primary border border-border-primary'
                      }`}
                    >
                      {ASSET_TYPE_LABELS[t]}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {/* State dropdown */}
              <div>
                <label className="text-xs text-text-secondary block mb-1">State</label>
                <select
                  className="input-field w-full text-xs"
                  value={draftFilters.state}
                  onChange={(e) => setDraftFilters((d) => ({ ...d, state: e.target.value }))}
                >
                  <option value="">Any</option>
                  {facets?.states.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>

              {/* Vintage dropdown */}
              <div>
                <label className="text-xs text-text-secondary block mb-1">Vintage</label>
                <select
                  className="input-field w-full text-xs"
                  value={draftFilters.vintage ?? ''}
                  onChange={(e) =>
                    setDraftFilters((d) => ({ ...d, vintage: e.target.value === '' ? null : Number(e.target.value) }))
                  }
                >
                  <option value="">Any</option>
                  {facets?.vintages.map((v) => (
                    <option key={v} value={v}>{v}</option>
                  ))}
                </select>
              </div>

              {/* Single tenant tri-state */}
              <div>
                <label className="text-xs text-text-secondary block mb-1">Single Tenant</label>
                <div className="flex gap-1">
                  {(['any', 'yes', 'no'] as const).map((v) => (
                    <button
                      key={v}
                      onClick={() => setDraftFilters((d) => ({ ...d, singleTenant: v }))}
                      className={`flex-1 text-xs px-2 py-1 rounded transition-colors capitalize ${
                        draftFilters.singleTenant === v
                          ? 'bg-accent text-bg-primary font-semibold'
                          : 'bg-bg-secondary text-text-secondary hover:text-text-primary border border-border-primary'
                      }`}
                    >
                      {v}
                    </button>
                  ))}
                </div>
              </div>

              {/* MSA autocomplete */}
              <div>
                <label className="text-xs text-text-secondary block mb-1">MSA</label>
                <input
                  type="text"
                  list="kick-msa-options"
                  className="input-field w-full text-xs"
                  placeholder="Substring match"
                  value={draftFilters.msa}
                  onChange={(e) => setDraftFilters((d) => ({ ...d, msa: e.target.value }))}
                />
                <datalist id="kick-msa-options">
                  {facets?.topMsas.map((m) => <option key={m} value={m} />)}
                </datalist>
              </div>

              {/* Sponsor autocomplete */}
              <div>
                <label className="text-xs text-text-secondary block mb-1">Sponsor</label>
                <input
                  type="text"
                  list="kick-sponsor-options"
                  className="input-field w-full text-xs"
                  placeholder="Substring match"
                  value={draftFilters.sponsor}
                  onChange={(e) => setDraftFilters((d) => ({ ...d, sponsor: e.target.value }))}
                />
                <datalist id="kick-sponsor-options">
                  {facets?.topSponsors.map((s) => <option key={s} value={s} />)}
                </datalist>
              </div>

              {/* Search */}
              <div>
                <label className="text-xs text-text-secondary block mb-1">Search</label>
                <input
                  type="text"
                  className="input-field w-full text-xs"
                  placeholder="Property, deal, sponsor, comments"
                  value={draftFilters.search}
                  onChange={(e) => setDraftFilters((d) => ({ ...d, search: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === 'Enter') applyFilters(); }}
                />
              </div>
            </div>

            <div className="flex gap-2 pt-2">
              <button onClick={applyFilters} className="btn-primary text-xs">Apply</button>
              <button onClick={clearFilters} className="btn-secondary text-xs">Clear</button>
            </div>
          </div>
        )}
      </div>

      {/* Results count + page size */}
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs text-text-muted">
          {loading
            ? 'Loading…'
            : data
              ? `Showing ${data.kicks.length === 0 ? 0 : (data.page - 1) * data.pageSize + 1}–${Math.min(data.page * data.pageSize, data.total)} of ${data.total.toLocaleString()} kicks`
              : ''}
        </div>
        <div className="flex items-center gap-2 text-xs text-text-muted">
          <span>Page size:</span>
          <select
            className="input-field text-xs"
            value={pageSize}
            onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}
          >
            {PAGE_SIZE_CHOICES.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
      </div>

      {error && (
        <div className="card border-risk-high/30 mb-3">
          <p className="text-sm text-risk-high">{error}</p>
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr>
              <th className="table-header text-left w-6"></th>
              {SORTABLE.map((c) => {
                const active = sortBy === c.key;
                return (
                  <th key={c.key} className="table-header text-left cursor-pointer select-none" onClick={() => handleSortClick(c.key)}>
                    <span className={active ? 'text-accent' : ''}>
                      {c.label}{active ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
                    </span>
                  </th>
                );
              })}
              <th className="table-header text-left">Single Tenant</th>
              <th className="table-header text-left">Comments</th>
              <th className="table-header text-left">Date</th>
            </tr>
          </thead>
          <tbody>
            {data?.kicks.length === 0 && !loading && (
              <tr><td colSpan={12} className="text-center py-12 text-text-muted text-sm">No kicks match these filters.</td></tr>
            )}
            {data?.kicks.map((k) => {
              const expanded = expandedId === k.id;
              const dateRaw = k.uwReceivedRaw ?? k.asrReceivedRaw ?? null;
              const location = [k.city, k.state].filter(Boolean).join(', ');
              return (
                <KickRow
                  key={k.id}
                  kick={k}
                  expanded={expanded}
                  onToggle={() => setExpandedId(expanded ? null : k.id)}
                  dateRaw={dateRaw}
                  location={location}
                />
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Pagination footer */}
      {data && data.totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 mt-4 text-xs">
          <button
            onClick={() => setPage(1)}
            disabled={page <= 1}
            className="px-2 py-1 rounded border border-border-primary text-text-secondary hover:text-text-primary disabled:opacity-30"
          >
            « First
          </button>
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="px-2 py-1 rounded border border-border-primary text-text-secondary hover:text-text-primary disabled:opacity-30"
          >
            ‹ Prev
          </button>
          <span className="text-text-muted px-2">
            Page {data.page} of {data.totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(data.totalPages, p + 1))}
            disabled={page >= data.totalPages}
            className="px-2 py-1 rounded border border-border-primary text-text-secondary hover:text-text-primary disabled:opacity-30"
          >
            Next ›
          </button>
          <button
            onClick={() => setPage(data.totalPages)}
            disabled={page >= data.totalPages}
            className="px-2 py-1 rounded border border-border-primary text-text-secondary hover:text-text-primary disabled:opacity-30"
          >
            Last »
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row + expanded detail
// ---------------------------------------------------------------------------

function KickRow({ kick, expanded, onToggle, dateRaw, location }: {
  kick: Kick;
  expanded: boolean;
  onToggle: () => void;
  dateRaw: string | null;
  location: string;
}) {
  const COMMENT_PREVIEW_LEN = 120;
  const hasComment = !!kick.zfComments;

  return (
    <>
      <tr className="hover:bg-bg-tertiary/50 transition-colors">
        <td className="table-cell">
          <button onClick={onToggle} className="text-text-muted hover:text-accent text-xs">
            {expanded ? '▼' : '▶'}
          </button>
        </td>
        <td className="table-cell">
          <span className="badge bg-accent/20 text-accent">{ASSET_TYPE_LABELS[kick.assetType]}</span>
        </td>
        <td className="table-cell">
          <div className="text-sm text-text-primary font-medium">{kick.propertyName || '—'}</div>
          <div className="text-xs text-text-muted">{location || '—'}</div>
        </td>
        <td className="table-cell text-xs text-text-secondary">{kick.sponsor || '—'}</td>
        <td className="table-cell text-xs font-mono text-text-secondary">{kick.vintage ?? '—'}</td>
        <td className="table-cell text-xs font-mono text-text-secondary">{fmtCurrency(kick.cutOffBalanceDollars)}</td>
        <td className="table-cell text-xs font-mono text-text-secondary">{fmtDscr(kick.dscr)}</td>
        <td className="table-cell text-xs font-mono text-text-secondary">{fmtPercent(kick.ltvAtCutoff)}</td>
        <td className="table-cell text-xs font-mono text-text-secondary">{fmtPercent(kick.debtYield)}</td>
        <td className="table-cell text-center">
          {kick.singleTenant === 1 ? <span className="text-accent">✓</span> : <span className="text-text-muted">—</span>}
        </td>
        <td className="table-cell text-xs text-text-secondary max-w-md">
          {hasComment ? (
            <span title={kick.zfComments ?? undefined}>{truncate(kick.zfComments, COMMENT_PREVIEW_LEN)}</span>
          ) : (
            <span className="text-text-muted">—</span>
          )}
        </td>
        <td className="table-cell text-xs text-text-muted">{dateRaw || '—'}</td>
      </tr>
      {expanded && (
        <tr className="bg-bg-tertiary/30">
          <td colSpan={12} className="p-4">
            <KickDetail kick={kick} />
          </td>
        </tr>
      )}
    </>
  );
}

function KickDetail({ kick }: { kick: Kick }) {
  let raw: Record<string, unknown> = {};
  try { raw = JSON.parse(kick.rawRowJson); } catch { /* ignore */ }

  // Field display order — matches the order analysts see in the source xlsx.
  const orderedFields: ReadonlyArray<[string, string]> = [
    ['UW Received', 'UW Received'],
    ['ASR Received', 'ASR Received'],
    ['Deal', 'Deal'],
    ['8F Control', '8F Control'],
    ['Normalized EF Property Type', 'Asset Type (source)'],
    ['Property Flag', 'Property Flag'],
    ['Seller', 'Seller'],
    ['Vintage', 'Vintage'],
    ['Property Name', 'Property Name'],
    ['Address', 'Address'],
    ['City', 'City'],
    ['State', 'State'],
    ['Property Type', 'Property Type (source)'],
    ['Property Sub-Type', 'Property Sub-Type'],
    ['Year Built', 'Year Built'],
    ['Year Renovated', 'Year Renovated'],
    ['Units', 'Units'],
    ['Cut-Off Property Balance', 'Cut-Off Balance'],
    ['Implied Total Debt at Cut Off based on LTV', 'Implied Total Debt'],
    ['Current Debt per Unit', 'Current Debt per Unit'],
    ['LTV at Cut-off', 'LTV at Cut-off'],
    ['LTV at Maturity', 'LTV at Maturity'],
    ['U/W NOI Debt Yield', 'Debt Yield'],
    ['Amortization Type', 'Amortization Type'],
    ['Most Recent Occ', 'Occupancy'],
    ['UW NCF DSCR', 'DSCR'],
    ['Sponsor', 'Sponsor'],
    ['Single Tenant (Yes/No)', 'Single Tenant'],
    ['Loan Purpose', 'Loan Purpose'],
    ['MSA', 'MSA'],
  ];

  return (
    <div className="space-y-3">
      {/* The two long-form comment fields get their own row above the field grid */}
      {kick.zfComments && (
        <div>
          <div className="text-xs font-semibold text-accent uppercase tracking-wider mb-1">Comments</div>
          <div className="text-sm text-text-secondary whitespace-pre-wrap leading-relaxed">{kick.zfComments}</div>
        </div>
      )}
      {kick.zfUwReviewComment && (
        <div>
          <div className="text-xs font-semibold text-accent uppercase tracking-wider mb-1">UW Review Comment</div>
          <div className="text-sm text-text-secondary whitespace-pre-wrap leading-relaxed">{kick.zfUwReviewComment}</div>
        </div>
      )}

      <div>
        <div className="text-xs font-semibold text-accent uppercase tracking-wider mb-1">Source Fields</div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-x-4 gap-y-1 text-xs">
          {orderedFields.map(([rawKey, label]) => {
            const v = raw[rawKey];
            const display = v === null || v === undefined || v === '' ? '—' : String(v);
            return (
              <div key={rawKey} className="flex justify-between gap-2 border-b border-border-primary/30 py-0.5">
                <span className="text-text-muted">{label}</span>
                <span className="text-text-secondary text-right truncate" title={display}>{display}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="text-xs text-text-muted">
        Kick id: <span className="font-mono">{kick.id}</span>
      </div>
    </div>
  );
}
