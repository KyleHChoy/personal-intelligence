import type { EvidenceId } from "@intelligence/contracts";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { sealUnder } from "../core/seal.ts";
import { OWNER, type Who } from "../test-support/cast.ts";
import { DECISION_TABLES } from "../test-support/catalogue.ts";
import { RUNTIME_ROLES, schemaOf } from "../test-support/catalogue-grants.ts";
import { DECISION_FUNCTIONS, DECISION_SEALED } from "../test-support/catalogue-work.ts";
import { insertClient, sha256Hex, testId } from "../test-support/clients.ts";
import { one, type Query, readAs, session, sqlState } from "../test-support/connections.ts";
import { fingerprint, queryAs, type TestDatabase } from "../test-support/database.ts";
import { type MailFixture, mail, mailFacts, mailRevision, mailSourceId } from "../test-support/items.ts";
import {
  batchOf,
  claimRecord,
  type PipelineStore,
  rowsOf,
  stored,
  withAgents,
  withPipeline,
} from "../test-support/pipeline-fixtures.ts";
import { withDbAdmin as withAdmin } from "../test-support/ruling-fixtures.ts";
import { withDatabase } from "../test-support/store.ts";
import { evidenceIdOf } from "../test-support/values.ts";
import { pending } from "../test-support/waits.ts";

// Every refusal has its positive control in the same test.

const TIMEOUT = 240_000;
const ME: Who = { address: OWNER.personal, name: OWNER.name };
const WORK_ME: Who = { address: OWNER.work, name: OWNER.name };
const SENDER: Who = { address: "ines@harbourmaster.test", name: "Ines Harbourmaster" };

// A received message in the inbox from Ines, declared so a derive finds its facts.
const message = (id: string, at: string, over: Partial<MailFixture> = {}): MailFixture =>
  mail({
    id,
    threadId: `thread-${id}`,
    at,
    from: SENDER,
    to: [ME],
    subject: `Harbour notice ${id}`,
    labels: ["INBOX"],
    ...over,
  });

const admin = <Row = Record<string, unknown>>(db: TestDatabase, text: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(db.urls.admin, text, values);

// One call of vault.mark_recovery as pi_pipeline, outside the store: what it answers.
const mark = async (
  db: TestDatabase,
  evidenceId: string,
  hold: boolean | null,
  seen: string | null = null,
): Promise<boolean> =>
  one(
    await queryAs<{ held: boolean }>(db.urls.pipeline, "select vault.mark_recovery($1, $2, $3) as held", [
      evidenceId,
      hold,
      seen,
    ]),
  ).held;

type Marks = { model_hold_at: Date | null; recovery_screened_at: Date | null; hold_released_at: Date | null };
const marksOf = async (db: TestDatabase, evidenceId: string): Promise<Marks> =>
  one(
    await admin<Marks>(
      db,
      "select model_hold_at, recovery_screened_at, hold_released_at from vault.evidence_items where id = $1",
      [evidenceId],
    ),
  );

// The message row of a source item, which cites its latest revision.
const messageOf = async (
  store: PipelineStore,
  fixture: MailFixture,
): Promise<{ id: string; held: boolean; evidence_id: string }> =>
  one(
    await admin<{ id: string; held: boolean; evidence_id: string }>(
      store.db,
      `select m.id, m.held, m.evidence_id from knowledge.messages m join vault.evidence_items e on e.id = m.evidence_id
       where e.source_item_fp = $1`,
      [fingerprint(store.db.keys, "source_id", mailSourceId(fixture))],
    ),
  );

// A connection holding one explicit transaction open, with what its first statement returned.
async function holding<Row>(
  url: string,
  sql: string,
  values?: unknown[],
): Promise<{
  rows: Row[];
  query: (text: string, values?: unknown[]) => Promise<unknown>;
  commit: () => Promise<void>;
}> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  let open = true;
  await client.query("begin");
  const { rows } = await client.query(sql, values);
  return {
    rows: rows as Row[],
    query: (text, more) => client.query(text, more),
    commit: async () => {
      if (!open) return;
      open = false;
      try {
        await client.query("commit");
      } finally {
        await client.end();
      }
    },
  };
}

// A row of vault.decision_calls in SQL, its output sealed under `own`.
function decisionCall(subject: string, refs: string[], keys: TestDatabase["keys"]): { sql: string; values: unknown[] } {
  const id = testId("dcc");
  return {
    sql: `insert into vault.decision_calls (id, point, version, prompt_id, prompt_version, subject, refs, input_fp, model_id, output_enc, compartments)
          values ($1, 'identity_rank', 1, 'jev_same_person', '1', $2, $3, $4, 'typesafe/jev-1.13', $5, '{own}')`,
    values: [
      id,
      subject,
      refs,
      sha256Hex(`input ${id}`),
      sealUnder(
        keys,
        ["own"],
        { table: "vault.decision_calls", id, column: "output_enc" },
        JSON.stringify({ rawOutput: '{"same_person":0.5}', outputHash: "a".repeat(64) }),
      ),
    ],
  };
}
const pairOf = (a: string, b: string): string => `pair:${[a, b].sort().join(":")}`;

// A draft call, which only the harness send screen's role writes: inserted as pi_owner with the
// forced row security lifted for that one statement and put back in the same transaction.
async function asOwner(db: TestDatabase, row: { sql: string; values: unknown[] }): Promise<void> {
  await session(db.urls.bootstrap, async (query: Query) => {
    await query("begin");
    try {
      await query("set local role pi_owner");
      await query("alter table vault.decision_calls no force row level security");
      await query(row.sql, row.values);
      await query("alter table vault.decision_calls force row level security");
      await query("commit");
    } catch (error) {
      await query("rollback");
      throw error;
    }
  });
}

async function draftCall(db: TestDatabase): Promise<string> {
  const row = decisionCall(`draft:${testId("drf")}`, [testId("drf")], db.keys);
  await asOwner(db, row);
  return row.values[0] as string;
}

describe("0017: the shape of its tables and columns", { timeout: TIMEOUT }, () => {
  it("the seven tables have exactly Data's columns, row-level security forced, pi_owner as owner, and only output_enc and body_enc sealed", () =>
    withDatabase(async (db) => {
      const COLUMNS: Record<string, string[]> = {
        "vault.decision_calls": [
          "id",
          "point",
          "version",
          "prompt_id",
          "prompt_version",
          "subject",
          "refs",
          "input_fp",
          "model_id",
          "created_at",
          "output_enc",
          "compartments",
        ],
        "policy.thresholds": [
          "id",
          "point",
          "version",
          "name",
          "value",
          "decision_id",
          "source",
          "proposal_id",
          "granted_at",
          "revoked_at",
        ],
        "policy.threshold_targets": ["decision_id", "point", "version", "recall", "miss", "precision", "set_at"],
        "policy.rung_suspensions": [
          "id",
          "point",
          "version",
          "rung",
          "report_id",
          "suspended_at",
          "lifted_at",
          "lift_decision_id",
        ],
        "ledger.point_verdicts": [
          "id",
          "request_id",
          "created_at",
          "created_by",
          "compartments",
          "tainted_at",
          "body_enc",
          "point",
          "version",
          "call_id",
          "evidence_id",
          "source",
          "band",
          "weight",
          "deliberate",
          "hurried",
        ],
        "ledger.calibration_reports": [
          "id",
          "point",
          "version",
          "created_at",
          "n",
          "bands",
          "precision",
          "recall",
          "agreement",
          "agreement_28d",
          "intervals",
          "drift",
          "insufficient",
        ],
        "ledger.threshold_proposals": ["id", "point", "version", "name", "value", "report_id", "created_at"],
      };
      expect(Object.keys(COLUMNS).sort()).toEqual([...DECISION_TABLES].sort());
      const columns = await admin<{ place: string; type: string }>(
        db,
        `select table_schema || '.' || table_name || '.' || column_name as place, data_type as type from information_schema.columns
         where table_schema || '.' || table_name = any($1)`,
        [DECISION_TABLES],
      );
      expect(columns.map((row) => row.place).sort()).toEqual(
        Object.entries(COLUMNS)
          .flatMap(([table, names]) => names.map((name) => `${table}.${name}`))
          .sort(),
      );
      // The jsonb columns: the two sealed ones, and a report's bands and intervals, counts in clear.
      expect(
        columns
          .filter((row) => row.type === "jsonb")
          .map((row) => row.place)
          .sort(),
      ).toEqual(
        [
          ...DECISION_SEALED.map((one) => `${one.table}.${one.column}`),
          "ledger.calibration_reports.bands",
          "ledger.calibration_reports.intervals",
        ].sort(),
      );

      const tables = await admin<{ name: string; enabled: boolean; forced: boolean; owner: string }>(
        db,
        `select n.nspname || '.' || c.relname as name, c.relrowsecurity as enabled, c.relforcerowsecurity as forced, pg_get_userbyid(c.relowner)::text as owner
         from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname || '.' || c.relname = any($1) order by 1`,
        [DECISION_TABLES],
      );
      expect(tables).toEqual(
        [...DECISION_TABLES].sort().map((name) => ({ name, enabled: true, forced: true, owner: "pi_owner" })),
      );
    }));

  it("an evidence row gains model_hold_at and recovery_screened_at and a run row gains thresholds, each nullable, and the recovery backlog's partial index exists", () =>
    withDatabase(async (db) => {
      const added = await admin<{ place: string; type: string; nullable: string }>(
        db,
        `select table_schema || '.' || table_name || '.' || column_name as place, data_type as type, is_nullable as nullable from information_schema.columns
         where (table_schema = 'vault' and table_name = 'evidence_items' and column_name in ('model_hold_at', 'recovery_screened_at'))
            or (table_schema = 'vault' and table_name = 'extraction_runs' and column_name = 'thresholds') order by 1`,
      );
      expect(added).toEqual([
        { place: "vault.evidence_items.model_hold_at", type: "timestamp with time zone", nullable: "YES" },
        { place: "vault.evidence_items.recovery_screened_at", type: "timestamp with time zone", nullable: "YES" },
        { place: "vault.extraction_runs.thresholds", type: "jsonb", nullable: "YES" },
      ]);
      const indexes = await admin<{ table: string; definition: string }>(
        db,
        "select schemaname || '.' || tablename as table, indexdef as definition from pg_indexes where schemaname in ('vault', 'policy', 'ledger')",
      );
      // The backlog: email items with no mark, newest first.
      const backlog = indexes.filter(
        (index) => index.table === "vault.evidence_items" && /recovery_screened_at IS NULL/.test(index.definition),
      );
      expect(backlog).toHaveLength(1);
      expect(backlog[0]?.definition).toMatch(/source_kind = 'email'::text/);
      expect(backlog[0]?.definition).toMatch(/\(observed_at DESC, id\)/);
      // A pair call's key, and the GIN index the deletion reads `refs` by.
      const calls = indexes
        .filter((index) => index.table === "vault.decision_calls")
        .map((index) => index.definition.replace(/^CREATE (UNIQUE )?INDEX \S+ ON /, "$1"));
      expect(calls).toContain(
        "UNIQUE vault.decision_calls USING btree (point, version, prompt_id, prompt_version, subject, input_fp)",
      );
      expect(calls).toContain("vault.decision_calls USING gin (refs)");
      // One open suspension per point version.
      expect(
        indexes.some(
          (index) =>
            index.table === "policy.rung_suspensions" &&
            /UNIQUE/.test(index.definition) &&
            /WHERE \(lifted_at IS NULL\)/.test(index.definition),
        ),
      ).toBe(true);
    }));

  it("a decision call's subject is a pair of fingerprints or a draft id, and its refs are ids and fingerprints only", () =>
    withDatabase(async (db) => {
      const a = sha256Hex("address a");
      const b = sha256Hex("address b");
      // The positive control: a pair of fingerprints, sorted, and refs of fingerprints and an evidence id.
      const good = decisionCall(pairOf(a, b), [a, b, sha256Hex("evidence")], db.keys);
      expect(await sqlState(() => admin(db, good.sql, good.values))).toBeNull();
      for (const [subject, refs] of [
        ["pair:Ines Harbourmaster", [a]],
        [`pair:${a}`, [a]],
        [pairOf(a, b), ["ines@harbourmaster.test"]],
        [pairOf(a, b), []],
      ] as const) {
        const bad = decisionCall(subject, [...refs], db.keys);
        expect(await sqlState(() => admin(db, bad.sql, bad.values)), `${subject} ${refs.join(",")}`).toBe("23514");
      }
      // A draft subject is the harness role's to write, and the admin's policy refuses it before
      // the check: the check is tried as the owner, with a well-formed draft as the control.
      expect(await sqlState(() => draftCall(db))).toBeNull();
      const lower = decisionCall(`draft:${testId("drf").toLowerCase()}`, [a], db.keys);
      expect(await sqlState(() => asOwner(db, lower))).toBe("23514");
      expect(await sqlState(() => admin(db, lower.sql, lower.values))).toBe("42501");
    }));
});

describe("0017: vault.mark_recovery, who may call it", { timeout: TIMEOUT }, () => {
  it("vault.mark_recovery is a definer function owned by pi_owner with the core's search path, returns boolean, and PUBLIC holds no EXECUTE", () =>
    withDatabase(async (db) => {
      const [signature] = Object.keys(DECISION_FUNCTIONS);
      // The grantees by name: an aggregate's `order by 1` orders by the constant, so their order
      // was the join's, which a server's plan may change.
      const fn = one(
        await admin<{
          definer: boolean;
          owner: string;
          config: string[];
          returns: string;
          language: string;
          public: boolean;
          grantees: string[];
        }>(
          db,
          `select p.prosecdef as definer, pg_get_userbyid(p.proowner)::text as owner, p.proconfig::text[] as config, pg_get_function_result(p.oid) as returns,
                  l.lanname::text as language, coalesce((select bool_or(a.grantee = 0) from aclexplode(p.proacl) a), true) as public,
                  coalesce((select array_agg(g.rolname::text order by g.rolname) from aclexplode(p.proacl) a join pg_roles g on g.oid = a.grantee
                            where a.grantee <> p.proowner and a.privilege_type = 'EXECUTE'), '{}') as grantees
           from pg_proc p join pg_language l on l.oid = p.prolang where p.oid = $1::regprocedure`,
          [signature],
        ),
      );
      expect({ ...fn, config: fn.config.map((setting) => setting.replaceAll(/[\s"]/g, "")) }).toEqual({
        definer: true,
        owner: "pi_owner",
        config: ["search_path=pg_catalog,policy,pg_temp"],
        returns: "boolean",
        language: "plpgsql",
        public: false,
        grantees: [...(DECISION_FUNCTIONS[signature ?? ""] ?? [])],
      });
      const can = await admin<{ role: string; ok: boolean }>(
        db,
        "select r as role, has_function_privilege(r, $2::regprocedure, 'EXECUTE') as ok from unnest($1::text[]) r order by 1",
        [[...RUNTIME_ROLES], signature],
      );
      expect(can.filter((row) => row.ok).map((row) => row.role)).toEqual(["pi_pipeline", "pi_restricted"]);
    }));

  it("only pi_pipeline may execute vault.mark_recovery: 42501 for pi_admin, pi_writer, pi_reader, pi_work and pi_proxy", () =>
    withDatabase(async (db) => {
      const sql = "select vault.mark_recovery($1, false, null)";
      const values = ["e".repeat(64)];
      for (const url of [db.urls.admin, db.urls.writer, db.urls.work, db.urls.proxy])
        expect(await sqlState(() => queryAs(url, sql, values)), url.split("@")[0]).toBe("42501");
      const client = await insertClient(db, "mark-recovery-reader", ["own"]);
      expect(await sqlState(() => readAs(db, client.token, (query) => query(sql, values)))).toBe("42501");
      expect(await sqlState(() => readAs(db, null, (query) => query(sql, values)))).toBe("42501");
      // The positive control: pi_pipeline runs it, and an id that names no message holds nothing.
      expect(one(await queryAs<{ held: boolean }>(db.urls.pipeline, `${sql} as held`, values)).held).toBe(false);
    }));

  it("pi_pipeline can neither set nor clear a hold by statement: only the function writes model_hold_at, recovery_screened_at and held", () =>
    withPipeline(async (store) => {
      const id = await stored(
        store.writer,
        store.accounts.personalMail,
        message("gm-j2-statement", "2026-09-05T09:00:00Z"),
      );
      for (const sql of [
        "update vault.evidence_items set model_hold_at = now() where id = $1",
        "update vault.evidence_items set recovery_screened_at = now() where id = $1",
        "update vault.evidence_items set model_hold_at = null where id = $1",
        "update knowledge.messages set held = true where evidence_id = $1",
      ]) {
        expect(await sqlState(() => queryAs(store.db.urls.pipeline, sql, [id])), sql).toBe("42501");
      }
      expect(await marksOf(store.db, id)).toEqual({
        model_hold_at: null,
        recovery_screened_at: null,
        hold_released_at: null,
      });
      // The positive control: the function sets them, and the pipeline reads them.
      expect(await mark(store.db, id, true)).toBe(true);
      expect(
        one(
          await queryAs<{ held: boolean }>(
            store.db.urls.pipeline,
            "select model_hold_at is not null as held from vault.evidence_items where id = $1",
            [id],
          ),
        ).held,
      ).toBe(true);
    }));
});

describe("0017: what vault.mark_recovery does", { timeout: TIMEOUT }, () => {
  it("it holds the latest revision only: an earlier revision's id holds nothing and marks nothing", () =>
    withPipeline(async (store) => {
      const { personalMail } = store.accounts;
      const fixture = message("gm-j2-latest", "2026-09-05T09:00:00Z");
      const first = await stored(store.writer, personalMail, fixture);
      expect(await store.writer.ingestItem(personalMail, mailRevision(fixture, personalMail), mailFacts(fixture))).toBe(
        "stored",
      );
      const latest = evidenceIdOf(personalMail, mailSourceId(fixture), 1);
      expect((await messageOf(store, fixture)).evidence_id).toBe(latest);

      expect(await mark(store.db, first, true)).toBe(false);
      expect(await marksOf(store.db, first)).toEqual({
        model_hold_at: null,
        recovery_screened_at: null,
        hold_released_at: null,
      });
      expect(await marksOf(store.db, latest)).toEqual({
        model_hold_at: null,
        recovery_screened_at: null,
        hold_released_at: null,
      });
      expect((await messageOf(store, fixture)).held).toBe(false);

      // The positive control: the latest revision's id holds the message.
      expect(await mark(store.db, latest, true)).toBe(true);
      const marks = await marksOf(store.db, latest);
      expect(marks.model_hold_at).not.toBeNull();
      expect(marks.recovery_screened_at).not.toBeNull();
      expect((await messageOf(store, fixture)).held).toBe(true);
      expect((await marksOf(store.db, first)).model_hold_at).toBeNull();
    }));

  it("it refuses a message the owner released: it answers false and holds nothing, and still marks the item screened", () =>
    withPipeline(async (store) => {
      const { personalMail } = store.accounts;
      const released = message("gm-j2-released", "2026-09-05T09:00:00Z", { held: true });
      const id = await stored(store.writer, personalMail, released);
      const row = await messageOf(store, released);
      expect(row.held).toBe(true);
      await withAdmin(store.db, (owner) => owner.held.releaseHeld({ id: row.id }));
      expect((await messageOf(store, released)).held).toBe(false);

      expect(await mark(store.db, id, true)).toBe(false);
      const marks = await marksOf(store.db, id);
      expect(marks.model_hold_at).toBeNull();
      expect(marks.hold_released_at).not.toBeNull();
      expect(marks.recovery_screened_at).not.toBeNull();
      expect((await messageOf(store, released)).held).toBe(false);

      // The positive control: a message the owner never released is held.
      const other = message("gm-j2-not-released", "2026-09-05T10:00:00Z");
      expect(await mark(store.db, await stored(store.writer, personalMail, other), true)).toBe(true);
      expect((await messageOf(store, other)).held).toBe(true);
    }));

  it("it refuses an agent record: it answers false and marks nothing", () =>
    withAgents(async (world) => {
      const { evidence } = await world.record("alpha");
      expect(await mark(world.db, evidence, true)).toBe(false);
      expect(await marksOf(world.db, evidence)).toEqual({
        model_hold_at: null,
        recovery_screened_at: null,
        hold_released_at: null,
      });
      // The positive control: an email item in the same store is held.
      const email = await stored(
        world.writer,
        world.accounts.personalMail,
        message("gm-j2-beside-record", "2026-09-05T09:00:00Z"),
      );
      expect(await mark(world.db, email, true)).toBe(true);
    }));

  it("it never clears: a later call with hold false, or with hold true again, leaves model_hold_at and held as they are, and a null hold is refused", () =>
    withPipeline(async (store) => {
      const fixture = message("gm-j2-never-clears", "2026-09-05T09:00:00Z");
      const id = await stored(store.writer, store.accounts.personalMail, fixture);
      expect(await mark(store.db, id, true)).toBe(true);
      const at = (await marksOf(store.db, id)).model_hold_at;
      expect(at).not.toBeNull();

      expect(await mark(store.db, id, false)).toBe(false);
      expect((await marksOf(store.db, id)).model_hold_at).toEqual(at);
      expect((await messageOf(store, fixture)).held).toBe(true);

      expect(await mark(store.db, id, true)).toBe(true);
      expect((await marksOf(store.db, id)).model_hold_at).toEqual(at);
      expect((await messageOf(store, fixture)).held).toBe(true);

      expect(await sqlState(() => mark(store.db, id, null))).toBe("22004");
      expect((await marksOf(store.db, id)).model_hold_at).toEqual(at);
    }));

  it("a hold false marks the item screened and holds nothing", () =>
    withPipeline(async (store) => {
      const fixture = message("gm-j2-not-recovery", "2026-09-05T09:00:00Z");
      const id = await stored(store.writer, store.accounts.personalMail, fixture);
      expect(await mark(store.db, id, false)).toBe(false);
      const marks = await marksOf(store.db, id);
      expect(marks.recovery_screened_at).not.toBeNull();
      expect(marks.model_hold_at).toBeNull();
      expect((await messageOf(store, fixture)).held).toBe(false);
    }));

  it("it refuses with PIC01 when the evidence row's xmin is not the one the pipeline saw, before anything is written", () =>
    withPipeline(async (store) => {
      const fixture = message("gm-j2-xmin", "2026-09-05T09:00:00Z");
      const id = await stored(store.writer, store.accounts.personalMail, fixture);
      // xmin 1 is the bootstrap transaction's, which wrote no row of this table.
      expect(await sqlState(() => mark(store.db, id, true, "1"))).toBe("PIC01");
      expect(await marksOf(store.db, id)).toEqual({
        model_hold_at: null,
        recovery_screened_at: null,
        hold_released_at: null,
      });
      expect((await messageOf(store, fixture)).held).toBe(false);
      // The positive control: the row's own xmin.
      const { xmin } = one(
        await admin<{ xmin: string }>(store.db, "select xmin::text as xmin from vault.evidence_items where id = $1", [
          id,
        ]),
      );
      expect(await mark(store.db, id, true, xmin)).toBe(true);
    }));

  it("through the store: markRecovery refuses item_changed for a row rewritten since open, and after a fresh open marks it, and the run's next write for the item is taken", () =>
    withPipeline(async (store) => {
      const fixture = message("gm-j2-store-xmin", "2026-09-05T09:00:00Z");
      const id = (await stored(store.writer, store.accounts.personalMail, fixture)) as EvidenceId;
      expect(await store.pipeline.open(id)).not.toBeNull();
      // A rewrite of the row since it was opened, as a re-derive makes.
      await admin(store.db, "update vault.evidence_items set media_type = media_type where id = $1", [id]);
      await expect(store.pipeline.markRecovery(id, true)).rejects.toMatchObject({ code: "item_changed" });
      expect(await marksOf(store.db, id)).toEqual({
        model_hold_at: null,
        recovery_screened_at: null,
        hold_released_at: null,
      });

      // The next run opens it again; the mark is taken, and moves the xmin the pipeline compares.
      expect(await store.pipeline.open(id)).not.toBeNull();
      expect(await store.pipeline.markRecovery(id, false)).toBe(false);
      expect((await marksOf(store.db, id)).recovery_screened_at).not.toBeNull();
      expect(await store.pipeline.commit(batchOf(id, [claimRecord(id, "own", store.owner)]))).toBe("committed");
    }));
});

describe("0017: a release and a hold of one message at once", { timeout: TIMEOUT }, () => {
  it("the release commits first: the hold then refuses, and the message stays released", () =>
    withPipeline(async (store) => {
      const fixture = message("gm-j2-race-release-first", "2026-09-05T09:00:00Z", { held: true });
      const id = await stored(store.writer, store.accounts.personalMail, fixture);
      const row = await messageOf(store, fixture);
      // The owner's release, in releaseHeld's order: the message row, then the evidence row.
      const release = await holding(
        store.db.urls.admin,
        "select evidence_id from knowledge.messages where id = $1 and held for update",
        [row.id],
      );
      try {
        await release.query("update vault.evidence_items set hold_released_at = now() where id = $1", [id]);
        await release.query("update knowledge.messages set held = false where id = $1", [row.id]);
        const hold = mark(store.db, id, true);
        expect(await pending(hold)).toBe(true);
        await release.commit();
        expect(await hold).toBe(false);
      } finally {
        await release.commit();
      }
      const marks = await marksOf(store.db, id);
      expect(marks.hold_released_at).not.toBeNull();
      expect(marks.model_hold_at).toBeNull();
      expect(marks.recovery_screened_at).not.toBeNull();
      expect((await messageOf(store, fixture)).held).toBe(false);
    }));

  it("the hold commits first: the release waits for it, then releases, and the message stays released", () =>
    withPipeline(async (store) => {
      const fixture = message("gm-j2-race-hold-first", "2026-09-05T09:00:00Z", { held: true });
      const id = await stored(store.writer, store.accounts.personalMail, fixture);
      const row = await messageOf(store, fixture);
      const hold = await holding<{ held: boolean }>(
        store.db.urls.pipeline,
        "select vault.mark_recovery($1, true, null) as held",
        [id],
      );
      try {
        expect(hold.rows).toEqual([{ held: true }]);
        await withAdmin(store.db, async (owner) => {
          const release = owner.held.releaseHeld({ id: row.id });
          expect(await pending(release)).toBe(true);
          await hold.commit();
          expect(await release).toEqual({ released: 1 });
        });
      } finally {
        await hold.commit();
      }
      const marks = await marksOf(store.db, id);
      expect(marks.hold_released_at).not.toBeNull();
      // Never cleared, and no longer holding.
      expect(marks.model_hold_at).not.toBeNull();
      expect((await messageOf(store, fixture)).held).toBe(false);
    }));

  it("the hold commits first on a message no term held: the waiting release finds it held by Jev and releases it", () =>
    withPipeline(async (store) => {
      const fixture = message("gm-j2-race-jev-only", "2026-09-05T09:00:00Z");
      const id = await stored(store.writer, store.accounts.personalMail, fixture);
      const row = await messageOf(store, fixture);
      expect(row.held).toBe(false);
      const hold = await holding<{ held: boolean }>(
        store.db.urls.pipeline,
        "select vault.mark_recovery($1, true, null) as held",
        [id],
      );
      try {
        expect(hold.rows).toEqual([{ held: true }]);
        await withAdmin(store.db, async (owner) => {
          const release = owner.held.releaseHeld({ id: row.id });
          expect(await pending(release)).toBe(true);
          await hold.commit();
          expect(await release).toEqual({ released: 1 });
        });
      } finally {
        await hold.commit();
      }
      expect((await marksOf(store.db, id)).hold_released_at).not.toBeNull();
      expect((await messageOf(store, fixture)).held).toBe(false);
    }));
});

describe("0017: the grants of Data", { timeout: TIMEOUT }, () => {
  // pi_pipeline's grant on vault.decision_calls' `facts:` rows is tested in same-fact.db.test.ts,
  // and left out here.
  const others = DECISION_TABLES.filter(
    (table) => !["policy.thresholds", "policy.rung_suspensions", "vault.decision_calls"].includes(table),
  );

  it("pi_pipeline may select policy.thresholds and policy.rung_suspensions and nothing else of the new tables but decision_calls' facts rows, and writes none of them", () =>
    withDatabase(async (db) => {
      const asPipeline = (sql: string): Promise<string | null> => sqlState(() => queryAs(db.urls.pipeline, sql));
      const asAdmin = (sql: string): Promise<string | null> => sqlState(() => admin(db, sql));
      for (const table of ["policy.thresholds", "policy.rung_suspensions"])
        expect(await asPipeline(`select count(*) from ${table}`), table).toBeNull();
      for (const table of others) {
        expect(await asPipeline(`select count(*) from ${table}`), table).toBe("42501");
        // The control: the admin reads it.
        expect(await asAdmin(`select count(*) from ${table}`), table).toBeNull();
      }
      for (const table of ["policy.thresholds", "policy.rung_suspensions"]) {
        for (const sql of [
          `insert into ${table} (id) select id from ${table} where false`,
          `update ${table} set id = id where false`,
          `delete from ${table} where false`,
        ]) {
          expect(await asPipeline(sql), sql).toBe("42501");
          expect(await asAdmin(sql), `control: ${sql}`).toBeNull();
        }
      }
    }));

  it("pi_writer may delete a pair row of vault.decision_calls, and sees and deletes no draft row, and inserts and updates none", () =>
    withDatabase(async (db) => {
      const a = sha256Hex("writer a");
      const b = sha256Hex("writer b");
      const pair = decisionCall(pairOf(a, b), [a, b], db.keys);
      await admin(db, pair.sql, pair.values);
      const draft = await draftCall(db);
      const asWriter = <Row>(sql: string, values?: unknown[]): Promise<Row[]> =>
        queryAs<Row>(db.urls.writer, sql, values);

      expect((await asWriter<{ id: string }>("select id from vault.decision_calls")).map((row) => row.id)).toEqual([
        pair.values[0],
      ]);
      // A delete of the draft row finds nothing, and the row is still there.
      expect(await asWriter("delete from vault.decision_calls where id = $1 returning id", [draft])).toEqual([]);
      expect(
        (await admin<{ id: string }>(db, "select id from vault.decision_calls where id = $1", [draft])).length,
      ).toBe(1);
      const another = decisionCall(pairOf(a, sha256Hex("writer c")), [a], db.keys);
      expect(await sqlState(() => asWriter(another.sql, another.values))).toBe("42501");
      expect(await sqlState(() => asWriter("update vault.decision_calls set refs = refs where false"))).toBe("42501");
      // The positive control: the pair row is deleted.
      expect(await asWriter("delete from vault.decision_calls where id = $1 returning id", [pair.values[0]])).toEqual([
        { id: pair.values[0] },
      ]);
    }));

  it("pi_admin may insert a pair row and not a draft row, delete any row, and update none", () =>
    withDatabase(async (db) => {
      const a = sha256Hex("admin a");
      const b = sha256Hex("admin b");
      const pair = decisionCall(pairOf(a, b), [a, b], db.keys);
      expect(await sqlState(() => admin(db, pair.sql, pair.values))).toBeNull();
      const draftRow = decisionCall(`draft:${testId("drf")}`, [a], db.keys);
      expect(await sqlState(() => admin(db, draftRow.sql, draftRow.values))).toBe("42501");
      expect(await sqlState(() => admin(db, "update vault.decision_calls set refs = refs where false"))).toBe("42501");
      // It reads and deletes a draft row, for the erasure hook.
      const draft = await draftCall(db);
      expect(
        (await admin<{ id: string }>(db, "select id from vault.decision_calls order by id"))
          .map((row) => row.id)
          .sort(),
      ).toEqual([pair.values[0], draft].sort());
      expect(await admin(db, "delete from vault.decision_calls where id = $1 returning id", [draft])).toEqual([
        { id: draft },
      ]);
    }));

  it("pi_admin may update flagged_at of ledger.agent_writes, and no other column it could not update before", () =>
    withDatabase(async (db) => {
      const updatable = await admin<{ column: string }>(
        db,
        `select a.attname::text as column from pg_attribute a
         where a.attrelid = 'ledger.agent_writes'::regclass and a.attnum > 0 and not a.attisdropped
           and has_column_privilege('pi_admin', 'ledger.agent_writes', a.attname, 'UPDATE') order by 1`,
      );
      // The agent records' three, and the decisions' flag.
      expect(updatable.map((row) => row.column)).toEqual(["body_enc", "evidence_id", "flagged_at", "tainted_at"]);
      expect(
        await sqlState(() => admin(db, "update ledger.agent_writes set flagged_at = null where false")),
      ).toBeNull();
      for (const set of [
        "kind = kind",
        "client_name = client_name",
        "refused_code = refused_code",
        "compartments = compartments",
      ]) {
        expect(await sqlState(() => admin(db, `update ledger.agent_writes set ${set} where false`)), set).toBe("42501");
      }
    }));

  it("the ledger tables are append-only for pi_admin: select and insert, and an update of a verdict's tainted_at and body_enc only, never a delete", () =>
    withDatabase(async (db) => {
      const ledger = DECISION_TABLES.filter((table) => schemaOf(table) === "ledger");
      expect(ledger.sort()).toEqual([
        "ledger.calibration_reports",
        "ledger.point_verdicts",
        "ledger.threshold_proposals",
      ]);
      for (const table of ledger) {
        expect(await sqlState(() => admin(db, `select count(*) from ${table}`)), `select ${table}`).toBeNull();
        expect(await sqlState(() => admin(db, `delete from ${table} where false`)), `delete ${table}`).toBe("42501");
        expect(await sqlState(() => admin(db, `update ${table} set id = id where false`)), `update ${table}.id`).toBe(
          "42501",
        );
        const held = one(
          await admin<{ insert: boolean }>(db, "select has_table_privilege('pi_admin', $1, 'INSERT') as insert", [
            table,
          ]),
        );
        expect(held.insert, `insert ${table}`).toBe(true);
      }
      const updatable = async (table: string): Promise<string[]> =>
        (
          await admin<{ column: string }>(
            db,
            `select a.attname::text as column from pg_attribute a
             where a.attrelid = $1::regclass and a.attnum > 0 and not a.attisdropped and has_column_privilege('pi_admin', $1, a.attname, 'UPDATE') order by 1`,
            [table],
          )
        ).map((row) => row.column);
      expect(await updatable("ledger.point_verdicts")).toEqual(["body_enc", "tainted_at"]);
      expect(await updatable("ledger.calibration_reports")).toEqual([]);
      expect(await updatable("ledger.threshold_proposals")).toEqual([]);
      // The erasure hook's statement runs.
      expect(
        await sqlState(() =>
          admin(db, "update ledger.point_verdicts set tainted_at = now(), body_enc = null where false"),
        ),
      ).toBeNull();
    }));

  it("pi_reader, pi_work and pi_proxy have nothing on any new table", () =>
    withDatabase(async (db) => {
      const held = await admin<{ role: string; table: string }>(
        db,
        `select r as role, t as table from unnest($1::text[]) r cross join unnest($2::text[]) t
         where has_table_privilege(r, t, 'SELECT') or has_table_privilege(r, t, 'INSERT') or has_table_privilege(r, t, 'UPDATE')
            or has_table_privilege(r, t, 'DELETE') or has_any_column_privilege(r, t, 'SELECT, INSERT, UPDATE')`,
        [["pi_reader", "pi_work", "pi_proxy"], DECISION_TABLES],
      );
      expect(held).toEqual([]);
      const client = await insertClient(db, "decisions-reader", ["own"]);
      for (const table of DECISION_TABLES) {
        const sql = `select count(*) from ${table}`;
        expect(await sqlState(() => queryAs(db.urls.work, sql)), `pi_work ${table}`).toBe("42501");
        expect(await sqlState(() => queryAs(db.urls.proxy, sql)), `pi_proxy ${table}`).toBe("42501");
        expect(await sqlState(() => readAs(db, client.token, (query) => query(sql))), `pi_reader ${table}`).toBe(
          "42501",
        );
        // The control: the admin reads every one.
        expect(await sqlState(() => admin(db, sql)), `pi_admin ${table}`).toBeNull();
      }
    }));
});

describe("0017: the pipeline's recovery backlog and run row", { timeout: TIMEOUT }, () => {
  it("recoveryBacklog returns unscreened, unheld, never-released email items, latest revision, newest first, and leaves out one once marked", () =>
    withPipeline(async (store) => {
      const { personalMail, workMail } = store.accounts;
      const newest = message("gm-j2-backlog-newest", "2026-09-10T09:00:00Z");
      const older = message("gm-j2-backlog-older", "2026-09-09T09:00:00Z");
      const revised = message("gm-j2-backlog-revised", "2026-09-08T09:00:00Z");
      const work = message("gm-j2-backlog-work", "2026-09-07T09:00:00Z", { to: [WORK_ME] });
      // Newer than all of them, and each left out.
      const held = message("gm-j2-backlog-held", "2026-09-11T09:00:00Z", { held: true });
      const released = message("gm-j2-backlog-released", "2026-09-12T09:00:00Z", { held: true });
      const screened = message("gm-j2-backlog-screened", "2026-09-13T09:00:00Z");
      const decideModel = message("gm-j2-backlog-jev", "2026-09-14T09:00:00Z");
      for (const fixture of [newest, older, revised, held, released, screened, decideModel])
        await stored(store.writer, personalMail, fixture);
      await stored(store.writer, workMail, work);
      expect(await store.writer.ingestItem(personalMail, mailRevision(revised, personalMail), mailFacts(revised))).toBe(
        "stored",
      );
      await withAdmin(store.db, async (owner) => owner.held.releaseHeld({ id: (await messageOf(store, released)).id }));
      expect(await mark(store.db, evidenceIdOf(personalMail, mailSourceId(screened)), false)).toBe(false);
      expect(await mark(store.db, evidenceIdOf(personalMail, mailSourceId(decideModel)), true)).toBe(true);

      const ids = async (limit: number, options?: { compartments?: string[] }): Promise<string[]> =>
        (await store.pipeline.recoveryBacklog(limit, options)).map((item) => item.evidenceId);
      const latestOf = (fixture: MailFixture, revision = 0): string =>
        evidenceIdOf(personalMail, mailSourceId(fixture), revision);
      const workId = evidenceIdOf(workMail, mailSourceId(work));
      expect(await ids(200)).toEqual([latestOf(newest), latestOf(older), latestOf(revised, 1), workId]);
      expect(await ids(1)).toEqual([latestOf(newest)]);
      expect(await ids(200, { compartments: ["employer:example"] })).toEqual([workId]);
      expect(await ids(200, { compartments: ["own"] })).toEqual([
        latestOf(newest),
        latestOf(older),
        latestOf(revised, 1),
      ]);
      const [first] = await store.pipeline.recoveryBacklog(1);
      expect(first).toMatchObject({
        source: "email",
        evidenceId: latestOf(newest),
        compartments: ["own"],
        triage: { direction: "inbound", bulk: false },
      });

      // Once marked, it is left out; a hold false holds nothing and is still a mark.
      expect(await store.pipeline.markRecovery(latestOf(newest) as EvidenceId, false)).toBe(false);
      expect(await ids(200)).toEqual([latestOf(older), latestOf(revised, 1), workId]);
    }));

  it("a run's thresholds are written to vault.extraction_runs as given, and a run with none writes null", () =>
    withPipeline(async (store) => {
      const counts = {
        done: 1,
        skipped: 0,
        withheld: 0,
        failed: 0,
        waiting: 0,
        claims: 0,
        unmapped: 0,
        unresolved: 0,
        liveCalls: 1,
        beliefs: 0,
        beliefsChanged: 0,
        beliefsMixed: 0,
        beliefsFailed: 0,
        beliefsRemoved: 0,
        rebuildMs: 0,
      };
      const grant = testId("thr");
      const thresholds = [
        { point: "extract_recovery@1", name: "hold", value: 0.7, source: "default" },
        { point: "extract_triage@2", name: "lane", value: 0.55, source: grant },
        { point: "extract_injection@2", name: "hold", value: 0.8, source: `carried:${grant}` },
      ];
      await store.pipeline.recordRun({ code: "ok", counts, thresholds });
      await store.pipeline.recordRun({ code: "ok", counts });
      expect(await rowsOf(store.db, "select thresholds from vault.extraction_runs order by seq")).toEqual([
        { thresholds },
        { thresholds: null },
      ]);
      // The pipeline writes the value with its insert and holds no update of the column.
      expect(
        await sqlState(() =>
          queryAs(store.db.urls.pipeline, "update vault.extraction_runs set thresholds = null where false"),
        ),
      ).toBe("42501");
      // A value that is not an array is refused by the table itself.
      expect(await sqlState(() => admin(store.db, "update vault.extraction_runs set thresholds = '{}'::jsonb"))).toBe(
        "23514",
      );
    }));
});
