import { TRIGGER_BUCKET_LOCK, TRIGGER_BUCKET_OF } from "../core/locks.ts";
import { revokeErased } from "../core/promotion-revoke.ts";
import { DECISION_CALL_PREFIX, IS_OWNER_JUDGE } from "../core/stored-forms.ts";
import { eraseFromQuestions } from "../identity/identity-answers-erasure.ts";
import { countDays, removeWarmth } from "../identity/warmth-build.ts";
import { capturesErasure } from "../lens/capture-erasure.ts";
import { chatLinesErasure } from "../lens/chat-lines.ts";
import { removeRecords } from "../write/writer-records.ts";
import { agentPeopleErasure } from "./erasure-agent-people.ts";
import { DOCUMENTS_HOOK } from "./erasure-documents.ts";
import { dreamFindingsErasure } from "./erasure-dream.ts";
import { agentCloses, factCards, factRulings, goalKeys, goneOf } from "./erasure-fact-keys.ts";
import { goalTargetNames, goalTargets } from "./erasure-goal-targets.ts";
import {
  allEvidence,
  countOf as count,
  type Erased,
  type ErasureHook,
  idsOf,
  peopleOf,
  removes,
  removing,
} from "./erasure-hook.ts";
import { researchFillsErasure } from "./erasure-research.ts";
import { timeRulingsErasure } from "./erasure-time.ts";
import { anchoredRulings, NAMES_PEOPLE, TAINTED_HERE, taintCiting } from "./taint.ts";

// What each hook removes of its own in an erasure: one row of ERASURE_HOOKS each, run in that order
// inside the erasure's transaction and after the removal. Each reads what the removal left. What a
// row needs of another's having run is ERASURE_ORDER, below.

// An erased item's revisions and the evidence rows of the agent records removed with them, those
// records by id, and the facts their claims carried.
const EXPOSED = `
  select x.id, x.recipient_kind, x.recipient, x.compartments from ledger.exposures x
  where (x.ref_kind = 'evidence' and x.ref = any($1::text[]))
     or (x.ref_kind = 'record' and x.ref = any($2::text[]))
     or (x.ref_kind = 'fact' and x.ref = any($3::text[]))`;

const exposedValues = (erased: Erased): unknown[] => [allEvidence(erased), erased.records, erased.factKeyFps];

// So is every ignore ruling that holds an erased address's fingerprint, and each same-person question and its answers; a domain ignore
// narrowed to addresses loses each erased one, and stays. A dry run only counts. An answer cites a message, a contact, a name or an
// address, never an agent record, so its evidence is the revisions'.
const identity: ErasureHook = {
  name: "identity",
  async run(query, erased, options) {
    const where = "a_fp = any($1) or b_fp = any($1)";
    const ignored = "subject = 'address' and value_fps && $1::text[]";
    const narrowed = "subject = 'domain' and address_fps && $1::text[]";
    const questions = await eraseFromQuestions(
      query,
      erased.addressFps,
      erased.evidenceIds,
      peopleOf(erased),
      options.dryRun,
    );
    const [row] = options.dryRun
      ? await query<{ n: number }>(
          `select (select count(*) from knowledge.identity_rulings where ${where})::int + (select count(*) from knowledge.ignore_rulings where ${ignored})::int
             + (select count(*) from knowledge.ignore_rulings where ${narrowed})::int as n`,
          [erased.addressFps],
        )
      : await query<{ n: number }>(
          `with gone as (delete from knowledge.identity_rulings where ${where} returning 1), unignored as (delete from knowledge.ignore_rulings where ${ignored} returning 1),
             unnarrowed as (update knowledge.ignore_rulings set address_fps = array(select x from unnest(address_fps) as x where not (x = any ($1::text[]))) where ${narrowed} returning 1)
           select (select count(*) from gone)::int + (select count(*) from unignored)::int + (select count(*) from unnarrowed)::int as n`,
          [erased.addressFps],
        );
    // A split report kept with one part only to find its rulings by links nothing once
    // they are deleted.
    if (!options.dryRun)
      await query(
        `delete from ledger.wrong_merge_reports r where r.state = 'split' and cardinality(r.parts) < 2
           and not exists (select 1 from knowledge.identity_rulings i where i.ruling_id = any (r.ruling_ids))`,
      );
    return (row?.n ?? 0) + (erased.identityQuestions ?? questions);
  },
};

// An erased person's warmth. The items went through removeSourceItem, which deleted the days of
// every label that could see one of their mail or meeting rows; here, the days of every label that
// held a day of the person's, by containment of that label, so every label that could see what the
// person's days rested on loses its days and is marked removed until the next build (invariant
// 10). The claims naming the person, their owner_tie among them, went in step 8 of the erasure (admin-erase.ts)
// under the same rule. A dry run counts.
const warmth: ErasureHook = {
  name: "warmth",
  after: {
    hooks: ["chat_lines"],
    why: "chat_lines removes the warmth days of each label that could see a line, so warmth finds those labels emptied",
  },
  async run(query, erased, { dryRun }) {
    const people = peopleOf(erased);
    if (people.length === 0) return 0;
    const held = (
      await query<{ label: string[] }>(
        "select distinct compartments as label from projections.warmth_days where entity_id = any ($1::text[])",
        [people],
      )
    ).map((row) => row.label);
    return dryRun ? countDays(query, held) : removeWarmth(query, held);
  },
};

// Every tier ruling that holds an erased address's fingerprint is deleted, as the ignore rulings
// that hold one are; the owner decisions behind them stay, holding ids only. A dry run only counts.
const tierRulings = removes("tier_rulings", [
  { table: "knowledge.tier_rulings", where: "value_fps && $1::text[]", values: (erased) => [erased.addressFps] },
]);

// A dry run only counts.
const ownerListMembers = removes("owner_list_members", [
  { table: "knowledge.owner_list_members", where: "value_fps && $1::text[]", values: (erased) => [erased.addressFps] },
]);

// An erased person's id leaves every hide of the owner's Remove; a hide left naming no one is deleted,
// and one still naming a member left standing keeps that member removed. The owner decisions behind
// them stay. A dry run counts the hides it would change.
const personHides: ErasureHook = {
  name: "person_hides",
  async run(query, erased, { dryRun }) {
    const people = peopleOf(erased);
    if (people.length === 0) return 0;
    return dryRun
      ? count(query, "select count(*)::int as n from knowledge.person_hides where entity_ids && $1::text[]", [people])
      : count(
          query,
          `with gone as (delete from knowledge.person_hides where entity_ids <@ $1::text[] returning 1),
             kept as (update knowledge.person_hides set entity_ids = array(select m from unnest(entity_ids) as m where m <> all ($1::text[]))
                      where entity_ids && $1::text[] and not entity_ids <@ $1::text[] returning 1)
           select ((select count(*) from gone) + (select count(*) from kept))::int as n`,
          [people],
        );
  },
};

// The owner decisions behind them stay, holding ids only. A dry run counts the rows it would change.
const personNames: ErasureHook = {
  name: "person_names",
  async run(query, erased, { dryRun }) {
    const people = peopleOf(erased);
    const values = [people, erased.addressFps];
    const hit = "(entity_ids && $1::text[] or value_fps && $2::text[])";
    return dryRun
      ? count(query, `select count(*)::int as n from knowledge.person_names where ${hit}`, values)
      : count(
          query,
          `with gone as (delete from knowledge.person_names where ${hit} and entity_ids <@ $1::text[] returning 1),
             kept as (update knowledge.person_names
                      set entity_ids = array(select m from unnest(entity_ids) as m where m <> all ($1::text[])),
                          value_fps = array(select f from unnest(value_fps) as f where f <> all ($2::text[]))
                      where ${hit} and not entity_ids <@ $1::text[] returning 1)
           select ((select count(*) from gone) + (select count(*) from kept))::int as n`,
          values,
        );
  },
};

// The owner's decisions with no target row, reached by what they act on (their `subject_fps`): each
// holding an erased address's fingerprint, or the fact key of a commitment the erasure leaves no
// claim of, is tainted by ledger.taint_subject_decisions, as ledger.taint_citing taints a decision
// whose target is gone, its fingerprints emptied. A close of a calendar item names no fact: its subject
// is the event's evidence id, an erased one of which is here as well. A dry run counts them by the same
// function, the claims the erasure would remove counted as gone. The fact keys handed are those
// that are gone (erasure-hook.ts, `goneKeyFps`); the function also takes what else holds such a
// key: a close's and a reopen's details, the reopen rows, and an agent's close record
// (ledger.forget_commitment_keys).
const subjectDecisions: ErasureHook = {
  name: "subject_decisions",
  taints: true,
  after: {
    hooks: ["agent_closes"],
    why: "agent_closes finds a close by the commitment's key, which subject_decisions replaces on the close's row",
  },
  async run(query, erased, { dryRun }) {
    return count(query, "select ledger.taint_subject_decisions($1::text[], $2::text[], $3::text[], $4) as n", [
      [...erased.addressFps, ...erased.evidenceIds],
      await goneOf(query, erased),
      erased.claimIds,
      dryRun,
    ]);
  },
};

// The owner decisions behind them stay, holding ids only. A dry run only counts.
const mentionBindings = removes("mention_bindings", [
  { table: "knowledge.mention_bindings", where: "address_fp = any($1)", values: (erased) => [erased.addressFps] },
]);

// The removal's cascade from the evidence rows already took an erased item's, so a real run finds them
// only where a revision was kept; a dry run counts them. Without a row, the organization is withheld
// everywhere, and nothing names it again until a live claim does. An agent record's own evidence row takes
// its name rows by the same cascade, so the revisions are enough.
const orgNames = removes("org_names", [
  {
    table: "knowledge.org_names",
    where: "evidence_id = any($1::text[]) or entity_id = any($2::text[])",
    values: (erased) => [erased.evidenceIds, peopleOf(erased)],
  },
]);

// A tainted verdict is not counted.
const DECISION_CALLS_HIT = "refs && $1::text[]";
const VERDICTS_HIT = `tainted_at is null and (evidence_id = any ($1::text[])
  or (starts_with(call_id, '${DECISION_CALL_PREFIX}') and not exists (select 1 from vault.decision_calls c where c.id = v.call_id))
  or call_id = any ($2::text[]))`;

// Over-removal is the direction invariant 10 allows. A dry run counts those of the projections the taint would reach, as
// vendor_exposures' dry run finds them.
const MEMORY_CHANGES = (projections: string) => `
  select w.id from ledger.agent_writes w
  where w.kind = 'memory_change' and w.body_enc is not null
    and exists (select 1 from ledger.memory_projections p where ${projections} and p.client_id = w.client_id and w.created_at >= p.first_served_at)
  order by w.id`;
const memoryChanges: ErasureHook = {
  name: "memory_changes",
  taints: true,
  async run(query, erased, { dryRun }) {
    if (dryRun) {
      return (
        await query<{ id: string }>(MEMORY_CHANGES("p.tainted_at is null and p.evidence_ids && $1::text[]"), [
          allEvidence(erased),
        ])
      ).length;
    }
    const ids = (await query<{ id: string }>(MEMORY_CHANGES(TAINTED_HERE("p.tainted_at")))).map((row) => row.id);
    const { removed, evidenceIds } = await removeRecords({ query }, ids);
    if (evidenceIds.length > 0) await taintCiting(query, { evidenceIds, refs: [] });
    return removed;
  },
};

// The count is of the requests this erasure tainted, whichever call did it.
const RESEARCH_HIT = `(('entity', q.about_entity_id) in (select * from unnest($1::text[], $2::text[]))
  or ('message', q.message_id) in (select * from unnest($1::text[], $2::text[])))`;
const researchRequests: ErasureHook = {
  name: "research_requests",
  taints: true,
  async run(query, erased, { dryRun }) {
    const refs = erased.refs.filter((ref) => ref.kind === "entity" || ref.kind === "message");
    const values = [refs.map((ref) => ref.kind), refs.map((ref) => ref.id)];
    if (dryRun)
      return count(
        query,
        `select count(*)::int as n from ledger.research_requests q where q.tainted_at is null and ${RESEARCH_HIT}`,
        values,
      );
    if (refs.length > 0) await query("select ledger.taint_citing('{}'::text[], $1::text[], $2::text[])", values);
    return count(
      query,
      `select count(*)::int as n from ledger.research_requests q where ${TAINTED_HERE("q.tainted_at")} and ${RESEARCH_HIT}`,
      values,
    );
  },
};

const FETCH_HIT = `f.body_enc is not null and (f.evidence_id = any($1::text[])
  or f.research_request_id in (select q.id from ledger.research_requests q where q.about_entity_id = any($2::text[]) or q.message_id = any($3::text[])))`;
const pages: ErasureHook = {
  name: "pages",
  run: (query, erased, { dryRun }) => {
    const values = [erased.evidenceIds, peopleOf(erased), idsOf(erased, "message")];
    return dryRun
      ? count(query, `select count(*)::int as n from ledger.research_fetches f where ${FETCH_HIT}`, values)
      : count(
          query,
          `with gone as (update ledger.research_fetches f set body_enc = null where ${FETCH_HIT} returning 1) select count(*)::int as n from gone`,
          values,
        );
  },
};

// The anchors on the erased evidence went with the removal (taint.ts). A join or a split that a
// claim under either of its keys said names the person took them into its entities before the
// removal (admin-erase.ts), so it is reached here too. A dry run counts the rulings, reading those
// claims itself.
const rulingAnchors: ErasureHook = {
  name: "ruling_anchors",
  after: {
    hooks: ["belief_rulings"],
    why: "the scrub tells a ruling that names an erased person by its entities, which ruling_anchors takes the person from",
  },
  run: async (query, erased, { dryRun }) => {
    return dryRun
      ? count(
          query,
          `select ((select count(*) from knowledge.belief_rulings r where r.claim_type is not null and r.entity_ids && $1::text[])
             + (select count(*) from knowledge.fact_rulings f where f.claim_type is not null and ${NAMES_PEOPLE("f", "$1")}))::int as n`,
          [peopleOf(erased)],
        )
      : count(query, "select knowledge.forget_ruling_anchors($1::text[], $2::text[]) as n", [[], peopleOf(erased)]);
  },
};

// The rulings anchored on the erased evidence or people were read before the removal emptied their
// anchors; a dry run reads them itself, and counts what the real run changes. A ruling's key is
// taken only when it is among the erasure's gone keys (erasure-hook.ts, `goneKeyFps`), the one set
// every hook removes by, so a ruling anchored on several items keeps its key while one of them
// stays, and a key taken here is taken from every other holder. The scrub tells a ruling that names
// an erased person by its entities, so it runs before `ruling_anchors` takes the person from them.
const beliefRulings: ErasureHook = {
  name: "belief_rulings",
  run: async (query, erased, { dryRun }) => {
    const anchored = erased.anchoredRulings ?? (await anchoredRulings(query, allEvidence(erased), peopleOf(erased)));
    return count(
      query,
      "select knowledge.scrub_belief_rulings($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8) as n",
      [
        anchored,
        erased.claimIds,
        erased.factKeyFps,
        erased.sources.map((one) => one.accountId),
        erased.sources.map((one) => one.sourceItemFp),
        await goneOf(query, erased),
        peopleOf(erased),
        dryRun,
      ],
    );
  },
};

// The settlements of the claims an erasure removes (ledger.fact_settlements: a claim's id, its
// evidence row and its claim key, with how the fact was settled) are deleted with them, by
// ledger.forget_fact_settlements: by claim id, by claim key, own and version 1, and by evidence row.
// A dry run counts them.
const factSettlements: ErasureHook = {
  name: "fact_settlements",
  async run(query, erased, { dryRun }) {
    return count(query, "select ledger.forget_fact_settlements($1::text[], $2::text[], $3::text[], $4) as n", [
      erased.claimIds,
      erased.claimKeys,
      allEvidence(erased),
      dryRun,
    ]);
  },
};

// Every relation naming a removed claim, by its claim key, is deleted in the erasure's transaction;
// a restore's replay runs the erasure again and deletes the relations the backup brought back. A
// claim's value rows go with the claim (on delete cascade). A dry run counts them.
const claimRelations = removes(
  "claim_relations",
  [
    {
      table: "knowledge.claim_relations",
      where: "from_claim_key = any($1::text[]) or to_claim_key = any($1::text[])",
      values: (erased) => [erased.claimKeys],
    },
  ],
  (erased) => erased.claimKeys.length > 0,
);

// Invariant 10, in the erasure's transaction, so no row names an erased claim even until the next
// pass: the trigger rows and the pending rechecks of every fact key that is gone are
// deleted; then every pending recheck that names an erased claim (added, removed, or a confirm's),
// whatever its key, is deleted, and for each key and label of those that still has a claim one
// recheck of cause `erasure` naming nothing takes their place, so the diff falls back to the last
// state logged (or writes a baseline). A key another item still holds keeps its trigger rows (they
// cite no claim). For a person, every trigger row whose anchors name the person goes too, whatever
// its key. The keys' bucket locks are taken first, in ascending order. A restore's replay runs the
// erasure again and repeats it. A dry run counts the rows it would delete. The count is of rows
// deleted.
const namesErased = (ids: string, items: string): string =>
  `added_claims && ${ids}::text[] or removed_claims && ${ids}::text[] or confirmed_claims && ${ids}::text[] or removed_items && ${items}::text[]`;
const triggers: ErasureHook = {
  name: "triggers",
  async run(query, erased, { dryRun }) {
    const ids = erased.claimIds;
    const people = peopleOf(erased);
    if (erased.factKeyFps.length === 0 && ids.length === 0 && people.length === 0) return 0;
    const gone = await goneOf(query, erased);
    const evidence = allEvidence(erased);
    const where = "fact_key_fp = any ($1::text[])";
    const anchoredOutside = `anchors && $2::text[] and not (${where})`;
    if (dryRun) {
      return (
        (await count(
          query,
          `select ((select count(*) from ledger.trigger_log where ${where}) + (select count(*) from ledger.trigger_rechecks where ${where}))::int as n`,
          [gone],
        )) +
        (await count(
          query,
          `select count(*)::int as n from ledger.trigger_rechecks where (${namesErased("$3", "$2")}) and not (${where})`,
          [gone, evidence, ids],
        )) +
        (await count(query, `select count(*)::int as n from ledger.trigger_log where ${anchoredOutside}`, [
          gone,
          people,
        ]))
      );
    }
    // The buckets of every key the hook touches, the pass's locks, before anything is deleted, in
    // ascending order as the pass takes them, so neither can deadlock the other.
    const anchoredKeys = (
      await query<{ fact_key_fp: string }>(
        "select distinct fact_key_fp from ledger.trigger_log where anchors && $1::text[]",
        [people],
      )
    ).map((row) => row.fact_key_fp);
    const buckets = await query<{ bucket: number }>(
      `select distinct ${TRIGGER_BUCKET_OF} as bucket from unnest($1::text[]) as k order by 1`,
      [[...erased.factKeyFps, ...anchoredKeys]],
    );
    for (const { bucket } of buckets) await query(TRIGGER_BUCKET_LOCK, [bucket]);
    const anchored = await count(
      query,
      `with rows as (delete from ledger.trigger_log where ${anchoredOutside} returning 1) select count(*)::int as n from rows`,
      [gone, people],
    );
    const emptied = await count(
      query,
      `with rows as (delete from ledger.trigger_log where ${where} returning 1), owed as (delete from ledger.trigger_rechecks where ${where} returning 1)
       select ((select count(*) from rows) + (select count(*) from owed))::int as n`,
      [gone],
    );
    const named = await query<{ fact_key_fp: string; compartments: string[] }>(
      `delete from ledger.trigger_rechecks where ${namesErased("$1", "$2")} returning fact_key_fp, compartments`,
      [ids, evidence],
    );
    const kept = [
      ...new Map(named.map((row) => [`${row.fact_key_fp}\n${JSON.stringify(row.compartments)}`, row])).values(),
    ];
    for (const row of kept) {
      await query(
        `insert into ledger.trigger_rechecks (fact_key_fp, cause, exact, compartments)
         select $1, 'erasure', false, $2 where exists (select 1 from knowledge.claims c where c.fact_key_fp = $1)`,
        [row.fact_key_fp, row.compartments],
      );
    }
    return anchored + emptied + named.length;
  },
};

// Invariant 10: in the erasure's transaction, every outcome link and outcome check that names an
// erased item (its evidence, or an agent record's removed with it) or an erased claim (by its claim
// key), every expectation whose subject is an erased person, message or event, with the links that
// name one, and every watch that came from an erased item or watches an erased person. Links first,
// which may name an expectation. A restore's replay runs the erasure again and repeats it. A dry
// run counts the rows it would delete. The count is of rows deleted. The erasure has already run
// ledger.taint_citing, which taints a link citing an erased item and clears its evidence id; such a
// link, tainted in this transaction and not a copy of an old link, is deleted too. A copy stays
// tainted, as its ledger.move_result_links row does.
const OUTCOME_LINKS_HIT = `evidence_id = any ($1::text[]) or claim_key = any ($2::text[])
  or expected_outcome_id in (select x.id from ledger.expected_outcomes x where x.subject_id = any ($3::text[]))
  or (${TAINTED_HERE("tainted_at")} and evidence_id is null and move_result_link_id is null)`;
const EXPECTATIONS_HIT = "subject_id = any ($1::text[])";
// The outcome judge's checks of an erased item or claim, or of an expectation the erasure removes
// (which its foreign key would take too).
const CHECKS_HIT = `evidence_id = any ($1::text[]) or claim_key = any ($2::text[])
  or expected_outcome_id in (select x.id from ledger.expected_outcomes x where x.subject_id = any ($3::text[]))`;
const WATCHES_HIT = "evidence_id = any ($1::text[]) or (kind = 'entity' and watch_key = any ($2::text[]))";
const outcomeValues = (erased: Erased): string[][] => [allEvidence(erased), erased.claimKeys, namedRefs(erased)];
const namedRefs = (erased: Erased): string[] => erased.refs.map((ref) => ref.id);
const outcomes = removes(
  "outcomes",
  [
    { table: "ledger.outcome_links", where: OUTCOME_LINKS_HIT, values: outcomeValues },
    { table: "ledger.outcome_checks", where: CHECKS_HIT, values: outcomeValues },
    { table: "ledger.expected_outcomes", where: EXPECTATIONS_HIT, values: (erased) => [namedRefs(erased)] },
    { table: "ledger.work_watches", where: WATCHES_HIT, values: (erased) => [allEvidence(erased), namedRefs(erased)] },
  ],
  (erased) => allEvidence(erased).length > 0 || erased.claimKeys.length > 0 || erased.refs.length > 0,
);

// Invariant 10: in the erasure's transaction, every source check that read an
// erased claim (by its claim key) or an erased item (its evidence, or an agent record's removed
// with it). A restore's replay runs the erasure again and repeats it. A dry run counts the rows it
// would delete. The count is of rows deleted.
// An owner's verdict (an audit card's answer, judge `owner:`) is the owner's judgment of the model,
// not knowledge from the erased item, so before that row goes its kept verdict is inserted: the same
// target, kind, relation judge, judge, verdict and time, under the original's label, with no claim
// key, item, passage or relation row, and a random keyed target: the original's target and relation
// row were derived from the erased claims. The switch and its `last_wrong` read it as any owner
// row; no row is updated. A kept verdict names nothing erased, so a later erasure never hits it.
const SOURCE_CHECKS_HIT = "claim_keys && $1::text[] or evidence_ids && $2::text[]";
const OWNER_KEPT_VERDICTS = `insert into ledger.source_checks (target, kind, target_key, relation_id, relation_judge, judge, verdict, code, cited, on_cited, claim_keys, evidence_ids, compartments, created_at, live, owner_new)
  select target, kind, encode(sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 'hex'), null, relation_judge, judge, verdict, code, null, on_cited, '{}', '{}', compartments, created_at, live, owner_new
  from ledger.source_checks where ${IS_OWNER_JUDGE} and (${SOURCE_CHECKS_HIT}) order by id`;
const sourceChecks: ErasureHook = {
  name: "source_checks",
  async run(query, erased, { dryRun }) {
    const evidence = allEvidence(erased);
    if (evidence.length === 0 && erased.claimKeys.length === 0) return 0;
    const values = [erased.claimKeys, evidence];
    if (!dryRun) await query(OWNER_KEPT_VERDICTS, values);
    return removing(query, dryRun, "ledger.source_checks", SOURCE_CHECKS_HIT, values);
  },
};

// An agent's report of a wrong relation names the relation's two claims by key and the evidence of
// what it cites: an erasure of either claim or of a cited item takes it, in the erasure's transaction,
// as the source checks go. A restore's replay repeats it. A dry run counts the rows it would delete.
const relationReports = removes(
  "relation_reports",
  [
    {
      table: "ledger.relation_reports",
      where: "claim_keys && $1::text[] or evidence_ids && $2::text[]",
      values: (erased) => [erased.claimKeys, allEvidence(erased)],
    },
  ],
  (erased) => erased.claimKeys.length > 0 || allEvidence(erased).length > 0,
);

// The meter's rows are ids of what was shown or read: an item's erasure takes them with it.
const meterRows = removes(
  "meter_rows",
  [
    { table: "ledger.surfaced_items", where: "evidence_ids && $1::text[]", values: (erased) => [allEvidence(erased)] },
    {
      table: "ledger.recall_checks",
      where: "evidence_id = any ($1::text[])",
      values: (erased) => [allEvidence(erased)],
    },
  ],
  (erased) => allEvidence(erased).length > 0,
);

export const ERASURE_HOOKS: readonly ErasureHook[] = [
  meterRows,
  dreamFindingsErasure,
  // The person's address fingerprints, out of every draft and send that holds one.
  {
    name: "send_recipients",
    taints: true,
    run: (query, erased, { dryRun }) =>
      dryRun
        ? count(
            query,
            `select ((select count(*) from ledger.drafts where recipient_fps && $1::text[]) + (select count(*) from ledger.sent_messages where recipient_fps && $1::text[]))::int as n`,
            [erased.addressFps],
          )
        : count(query, "select ledger.forget_recipients($1::text[]) as n", [erased.addressFps]),
  },
  // Each removed item's source fingerprint, off the send whose copy it was.
  {
    name: "sent_source",
    run: (query, erased, { dryRun }) => {
      const values = [erased.sources.map((one) => one.accountId), erased.sources.map((one) => one.sourceItemFp)];
      return dryRun
        ? count(
            query,
            `select count(*)::int as n from ledger.sent_messages s
             where exists (select 1 from unnest($1::text[], $2::text[]) as p (account_id, fp) where p.account_id = s.source_account_id and p.fp = s.source_item_fp)`,
            values,
          )
        : count(query, "select ledger.forget_sent_source($1::text[], $2::text[]) as n", values);
    },
  },
  DOCUMENTS_HOOK,
  timeRulingsErasure,
  identity,
  tierRulings,
  ownerListMembers,
  personHides,
  personNames,
  agentCloses,
  subjectDecisions,
  goalTargets,
  goalTargetNames,
  memoryChanges,
  agentPeopleErasure,
  researchFillsErasure,
  {
    name: "decision_calls",
    taints: true,
    run: async (query, erased, { dryRun }) => {
      const evidence = allEvidence(erased);
      const refs = [...new Set([...erased.addressFps, ...evidence])];
      if (dryRun) {
        const hit = await query<{ id: string }>(`select id from vault.decision_calls where ${DECISION_CALLS_HIT}`, [
          refs,
        ]);
        const verdicts = await count(
          query,
          `select count(*)::int as n from ledger.point_verdicts v where ${VERDICTS_HIT}`,
          [evidence, hit.map((row) => row.id)],
        );
        return hit.length + verdicts;
      }
      const gone = await query<{ id: string }>(
        `delete from vault.decision_calls where ${DECISION_CALLS_HIT} returning id`,
        [refs],
      );
      const tainted = await query<{ id: string }>(
        `update ledger.point_verdicts v set tainted_at = now(), body_enc = null where ${VERDICTS_HIT} returning v.id`,
        [evidence, gone.map((row) => row.id)],
      );
      return gone.length + tainted.length;
    },
  },
  beliefRulings,
  rulingAnchors,
  factRulings,
  factCards,
  factSettlements,
  claimRelations,
  goalKeys,
  triggers,
  outcomes,
  sourceChecks,
  relationReports,
  mentionBindings,
  orgNames,
  researchRequests,
  pages,
  capturesErasure,
  // Every trial run's stored output loses its body, whatever the trial read, by
  // ledger.forget_trial_outputs; a trial is a comparison, not knowledge, so over-removal costs
  // nothing. A dry run counts them.
  {
    name: "trial_outputs",
    run: (query, _erased, { dryRun }) =>
      dryRun
        ? count(
            query,
            `select count(*)::int as n from ledger.record_events e
             where e.row_kind = 'run' and e.event = 'finished' and e.body_enc is not null
               and exists (select 1 from ledger.runs r where r.id = e.row_id and r.trial_model is not null)`,
            [],
          )
        : count(query, "select ledger.forget_trial_outputs() as n", []),
  },
  // Every web step's sealed query or URL is dropped by any erasure, by ledger.forget_web_requests:
  // a query may hold what the run read, and no record says which evidence it drew on, so
  // over-removal is the direction invariant 10 allows. The steps stay, as counts. A dry run counts
  // them.
  {
    name: "web_requests",
    run: (query, _erased, { dryRun }) =>
      dryRun
        ? count(
            query,
            "select count(*)::int as n from ledger.run_steps s where s.kind in ('web_search', 'web_fetch') and s.detail_enc is not null",
            [],
          )
        : count(query, "select ledger.forget_web_requests() as n", []),
  },
  // Lens's mirror: every mirror row naming an erased person tainted, by
  // ledger.taint_mirror_entities; then one link for each mirror row this erasure tainted, whether
  // the erasure's own taint or this hook did it. A replay keeps a link already there. The number of
  // distinct mirror clients linked. A dry run writes nothing and counts the clients of the rows the
  // taint would reach.
  {
    name: "mirror",
    after: {
      hooks: [],
      taints: true,
      why: "mirror links every row tainted in this transaction, so it follows what taints",
    },
    async run(query, erased, { dryRun }) {
      const people = peopleOf(erased);
      if (dryRun) {
        return count(
          query,
          `select count(distinct m.client_id)::int as n from ledger.mirror_entries m
           where m.tainted_at is null and (m.evidence_ids && $1::text[] or m.entity_ids && $2::text[])`,
          [allEvidence(erased), people],
        );
      }
      if (people.length > 0) await query("select ledger.taint_mirror_entities($1::text[])", [people]);
      await query(
        `insert into ledger.erasure_exposures (erasure_id, mirror_entry_id, compartments)
         select $1, m.id, m.compartments from ledger.mirror_entries m where ${TAINTED_HERE("m.tainted_at")}
         on conflict on constraint erasure_exposures_mirror do nothing`,
        [erased.erasureId],
      );
      return count(
        query,
        "select count(distinct m.client_id)::int as n from ledger.erasure_exposures l join ledger.mirror_entries m on m.id = l.mirror_entry_id where l.erasure_id = $1",
        [erased.erasureId],
      );
    },
  },
  chatLinesErasure,
  warmth,
  // A replay runs it again over the restored rows. A dry run counts.
  {
    name: "shown_lessons",
    after: {
      hooks: ["mirror"],
      taints: true,
      why: "shown_lessons retires what was shown a decision this erasure reached, so it follows every taint",
    },
    run: (query, erased, { dryRun }) =>
      count(query, "select ledger.retire_shown_lessons($1::text[], $2::text[], $3::text[], $4) as n", [
        erased.refs.map((ref) => ref.kind),
        erased.refs.map((ref) => ref.id),
        erased.addressFps,
        dryRun,
      ]),
  },
  // Each promotion sent that carried an erased claim: revoked, so the next outbox carries its
  // deletion notice, and the erased ids replaced in it by a keyed fingerprint. A replay runs it again
  // over the restored rows. A dry run counts.
  {
    name: "promotions",
    run: (query, erased, { dryRun, now, keys }) =>
      dryRun
        ? count(
            query,
            "select count(*)::int as n from ledger.promotions where direction = 'out' and claim_ids && $1::text[]",
            [erased.claimIds],
          )
        : revokeErased(query, keys, erased.claimIds, now),
  },
  // A link for each exposure of what the erasure erased,
  // and for each memory exposure its taint wrote in this transaction; the number of
  // distinct recipients of the erasure's links. The links name the erasure before its row exists:
  // their key is deferred to the commit. A replay keeps a link already there. A dry run writes
  // nothing and counts the recipients of the matching exposures and the clients of the projections
  // the taint would reach (the memory taint's `wouldTaint` term).
  {
    name: "vendor_exposures",
    after: {
      hooks: ["pages", "captures", "chat_lines", "warmth", "shown_lessons", "mirror"],
      taints: true,
      why: "vendor_exposures links every memory exposure a taint wrote in this transaction, so it runs last",
    },
    async run(query, erased, { dryRun }) {
      const values = exposedValues(erased);
      if (dryRun) {
        return count(
          query,
          `select count(*)::int as n from (
             select e.recipient_kind, e.recipient from (${EXPOSED}) e
             union
             select 'client', p.client_id from ledger.memory_projections p where p.tainted_at is null and p.evidence_ids && $4::text[]
           ) r`,
          [...values, allEvidence(erased)],
        );
      }
      await query(
        `insert into ledger.erasure_exposures (erasure_id, exposure_id, compartments)
         select $4, e.id, e.compartments from (${EXPOSED}) e
         on conflict on constraint erasure_exposures_exposure do nothing`,
        [...values, erased.erasureId],
      );
      await query(
        `insert into ledger.erasure_exposures (erasure_id, memory_exposure_id, compartments)
         select $1, m.id, m.compartments from ledger.memory_exposures m join ledger.memory_projections p on p.id = m.projection_id
         where ${TAINTED_HERE("m.recorded_at")} and ${TAINTED_HERE("p.tainted_at")}
         on conflict on constraint erasure_exposures_memory do nothing`,
        [erased.erasureId],
      );
      return count(
        query,
        `select count(*)::int as n from (
           select x.recipient_kind, x.recipient from ledger.erasure_exposures l join ledger.exposures x on x.id = l.exposure_id where l.erasure_id = $1
           union
           select 'client', m.client_id from ledger.erasure_exposures l join ledger.memory_exposures m on m.id = l.memory_exposure_id where l.erasure_id = $1
         ) r`,
        [erased.erasureId],
      );
    },
  },
];

// The hooks' order, as far as one hook needs another to have run, each with why: what each hook's
// `after` declares. The array above is the order they run in, and a test holds it to these.
const TAINTS = ERASURE_HOOKS.filter((hook) => hook.taints === true).map((hook) => hook.name);
export const ERASURE_ORDER = ERASURE_HOOKS.flatMap(({ name, after }) =>
  after === undefined ? [] : [{ first: [...after.hooks, ...(after.taints ? TAINTS : [])], next: name, why: after.why }],
);
