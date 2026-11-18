import { randomBytes } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { ALL_VIEWS, sha256Hex, type TestClient, testId } from "../test-support/clients.ts";
import {
  recordLabelOf as labelOf,
  one,
  readAs,
  session,
  openSession as sessionOf,
  sqlState,
} from "../test-support/connections.ts";
import { queryAs, type TestDatabase } from "../test-support/database.ts";
import { seeder } from "../test-support/seeder.ts";
import { withDatabase } from "../test-support/store.ts";

// Every refusal has its positive control in the same test.

const TIMEOUT = 180_000;
const COMPARTMENTS = ["own", "employer:example", "agent:alpha", "agent:beta"];
const FP = "c".repeat(64);
const CITES_FP = "b".repeat(64);
const APPEND = "select outcome, record_id from policy.append_record($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)";
const BODY = { v: 1, nonce: "AAAAAAAAAAAAAAAA", ciphertext: "AAAA", tag: "AAAAAAAAAAAAAAAAAAAAAA==" };
const TAINT = "hashtext('intelligence personal ledger taint')";

type Client = TestClient & { views: string[] };

const withRecords = <T>(fn: (db: TestDatabase) => Promise<T>): Promise<T> =>
  withDatabase(fn, { compartments: COMPARTMENTS });

// A client that holds record and its own agent compartment, inserted as pi_admin.
async function writer(db: TestDatabase, name: string, clearance: string[]): Promise<Client> {
  const compartments = [...clearance, `agent:${name}`];
  const client = { id: testId("cli"), name, token: `pit_test-${name}-${testId("x")}`, compartments, views: ALL_VIEWS };
  await queryAs(
    db.urls.admin,
    `insert into policy.clients (id, name, token_hash, status, vendor_retention, runtime, compartments, views, tools)
     values ($1, $2, $3, 'active', 'none', 'local', $4, $5, $6)`,
    [client.id, name, sha256Hex(client.token), compartments, ALL_VIEWS, ["search", "record"]],
  );
  return client;
}

// One read log row of the session, as the reader writes it, for a tool the client holds.
const logRead = (db: TestDatabase, client: Client, session: string, bound: string[]): Promise<unknown> =>
  readAs(db, client.token, (query) => query("select policy.log_read($1, 'search', $2, '{}', '{}')", [session, bound]));

type Append = { session: string; id?: string; request?: string; cites?: string[]; label: string[]; stamps?: string[] };
const appendArgs = (a: Append): unknown[] => [
  a.session,
  a.id ?? testId("rec"),
  a.request ?? `request-${testId("r").slice(-16)}`,
  "note",
  FP,
  CITES_FP,
  a.cites ?? [],
  a.label,
  BODY,
  a.stamps ?? [],
];
const append = (db: TestDatabase, client: Client, a: Append): Promise<{ outcome: string; record_id: string | null }> =>
  readAs(db, client.token, async (query) =>
    one(await query<{ outcome: string; record_id: string | null }>(APPEND, appendArgs(a))),
  );

const rowCount = async (db: TestDatabase): Promise<number> =>
  one(await queryAs<{ n: number }>(db.urls.admin, "select count(*)::int as n from ledger.agent_writes")).n;
const attempts = async (db: TestDatabase, client: Client): Promise<number> =>
  (
    await queryAs<{ attempts: number }>(
      db.urls.admin,
      "select attempts::int as attempts from policy.record_quota where client_id = $1",
      [client.id],
    )
  )[0]?.attempts ?? 0;

// An evidence row of `own`, as the seeder makes one.
const evidence = (db: TestDatabase): Promise<string> => session(db.urls.admin, (query) => seeder(db, query).evidence());

// One projection row of a client, as policy.serve_memory would leave it, inserted as pi_owner,
// whose policies on ledger.memory_projections let it insert.
async function projection(db: TestDatabase, client: Client, state: "live" | "tainted"): Promise<string> {
  const id = `mpr_${randomBytes(20).toString("hex")}`;
  await session(db.urls.bootstrap, async (query) => {
    await query("set role pi_owner");
    await query(
      `insert into ledger.memory_projections (id, client_id, audience, template, fact_key_fp, state_fp, evidence_ids, compartments, first_served_at, last_served_at, tainted_at)
       values ($1, $2, $3, 'commitments@1', $4, $4, '{}', $3, now(), now(), $5)`,
      [
        id,
        client.id,
        client.compartments.filter((one) => !one.startsWith("agent:")).sort(),
        FP,
        state === "tainted" ? new Date() : null,
      ],
    );
  });
  return id;
}

// A connection of pi_reader, in a transaction of the isolation given, under the client's token.
async function open(db: TestDatabase, client: Client, isolation: string): Promise<pg.Client> {
  const connection = new pg.Client({ connectionString: db.urls.reader });
  await connection.connect();
  await connection.query(`begin isolation level ${isolation}`);
  await connection.query("select set_config('pi.client_token', $1, true)", [client.token]);
  return connection;
}

describe("the removed-evidence check on append_record", { timeout: TIMEOUT }, () => {
  it("append_record waits for an exclusive taint lock held elsewhere", () =>
    withRecords(async (db) => {
      const alpha = await writer(db, "alpha", ["own"]);
      const session = await sessionOf(db, alpha);
      const label = await labelOf(db, alpha);
      // A deletion's taint, as ledger.taint_citing takes it, held by another connection.
      const deletion = new pg.Client({ connectionString: db.urls.admin });
      await deletion.connect();
      try {
        await deletion.query("begin");
        await deletion.query(`select pg_advisory_xact_lock(${TAINT})`);
        let settled = false;
        const waiting = append(db, alpha, { session, label }).finally(() => {
          settled = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(settled).toBe(false);
        expect(await rowCount(db)).toBe(0);
        await deletion.query("commit");
        expect((await waiting).outcome).toBe("ok");
        expect(await rowCount(db)).toBe(1);
      } finally {
        await deletion.end();
      }
      // The control: with no lock held elsewhere it answers at once.
      expect((await append(db, alpha, { session, label })).outcome).toBe("ok");
    }));

  it("append_record in a repeatable-read transaction is refused 42501", () =>
    withRecords(async (db) => {
      const alpha = await writer(db, "alpha", ["own"]);
      const session = await sessionOf(db, alpha);
      const label = await labelOf(db, alpha);
      for (const isolation of ["repeatable read", "serializable"]) {
        const connection = await open(db, alpha, isolation);
        try {
          expect(await sqlState(() => connection.query(APPEND, appendArgs({ session, label }))), isolation).toBe(
            "42501",
          );
        } finally {
          await connection.query("rollback");
          await connection.end();
        }
      }
      expect(await rowCount(db)).toBe(0);
      // The control: the same call read committed, set explicitly, is taken.
      const connection = await open(db, alpha, "read committed");
      try {
        expect(
          (await connection.query<{ outcome: string }>(APPEND, appendArgs({ session, label }))).rows[0]?.outcome,
        ).toBe("ok");
        await connection.query("commit");
      } finally {
        await connection.end();
      }
      expect(await rowCount(db)).toBe(1);
    }));

  it("append_record answers not_found and writes nothing but the quota row when a cite or a bound entry of its session names no evidence row, whatever its read_at", () =>
    withRecords(async (db) => {
      const alpha = await writer(db, "alpha", ["own"]);
      const label = await labelOf(db, alpha);
      const present = await evidence(db);
      const gone = "f".repeat(64);

      // A cite that names no evidence row, beside one that does.
      const citing = await sessionOf(db, alpha);
      expect(await append(db, alpha, { session: citing, cites: [present, gone], label })).toEqual({
        outcome: "not_found",
        record_id: null,
      });
      expect(await attempts(db, alpha)).toBe(1);

      // A bound entry of the session's read log: read before, and read again after another write.
      const reading = await sessionOf(db, alpha);
      await logRead(db, alpha, reading, [present]);
      await logRead(db, alpha, reading, [gone]);
      expect(await append(db, alpha, { session: reading, label })).toEqual({
        outcome: "read_removed",
        record_id: null,
      });
      expect(await append(db, alpha, { session: reading, cites: [present], label })).toEqual({
        outcome: "read_removed",
        record_id: null,
      });
      expect(await attempts(db, alpha)).toBe(3);
      expect(await rowCount(db)).toBe(0);

      // What another session of the client read is not this one's: the control.
      const other = await sessionOf(db, alpha);
      expect((await append(db, alpha, { session: other, cites: [present], label })).outcome).toBe("ok");
      expect(await rowCount(db)).toBe(1);
    }));

  it("close_commitment and answer_owner_question tell a removed read from anything else", () =>
    withRecords(async (db) => {
      const alpha = await writer(db, "alpha", ["own"]);
      await queryAs(db.urls.admin, "update policy.clients set tools = $1 where id = $2", [
        ["search", "record", "close_commitment", "answer_owner_question"],
        alpha.id,
      ]);
      const label = await labelOf(db, alpha);
      const [present, gone] = [await evidence(db), "d".repeat(64)];
      const close = (session: string, cited: string) =>
        readAs(db, alpha.token, async (query) =>
          one(
            await query<{ outcome: string }>(
              "select outcome from ledger.close_commitment($1, $2, $3, $4, 'done', $5, now(), $6, $7, $8, $9, $10, $11)",
              [
                session,
                testId("rec"),
                `request-${testId("r").slice(-16)}`,
                FP,
                [cited],
                FP,
                CITES_FP,
                label,
                BODY,
                label,
                [],
              ],
            ),
          ),
        );
      const answer = (session: string) =>
        readAs(db, alpha.token, async (query) =>
          one(
            await query<{ outcome: string }>(
              "select outcome from ledger.answer_owner_question($1, $2, $3, $4, $5, $6, 'neither', $7, $8, '{}', $9, $10)",
              [
                session,
                testId("rec"),
                `request-${testId("r").slice(-16)}`,
                testId("opp"),
                testId("tst"),
                testId("rul"),
                FP,
                CITES_FP,
                label,
                BODY,
              ],
            ),
          ),
        );
      const reading = await sessionOf(db, alpha);
      await logRead(db, alpha, reading, [gone]);
      expect(await close(reading, present)).toEqual({ outcome: "read_removed" });
      expect(await answer(reading)).toEqual({ outcome: "read_removed" });
      // The controls: a session that read nothing gone is refused for other things, if at all, and a
      // cited item that is gone stays a plain not_found.
      const other = await sessionOf(db, alpha);
      expect(await close(other, gone)).toEqual({ outcome: "not_found" });
      expect(await close(other, present)).not.toEqual({ outcome: "read_removed" });
      expect(await answer(other)).toEqual({ outcome: "not_found" });
    }));

  it("with every evidence row present it writes the record", () =>
    withRecords(async (db) => {
      const alpha = await writer(db, "alpha", ["own"]);
      const label = await labelOf(db, alpha);
      const [cited, read] = [await evidence(db), await evidence(db)];
      const reading = await sessionOf(db, alpha);
      await logRead(db, alpha, reading, [read]);
      const id = testId("rec");
      expect(await append(db, alpha, { session: reading, id, cites: [cited], label })).toEqual({
        outcome: "ok",
        record_id: id,
      });
      expect(await queryAs(db.urls.admin, "select cites from ledger.agent_writes where id = $1", [id])).toEqual([
        { cites: [cited] },
      ]);
      // And once the read item is gone, as the writer's deletion leaves it, the session's next
      // write is refused.
      await queryAs(db.urls.writer, "delete from vault.evidence_items where id = $1", [read]);
      expect(await append(db, alpha, { session: reading, cites: [cited], label })).toEqual({
        outcome: "read_removed",
        record_id: null,
      });
      expect(await rowCount(db)).toBe(1);
    }));

  it("a stamp of the client's tainted projection is refused; another client's tainted projection, and an unknown id, refuse nothing", () =>
    withRecords(async (db) => {
      const alpha = await writer(db, "alpha", ["own"]);
      const beta = await writer(db, "beta", ["own"]);
      const label = await labelOf(db, alpha);
      const session = await sessionOf(db, alpha);
      const tainted = await projection(db, alpha, "tainted");
      const live = await projection(db, alpha, "live");
      const betas = await projection(db, beta, "tainted");
      const unknown = `mpr_${"0".repeat(40)}`;

      expect(await append(db, alpha, { session, label, stamps: [tainted] })).toEqual({
        outcome: "not_found",
        record_id: null,
      });
      expect(await append(db, alpha, { session, label, stamps: [live, tainted] })).toEqual({
        outcome: "not_found",
        record_id: null,
      });
      expect(await rowCount(db)).toBe(0);
      // The controls: its own live projection, another client's tainted one, an id of no row.
      for (const stamps of [[live], [betas], [unknown], []])
        expect((await append(db, alpha, { session, label, stamps })).outcome, stamps.join()).toBe("ok");
      expect(await rowCount(db)).toBe(4);
    }));

  it("pi_reader can execute only the new signature", () =>
    withRecords(async (db) => {
      // Later migrations made it again with an eleventh argument, the record it supersedes, and a
      // twelfth, the project, each null by default, so a call with ten arguments still resolves to it.
      const NEW = "policy.append_record(text, text, text, text, text, text, text[], text[], jsonb, text[], text, text)";
      for (const OLD of [
        "policy.append_record(text, text, text, text, text, text, text[], text[], jsonb)",
        "policy.append_record(text, text, text, text, text, text, text[], text[], jsonb, text[])",
        "policy.append_record(text, text, text, text, text, text, text[], text[], jsonb, text[], text)",
      ]) {
        expect(await queryAs(db.urls.admin, "select to_regprocedure($1) is null as gone", [OLD]), OLD).toEqual([
          { gone: true },
        ]);
      }
      expect(
        await queryAs(db.urls.admin, "select pg_get_function_arguments(to_regprocedure($1)) as args", [NEW]),
      ).toEqual([
        {
          args: "session_id text, new_id text, request_id text, kind text, content_fp text, cites_fp text, cites text[], compartments text[], body_enc jsonb, stamps text[], supersedes_id text DEFAULT NULL::text, project_id text DEFAULT NULL::text",
        },
      ]);
      const roles = ["pi_reader", "pi_writer", "pi_admin", "pi_pipeline", "pi_work", "pi_proxy"];
      const may = await queryAs<{ role: string; may: boolean }>(
        db.urls.admin,
        "select r as role, has_function_privilege(r, to_regprocedure($1), 'execute') as may from unnest($2::text[]) as r order by r",
        [NEW, roles],
      );
      expect(may).toEqual([...roles].sort().map((role) => ({ role, may: role === "pi_reader" })));
      // Still one function by the name, a definer owned by pi_owner.
      expect(
        await queryAs(
          db.urls.admin,
          "select count(*)::int as n, bool_and(prosecdef) as definer, min(pg_get_userbyid(proowner)) as owner from pg_proc where proname = 'append_record'",
        ),
      ).toEqual([{ n: 1, definer: true, owner: "pi_owner" }]);
    }));
});
