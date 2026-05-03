'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { AuthProvider, useAuth } from '@/lib/auth';

function AppContent({ children }: { children: React.ReactNode }) {
  const { user, logout, isLoading } = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  const isLoginPage = pathname === '/login';

  useEffect(() => {
    if (!isLoading && !user && !isLoginPage) {
      router.push('/login');
    }
  }, [user, isLoading, isLoginPage, router]);

  // Show nothing while checking auth state
  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-sm text-text-muted">Loading...</div>
      </div>
    );
  }

  // Login page renders without header
  if (isLoginPage) {
    return <>{children}</>;
  }

  // Not logged in, will redirect
  if (!user) {
    return null;
  }

  return (
    <>
      <header className="border-b border-border-primary bg-bg-secondary px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-2 h-2 bg-accent rounded-full" />
          <span className="text-sm font-semibold tracking-wide text-text-primary">
            CRE CREDIT COMMITTEE
          </span>
        </div>
        <nav className="flex items-center gap-4 text-xs text-text-secondary">
          <a href="/" className="hover:text-text-primary transition-colors">Home</a>
          <a href="/analysis/new" className="hover:text-text-primary transition-colors">New Analysis</a>
          <a href="/admin/criteria" className="hover:text-text-primary transition-colors">Criteria</a>
          <a href="/admin/underwriting-library" className="hover:text-text-primary transition-colors">UW Library</a>
          <a href="/admin/underwriting-insights" className="hover:text-text-primary transition-colors">UW Insights</a>
          <span className="text-text-muted">|</span>
          <span className="text-text-muted">{user.email}</span>
          <button
            onClick={logout}
            className="hover:text-text-primary transition-colors"
          >
            Sign Out
          </button>
        </nav>
      </header>
      <main>{children}</main>
    </>
  );
}

export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <AppContent>{children}</AppContent>
    </AuthProvider>
  );
}
