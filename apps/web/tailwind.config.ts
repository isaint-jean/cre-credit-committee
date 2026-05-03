import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        bg: {
          primary: '#0A0E17',
          secondary: '#111827',
          tertiary: '#1A2332',
        },
        border: {
          primary: '#1F2937',
          secondary: '#374151',
        },
        text: {
          primary: '#E5E7EB',
          secondary: '#9CA3AF',
          muted: '#6B7280',
        },
        accent: {
          DEFAULT: '#F59E0B',
          hover: '#D97706',
        },
        risk: {
          critical: '#DC2626',
          high: '#EF4444',
          medium: '#F59E0B',
          low: '#6B7280',
          positive: '#10B981',
        },
        score: {
          strong: '#10B981',
          acceptable: '#F59E0B',
          watchlist: '#F97316',
          high_risk: '#EF4444',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
};

export default config;
