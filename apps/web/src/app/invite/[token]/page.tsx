'use client';

/**
 * Buyer accept page (Chunk 3d) — /invite/[token].
 * Previews the invite, then Accept → creates the explicit buyer deal_access grant
 * and lands them in the resource. (Access still pends the confidentiality gate, 3c.)
 */
import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { api } from '@/lib/api-client';

type Invite = { resourceType: 'deal' | 'pool'; resourceKey: string; invitedEmail: string | null; expiresAt: string };
type State = 'loading' | 'valid' | 'invalid' | 'accepting' | 'accepted' | 'error';

export default function InviteAcceptPage() {
  const params = useParams();
  const token = String((params as { token?: string }).token ?? '');
  const router = useRouter();
  const [state, setState] = useState<State>('loading');
  const [invite, setInvite] = useState<Invite | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const inv = await api.getInvite(token);
        if (!cancelled) { setInvite(inv); setState('valid'); }
      } catch {
        if (!cancelled) setState('invalid');
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  const accept = useCallback(async () => {
    setState('accepting');
    setErr(null);
    try {
      const r = await api.acceptInvite(token);
      setState('accepted');
      setTimeout(() => {
        router.push(r.resourceType === 'pool' ? `/pools/${r.resourceKey}/data-room` : '/pools');
      }, 900);
    } catch (e) {
      setErr((e as Error).message);
      setState('error');
    }
  }, [token, router]);

  return (
    <div className="mx-auto mt-16 max-w-md rounded-lg border border-border-primary bg-bg-secondary p-6">
      <h1 className="text-lg font-semibold text-text-primary">Deal invitation</h1>

      {state === 'loading' && <p className="mt-3 text-sm text-text-secondary">Checking your invitation…</p>}

      {(state === 'invalid') && (
        <p className="mt-3 text-sm text-score-weak">This invitation is invalid or has expired.</p>
      )}

      {(state === 'valid' || state === 'accepting' || state === 'error') && invite && (
        <>
          <p className="mt-3 text-sm text-text-secondary">
            You&apos;ve been invited to a {invite.resourceType === 'pool' ? 'data room' : 'deal'}.
          </p>
          <p className="mt-1 font-mono text-xs text-text-secondary">{invite.resourceKey}</p>
          {invite.invitedEmail && (
            <p className="mt-2 text-xs text-text-secondary">Bound to {invite.invitedEmail} — sign in as that account to accept.</p>
          )}
          <button
            type="button"
            onClick={accept}
            disabled={state === 'accepting'}
            className="mt-5 w-full rounded-md border border-accent/40 bg-accent-soft px-4 py-2 text-sm text-accent hover:opacity-80 disabled:opacity-50"
          >
            {state === 'accepting' ? 'Accepting…' : 'Accept invitation'}
          </button>
          {err && <p className="mt-2 text-xs text-score-weak">{err}</p>}
        </>
      )}

      {state === 'accepted' && (
        <p className="mt-3 text-sm text-score-strong">Accepted — taking you to the data room…</p>
      )}
    </div>
  );
}
