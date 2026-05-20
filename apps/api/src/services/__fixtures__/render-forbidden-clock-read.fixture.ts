// LINT FIXTURE - DELIBERATE VIOLATION (Batch 6.8 negative test).
//
// This file deliberately violates Batch 6.7 RD4 (read-pole determinism)
// by importing node:fs from a render-side module path. It is excluded from
// normal lint:boundaries by the __fixtures__/ exclusion and scanned only by
// apps/api/src/scripts/test-render-isolation.ts.
//
// Expected to be flagged by:
//   - dependency-cruiser rule: render-no-clock-or-side-channels
//
// DO NOT REMOVE THIS FILE - its purpose is to break the build if the policy
// ever fails to fire.

import * as fs from 'node:fs';

export const _forbidden = fs;
