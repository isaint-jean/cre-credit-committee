import type { Config } from 'tailwindcss';

// Visual pass PR 1 — Token system aligned to the prototype
// (~/Downloads/cre-pool-rail.html, the design source).
//
// Brand is TEAL (#3FA7A0) — not amber. Fonts are the IBM Plex family
// (Sans body / Serif headers / Mono ids+numbers). Canvas + panels carry the
// prototype's four-tier layering; text + hairlines carry the prototype's
// four-tier shading.
//
// Backward-compatibility: every existing token key the components reference
// (`bg-bg-{primary,secondary,tertiary}`, `text-text-{primary,secondary,muted}`,
// `border-border-{primary,secondary}`, `accent`, `risk`, `score`) is preserved
// — only its VALUE changed. The ~970 existing className refs cascade. New
// tokens (`bg.quaternary`, `text.subtle`, `status.new`, `status.call`,
// `border.subtle`, fontFamily.serif) are ADDITIVE.
const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        // RELIGHT (1a) — flipped to the deal-room light palette (one source of truth).
        bg: {
          primary:    '#F5F7F8', // canvas
          secondary:  '#FFFFFF', // surface
          tertiary:   '#FBFCFC', // surface-2
          quaternary: '#FFFFFF', // elevated chips, popovers
        },
        border: {
          primary:   '#E2E8EA', // hairline
          secondary: '#CCD6D9', // border-strong
          subtle:    '#CCD6D9', // alias — border-strong
        },
        text: {
          primary:   '#15262C', // ink
          secondary: '#4A5C62', // ink-2
          muted:     '#8A979C', // ink-3
          subtle:    '#8A979C', // ink-3
        },
        // Brand teal — deal-room teal. `accent.DEFAULT` is the brand color,
        // `accent.hover` is the deep variant, `accent.soft` the tinted fill.
        accent: {
          DEFAULT: '#0C6E78', // teal
          hover:   '#0A555D', // teal-deep
          soft:    '#E6F1F2', // tealSoft (tinted fill)
        },
        risk: {
          critical: '#AE3A33', // kicked
          high:     '#AE3A33', // kicked
          medium:   '#A9641F', // flagged
          low:      '#8A979C', // ink-3
          positive: '#2E7D5B', // resolved
        },
        score: {
          strong:     '#2E7D5B', // resolved
          acceptable: '#A9641F', // flagged
          watchlist:  '#A9641F', // flagged
          high_risk:  '#AE3A33', // kicked
        },
        // New status families the prototype uses; tokens added now so the
        // later port PRs (Sankey, new-tape interrupt, negotiation actions)
        // can consume them without retouching Tailwind config.
        status: {
          new:  '#48B0C9', // --new   (cyan, "just-arrived" loans on a tape)
          call: '#8093E6', // --call  (lavender, "request a call" / in-negotiation)
        },

        // ── Two-facing port (P1) — one source of truth for the two-door /
        // side-identity system, ported from docs/mockups/cre-two-facing-mockup.jsx
        // token object `C` (lines 8-23). Teal `accent` above stays the
        // PLATFORM / neutral color (chrome ground, deal-room); these carry SIDE
        // identity + the mockup's ink/paper/cleared/warn names so P2–P4 can
        // reach them as Tailwind classes.

        // Originator — warm ochre (advocacy, winning the borrower).
        originator: {
          DEFAULT: '#A8742A',
          soft:    '#F4EAD6',
        },
        // B-piece buyer — cool steel (skeptical, conservative, first-loss).
        buyer: {
          DEFAULT: '#2F5E86',
          soft:    '#E0E9F1',
        },

        // Mockup surface + semantic names (C.ink/paper/card/line/cleared/warn).
        // `card` (#FFFFFF) already equals bg.secondary; `paper`/`line` map onto
        // the light surface but are named here so the mockup port reads 1:1.
        ink:     { DEFAULT: '#111A26', soft: '#1B2838' },
        paper:   '#EEF1F4', // mockup canvas (≈ bg.primary)
        card:    '#FFFFFF', // mockup surface (= bg.secondary)
        line:    '#D3DAE2', // mockup hairline (≈ border.primary)
        cleared: '#2E7D57', // convergence / agreed
        warn:    '#B5532B', // last-resort / caution
      },
      fontFamily: {
        // Body — Plex Sans. Headers default to serif (override at component
        // level: `font-serif`). Mono for ids + numbers with tabular-nums
        // applied via globals.css `.mono`.
        sans:  ['"IBM Plex Sans"',  'system-ui', 'sans-serif'],
        serif: ['"IBM Plex Serif"', 'Georgia', 'serif'],
        mono:  ['"IBM Plex Mono"',  'ui-monospace', 'Menlo', 'monospace'],

        // ── Two-facing port (P1) type roles (mockup lines 24-26).
        // `display` = Space Grotesk (h1/wordmark), `body` = Inter, `mono` above
        // doubles as the mockup MONO. Fonts imported in globals.css.
        display: ['"Space Grotesk"', '"IBM Plex Serif"', 'sans-serif'],
        body:    ['"Inter"', '"IBM Plex Sans"', 'system-ui', 'sans-serif'],
      },
      borderRadius: {
        // Prototype uses 11px panels, 7px small. Add named tokens so
        // component refresh PRs can opt into them cleanly.
        panel: '11px',
        sm2:   '7px',
      },
      boxShadow: {
        // Soft drop + subtle top-edge highlight, per prototype's --shadow.
        card: '0 1px 0 rgba(255,255,255,.02), 0 10px 30px -14px rgba(0,0,0,.65)',
      },
    },
  },
  plugins: [],
};

export default config;
