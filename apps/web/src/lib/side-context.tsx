'use client';

/* -------------------------------------------------------------------------- */
/* Side context (P1) — reads `?side=originator|buyer` from the URL and exposes  */
/* it to the chrome (accent + breadcrumb label). FRONTEND-ONLY: no             */
/* persistence, no backend, no cookies — the URL is the single source of truth.*/
/*                                                                            */
/* useSearchParams() opts a subtree into client-side rendering in Next 14 and  */
/* MUST be wrapped in <Suspense>, so the actual reader lives in an inner        */
/* component and the provider renders it under a Suspense boundary.            */
/* -------------------------------------------------------------------------- */

import { createContext, useContext, Suspense, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';

export type Side = 'originator' | 'buyer';

const SideContext = createContext<Side | null>(null);

function parseSide(raw: string | null): Side | null {
  return raw === 'originator' || raw === 'buyer' ? raw : null;
}

function SideReader({ children }: { children: ReactNode }) {
  const params = useSearchParams();
  const side = parseSide(params.get('side'));
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
