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
import { useState, type ReactNode } from 'react';
import { SiteVisitChecklist } from './SiteVisitChecklist';
import { SitePhotos } from './SitePhotos';
import { PortfolioStructure } from './PortfolioStructure';
import { Comps } from './Comps';
import { LeaseComps } from './LeaseComps';
import { SiteInspection } from './SiteInspection';
import { ServicerNarrativeInput } from './ServicerNarrativeInput';
import type { AssetType } from '@cre/contracts';

/** A titled, divided section grouping one or more servicer-input widgets. Pure layout —
 *  an eyebrow header (which workbook area it feeds) + calm spacing; dividers come from the
 *  parent's `divide-y`. Matches the deal-room's existing token styling. */
function Group({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <section className="space-y-3 p-4">
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-text-secondary">{title}</span>
        <span className="text-[10px] text-text-muted">{hint}</span>
      </div>
      {children}
    </section>
  );
}

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
        <span className="text-sm font-medium text-text-primary">Servicer inputs — field notes, inspection, photos, comps, portfolio</span>
        <span className="text-[11px] text-text-muted">{open ? '▾' : '▸'} display-only</span>
      </button>
      {open && (
        <div className="divide-y divide-border-primary border-t border-border-primary">
          {/* Narratives — the servicer's field observations, feeding the memo / narrative slots. */}
          <Group title="Field notes" hint="Site-visit + broker narrative">
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
          </Group>

          {/* Inspection — the checklist + the structured Site Inspection form (fills the tab). */}
          <Group title="Site Inspection" hint="Checklist + inspection form → Site Inspection tab">
            <SiteVisitChecklist poolId={poolId} loanInPoolId={loanInPoolId} assetType={assetType} />
            <SiteInspection poolId={poolId} loanInPoolId={loanInPoolId} />
          </Group>

          {/* Photos — uploaded site photos → Site Photos tab. */}
          <Group title="Site Photos" hint="Uploaded photos → Site Photos tab">
            <SitePhotos poolId={poolId} loanInPoolId={loanInPoolId} />
          </Group>

          {/* Comparables — sales + lease comps → the Sales/Lease Comps tabs. */}
          <Group title="Comparables" hint="Sales + lease comps → Comps tabs">
            <Comps poolId={poolId} loanInPoolId={loanInPoolId} />
            <LeaseComps poolId={poolId} loanInPoolId={loanInPoolId} assetType={assetType} />
          </Group>

          {/* Portfolio — the N-property definition (drives the rollup export). */}
          <Group title="Portfolio" hint="Multi-property definition → rollup export">
            <PortfolioStructure poolId={poolId} loanInPoolId={loanInPoolId} />
          </Group>
        </div>
      )}
    </section>
  );
}
