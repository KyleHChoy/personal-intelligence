import { createHmac, randomBytes } from "node:crypto";
import { Envelope, type EvidenceId, type Mention } from "@intelligence/contracts";
import {
  ANCHOR_VECTORS,
  BROWSER_BUNDLES,
  type CaptureId,
  type EntityId,
  GENERIC_APPS,
  GENERIC_HOSTS,
  type MessageId,
  MULTI_ACCOUNT_SURFACES,
} from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Admin, createAdmin } from "../admin/admin.ts";
import type { DeviceAnchorInput } from "../admin/projects/admin-projects.ts";
import { openUnder, sealUnder } from "../core/seal.ts";
import { createPipeline, type Pipeline } from "../pipeline/pipeline.ts";
import { seedCapture } from "../test-support/capture-fixtures.ts";
import { type Accounts, connect } from "../test-support/cast.ts";
import { insertClient, testId } from "../test-support/clients.ts";
import { one, readAs, refusal, session, sqlState } from "../test-support/connections.ts";
import { createTestDatabase, queryAs, type TestDatabase } from "../test-support/database.ts";
import { MAIL } from "../test-support/items-named.ts";
import { batchOf, claimRecord, stored } from "../test-support/pipeline-fixtures.ts";
import { recordingLogger } from "../test-support/recording.ts";
import { createWriter, type Writer } from "../write/writer.ts";

// One world, built once: the two compartments, the canary thread stored and its claim committed
// under an `own` project anchored to it, an `employer:example` project with a thread anchor, and a
// closed project. Synthetic values only: hosts on example.com, example.org and .test, bundle ids
// under `test.`, paths under `~/test`; the product lists only in the refusals.

const TABLE = "knowledge.project_anchors";
const THIS: Mention = {
  key: { kind: "source_id", value: "project:this" },
  observedAt: "2026-09-01T09:00:00.000Z",
} as Mention;

let db: TestDatabase;
let writer: Writer;
let pipeline: Pipeline;
let admin: Admin;
let accounts: Accounts;
let canary: string;
let solo: string;
let own: EntityId;
let work: EntityId;
let closed: EntityId;
let ruling: string;

let serial = 0;
const request = (): string => `req-device-anchors-${(serial += 1)}-${randomBytes(4).toString("hex")}`;
const rows = <Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(db.urls.admin, sql, values);
const count = async (table: string): Promise<number> =>
  one(await rows<{ n: number }>(`select count(*)::int as n from ${table}`)).n;
const counts = async () => ({ decisions: await count("knowledge.owner_decisions"), anchors: await count(TABLE) });

const anchorFp = (key: string): string =>
  createHmac("sha256", db.keys.fingerprintKey)
    .update("anchor", "utf8")
    .update(Buffer.from([0]))
    .update(key, "utf8")
    .digest("hex");
// The sealed value is the normal form without its `<prefix>:`.
const sealedPart = (key: string): string => key.slice(key.indexOf(":") + 1);
const valueAt = (id: string) => ({ table: TABLE, id, column: "value_enc" });

type AnchorRow = {
  id: string;
  project_id: string;
  kind: string;
  anchor_fp: string;
  ruling_id: string;
  value_enc: unknown;
  lifted_at: Date | null;
  compartments: string[];
};
const anchorRow = async (id: string): Promise<AnchorRow> =>
  one(
    await rows<AnchorRow>(
      `select id, project_id, kind, anchor_fp, ruling_id, value_enc, lifted_at, compartments from ${TABLE} where id = $1`,
      [id],
    ),
  );
const opened = (row: AnchorRow): string =>
  openUnder(db.keys, row.compartments, valueAt(row.id), Envelope.parse(row.value_enc));
const decision = async (id: string) =>
  one(
    await rows<{ kind: string; target_id: string; compartments: string[] }>(
      "select kind, target_id, compartments from knowledge.owner_decisions where id = $1",
      [id],
    ),
  );

const anchor = (project: EntityId, input: DeviceAnchorInput): Promise<string> =>
  admin.projects.anchor(project, input, { requestId: request() });
const messageOf = async (evidenceId: string): Promise<MessageId> =>
  one(await rows<{ id: MessageId }>("select id from knowledge.messages where evidence_id = $1", [evidenceId])).id;

// One transaction as pi_admin, rolled back; each statement in its own savepoint, so a refused
// one leaves the next to run. `attempt` gives what a statement was refused with, or null.
const rolledBack = (
  fn: (
    attempt: (sql: string, values?: unknown[]) => Promise<{ code: string; constraint?: string } | null>,
  ) => Promise<void>,
) =>
  session(db.urls.admin, async (query) => {
    await query("begin");
    try {
      await fn(async (sql, values) => {
        await query("savepoint one");
        const refused = await refusal(() => query(sql, values));
        await query(refused === null ? "release savepoint one" : "rollback to savepoint one");
        return refused;
      });
    } finally {
      await query("rollback");
    }
  });

// A row of the anchors table written as pi_admin by hand, under one of the world's decisions.
const insertRow = <T>(
  query: (sql: string, values?: unknown[]) => Promise<T>,
  row: { project: string; kind: string; compartments: string[]; value: string | null; id?: string },
) => {
  const id = row.id ?? testId("pan");
  return query(
    `insert into ${TABLE} (id, project_id, kind, anchor_fp, ruling_id, created_at, compartments, value_enc) values ($1, $2, $3, $4, $5, now(), $6, $7)`,
    [
      id,
      row.project,
      row.kind,
      randomBytes(32).toString("hex"),
      ruling,
      row.compartments,
      row.value === null ? null : JSON.stringify(sealUnder(db.keys, row.compartments, valueAt(id), row.value)),
    ],
  );
};

const resolveThis = async (evidenceId: string) => {
  const item = await pipeline.open(evidenceId as EvidenceId);
  if (item === null) throw new Error("no item");
  return item.context.identity.resolve(THIS, "personal", "r" as never);
};

beforeAll(async () => {
  db = await createTestDatabase();
  const { log } = recordingLogger();
  writer = createWriter({ url: db.urls.writer, keys: db.keys, log });
  pipeline = createPipeline({ url: db.urls.pipeline, keys: db.keys, log });
  admin = createAdmin({ url: db.urls.admin, keys: db.keys, log });
  accounts = await connect(writer);
  const owner = one(await rows<{ id: string }>("select id from knowledge.entities where kind = 'owner'")).id;
  canary = await stored(writer, accounts.personalMail, MAIL.canary);
  solo = await stored(writer, accounts.personalMail, MAIL.solo);
  const workMail = await stored(writer, accounts.workMail, MAIL.workCanary);
  own = await admin.projects.add("Heron survey", { requestId: request() });
  work = await admin.projects.add("Employer survey", { compartment: "employer:example", requestId: request() });
  closed = await admin.projects.add("Finished survey", { requestId: request() });
  const threadAnchor = await admin.projects.anchor(own, await messageOf(canary), { requestId: request() });
  await admin.projects.anchor(work, await messageOf(workMail), { requestId: request() });
  expect(await admin.projects.close(closed, { requestId: request() })).toBe(true);
  // The thread's claim, committed after its anchor, so it is bound to `own`.
  expect(await pipeline.commit(batchOf(canary, [claimRecord(canary, "own", owner)]))).toBe("committed");
  ruling = (await anchorRow(threadAnchor)).ruling_id;
}, 120_000);

afterAll(async () => {
  await admin?.close();
  await pipeline?.close();
  await writer?.close();
  await db?.drop();
});

describe("the project anchors migration: knowledge.project_anchors", () => {
  it("the kind check takes the five device kinds and keeps email_thread and meeting_series", () =>
    rolledBack(async (attempt) => {
      for (const kind of ["app", "host", "url_prefix", "repository", "document", "meeting_series"]) {
        expect(
          await insertRow(attempt, { project: own, kind, compartments: ["own"], value: "kept.example.org" }),
          kind,
        ).toBeNull();
      }
      expect(
        await insertRow(attempt, { project: own, kind: "email_thread", compartments: ["own"], value: null }),
      ).toBeNull();
      for (const kind of ["range", "calendar", "url", "folder", "thread"]) {
        expect(
          await insertRow(attempt, { project: own, kind, compartments: ["own"], value: "kept.example.org" }),
          kind,
        ).toEqual({ code: "23514", constraint: "project_anchors_kind" });
      }
    }));

  it("value_enc is set exactly when the kind is neither email_thread nor window_title", () =>
    rolledBack(async (attempt) => {
      expect(
        await insertRow(attempt, {
          project: own,
          kind: "email_thread",
          compartments: ["own"],
          value: "kept.example.org",
        }),
      ).toEqual({ code: "23514", constraint: "project_anchors_value" });
      expect(
        await insertRow(attempt, { project: own, kind: "email_thread", compartments: ["own"], value: null }),
      ).toBeNull();
      for (const kind of ["app", "host", "url_prefix", "repository", "document", "meeting_series"]) {
        expect(await insertRow(attempt, { project: own, kind, compartments: ["own"], value: null }), kind).toEqual({
          code: "23514",
          constraint: "project_anchors_value",
        });
        expect(
          await insertRow(attempt, { project: own, kind, compartments: ["own"], value: "kept.example.org" }),
          kind,
        ).toBeNull();
      }
      // A window title anchor, as a thread, keeps no value: only its fingerprint.
      expect(
        await insertRow(attempt, {
          project: own,
          kind: "window_title",
          compartments: ["own"],
          value: "kept.example.org",
        }),
      ).toEqual({ code: "23514", constraint: "project_anchors_value" });
      expect(
        await insertRow(attempt, { project: own, kind: "window_title", compartments: ["own"], value: null }),
      ).toBeNull();
    }));

  it("pi_reader reads a live anchor's id, project, kind, fingerprint, sealed value and compartments within its clearance and no row outside it, and writes none", async () => {
    const mine = [
      { project: own, kind: "host", compartments: ["own"], value: "reader.example.org", id: testId("pan") },
      {
        project: work,
        kind: "app",
        compartments: ["employer:example"],
        value: "test.example.reader",
        id: testId("pan"),
      },
      {
        project: own,
        kind: "document",
        compartments: ["employer:example", "own"],
        value: "~/test/reader",
        id: testId("pan"),
      },
    ];
    for (const row of mine) await insertRow((sql, values) => rows(sql, values), row);
    try {
      const ownClient = await insertClient(db, "anchors-own", ["own"]);
      const workClient = await insertClient(db, "anchors-work", ["employer:example"]);
      const bothClient = await insertClient(db, "anchors-both", ["own", "employer:example"]);
      const COLUMNS = "id, project_id, kind, anchor_fp, value_enc, lifted_at, compartments";
      const seenBy = (token: string | null) =>
        readAs(db, token, (query) =>
          query<{
            id: string;
            project_id: string;
            kind: string;
            anchor_fp: string;
            value_enc: unknown;
            compartments: string[];
          }>(`select ${COLUMNS} from ${TABLE} where lifted_at is null order by id`),
        );
      const expected = async (clearance: string[]) =>
        (
          await rows<{ id: string }>(
            `select id from ${TABLE} where lifted_at is null and compartments <@ $1 order by id`,
            [clearance],
          )
        ).map((row) => row.id);
      // Every live row within the clearance, the world's thread anchors among them, and none outside.
      for (const [client, clearance] of [
        [ownClient, ["own"]],
        [workClient, ["employer:example"]],
        [bothClient, ["own", "employer:example"]],
      ] as const) {
        const seen = await seenBy(client.token);
        expect(
          seen.map((row) => row.id),
          client.name,
        ).toEqual(await expected([...clearance]));
        expect(seen.length, client.name).toBeGreaterThan(0);
      }
      const ownSeen = await seenBy(ownClient.token);
      expect(ownSeen.map((row) => row.id)).toContain(mine[0]?.id);
      expect(ownSeen.map((row) => row.id)).not.toContain(mine[1]?.id);
      expect(ownSeen.map((row) => row.id)).not.toContain(mine[2]?.id);
      expect((await seenBy(bothClient.token)).map((row) => row.id)).toEqual(
        expect.arrayContaining(mine.map((row) => row.id)),
      );
      // The sealed value is read as it is stored, and opens under the row's compartments.
      const host = ownSeen.find((row) => row.id === mine[0]?.id);
      expect(host).toMatchObject({ project_id: own, kind: "host", compartments: ["own"] });
      expect(openUnder(db.keys, ["own"], valueAt(mine[0]?.id ?? ""), Envelope.parse(host?.value_enc))).toBe(
        "reader.example.org",
      );
      // No token, no row.
      expect(await seenBy(null)).toEqual([]);
      // Seven columns, never more.
      for (const column of ["ruling_id", "created_at", "*"]) {
        expect(
          await sqlState(() => readAs(db, ownClient.token, (query) => query(`select ${column} from ${TABLE}`))),
          column,
        ).toBe("42501");
      }
      // No write, with the read beside it as the control.
      for (const sql of [
        `insert into ${TABLE} (id, project_id, kind, anchor_fp, ruling_id, created_at, compartments, value_enc) values ('${testId("pan")}', '${own}', 'host', '${"a".repeat(64)}', '${ruling}', now(), '{own}', '{}')`,
        `update ${TABLE} set lifted_at = now()`,
        `delete from ${TABLE}`,
      ]) {
        expect(await sqlState(() => readAs(db, ownClient.token, (query) => query(sql))), sql).toBe("42501");
      }
      expect(
        await sqlState(() => readAs(db, ownClient.token, (query) => query(`select ${COLUMNS} from ${TABLE}`))),
      ).toBeNull();
      const [policy] = await rows<{ roles: string[]; cmd: string; qual: string }>(
        "select roles::text[] as roles, cmd, qual from pg_policies where schemaname = 'knowledge' and tablename = 'project_anchors' and policyname = 'pi_reader_select'",
      );
      expect(policy).toMatchObject({ roles: ["pi_reader"], cmd: "SELECT" });
      expect(policy?.qual).toMatch(/compartments\s*<@\s*\(\s*SELECT\s+(policy\.)?client_clearance\(\)/i);
      expect(policy?.qual).toMatch(
        /(policy\.)?label_key\(compartments\)\s*=\s*ANY\s*\(\s*\(\s*SELECT\s+(policy\.)?clearance_keys\(\)/i,
      );
    } finally {
      await rows(`delete from ${TABLE} where id = any($1)`, [mine.map((row) => row.id)]);
    }
  });

  it("pi_writer reads no anchor", async () => {
    expect(await sqlState(() => queryAs(db.urls.writer, `select id from ${TABLE}`))).toBe("42501");
    expect(await sqlState(() => queryAs(db.urls.writer, `select value_enc from ${TABLE}`))).toBe("42501");
    expect(await sqlState(() => queryAs(db.urls.writer, "select id from knowledge.project_bindings"))).toBeNull();
  });

  it("pi_pipeline's read is unchanged", async () => {
    // Every column of every row not restricted, in both compartments, and no write.
    const seen = await queryAs<{ compartments: string[] }>(
      db.urls.pipeline,
      `select id, project_id, kind, anchor_fp, ruling_id, created_at, lifted_at, value_enc, compartments from ${TABLE}`,
    );
    expect(new Set(seen.map((row) => row.compartments.join("|")))).toEqual(new Set(["own", "employer:example"]));
    for (const privilege of ["INSERT", "UPDATE", "DELETE"]) {
      expect(
        one(
          await rows<{ held: boolean }>(`select has_table_privilege('pi_pipeline', '${TABLE}', $1) as held`, [
            privilege,
          ]),
        ).held,
        privilege,
      ).toBe(false);
    }
    expect(
      one(await rows<{ held: boolean }>(`select has_table_privilege('pi_pipeline', '${TABLE}', 'SELECT') as held`))
        .held,
    ).toBe(true);
    expect(await sqlState(() => queryAs(db.urls.pipeline, `update ${TABLE} set lifted_at = now()`))).toBe("42501");
  });
});

describe("the owner's device anchors", () => {
  it("each kind is stored with one owner decision of kind project_anchor, its compartments the project's, its value sealed and its key fingerprinted under the anchor kind", async () => {
    const before = await counts();
    const given: { input: DeviceAnchorInput; key: string }[] = [
      { input: { kind: "app", value: "test.Example.Survey" }, key: "app:test.example.survey" },
      { input: { kind: "host", value: "Survey.Example.org" }, key: "host:survey.example.org" },
      {
        input: { kind: "url_prefix", value: "https://wiki.example.org/teams/survey" },
        key: "url:wiki.example.org/teams/survey",
      },
      {
        input: { kind: "repository", value: "git.example.org/owner/survey" },
        key: "repository:git.example.org/owner/survey",
      },
      { input: { kind: "document", value: "~/test/survey/" }, key: "document:~/test/survey" },
    ];
    const ids: string[] = [];
    for (const { input, key } of given) {
      const id = await anchor(work, input);
      expect(id).toMatch(/^pan_[0-9A-HJKMNP-TV-Z]{26}$/);
      ids.push(id);
      const row = await anchorRow(id);
      expect(row).toMatchObject({
        project_id: work,
        kind: "kind" in input ? input.kind : "meeting_series",
        anchor_fp: anchorFp(key),
        lifted_at: null,
        compartments: ["employer:example"],
      });
      expect(opened(row)).toBe(sealedPart(key));
      expect(await decision(row.ruling_id)).toEqual({
        kind: "project_anchor",
        target_id: work,
        compartments: ["employer:example"],
      });
    }
    expect(await counts()).toEqual({
      decisions: before.decisions + given.length,
      anchors: before.anchors + given.length,
    });
    // No value is held in clear, in the anchors or in their decisions.
    const clear = JSON.stringify([
      await rows(`select * from ${TABLE}`),
      await rows("select * from knowledge.owner_decisions"),
    ]);
    for (const needle of ["survey.example.org", "test.example.survey", "teams/survey", "owner/survey", "~/test/survey"])
      expect(clear, needle).not.toContain(needle);
    // The list opens each value for the owner, beside the thread anchor, which has none.
    const listed = (await admin.projects.list()).find((project) => project.id === work);
    expect(
      listed?.anchors.filter((one) => ids.includes(one.id)).map(({ id, kind, value }) => ({ id, kind, value })),
    ).toEqual(
      given.map(({ input, key }, index) => ({
        id: ids[index],
        kind: "kind" in input ? input.kind : "meeting_series",
        value: sealedPart(key),
      })),
    );
    expect(listed?.anchors.find((one) => one.kind === "email_thread")).toMatchObject({ value: null });
  });

  it("the same key on another active project is anchor_taken, and on a closed project's lifted anchor it is accepted", async () => {
    expect(await anchor(own, { kind: "host", value: "taken.example.org" })).toMatch(/^pan_/);
    const before = await counts();
    // The same key, however it is written, on another active project, of either compartment.
    for (const value of ["taken.example.org", "Taken.Example.org.", "taken.example.org:8443"]) {
      await expect(anchor(work, { kind: "host", value }), value).rejects.toMatchObject({ code: "anchor_taken" });
    }
    expect(await counts()).toEqual(before);
    // Overlapping anchors are allowed: a URL prefix under the host, on the other project.
    expect(await anchor(work, { kind: "url_prefix", value: "https://taken.example.org/teams" })).toMatch(/^pan_/);

    // A project that held two keys, lifted one and was closed: neither key is taken.
    const ended = await admin.projects.add("Ended survey", { requestId: request() });
    const lifted = await anchor(ended, { kind: "host", value: "lifted.example.org" });
    await anchor(ended, { kind: "app", value: "test.example.ended" });
    expect(await admin.projects.unanchor(lifted, { requestId: request() })).toBe(true);
    expect(await admin.projects.close(ended, { requestId: request() })).toBe(true);
    expect(await anchor(own, { kind: "host", value: "lifted.example.org" })).toMatch(/^pan_/);
    expect(await anchor(own, { kind: "app", value: "test.example.ended" })).toMatch(/^pan_/);
  });

  it("a closed project takes no anchor (not_found)", async () => {
    const before = await counts();
    await expect(anchor(closed, { kind: "host", value: "closed.example.org" })).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      anchor(`ent_${"0".repeat(26)}` as EntityId, { kind: "host", value: "closed.example.org" }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await counts()).toEqual(before);
    // The control: an active project takes the same value.
    expect(await anchor(own, { kind: "host", value: "closed.example.org" })).toMatch(/^pan_/);
    expect(await counts()).toEqual({ decisions: before.decisions + 1, anchors: before.anchors + 1 });
  });

  // The captures: a meeting with a calendar UID, one with no calendar entry, a moment, each under
  // `own`, and an `employer:example` meeting with a UID.
  it("--series-of a stored meeting takes its calendar UID; of a meeting with no calendar entry, of a moment, and of a cap_ id the admin cannot find, no_series; of an employer:example meeting for an own project, compartment_mismatch", async () => {
    const uid = "series-survey@example.com";
    const meeting = await seedCapture(db, ["own"], "meeting", uid);
    const id = await anchor(own, { seriesOf: meeting });
    const row = await anchorRow(id);
    expect(row).toMatchObject({
      project_id: own,
      kind: "meeting_series",
      anchor_fp: anchorFp(`series:${uid}`),
      compartments: ["own"],
    });
    expect(opened(row)).toBe(uid);
    expect(await decision(row.ruling_id)).toEqual({ kind: "project_anchor", target_id: own, compartments: ["own"] });

    const before = await counts();
    await expect(anchor(own, { seriesOf: await seedCapture(db, ["own"], "meeting") })).rejects.toMatchObject({
      code: "no_series",
    });
    await expect(anchor(own, { seriesOf: await seedCapture(db, ["own"], "moment") })).rejects.toMatchObject({
      code: "no_series",
    });
    await expect(anchor(own, { seriesOf: `cap_${"0".repeat(26)}` as CaptureId })).rejects.toMatchObject({
      code: "no_series",
    });
    const workMeeting = await seedCapture(db, ["employer:example"], "meeting", "series-employer@example.com");
    await expect(anchor(own, { seriesOf: workMeeting })).rejects.toMatchObject({ code: "compartment_mismatch" });
    expect(await counts()).toEqual(before);
    // The control: the project of the meeting's compartment takes it.
    const taken = await anchorRow(await anchor(work, { seriesOf: workMeeting }));
    expect(taken).toMatchObject({
      kind: "meeting_series",
      anchor_fp: anchorFp("series:series-employer@example.com"),
      compartments: ["employer:example"],
    });
  });

  it("unanchor lifts a device anchor with one decision of kind project_unanchor, and a lifted anchor is listed no more", async () => {
    const id = await anchor(own, { kind: "document", value: "~/test/heron/notes" });
    const listed = async () =>
      (await admin.projects.list()).find((project) => project.id === own)?.anchors.map((one) => one.id) ?? [];
    expect(await listed()).toContain(id);
    const before = await counts();
    expect(await admin.projects.unanchor(id, { requestId: request() })).toBe(true);
    expect(await counts()).toEqual({ decisions: before.decisions + 1, anchors: before.anchors });
    const [lift] = await rows<{ kind: string; target_id: string; compartments: string[] }>(
      "select kind, target_id, compartments from knowledge.owner_decisions order by decided_at desc, id desc limit 1",
    );
    expect(lift).toEqual({ kind: "project_unanchor", target_id: own, compartments: ["own"] });
    expect((await anchorRow(id)).lifted_at).not.toBeNull();
    expect(await listed()).not.toContain(id);
    // Lifted once: a second lift finds nothing and writes nothing.
    expect(await admin.projects.unanchor(id, { requestId: request() })).toBe(false);
    expect(await counts()).toEqual({ decisions: before.decisions + 1, anchors: before.anchors });
  });

  it("every kept vector of ANCHOR_VECTORS is stored at its key, and the anchor_fp is the anchor fingerprint of that key; a window title's with no value", async () => {
    const kept = ANCHOR_VECTORS.flatMap((vector) =>
      "key" in vector && vector.kind !== "meeting_series" ? [vector] : [],
    );
    expect(kept.length).toBeGreaterThan(10);
    for (const vector of kept) {
      const id = await anchor(own, {
        kind: vector.kind as Exclude<typeof vector.kind, "meeting_series">,
        value: vector.value,
      });
      const row = await anchorRow(id);
      // A window title anchor keeps its fingerprint alone, never its title.
      const titled = vector.kind === "window_title";
      expect(
        { kind: row.kind, anchor_fp: row.anchor_fp, value: titled ? row.value_enc : opened(row) },
        vector.value,
      ).toEqual({
        kind: vector.kind,
        anchor_fp: anchorFp(vector.key),
        value: titled ? null : sealedPart(vector.key),
      });
      // Lifted again, so the next spelling of the same key starts clean.
      expect(await admin.projects.unanchor(id, { requestId: request() })).toBe(true);
    }
  });

  it("every refused vector is generic_anchor or bad_anchor and writes no decision", async () => {
    type Kind = Exclude<DeviceAnchorInput, { seriesOf: CaptureId }>["kind"];
    const refused: { kind: Kind; value: string; code: "generic_anchor" | "bad_anchor" }[] = [
      // Products: browsers, multi-account apps and hosts, generic apps and hosts.
      ...[...BROWSER_BUNDLES, ...MULTI_ACCOUNT_SURFACES.bundles, ...GENERIC_APPS].map((value) => ({
        kind: "app" as const,
        value,
        code: "generic_anchor" as const,
      })),
      ...[...MULTI_ACCOUNT_SURFACES.hosts, ...GENERIC_HOSTS].map((value) => ({
        kind: "host" as const,
        value,
        code: "generic_anchor" as const,
      })),
      { kind: "app", value: "com.google.Chrome", code: "generic_anchor" },
      { kind: "app", value: "us.zoom.xos", code: "generic_anchor" },
      { kind: "host", value: "zoom.us", code: "generic_anchor" },
      { kind: "host", value: "github.com", code: "generic_anchor" },
      { kind: "host", value: "localhost", code: "generic_anchor" },
      { kind: "host", value: "192.0.2.10", code: "bad_anchor" },
      { kind: "url_prefix", value: "https://plans.example.com/", code: "generic_anchor" },
      { kind: "url_prefix", value: "https://github.com/example-org", code: "generic_anchor" },
      { kind: "url_prefix", value: "https://github.com/example-org/issues", code: "generic_anchor" },
      { kind: "url_prefix", value: "https://docs.google.com/document/d", code: "generic_anchor" },
      { kind: "repository", value: "git.example.org/owner", code: "generic_anchor" },
      { kind: "repository", value: "docs.google.com/document/d", code: "generic_anchor" },
      { kind: "repository", value: "git.example.org/issues/name", code: "generic_anchor" },
      { kind: "repository", value: "git.example.org/owner/wiki", code: "generic_anchor" },
      { kind: "document", value: "~", code: "generic_anchor" },
      { kind: "document", value: "~/Documents", code: "generic_anchor" },
      { kind: "document", value: "/Users/x", code: "generic_anchor" },
      // And every refused vector of the contracts' list, but the series, which is never a value.
      ...ANCHOR_VECTORS.flatMap((vector) =>
        "refused" in vector && vector.kind !== "meeting_series"
          ? [{ kind: vector.kind as Kind, value: vector.value, code: vector.refused }]
          : [],
      ),
    ];
    const before = await counts();
    for (const { kind, value, code } of refused)
      await expect(anchor(own, { kind, value }), `${kind} ${value}`).rejects.toMatchObject({ code });
    expect(await counts()).toEqual(before);
    // The control: a value that is no product, of each kind, is taken, one decision each.
    for (const [kind, value] of [
      ["app", "test.example.control"],
      ["host", "control.example.org"],
      ["url_prefix", "https://github.com/example-org/control"],
      ["repository", "git.example.org/owner/control"],
      ["document", "~/test/control"],
    ] as const) {
      expect(await anchor(own, { kind, value }), value).toMatch(/^pan_/);
    }
    expect(await counts()).toEqual({ decisions: before.decisions + 5, anchors: before.anchors + 5 });
  });

  it("a device anchor binds no mail claim: anchoring a host the world's thread mentions changes no claim, binding or waiting mark, and the projects port resolves project:this as before", async () => {
    const state = async () => ({
      claims: await rows("select id, evidence_id from knowledge.claims order by id"),
      bindings: await rows(
        "select id, claim_id, project_id, anchor_kind, anchor_fp from knowledge.project_bindings order by id",
      ),
      items: await rows("select evidence_id, waiting, withheld from vault.pipeline_items order by evidence_id"),
    });
    const before = await state();
    expect(before.bindings).toHaveLength(1);
    expect(await resolveThis(canary)).toEqual({ outcome: "linked", entity: own, epoch: 0 });
    // The canary's domain, on a second `own` project and on the thread's own project.
    const rival = await admin.projects.add("Harbor survey", { requestId: request() });
    expect(await anchor(rival, { kind: "host", value: "harbor-canary.test" })).toMatch(/^pan_/);
    expect(await anchor(own, { kind: "url_prefix", value: "https://harbor-canary.test/heron" })).toMatch(/^pan_/);
    expect(await state()).toEqual(before);
    expect(await resolveThis(canary)).toEqual({ outcome: "linked", entity: own, epoch: 0 });
    // The control: another thread is still no project's.
    expect(await resolveThis(solo)).toEqual({ outcome: "not_a_person" });
  });
});
