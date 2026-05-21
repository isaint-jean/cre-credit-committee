'use client';

import { useState, useEffect, useCallback } from 'react';
import { api } from '@/lib/api-client';
import { JsonPasteForm } from '@/components/JsonPasteForm';
import type { LibrarySnapshot } from '@cre/contracts';

export default function LibrarySnapshotsPage() {
  const [items, setItems] = useState<LibrarySnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Form state. Distinct from the other two pages because of the build-from-deals
  // pre-population flow.
  const [showForm, setShowForm] = useState(false);
  const [seededExample, setSeededExample] = useState<object | undefined>(undefined);
  const [seededFormKey, setSeededFormKey] = useState(0);

  // Build-from-approved-deals state.
  const [asOfDate, setAsOfDate] = useState<string>(() => new Date().toISOString().slice(0, 10));
  const [building, setBuilding] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.listLibrarySnapshots();
      setItems(data.items);
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function handleBuild(): Promise<void> {
    setBuilding(true);
    setBuildError(null);
    try {
      // Server expects an ISO datetime. The <input type="date"> gives YYYY-MM-DD;
      // append a midnight UTC component to make it a full ISO string.
      const isoAsOf = `${asOfDate}T00:00:00Z`;
      const res = await api.buildLibrarySnapshot({ asOfDate: isoAsOf });
      // Pre-populate the JsonPasteForm with the computed snapshot body. Bump
      // the form's key so a fresh component instance mounts with the new seed.
      setSeededExample(res.snapshot as unknown as object);
      setSeededFormKey((k) => k + 1);
      setShowForm(true);
    } catch (e) {
      const err = e as Error;
      setBuildError(err.message ?? 'Build failed');
    } finally {
      setBuilding(false);
    }
  }

  function handleManualNew(): void {
    setSeededExample(undefined);
    setSeededFormKey((k) => k + 1);
    setShowForm(true);
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-base font-semibold text-text-primary">Library Snapshots</h2>
          <p className="text-xs text-text-secondary">
            Per-asset-type distributions derived from approved_deals (median / p25 / p75 / n).
            Architecture §4: n &lt; 20 yields a null entry for that asset type (degraded mode).
          </p>
        </div>
        <button
          onClick={() => (showForm ? setShowForm(false) : handleManualNew())}
          className="btn-primary text-sm"
        >
          {showForm ? 'Cancel' : 'New (paste JSON)'}
        </button>
      </div>

      {/* Build-from-approved-deals action — separate from the manual JSON path */}
      <div className="card mb-6 border-accent/20">
        <h3 className="text-sm font-semibold text-text-primary mb-2">Build from approved_deals</h3>
        <p className="text-xs text-text-secondary mb-3">
          Compute a fresh snapshot from the current <code className="font-mono">approved_deals</code> table state at the given as-of date.
          The computed body opens in the paste form below — review, edit if needed, then submit to persist.
        </p>
        <div className="flex items-end gap-2">
          <div>
            <label className="text-xs text-text-secondary block mb-1">as-of date</label>
            <input
              type="date"
              className="input-field text-xs"
              value={asOfDate}
              onChange={(e) => setAsOfDate(e.target.value)}
            />
          </div>
          <button
            onClick={() => void handleBuild()}
            className="btn-secondary text-xs"
            disabled={building || asOfDate.length === 0}
          >
            {building ? 'Building...' : 'Build'}
          </button>
        </div>
        {buildError !== null && (
          <div className="mt-3 text-xs text-risk-high">
            <span className="font-semibold">Build failed: </span>
            <span className="font-mono">{buildError}</span>
          </div>
        )}
      </div>

      {showForm && (
        <JsonPasteForm
          key={seededFormKey}
          label="Paste LibrarySnapshot JSON"
          exampleJson={seededExample}
          onSubmit={async (parsed) => {
            const res = await api.postLibrarySnapshot(parsed);
            await load();
            setShowForm(false);
            return res;
          }}
        />
      )}

      {loading ? (
        <div className="text-center py-12 text-text-muted">Loading library snapshots...</div>
      ) : items.length === 0 ? (
        <div className="text-center py-12 text-text-muted">
          No library snapshots yet. Use <span className="font-semibold">Build from approved_deals</span> or click <span className="font-semibold">New</span>.
        </div>
      ) : (
        <table className="w-full">
          <thead>
            <tr>
              <th className="table-header text-left">ID</th>
              <th className="table-header text-left">As of</th>
              <th className="table-header text-left">Approved-deals hash</th>
              <th className="table-header text-center w-20">Details</th>
            </tr>
          </thead>
          <tbody>
            {items.map((s) => (
              <SnapshotRow key={s.id} record={s} expandedId={expandedId} setExpandedId={setExpandedId} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function SnapshotRow({
  record,
  expandedId,
  setExpandedId,
}: {
  record: LibrarySnapshot;
  expandedId: string | null;
  setExpandedId: (id: string | null) => void;
}) {
  const isOpen = expandedId === record.id;
  return (
    <>
      <tr>
        <td className="table-cell font-mono text-xs text-text-secondary">{record.id.slice(0, 16)}…</td>
        <td className="table-cell text-xs">{record.asOf}</td>
        <td className="table-cell font-mono text-xs text-text-secondary">{record.approvedDealsTableHash.slice(0, 16)}…</td>
        <td className="table-cell text-center">
          <button
            onClick={() => setExpandedId(isOpen ? null : record.id)}
            className="text-xs text-accent hover:text-accent-hover"
          >
            {isOpen ? 'Hide' : 'View'}
          </button>
        </td>
      </tr>
      {isOpen && (
        <tr>
          <td colSpan={4} className="table-cell">
            <pre className="text-xs font-mono whitespace-pre-wrap break-all bg-bg-secondary p-3 rounded">
              {JSON.stringify(record, null, 2)}
            </pre>
          </td>
        </tr>
      )}
    </>
  );
}
