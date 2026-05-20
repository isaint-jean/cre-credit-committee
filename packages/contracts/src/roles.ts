// Role + permission contract (Phase 4 - productization layer).
//
// Authorization model is API-boundary-only. The core domain (producers, render,
// projections, stores) does NOT branch on roles. Role checks happen exclusively in
// route handler middleware before any domain function is invoked.
//
// This module is types + closed enums + a permission matrix. No execution logic.
// The middleware that enforces these checks lives in apps/api/src/middleware/.

export const ROLES = [
  'ANALYST',
  'CREDIT_OFFICER',
  'COMMITTEE_MEMBER',
  'ADMIN',
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
  // Audit / replay (read-only history).
  'audit:read',
  // Snapshots.
  'snapshot:read',
  'snapshot:create',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

// Role -> permission matrix. Each role has a fixed set of permissions; no
// inheritance hierarchy in v1. Derived roles can be added by listing all the
// underlying permissions explicitly.
export const ROLE_PERMISSIONS: { readonly [R in Role]: readonly Permission[] } = {
  ANALYST: [
    'workflow:read',
    'workflow:submit',
    'workflow:override',
    'audit:read',
    'snapshot:read',
    'snapshot:create',
  ],
  CREDIT_OFFICER: [
    'workflow:read',
    'workflow:submit',
    'workflow:request-info',
    'workflow:override',
    'audit:read',
    'snapshot:read',
    'snapshot:create',
  ],
  COMMITTEE_MEMBER: [
    'workflow:read',
    'workflow:request-info',
    'workflow:approve',
    'workflow:reject',
    'workflow:postpone',
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
  ],
} as const;

// Pure check: does the given role hold the given permission? No I/O, no branching
// on environment. Used by the boundary middleware to gate routes.
export function roleHasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].indexOf(permission) >= 0;
}
