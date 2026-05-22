'use client';

// New-spine upload page (Ticket #14). Posts to POST /api/build-and-ingest
// (Tier B / cached). Receives { rootId, extractionResultId, ... } and
// navigates to /analysis/[rootId], where the unified-read endpoint dispatches
// to the RenderedAnalysisView component.
//
// Removed from the legacy flow:
//   - Supporting documents upload (no spine slot exists)
//   - Underwriting template selector (Excel rendering is a separate cutover)
//   - Seller-UW PDF upload (no spine slot; legacy "Path C" tracked in #11)
//
// Added for the new spine:
//   - dealRef (required, free-form deal identifier)
//   - analysisAsOfDate (required, ISO 8601; defaults to today)
//   - librarySnapshotId / marketBenchmarksId / creditManifestoId registry
//     selectors (populated from /api/registry/*)
//   - Structured loanTerms input (required-in-practice; route returns 400
//     with JE_LOAN_AMOUNT_MISSING if absent)

import { useState, useCallback, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useDropzone } from 'react-dropzone';
import { api } from '@/lib/api-client';
import { ASSET_TYPES, type AssetType } from '@cre/contracts';
import type {
  CreditManifesto,
  LibrarySnapshot,
  MarketBenchmarks,
} from '@cre/contracts';

type RegistryItems = {
  library: LibrarySnapshot[];
  benchmarks: MarketBenchmarks[];
  manifestos: CreditManifesto[];
};

/** Local UI shape for the structured loanTerms form. Converted to the
 *  contract's LoanTermsExtraction shape (months / fraction) at submit time. */
interface LoanTermsUI {
  loanAmount: string;       // dollars; allow empty string
  interestRatePercent: string; // 7.50 (%) → converted to 0.075 on submit
  amortizationYears: string;   // 30 → 360 months
  ioPeriodYears: string;        // 0–N years → months
  maturityDate: string;         // YYYY-MM-DD from <input type="date">
}

const DEFAULT_LOAN_TERMS: LoanTermsUI = {
  loanAmount: '',
  interestRatePercent: '',
  amortizationYears: '',
  ioPeriodYears: '0',
  maturityDate: '',
};

/** Display labels for canonical PascalCase AssetType values. The state + submit
 *  always carry canonical values (per issue #28); this map exists purely so
 *  multi-word types ("SelfStorage", "MixedUse", "MHC") render as human-friendly
 *  strings in the dropdown UI. */
const ASSET_TYPE_LABELS: Record<AssetType, string> = {
  Office:       'Office',
  Retail:       'Retail',
  Multifamily:  'Multifamily',
  Industrial:   'Industrial',
  Hotel:        'Hotel',
  SelfStorage:  'Self Storage',
  MHC:          'Manufactured Housing',
  MixedUse:     'Mixed Use',
  Other:        'Other',
};

function todayISODateOnly(): string {
  // YYYY-MM-DD slice of an ISO date for <input type="date">.
  return new Date().toISOString().slice(0, 10);
}

export default function NewAnalysisPage() {
  const router = useRouter();

  // Files
  const [asrFile, setAsrFile] = useState<File | null>(null);
  const [rentRollFile, setRentRollFile] = useState<File | null>(null);
  const [sellerCfFile, setSellerCfFile] = useState<File | null>(null);

  // Text + selector form fields
  const [dealRef, setDealRef] = useState<string>('');
  const [analysisAsOfDate, setAnalysisAsOfDate] = useState<string>(todayISODateOnly());
  const [propertyType, setPropertyType] = useState<AssetType | ''>('');
  const [librarySnapshotId, setLibrarySnapshotId] = useState<string>('');
  const [marketBenchmarksId, setMarketBenchmarksId] = useState<string>('');
  const [creditManifestoId, setCreditManifestoId] = useState<string>('');
  const [loanTerms, setLoanTerms] = useState<LoanTermsUI>(DEFAULT_LOAN_TERMS);

  // Registry options (fetched on page load)
  const [registry, setRegistry] = useState<RegistryItems>({ library: [], benchmarks: [], manifestos: [] });
  const [registryLoading, setRegistryLoading] = useState(true);

  // Submission state
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string>('');

  // Fetch registry lists on mount. Failures degrade gracefully — the empty-
  // state guard below shows a clear message and prevents submission.
  useEffect(() => {
    (async () => {
      try {
        const [lib, bench, man] = await Promise.all([
          api.listLibrarySnapshots().catch(() => ({ items: [] as LibrarySnapshot[] })),
          api.listMarketBenchmarks().catch(() => ({ items: [] as MarketBenchmarks[] })),
          api.listCreditManifestos().catch(() => ({ items: [] as CreditManifesto[] })),
        ]);
        const r = { library: lib.items, benchmarks: bench.items, manifestos: man.items };
        setRegistry(r);
        // Auto-select if exactly one entry exists for each registry.
        if (r.library.length === 1) setLibrarySnapshotId(r.library[0]!.id);
        if (r.benchmarks.length === 1) setMarketBenchmarksId(r.benchmarks[0]!.id);
        if (r.manifestos.length === 1) setCreditManifestoId(r.manifestos[0]!.id);
      } finally {
        setRegistryLoading(false);
      }
    })();
  }, []);

  const registryReady = registry.library.length > 0 && registry.benchmarks.length > 0 && registry.manifestos.length > 0;

  // Dropzones
  const onDropAsr = useCallback((accepted: File[]) => {
    if (accepted.length > 0) { setAsrFile(accepted[0]!); setError(''); }
  }, []);
  const { getRootProps: getAsrRootProps, getInputProps: getAsrInputProps, isDragActive: isAsrDrag } = useDropzone({
    onDrop: onDropAsr,
    accept: { 'application/pdf': ['.pdf'] },
    maxSize: 50 * 1024 * 1024,
    multiple: false,
  });

  const onDropRentRoll = useCallback((accepted: File[]) => {
    if (accepted.length > 0) { setRentRollFile(accepted[0]!); setError(''); }
  }, []);
  const { getRootProps: getRentRollRootProps, getInputProps: getRentRollInputProps, isDragActive: isRentRollDrag } = useDropzone({
    onDrop: onDropRentRoll,
    accept: {
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
      'application/vnd.ms-excel.sheet.macroEnabled.12': ['.xlsm'],
    },
    maxSize: 50 * 1024 * 1024,
    multiple: false,
  });

  const onDropSellerCf = useCallback((accepted: File[]) => {
    if (accepted.length > 0) { setSellerCfFile(accepted[0]!); setError(''); }
  }, []);
  const { getRootProps: getSellerCfRootProps, getInputProps: getSellerCfInputProps, isDragActive: isSellerCfDrag } = useDropzone({
    onDrop: onDropSellerCf,
    accept: {
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
      'application/vnd.ms-excel.sheet.macroEnabled.12': ['.xlsm'],
    },
    maxSize: 50 * 1024 * 1024,
    multiple: false,
  });

  /** Coerce a string-or-empty number input to a finite number, or null. */
  function asFiniteOrNull(s: string): number | null {
    if (s.trim().length === 0) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

  /** Convert the UI loanTerms shape to the contract's LoanTermsExtraction. */
  function loanTermsToContract(ui: LoanTermsUI): {
    loanAmount: number | null;
    interestRate: number | null;
    amortization: number | null;
    interestOnlyPeriod: number | null;
    maturityDate: string | null;
  } {
    const ratePercent = asFiniteOrNull(ui.interestRatePercent);
    const amortYears = asFiniteOrNull(ui.amortizationYears);
    const ioYears = asFiniteOrNull(ui.ioPeriodYears);
    return {
      loanAmount: asFiniteOrNull(ui.loanAmount),
      interestRate: ratePercent === null ? null : ratePercent / 100, // 7.5 → 0.075
      amortization: amortYears === null ? null : Math.round(amortYears * 12),
      interestOnlyPeriod: ioYears === null ? null : Math.round(ioYears * 12),
      maturityDate: ui.maturityDate.length === 0 ? null : `${ui.maturityDate}T00:00:00Z`,
    };
  }

  const submittable = useMemo(() => {
    if (uploading || !registryReady) return false;
    if (!dealRef.trim() || !analysisAsOfDate || !propertyType) return false;
    if (!librarySnapshotId || !marketBenchmarksId || !creditManifestoId) return false;
    // Engine requires loanAmount, amortization, AND maturityDate (each fires a
    // JE_*_MISSING throw if null — see line-item-builders.ts {L280, L328, L637}).
    // interestRate is needed for DSCR computation downstream; required here for
    // institutional rigor (no real submission lacks it). IO period stays optional
    // — engine treats it as applicability-gated.
    if (asFiniteOrNull(loanTerms.loanAmount) === null) return false;
    if (asFiniteOrNull(loanTerms.interestRatePercent) === null) return false;
    if (asFiniteOrNull(loanTerms.amortizationYears) === null) return false;
    if (loanTerms.maturityDate.length === 0) return false;
    return true;
  }, [
    uploading, registryReady, dealRef, analysisAsOfDate, propertyType,
    librarySnapshotId, marketBenchmarksId, creditManifestoId,
    loanTerms.loanAmount, loanTerms.interestRatePercent,
    loanTerms.amortizationYears, loanTerms.maturityDate,
  ]);

  async function handleSubmit(): Promise<void> {
    setError('');
    setUploading(true);
    try {
      const result = await api.buildAndIngest({
        files: {
          ...(asrFile ? { asr: asrFile } : {}),
          ...(rentRollFile ? { rentRoll: rentRollFile } : {}),
          ...(sellerCfFile ? { sellerCf: sellerCfFile } : {}),
        },
        formFields: {
          analysisAsOfDate: `${analysisAsOfDate}T00:00:00Z`,
          dealRef: dealRef.trim(),
          propertyType,
          librarySnapshotId,
          marketBenchmarksId,
          creditManifestoId,
          loanTerms: loanTermsToContract(loanTerms),
        },
      });
      router.push(`/analysis/${result.rootId}`);
    } catch (e) {
      const err = e as Error;
      setError(err.message || 'Upload failed');
      setUploading(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="max-w-4xl mx-auto px-6 py-12">
      <h1 className="text-2xl font-bold text-text-primary mb-2">New Analysis</h1>
      <p className="text-sm text-text-secondary mb-10">
        Upload deal documents. Persistence is content-addressed; identical re-uploads short-circuit
        the extraction pipeline via the input cache.
      </p>

      {/* Registry empty-state guards */}
      {!registryLoading && !registryReady && (
        <div className="card border-risk-high/40 bg-risk-high/5 mb-8">
          <h3 className="text-sm font-semibold text-risk-high mb-2">Registry setup required</h3>
          <p className="text-xs text-text-secondary mb-3">
            Submitting an analysis requires at least one entry in each of the three pinned registries.
            Visit the admin pages to create them:
          </p>
          <ul className="text-xs text-text-secondary list-disc pl-5 space-y-1">
            {registry.library.length === 0 && (
              <li><a href="/admin/registry/library-snapshots" className="text-accent hover:underline">/admin/registry/library-snapshots</a> — no entries</li>
            )}
            {registry.benchmarks.length === 0 && (
              <li><a href="/admin/registry/market-benchmarks" className="text-accent hover:underline">/admin/registry/market-benchmarks</a> — no entries</li>
            )}
            {registry.manifestos.length === 0 && (
              <li><a href="/admin/registry/credit-manifestos" className="text-accent hover:underline">/admin/registry/credit-manifestos</a> — no entries</li>
            )}
          </ul>
        </div>
      )}

      {/* Section 1: Deal identity */}
      <div className="mb-8">
        <label className="text-xs font-semibold text-text-secondary uppercase tracking-wider block mb-3">
          1. Deal Identity <span className="text-risk-high">*</span>
        </label>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-xs text-text-secondary block mb-1">Deal reference</label>
            <input
              type="text"
              className="input-field w-full"
              placeholder="e.g. PROJECT-ATLANTA-2026"
              value={dealRef}
              onChange={(e) => setDealRef(e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs text-text-secondary block mb-1">Analysis as-of date</label>
            <input
              type="date"
              className="input-field w-full"
              value={analysisAsOfDate}
              onChange={(e) => setAnalysisAsOfDate(e.target.value)}
            />
          </div>
        </div>
      </div>

      {/* Section 2: Files */}
      <div className="mb-8">
        <label className="text-xs font-semibold text-text-secondary uppercase tracking-wider block mb-3">
          2. Documents
        </label>
        <p className="text-xs text-text-muted mb-3">
          All three slots are optional at the multipart level. The composer reports absent slots in the BuildReport;
          downstream judgment surfaces missing-data flags for fields that depend on the absent slots.
        </p>
        <div className="grid grid-cols-3 gap-4">
          {/* ASR (PDF) */}
          <Dropzone
            label="ASR (PDF)"
            file={asrFile}
            isDragActive={isAsrDrag}
            getRootProps={getAsrRootProps}
            getInputProps={getAsrInputProps}
            acceptHint="PDF only (max 50MB)"
          />
          {/* Rent roll (XLSX) */}
          <Dropzone
            label="Rent roll (XLSX)"
            file={rentRollFile}
            isDragActive={isRentRollDrag}
            getRootProps={getRentRollRootProps}
            getInputProps={getRentRollInputProps}
            acceptHint="XLSX or XLSM (max 50MB)"
          />
          {/* Seller cash flow (XLSX) */}
          <Dropzone
            label="Seller cash flow (XLSX)"
            file={sellerCfFile}
            isDragActive={isSellerCfDrag}
            getRootProps={getSellerCfRootProps}
            getInputProps={getSellerCfInputProps}
            acceptHint="XLSX or XLSM (max 50MB)"
          />
        </div>
      </div>

      {/* Section 3: Asset type */}
      <div className="mb-8">
        <label className="text-xs font-semibold text-text-secondary uppercase tracking-wider block mb-3">
          3. Asset type <span className="text-risk-high">*</span>
        </label>
        <div className="grid grid-cols-4 gap-3">
          {ASSET_TYPES.map((value) => (
            <button
              key={value}
              onClick={() => setPropertyType(value)}
              className={`card text-center py-4 cursor-pointer transition-colors ${
                propertyType === value ? 'border-accent bg-accent/10' : 'hover:border-accent/50'
              }`}
            >
              <div className="text-sm font-medium text-text-primary">{ASSET_TYPE_LABELS[value]}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Section 4: Registry references */}
      <div className="mb-8">
        <label className="text-xs font-semibold text-text-secondary uppercase tracking-wider block mb-3">
          4. Registry references <span className="text-risk-high">*</span>
        </label>
        <p className="text-xs text-text-muted mb-3">
          Pinned upstream inputs to the judgment engine. Manage entries via the <a href="/admin/registry" className="text-accent hover:underline">Registry</a> admin pages.
        </p>
        <div className="grid grid-cols-3 gap-4">
          <RegistrySelector
            label="Library snapshot"
            items={registry.library.map((s) => ({ id: s.id, sublabel: s.asOf }))}
            value={librarySnapshotId}
            onChange={setLibrarySnapshotId}
            emptyLink="/admin/registry/library-snapshots"
          />
          <RegistrySelector
            label="Market benchmarks"
            items={registry.benchmarks.map((b) => ({ id: b.id, sublabel: b.asOfDate }))}
            value={marketBenchmarksId}
            onChange={setMarketBenchmarksId}
            emptyLink="/admin/registry/market-benchmarks"
          />
          <RegistrySelector
            label="Credit manifesto"
            items={registry.manifestos.map((m) => ({ id: m.id, sublabel: `v${m.manifestoContractVersion}` }))}
            value={creditManifestoId}
            onChange={setCreditManifestoId}
            emptyLink="/admin/registry/credit-manifestos"
          />
        </div>
      </div>

      {/* Section 5: Loan terms */}
      <div className="mb-8">
        <label className="text-xs font-semibold text-text-secondary uppercase tracking-wider block mb-3">
          5. Loan terms <span className="text-risk-high">*</span>
        </label>
        <p className="text-xs text-text-muted mb-3">
          The new-spine judgment engine needs loan terms supplied at upload time (no v0.2.0 adapter
          extracts them from documents yet).
          Loan amount, rate, amortization, and maturity date are required. IO period is optional.
        </p>
        <div className="grid grid-cols-5 gap-4">
          <div>
            <label className="text-xs text-text-secondary block mb-1">
              Loan amount ($) <span className="text-risk-high">*</span>
            </label>
            <input
              type="number"
              className="input-field w-full"
              placeholder="e.g. 10000000"
              value={loanTerms.loanAmount}
              onChange={(e) => setLoanTerms({ ...loanTerms, loanAmount: e.target.value })}
            />
          </div>
          <div>
            <label className="text-xs text-text-secondary block mb-1">
              Rate (%) <span className="text-risk-high">*</span>
            </label>
            <input
              type="number"
              step="0.01"
              className="input-field w-full"
              placeholder="e.g. 7.25"
              value={loanTerms.interestRatePercent}
              onChange={(e) => setLoanTerms({ ...loanTerms, interestRatePercent: e.target.value })}
            />
          </div>
          <div>
            <label className="text-xs text-text-secondary block mb-1">
              Amort (years) <span className="text-risk-high">*</span>
            </label>
            <input
              type="number"
              className="input-field w-full"
              placeholder="e.g. 30"
              value={loanTerms.amortizationYears}
              onChange={(e) => setLoanTerms({ ...loanTerms, amortizationYears: e.target.value })}
            />
          </div>
          <div>
            <label className="text-xs text-text-secondary block mb-1">IO period (years)</label>
            <input
              type="number"
              className="input-field w-full"
              placeholder="e.g. 0"
              value={loanTerms.ioPeriodYears}
              onChange={(e) => setLoanTerms({ ...loanTerms, ioPeriodYears: e.target.value })}
            />
          </div>
          <div>
            <label className="text-xs text-text-secondary block mb-1">
              Maturity date <span className="text-risk-high">*</span>
            </label>
            <input
              type="date"
              className="input-field w-full"
              value={loanTerms.maturityDate}
              onChange={(e) => setLoanTerms({ ...loanTerms, maturityDate: e.target.value })}
            />
          </div>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="mb-4 p-3 bg-risk-high/10 border border-risk-high/30 rounded text-sm text-risk-high">
          <span className="font-semibold">Submit failed: </span>{error}
        </div>
      )}

      {/* Submit */}
      <div className="flex items-center justify-end gap-4">
        <button
          onClick={handleSubmit}
          disabled={!submittable}
          className="btn-primary px-8 py-3 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {uploading ? 'Processing...' : 'Submit for Analysis'}
        </button>
      </div>
    </div>
  );
}

/* ----------------------------- helper components --------------------------- */

function Dropzone({
  label,
  file,
  isDragActive,
  getRootProps,
  getInputProps,
  acceptHint,
}: {
  label: string;
  file: File | null;
  isDragActive: boolean;
  getRootProps: () => Record<string, unknown>;
  getInputProps: () => Record<string, unknown>;
  acceptHint: string;
}) {
  return (
    <div>
      <div className="text-xs text-text-secondary mb-2">{label}</div>
      <div
        {...getRootProps()}
        className={`border-2 border-dashed rounded p-5 text-center cursor-pointer transition-colors ${
          isDragActive
            ? 'border-accent bg-accent/5'
            : file
              ? 'border-risk-positive bg-risk-positive/5'
              : 'border-border-secondary hover:border-accent/50'
        }`}
      >
        <input {...getInputProps()} />
        {file ? (
          <div>
            <div className="text-xs font-medium text-risk-positive truncate">{file.name}</div>
            <div className="text-[10px] text-text-muted mt-1">
              {(file.size / 1024 / 1024).toFixed(2)} MB — click to replace
            </div>
          </div>
        ) : (
          <div>
            <div className="text-xs text-text-secondary">
              {isDragActive ? 'Drop here' : 'Drag or click'}
            </div>
            <div className="text-[10px] text-text-muted mt-1">{acceptHint}</div>
          </div>
        )}
      </div>
    </div>
  );
}

function RegistrySelector({
  label,
  items,
  value,
  onChange,
  emptyLink,
}: {
  label: string;
  items: { id: string; sublabel: string }[];
  value: string;
  onChange: (id: string) => void;
  emptyLink: string;
}) {
  const hasItems = items.length > 0;
  return (
    <div>
      <label className="text-xs text-text-secondary block mb-1">{label}</label>
      {hasItems ? (
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="input-field w-full text-xs"
        >
          <option value="">— select —</option>
          {items.map((it) => (
            <option key={it.id} value={it.id}>
              {it.id.slice(0, 12)}… — {it.sublabel}
            </option>
          ))}
        </select>
      ) : (
        <div className="text-xs text-text-muted">
          None.{' '}
          <a href={emptyLink} className="text-accent hover:underline">Create one</a>
        </div>
      )}
    </div>
  );
}
