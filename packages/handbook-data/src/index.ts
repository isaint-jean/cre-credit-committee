/**
 * @cre/handbook-data — the structured form of the Eightfold CRE Credit
 * Handbook, exported as a typed constant for consumption by the engine,
 * registry, and admin UI.
 *
 * Source of truth lives in `./handbook.ts` (a typed TS literal compile-
 * validated against the @cre/contracts Handbook type). The committed
 * `./handbook.json` is regenerated from that literal via JSON.stringify;
 * this barrel imports the JSON for runtime consumption to avoid pulling
 * the entire 3,900-line TS source into the dependency graph.
 *
 * Round-trip invariant: the JSON's structural shape conforms to the
 * Handbook contract because the TS literal it was generated from
 * type-checks. The `as Handbook` cast at runtime is therefore type-safe
 * by construction — to remain so, regenerate the JSON whenever the TS
 * literal changes.
 */

import type { Handbook } from '@cre/contracts';
import handbookData from './handbook.json';

export const handbook: Handbook = handbookData as Handbook;
