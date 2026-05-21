import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import type { Role } from '@cre/contracts';
import { env } from '../config/env.js';

export interface AuthPayload {
  userId: string;
  email: string;
  role: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthPayload;
    }
  }
}

/**
 * Legacy → new-spine role translation. The sqlite-store `users.role` column
 * holds lowercase strings (`'admin' | 'analyst' | 'viewer'`) for historical
 * reasons. The new-spine authorization layer (packages/contracts/src/roles.ts
 * + middleware/require-permission.ts) uses an uppercase enum (`'ADMIN' |
 * 'ANALYST' | 'COMMITTEE_MEMBER' | 'CREDIT_OFFICER' | 'VIEWER'`).
 *
 * Translation happens at TWO boundaries:
 *   1. Sign time (auth.routes.ts /login): the JWT carries the new-spine role
 *      going forward, so requirePermission() sees a known value.
 *   2. Decode time (this module's requireAuth): for any JWT issued BEFORE
 *      this fix landed (still has lowercase role + valid 7-day TTL),
 *      normalize on decode so existing user sessions don't break. This branch
 *      is transitional; once every pre-fix JWT has expired (≤7 days post-deploy)
 *      it becomes effectively unreachable.
 */
export const LEGACY_ROLE_TO_NEW: Record<string, Role> = {
  admin: 'ADMIN',
  analyst: 'ANALYST',
  viewer: 'VIEWER',
};

/** Apply the translation if the role is a legacy lowercase string; otherwise
 *  pass through unchanged. Returns the input as-is for already-uppercase roles
 *  and for unknown values (the permission check downstream surfaces 403
 *  UNKNOWN_ROLE for genuinely-unknown strings). */
export function normalizeRoleAtBoundary(role: string): string {
  return LEGACY_ROLE_TO_NEW[role] ?? role;
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, env.jwtSecret) as AuthPayload;
    // Defense-in-depth: normalize legacy-lowercase roles in existing JWTs that
    // were signed before the boundary translation landed in auth.routes.ts.
    // No-op for JWTs signed after the fix (already uppercase).
    req.user = { ...payload, role: normalizeRoleAtBoundary(payload.role) };
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}
