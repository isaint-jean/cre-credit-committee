// LINT FIXTURE - DELIBERATE VIOLATION (Batch 6.8 negative test).
//
// This file deliberately violates Batch 6.7 RD1 (read-pole no-upstream-reach-back)
// by importing a producer service from a render-side module path. It is excluded
// from normal lint:boundaries by the __fixtures__/ exclusion and scanned only by
// apps/api/src/scripts/test-render-isolation.ts.
//
// Expected to be flagged by:
//   - dependency-cruiser rule: render-no-producers
//
// DO NOT REMOVE THIS FILE - its purpose is to break the build if the policy
// ever fails to fire.

import * as judgment from '../judgment/apply-judgment-adjustments.js';

export const _forbidden = judgment;
