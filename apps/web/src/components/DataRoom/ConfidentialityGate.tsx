'use client';

/**
 * Confidentiality gate (Chunk 3c) — buyer-side. Shown before the data room renders
 * when the buyer has a grant but hasn't accepted the confidentiality agreement.
 * Accept → records the acceptance (logged who/when/IP/version) + unlocks entry.
 * Decline → back to the deal list, no access.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api-client';

export function ConfidentialityGate({
  poolId,
  agreementVersion,
  onAccepted,
}: {
  poolId: string;
  agreementVersion: string;
  onAccepted: () => void;
}) {
  const router = useRouter();
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function accept() {
    setBusy(true);
    setErr(null);
    try {
      await api.acceptConfidentiality(poolId);
      onAccepted();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto mt-10 max-w-xl rounded-lg border border-border-primary bg-bg-secondary p-6">
      <h1 className="text-lg font-semibold text-text-primary">Confidentiality agreement</h1>
      <p className="mt-1 text-xs text-text-secondary">Version {agreementVersion}</p>
      <div className="mt-4 max-h-64 overflow-y-auto rounded border border-border-primary bg-bg-tertiary p-3 text-sm text-text-secondary">
        <p>
          The materials in this data room are strictly confidential and provided solely to evaluate a
          potential transaction. By entering, you confirm that you are the intended recipient, that you
          will keep all materials confidential, will not copy, distribute, or use them for any purpose
          other than this evaluation, and will destroy or return them on request. Access is logged.
        </p>
      </div>
      <label className="mt-4 flex items-start gap-2 text-sm text-text-primary">
        <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-0.5" />
        <span>I confirm I am the intended recipient and agree to keep these materials confidential.</span>
      </label>
      <div className="mt-5 flex items-center gap-2">
        <button
          type="button"
          onClick={accept}
          disabled={!confirmed || busy}
          className="rounded-md border border-accent/40 bg-accent-soft px-4 py-2 text-sm text-accent hover:opacity-80 disabled:opacity-50"
        >
          {busy ? 'Recording…' : 'Accept & enter'}
        </button>
        <button
          type="button"
          onClick={() => router.push('/pools')}
          className="rounded-md px-4 py-2 text-sm text-text-secondary hover:text-text-primary"
        >
          Decline
        </button>
        {err && <span className="text-xs text-score-weak">{err}</span>}
      </div>
    </div>
  );
}
