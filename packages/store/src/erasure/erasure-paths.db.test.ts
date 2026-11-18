import { copyFile, readFile } from "node:fs/promises";
import type { EvidenceId } from "@intelligence/contracts";
import {
  type AgentRecordArgs,
  BELIEF_TYPES,
  type CaptureId,
  type CardId,
  type DocumentId,
  type EntityId,
  type ErasureId,
  type ErasureReport,
  type EventId,
  type FactId,
  type GoalId,
  type MessageId,
  type NewCard,
  type PersonalTool,
} from "@intelligence/contracts/personal";
import { PERSONAL_LIMITS } from "@intelligence/personal-core";
import { type DocBody, type DriveFile, deriveItem, driveItem } from "@intelligence/personal-core/items";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Admin } from "../admin/admin.ts";
import { syncLock } from "../admin/admin-base.ts";
import { applyDeviceForget } from "../admin/erasure/admin-erase-targets.ts";
import { writeGoal } from "../admin/goals/goal-writes.ts";
import type { AdminContext } from "../core/admin-context.ts";
import { inTransaction, TRANSACTION } from "../core/db.ts";
import { fingerprint } from "../core/fingerprint.ts";
import { journalPath, readJournal } from "../core/journal.ts";
import { createPipeline } from "../pipeline/pipeline.ts";
import { Reader } from "../read/read.ts";
import { CANARY_PERSON, connect, OWNER, QUENTIN, SOLO } from "../test-support/cast.ts";
import { ALL_VIEWS, testId } from "../test-support/clients.ts";
import { one, session } from "../test-support/connections.ts";
import { copyTestDatabase, createTestDatabase, queryAs, sealRow, type TestDatabase } from "../test-support/database.ts";
import { holdingEach } from "../test-support/erasure-walk.ts";
import { ingestEvent, ingestMail, type MailFixture, mailSourceId } from "../test-support/items.ts";
import { EVENTS, MAIL } from "../test-support/items-named.ts";
import { batchOf, beliefsComputed, claimRecord } from "../test-support/pipeline-fixtures.ts";
import { recordingLogger } from "../test-support/recording.ts";
import { seeder } from "../test-support/seeder.ts";
import { outcomeValue, registration } from "../test-support/values.ts";
import { createWriter } from "../write/writer.ts";
import { expireSourceItem, removeSourceItem } from "../write/writer-item-removal.ts";
import { removeOne } from "../write/writer-records.ts";
import { ERASURE_HOOKS } from "./erasure-hooks.ts";

// Invariant 10, path by path, on one populated store. Each way a thing is removed is run once on the
// live store, against its own target, and what it leaves is stated twice: on the live store, and on a
// copy of the store taken before any of it, as a dump is, after the journal is replayed there. A
// control beside every target says what must stay. Synthetic values only.

const TIMEOUT = 300_000;
const RECORDER = "alpha";
const TOOLS = ["get_self", "find_messages", "read_message", "build_context_pack", "record"] as PersonalTool[];
const FOLDER = "fldErasurePathsRoot01";
const log = recordingLogger().log;
const req = (): string => testId("req");

// A column may keep an erased id only for the reason given: the record of what was removed, or a
// tainted row's note of what it was about.
const KEEPS_AN_ID: Readonly<Record<string, string>> = {
  "knowledge.removed_evidence.evidence_ids": "the erasure's own record of what it removed",
  "ledger.basis.ref_id": "a tainted basis row keeps the id of what it was about",
  "ledger.agent_writes.cites": "a tainted agent record keeps what it cited",
  "ledger.agent_writes.evidence_id": "a removed agent record keeps its ids, its own deleted evidence row's among them",
  "knowledge.owner_decisions.target_id": "the owner's decision stays, tainted, holding ids only",
  "ledger.read_log.bound": "the read log holds ids of what was read, the exposure's record",
  "ledger.read_log.shown": "the read log holds ids of what was read, the exposure's record",
};

type Ids = {
  owner: string;
  solo: { message: MessageId; evidence: string; claim: string; person: EntityId; card: CardId; record: string };
  canary: {
    person: EntityId;
    messages: string[];
    evidence: string[];
    claims: string[];
    nameFps: string[];
    addressFp: string;
  };
  quentin: { person: EntityId; message: MessageId; evidence: string; keptClaim: string; namingClaim: string };
  goal: { id: GoalId; evidence: string; claim: string; control: GoalId };
  note: { claim: FactId; evidence: string };
  event: { id: EventId; evidence: string };
  document: { id: DocumentId; evidence: string };
  capture: { id: CaptureId; evidence: string; account: string; fp: string };
  forgotten: { id: string; evidence: string; account: string; fp: string };
  removedAtSource: { message: string; evidence: string; account: string; sourceItemId: string };
  expired: { message: string; evidence: string; account: string; fp: string };
  record: { id: string; evidence: string; controlMessage: string };
  lifted: { message: MessageId; evidence: string };
  twin: { message: MessageId };
};

let live: TestDatabase;
let restored: TestDatabase;
let ids: Ids;
let replay: { applied: number; journalled: number };
let replayAgain: { applied: number; journalled: number };
const reports: Record<string, ErasureReport> = {};
const dryReports: Record<string, ErasureReport> = {};
let liveWalk: Map<string, string[]>;
let restoredWalk: Map<string, string[]>;

// How many beliefs `own` is given now rest on this stored claim: computed when asked.
const resting = async (db: TestDatabase, claim: string): Promise<number> =>
  (await beliefsComputed(db, ["own"], BELIEF_TYPES, new Date().toISOString())).filter((one) =>
    one.belief.support.some((id) => fingerprint(db.keys, "claim", id) === claim),
  ).length;
const count = async (db: TestDatabase, table: string, where = "true", values: unknown[] = []): Promise<number> =>
  one(await queryAs<{ n: number }>(db.urls.admin, `select count(*)::int as n from ${table} where ${where}`, values)).n;

const messageOf = async (
  db: TestDatabase,
  account: string,
  fixture: MailFixture,
): Promise<{ id: MessageId; evidence: string }> => {
  const row = one(
    await queryAs<{ id: MessageId; evidence_id: string }>(
      db.urls.admin,
      "select m.id, m.evidence_id from knowledge.messages m join vault.evidence_items e on e.id = m.evidence_id where e.source_account_id = $1 and e.source_item_fp = $2",
      [account, fingerprint(db.keys, "source_id", mailSourceId(fixture))],
    ),
  );
  return { id: row.id, evidence: row.evidence_id };
};
const personOf = async (db: TestDatabase, address: string): Promise<EntityId> =>
  one(
    await queryAs<{ entity_id: EntityId }>(
      db.urls.admin,
      "select distinct entity_id from knowledge.accounts where value_fp = $1",
      [fingerprint(db.keys, "address", address)],
    ),
  ).entity_id;

const cardAbout = (refs: { kind: string; id: string }[]): NewCard =>
  ({
    id: testId("crd") as CardId,
    requestId: req(),
    kind: "notice",
    author: "system:test",
    options: ["acknowledge"],
    target: null,
    refs,
    compartments: ["own"],
    expiresAt: null,
    expiresAfterDays: null,
    caseKey: null,
    run: null,
    body: "a card about what is erased",
    bodyFrom: "code",
  }) as NewCard;

const driveFile = (id: string): DriveFile => ({
  id,
  name: `Notes ${id}`,
  mimeType: "application/vnd.google-apps.document",
  createdTime: "2026-09-01T09:00:00.000Z",
  modifiedTime: "2026-09-02T09:00:00.000Z",
  parent: FOLDER,
  root: FOLDER,
  ownedByMe: true,
  modifiedByMe: true,
  owner: { address: OWNER.personal },
  canDownload: true,
});
const BODY: DocBody = { blocks: [{ kind: "paragraph", text: "Notes." }] };

async function populate(db: TestDatabase): Promise<Ids> {
  const writer = createWriter({ url: db.urls.writer, keys: db.keys, log });
  const pool = new pg.Pool({ connectionString: db.urls.admin, max: 2 });
  const readerPool = new pg.Pool({ connectionString: db.urls.reader, max: 2 });
  const admin = new Admin({ pool, keys: db.keys, log, journal: journalPath(db.keyFile), recordEnabled: true });
  const reader = new Reader({ pool: readerPool, keys: db.keys, log });
  const pipeline = createPipeline({ url: db.urls.pipeline, keys: db.keys, log });
  try {
    const accounts = await connect(writer);
    const mailAccount = accounts.personalMail;
    const owner = one(
      await queryAs<{ id: string }>(db.urls.admin, "select id from knowledge.entities where kind = 'owner'"),
    ).id;
    for (const fixture of [
      MAIL.solo,
      MAIL.canary,
      MAIL.reply,
      MAIL.fromQuentin,
      MAIL.toAlias,
      MAIL.twinA,
      MAIL.twinB,
      MAIL.aliasSent,
      MAIL.newsletter,
    ])
      expect(await ingestMail(writer, mailAccount, fixture)).toBe("stored");

    const claimsOf = async (evidence: string): Promise<string[]> =>
      (
        await queryAs<{ id: string }>(
          db.urls.admin,
          "select id from knowledge.claims where evidence_id = $1 order by id",
          [evidence],
        )
      ).map((row) => row.id);
    const commit = async (evidence: string, n: number, entities: string[] = []) => {
      expect(await pipeline.open(evidence as EvidenceId)).not.toBeNull();
      const record = claimRecord(evidence, "own", owner, { n, entities });
      expect(await pipeline.commit(batchOf(evidence, [record]))).toBe("committed");
      return record;
    };

    // An item: its claim with a belief on it, a project binding and a declassified-free claim, a
    // card citing it, and an agent record resting on it.
    const soloMail = await messageOf(db, mailAccount.id, MAIL.solo);
    const soloPerson = await personOf(db, SOLO.address);
    await commit(soloMail.evidence, 1);
    const canaryPerson = await personOf(db, CANARY_PERSON.address);
    const canaryMail = await messageOf(db, mailAccount.id, MAIL.canary);
    await commit(canaryMail.evidence, 2, [canaryPerson]);
    const replyMail = await messageOf(db, mailAccount.id, MAIL.reply);
    const quentinPerson = await personOf(db, QUENTIN.address);
    const quentinMail = await messageOf(db, mailAccount.id, MAIL.fromQuentin);
    expect(await pipeline.open(quentinMail.evidence as EvidenceId)).not.toBeNull();
    const namingClaim = claimRecord(quentinMail.evidence, "own", owner, { n: 3, entities: [canaryPerson] });
    const keptClaim = claimRecord(quentinMail.evidence, "own", owner, { n: 4 });
    expect(await pipeline.commit(batchOf(quentinMail.evidence, [namingClaim, keptClaim]))).toBe("committed");
    const [soloClaimId = ""] = await claimsOf(soloMail.evidence);
    const [canaryClaimId = ""] = await claimsOf(canaryMail.evidence);
    const [namingClaimId = ""] = (
      await queryAs<{ claim_id: string }>(
        db.urls.admin,
        "select n.claim_id from knowledge.claim_entities n join knowledge.claims c on c.id = n.claim_id where c.evidence_id = $1 and n.entity_id = $2",
        [quentinMail.evidence, canaryPerson],
      )
    ).map((row) => row.claim_id);
    const keptClaimId = (await claimsOf(quentinMail.evidence)).find((id) => id !== namingClaimId) ?? "";
    await session(db.urls.admin, async (query) => {
      const seed = seeder(db, query);
      await seed.projectBinding(["own"], soloClaimId);
      await seed.projectBinding(["own"], namingClaimId);
    });

    const card = cardAbout([{ kind: "message", id: soloMail.id }]);
    await admin.cards.raiseCard(card);
    await admin.cards.raiseCard(cardAbout([{ kind: "entity", id: canaryPerson }]));
    const { token } = await admin.clients.addClient(
      registration(RECORDER, ["own"], { tools: TOOLS, views: ALL_VIEWS as never }),
    );
    const recordOn = async (message: string, text: string): Promise<string> => {
      return outcomeValue(
        await reader.record(token, {
          kind: "note",
          body: text,
          requestId: req().padEnd(21, "0"),
          cites: [message],
        } as AgentRecordArgs),
      ).recordId;
    };
    const soloRecord = await recordOn(soloMail.id, "a note on the solo message");
    const twinA = await messageOf(db, mailAccount.id, MAIL.twinA);
    // For the statements' order below: a claim on an item, and a claim naming Quentin.
    await commit((await messageOf(db, mailAccount.id, MAIL.twinB)).evidence, 5);
    await commit(twinA.evidence, 6, [quentinPerson]);
    const ownRecord = await recordOn(twinA.id, "a note removed on its own");
    expect((await writer.takeRecords()).taken).toBe(2);
    const ownRecordEvidence = one(
      await queryAs<{ evidence_id: string }>(
        db.urls.admin,
        "select evidence_id from ledger.agent_writes where id = $1",
        [ownRecord],
      ),
    ).evidence_id;

    // A goal the owner set and its control, and a note about Quentin.
    const [goal, control] = await session(db.urls.admin, async (query) => [
      await writeGoal(query, db.keys, {
        statement: "An erased goal.",
        compartment: "own",
        requestId: req(),
        now: new Date(),
      }),
      await writeGoal(query, db.keys, {
        statement: "A kept goal.",
        compartment: "own",
        requestId: req(),
        now: new Date(),
      }),
    ]);

    // What the hooks reach of the person, as the owner's commands write it where one exists: a goal
    // that targets them, a list, a hide, a name; and as pi_admin writes the rest.
    const canaryFp = fingerprint(db.keys, "address", CANARY_PERSON.address);
    const canaryKey = one(
      await queryAs<{ fact_key_fp: string }>(db.urls.admin, "select fact_key_fp from knowledge.claims where id = $1", [
        canaryClaimId,
      ]),
    ).fact_key_fp;
    const targeting = await session(db.urls.admin, (query) =>
      writeGoal(query, db.keys, {
        statement: "Meet the canary.",
        compartment: "own",
        requestId: req(),
        now: new Date(),
      }),
    );
    expect(await admin.work.setGoalTarget(targeting as GoalId, canaryPerson, { requestId: req() })).toBe(true);
    await admin.lists.addToList(await admin.lists.createList("Canaries", { requestId: req() }), canaryPerson, {
      requestId: req(),
    });
    await admin.ignores.addIgnore("entity", canaryPerson, { requestId: req() });
    await admin.identity.namePerson(canaryPerson, "Canary Example-Name", { requestId: req() });
    await session(db.urls.admin, async (query) => {
      const decision = async (): Promise<string> => {
        const id = testId("rul");
        await query(
          "insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, labels, details, decided_at, compartments) values ($1, $2, 'release', 0, '{}', '{}', now(), '{own}')",
          [id, req()],
        );
        return id;
      };
      await query(
        `insert into knowledge.time_rulings (id, from_at, to_at, source, proposal_id, evidence_ids, lifted_at, lift_ruling_id, created_at, compartments)
         values ($1, now() - interval '1 hour', now(), 'system', $2, $3, now(), $4, now(), '{own}')`,
        [testId("tru"), testId("tpr"), [canaryMail.evidence], await decision()],
      );
      await query(
        "insert into knowledge.goal_key_rulings (ruling_id, verdict, fact_key_fp, created_at, compartments) values ($1, 'hide', $2, now(), '{own}')",
        [await decision(), canaryKey],
      );
      await query("insert into projections.goal_key_ranks (fact_key_fp, rank, compartments) values ($1, 1, '{own}')", [
        canaryKey,
      ]);
      await query(
        "insert into knowledge.mention_bindings (id, ruling_id, evidence_id, mention_fp, address_fp, created_at, compartments) values ($1, $2, $3, $4, $5, now(), '{own}')",
        [
          testId("mbd"),
          await decision(),
          quentinMail.evidence,
          fingerprint(db.keys, "name", "Canary Mention"),
          canaryFp,
        ],
      );
    });
    // A web step: any erasure drops it.
    await session(db.urls.admin, async (query) => {
      const seed = seeder(db, query);
      await seed.into("ledger.run_steps")(["own"]);
    });
    await session(db.urls.bootstrap, async (query) => {
      await query("begin");
      await query("set local role pi_owner");
      await query("alter table ledger.run_steps no force row level security");
      await query(
        "update ledger.run_steps set kind = 'web_fetch', status = null, tool = null, code = null, detail_enc = '{}'::jsonb",
      );
      await query("alter table ledger.run_steps force row level security");
      await query("commit");
    });
    await queryAs(
      db.urls.pipeline,
      `insert into vault.decision_calls (id, point, version, prompt_id, prompt_version, subject, refs, input_fp, model_id, output_enc, compartments)
       values ($1, 'identity_rank', 1, 'jev_identity', '1', $2, $3, $4, 'typesafe/jev-1.13', $5, '{own}')`,
      ((id) => [
        id,
        `facts:${fingerprint(db.keys, "fact", "a")}:${fingerprint(db.keys, "fact", "b")}`,
        [canaryMail.evidence],
        fingerprint(db.keys, "model_input", "a call on the canary's mail"),
        sealRow(db.keys, "own", { table: "vault.decision_calls", id, column: "output_enc" }, "{}"),
      ])(testId("dcc")),
    );
    const goalRow = one(
      await queryAs<{ evidence_id: string; claim_id: string }>(
        db.urls.admin,
        "select evidence_id, claim_id from knowledge.goal_ids where goal_id = $1",
        [goal],
      ),
    );
    const note = await admin.notes.addNote(
      { person: quentinPerson, role: "note", text: "a note about Quentin" },
      { requestId: req() },
    );
    const noteEvidence = one(
      await queryAs<{ evidence_id: string }>(db.urls.admin, "select evidence_id from knowledge.claims where id = $1", [
        note,
      ]),
    ).evidence_id;

    // An event, a document and two captures.
    expect(await ingestEvent(writer, accounts.personalCalendar, EVENTS.guest)).toBe("stored");
    const event = one(
      await queryAs<{ id: EventId; evidence_id: string }>(
        db.urls.admin,
        "select id, evidence_id from knowledge.events limit 1",
      ),
    );
    const drive = await writer.ensureSourceAccount("personal", "google_docs", "own", OWNER.personal);
    await admin.drive.addRoot("personal", FOLDER, "extract");
    const raw = driveItem(driveFile("1ErasurePath0001"), BODY, null, {
      sourceAccount: drive.id,
      changeKind: "backfill",
      ownerAddress: OWNER.personal,
    });
    expect(await writer.ingestItem(drive, raw, (ctx) => deriveItem(raw, ctx, PERSONAL_LIMITS))).toBe("stored");
    const document = one(
      await queryAs<{ id: DocumentId; evidence_id: string }>(
        db.urls.admin,
        "select id, evidence_id from knowledge.documents limit 1",
      ),
    );
    const [capture, forgotten] = await session(db.urls.admin, async (query) => {
      const seed = seeder(db, query);
      return [await seed.capture(["own"]), await seed.capture(["own"])];
    });
    const captureItem = async (evidence: string): Promise<{ account: string; fp: string }> => {
      const row = one(
        await queryAs<{ source_account_id: string; source_item_fp: string }>(
          db.urls.admin,
          "select source_account_id, source_item_fp from vault.evidence_items where id = $1",
          [evidence],
        ),
      );
      return { account: row.source_account_id, fp: row.source_item_fp };
    };
    const toAlias = await messageOf(db, mailAccount.id, MAIL.toAlias);
    const aliasSent = await messageOf(db, mailAccount.id, MAIL.aliasSent);

    return {
      owner,
      solo: {
        message: soloMail.id,
        evidence: soloMail.evidence,
        claim: soloClaimId,
        person: soloPerson,
        card: card.id,
        record: soloRecord,
      },
      canary: {
        person: canaryPerson,
        messages: [canaryMail.id, replyMail.id],
        evidence: [canaryMail.evidence, replyMail.evidence],
        claims: [canaryClaimId, namingClaimId],
        addressFp: fingerprint(db.keys, "address", CANARY_PERSON.address),
        nameFps: [fingerprint(db.keys, "name", CANARY_PERSON.name ?? "")],
      },
      quentin: {
        person: quentinPerson,
        message: quentinMail.id,
        evidence: quentinMail.evidence,
        keptClaim: keptClaimId,
        namingClaim: namingClaimId,
      },
      goal: { id: goal as GoalId, evidence: goalRow.evidence_id, claim: goalRow.claim_id, control: control as GoalId },
      note: { claim: note, evidence: noteEvidence },
      event: { id: event.id, evidence: event.evidence_id },
      document: { id: document.id, evidence: document.evidence_id },
      capture: {
        id: capture?.id as CaptureId,
        evidence: capture?.evidenceId ?? "",
        ...(await captureItem(capture?.evidenceId ?? "")),
      },
      forgotten: {
        id: forgotten?.id ?? "",
        evidence: forgotten?.evidenceId ?? "",
        ...(await captureItem(forgotten?.evidenceId ?? "")),
      },
      removedAtSource: {
        message: toAlias.id,
        evidence: toAlias.evidence,
        account: mailAccount.id,
        sourceItemId: mailSourceId(MAIL.toAlias),
      },
      expired: {
        message: aliasSent.id,
        evidence: aliasSent.evidence,
        account: mailAccount.id,
        fp: fingerprint(db.keys, "source_id", mailSourceId(MAIL.aliasSent)),
      },
      record: { id: ownRecord, evidence: ownRecordEvidence, controlMessage: twinA.id },
      lifted: await messageOf(db, mailAccount.id, MAIL.newsletter).then(({ id, evidence }) => ({
        message: id,
        evidence,
      })),
      twin: { message: (await messageOf(db, mailAccount.id, MAIL.twinB)).id },
    };
  } finally {
    await pipeline.close();
    await writer.close();
    await admin.close();
    await pool.end();
    await readerPool.end();
  }
}

// What a path's ids still hold on a store, beyond the columns allowed to keep one.
const leftIn = (walk: Map<string, string[]>, values: readonly string[]): string[] =>
  [...new Set(values.flatMap((value) => walk.get(value) ?? []))].filter((column) => !(column in KEEPS_AN_ID)).sort();

const gone = (): Record<string, string[]> => ({
  item: [ids.solo.message, ids.solo.evidence, ids.solo.claim],
  person: [ids.canary.person, ...ids.canary.messages, ...ids.canary.evidence, ...ids.canary.claims],
  goal: [ids.goal.id, ids.goal.evidence, ids.goal.claim],
  ownerItem: [ids.note.claim, ids.note.evidence],
  event: [ids.event.id, ids.event.evidence],
  document: [ids.document.id, ids.document.evidence],
  capture: [ids.capture.id, ids.capture.evidence],
  deviceForget: [ids.forgotten.id, ids.forgotten.evidence],
});

beforeAll(async () => {
  live = await createTestDatabase({ compartments: ["own", "employer:example", `agent:${RECORDER}`] });
  ids = await populate(live);
  // The dump: nothing is connected, and nothing of what follows is in it.
  restored = await copyTestDatabase(live);

  const pool = new pg.Pool({ connectionString: live.urls.admin, max: 2 });
  const admin = new Admin({ pool, keys: live.keys, log, journal: journalPath(live.keyFile), recordEnabled: true });
  const context: AdminContext = {
    transaction: (fn) =>
      inTransaction(pool, TRANSACTION, (error) => (error instanceof Error ? error : new Error("unavailable")), fn),
    keys: live.keys,
    log,
    now: () => new Date(),
    journal: journalPath(live.keyFile),
  };
  try {
    const paths: [string, (dryRun: boolean) => Promise<ErasureReport>][] = [
      [
        "item",
        (dryRun) => admin.erasure.eraseItem({ kind: "message", id: ids.solo.message }, { requestId: req(), dryRun }),
      ],
      ["person", (dryRun) => admin.erasure.erasePerson(ids.canary.person, { requestId: req(), dryRun })],
      ["goal", (dryRun) => admin.erasure.eraseGoal(ids.goal.id, { requestId: req(), dryRun })],
      ["ownerItem", (dryRun) => admin.erasure.eraseOwnerItem(ids.note.claim, { requestId: req(), dryRun })],
      ["event", (dryRun) => admin.erasure.eraseItem({ kind: "event", id: ids.event.id }, { requestId: req(), dryRun })],
      [
        "document",
        (dryRun) => admin.erasure.eraseItem({ kind: "document", id: ids.document.id }, { requestId: req(), dryRun }),
      ],
      [
        "capture",
        (dryRun) => admin.erasure.eraseItem({ kind: "capture", id: ids.capture.id }, { requestId: req(), dryRun }),
      ],
    ];
    for (const [name, run] of paths) {
      dryReports[name] = await run(true);
      reports[name] = await run(false);
    }
    await context.transaction(async (query) => {
      await syncLock(query);
      await applyDeviceForget(context, query, [{ accountId: ids.forgotten.account, fp: ids.forgotten.fp }]);
    });
    const lifted = await admin.erasure.eraseItem({ kind: "message", id: ids.lifted.message }, { requestId: req() });
    expect(await admin.erasure.liftErasure(lifted.erasure as ErasureId, { requestId: req() })).toBe(true);
  } finally {
    await admin.close();
    await pool.end();
  }

  // The restore: the copy, with the live journal beside it, replayed twice.
  await copyFile(journalPath(live.keyFile), journalPath(restored.keyFile));
  const restoredPool = new pg.Pool({ connectionString: restored.urls.admin, max: 2 });
  const copy = new Admin({
    pool: restoredPool,
    keys: restored.keys,
    log,
    journal: journalPath(restored.keyFile),
    recordEnabled: true,
  });
  try {
    expect(await copy.erasure.level()).toBe("behind");
    replay = await copy.erasure.replayErasures();
    replayAgain = await copy.erasure.replayErasures();
    expect(await copy.erasure.level()).toBe("level");
  } finally {
    await copy.close();
    await restoredPool.end();
  }
  const everything = [...Object.values(gone()).flat(), ids.canary.addressFp, ...ids.canary.nameFps];
  liveWalk = await holdingEach(live, everything);
  restoredWalk = await holdingEach(restored, everything);
}, TIMEOUT);

afterAll(async () => {
  await restored?.drop();
  await live?.drop();
}, TIMEOUT);

describe("every erasure path, live and on a restored copy", { timeout: TIMEOUT }, () => {
  it("the journal holds one line for each path, the replay applies them all, and a second replay nothing", async () => {
    const { entries } = await readJournal(journalPath(live.keyFile));
    expect(entries).toHaveLength(10);
    expect(replay).toEqual({ applied: 10, journalled: 0 });
    expect(replayAgain).toEqual({ applied: 0, journalled: 0 });
    expect((await readFile(journalPath(restored.keyFile), "utf8")).trim().split("\n")).toHaveLength(10);
  });

  for (const path of ["item", "person", "goal", "ownerItem", "event", "document", "capture", "deviceForget"]) {
    it(`${path}: no column holds what it erased, but those that keep an id for a stated reason`, async () => {
      expect(leftIn(liveWalk, gone()[path] ?? [])).toEqual([]);
      expect(leftIn(restoredWalk, gone()[path] ?? [])).toEqual([]);
    });
  }

  it("a lifted erasure: the item stays gone on both stores, with nothing left that refuses it again", async () => {
    for (const db of [live, restored]) {
      expect(await count(db, "knowledge.messages", "id = $1", [ids.lifted.message])).toBe(0);
      expect(await count(db, "vault.evidence_items", "id = $1", [ids.lifted.evidence])).toBe(0);
      expect(await count(db, "knowledge.removed_evidence", "evidence_ids && $1::text[]", [[ids.lifted.evidence]])).toBe(
        0,
      );
    }
  });

  it("a goal's erasure: its state row is gone on both stores", async () => {
    for (const db of [live, restored])
      expect(await count(db, "projections.goal_state", "goal_id = $1", [ids.goal.id])).toBe(0);
  });

  it("what stays: the controls beside each target, on both stores", async () => {
    for (const db of [live, restored]) {
      expect(await count(db, "knowledge.messages", "id = $1", [ids.quentin.message])).toBe(1);
      expect(await count(db, "knowledge.claims", "id = $1", [ids.quentin.keptClaim])).toBe(1);
      expect(await count(db, "knowledge.entities", "id = $1", [ids.quentin.person])).toBe(1);
      expect(await count(db, "projections.goal_state", "goal_id = $1", [ids.goal.control])).toBe(1);
      expect(await count(db, "knowledge.goal_ids", "goal_id = $1", [ids.goal.control])).toBe(1);
      expect(await count(db, "knowledge.messages", "id = $1", [ids.record.controlMessage])).toBe(1);
      expect(await count(db, "knowledge.messages", "id = $1", [ids.removedAtSource.message])).toBe(1);
    }
  });

  it("an item's erasure: its belief, its binding and its card's body go, the card stays tainted, its agent record is emptied", async () => {
    for (const db of [live, restored]) {
      expect(await resting(db, ids.solo.claim)).toBe(0);
      expect(await count(db, "knowledge.project_bindings", "claim_id = $1", [ids.solo.claim])).toBe(0);
      expect(
        await queryAs(
          db.urls.admin,
          "select tainted_at is not null as tainted, body_enc is null as bare from ledger.cards where id = $1",
          [ids.solo.card],
        ),
      ).toEqual([{ tainted: true, bare: true }]);
      expect(
        await queryAs(db.urls.admin, "select body_enc is null as bare from ledger.agent_writes where id = $1", [
          ids.solo.record,
        ]),
      ).toEqual([{ bare: true }]);
    }
  });

  it("a person's erasure: the naming claim's belief goes and the other claim's stays; the address and names are suppressed; each item has its removed-evidence row", async () => {
    for (const db of [live, restored]) {
      expect(await resting(db, ids.quentin.namingClaim)).toBe(0);
      expect(await resting(db, ids.quentin.keptClaim)).toBe(1);
      expect(await count(db, "knowledge.suppressions", "value_fp = $1", [ids.canary.addressFp])).toBe(1);
      expect(await count(db, "knowledge.removed_evidence", "evidence_ids && $1::text[]", [ids.canary.evidence])).toBe(
        2,
      );
    }
  });

  it("a person's address and name fingerprints are in no column but the suppressions", () => {
    const fps = [ids.canary.addressFp, ...ids.canary.nameFps];
    expect(leftIn(liveWalk, fps)).toEqual(["knowledge.suppressions.value_fp"]);
    expect(leftIn(restoredWalk, fps)).toEqual(["knowledge.suppressions.value_fp"]);
  });

  it("restoredFacts finds no survivor of any path, on either store", async () => {
    for (const db of [live, restored]) {
      const pool = new pg.Pool({ connectionString: db.urls.admin, max: 1 });
      const admin = new Admin({ pool, keys: db.keys, log });
      try {
        expect((await admin.box.restoredFacts()).survivors).toBe(0);
      } finally {
        await admin.close();
        await pool.end();
      }
    }
  });

  // The one count that differs: the removal writes a recheck of each key it empties, and `triggers`
  // deletes it. A dry run removes nothing, so that recheck is not there to count.
  it("the dry run of each path counts what its erasure then does", () => {
    const report = (of: Record<string, ErasureReport>, name: string) => {
      const { erasure: _erasure, more, ...rest } = of[name] as ErasureReport;
      const { triggers: _triggers, ...counts } = more;
      return { ...rest, ...counts };
    };
    for (const name of Object.keys(reports)) expect(report(dryReports, name), name).toEqual(report(reports, name));
  });

  // A hook at 0 proves nothing above. These reach something of the person here; the others have
  // rows only in their own hook's test.
  it("the first path's dry run counts the web steps its erasure drops", () => {
    expect(dryReports.item?.more.web_requests).toBe(1);
    expect(reports.item?.more.web_requests).toBe(1);
    expect(reports.person?.more.web_requests).toBe(0);
  });

  it("the person's dry run compares hooks that reached something", () => {
    const reached = Object.entries(reports.person?.more ?? {})
      .filter(([, n]) => n > 0)
      .map(([name]) => name);
    expect(reached).toEqual(
      expect.arrayContaining([
        "time_rulings",
        "owner_list_members",
        "person_hides",
        "person_names",
        "goal_targets",
        "decision_calls",
        "goal_keys",
        "triggers",
        "mention_bindings",
        "claims_naming",
      ]),
    );
  });

  it("the hooks' order", () => {
    expect(ERASURE_HOOKS.map((hook) => hook.name)).toEqual([
      "meter_rows",
      "dream_findings",
      "send_recipients",
      "sent_source",
      "documents",
      "time_rulings",
      "identity",
      "tier_rulings",
      "owner_list_members",
      "person_hides",
      "person_names",
      "agent_closes",
      "subject_decisions",
      "goal_targets",
      "goal_target_names",
      "memory_changes",
      "agent_people",
      "research_fills",
      "decision_calls",
      "belief_rulings",
      "ruling_anchors",
      "fact_rulings",
      "fact_cards",
      "fact_settlements",
      "claim_relations",
      "goal_keys",
      "triggers",
      "outcomes",
      "source_checks",
      "relation_reports",
      "mention_bindings",
      "org_names",
      "research_requests",
      "pages",
      "captures",
      "trial_outputs",
      "web_requests",
      "mirror",
      "chat_lines",
      "warmth",
      "shown_lessons",
      "promotions",
      "vendor_exposures",
    ]);
  });
});

describe("the removals with no journal line", { timeout: TIMEOUT }, () => {
  it("removeSourceItem, a deletion at the source: the item goes and leaves no removed-evidence row or journal line; on a restored copy it is there until the source's next listing removes it", async () => {
    const { removedAtSource: item } = ids;
    const before = (await readJournal(journalPath(live.keyFile))).entries.length;
    const fp = fingerprint(live.keys, "source_id", item.sourceItemId);
    for (const db of [live, restored]) {
      await session(db.urls.writer, async (query) => {
        await query("begin");
        expect(
          await removeSourceItem({ query, keys: db.keys }, { id: item.account, compartment: "own" }, fp, "deleted"),
        ).toMatchObject({
          removed: true,
        });
        await query("commit");
      });
      expect(await count(db, "knowledge.messages", "id = $1", [item.message])).toBe(0);
      expect(await count(db, "vault.evidence_items", "id = $1", [item.evidence])).toBe(0);
      expect(await count(db, "knowledge.removed_evidence", "evidence_ids && $1::text[]", [[item.evidence]])).toBe(0); // erasure-proves: knowledge.removed_evidence.evidence_ids
    }
    expect((await readJournal(journalPath(live.keyFile))).entries).toHaveLength(before);
    expect(leftIn(await holdingEach(live, [item.message, item.evidence]), [item.message, item.evidence])).toEqual([]);
  });

  it("expireSourceItem, an expiry: all that is derived goes, the latest revision's row stays expired with its blob gone", async () => {
    const { expired } = ids;
    await session(live.urls.writer, async (query) => {
      await query("begin");
      await expireSourceItem(
        { query, keys: live.keys },
        { id: expired.account, compartment: "own" },
        expired.fp,
        new Date(),
      );
      await query("commit");
    });
    expect(await count(live, "knowledge.messages", "id = $1", [expired.message])).toBe(0);
    expect(
      await queryAs(
        live.urls.admin,
        "select payload_state, blob_ref is null as blobless, expired_at is not null as dated from vault.evidence_items where id = $1",
        [expired.evidence],
      ),
    ).toEqual([{ payload_state: "expired", blobless: true, dated: true }]);
    expect(await count(live, "vault.listed_items", "source_item_fp = $1", [expired.fp])).toBe(0);
  });

  it("removeOne, an agent record alone: its body, its evidence row and what was extracted from it go; its row and its ids stay; the message it cited stays", async () => {
    const { record } = ids;
    await session(live.urls.writer, async (query) => {
      await query("begin");
      expect(await removeOne({ query }, record.id)).toBe(true);
      await query("commit");
    });
    expect(
      await queryAs(
        live.urls.admin,
        "select body_enc is null as bare, tainted_at is not null as tainted from ledger.agent_writes where id = $1",
        [record.id],
      ),
    ).toEqual([{ bare: true, tainted: true }]);
    expect(await count(live, "vault.evidence_items", "id = $1", [record.evidence])).toBe(0);
    expect(await count(live, "knowledge.messages", "id = $1", [record.controlMessage])).toBe(1);
  });
});

// The statements an erasure sends, from a pool that notes each. Nothing here depends on their exact
// text beyond what names the table or the function.
function notingPool(pool: pg.Pool, into: string[]): pg.Pool {
  return {
    connect: async () => {
      const client = await pool.connect();
      return {
        query: (text: string, values?: unknown[]) => {
          into.push(text);
          return client.query(text, values);
        },
        release: (error?: Error) => client.release(error),
      };
    },
  } as unknown as pg.Pool;
}

// Each pattern found after the one before it.
function inOrder(statements: string[], patterns: RegExp[]): void {
  let at = 0;
  for (const pattern of patterns) {
    const found = statements.findIndex((text, index) => index >= at && pattern.test(text));
    expect(found, `${pattern} after statement ${at}`).toBeGreaterThanOrEqual(0);
    at = found + 1;
  }
}

describe("the order an erasure's statements come in, on the restored copy", { timeout: TIMEOUT }, () => {
  const run = async (fn: (admin: Admin) => Promise<unknown>): Promise<string[]> => {
    const statements: string[] = [];
    const pool = new pg.Pool({ connectionString: restored.urls.admin, max: 2 });
    const admin = new Admin({
      pool: notingPool(pool, statements),
      keys: restored.keys,
      log,
      journal: journalPath(restored.keyFile),
      recordEnabled: true,
    });
    try {
      await fn(admin);
    } finally {
      await pool.end();
    }
    return statements;
  };
  const LOCKS = [
    /pg_try_advisory_lock|intelligence personal sync/,
    /from knowledge\.messages where id = any\(\$1\) order by id for update/,
    /from knowledge\.documents where id = any\(\$1\) order by id for update/,
    /from vault\.evidence_items where id = any\(\$1\) order by id for update/,
    /intelligence personal beliefs/,
  ];

  it("an item: the sync lock, each row lock, the beliefs lock and the taint lock alone, then the removal, the hooks, one sweep of the taint, and its own rows last", async () => {
    const statements = await run((admin) =>
      admin.erasure.eraseItem({ kind: "message", id: ids.twin.message }, { requestId: req() }),
    );
    inOrder(statements, [
      ...LOCKS,
      /pi\.trigger_cause/,
      /delete from knowledge\.messages/,
      /knowledge\.remove_claims/,
      /ledger\.taint_citing\(\$1, \$2, \$3\)/,
      /delete from vault\.evidence_items/,
      /delete from vault\.evidence_blobs/,
      /ledger\.surfaced_items/,
      /erasure_exposures/,
      /ledger\.taint_citing\('\{\}'::text\[\], '\{\}'::text\[\], '\{\}'::text\[\]\)/,
      /insert into knowledge\.erasures/,
      /insert into knowledge\.removed_evidence/,
    ]);
  });

  it("a person: the claims naming them go before any of their items", async () => {
    const statements = await run((admin) => admin.erasure.erasePerson(ids.quentin.person, { requestId: req() }));
    inOrder(statements, [
      ...LOCKS,
      /from knowledge\.entities where id = any\(\$1\) order by id for update/,
      /pi\.trigger_cause/,
      /delete from knowledge\.project_bindings/,
      /projections\.drop_declassified/,
      /knowledge\.remove_claims/,
      /delete from knowledge\.messages/,
      /ledger\.taint_citing\(\$1, \$2, \$3\)/,
      /insert into knowledge\.suppressions/,
    ]);
  });
});
