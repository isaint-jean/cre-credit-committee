/**
 * TapeHistoryPanel — the pool's tape-by-tape biography as a flowing cohort-flow
 * SVG ribbon. Port of the prototype's `buildFlow()` (cre-pool-rail.html lines
 * 455-508), with the same geometry: a central teal ribbon swelling/contracting
 * across tape nodes, joined with cubic Beziers, with green/gray/red tributaries
 * for added/dropped/kicked loans.
 *
 * The data layer is `computeCohortFlow` (sibling pure projection — see
 * `./cohort-flow.ts`). This component is presentational: it consumes the
 * model and renders the SVG.
 *
 * BALANCE (reseed PR B): when `model.hasBalanceData === true`, the ribbon
 * scales by total cutOffBalance per tape, each node shows its `$X.XXB`
 * total below the loan count, and every tributary carries a `$XXXmm` label
 * alongside its `+N` / `-N` count. When balance data is absent (synthetic
 * pools), the component falls back to count-scaling + count-only labels —
 * the prior behavior, preserved without code branching beyond the scale.
 *
 * HONEST STATES:
 *   - 0 tapes  → existing empty state.
 *   - 1 tape   → single node, NO flows drawn (not a fake transition).
 *   - 2+ tapes → full cohort-flow diagram.
 *   - Mixed balance presence on a single tape → totalBalance is the sum of
 *     what's present (sumBalance skips nulls); no fabricated total.
 */
import type { Disposition, Tape } from '@cre/contracts';
import { computeCohortFlow, type TapeNode, type TransitionFlow } from './cohort-flow';

const RIBBON_COLOR  = '#3FA7A0'; // accent (--brand)
const ADDED_COLOR   = '#4FB17C'; // status.positive (--accept)
const DROPPED_COLOR = '#5C6677'; // text.subtle (--muted-2)
const KICKED_COLOR  = '#D46A6A'; // risk.high (--kick)
const INK           = '#E9EDF3';
const INK_2         = '#AAB4C4';
const MUTED         = '#7E8A9C';

const W = 1080;
const H = 300;
const PAD_L = 70;
const PAD_R = 70;
const PAD_T = 46;
const PAD_B = 58;
const INNER_W = W - PAD_L - PAD_R;
const MID_Y = PAD_T + (H - PAD_T - PAD_B) / 2;
/** Ribbon-width scale: the half-height of the central ribbon at each tape
 *  node equals `loanCount * SCALE / 2`. The scale factor is chosen so the
 *  largest tape's ribbon takes up 78% of the inner band height. */
const RIBBON_HEIGHT_PCT = 0.78;

function nodeXs(n: number): number[] {
  if (n === 0) return [];
  if (n === 1) return [PAD_L + INNER_W / 2];
  return Array.from({ length: n }, (_, i) => PAD_L + (INNER_W * i) / (n - 1));
}

/** Width-scale value per tape — dollars when balance is present, count when not. */
function scaleSeed(node: TapeNode, useBalance: boolean): number {
  if (useBalance && node.totalBalance !== null) return node.totalBalance;
  return node.loanCount;
}

function buildRibbonPath(
  nodes: readonly TapeNode[],
  xs: readonly number[],
  scale: number,
  useBalance: boolean,
): string {
  const half = (n: TapeNode): number => (scaleSeed(n, useBalance) * scale) / 2;
  let band = `M ${xs[0]} ${MID_Y - half(nodes[0]!)} `;
  for (let i = 1; i < nodes.length; i++) {
    const x0 = xs[i - 1]!;
    const x1 = xs[i]!;
    const y0 = MID_Y - half(nodes[i - 1]!);
    const y1 = MID_Y - half(nodes[i]!);
    const cx = (x0 + x1) / 2;
    band += `C ${cx} ${y0} ${cx} ${y1} ${x1} ${y1} `;
  }
  band += `L ${xs[xs.length - 1]} ${MID_Y + half(nodes[nodes.length - 1]!)} `;
  for (let i = nodes.length - 1; i > 0; i--) {
    const x0 = xs[i]!;
    const x1 = xs[i - 1]!;
    const y0 = MID_Y + half(nodes[i]!);
    const y1 = MID_Y + half(nodes[i - 1]!);
    const cx = (x0 + x1) / 2;
    band += `C ${cx} ${y0} ${cx} ${y1} ${x1} ${y1} `;
  }
  return band + 'Z';
}

/** Format a dollar value for axis/flow labels. */
function fmtDollars(b: number | null): string {
  if (b === null || !Number.isFinite(b)) return '';
  if (b >= 1e9)  return `$${(b / 1e9).toFixed(2)}B`;
  if (b >= 1e6)  return `$${Math.round(b / 1e6)}mm`;
  if (b >= 1e3)  return `$${Math.round(b / 1e3)}k`;
  return `$${Math.round(b)}`;
}

export function TapeHistoryPanel({
  tapes,
  dispositions,
  currentTapeId,
}: {
  /** Chronological order: v1 first, current tape last. */
  readonly tapes: readonly Tape[];
  readonly dispositions: readonly Disposition[];
  readonly currentTapeId: string | null;
}) {
  const model = computeCohortFlow(tapes, dispositions, currentTapeId);

  return (
    <section className="mb-6">
      <h2 className="text-sm font-semibold text-text-primary uppercase tracking-wide mb-3 font-sans">
        Pool evolution — tape by tape
      </h2>
      {model.nodes.length === 0 ? (
        <div className="bg-bg-secondary border border-border-primary rounded p-4 text-text-muted text-sm">
          No frozen tapes yet — this pool was just created.
        </div>
      ) : (
        <div
          className="border border-border-primary overflow-hidden rounded-panel shadow-card"
          style={{
            background: 'linear-gradient(180deg, #141A24, #11161f)',
            padding: '8px 8px 0',
          }}
        >
          <CohortFlowSVG nodes={model.nodes} useBalance={model.hasBalanceData} />
          <FlowLegend />
        </div>
      )}
    </section>
  );
}

function CohortFlowSVG({
  nodes,
  useBalance,
}: {
  readonly nodes: readonly TapeNode[];
  readonly useBalance: boolean;
}) {
  const xs = nodeXs(nodes.length);
  // Scale ribbon by the max seed (balance when present, count when not) so
  // the largest tape uses ~78% of the band.
  const maxSeed = Math.max(1, ...nodes.map(n => scaleSeed(n, useBalance)));
  const scale = ((H - PAD_T - PAD_B) * RIBBON_HEIGHT_PCT) / maxSeed;
  const halfNode = (n: TapeNode): number => (scaleSeed(n, useBalance) * scale) / 2;
  // Tributary width helper: takes a count + a balance and computes the visual
  // width using whichever axis the ribbon is scaled on.
  function flowHalf(count: number, balance: number | null): number {
    const seed = useBalance && balance !== null ? balance : count;
    return (seed * scale) / 2;
  }

  const ribbonPath = nodes.length >= 2 ? buildRibbonPath(nodes, xs, scale, useBalance) : null;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="block w-full h-auto"
      role="img"
      aria-label={`Pool evolution across ${nodes.length} tape${nodes.length === 1 ? '' : 's'}`}
    >
      <defs>
        <linearGradient id="cohort-band" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor={RIBBON_COLOR} stopOpacity="0.28" />
          <stop offset="1" stopColor={RIBBON_COLOR} stopOpacity="0.5" />
        </linearGradient>
      </defs>

      {/* Central ribbon — drawn only when there are 2+ tapes (no flows on a single tape). */}
      {ribbonPath !== null && (
        <path
          d={ribbonPath}
          fill="url(#cohort-band)"
          stroke={RIBBON_COLOR}
          strokeOpacity="0.55"
          strokeWidth="1"
        />
      )}

      {nodes.map((n, i) => {
        const x = xs[i]!;
        const ribbonHalf = nodes.length >= 2 ? halfNode(n) : 16; // single-node fallback
        const topY = MID_Y - ribbonHalf;
        const botY = MID_Y + ribbonHalf;
        const t = n.transitionFromPrior;

        return (
          <g key={n.tapeId}>
            {/* Origin eyebrow */}
            {n.isOrigin && (
              <text
                x={x}
                y={24 - 15}
                fill={RIBBON_COLOR}
                fontFamily="IBM Plex Sans"
                fontSize="9.5"
                fontWeight="600"
                letterSpacing="0.1em"
                textAnchor="middle"
              >
                ORIGIN
              </text>
            )}

            {/* Node tick + dot */}
            {nodes.length >= 2 && (
              <line
                x1={x}
                y1={topY}
                x2={x}
                y2={botY}
                stroke="#0C1118"
                strokeWidth="2"
                opacity="0.5"
              />
            )}
            <circle cx={x} cy={MID_Y} r="3.5" fill={RIBBON_COLOR} />

            {/* Added tributary (from top) */}
            {t !== null && t.added > 0 && (
              <g>
                <path
                  d={`M ${x - 46} ${topY - 34} C ${x - 26} ${topY - 34} ${x - 14} ${topY - 4} ${x} ${topY}`}
                  fill="none"
                  stroke={ADDED_COLOR}
                  strokeWidth={Math.max(3, flowHalf(t.added, t.addedBalance))}
                  strokeOpacity="0.5"
                  strokeLinecap="round"
                />
                <text
                  x={x - 48}
                  y={topY - 40}
                  fill={ADDED_COLOR}
                  fontFamily="IBM Plex Mono"
                  fontSize="12"
                  fontWeight="600"
                >
                  +{t.added}
                </text>
                {useBalance && t.addedBalance !== null && (
                  <text
                    x={x - 48}
                    y={topY - 26}
                    fill={MUTED}
                    fontFamily="IBM Plex Mono"
                    fontSize="10.5"
                  >
                    {fmtDollars(t.addedBalance)}
                  </text>
                )}
              </g>
            )}

            {/* Dropped tributary (below) */}
            {t !== null && t.dropped > 0 && (
              <g>
                <path
                  d={`M ${x} ${botY} C ${x + 14} ${botY + 4} ${x + 16} ${botY + 22} ${x + 30} ${botY + 26}`}
                  fill="none"
                  stroke={DROPPED_COLOR}
                  strokeWidth={Math.max(2.5, flowHalf(t.dropped, t.droppedBalance))}
                  strokeOpacity="0.7"
                  strokeLinecap="round"
                />
                <text
                  x={x + 34}
                  y={botY + 30}
                  fill={MUTED}
                  fontFamily="IBM Plex Mono"
                  fontSize="10.5"
                >
                  −{t.dropped} dropped{useBalance && t.droppedBalance !== null ? ` · ${fmtDollars(t.droppedBalance)}` : ''}
                </text>
              </g>
            )}

            {/* Kicked tributary (below; offset further when dropped is also present) */}
            {t !== null && t.kicked > 0 && (
              <g>
                {(() => {
                  const off = t.dropped > 0 ? 44 : 26;
                  return (
                    <>
                      <path
                        d={`M ${x} ${botY} C ${x + 14} ${botY + 6} ${x + 16} ${botY + off - 4} ${x + 30} ${botY + off}`}
                        fill="none"
                        stroke={KICKED_COLOR}
                        strokeWidth={Math.max(2.5, flowHalf(t.kicked, t.kickedBalance))}
                        strokeOpacity="0.75"
                        strokeLinecap="round"
                      />
                      <text
                        x={x + 34}
                        y={botY + off + 4}
                        fill={KICKED_COLOR}
                        fontFamily="IBM Plex Mono"
                        fontSize="10.5"
                      >
                        −{t.kicked} kicked{useBalance && t.kickedBalance !== null ? ` · ${fmtDollars(t.kickedBalance)}` : ''}
                      </text>
                    </>
                  );
                })()}
              </g>
            )}

            {/* Node label — date + current marker (top) */}
            <text
              x={x}
              y={24}
              fill={INK}
              fontFamily="IBM Plex Mono"
              fontSize="13"
              fontWeight="600"
              textAnchor="middle"
            >
              {formatTapeDate(n.tapeDate)}
              {n.isCurrent ? '  ●' : ''}
            </text>

            {/* Node label — loan count (bottom). */}
            <text
              x={x}
              y={H - 26}
              fill={INK_2}
              fontFamily="IBM Plex Mono"
              fontSize="13"
              fontWeight="500"
              textAnchor="middle"
            >
              {n.loanCount} {n.loanCount === 1 ? 'loan' : 'loans'}
            </text>
            {/* Per-node total balance — shown when present (reseed PR B). When
                absent (synthetic data), version label takes its place. */}
            <text
              x={x}
              y={H - 11}
              fill={MUTED}
              fontFamily="IBM Plex Mono"
              fontSize="11"
              textAnchor="middle"
            >
              {useBalance && n.totalBalance !== null ? fmtDollars(n.totalBalance) : `v${n.version}`}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function FlowLegend() {
  return (
    <div className="flex gap-5 flex-wrap text-xs text-text-muted font-sans" style={{ padding: '4px 16px 16px' }}>
      <LegendItem color={RIBBON_COLOR} label="Pool on tape" />
      <LegendItem color={ADDED_COLOR}  label="Added" />
      <LegendItem color={DROPPED_COLOR} label="Dropped (originator)" />
      <LegendItem color={KICKED_COLOR}  label="Kicked (buyer)" />
    </div>
  );
}

function LegendItem({ color, label }: { readonly color: string; readonly label: string }) {
  return (
    <span className="flex items-center gap-2">
      <i
        className="inline-block"
        style={{ width: '11px', height: '11px', borderRadius: '3px', background: color }}
        aria-hidden
      />
      {label}
    </span>
  );
}

/** Short tape-date label (e.g. "Jan 02"). */
function formatTapeDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { month: 'short', day: '2-digit' });
}
