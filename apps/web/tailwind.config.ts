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
        bg: {
          primary:    '#0C1118', // --canvas
          secondary:  '#141A24', // --panel
          tertiary:   '#1A2230', // --panel-2
          quaternary: '#222C3C', // --panel-3 (NEW — elevated chips, popovers)
        },
        border: {
          primary:   '#28323F', // --hair
          secondary: '#1F2733', // --hair-soft  (the lighter hairline)
          subtle:    '#1F2733', // alias — semantic name for hair-soft
        },
        text: {
          primary:   '#E9EDF3', // --ink
          secondary: '#AAB4C4', // --ink-2
          muted:     '#7E8A9C', // --muted
          subtle:    '#5C6677', // --muted-2 (NEW — fourth tier)
        },
        // Brand teal — replaces amber. `accent.DEFAULT` is the brand color,
        // `accent.hover` is the dimmed variant. All existing `bg-accent`,
        // `text-accent`, `hover:bg-accent-hover` refs cascade.
        accent: {
          DEFAULT: '#3FA7A0', // --brand
          hover:   '#2C7570', // --brand-dim
        },
        risk: {
          critical: '#D46A6A', // align with prototype's kick palette
          high:     '#D46A6A', // --kick  (the primary kick/danger color)
          medium:   '#E0973F', // --flag  (distinct from accent now — they conflicted before)
          low:      '#7E8A9C', // align with --muted
          positive: '#4FB17C', // --accept
        },
        score: {
          strong:     '#4FB17C', // --accept
          acceptable: '#E0973F', // --flag
          watchlist:  '#E0973F', // hold for a future distinction
          high_risk:  '#D46A6A', // --kick
        },
        // New status families the prototype uses; tokens added now so the
        // later port PRs (Sankey, new-tape interrupt, negotiation actions)
        // can consume them without retouching Tailwind config.
        status: {
          new:  '#48B0C9', // --new   (cyan, "just-arrived" loans on a tape)
          call: '#8093E6', // --call  (lavender, "request a call" / in-negotiation)
        },
      },
      fontFamily: {
        // Body — Plex Sans. Headers default to serif (override at component
        // level: `font-serif`). Mono for ids + numbers with tabular-nums
        // applied via globals.css `.mono`.
        sans:  ['"IBM Plex Sans"',  'system-ui', 'sans-serif'],
        serif: ['"IBM Plex Serif"', 'Georgia', 'serif'],
        mono:  ['"IBM Plex Mono"',  'ui-monospace', 'Menlo', 'monospace'],
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
