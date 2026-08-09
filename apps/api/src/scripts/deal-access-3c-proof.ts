/**
 * PROOF — Chunk 3c: the confidentiality gate. Fully in-memory + synthetic ids →
 * the real cre.db is never written (deal_access stays 48; no confi_acceptances
 * table created on it). Proves, with the flag ON:
 *   - a granted-but-not-accepted BUYER is DENIED the data room (CONFIDENTIALITY_REQUIRED);
 *   - originator (owner) + admin BYPASS the confi gate;
 *   - a buyer with NO grant is DENIED (pool access) — confi is not the issue;
 *   - accept records a confi_acceptances row (IP + version) AND flips
 *     deal_access.accepted_at → the same buyer is then ALLOWED;
 *   - you cannot accept your way IN: markConfiAccepted on a non-existent grant fails;
 *   - flag OFF → allowed (dark, no gate).
 *
 * Run: npx tsx src/scripts/deal-access-3c-proof.ts   (from apps/api)
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import type { Request, Response } from 'express';
import { DealAccessStore, setDealAccessStore } from '../storage/deal-access-store.js';
import { ConfiAcceptanceStore, setConfiAcceptanceStore, CONFIDENTIALITY_AGREEMENT_VERSION } from '../storage/confi-acceptance-store.js';
import { enforceDataRoomAccessParam } from '../middleware/deal-access.js';

const DB_PATH = path.join(process.cwd(), 'data', 'cre.db');
const POOL = '__confi_pool__';
const BUYER = '__buyer__', ORIG = '__orig__', ADMIN = '__admin__', NOGRANT = '__nobody__';

let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
}

/** Drive the data-room param gate with a mock req/res/next. */
function gate(userId: string, role: string): { allowed: boolean; status?: number; error?: string } {
  let allowed = false; let status: number | undefined; let error: string | undefined;
  const req = { user: { userId, role } } as unknown as Request;
  const res = {
    status(c: number) { status = c; return this; },
    json(b: { error?: string }) { error = b.error; return this; },
  } as unknown as Response;
  enforceDataRoomAccessParam(req, res, () => { allowed = true; }, POOL);
  return { allowed, status, error };
}

function main(): void {
  const canonicalBefore = new DealAccessStore(DB_PATH).countAll();
  console.log('\nDeal-access 3c proof — confidentiality gate (in-memory; canonical-safe)\n');

  const access = new DealAccessStore(':memory:');
  const confi = new ConfiAcceptanceStore(':memory:');
  setDealAccessStore(access);
  setConfiAcceptanceStore(confi);
  try {
    // Grants: buyer + originator both have a pool grant (accepted_at NULL initially).
    access.grant({ resourceType: 'pool', resourceKey: POOL, userId: BUYER, party: 'buyer' });
    access.grant({ resourceType: 'pool', resourceKey: POOL, userId: ORIG, party: 'originator' });

    process.env.DEAL_ACCESS_ENFORCEMENT = 'true';

    // Buyer granted but no confi → data room denied (CONFIDENTIALITY_REQUIRED).
    let g = gate(BUYER, 'BUYER');
    check('granted buyer w/o confi → DENIED data room', !g.allowed && g.status === 403 && g.error === 'CONFIDENTIALITY_REQUIRED', g.error);
    // Originator (owner) + admin bypass the confi gate.
    check('originator (owner) BYPASSES confi', gate(ORIG, 'ORIGINATOR').allowed);
    check('admin BYPASSES confi', gate(ADMIN, 'ADMIN').allowed);
    // Buyer with NO grant → denied on pool access (not a confi issue).
    g = gate(NOGRANT, 'BUYER');
    check('ungranted buyer → DENIED (pool access, not confi)', !g.allowed && g.error === 'DEAL_ACCESS_DENIED', g.error);

    // Cannot accept your way IN — no grant to stamp.
    check('cannot accept without a grant (markConfiAccepted fails)', access.markConfiAccepted('pool', POOL, NOGRANT) === false);

    // Accept: record the log row (IP + version) + flip accepted_at.
    const at = new Date().toISOString();
    confi.record({ resourceType: 'pool', resourceKey: POOL, userId: BUYER, agreementVersion: CONFIDENTIALITY_AGREEMENT_VERSION, clientIp: '203.0.113.7', acceptedAt: at });
    check('markConfiAccepted stamps the existing grant', access.markConfiAccepted('pool', POOL, BUYER, at) === true);
    check('deal_access.accepted_at now set', access.acceptedAtFor('pool', POOL, BUYER) === at);
    const logged = confi.listForResource('pool', POOL).find((r) => r.userId === BUYER);
    check('confi log row present w/ IP + version', !!logged && logged.clientIp === '203.0.113.7' && logged.agreementVersion === CONFIDENTIALITY_AGREEMENT_VERSION);

    // Now the buyer is allowed into the data room.
    check('after accept → buyer ALLOWED data room', gate(BUYER, 'BUYER').allowed);

    // Flag OFF — dark: a granted-but-unaccepted buyer is allowed (no gate).
    process.env.DEAL_ACCESS_ENFORCEMENT = 'false';
    access.grant({ resourceType: 'pool', resourceKey: POOL, userId: '__buyer2__', party: 'buyer' });
    check('flag OFF — unaccepted buyer allowed (ships dark)', gate('__buyer2__', 'BUYER').allowed);
  } finally {
    process.env.DEAL_ACCESS_ENFORCEMENT = 'false';
    setDealAccessStore(null);
    setConfiAcceptanceStore(null);
  }

  const canonicalAfter = new DealAccessStore(DB_PATH).countAll();
  check('canonical deal_access untouched (48)', canonicalAfter === canonicalBefore, `${canonicalBefore} → ${canonicalAfter}`);
  console.log(failures === 0 ? '\ndeal-access 3c proof: OK\n' : `\ndeal-access 3c proof: ${failures} FAILURE(S)\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
