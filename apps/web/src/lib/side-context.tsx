'use client';

/* -------------------------------------------------------------------------- */
/* Side context — the effective side is now DERIVED FROM the logged-in user's  */
/* role (role-siloing chunk 3), not just the URL:                             */
/*   ORIGINATOR/BUYER → forced to their side (?side cannot override);          */
/*   ADMIN + internal roles + logged-out → the URL `?side` (else Platform).    */
/* This makes every existing useSide() consumer real role-driven siloing with  */
/* no rewrites, while preserving ADMIN's ?side override (QA views each side).   */
/*                                                                            */
/* useSearchParams() opts a subtree into client-side rendering in Next 14 and  */
/* MUST be wrapped in <Suspense>, so the actual reader lives in an inner        */
/* component and the provider renders it under a Suspense boundary. The reader  */
/* sits inside AuthProvider (see auth-shell.tsx), so useAuth() is available.    */
/* -------------------------------------------------------------------------- */

import { createContext, useContext, Suspense, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import { useAuth } from './auth';
import { deriveSide } from './derive-side';

export type Side = 'originator' | 'buyer';

const SideContext = createContext<Side | null>(null);

function parseSide(raw: string | null): Side | null {
  return raw === 'originator' || raw === 'buyer' ? raw : null;
}

function SideReader({ children }: { children: ReactNode }) {
  const params = useSearchParams();
  const { user } = useAuth();
  // Role forces the side for ORIGINATOR/BUYER; ADMIN + internal + logged-out keep ?side.
  const side = deriveSide(user?.role, parseSide(params.get('side')));
  return <SideContext.Provider value={side}>{children}</SideContext.Provider>;
}

export function SideProvider({ children }: { children: ReactNode }) {
  // Suspense fallback also provides the context (null side) so consumers never
  // read outside a provider while the search params resolve.
  return (
    <Suspense
      fallback={<SideContext.Provider value={null}>{children}</SideContext.Provider>}
    >
      <SideReader>{children}</SideReader>
    </Suspense>
  );
}

export function useSide(): Side | null {
  return useContext(SideContext);
}
