'use client';

/**
 * FlagDetailModal — the click-to-open "how I determined this" dialog for a red flag.
 * Opens over a dimmed backdrop; closes on X, backdrop-click, or Esc. Shows the flag
 * statement, the reasoning ("how it was determined"), and the sourced evidence — named
 * as TEXT, never clickable-to-open-a-doc. Content comes from the shared buildFlagDetail
 * (identical to the memo's inline <details>). DISPLAY-ONLY.
 */
import { useEffect, useRef } from 'react';
import type { FlagDetail } from '@cre/contracts';

export function FlagDetailModal({ detail, onClose }: { detail: FlagDetail; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    closeRef.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const tierLabel = detail.tier === 'rich' ? 'grounded in the underwriting inputs'
    : detail.tier === 'message' ? 'rule-based determination'
    : 'human / HITL assessment — limited structured evidence';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="How this red flag was determined"
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(15,23,42,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: '#fff', color: '#0f172a', maxWidth: 640, width: '100%', maxHeight: '85vh', overflow: 'auto', borderRadius: 12, boxShadow: '0 20px 60px rgba(0,0,0,0.3)', padding: '20px 24px' }}
      >
        <div style={{ display: 'flex', alignItems: 'start', justifyContent: 'space-between', gap: 16 }}>
          <div>
            <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#64748b', marginBottom: 4 }}>Red flag — how this was determined</div>
            <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0, lineHeight: 1.35 }}>{detail.statement}</h2>
          </div>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Close" style={{ border: 'none', background: 'transparent', fontSize: 22, lineHeight: 1, cursor: 'pointer', color: '#64748b', padding: 4 }}>×</button>
        </div>

        <section style={{ marginTop: 16 }}>
          <h3 style={{ fontSize: 12, fontWeight: 700, color: '#334155', margin: '0 0 4px' }}>How it was determined</h3>
          <p style={{ fontSize: 13, lineHeight: 1.5, margin: 0, color: '#0f172a' }}>{detail.howDetermined}</p>
        </section>

        {detail.evidence.length > 0 ? (
          <section style={{ marginTop: 16 }}>
            <h3 style={{ fontSize: 12, fontWeight: 700, color: '#334155', margin: '0 0 6px' }}>Evidence</h3>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ color: '#64748b', textAlign: 'left' }}>
                  <th style={{ fontWeight: 600, padding: '2px 8px 4px 0' }}>Figure</th>
                  <th style={{ fontWeight: 600, padding: '2px 8px 4px 0' }}>Value</th>
                  <th style={{ fontWeight: 600, padding: '2px 0 4px 0' }}>Source</th>
                </tr>
              </thead>
              <tbody>
                {detail.evidence.map((e, i) => (
                  <tr key={i} style={{ borderTop: '1px solid #f1f5f9' }}>
                    <td style={{ padding: '4px 8px 4px 0', color: '#334155' }}>{e.label}</td>
                    <td style={{ padding: '4px 8px 4px 0', fontWeight: 600 }}>{e.value}</td>
                    <td style={{ padding: '4px 0', color: '#64748b' }}>{e.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : (
          <p style={{ marginTop: 14, fontSize: 12, color: '#64748b', fontStyle: 'italic' }}>No structured evidence was captured for this flag.</p>
        )}

        <p style={{ marginTop: 16, fontSize: 11, color: '#94a3b8' }}>
          {tierLabel}. Source documents are named, not linked; page-level provenance is not captured.
        </p>
      </div>
    </div>
  );
}
