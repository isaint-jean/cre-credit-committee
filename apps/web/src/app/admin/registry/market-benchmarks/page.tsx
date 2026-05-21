'use client';

import { useState, useEffect, useCallback } from 'react';
import { api } from '@/lib/api-client';
import { JsonPasteForm } from '@/components/JsonPasteForm';
import type { MarketBenchmarks } from '@cre/contracts';

const EXAMPLE: object = {
  asOfDate: '2026-05-21T00:00:00Z',
  capRates: {
    Office: 0.075, Retail: null, Multifamily: null, Hotel: null,
    Industrial: null, SelfStorage: null, MHC: null, MixedUse: null, Other: null,
  },
  vacancyRates: {
    Office: 0.10, Retail: 0.06, Multifamily: 0.05, Hotel: null,
    Industrial: null, SelfStorage: null, MHC: null, MixedUse: null, Other: null,
  },
  expensesPerSqFt: {
    Office: 8.50, Retail: 5.50, Multifamily: null, Hotel: null,
    Industrial: null, SelfStorage: null, MHC: null, MixedUse: null, Other: null,
  },
  interestRateAssumptions: { baseRate: 0.065, stressRate: 0.085 },
  marketLiquidityIndex: { primary: 0.85, secondary: 0.55, tertiary: 0.30 },
};

export default function MarketBenchmarksPage() {
  const [items, setItems] = useState<MarketBenchmarks[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.listMarketBenchmarks();
      setItems(data.items);
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-base font-semibold text-text-primary">Market Benchmarks</h2>
          <p className="text-xs text-text-secondary">
            Point-value market context (rates, prevailing norms). Content-addressed; immutable once stored.
          </p>
        </div>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="btn-primary text-sm"
        >
          {showForm ? 'Cancel' : 'New'}
        </button>
      </div>

      {showForm && (
        <JsonPasteForm
          label="Paste MarketBenchmarks JSON"
          exampleJson={EXAMPLE}
          onSubmit={async (parsed) => {
            const res = await api.postMarketBenchmarks(parsed);
            await load();
            setShowForm(false);
            return res;
          }}
        />
      )}

      {loading ? (
        <div className="text-center py-12 text-text-muted">Loading market benchmarks...</div>
      ) : items.length === 0 ? (
        <div className="text-center py-12 text-text-muted">
          No market benchmarks yet. Click <span className="font-semibold">New</span> to add one.
        </div>
      ) : (
        <table className="w-full">
          <thead>
            <tr>
              <th className="table-header text-left">ID</th>
              <th className="table-header text-left">As of</th>
              <th className="table-header text-left w-40">Office cap rate</th>
              <th className="table-header text-center w-20">Details</th>
            </tr>
          </thead>
          <tbody>
            {items.map((m) => (
              <RegistryRow key={m.id} record={m} expandedId={expandedId} setExpandedId={setExpandedId} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function RegistryRow({
  record,
  expandedId,
  setExpandedId,
}: {
  record: MarketBenchmarks;
  expandedId: string | null;
  setExpandedId: (id: string | null) => void;
}) {
  const isOpen = expandedId === record.id;
  return (
    <>
      <tr>
        <td className="table-cell font-mono text-xs text-text-secondary">{record.id.slice(0, 16)}…</td>
        <td className="table-cell text-xs">{record.asOfDate}</td>
        <td className="table-cell text-xs font-mono">
          {record.capRates.Office === null ? '—' : (record.capRates.Office * 100).toFixed(2) + '%'}
        </td>
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
