import { describe, expect, it } from "vitest";
import { labelFixedColumnGrants } from "../test-support/catalogue-labels.ts";
import { insertClient, testId } from "../test-support/clients.ts";
import { one, type Query, readAs, refusal, session, sqlState } from "../test-support/connections.ts";
import { fingerprint, queryAs, type TestDatabase } from "../test-support/database.ts";
import { seeder } from "../test-support/seeder.ts";
import { withDatabase } from "../test-support/store.ts";

// Every refusal has its positive control in the same test. Made-up values only.

const TIMEOUT = 180_000;
const AT = "2026-09-01T00:00:00Z";
const THREE = ["knowledge.contacts", "knowledge.contact_addresses", "knowledge.identity_rulings"];

type Role = "pi_admin" | "pi_writer" | "pi_reader" | "pi_owner" | "pi_pipeline" | "pi_restricted";
type Command = "ALL" | "SELECT" | "INSERT" | "UPDATE" | "DELETE";
const POLICIES: Record<string, [Role, Command][]> = {
  "knowledge.contacts": [
    ["pi_admin", "ALL"],
    ["pi_writer", "ALL"],
    ["pi_reader", "SELECT"],
    ["pi_owner", "SELECT"],
  ],
  "knowledge.contact_addresses": [
    ["pi_admin", "ALL"],
    ["pi_writer", "ALL"],
    ["pi_reader", "SELECT"],
    ["pi_owner", "SELECT"],
    ["pi_pipeline", "SELECT"],
    ["pi_restricted", "SELECT"],
  ],
  "knowledge.identity_rulings": [
    ["pi_admin", "SELECT"],
    ["pi_admin", "INSERT"],
    ["pi_admin", "UPDATE"],
    ["pi_admin", "DELETE"],
    ["pi_writer", "SELECT"],
    ["pi_reader", "SELECT"],
    ["pi_owner", "SELECT"],
    ["pi_owner", "INSERT"],
    ["pi_owner", "UPDATE"],
    ["pi_pipeline", "SELECT"],
    ["pi_restricted", "SELECT"],
  ],
};
// Their update is a column grant of every column but the label (catalogue-labels.ts).
const TABLE_PRIVILEGES = [
  ...["knowledge.contact_addresses", "knowledge.contacts"].flatMap((table) =>
    ["pi_admin", "pi_writer"].flatMap((role) => ["DELETE", "INSERT", "SELECT"].map((p) => `${table} ${role} ${p}`)),
  ),
  "knowledge.contact_addresses pi_reader SELECT",
  "knowledge.contact_addresses pi_pipeline SELECT",
  "knowledge.contact_addresses pi_restricted SELECT",
  "knowledge.identity_rulings pi_admin DELETE",
  "knowledge.identity_rulings pi_admin INSERT",
  "knowledge.identity_rulings pi_admin SELECT",
  "knowledge.identity_rulings pi_writer SELECT",
  "knowledge.identity_rulings pi_pipeline SELECT",
  "knowledge.identity_rulings pi_restricted SELECT",
].sort();
// Column grants beyond the table grants.
const COLUMN_PRIVILEGES = [
  ...["compartments", "evidence_id", "account_id", "facts_enc", "id", "source_contact_fp", "updated_at"].map(
    (column) => `knowledge.contacts ${column} pi_reader SELECT`,
  ),
  ...["a_fp", "b_fp", "lifted_at", "verdict"].map((column) => `knowledge.identity_rulings ${column} pi_reader SELECT`),
  "knowledge.identity_rulings lift_ruling_id pi_admin UPDATE",
  "knowledge.identity_rulings lifted_at pi_admin UPDATE",
  "knowledge.identity_rulings lifted_by_deletion pi_admin UPDATE",
].sort();

const admin = <Row = Record<string, unknown>>(db: TestDatabase, text: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(db.urls.admin, text, values);
const fp = (db: TestDatabase, address: string): string => fingerprint(db.keys, "address", address);

// A person with one address under the compartments given, as pi_admin. Returns the entity id.
async function person(
  db: TestDatabase,
  query: Query,
  address: string,
  compartments: string[],
  entity?: string,
): Promise<string> {
  const id = entity ?? testId("ent");
  if (entity === undefined) await query("insert into knowledge.entities (id, kind) values ($1, 'person')", [id]);
  const account = testId("adr");
  await query(
    `insert into knowledge.accounts (id, entity_id, kind, value_fp, domain_fp, value_enc, compartments) values ($1, $2, 'email', $3, $4, '{}'::jsonb, $5)`,
    [account, id, fp(db, address), fingerprint(db.keys, "domain", address.split("@")[1] ?? ""), compartments],
  );
  return id;
}

// The one owner entity.
async function ownerEntity(query: Query): Promise<string> {
  await query(
    "insert into knowledge.entities (id, kind) values ($1, 'owner') on conflict (kind) where kind = 'owner' do nothing",
    [testId("ent")],
  );
  return one(await query<{ id: string }>("select id from knowledge.entities where kind = 'owner'")).id;
}

async function decision(query: Query, kind = "identity"): Promise<string> {
  const id = testId("rul");
  await query(
    `insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, labels, details, decided_at, compartments) values ($1, $2, $3, 0, '{}', '{}', $4, '{own}')`,
    [id, testId("req"), kind, AT],
  );
  return id;
}

// A ruling as pi_admin, its fingerprints in order.
async function ruling(db: TestDatabase, query: Query, verdict: string, a: string, b?: string): Promise<string> {
  const id = await decision(query);
  const [first, second] = b === undefined ? [fp(db, a), null] : [fp(db, a), fp(db, b)].sort();
  await query(
    "insert into knowledge.identity_rulings (ruling_id, verdict, a_fp, b_fp, created_at) values ($1, $2, $3, $4, $5)",
    [id, verdict, first, second, AT],
  );
  return id;
}

// A stored contact of one account and one of its addresses, as pi_admin.
// One seeder for each session, so two contacts of one test get two accounts.
const seeders = new WeakMap<Query, ReturnType<typeof seeder>>();
function seedOf(db: TestDatabase, query: Query): ReturnType<typeof seeder> {
  const known = seeders.get(query);
  if (known !== undefined) return known;
  const made = seeder(db, query);
  seeders.set(query, made);
  return made;
}

async function contact(
  db: TestDatabase,
  query: Query,
  compartments: string[],
  address: string,
  entity: string,
): Promise<string> {
  const seed = seedOf(db, query);
  const account = await seed.sourceAccount(compartments);
  const evidence = await seed.evidence(compartments, account);
  const id = testId("con");
  await query(
    `insert into knowledge.contacts (id, evidence_id, account_id, source_contact_fp, updated_at, address_fps, name_fps, facts_enc, compartments)
     values ($1, $2, $3, $4, $5, $6, $7, '{}'::jsonb, $8)`,
    [
      id,
      evidence,
      account,
      fingerprint(db.keys, "source_id", `contact:${id}`),
      AT,
      [fp(db, address)],
      [fingerprint(db.keys, "name", "maren holt")],
      compartments,
    ],
  );
  await query(
    "insert into knowledge.contact_addresses (contact_id, value_fp, entity_id, compartments) values ($1, $2, $3, $4)",
    [id, fp(db, address), entity, compartments],
  );
  return id;
}

async function veto(db: TestDatabase, query: Query, address: string): Promise<string> {
  const id = await decision(query, "veto");
  await query(
    "insert into knowledge.vetoes (ruling_id, subject, value_fps, created_at, compartments) values ($1, 'person', $2, $3, '{own}')",
    [id, [fp(db, address)], AT],
  );
  return id;
}

const roleExists = async (db: TestDatabase, role: string): Promise<boolean> =>
  one(await admin<{ found: boolean }>(db, "select exists (select 1 from pg_roles where rolname = $1) as found", [role]))
    .found;

describe("0013: the contacts and identity tables", { timeout: TIMEOUT }, () => {
  it("the three tables have exactly the expected policies and grants", () =>
    withDatabase(async (db) => {
      const policies = await admin<{ line: string; permissive: string }>(
        db,
        `select schemaname || '.' || tablename || ' ' || policyname || ' ' || array_to_string(roles::text[], ',') || ' ' || cmd as line, permissive
         from pg_policies where schemaname || '.' || tablename = any($1)`,
        [THREE],
      );
      const expected = THREE.flatMap((table) =>
        (POLICIES[table] ?? []).map(
          ([role, command]) => `${table} ${role}_${command.toLowerCase()} ${role} ${command}`,
        ),
      );
      expect(policies.map((row) => row.line).sort()).toEqual(expected.sort());
      expect(policies.every((row) => row.permissive === "PERMISSIVE")).toBe(true);

      const tables = await admin<{ name: string; enabled: boolean; forced: boolean; owner: string }>(
        db,
        `select n.nspname || '.' || c.relname as name, c.relrowsecurity as enabled, c.relforcerowsecurity as forced, pg_get_userbyid(c.relowner)::text as owner
         from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname || '.' || c.relname = any($1) order by 1`,
        [THREE],
      );
      expect(tables).toEqual(
        [...THREE].sort().map((name) => ({ name, enabled: true, forced: true, owner: "pi_owner" })),
      );

      const privileges = await admin<{ line: string; grantable: boolean }>(
        db,
        `select n.nspname || '.' || c.relname || ' ' || coalesce(g.rolname::text, 'PUBLIC') || ' ' || a.privilege_type as line, a.is_grantable as grantable
         from pg_class c join pg_namespace n on n.oid = c.relnamespace cross join lateral aclexplode(c.relacl) a left join pg_roles g on g.oid = a.grantee
         where n.nspname || '.' || c.relname = any($1) and a.grantee <> c.relowner`,
        [THREE],
      );
      expect(privileges.map((row) => row.line).sort()).toEqual(TABLE_PRIVILEGES);
      expect(privileges.filter((row) => row.grantable)).toEqual([]);

      const columns = await session(db.urls.bootstrap, async (query) => {
        await query("set role pi_owner");
        return query<{ line: string; whole: string }>(
          `select table_schema || '.' || table_name || ' ' || column_name || ' ' || grantee || ' ' || privilege_type as line,
             table_schema || '.' || table_name || ' ' || grantee || ' ' || privilege_type as whole
           from information_schema.column_privileges where table_schema || '.' || table_name = any($1) and grantee <> 'pi_owner'`,
          [THREE],
        );
      });
      const byTable = new Set(TABLE_PRIVILEGES);
      const labels = await session(db.urls.admin, (query) =>
        labelFixedColumnGrants(query, ["knowledge.contact_addresses", "knowledge.contacts"]),
      );
      expect(
        columns
          .filter((row) => !byTable.has(row.whole))
          .map((row) => row.line)
          .sort(),
      ).toEqual([...COLUMN_PRIVILEGES, ...labels].sort());
    }));

  it("pi_reader cannot select address_fps or name_fps, and selects the other columns under the row policy; pi_pipeline, pi_work and pi_proxy read neither table", () =>
    withDatabase(async (db) => {
      await session(db.urls.admin, async (query) => {
        await contact(
          db,
          query,
          ["own"],
          "maren@contacts-db.test",
          await person(db, query, "maren@contacts-db.test", ["own"]),
        );
        await contact(
          db,
          query,
          ["employer:example"],
          "devon@contacts-db.test",
          await person(db, query, "devon@contacts-db.test", ["employer:example"]),
        );
      });
      const own = await insertClient(db, "contacts-db-own", ["own"]);
      for (const column of ["address_fps", "name_fps"]) {
        expect(
          await sqlState(() => readAs(db, own.token, (query) => query(`select ${column} from knowledge.contacts`))),
          column,
        ).toBe("42501");
      }
      const seen = await readAs(db, own.token, (query) =>
        query<{ compartments: string[] }>(
          "select id, evidence_id, account_id, source_contact_fp, updated_at, facts_enc, compartments from knowledge.contacts",
        ),
      );
      expect(seen.map((row) => row.compartments)).toEqual([["own"]]);
      const addresses = await readAs(db, own.token, (query) =>
        query<{ compartments: string[] }>("select compartments from knowledge.contact_addresses"),
      );
      expect(addresses.map((row) => row.compartments)).toEqual([["own"]]);
      // The positive control: the admin reads both columns of both rows.
      expect((await admin(db, "select address_fps, name_fps from knowledge.contacts")).length).toBe(2);

      // The pipeline reads the identity rulings (fingerprints and verdicts) for the warmth build's
      // groups, and the contact addresses for triage's known correspondent line; never
      // knowledge.contacts.
      for (const role of ["pi_pipeline", "pi_work", "pi_proxy"]) {
        if (!(await roleExists(db, role))) continue;
        const tables = role === "pi_pipeline" ? ["knowledge.contacts"] : THREE;
        const held = await admin<{ table: string }>(
          db,
          `select t.name as table from unnest($2::text[]) as t (name)
           where has_table_privilege($1, t.name, 'SELECT') or has_table_privilege($1, t.name, 'INSERT')
              or has_table_privilege($1, t.name, 'UPDATE') or has_table_privilege($1, t.name, 'DELETE')
              or has_any_column_privilege($1, t.name, 'SELECT')`,
          [role, tables],
        );
        expect(held, role).toEqual([]);
      }
      expect(await sqlState(() => queryAs(db.urls.pipeline, "select count(*) from knowledge.contacts"))).toBe("42501");
    }));

  it("0056: pi_owner reads knowledge.contacts and knowledge.contact_addresses through one select policy each, and writes neither", () =>
    withDatabase(async (db) => {
      const policies = await admin<{ line: string }>(
        db,
        "select tablename || ' ' || cmd as line from pg_policies where 'pi_owner' = any(roles) and tablename in ('contacts', 'contact_addresses') and schemaname = 'knowledge' order by 1",
      );
      expect(policies.map((row) => row.line)).toEqual(["contact_addresses SELECT", "contacts SELECT"]);
      // pi_owner owns the tables, so its privilege is the owner's; under forced row-level
      // security its select policy alone lets it read.
      await session(db.urls.admin, async (query) => {
        await contact(
          db,
          query,
          ["own"],
          "maren@contacts-db.test",
          await person(db, query, "maren@contacts-db.test", ["own"]),
        );
      });
      const seen = await session(db.urls.bootstrap, async (query) => {
        await query("set role pi_owner");
        return query<{ count: string }>(
          "select (select count(*) from knowledge.contacts) + (select count(*) from knowledge.contact_addresses) as count",
        );
      });
      expect(one(seen).count).toBe("2");
      expect(one(await admin<{ count: string }>(db, "select count(*) from knowledge.contacts")).count).toBe("1");
    }));

  it("only the admin writes a ruling", () =>
    withDatabase(async (db) => {
      const id = await session(db.urls.admin, (query) => decision(query));
      const [a, b] = [fp(db, "a@contacts-db.test"), fp(db, "b@contacts-db.test")].sort();
      const insert = `insert into knowledge.identity_rulings (ruling_id, verdict, a_fp, b_fp, created_at) values ('${id}', 'same', '${a}', '${b}', '${AT}')`;
      const client = await insertClient(db, "contacts-db-writer-probe", ["own"]);
      expect(await sqlState(() => queryAs(db.urls.writer, insert)), "pi_writer").toBe("42501");
      expect(await sqlState(() => readAs(db, client.token, (query) => query(insert))), "pi_reader").toBe("42501");
      expect(await sqlState(() => queryAs(db.urls.pipeline, insert)), "pi_pipeline").toBe("42501");
      for (const role of ["pi_writer", "pi_reader", "pi_pipeline", "pi_work", "pi_proxy"]) {
        if (!(await roleExists(db, role))) continue;
        for (const privilege of ["INSERT", "UPDATE", "DELETE"]) {
          const [row] = await admin<{ held: boolean }>(
            db,
            "select has_table_privilege($1, 'knowledge.identity_rulings', $2) or (case when $2 = 'DELETE' then false else has_any_column_privilege($1, 'knowledge.identity_rulings', $2) end) as held",
            [role, privilege],
          );
          expect(row?.held, `${role} ${privilege}`).toBe(false);
        }
      }
      // The positive control.
      expect(await sqlState(() => admin(db, insert))).toBeNull();
      for (const sql of [
        "update knowledge.identity_rulings set lifted_at = now()",
        "delete from knowledge.identity_rulings",
      ]) {
        expect(await sqlState(() => queryAs(db.urls.writer, sql)), `pi_writer: ${sql}`).toBe("42501");
      }
      expect(
        one(await queryAs<{ count: string }>(db.urls.writer, "select count(*) from knowledge.identity_rulings")).count,
      ).toBe("1");
    }));

  it("the admin cannot update a ruling's verdict or fingerprints", () =>
    withDatabase(async (db) => {
      const id = await session(db.urls.admin, (query) =>
        ruling(db, query, "same", "a@contacts-db.test", "b@contacts-db.test"),
      );
      for (const column of ["verdict", "a_fp", "b_fp", "created_at", "ruling_id"]) {
        expect(
          await sqlState(() => admin(db, `update knowledge.identity_rulings set ${column} = ${column}`)),
          column,
        ).toBe("42501");
      }
      const lift = await session(db.urls.admin, (query) => decision(query, "identity_lift"));
      expect(
        await sqlState(() =>
          admin(db, "update knowledge.identity_rulings set lifted_at = $2, lift_ruling_id = $3 where ruling_id = $1", [
            id,
            AT,
            lift,
          ]),
        ),
      ).toBeNull();
    }));

  it("a same ruling with one fingerprint, and one with its fingerprints out of order, are refused", () =>
    withDatabase(async (db) => {
      const [low, high] = [fp(db, "a@contacts-db.test"), fp(db, "b@contacts-db.test")].sort();
      const insert = async (verdict: string, a: string, b: string | null) =>
        refusal(async () =>
          admin(
            db,
            "insert into knowledge.identity_rulings (ruling_id, verdict, a_fp, b_fp, created_at) values ($1, $2, $3, $4, $5)",
            [await session(db.urls.admin, (query) => decision(query)), verdict, a, b, AT],
          ),
        );
      expect(await insert("same", low ?? "", null)).toEqual({ code: "23514", constraint: "identity_rulings_sides" });
      expect(await insert("same", high ?? "", low ?? "")).toEqual({
        code: "23514",
        constraint: "identity_rulings_sides",
      });
      expect(await insert("shared", low ?? "", high ?? "")).toEqual({
        code: "23514",
        constraint: "identity_rulings_sides",
      });
      expect((await insert("merge", low ?? "", high ?? ""))?.code).toBe("23514");
      expect(await insert("same", low ?? "", high ?? "")).toBeNull();
      expect(await insert("shared", low ?? "", null)).toBeNull();
      // One live ruling for a pair, and one live mark for an address, as the admin already
      // refuses a second (already_settled, conflicting_ruling): the reader orders its rulings by
      // the pair, a key of the live rows.
      expect(await insert("different", low ?? "", high ?? "")).toEqual({
        code: "23505",
        constraint: "identity_rulings_live",
      });
      expect(await insert("single", low ?? "", null)).toEqual({ code: "23505", constraint: "identity_rulings_live" });
      // The positive control: once the live ruling is lifted, the pair takes a new one.
      await admin(
        db,
        "update knowledge.identity_rulings set lifted_at = $2, lift_ruling_id = $3 where a_fp = $1 and b_fp is not null",
        [low, AT, await session(db.urls.admin, (query) => decision(query))],
      );
      expect(await insert("different", low ?? "", high ?? "")).toBeNull();
    }));

  it("the reader reads a same ruling only when both addresses have a person's account row within its clearance", () =>
    withDatabase(async (db) => {
      const ids = await session(db.urls.admin, async (query) => {
        await person(db, query, "a@contacts-db.test", ["own"]);
        await person(db, query, "b@contacts-db.test", ["own"]);
        await person(db, query, "c@contacts-db.test", ["employer:example"]);
        const owner = await ownerEntity(query);
        await person(db, query, "owner@contacts-db.test", ["own"], owner);
        const both = await ruling(db, query, "same", "a@contacts-db.test", "b@contacts-db.test");
        const hidden = await ruling(db, query, "same", "a@contacts-db.test", "c@contacts-db.test");
        const lifted = await ruling(db, query, "same", "b@contacts-db.test", "c@contacts-db.test");
        await query("update knowledge.identity_rulings set lifted_at = $2, lift_ruling_id = $3 where ruling_id = $1", [
          lifted,
          AT,
          await decision(query, "identity_lift"),
        ]);
        // On the pair whose same ruling was lifted: a pair has one live ruling (identity_rulings_live).
        const different = await ruling(db, query, "different", "b@contacts-db.test", "c@contacts-db.test");
        const ownerSide = await ruling(db, query, "same", "a@contacts-db.test", "owner@contacts-db.test");
        const shared = await ruling(db, query, "shared", "b@contacts-db.test");
        return { both, hidden, lifted, different, ownerSide, shared };
      });
      const read = async (compartments: string[]) => {
        const client = await insertClient(db, `contacts-db-${compartments.join("-").replace(":", "-")}`, compartments);
        return readAs(db, client.token, (query) =>
          query<{ verdict: string; a_fp: string; b_fp: string | null }>(
            "select verdict, a_fp, b_fp from knowledge.identity_rulings",
          ),
        );
      };
      const pair = (a: string, b: string) => [fp(db, a), fp(db, b)].sort().join(" ");
      const lines = (rows: { verdict: string; a_fp: string; b_fp: string | null }[]) =>
        rows.map((row) => `${row.verdict} ${row.a_fp}${row.b_fp === null ? "" : ` ${row.b_fp}`}`).sort();
      expect(lines(await read(["own"]))).toEqual(
        [`same ${pair("a@contacts-db.test", "b@contacts-db.test")}`, `shared ${fp(db, "b@contacts-db.test")}`].sort(),
      );
      expect(lines(await read(["employer:example", "own"]))).toEqual(
        [
          `same ${pair("a@contacts-db.test", "b@contacts-db.test")}`,
          `same ${pair("a@contacts-db.test", "c@contacts-db.test")}`,
          `shared ${fp(db, "b@contacts-db.test")}`,
        ].sort(),
      );
      // The positive control: the admin reads all six.
      expect((await admin(db, "select 1 from knowledge.identity_rulings")).length).toBe(Object.keys(ids).length);
    }));

  it("the reader cannot read when a ruling was made or its ruling id", () =>
    withDatabase(async (db) => {
      await session(db.urls.admin, async (query) => {
        await person(db, query, "a@contacts-db.test", ["own"]);
        await person(db, query, "b@contacts-db.test", ["own"]);
        await ruling(db, query, "same", "a@contacts-db.test", "b@contacts-db.test");
      });
      const client = await insertClient(db, "contacts-db-columns", ["own"]);
      for (const column of ["created_at", "ruling_id", "lift_ruling_id"]) {
        expect(
          await sqlState(() =>
            readAs(db, client.token, (query) => query(`select ${column} from knowledge.identity_rulings`)),
          ),
          column,
        ).toBe("42501");
      }
      expect(
        (
          await readAs(db, client.token, (query) =>
            query("select verdict, a_fp, b_fp, lifted_at from knowledge.identity_rulings"),
          )
        ).length,
      ).toBe(1);
    }));

  it("vetoed_by and vetoed agree for a group member, asked by a person ref and by an address ref, and both stop after the ruling is lifted", () =>
    withDatabase(async (db) => {
      const { a, c, vetoId, joins } = await session(db.urls.admin, async (query) => {
        const a = await person(db, query, "a@contacts-db.test", ["own"]);
        await person(db, query, "b@contacts-db.test", ["own"]);
        const c = await person(db, query, "c@contacts-db.test", ["own"]);
        const vetoId = await veto(db, query, "a@contacts-db.test");
        // Through a third person: a to b, b to c.
        const joins = [
          await ruling(db, query, "same", "a@contacts-db.test", "b@contacts-db.test"),
          await ruling(db, query, "same", "b@contacts-db.test", "c@contacts-db.test"),
        ];
        return { a, c, vetoId, joins };
      });
      const ask = async (kind: string, id: string) =>
        one(
          await admin<{ by: string | null; vetoed: boolean }>(
            db,
            "select policy.vetoed_by(array[$1], array[$2], null) as by, policy.vetoed(array[$1], array[$2], null) as vetoed",
            [kind, id],
          ),
        );
      expect(await ask("entity", c)).toEqual({ by: vetoId, vetoed: true });
      expect(await ask("address", fp(db, "c@contacts-db.test"))).toEqual({ by: vetoId, vetoed: true });
      expect(await ask("entity", a)).toEqual({ by: vetoId, vetoed: true });
      // A different ruling joins nobody.
      await session(db.urls.admin, (query) =>
        ruling(db, query, "different", "a@contacts-db.test", "d@contacts-db.test"),
      );
      expect(await ask("address", fp(db, "d@contacts-db.test"))).toEqual({ by: null, vetoed: false });
      // After a lift of the middle link, c is apart again.
      await session(db.urls.admin, async (query) =>
        query("update knowledge.identity_rulings set lifted_at = $2, lift_ruling_id = $3 where ruling_id = $1", [
          joins[1],
          AT,
          await decision(query, "identity_lift"),
        ]),
      );
      expect(await ask("entity", c)).toEqual({ by: null, vetoed: false });
      expect(await ask("address", fp(db, "c@contacts-db.test"))).toEqual({ by: null, vetoed: false });
      expect(await ask("address", fp(db, "b@contacts-db.test"))).toEqual({ by: vetoId, vetoed: true });
    }));

  it("a ruling that names an owner address joins nothing for a veto", () =>
    withDatabase(async (db) => {
      const { c } = await session(db.urls.admin, async (query) => {
        await person(db, query, "owner@contacts-db.test", ["own"], await ownerEntity(query));
        await person(db, query, "a@contacts-db.test", ["own"]);
        const c = await person(db, query, "c@contacts-db.test", ["own"]);
        await veto(db, query, "a@contacts-db.test");
        await ruling(db, query, "same", "a@contacts-db.test", "owner@contacts-db.test");
        await ruling(db, query, "same", "owner@contacts-db.test", "c@contacts-db.test");
        return { c };
      });
      expect(
        one(
          await admin<{ vetoed: boolean }>(db, "select policy.vetoed(array['entity'], array[$1], null) as vetoed", [c]),
        ).vetoed,
      ).toBe(false);
      expect(
        one(
          await admin<{ vetoed: boolean }>(db, "select policy.vetoed(array['address'], array[$1], null) as vetoed", [
            fp(db, "a@contacts-db.test"),
          ]),
        ).vetoed,
      ).toBe(true);
    }));

  it("vetoed_by keeps its owner, search path, security and grants", () =>
    withDatabase(async (db) => {
      const fn = one(
        await admin<{ definer: boolean; volatility: string; owner: string; config: string[]; public: boolean }>(
          db,
          `select p.prosecdef as definer, p.provolatile as volatility, pg_get_userbyid(p.proowner)::text as owner, p.proconfig as config,
             exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0) as public
           from pg_proc p where p.oid = 'policy.vetoed_by(text[], text[], text)'::regprocedure`,
        ),
      );
      expect(fn).toEqual({
        definer: true,
        volatility: "s",
        owner: "pi_owner",
        config: ["search_path=pg_catalog, policy, pg_temp"],
        public: false,
      });
    }));

  it("ledger.contact_candidates (0056) is a definer function owned by pi_owner that only pi_reader and pi_proxy execute, and pi_writer gains no right in the ledger beyond other migrations'", () =>
    withDatabase(async (db) => {
      const fn = one(
        await admin<{
          definer: boolean;
          owner: string;
          public: boolean;
          reader: boolean;
          proxy: boolean;
          writer: boolean;
          admin: boolean;
        }>(
          db,
          `select p.prosecdef as definer, pg_get_userbyid(p.proowner)::text as owner,
             exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0) as public,
             has_function_privilege('pi_reader', p.oid, 'EXECUTE') as reader, has_function_privilege('pi_proxy', p.oid, 'EXECUTE') as proxy,
             has_function_privilege('pi_writer', p.oid, 'EXECUTE') as writer, has_function_privilege('pi_admin', p.oid, 'EXECUTE') as admin
           from pg_proc p where p.oid = 'ledger.contact_candidates(text)'::regprocedure`,
        ),
      );
      expect(fn).toEqual({
        definer: true,
        owner: "pi_owner",
        public: false,
        reader: true,
        proxy: true,
        writer: false,
        admin: false,
      });
      const held = await admin<{ line: string }>(
        db,
        `select n.nspname || '.' || c.relname || ' ' || p.privilege as line from pg_class c join pg_namespace n on n.oid = c.relnamespace
         cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) as p (privilege)
         where n.nspname = 'ledger' and c.relkind = 'r'
           and (has_table_privilege('pi_writer', c.oid, p.privilege) or (case when p.privilege = 'DELETE' then false else has_any_column_privilege('pi_writer', c.oid, p.privilege) end))
         order by 1`,
      );
      expect(held.map((row) => row.line)).toEqual([
        "ledger.agent_writes SELECT",
        "ledger.agent_writes UPDATE",
        "ledger.capture_inbox DELETE",
        "ledger.capture_inbox SELECT",
        "ledger.capture_inbox UPDATE",
        "ledger.cards INSERT",
        "ledger.cards SELECT",
        "ledger.identity_answers SELECT",
        "ledger.identity_answers UPDATE",
        "ledger.identity_questions INSERT",
        "ledger.identity_questions SELECT",
        "ledger.identity_questions UPDATE",
        "ledger.job_runs INSERT",
        "ledger.memory_imports SELECT",
        "ledger.memory_imports UPDATE",
        "ledger.memory_projections SELECT",
        "ledger.question_rules SELECT",
        "ledger.read_log SELECT",
        "ledger.record_events INSERT",
        "ledger.record_events SELECT",
        "ledger.wrong_merge_reports SELECT",
      ]);
    }));

  it("a source account takes google_contacts only with crm, and agent only with agent_record", () =>
    withDatabase(async (db) => {
      const insert = (connector: string, kind: string) =>
        refusal(() =>
          admin(
            db,
            `insert into vault.source_accounts (id, label, connector, source_kind, compartments, address_fp, address_enc)
             values ($1, $2, $3, $4, '{own}', $5, $6)`,
            connector === "agent"
              ? [testId("acc"), `l-${testId("x").slice(-6).toLowerCase()}`, connector, kind, null, null]
              : [
                  testId("acc"),
                  `l-${testId("x").slice(-6).toLowerCase()}`,
                  connector,
                  kind,
                  fp(db, "o@contacts-db.test"),
                  "{}",
                ],
          ),
        );
      expect(await insert("google_contacts", "email")).toEqual({
        code: "23514",
        constraint: "source_accounts_kind_of_connector",
      });
      expect(await insert("agent", "crm")).toEqual({ code: "23514", constraint: "source_accounts_kind_of_connector" });
      expect(await insert("google_drive", "crm")).toEqual({
        code: "23514",
        constraint: "source_accounts_connector_check",
      });
      expect(await insert("google_contacts", "crm")).toBeNull();
      expect(await insert("agent", "agent_record")).toBeNull();
      expect(await insert("google_mail", "email")).toBeNull();
    }));

  it("every new table but identity_rulings refuses an empty compartments", () =>
    withDatabase(async (db) => {
      const { entity, contactId, spare } = await session(db.urls.admin, async (query) => {
        const entity = await person(db, query, "maren@contacts-db.test", ["own"]);
        const contactId = await contact(db, query, ["own"], "maren@contacts-db.test", entity);
        const seed = seedOf(db, query);
        const account = await seed.sourceAccount(["own"]);
        return {
          entity,
          contactId,
          spare: { account, evidence: [await seed.evidence(["own"], account), await seed.evidence(["own"], account)] },
        };
      });
      const inserts: Record<string, (compartments: string[]) => Promise<unknown>> = {
        "knowledge.contacts": async (compartments) => {
          const evidence = spare.evidence.shift();
          return admin(
            db,
            `insert into knowledge.contacts (id, evidence_id, account_id, source_contact_fp, updated_at, address_fps, name_fps, facts_enc, compartments)
             values ($1, $2, $3, $4, $5, '{}', '{}', '{}'::jsonb, $6)`,
            [
              testId("con"),
              evidence,
              spare.account,
              fingerprint(db.keys, "source_id", testId("item")),
              AT,
              compartments,
            ],
          );
        },
        "knowledge.contact_addresses": (compartments) =>
          admin(
            db,
            "insert into knowledge.contact_addresses (contact_id, value_fp, entity_id, compartments) values ($1, $2, $3, $4)",
            [contactId, fp(db, `${testId("x").toLowerCase()}@contacts-db.test`), entity, compartments],
          ),
      };
      for (const [table, insert] of Object.entries(inserts)) {
        expect(await refusal(() => insert([])), table).toEqual({ code: "23514", constraint: "compartments_not_empty" });
        expect(await refusal(() => insert(["own"])), `control: ${table}`).toBeNull();
      }
      const columns = await admin<{ column_name: string }>(
        db,
        "select column_name from information_schema.columns where table_schema = 'knowledge' and table_name = 'identity_rulings'",
      );
      expect(columns.map((row) => row.column_name)).not.toContain("compartments");
    }));
});
