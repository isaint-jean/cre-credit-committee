# Parity Corpus

Observational fixture set comparing legacy dashboard output against `RenderedAnalysis`
output across representative analyses. **Catalogs divergences; does not enforce parity.**

See `docs/legacy-reduction-plan.md` §8 for the full methodology and rationale.

## Constraints

- **Observational only.** The corpus does NOT cause the build to fail on divergence.
  Every divergence is a classification, not a regression.
- **Do not back-port.** Mismatches tagged `intentional-modernization` or `legacy-bug`
  document deliberate divergence. The new spine is correct; legacy is the deprecated path.
- **Do not bypass unified-read.** Both snapshots come from `GET /api/analyses/:id` —
  legacy via a uuid id, new via a content-hash id. No internal store reads.
- **Do not introduce client-side patches** to the new spine to "make parity pass."
  Parity is a documentation artifact, not an acceptance criterion.

## Fixture layout

Each fixture is a directory at `apps/api/fixtures/parity/{name}/` with four files:

```
apps/api/fixtures/parity/{name}/
├── extraction-result.json   # Synthetic ExtractionResult (input to new-spine ingestion)
├── expected-rendered.json   # GET /api/analyses/{rootId} for the graph-keyed analysis
├── expected-legacy.json     # GET /api/analyses/{uuid} for the equivalent legacy analysis
└── parity-report.md         # Per-field classification + rationale
```

## Classification schema

Every divergence between `expected-legacy.json` and `expected-rendered.json` falls into
exactly one of five categories:

| Tag | Meaning | Action |
|---|---|---|
| `match` | The two surfaces display equivalent values for the same logical field. | none |
| `intentional-modernization` | New spine is correct; legacy was inconsistent or violated an architectural invariant. | document the divergence; do not back-port |
| `legacy-bug` | Legacy is observably wrong (e.g., displayed value computed against a stale or pre-floor input). | document; do not patch new spine to reproduce |
| `missing-render-field` | Both spines have the data; new spine has not yet projected it into `RenderedAnalysis`. | enqueue contract addition (see legacy-reduction-plan.md §7 Phase 1) |
| `migration-gap` | Capability has no current new-spine equivalent (producer-pending, out-of-spine, or deferred-write-side). | classify by sub-tag below; do not silently fill from legacy |

Sub-tags for `migration-gap`:

| Sub-tag | Meaning |
|---|---|
| `producer-pending` | Producer-side work needed before the field can exist on the new spine. |
| `out-of-spine` | Capability is fundamentally outside the deterministic spine (AI-generated content, external research). |
| `deferred-write-side` | Capability is a mutation flow; deferred until editable rendered semantics are designed. |

## Per-fixture report format (`parity-report.md`)

```markdown
# {fixture-name} parity report

**Asset class:** {Office | Multifamily | Hotel | ...}
**Scenario:** {stabilized | lease-up | library-degraded | ...}
**Source analysisAsOfDate:** {ISO date}

## Classifications

| Field | Legacy | Rendered | Tag | Notes |
|---|---|---|---|---|
| summary.ratingBand | "Acceptable" | "Acceptable" | match | |
| metrics.dscr | 1.34 | 1.34 | match | |
| crossCheck.findings | [{noi: -50000, status: minor}] | [] | migration-gap | producer-pending — see legacy-reduction-plan.md §7 Phase 2 #6 |
| componentScores | (table) | absent | missing-render-field | Phase 1 #1 |
| ... | ... | ... | ... | ... |

## Unclassified fields

{none — every legacy field MUST be classified or this report is incomplete}
```

## Adding a fixture

See `docs/legacy-reduction-plan.md` §8.5.

## Reporter

`apps/api/src/scripts/parity-report.ts` — read-only aggregator; walks all fixture
directories, parses each `parity-report.md`, emits a summary (count by tag per fixture,
cross-fixture totals, list of unclassified fields). Does not enforce; does not block CI.
