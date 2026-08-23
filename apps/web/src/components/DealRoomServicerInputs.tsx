'use client';

/**
 * DealRoomServicerInputs — mounts the servicer inputs (site-visit + broker narrative
 * + the site-visit/PCR checklist) on the analysis deal-room, where the servicer lands
 * via "Open underwriting". Same components / same fieldTypes as the pool loan page, so
 * they read/write the SAME servicer_inputs store (keyed by pool+loan+fieldType) — a note
 * entered here shows on the loan page and vice-versa.
 *
 * The deal-room only holds data.rootId; the parent resolves the pool coordinates
 * (poolId/loanInPoolId/assetType) via GET /pools/loan-for-root/:rootId and passes them in.
 * Collapsible so it doesn't crowd the deal-room. DISPLAY-ONLY / MINT-SAFE; gating lives
 * inside the child components (servicer edits, buyer/admin read-only).
 */
import { useState } from 'react';
import { SiteVisitChecklist } from './SiteVisitChecklist';
import { SitePhotos } from './SitePhotos';
import { PortfolioStructure } from './PortfolioStructure';
import { Comps } from './Comps';
import { ServicerNarrativeInput } from './ServicerNarrativeInput';
import type { AssetType } from '@cre/contracts';

export function DealRoomServicerInputs({
  poolId,
  loanInPoolId,
  assetType,
}: {
  poolId: string;
  loanInPoolId: string;
  assetType: AssetType | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="mb-4 rounded-lg border border-border-primary bg-bg-secondary">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
        aria-expanded={open}
      >
        <span className="text-sm font-medium text-text-primary">Servicer inputs — site visit, broker feedback, checklist</span>
        <span className="text-[11px] text-text-muted">{open ? '▾' : '▸'} display-only</span>
      </button>
      {open && (
        <div className="space-y-4 border-t border-border-primary p-4">
          <div className="grid gap-4 md:grid-cols-2">
            <ServicerNarrativeInput
              poolId={poolId} loanInPoolId={loanInPoolId} fieldType="site_visit"
              label="Site visit" eyebrow="Servicer field observation"
              placeholder="What the servicer saw on site — condition, deferred maintenance, occupancy, anything a spreadsheet won't tell you."
            />
            <ServicerNarrativeInput
              poolId={poolId} loanInPoolId={loanInPoolId} fieldType="broker_feedback"
              label="Broker feedback" eyebrow="Servicer broker call"
              placeholder="What the broker said — market tone, leasing velocity, comparable deals, buyer/seller sentiment."
            />
          </div>
          <SiteVisitChecklist poolId={poolId} loanInPoolId={loanInPoolId} assetType={assetType} />
          <SitePhotos poolId={poolId} loanInPoolId={loanInPoolId} />
          <Comps poolId={poolId} loanInPoolId={loanInPoolId} />
          <PortfolioStructure poolId={poolId} loanInPoolId={loanInPoolId} />
        </div>
      )}
    </section>
  );
}
