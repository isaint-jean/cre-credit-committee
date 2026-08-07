/**
 * BuyerDiffPanel — the calm view. The originator sees the buyer-diff (issuer → our
 * buyer-adjusted underwriting, per adjustment, with the "why") and accepts/rejects
 * each suggestion, then downloads a clean Excel reflecting those decisions.
 *
 * Calm discipline (quiet by default): the checklist is collapsed to a one-line
 * summary until opened; low-pressure ✓/✗; evidence-grounded question phrasing.
 * Accept/reject is AIR-GAPPED — it governs only what renders in the download, never
 * the underwriting score. Mirrors NegotiationSurface's orig → buyer → why pattern.
 */
'use client';

import React, { useEffect, useState } from 'react';
import { api, type BuyerDiffSuggestionDTO } from '@/lib/api-client';

type Decision = 'accepted' | 'rejected' | 'pending';

function fmt(s: BuyerDiffSuggestionDTO, v: number | null): string {
  if (v === null) return '—';
  return s.format === 'pct' ? `${(v * 100).toFixed(2)}%` : `$${Math.round(v).toLocaleString('en-US')}`;
}

export function BuyerDiffPanel({ analysisId }: { readonly analysisId: string }): React.ReactElement | null {
  const [findings, setFindings] = useState<BuyerDiffSuggestionDTO[] | null>(null);
  const [open, setOpen] = useState(false);            // quiet by default
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.getBuyerDiffDecisions(analysisId)
      .then((r) => { if (live) setFindings(r.findings); })
      .catch(() => { if (live) setError('Buyer-diff not available for this deal.'); });
    return () => { live = false; };
  }, [analysisId]);

  if (error) return null;               // fail quiet — nothing to nag about
  if (!findings) return null;
  if (findings.length === 0) return null;

  const accepted = findings.filter((f) => f.decision === 'accepted').length;
  const pending = findings.filter((f) => f.decision === 'pending').length;

  async function decide(findingId: string, decision: Decision): Promise<void> {
    setBusy(findingId);
    try {
      const r = await api.putBuyerDiffDecision(analysisId, findingId, decision);
      setFindings(r.findings);
    } catch { setError('Could not save that decision.'); }
    finally { setBusy(null); }
  }

  return (
    <section style={S.wrap}>
      <button style={S.summary} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span style={S.summaryLead}>{open ? '▾' : '▸'} What a buyer will ask</span>
        <span style={S.summaryMeta}>
          {findings.length} question{findings.length === 1 ? '' : 's'}
          {pending > 0 ? ` · ${pending} to review` : ' · all reviewed'}
          {accepted > 0 ? ` · ${accepted} accepted` : ''}
        </span>
      </button>

      {open && (
        <div style={S.list}>
          {findings.map((f) => (
            <div key={f.findingId} style={{ ...S.card, ...(f.decision === 'rejected' ? S.cardRejected : f.decision === 'accepted' ? S.cardAccepted : {}) }}>
              <div style={S.question}>{f.question}</div>
              <div style={S.numbers}>
                <span style={S.issuer}>Issuer&nbsp;<b>{fmt(f, f.issuer)}</b></span>
                <span style={S.arrow}>→</span>
                <span style={S.buyer}>Buyer&nbsp;<b>{fmt(f, f.buyer)}</b></span>
              </div>
              {f.why.length > 0 && (
                <ul style={S.why}>
                  {f.why.map((w, i) => (<li key={i}><code style={S.rule}>{w.ruleId}</code> {w.reason}</li>))}
                </ul>
              )}
              <div style={S.actions}>
                <button
                  style={{ ...S.btn, ...(f.decision === 'accepted' ? S.btnAcceptOn : S.btnGhost) }}
                  disabled={busy === f.findingId}
                  onClick={() => decide(f.findingId, f.decision === 'accepted' ? 'pending' : 'accepted')}
                >✓ Accept</button>
                <button
                  style={{ ...S.btn, ...(f.decision === 'rejected' ? S.btnRejectOn : S.btnGhost) }}
                  disabled={busy === f.findingId}
                  onClick={() => decide(f.findingId, f.decision === 'rejected' ? 'pending' : 'rejected')}
                >✗ Reject</button>
              </div>
            </div>
          ))}
          <div style={S.footer}>
            <span style={S.footerNote}>Accept/reject changes only the download — never the underwriting score.</span>
            <button style={S.download} onClick={() => api.downloadBuyerDiffWorkbook(analysisId)}>
              ⬇ Download seller UW
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

const S: Record<string, React.CSSProperties> = {
  wrap: { border: '1px solid #e6e8ec', borderRadius: 12, background: '#fff', margin: '16px 0', overflow: 'hidden' },
  summary: { width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '14px 18px', background: 'transparent', border: 'none', cursor: 'pointer', font: 'inherit', textAlign: 'left' },
  summaryLead: { fontWeight: 600, color: '#1f2430', fontSize: 15 },
  summaryMeta: { color: '#8b93a3', fontSize: 13 },
  list: { padding: '4px 18px 18px', borderTop: '1px solid #eef0f3' },
  card: { border: '1px solid #eef0f3', borderRadius: 10, padding: '14px 16px', margin: '12px 0', background: '#fbfcfe' },
  cardAccepted: { borderColor: '#bfe3cb', background: '#f4fbf6' },
  cardRejected: { opacity: 0.62 },
  question: { fontSize: 14.5, color: '#1f2430', lineHeight: 1.5, marginBottom: 8 },
  numbers: { display: 'flex', alignItems: 'center', gap: 10, fontSize: 14, marginBottom: 6 },
  issuer: { color: '#8b93a3' }, arrow: { color: '#c2c8d2' }, buyer: { color: '#b26b00' },
  why: { margin: '4px 0 10px', paddingLeft: 18, color: '#5b6472', fontSize: 12.5 },
  rule: { background: '#f0f2f6', borderRadius: 4, padding: '1px 5px', fontSize: 11.5, color: '#3a6df0' },
  actions: { display: 'flex', gap: 8 },
  btn: { borderRadius: 8, padding: '6px 14px', fontSize: 13, cursor: 'pointer', border: '1px solid #dfe3ea' },
  btnGhost: { background: '#fff', color: '#5b6472' },
  btnAcceptOn: { background: '#2f9e57', color: '#fff', borderColor: '#2f9e57' },
  btnRejectOn: { background: '#e7ebf0', color: '#6b7280', borderColor: '#d7dbe2' },
  footer: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 14, paddingTop: 12, borderTop: '1px solid #eef0f3' },
  footerNote: { color: '#8b93a3', fontSize: 12 },
  download: { background: '#1f3864', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 16px', fontSize: 13, cursor: 'pointer', fontWeight: 500 },
};
