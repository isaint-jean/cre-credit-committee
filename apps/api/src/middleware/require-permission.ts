// Permission-check middleware factory (Phase 4 - productization layer).
//
// Boundary-only authorization. Wraps a route handler with a check that the
// authenticated user's role holds the named permission. The permission matrix
// is the single source of truth for role -> permission mapping; this middleware
// is a thin adapter over `roleHasPermission`.
//
// CRITICAL DISCIPLINE:
//   - This middleware is the ONLY place permissions are checked. Domain
//     services (producers, render, projections) NEVER branch on role or
//     permission.
//   - The middleware delegates to the contract's `roleHasPermission` predicate;
//     no role logic is reimplemented here.
//   - If the user is not authenticated, this middleware returns 401 (unauth-
//     before-authz). If authenticated but lacking the permission, it returns 403.

import type { Request, Response, NextFunction } from 'express';
import {
  ROLES,
  roleHasPermission,
  type Permission,
  type Role,
} from '@cre/contracts';

function isKnownRole(role: string): role is Role {
  return (ROLES as readonly string[]).indexOf(role) >= 0;
}

export function requirePermission(permission: Permission) {
  return function (req: Request, res: Response, next: NextFunction): void {
    if (!enforcePermission(req, res, permission)) return;
    next();
  };
}

// Direct permission check usable inline within a handler when the required
// permission depends on the request body (e.g., POST /committee-actions where
// the action kind dictates which permission gates the call). Returns true if
// the request is allowed; if not, the response has already been sent (401/403)
// and the caller should `return`.
export function enforcePermission(
  req: Request,
  res: Response,
  permission: Permission,
): boolean {
  const user = req.user;
  if (!user) {
    res.status(401).json({ error: 'Authentication required' });
    return false;
  }
  const role = user.role;
  if (typeof role !== 'string' || !isKnownRole(role)) {
    res.status(403).json({ error: 'UNKNOWN_ROLE', role });
    return false;
  }
  if (!roleHasPermission(role, permission)) {
    res.status(403).json({
      error: 'PERMISSION_DENIED',
      role,
      required: permission,
    });
    return false;
  }
  return true;
}
