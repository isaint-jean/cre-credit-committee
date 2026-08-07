// Role + permission contract (Phase 4 - productization layer).
//
// Authorization model is API-boundary-only. The core domain (producers, render,
// projections, stores) does NOT branch on roles. Role checks happen exclusively in
// route handler middleware before any domain function is invoked.
//
// This module is types + closed enums + a permission matrix. No execution logic.
// The middleware that enforces these checks lives in apps/api/src/middleware/.

export const ROLES = [
  'VIEWER',
  'ANALYST',
  'CREDIT_OFFICER',
  'COMMITTEE_MEMBER',
  'ADMIN',
  // Role-siloing chunk 1 (additive). Two-sided deal roles, distinct from the internal
  // credit-shop ladder above. ORIGINATOR (bank/seller) prepares + negotiates but CANNOT
  // self-approve; BUYER (B-piece, first-loss) is the approver/rejecter. Side-from-role
  // wiring and route gating are later chunks — these just make the roles exist + persist.
  'ORIGINATOR',
  'BUYER',
] as const;
export type Role = (typeof ROLES)[number];

// Closed enum of permission identifiers. Each corresponds to one capability that a
// role may or may not exercise at the API boundary.
export const PERMISSIONS = [
  // Workflow read-side (anyone authenticated may read state for a deal they can see).
  'workflow:read',
  // Committee write actions (lifecycle transitions).
  'workflow:submit',          // SUBMIT_TO_COMMITTEE
  'workflow:request-info',    // REQUEST_MORE_INFO
  'workflow:override',        // OVERRIDE_DECISION
  'workflow:approve',         // APPROVE_DEAL
  'workflow:reject',          // REJECT_DEAL
  'workflow:postpone',        // POSTPONE_DEAL
  // Chunk 7a (additive) — originator negotiation/comms actions (not yet wired to
  // event kinds/UI; those are 7b/7c). Held by ORIGINATOR (+ ADMIN superset).
  'workflow:respond',         // push back on a buyer requirement/decision
  'workflow:request-call',    // request a call with the buyer
  'workflow:send-to-buyer',   // submit the seller UW to the buyer
  // The buyer's kick / disposition (per-loan negative terminal). Buyer-authoritative
  // (first-loss) + COMMITTEE_MEMBER/ADMIN; the ORIGINATOR must NOT hold it (can't kick
  // their own deal — mirror of "can't self-approve").
  'workflow:dispose',         // dispositionLoan (kicked/dropped)
  // Audit / replay (read-only history).
  'audit:read',
  // Snapshots.
  'snapshot:read',
  'snapshot:create',
  // Registry (LibrarySnapshot / MarketBenchmarks / CreditManifesto admin write).
  // Read-side is just authenticated; only POST goes through this permission.
  'registry:write',
  // Revision creation on an analysis lineage (POST /api/analyses/:id/revisions).
  // Gates both the legacy and the new-spine branches (option C / issue #20, step 8.6).
  // Held by ANALYST / CREDIT_OFFICER / ADMIN — not COMMITTEE_MEMBER (separation of
  // duties: committee reviews and approves/rejects; editing assumptions is upstream).
  'analysis:revise',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

// Role -> permission matrix. Each role has a fixed set of permissions; no
// inheritance hierarchy in v1. Derived roles can be added by listing all the
// underlying permissions explicitly.
export const ROLE_PERMISSIONS: { readonly [R in Role]: readonly Permission[] } = {
  // Read-only legacy/observer role. Reads (which are only requireAuth-gated)
  // remain accessible; every permission-gated endpoint fails uniformly with
  // PERMISSION_DENIED for VIEWER users. Maps from the legacy 'viewer' role in
  // sqlite-store (see auth.routes.ts boundary translation).
  VIEWER: [],
  ANALYST: [
    'workflow:read',
    'workflow:submit',
    'workflow:override',
    'audit:read',
    'snapshot:read',
    'snapshot:create',
    'analysis:revise',
  ],
  CREDIT_OFFICER: [
    'workflow:read',
    'workflow:submit',
    'workflow:request-info',
    'workflow:override',
    'audit:read',
    'snapshot:read',
    'snapshot:create',
    'analysis:revise',
  ],
  COMMITTEE_MEMBER: [
    'workflow:read',
    'workflow:request-info',
    'workflow:approve',
    'workflow:reject',
    'workflow:postpone',
    'workflow:dispose',        // ch.7a: internal terminal-reject authority (keeps the kick)
    'audit:read',
    'snapshot:read',
  ],
  ADMIN: [
    'workflow:read',
    'workflow:submit',
    'workflow:request-info',
    'workflow:override',
    'workflow:approve',
    'workflow:reject',
    'workflow:postpone',
    'audit:read',
    'snapshot:read',
    'snapshot:create',
    'registry:write',
    'analysis:revise',
    // ch.7a: ADMIN superset — the originator comms perms + the kick.
    'workflow:respond',
    'workflow:request-call',
    'workflow:send-to-buyer',
    'workflow:dispose',
  ],
  // ── Role-siloing chunk 1 (additive; existing roles above unchanged) ──────────
  // ORIGINATOR (bank/seller): prepares + negotiates the deal but CANNOT self-approve.
  //   read + audit/snapshot read · analysis:revise (revise / upload docs) ·
  //   workflow:override (negotiate — ratify a mitigant / post overlay comments).
  //   Deliberately NO workflow:approve / workflow:reject / workflow:submit.
  ORIGINATOR: [
    'workflow:read',
    'audit:read',
    'snapshot:read',
    'analysis:revise',
    'workflow:override',
    // ch.7a: the originator's negotiation/comms actions (not yet wired — 7b/7c).
    // Deliberately NO workflow:dispose — the originator cannot kick their own deal.
    'workflow:respond',
    'workflow:request-call',
    'workflow:send-to-buyer',
  ],
  // BUYER (B-piece, first-loss): the approver/rejecter of the deal.
  //   read + audit/snapshot read · workflow:request-info · workflow:override
  //   (negotiate) · workflow:approve + workflow:reject (the first-loss verdict).
  //   Deliberately NO workflow:submit (deal-team step) and NO analysis:revise
  //   (does not revise the seller's underwriting).
  BUYER: [
    'workflow:read',
    'audit:read',
    'snapshot:read',
    'workflow:request-info',
    'workflow:override',
    'workflow:approve',
    'workflow:reject',
    'workflow:dispose',        // ch.7a: the buyer's kick (first-loss negative terminal)
  ],
} as const;

// Pure check: does the given role hold the given permission? No I/O, no branching
// on environment. Used by the boundary middleware to gate routes.
export function roleHasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].indexOf(permission) >= 0;
}
