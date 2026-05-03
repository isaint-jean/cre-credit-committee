'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { api } from '@/lib/api-client';
import { ASSET_TYPES } from '@cre/shared';
import type { AssetType, DealOutcome, MarketIntelligence } from '@cre/shared';
import dynamic from 'next/dynamic';
import type { MarketCluster } from './broker-map';

const BrokerMap = dynamic(() => import('./broker-map'), { ssr: false, loading: () => <div className="w-full h-full flex items-center justify-center text-text-muted text-sm">Loading map...</div> });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UWRecord {
  id: string;
  assetType: AssetType;
  dealName: string;
  outcome: DealOutcome;
  date: string;
  year: number;
  fileName: string;
  brokerName: string;
  brokerFirm: string;
  city: string;
  state: string;
  notes: string;
  loanType: 'single_asset' | 'portfolio';
  parentId: string | null;
  portfolioProperties: { name: string; city: string; state: string; assetClass: string; units: number | null; sf: number | null }[];
  brokerNarratives: any[];
  outcomeSource: string | null;
  outcomeConfidence: number | null;
  kickMatchId: number | null;
  outcomeAudit: { sourceFileName: string; sourceRowId: number; matchConfidence: number; matchedFields: string[]; matchedAt: string } | null;
  createdAt: string;
}

const OUTCOMES: { value: DealOutcome; label: string }[] = [
  { value: 'approved', label: 'Approved' },
  { value: 'modified', label: 'Modified' },
  { value: 'rejected', label: 'Rejected' },
];

const LIBRARY_ASSET_CLASSES: { value: AssetType | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'office', label: 'Office' },
  { value: 'multifamily', label: 'Multifamily' },
  { value: 'retail', label: 'Retail' },
  { value: 'industrial', label: 'Industrial' },
  { value: 'hotel', label: 'Hotel' },
  { value: 'self_storage', label: 'Self Storage' },
  { value: 'mixed_use', label: 'Mixed Use' },
  { value: 'manufactured_housing', label: 'Manufactured Housing' },
];

const US_STATES: { value: string; label: string }[] = [
  { value: 'AL', label: 'Alabama' }, { value: 'AK', label: 'Alaska' }, { value: 'AZ', label: 'Arizona' },
  { value: 'AR', label: 'Arkansas' }, { value: 'CA', label: 'California' }, { value: 'CO', label: 'Colorado' },
  { value: 'CT', label: 'Connecticut' }, { value: 'DE', label: 'Delaware' }, { value: 'DC', label: 'District of Columbia' },
  { value: 'FL', label: 'Florida' }, { value: 'GA', label: 'Georgia' }, { value: 'HI', label: 'Hawaii' },
  { value: 'ID', label: 'Idaho' }, { value: 'IL', label: 'Illinois' }, { value: 'IN', label: 'Indiana' },
  { value: 'IA', label: 'Iowa' }, { value: 'KS', label: 'Kansas' }, { value: 'KY', label: 'Kentucky' },
  { value: 'LA', label: 'Louisiana' }, { value: 'ME', label: 'Maine' }, { value: 'MD', label: 'Maryland' },
  { value: 'MA', label: 'Massachusetts' }, { value: 'MI', label: 'Michigan' }, { value: 'MN', label: 'Minnesota' },
  { value: 'MS', label: 'Mississippi' }, { value: 'MO', label: 'Missouri' }, { value: 'MT', label: 'Montana' },
  { value: 'NE', label: 'Nebraska' }, { value: 'NV', label: 'Nevada' }, { value: 'NH', label: 'New Hampshire' },
  { value: 'NJ', label: 'New Jersey' }, { value: 'NM', label: 'New Mexico' }, { value: 'NY', label: 'New York' },
  { value: 'NC', label: 'North Carolina' }, { value: 'ND', label: 'North Dakota' }, { value: 'OH', label: 'Ohio' },
  { value: 'OK', label: 'Oklahoma' }, { value: 'OR', label: 'Oregon' }, { value: 'PA', label: 'Pennsylvania' },
  { value: 'RI', label: 'Rhode Island' }, { value: 'SC', label: 'South Carolina' }, { value: 'SD', label: 'South Dakota' },
  { value: 'TN', label: 'Tennessee' }, { value: 'TX', label: 'Texas' }, { value: 'UT', label: 'Utah' },
  { value: 'VT', label: 'Vermont' }, { value: 'VA', label: 'Virginia' }, { value: 'WA', label: 'Washington' },
  { value: 'WV', label: 'West Virginia' }, { value: 'WI', label: 'Wisconsin' }, { value: 'WY', label: 'Wyoming' },
];

const PAGE_SIZE = 25;

const ASSET_CLASS_COLORS: Record<string, string> = {
  office: '#3B82F6', multifamily: '#10B981', retail: '#F97316', industrial: '#8B5CF6',
  hotel: '#EF4444', self_storage: '#6B7280', mixed_use: '#EC4899', manufactured_housing: '#14B8A6',
};

type SortKey = 'year_desc' | 'year_asc' | 'assetClass' | 'dealName' | 'location';

const STATE_COORDS: Record<string, [number, number]> = {
  AL: [32.806671, -86.791130], AK: [61.370716, -152.404419], AZ: [33.729759, -111.431221],
  AR: [34.969704, -92.373123], CA: [36.116203, -119.681564], CO: [39.059811, -105.311104],
  CT: [41.597782, -72.755371], DE: [39.318523, -75.507141], FL: [27.766279, -81.686783],
  GA: [33.040619, -83.643074], HI: [21.094318, -157.498337], ID: [44.240459, -114.478828],
  IL: [40.349457, -88.986137], IN: [39.849426, -86.258278], IA: [42.011539, -93.210526],
  KS: [38.526600, -96.726486], KY: [37.668140, -84.670067], LA: [31.169546, -91.867805],
  ME: [44.693947, -69.381927], MD: [39.063946, -76.802101], MA: [42.230171, -71.530106],
  MI: [43.326618, -84.536095], MN: [45.694454, -93.900192], MS: [32.741646, -89.678696],
  MO: [38.456085, -92.288368], MT: [46.921925, -110.454353], NE: [41.125370, -98.268082],
  NV: [38.313515, -117.055374], NH: [43.452492, -71.563896], NJ: [40.298904, -74.521011],
  NM: [34.840515, -106.248482], NY: [42.165726, -74.948051], NC: [35.630066, -79.806419],
  ND: [47.528912, -99.784012], OH: [40.388783, -82.764915], OK: [35.565342, -96.928917],
  OR: [44.572021, -122.070938], PA: [40.590752, -77.209755], RI: [41.680893, -71.511780],
  SC: [33.856892, -80.945007], SD: [44.299782, -99.438828], TN: [35.747845, -86.692345],
  TX: [31.054487, -97.563461], UT: [40.150032, -111.862434], VT: [44.045876, -72.710686],
  VA: [37.769337, -78.169968], WA: [47.400902, -121.490494], WV: [38.491226, -80.954453],
  WI: [44.268543, -89.616508], WY: [42.755966, -107.302490], DC: [38.907192, -77.036871],
};

const SENTIMENT_COLORS: Record<string, string> = {
  bullish: '#10B981', slightly_bullish: '#34D399', neutral: '#F59E0B',
  slightly_bearish: '#F97316', bearish: '#EF4444',
};

const SENTIMENT_LABELS: Record<string, string> = {
  bullish: 'Bullish', slightly_bullish: 'Slightly Bullish', neutral: 'Neutral',
  slightly_bearish: 'Slightly Bearish', bearish: 'Bearish',
};

const TREND_LABELS: Record<string, string> = {
  increasing: 'Increasing', stabilizing: 'Stabilizing', declining: 'Declining', mixed: 'Mixed',
};

const TREND_COLORS: Record<string, string> = {
  increasing: '#10B981', stabilizing: '#F59E0B', declining: '#EF4444', mixed: '#6B7280',
};

// ---------------------------------------------------------------------------
// Main Page Component
// ---------------------------------------------------------------------------

export default function UnderwritingLibraryPage() {
  const [underwritings, setUnderwritings] = useState<UWRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [showDropZone, setShowDropZone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Batch upload
  const [batchFiles, setBatchFiles] = useState<File[]>([]);
  const [batchProgress, setBatchProgress] = useState<{ total: number; done: number; results: { name: string; status: string; dealName?: string; assetType?: string; error?: string }[] } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Library filters
  const [filterAssetClass, setFilterAssetClass] = useState<AssetType | 'all'>('all');
  const [filterLoanType, setFilterLoanType] = useState<'all' | 'single_asset' | 'portfolio'>('all');
  const [filterYears, setFilterYears] = useState<Set<string>>(new Set());
  const [filterStates, setFilterStates] = useState<Set<string>>(new Set());
  const [filterOutcome, setFilterOutcome] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('year_desc');
  const [filtersApplied, setFiltersApplied] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);

  // Portfolio expansion
  const [expandedPortfolios, setExpandedPortfolios] = useState<Set<string>>(new Set());

  // Async batch upload
  const [asyncJobId, setAsyncJobId] = useState<string | null>(null);
  const [asyncJobStatus, setAsyncJobStatus] = useState<any>(null);

  // Dropdown open state
  const [yearDropdownOpen, setYearDropdownOpen] = useState(false);
  const [stateDropdownOpen, setStateDropdownOpen] = useState(false);
  const yearDropdownRef = useRef<HTMLDivElement>(null);
  const stateDropdownRef = useRef<HTMLDivElement>(null);

  // Edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Partial<UWRecord>>({});

  // Map state
  const [mapAssetFilters, setMapAssetFilters] = useState<Set<string>>(new Set(['office', 'multifamily', 'retail', 'industrial', 'hotel', 'self_storage', 'mixed_use', 'manufactured_housing']));
  const [mapYearRange, setMapYearRange] = useState<[number, number]>([2015, 2026]);
  const [mapOutcomeFilter, setMapOutcomeFilter] = useState<string>('all');
  const [showHeatmap, setShowHeatmap] = useState(false);

  // Market Intelligence state
  const [selectedCluster, setSelectedCluster] = useState<MarketCluster | null>(null);
  const [marketIntelligence, setMarketIntelligence] = useState<MarketIntelligence[]>([]);
  const [marketLoading, setMarketLoading] = useState(false);

  // Geographic drill-down
  const [drillState, setDrillState] = useState<string | null>(null);
  const [drillCity, setDrillCity] = useState<string | null>(null);

  // ---------------------------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------------------------
  const loadLibrary = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.listHistoricalUWs();
      setUnderwritings(data.underwritings);
    } catch {
      setError('Failed to load underwriting library');
    }
    setLoading(false);
  }, []);

  useEffect(() => { loadLibrary(); }, [loadLibrary]);

  // Load market intelligence
  const loadMarketIntelligence = useCallback(async (cluster?: MarketCluster | null) => {
    setMarketLoading(true);
    try {
      const filters: Record<string, any> = {};
      if (cluster) {
        filters.city = cluster.city;
        filters.state = cluster.state;
      } else if (drillState) {
        filters.state = drillState;
        if (drillCity) filters.city = drillCity;
      }
      if (mapYearRange[0] > 2015) filters.yearMin = mapYearRange[0];
      if (mapYearRange[1] < 2026) filters.yearMax = mapYearRange[1];
      const data = await api.getMarketIntelligence(filters);
      setMarketIntelligence(data.markets || []);
    } catch {
      setMarketIntelligence([]);
    }
    setMarketLoading(false);
  }, [drillState, drillCity, mapYearRange]);

  useEffect(() => {
    loadMarketIntelligence(selectedCluster);
  }, [selectedCluster, loadMarketIntelligence]);

  // ---------------------------------------------------------------------------
  // Batch Upload
  // ---------------------------------------------------------------------------
  const handleFilesSelected = (files: FileList | File[]) => {
    const valid = Array.from(files).filter((f) => /\.(xlsx?|xls|xlsm|pdf)$/i.test(f.name));
    if (valid.length === 0) { setError('Please select Excel or PDF files (.xlsx, .xlsm, .xls, .pdf)'); return; }
    setBatchFiles(valid);
    setShowDropZone(true);
    setError(null);
  };

  const handleBatchUpload = async () => {
    if (batchFiles.length === 0) return;
    setUploading(true); setError(null); setSuccess(null);
    setBatchProgress({ total: batchFiles.length, done: 0, results: [] });

    // Use async endpoint for large batches (50+ files), sync for smaller
    if (batchFiles.length > 50) {
      try {
        const data = await api.batchUploadAsync(batchFiles);
        setAsyncJobId(data.jobId);
        // Start polling for progress
        const pollInterval = setInterval(async () => {
          try {
            const status = await api.getBatchJobStatus(data.jobId);
            const job = status.job;
            setAsyncJobStatus(job);
            setBatchProgress({
              total: job.totalFiles,
              done: job.processed,
              results: (job.results || []).map((r: any) => ({
                name: r.fileName, status: r.status, dealName: r.dealName,
                assetType: r.assetType, error: r.error || r.skipReason,
              })),
            });
            if (job.status === 'completed' || job.status === 'failed') {
              clearInterval(pollInterval);
              setUploading(false);
              setAsyncJobId(null);
              const succeeded = job.succeeded || 0;
              const failed = job.failed || 0;
              const skipped = job.skipped || 0;
              setSuccess(`${succeeded} uploaded, ${skipped} skipped (duplicates), ${failed} failed.`);
              await loadLibrary();
            }
          } catch {
            clearInterval(pollInterval);
            setUploading(false);
            setError('Failed to check batch status');
          }
        }, 3000);
      } catch (err: any) {
        setError(err.message || 'Batch upload failed');
        setBatchProgress(null);
        setUploading(false);
      }
    } else {
      try {
        const data = await api.batchUploadHistoricalUWs(batchFiles);
        const results = (data.results || []).map((r: any) => ({ name: r.fileName, status: r.status, dealName: r.dealName, assetType: r.assetType, error: r.error || r.skipReason }));
        const succeeded = results.filter((r: any) => r.status === 'success').length;
        const failed = results.filter((r: any) => r.status === 'error').length;
        const skipped = results.filter((r: any) => r.status === 'skipped').length;
        setBatchProgress({ total: batchFiles.length, done: batchFiles.length, results });
        setSuccess(`${succeeded} uploaded and auto-classified.${skipped > 0 ? ` ${skipped} skipped (duplicates).` : ''}${failed > 0 ? ` ${failed} failed.` : ''}`);
        await loadLibrary();
      } catch (err: any) {
        setError(err.message || 'Batch upload failed');
        setBatchProgress(null);
      }
      setUploading(false);
    }
  };

  const clearBatch = () => { setBatchFiles([]); setBatchProgress(null); setShowDropZone(false); if (fileInputRef.current) fileInputRef.current.value = ''; };
  const handleDrop = (e: React.DragEvent) => { e.preventDefault(); setIsDragging(false); if (e.dataTransfer.files.length > 0) handleFilesSelected(e.dataTransfer.files); };

  // ---------------------------------------------------------------------------
  // Edit
  // ---------------------------------------------------------------------------
  const startEdit = (uw: UWRecord) => {
    setEditingId(uw.id);
    setEditForm({ assetType: uw.assetType, year: uw.year, city: uw.city, state: uw.state, notes: uw.notes, outcome: uw.outcome });
  };

  const saveEdit = async () => {
    if (!editingId) return;
    try { await api.updateHistoricalUW(editingId, editForm); setEditingId(null); setEditForm({}); await loadLibrary(); } catch (err: any) { setError(err.message || 'Update failed'); }
  };

  const handleDelete = async (id: string) => { try { await api.deleteHistoricalUW(id); await loadLibrary(); } catch {} };

  // ---------------------------------------------------------------------------
  // Derived data
  // ---------------------------------------------------------------------------
  const uniqueYears = useMemo(() => [...new Set(underwritings.map((u) => u.year))].sort((a, b) => b - a), [underwritings]);
  const hasActiveFilters = filterAssetClass !== 'all' || filterLoanType !== 'all' || filterYears.size > 0 || filterStates.size > 0 || filterOutcome !== 'all' || searchQuery.trim().length > 0;

  const filteredUWs = useMemo(() => {
    if (!filtersApplied) return [];
    let items = [...underwritings];
    // Exclude child records from top-level listing (they appear via portfolio expansion)
    items = items.filter((u) => !u.parentId);
    if (filterAssetClass !== 'all') items = items.filter((u) => u.assetType === filterAssetClass);
    if (filterLoanType !== 'all') items = items.filter((u) => (u.loanType || 'single_asset') === filterLoanType);
    if (filterYears.size > 0) items = items.filter((u) => filterYears.has(String(u.year)));
    if (filterStates.size > 0) items = items.filter((u) => filterStates.has(u.state));
    if (filterOutcome !== 'all') items = items.filter((u) => u.outcome === filterOutcome);
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      items = items.filter((u) => u.dealName.toLowerCase().includes(q) || u.city.toLowerCase().includes(q) || u.state.toLowerCase().includes(q) || u.assetType.includes(q));
    }
    switch (sortKey) {
      case 'year_desc': items.sort((a, b) => b.year - a.year); break;
      case 'year_asc': items.sort((a, b) => a.year - b.year); break;
      case 'assetClass': items.sort((a, b) => a.assetType.localeCompare(b.assetType)); break;
      case 'dealName': items.sort((a, b) => a.dealName.localeCompare(b.dealName)); break;
      case 'location': items.sort((a, b) => `${a.state}${a.city}`.localeCompare(`${b.state}${b.city}`)); break;
    }
    return items;
  }, [underwritings, filterAssetClass, filterLoanType, filterYears, filterStates, filterOutcome, searchQuery, sortKey, filtersApplied]);

  const totalPages = Math.max(1, Math.ceil(filteredUWs.length / PAGE_SIZE));
  const paginatedUWs = useMemo(() => {
    const start = (currentPage - 1) * PAGE_SIZE;
    return filteredUWs.slice(start, start + PAGE_SIZE);
  }, [filteredUWs, currentPage]);

  const applyFilters = () => { setFiltersApplied(true); setCurrentPage(1); };
  const clearAllFilters = () => {
    setFilterAssetClass('all'); setFilterLoanType('all'); setFilterYears(new Set()); setFilterStates(new Set());
    setFilterOutcome('all'); setSearchQuery(''); setFiltersApplied(false); setCurrentPage(1);
  };

  const togglePortfolio = (id: string) => {
    setExpandedPortfolios(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleYear = (year: string) => {
    setFilterYears((prev) => { const next = new Set(prev); if (next.has(year)) next.delete(year); else next.add(year); return next; });
  };
  const toggleState = (state: string) => {
    setFilterStates((prev) => { const next = new Set(prev); if (next.has(state)) next.delete(state); else next.add(state); return next; });
  };

  // Close dropdowns on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (yearDropdownRef.current && !yearDropdownRef.current.contains(e.target as Node)) setYearDropdownOpen(false);
      if (stateDropdownRef.current && !stateDropdownRef.current.contains(e.target as Node)) setStateDropdownOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  // Map filtered
  const mapFilteredUWs = useMemo(() => {
    return underwritings.filter((u) => {
      if (!mapAssetFilters.has(u.assetType)) return false;
      if (u.year < mapYearRange[0] || u.year > mapYearRange[1]) return false;
      if (mapOutcomeFilter !== 'all' && u.outcome !== mapOutcomeFilter) return false;
      if (u.state === 'Unknown / Needs Review') return false;
      if (drillState && u.state !== drillState) return false;
      if (drillCity && u.city !== drillCity) return false;
      return true;
    });
  }, [underwritings, mapAssetFilters, mapYearRange, mapOutcomeFilter, drillState, drillCity]);

  // Map markers — no deal names exposed
  const mapMarkers = useMemo(() => {
    return mapFilteredUWs.filter((u) => STATE_COORDS[u.state]).map((u) => {
      const [lat, lng] = STATE_COORDS[u.state];
      const jitter = (Math.random() - 0.5) * 0.8;
      return { id: u.id, assetType: u.assetType, year: u.year, city: u.city, state: u.state, lat: lat + jitter, lng: lng + jitter * 0.8, color: ASSET_CLASS_COLORS[u.assetType] || '#6B7280' };
    });
  }, [mapFilteredUWs]);

  const selectedClusterKey = selectedCluster ? `${selectedCluster.city}_${selectedCluster.state}` : null;

  const drillStates = useMemo(() => {
    return [...new Set(mapFilteredUWs.map((u) => u.state).filter((s) => s !== 'Unknown / Needs Review'))].sort();
  }, [mapFilteredUWs]);

  const drillCities = useMemo(() => {
    if (!drillState) return [];
    return [...new Set(underwritings.filter((u) => u.state === drillState && u.city !== 'Unknown / Needs Review').map((u) => u.city))].sort();
  }, [underwritings, drillState]);

  const marketSummary = useMemo(() => {
    const items = mapFilteredUWs;
    if (items.length === 0) return null;
    const cities = new Set(items.map((u) => `${u.city}_${u.state}`).filter((s) => !s.startsWith('Unknown')));
    const assetCounts = new Map<string, number>();
    const stateCounts = new Map<string, number>();
    for (const u of items) {
      assetCounts.set(u.assetType, (assetCounts.get(u.assetType) || 0) + 1);
      stateCounts.set(u.state, (stateCounts.get(u.state) || 0) + 1);
    }
    return {
      totalFiles: items.length,
      totalMarkets: cities.size,
      assetBreakdown: [...assetCounts.entries()].sort((a, b) => b[1] - a[1]),
      topStates: [...stateCounts.entries()].filter(([s]) => s !== 'Unknown / Needs Review').sort((a, b) => b[1] - a[1]).slice(0, 5),
    };
  }, [mapFilteredUWs]);

  const toggleMapAssetFilter = (assetType: string) => {
    setMapAssetFilters((prev) => { const next = new Set(prev); if (next.has(assetType)) next.delete(assetType); else next.add(assetType); return next; });
  };

  const handleClusterClick = useCallback((cluster: MarketCluster) => {
    setSelectedCluster(cluster);
  }, []);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div className="min-h-screen">
      {/* ================================================================== */}
      {/* SECTION 1: UNDERWRITING LIBRARY                                    */}
      {/* ================================================================== */}
      <div className="max-w-[1400px] mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-bold text-text-primary tracking-wide">UNDERWRITING LIBRARY</h1>
            <p className="text-sm text-text-secondary mt-1">Central archive — {underwritings.length} records</p>
          </div>
          <button onClick={() => { setShowDropZone(true); setError(null); setSuccess(null); }} className="btn-primary text-sm">Upload Underwritings</button>
        </div>

        {error && <div className="card mb-4 border-risk-high/30 bg-risk-high/5"><p className="text-sm text-risk-high">{error}</p></div>}
        {success && <div className="card mb-4 border-risk-positive/30 bg-risk-positive/5"><p className="text-sm text-risk-positive">{success}</p></div>}

        {/* Batch Upload Drop Zone */}
        {showDropZone && (
          <div className="card mb-6 border-accent/30">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-text-primary">Batch Upload — Drop Files Here</h3>
              <button onClick={clearBatch} className="text-xs text-text-muted hover:text-text-primary">Close</button>
            </div>
            <p className="text-xs text-text-secondary mb-3">Drop one or more Excel or PDF files. AI auto-detects asset class, deal name, location, year, outcome, and broker market commentary.</p>
            <div
              onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors mb-4 ${isDragging ? 'border-accent bg-accent/5' : 'border-border-secondary hover:border-accent/50 hover:bg-bg-tertiary/30'}`}
            >
              <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.xlsm,.pdf" multiple className="hidden" onChange={(e) => { if (e.target.files) handleFilesSelected(e.target.files); }} />
              <div className="text-text-muted text-sm mb-1">{isDragging ? 'Drop files here...' : 'Drag & drop files here, or click to browse'}</div>
              <div className="text-text-muted text-xs">.xlsx, .xlsm, .xls, .pdf — multiple files supported</div>
            </div>
            {batchFiles.length > 0 && (
              <div className="mb-4">
                <div className="text-xs text-text-muted mb-2">{batchFiles.length} file{batchFiles.length !== 1 ? 's' : ''} selected</div>
                {/* Progress bar for async uploads */}
                {batchProgress && uploading && batchProgress.total > 0 && (
                  <div className="mb-3">
                    <div className="flex justify-between text-xs text-text-muted mb-1">
                      <span>{Math.round((batchProgress.done / batchProgress.total) * 100)}% complete</span>
                      <span>{batchProgress.done} / {batchProgress.total} processed</span>
                    </div>
                    <div className="w-full h-2 bg-bg-tertiary rounded overflow-hidden">
                      <div className="h-full bg-accent transition-all duration-300" style={{ width: `${(batchProgress.done / batchProgress.total) * 100}%` }} />
                    </div>
                    {asyncJobStatus && (
                      <div className="flex gap-3 text-xs mt-1.5">
                        <span className="text-risk-positive">{asyncJobStatus.succeeded} succeeded</span>
                        <span className="text-text-muted">{asyncJobStatus.skipped} skipped</span>
                        <span className="text-risk-high">{asyncJobStatus.failed} failed</span>
                      </div>
                    )}
                  </div>
                )}
                <div className="space-y-1 max-h-[200px] overflow-y-auto">
                  {batchFiles.map((f, i) => {
                    const result = batchProgress?.results.find((r) => r.name === f.name);
                    return (
                      <div key={i} className="flex items-center justify-between px-3 py-1.5 rounded bg-bg-tertiary text-xs">
                        <span className="text-text-primary truncate mr-2">{f.name}</span>
                        <span className="text-text-muted flex-shrink-0">{(f.size / 1024).toFixed(0)} KB</span>
                        {result && (
                          <span className={`ml-2 flex-shrink-0 ${
                            result.status === 'success' ? 'text-risk-positive' :
                            result.status === 'skipped' ? 'text-text-muted italic' :
                            'text-risk-high'
                          }`}>
                            {result.status === 'success' ? `${result.assetType}` :
                             result.status === 'skipped' ? `Skipped: ${result.error || 'duplicate'}` :
                             result.error || 'Failed'}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            <div className="flex gap-2">
              <button onClick={handleBatchUpload} disabled={uploading || batchFiles.length === 0} className="btn-primary text-sm disabled:opacity-40">
                {uploading ? `Processing ${batchFiles.length} file${batchFiles.length !== 1 ? 's' : ''}...` : `Upload & Auto-Classify ${batchFiles.length} File${batchFiles.length !== 1 ? 's' : ''}`}
              </button>
              <button onClick={clearBatch} className="btn-secondary text-sm">Clear</button>
            </div>
          </div>
        )}

        {/* Asset Class Navigation */}
        <div className="flex flex-wrap gap-2 mb-4">
          {LIBRARY_ASSET_CLASSES.map((ac) => (
            <button key={ac.value} onClick={() => { setFilterAssetClass(ac.value); setCurrentPage(1); }} className={`px-4 py-2 rounded text-sm transition-colors ${filterAssetClass === ac.value ? 'bg-accent text-bg-primary font-semibold' : 'bg-bg-secondary text-text-secondary hover:text-text-primary border border-border-primary'}`}>{ac.label}</button>
          ))}
        </div>

        {/* Filter Panel */}
        <div className="card mb-4 border-border-secondary">
          <div className="flex flex-wrap gap-3 items-start">
            {/* Year Multi-Select */}
            <div className="relative" ref={yearDropdownRef}>
              <button onClick={() => { setYearDropdownOpen(!yearDropdownOpen); setStateDropdownOpen(false); }} className="input-field text-xs flex items-center gap-2 min-w-[140px] justify-between">
                <span>{filterYears.size === 0 ? 'All Years' : `${filterYears.size} year${filterYears.size !== 1 ? 's' : ''}`}</span>
                <span className="text-text-muted text-[10px]">&#9662;</span>
              </button>
              {yearDropdownOpen && (
                <div className="absolute z-50 top-full left-0 mt-1 w-48 bg-bg-secondary border border-border-secondary rounded shadow-lg max-h-[240px] overflow-y-auto">
                  <button onClick={() => setFilterYears(new Set())} className={`w-full text-left px-3 py-1.5 text-xs hover:bg-bg-tertiary transition-colors ${filterYears.size === 0 ? 'text-accent font-semibold' : 'text-text-secondary'}`}>All Years</button>
                  <button onClick={() => setFilterYears(new Set(uniqueYears.map(String)))} className={`w-full text-left px-3 py-1.5 text-xs hover:bg-bg-tertiary transition-colors ${filterYears.size === uniqueYears.length ? 'text-accent font-semibold' : 'text-text-secondary'}`}>Select All</button>
                  <div className="border-t border-border-primary my-0.5" />
                  {uniqueYears.map((y) => (
                    <button key={y} onClick={() => toggleYear(String(y))} className={`w-full text-left px-3 py-1.5 text-xs hover:bg-bg-tertiary transition-colors flex items-center gap-2 ${filterYears.has(String(y)) ? 'text-accent font-semibold' : 'text-text-secondary'}`}>
                      <span className={`w-3 h-3 rounded-sm border flex-shrink-0 flex items-center justify-center ${filterYears.has(String(y)) ? 'bg-accent border-accent' : 'border-border-secondary'}`}>
                        {filterYears.has(String(y)) && <span className="text-bg-primary text-[8px]">&#10003;</span>}
                      </span>
                      {y}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* State Multi-Select */}
            <div className="relative" ref={stateDropdownRef}>
              <button onClick={() => { setStateDropdownOpen(!stateDropdownOpen); setYearDropdownOpen(false); }} className="input-field text-xs flex items-center gap-2 min-w-[160px] justify-between">
                <span>{filterStates.size === 0 ? 'All States' : `${filterStates.size} state${filterStates.size !== 1 ? 's' : ''}`}</span>
                <span className="text-text-muted text-[10px]">&#9662;</span>
              </button>
              {stateDropdownOpen && (
                <div className="absolute z-50 top-full left-0 mt-1 w-56 bg-bg-secondary border border-border-secondary rounded shadow-lg max-h-[280px] overflow-y-auto">
                  <button onClick={() => setFilterStates(new Set())} className={`w-full text-left px-3 py-1.5 text-xs hover:bg-bg-tertiary transition-colors ${filterStates.size === 0 ? 'text-accent font-semibold' : 'text-text-secondary'}`}>All States</button>
                  <button onClick={() => setFilterStates(new Set(US_STATES.map(s => s.value)))} className={`w-full text-left px-3 py-1.5 text-xs hover:bg-bg-tertiary transition-colors ${filterStates.size === US_STATES.length ? 'text-accent font-semibold' : 'text-text-secondary'}`}>Select All</button>
                  <div className="border-t border-border-primary my-0.5" />
                  {US_STATES.map((s) => (
                    <button key={s.value} onClick={() => toggleState(s.value)} className={`w-full text-left px-3 py-1.5 text-xs hover:bg-bg-tertiary transition-colors flex items-center gap-2 ${filterStates.has(s.value) ? 'text-accent font-semibold' : 'text-text-secondary'}`}>
                      <span className={`w-3 h-3 rounded-sm border flex-shrink-0 flex items-center justify-center ${filterStates.has(s.value) ? 'bg-accent border-accent' : 'border-border-secondary'}`}>
                        {filterStates.has(s.value) && <span className="text-bg-primary text-[8px]">&#10003;</span>}
                      </span>
                      {s.value} — {s.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Outcome Filter */}
            <select className="input-field text-xs" value={filterOutcome} onChange={(e) => setFilterOutcome(e.target.value)}>
              <option value="all">All Outcomes</option>
              {OUTCOMES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>

            {/* Loan Type Filter */}
            <select className="input-field text-xs" value={filterLoanType} onChange={(e) => setFilterLoanType(e.target.value as any)}>
              <option value="all">All Loan Types</option>
              <option value="single_asset">Single Asset</option>
              <option value="portfolio">Portfolio</option>
            </select>

            {/* Search */}
            <div className="flex-1 min-w-[200px]">
              <input className="input-field w-full text-xs" placeholder="Search by deal name, location..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />
            </div>

            {/* Sort */}
            <select className="input-field text-xs" value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)}>
              <option value="year_desc">Newest First</option>
              <option value="year_asc">Oldest First</option>
              <option value="assetClass">Asset Class</option>
              <option value="dealName">Deal Name</option>
              <option value="location">Location</option>
            </select>
          </div>

          {/* Active filter tags */}
          {hasActiveFilters && (
            <div className="flex flex-wrap gap-1.5 mt-3 pt-3 border-t border-border-primary">
              {filterAssetClass !== 'all' && (
                <span className="text-[10px] px-2 py-0.5 rounded bg-accent/15 text-accent flex items-center gap-1">
                  {filterAssetClass.replace('_', ' ')} <button onClick={() => setFilterAssetClass('all')} className="hover:text-text-primary">&times;</button>
                </span>
              )}
              {[...filterYears].map((y) => (
                <span key={y} className="text-[10px] px-2 py-0.5 rounded bg-accent/15 text-accent flex items-center gap-1">
                  {y} <button onClick={() => toggleYear(y)} className="hover:text-text-primary">&times;</button>
                </span>
              ))}
              {[...filterStates].map((s) => (
                <span key={s} className="text-[10px] px-2 py-0.5 rounded bg-accent/15 text-accent flex items-center gap-1">
                  {s} <button onClick={() => toggleState(s)} className="hover:text-text-primary">&times;</button>
                </span>
              ))}
              {filterOutcome !== 'all' && (
                <span className="text-[10px] px-2 py-0.5 rounded bg-accent/15 text-accent flex items-center gap-1">
                  {filterOutcome} <button onClick={() => setFilterOutcome('all')} className="hover:text-text-primary">&times;</button>
                </span>
              )}
              {filterLoanType !== 'all' && (
                <span className="text-[10px] px-2 py-0.5 rounded bg-accent/15 text-accent flex items-center gap-1">
                  {filterLoanType === 'single_asset' ? 'Single Asset' : 'Portfolio'} <button onClick={() => setFilterLoanType('all')} className="hover:text-text-primary">&times;</button>
                </span>
              )}
              {searchQuery.trim() && (
                <span className="text-[10px] px-2 py-0.5 rounded bg-accent/15 text-accent flex items-center gap-1">
                  &ldquo;{searchQuery}&rdquo; <button onClick={() => setSearchQuery('')} className="hover:text-text-primary">&times;</button>
                </span>
              )}
            </div>
          )}

          {/* Action buttons */}
          <div className="flex gap-2 mt-3">
            <button onClick={applyFilters} disabled={!hasActiveFilters} className="btn-primary text-sm disabled:opacity-40">Apply Filters</button>
            <button onClick={clearAllFilters} className="btn-secondary text-sm">Clear All</button>
          </div>
        </div>

        {/* Results */}
        {loading ? (
          <div className="text-center py-12 text-text-muted">Loading library...</div>
        ) : !filtersApplied ? (
          <div className="card text-center py-16">
            <div className="text-text-muted text-sm mb-2">No results shown. Select filters to view underwritings.</div>
            <div className="text-text-muted text-xs">{underwritings.length} record{underwritings.length !== 1 ? 's' : ''} in library</div>
          </div>
        ) : filteredUWs.length === 0 ? (
          <div className="card text-center py-16">
            <div className="text-text-muted text-sm mb-2">No underwritings match your filters.</div>
            <button onClick={clearAllFilters} className="text-xs text-accent hover:underline mt-2">Clear filters</button>
          </div>
        ) : (
          <>
            <div className="text-xs text-text-muted mb-2">{filteredUWs.length} result{filteredUWs.length !== 1 ? 's' : ''} — showing {Math.min((currentPage - 1) * PAGE_SIZE + 1, filteredUWs.length)}–{Math.min(currentPage * PAGE_SIZE, filteredUWs.length)}</div>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr>
                    <th className="table-header text-left">Deal</th>
                    <th className="table-header text-left">Asset Class</th>
                    <th className="table-header text-center">Type</th>
                    <th className="table-header text-center">Year</th>
                    <th className="table-header text-left">Location</th>
                    <th className="table-header text-center">Outcome</th>
                    <th className="table-header text-center">Commentary</th>
                    <th className="table-header text-left">Notes</th>
                    <th className="table-header text-center w-28">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {paginatedUWs.map((uw) => (
                    <>
                    <tr key={uw.id} className="hover:bg-bg-tertiary/50 transition-colors">
                      {editingId === uw.id ? (
                        <>
                          <td className="table-cell"><span className="text-sm text-text-primary font-medium">{uw.dealName}</span></td>
                          <td className="table-cell">
                            <select className="input-field text-xs w-full" value={editForm.assetType || uw.assetType} onChange={(e) => setEditForm({ ...editForm, assetType: e.target.value as AssetType })}>
                              {ASSET_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                            </select>
                          </td>
                          <td className="table-cell text-center text-xs text-text-muted">{(uw.loanType || 'single_asset') === 'portfolio' ? 'Portfolio' : 'Single'}</td>
                          <td className="table-cell"><input type="number" className="input-field text-xs w-20" value={editForm.year ?? uw.year} onChange={(e) => setEditForm({ ...editForm, year: parseInt(e.target.value) || uw.year })} /></td>
                          <td className="table-cell">
                            <div className="flex gap-1">
                              <input className="input-field text-xs w-24" placeholder="City" value={editForm.city ?? uw.city} onChange={(e) => setEditForm({ ...editForm, city: e.target.value })} />
                              <input className="input-field text-xs w-12" placeholder="ST" maxLength={2} value={editForm.state ?? uw.state} onChange={(e) => setEditForm({ ...editForm, state: e.target.value.toUpperCase() })} />
                            </div>
                          </td>
                          <td className="table-cell">
                            <select className="input-field text-xs w-full" value={editForm.outcome || uw.outcome} onChange={(e) => setEditForm({ ...editForm, outcome: e.target.value as DealOutcome })}>
                              {OUTCOMES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                            </select>
                          </td>
                          <td className="table-cell text-center text-xs text-text-muted">{(uw.brokerNarratives || []).length}</td>
                          <td className="table-cell"><input className="input-field text-xs w-full" value={editForm.notes ?? uw.notes} onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })} /></td>
                          <td className="table-cell text-center space-x-1">
                            <button onClick={saveEdit} className="text-xs text-risk-positive hover:underline">Save</button>
                            <button onClick={() => { setEditingId(null); setEditForm({}); }} className="text-xs text-text-muted hover:underline">Cancel</button>
                          </td>
                        </>
                      ) : (
                        <>
                          <td className="table-cell">
                            <span className="flex items-center gap-1.5">
                              {(uw.loanType || 'single_asset') === 'portfolio' && (
                                <button onClick={() => togglePortfolio(uw.id)} className="text-text-muted hover:text-accent text-xs">
                                  {expandedPortfolios.has(uw.id) ? '▼' : '▶'}
                                </button>
                              )}
                              <span className="text-sm text-text-primary font-medium">{uw.dealName}</span>
                            </span>
                          </td>
                          <td className="table-cell">
                            <span className="flex items-center gap-1.5 text-sm text-text-secondary">
                              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: ASSET_CLASS_COLORS[uw.assetType] || '#6B7280' }} />
                              <span className="capitalize">{uw.assetType.replace('_', ' ')}</span>
                            </span>
                          </td>
                          <td className="table-cell text-center">
                            <span className={`badge text-[10px] ${(uw.loanType || 'single_asset') === 'portfolio' ? 'bg-purple-500/20 text-purple-400' : 'bg-bg-tertiary text-text-muted'}`}>
                              {(uw.loanType || 'single_asset') === 'portfolio' ? 'Portfolio' : 'Single'}
                            </span>
                          </td>
                          <td className="table-cell text-center text-sm font-mono text-text-secondary">{uw.year}</td>
                          <td className="table-cell text-sm text-text-secondary">{uw.city !== 'Unknown / Needs Review' ? `${uw.city}, ${uw.state}` : uw.state}</td>
                          <td className="table-cell text-center">
                            {uw.outcome === 'rejected' && uw.outcomeSource?.includes('Kicks File') ? (
                              <span className="inline-flex items-center gap-1 badge badge-fail" title={`From outcomes dataset — ${uw.outcomeConfidence != null ? `${uw.outcomeConfidence}% confidence` : 'manual link'}`}>
                                <span className="w-2 h-2 rounded-full bg-red-500 inline-block" />KICKED
                              </span>
                            ) : (
                              <span className={`badge ${uw.outcome === 'approved' ? 'badge-pass' : uw.outcome === 'rejected' ? 'badge-fail' : 'badge-unknown'}`}>{uw.outcome}</span>
                            )}
                          </td>
                          <td className="table-cell text-center">
                            {(uw.brokerNarratives || []).length > 0
                              ? <span className="badge bg-accent/20 text-accent">{(uw.brokerNarratives || []).length} excerpt{(uw.brokerNarratives || []).length !== 1 ? 's' : ''}</span>
                              : <span className="text-xs text-text-muted">—</span>}
                          </td>
                          <td className="table-cell text-xs text-text-muted truncate max-w-[120px]">{uw.notes || '—'}</td>
                          <td className="table-cell text-center space-x-2">
                            <a href={api.getUWDownloadUrl(uw.id)} download className="text-xs text-accent hover:underline">Download</a>
                            <button onClick={() => startEdit(uw)} className="text-xs text-accent hover:underline">Edit</button>
                            <button onClick={() => handleDelete(uw.id)} className="text-xs text-risk-high hover:underline">Delete</button>
                          </td>
                        </>
                      )}
                    </tr>
                    {/* Portfolio expansion — show child properties */}
                    {expandedPortfolios.has(uw.id) && (uw.portfolioProperties || []).length > 0 && (
                      (uw.portfolioProperties || []).map((prop, idx) => (
                        <tr key={`${uw.id}-prop-${idx}`} className="bg-bg-tertiary/30">
                          <td className="table-cell pl-10">
                            <span className="text-xs text-text-secondary">↳ {prop.name}</span>
                          </td>
                          <td className="table-cell">
                            <span className="flex items-center gap-1.5 text-xs text-text-muted">
                              <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: ASSET_CLASS_COLORS[prop.assetClass] || '#6B7280' }} />
                              <span className="capitalize">{(prop.assetClass || '').replace('_', ' ')}</span>
                            </span>
                          </td>
                          <td className="table-cell"></td>
                          <td className="table-cell"></td>
                          <td className="table-cell text-xs text-text-muted">{prop.city}, {prop.state}</td>
                          <td className="table-cell"></td>
                          <td className="table-cell text-center text-xs text-text-muted">
                            {prop.units ? `${prop.units} units` : prop.sf ? `${prop.sf.toLocaleString()} SF` : '—'}
                          </td>
                          <td className="table-cell"></td>
                          <td className="table-cell"></td>
                        </tr>
                      ))
                    )}
                    </>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between mt-4 pt-4 border-t border-border-primary">
                <div className="text-xs text-text-muted">Page {currentPage} of {totalPages}</div>
                <div className="flex gap-1">
                  <button onClick={() => setCurrentPage(1)} disabled={currentPage === 1} className="px-2 py-1 rounded text-xs bg-bg-secondary border border-border-primary text-text-secondary hover:text-text-primary disabled:opacity-30 transition-colors">&laquo;</button>
                  <button onClick={() => setCurrentPage((p) => Math.max(1, p - 1))} disabled={currentPage === 1} className="px-3 py-1 rounded text-xs bg-bg-secondary border border-border-primary text-text-secondary hover:text-text-primary disabled:opacity-30 transition-colors">Prev</button>
                  {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                    let page: number;
                    if (totalPages <= 5) page = i + 1;
                    else if (currentPage <= 3) page = i + 1;
                    else if (currentPage >= totalPages - 2) page = totalPages - 4 + i;
                    else page = currentPage - 2 + i;
                    return (
                      <button key={page} onClick={() => setCurrentPage(page)} className={`px-3 py-1 rounded text-xs border transition-colors ${currentPage === page ? 'bg-accent text-bg-primary border-accent font-semibold' : 'bg-bg-secondary border-border-primary text-text-secondary hover:text-text-primary'}`}>{page}</button>
                    );
                  })}
                  <button onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages} className="px-3 py-1 rounded text-xs bg-bg-secondary border border-border-primary text-text-secondary hover:text-text-primary disabled:opacity-30 transition-colors">Next</button>
                  <button onClick={() => setCurrentPage(totalPages)} disabled={currentPage === totalPages} className="px-2 py-1 rounded text-xs bg-bg-secondary border border-border-primary text-text-secondary hover:text-text-primary disabled:opacity-30 transition-colors">&raquo;</button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* ================================================================== */}
      {/* SECTION 2: MARKET INTELLIGENCE MAP                                 */}
      {/* ================================================================== */}
      <div className="border-t border-border-primary bg-bg-secondary/50">
        <div className="max-w-[1400px] mx-auto px-6 py-8">
          <div className="mb-6">
            <h2 className="text-lg font-bold text-text-primary tracking-wide">MARKET INTELLIGENCE</h2>
            <p className="text-sm text-text-secondary mt-1">Aggregated market trends and broker sentiment — click a market on the map</p>
          </div>

          {/* Filters + Map row */}
          <div className="grid grid-cols-[240px_1fr] gap-4">
            {/* LEFT PANEL: Filters */}
            <div className="bg-bg-secondary border border-border-primary rounded p-4 overflow-y-auto" style={{ maxHeight: 480 }}>
              <h3 className="text-xs font-semibold text-accent uppercase tracking-wider mb-3">Filters</h3>

              {/* Geographic Drill-Down */}
              <div className="mb-4">
                <label className="text-xs text-text-muted block mb-2">Region</label>
                <select className="input-field w-full text-xs mb-1.5" value={drillState || ''} onChange={(e) => { setDrillState(e.target.value || null); setDrillCity(null); setSelectedCluster(null); }}>
                  <option value="">All States</option>
                  {drillStates.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
                {drillState && drillCities.length > 0 && (
                  <select className="input-field w-full text-xs" value={drillCity || ''} onChange={(e) => { setDrillCity(e.target.value || null); setSelectedCluster(null); }}>
                    <option value="">All Cities in {drillState}</option>
                    {drillCities.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                )}
              </div>

              {/* Asset Class Toggles */}
              <div className="mb-4">
                <label className="text-xs text-text-muted block mb-2">Asset Class</label>
                <div className="space-y-1.5">
                  {LIBRARY_ASSET_CLASSES.filter((a) => a.value !== 'all').map((ac) => (
                    <button key={ac.value} onClick={() => toggleMapAssetFilter(ac.value)} className={`w-full flex items-center gap-2 px-3 py-1.5 rounded text-xs transition-colors ${mapAssetFilters.has(ac.value) ? 'bg-bg-tertiary text-text-primary' : 'text-text-muted hover:text-text-secondary'}`}>
                      <span className="w-3 h-3 rounded-full border-2 flex-shrink-0" style={{ backgroundColor: mapAssetFilters.has(ac.value) ? (ASSET_CLASS_COLORS[ac.value] || '#6B7280') : 'transparent', borderColor: ASSET_CLASS_COLORS[ac.value] || '#6B7280' }} />
                      {ac.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Year Range */}
              <div className="mb-4">
                <label className="text-xs text-text-muted block mb-2">Year Range</label>
                <div className="flex gap-2 items-center">
                  <input type="number" className="input-field text-xs w-16" value={mapYearRange[0]} onChange={(e) => setMapYearRange([parseInt(e.target.value) || 2015, mapYearRange[1]])} />
                  <span className="text-text-muted text-xs">to</span>
                  <input type="number" className="input-field text-xs w-16" value={mapYearRange[1]} onChange={(e) => setMapYearRange([mapYearRange[0], parseInt(e.target.value) || 2026])} />
                </div>
              </div>

              {/* Outcome + Heatmap */}
              <div className="mb-4">
                <label className="text-xs text-text-muted block mb-2">Outcome</label>
                <div className="space-y-1.5">
                  {[{ value: 'all', label: 'All' }, ...OUTCOMES].map((o) => (
                    <button key={o.value} onClick={() => setMapOutcomeFilter(o.value)} className={`w-full text-left px-3 py-1.5 rounded text-xs transition-colors ${mapOutcomeFilter === o.value ? 'bg-bg-tertiary text-text-primary font-medium' : 'text-text-muted hover:text-text-secondary'}`}>{o.label}</button>
                  ))}
                </div>
              </div>
              <button onClick={() => setShowHeatmap(!showHeatmap)} className={`w-full px-3 py-2 rounded text-xs transition-colors border mb-4 ${showHeatmap ? 'bg-accent/20 border-accent/40 text-accent' : 'bg-bg-tertiary border-border-primary text-text-secondary hover:text-text-primary'}`}>{showHeatmap ? 'Hide Heatmap' : 'Show Heatmap'}</button>

              {/* Summary */}
              <div className="border-t border-border-primary pt-4">
                <div className="text-xs text-text-muted">{mapFilteredUWs.length} underwriting{mapFilteredUWs.length !== 1 ? 's' : ''} across {marketSummary?.totalMarkets || 0} market{(marketSummary?.totalMarkets || 0) !== 1 ? 's' : ''}</div>
                {drillState && <div className="text-xs text-accent mt-1">{drillState}{drillCity ? ` / ${drillCity}` : ''}</div>}
              </div>
            </div>

            {/* MAP — fills the remaining width */}
            <div className="bg-bg-secondary border border-border-primary rounded overflow-hidden relative" style={{ height: 480 }}>
              <BrokerMap markers={mapMarkers} showHeatmap={showHeatmap} onClusterClick={handleClusterClick} selectedKey={selectedClusterKey} />
            </div>
          </div>

          {/* MARKET INTELLIGENCE — below the map */}
          <div className="mt-6">
            {marketLoading ? (
              <div className="card text-center py-8 text-text-muted text-sm">Loading market intelligence...</div>
            ) : selectedCluster && marketIntelligence.length > 0 ? (
              <div className="card">
                <div className="flex items-center justify-between mb-6">
                  <h3 className="text-sm font-bold text-text-primary tracking-wide">
                    MARKET INTELLIGENCE: {selectedCluster.city.toUpperCase()}, {selectedCluster.state}
                  </h3>
                  <button onClick={() => setSelectedCluster(null)} className="text-xs text-text-muted hover:text-text-primary">Close</button>
                </div>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  {marketIntelligence.map((mi) => (
                    <MarketIntelligencePanel key={mi.marketKey} market={mi} />
                  ))}
                </div>
              </div>
            ) : !selectedCluster && marketIntelligence.length > 0 ? (
              <div className="card">
                <h3 className="text-sm font-bold text-text-primary tracking-wide mb-6">
                  {drillState ? `${drillState}${drillCity ? ` / ${drillCity}` : ''} MARKET OVERVIEW` : 'ALL MARKETS OVERVIEW'}
                </h3>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  {marketIntelligence.slice(0, 6).map((mi) => (
                    <MarketIntelligencePanel key={mi.marketKey} market={mi} />
                  ))}
                </div>
                {marketIntelligence.length > 6 && (
                  <div className="text-xs text-text-muted text-center pt-4 mt-4 border-t border-border-primary">+ {marketIntelligence.length - 6} more markets. Drill down or click a market for detail.</div>
                )}
              </div>
            ) : (
              <div className="card text-center py-8">
                <p className="text-text-muted text-sm">Click a market cluster on the map to view aggregated intelligence.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Market Intelligence Panel Component
// ---------------------------------------------------------------------------

function MarketIntelligencePanel({ market: mi }: { market: MarketIntelligence }) {
  return (
    <div className="mb-6 last:mb-0 pb-6 last:pb-0 border-b last:border-b-0 border-border-primary">
      <div className="text-xs font-bold text-accent uppercase tracking-wider mb-1">{mi.displayName}</div>
      {mi.subMarkets.length > 0 && (
        <div className="text-[10px] text-text-muted mb-3">Sub-markets: {mi.subMarkets.join(', ')}</div>
      )}

      {/* 1. Rent Overview */}
      <div className="mb-4">
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-[10px] font-semibold text-text-muted uppercase tracking-wider">Rent Overview</span>
          <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold" style={{ backgroundColor: `${TREND_COLORS[mi.rentOverview.trend]}20`, color: TREND_COLORS[mi.rentOverview.trend] }}>
            {TREND_LABELS[mi.rentOverview.trend] || 'Mixed'}
          </span>
        </div>
        {mi.rentOverview.avgRentLow !== null && (
          <div className="text-sm text-text-primary font-mono mb-1">
            ${mi.rentOverview.avgRentLow.toLocaleString()} – ${mi.rentOverview.avgRentHigh?.toLocaleString()} <span className="text-text-muted text-xs">{mi.rentOverview.rentUnit}</span>
          </div>
        )}
        <p className="text-xs text-text-secondary leading-relaxed">{mi.rentOverview.trendNarrative}</p>
      </div>

      {/* 2. Vacancy & Occupancy */}
      <div className="mb-4">
        <div className="text-[10px] font-semibold text-text-muted uppercase tracking-wider mb-1.5">Vacancy & Occupancy</div>
        {mi.vacancyOverview.vacancyLow !== null && (
          <div className="text-sm text-text-primary font-mono mb-1">
            {(mi.vacancyOverview.vacancyLow * 100).toFixed(1)}% – {((mi.vacancyOverview.vacancyHigh || 0) * 100).toFixed(1)}% <span className="text-text-muted text-xs">vacancy range</span>
          </div>
        )}
        <p className="text-xs text-text-secondary leading-relaxed">{mi.vacancyOverview.occupancyTrend}</p>
      </div>

      {/* 3. Supply & Demand */}
      <div className="mb-4">
        <div className="text-[10px] font-semibold text-text-muted uppercase tracking-wider mb-1.5">Supply & Demand</div>
        <div className="space-y-1.5">
          {mi.supplyDemand.supplyNarrative !== 'No supply commentary available' && (
            <p className="text-xs text-text-secondary leading-relaxed"><span className="text-text-muted font-medium">Supply:</span> {mi.supplyDemand.supplyNarrative}</p>
          )}
          {mi.supplyDemand.demandNarrative !== 'No demand commentary available' && (
            <p className="text-xs text-text-secondary leading-relaxed"><span className="text-text-muted font-medium">Demand:</span> {mi.supplyDemand.demandNarrative}</p>
          )}
          {mi.supplyDemand.newDevelopment !== 'No development pipeline data' && (
            <p className="text-xs text-text-secondary leading-relaxed"><span className="text-text-muted font-medium">Pipeline:</span> {mi.supplyDemand.newDevelopment}</p>
          )}
          {mi.supplyDemand.absorptionTrend !== 'No absorption data' && (
            <p className="text-xs text-text-secondary leading-relaxed"><span className="text-text-muted font-medium">Absorption:</span> {mi.supplyDemand.absorptionTrend}</p>
          )}
          {mi.supplyDemand.supplyNarrative === 'No supply commentary available' &&
           mi.supplyDemand.demandNarrative === 'No demand commentary available' && (
            <p className="text-xs text-text-muted">No supply/demand commentary available</p>
          )}
        </div>
      </div>

      {/* 4. Broker Sentiment */}
      <div className="mb-4">
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-[10px] font-semibold text-text-muted uppercase tracking-wider">Broker Sentiment</span>
          <span className="px-2 py-0.5 rounded text-[10px] font-semibold" style={{ backgroundColor: `${SENTIMENT_COLORS[mi.brokerSentiment.sentiment]}20`, color: SENTIMENT_COLORS[mi.brokerSentiment.sentiment] }}>
            {SENTIMENT_LABELS[mi.brokerSentiment.sentiment] || 'Neutral'}
          </span>
        </div>
        <p className="text-xs text-text-secondary leading-relaxed mb-2">{mi.brokerSentiment.explanation}</p>
        <div className="flex gap-4">
          {mi.brokerSentiment.positiveThemes.length > 0 && (
            <div>
              <div className="text-[10px] text-risk-positive mb-1">Positive Signals</div>
              <div className="flex flex-wrap gap-1">
                {mi.brokerSentiment.positiveThemes.map((t, i) => (
                  <span key={i} className="text-[10px] px-1.5 py-0.5 rounded bg-risk-positive/10 text-risk-positive">{t}</span>
                ))}
              </div>
            </div>
          )}
          {mi.brokerSentiment.negativeThemes.length > 0 && (
            <div>
              <div className="text-[10px] text-risk-high mb-1">Concerns</div>
              <div className="flex flex-wrap gap-1">
                {mi.brokerSentiment.negativeThemes.map((t, i) => (
                  <span key={i} className="text-[10px] px-1.5 py-0.5 rounded bg-risk-high/10 text-risk-high">{t}</span>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 5. Key Market Themes */}
      {mi.keyThemes.length > 0 && (
        <div className="mb-4">
          <div className="text-[10px] font-semibold text-text-muted uppercase tracking-wider mb-1.5">Key Market Themes</div>
          <div className="space-y-1">
            {mi.keyThemes.map((theme, i) => (
              <div key={i} className="text-xs text-text-secondary leading-relaxed flex gap-2">
                <span className="text-accent flex-shrink-0 mt-0.5">-</span>
                <span>{theme}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Sources */}
      <div className="bg-bg-tertiary/50 rounded p-3 mt-3">
        <div className="text-[10px] font-semibold text-text-muted uppercase tracking-wider mb-1.5">Sources</div>
        <div className="text-[11px] text-text-muted mb-2">
          Based on {mi.sources.fileCount} underwriting file{mi.sources.fileCount !== 1 ? 's' : ''} ({mi.sources.yearRange})
        </div>
        {mi.sources.excerpts.length > 0 && (
          <div className="space-y-1.5">
            {mi.sources.excerpts.map((excerpt, i) => (
              <blockquote key={i} className="text-[11px] text-text-primary bg-bg-primary/50 border-l-2 border-accent/30 px-2 py-1.5 rounded-r italic leading-relaxed">
                {excerpt}
              </blockquote>
            ))}
          </div>
        )}
        {mi.sources.pageReferences.length > 0 && (
          <div className="text-[10px] text-text-muted mt-2">
            Refs: {mi.sources.pageReferences.join(' | ')}
          </div>
        )}
      </div>
    </div>
  );
}
