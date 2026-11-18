import type { SourceDeletion } from "@intelligence/contracts";
import { describe, expect, it } from "vitest";
import { type Accounts, CANARIES, connect } from "../test-support/cast.ts";
import { RESTRICTED_TABLE_GRANTS, RESTRICTED_TABLES } from "../test-support/catalogue.ts";
import { SCHEMAS } from "../test-support/catalogue-grants.ts";
import { labelFixed } from "../test-support/catalogue-labels.ts";
import { insertClient, testId } from "../test-support/clients.ts";
import { asTablesOwner, one, type Query, readAs, refusal, session, sqlState } from "../test-support/connections.ts";
import { queryAs, type TestDatabase } from "../test-support/database.ts";
import { mailFacts, mailRevision, mailSourceId } from "../test-support/items.ts";
import { MAIL } from "../test-support/items-named.ts";
import { seedExtraction, stored } from "../test-support/pipeline-fixtures.ts";
import { withStore } from "../test-support/store.ts";
import type { Writer } from "../write/writer.ts";

// The restricted migration, through SQL connections as each role. Every refusal has its positive
// control in the same test. The rows are hand-written; their sealed columns hold an empty object,
// since no key is opened here.

const TIMEOUT = 240_000;
const RESTRICTED = ["own", "restricted:health"];

type World = { db: TestDatabase; writer: Writer; accounts: Accounts; item: string; other: string };

// A database with the restricted file holding health's and money's keys, the four accounts, and
// two stored messages under `own`: `item` and `other`.
const withWorld = <T>(fn: (world: World) => Promise<T>): Promise<T> =>
  withStore(
    async ({ db, writer }) => {
      const accounts = await connect(writer);
      const item = await stored(writer, accounts.personalMail, MAIL.canary);
      const other = await stored(writer, accounts.personalMail, MAIL.fromQuentin);
      return fn({ db, writer, accounts, item, other });
    },
    { restricted: ["health", "money"] },
  );

const admin = <Row = Record<string, unknown>>(db: TestDatabase, text: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(db.urls.admin, text, values);
const stateAs = (url: string, text: string, values?: unknown[]): Promise<string | null> =>
  sqlState(() => queryAs(url, text, values));

// An item's label made `label`, as the relabel will make it, on the evidence row and its message, as
// the tables' owner: no runtime role updates a label.
async function labelItem(db: TestDatabase, evidenceId: string, label: string[]): Promise<void> {
  await asTablesOwner(db, ["vault.evidence_items", "knowledge.messages"], async (query) => {
    await query("update vault.evidence_items set compartments = $2 where id = $1", [evidenceId, label]);
    await query("update knowledge.messages set compartments = $2 where evidence_id = $1", [evidenceId, label]);
  });
}

const turnOn = (db: TestDatabase, category: string): Promise<unknown> =>
  admin(db, "insert into policy.restricted_categories (category) values ($1)", [category]);

const readersOf = async (db: TestDatabase, evidenceId: string): Promise<string[]> =>
  one(await admin<{ readers: string[] }>(db, "select readers from vault.evidence_items where id = $1", [evidenceId]))
    .readers;

// One claim of an item, inserted as the role in `url` under `label`.
const CLAIM = `insert into knowledge.claims (id, evidence_id, type, valid_from, fact_key_fp, extractor_generation, readers, content_enc, compartments)
  values ($1, $2, 'commitment', now(), $3, 1, $4, '{}'::jsonb, $5)`;
const claimAs = async (
  db: TestDatabase,
  url: string,
  id: string,
  evidenceId: string,
  label: string[],
): Promise<string | null> =>
  stateAs(url, CLAIM, [id, evidenceId, `fact-${id}`, await readersOf(db, evidenceId), label]);

// One status row, inserted as the role in `url`.
const STATUS = `insert into vault.pipeline_items (evidence_id, waiting, withheld, screened, extractor_generation, updated_at, facts_enc, compartments)
  values ($1, false, false, false, 1, now(), '{}'::jsonb, $2)`;

// The tables with a label, from the catalogue.
const labelledTables = async (db: TestDatabase): Promise<string[]> =>
  (
    await admin<{ name: string }>(
      db,
      "select table_schema || '.' || table_name as name from information_schema.columns where column_name = 'compartments' and table_schema = any($1) order by 1",
      [SCHEMAS],
    )
  ).map((row) => row.name);

// Every right a role holds by name: on schemas, tables, columns and functions.
const RIGHTS = `
  select 'schema ' || n.nspname || ' ' || a.privilege_type as line from pg_namespace n, aclexplode(n.nspacl) a where a.grantee = $1::regrole
  union all
  select 'table ' || c.oid::regclass::text || ' ' || a.privilege_type from pg_class c, aclexplode(c.relacl) a where a.grantee = $1::regrole
  union all
  select 'column ' || t.attrelid::regclass::text || '.' || t.attname || ' ' || a.privilege_type
  from pg_attribute t, aclexplode(t.attacl) a where a.grantee = $1::regrole and not t.attisdropped
  union all
  select 'function ' || p.oid::regprocedure::text || ' ' || a.privilege_type from pg_proc p, aclexplode(p.proacl) a where a.grantee = $1::regrole`;
const rightsOf = async (db: TestDatabase, role: string): Promise<string[]> =>
  (await admin<{ line: string }>(db, RIGHTS, [role])).map((row) => row.line).sort();

// Rights that are pi_pipeline's alone, each because the restricted worker never does that work. The cards'
// match key, the settlements and policy.fact_answer, since the restricted worker raises no agent card. Its
// policy on ledger.cards is the update of match_fp alone. The reopens, the close columns of agent_writes,
// the standing release and the label check's close branch (database.db.test.ts: "no restricted copy"),
// since no close is restricted: no client's clearance holds a restricted compartment, so no agent record's
// label does. The standing release's policy.grant_release, policy.granted_releases and policy.fact_ruled,
// since they serve an agent record's commit and its cards, and no agent record is restricted. The shadow
// sampler, with its read of the read log, its passes and the reader's statements under a clearance: the
// restricted worker makes no pass, so restricted audiences are not shadowed. And the trigger diff's
// rechecks and log, since there is no restricted pass. The recall audit's table, since its sampler leaves
// restricted rows out; and ledger.card_rule_stop's own grant, since a rule reaches a card through the
// definer ledger.stop_card_by_rule. And agents' anchors and time rulings, read by the daily time pass
// alone, which the restricted worker does not run. The dream pass's goal subjects and same-person pairs,
// which leave restricted rows out: the restricted worker runs no dream pass, and the pass skips every
// restricted row (dream-store.ts). The pseudonymiser's names, which leave restricted rows out: no
// restricted run calls a model. The warmth lanes' gap pass, whose flags and candidates are under no
// restricted label: the restricted worker raises and closes no gap flag.
const PIPELINE_ONLY =
  /ledger\.(gap_flag_rows|gap_supply_rows|gap_raised_by_trigger|gap_explored_rows|task_standing|close_gap_flag|raise_gap_flag|expect_gap_flag|opportunity_facts|explore_gaps|close_no_tie_gaps|close_no_role_gaps)\(|policy\.known_identities\(|ledger\.dream_goal_subjects\(|ledger\.dream_identity_pairs\(|ledger\.recall_checks\b|ledger\.card_rule_stop\b|ledger\.trigger_rechecks\b|ledger\.trigger_log\b|ledger\.read_log\b|ledger\.belief_shadow\b|policy\.belief_inputs_under\b|projections\.fact_groupings|knowledge\.same_fact_judgments\b|policy\.owner_settings\.grouping |policy\.released_records|^ledger\.cards UPDATE$|ledger\.cards\.match_fp UPDATE$|ledger\.fact_settlements\b|policy\.fact_answer\(|ledger\.commitment_reopens\b|ledger\.agent_writes\.(kind|close_fact_fp) SELECT$|policy\.agent_closes_on\(|policy\.close_claim_allowed\(|policy\.grant_release\(|policy\.granted_releases\(|policy\.fact_ruled\(|knowledge\.time_rulings\b|knowledge\.agent_anchors\b|knowledge\.agent_time_rulings\b|policy\.time_exceptions\b|ledger\.job_runs\b|knowledge\.suppressions\b/;

describe("restricted-compartments's database", { timeout: TIMEOUT }, () => {
  it("the new tables have row-level security forced, are pi_owner's, and hold exactly the policies and privileges of the grants table", () =>
    withWorld(async ({ db }) => {
      const tables = await admin<{ name: string; enabled: boolean; forced: boolean; owner: string }>(
        db,
        `select n.nspname || '.' || c.relname as name, c.relrowsecurity as enabled, c.relforcerowsecurity as forced, pg_get_userbyid(c.relowner)::text as owner
         from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname || '.' || c.relname = any($1) order by 1`,
        [RESTRICTED_TABLES],
      );
      expect(tables).toEqual(
        [...RESTRICTED_TABLES].sort().map((name) => ({ name, enabled: true, forced: true, owner: "pi_owner" })),
      );

      // Each cell one policy, and pi_restricted's copy of each of pi_pipeline's.
      const expected = RESTRICTED_TABLES.flatMap((table) => {
        const cells = RESTRICTED_TABLE_GRANTS[table] ?? {};
        const roles = Object.entries(cells).flatMap(([role, list]) =>
          (list ?? []).map((cell) => [role, cell] as const),
        );
        const copies = (cells.pi_pipeline ?? []).map((cell) => ["pi_restricted", cell] as const);
        return [...roles, ...copies].map(([role, cell]) => `${table} ${role}_${cell} ${role}`);
      });
      const policies = await admin<{ line: string }>(
        db,
        "select schemaname || '.' || tablename || ' ' || policyname || ' ' || array_to_string(roles, ',') as line from pg_policies where schemaname || '.' || tablename = any($1)",
        [RESTRICTED_TABLES],
      );
      expect(policies.map((row) => row.line).sort()).toEqual(expected.sort());

      // The table privileges by name, besides the owner's own, with no grant option and nothing for PUBLIC.
      const privileges = await admin<{ line: string; grantable: boolean }>(
        db,
        `select n.nspname || '.' || c.relname || ' ' || coalesce(g.rolname::text, 'PUBLIC') || ' ' || a.privilege_type as line, a.is_grantable as grantable
         from pg_class c join pg_namespace n on n.oid = c.relnamespace cross join lateral aclexplode(c.relacl) a left join pg_roles g on g.oid = a.grantee
         where n.nspname || '.' || c.relname = any($1) and a.grantee <> c.relowner`,
        [RESTRICTED_TABLES],
      );
      const PRIVILEGES = {
        all: ["SELECT", "INSERT", "UPDATE", "DELETE"],
        select: ["SELECT"],
        insert: ["INSERT"],
        update: ["UPDATE"],
        delete: ["DELETE"],
      } as const;
      const want = RESTRICTED_TABLES.flatMap((table) => {
        const cells = {
          ...(RESTRICTED_TABLE_GRANTS[table] ?? {}),
          pi_restricted: RESTRICTED_TABLE_GRANTS[table]?.pi_pipeline ?? [],
        };
        return Object.entries(cells).flatMap(([role, list]) =>
          role === "pi_owner"
            ? []
            : (list ?? [])
                // The writer's update of a request, and a worker's of a screen, are column grants.
                .filter(
                  (cell) =>
                    !(
                      cell === "update" &&
                      ((table === "vault.restriction_requests" && role === "pi_writer") ||
                        table === "vault.restrict_screens")
                    ),
                )
                .flatMap((cell) => PRIVILEGES[cell].map((privilege) => `${table} ${role} ${privilege}`))
                // And an update held column by column, its label columns left out.
                .filter((line) => !(line.endsWith(" UPDATE") && labelFixed(table, role))),
        );
      });
      expect(privileges.map((row) => row.line).sort()).toEqual(want.sort());
      expect(privileges.filter((row) => row.grantable)).toEqual([]);
      expect(await rightsOf(db, "pi_writer")).toContain("column vault.restriction_requests.applied_at UPDATE");
    }));

  it("pi_pipeline sees no row labelled restricted:health in any table that has compartments, and pi_admin sees it", () =>
    withWorld(async ({ db, item }) => {
      await seedExtraction(db, item, { address: CANARIES.address, text: CANARIES.bodyText, subject: CANARIES.subject });
      const tables = await labelledTables(db);
      const readable = async (table: string): Promise<boolean> =>
        one(
          await admin<{ ok: boolean }>(
            db,
            "select has_table_privilege('pi_pipeline', $1, 'SELECT') or has_any_column_privilege('pi_pipeline', $1, 'SELECT') as ok",
            [table],
          ),
        ).ok;
      const pipelineCount = async (table: string): Promise<number> =>
        one(await queryAs<{ n: number }>(db.urls.pipeline, `select count(*)::int as n from ${table}`)).n;

      // The control: before, pi_pipeline sees the rows of the item and its extraction.
      const core = [
        "vault.evidence_items",
        "knowledge.messages",
        "vault.pipeline_items",
        "knowledge.claims",
        "vault.model_calls",
      ];
      for (const table of core) expect(await pipelineCount(table), table).toBeGreaterThan(0);

      // Every row of every labelled table pi_admin may update, and the claims, given
      // restricted:health, in one transaction as the owner role under a policy that lives only in
      // it: the evidence first, then what its triggers check against it. An account's compartment
      // is never restricted (compartments_single), so its row is left.
      const order = (table: string): number =>
        ["vault.evidence_items", "knowledge.claims", "knowledge.claim_entities"].indexOf(table);
      const relabelled = tables
        .filter((table) => table !== "vault.source_accounts")
        .sort((a, b) => (order(a) === -1 ? 99 : order(a)) - (order(b) === -1 ? 99 : order(b)));
      let values = 0;
      await session(db.urls.bootstrap, async (query: Query) => {
        await query("begin");
        await query("set local role pi_owner");
        const based = (
          await query<{ name: string }>(
            "select n.nspname || '.' || c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('r', 'p') and n.nspname || '.' || c.relname = any($1)",
            [relabelled],
          )
        ).map((row) => row.name);
        for (const table of based)
          await query(`create policy zz_test_relabel on ${table} for all to pi_owner using (true) with check (true)`);
        for (const table of relabelled) {
          // A claim's value rows are insert-only and carry its label (claim_values_label). The relabel
          // removes the item's claims, which takes their value rows, and derives them again under the new
          // label, so here they are deleted and inserted again under their claim's new label.
          if (table === "knowledge.claim_values") {
            const rows = await query<{ claim_id: string; claim_key: string; value_fp: string }>(
              "select claim_id, claim_key, value_fp from knowledge.claim_values order by claim_id, claim_key",
            );
            values = rows.length;
            await query("delete from knowledge.claim_values");
            for (const value of rows) {
              await query(
                "insert into knowledge.claim_values (claim_id, claim_key, value_fp, compartments) select $1, $2, $3, c.compartments from knowledge.claims c where c.id = $1",
                [value.claim_id, value.claim_key, value.value_fp],
              );
            }
            continue;
          }
          const updatable =
            table === "knowledge.claims" ||
            table === "knowledge.claim_entities" ||
            // pi_admin may update every column of it but its label columns, which no runtime role updates.
            one(
              await query<{ ok: boolean }>(
                `select not exists (select 1 from pg_attribute a where a.attrelid = $1::regclass and a.attnum > 0 and not a.attisdropped
                   and a.attname <> all ('{compartments,readers,audience,bound}') and not has_column_privilege('pi_admin', a.attrelid, a.attnum, 'UPDATE')) as ok`,
                [table],
              ),
            ).ok;
          if (!updatable) continue;
          await query(
            `update ${table} set compartments = (select array_agg(c order by c collate "C") from unnest(compartments || '{restricted:health}'::text[]) c)
             where not policy.is_restricted(compartments)`,
          );
        }
        for (const table of based) await query(`drop policy zz_test_relabel on ${table}`);
        await query("commit");
      });

      for (const table of core)
        expect(
          one(
            await admin<{ n: number }>(
              db,
              `select count(*)::int as n from ${table} where policy.is_restricted(compartments)`,
            ),
          ).n,
          table,
        ).toBeGreaterThan(0);
      // The value rows' positive control: every one of them is now under its claim's restricted label.
      expect(values).toBeGreaterThan(0);
      expect(
        one(
          await admin<{ n: number }>(
            db,
            "select count(*)::int as n from knowledge.claim_values where policy.is_restricted(compartments)",
          ),
        ).n,
      ).toBe(values);
      // A relabel owes the old label's audiences a diff, so it writes a recheck under the old,
      // unrestricted label (ids and a fingerprint the pipeline already held); the recheck of the
      // claims' commit keeps its label too. Neither is restricted, so the general worker reads them.
      for (const table of tables.filter(
        (name) => name !== "vault.source_accounts" && name !== "ledger.trigger_rechecks",
      )) {
        if (await readable(table)) expect(await pipelineCount(table), table).toBe(0);
      }
    }));

  it("pi_restricted sees no row whose label holds no restricted compartment in any table that has compartments, and pi_admin sees it", () =>
    withWorld(async ({ db, item }) => {
      await seedExtraction(db, item, { address: CANARIES.address, text: CANARIES.bodyText, subject: CANARIES.subject });
      const tables = await labelledTables(db);
      const readable = async (table: string): Promise<boolean> =>
        one(
          await admin<{ ok: boolean }>(
            db,
            "select has_table_privilege('pi_restricted', $1, 'SELECT') or has_any_column_privilege('pi_restricted', $1, 'SELECT') as ok",
            [table],
          ),
        ).ok;
      const count = async (url: string, table: string): Promise<number> =>
        one(await queryAs<{ n: number }>(url, `select count(*)::int as n from ${table}`)).n;
      // The control: pi_admin sees the item's rows and its extraction's, every one under `own`.
      for (const table of ["vault.evidence_items", "knowledge.messages", "knowledge.claims"])
        expect(await count(db.urls.admin, table), table).toBeGreaterThan(0);
      const read = [];
      for (const table of tables) {
        if (!(await readable(table))) continue;
        read.push(table);
        expect(await count(db.urls.restricted, table), table).toBe(0);
      }
      expect(read).toEqual(expect.arrayContaining(["vault.evidence_items", "knowledge.claims"]));
    }));

  it("pi_pipeline cannot insert a claim or a status row under a restricted label", () =>
    withWorld(async ({ db, item, other }) => {
      await labelItem(db, item, RESTRICTED);
      // The controls: the same two under `own`, for the item that is not restricted.
      expect(await claimAs(db, db.urls.pipeline, "clm-own", other, ["own"])).toBeNull();
      expect(await stateAs(db.urls.pipeline, STATUS, [other, ["own"]])).toBeNull();

      // A claim of a restricted item: its trigger cannot find the item as pi_pipeline (23514), and
      // the policy refuses the row in any case (42501).
      expect(["23514", "42501"]).toContain(await claimAs(db, db.urls.pipeline, "clm-restricted", item, RESTRICTED));
      expect(await stateAs(db.urls.pipeline, STATUS, [item, RESTRICTED])).toBe("42501");
      expect(
        one(
          await admin<{ n: number }>(
            db,
            "select count(*)::int as n from knowledge.claims where policy.is_restricted(compartments)",
          ),
        ).n,
      ).toBe(0);
    }));

  it("every pi_pipeline policy on a table with compartments excludes restricted rows", () =>
    withWorld(async ({ db }) => {
      const tables = new Set(await labelledTables(db));
      const policies = await admin<{ table: string; name: string; qual: string | null; check: string | null }>(
        db,
        `select schemaname || '.' || tablename as "table", policyname as name, qual, with_check as "check" from pg_policies where 'pi_pipeline' = any (roles)`,
      );
      const onLabelled = policies.filter((policy) => tables.has(policy.table));
      // The control: there are such policies, and one on a table with no label says nothing of it.
      expect(onLabelled.length).toBeGreaterThan(10);
      expect(policies.find((policy) => policy.table === "policy.secrets")?.qual).not.toMatch(/is_restricted/);
      for (const policy of onLabelled) {
        // The one exception, by name: a suppression's fingerprint on every row, since an erasure labels one
        // with the union of what it removed, and hiding it would leave its person unsuppressed. That it is
        // the fingerprint alone is erasure-database.db.test.ts's to pin.
        if (policy.table === "knowledge.suppressions" && policy.name === "pi_pipeline_select") {
          expect({ qual: policy.qual, check: policy.check }).toEqual({ qual: "true", check: null });
          continue;
        }
        for (const text of [policy.qual, policy.check]) {
          if (text === null) continue;
          expect(text, `${policy.table} ${policy.name}`).toMatch(/NOT policy\.is_restricted\(compartments\)/);
        }
      }
      // And pi_restricted has a policy of the same command for each of pi_pipeline's.
      const restricted = await admin<{ line: string }>(
        db,
        "select schemaname || '.' || tablename || ' ' || cmd as line from pg_policies where 'pi_restricted' = any (roles)",
      );
      const pipeline = await admin<{ line: string }>(
        db,
        "select schemaname || '.' || tablename || ' ' || cmd as line from pg_policies where 'pi_pipeline' = any (roles)",
      );
      expect(restricted.map((row) => row.line).sort()).toEqual(
        pipeline
          .map((row) => row.line)
          .filter((line) => !PIPELINE_ONLY.test(line))
          .sort(),
      );
    }));

  it("pi_restricted can insert a claim under a restricted label and not under own", () =>
    withWorld(async ({ db, item, other }) => {
      await labelItem(db, item, RESTRICTED);
      expect(await claimAs(db, db.urls.restricted, "clm-restricted", item, RESTRICTED)).toBeNull();
      // An `own` item's claim: its trigger cannot find the item as pi_restricted (23514), and the
      // policy refuses the row in any case (42501).
      expect(["23514", "42501"]).toContain(await claimAs(db, db.urls.restricted, "clm-own", other, ["own"]));
      expect(
        (await queryAs<{ id: string }>(db.urls.restricted, "select id from knowledge.claims order by id")).map(
          (row) => row.id,
        ),
      ).toEqual(["clm-restricted"]);
      // pi_restricted reads the restricted item alone; pi_admin, the control, reads both.
      const items = "select id from vault.evidence_items where id = any ($1) order by id";
      expect((await queryAs<{ id: string }>(db.urls.restricted, items, [[item, other]])).map((row) => row.id)).toEqual([
        item,
      ]);
      expect(await admin(db, items, [[item, other]])).toHaveLength(2);
    }));

  it("a restricting message is returned to pi_reader by no statement, and to pi_admin by the same statement", () =>
    withWorld(async ({ db, item }) => {
      const client = await insertClient(db, "own-only", ["own"]);
      const statements = [
        "select id from knowledge.messages where evidence_id = $1",
        "select count(*)::int as n from knowledge.messages where evidence_id = $1",
      ];
      const asReader = (sql: string) =>
        readAs(db, client.token, (query) => query<Record<string, unknown>>(sql, [item]));
      // The control: before, the reader sees it.
      expect(await asReader(statements[0] ?? "")).toHaveLength(1);
      await admin(db, "update knowledge.messages set restricting = true where evidence_id = $1", [item]);
      expect(await asReader(statements[0] ?? "")).toEqual([]);
      expect(await asReader(statements[1] ?? "")).toEqual([{ n: 0 }]);
      expect(await admin(db, statements[0] ?? "", [item])).toHaveLength(1);
      expect(await admin(db, statements[1] ?? "", [item])).toEqual([{ n: 1 }]);
    }));

  it("request_restriction from pi_pipeline sets restricting and writes one request; a category that is not on is refused; a second call for the same item and category while the first is pending writes nothing", () =>
    withWorld(async ({ db, item }) => {
      const ask = (category: string) =>
        stateAs(db.urls.pipeline, "select policy.request_restriction($1, $2)", [item, category]);
      const requests = () =>
        admin<{
          id: string;
          evidence_id: string;
          kind: string;
          category: string;
          requested_by: string;
          applied_at: unknown;
          compartments: string[];
        }>(db, "select * from vault.restriction_requests");
      // No category is on: refused, and nothing written.
      expect(await ask("health")).toBe("42501");
      expect(await requests()).toEqual([]);
      await turnOn(db, "health");
      expect(await ask("health")).toBeNull();
      const [request, ...more] = await requests();
      expect(more).toEqual([]);
      expect(request).toMatchObject({
        evidence_id: item,
        kind: "restrict",
        category: "health",
        requested_by: "jev",
        applied_at: null,
        compartments: ["own"],
      });
      expect(request?.id).toMatch(/^rrq_[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(
        one(
          await admin<{ restricting: boolean }>(
            db,
            "select restricting from knowledge.messages where evidence_id = $1",
            [item],
          ),
        ).restricting,
      ).toBe(true);
      // Again, while pending: nothing more.
      expect(await ask("health")).toBeNull();
      expect(await requests()).toHaveLength(1);
      // money is not on; `other` is no category.
      expect(await ask("money")).toBe("42501");
      expect(await ask("other")).toBe("42501");
      expect(await requests()).toHaveLength(1);
    }));

  it("request_restriction writes nothing for a category the item carries or one lifted for it", () =>
    withWorld(async ({ db, accounts, item, other }) => {
      await turnOn(db, "health");
      await labelItem(db, item, RESTRICTED);
      expect(await stateAs(db.urls.restricted, "select policy.request_restriction($1, 'health')", [item])).toBeNull();
      const ruling = testId("rul");
      await admin(
        db,
        `insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, decided_at, details, compartments)
         values ($1, $2, 'restriction_lift', 0, now(), '{"category": "health"}'::jsonb, '{own}')`,
        [ruling, `lift-${ruling.slice(4, 20)}`],
      );
      const source = one(
        await admin<{ fp: string }>(db, "select source_item_fp as fp from vault.evidence_items where id = $1", [other]),
      ).fp;
      await admin(
        db,
        "insert into vault.restriction_lifts (account_id, source_item_fp, category, ruling_id, compartments) values ($1, $2, 'health', $3, $4)",
        [accounts.personalMail.id, source, ruling, RESTRICTED],
      );
      expect(await stateAs(db.urls.pipeline, "select policy.request_restriction($1, 'health')", [other])).toBeNull();
      expect(await admin(db, "select id from vault.restriction_requests")).toEqual([]);
      expect(await admin(db, "select id from knowledge.messages where restricting")).toEqual([]);
    }));

  it("pi_restricted cannot update media_type or any other column of an evidence row", () =>
    withWorld(async ({ db, item }) => {
      await labelItem(db, item, RESTRICTED);
      expect(
        await stateAs(db.urls.restricted, "update vault.evidence_items set media_type = media_type where id = $1", [
          item,
        ]),
      ).toBe("42501");
      expect(
        await stateAs(db.urls.restricted, "update vault.evidence_items set change_kind = change_kind where id = $1", [
          item,
        ]),
      ).toBe("42501");
      // The control: it may lock the row, which is what the column grant is for.
      const locked = await session(db.urls.restricted, async (query) => {
        await query("begin");
        const rows = await query("select id from vault.evidence_items where id = $1 for share", [item]);
        await query("rollback");
        return rows;
      });
      expect(locked).toHaveLength(1);
    }));

  it("pi_admin can select, insert, update and delete the four new vault tables", () =>
    withWorld(async ({ db, accounts, item }) => {
      const ruling = testId("rul");
      await admin(
        db,
        "insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, decided_at, compartments) values ($1, $2, 'restriction_lift', 0, now(), '{own}')",
        [ruling, `lift-${ruling.slice(4, 20)}`],
      );
      const source = one(
        await admin<{ fp: string }>(db, "select source_item_fp as fp from vault.evidence_items where id = $1", [item]),
      ).fp;
      const request = testId("rrq");
      const steps: [string, string, unknown[]][] = [
        [
          "requests insert",
          "insert into vault.restriction_requests (id, evidence_id, kind, category, requested_by, compartments) values ($1, $2, 'lift', 'health', 'owner', '{own}')",
          [request, item],
        ],
        ["requests update", "update vault.restriction_requests set applied_at = now() where id = $1", [request]],
        ["requests delete", "delete from vault.restriction_requests where id = $1", [request]],
        [
          "lifts insert",
          "insert into vault.restriction_lifts (account_id, source_item_fp, category, ruling_id, compartments) values ($1, $2, 'health', $3, '{own}')",
          [accounts.personalMail.id, source, ruling],
        ],
        ["lifts update", "update vault.restriction_lifts set lifted_at = now() where ruling_id = $1", [ruling]],
        ["lifts delete", "delete from vault.restriction_lifts where ruling_id = $1", [ruling]],
        [
          "screens insert",
          "insert into vault.restrict_screens (evidence_id, categories, compartments) values ($1, '{health}', '{own}')",
          [item],
        ],
        [
          "screens update",
          "update vault.restrict_screens set categories = '{health,money}' where evidence_id = $1",
          [item],
        ],
        ["screens delete", "delete from vault.restrict_screens where evidence_id = $1", [item]],
        ["passes insert", "insert into vault.screen_passes (version, categories) values (1, '{health}')", []],
        ["passes update", "update vault.screen_passes set categories = '{health,money}'", []],
        ["passes delete", "delete from vault.screen_passes", []],
      ];
      for (const [name, sql, values] of steps) expect(await refusal(() => admin(db, sql, values)), name).toBeNull();
      for (const table of [
        "vault.restriction_requests",
        "vault.restriction_lifts",
        "vault.restrict_screens",
        "vault.screen_passes",
      ]) {
        expect(await admin(db, `select * from ${table}`), table).toEqual([]);
      }
    }));

  it("request_restriction is refused to pi_reader and pi_writer", () =>
    withWorld(async ({ db, item }) => {
      await turnOn(db, "health");
      const sql = "select policy.request_restriction($1, 'health')";
      const client = await insertClient(db, "own-only", ["own"]);
      expect(await sqlState(() => readAs(db, client.token, (query) => query(sql, [item])))).toBe("42501");
      expect(await stateAs(db.urls.writer, sql, [item])).toBe("42501");
      expect(await stateAs(db.urls.admin, sql, [item])).toBe("42501");
      expect(await admin(db, "select id from vault.restriction_requests")).toEqual([]);
      // The control: a worker's role may.
      expect(await stateAs(db.urls.pipeline, sql, [item])).toBeNull();
    }));

  it("request_restriction from pi_pipeline is refused for an item labelled restricted:health", () =>
    withWorld(async ({ db, item }) => {
      await turnOn(db, "money");
      await labelItem(db, item, RESTRICTED);
      expect(await stateAs(db.urls.pipeline, "select policy.request_restriction($1, 'money')", [item])).toBe("42501");
      expect(await admin(db, "select id from vault.restriction_requests")).toEqual([]);
      // The control: the restricted worker may ask the same.
      expect(await stateAs(db.urls.restricted, "select policy.request_restriction($1, 'money')", [item])).toBeNull();
      expect(
        await admin<{ compartments: string[] }>(db, "select compartments from vault.restriction_requests"),
      ).toEqual([{ compartments: RESTRICTED }]);
    }));

  it("a screen carries its item's label: pi_pipeline writes none for a restricted item, and each worker widens its own", () =>
    withWorld(async ({ db, item, other }) => {
      await labelItem(db, item, RESTRICTED);
      const screen =
        "insert into vault.restrict_screens (evidence_id, categories, compartments) values ($1, '{health}', $2)";
      // Under a label that is not its item's, refused; for an item pi_pipeline cannot see, refused
      // whatever label it names.
      expect(await stateAs(db.urls.pipeline, screen, [other, RESTRICTED])).not.toBeNull();
      expect(await stateAs(db.urls.pipeline, screen, [item, ["own"]])).toBe("23514");
      expect(await stateAs(db.urls.restricted, screen, [item, ["own"]])).toBe("23514");
      // The controls: each worker screens its own item under its label, and widens it.
      expect(await stateAs(db.urls.pipeline, screen, [other, ["own"]])).toBeNull();
      expect(await stateAs(db.urls.restricted, screen, [item, RESTRICTED])).toBeNull();
      const widen =
        "update vault.restrict_screens set categories = '{health,money}', screened_at = now() where evidence_id = $1";
      expect(await stateAs(db.urls.pipeline, widen, [other])).toBeNull();
      expect(await stateAs(db.urls.restricted, widen, [item])).toBeNull();
      // But no other column of it.
      expect(
        await stateAs(
          db.urls.pipeline,
          "update vault.restrict_screens set compartments = compartments where evidence_id = $1",
          [other],
        ),
      ).toBe("42501");
      expect(
        await admin(db, "select evidence_id, categories from vault.restrict_screens order by evidence_id"),
      ).toEqual(
        [
          { evidence_id: item, categories: ["health", "money"] },
          { evidence_id: other, categories: ["health", "money"] },
        ].sort((a, b) => (a.evidence_id < b.evidence_id ? -1 : 1)),
      );
    }));

  it("audiences() gives the general worker the audiences with no restricted compartment, and the restricted worker the others", () =>
    withWorld(async ({ db }) => {
      await insertClient(db, "own-only", ["own"]);
      await insertClient(db, "cleared", ["restricted:health", "own"]);
      const audiences = async (url: string): Promise<string[][]> =>
        (await queryAs<{ audience: string[] }>(url, "select a as audience from policy.audiences() a order by 1")).map(
          (row) => row.audience,
        );
      expect(await audiences(db.urls.pipeline)).toEqual([["own"]]);
      expect(await audiences(db.urls.restricted)).toEqual([RESTRICTED]);
    }));

  // Invariant 10: an item's requests and screens are removed with what was extracted from it, so
  // their foreign keys never stop a deletion at the source.
  it("a deletion at the source removes the item's restriction requests and screens", () =>
    withWorld(async ({ db, writer, accounts, other }) => {
      await turnOn(db, "health");
      expect(await stateAs(db.urls.pipeline, "select policy.request_restriction($1, 'health')", [other])).toBeNull();
      expect(
        await stateAs(
          db.urls.pipeline,
          "insert into vault.restrict_screens (evidence_id, categories, compartments) values ($1, '{health}', '{own}')",
          [other],
        ),
      ).toBeNull();
      await writer.applyDeletion(accounts.personalMail, {
        sourceAccount: accounts.personalMail.id,
        sourceItemId: mailSourceId(MAIL.fromQuentin),
      } as SourceDeletion);
      expect(await admin(db, "select id from vault.evidence_items where id = $1", [other])).toEqual([]);
      expect(await admin(db, "select id from vault.restriction_requests")).toEqual([]);
      expect(await admin(db, "select evidence_id from vault.restrict_screens")).toEqual([]);
    }));

  // A new revision is not a removal: the item's pending request outlives it, for sync to apply.
  it("a new revision of an item keeps its pending restriction request, and its message stays kept from clients", () =>
    withWorld(async ({ db, writer, accounts }) => {
      await turnOn(db, "health");
      const first = await stored(writer, accounts.personalMail, MAIL.solo);
      expect(await stateAs(db.urls.pipeline, "select policy.request_restriction($1, 'health')", [first])).toBeNull();
      expect(
        await writer.ingestItem(
          accounts.personalMail,
          mailRevision(MAIL.soloAgain, accounts.personalMail),
          mailFacts(MAIL.soloAgain),
        ),
      ).toBe("stored");
      expect(await admin(db, "select evidence_id from vault.restriction_requests where applied_at is null")).toEqual([
        { evidence_id: first },
      ]);
      const rows = await admin<{ evidence_id: string; restricting: boolean }>(
        db,
        "select evidence_id, restricting from knowledge.messages m where m.evidence_id <> $1 and exists (select 1 from vault.evidence_items e, vault.evidence_items f where e.id = m.evidence_id and f.id = $1 and e.source_item_fp = f.source_item_fp)",
        [first],
      );
      expect(rows.map((row) => row.restricting)).toEqual([true]);
    }));

  it("pi_restricted holds every table, column and function privilege pi_pipeline holds", () =>
    withWorld(async ({ db }) => {
      const pipeline = await rightsOf(db, "pi_pipeline");
      expect(pipeline.length).toBeGreaterThan(20);
      expect(pipeline).toContain("column vault.evidence_items.media_type UPDATE");
      expect(await rightsOf(db, "pi_restricted")).toEqual(pipeline.filter((line) => !PIPELINE_ONLY.test(line)));
      // As information_schema reports them too, column by column.
      const columns = async (role: string): Promise<string[]> =>
        (
          await session(db.urls.bootstrap, async (query) => {
            await query("set role pi_owner");
            return query<{ line: string }>(
              "select table_schema || '.' || table_name || '.' || column_name || ' ' || privilege_type as line from information_schema.column_privileges where grantee = $1",
              [role],
            );
          })
        )
          .map((row) => row.line)
          .sort();
      expect(await columns("pi_restricted")).toEqual(
        (await columns("pi_pipeline")).filter((line) => !PIPELINE_ONLY.test(line)),
      );
      for (const url of [db.urls.pipeline, db.urls.restricted]) {
        expect(await stateAs(url, "select value from policy.settings where key = 'extract.carry_gate_max'")).toBeNull();
        expect(await stateAs(url, "select ruling_id, state from policy.carry_gate(1)")).toBeNull();
      }
    }));
});
