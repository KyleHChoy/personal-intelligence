import { describe, expect, it } from "vitest";
import { sealRow } from "../core/seal.ts";
import { insertClient, testId } from "../test-support/clients.ts";
import { one, type Query, readAs, refusal, session, sqlState } from "../test-support/connections.ts";
import { fingerprint, queryAs, type TestDatabase } from "../test-support/database.ts";
import { seeder } from "../test-support/seeder.ts";
import { withDatabase } from "../test-support/store.ts";

// Every refusal has its positive control in the same test. Made-up values only.

const TIMEOUT = 180_000;
const AT = "2026-09-01T00:00:00Z";
// A key file that holds the declassified key, so a declassified row can be sealed as a
// declassification seals it.
const KEYS = { compartments: ["own", "employer:example", "declassified"] };

type Role = "pi_admin" | "pi_writer" | "pi_reader" | "pi_pipeline" | "pi_owner";
type Command = "SELECT" | "INSERT" | "UPDATE" | "DELETE";

// The expected grants: one policy for each cell, named <role>_<command>.
const POLICIES: Record<string, [Role, Command][]> = {
  "knowledge.belief_rulings": [
    ["pi_admin", "SELECT"],
    ["pi_admin", "INSERT"],
    ["pi_admin", "UPDATE"],
    ["pi_owner", "SELECT"],
    // No runtime role's policy or grant changed.
    ["pi_owner", "UPDATE"],
  ],
  "projections.declassified_facts": [
    ["pi_admin", "SELECT"],
    ["pi_admin", "INSERT"],
    ["pi_admin", "DELETE"],
    ["pi_reader", "SELECT"],
    ["pi_owner", "SELECT"],
    ["pi_owner", "DELETE"],
  ],
};
const TWO = Object.keys(POLICIES);

const TABLE_PRIVILEGES = [
  "knowledge.belief_rulings pi_admin INSERT",
  "knowledge.belief_rulings pi_admin SELECT",
  "projections.declassified_facts pi_admin DELETE",
  "projections.declassified_facts pi_admin INSERT",
  "projections.declassified_facts pi_admin SELECT",
];
// The admin's update of a ruling's two lift columns, and the reader's seven columns.
const READER_COLUMNS = ["id", "claim_fp", "evidence_id", "type", "valid_from", "compartments", "fact_enc"];
const COLUMN_GRANTS = [
  "knowledge.belief_rulings lift_ruling_id pi_admin UPDATE",
  "knowledge.belief_rulings lifted_at pi_admin UPDATE",
  ...READER_COLUMNS.map((column) => `projections.declassified_facts ${column} pi_reader SELECT`),
];

// The four functions: their signatures, kinds and the runtime roles that execute them.
const FUNCTIONS: Record<string, { signature: string; volatility: "s" | "v"; execute: Role[] }> = {
  // pi_admin too, for `pi self review`, which reads the same rule.
  "policy.rejected_claims": {
    signature: "policy.rejected_claims()",
    volatility: "s",
    execute: ["pi_pipeline", "pi_admin"],
  },
  "policy.fact_vetoes": { signature: "policy.fact_vetoes()", volatility: "s", execute: ["pi_pipeline"] },
  "policy.belief_rulings_mark": {
    signature: "policy.belief_rulings_mark()",
    volatility: "s",
    execute: ["pi_pipeline"],
  },
  "projections.drop_declassified": {
    signature: "projections.drop_declassified(text[])",
    volatility: "v",
    execute: ["pi_admin", "pi_writer", "pi_pipeline"],
  },
};

const admin = <Row = Record<string, unknown>>(db: TestDatabase, text: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(db.urls.admin, text, values);
const fp = (db: TestDatabase, value: string): string => fingerprint(db.keys, "fact", value);

// One decision of the owner's, as pi_admin writes it.
async function decision(query: Query, kind: string): Promise<string> {
  const id = testId("rul");
  await query(
    `insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, labels, details, decided_at, compartments) values ($1, $2, $3, 0, '{}', '{}', $4, '{own}')`,
    [id, testId("req"), kind, AT],
  );
  return id;
}

type Ruling = {
  verdict: "reject" | "veto" | "retire";
  claim: string;
  factKey: string;
  account?: string | null;
  item?: string | null;
  compartments?: string[];
  at?: string;
};

// One ruling row, with its decision. A reject names its claim's source item; a veto none.
async function ruling(query: Query, given: Ruling): Promise<string> {
  const id = await decision(query, given.verdict === "reject" ? "correction" : "fact_veto");
  await query(
    `insert into knowledge.belief_rulings (ruling_id, verdict, claim_fp, source_account_id, source_item_fp, fact_key_fp, created_at, compartments)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      given.verdict,
      given.claim,
      given.account ?? null,
      given.item ?? null,
      given.factKey,
      given.at ?? AT,
      given.compartments ?? ["own"],
    ],
  );
  return id;
}

const lift = async (query: Query, id: string): Promise<void> => {
  const lifted = await decision(query, "correction_lift");
  await query("update knowledge.belief_rulings set lifted_at = $2, lift_ruling_id = $3 where ruling_id = $1", [
    id,
    AT,
    lifted,
  ]);
};

// One declassified row, sealed under the declassified key, with its decision.
async function declassified(
  db: TestDatabase,
  query: Query,
  claim: string,
  compartments: string[] = ["declassified"],
): Promise<string> {
  const ruled = await decision(query, "declassify");
  const id = testId("dcl");
  const sealed = sealRow(
    db.keys,
    "declassified",
    { table: "projections.declassified_facts", id, column: "fact_enc" },
    '{"type":"commitment"}',
  );
  await query(
    `insert into projections.declassified_facts (id, ruling_id, claim_fp, evidence_id, type, valid_from, created_at, fact_enc, compartments)
     values ($1, $2, $3, $4, 'commitment', $5, $5, $6, $7)`,
    [id, ruled, claim, "e".repeat(64), AT, sealed, compartments],
  );
  return id;
}

describe("0015: the tables of corrections-and-digest", { timeout: TIMEOUT }, () => {
  it("the two tables have exactly the policies and privileges of the grants table", () =>
    withDatabase(async (db) => {
      const policies = await admin<{
        table: string;
        name: string;
        roles: string[];
        cmd: string;
        permissive: string;
        qual: string | null;
        check: string | null;
      }>(
        db,
        `select schemaname || '.' || tablename as "table", policyname as name, roles::text[] as roles, cmd, permissive, qual, with_check as "check"
         from pg_policies where schemaname || '.' || tablename = any($1)`,
        [TWO],
      );
      const expected = TWO.flatMap((table) =>
        (POLICIES[table] ?? []).map(
          ([role, command]) => `${table} ${role}_${command.toLowerCase()} ${role} ${command}`,
        ),
      );
      expect(
        policies.map((policy) => `${policy.table} ${policy.name} ${policy.roles.join(",")} ${policy.cmd}`).sort(),
      ).toEqual(expected.sort());
      for (const policy of policies) {
        const label = `${policy.table} ${policy.name}`;
        expect(policy.permissive, label).toBe("PERMISSIVE");
        // The admin's update sets a lift once: only on an unlifted row, and only to a lift.
        if (label === "knowledge.belief_rulings pi_admin_update") {
          expect({ qual: policy.qual, check: policy.check }, label).toEqual({
            qual: "(lifted_at IS NULL)",
            check: "(lifted_at IS NOT NULL)",
          });
          continue;
        }
        if (policy.roles.includes("pi_reader")) {
          // The reader's row policy reads the clearance once per query, and holds the label key
          // beside it, never instead of it.
          expect(policy.qual, label).toMatch(/^\(\(compartments <@ \(\s*select\s+(policy\.)?client_clearance\(\)/i);
          expect(policy.qual, label).toMatch(
            /\) AND \((policy\.)?label_key\(compartments\)\s*=\s*ANY\s*\(\(\s*SELECT\s+(policy\.)?clearance_keys\(\)/i,
          );
          expect(policy.check, label).toBeNull();
          continue;
        }
        expect(policy.qual, label).toBe(policy.cmd === "INSERT" ? null : "true");
        expect(policy.check, label).toBe(policy.cmd === "SELECT" || policy.cmd === "DELETE" ? null : "true");
      }

      const tables = await admin<{ name: string; enabled: boolean; forced: boolean; owner: string }>(
        db,
        `select n.nspname || '.' || c.relname as name, c.relrowsecurity as enabled, c.relforcerowsecurity as forced, pg_get_userbyid(c.relowner)::text as owner
         from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname || '.' || c.relname = any($1) order by 1`,
        [TWO],
      );
      expect(tables).toEqual([...TWO].sort().map((name) => ({ name, enabled: true, forced: true, owner: "pi_owner" })));

      const privileges = await admin<{ line: string; grantable: boolean }>(
        db,
        `select n.nspname || '.' || c.relname || ' ' || coalesce(g.rolname::text, 'PUBLIC') || ' ' || a.privilege_type as line, a.is_grantable as grantable
         from pg_class c join pg_namespace n on n.oid = c.relnamespace cross join lateral aclexplode(c.relacl) a left join pg_roles g on g.oid = a.grantee
         where n.nspname || '.' || c.relname = any($1) and a.grantee <> c.relowner`,
        [TWO],
      );
      expect(privileges.map((row) => row.line).sort()).toEqual(TABLE_PRIVILEGES);
      expect(privileges.filter((row) => row.grantable)).toEqual([]);

      const columns = await session(db.urls.bootstrap, async (query) => {
        await query("set role pi_owner");
        return query<{ line: string; whole: string }>(
          `select table_schema || '.' || table_name || ' ' || column_name || ' ' || grantee || ' ' || privilege_type as line, table_schema || '.' || table_name || ' ' || grantee || ' ' || privilege_type as whole
           from information_schema.column_privileges where table_schema || '.' || table_name = any($1) and grantee <> 'pi_owner'`,
          [TWO],
        );
      });
      const byTable = new Set(TABLE_PRIVILEGES);
      expect(
        columns
          .filter((row) => !byTable.has(row.whole))
          .map((row) => row.line)
          .sort(),
      ).toEqual([...COLUMN_GRANTS].sort());

      // The four functions: definer, owned by pi_owner, the core's search path, no PUBLIC
      // EXECUTE, and EXECUTE for exactly the roles of the expected table.
      for (const [name, want] of Object.entries(FUNCTIONS)) {
        const fn = one(
          await admin<{
            definer: boolean;
            volatility: string;
            owner: string;
            config: string[] | null;
            public: boolean;
          }>(
            db,
            `select p.prosecdef as definer, p.provolatile::text as volatility, pg_get_userbyid(p.proowner)::text as owner, p.proconfig::text[] as config,
               exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0) as public
             from pg_proc p where p.oid = $1::regprocedure`,
            [want.signature],
          ),
        );
        expect({ ...fn, config: (fn.config ?? []).map((setting) => setting.replaceAll(/[\s"]/g, "")) }, name).toEqual({
          definer: true,
          volatility: want.volatility,
          owner: "pi_owner",
          config: ["search_path=pg_catalog,policy,pg_temp"],
          public: false,
        });
        for (const role of ["pi_admin", "pi_writer", "pi_reader", "pi_pipeline"] as const) {
          const can = one(
            await admin<{ ok: boolean }>(db, "select has_function_privilege($1, $2::regprocedure, 'EXECUTE') as ok", [
              role,
              want.signature,
            ]),
          ).ok;
          expect(can, `${role} ${name}`).toBe(want.execute.includes(role));
        }
      }
    }));

  it("the reader reads a declassified row only when its clearance holds declassified, and only the seven columns of its grant", () =>
    withDatabase(async (db) => {
      await session(db.urls.admin, (query) => declassified(db, query, fp(db, "claim-reader")));
      const cleared = await insertClient(db, "cli-cleared", ["own", "declassified"]);
      const own = await insertClient(db, "cli-own", ["own"]);
      const granted = `select ${READER_COLUMNS.join(", ")} from projections.declassified_facts`;
      expect(await readAs(db, cleared.token, (query) => query(granted))).toHaveLength(1);
      // A client whose clearance lacks declassified reads no row, with the same statement.
      expect(await readAs(db, own.token, (query) => query(granted))).toHaveLength(0);
      expect(await readAs(db, null, (query) => query(granted))).toHaveLength(0);
      for (const column of ["ruling_id", "created_at"]) {
        const sql = `select ${column} from projections.declassified_facts`;
        expect(await sqlState(() => readAs(db, cleared.token, (query) => query(sql))), column).toBe("42501");
        // The positive control: the admin's same statement.
        expect(await admin(db, sql), `control: ${column}`).toHaveLength(1);
      }
    }, KEYS));

  it("the writer and the pipeline read neither table", () =>
    withDatabase(async (db) => {
      await session(db.urls.admin, async (query) => {
        const account = await seeder(db, query).sourceAccount();
        await ruling(query, {
          verdict: "reject",
          claim: fp(db, "claim-w"),
          factKey: fp(db, "fact-w"),
          account,
          item: fp(db, "item-w"),
        });
        await declassified(db, query, fp(db, "claim-w"));
      });
      for (const table of TWO) {
        const sql = `select count(*) from ${table}`;
        for (const [role, url] of [
          ["pi_writer", db.urls.writer],
          ["pi_pipeline", db.urls.pipeline],
        ] as const) {
          expect(await sqlState(() => queryAs(url, sql)), `${role}: ${table}`).toBe("42501");
        }
        expect(one(await admin<{ count: string }>(db, sql)).count, `control: ${table}`).toBe("1");
      }
    }, KEYS));

  it("a declassified row under any compartments but declassified is refused", () =>
    withDatabase(async (db) => {
      await session(db.urls.admin, async (query) => {
        for (const compartments of [["own"], ["declassified", "own"], ["employer:example"]]) {
          expect(
            await refusal(() => declassified(db, query, fp(db, `claim-${compartments.join("-")}`), compartments)),
            compartments.join(","),
          ).toEqual({
            code: "23514",
            constraint: "declassified_facts_compartments",
          });
        }
        // The positive control: declassified alone.
        expect(await refusal(() => declassified(db, query, fp(db, "claim-declassified")))).toBeNull();
      });
    }, KEYS));

  it("a second unlifted reject of one claim, and a second unlifted veto of one fact key, are refused, and allowed once the first is lifted", () =>
    withDatabase(async (db) => {
      await session(db.urls.admin, async (query) => {
        const account = await seeder(db, query).sourceAccount();
        const reject: Ruling = {
          verdict: "reject",
          claim: fp(db, "claim-r"),
          factKey: fp(db, "fact-r"),
          account,
          item: fp(db, "item-r"),
        };
        const veto: Ruling = { verdict: "veto", claim: fp(db, "claim-v"), factKey: fp(db, "fact-v") };
        const firstReject = await ruling(query, reject);
        const firstVeto = await ruling(query, veto);
        // Another claim of the same item and fact key is the same reject.
        expect(await refusal(() => ruling(query, { ...reject, claim: fp(db, "claim-r2") }))).toEqual({
          code: "23505",
          constraint: "belief_rulings_reject_in_force",
        });
        expect(await refusal(() => ruling(query, { ...veto, claim: fp(db, "claim-v2") }))).toEqual({
          code: "23505",
          constraint: "belief_rulings_veto_in_force",
        });
        // The control: a reject of the same fact key from another item, and a veto of another
        // fact key, stand beside them.
        expect(await refusal(() => ruling(query, { ...reject, item: fp(db, "item-other") }))).toBeNull();
        expect(await refusal(() => ruling(query, { ...veto, factKey: fp(db, "fact-other") }))).toBeNull();
        // A reject and a veto of one fact key are two verdicts.
        expect(await refusal(() => ruling(query, { ...veto, factKey: reject.factKey }))).toBeNull();

        await lift(query, firstReject);
        await lift(query, firstVeto);
        expect(await refusal(() => ruling(query, reject))).toBeNull();
        expect(await refusal(() => ruling(query, veto))).toBeNull();
      });
    }));

  it("a reject with no source item and a veto with one are refused", () =>
    withDatabase(async (db) => {
      await session(db.urls.admin, async (query) => {
        const account = await seeder(db, query).sourceAccount();
        const claim = fp(db, "claim-s");
        const factKey = fp(db, "fact-s");
        const item = fp(db, "item-s");
        const refused = { code: "23514", constraint: "belief_rulings_source" };
        expect(await refusal(() => ruling(query, { verdict: "reject", claim, factKey }))).toEqual(refused);
        expect(await refusal(() => ruling(query, { verdict: "reject", claim, factKey, account }))).toEqual(refused);
        expect(await refusal(() => ruling(query, { verdict: "reject", claim, factKey, item }))).toEqual(refused);
        expect(await refusal(() => ruling(query, { verdict: "veto", claim, factKey, account, item }))).toEqual(refused);
        expect(await refusal(() => ruling(query, { verdict: "veto", claim, factKey, item }))).toEqual(refused);
        // A retire holds by its fact key alone, as a veto does.
        expect(await refusal(() => ruling(query, { verdict: "retire", claim, factKey, account, item }))).toEqual(
          refused,
        );
        // A verdict outside the two. The source check refuses it too, and Postgres names the
        // first check it fails, so the verdict check is also read from the catalogue.
        expect((await refusal(() => ruling(query, { verdict: "keep" as never, claim, factKey })))?.code).toBe("23514");
        expect(
          await query<{ def: string }>(
            "select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'belief_rulings_verdict'",
          ),
        ).toEqual([
          // The owner's domain and kind rulings.
          {
            def: "CHECK ((verdict = ANY (ARRAY['reject'::text, 'veto'::text, 'retire'::text, 'domain'::text, 'kind'::text])))",
          },
        ]);
        // The positive controls.
        expect(await refusal(() => ruling(query, { verdict: "reject", claim, factKey, account, item }))).toBeNull();
        expect(await refusal(() => ruling(query, { verdict: "veto", claim, factKey }))).toBeNull();
        expect(await refusal(() => ruling(query, { verdict: "retire", claim, factKey: fp(db, "fact-r") }))).toBeNull();
      });
    }));

  it("rejected_claims and fact_vetoes return the unlifted rulings, in order, to the pipeline only, and the rejected claims to the admin", () =>
    withDatabase(async (db) => {
      const made = await session(db.urls.admin, async (query) => {
        const account = await seeder(db, query).sourceAccount();
        const later = await ruling(query, {
          verdict: "reject",
          claim: fp(db, "c2"),
          factKey: fp(db, "f2"),
          account,
          item: fp(db, "i2"),
          at: "2026-09-03T00:00:00Z",
        });
        const earlier = await ruling(query, {
          verdict: "reject",
          claim: fp(db, "c1"),
          factKey: fp(db, "f1"),
          account,
          item: fp(db, "i1"),
          at: "2026-09-02T00:00:00Z",
        });
        const lifted = await ruling(query, {
          verdict: "reject",
          claim: fp(db, "c3"),
          factKey: fp(db, "f3"),
          account,
          item: fp(db, "i3"),
          at: "2026-09-01T00:00:00Z",
        });
        await lift(query, lifted);
        const vetoLater = await ruling(query, {
          verdict: "veto",
          claim: fp(db, "c5"),
          factKey: fp(db, "f5"),
          compartments: ["employer:example", "own"],
          at: "2026-09-05T00:00:00Z",
        });
        const vetoEarlier = await ruling(query, {
          verdict: "veto",
          claim: fp(db, "c4"),
          factKey: fp(db, "f4"),
          at: "2026-09-04T00:00:00Z",
        });
        const vetoLifted = await ruling(query, {
          verdict: "veto",
          claim: fp(db, "c6"),
          factKey: fp(db, "f6"),
          at: "2026-09-01T00:00:00Z",
        });
        await lift(query, vetoLifted);
        return { account, later, earlier, vetoLater, vetoEarlier };
      });

      const rejected = await queryAs(db.urls.pipeline, "select * from policy.rejected_claims()");
      expect(rejected).toEqual([
        { source_account_id: made.account, source_item_fp: fp(db, "i1"), fact_key_fp: fp(db, "f1") },
        { source_account_id: made.account, source_item_fp: fp(db, "i2"), fact_key_fp: fp(db, "f2") },
      ]);
      const vetoes = await queryAs<{
        ruling_id: string;
        fact_key_fp: string;
        created_at: Date;
        compartments: string[];
      }>(db.urls.pipeline, "select * from policy.fact_vetoes()");
      expect(vetoes.map((row) => ({ ...row, created_at: row.created_at.toISOString() }))).toEqual([
        {
          ruling_id: made.vetoEarlier,
          fact_key_fp: fp(db, "f4"),
          created_at: "2026-09-04T00:00:00.000Z",
          compartments: ["own"],
        },
        {
          ruling_id: made.vetoLater,
          fact_key_fp: fp(db, "f5"),
          created_at: "2026-09-05T00:00:00.000Z",
          compartments: ["employer:example", "own"],
        },
      ]);

      // No other role runs them, but pi_admin the rejected claims, for `pi self review`.
      const client = await insertClient(db, "cli-reader", ["own"]);
      for (const sql of [
        "select * from policy.rejected_claims()",
        "select * from policy.fact_vetoes()",
        "select policy.belief_rulings_mark()",
      ]) {
        expect(await sqlState(() => queryAs(db.urls.admin, sql)), `pi_admin: ${sql}`).toBe(
          sql.includes("rejected_claims") ? null : "42501",
        );
        expect(await sqlState(() => queryAs(db.urls.writer, sql)), `pi_writer: ${sql}`).toBe("42501");
        expect(await sqlState(() => readAs(db, client.token, (query) => query(sql))), `pi_reader: ${sql}`).toBe(
          "42501",
        );
        expect(await sqlState(() => queryAs(db.urls.pipeline, sql)), `control: ${sql}`).toBeNull();
      }
    }));

  it("the mark rises with each ruling and each lift and never falls", () =>
    withDatabase(async (db) => {
      const mark = async (): Promise<number> =>
        Number(
          one(await queryAs<{ mark: string }>(db.urls.pipeline, "select policy.belief_rulings_mark()::text as mark"))
            .mark,
        );
      expect(await mark()).toBe(0);
      const marks: number[] = [];
      await session(db.urls.admin, async (query) => {
        const account = await seeder(db, query).sourceAccount();
        const first = await ruling(query, {
          verdict: "reject",
          claim: fp(db, "m1"),
          factKey: fp(db, "mf1"),
          account,
          item: fp(db, "mi1"),
        });
        marks.push(await mark());
        const second = await ruling(query, { verdict: "veto", claim: fp(db, "m2"), factKey: fp(db, "mf2") });
        marks.push(await mark());
        await lift(query, first);
        marks.push(await mark());
        // A second ruling of the lifted one: the mark still rises.
        await ruling(query, {
          verdict: "reject",
          claim: fp(db, "m1"),
          factKey: fp(db, "mf1"),
          account,
          item: fp(db, "mi1"),
        });
        marks.push(await mark());
        await lift(query, second);
        marks.push(await mark());
      });
      expect(marks).toEqual([1, 2, 3, 4, 5]);
      // Read through the definer: without its policy the function would see no row.
      expect(one(await admin<{ n: number }>(db, "select count(*)::int as n from knowledge.belief_rulings")).n).toBe(3);
    }));

  it("a lift is set once: it cannot be cleared or rewritten, so the mark never falls", () =>
    withDatabase(async (db) => {
      const mark = async (): Promise<number> =>
        Number(
          one(await queryAs<{ mark: string }>(db.urls.pipeline, "select policy.belief_rulings_mark()::text as mark"))
            .mark,
        );
      await session(db.urls.admin, async (query) => {
        const lifted = await ruling(query, { verdict: "veto", claim: fp(db, "o1"), factKey: fp(db, "of1") });
        const standing = await ruling(query, { verdict: "veto", claim: fp(db, "o2"), factKey: fp(db, "of2") });
        await lift(query, lifted);
        expect(await mark()).toBe(3);
        const again = await decision(query, "fact_veto_lift");
        // A lifted ruling's lift is neither cleared nor rewritten: the update finds no row.
        expect(
          await query(
            "update knowledge.belief_rulings set lifted_at = null, lift_ruling_id = null where ruling_id = $1 returning ruling_id",
            [lifted],
          ),
        ).toEqual([]);
        expect(
          await query(
            "update knowledge.belief_rulings set lifted_at = $2, lift_ruling_id = $3 where ruling_id = $1 returning ruling_id",
            [lifted, "2026-09-09T00:00:00Z", again],
          ),
        ).toEqual([]);
        // An unlifted ruling cannot be updated to no lift.
        expect(
          await sqlState(() =>
            query("update knowledge.belief_rulings set lift_ruling_id = lift_ruling_id where ruling_id = $1", [
              standing,
            ]),
          ),
        ).toBe("42501");
        expect(await mark()).toBe(3);
        // The positive control: the standing ruling's lift is set, once.
        expect(
          await query(
            "update knowledge.belief_rulings set lifted_at = $2, lift_ruling_id = $3 where ruling_id = $1 returning ruling_id",
            [standing, AT, again],
          ),
        ).toEqual([{ ruling_id: standing }]);
        expect(await mark()).toBe(4);
      });
    }));

  it("drop_declassified deletes the rows of the claims named, returns the count, and a second call returns 0", () =>
    withDatabase(async (db) => {
      const claims = ["d1", "d2", "d3", "d4"].map((name) => fp(db, name));
      await session(db.urls.admin, async (query) => {
        for (const claim of claims) await declassified(db, query, claim);
      });
      const drop = async (url: string, named: string[]): Promise<number> =>
        one(await queryAs<{ n: number }>(url, "select projections.drop_declassified($1) as n", [named])).n;
      const left = async (): Promise<string[]> =>
        (
          await admin<{ claim_fp: string }>(db, "select claim_fp from projections.declassified_facts order by claim_fp")
        ).map((row) => row.claim_fp);

      expect(await drop(db.urls.writer, [claims[0] ?? "", fp(db, "never-declassified")])).toBe(1);
      expect(await drop(db.urls.writer, [claims[0] ?? ""])).toBe(0);
      expect(await drop(db.urls.pipeline, [claims[1] ?? ""])).toBe(1);
      expect(await drop(db.urls.admin, [claims[2] ?? ""])).toBe(1);
      expect(await drop(db.urls.admin, [])).toBe(0);
      // The control: the claim no call named is still there.
      expect(await left()).toEqual([claims[3]]);
      const client = await insertClient(db, "cli-dropper", ["own", "declassified"]);
      expect(
        await sqlState(() =>
          readAs(db, client.token, (query) => query("select projections.drop_declassified($1)", [[claims[3]]])),
        ),
      ).toBe("42501");
      expect(await left()).toEqual([claims[3]]);
    }, KEYS));

  it("a row with an empty compartments is refused, for each table", () =>
    withDatabase(async (db) => {
      await session(db.urls.admin, async (query) => {
        const account = await seeder(db, query).sourceAccount();
        const empty = { code: "23514", constraint: "compartments_not_empty" };
        expect(
          await refusal(() =>
            ruling(query, {
              verdict: "reject",
              claim: fp(db, "e1"),
              factKey: fp(db, "ef1"),
              account,
              item: fp(db, "ei1"),
              compartments: [],
            }),
          ),
        ).toEqual(empty);
        expect(await refusal(() => declassified(db, query, fp(db, "e2"), []))).toEqual(empty);
        // The positive controls.
        expect(
          await refusal(() =>
            ruling(query, {
              verdict: "reject",
              claim: fp(db, "e1"),
              factKey: fp(db, "ef1"),
              account,
              item: fp(db, "ei1"),
            }),
          ),
        ).toBeNull();
        expect(await refusal(() => declassified(db, query, fp(db, "e2")))).toBeNull();
      });
    }, KEYS));
});
