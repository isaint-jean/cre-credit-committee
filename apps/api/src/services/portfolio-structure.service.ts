/**
 * portfolio-structure.service — Phase A. Read/write a servicer's MANUAL portfolio
 * definition (N properties + allocated loan amounts + optional whole-loan debt service)
 * for a loan. Persists on the additive servicer_inputs store (fieldType
 * 'portfolio_structure') — the SAME pattern as site photos / the checklist.
 *
 * ★ MINT-SAFE: writes only the additive servicer_inputs TEXT row. It NEVER touches the
 *   minted ExtractionResult / doctrine / 640 head. A single-loan deal never writes one.
 */
import {
  parseManualPortfolio,
  serializeManualPortfolio,
  manualPortfolioToComponents,
  type ManualPortfolioDefinition,
  type PropertyComponent,
} from '@cre/contracts';
import { getServicerInput, upsertServicerInput, resolveLoanForAnalysis } from './servicer-inputs.service.js';

const FIELD = 'portfolio_structure' as const;

/** The manual portfolio definition for a loan, or the empty definition when none. */
export function getPortfolioStructure(poolId: string, loanInPoolId: string): ManualPortfolioDefinition {
  return parseManualPortfolio(getServicerInput(poolId, loanInPoolId, FIELD)?.value ?? null);
}

/** Persist a manual portfolio definition (last-write-wins), returning the parsed round-trip. */
export function setPortfolioStructure(args: {
  poolId: string;
  loanInPoolId: string;
  definition: ManualPortfolioDefinition;
  author: string;
}): ManualPortfolioDefinition {
  const saved = upsertServicerInput({
    poolId: args.poolId,
    loanInPoolId: args.loanInPoolId,
    fieldType: FIELD,
    value: serializeManualPortfolio(args.definition),
    author: args.author,
  });
  return parseManualPortfolio(saved.value);
}

/** Resolve a loan's manual definition by analysis (graph revision → loan join). */
export function getPortfolioStructureForAnalysis(graphRevisionId: string | null | undefined): ManualPortfolioDefinition | null {
  const loan = resolveLoanForAnalysis(graphRevisionId);
  if (loan === null) return null;
  return getPortfolioStructure(loan.poolId, loan.loanInPoolId);
}

/**
 * The manual portfolio's PropertyComponent[] for an analysis, or null when there is no
 * manual definition with more than one property. This is the Phase-A OVERRIDE source the
 * export dispatch reads before the (EX-102) graph properties.
 */
export function resolveManualPortfolioComponents(
  graphRevisionId: string | null | undefined,
): { components: readonly PropertyComponent[]; wholeLoanDebtService: number | null } | null {
  const def = getPortfolioStructureForAnalysis(graphRevisionId);
  if (def === null || def.properties.length <= 1) return null;
  return { components: manualPortfolioToComponents(def), wholeLoanDebtService: def.wholeLoanDebtService };
}
