'use client';

/**
 * NoiReconciliationReceipts — the collapsed "receipts" expander shown INSIDE the
 * deal-room's existing red NOI-divergence banner. Fetches the sourced side-by-side
 * (value · source-document · variance) from GET /pools/loan-for-root/:rootId/noi-
 * reconciliation, which uses the SAME buildNoiReconciliationDetail builder as the memo
 * — so the deal-room rows are byte-identical to the memo's.
 *
 * DISPLAY-ONLY / render-time. Renders nothing until ≥2 figures are present (a side-by-side
 * needs two), matching the memo's gate. NO page numbers — source document only.
 */
import { useEffect, useState } from 'react';
import { api } from '@/lib/api-client';
import type { NoiReconciliationDetail } from '@cre/contracts';

export function NoiReconciliationReceipts({ rootId }: { rootId: string }) {
  const [detail, setDetail] = useState<NoiReconciliationDetail | null>(null);
  useEffect(() => {
    let live = true;
    api.getNoiReconciliation(rootId)
      .then((r) => { if (live) setDetail(r.detail); })
      .catch(() => { /* no detail → the banner stays terse */ });
    return () => { live = false; };
  }, [rootId]);

  if (detail === null || detail.rows.length < 2) return null;

  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-xs font-medium text-red-800">Show the figures compared</summary>
      <table className="mt-2 w-full text-xs">
        <thead>
          <tr className="text-red-900">
            <th className="text-left font-medium">Figure</th>
            <th className="text-left font-medium">Value</th>
            <th className="text-left font-medium">Source document</th>
          </tr>
        </thead>
        <tbody>
          {detail.rows.map((r, i) => (
            <tr key={i}>
              <td className="pr-3 text-red-800">{r.label}</td>
              <td className="pr-3 font-medium text-red-900">{r.valueFormatted}</td>
              <td className="text-red-800">{r.sourceDocument}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {detail.variance !== null && <p className="mt-1 text-xs text-red-800">{detail.variance}</p>}
      <p className="mt-1 text-[11px] text-red-700">Source documents shown; page-level provenance is not captured for these figures.</p>
    </details>
  );
}
