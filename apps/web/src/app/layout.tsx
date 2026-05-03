import type { Metadata } from 'next';
import './globals.css';
import { AuthShell } from '@/components/auth-shell';

export const metadata: Metadata = {
  title: 'CRE Credit Committee',
  description: 'Institutional-grade AI-powered commercial real estate credit analysis',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-bg-primary antialiased">
        <AuthShell>{children}</AuthShell>
      </body>
    </html>
  );
}
