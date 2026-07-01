import React, { useState, useEffect } from "react";
import {
  ArrowRight, FileText, Table2, ScrollText, ShieldCheck,
  Landmark, Scale, Check, AlertTriangle, RotateCcw, ChevronRight, Dot,
  Phone, MessageSquare, Send, Building2, Layers, Flag, XCircle, CheckCircle2, Upload,
} from "lucide-react";

/* ---- design tokens (warm originator vs cool buyer) ---- */
const C = {
  ink: "#111A26", inkSoft: "#1B2838", inkLine: "rgba(255,255,255,0.10)",
  paper: "#EEF1F4", card: "#FFFFFF", line: "#D3DAE2", text: "#16202E", sub: "#5C6B7E",
  ochre: "#A8742A", ochreSoft: "#F4EAD6",
  steel: "#2F5E86", steelSoft: "#E0E9F1",
  cleared: "#2E7D57", clearedSoft: "#E2F0E8",
  warn: "#B5532B", warnSoft: "#F3E2DB",
};
const DISP = "'Space Grotesk', sans-serif";
const BODY = "'Inter', sans-serif";
const MONO = "'IBM Plex Mono', monospace";

const SCORE_BASE = 58;
const SCORE_THRESHOLD = 80;

/* structural levers carry a red flag (1:1); proceeds is the last-resort economic lever (no flag) */
const LEVERS = [
  { id: "reserve", name: "Lease-up reserve", icon: Landmark, weight: 7,
    flag: "Lease-up carry unfunded",
    orig: "Minimal reserve", buyer: "$4.2M lease-up reserve",
    why: "Preserves the borrower's cash at closing", buyerWhy: "Funds carry the asset through stabilization" },
  { id: "cash", name: "Cash management", icon: Scale, weight: 5,
    flag: "No cash trap if lease-up stalls",
    orig: "No lockbox", buyer: "Springing lockbox < 70% occ",
    why: "Borrower keeps control of cash flow", buyerWhy: "Traps cash if lease-up stalls" },
  { id: "guaranty", name: "Recourse / guaranty", icon: ShieldCheck, weight: 6,
    flag: "Non-recourse on a transitional asset",
    orig: "Non-recourse", buyer: "Springing recourse on milestones",
    why: "Standard ask to win the borrower", buyerWhy: "Recourse triggers if lease-up misses" },
  { id: "amort", name: "Amortization", icon: ScrollText, weight: 4,
    flag: "Full-term IO — no deleveraging",
    orig: "Full-term interest-only", buyer: "Amortize after stabilization",
    why: "Maximizes borrower cash flow", buyerWhy: "Builds equity once stabilized" },
  { id: "cp", name: "Conditions precedent", icon: FileText, weight: 5,
    flag: "GSA anchor unverified",
    orig: "None at close", buyer: "GSA estoppel + lease-up evidence",
    why: "Faster close for the borrower", buyerWhy: "Verifies the anchor before funding" },
  { id: "proceeds", name: "Loan proceeds", icon: Landmark, weight: 6, lastResort: true,
    orig: "$82.46M (full request)", buyer: "$78.0M (lease-up haircut)",
    why: "The borrower's whole reason to choose this lender", buyerWhy: "De-risks by lowering basis" },
];
const STRUCTURAL = LEVERS.filter((l) => !l.lastResort);

const SEED_MESSAGES = [
  { id: 1, side: "buyer", lever: "proceeds",
    text: "At 46.8% leased we need basis protection — either a real lease-up reserve or a proceeds haircut." },
  { id: 2, side: "originator", lever: "reserve",
    text: "We'll fund the $4.2M reserve and add springing recourse. Let's keep proceeds whole — that's why the borrower picked us." },
  { id: 3, side: "buyer", lever: "cp",
    text: "Works if the GSA estoppel is a CP. Can we get on a call to settle the recourse language?" },
];

const REJECT_REASONS = [
  { id: "disqualifying", label: "Disqualifying", hint: "Sponsor character / fatal credit" },
  { id: "couldnt_structure", label: "Couldn't structure", hint: "Economics won't pencil even maxing levers" },
  { id: "expired", label: "Expired", hint: "Missed the pool cutoff / ran out of time" },
  { id: "withdrawn", label: "Withdrawn", hint: "Borrower took a competing term sheet" },
];

const DEALS = [
  {
    id: "bmark-v8", name: "BMARK 2024-V8", shelf: "Benchmark · conduit",
    balance: "$1.02B", count: 41, vintage: "2024", wac: "6.41%", ready: true,
    loans: [
      { n: 22, name: "Sunroad Centrum", type: "Office", loc: "San Diego, CA", bal: "$82.46M", occ: "46.8%", status: "Lease-up", ready: true },
      { n: 3,  name: "Crossroads Logistics", type: "Industrial", loc: "Phoenix, AZ", bal: "$61.0M", occ: "100%", status: "Stabilized", ready: false },
      { n: 8,  name: "Vista Marketplace", type: "Retail", loc: "Vista, CA", bal: "$44.2M", occ: "95%", status: "Stabilized", ready: false },
      { n: 11, name: "Peachtree Office Tower", type: "Office", loc: "Atlanta, GA", bal: "$88.0M", occ: "71%",
        disposition: { outcome: "withdrawn", reason: "Withdrawn", ref: "Recourse / guaranty", by: "Originator",
          detail: "Borrower took a competing term sheet — our recourse ask was heavier than the competing lender's." } },
      { n: 17, name: "Bayfront Tower", type: "Office", loc: "Tampa, FL", bal: "$103.5M", occ: "79%", status: "Stabilized", ready: false },
      { n: 29, name: "Desert Ridge Retail", type: "Retail", loc: "Mesa, AZ", bal: "$46.0M", occ: "83%",
        disposition: { outcome: "disqualifying", reason: "Disqualifying", ref: "Sponsor background", by: "Buyer",
          detail: "Undisclosed sponsor litigation + a prior CMBS default surfaced in background review. No structure cures it." } },
      { n: 31, name: "Harborview Storage", type: "Self-storage", loc: "Long Beach, CA", bal: "$22.4M", occ: "91%", status: "Stabilized", ready: false },
    ],
  },
  {
    id: "bank-48", name: "BANK 2024-BNK48", shelf: "BANK · conduit",
    balance: "$880M", count: 38, vintage: "2024", wac: "6.55%", ready: false,
    loans: [
      { n: 5,  name: "Northgate Commons", type: "Retail", loc: "Seattle, WA", bal: "$67.0M", occ: "88%", status: "Stabilized", ready: false },
      { n: 12, name: "Apex Distribution", type: "Industrial", loc: "Memphis, TN", bal: "$74.3M", occ: "100%", status: "Stabilized", ready: false },
    ],
  },
  {
    id: "bbcms-5c30", name: "BBCMS 2024-5C30", shelf: "BBCMS · conduit",
    balance: "$760M", count: 33, vintage: "2024", wac: "6.62%", ready: false,
    loans: [
      { n: 2,  name: "Lincoln Park Plaza", type: "Mixed-use", loc: "Chicago, IL", bal: "$91.0M", occ: "85%", status: "Stabilized", ready: false },
      { n: 19, name: "Sunbelt Portfolio", type: "Self-storage", loc: "Atlanta, GA", bal: "$38.5M", occ: "90%", status: "Stabilized", ready: false },
    ],
  },
];

const WS = {
  originator: {
    accent: C.ochre, soft: C.ochreSoft, label: "Originator", posture: "You serve two masters.",
    sub: "Win the borrower with flexible terms — and still hand a buyer something they'll respect.",
    deliverables: [
      [Table2, "Seller underwriting", "The package you take to market — same facts, presented to clear a buyer."],
      [ShieldCheck, "Analysis page", "Red flags surfaced before a buyer finds them."],
      [ScrollText, "Credit memo", "Reads as guidance, not repair.", "“How the deal should be structured”"],
    ],
    note: "Structure first — reserves, recourse, cash management. Proceeds-down stays a last resort.",
  },
  buyer: {
    accent: C.steel, soft: C.steelSoft, label: "B-piece buyer", posture: "Conservative to the T.",
    sub: "You take first loss, so you read the deal skeptically. The workbook replaces the special servicer's quantitative work.",
    deliverables: [
      [Table2, "Full workbook", "The populated model — your quantitative work product."],
      [ShieldCheck, "Analysis page", "Stress-tested score, red flags, the lease-up risk front and center."],
      [ScrollText, "Credit memo", "What it takes to make first-loss acceptable.", "“Mitigation & restructuring”"],
    ],
    note: "Same seven levers as the originator — read cold. Here, lowering proceeds is just a clean way to cut basis.",
  },
};

/* ---- intake completeness: field-driven, mapped to honest-ceiling states ---- */
const FIELDS = [
  { id: "value", name: "As-is appraised value", blocks: "Value, LTV", source: "the appraisal", state: "populated" },
  { id: "noi", name: "In-place NOI", blocks: "DSCR, debt yield", source: "the operating statement", state: "populated" },
  { id: "proforma", name: "Stabilized pro-forma NOI", blocks: "stabilized metrics", source: "the appraisal / ASR", state: "populated" },
  { id: "gpr", name: "Gross potential rent", blocks: "the income build", source: "the rent roll", state: "populated" },
  { id: "pca", name: "Immediate repairs", blocks: "reserve sizing", source: "the PCA", state: "populated" },
  { id: "caprate", name: "Cap-rate basis (as-is vs stabilized)", blocks: "cap-rate comparison to comps", source: "the appraisal's income approach", state: "in_pdf" },
  { id: "gsa", name: "GSA lease expiration & renewal terms", blocks: "anchor rollover analysis", source: "the leases or appraisal", state: "in_pdf" },
  { id: "environ", name: "Environmental status", blocks: "the environmental risk line", source: "a Phase I ESA — not provided", state: "not_in_doc" },
  { id: "sponsor", name: "Sponsor net worth & liquidity", blocks: "recourse / guaranty analysis", source: "a sponsor PFS / REO schedule — not provided", state: "not_in_doc" },
  { id: "reserves", name: "Final underwritten reserves", blocks: "—", source: "the underwriter's call — set in the deal room", state: "decision" },
];
const FSTATE = {
  populated: { label: "sourced", color: C.cleared, bg: C.clearedSoft, icon: Check },
  in_pdf: { label: "in a doc — confirm", color: C.ochre, bg: C.ochreSoft, icon: AlertTriangle },
  not_in_doc: { label: "no source yet", color: C.warn, bg: C.warnSoft, icon: Flag },
  decision: { label: "your call", color: C.sub, bg: C.paper, icon: Dot },
};

/* ---- status helpers ---- */
function computeActiveStatus({ disposition, fatalRaised, allCleared }) {
  if (disposition) {
    if (disposition.outcome === "closed") return { key: "closed", label: "Closed" };
    if (disposition.outcome === "expired") return { key: "expired", label: "Expired", ...disposition };
    return { key: "rejected", label: disposition.reason, ...disposition };
  }
  if (fatalRaised) return { key: "blocked", label: "Action needed" };
  if (allCleared) return { key: "cleared", label: "Cleared" };
  return { key: "negotiation", label: "In negotiation" };
}
function statusForLoan(loan, activeName, activeStatus) {
  if (activeName && loan.name === activeName && activeStatus) return activeStatus;
  if (loan.disposition) {
    const o = loan.disposition.outcome;
    if (o === "closed") return { key: "closed", label: "Closed" };
    if (o === "expired") return { key: "expired", label: "Expired", ...loan.disposition };
    return { key: "rejected", label: loan.disposition.reason, ...loan.disposition };
  }
  if (loan.ready) return { key: "negotiation", label: "In negotiation" };
  return { key: "awaiting", label: "Awaiting docs" };
}
const CHIP = {
  negotiation: [C.ochre, C.ochreSoft], cleared: [C.steel, C.steelSoft],
  closed: [C.cleared, C.clearedSoft], rejected: [C.warn, C.warnSoft],
  expired: [C.sub, C.paper], awaiting: [C.sub, C.paper], blocked: [C.warn, C.warnSoft],
};
function StatusChip({ status, dark }) {
  const [fg, bg] = CHIP[status.key] || [C.sub, C.paper];
  return (
    <span style={{ fontFamily: MONO, fontSize: 10, color: fg, background: dark ? "transparent" : bg, border: dark ? `1px solid ${fg}` : "none", borderRadius: 5, padding: "2px 8px", whiteSpace: "nowrap" }}>
      {status.label}
    </span>
  );
}

export default function App() {
  const [screen, setScreen] = useState("home");
  const [side, setSide] = useState(null);
  const [deal, setDeal] = useState(null);
  const [loan, setLoan] = useState(null);
  const [resolved, setResolved] = useState({});
  const [fatalRaised, setFatalRaised] = useState(false);
  const [disposition, setDisposition] = useState(null);

  useEffect(() => {
    const l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap";
    document.head.appendChild(l);
    return () => { document.head.removeChild(l); };
  }, []);

  const pickSide = (s) => { setSide(s); setDeal(null); setLoan(null); setScreen("deals"); };
  const pickDeal = (d) => { setDeal(d); setLoan(null); setScreen("loans"); };
  const pickLoan = (l) => { setLoan(l); setScreen("workspace"); };
  const nav = (t) => { if (t === "home") { setSide(null); setDeal(null); setLoan(null); setScreen("home"); } else setScreen(t); };
  const jumpDealRoom = () => { const d = DEALS[0]; setSide("buyer"); setDeal(d); setLoan(d.loans[0]); setScreen("dealroom"); };

  const openFlags = STRUCTURAL.filter((l) => !resolved[l.id]).length;
  const allCleared = openFlags === 0 && !fatalRaised;
  const proceedsCut = !!resolved["proceeds"];
  const score = SCORE_BASE
    + STRUCTURAL.reduce((a, l) => a + (resolved[l.id] ? l.weight : 0), 0)
    + (proceedsCut ? 6 : 0);
  const activeStatus = computeActiveStatus({ disposition, fatalRaised, allCleared });
  const accent = side === "buyer" ? C.steel : C.ochre;

  return (
    <div style={{ background: C.paper, color: C.text, fontFamily: BODY, minHeight: "100vh" }}>
      <TopBar screen={screen} side={side} deal={deal} loan={loan} nav={nav} />
      {screen === "home" && <Home pickSide={pickSide} jumpDealRoom={jumpDealRoom} />}
      {screen === "deals" && <DealsScreen side={side} accent={accent} onPick={pickDeal} />}
      {screen === "loans" && <LoansScreen deal={deal} side={side} accent={accent} onPick={pickLoan} activeStatus={activeStatus} />}
      {screen === "workspace" && <WorkspaceScreen side={side} deal={deal} loan={loan} onDealRoom={() => setScreen("dealroom")} />}
      {screen === "dealroom" && (
        <DealRoom
          loan={loan} resolved={resolved} setResolved={setResolved}
          score={score} openFlags={openFlags} allCleared={allCleared} proceedsCut={proceedsCut}
          fatalRaised={fatalRaised} setFatalRaised={setFatalRaised}
          disposition={disposition} setDisposition={setDisposition} status={activeStatus}
          resetAll={() => { setResolved({}); setFatalRaised(false); setDisposition(null); }}
        />
      )}
    </div>
  );
}

/* ----------------------------- chrome ----------------------------- */
function TopBar({ screen, side, deal, loan, nav }) {
  const crumbs = [{ label: "Home", go: () => nav("home") }];
  if (side) crumbs.push({ label: side === "buyer" ? "B-piece buyer" : "Originator", go: () => nav("deals") });
  if (deal) crumbs.push({ label: deal.name, go: () => nav("loans") });
  if (loan) crumbs.push({ label: loan.name, go: () => nav("workspace") });
  if (screen === "dealroom") crumbs.push({ label: "Deal room", go: () => nav("dealroom") });
  return (
    <div style={{ background: C.ink, borderBottom: `1px solid ${C.inkLine}` }}>
      <div className="flex items-center justify-between px-6 py-3 max-w-6xl mx-auto gap-4">
        <button onClick={() => nav("home")} className="flex items-center gap-3 text-left shrink-0">
          <div style={{ width: 22, height: 22, borderRadius: 5, background: `linear-gradient(135deg, ${C.ochre} 0 50%, ${C.steel} 50% 100%)` }} />
          <div>
            <div style={{ fontFamily: DISP, fontWeight: 700, letterSpacing: "0.02em", color: "#fff", fontSize: 14, lineHeight: 1 }}>CRE CREDIT COMMITTEE</div>
            <div style={{ fontFamily: MONO, fontSize: 10, color: "rgba(255,255,255,0.45)", marginTop: 3 }}>the credit committee, as software</div>
          </div>
        </button>
        <div className="flex items-center gap-1 flex-wrap justify-end" style={{ fontFamily: MONO, fontSize: 11 }}>
          {crumbs.map((c, i) => {
            const last = i === crumbs.length - 1;
            return (
              <span key={i} className="flex items-center gap-1">
                {i > 0 && <ChevronRight size={11} style={{ color: "rgba(255,255,255,0.3)" }} />}
                <button onClick={c.go} disabled={last}
                  style={{ color: last ? "#fff" : "rgba(255,255,255,0.5)", background: "none", border: "none", cursor: last ? "default" : "pointer", padding: "2px 0" }}>
                  {c.label}
                </button>
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Eyebrow({ children, color }) {
  return <div style={{ fontFamily: MONO, fontSize: 11, letterSpacing: "0.14em", textTransform: "uppercase", color: color || C.sub }}>{children}</div>;
}

/* ------------------------------ home ------------------------------ */
function Home({ pickSide, jumpDealRoom }) {
  return (
    <div className="max-w-6xl mx-auto px-6 pt-14 pb-10">
      <div className="text-center mb-3"><Eyebrow color={C.sub}>one deal · two sides · one venue</Eyebrow></div>
      <h1 style={{ fontFamily: DISP, fontWeight: 700, fontSize: 38, lineHeight: 1.08, textAlign: "center", maxWidth: 720, margin: "8px auto 6px" }}>
        The same deal reads two ways. Pick your side.
      </h1>
      <p style={{ textAlign: "center", color: C.sub, maxWidth: 560, margin: "0 auto 36px", fontSize: 15 }}>
        Originators want to win the borrower and still clear a buyer. Buyers want to be paid for the risk.
        The platform runs both reads off one underwriting — and brings them together in the deal room.
      </p>
      <div className="grid md:grid-cols-2 gap-5">
        <Door side="Originator" accent={C.ochre} soft={C.ochreSoft}
          posture="Serves two masters — the borrower and the buyer"
          brings="ASR · rent roll · appraisal · PCA · operating statement"
          gets={[["Seller underwriting", "the package you market the deal with", Table2], ["Analysis page", "red-flag and diligence coverage", ShieldCheck], ["Credit memo", "how the deal should be structured", ScrollText]]}
          note="Accurate enough to pass a buyer. Accommodating enough to keep the borrower."
          onEnter={() => pickSide("originator")} />
        <Door side="B-piece buyer" accent={C.steel} soft={C.steelSoft}
          posture="Conservative to the T — paid to take first loss"
          brings="a submitted deal, or your own document set"
          gets={[["Full workbook", "the populated quantitative work product", Table2], ["Analysis page", "stress-tested score and red flags", ShieldCheck], ["Credit memo", "mitigation and restructuring", ScrollText]]}
          note="Skeptical by default. Proceeds-down is a clean lever, not a last resort."
          onEnter={() => pickSide("buyer")} />
      </div>
      <div className="mt-5 flex justify-center">
        <button onClick={jumpDealRoom}
          style={{ fontFamily: MONO, fontSize: 12, color: C.ink, background: "#fff", border: `1px solid ${C.line}`, padding: "10px 16px", borderRadius: 8 }}
          className="flex items-center gap-2">
          Jump to a live deal room (Sunroad) <ArrowRight size={14} />
        </button>
      </div>
    </div>
  );
}

function Door({ side, accent, soft, posture, brings, gets, note, onEnter }) {
  const [hover, setHover] = useState(false);
  return (
    <button onClick={onEnter} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} className="text-left w-full"
      style={{ background: C.card, border: `1px solid ${hover ? accent : C.line}`, borderTop: `3px solid ${accent}`, borderRadius: 12, padding: 22, transition: "border-color .15s, transform .15s", transform: hover ? "translateY(-2px)" : "none" }}>
      <div className="flex items-center justify-between">
        <Eyebrow color={accent}>{side}</Eyebrow>
        <span style={{ width: 26, height: 26, borderRadius: 999, background: soft, color: accent }} className="flex items-center justify-center"><ArrowRight size={14} /></span>
      </div>
      <div style={{ fontFamily: DISP, fontWeight: 600, fontSize: 19, marginTop: 10, marginBottom: 14 }}>{posture}</div>
      <div style={{ fontFamily: MONO, fontSize: 11, color: C.sub, marginBottom: 4 }}>BRINGS</div>
      <div style={{ fontSize: 13, color: C.text, marginBottom: 16 }}>{brings}</div>
      <div style={{ fontFamily: MONO, fontSize: 11, color: C.sub, marginBottom: 8 }}>GETS</div>
      <div className="flex flex-col gap-2 mb-3">
        {gets.map(([t, d, Icon]) => (
          <div key={t} className="flex items-start gap-3" style={{ background: C.paper, borderRadius: 8, padding: "9px 11px" }}>
            <Icon size={16} style={{ color: accent, marginTop: 1 }} />
            <div><div style={{ fontWeight: 600, fontSize: 13 }}>{t}</div><div style={{ fontSize: 12, color: C.sub }}>{d}</div></div>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 12, color: C.sub, fontStyle: "italic", borderTop: `1px solid ${C.line}`, paddingTop: 10 }}>{note}</div>
    </button>
  );
}

/* --------------------------- deal picker --------------------------- */
function DealsScreen({ side, accent, onPick }) {
  const label = side === "buyer" ? "B-piece buyer" : "Originator";
  return (
    <div className="max-w-6xl mx-auto px-6 py-10">
      <Eyebrow color={accent}>{label} · choose a deal</Eyebrow>
      <h1 style={{ fontFamily: DISP, fontWeight: 700, fontSize: 28, margin: "8px 0 4px" }}>Which pool are you working?</h1>
      <p style={{ color: C.sub, fontSize: 14, maxWidth: 560 }}>A deal is a securitization pool. Pick one to open its loan tape, then drill into a loan.</p>
      <div className="grid md:grid-cols-3 gap-4 mt-8">
        {DEALS.map((d) => (
          <button key={d.id} onClick={() => onPick(d)} className="text-left"
            style={{ background: C.card, border: `1px solid ${C.line}`, borderTop: `3px solid ${accent}`, borderRadius: 12, padding: 18 }}>
            <div className="flex items-center justify-between mb-3">
              <Eyebrow color={accent}>{d.shelf}</Eyebrow>
              <span style={{ fontFamily: MONO, fontSize: 9.5, color: d.ready ? C.cleared : C.sub, background: d.ready ? C.clearedSoft : C.paper, borderRadius: 5, padding: "2px 7px" }}>{d.ready ? "wired" : "sample"}</span>
            </div>
            <div className="flex items-center gap-2 mb-3"><Building2 size={18} style={{ color: accent }} /><span style={{ fontFamily: DISP, fontWeight: 600, fontSize: 18 }}>{d.name}</span></div>
            <div className="grid grid-cols-2 gap-y-2 gap-x-3" style={{ fontFamily: MONO, fontSize: 12 }}>
              <Stat k="Balance" v={d.balance} /><Stat k="Loans" v={String(d.count)} /><Stat k="Vintage" v={d.vintage} /><Stat k="WAC" v={d.wac} />
            </div>
            <div className="flex items-center gap-1 mt-4" style={{ fontFamily: MONO, fontSize: 11, color: accent }}>Open loan tape <ChevronRight size={13} /></div>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ---------------------------- loan tape ---------------------------- */
function LoansScreen({ deal, side, accent, onPick, activeStatus }) {
  const label = side === "buyer" ? "B-piece buyer" : "Originator";
  const [view, setView] = useState("all");
  const activeName = deal.id === "bmark-v8" ? "Sunroad Centrum" : null;
  const rows = deal.loans.map((l) => ({ l, s: statusForLoan(l, activeName, activeStatus) }));
  const filtered = view === "final" ? rows.filter((r) => r.s.key === "closed")
    : view === "disp" ? rows.filter((r) => r.s.key === "rejected" || r.s.key === "expired")
    : rows;

  return (
    <div className="max-w-6xl mx-auto px-6 py-10">
      <Eyebrow color={accent}>{label} · {deal.name}</Eyebrow>
      <div style={{ background: C.card, border: `1px solid ${C.line}`, borderTop: `3px solid ${accent}`, borderRadius: 12, padding: 20, marginTop: 8 }}>
        <div className="flex items-center gap-2 mb-1"><Layers size={18} style={{ color: accent }} /><span style={{ fontFamily: DISP, fontWeight: 700, fontSize: 22 }}>{deal.name}</span></div>
        <div style={{ fontSize: 13, color: C.sub, marginBottom: 14 }}>{deal.shelf} · {deal.vintage}</div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3" style={{ fontFamily: MONO, fontSize: 13 }}>
          <Stat k="Pool balance" v={deal.balance} /><Stat k="Loan count" v={String(deal.count)} /><Stat k="Vintage" v={deal.vintage} /><Stat k="WAC" v={deal.wac} />
        </div>
      </div>

      <div className="flex items-center gap-2 mt-6 mb-3">
        {[["all", "All loans"], ["final", "Final tape"], ["disp", "Dispositions"]].map(([k, t]) => (
          <button key={k} onClick={() => setView(k)}
            style={{ fontFamily: MONO, fontSize: 11.5, padding: "6px 12px", borderRadius: 7,
              color: view === k ? "#fff" : C.sub, background: view === k ? C.ink : "#fff", border: `1px solid ${view === k ? C.ink : C.line}` }}>
            {t}
          </button>
        ))}
        <span style={{ fontFamily: MONO, fontSize: 11, color: C.sub, marginLeft: "auto" }}>
          {view === "final" ? "closed loans only — the securitized set" : view === "disp" ? "why loans didn't close — visible to both sides" : `${deal.loans.length} of ${deal.count} shown`}
        </span>
      </div>

      {filtered.length === 0 ? (
        <div style={{ background: C.card, border: `1px dashed ${C.line}`, borderRadius: 12, padding: 34, textAlign: "center", color: C.sub, fontSize: 13.5 }}>
          {view === "final" ? "No loans have closed into the final tape yet. Clear a deal and close it to populate this." : "No dispositions logged yet."}
        </div>
      ) : view === "disp" ? (
        <div className="flex flex-col gap-2.5">
          {filtered.map(({ l, s }) => (
            <div key={l.n} style={{ background: C.card, border: `1px solid ${C.line}`, borderLeft: `3px solid ${C.warn}`, borderRadius: 10, padding: 16 }}>
              <div className="flex items-center gap-2 flex-wrap mb-1">
                <span style={{ fontFamily: MONO, fontSize: 12, color: C.sub }}>#{l.n}</span>
                <span style={{ fontWeight: 600, fontSize: 14 }}>{l.name}</span>
                <StatusChip status={s} />
                {(l.disposition?.by || s.by) && <span style={{ fontFamily: MONO, fontSize: 10, color: C.sub }}>called by {l.disposition?.by || s.by}</span>}
              </div>
              <div style={{ fontFamily: MONO, fontSize: 11, color: C.sub, marginBottom: 6 }}>{l.type} · {l.loc} · {l.bal}</div>
              <div style={{ fontSize: 13, color: C.text }}>{l.disposition?.detail || s.detail}</div>
              {(l.disposition?.ref || s.ref) && <div style={{ fontFamily: MONO, fontSize: 11, color: C.warn, marginTop: 6 }}>linked to: {l.disposition?.ref || s.ref}</div>}
            </div>
          ))}
        </div>
      ) : (
        <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, overflow: "hidden" }}>
          {filtered.map(({ l, s }, i) => (
            <button key={l.n} onClick={() => onPick(l)} className="w-full flex items-center gap-3 text-left"
              style={{ padding: "13px 16px", borderTop: i === 0 ? "none" : `1px solid ${C.line}`, background: l.ready ? "#FBFCFD" : "#fff" }}>
              <span style={{ fontFamily: MONO, fontSize: 12, color: C.sub, width: 28 }}>#{l.n}</span>
              <div className="flex-1 min-w-0">
                <div style={{ fontWeight: 600, fontSize: 14 }}>{l.name}</div>
                <div style={{ fontFamily: MONO, fontSize: 11, color: C.sub }}>{l.type} · {l.loc}</div>
              </div>
              <span className="hidden md:inline" style={{ fontFamily: MONO, fontSize: 12, width: 80, textAlign: "right" }}>{l.bal}</span>
              <span className="hidden md:inline" style={{ fontFamily: MONO, fontSize: 12, color: C.sub, width: 56, textAlign: "right" }}>{l.occ}</span>
              <StatusChip status={s} />
              <ChevronRight size={15} style={{ color: C.sub }} />
            </button>
          ))}
        </div>
      )}
      {view === "all" && <div style={{ fontFamily: MONO, fontSize: 11, color: C.sub, marginTop: 10 }}>Illustrative tape — Sunroad Centrum is the loan wired with real data.</div>}
    </div>
  );
}

function Stat({ k, v }) {
  return <div><div style={{ color: C.sub, fontSize: 10.5 }}>{k.toUpperCase()}</div><div style={{ fontWeight: 600 }}>{v}</div></div>;
}

/* --------------------------- loan workspace --------------------------- */
function WorkspaceScreen({ side, deal, loan, onDealRoom }) {
  const cfg = WS[side] || WS.originator;
  const a = cfg.accent;
  const [envAdded, setEnvAdded] = useState(false);
  const docCount = envAdded ? 6 : 5;
  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      <div style={{ background: C.card, border: `1px solid ${C.line}`, borderTop: `3px solid ${a}`, borderRadius: 12, padding: 22, marginBottom: 18 }}>
        <Eyebrow color={a}>{cfg.label} workspace · {deal.name} · #{loan.n}</Eyebrow>
        <h2 style={{ fontFamily: DISP, fontWeight: 700, fontSize: 26, margin: "6px 0 4px" }}>{loan.name}</h2>
        <div style={{ fontFamily: MONO, fontSize: 12.5, color: C.sub, marginBottom: 6 }}>{loan.type} · {loan.loc}</div>
        <div className="flex flex-wrap gap-x-6 gap-y-1" style={{ fontFamily: MONO, fontSize: 12.5 }}>
          <span><span style={{ color: C.sub }}>Loan </span>{loan.bal}</span>
          <span><span style={{ color: C.sub }}>Occ </span>{loan.occ}</span>
          <span><span style={{ color: C.sub }}>Status </span>{loan.status || "—"}</span>
        </div>
        <div style={{ fontSize: 13.5, color: C.sub, marginTop: 10, maxWidth: 640 }}>{cfg.posture} — {cfg.sub}</div>
      </div>

      {loan.ready ? (
        <>
          <div className="grid md:grid-cols-2 gap-5">
            <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, padding: 20 }}>
              <div className="flex items-center justify-between">
                <Eyebrow color={a}>Document intake</Eyebrow>
                <span style={{ fontFamily: MONO, fontSize: 11, color: C.sub }}>{docCount} of 6</span>
              </div>
              <div className="mt-3">
                {["ASR (appraisal summary report)", "Rent roll", "Operating statement", "Appraisal", "PCA"].map((d) => <DocRow key={d} label={d} on accent={a} />)}
                <DocRow label="Environmental / other" on={envAdded} accent={a} />
              </div>
              <button onClick={() => setEnvAdded(true)}
                style={{ width: "100%", fontFamily: MONO, fontSize: 12, color: a, background: "#fff", border: `1px dashed ${a}`, borderRadius: 9, padding: "11px 12px", marginTop: 12, cursor: "pointer" }}
                className="flex items-center justify-center gap-2">
                <Upload size={14} /> Add documents
              </button>
              <div style={{ fontFamily: MONO, fontSize: 11, color: C.sub, marginTop: 10 }}>
                {envAdded ? "6 of 6 in — full document set" : "5 of 6 in — environmental optional for this asset"}
              </div>
            </div>
            <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, padding: 20 }}>
              <Eyebrow color={a}>Your deliverables</Eyebrow>
              <div className="mt-3">
                {cfg.deliverables.map(([Icon, title, desc, frame]) => <Deliverable key={title} icon={Icon} accent={a} title={title} desc={desc} frame={frame} />)}
              </div>
              <div style={{ fontSize: 12.5, color: C.sub, fontStyle: "italic", borderTop: `1px solid ${C.line}`, paddingTop: 10, marginTop: 4 }}>{cfg.note}</div>
            </div>
          </div>
          <WorkbookReadiness side={side} />
          <div className="mt-5 flex justify-end">
            <button onClick={onDealRoom} style={{ fontFamily: MONO, fontSize: 13, color: "#fff", background: a, padding: "11px 18px", borderRadius: 9 }} className="flex items-center gap-2">
              {side === "buyer" ? "Open deal room" : "Submit to buyers"} <ArrowRight size={15} />
            </button>
          </div>
        </>
      ) : (
        <div style={{ background: C.card, border: `1px dashed ${C.line}`, borderRadius: 12, padding: 40, textAlign: "center" }}>
          <FileText size={26} style={{ color: C.sub, margin: "0 auto 10px" }} />
          <div style={{ fontFamily: DISP, fontWeight: 600, fontSize: 17, marginBottom: 6 }}>No documents uploaded for this loan yet</div>
          <div style={{ fontSize: 13.5, color: C.sub, maxWidth: 440, margin: "0 auto" }}>
            Intake gates the workspace — once the ASR, rent roll, and operating statement land, the analysis and deliverables populate. This loan isn't wired in the demo; open Sunroad Centrum to see a populated workspace.
          </div>
        </div>
      )}
    </div>
  );
}

function WorkbookReadiness({ side }) {
  const [generated, setGenerated] = useState(false);
  const data = FIELDS.filter((f) => f.state !== "decision");
  const sourced = data.filter((f) => f.state === "populated").length;
  const pct = Math.round((sourced / data.length) * 100);
  const needs = FIELDS.filter((f) => f.state === "in_pdf" || f.state === "not_in_doc");
  const decisions = FIELDS.filter((f) => f.state === "decision");
  const ctaLabel = side === "buyer" ? "Create workbook" : "Generate seller underwriting";
  return (
    <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, padding: 20, marginTop: 18 }}>
      <div className="flex items-start justify-between flex-wrap gap-3 mb-4">
        <div>
          <Eyebrow color={C.text}>Workbook readiness</Eyebrow>
          <div style={{ fontSize: 12.5, color: C.sub, marginTop: 4, maxWidth: 520 }}>
            Nothing here blocks you — the workbook builds at any completeness, fills what it can, and marks the rest. Prompts ask for the missing <em>fact</em>, not a document.
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div style={{ textAlign: "right" }}>
            <div style={{ fontFamily: MONO, fontSize: 11, color: C.sub }}>{sourced} / {data.length} data points sourced</div>
            <div style={{ width: 140, height: 6, borderRadius: 999, background: C.paper, overflow: "hidden", marginTop: 4 }}>
              <div style={{ width: `${pct}%`, height: "100%", background: pct === 100 ? C.cleared : C.ochre }} />
            </div>
          </div>
          <button onClick={() => setGenerated(true)}
            style={{ fontFamily: MONO, fontSize: 12.5, color: "#fff", background: C.ink, border: "none", borderRadius: 9, padding: "10px 16px", cursor: "pointer" }}
            className="flex items-center gap-2">
            <Table2 size={15} /> {ctaLabel}
          </button>
        </div>
      </div>

      {generated && (
        <div style={{ background: C.paper, border: `1px solid ${C.line}`, borderRadius: 9, padding: "11px 13px", marginBottom: 14 }}>
          <div className="flex items-center gap-2" style={{ fontFamily: MONO, fontSize: 12, color: C.cleared }}>
            <Check size={14} /> {side === "buyer" ? "Workbook" : "Seller underwriting"} created — stamped provisional
          </div>
          <div style={{ fontSize: 12.5, color: C.sub, marginTop: 4 }}>
            {sourced} of {data.length} data points sourced · {needs.length} flagged for follow-up in the output · {decisions.length} left for your judgment.
          </div>
        </div>
      )}

      <div style={{ fontFamily: MONO, fontSize: 11, color: C.sub, marginBottom: 8 }}>STILL NEEDED — BY FACT, NOT BY DOCUMENT</div>
      <div className="flex flex-col gap-2">
        {needs.map((f) => {
          const meta = FSTATE[f.state];
          const Icon = meta.icon;
          return (
            <div key={f.id} className="flex items-start gap-3" style={{ background: C.paper, borderRadius: 9, padding: "11px 13px" }}>
              <Icon size={15} style={{ color: meta.color, marginTop: 2 }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span style={{ fontWeight: 600, fontSize: 13.5 }}>{f.name}</span>
                  <span style={{ fontFamily: MONO, fontSize: 9.5, color: meta.color, background: meta.bg, borderRadius: 5, padding: "1px 7px" }}>{meta.label}</span>
                </div>
                <div style={{ fontSize: 12, color: C.sub, marginTop: 2 }}>
                  Blocks <span style={{ color: C.text }}>{f.blocks}</span> · usually in {f.source}
                </div>
              </div>
              <button style={{ fontFamily: MONO, fontSize: 10.5, color: C.text, background: "#fff", border: `1px solid ${C.line}`, borderRadius: 7, padding: "5px 10px", cursor: "pointer", whiteSpace: "nowrap" }}>
                {f.state === "in_pdf" ? "Confirm / enter" : "Add source"}
              </button>
            </div>
          );
        })}
      </div>

      {decisions.length > 0 && (
        <div style={{ fontSize: 12, color: C.sub, borderTop: `1px solid ${C.line}`, paddingTop: 10, marginTop: 12 }}>
          <span style={{ fontFamily: MONO, fontSize: 11 }}>Not missing — your call:</span> {decisions.map((d) => d.name).join(", ")} — left blank for the underwriter, set in the deal room.
        </div>
      )}
    </div>
  );
}

function DocRow({ label, on, accent }) {
  return (
    <div className="flex items-center gap-3 py-2" style={{ borderBottom: `1px solid ${C.line}` }}>
      <span style={{ width: 18, height: 18, borderRadius: 5, background: on ? C.ochreSoft : C.paper, color: on ? accent : C.sub }} className="flex items-center justify-center">{on ? <Check size={12} /> : <Dot size={14} />}</span>
      <span style={{ fontSize: 13, color: on ? C.text : C.sub }}>{label}</span>
    </div>
  );
}
function Deliverable({ icon: Icon, accent, title, desc, frame }) {
  return (
    <div className="flex items-start gap-3 mb-3" style={{ background: C.paper, borderRadius: 9, padding: "12px 13px" }}>
      <Icon size={17} style={{ color: accent, marginTop: 2 }} />
      <div><div style={{ fontWeight: 600, fontSize: 14 }}>{title}</div><div style={{ fontSize: 12.5, color: C.sub }}>{desc}</div>{frame && <div style={{ fontFamily: MONO, fontSize: 11, color: accent, marginTop: 4 }}>{frame}</div>}</div>
    </div>
  );
}

/* ----------------------------- deal room ----------------------------- */
function DealRoom({ loan, resolved, setResolved, score, openFlags, allCleared, proceedsCut, fatalRaised, setFatalRaised, disposition, setDisposition, status, resetAll }) {
  const [messages, setMessages] = useState(SEED_MESSAGES);
  const [side, setSide] = useState("originator");
  const [draft, setDraft] = useState("");
  const [tag, setTag] = useState(null);
  const [callRequested, setCallRequested] = useState(false);

  const post = () => {
    const t = draft.trim(); if (!t) return;
    setMessages((m) => [...m, { id: Date.now(), side, lever: tag, text: t }]);
    setDraft(""); setTag(null);
  };

  const pct = Math.min(100, Math.round((score / 100) * 100));
  const scoreColor = score >= SCORE_THRESHOLD ? C.cleared : score >= 70 ? C.ochre : C.warn;

  return (
    <div style={{ background: C.ink, minHeight: "calc(100vh - 56px)" }}>
      <div className="max-w-6xl mx-auto px-6 py-8">
        <div className="flex items-start justify-between flex-wrap gap-4 mb-5">
          <div>
            <Eyebrow color="rgba(255,255,255,0.5)">deal room · {loan ? loan.name : "Sunroad Centrum"}</Eyebrow>
            <h2 style={{ fontFamily: DISP, fontWeight: 700, fontSize: 26, color: "#fff", margin: "6px 0 4px" }}>Two reads, one structure to clear.</h2>
            <p style={{ color: "rgba(255,255,255,0.55)", fontSize: 13.5, maxWidth: 560 }}>Clear a red flag with a lever and the score climbs. Flags to zero, score over the bar — the deal clears. Then it still has to close.</p>
          </div>
          <button onClick={resetAll} style={{ fontFamily: MONO, fontSize: 11, color: "rgba(255,255,255,0.6)", border: `1px solid ${C.inkLine}`, padding: "8px 12px", borderRadius: 7 }} className="flex items-center gap-2"><RotateCcw size={12} /> reset</button>
        </div>

        <DispositionBar status={status} allCleared={allCleared} fatalRaised={fatalRaised} disposition={disposition} setDisposition={setDisposition} resetAll={resetAll} />

        <div className="grid lg:grid-cols-3 gap-5 items-start mt-4">
          <div className="lg:col-span-2">
            {/* score panel */}
            <div style={{ background: C.inkSoft, border: `1px solid ${C.inkLine}`, borderRadius: 12, padding: 18, marginBottom: 12 }}>
              <div className="flex items-end justify-between mb-2">
                <div>
                  <div style={{ fontFamily: MONO, fontSize: 11, color: "rgba(255,255,255,0.55)" }}>CREDIT SCORE</div>
                  <div className="flex items-end gap-2">
                    <span style={{ fontFamily: DISP, fontWeight: 700, fontSize: 34, color: scoreColor, lineHeight: 1 }}>{score}</span>
                    <span style={{ fontFamily: MONO, fontSize: 11, color: "rgba(255,255,255,0.45)", marginBottom: 4 }}>/ approve at {SCORE_THRESHOLD}</span>
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div className="flex items-center gap-1 justify-end" style={{ color: openFlags ? "#E9B48C" : "#7FE0AC", fontFamily: MONO, fontSize: 12 }}>
                    <Flag size={13} /> {openFlags ? `${openFlags} red flag${openFlags === 1 ? "" : "s"} open` : "all flags cleared"}
                  </div>
                </div>
              </div>
              <div style={{ position: "relative", height: 8, borderRadius: 999, background: "rgba(255,255,255,0.08)", overflow: "hidden" }}>
                <div style={{ width: `${pct}%`, height: "100%", background: scoreColor, transition: "width .35s, background .35s" }} />
              </div>
              <div style={{ position: "relative", height: 12, marginTop: 2 }}>
                <div style={{ position: "absolute", left: `${SCORE_THRESHOLD}%`, transform: "translateX(-50%)", fontFamily: MONO, fontSize: 9, color: "rgba(255,255,255,0.4)" }}>▲ {SCORE_THRESHOLD}</div>
              </div>
              <div className="mt-1">
                {fatalRaised ? (
                  <div className="flex items-center gap-2" style={{ color: "#E98C8C", fontFamily: MONO, fontSize: 12.5 }}><XCircle size={14} /> Disqualifying flag raised — no structure cures this. Reject as disqualifying.</div>
                ) : allCleared ? (
                  <div className="flex items-center gap-2" style={{ color: "#7FE0AC", fontFamily: MONO, fontSize: 12.5 }}><CheckCircle2 size={14} /> Cleared — {proceedsCut ? "proceeds reduced (last resort used)" : "borrower proceeds preserved"}. Ready to approve.</div>
                ) : (
                  <div style={{ color: "rgba(255,255,255,0.55)", fontFamily: MONO, fontSize: 12.5 }}>{openFlags} flag{openFlags === 1 ? "" : "s"} to clear — resolve with structure before touching proceeds.</div>
                )}
              </div>
            </div>

            {/* fatal control */}
            <div style={{ background: fatalRaised ? "rgba(181,83,43,0.14)" : "rgba(255,255,255,0.03)", border: `1px solid ${fatalRaised ? "rgba(233,140,140,0.4)" : C.inkLine}`, borderRadius: 10, padding: 12, marginBottom: 12 }}>
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2" style={{ fontFamily: MONO, fontSize: 12, color: "rgba(255,255,255,0.75)" }}>
                  <ShieldCheck size={14} /> Sponsor & credit review
                </div>
                {!fatalRaised ? (
                  <button onClick={() => setFatalRaised(true)} style={{ fontFamily: MONO, fontSize: 11, color: "#E9B48C", background: "none", border: `1px solid rgba(233,140,140,0.35)`, borderRadius: 7, padding: "5px 10px", cursor: "pointer" }} className="flex items-center gap-1">
                    <AlertTriangle size={12} /> Raise disqualifying flag
                  </button>
                ) : (
                  <button onClick={() => setFatalRaised(false)} style={{ fontFamily: MONO, fontSize: 11, color: "rgba(255,255,255,0.5)", background: "none", border: `1px solid ${C.inkLine}`, borderRadius: 7, padding: "5px 10px", cursor: "pointer" }}>clear flag (demo)</button>
                )}
              </div>
              {fatalRaised && <div style={{ fontSize: 12, color: "#E9B48C", marginTop: 8 }}>Fatal flags don't lower the score — they route straight to reject. A lever can't cure sponsor character.</div>}
            </div>

            <div className="flex flex-col gap-2.5">
              {LEVERS.map((l) => <LeverRow key={l.id} lever={l} state={resolved[l.id]} onResolve={(mode) => setResolved((r) => ({ ...r, [l.id]: mode }))} onComment={() => setTag(l.id)} />)}
            </div>
          </div>

          <CommentaryPanel messages={messages} side={side} setSide={setSide} draft={draft} setDraft={setDraft} tag={tag} setTag={setTag} post={post} callRequested={callRequested} setCallRequested={setCallRequested} />
        </div>
      </div>
    </div>
  );
}

function DispositionBar({ status, allCleared, fatalRaised, disposition, setDisposition, resetAll }) {
  const [expanded, setExpanded] = useState(false);
  const [reason, setReason] = useState(fatalRaised ? REJECT_REASONS[0] : null);
  const [ref, setRef] = useState("");
  const [note, setNote] = useState("");

  const terminal = !!disposition;
  const confirm = () => {
    if (!reason) return;
    setDisposition({ outcome: reason.id, reason: reason.label, ref: ref || undefined, detail: note.trim() || reason.hint, by: "Buyer" });
    setExpanded(false);
  };

  return (
    <div style={{ background: C.inkSoft, border: `1px solid ${terminal ? (disposition.outcome === "closed" ? "rgba(127,224,172,0.35)" : "rgba(233,140,140,0.35)") : C.inkLine}`, borderRadius: 12, padding: 16 }}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <span style={{ fontFamily: MONO, fontSize: 11, color: "rgba(255,255,255,0.5)" }}>OUTCOME</span>
          <StatusChip status={status} dark />
          <span style={{ fontSize: 12.5, color: "rgba(255,255,255,0.6)" }}>
            {terminal
              ? (disposition.outcome === "closed" ? "Closed — in the final tape." : `${disposition.reason} — ${disposition.detail}`)
              : fatalRaised ? "A disqualifying flag is raised." : allCleared ? "Structure cleared. The buyer can approve, or still walk." : "In negotiation."}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {terminal ? (
            <button onClick={resetAll} style={{ fontFamily: MONO, fontSize: 11, color: "rgba(255,255,255,0.55)", background: "none", border: `1px solid ${C.inkLine}`, borderRadius: 7, padding: "7px 12px", cursor: "pointer" }} className="flex items-center gap-1"><RotateCcw size={12} /> reopen (demo)</button>
          ) : (
            <>
              {allCleared && !fatalRaised && (
                <button onClick={() => setDisposition({ outcome: "closed" })} style={{ fontFamily: MONO, fontSize: 12, color: "#fff", background: C.cleared, border: "none", borderRadius: 8, padding: "8px 14px", cursor: "pointer" }} className="flex items-center gap-2"><CheckCircle2 size={14} /> Approve &amp; close</button>
              )}
              <button onClick={() => { setExpanded((e) => !e); if (fatalRaised) setReason(REJECT_REASONS[0]); }} style={{ fontFamily: MONO, fontSize: 12, color: fatalRaised ? "#fff" : "rgba(255,255,255,0.7)", background: fatalRaised ? C.warn : "none", border: fatalRaised ? "none" : `1px solid ${C.inkLine}`, borderRadius: 8, padding: "8px 14px", cursor: "pointer" }} className="flex items-center gap-2">
                <XCircle size={14} /> {fatalRaised ? "Reject — disqualifying" : "Reject / withdraw"}
              </button>
            </>
          )}
        </div>
      </div>

      {expanded && !terminal && (
        <div style={{ borderTop: `1px solid ${C.inkLine}`, marginTop: 14, paddingTop: 14 }}>
          <div style={{ fontFamily: MONO, fontSize: 10.5, color: "rgba(255,255,255,0.5)", marginBottom: 8 }}>WHY DIDN'T IT CLOSE?</div>
          <div className="grid sm:grid-cols-2 gap-2 mb-3">
            {REJECT_REASONS.map((r) => {
              const on = reason && reason.id === r.id;
              return (
                <button key={r.id} onClick={() => setReason(r)} className="text-left" style={{ background: on ? "rgba(181,83,43,0.16)" : "rgba(255,255,255,0.03)", border: `1px solid ${on ? "rgba(233,140,140,0.5)" : C.inkLine}`, borderRadius: 9, padding: "10px 12px", cursor: "pointer" }}>
                  <div style={{ fontFamily: MONO, fontSize: 12, color: on ? "#E9B48C" : "#fff" }}>{r.label}</div>
                  <div style={{ fontSize: 11.5, color: "rgba(255,255,255,0.5)", marginTop: 2 }}>{r.hint}</div>
                </button>
              );
            })}
          </div>
          <div className="flex flex-col sm:flex-row gap-2">
            <select value={ref} onChange={(e) => setRef(e.target.value)} style={{ fontFamily: MONO, fontSize: 11.5, color: "#fff", background: "rgba(255,255,255,0.04)", border: `1px solid ${C.inkLine}`, borderRadius: 8, padding: "8px 10px", outline: "none" }}>
              <option value="" style={{ color: "#000" }}>Link to a flag/term (optional)</option>
              {LEVERS.map((l) => <option key={l.id} value={l.name} style={{ color: "#000" }}>{l.name}</option>)}
              <option value="Sponsor background" style={{ color: "#000" }}>Sponsor background</option>
            </select>
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note both sides will see…" style={{ flex: 1, fontFamily: BODY, fontSize: 12.5, color: "#fff", background: "rgba(255,255,255,0.04)", border: `1px solid ${C.inkLine}`, borderRadius: 8, padding: "8px 10px", outline: "none" }} />
            <button onClick={confirm} disabled={!reason} style={{ fontFamily: MONO, fontSize: 12, color: "#fff", background: reason ? C.warn : "rgba(255,255,255,0.1)", border: "none", borderRadius: 8, padding: "8px 16px", cursor: reason ? "pointer" : "default" }}>Log disposition</button>
          </div>
        </div>
      )}
    </div>
  );
}

function LeverRow({ lever, state, onResolve, onComment }) {
  const Icon = lever.icon;
  const done = !!state;
  const isProceeds = lever.lastResort;
  return (
    <div style={{ background: done ? "rgba(46,125,87,0.10)" : C.inkSoft, border: `1px solid ${done ? "rgba(127,224,172,0.35)" : C.inkLine}`, borderRadius: 11, padding: 16 }}>
      <div className="flex items-center gap-3 mb-1">
        <Icon size={16} style={{ color: done ? "#7FE0AC" : "rgba(255,255,255,0.75)" }} />
        <span style={{ fontFamily: DISP, fontWeight: 600, fontSize: 15, color: "#fff" }}>{lever.name}</span>
        <div className="flex items-center gap-3" style={{ marginLeft: "auto" }}>
          {!done && <button onClick={onComment} title="Note on this term" style={{ color: "rgba(255,255,255,0.4)", background: "none", border: "none", cursor: "pointer" }} className="flex items-center"><MessageSquare size={14} /></button>}
          {isProceeds && !done && <span className="flex items-center gap-1" style={{ fontFamily: MONO, fontSize: 10, color: C.warn }}><AlertTriangle size={11} /> last resort</span>}
          {done && <span style={{ fontFamily: MONO, fontSize: 11, color: "#7FE0AC" }} className="flex items-center gap-1"><Check size={12} /> agreed</span>}
        </div>
      </div>
      {lever.flag && (
        <div className="flex items-center gap-1 mb-3" style={{ fontFamily: MONO, fontSize: 10.5, color: done ? "rgba(127,224,172,0.7)" : "#E9B48C" }}>
          <Flag size={10} /> {done ? "flag cleared" : `red flag: ${lever.flag}`}
        </div>
      )}
      {!done ? (
        <>
          <div className="grid md:grid-cols-2 gap-2.5 mb-3">
            <Position accent={C.ochre} who="Originator proposes" term={lever.orig} why={lever.why} />
            <Position accent={C.steel} who="Buyer requires" term={lever.buyer} why={lever.buyerWhy} />
          </div>
          <div className="flex gap-2">
            {!isProceeds ? (
              <button onClick={() => onResolve("structure")} style={{ fontFamily: MONO, fontSize: 11.5, color: "#fff", background: C.steel, padding: "8px 13px", borderRadius: 7 }} className="flex items-center gap-2">Accept structure — clears the flag <ChevronRight size={13} /></button>
            ) : (
              <button onClick={() => onResolve("proceeds")} style={{ fontFamily: MONO, fontSize: 11.5, color: "#fff", background: C.warn, padding: "8px 13px", borderRadius: 7 }} className="flex items-center gap-2"><AlertTriangle size={12} /> Reduce proceeds (last resort)</button>
            )}
          </div>
        </>
      ) : (
        <div style={{ fontFamily: MONO, fontSize: 12.5, color: "rgba(255,255,255,0.8)" }}>{lever.buyer}<span style={{ color: "rgba(255,255,255,0.4)" }}> — locked into the cleared structure</span></div>
      )}
    </div>
  );
}

function CommentaryPanel({ messages, side, setSide, draft, setDraft, tag, setTag, post, callRequested, setCallRequested }) {
  const leverName = (id) => (LEVERS.find((l) => l.id === id) || {}).name;
  return (
    <div style={{ background: C.inkSoft, border: `1px solid ${C.inkLine}`, borderRadius: 12, padding: 16, display: "flex", flexDirection: "column", maxHeight: 720 }}>
      <div className="flex items-center gap-2 mb-3"><MessageSquare size={15} style={{ color: "rgba(255,255,255,0.7)" }} /><span style={{ fontFamily: DISP, fontWeight: 600, fontSize: 14, color: "#fff" }}>Deal notes</span></div>
      {!callRequested ? (
        <button onClick={() => setCallRequested(true)} style={{ fontFamily: MONO, fontSize: 12, color: "#fff", background: "rgba(255,255,255,0.06)", border: `1px solid ${C.inkLine}`, padding: "9px 12px", borderRadius: 8, marginBottom: 14 }} className="flex items-center justify-center gap-2"><Phone size={13} /> Request a call</button>
      ) : (
        <div style={{ background: "rgba(127,224,172,0.10)", border: "1px solid rgba(127,224,172,0.30)", borderRadius: 8, padding: "9px 12px", marginBottom: 14 }}>
          <div className="flex items-center gap-2" style={{ color: "#7FE0AC", fontFamily: MONO, fontSize: 12 }}><Phone size={13} /> Call requested</div>
          <div style={{ fontSize: 11.5, color: "rgba(255,255,255,0.5)", marginTop: 3 }}>The other side will be notified to schedule.</div>
        </div>
      )}
      <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 10, marginBottom: 12, minHeight: 160 }}>
        {messages.map((m) => {
          const isOrig = m.side === "originator";
          const accent = isOrig ? C.ochre : C.steel;
          return (
            <div key={m.id} style={{ background: "rgba(255,255,255,0.03)", borderLeft: `3px solid ${accent}`, borderRadius: 7, padding: "9px 11px" }}>
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: "0.06em", textTransform: "uppercase", color: accent }}>{isOrig ? "Originator" : "Buyer"}</span>
                {m.lever && <span style={{ fontFamily: MONO, fontSize: 9.5, color: "rgba(255,255,255,0.5)", background: "rgba(255,255,255,0.06)", borderRadius: 4, padding: "1px 6px" }}>re: {leverName(m.lever)}</span>}
              </div>
              <div style={{ fontSize: 12.5, color: "rgba(255,255,255,0.85)", lineHeight: 1.45 }}>{m.text}</div>
            </div>
          );
        })}
      </div>
      <div style={{ borderTop: `1px solid ${C.inkLine}`, paddingTop: 12 }}>
        <div className="flex items-center gap-2 mb-2">
          <span style={{ fontFamily: MONO, fontSize: 10, color: "rgba(255,255,255,0.4)" }}>POST AS</span>
          {["originator", "buyer"].map((s) => {
            const on = side === s; const a = s === "originator" ? C.ochre : C.steel;
            return <button key={s} onClick={() => setSide(s)} style={{ fontFamily: MONO, fontSize: 10.5, padding: "3px 9px", borderRadius: 6, color: on ? "#fff" : "rgba(255,255,255,0.5)", background: on ? a : "transparent", border: `1px solid ${on ? a : C.inkLine}` }}>{s === "buyer" ? "Buyer" : "Originator"}</button>;
          })}
        </div>
        {tag && (
          <div className="flex items-center gap-2 mb-2">
            <span style={{ fontFamily: MONO, fontSize: 10, color: "rgba(255,255,255,0.65)", background: "rgba(255,255,255,0.06)", borderRadius: 5, padding: "2px 8px" }}>re: {leverName(tag)}</span>
            <button onClick={() => setTag(null)} style={{ fontFamily: MONO, fontSize: 10, color: "rgba(255,255,255,0.4)", background: "none", border: "none", cursor: "pointer" }}>clear</button>
          </div>
        )}
        <div className="flex gap-2">
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) post(); }} placeholder="Add a note or counter…  (⌘/Ctrl+Enter)" rows={2}
            style={{ flex: 1, resize: "none", fontFamily: BODY, fontSize: 12.5, color: "#fff", background: "rgba(255,255,255,0.04)", border: `1px solid ${C.inkLine}`, borderRadius: 8, padding: "8px 10px", outline: "none" }} />
          <button onClick={post} style={{ background: C.steel, color: "#fff", border: "none", borderRadius: 8, padding: "0 12px", cursor: "pointer" }} className="flex items-center"><Send size={15} /></button>
        </div>
      </div>
    </div>
  );
}

function Position({ accent, who, term, why }) {
  return (
    <div style={{ background: "rgba(255,255,255,0.03)", border: `1px solid ${C.inkLine}`, borderLeft: `3px solid ${accent}`, borderRadius: 8, padding: "10px 12px" }}>
      <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: "0.08em", color: accent, textTransform: "uppercase" }}>{who}</div>
      <div style={{ fontFamily: MONO, fontSize: 13, color: "#fff", margin: "3px 0 3px" }}>{term}</div>
      <div style={{ fontSize: 11.5, color: "rgba(255,255,255,0.5)" }}>{why}</div>
    </div>
  );
}
