'use client';

/**
 * Invite-buyer control (Chunk 3d) — originator/admin only. Mints a single-use pool
 * invite and shows the copyable /invite/<token> link (optionally email-bound). The
 * link is produced client-side for the originator to share — nothing is auto-sent.
 */
import { useState } from 'react';
import { api } from '@/lib/api-client';

export function InviteBuyerButton({ poolId }: { poolId: string }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function mint() {
    setBusy(true);
    setErr(null);
    setLink(null);
    try {
      const inv = await api.createInvite({
        resourceType: 'pool',
        resourceKey: poolId,
        invitedEmail: email.trim() || undefined,
      });
      const origin = typeof window !== 'undefined' ? window.location.origin : '';
      setLink(`${origin}${inv.acceptUrl}`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="rounded-md border border-border-primary px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary"
      >
        Invite buyer
      </button>
      {open && (
        <div className="absolute right-0 z-10 mt-2 w-80 rounded-lg border border-border-primary bg-bg-secondary p-3 shadow-lg">
          <p className="text-xs text-text-secondary">Invite a buyer to this data room. Share the generated link.</p>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Bind to a buyer email (optional)"
            className="mt-2 w-full rounded border border-border-primary bg-bg-tertiary px-2 py-1 text-sm text-text-primary"
          />
          <button
            type="button"
            onClick={mint}
            disabled={busy}
            className="mt-2 w-full rounded border border-accent/40 bg-accent-soft px-3 py-1.5 text-sm text-accent hover:opacity-80 disabled:opacity-50"
          >
            {busy ? 'Generating…' : 'Generate invite link'}
          </button>
          {err && <p className="mt-2 text-xs text-score-weak">{err}</p>}
          {link && (
            <div className="mt-2">
              <p className="text-xs text-text-secondary">Copy this link and send it to the buyer:</p>
              <div className="mt-1 flex gap-1">
                <input readOnly value={link} className="w-full rounded border border-border-primary bg-bg-tertiary px-2 py-1 text-xs text-text-primary" />
                <button
                  type="button"
                  onClick={() => { void navigator.clipboard?.writeText(link); }}
                  className="rounded border border-border-primary px-2 py-1 text-xs text-text-secondary hover:text-text-primary"
                >
                  Copy
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
