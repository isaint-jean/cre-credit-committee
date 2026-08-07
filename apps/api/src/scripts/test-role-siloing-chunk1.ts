/**
 * Role-siloing chunk 1 — ORIGINATOR + BUYER roles exist (additive), seeded users
 * round-trip, and the permission matrix is doctrinally correct:
 *   - ORIGINATOR: read / audit / snapshot-read / analysis:revise / workflow:override
 *                 — NO workflow:approve, NO workflow:reject, NO workflow:submit.
 *   - BUYER: read / request-info / override / APPROVE / REJECT — NO submit, NO revise.
 *   - existing 5 roles byte-identical (proves additive, nothing changed).
 *   - normalizeRoleAtBoundary maps the lowercase storage roles to the contract enum.
 *
 *   npm run test:role-siloing-chunk1
 */
import { ROLE_PERMISSIONS, roleHasPermission, ROLES } from '@cre/contracts';
import { normalizeRoleAtBoundary } from '../middleware/auth.js';
import { store } from '../storage/sqlite-store.js';

let passed = 0, failed = 0;
const ok = (m: string) => { passed++; console.log(`  ok    ${m}`); };
const fail = (m: string) => { failed++; console.error(`  FAIL  ${m}`); };
const assert = (c: boolean, m: string) => (c ? ok(m) : fail(m));

console.log('New roles exist in the matrix:');
assert((ROLES as readonly string[]).includes('ORIGINATOR'), 'ORIGINATOR in ROLES');
assert((ROLES as readonly string[]).includes('BUYER'), 'BUYER in ROLES');

console.log('\nORIGINATOR permissions (prepares + negotiates, CANNOT self-approve):');
assert(roleHasPermission('ORIGINATOR', 'workflow:read'), 'ORIGINATOR has workflow:read');
assert(roleHasPermission('ORIGINATOR', 'analysis:revise'), 'ORIGINATOR has analysis:revise (revise/upload)');
assert(roleHasPermission('ORIGINATOR', 'workflow:override'), 'ORIGINATOR has workflow:override (negotiate)');
assert(!roleHasPermission('ORIGINATOR', 'workflow:approve'), 'ORIGINATOR does NOT have workflow:approve');
assert(!roleHasPermission('ORIGINATOR', 'workflow:reject'), 'ORIGINATOR does NOT have workflow:reject');
assert(!roleHasPermission('ORIGINATOR', 'workflow:submit'), 'ORIGINATOR does NOT have workflow:submit');

console.log('\nBUYER permissions (first-loss approver):');
assert(roleHasPermission('BUYER', 'workflow:read'), 'BUYER has workflow:read');
assert(roleHasPermission('BUYER', 'workflow:approve'), 'BUYER has workflow:approve (first-loss)');
assert(roleHasPermission('BUYER', 'workflow:reject'), 'BUYER has workflow:reject');
assert(roleHasPermission('BUYER', 'workflow:request-info'), 'BUYER has workflow:request-info');
assert(roleHasPermission('BUYER', 'workflow:override'), 'BUYER has workflow:override (negotiate)');
assert(!roleHasPermission('BUYER', 'workflow:submit'), 'BUYER does NOT have workflow:submit');
assert(!roleHasPermission('BUYER', 'analysis:revise'), 'BUYER does NOT have analysis:revise');

console.log('\nExisting 5 roles BYTE-IDENTICAL (additive proof):');
const EXPECTED: Record<string, readonly string[]> = {
  VIEWER: [],
  ANALYST: ['workflow:read', 'workflow:submit', 'workflow:override', 'audit:read', 'snapshot:read', 'snapshot:create', 'analysis:revise'],
  CREDIT_OFFICER: ['workflow:read', 'workflow:submit', 'workflow:request-info', 'workflow:override', 'audit:read', 'snapshot:read', 'snapshot:create', 'analysis:revise'],
  COMMITTEE_MEMBER: ['workflow:read', 'workflow:request-info', 'workflow:approve', 'workflow:reject', 'workflow:postpone', 'audit:read', 'snapshot:read'],
  ADMIN: ['workflow:read', 'workflow:submit', 'workflow:request-info', 'workflow:override', 'workflow:approve', 'workflow:reject', 'workflow:postpone', 'audit:read', 'snapshot:read', 'snapshot:create', 'registry:write', 'analysis:revise'],
};
for (const [role, perms] of Object.entries(EXPECTED)) {
  const actual = ROLE_PERMISSIONS[role as keyof typeof ROLE_PERMISSIONS] as readonly string[];
  assert(JSON.stringify(actual) === JSON.stringify(perms), `${role} permissions unchanged`);
}

console.log('\nBoundary translation (lowercase storage → contract enum):');
assert(normalizeRoleAtBoundary('originator') === 'ORIGINATOR', "normalize 'originator' → ORIGINATOR");
assert(normalizeRoleAtBoundary('buyer') === 'BUYER', "normalize 'buyer' → BUYER");
assert(normalizeRoleAtBoundary('admin') === 'ADMIN', "normalize 'admin' → ADMIN (unchanged)");

console.log('\nSeeded users round-trip (seedDefaultUser ran on store construct):');
const orig = store.getUserByEmail('originator@cre.com');
const buyer = store.getUserByEmail('buyer@cre.com');
const admin = store.getUserByEmail('admin@cre.com');
assert(orig !== null && orig.role === 'originator', 'originator@cre.com seeded, role=originator');
assert(buyer !== null && buyer.role === 'buyer', 'buyer@cre.com seeded, role=buyer');
assert(admin !== null && admin.role === 'admin', 'admin@cre.com intact, role=admin');
assert(orig !== null && store.verifyPassword('originator123', orig.passwordHash), 'originator password verifies');
assert(buyer !== null && store.verifyPassword('buyer123', buyer.passwordHash), 'buyer password verifies');

console.log(`\n${failed === 0 ? '✓' : '✗'} role-siloing-chunk1: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
