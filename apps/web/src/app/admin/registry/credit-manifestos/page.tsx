'use client';

import { useState, useEffect, useCallback } from 'react';
import { api } from '@/lib/api-client';
import { JsonPasteForm } from '@/components/JsonPasteForm';
import type { CreditManifesto } from '@cre/contracts';

const EXAMPLE: object = {
  analysisAsOfDate: '2026-05-21T00:00:00Z',
  manifestoContractVersion: '1.0',
  rules: [
    // Rules array. Empty is acceptable; populate with ManifestoRule objects.
    // See packages/contracts/src/manifesto.ts for the shape (ruleId, metricName,
    // condition, thresholdValue, comparisonOperator, outcome, weight,
    // assetTypes, sourceText, pageReference).
  ],
};

export default function CreditManifestosPage() {
  const [items, setItems] = useState<CreditManifesto[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.listCreditManifestos();
      setItems(data.items);
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-base font-semibold text-text-primary">Credit Manifestos</h2>
          <p className="text-xs text-text-secondary">
            Content-addressed credit-policy rule sets. Immutable once stored. (Separate from the legacy
            <code className="font-mono">/api/manifesto/*</code> PDF-upload flow.)
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
          label="Paste CreditManifesto JSON"
          exampleJson={EXAMPLE}
          onSubmit={async (parsed) => {
            const res = await api.postCreditManifesto(parsed);
            await load();
            setShowForm(false);
            return res;
          }}
        />
      )}

      {loading ? (
        <div className="text-center py-12 text-text-muted">Loading credit manifestos...</div>
      ) : items.length === 0 ? (
        <div className="text-center py-12 text-text-muted">
          No credit manifestos yet. Click <span className="font-semibold">New</span> to add one.
        </div>
      ) : (
        <table className="w-full">
          <thead>
            <tr>
              <th className="table-header text-left">ID</th>
              <th className="table-header text-left">Analysis as-of</th>
              <th className="table-header text-left w-32">Contract version</th>
              <th className="table-header text-center w-20">Rules</th>
              <th className="table-header text-center w-20">Details</th>
            </tr>
          </thead>
          <tbody>
            {items.map((m) => (
              <ManifestoRow key={m.id} record={m} expandedId={expandedId} setExpandedId={setExpandedId} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function ManifestoRow({
  record,
  expandedId,
  setExpandedId,
}: {
  record: CreditManifesto;
  expandedId: string | null;
  setExpandedId: (id: string | null) => void;
}) {
  const isOpen = expandedId === record.id;
  return (
    <>
      <tr>
        <td className="table-cell font-mono text-xs text-text-secondary">{record.id.slice(0, 16)}…</td>
        <td className="table-cell text-xs">{record.analysisAsOfDate}</td>
        <td className="table-cell text-xs font-mono">{record.manifestoContractVersion}</td>
        <td className="table-cell text-center text-xs font-mono">{record.rules.length}</td>
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
          <td colSpan={5} className="table-cell">
            <pre className="text-xs font-mono whitespace-pre-wrap break-all bg-bg-secondary p-3 rounded">
              {JSON.stringify(record, null, 2)}
            </pre>
          </td>
        </tr>
      )}
    </>
  );
}
