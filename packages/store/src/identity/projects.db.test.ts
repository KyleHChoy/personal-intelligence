import type { EntityId } from "@intelligence/contracts/personal";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { insertClient, testId } from "../test-support/clients.ts";
import { readAs, refusal, session, sqlState } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import { MAIL } from "../test-support/items-named.ts";
import { batchOf, claimRecord, type PipelineStore, rowsOf, stored } from "../test-support/pipeline-fixtures.ts";
import { withRulings as withAdmin } from "../test-support/ruling-fixtures.ts";
import { seeder } from "../test-support/seeder.ts";
import { withDatabase } from "../test-support/store.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";

// Reserved domains only.

const EXTRACT = "select pg_advisory_lock(hashtext('intelligence personal extract'))";

const messageOf = async (store: PipelineStore, evidenceId: string): Promise<string> =>
  (await rowsOf<{ id: string }>(store.db, "select id from knowledge.messages where evidence_id = $1", [evidenceId]))[0]
    ?.id ?? "";

// A saved call for an item, as the pipeline saves one.
const saveCall = (store: PipelineStore, evidenceId: string) =>
  store.pipeline.calls("configured/model").save({
    key: {
      evidenceId,
      revision: 0,
      extractorGeneration: 1,
      promptId: "personal_correspondence",
      promptVersion: "2",
      inputHash: "a".repeat(64),
    },
    keys: [{ evidenceId, keyRef: "personal-unsealed" }],
    renderedInput: "",
    rawOutput: '{"claims":[],"narrowing":"none"}',
    outputHash: "b".repeat(64),
    label: { compartments: ["own"], readers: ["m-owner"] },
    origin: "live",
  } as never);

const decisions = (store: PipelineStore, kind: string) =>
  rowsOf<{ id: string; target_id: string }>(
    store.db,
    "select id, target_id from knowledge.owner_decisions where kind = $1 order by decided_at, id",
    [kind],
  );
let serial = 0;
const request = (): string => `req-projects-${(serial += 1)}-${testId("x").slice(-8)}`;

describe("0026: projects, anchors and bindings", { timeout: DB_TEST_TIMEOUT }, () => {
  it("the entity kind check takes project and nothing else new", () =>
    withDatabase(async (db) => {
      expect(
        await sqlState(() =>
          queryAs(db.urls.admin, "insert into knowledge.entities (id, kind) values ($1, 'project')", [testId("ent")]),
        ),
      ).toBeNull();
      for (const kind of ["household", "place", "thread"]) {
        expect(
          await refusal(() =>
            queryAs(db.urls.admin, "insert into knowledge.entities (id, kind) values ($1, $2)", [testId("ent"), kind]),
          ),
          kind,
        ).toEqual({ code: "23514", constraint: "entities_kind_check" });
      }
    }));

  it("projects and project_bindings have their columns and checks", () =>
    withDatabase(async (db) => {
      const columns = async (table: string) =>
        (
          await queryAs<{ column_name: string }>(
            db.urls.admin,
            "select column_name from information_schema.columns where table_schema = 'knowledge' and table_name = $1 order by ordinal_position",
            [table],
          )
        ).map((row) => row.column_name);
      // The columns, and a sealed name.
      expect(await columns("projects")).toEqual(
        expect.arrayContaining([
          "id",
          "status",
          "merged_into",
          "merged_by",
          "name_enc",
          "compartments",
          "readers",
          // The items a project's name was taken from.
          "named_from",
        ]),
      );
      expect(await columns("project_bindings")).toEqual([
        "id",
        "claim_id",
        "project_id",
        "anchor_kind",
        "anchor_fp",
        "basis",
        "confirmed_by",
        "made_by",
        "ended_by",
        "undone_at",
        "compartments",
        "readers",
      ]);
      expect(await columns("project_anchors")).toEqual([
        "id",
        "project_id",
        "kind",
        "anchor_fp",
        "ruling_id",
        "created_at",
        "lifted_at",
        "compartments",
        "value_enc",
      ]);

      await session(db.urls.admin, async (query) => {
        const seed = seeder(db, query);
        const project = await seed.project(["own"]);
        const claim = await seed.claim(["own"]);
        // A closed project is the owner's word; a merge needs both columns.
        expect(
          await refusal(() => query("update knowledge.projects set status = 'closed' where id = $1", [project])),
        ).toBeNull();
        expect(
          await refusal(() => query("update knowledge.projects set status = 'merged' where id = $1", [project])),
        ).toEqual({ code: "23514", constraint: "projects_merged" });
        // A binding's basis is `anchor` alone, and an anchor binding names its anchor.
        const binding = (basis: string, kind: string | null) =>
          refusal(() =>
            query(
              "insert into knowledge.project_bindings (claim_id, project_id, anchor_kind, anchor_fp, basis, confirmed_by, compartments, readers) values ($1, $2, $3, $4, $5, $6, '{own}', '{m-owner}')",
              [claim, project, kind, kind === null ? null : "f".repeat(64), basis, basis === "human" ? "owner" : null],
            ),
          );
        expect(await binding("proposed", "email_thread")).toEqual({
          code: "23514",
          constraint: "project_bindings_basis",
        });
        expect(await binding("human", "email_thread")).toEqual({ code: "23514", constraint: "project_bindings_basis" });
        expect(await binding("anchor", null)).toEqual({ code: "23514", constraint: "project_bindings_anchor_basis" });
        expect(await binding("anchor", "email_thread")).toBeNull();
        // The binding takes its claim's label, whatever was sent.
        const [row] = await query<{ compartments: string[] }>(
          "select compartments from knowledge.project_bindings where claim_id = $1",
          [claim],
        );
        expect(row?.compartments).toEqual(["own"]);
        // The key to the claim is plain: a claim with a binding is not deleted under it.
        expect(
          await refusal(() => queryAs(db.urls.writer, "delete from knowledge.claims where id = $1", [claim])),
        ).toMatchObject({
          code: "23503",
        });
      });
    }));

  it("pi_pipeline inserts and deletes a binding, pi_writer deletes one, pi_reader reads one only within its clearance, and each is refused where the row gives no grant", () =>
    withDatabase(async (db) => {
      const { own, work, project, ownAnchor } = await session(db.urls.admin, async (query) => {
        const seed = seeder(db, query);
        const projectId = await seed.project(["own"]);
        const anchor = await seed.projectAnchor(["own"], projectId);
        return {
          own: await seed.claim(["own"]),
          work: await seed.claim(["employer:example"]),
          project: projectId,
          ownAnchor: anchor,
        };
      });
      const bind = (url: string, claim: string) =>
        sqlState(() =>
          queryAs(
            url,
            "insert into knowledge.project_bindings (claim_id, project_id, anchor_kind, anchor_fp, basis, compartments, readers) values ($1, $2, 'email_thread', $3, 'anchor', '{own}', '{m-owner}')",
            [claim, project, "e".repeat(64)],
          ),
        );
      // The pipeline binds and deletes; the writer and the reader cannot bind.
      expect(await bind(db.urls.writer, own)).toBe("42501");
      expect(await bind(db.urls.pipeline, own)).toBeNull();
      expect(await bind(db.urls.pipeline, work)).toBeNull();
      expect(
        await sqlState(() => queryAs(db.urls.pipeline, "select claim_id from knowledge.project_bindings")),
      ).toBeNull();

      // The reader reads a binding only within its clearance, and a project the same way.
      const ownClient = await insertClient(db, "own-projects", ["own"]);
      const seen = await readAs(db, ownClient.token, (query) =>
        query<{ claim_id: string }>("select claim_id from knowledge.project_bindings order by claim_id"),
      );
      expect(seen.map((row) => row.claim_id)).toEqual([own]);
      expect(
        await readAs(db, ownClient.token, (query) =>
          query<{ id: string }>("select id from knowledge.projects order by id"),
        ),
      ).toEqual([{ id: project }]);
      const workClient = await insertClient(db, "work-projects", ["employer:example"]);
      expect(
        await readAs(db, workClient.token, (query) =>
          query<{ id: string }>("select id from knowledge.projects order by id"),
        ),
      ).toEqual([]);
      // The project's entity is seen with the project, as a person's with an account.
      expect(
        await readAs(db, ownClient.token, (query) =>
          query<{ id: string }>("select id from knowledge.entities where kind = 'project'"),
        ),
      ).toEqual([{ id: project }]);
      expect(
        await readAs(db, workClient.token, (query) =>
          query<{ id: string }>("select id from knowledge.entities where kind = 'project'"),
        ),
      ).toEqual([]);
      // Four columns of a project, never more.
      expect(
        await sqlState(() => readAs(db, ownClient.token, (query) => query("select readers from knowledge.projects"))),
      ).toBe("42501");
      const workAnchor = await session(db.urls.admin, (query) => seeder(db, query).projectAnchor(["employer:example"]));
      expect(
        await readAs(db, ownClient.token, (query) =>
          query<{ id: string }>("select id from knowledge.project_anchors order by id"),
        ),
      ).toEqual([{ id: ownAnchor }]);
      expect(
        await readAs(db, workClient.token, (query) =>
          query<{ id: string }>("select id from knowledge.project_anchors order by id"),
        ),
      ).toEqual([{ id: workAnchor }]);
      for (const column of ["ruling_id", "created_at"]) {
        expect(
          await sqlState(() =>
            readAs(db, ownClient.token, (query) => query(`select ${column} from knowledge.project_anchors`)),
          ),
          column,
        ).toBe("42501");
      }
      // The pipeline reads anchors and projects; the writer reads neither.
      expect(
        await sqlState(() => queryAs(db.urls.pipeline, "select anchor_fp from knowledge.project_anchors")),
      ).toBeNull();
      expect(await sqlState(() => queryAs(db.urls.pipeline, "select id from knowledge.projects"))).toBeNull();
      expect(await sqlState(() => queryAs(db.urls.writer, "select id from knowledge.project_anchors"))).toBe("42501");
      expect(
        await sqlState(() => queryAs(db.urls.pipeline, "insert into knowledge.project_anchors (id) values ('pan_x')")),
      ).toBe("42501");
      // The writer deletes a binding; the reader cannot.
      expect(
        await sqlState(() => readAs(db, ownClient.token, (query) => query("delete from knowledge.project_bindings"))),
      ).toBe("42501");
      expect(
        await sqlState(() =>
          queryAs(db.urls.writer, "delete from knowledge.project_bindings where claim_id = $1", [work]),
        ),
      ).toBeNull();
      expect(
        await sqlState(() =>
          queryAs(db.urls.pipeline, "delete from knowledge.project_bindings where claim_id = $1", [own]),
        ),
      ).toBeNull();
      expect(await rowsOf<{ n: number }>(db, "select count(*)::int as n from knowledge.project_bindings")).toEqual([
        { n: 0 },
      ]);
    }));
});

describe("the owner's project commands", { timeout: DB_TEST_TIMEOUT }, () => {
  it("add, anchor, unanchor and close each write one decision", () =>
    withAdmin(async (store) => {
      const { admin, writer, accounts } = store;
      const project = await admin.projects.add("Canary project: the heron survey", { requestId: request() });
      expect(project).toMatch(/^ent_/);
      const evidence = await stored(writer, accounts.personalMail, MAIL.canary);
      const anchor = await admin.projects.anchor(project, (await messageOf(store, evidence)) as never, {
        requestId: request(),
      });
      expect(anchor).toMatch(/^pan_/);
      expect(await admin.projects.unanchor(anchor, { requestId: request() })).toBe(true);
      expect(await admin.projects.close(project, { requestId: request() })).toBe(true);
      for (const kind of ["project_add", "project_anchor", "project_unanchor", "project_close"])
        expect(
          (await decisions(store, kind)).map((row) => row.target_id),
          kind,
        ).toEqual([project]);
      // The name is sealed: the list opens it for the owner, and no row holds it in clear.
      const [listed] = await admin.projects.list();
      expect(listed).toMatchObject({
        id: project,
        status: "closed",
        name: "Canary project: the heron survey",
        anchors: [],
      });
      expect(JSON.stringify(await rowsOf(store.db, "select * from knowledge.projects"))).not.toContain("heron");
      // A repeated request id adds nothing.
      const again = request();
      const first = await admin.projects.add("Second", { requestId: again });
      expect(await admin.projects.add("Second", { requestId: again })).toBe(first);
      expect(await decisions(store, "project_add")).toHaveLength(2);
      // An unknown project or anchor is not_found, and an empty name is refused.
      await expect(
        admin.projects.anchor(`ent_${"0".repeat(26)}` as EntityId, (await messageOf(store, evidence)) as never, {
          requestId: request(),
        }),
      ).rejects.toMatchObject({ code: "not_found" });
      expect(await admin.projects.unanchor(`pan_${"0".repeat(26)}`, { requestId: request() })).toBe(false);
      await expect(admin.projects.add("  ", { requestId: request() })).rejects.toMatchObject({
        code: "invalid_argument",
      });
    }));

  it("anchoring a thread sets its items waiting and keeps their saved calls; it removes their claims", () =>
    withAdmin(async (store) => {
      const { admin, pipeline, writer, accounts, owner } = store;
      const first = await stored(writer, accounts.personalMail, MAIL.canary);
      const second = await stored(writer, accounts.personalMail, MAIL.reply);
      const elsewhere = await stored(writer, accounts.personalMail, MAIL.solo);
      for (const evidence of [first, second, elsewhere]) {
        await saveCall(store, evidence);
        expect(await pipeline.commit(batchOf(evidence, [claimRecord(evidence, "own", owner)]))).toBe("committed");
      }
      expect(await pipeline.due(10, 1)).toEqual([]);
      const project = await admin.projects.add("Lighthouse", { requestId: request() });
      await admin.projects.anchor(project, (await messageOf(store, first)) as never, { requestId: request() });
      // Both items of the thread are due again, the other is not; every saved call is kept.
      expect((await pipeline.due(10, 1)).map((item) => item.evidenceId).sort()).toEqual([first, second].sort());
      expect(await rowsOf<{ n: number }>(store.db, "select count(*)::int as n from vault.model_calls")).toEqual([
        { n: 3 },
      ]);
      // The thread's claims are gone, with their entities; the other item's stay.
      expect(
        (await rowsOf<{ evidence_id: string }>(store.db, "select evidence_id from knowledge.claims")).map(
          (row) => row.evidence_id,
        ),
      ).toEqual([elsewhere]);
    }));

  it("anchor while a run holds the extract lock is extract_running and changes nothing", () =>
    withAdmin(async (store) => {
      const { admin, pipeline, writer, accounts, owner, db } = store;
      const evidence = await stored(writer, accounts.personalMail, MAIL.canary);
      expect(await pipeline.commit(batchOf(evidence, [claimRecord(evidence, "own", owner)]))).toBe("committed");
      const project = await admin.projects.add("Locked", { requestId: request() });
      const run = new pg.Client({ connectionString: db.urls.pipeline });
      await run.connect();
      try {
        await run.query(EXTRACT);
        await expect(
          admin.projects.anchor(project, (await messageOf(store, evidence)) as never, { requestId: request() }),
        ).rejects.toMatchObject({ code: "extract_running" });
        expect(await rowsOf(store.db, "select id from knowledge.project_anchors")).toEqual([]);
        expect(await rowsOf<{ n: number }>(store.db, "select count(*)::int as n from knowledge.claims")).toEqual([
          { n: 1 },
        ]);
        expect(await decisions(store, "project_anchor")).toEqual([]);
      } finally {
        await run.end();
      }
      // The control: once the run ends, the same anchor is taken.
      expect(
        await admin.projects.anchor(project, (await messageOf(store, evidence)) as never, { requestId: request() }),
      ).toMatch(/^pan_/);
    }));

  it("close while a run holds the extract lock is extract_running and changes nothing", () =>
    withAdmin(async (store) => {
      const { admin, db } = store;
      const project = await admin.projects.add("Locked close", { requestId: request() });
      const run = new pg.Client({ connectionString: db.urls.pipeline });
      await run.connect();
      try {
        await run.query(EXTRACT);
        await expect(admin.projects.close(project, { requestId: request() })).rejects.toMatchObject({
          code: "extract_running",
        });
        expect(await rowsOf(store.db, "select status from knowledge.projects where id = $1", [project])).toEqual([
          { status: "active" },
        ]);
      } finally {
        await run.end();
      }
      expect(await admin.projects.close(project, { requestId: request() })).toBe(true);
    }));

  it("the replay wakes only the thread's items with a saved call, never a withheld one, so it buys no call", () =>
    withAdmin(async (store) => {
      const { admin, pipeline, writer, accounts, owner } = store;
      const saved = await stored(writer, accounts.personalMail, MAIL.canary);
      const withheld = await stored(writer, accounts.personalMail, MAIL.reply);
      await saveCall(store, saved);
      expect(await pipeline.commit(batchOf(saved, [claimRecord(saved, "own", owner)]))).toBe("committed");
      await saveCall(store, withheld);
      expect(await pipeline.commit(batchOf(withheld, [], { status: "withheld", code: "quarantine" }))).toBe(
        "committed",
      );
      const project = await admin.projects.add("Saved calls only", { requestId: request() });
      await admin.projects.anchor(project, (await messageOf(store, saved)) as never, { requestId: request() });
      expect((await pipeline.due(10, 1)).map((item) => item.evidenceId)).toEqual([saved]);
      expect(
        await rowsOf(store.db, "select waiting, withheld from vault.pipeline_items where evidence_id = $1", [withheld]),
      ).toEqual([{ waiting: false, withheld: true }]);
    }));

  it("an anchor to a thread of another compartment is compartment_mismatch", () =>
    withAdmin(async (store) => {
      const { admin, writer, accounts } = store;
      const work = await stored(writer, accounts.workMail, MAIL.workCanary);
      const project = await admin.projects.add("Own only", { requestId: request() });
      await expect(
        admin.projects.anchor(project, (await messageOf(store, work)) as never, { requestId: request() }),
      ).rejects.toMatchObject({ code: "compartment_mismatch" });
      // The control: a project of that compartment takes it.
      const employer = await admin.projects.add("Employer's", {
        compartment: "employer:example",
        requestId: request(),
      });
      expect(
        await admin.projects.anchor(employer, (await messageOf(store, work)) as never, { requestId: request() }),
      ).toMatch(/^pan_/);
      expect(
        (await rowsOf<{ compartments: string[] }>(store.db, "select compartments from knowledge.project_anchors"))[0]
          ?.compartments,
      ).toEqual(["employer:example"]);
    }));
});
