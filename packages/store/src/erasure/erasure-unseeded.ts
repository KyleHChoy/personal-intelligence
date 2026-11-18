// The id-bearing columns erasure-completeness.db.test.ts does not seed with one of the canary's ids,
// each with why and the test file that exercises its erasure hook. The walk proves the seeded
// columns. A column here is proved only where its named test asserts it on a line marked
// `erasure-proves: schema.table.column`, which tests/structure/erasure-unseeded.test.ts checks; the
// erasure claim (tools/prove/claims.json) runs every named test. A column marked `unproved` has no
// such assertion yet: its named test reads the table but does not show an erasure leaves the column
// holding no erased id, so nothing proves it. Each leaves this list's `unproved` once its test asserts
// it or the walk seeds it.

const S = "packages/store/src";
const PI = "apps/pi/src";

export type Unseeded = { readonly why: string; readonly test: string; readonly unproved?: true };

export const NOT_SEEDED: Readonly<Record<string, Unseeded>> = {
  "knowledge.promoted_claims.subject_id": {
    why: "a receiving instance's intake, which this world is not; the promotion's deletion notice removes it",
    test: `${S}/promotion/promotion.db.test.ts`,
  },
  "ledger.promotions.claim_ids": {
    why: "the canary is never promoted; the erasure rewrites a promotion's claim ids",
    test: `${S}/promotion/promotion.db.test.ts`,
    unproved: true,
  },
  "knowledge.removed_evidence.evidence_ids": {
    why: "the erasure's own record, written by the erasure",
    test: `${S}/erasure/erasure-paths.db.test.ts`,
  },
  "ledger.agent_writes.evidence_id": {
    why: "an agent record's own evidence row, never one of the canary's; a removed record keeps its ids",
    test: `${S}/write/writer-records.db.test.ts`,
    unproved: true,
  },
  "ledger.surfaced_items.evidence_ids": {
    why: "written by the timer's read; the source_checks hook removes it",
    test: `${PI}/extract/dream-recall.db.test.ts`,
    unproved: true,
  },
  "ledger.dream_identity_candidates.evidence_ids": {
    why: "written by the dream pass, which no line turns on here; ledger.forget_dream_merges takes it",
    test: `${PI}/extract/dream-pass.db.test.ts`,
  },
  "ledger.dream_subjects.entity_id": {
    why: "written by the dream pass, which no line turns on here; it goes with its entity by cascade",
    test: `${S}/write/writer-removal-tables.db.test.ts`,
    unproved: true,
  },
  "ledger.signal_marks.ref_id": {
    why: "a removed message, event or person takes its marks by trigger",
    test: `${S}/work/agent-seam.db.test.ts`,
  },
  "ledger.change_log.ref_id": {
    why: "an agent message's or a piece of work's id, never a canary's entity, item, message or claim",
    test: `${S}/work/agent-seam.db.test.ts`,
    unproved: true,
  },
  "knowledge.captures.evidence_id": {
    why: "a Lens capture, which this world has none of; a capture's erasure removes it",
    test: `${S}/lens/capture-erasure.db.test.ts`,
  },
  "ledger.capture_inbox.evidence_id": {
    why: "a Lens capture waiting to be taken in; the capture's forgetting removes it",
    test: `${S}/admin/lens/capture-forget.db.test.ts`,
    unproved: true,
  },
  "ledger.goal_proposals.target_entity_id": {
    why: "an agent's proposed goal target; taint_citing taints a proposal naming an erased entity",
    test: `${S}/cards/goal-target-proposals.db.test.ts`,
    unproved: true,
  },
  "knowledge.claim_org_names.claim_id": {
    why: "an organization named in a claim; it goes with its claim",
    test: `${S}/write/named-orgs.db.test.ts`,
  },
  "knowledge.claim_releases.evidence_id": {
    why: "a release of an agent's claim; it goes with the claim's evidence",
    test: `${PI}/agents/claim-release.db.test.ts`,
  },
  "knowledge.contact_addresses.entity_id": {
    why: "an imported contact's address; the identity removal deletes it with its person",
    test: `${S}/write/writer-contacts.db.test.ts`,
    unproved: true,
  },
  "knowledge.contacts.evidence_id": {
    why: "an imported contact, which this world has none of; the identity removal deletes it with its item",
    test: `${S}/admin/erasure/admin-erase-identity.db.test.ts`,
  },
  "knowledge.domains.entity_id": {
    why: "an organization's domain, and the canary is a person; it goes with its organization",
    test: `${S}/admin/erasure/admin-erase.db.test.ts`,
  },
  "knowledge.goal_ids.claim_id": {
    why: "a goal's claim ids; the erasure's item path removes them",
    test: `${S}/erasure/erasure-paths.db.test.ts`,
    unproved: true,
  },
  "knowledge.goal_ids.evidence_id": {
    why: "a goal's evidence ids; the erasure's item path removes them",
    test: `${S}/erasure/erasure-paths.db.test.ts`,
    unproved: true,
  },
  "knowledge.interaction_log.member_id": {
    why: "a member's id, never an entity's, item's, message's or claim's; the row goes with its item",
    test: `${S}/write/writer-erasure.db.test.ts`,
    unproved: true,
  },
  "knowledge.pages.about_entity_id": {
    why: "a research page, which this world has none of; the pages hook removes it",
    test: `${S}/erasure/erasure-reach.db.test.ts`,
    unproved: true,
  },
  "knowledge.pages.evidence_id": {
    why: "a research page, which this world has none of; the pages hook removes it",
    test: `${S}/erasure/erasure-reach.db.test.ts`,
    unproved: true,
  },
  "knowledge.signatures.evidence_id": {
    why: "a mail signature, which this world's canary mail has none of; forgetting removes it",
    test: `${S}/erasure/forgetting-database.db.test.ts`,
    unproved: true,
  },
  "ledger.agent_message_reads.message_id": {
    why: "an agent message's id, never a knowledge message's",
    test: `${PI}/e2e.db.test.ts`,
    unproved: true,
  },
  "ledger.basis.row_id": {
    why: "the row a basis line belongs to; a tainted row keeps its basis, the cited ids gone",
    test: `${S}/admin/erasure/admin-erase.db.test.ts`,
  },
  "ledger.cases.about_id": {
    why: "a piece of work's subject; taint_citing taints a case about an erased entity",
    test: `${S}/work/lesson-lineage.db.test.ts`,
    unproved: true,
  },
  "ledger.context_packs.item_ids": {
    why: "a pack an agent built, which no agent builds here; the pi erase removes the items from it",
    test: `${PI}/owner/erase.e2e.db.test.ts`,
    unproved: true,
  },
  "ledger.coverage_states.row_id": {
    why: "a coverage measure's own row id, never an entity's, item's, message's or claim's",
    test: `${S}/admin/outcomes/coverage.db.test.ts`,
    unproved: true,
  },
  "ledger.decision_point_calls.subject_id": {
    why: "a send or a move's gate decision; taint_citing taints one about an erased subject",
    test: `${S}/write/send-functions.db.test.ts`,
    unproved: true,
  },
  "ledger.expected_outcomes.subject_id": {
    why: "a piece of work's expected outcome; the triggers hook removes one naming an erased subject",
    test: `${S}/work/work-outcomes.db.test.ts`,
    unproved: true,
  },
  "ledger.hypotheses.about_id": {
    why: "a hypothesis's subject; taint_citing taints one about an erased entity",
    test: `${S}/work/lesson-lineage.db.test.ts`,
    unproved: true,
  },
  "ledger.mirror_entries.entity_ids": {
    why: "a Lens mirror entry, which this world has none of; the mirror hook taints it",
    test: `${S}/erasure/exposures-database.db.test.ts`,
    unproved: true,
  },
  "ledger.move_result_links.ref_id": {
    why: "a move's result link; the triggers hook removes one naming an erased ref",
    test: `${S}/work/work-outcomes.db.test.ts`,
    unproved: true,
  },
  "ledger.opportunities.about_id": {
    why: "a piece of work's subject; taint_citing taints one about an erased entity",
    test: `${S}/work/learning-taint.db.test.ts`,
    unproved: true,
  },
  "ledger.outcome_assessments.subject_id": {
    why: "an outcome's assessment; taint_citing taints one about an erased subject",
    test: `${S}/work/learning-taint.db.test.ts`,
    unproved: true,
  },
  "ledger.outcome_checks.claim_id": {
    why: "an outcome check; the triggers hook removes one naming an erased claim",
    test: `${S}/work/outcome-match.db.test.ts`,
    unproved: true,
  },
  "ledger.owner_views.target_id": {
    why: "what the owner opened, a piece of work's or a card's id, never an entity's, item's, message's or claim's",
    test: `${S}/work/learning-schema.db.test.ts`,
    unproved: true,
  },
  "ledger.point_verdicts.evidence_id": {
    why: "a calibration verdict; the decision_calls hook removes one on an erased item",
    test: `${S}/admin/cards/admin-calibration.db.test.ts`,
    unproved: true,
  },
  "ledger.record_events.row_id": {
    why: "a ledger row's event; a tainted row keeps its events, the cited ids gone",
    test: `${S}/admin/erasure/admin-erase.db.test.ts`,
    unproved: true,
  },
  "ledger.relation_checks.claim_id": {
    why: "a relation check on a claim; it goes when its claim's relation is orphaned",
    test: `${PI}/extract/relations.db.test.ts`,
    unproved: true,
  },
  "ledger.research_fetches.evidence_id": {
    why: "a research fetch, which this world has none of; the research_requests hook removes it",
    test: `${S}/work/research-database.db.test.ts`,
    unproved: true,
  },
  "ledger.research_requests.about_entity_id": {
    why: "a research request, which this world has none of; the research_requests hook taints it",
    test: `${S}/erasure/erasure-reach.db.test.ts`,
    unproved: true,
  },
  "ledger.research_requests.message_id": {
    why: "a research request, which this world has none of; the research_requests hook taints it",
    test: `${S}/erasure/erasure-reach.db.test.ts`,
    unproved: true,
  },
  "ledger.source_checks.evidence_ids": {
    why: "written by the dream pass, which no line turns on here; the source_checks hook removes it",
    test: `${PI}/extract/dream.db.test.ts`,
    unproved: true,
  },
  "ledger.work_notices.outcome_ref_id": {
    why: "a notice about a piece of work's outcome; it goes when the work is tainted",
    test: `${S}/work/work-notices.db.test.ts`,
    unproved: true,
  },
  "projections.declassified_facts.evidence_id": {
    why: "a fact the owner declassified, which this world has none of; it is rebuilt from claims",
    test: `${S}/admin/rulings/admin-declassify.db.test.ts`,
    unproved: true,
  },
  "vault.extraction_reviews.claim_id": {
    why: "an extraction review, which this world has none of; the item removal deletes it",
    test: `${S}/write/writer-extraction.db.test.ts`,
    unproved: true,
  },
  "vault.sent_recipients.evidence_id": {
    why: "a sent item's recipients, and the canary's mail is received; the item removal deletes them",
    test: `${S}/admin/erasure/admin-erase.db.test.ts`,
  },
};
