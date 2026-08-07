# Scoping Doc: Chunk 7 — Originator Communication / Negotiation Actions

Status: scoping. Sub-chunk 7a (permissions + kick gate) is the first build; 7b–7e held.

## A. Current state

### A1. Buyer decisions the originator would respond to
- Committee actions (6 kinds): SUBMIT_TO_COMMITTEE, REQUEST_MORE_INFO, OVERRIDE_DECISION,
  APPROVE_DEAL, REJECT_DEAL, POSTPONE_DEAL. Buyer holds approve/reject/request-info (ch.1) — so
  REJECT + REQUEST_MORE_INFO are buyer decisions. Built + server-enforced.
- Disposition/kick (pool.ts): DISPOSITION_KINDS = ['dropped','kicked']; reasons disqualifying |
  couldnt_structure | expired | withdrawn. `kicked` ← disqualifying/couldnt_structure = the BUYER's
  kick (via api.dispositionLoan / DispositionBar). Built, but the per-loan disposition route was
  UNGATED (no permission check) — 7a fixes this.
- DQ request channel: buyer writes `dq:<code>` side-tagged overlay comments; the originator's
  OpenFlagsPanel receives them. Built.

### A2. Existing originator affordances
- Side-tagged overlay comments (`side:'originator'`) — LIVE, gated by workflow:override (originator
  holds it). The key existing cross-role messaging primitive.
- Respond-by-upload (FlagUploadAction → appendDocument) — LIVE.
- Lever ratify (OVERRIDE_DECISION) — LIVE.
- Request a call — PREVIEW only (no-op session Set).
- Push-back (structured) / send-to-buyer / "waiting on buyer" — MISSING (net-new).

### A3. Event / lifecycle / permission model
- Two event channels: committee-actions → CommitteeActionsStore.insert → compute-deal-workflow-state
  re-projects DealWorkflowState; overlay-comments → comment-added audit event + side-tagged
  OverlayCommentPatch. Comms can reuse the comment channel; status-changing actions need new kinds.
- Lifecycle states BUILT: DRAFT → IN_REVIEW → IN_COMMITTEE → APPROVED/REJECTED/POSTPONED (from the
  committee-action chain) + overlay-created → IN_REVIEW; pool terminals close/kicked/dropped.
  "Cleared" is a derived read (not stored). No originator states (awaiting-buyer, pushed-back,
  call-requested) exist.
- Permissions (ch.1): originator has read/audit/snapshot-read/analysis:revise/workflow:override.

## B. Target — the four originator actions
- PUSH BACK — contest a buyer requirement/decision (minimal = side-tagged comment; structured = event).
- REQUEST A CALL — persist the ask (currently preview) so the buyer sees it.
- SEND-TO-BUYER — submit the seller UW to the buyer (mirror of SUBMIT_TO_COMMITTEE, originator→buyer);
  new state SENT_TO_BUYER → AWAITING_BUYER.
- WAITING ON BUYER — a STATUS (derived from sent + no buyer response), not an action.

## C. Gap → sub-chunks (Size S/M/L · Risk Lo/Med/Hi)
- 7a — permissions + kick gate. S · Med. Add workflow:respond/request-call/send-to-buyer (→ ORIGINATOR)
  + workflow:dispose (→ BUYER/COMMITTEE_MEMBER/ADMIN, NOT originator); gate the per-loan disposition
  route. ← THIS BUILD.
- 7b — event kinds + workflow states. M · Hi. New event kinds + SENT_TO_BUYER/AWAITING_BUYER states;
  extend compute-deal-workflow-state. Highest risk (every workflow-state consumer). Deps: 7a.
- 7c — originator action UI. M · Lo-Med. Buttons in "Let's Structure This Deal Together" + waiting chip.
  Deps: 7a,7b.
- 7d — buyer-side notification/visibility. M · Med. Deps: 7b.
- 7e — real Request-a-call MVP via the existing side-tagged comment channel. S · Lo. Near view-only.

## D. View-only vs backend
- Real backend (bugs matter): 7a (perms + kick gate + denial tests), 7b (events/states — riskiest),
  7d (read projection).
- Mostly view: 7c (UI), 7e (reuses the live comment channel).

## E. Recommended order + honest total size
Start 7e (real request-a-call via comments — near view-only, quick real win) → 7a (perms + kick gate)
→ 7b (the event/state engine — deliberate, with tests) → 7c (UI) + 7d (buyer visibility). Honest total
size: L overall — a real two-sided negotiation feature (new perms, new lifecycle states, new events,
cross-role UI, notifications). ~5 sub-chunks over several sessions; 7a/7b need Chunk 1-2 auth/lifecycle
rigor (backups, denial tests, byte-identical). Not a one-shot.

## F. Net-new
Structured push-back; a real request-a-call; send-to-buyer; AWAITING_BUYER state; buyer-side
notifications; role-enforced buyer kick (the deferred disposition gate — 7a).
