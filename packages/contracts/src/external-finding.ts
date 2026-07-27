/**
 * ExternalFinding — the HONESTY MODEL for due-diligence signal fetched from OUTSIDE
 * the deal documents (sponsor/borrower reputation, nearby foreclosures / distressed
 * comps, market red flags). It is the foundation every later piece (fetch, cache,
 * render) carries: get the shape + the guard right and those layers are safe by
 * construction.
 *
 * TWO LOAD-BEARING INVARIANTS, enforced by the type's SHAPE and the guard below:
 *
 *   1. NEVER A FACT. A finding stores REPORTED SPEECH — `claim: string`, e.g.
 *      "reported association with a 2019 fraud settlement" — never an asserted
 *      boolean/number. There is deliberately NO `hasFraudHistory: boolean` field;
 *      the type makes it awkward to store a bare fact. Anything that renders is
 *      wrapped as "a [publisher] report ([date]) indicates … — the committee should
 *      confirm", never presented as established.
 *
 *   2. NEVER A SCORE INPUT. ExternalFinding carries NO numeric or boolean field the
 *      doctrine scorer could read, and no function maps a finding to a
 *      SponsorAssessment or any dimension input. The ONLY path to the score is a
 *      human — after READING a finding — separately entering a real HITL
 *      SponsorAssessment (dim 9); that human judgment, not the finding, is the score
 *      input. The finding cannot reach the scorer programmatically. (Asserted by
 *      apps/api/src/scripts/test-external-finding.ts: no doctrine-clean file imports
 *      this module, and the type exposes no numeric/boolean field.)
 *
 * The defamation guard (computeRenderDecision) decides — as a PURE, deterministic
 * function of the finding — whether the specific claim may be repeated. The
 * render decision is COMPUTED by the guard, never hand-set; that is why it is NOT a
 * field on ExternalFinding.
 */

import type { ISODateTime } from './versioning.js';

/** 'person' = a named person/entity (high defamation bar). 'property_market' = facts
 *  about a PLACE (low bar — a nearby foreclosure is public information, not a
 *  reputational claim about a person). */
export type ExternalSubjectType = 'person' | 'property_market';

/** Verifiability of the claim's KIND, ascending: a lawsuit's allegation is the least
 *  verifiable; a news-reported event more so; a recorded primary document most. */
export type ExternalClaimKind = 'allegation' | 'reported_event' | 'public_record';

/** Declared corroboration tier. The guard does NOT trust this blindly — it
 *  re-derives corroboration from the EVIDENCE (isEvidenceCorroborated), so a
 *  mislabeled tier cannot bypass the person-suppression rule. */
export type ExternalVerificationTier = 'external-unverified' | 'external-corroborated';

/** Polarity of the finding. The guard's high bar applies only to NEGATIVE
 *  reputational claims about people. */
export type ExternalSentiment = 'negative' | 'neutral' | 'positive';

/** Guard output. 'render' = may surface the specific claim (always caveated).
 *  'suppress_specific' = may prompt diligence but NEVER repeat the specific claim.
 *  'blank' = nothing may render (e.g. an unsourced finding). */
export type ExternalRenderDecision = 'render' | 'suppress_specific' | 'blank';

export interface ExternalSource {
  readonly url: string;
  /** The outlet or record-keeper. INDEPENDENCE is counted by distinct publisher. */
  readonly publisher: string;
  /** The source's own publication / record date. */
  readonly asOfDate: ISODateTime;
}

export interface ExternalFinding {
  /** Drives the defamation threshold — see the guard. */
  readonly subjectType: ExternalSubjectType;
  /** Who/what the finding is about: a sponsor/borrower name, or a property / address. */
  readonly subject: string;
  /** REPORTED SPEECH, never an assertion. e.g. "reported association with a 2019 fraud settlement". */
  readonly claim: string;
  readonly claimKind: ExternalClaimKind;
  readonly verificationTier: ExternalVerificationTier;
  readonly sentiment: ExternalSentiment;
  /** ≥1 source. Corroboration = ≥2 INDEPENDENT publishers OR a primary public record.
   *  A finding with zero sources can never render. */
  readonly sources: readonly ExternalSource[];
  /** When THIS platform retrieved the finding — pins it in time for the (later)
   *  determinism layer. */
  readonly retrievedAt: ISODateTime;
  // INVARIANT: no numeric / boolean fact field. Adding one would let the finding be
  // read as a fact or a score input — both forbidden.
}

/* --------------------------- the defamation guard ------------------------- */

/** Count of INDEPENDENT sources = distinct publishers (case/whitespace-insensitive). */
export function independentSourceCount(sources: readonly ExternalSource[]): number {
  return new Set(
    sources.map((s) => s.publisher.trim().toLowerCase()).filter((p) => p.length > 0),
  ).size;
}

/**
 * Whether the EVIDENCE (not the declared `verificationTier` label) corroborates the
 * claim: a primary public record, OR ≥2 independent publishers. The guard keys on
 * this — never on the label — so a finding hand-labeled 'external-corroborated' but
 * backed by a single blog cannot slip a person's unconfirmed claim into the memo.
 */
export function isEvidenceCorroborated(finding: ExternalFinding): boolean {
  if (finding.claimKind === 'public_record') return true;
  return independentSourceCount(finding.sources) >= 2;
}

/**
 * THE DEFAMATION GUARD. Pure and deterministic: (finding) → renderDecision. Rules
 * (Isabelle's):
 *
 *   6. sources empty            → 'blank'  (an unsourced claim can never be repeated).
 *   3. subjectType property_market → 'render' (facts about PLACES, low risk).
 *   —  person, non-negative     → 'render' (no defamation risk in neutral/positive news).
 *   1 & 2. person + NEGATIVE    → repeat the SPECIFIC claim ONLY when the EVIDENCE
 *          corroborates it (a primary public record OR ≥2 independent sources);
 *          otherwise 'suppress_specific' — the memo may recommend further diligence
 *          but NEVER repeats the specific unconfirmed claim about a named person.
 */
export function computeRenderDecision(finding: ExternalFinding): ExternalRenderDecision {
  if (finding.sources.length === 0) return 'blank';                        // rule 6
  if (finding.subjectType === 'property_market') return 'render';          // rule 3
  if (finding.sentiment !== 'negative') return 'render';                   // person, not adverse
  return isEvidenceCorroborated(finding) ? 'render' : 'suppress_specific'; // rules 1 & 2
}

/* --------------------------- safe rendering ------------------------------- */

/** The ONLY thing a suppressed person-finding may surface — no claim, no source. */
export const EXTERNAL_FINDING_SUPPRESSED_TEXT =
  'Further diligence is recommended on the sponsor.' as const;

export interface RenderedExternalFinding {
  readonly decision: ExternalRenderDecision;
  /**
   * Committee-facing text, or null when 'blank'. For 'suppress_specific' this is the
   * generic diligence prompt with NO claim and NO source. For 'render' it is the
   * claim wrapped as reported speech with source + as-of date + a confirm caveat —
   * never presented as an established fact.
   */
  readonly text: string | null;
}

/**
 * Strip a leading reporting-verb prefix from a reported-speech claim so it reads
 * cleanly after the wrapper's "… report (…) indicates". The classifier phrases
 * claims as reported speech ("Reported that a former executive …"), which would
 * otherwise collide: "indicates Reported that …". We drop a leading
 * "Reported that " / "Report(s) that " / "It was reported that " (case-
 * insensitive) and re-capitalize the first letter. Idempotent; leaves other
 * phrasings ("a lawsuit alleges …") untouched.
 */
export function stripReportingPrefix(claim: string): string {
  const stripped = claim.replace(
    /^\s*(?:it\s+was\s+reported\s+that|reports?\s+that|reported\s+that)\s+/i,
    '',
  );
  if (stripped === claim) return claim.trim();
  const t = stripped.trim();
  return t.length > 0 ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

/**
 * Resolve a finding to its ONLY sanctioned committee-facing rendering. Combines the
 * guard with the safe text forms: never returns the specific claim for a
 * 'suppress_specific' decision; never returns an un-caveated claim for 'render'.
 */
export function renderExternalFinding(finding: ExternalFinding): RenderedExternalFinding {
  const decision = computeRenderDecision(finding);
  if (decision === 'blank') return { decision, text: null };
  if (decision === 'suppress_specific') return { decision, text: EXTERNAL_FINDING_SUPPRESSED_TEXT };
  // 'render' — rule 4: reported speech + source + as-of date + confirm caveat, never a fact.
  const primary = finding.sources[0]!;
  const caveat = isEvidenceCorroborated(finding)
    ? 'the committee should independently confirm the source'
    : 'unverified; the committee should confirm';
  // Strip a leading "Reported that …" so it doesn't collide with "indicates".
  const claim = stripReportingPrefix(finding.claim);
  const text = `A ${primary.publisher} report (${primary.asOfDate}) indicates ${claim} — ${caveat}.`;
  return { decision, text };
}
