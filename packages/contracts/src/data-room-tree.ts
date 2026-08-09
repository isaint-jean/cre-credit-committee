import type { DocTypeCategory, DocTypeTier } from './doctype-taxonomy.js';

/**
 * Data Room — read-only nested tree (Chunk 1).
 *
 * The Intralinks-style hierarchy over documents that ALREADY exist, composed
 * server-side from projectByLoan + DOC_TYPE_CATEGORY + the selected-version
 * tiebreak:  Deal (pool) → Loan → Category → docType slot → file.
 *
 * This is purely a READ projection — no new persistence, no mutation. Two rules
 * the shape guarantees:
 *   - ON-DEMAND FOLDERS: a loan / category / slot node is present ONLY when it
 *     contains ≥1 file (empty folders are never emitted).
 *   - DETERMINISTIC, SERVER-OWNED ORDERING: loans in listPoolDocs order,
 *     categories in CATEGORIES_IN_ORDER, slots in DOC_TYPE_TAXONOMY order,
 *     versions newest-first.
 */

/** One physical file (one version) under a (loan, docType) slot. */
export interface DataRoomTreeFile {
  readonly fileHash: string;
  readonly fileName: string;
  readonly size: number;
  /** ISO-8601 upload timestamp (always present — the receipt date fallback). */
  readonly uploadedAt: string;
  /** Extracted content / as-of date (ISO), or null when none was parseable. */
  readonly docEffectiveDate: string | null;
  /** Human pin: this version wins its slot for underwriting. */
  readonly pinned: boolean;
  /** The version that wins the slot (pinned → latest docEffectiveDate → latest uploadedAt). */
  readonly isSelectedVersion: boolean;
  /** 1-based position among the slot's versions, newest→oldest (for a "v{i} of {n}" badge). */
  readonly versionIndex: number;
  readonly versionCount: number;
}

/** A docType slot within a category (e.g. "appraisal"), holding its versions. */
export interface DataRoomTreeSlot {
  readonly docType: string;
  readonly label: string;
  readonly tier: DocTypeTier;
  readonly files: readonly DataRoomTreeFile[];
}

/** A human category folder (e.g. "Third-Party Reports") within a loan. */
export interface DataRoomTreeCategory {
  readonly category: DocTypeCategory;
  readonly slots: readonly DataRoomTreeSlot[];
  readonly fileCount: number;
}

/** A loan within the deal, with its category folders. */
export interface DataRoomTreeLoan {
  readonly loanInPoolId: string;
  /** Resolved display name (LoanInPool.propertyName), or null if unresolved. */
  readonly propertyName: string | null;
  readonly categories: readonly DataRoomTreeCategory[];
  readonly fileCount: number;
}

/** The whole read-only tree for one pool (deal). */
export interface DataRoomTree {
  readonly poolId: string;
  readonly poolName: string | null;
  readonly seller: string | null;
  readonly loans: readonly DataRoomTreeLoan[];
  readonly fileCount: number;
}
