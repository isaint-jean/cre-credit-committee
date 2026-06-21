'use client';

/**
 * AddDocumentControl — "Add Document" affordance on the analysis page. Picks a
 * slot + file → POST /api/analyses/:id/append-document (api.appendDocument) →
 * re-ingest as a CHILD revision → re-fetch the now-advanced deal.
 *
 * Surfaces the preserve-and-flag overlay divergences (the 201 body's own channel)
 * as a visible review banner, and gives the 422 (no_eval_context /
 * parent_context_unresolvable) case a clear, non-crashing message.
 *
 * Native styling — mirrors the header action-bar buttons + comment panel tokens
 * (bg-bg-secondary/tertiary, border-border-primary, text-*; risk-high for errors).
 */
import React, { useState } from 'react';
import { api } from '@/lib/api-client';

const APPEND_SLOTS: ReadonlyArray<{ slot: string; label: string }> = [
  { slot: 'asr', label: 'ASR (Anticipated Sale Report)' },
  { slot: 'cf', label: 'Cash Flow (Seller CF)' },
  { slot: 'rent_roll', label: 'Rent Roll' },
  { slot: 'pca', label: 'PCA (Property Condition Assessment)' },
];

type Phase = 'idle' | 'uploading' | 'success' | 'error';

export function AddDocumentControl({
  analysisId,
  onAppended,
}: {
  analysisId: string;
  onAppended: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [slot, setSlot] = useState('cf');
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [divergences, setDivergences] = useState<Array<{ overlay: string; detail: string }>>([]);

  const reset = () => { setPhase('idle'); setErrorMsg(''); setDivergences([]); setFile(null); };

  const submit = async () => {
    if (!file || phase === 'uploading') return;
    setPhase('uploading'); setErrorMsg(''); setDivergences([]);
    try {
      const res = await api.appendDocument(analysisId, slot, file);
      if (res.ok) {
        setDivergences(res.overlayDivergences ?? []);
        setPhase('success');
        setFile(null);
        await onAppended(); // re-fetch → re-render the advanced (child) deal
      } else if (res.status === 422 && (res.error === 'no_eval_context' || res.error === 'parent_context_unresolvable')) {
        setErrorMsg("This deal can't accept new documents (created before append support).");
        setPhase('error');
      } else {
        setErrorMsg('Upload failed — retry.');
        setPhase('error');
      }
    } catch {
      setErrorMsg('Upload failed — retry.');
      setPhase('error');
    }
  };

  return (
    <div className="relative">
      <button
        onClick={() => { setOpen((o) => !o); if (open) reset(); }}
        className="text-xs px-4 py-2 flex items-center gap-2 rounded border border-border-primary bg-bg-tertiary text-text-secondary hover:text-text-primary hover:border-text-muted transition-colors"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
        Add Document
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-80 z-20 rounded border border-border-primary bg-bg-secondary shadow-lg p-3 text-xs">
          <div className="flex items-center justify-between mb-2">
            <span className="font-semibold text-text-primary">Add a source document</span>
            <button onClick={() => { setOpen(false); reset(); }} className="text-text-muted hover:text-text-primary">✕</button>
          </div>

          <label className="block text-text-muted mb-1">Document type</label>
          <select
            value={slot}
            onChange={(e) => setSlot(e.target.value)}
            className="w-full mb-3 px-2 py-1.5 rounded border border-border-primary bg-bg-tertiary text-text-primary"
          >
            {APPEND_SLOTS.map((s) => <option key={s.slot} value={s.slot}>{s.label}</option>)}
          </select>

          <label className="block text-text-muted mb-1">File</label>
          <input
            type="file"
            onChange={(e) => { setFile(e.target.files?.[0] ?? null); if (phase !== 'idle') setPhase('idle'); }}
            className="w-full mb-3 text-text-secondary file:mr-2 file:px-2 file:py-1 file:rounded file:border-0 file:bg-bg-tertiary file:text-text-secondary"
          />

          <button
            onClick={submit}
            disabled={!file || phase === 'uploading'}
            className="btn-primary text-xs px-4 py-2 w-full flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {phase === 'uploading' && <span className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" />}
            {phase === 'uploading' ? 'Adding…' : 'Add & re-ingest'}
          </button>

          {phase === 'success' && (
            <div className="mt-3 text-text-secondary">
              <div className="text-accent font-medium mb-1">Document added — deal updated.</div>
              {divergences.length > 0 && (
                <div className="rounded border border-risk-medium/40 bg-risk-medium/10 p-2 mt-1">
                  <div className="font-medium text-text-primary mb-1">Review — added doc differs from kept values:</div>
                  <ul className="list-disc list-inside space-y-0.5 text-text-muted">
                    {divergences.map((d, i) => <li key={i}>{d.detail}</li>)}
                  </ul>
                </div>
              )}
            </div>
          )}

          {phase === 'error' && (
            <div className="mt-3 rounded border border-risk-high/40 bg-risk-high/10 p-2 text-risk-high">{errorMsg}</div>
          )}
        </div>
      )}
    </div>
  );
}
