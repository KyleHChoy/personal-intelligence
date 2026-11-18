import { copyFile } from "node:fs/promises";
import type { EvidenceId } from "@intelligence/contracts";
import type {
  AgentRecordArgs,
  EntityId,
  ErasureJournalEntry,
  GoalId,
  MessageId,
  NewCard,
  PageId,
  PersonalTool,
} from "@intelligence/contracts/personal";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { Admin } from "../admin/admin.ts";
import { writeGoal } from "../admin/goals/goal-writes.ts";
import { fingerprint } from "../core/fingerprint.ts";
import { newId } from "../core/ids.ts";
import { journalPath, readJournal } from "../core/journal.ts";
import { createPipeline } from "../pipeline/pipeline.ts";
import { Reader } from "../read/read.ts";
import { connect, QUENTIN } from "../test-support/cast.ts";
import { ALL_VIEWS, testId } from "../test-support/clients.ts";
import { one, session } from "../test-support/connections.ts";
import { copyTestDatabase, createTestDatabase, queryAs, sealRow, type TestDatabase } from "../test-support/database.ts";
import { ingestMail, mailSourceId } from "../test-support/items.ts";
import { MAIL } from "../test-support/items-named.ts";
import { batchOf, claimRecord } from "../test-support/pipeline-fixtures.ts";
import { recordingLogger } from "../test-support/recording.ts";
import { seeder } from "../test-support/seeder.ts";
import { outcomeValue, registration } from "../test-support/values.ts";
import { createWriter, type Writer } from "../write/writer.ts";
import type { ErasureHook } from "./erasure-hook.ts";
import { ERASURE_HOOKS } from "./erasure-hooks.ts";

// Invariant 10: what an erasure once left behind, each named by what it erased too little of. Each of
// these failed before its fix. Synthetic values only.

const TIMEOUT = 240_000;
const RECORDER = "alpha";
const TOOLS = ["get_self", "find_messages", "read_message", "build_context_pack", "record"] as PersonalTool[];
const log = recordingLogger().log;
const req = (): string => testId("req");

const count = async (db: TestDatabase, table: string, where = "true", values: unknown[] = []): Promise<number> =>
  one(await queryAs<{ n: number }>(db.urls.admin, `select count(*)::int as n from ${table} where ${where}`, values)).n;

async function withAdmin<T>(db: TestDatabase, fn: (admin: Admin, pool: pg.Pool) => Promise<T>): Promise<T> {
  const pool = new pg.Pool({ connectionString: db.urls.admin, max: 2 });
  try {
    return await fn(
      new Admin({ pool, keys: db.keys, log, journal: journalPath(db.keyFile), recordEnabled: true }),
      pool,
    );
  } finally {
    await pool.end();
  }
}

async function withWriter<T>(db: TestDatabase, fn: (writer: Writer) => Promise<T>): Promise<T> {
  const writer = createWriter({ url: db.urls.writer, keys: db.keys, log });
  try {
    return await fn(writer);
  } finally {
    await writer.close();
  }
}

async function inDatabase(fn: (db: TestDatabase) => Promise<void>): Promise<void> {
  const db = await createTestDatabase({ compartments: ["own", "employer:example", `agent:${RECORDER}`] });
  try {
    await fn(db);
  } finally {
    await db.drop();
  }
}

const ownerOf = async (db: TestDatabase): Promise<string> =>
  one(await queryAs<{ id: string }>(db.urls.admin, "select id from knowledge.entities where kind = 'owner'")).id;

const quentinsMail = async (db: TestDatabase): Promise<{ id: MessageId; evidence: EvidenceId }> =>
  withWriter(db, async (writer) => {
    const { personalMail } = await connect(writer);
    expect(await ingestMail(writer, personalMail, MAIL.fromQuentin)).toBe("stored");
    const row = one(
      await queryAs<{ id: MessageId; evidence_id: EvidenceId }>(
        db.urls.admin,
        "select m.id, m.evidence_id from knowledge.messages m join vault.evidence_items e on e.id = m.evidence_id where e.source_item_fp = $1",
        [fingerprint(db.keys, "source_id", mailSourceId(MAIL.fromQuentin))],
      ),
    );
    return { id: row.id, evidence: row.evidence_id };
  });

// The dump: a copy taken with nothing connected. The live journal is put beside it when it is restored.
const restoring = async (live: TestDatabase, copy: TestDatabase): Promise<void> => {
  await copyFile(journalPath(live.keyFile), journalPath(copy.keyFile));
  await withAdmin(copy, (admin) => admin.erasure.replayErasures());
};

describe("a person with no address", { timeout: TIMEOUT }, () => {
  it("is erased again by a restore's replay, with the claim that names them on another person's mail", () =>
    inDatabase(async (db) => {
      const mail = await quentinsMail(db);
      const person = await session(db.urls.admin, (query) => seeder(db, query).entity("person"));
      const pipeline = createPipeline({ url: db.urls.pipeline, keys: db.keys, log });
      try {
        expect(await pipeline.open(mail.evidence)).not.toBeNull();
        const record = claimRecord(mail.evidence, "own", await ownerOf(db), { entities: [person] });
        expect(await pipeline.commit(batchOf(mail.evidence, [record]))).toBe("committed");
      } finally {
        await pipeline.close();
      }
      expect(await count(db, "knowledge.claim_entities", "entity_id = $1", [person])).toBe(1);
      const copy = await copyTestDatabase(db);
      try {
        await withAdmin(db, (admin) => admin.erasure.erasePerson(person as EntityId, { requestId: req() }));
        expect(await count(db, "knowledge.entities", "id = $1", [person])).toBe(0);
        expect(await count(db, "knowledge.claim_entities", "entity_id = $1", [person])).toBe(0);
        // The journal names the person, who has no address for a replay to find them by.
        const { entries } = await readJournal(journalPath(db.keyFile));
        expect(entries[0]).toMatchObject({ kind: "person", suppress: [], entities: [person] });

        await restoring(db, copy);
        expect(await count(copy, "knowledge.entities", "id = $1", [person])).toBe(0);
        expect(await count(copy, "knowledge.claim_entities", "entity_id = $1", [person])).toBe(0);
        expect(await count(copy, "knowledge.claims", "evidence_id = $1", [mail.evidence])).toBe(0);
      } finally {
        await copy.drop();
      }
    }));

  it("a person nothing names is gone too, with an address or none", () =>
    inDatabase(async (db) => {
      const { bare, addressed, fp } = await session(db.urls.admin, async (query) => {
        const seed = seeder(db, query);
        const addressed = await seed.entity("person");
        const account = await seed.account(["own"], addressed);
        const [row] = await query<{ value_fp: string }>("select value_fp from knowledge.accounts where id = $1", [
          account,
        ]);
        return { bare: await seed.entity("person"), addressed, fp: row?.value_fp };
      });
      await withAdmin(db, async (admin) => {
        await admin.erasure.erasePerson(bare as EntityId, { requestId: req() });
        await admin.erasure.erasePerson(addressed as EntityId, { requestId: req() });
      });
      expect(await count(db, "knowledge.entities", "id = any ($1)", [[bare, addressed]])).toBe(0);
      expect(await count(db, "knowledge.accounts", "value_fp = $1", [fp])).toBe(0);
    }));

  it("a journal line written before lines named the person still replays, by its addresses alone", () =>
    inDatabase(async (db) => {
      const line = {
        seq: 1,
        erasure: `ers_${testId("x").slice(-26)}`,
        kind: "person",
        items: [],
        suppress: [],
      } as unknown as ErasureJournalEntry;
      const { appendJournal } = await import("../core/journal.ts");
      await appendJournal(journalPath(db.keyFile), line);
      await withAdmin(db, async (admin) => {
        expect(await admin.erasure.replayErasures()).toEqual({ applied: 1, journalled: 0 });
      });
    }));
});

describe("a replay hands the hooks the journal's names", { timeout: TIMEOUT }, () => {
  it("the fingerprints a line suppressed are names to the hooks as well as addresses, so a handle a binding named is cleaned on a restored copy too", () =>
    inDatabase(async (db) => {
      await quentinsMail(db);
      const person = one(
        await queryAs<{ entity_id: EntityId }>(
          db.urls.admin,
          "select distinct entity_id from knowledge.accounts where value_fp = $1",
          [fingerprint(db.keys, "address", QUENTIN.address)],
        ),
      ).entity_id;
      const copy = await copyTestDatabase(db);
      try {
        await withAdmin(db, (admin) => admin.erasure.erasePerson(person, { requestId: req() }));
        const seen: { nameFps?: string[]; addressFps: string[] }[] = [];
        const spy: ErasureHook = {
          name: "test_spy",
          run: async (_query, erased) => {
            seen.push(erased);
            return 0;
          },
        };
        const hooks = ERASURE_HOOKS as ErasureHook[];
        hooks.push(spy);
        try {
          await restoring(db, copy);
        } finally {
          hooks.splice(hooks.indexOf(spy), 1);
        }
        const [erased] = seen;
        expect(erased?.addressFps.length).toBeGreaterThan(0);
        expect(erased?.nameFps).toEqual(erased?.addressFps);
      } finally {
        await copy.drop();
      }
    }));
});

describe("an agent record removed with an item", { timeout: TIMEOUT }, () => {
  it("takes the saved decision calls keyed to its own evidence row", () =>
    inDatabase(async (db) => {
      const mail = await quentinsMail(db);
      const record = await withAdmin(db, async (admin) => {
        const readerPool = new pg.Pool({ connectionString: db.urls.reader, max: 2 });
        try {
          const reader = new Reader({ pool: readerPool, keys: db.keys, log });
          const { token } = await admin.clients.addClient(
            registration(RECORDER, ["own"], { tools: TOOLS, views: ALL_VIEWS as never }),
          );
          return outcomeValue(
            await reader.record(token, {
              kind: "note",
              body: "a note on the message",
              requestId: req().padEnd(21, "0"),
              cites: [mail.id],
            } as AgentRecordArgs),
          ).recordId;
        } finally {
          await readerPool.end();
        }
      });
      expect((await withWriter(db, (writer) => writer.takeRecords())).taken).toBe(1);
      const evidence = one(
        await queryAs<{ evidence_id: string }>(
          db.urls.admin,
          "select evidence_id from ledger.agent_writes where id = $1",
          [record],
        ),
      ).evidence_id;
      const call = testId("dcc");
      await queryAs(
        db.urls.pipeline,
        `insert into vault.decision_calls (id, point, version, prompt_id, prompt_version, subject, refs, input_fp, model_id, output_enc, compartments)
         values ($1, 'identity_rank', 1, 'jev_identity', '1', $2, $3, $4, 'typesafe/jev-1.13', $5, '{own}')`,
        [
          call,
          `facts:${fingerprint(db.keys, "fact", "a")}:${fingerprint(db.keys, "fact", "b")}`,
          [evidence],
          fingerprint(db.keys, "model_input", "a check of the record's claims"),
          sealRow(db.keys, "own", { table: "vault.decision_calls", id: call, column: "output_enc" }, "{}"),
        ],
      );
      await withAdmin(db, async (admin) => {
        const dry = await admin.erasure.eraseItem({ kind: "message", id: mail.id }, { requestId: req(), dryRun: true });
        expect(dry.more.decision_calls).toBe(1);
        await admin.erasure.eraseItem({ kind: "message", id: mail.id }, { requestId: req() });
      });
      expect(await count(db, "vault.decision_calls", "id = $1", [call])).toBe(0);
    }));
});

describe("a page", { timeout: TIMEOUT }, () => {
  // A row put in as its table's owner, past its triggers and its policies: what a failed replay, or a
  // run this test does not start, would have left.
  const planted = async (db: TestDatabase, table: string, text: string, values: unknown[]): Promise<void> =>
    session(db.urls.bootstrap, async (query) => {
      await query("begin");
      await query("set local role pi_owner");
      await query(`alter table ${table} disable trigger user`);
      await query(`alter table ${table} no force row level security`);
      await query(text, values);
      await query(`alter table ${table} force row level security`);
      await query(`alter table ${table} enable trigger user`);
      await query("commit");
    });

  const seedPage = async (db: TestDatabase): Promise<{ id: PageId; evidence: string }> => {
    const { evidence, request } = await session(db.urls.admin, async (query) => {
      const seed = seeder(db, query);
      return { evidence: await seed.evidence(["own"]), request: await seed.into("ledger.research_requests")(["own"]) };
    });
    const id = newId("pag") as PageId;
    const at = (column: string) => ({ table: "knowledge.pages", id, column });
    await planted(
      db,
      "knowledge.pages",
      `insert into knowledge.pages (id, evidence_id, request_id, url_fp, host_fp, fetched_at, media_type, page_enc, names_enc, compartments)
       values ($1, $2, $3, $4, $5, now(), 'text/html', $6, $7, '{own}')`,
      [
        id,
        evidence,
        request,
        fingerprint(db.keys, "url", "https://page.test/a"),
        fingerprint(db.keys, "host", "page.test"),
        sealRow(db.keys, "own", at("page_enc"), "{}"),
        sealRow(db.keys, "own", at("names_enc"), "[]"),
      ],
    );
    return { id, evidence };
  };

  it("a dry run counts the card about an erased page, as the erasure taints it", () =>
    inDatabase(async (db) => {
      const page = await seedPage(db);
      await withAdmin(db, async (admin) => {
        await admin.cards.raiseCard({
          id: testId("crd"),
          requestId: req(),
          kind: "notice",
          author: "system:test",
          options: ["acknowledge"],
          target: { kind: "page", id: page.id },
          refs: [],
          compartments: ["own"],
          expiresAt: null,
          expiresAfterDays: null,
          caseKey: null,
          run: null,
          body: "a card about a page",
          bodyFrom: "code",
        } as unknown as NewCard);
        const dry = await admin.erasure.eraseItem({ kind: "page", id: page.id }, { requestId: req(), dryRun: true });
        const real = await admin.erasure.eraseItem({ kind: "page", id: page.id }, { requestId: req() });
        expect(real.taintedRows).toBe(1);
        expect(dry.taintedRows).toBe(real.taintedRows);
      });
    }));

  it("restoredFacts reports an erased page that is here all the same", () =>
    inDatabase(async (db) => {
      const mail = await quentinsMail(db);
      await withAdmin(db, async (admin) => {
        await admin.erasure.eraseItem({ kind: "message", id: mail.id }, { requestId: req() });
        expect((await admin.box.restoredFacts()).survivors).toBe(0);
        // A page the erasure's record names, and that is here all the same, as a failed replay would leave it.
        const page = await seedPage(db);
        await planted(
          db,
          "knowledge.removed_evidence",
          "update knowledge.removed_evidence set evidence_ids = array_append(evidence_ids, $1)",
          [page.evidence],
        );
        expect((await admin.box.restoredFacts()).survivors).toBe(1);
      });
    }));
});

describe("a goal the owner set", { timeout: TIMEOUT }, () => {
  it("keeps no words in its decisions, and a rebuild of the goals' state does not bring it back", () =>
    inDatabase(async (db) => {
      const [goal, kept] = await session(db.urls.admin, async (query) => [
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
      await withAdmin(db, async (admin) => {
        expect(await admin.work.editGoal(goal as GoalId, "An erased goal, reworded.", { requestId: req() })).toBe(true);
        const dry = await admin.erasure.eraseGoal(goal as GoalId, { requestId: req(), dryRun: true });
        const real = await admin.erasure.eraseGoal(goal as GoalId, { requestId: req() });
        expect(dry.taintedRows).toBe(real.taintedRows);
        expect(
          await count(
            db,
            "knowledge.owner_decisions",
            "target_kind = 'goal' and target_id = $1 and body_enc is not null",
            [goal],
          ),
        ).toBe(0);
        expect(
          await count(
            db,
            "knowledge.owner_decisions",
            "target_kind = 'goal' and target_id = $1 and tainted_at is null",
            [goal],
          ),
        ).toBe(0);
        await admin.work.rebuildGoalState();
      });
      expect(await count(db, "projections.goal_state", "goal_id = $1", [goal])).toBe(0);
      expect(await count(db, "projections.goal_state", "goal_id = $1", [kept])).toBe(1);
    }));
});
