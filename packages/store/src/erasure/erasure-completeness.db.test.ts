import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvidenceId } from "@intelligence/contracts";
import {
  type AgentRecordArgs,
  CARD_OPTIONS,
  type CardId,
  type EntityId,
  type FactId,
  type GoalId,
  type MessageId,
  type NewCard,
  type PersonalTool,
} from "@intelligence/contracts/personal";
import { sha256 } from "@intelligence/personal-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Admin } from "../admin/admin.ts";
import { questionBody } from "../admin/extraction/admin-reattach.ts";
import { writeGoal } from "../admin/goals/goal-writes.ts";
import type { Query } from "../core/db.ts";
import { reopenId } from "../core/ids.ts";
import { createPipeline } from "../pipeline/pipeline.ts";
import { Reader } from "../read/read.ts";
import { type Accounts, CANARY_PERSON, connect } from "../test-support/cast.ts";
import { ALL_VIEWS, testId } from "../test-support/clients.ts";
import { one, session } from "../test-support/connections.ts";
import { fingerprint, queryAs } from "../test-support/database.ts";
import { asOwner, columns, holding, lifted } from "../test-support/erasure-walk.ts";
import { ingestEvent, ingestMail, mailSourceId } from "../test-support/items.ts";
import { EVENTS, MAIL } from "../test-support/items-named.ts";
import { batchOf, claimRecord, asOwner as ownerWrite } from "../test-support/pipeline-fixtures.ts";
import { seeder } from "../test-support/seeder.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { outcomeValue, registration } from "../test-support/values.ts";
import { NOT_SEEDED } from "./erasure-unseeded.ts";

// A canary person is given mail, claims, a card, an agent record, a meeting, a document, a chat line, a model call, a goal target, a list membership, a
// hide and a name; the owner's Admin erases the canary; then every column that can hold an id (every text, varchar, array of either, and clear jsonb
// column, whatever its name) of vault, knowledge, ledger, projections and policy is read, row-level security lifted in a transaction rolled back. None
// may still hold an id of a row the erasure removed (the canary's entity, the canary's items, their messages and claims), unless the column is in
// ALLOWED with its reason. Synthetic values only.

const TIMEOUT = 180_000;
const RECORDER = "alpha";
const TOOLS = ["get_self", "find_messages", "read_message", "build_context_pack", "record"] as PersonalTool[];

// The tables whose removed rows are the canary's: their ids, read before and after the erasure.
const IDENTITY_TABLES = ["knowledge.entities", "vault.evidence_items", "knowledge.messages", "knowledge.claims"];

// A column that can hold the id of a row an erasure removes, by its name: an entity's, an item's, a
// message's or a claim's, or a reference that may be any of them.
const ID_COLUMN =
  /(^|_)(entity|entities|evidence|message|claim|subject|target|about|ref|row|member|item|person)(_entity)?_ids?$/;

// "<table>.<column>" of ID_COLUMN that this test does not fill with one of the canary's ids before
// the erasure are in NOT_SEEDED (erasure-unseeded.ts), each with its reason and the test that proves
// its erasure. A new such column fails the test until it is seeded here or listed there.

const ALLOWED: Readonly<Record<string, string>> = {
  "knowledge.removed_evidence.evidence_ids": "R15: the erasure's own record of the evidence it removed",
  "ledger.basis.ref_id": "R15: a tainted basis row keeps the id of what it was about",
  "ledger.cards.target_id": "R15: a tainted card keeps the id of what it was about, its body gone",
  "ledger.agent_writes.cites":
    "R15: a tainted agent record keeps what it cited, the record of what its client was given",
  // Its evidence id names its own evidence row, which went with the body, so it opens nothing
  // (writer-records.db.test.ts pins it).
  "ledger.agent_writes.evidence_id":
    "O2 R11: a removed agent record keeps its ids, its own deleted evidence row's among them",
  "knowledge.owner_decisions.target_id":
    "R15 and owner-words R25: his tainted person_name decision keeps the id it was about",
};

// The columns seeded by a fixture row of their table given one of the canary's ids: its evidence
// row's or its entity's. The rest of the walk then holds each to the erasure like any seeded column.
const BY_FIXTURE: Readonly<Record<string, "evidence" | "entity">> = {
  "knowledge.org_names.entity_id": "entity",
  "knowledge.org_names.evidence_id": "evidence",
  "ledger.drafts.reply_to_evidence_id": "evidence",
  "ledger.memory_projections.evidence_ids": "evidence",
  "ledger.mirror_entries.evidence_ids": "evidence",
  "ledger.move_result_links.evidence_id": "evidence",
  "ledger.outcome_checks.evidence_id": "evidence",
  "ledger.outcome_links.evidence_id": "evidence",
  "ledger.recall_checks.evidence_id": "evidence",
  "ledger.signal_marks.evidence_ids": "evidence",
  "ledger.work_watches.evidence_id": "evidence",
  "projections.warmth_days.entity_id": "entity",
  "vault.extraction_reviews.evidence_id": "evidence",
  "vault.restrict_screens.evidence_id": "evidence",
  "vault.restriction_requests.evidence_id": "evidence",
  "vault.unmapped_claims.evidence_id": "evidence",
  "vault.unresolved_mentions.evidence_id": "evidence",
};

let store: TestStore;
let dir: string;
let erased: string[];
let person: EntityId;
let goal: GoalId;
let left: string[];
let emptied: string[];
let heldBefore: string[];
let idColumns: string[];
let fpsBefore: string[];
let fpsLeft: string[];
// The keys of the canary's facts as an earlier generation read them: rulings and decisions still
// hold them, and no claim does, so only what those rulings were anchored on reaches them.
let moved: { join: string[]; closed: string };
let closedNow: string;
let carryCard: CardId;
// Two cards about one claim of the canary's that cite nothing: a same_fact card, whose case key is
// a fact key of the canary's, and a title link's agent_claim card.
let claimCards: CardId[];
let agentClose: string;

const admin = <Row = Record<string, unknown>>(text: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(store.db.urls.admin, text, values);
const req = (): string => testId("req");
const decisionOf = async (query: Query): Promise<string> => {
  const id = testId("rul");
  await query(
    "insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, labels, details, decided_at, compartments) values ($1, $2, 'release', 0, '{}', '{}', now(), '{own}')",
    [id, req()],
  );
  return id;
};

async function messageOf(
  accounts: Accounts,
  fixture: typeof MAIL.canary,
): Promise<{ id: MessageId; evidence: string }> {
  const row = one(
    await admin<{ id: string; evidence_id: string }>(
      "select m.id, m.evidence_id from knowledge.messages m join vault.evidence_items e on e.id = m.evidence_id where e.source_account_id = $1 and e.source_item_fp = $2",
      [accounts.personalMail.id, fingerprint(store.db.keys, "source_id", mailSourceId(fixture))],
    ),
  );
  return { id: row.id as MessageId, evidence: row.evidence_id };
}

// The ids each identity table holds, as pi_owner with row-level security lifted, rolled back.
const ids = (): Promise<Set<string>> =>
  asOwner(store.db, async (query) => {
    const found = new Set<string>();
    for (const table of IDENTITY_TABLES) {
      await query(lifted(table));
      for (const row of await query(`select id from ${table}`)) found.add(String(row.id));
    }
    return found;
  });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-erasure-complete-"));
  store = await openStore({ compartments: ["own", "employer:example", `agent:${RECORDER}`] });
  const accounts = await connect(store.writer);
  const owner = one(await admin<{ id: string }>("select id from knowledge.entities where kind = 'owner'")).id;
  const erase = new Admin({
    pool: store.adminPool,
    keys: store.db.keys,
    log: store.log,
    journal: join(dir, "keys.json.erasures"),
    recordEnabled: true,
  });

  // Mail, and a name: the canary's messages to the owner (its display name an alias), and Quentin's, the control.
  for (const fixture of [MAIL.canary, MAIL.reply, MAIL.fromQuentin])
    expect(await ingestMail(store.writer, accounts.personalMail, fixture)).toBe("stored");
  person = one(
    await admin<{ entity_id: EntityId }>("select distinct entity_id from knowledge.accounts where value_fp = $1", [
      fingerprint(store.db.keys, "address", CANARY_PERSON.address),
    ]),
  ).entity_id;
  const canary = await messageOf(accounts, MAIL.canary);
  const quentin = await messageOf(accounts, MAIL.fromQuentin);

  // Claims: one on the canary's message, and one on Quentin's that names the canary.
  const pipeline = createPipeline({ url: store.db.urls.pipeline, keys: store.db.keys, log: store.log });
  try {
    for (const [evidence, n] of [
      [canary.evidence, 1],
      [quentin.evidence, 2],
    ] as const) {
      expect(await pipeline.open(evidence as EvidenceId)).not.toBeNull();
      expect(
        await pipeline.commit(batchOf(evidence, [claimRecord(evidence, "own", owner, { n, entities: [person] })])),
      ).toBe("committed");
    }
  } finally {
    await pipeline.close();
  }

  // A card about the canary and the canary's message.
  await erase.cards.raiseCard({
    id: testId("crd") as CardId,
    requestId: req(),
    kind: "notice",
    author: "system:test",
    options: ["acknowledge"],
    target: null,
    refs: [
      { kind: "message", id: canary.id },
      { kind: "entity", id: person },
    ],
    compartments: ["own"],
    expiresAt: null,
    expiresAfterDays: null,
    caseKey: null,
    run: null,
    body: "a card about a canary",
    bodyFrom: "code",
  } as NewCard);

  // Rows resting on the canary's message, each written as its seeder writes one: a meeting, a
  // document, a chat line with the canary, a model call and a group call's member.
  let document = "";
  await session(store.db.urls.admin, async (query) => {
    const seed = seeder(store.db, query);
    await seed.event(["own"], canary.evidence);
    const call = await seed.modelCall(["own"], canary.evidence);
    await query("insert into vault.model_call_members (call_id, evidence_id, compartments) values ($1, $2, '{own}')", [
      call,
      canary.evidence,
    ]);
    document = await seed.document(["own"]);
  });
  // As pi_owner with row-level security lifted for the one statement, then forced again.
  await session(store.db.urls.bootstrap, async (query) => {
    await query("begin");
    await query("set local role pi_owner");
    await query(lifted("knowledge.documents"));
    const moved = await query("update knowledge.documents set evidence_id = $2 where id = $1 returning id", [
      document,
      canary.evidence,
    ]);
    await query("alter table knowledge.documents force row level security");
    await query("commit");
    expect(moved).toHaveLength(1);
  });
  await queryAs(
    store.db.urls.writer,
    "insert into knowledge.chat_lines (id, evidence_id, line, entity_id, direction, occurred_at, others, thread_fp, compartments) values ($1, $2, 0, $3, 'inbound', now(), 1, $4, '{own}')",
    [`chl_${testId("cli").slice(4)}`, canary.evidence, person, sha256(`canary chat ${person}`)],
  );

  // A meeting with the canary, and a card whose target is their message.
  expect(await ingestEvent(store.writer, accounts.personalCalendar, EVENTS.canary)).toBe("stored");
  await erase.cards.raiseCard({
    id: testId("crd") as CardId,
    requestId: req(),
    kind: "notice",
    author: "system:test",
    options: ["acknowledge"],
    target: { kind: "message", id: canary.id },
    refs: [],
    compartments: ["own"],
    expiresAt: null,
    expiresAfterDays: null,
    caseKey: null,
    run: null,
    body: "a card on a canary's message",
    bodyFrom: "code",
  } as NewCard);

  // An agent record citing the canary's message, taken into the vault.
  const { token } = await erase.clients.addClient(
    registration(RECORDER, ["own"], { tools: TOOLS, views: ALL_VIEWS as never }),
  );
  const reader = new Reader({ pool: store.readerPool, keys: store.db.keys, log: store.log });
  outcomeValue(
    await reader.record(token, {
      kind: "note",
      body: "a note on a canary's message",
      requestId: "erasure-complete-0001",
      cites: [canary.id],
    } as AgentRecordArgs),
  );
  expect((await store.writer.takeRecords()).taken).toBe(1);

  // A goal that targets the canary, a list the canary is on, and the owner's Remove (a hide).
  goal = await session(store.db.urls.admin, (query) =>
    writeGoal(query, store.db.keys, {
      statement: "Meet the canary.",
      compartment: "own",
      requestId: req(),
      now: new Date(),
    }),
  );
  expect(await store.admin.work.setGoalTarget(goal, person, { requestId: req() })).toBe(true);
  const list = await erase.lists.createList("Canaries", { requestId: req() });
  await erase.lists.addToList(list, person, { requestId: req() });
  await erase.ignores.addIgnore("entity", person, { requestId: req() });

  // The owner's name for the canary, and the owner's hide, place and fact ruling on the key of
  // a claim about the canary, as the admin writes each.
  await erase.identity.namePerson(person, "Canary Example-Name", { requestId: req() });
  const canaryClaims = await asOwner(store.db, async (query) => {
    await query(lifted("knowledge.claims"));
    await query(lifted("knowledge.claim_entities"));
    return (await query(
      "select c.id, c.fact_key_fp from knowledge.claims c where c.evidence_id = $1 or c.id in (select n.claim_id from knowledge.claim_entities n where n.entity_id = $2) order by c.id",
      [canary.evidence, person],
    )) as { id: string; fact_key_fp: string }[];
  });
  const [onHim, another] = canaryClaims;
  expect(onHim).toBeDefined();
  await session(store.db.urls.admin, async (query) => {
    await seeder(store.db, query).projectBinding(["own"], onHim?.id);
    await query(
      "insert into knowledge.mention_bindings (id, ruling_id, evidence_id, mention_fp, address_fp, created_at, compartments) values ($1, $2, $3, $4, $5, now(), '{own}')",
      [
        testId("mbd"),
        await decisionOf(query),
        canary.evidence,
        fingerprint(store.db.keys, "name", "A canary, by a mention"),
        fingerprint(store.db.keys, "address", CANARY_PERSON.address),
      ],
    );
    const decision = (): Promise<string> => decisionOf(query);
    // A stretch of time the owner said no to, which still cites the canary's item until the erasure.
    await query(
      `insert into knowledge.time_rulings (id, from_at, to_at, source, proposal_id, evidence_ids, lifted_at, lift_ruling_id, created_at, compartments)
       values ($1, now() - interval '1 hour', now(), 'system', $2, $3, now(), $4, now(), '{own}')`,
      [testId("tru"), testId("tpr"), [canary.evidence], await decision()],
    );
    await query(
      "insert into knowledge.goal_key_rulings (ruling_id, verdict, fact_key_fp, created_at, compartments) values ($1, 'hide', $2, now(), '{own}')",
      [await decision(), onHim?.fact_key_fp],
    );
    await query("insert into projections.goal_key_ranks (fact_key_fp, rank, compartments) values ($1, 1, '{own}')", [
      onHim?.fact_key_fp,
    ]);
    await query(
      "insert into knowledge.fact_rulings (ruling_id, verdict, a_fp, b_fp, created_at, compartments) values ($1, 'split', $2, $3, now(), '{own}')",
      [await decision(), ...[onHim?.fact_key_fp ?? "", another?.fact_key_fp ?? sha256(`another ${person}`)].sort()],
    );
  });
  // Every ruling's anchors: the evidence and the entities the split above was made on, in clear.
  await admin("select knowledge.anchor_rulings(null)");
  // The owner's own rulings on the canary's facts, as the admin writes them: a reject of one claim
  // and a veto of another fact, each with its anchors and its decision's details.
  expect(another).toBeDefined();
  await erase.facts.rejectClaim(onHim?.id as FactId, { requestId: req() });
  await erase.facts.vetoFact(another?.id as FactId, { requestId: req() });
  // An agent's report of a wrong merge that names the canary, as ledger.report_wrong_merge writes
  // one as pi_owner.
  await ownerWrite(
    store.db,
    `insert into ledger.wrong_merge_reports (id, request_id, entity_id, members, parts, partition_key, group_key, cross_rulings, client_id,
       client_name, session_id, because, cites, cite_evidence, cite_address_fps, state, created_at, compartments)
     values ($1, $2, $3, $4, $4, $5, $6, $7, $8, 'seed-agent', $9, 'different_employers', '{}', '{}', '{}', 'open', now(), '{own}')`,
    [
      `wmr_${testId("x").slice(-26)}`,
      testId("req").slice(4),
      person,
      [person, testId("ent")].sort(),
      sha256(`partition ${person}`),
      sha256(`group ${person}`),
      [testId("rul")],
      testId("cli"),
      testId("ses"),
    ],
  );
  // An agent's report of a wrong relation citing the canary's item, as
  // ledger.report_wrong_relation writes one as pi_owner.
  await ownerWrite(
    store.db,
    `insert into ledger.relation_reports (id, request_id, relation_id, claim_keys, client_id, session_id, because, cites,
       evidence_ids, created_at, compartments)
     values ($1, $2, 1, $3, $4, $5, 'not_same_fact', $6, $7, now(), '{own}')`,
    [
      `rrp_${testId("x").slice(-26)}`,
      testId("req").slice(4),
      [sha256(`report from ${person}`), sha256(`report to ${person}`)],
      testId("cli"),
      testId("ses"),
      [testId("msg")],
      [canary.evidence],
    ],
  );

  // A split made on keys a generation moved since, awaiting its carry: anchored on the canary's
  // message, with both keys in its decision's details, as the admin writes them.
  moved = {
    join: [sha256(`moved a ${person}`), sha256(`moved b ${person}`)].sort(),
    closed: sha256(`moved c ${person}`),
  };
  closedNow = onHim?.fact_key_fp as string;
  const detail = async (kind: string, details: object, subject: string[] = []): Promise<string> => {
    const id = testId("rul");
    await admin(
      "insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, labels, details, decided_at, compartments, subject_fps) values ($1, $2, $3, 0, '{}', $4, now(), '{own}', $5)",
      [id, req(), kind, JSON.stringify(details), subject],
    );
    return id;
  };
  const split = await detail("fact_split", { a: moved.join[0], b: moved.join[1] });
  await admin(
    "insert into knowledge.fact_rulings (ruling_id, verdict, a_fp, b_fp, created_at, compartments) values ($1, 'split', $2, $3, now(), '{own}')",
    [split, ...moved.join],
  );
  await ownerWrite(
    store.db,
    "update knowledge.fact_rulings set claim_type = 'commitment', a_evidence_ids = $2, b_evidence_ids = $2, entity_ids = '{}' where ruling_id = $1",
    [split, [canary.evidence]],
  );
  // The owner's close and reopen of a commitment, twice: on a key the canary's claim holds now, and
  // on a moved one that only the retire's anchors reach. Each close is a decision beside its retire,
  // and each reopen a decision and a row, all holding the key.
  for (const key of [closedNow, moved.closed]) {
    const retire = await detail("fact_retire", { factKey: key });
    await admin(
      "insert into knowledge.belief_rulings (ruling_id, verdict, claim_fp, fact_key_fp, created_at, compartments) values ($1, 'retire', $2, $3, now(), '{own}')",
      [retire, sha256(`retired claim ${key}`), key],
    );
    if (key === moved.closed)
      await ownerWrite(
        store.db,
        "update knowledge.belief_rulings set claim_type = 'commitment', evidence_ids = $2, entity_ids = '{}' where ruling_id = $1",
        [retire, [canary.evidence]],
      );
    await detail("commitment_close", { factKey: key, retire, at: new Date().toISOString() }, [key]);
    const reopen = await detail("commitment_reopen", { factKey: key }, [key]);
    await admin(
      "insert into ledger.commitment_reopens (id, close_id, fact_fp, by, decision_id, compartments, at) values ($1, null, $2, 'owner', $3, '{own}', now())",
      [reopenId(), key, reopen],
    );
  }
  // A question about a ruling whose claim a generation moved, listing a claim that names the canary
  // as a candidate; its basis is that claim (ledger.cite_claims), as the carry-over sweep writes it.
  carryCard = (
    await erase.cards.raiseCard({
      id: testId("crd") as CardId,
      requestId: req(),
      kind: "ruling_carry",
      author: "system:test",
      options: [...CARD_OPTIONS.ruling_carry],
      target: null,
      refs: [],
      compartments: ["own"],
      expiresAt: null,
      expiresAfterDays: null,
      caseKey: `ruling_carry:${split}:2`,
      run: null,
      body: questionBody(split, "split", 2, [another?.id as string]),
      bodyFrom: "code",
    } as NewCard)
  ).id;
  expect(await admin("select ledger.cite_claims($1, $2::text[]) as n", [carryCard, [another?.id]])).toEqual([{ n: 1 }]);

  // The cards the pipeline raises about one claim, with the claim as their target, no ref and no
  // basis: a same_fact card (identity/grouping.ts), its case key the pair's second fact key, and a
  // title link's agent_claim card (pipeline/pipeline-cards.ts).
  claimCards = [];
  for (const [kind, target, caseKey] of [
    ["same_fact", onHim?.id, another?.fact_key_fp],
    ["agent_claim", another?.id, null],
  ] as const)
    claimCards.push(
      (
        await erase.cards.raiseCard({
          id: testId("crd") as CardId,
          requestId: req(),
          kind,
          author: "system:test",
          options: [...CARD_OPTIONS[kind]],
          target: { kind: "claim", id: target as FactId },
          refs: [],
          compartments: ["own"],
          expiresAt: null,
          expiresAfterDays: 30,
          caseKey,
          run: null,
          body: null,
          bodyFrom: null,
        } as NewCard)
      ).id,
    );
  // An agent's close of the canary's commitment, as ledger.close_commitment writes one, which the
  // owner reopened: the reopen row above holds the key, and so does the close's own row.
  agentClose = (
    (await session(store.db.urls.admin, (query) => seeder(store.db, query).into("ledger.agent_writes")(["own"]))) as {
      id: string;
    }
  ).id;
  await ownerWrite(
    store.db,
    "update ledger.agent_writes set kind = 'close', tool = 'close_commitment', close_fact_fp = $2, close_ending = 'done' where id = $1",
    [agentClose, closedNow],
  );
  await admin(
    "insert into ledger.commitment_reopens (id, close_id, fact_fp, by, decision_id, compartments, at) values ($1, $2, $3, 'owner', $4, '{own}', now())",
    [reopenId(), agentClose, closedNow, await detail("commitment_reopen", { factKey: closedNow }, [closedNow])],
  );
  // A settlement of one of the canary's claims, as the pipeline writes one for a card it waits on:
  // the claim's id and its evidence row.
  await ownerWrite(
    store.db,
    `insert into ledger.fact_settlements (id, claim_key, card_id, answer, kind, claim_id, evidence_id, match_fp, written_by, created_at, compartments)
     select $1, $2, $3, 'waiting', 'about_you', c.id, c.evidence_id, $4, 'pipeline', now(), '{own}' from knowledge.claims c
     where c.id = any ($5) and c.evidence_id = $6 order by c.id limit 1`,
    [
      `fst_${testId("rul").slice(4)}`,
      sha256(`settled ${person}`),
      claimCards[0],
      sha256(`settled match ${person}`),
      // A claim on the canary's own message: the first of the canary's claims may rest on another.
      canaryClaims.map((one) => one.id),
      canary.evidence,
    ],
  );

  // One fixture row of each table of BY_FIXTURE, as its seeder writes one, with the canary's evidence
  // row or entity written into the column, as pi_owner with row-level security lifted.
  for (const [column, holds] of Object.entries(BY_FIXTURE)) {
    const table = column.split(".").slice(0, 2).join(".");
    const name = column.split(".")[2] as string;
    const before = await asOwner(store.db, async (query) => {
      await query(lifted(table));
      return (await query(`select ctid::text as at from ${table}`)).map((row) => String(row.at));
    });
    await session(store.db.urls.admin, (query) => seeder(store.db, query).into(table)(["own"]));
    const written = await session(store.db.urls.bootstrap, async (query) => {
      await query("begin");
      await query("set local role pi_owner");
      await query(lifted(table));
      const [type] = await query<{ array: boolean }>(
        "select data_type = 'ARRAY' as array from information_schema.columns where table_schema || '.' || table_name = $1 and column_name = $2",
        [table, name],
      );
      const out = await query(
        `update ${table} set ${name} = ${type?.array === true ? "array[$1::text]" : "$1"} where not (ctid::text = any ($2)) returning 1`,
        [holds === "evidence" ? canary.evidence : person, before],
      );
      await query(`alter table ${table} force row level security`);
      await query("commit");
      return out.length;
    });
    expect(written, column).toBeGreaterThan(0);
  }

  // Every id-bearing column holds one of the canary's ids before the erasure, or is listed with its
  // reason: the canary's entity, its messages and their items, and the claims on them or
  // naming the canary, with the fact keys of those claims.
  const fps = [
    fingerprint(store.db.keys, "address", CANARY_PERSON.address),
    fingerprint(store.db.keys, "name", CANARY_PERSON.name ?? ""),
  ];
  fpsBefore = await holding(store.db, fps);
  const before = await ids();
  expect(before.has(person)).toBe(true);
  expect(before.has(canary.id) && before.has(canary.evidence)).toBe(true);
  const keys = [...new Set(canaryClaims.map((one) => one.fact_key_fp))];
  heldBefore = await holding(store.db, [
    person,
    canary.id,
    canary.evidence,
    ...canaryClaims.map((one) => one.id),
    ...keys,
    ...moved.join,
    moved.closed,
  ]);
  idColumns = (await columns(store.db)).filter(({ col }) => ID_COLUMN.test(col)).map(({ tbl, col }) => `${tbl}.${col}`);

  await erase.erasure.erasePerson(person, { requestId: req() });
  const after = await ids();
  const keysAfter = await asOwner(store.db, async (query) => {
    await query(lifted("knowledge.claims"));
    return new Set(
      (await query("select distinct fact_key_fp from knowledge.claims where fact_key_fp = any ($1)", [keys])).map(
        (row) => String(row.fact_key_fp),
      ),
    );
  });
  erased = [...before].filter((id) => !after.has(id));
  emptied = keys.filter((key) => !keysAfter.has(key));
  left = await holding(store.db, [...erased, ...emptied, ...moved.join, moved.closed]);
  fpsLeft = await holding(store.db, fps);
}, TIMEOUT);

afterAll(async () => {
  await store?.close();
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
}, TIMEOUT);

describe("a person's erasure empties every id-bearing column", { timeout: TIMEOUT }, () => {
  it("the erasure removes the canary's entity, its items, their messages and claims", () => {
    expect(erased).toContain(person);
    expect(erased.length).toBeGreaterThanOrEqual(5);
  });

  it("no column holds an erased id, but those listed with their reason", () => {
    expect(left.filter((column) => !(column in ALLOWED))).toEqual([]);
    expect(left).toEqual(expect.arrayContaining(Object.keys(ALLOWED)));
  });

  // Most hooks erase by fingerprint, so the walk reads those too: an erased address or name is in the
  // suppressions, which refuse them again, and in no other column.
  it("no column holds the canary's address or name fingerprint, but the suppressions", () => {
    expect(fpsBefore).toEqual(
      expect.arrayContaining([
        "knowledge.accounts.value_fp",
        "knowledge.aliases.value_fp",
        "knowledge.mention_bindings.address_fp",
      ]),
    );
    expect(fpsLeft).toEqual(["knowledge.suppressions.value_fp"]);
  });

  // The check proves something only where the canary's ids were.
  it("every id-bearing column held one of the canary's ids before the erasure, or is listed with its reason", () => {
    // A fact ruling's two sides are ordered by fingerprint, so which side the canary's claim is on
    // varies by run: the other side names no stored claim here. One function empties both sides.
    const sides = ["knowledge.fact_rulings.a_evidence_ids", "knowledge.fact_rulings.b_evidence_ids"];
    expect(sides.some((column) => heldBefore.includes(column))).toBe(true);
    expect(idColumns.filter((column) => !heldBefore.includes(column) && !sides.includes(column)).sort()).toEqual(
      Object.keys(NOT_SEEDED).sort(),
    );
    // The seeded ones named here, the canary's fact keys among them, held before and gone after.
    for (const column of [
      "knowledge.belief_rulings.claim_fp",
      "knowledge.belief_rulings.fact_key_fp",
      "knowledge.belief_rulings.entity_ids",
      "knowledge.belief_rulings.evidence_ids",
      "knowledge.owner_decisions.details",
      "ledger.wrong_merge_reports.entity_id",
      "ledger.wrong_merge_reports.members",
      "ledger.relation_reports.evidence_ids",
      "knowledge.person_names.entity_ids",
      "knowledge.time_rulings.evidence_ids",
      "knowledge.goal_key_rulings.fact_key_fp",
      "projections.goal_key_ranks.fact_key_fp",
      "knowledge.fact_rulings.a_fp",
      "knowledge.fact_rulings.b_fp",
      "knowledge.owner_decisions.subject_fps",
      "ledger.commitment_reopens.fact_fp",
      "knowledge.claim_values.claim_id",
      "ledger.cards.case_key",
      "ledger.agent_writes.close_fact_fp",
      "ledger.fact_settlements.claim_id",
      "ledger.fact_settlements.evidence_id",
      "knowledge.events.evidence_id",
      "knowledge.documents.evidence_id",
      "knowledge.chat_lines.entity_id",
      "knowledge.chat_lines.evidence_id",
      "vault.model_calls.evidence_id",
      "vault.model_call_members.evidence_id",
      ...Object.keys(BY_FIXTURE),
    ]) {
      expect(heldBefore, column).toContain(column);
      expect(left, column).not.toContain(column);
    }
    expect(emptied.length).toBeGreaterThan(0);
  });

  // A join or a split awaiting its carry holds keys no claim holds any more: it goes by its anchors.
  it("a split made on keys a generation moved since is deleted, and its decision holds neither key", async () => {
    expect(
      await admin("select 1 from knowledge.fact_rulings where a_fp = any ($1) or b_fp = any ($1)", [moved.join]),
    ).toEqual([]);
    expect(
      await admin(
        "select 1 from knowledge.owner_decisions where details ->> 'a' = any ($1) or details ->> 'b' = any ($1)",
        [moved.join],
      ),
    ).toEqual([]);
  });

  it("the owner's close and reopen of the canary's commitment hold its key nowhere: on a key its claim held, and on a moved one", async () => {
    const closes = [closedNow, moved.closed];
    expect(emptied).toContain(closedNow);
    expect(
      await admin(
        "select kind, tainted_at is not null as tainted, details ? 'factKey' as keyed, subject_fps from knowledge.owner_decisions where kind in ('commitment_close', 'commitment_reopen') order by kind",
      ),
    ).toEqual([
      { kind: "commitment_close", tainted: true, keyed: false, subject_fps: [] },
      { kind: "commitment_close", tainted: true, keyed: false, subject_fps: [] },
      { kind: "commitment_reopen", tainted: true, keyed: false, subject_fps: [] },
      { kind: "commitment_reopen", tainted: true, keyed: false, subject_fps: [] },
      { kind: "commitment_reopen", tainted: true, keyed: false, subject_fps: [] },
    ]);
    expect(await admin("select 1 from ledger.commitment_reopens where fact_fp = any ($1)", [closes])).toEqual([]);
    expect(await admin("select 1 from knowledge.belief_rulings where fact_key_fp = any ($1)", [closes])).toEqual([]);
  });

  it("an agent's close of the canary's commitment is emptied and holds its key no more, and its reopen row is gone", async () => {
    expect(
      await admin(
        "select body_enc is null as emptied, tainted_at is not null as tainted, close_fact_fp = $2 as keyed from ledger.agent_writes where id = $1",
        [agentClose, closedNow],
      ),
    ).toEqual([{ emptied: true, tainted: true, keyed: false }]);
    expect(await admin("select 1 from ledger.commitment_reopens where close_id = $1", [agentClose])).toEqual([]);
  });

  it("a same_fact card and a title link's agent_claim card on a removed claim are tainted and withdrawn, and the same_fact card holds no fact key", async () => {
    expect(
      await admin(
        `select c.kind, c.tainted_at is not null as tainted, c.case_key,
           (select e.event from ledger.record_events e where e.row_kind = 'card' and e.row_id = c.id order by e.id desc limit 1) as state
         from ledger.cards c where c.id = any ($1) order by c.kind`,
        [claimCards],
      ),
    ).toEqual([
      { kind: "agent_claim", tainted: true, case_key: null, state: "withdrawn" },
      { kind: "same_fact", tainted: true, case_key: null, state: "withdrawn" },
    ]);
  });

  it("a ruling_carry card that listed a removed claim as a candidate is tainted: its body is gone and it is withdrawn", async () => {
    expect(
      await admin(
        `select c.tainted_at is not null as tainted, c.body_enc is null as emptied,
           (select e.event from ledger.record_events e where e.row_kind = 'card' and e.row_id = c.id order by e.id desc limit 1) as state
         from ledger.cards c where c.id = $1`,
        [carryCard],
      ),
    ).toEqual([{ tainted: true, emptied: true, state: "withdrawn" }]);
  });

  // The two goal gaps the erasure hook `goal_targets` closes.
  it("the canary's goal targets no one: its goal_target decision is tainted and names no one, and a rebuild keeps it so", async () => {
    expect(left).not.toContain("knowledge.owner_decisions.details");
    expect(left).not.toContain("projections.goal_state.target_entity_id");
    const [decision] = await admin<{ details: Record<string, unknown>; tainted: boolean }>(
      "select details, tainted_at is not null as tainted from knowledge.owner_decisions where kind = 'goal_target' and target_id = $1",
      [goal],
    );
    expect(decision).toMatchObject({ tainted: true, details: { entity: null } });
    expect(await store.admin.work.rebuildGoalState()).toBeGreaterThanOrEqual(1);
    expect(await admin("select target_entity_id from projections.goal_state where goal_id = $1", [goal])).toEqual([
      { target_entity_id: null },
    ]);
  });
});
