import React, { useState, useEffect } from "react";
import {
  ArrowRight, ArrowLeft, FileText, Table2, ScrollText, ShieldCheck,
  Landmark, Scale, Check, AlertTriangle, RotateCcw, ChevronRight, Dot,
} from "lucide-react";

/* ---- design tokens (subject-grounded: warm originator vs cool buyer) ---- */
const C = {
  ink: "#111A26",
  inkSoft: "#1B2838",
  inkLine: "rgba(255,255,255,0.10)",
  paper: "#EEF1F4",
  card: "#FFFFFF",
  line: "#D3DAE2",
  text: "#16202E",
  sub: "#5C6B7E",
  ochre: "#A8742A",      // originator — advocacy, winning the borrower
  ochreSoft: "#F4EAD6",
  steel: "#2F5E86",      // buyer — skeptical, conservative
  steelSoft: "#E0E9F1",
  cleared: "#2E7D57",    // convergence
  warn: "#B5532B",
};
const DISP = "'Space Grotesk', sans-serif";
const BODY = "'Inter', sans-serif";
const MONO = "'IBM Plex Mono', monospace";

const LEVERS = [
  { id: "reserve", name: "Lease-up reserve", icon: Landmark,
    orig: "Minimal reserve", buyer: "$4.2M lease-up reserve",
    why: "Preserves the borrower's cash at closing", buyerWhy: "Funds carry the asset through stabilization", cost: "low" },
  { id: "cash", name: "Cash management", icon: Scale,
    orig: "No lockbox", buyer: "Springing lockbox < 70% occ",
    why: "Borrower keeps control of cash flow", buyerWhy: "Traps cash if lease-up stalls", cost: "low" },
  { id: "guaranty", name: "Recourse / guaranty", icon: ShieldCheck,
    orig: "Non-recourse", buyer: "Springing recourse on milestones",
    why: "Standard ask to win the borrower", buyerWhy: "Recourse triggers if lease-up misses", cost: "med" },
  { id: "amort", name: "Amortization", icon: ScrollText,
    orig: "Full-term interest-only", buyer: "Amortize after stabilization",
    why: "Maximizes borrower cash flow", buyerWhy: "Builds equity once stabilized", cost: "med" },
  { id: "cp", name: "Conditions precedent", icon: FileText,
    orig: "None at close", buyer: "GSA estoppel + lease-up evidence",
    why: "Faster close for the borrower", buyerWhy: "Verifies the anchor before funding", cost: "low" },
  { id: "proceeds", name: "Loan proceeds", icon: Landmark,
    orig: "$82.46M (full request)", buyer: "$78.0M (lease-up haircut)",
    why: "The borrower's whole reason to choose this lender", buyerWhy: "De-risks by lowering basis", cost: "high", lastResort: true },
];

export default function App() {
  const [screen, setScreen] = useState("home");
  const [resolved, setResolved] = useState({}); // id -> 'structure' | 'proceeds'

  useEffect(() => {
    const l = document.createElement("link");
    l.rel = "stylesheet";
    l.href =
      "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap";
    document.head.appendChild(l);
    return () => { document.head.removeChild(l); };
  }, []);

  const structuralIds = LEVERS.filter((l) => !l.lastResort).map((l) => l.id);
  const structAgreed = structuralIds.filter((id) => resolved[id]).length;
  const proceedsCut = resolved["proceeds"] === "proceeds";
  const allStruct = structAgreed === structuralIds.length;
  const clearable = allStruct; // ideal: structure closes the gap, proceeds preserved

  return (
    <div style={{ background: C.paper, color: C.text, fontFamily: BODY, minHeight: "100vh" }}>
      <TopBar screen={screen} setScreen={setScreen} />
      {screen === "home" && <Home setScreen={setScreen} />}
      {screen === "originator" && <Originator setScreen={setScreen} />}
      {screen === "buyer" && <Buyer setScreen={setScreen} />}
      {screen === "dealroom" && (
        <DealRoom
          resolved={resolved} setResolved={setResolved}
          structAgreed={structAgreed} total={structuralIds.length}
          clearable={clearable} proceedsCut={proceedsCut}
        />
      )}
    </div>
  );
}

/* ----------------------------- chrome ----------------------------- */
function TopBar({ screen, setScreen }) {
  const tabs = [
    ["home", "Home"], ["originator", "Originator"],
    ["buyer", "B-piece buyer"], ["dealroom", "Deal room"],
  ];
  return (
    <div style={{ background: C.ink, borderBottom: `1px solid ${C.inkLine}` }}>
      <div className="flex items-center justify-between px-6 py-3 max-w-6xl mx-auto">
        <button onClick={() => setScreen("home")} className="flex items-center gap-3 text-left">
          <div style={{ width: 22, height: 22, borderRadius: 5, background: `linear-gradient(135deg, ${C.ochre} 0 50%, ${C.steel} 50% 100%)` }} />
          <div>
            <div style={{ fontFamily: DISP, fontWeight: 700, letterSpacing: "0.02em", color: "#fff", fontSize: 14, lineHeight: 1 }}>
              CRE CREDIT COMMITTEE
            </div>
            <div style={{ fontFamily: MONO, fontSize: 10, color: "rgba(255,255,255,0.45)", marginTop: 3 }}>
              the credit committee, as software
            </div>
          </div>
        </button>
        <div className="flex gap-1">
          {tabs.map(([id, label]) => (
            <button key={id} onClick={() => setScreen(id)}
              style={{
                fontFamily: MONO, fontSize: 11, padding: "6px 11px", borderRadius: 6,
                color: screen === id ? "#fff" : "rgba(255,255,255,0.5)",
                background: screen === id ? "rgba(255,255,255,0.10)" : "transparent",
              }}>
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function Eyebrow({ children, color }) {
  return (
    <div style={{ fontFamily: MONO, fontSize: 11, letterSpacing: "0.14em", textTransform: "uppercase", color: color || C.sub }}>
      {children}
    </div>
  );
}

/* ------------------------------ home ------------------------------ */
function Home({ setScreen }) {
  return (
    <div className="max-w-6xl mx-auto px-6 pt-14 pb-10">
      <div className="text-center mb-3">
        <Eyebrow color={C.sub}>one deal · two sides · one venue</Eyebrow>
      </div>
      <h1 style={{ fontFamily: DISP, fontWeight: 700, fontSize: 38, lineHeight: 1.08, textAlign: "center", maxWidth: 720, margin: "8px auto 6px" }}>
        The same deal reads two ways. Pick your side.
      </h1>
      <p style={{ textAlign: "center", color: C.sub, maxWidth: 560, margin: "0 auto 36px", fontSize: 15 }}>
        Originators want to win the borrower and still clear a buyer. Buyers want to be paid for the risk.
        The platform runs both reads off one underwriting — and brings them together in the deal room.
      </p>

      <div className="grid md:grid-cols-2 gap-5">
        <Door
          side="Originator" accent={C.ochre} soft={C.ochreSoft}
          posture="Serves two masters — the borrower and the buyer"
          brings="ASR · rent roll · appraisal · PCA · operating statement"
          gets={[
            ["Seller underwriting", "the package you market the deal with", Table2],
            ["Analysis page", "red-flag and diligence coverage", ShieldCheck],
            ["Credit memo", "how the deal should be structured", ScrollText],
          ]}
          note="Accurate enough to pass a buyer. Accommodating enough to keep the borrower."
          onEnter={() => setScreen("originator")}
        />
        <Door
          side="B-piece buyer" accent={C.steel} soft={C.steelSoft}
          posture="Conservative to the T — paid to take first loss"
          brings="a submitted deal, or your own document set"
          gets={[
            ["Full workbook", "the populated quantitative work product", Table2],
            ["Analysis page", "stress-tested score and red flags", ShieldCheck],
            ["Credit memo", "mitigation and restructuring", ScrollText],
          ]}
          note="Skeptical by default. Proceeds-down is a clean lever, not a last resort."
          onEnter={() => setScreen("buyer")}
        />
      </div>

      <div className="mt-5 flex justify-center">
        <button onClick={() => setScreen("dealroom")}
          style={{ fontFamily: MONO, fontSize: 12, color: C.ink, background: "#fff", border: `1px solid ${C.line}`, padding: "10px 16px", borderRadius: 8 }}
          className="flex items-center gap-2">
          Skip to the deal room <ArrowRight size={14} />
        </button>
      </div>
    </div>
  );
}

function Door({ side, accent, soft, posture, brings, gets, note, onEnter }) {
  const [hover, setHover] = useState(false);
  return (
    <button onClick={onEnter} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      className="text-left w-full"
      style={{
        background: C.card, border: `1px solid ${hover ? accent : C.line}`,
        borderTop: `3px solid ${accent}`, borderRadius: 12, padding: 22,
        transition: "border-color .15s, transform .15s", transform: hover ? "translateY(-2px)" : "none",
      }}>
      <div className="flex items-center justify-between">
        <Eyebrow color={accent}>{side}</Eyebrow>
        <span style={{ width: 26, height: 26, borderRadius: 999, background: soft, color: accent }}
          className="flex items-center justify-center">
          <ArrowRight size={14} />
        </span>
      </div>
      <div style={{ fontFamily: DISP, fontWeight: 600, fontSize: 19, marginTop: 10, marginBottom: 14 }}>{posture}</div>

      <div style={{ fontFamily: MONO, fontSize: 11, color: C.sub, marginBottom: 4 }}>BRINGS</div>
      <div style={{ fontSize: 13, color: C.text, marginBottom: 16 }}>{brings}</div>

      <div style={{ fontFamily: MONO, fontSize: 11, color: C.sub, marginBottom: 8 }}>GETS</div>
      <div className="flex flex-col gap-2 mb-3">
        {gets.map(([t, d, Icon]) => (
          <div key={t} className="flex items-start gap-3" style={{ background: C.paper, borderRadius: 8, padding: "9px 11px" }}>
            <Icon size={16} style={{ color: accent, marginTop: 1 }} />
            <div>
              <div style={{ fontWeight: 600, fontSize: 13 }}>{t}</div>
              <div style={{ fontSize: 12, color: C.sub }}>{d}</div>
            </div>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 12, color: C.sub, fontStyle: "italic", borderTop: `1px solid ${C.line}`, paddingTop: 10 }}>{note}</div>
    </button>
  );
}

/* -------------------------- workspaces -------------------------- */
function Workspace({ accent, soft, side, posture, sub, left, right, cta, onCta, setScreen }) {
  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      <button onClick={() => setScreen("home")} style={{ fontFamily: MONO, fontSize: 11, color: C.sub }} className="flex items-center gap-1 mb-5">
        <ArrowLeft size={13} /> back to the two doors
      </button>
      <div style={{ background: C.card, border: `1px solid ${C.line}`, borderTop: `3px solid ${accent}`, borderRadius: 12, padding: 22, marginBottom: 18 }}>
        <Eyebrow color={accent}>{side} workspace</Eyebrow>
        <h2 style={{ fontFamily: DISP, fontWeight: 700, fontSize: 26, margin: "6px 0 4px" }}>{posture}</h2>
        <p style={{ color: C.sub, fontSize: 14, maxWidth: 620 }}>{sub}</p>
      </div>

      <div className="grid md:grid-cols-2 gap-5">
        <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, padding: 20 }}>{left}</div>
        <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, padding: 20 }}>{right}</div>
      </div>

      <div className="mt-5 flex justify-end">
        <button onClick={onCta}
          style={{ fontFamily: MONO, fontSize: 13, color: "#fff", background: accent, padding: "11px 18px", borderRadius: 9 }}
          className="flex items-center gap-2">
          {cta} <ArrowRight size={15} />
        </button>
      </div>
    </div>
  );
}

function DocRow({ label, on }) {
  return (
    <div className="flex items-center gap-3 py-2" style={{ borderBottom: `1px solid ${C.line}` }}>
      <span style={{ width: 18, height: 18, borderRadius: 5, background: on ? C.ochreSoft : C.paper, color: on ? C.ochre : C.sub }}
        className="flex items-center justify-center">
        {on ? <Check size={12} /> : <Dot size={14} />}
      </span>
      <span style={{ fontSize: 13, color: on ? C.text : C.sub }}>{label}</span>
    </div>
  );
}

function Deliverable({ icon: Icon, accent, title, desc, frame }) {
  return (
    <div className="flex items-start gap-3 mb-3" style={{ background: C.paper, borderRadius: 9, padding: "12px 13px" }}>
      <Icon size={17} style={{ color: accent, marginTop: 2 }} />
      <div>
        <div style={{ fontWeight: 600, fontSize: 14 }}>{title}</div>
        <div style={{ fontSize: 12.5, color: C.sub }}>{desc}</div>
        {frame && <div style={{ fontFamily: MONO, fontSize: 11, color: accent, marginTop: 4 }}>{frame}</div>}
      </div>
    </div>
  );
}

function Originator({ setScreen }) {
  return (
    <Workspace
      setScreen={setScreen} accent={C.ochre} soft={C.ochreSoft} side="Originator"
      posture="You serve two masters."
      sub="Win the borrower with flexible terms — and still hand a buyer something they'll respect. The seller underwriting is accurate, not stress-maxed; the memo is constructive, not corrective."
      left={
        <>
          <Eyebrow color={C.ochre}>Document intake</Eyebrow>
          <div className="mt-3">
            <DocRow label="ASR (appraisal summary report)" on />
            <DocRow label="Rent roll" on />
            <DocRow label="Operating statement" on />
            <DocRow label="Appraisal" on />
            <DocRow label="PCA" on />
            <DocRow label="Environmental / other" on={false} />
          </div>
          <div style={{ fontFamily: MONO, fontSize: 11, color: C.sub, marginTop: 12 }}>
            5 of 6 in — environmental optional for this asset class
          </div>
        </>
      }
      right={
        <>
          <Eyebrow color={C.ochre}>Your deliverables</Eyebrow>
          <div className="mt-3">
            <Deliverable icon={Table2} accent={C.ochre} title="Seller underwriting"
              desc="The package you take to market — same facts, presented to clear a buyer." />
            <Deliverable icon={ShieldCheck} accent={C.ochre} title="Analysis page"
              desc="Red flags surfaced before a buyer finds them." />
            <Deliverable icon={ScrollText} accent={C.ochre} title="Credit memo"
              desc="Reads as guidance, not repair." frame="“How the deal should be structured”" />
          </div>
          <div style={{ fontSize: 12.5, color: C.sub, fontStyle: "italic", borderTop: `1px solid ${C.line}`, paddingTop: 10, marginTop: 4 }}>
            Structure first — reserves, recourse, cash management. Proceeds-down stays a last resort; it's the borrower's reason to pick you.
          </div>
        </>
      }
      cta="Submit to buyers" onCta={() => setScreen("dealroom")}
    />
  );
}

function Buyer({ setScreen }) {
  return (
    <Workspace
      setScreen={setScreen} accent={C.steel} soft={C.steelSoft} side="B-piece buyer"
      posture="Conservative to the T."
      sub="You take first loss, so you read the deal skeptically. The workbook replaces the special servicer's quantitative work; the memo says what it would take to make the risk acceptable."
      left={
        <>
          <Eyebrow color={C.steel}>Deal in</Eyebrow>
          <div style={{ background: C.steelSoft, borderRadius: 9, padding: 14, marginTop: 12 }}>
            <div style={{ fontFamily: DISP, fontWeight: 600, fontSize: 16 }}>Sunroad Centrum</div>
            <div style={{ fontFamily: MONO, fontSize: 12, color: C.steel, marginTop: 4 }}>
              BMARK 2024-V8 · San Diego office · GSA-anchored
            </div>
            <div className="grid grid-cols-2 gap-2 mt-3" style={{ fontFamily: MONO, fontSize: 12 }}>
              <Stat k="Loan" v="$82.46M" />
              <Stat k="Occupancy" v="46.8% → 100%" />
              <Stat k="Built" v="2008" />
              <Stat k="Status" v="lease-up" />
            </div>
          </div>
          <div style={{ fontSize: 12.5, color: C.sub, marginTop: 12 }}>
            Submitted by the originator — or upload your own document set to underwrite cold.
          </div>
        </>
      }
      right={
        <>
          <Eyebrow color={C.steel}>Your deliverables</Eyebrow>
          <div className="mt-3">
            <Deliverable icon={Table2} accent={C.steel} title="Full workbook"
              desc="The populated model — your quantitative work product." />
            <Deliverable icon={ShieldCheck} accent={C.steel} title="Analysis page"
              desc="Stress-tested score, red flags, the lease-up risk front and center." />
            <Deliverable icon={ScrollText} accent={C.steel} title="Credit memo"
              desc="What it takes to make first-loss acceptable." frame="“Mitigation & restructuring”" />
          </div>
          <div style={{ fontSize: 12.5, color: C.sub, fontStyle: "italic", borderTop: `1px solid ${C.line}`, paddingTop: 10, marginTop: 4 }}>
            Same seven levers as the originator — read from the other side. Here, lowering proceeds is just a clean way to cut basis.
          </div>
        </>
      }
      cta="Open deal room" onCta={() => setScreen("dealroom")}
    />
  );
}

function Stat({ k, v }) {
  return (
    <div>
      <div style={{ color: C.sub, fontSize: 10.5 }}>{k.toUpperCase()}</div>
      <div style={{ fontWeight: 600 }}>{v}</div>
    </div>
  );
}

/* ----------------------------- deal room ----------------------------- */
function DealRoom({ resolved, setResolved, structAgreed, total, clearable, proceedsCut }) {
  const pct = Math.round((structAgreed / total) * 100);
  return (
    <div style={{ background: C.ink, minHeight: "calc(100vh - 56px)" }}>
      <div className="max-w-6xl mx-auto px-6 py-8">
        <div className="flex items-start justify-between flex-wrap gap-4 mb-6">
          <div>
            <Eyebrow color="rgba(255,255,255,0.5)">deal room · Sunroad Centrum</Eyebrow>
            <h2 style={{ fontFamily: DISP, fontWeight: 700, fontSize: 26, color: "#fff", margin: "6px 0 4px" }}>
              Two reads, one structure to clear.
            </h2>
            <p style={{ color: "rgba(255,255,255,0.55)", fontSize: 13.5, maxWidth: 600 }}>
              The originator opens warm (preserve the borrower's terms). The buyer opens cold (price the lease-up risk).
              Each lever is the same doctrine seen twice — close the gap with structure, and proceeds stay whole.
            </p>
          </div>
          <button onClick={() => setResolved({})}
            style={{ fontFamily: MONO, fontSize: 11, color: "rgba(255,255,255,0.6)", border: `1px solid ${C.inkLine}`, padding: "8px 12px", borderRadius: 7 }}
            className="flex items-center gap-2">
            <RotateCcw size={12} /> reset
          </button>
        </div>

        {/* convergence */}
        <div style={{ background: C.inkSoft, border: `1px solid ${C.inkLine}`, borderRadius: 12, padding: 18, marginBottom: 18 }}>
          <div className="flex items-center justify-between mb-2">
            <span style={{ fontFamily: MONO, fontSize: 11, color: "rgba(255,255,255,0.6)" }}>STRUCTURAL TERMS AGREED</span>
            <span style={{ fontFamily: MONO, fontSize: 12, color: "#fff" }}>{structAgreed} / {total}</span>
          </div>
          <div style={{ height: 8, borderRadius: 999, background: "rgba(255,255,255,0.08)", overflow: "hidden" }}>
            <div style={{ width: `${pct}%`, height: "100%", background: clearable ? C.cleared : `linear-gradient(90deg, ${C.ochre}, ${C.steel})`, transition: "width .35s" }} />
          </div>
          <div className="mt-3">
            {clearable ? (
              <div className="flex items-center gap-2" style={{ color: "#7FE0AC", fontFamily: MONO, fontSize: 12.5 }}>
                <Check size={15} /> Clearable structure — {proceedsCut ? "proceeds reduced (last resort used)" : "borrower proceeds preserved"}
              </div>
            ) : (
              <div style={{ color: "rgba(255,255,255,0.55)", fontFamily: MONO, fontSize: 12.5 }}>
                {total - structAgreed} term{total - structAgreed === 1 ? "" : "s"} still open — resolve with structure before touching proceeds
              </div>
            )}
          </div>
        </div>

        {/* lever ledger */}
        <div className="flex flex-col gap-2.5">
          {LEVERS.map((l) => (
            <LeverRow key={l.id} lever={l} state={resolved[l.id]}
              onResolve={(mode) => setResolved((r) => ({ ...r, [l.id]: mode }))} />
          ))}
        </div>
      </div>
    </div>
  );
}

function LeverRow({ lever, state, onResolve }) {
  const Icon = lever.icon;
  const done = !!state;
  const isProceeds = lever.lastResort;
  return (
    <div style={{
      background: done ? "rgba(46,125,87,0.10)" : C.inkSoft,
      border: `1px solid ${done ? "rgba(127,224,172,0.35)" : C.inkLine}`,
      borderRadius: 11, padding: 16,
    }}>
      <div className="flex items-center gap-3 mb-3">
        <Icon size={16} style={{ color: done ? "#7FE0AC" : "rgba(255,255,255,0.75)" }} />
        <span style={{ fontFamily: DISP, fontWeight: 600, fontSize: 15, color: "#fff" }}>{lever.name}</span>
        {isProceeds && !done && (
          <span className="flex items-center gap-1" style={{ fontFamily: MONO, fontSize: 10, color: C.warn, marginLeft: "auto" }}>
            <AlertTriangle size={11} /> last resort
          </span>
        )}
        {done && (
          <span style={{ fontFamily: MONO, fontSize: 11, color: "#7FE0AC", marginLeft: "auto" }} className="flex items-center gap-1">
            <Check size={12} /> agreed
          </span>
        )}
      </div>

      {!done ? (
        <>
          <div className="grid md:grid-cols-2 gap-2.5 mb-3">
            <Position accent={C.ochre} who="Originator proposes" term={lever.orig} why={lever.why} />
            <Position accent={C.steel} who="Buyer requires" term={lever.buyer} why={lever.buyerWhy} />
          </div>
          <div className="flex gap-2">
            {!isProceeds ? (
              <button onClick={() => onResolve("structure")}
                style={{ fontFamily: MONO, fontSize: 11.5, color: "#fff", background: C.steel, padding: "8px 13px", borderRadius: 7 }}
                className="flex items-center gap-2">
                Accept structure — keep proceeds whole <ChevronRight size={13} />
              </button>
            ) : (
              <button onClick={() => onResolve("proceeds")}
                style={{ fontFamily: MONO, fontSize: 11.5, color: "#fff", background: C.warn, padding: "8px 13px", borderRadius: 7 }}
                className="flex items-center gap-2">
                <AlertTriangle size={12} /> Reduce proceeds (last resort)
              </button>
            )}
          </div>
        </>
      ) : (
        <div style={{ fontFamily: MONO, fontSize: 12.5, color: "rgba(255,255,255,0.8)" }}>
          {state === "proceeds" ? lever.buyer : lever.buyer}
          <span style={{ color: "rgba(255,255,255,0.4)" }}> — locked into the cleared structure</span>
        </div>
      )}
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
