# Excel Render Shell — Assembly Guide

This folder is the source-of-truth for the institutional underwriting workbook. The workbook is a **rendering layer only** — all underwriting math, library baselines, judgment overlays, and conservatism gates live in the TS pipeline. See `memory/architecture_excel_role.md`.

## Contracts

The Excel layer is bound to two contracts:

1. **`AdjustedInputs`** (`packages/shared/src/types/adjusted-inputs.ts`) — the sole upstream input. The render layer never reads internal pipeline state.
2. **`RenderPayload`** (`packages/shared/src/types/render.ts`) — the wire format. Carries `contractVersion`. Bump when the cell schema changes.

Every cell the workbook can display is enumerated declaratively in `apps/api/src/services/render-schema.ts`. **If a binding is not in that file, it does not exist in the rendering system.** No ad-hoc workbook formulas, no VBA-side derivation.

## Source files

| Path | Purpose |
| --- | --- |
| `vba/modConfig.bas`     | Constants + helpers (API URL, sheet/range names). |
| `vba/modRefresh.bas`    | `RefreshFromBackend` entry point + HTTP. |
| `vba/modBindings.bas`   | Cell write + tab visibility + driver table + banner. |
| `vba/modValidate.bas`   | Bidirectional schema integrity gate. **Hard errors on any drift.** |
| `vba/Sheet_Inputs.cls`  | Asset-class-change → refresh trigger. Lives behind the Inputs sheet. |
| `vba/ThisWorkbook.cls`  | Hide `_Config` + run open-time integrity self-test. |
| `config/asset-class-tabs.csv` | Seed for the hidden `_Config` sheet. |

## Runtime validation gates (closed-system enforcement)

The system enforces schema integrity programmatically on **both sides**:

**Backend (TS):**
- `assertSchemaWellFormed()` runs at module import — duplicate addresses, malformed ranges, or asset-class mismatches throw `RenderSchemaError` before any request is served.
- `assertProjectionMatchesSchema(assetClass, bindings)` runs on every render — the emitted `cellBindings` set must equal the declared schema set. Any drift returns HTTP 500 with `code: PROJECTION_SCHEMA_MISMATCH` and a diff.
- The payload carries `schemaAddresses` so the workbook receives the canonical expected-set, not just values.

**Excel (VBA):**
- `RefreshFromBackend` runs three gates **before any cell is written**:
  1. `AssertBindingsMatchSchemaAddresses` — payload's `cellBindings` keys equal `schemaAddresses` (closed-system check).
  2. `AssertSchemaAddressesResolve` — every address in `schemaAddresses` resolves to a Range in the workbook.
  3. `AssertNoExtraManagedNames` — workbook contains no managed-namespace named ranges absent from the schema.
- Any failure raises `ERR_VALIDATE` and aborts the entire refresh — no partial writes.
- `Workbook_Open` runs the same validations against `/render-config` so drift surfaces at file open, not on first refresh.

The "managed namespace" is **declared by the backend** in `render-schema.ts` and shipped to the workbook on every render and via `/render-config`. The VBA validator never declares prefixes, literals, or excluded sheets locally — it consumes the policy from the payload and applies it.

## Single source of truth (locked invariant)

`apps/api/src/services/render-schema.ts` is the **only** place where schema decisions live. Specifically, the backend owns:

- The list of cell addresses (`schemaAddresses`).
- The managed-namespace policy (`prefixes`, `literals`, `excludedSheets`).
- All table layouts (sheet, header row, data start row, columns, headers, source fields).
- The visible-tabs set per asset class.

The workbook owns only:

- API base-URL transport config (`DEFAULT_API_BASE_URL`, override sheet `_Config`).
- The Inputs-side named ranges that capture USER input (`Input_Deal_Id`, `Input_Asset_Class`, `Input_Auth_Token`).

Any schema rule found in VBA is a violation. The VBA validator is a strict enforcement client only — it rejects payloads that drift from the schema, but it never defines what the schema is.

## Schema evolution (mandatory, migration-aware protocol)

Schema changes are **migration-aware**. Every bump of `RENDER_CONTRACT_VERSION` MUST be accompanied by a migration entry in `apps/api/src/services/render-migrations.ts`. The migration history is append-only and validated at backend boot — a missing or malformed step fails server startup with `MIGRATION_CHAIN_BROKEN`.

### Required sequence for any schema change

1. Modify the source of truth — `render-schema.ts` (cells/tables/policy) and/or `adjusted-inputs.ts` (input shape).
2. Bump `RENDER_CONTRACT_VERSION` in `packages/shared/src/types/render.ts`.
3. **Append a `RenderContractMigration` to `MIGRATIONS`** describing the diff, using the structured change kinds:
   - `addresses`: `address-added | address-removed | address-renamed`
   - `tables`: `table-added | table-removed | table-renamed | table-columns-changed | table-sheet-changed`
   - `managedNamespace`: prefix/literal/excluded-sheet add/remove
   - `visibility`: per-asset-class tab add/remove
   - `wire`: payload field add/remove/rename
   - Set `autoApplicable: false` unless every change is purely additive or a pure rename a workbook can mechanically apply.
4. Update the workbook's `EMBEDDED_CONTRACT_VERSION` (in `vba/modConfig.bas`) **only after** the workbook itself has been rebuilt to satisfy the new contract.
5. Run `npx tsx apps/api/src/scripts/dump-render-schema.ts` and commit the resulting JSON.
6. Smoke-test: open the workbook → `Workbook_Open` self-test should not raise; refresh against a real deal → no validation errors.

### Backward-compatibility behaviour

- Workbooks send `clientContractVersion=N` on every `/render` and `/render-config` call.
- Backend at version `M >= N` returns the payload AND a `migrationsFromClient` manifest listing each `N→...→M` step.
- Backend at version `M < N` (workbook newer than backend) returns HTTP 409 `CLIENT_AHEAD_OF_BACKEND` and refuses to render.
- The workbook's `modMigrations.HandleMigrationDrift` shows the user every step and asks for confirmation before any write. **No silent migration.** Even autoApplicable steps are reviewed first.

### Forbidden

- Bumping `RENDER_CONTRACT_VERSION` without adding a migration step (boot fails).
- Removing/renaming addresses, tables, or namespace entries without a structured change record.
- Editing an existing migration entry — history is append-only.
- Adding VBA logic that reinterprets or rewrites the migration manifest. VBA renders the manifest to the user; it never decides semantics.

### Endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /api/underwriting/render?...&clientContractVersion=N` | Render payload, with `migrationsFromClient` if `N < current`. |
| `GET /api/underwriting/render-config?clientContractVersion=N` | Workbook-open self-test source. |
| `GET /api/underwriting/render-migrations?fromVersion=N` | Standalone migration manifest from `N` → current. |
| `GET /api/underwriting/render-migrations` | Full migration history (audit/CI use). |

## Building the .xlsm from scratch

1. **Create a new macro-enabled workbook** `cre-uw-shell.xlsm`.

2. **Add sheets** (uniform layout — one set per asset class):

   ```
   Cover  Inputs  CrossCheck  _Config
   MF_Cashflow  MF_DebtSchedule  MF_Output
   OF_Cashflow  OF_DebtSchedule  OF_Output
   RT_Cashflow  RT_DebtSchedule  RT_Output
   IN_Cashflow  IN_DebtSchedule  IN_Output
   HT_Cashflow  HT_DebtSchedule  HT_Output
   SS_Cashflow  SS_DebtSchedule  SS_Output
   MX_Cashflow  MX_DebtSchedule  MX_Output
   MH_Cashflow  MH_DebtSchedule  MH_Output
   ```

3. **Inputs sheet** — add three workbook-scoped named ranges:

   | Name | Cell | Notes |
   | --- | --- | --- |
   | `Input_Deal_Id`     | e.g. B3 | Free text. Required. |
   | `Input_Asset_Class` | e.g. B4 | Data Validation list — see step 4. |
   | `Input_Auth_Token`  | e.g. B5 | Bearer token from `/api/auth/login`. Optional in dev. |

4. **Asset class dropdown** — Data → Data Validation on `Input_Asset_Class` → Allow: List → Source:

   ```
   multifamily,office,retail,industrial,hotel,self_storage,mixed_use,manufactured_housing
   ```

5. **Cover sheet** — add **sheet-scoped** named ranges (so the same name can be unique to Cover):
   - `Deal_Name`, `Asset_Class`, `Generated_At`
   - `Cover_Conservatism_Status`, `Cover_Conservatism_Flags`
   - `Cover_Confidence_Reduction`, `Cover_Library_Sample_Size`, `Cover_Library_Degraded`

6. **Cashflow sheets (`{MF,OF,RT,IN,HT,SS,MX,MH}_Cashflow`)** — sheet-scoped named ranges:

   Income (adjusted): `Income_GPR`, `Income_Vacancy`, `Income_Concessions`, `Income_OtherIncome`, `Income_EGI`
   Income (raw, side-by-side): `Income_GPR_Raw`, `Income_Vacancy_Raw`, `Income_Concessions_Raw`, `Income_OtherIncome_Raw`, `Income_EGI_Raw`
   Expenses (adjusted): `Expense_RealEstateTaxes`, `Expense_Insurance`, `Expense_Utilities`, `Expense_RandM`, `Expense_Management`, `Expense_GandA`, `Expense_Payroll`, `Expense_ReplReserves`, `Expense_Total`
   Expenses (raw): `Expense_RealEstateTaxes_Raw`, `Expense_Insurance_Raw`, `Expense_Utilities_Raw`, `Expense_RandM_Raw`, `Expense_Management_Raw`, `Expense_GandA_Raw`, `Expense_Payroll_Raw`, `Expense_ReplReserves_Raw`, `Expense_Total_Raw`
   NOI: `Cashflow_NOI`

7. **DebtSchedule sheets** — sheet-scoped: `Loan_Amount`, `Loan_InterestRate`, `Loan_RateType`, `Loan_AmortizationMonths`, `Loan_TermMonths`, `Loan_IoMonths`, `Loan_AnnualDebtService`.

8. **Output sheets** — sheet-scoped: `Metric_NOI`, `Metric_CapRate`, `Metric_Value`, `Metric_DSCR`, `Metric_LTV`, `Metric_DebtYield`, `Metric_LoanAmount`, `Metric_AnnualDebtService`.

9. **CrossCheck sheet** — header row at row 3:
   `Metric | Bank | BPSpire | Variance$ | Variance% | Flag | Severity | Commentary`. Rows 4+ populated by `WriteDriversTable`.

10. **`_Config` sheet** — paste contents of `config/asset-class-tabs.csv`. Header in row 1, one row per asset class. Sheet remains `xlSheetVeryHidden`; `Workbook_Open` enforces it.

11. **Import VBA** — VBE (Alt+F11) → File → Import File:
    - `JsonConverter.bas` (Tim Hall's VBA-JSON — external dependency, not bundled).
    - `modConfig.bas`, `modRefresh.bas`, `modBindings.bas`.
    - `Sheet_Inputs.cls` body → into Inputs sheet's code-behind.
    - `ThisWorkbook.cls` body → into ThisWorkbook code-behind.

12. **Tools → References** in the VBE:
    - Microsoft XML, v6.0 (`MSXML2.XMLHTTP`)
    - Microsoft Scripting Runtime (`Scripting.Dictionary`)

13. **Save** as `.xlsm`.

## Verifying the workbook matches the schema

Every named range in steps 5–8 is declared in `apps/api/src/services/render-schema.ts`. To regenerate the canonical list:

```
npx tsx apps/api/src/scripts/dump-render-schema.ts > excel/config/render-schema.json
```

That JSON enumerates every `Sheet!Range` the backend will emit. The Excel build step should fail if any address is missing from the workbook.

## Smoke test

1. Start the API: `pnpm --filter api dev`.
2. Run an analysis through the existing pipeline so an `Analysis` row exists with a non-null `uwModel`.
3. Open `cre-uw-shell.xlsm` → Inputs → enter dealId → choose asset class.
4. The asset-class change fires `RefreshFromBackend`. Output cells populate; non-relevant tabs hide.

## Hard rules (do not violate)

- The workbook never derives a metric. If `Metric_NOI` would otherwise be a formula, it must be a value supplied by `cellBindings`.
- Adding a new asset class = add an entry to `ASSET_CLASS_PREFIX` in `render-schema.ts` and a row in `_Config`. No VBA changes.
- Adding a new cell = add a `SchemaEntry` in `render-schema.ts` AND a named range in the workbook. Bump `RENDER_CONTRACT_VERSION`.
- Library baselines, vacancy adjustments, expense overlays, conservatism gates → all in TS, never here.
