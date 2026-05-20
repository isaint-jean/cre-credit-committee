'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api-client';

export default function LandingPage() {
  const [analyses, setAnalyses] = useState<any[]>([]);

  useEffect(() => {
    api.listAnalyses().then((data) => setAnalyses(data.analyses || [])).catch(() => {});
  }, []);

  return (
    <div className="max-w-5xl mx-auto px-6 py-16">

      {/* ── Hero ── */}
      <div className="mb-20">
        <h1 className="text-4xl font-bold text-text-primary leading-tight mb-3">
          Every deal gets pressure-tested<br />before approval.
        </h1>
        <p className="text-base text-accent font-medium mb-4">
          Used to pressure-test deals before credit committee.
        </p>
        <p className="text-base text-text-secondary max-w-3xl mb-8">
          CRE Credit Committee is the system used to evaluate, challenge, and restructure
          commercial real estate loans before they reach final credit approval.
          This is not an analysis tool. It is a decision system.
        </p>
        <div className="flex items-center gap-4">
          <Link href="/analysis/new" className="btn-primary text-base px-8 py-3 inline-block">
            Upload Deal for Review
          </Link>
          <Link href="#sample-output" className="btn-secondary text-base px-8 py-3 inline-block">
            View Sample Credit Output
          </Link>
        </div>
      </div>

      {/* ── How Deals Actually Get Approved ── */}
      <div className="mb-20">
        <h2 className="text-lg font-semibold text-text-primary mb-4">
          How deals actually get approved
        </h2>
        <p className="text-sm text-text-secondary max-w-3xl mb-6">
          Before a deal is approved, it is challenged, stress tested, re-underwritten, and
          restructured. This platform replicates that process.
        </p>
      </div>

      {/* ── 4-Step Process ── */}
      <div className="mb-20">
        <div className="grid grid-cols-4 gap-4">
          {[
            {
              step: '1',
              title: 'Upload Deal',
              desc: 'ASR + Underwriting',
              icon: (
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
                </svg>
              ),
            },
            {
              step: '2',
              title: 'Pressure Test',
              desc: 'Red flags, cross-checks, external risks',
              icon: (
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                </svg>
              ),
            },
            {
              step: '3',
              title: 'Rebuild & Stress',
              desc: 'Dynamic underwriting + scenarios',
              icon: (
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M11.42 15.17l-5.384-3.1A2.25 2.25 0 014.5 10.09V6.75a2.25 2.25 0 011.536-1.98l5.384-3.1a2.25 2.25 0 012.16 0l5.384 3.1A2.25 2.25 0 0120.5 6.75v3.34a2.25 2.25 0 01-1.536 1.98l-5.384 3.1a2.25 2.25 0 01-2.16 0z" />
                </svg>
              ),
            },
            {
              step: '4',
              title: 'Decide',
              desc: 'Credit score, mitigants, IC-ready output',
              icon: (
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              ),
            },
          ].map((item) => (
            <div key={item.step} className="card text-center">
              <div className="w-10 h-10 mx-auto mb-3 flex items-center justify-center rounded bg-accent/10 text-accent">
                {item.icon}
              </div>
              <div className="text-xs font-mono text-text-muted mb-1">Step {item.step}</div>
              <h3 className="text-sm font-semibold text-text-primary mb-1">{item.title}</h3>
              <p className="text-xs text-text-muted">{item.desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* ── Differentiation ── */}
      <div className="mb-20">
        <h2 className="text-lg font-semibold text-text-primary mb-6">
          Built for credit decisions — not summaries
        </h2>
        <div className="grid grid-cols-2 gap-6">
          <div className="card">
            <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-4">Traditional Tools</h3>
            <ul className="space-y-3 text-sm text-text-muted">
              <li className="flex items-start gap-2">
                <span className="text-text-muted mt-0.5">—</span>
                <span>Summarize documents</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-text-muted mt-0.5">—</span>
                <span>Rely on user interpretation</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-text-muted mt-0.5">—</span>
                <span>No structure</span>
              </li>
            </ul>
          </div>
          <div className="card border-accent/30">
            <h3 className="text-xs font-semibold text-accent uppercase tracking-wider mb-4">CRE Credit Committee</h3>
            <ul className="space-y-3 text-sm text-text-secondary">
              <li className="flex items-start gap-2">
                <span className="text-accent mt-0.5">+</span>
                <span>Identifies risk automatically</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-accent mt-0.5">+</span>
                <span>Rebuilds underwriting</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-accent mt-0.5">+</span>
                <span>Recommends deal structure</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-accent mt-0.5">+</span>
                <span>Produces decision-ready output</span>
              </li>
            </ul>
          </div>
        </div>
      </div>

      {/* ── What You Get ── */}
      <div className="mb-20" id="sample-output">
        <h2 className="text-xs font-semibold text-accent uppercase tracking-wider mb-6">What You Get</h2>
        <div className="grid grid-cols-3 gap-4">
          {[
            { icon: '\u{1F6A8}', title: 'Red Flags', desc: 'With sources and page references' },
            { icon: '\u{1F4CA}', title: 'Rebuilt Underwriting Model', desc: 'Fully recalculated financials' },
            { icon: '\u{1F4C9}', title: 'Stress Test Scenarios', desc: 'Rate, vacancy, and NOI shocks' },
            { icon: '\u{1F6E0}', title: 'Structural Mitigants', desc: 'With numbers and conditions' },
            { icon: '\u{1F4C8}', title: 'Credit Score', desc: 'Fully explained, weighted across categories' },
            { icon: '\u{1F310}', title: 'Market Intelligence', desc: 'Real broker data and market comps' },
          ].map((item, i) => (
            <div key={i} className="card flex items-start gap-3">
              <span className="text-lg shrink-0">{item.icon}</span>
              <div>
                <h3 className="text-sm font-medium text-text-primary">{item.title}</h3>
                <p className="text-xs text-text-muted mt-0.5">{item.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Credibility ── */}
      <div className="mb-20">
        <div className="border-l-2 border-accent/40 pl-6 py-2">
          <p className="text-sm text-text-secondary mb-2">
            Designed to reflect how institutional B-piece buyers evaluate risk.
          </p>
          <p className="text-xs text-text-muted">
            Used by lenders, debt funds, and credit investors.
          </p>
        </div>
      </div>

      {/* ── CTA ── */}
      <div className="flex items-center justify-center gap-4 mb-16">
        <Link href="/analysis/new" className="btn-primary text-base px-8 py-3 inline-block">
          Upload Deal for Review
        </Link>
      </div>

      {/* ── Recent Analyses ── */}
      {analyses.length > 0 && (
        <div>
          <h2 className="text-xs font-semibold text-accent uppercase tracking-wider mb-4">Recent Analyses</h2>
          <div className="space-y-2">
            {analyses.map((a) => (
              <Link
                key={a.id}
                href={`/analysis/${a.id}`}
                className="card flex items-center justify-between hover:border-accent/50 transition-colors"
              >
                <div>
                  <span className="text-sm font-medium text-text-primary">{a.name}</span>
                  <span className="text-xs text-text-muted ml-3">{a.assetType}</span>
                </div>
                <div className="flex items-center gap-4">
                  {a.creditScore !== null && (
                    /* Color sourced from server-emitted a.riskTier — no client-side threshold. */
                    <span className={`text-sm font-mono font-bold text-score-${a.riskTier ?? 'high_risk'}`}>
                      {a.creditScore}/100
                    </span>
                  )}
                  <span className={`badge ${
                    a.status === 'complete' ? 'badge-pass' :
                    a.status === 'error' ? 'badge-fail' :
                    'badge-unknown'
                  }`}>
                    {a.status}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
