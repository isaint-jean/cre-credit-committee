'use client';

// Pass 4b — /deal-room is retired. The deal room now lives at /analysis/[id]
// (one canonical URL). This route redirects for any lingering links.
import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';

export default function DealRoomRedirect() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  useEffect(() => { router.replace(`/analysis/${id}`); }, [id, router]);
  return null;
}
