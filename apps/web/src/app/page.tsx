'use client';

/* -------------------------------------------------------------------------- */
/* Two-door home (P1) — ported from docs/mockups/cre-two-facing-mockup.jsx     */
/* Home/Door (lines 131-220). Replaces the old dead-redirected landing.        */
/*                                                                            */
/* Each door carries the side onto /pools: Originator → /pools?side=originator,*/
/* B-piece buyer → /pools?side=buyer. Icons are inline SVG (lucide-react is    */
/* not a dependency here — FRONTEND-ONLY, no new packages).                    */
/* -------------------------------------------------------------------------- */

import Link from 'next/link';
import type { ReactNode } from 'react';

/* ---- inline icons (stroke-based, currentColor) ---- */
function IconArrowRight({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}
function IconTable({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 10h18M3 15h18M12 4v16" />
    </svg>
  );
}
function IconShield({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}
function IconScroll({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 4h11a2 2 0 012 2v12M6 4a2 2 0 00-2 2v1a2 2 0 002 2h2M6 4a2 2 0 012 2v11a2 2 0 002 2h7a2 2 0 002-2" />
    </svg>
  );
}

type DoorIcon = (props: { className?: string }) => ReactNode;

function Eyebrow({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`font-mono text-[11px] tracking-[0.14em] uppercase ${className}`}>
      {children}
    </div>
  );
}

/* Side identity → tokens (originator ochre / buyer steel). Explicit strings so
 * Tailwind's JIT keeps the classes; `soft`/`text`/`border` map to the new
 * `originator`/`buyer` scales in tailwind.config.ts. */
const DOORS = [
  {
    href: '/pools?side=originator',
    side: 'Servicer', // display only — the ?side=originator URL param + text-originator theme token are identity (unchanged)
    accentText: 'text-originator',
    accentBorderTop: 'border-t-originator',
    hoverBorder: 'hover:border-originator',
    softBg: 'bg-originator-soft',
    posture: 'Serves two masters — the borrower and the buyer',
    brings: 'ASR · rent roll · appraisal · PCA · operating statement',
    gets: [
      ['Servicer underwriting', 'the package you market the deal with', IconTable],
      ['Analysis page', 'red-flag and diligence coverage', IconShield],
      ['Credit memo', 'how the deal should be structured', IconScroll],
    ] as [string, string, DoorIcon][],
    note: 'Accurate enough to pass a buyer. Accommodating enough to keep the borrower.',
  },
  {
    href: '/pools?side=buyer',
    side: 'B-piece buyer',
    accentText: 'text-buyer',
    accentBorderTop: 'border-t-buyer',
    hoverBorder: 'hover:border-buyer',
    softBg: 'bg-buyer-soft',
    posture: 'Conservative to the T — paid to take first loss',
    brings: 'a submitted deal, or your own document set',
    gets: [
      ['Full workbook', 'the populated quantitative work product', IconTable],
      ['Analysis page', 'stress-tested score and red flags', IconShield],
      ['Credit memo', 'mitigation and restructuring', IconScroll],
    ] as [string, string, DoorIcon][],
    note: 'Skeptical by default. Proceeds-down is a clean lever, not a last resort.',
  },
] as const;

export default function Home() {
  return (
    <div className="max-w-6xl mx-auto px-6 pt-14 pb-10 font-body text-[#16202E]">
      <div className="text-center mb-3">
        <Eyebrow className="text-text-secondary">one deal · two sides · one venue</Eyebrow>
      </div>
      <h1 className="font-display font-bold text-center leading-[1.08] max-w-[720px] mx-auto mt-2 mb-1.5 text-text-primary text-[38px]">
        The same deal reads two ways. Pick your side.
      </h1>
      <p className="text-center text-text-secondary max-w-[560px] mx-auto mb-9 text-[15px]">
        Servicers want to win the borrower and still clear a buyer. Buyers want to be paid for the
        risk. The platform runs both reads off one underwriting — and brings them together in the
        deal room.
      </p>

      <div className="grid md:grid-cols-2 gap-5">
        {DOORS.map((d) => (
          <Link
            key={d.side}
            href={d.href}
            className={`group block text-left w-full bg-white border border-line ${d.hoverBorder}
                        border-t-[3px] ${d.accentBorderTop} rounded-xl p-[22px]
                        transition-[border-color,transform] duration-150 hover:-translate-y-0.5`}
          >
            <div className="flex items-center justify-between">
              <Eyebrow className={d.accentText}>{d.side}</Eyebrow>
              <span className={`w-[26px] h-[26px] rounded-full ${d.softBg} ${d.accentText} flex items-center justify-center`}>
                <IconArrowRight className="w-3.5 h-3.5" />
              </span>
            </div>
            <div className="font-display font-semibold text-[19px] mt-2.5 mb-3.5 text-text-primary">
              {d.posture}
            </div>

            <div className="font-mono text-[11px] text-text-secondary mb-1">BRINGS</div>
            <div className="text-[13px] text-[#16202E] mb-4">{d.brings}</div>

            <div className="font-mono text-[11px] text-text-secondary mb-2">GETS</div>
            <div className="flex flex-col gap-2 mb-3">
              {d.gets.map(([t, desc, Icon]) => (
                <div key={t} className="flex items-start gap-3 bg-paper rounded-lg px-[11px] py-[9px]">
                  <Icon className={`w-4 h-4 mt-px flex-none ${d.accentText}`} />
                  <div>
                    <div className="font-semibold text-[13px] text-text-primary">{t}</div>
                    <div className="text-[12px] text-text-secondary">{desc}</div>
                  </div>
                </div>
              ))}
            </div>
            <div className="text-[12px] text-text-secondary italic border-t border-line pt-2.5">
              {d.note}
            </div>
          </Link>
        ))}
      </div>

      {/* "Skip to the deal room" — routes to /pools (the deals workspace). The
       *  standalone deal-room screen is P3/P4; /pools is the closest live entry. */}
      <div className="mt-5 flex justify-center">
        <Link
          href="/pools"
          className="flex items-center gap-2 font-mono text-[12px] text-ink bg-white border border-line px-4 py-2.5 rounded-lg hover:border-ink/40 transition-colors"
        >
          Skip to the deal room <IconArrowRight className="w-3.5 h-3.5" />
        </Link>
      </div>
    </div>
  );
}
