import type { Metadata } from 'next';
import './globals.css';
import { AuthShell } from '@/components/auth-shell';

export const metadata: Metadata = {
  title: 'CRE Credit Committee',
  description: 'Institutional-grade AI-powered commercial real estate credit analysis',
};

// This is an auth-gated, client-rendered app: every page reads `?side` via useSearchParams
// (useSide) and gates on the JWT — nothing is statically cacheable. Force dynamic rendering
// app-wide so `next build` does NOT attempt to statically prerender these pages (which fails
// with the useSearchParams "missing-suspense-with-csr-bailout" error). Surfaced by the first
// production build (the app had only ever run via `next dev`). No effect on `next dev`.
export const dynamic = 'force-dynamic';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen antialiased">
        <AuthShell>{children}</AuthShell>
      </body>
    </html>
  );
}
