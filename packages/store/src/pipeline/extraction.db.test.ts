import { describe, expect, it } from "vitest";
import { openRow } from "../core/seal.ts";
import { CANARIES } from "../test-support/cast.ts";
import { insertClient, insertSecret, sha256Hex } from "../test-support/clients.ts";
import { asClaimsOwner, asTablesOwner, one, readAs, refusal, session, sqlState } from "../test-support/connections.ts";
import { fingerprint, queryAs, scanForPlaintext, sealRow, type TestDatabase } from "../test-support/database.ts";
import { MAIL } from "../test-support/items-named.ts";
import { batchOf, claimRecord, countOf, rowsOf, stored, withPipeline } from "../test-support/pipeline-fixtures.ts";
import { seeder } from "../test-support/seeder.ts";
import { withDatabase } from "../test-support/store.ts";

// A statement that changes or removes a claim, as the claims' owner: pi_admin may not.
const claimsAs = (db: TestDatabase, text: string, values: unknown[] = []): Promise<unknown> =>
  asClaimsOwner(db, (query) => query(text, values));

// The extraction migration's tables, grants, triggers and functions. Each refusal has its positive
// control in the same test.

const TIMEOUT = 240_000;

// The clear columns of each new table, with `compartments`; every other
// column is a sealed envelope.
const CLEAR: Record<string, string[]> = {
  // `release_ruling_id`, the release the last run read, an id.
  // The re-derive's carry of an item's first-known times.
  "vault.pipeline_items": [
    "evidence_id",
    "waiting",
    "withheld",
    "screened",
    "extractor_generation",
    "updated_at",
    "compartments",
    "release_ruling_id",
    "first_known",
    // Counts, a time, code words and a prompt's id: what failed the item stays sealed.
    "vendor_retries",
    "retry_at",
    "reask_codes",
    "reask_wording",
    "reask_rescued",
  ],
  "vault.model_calls": [
    "id",
    "evidence_id",
    "revision",
    "prompt_id",
    "prompt_version",
    "input_fp",
    "model_id",
    "created_at",
    "compartments",
    "key_version",
    "superseded_at",
    "superseded_members",
  ],
  // The budget's lane, `extract` or `dream`.
  "vault.model_usage": [
    "id",
    "prompt_id",
    "prompt_version",
    "model_id",
    "input_tokens",
    "output_tokens",
    "cost_microusd",
    "outcome",
    "day",
    "compartments",
    "lane",
  ],
  "vault.extraction_runs": [
    "seq",
    "day",
    "code",
    "done",
    "skipped",
    "withheld",
    "failed",
    "waiting",
    "claims",
    "unmapped",
    "unresolved",
    "live_calls",
    "beliefs",
    "beliefs_changed",
    "beliefs_mixed",
    "beliefs_failed",
    "beliefs_removed",
    "rebuild_ms",
    "compartments",
    // The thresholds the run applied, ids, names and numbers.
    "thresholds",
    // The lanes the run had switched off, lane words only.
    "lanes_off",
  ],
  "vault.unmapped_claims": ["id", "evidence_id", "extractor_generation", "compartments"],
  "vault.extraction_reviews": ["id", "evidence_id", "claim_id", "extractor_generation", "reviewed_at", "compartments"],
  // A claim's version 1 fact keys, keyed fingerprints.
  "knowledge.claims": [
    "id",
    "evidence_id",
    "type",
    "valid_from",
    "fact_key_fp",
    "extractor_generation",
    "readers",
    "created_at",
    "compartments",
    "legacy_fact_key_fp",
    "legacy_alt_fact_key_fp",
    "released",
    // Whether the claim is an agent's close of its commitment, in clear.
    "closes",
    // Its end, due and review dates.
    "valid_to",
    "due_at",
    "review_at",
    // When the claim was first known.
    "first_known_at",
    // Whether the pipeline built it from a research fill alone.
    "researched",
  ],
  "knowledge.claim_entities": ["claim_id", "entity_id", "compartments"],
};
const SEALED: Record<string, string[]> = {
  "vault.pipeline_items": ["facts_enc"],
  "vault.model_calls": ["output_enc"],
  "vault.unmapped_claims": ["facts_enc"],
  "vault.extraction_reviews": ["facts_enc"],
  "knowledge.claims": ["content_enc"],
};

describe("the extraction migration", { timeout: TIMEOUT }, () => {
  it("the clear columns of each new table are exactly those listed", () =>
    withDatabase(async (db) => {
      for (const [table, clear] of Object.entries(CLEAR)) {
        const [schema, name] = table.split(".");
        const columns = await queryAs<{ name: string }>(
          db.urls.admin,
          "select column_name::text as name from information_schema.columns where table_schema = $1 and table_name = $2",
          [schema, name],
        );
        expect(columns.map((one) => one.name).sort(), table).toEqual([...clear, ...(SEALED[table] ?? [])].sort());
      }
    }));

  it("no foreign key of the new tables cascades", () =>
    withDatabase(async (db) => {
      const keys = await queryAs<{ name: string; table: string; action: string }>(
        db.urls.admin,
        `select conname::text as name, conrelid::regclass::text as table, confdeltype::text as action from pg_constraint
         where contype = 'f' and conrelid::regclass::text = any ($1)`,
        [Object.keys(CLEAR)],
      );
      // To the evidence from five tables, and from claim_entities to its claim and its entity.
      expect(keys.length).toBe(7);
      for (const key of keys) expect(key.action, `${key.table} ${key.name}`).toBe("a");
    }));

  it("log_call accepts find_facts once the extraction migration has run, and the policies of policy.tool_names are stage 1's two and the owner role's read", () =>
    withDatabase(async (db) => {
      const client = await insertClient(db, "caller", ["own"]);
      expect(
        await sqlState(() =>
          readAs(db, client.token, (query) => query("select policy.log_call('find_facts', 3, 'ok')")),
        ),
      ).toBeNull();
      expect(await queryAs(db.urls.admin, "select tool, rows from policy.calls")).toEqual([
        { tool: "find_facts", rows: 3 },
      ]);
      // The control: a name no migration added is still refused.
      expect(
        await sqlState(() =>
          readAs(db, client.token, (query) => query("select policy.log_call('not_a_tool', 0, 'ok')")),
        ),
      ).toBe("23503");
      expect(
        await queryAs(
          db.urls.admin,
          "select policyname::text as name from pg_policies where schemaname = 'policy' and tablename = 'tool_names' order by 1",
        ),
        // Stage 1's two, and the definer's own read of the names, as database.db.test.ts pins.
      ).toEqual([{ name: "pi_admin_select" }, { name: "pi_owner_insert" }, { name: "pi_owner_select" }]);
    }));

  it("the pipeline can lock an evidence row and cannot change one", () =>
    withPipeline(async ({ db, writer, accounts }) => {
      const id = await stored(writer, accounts.personalMail, MAIL.canary);
      await session(db.urls.pipeline, async (query) => {
        await query("begin");
        expect(await query("select id from vault.evidence_items where id = $1 for share", [id])).toEqual([{ id }]);
        await query("rollback");
      });
      expect(
        await sqlState(() =>
          queryAs(db.urls.pipeline, "update vault.evidence_items set media_type = media_type where id = $1", [id]),
        ),
      ).toBe("42501");
      expect(
        await sqlState(() =>
          queryAs(db.urls.pipeline, "update vault.evidence_items set observed_at = now() where id = $1", [id]),
        ),
      ).toBe("42501");
      expect(
        await sqlState(() => queryAs(db.urls.pipeline, "delete from vault.evidence_items where id = $1", [id])),
      ).toBe("42501");
      // The positive control: the writer may.
      expect(
        await sqlState(() =>
          queryAs(db.urls.writer, "update vault.evidence_items set media_type = media_type where id = $1", [id]),
        ),
      ).toBeNull();
    }));

  it("the pipeline cannot read a client, a call, a tool name or a Google secret, and cannot write a core table or update a claim", () =>
    withPipeline(async ({ db, writer, accounts, pipeline, owner }) => {
      await insertClient(db, "someone", ["own"]);
      await insertSecret(db, "google/personal/refresh_token", "google-token");
      await insertSecret(db, "openrouter/key", "model-key");
      for (const table of ["policy.clients", "policy.calls", "policy.tool_names"])
        expect(await sqlState(() => queryAs(db.urls.pipeline, `select count(*) from ${table}`)), table).toBe("42501");
      expect(await queryAs(db.urls.pipeline, "select name from policy.secrets order by name")).toEqual([
        { name: "openrouter/key" },
      ]);
      for (const sql of [
        "insert into knowledge.entities (id, kind) values ('ent_x', 'person')",
        "update knowledge.messages set held = true",
        "delete from knowledge.accounts",
      ]) {
        expect(await sqlState(() => queryAs(db.urls.pipeline, sql)), sql).toBe("42501");
      }
      const id = await stored(writer, accounts.personalMail, MAIL.canary);
      await pipeline.commit(batchOf(id, [claimRecord(id, "own", owner)]));
      expect(await sqlState(() => queryAs(db.urls.pipeline, "update knowledge.claims set type = type"))).toBe("42501");
      // The positive control: pi_admin may read all of it.
      expect(await countOf(db, "policy.secrets")).toBe(2);
    }));

  it("the writer still reads a Google secret, and cannot read the model key", () =>
    withDatabase(async (db) => {
      await insertSecret(db, "google/personal/refresh_token", "google-token");
      await insertSecret(db, "openrouter/key", "model-key");
      expect(await queryAs(db.urls.writer, "select name from policy.secrets order by name")).toEqual([
        { name: "google/personal/refresh_token" },
      ]);
      expect(await queryAs(db.urls.writer, "select name from policy.secrets where name = 'openrouter/key'")).toEqual(
        [],
      );
    }));

  it("policy.audiences is run by the pipeline alone", () =>
    withDatabase(async (db) => {
      await insertClient(db, "a", ["own", "employer:example"]);
      await insertClient(db, "b", ["employer:example", "own"]);
      await insertClient(db, "c", ["own"]);
      const revoked = await insertClient(db, "d", ["public"]);
      await queryAs(db.urls.admin, "update policy.clients set status = 'revoked' where id = $1", [revoked.id]);
      const audiences = (await queryAs<{ a: string[] }>(db.urls.pipeline, "select a from policy.audiences() a"))
        .map((row) => row.a)
        .sort();
      expect(audiences).toEqual([["employer:example", "own"], ["own"]]);
      for (const url of [db.urls.admin, db.urls.writer])
        expect(await sqlState(() => queryAs(url, "select * from policy.audiences()")), url).toBe("42501");
      const client = await insertClient(db, "reader", ["own"]);
      expect(await sqlState(() => readAs(db, client.token, (query) => query("select * from policy.audiences()")))).toBe(
        "42501",
      );
    }));

  it("the database refuses a claim whose compartments differ from its evidence's, as pi_pipeline and as pi_admin", () =>
    withPipeline(async ({ db, writer, accounts }) => {
      const id = await stored(writer, accounts.personalMail, MAIL.canary);
      const insert = (url: string, compartments: string[], readers = ["m-owner"]) =>
        refusal(() =>
          queryAs(
            url,
            `insert into knowledge.claims (id, evidence_id, type, valid_from, fact_key_fp, extractor_generation, readers, content_enc, compartments)
             values ($1, $2, 'commitment', now(), 'f', 1, $3, $4, $5)`,
            [
              sha256Hex(`${url} ${compartments.join()} ${readers.join()}`),
              id,
              readers,
              sealRow(db.keys, "own", { table: "knowledge.claims", id: "x", column: "content_enc" }, "{}"),
              compartments,
            ],
          ),
        );
      for (const url of [db.urls.pipeline, db.urls.admin]) {
        expect(await insert(url, ["employer:example"]), url).toMatchObject({ code: "23514" });
        expect(await insert(url, ["own", "employer:example"]), url).toMatchObject({ code: "23514" });
        expect(await insert(url, ["own"], ["m-owner", "m-other"]), url).toMatchObject({ code: "23514" });
        // The positive control: the evidence's own label.
        expect(await insert(url, ["own"]), url).toBeNull();
      }
      // And on update, as the claims' owner: no runtime role may update a claim.
      expect(
        await sqlState(() => claimsAs(db, "update knowledge.claims set compartments = '{employer:example}'")),
      ).toBe("23514");
    }));

  it("and restricted-compartments: the database refuses a claim entity labelled other than its claim, and a claim under a restricted label that differs from its item's", () =>
    withPipeline(async ({ db, writer, accounts, pipeline, owner }) => {
      const id = await stored(writer, accounts.personalMail, MAIL.canary);
      const record = claimRecord(id, "own", owner);
      await pipeline.commit(batchOf(id, [record]));
      const claimId = fingerprint(db.keys, "claim", record.claim.id);
      await session(db.urls.admin, async (query) => {
        const seed = seeder(db, query);
        const entity = await seed.entity("person");
        const entityRow = (compartments: string[]) =>
          refusal(() =>
            query("insert into knowledge.claim_entities (claim_id, entity_id, compartments) values ($1, $2, $3)", [
              claimId,
              entity,
              compartments,
            ]),
          );
        expect(await entityRow(["employer:example"])).toMatchObject({ code: "23514" });
        expect(await entityRow(["own"])).toBeNull();
      });
      // A claim under a restricted label its item does not carry is refused; under the item's
      // own restricted label it is taken.
      const claim = (claimId: string) =>
        refusal(() =>
          queryAs(
            db.urls.admin,
            "insert into knowledge.claims (id, evidence_id, type, valid_from, fact_key_fp, extractor_generation, readers, content_enc, compartments) values ($1, $2, 't', now(), 'f', 1, '{m-owner}', '{}'::jsonb, '{own,restricted:health}')",
            [claimId, id],
          ),
        );
      expect(await claim("r1")).toMatchObject({ code: "23514" });
      await asTablesOwner(db, ["vault.evidence_items"], (query) =>
        query("update vault.evidence_items set compartments = '{own,restricted:health}' where id = $1", [id]),
      );
      expect(await claim("r2")).toBeNull();
    }));

  it("the reader reads a claim only within its clearance", () =>
    withPipeline(async ({ db, writer, accounts, pipeline, owner }) => {
      const id = await stored(writer, accounts.personalMail, MAIL.canary);
      const record = claimRecord(id, "own", owner);
      await pipeline.commit(batchOf(id, [record]));
      const narrow = await insertClient(db, "narrow", ["own"]);
      const wide = await insertClient(db, "wide", ["own", "employer:example"]);
      const work = await insertClient(db, "work", ["employer:example"]);
      const claims = (token: string) =>
        readAs(
          db,
          token,
          async (query) => one(await query<{ n: number }>("select count(*)::int as n from knowledge.claims")).n,
        );
      expect(await claims(narrow.token)).toBe(1);
      expect(await claims(wide.token)).toBe(1);
      expect(await claims(work.token)).toBe(0);
    }));

  it("a moved envelope does not open, for each sealed column of the new tables", () =>
    withPipeline(async ({ db, writer, accounts, pipeline, owner }) => {
      const id = await stored(writer, accounts.personalMail, MAIL.canary);
      const record = claimRecord(id, "own", owner);
      await pipeline.commit(
        batchOf(id, [record], { unmapped: [{ id: "u", proposedType: "commitment", reason: "bad_fields" }] }),
      );
      await pipeline.calls("m").save({
        key: {
          evidenceId: id,
          revision: 0,
          extractorGeneration: 0,
          promptId: "p",
          promptVersion: "1",
          inputHash: "a".repeat(64),
        },
        keys: [{ evidenceId: id, keyRef: "personal-unsealed" }],
        renderedInput: "",
        rawOutput: "{}",
        outputHash: "b".repeat(64),
        label: { compartments: ["own"], readers: ["m-owner"] },
        origin: "live",
      } as never);
      await session(db.urls.admin, (query) => seeder(db, query).review(["own"], id));
      const sealedAt = Object.entries(SEALED).map(([table, [column]]) => ({
        table,
        column: column ?? "",
        key: table === "vault.pipeline_items" ? "evidence_id" : "id",
      }));
      for (const at of sealedAt) {
        const row = one(
          await rowsOf<{ key: string; value: unknown }>(
            db,
            `select ${at.key} as key, ${at.column} as value from ${at.table} limit 1`,
          ),
        );
        // The positive control: it opens at its own row and column.
        expect(
          () => openRow(db.keys, "own", { table: at.table, id: row.key, column: at.column }, row.value as never),
          at.table,
        ).not.toThrow();
        // At another row's id, or another table, it does not.
        expect(
          () => openRow(db.keys, "own", { table: at.table, id: `${row.key}x`, column: at.column }, row.value as never),
          at.table,
        ).toThrow();
        expect(
          () =>
            openRow(
              db.keys,
              "own",
              { table: "knowledge.messages", id: row.key, column: "facts_enc" },
              row.value as never,
            ),
          at.table,
        ).toThrow();
      }
    }));

  it("a canary commitment text is in no column, and neither is the plain hash of it, of a claim's id or of an output", () =>
    withPipeline(async ({ db, writer, accounts, pipeline, owner }) => {
      const id = await stored(writer, accounts.personalMail, MAIL.canary);
      const merchant = "Canary Lanternworks Supply";
      const orderRef = "ORDER-CANARY-77310";
      const what = "I will send the canary heron ledger by Friday.";
      const record = claimRecord(id, "own", owner);
      const claim = {
        ...record,
        claim: {
          ...record.claim,
          content: { ...record.claim.content, fields: { what, merchant, order_ref: orderRef } },
        },
      };
      const output = JSON.stringify({ claims: [{ what, merchant }], narrowing: "none" });
      await pipeline.commit(batchOf(id, [claim as never]));
      await pipeline.calls("m").save({
        key: {
          evidenceId: id,
          revision: 0,
          extractorGeneration: 0,
          promptId: "p",
          promptVersion: "1",
          inputHash: sha256Hex("rendered"),
        },
        keys: [{ evidenceId: id, keyRef: "personal-unsealed" }],
        renderedInput: "rendered",
        rawOutput: output,
        outputHash: sha256Hex(output),
        label: { compartments: ["own"], readers: ["m-owner"] },
        origin: "live",
      } as never);
      for (const table of ["knowledge.claims", "vault.model_calls", "vault.pipeline_items"])
        expect(await countOf(db, table), table).toBeGreaterThan(0);
      const needles = [
        merchant,
        orderRef,
        what,
        sha256Hex(what),
        claim.claim.id,
        sha256Hex(output),
        sha256Hex("rendered"),
        CANARIES.bodyText,
      ];
      expect(await scanForPlaintext(db.urls.admin, needles)).toEqual([]);
      // The positive control: a planted plain hash is found.
      await claimsAs(db, "update knowledge.claims set type = $1", [claim.claim.id]);
      expect(await scanForPlaintext(db.urls.admin, needles)).toEqual([{ table: "knowledge.claims", column: "type" }]);
    }));
});
