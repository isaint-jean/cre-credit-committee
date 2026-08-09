import type { DocTypeCategory, DocTypeTier } from './doctype-taxonomy.js';

/**
 * Data Room — read-only nested tree (Chunk 1).
 *
 * Mirrors how a CMBS deal is assembled on Intralinks:
 *
 *   Deal/Pool (BMARK 2024-V8)
 *    └── New Issue
 *        └── Deal name again (BMARK 2024-V8)
 *            └── BANK  (mortgageLoanSeller: GSMC / "GSMC, BMO" / CREFI …)
 *                └── CATEGORY  (ASRs / Excels / Third-Party Reports / Legal …)  ← THE FOLDER
 *                    └── FILE   (a document, LABELED BY ITS LOAN)                ← LEAVES
 *
 * ★ KEY: the CATEGORY is the grouping folder; LOANS are the leaf files inside it.
 *   One "ASRs" folder under a bank holds ALL that bank's loans' ASRs — each file
 *   labeled by loan (Sunroad Centrum, 640 Fifth Ave), NOT a loan subfolder each
 *   holding one ASR.
 *
 * Purely a READ projection — no new persistence, no mutation. Guarantees:
 *   - ON-DEMAND FOLDERS: a bank / category node is present ONLY when it has ≥1 file.
 *   - DETERMINISTIC ORDER: banks A→Z, categories in CATEGORIES_IN_ORDER, files by
 *     loan name → doc-type (taxonomy order) → version (newest first).
 */

/** One document — the leaf. Labeled by its LOAN; its doc-type is metadata. */
export interface DataRoomTreeFile {
  readonly fileHash: string;
  readonly fileName: string;
  readonly size: number;
  /** ISO-8601 upload timestamp (always present — the receipt-date fallback). */
  readonly uploadedAt: string;
  /** Extracted content / as-of date (ISO), or null when none was parseable. */
  readonly docEffectiveDate: string | null;
  readonly pinned: boolean;
  /** Wins its (loan, doc-type) slot (pinned → latest docEffectiveDate → latest uploadedAt). */
  readonly isSelectedVersion: boolean;
  /** 1-based position among that (loan, doc-type) slot's versions, newest→oldest. */
  readonly versionIndex: number;
  readonly versionCount: number;
  // ── leaf identity: the file is named by its LOAN ─────────────────────────
  readonly loanInPoolId: string;
  readonly loanName: string;
  readonly docType: string;
  readonly docTypeLabel: string;
  readonly tier: DocTypeTier;
  /** Differentiator (Tier 1): the resolved engine analysis id for this file's LOAN
   *  (uuid or 64-hex lineageRoot), or null when it has no underwriting / its dealRef
   *  doesn't resolve. Resolved server-side (lookupAnalysisByDealRef), memoized per
   *  loan. Lets the file row surface the engine's verdict for its loan. */
  readonly analysisId: string | null;
}

/** A category folder within a bank (e.g. "Third-Party Reports") — holds the
 *  loan-labeled files of every doc-type in that category. */
export interface DataRoomTreeCategory {
  readonly category: DocTypeCategory;
  readonly files: readonly DataRoomTreeFile[];
  readonly fileCount: number;
}

/** A contributing bank (mortgageLoanSeller) — its category folders. */
export interface DataRoomTreeBank {
  readonly bank: string;
  readonly categories: readonly DataRoomTreeCategory[];
  readonly fileCount: number;
}

/** The "New Issue" level, wrapping the deal-name repeat and its banks. */
export interface DataRoomTreeNewIssue {
  /** The deal name, repeated under "New Issue" (mirrors the Intralinks shape). */
  readonly dealName: string | null;
  readonly banks: readonly DataRoomTreeBank[];
  readonly fileCount: number;
}

/** The whole read-only tree for one pool (deal). */
export interface DataRoomTree {
  readonly poolId: string;
  readonly poolName: string | null;
  readonly seller: string | null;
  /** null when the pool has no documents. */
  readonly newIssue: DataRoomTreeNewIssue | null;
  readonly fileCount: number;
}
