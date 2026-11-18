import type { EvidenceId } from "@intelligence/contracts";
import type { ErasureId } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { type Admin, createAdmin } from "../admin/admin.ts";
import { sha256Hex, testId } from "../test-support/clients.ts";
import { one, type Query, session } from "../test-support/connections.ts";
import { queryAs, type TestDatabase } from "../test-support/database.ts";
import { MAIL } from "../test-support/items-named.ts";
import { stored, withPipeline } from "../test-support/pipeline-fixtures.ts";
import { openStore } from "../test-support/store.ts";
import { outcomeValue } from "../test-support/values.ts";
import { seedWorld, WORLD_NOW } from "../test-support/world.ts";

// The store's half of the vendor exposure record: the pipeline's note, committed on a connection of
// its own before it answers, and the owner's two listings. Every refusal has its positive control.
// Made-up values only.

const TIMEOUT = 240_000;
const EXTRACT_MODEL = "openai/gpt-6-luna";
const PROMPT = "personal_correspondence";

const admin = <Row = Record<string, unknown>>(db: TestDatabase, text: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(db.urls.admin, text, values);
const exposures = async (db: TestDatabase): Promise<number> =>
  one(await admin<{ n: number }>(db, "select count(*)::int as n from ledger.exposures")).n;
const rejection = (call: Promise<unknown>): Promise<{ code?: string } | undefined> =>
  call.then(
    () => undefined,
    (error: unknown) => error as { code?: string },
  );

const quiet = { info() {}, warn() {}, error() {} };
async function asAdmin<T>(db: TestDatabase, fn: (owner: Admin) => Promise<T>): Promise<T> {
  const owner = createAdmin({ url: db.urls.admin, keys: db.keys, log: quiet });
  try {
    return await fn(owner);
  } finally {
    await owner.close();
  }
}

// An owner decision and an erasure, as pi_admin: the row a link names.
async function insertErasure(query: Query, id: string, seq: number): Promise<void> {
  const ruling = testId("rul");
  await query(
    `insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, labels, details, decided_at, compartments) values ($1, $2, 'erase', 0, '{}', '{}', now(), '{own}')`,
    [ruling, testId("req")],
  );
  await query(
    `insert into knowledge.erasures (id, ruling_id, kind, journal_seq, erased_at, items, suppressed, tainted_rows, compartments) values ($1, $2, 'item', $3, now(), 1, 0, 0, '{own}')`,
    [id, ruling, seq],
  );
}

describe("the pipeline's note", { timeout: TIMEOUT }, () => {
  it("noteExposure commits before it answers, on a connection of its own, while the run holds the extract lock", () =>
    withPipeline(async ({ pipeline, writer, accounts, db }) => {
      const solo = (await stored(writer, accounts.personalMail, MAIL.solo)) as EvidenceId;
      const seen = await pipeline.withExtractLock(async () => {
        expect(await pipeline.noteExposure(EXTRACT_MODEL, PROMPT, [solo])).toBe(1);
        // Read by another role on another connection before the run ends: it is committed.
        return admin<{
          recipient_kind: string;
          recipient: string;
          route: string;
          ref_kind: string;
          ref: string;
          retention: string;
          compartments: string[];
          today: boolean;
        }>(
          db,
          "select recipient_kind, recipient, route, ref_kind, ref, retention, compartments, day = (now() at time zone 'utc')::date as today from ledger.exposures",
        );
      });
      expect(seen).toEqual([
        {
          recipient_kind: "model",
          recipient: EXTRACT_MODEL,
          route: PROMPT,
          ref_kind: "evidence",
          ref: solo,
          retention: "unknown",
          compartments: ["own"],
          today: true,
        },
      ]);
    }));

  it("a second note of the same item, model and prompt the same day writes nothing; another prompt writes its own", () =>
    withPipeline(async ({ pipeline, writer, accounts, db }) => {
      const solo = (await stored(writer, accounts.personalMail, MAIL.solo)) as EvidenceId;
      expect(await pipeline.noteExposure(EXTRACT_MODEL, PROMPT, [solo])).toBe(1);
      expect(await pipeline.noteExposure(EXTRACT_MODEL, PROMPT, [solo])).toBe(0);
      expect(await pipeline.noteExposure(EXTRACT_MODEL, "jev_screen", [solo])).toBe(1);
      expect(await exposures(db)).toBe(2);
    }));

  it("a note of an id the vault does not hold, or of a model id off the form, rejects unavailable and writes nothing", () =>
    withPipeline(async ({ pipeline, writer, accounts, db }) => {
      const solo = (await stored(writer, accounts.personalMail, MAIL.solo)) as EvidenceId;
      expect(
        await rejection(pipeline.noteExposure(EXTRACT_MODEL, PROMPT, ["f".repeat(64) as EvidenceId])),
      ).toMatchObject({
        code: "unavailable",
      });
      expect(
        await rejection(pipeline.noteExposure(EXTRACT_MODEL, PROMPT, [solo, "f".repeat(64) as EvidenceId])),
      ).toMatchObject({
        code: "unavailable",
      });
      expect(await rejection(pipeline.noteExposure("Not A Model", PROMPT, [solo]))).toMatchObject({
        code: "unavailable",
      });
      expect(await rejection(pipeline.noteExposure(EXTRACT_MODEL, PROMPT, []))).toMatchObject({ code: "unavailable" });
      expect(await exposures(db)).toBe(0);
      // The control.
      expect(await pipeline.noteExposure(EXTRACT_MODEL, PROMPT, [solo])).toBe(1);
    }));

  it("a note is not held up by a shared lock on the item, as a commit takes, and waits for an erasure's", () =>
    withPipeline(async ({ pipeline, writer, accounts, db }) => {
      const solo = (await stored(writer, accounts.personalMail, MAIL.solo)) as EvidenceId;
      await session(db.urls.admin, async (query) => {
        await query("begin");
        await query("select id from vault.evidence_items where id = $1 for share", [solo]);
        expect(await pipeline.noteExposure(EXTRACT_MODEL, PROMPT, [solo])).toBe(1);
        await query("rollback");
      });
      // An erasure locks the item's evidence row for update before its hooks read the record: a
      // note started then waits, so it is either linked by the erasure or finds the row gone.
      await session(db.urls.admin, async (query) => {
        await query("begin");
        await query("select id from vault.evidence_items where id = $1 for update", [solo]);
        let settled = false;
        const note = pipeline.noteExposure(EXTRACT_MODEL, "jev_screen", [solo]).finally(() => (settled = true));
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(settled).toBe(false);
        await query("rollback");
        expect(await note).toBe(1);
      });
      expect(await exposures(db)).toBe(2);
    }));
});

describe("the client route", { timeout: TIMEOUT }, () => {
  it("a pack's read set is recorded for a retaining client, id for id, and nothing for one recorded none", async () => {
    const store = await openStore({
      now: WORLD_NOW,
      compartments: ["own", "employer:example", "agent:packer", "agent:quiet"],
    });
    try {
      await seedWorld(store.writer, store.admin);
      const clients: Record<string, { id: string; token: string }> = {};
      for (const [name, retention] of [
        ["packer", "retains"],
        ["quiet", "none"],
      ] as const) {
        const id = testId("cli");
        const token = `pit_test-${name}-${testId("x")}`;
        await admin(
          store.db,
          `insert into policy.clients (id, name, token_hash, status, vendor_retention, runtime, compartments, views, tools)
           values ($1, $2, $3, 'active', $4, 'local', $5, '{self,people}', '{get_self,record,build_context_pack}')`,
          [id, name, sha256Hex(token), retention, ["own", `agent:${name}`]],
        );
        clients[name] = { id, token };
        outcomeValue(
          await store.reader.record(token, {
            kind: "note",
            body: `a note of ${name}`,
            requestId: `exposure-pack-${name}-0001`,
          }),
        );
        outcomeValue(await store.reader.buildContextPack(token, { purpose: "agent_bootstrap" }));
      }
      const logged = async (client: string): Promise<string[]> =>
        (
          await admin<{ ref: string }>(
            store.db,
            "select distinct x as ref from ledger.read_log r, unnest(r.bound || r.shown || r.fact_key_fps) as x where r.client_id = $1 and r.tool = 'build_context_pack'",
            [client],
          )
        )
          .map((row) => row.ref)
          .sort();
      const exposed = async (client: string): Promise<string[]> =>
        (
          await admin<{ ref: string }>(
            store.db,
            "select ref from ledger.exposures where recipient = $1 and route = 'build_context_pack'",
            [client],
          )
        )
          .map((row) => row.ref)
          .sort();
      const packer = clients.packer?.id ?? "";
      const quiet = clients.quiet?.id ?? "";
      expect((await logged(packer)).length).toBeGreaterThan(0);
      expect(await exposed(packer)).toEqual(await logged(packer));
      expect((await logged(quiet)).length).toBeGreaterThan(0);
      expect(await exposed(quiet)).toEqual([]);
    } finally {
      await store.close();
    }
  });
});

describe("the owner's listings", { timeout: TIMEOUT }, () => {
  it("an unknown erasure is not_found", () =>
    withPipeline(({ db }) =>
      asAdmin(db, (owner) =>
        expect(owner.erasure.listExposures(testId("ers") as ErasureId)).rejects.toMatchObject({ code: "not_found" }),
      ),
    ));

  it("the listing of an erasure gives each recipient by route, its first and last day and the number of ids; the status counts the last 30 days by recipient", () =>
    withPipeline(async ({ db, writer, accounts }) => {
      const solo = await stored(writer, accounts.personalMail, MAIL.solo);
      const quentin = await stored(writer, accounts.personalMail, MAIL.fromQuentin);
      const client = testId("cli");
      await admin(
        db,
        `insert into policy.clients (id, name, token_hash, status, vendor_retention, runtime, compartments, views, tools)
         values ($1, 'listed-reader', $2, 'active', 'retains', 'local', '{own}', '{self}', '{get_self}')`,
        [client, "a".repeat(64)],
      );
      // Rows as the definer function and the trigger write them, as pi_owner through the bootstrap;
      // the last one today, for the status.
      await session(db.urls.bootstrap, async (query) => {
        await query("set role pi_owner");
        const insert = `insert into ledger.exposures (recipient_kind, recipient, route, ref_kind, ref, day, retention, compartments) values ($1, $2, $3, $4, $5, $6::date, $7, '{own}')`;
        await query(insert, ["model", EXTRACT_MODEL, PROMPT, "evidence", solo, "2026-09-01", "unknown"]);
        await query(insert, ["model", EXTRACT_MODEL, PROMPT, "evidence", quentin, "2026-09-03", "unknown"]);
        await query(insert, ["client", client, "read_message", "evidence", solo, "2026-09-02", "retains"]);
        await query(insert, ["client", client, "read_message", "evidence", solo, "2026-09-05", "retains"]);
        const [today] = await query<{ day: string }>("select (now() at time zone 'utc')::date::text as day");
        await query(insert, ["model", EXTRACT_MODEL, "jev_screen", "evidence", solo, today?.day, "unknown"]);
        await query("reset role");
      });
      const erasure = testId("ers");
      await session(db.urls.admin, async (query) => {
        await insertErasure(query, erasure, 1);
        await query(
          "insert into ledger.erasure_exposures (erasure_id, exposure_id, compartments) select $1, id, compartments from ledger.exposures where day < '2026-09-10'",
          [erasure],
        );
      });
      await asAdmin(db, async (owner) => {
        const listed = await owner.erasure.listExposures(erasure as ErasureId);
        expect(listed.erasure).toBe(erasure);
        expect([...listed.recipients].sort((a, b) => (a.kind < b.kind ? -1 : 1))).toEqual([
          {
            kind: "client",
            id: client,
            route: "read_message",
            firstDay: "2026-09-02",
            lastDay: "2026-09-05",
            ids: 1,
            retention: "retains",
            removal: null,
          },
          {
            kind: "model",
            id: EXTRACT_MODEL,
            route: PROMPT,
            firstDay: "2026-09-01",
            lastDay: "2026-09-03",
            ids: 2,
            retention: "unknown",
            removal: null,
          },
        ]);
        const status = await owner.erasure.exposureStatus();
        expect(status.recipients).toEqual([{ kind: "model", id: EXTRACT_MODEL, ids: 1 }]);
        expect(status.since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      });
    }));
});
