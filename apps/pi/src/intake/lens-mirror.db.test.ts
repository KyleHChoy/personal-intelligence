import { randomBytes } from "node:crypto";
import { evidenceIdFor } from "@intelligence/contracts/evidence-id";
import {
  ErasureReport,
  ExposureListView,
  LensDeviceView,
  MirrorPage,
  REFUSAL_CODE_HINTS,
  SourceAccountId,
  type SyncMirrorArgs,
} from "@intelligence/contracts/personal";
import { sha256 } from "@intelligence/personal-core";
import { createRoutes } from "@intelligence/personal-mcp";
import { createWork, Reader } from "@intelligence/personal-store";
import { fingerprint, queryAs, sealRow, type TestDatabase } from "@intelligence/personal-store/testing";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { builtOnce, pi, quiet, type Synced } from "../test-support/extract-fixtures.ts";

// The mirror at `pi http` and at the owner's commands. The reader's rules are the store's
// mirror-sync.db.test.ts and mirror-gate.db.test.ts.
//
// The synced world is built once with two devices registered by `pi lens add` (one cleared for
// own, one for own and employer:example) and a stored meeting of the first, and each test gets a
// copy (builtOnce). The world's times are the real clock's, as the database's are; the reader's
// clock is injected and moved past PI_MIRROR_PASS_SECONDS (3 600) where a test needs the next
// pass, so nothing waits. Reserved domains, synthetic names.

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const T = Date.now();
const PASS_SECONDS = 3_600;
const OWN = ["own"];
const BOTH = ["employer:example", "own"];
const ARGS = { templates: ["lens_mirror@1"], cursor: null } as SyncMirrorArgs;
const ulid = (): string => [...randomBytes(26)].map((byte) => "0123456789ABCDEFGHJKMNPQRSTVWXYZ"[byte % 32]).join("");

type Device = { name: string; id: string; token: string };
type Made = { mac: Device; wide: Device; meeting: { id: string; key: string; evidence: string } };

// A stored meeting of the device, as the drain leaves it, written as pi_admin.
async function meetingOf(db: TestDatabase, account: string): Promise<Made["meeting"]> {
  const key = `meeting:${ulid()}`;
  const source = { vault: "personal" as const, sourceAccount: SourceAccountId.parse(account), sourceItemId: key };
  const evidence = evidenceIdFor({ ...source, revision: 0 });
  const blob = `blb_${ulid()}`;
  const id = `cap_${ulid()}`;
  const sealed = (table: string, row: string, column: string, value: string): string =>
    JSON.stringify(sealRow(db.keys, "own", { table, id: row, column }, value));
  const started = new Date(T - 2 * 86_400_000).toISOString();
  const ended = new Date(T - 2 * 86_400_000 + 1_800_000).toISOString();
  await queryAs(
    db.urls.admin,
    "insert into vault.evidence_blobs (blob_ref, envelope, compartments) values ($1, $2::jsonb, '{own}')",
    [blob, sealed("vault.evidence_blobs", blob, "envelope", Buffer.from("canary-pi-mirror-words").toString("base64"))],
  );
  await queryAs(
    db.urls.admin,
    `insert into vault.evidence_items (id, source_account_id, source_kind, source_item_fp, revision_tag_fp, revision, next_revision_id, content_hash, media_type,
       observed_at, change_kind, participant_members, system_originated, answers_system, payload_state, compartments, readers, blob_ref, item_enc)
     values ($1, $2, 'transcript', $3, $4, 0, $5, $6, 'application/json', $7, 'live', '{m-owner}', false, false, 'present', '{own}', '{m-owner}', $8, $9::jsonb)`,
    [
      evidence,
      account,
      fingerprint(db.keys, "source_id", key),
      fingerprint(db.keys, "revision_tag", `h:${key}`),
      evidenceIdFor({ ...source, revision: 1 }),
      sha256(`pi mirror ${key}`),
      started,
      blob,
      sealed("vault.evidence_items", evidence, "item_enc", JSON.stringify({ sourceItemId: key, markers: [] })),
    ],
  );
  await queryAs(
    db.urls.admin,
    `insert into knowledge.captures (id, evidence_id, source_account_id, capture_key, revision, kind, started_at, ended_at, first_pushed_at, local_day, facts_enc, compartments)
     values ($1, $2, $3, $4, 0, 'meeting', $5, $6, $6, $7, $8::jsonb, '{own}')`,
    [
      id,
      evidence,
      account,
      key,
      started,
      ended,
      started.slice(0, 10),
      sealed("knowledge.captures", id, "facts_enc", JSON.stringify({ title: "canary-pi-mirror-title" })),
    ],
  );
  return { id, key, evidence };
}

const fixture = builtOnce<Made>(async (s) => {
  const add = async (name: string, compartments: string[]): Promise<Device> => {
    const added = await pi(["lens", "add", name, "--compartments", compartments.join(",")], s.admin, { tty: true });
    expect(added).toMatchObject({ exit: 0, stderr: "" });
    // The mirror's first token is `lens rotate --mirror`'s.
    const issued = await pi(["lens", "rotate", name, "--mirror"], s.admin, { tty: true });
    expect(issued).toMatchObject({ exit: 0, stderr: "" });
    const tokens = { mirror: issued.stdout.trimEnd() };
    const [client] = await queryAs<{ id: string }>(s.db.urls.admin, "select id from policy.clients where name = $1", [
      name,
    ]);
    return { name, id: client?.id ?? "", token: tokens.mirror };
  };
  const mac = await add("mac", OWN);
  const wide = await add("mac-wide", BOTH);
  const [account] = await queryAs<{ id: string }>(
    s.db.urls.admin,
    "select id from vault.source_accounts where label = 'device:mac' and connector = 'lens_meetings'",
  );
  return { mac, wide, meeting: await meetingOf(s.db, account?.id ?? "") };
});

// ---------------------------------------------------------------------------------------------
// A test's copy, its reader and its routes
// ---------------------------------------------------------------------------------------------

type Stack = {
  s: Synced;
  made: Made;
  clock: { at: number };
  reader: Reader;
  routes: ReturnType<typeof createRoutes>;
  sql<Row = Record<string, unknown>>(text: string, values?: unknown[]): Promise<Row[]>;
};
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close().catch(() => {});
});

async function stack(): Promise<Stack> {
  const { s, made } = await fixture();
  closers.push(() => s.drop());
  const clock = { at: T };
  const pool = new pg.Pool({ connectionString: s.db.urls.reader, max: 3 });
  closers.push(() => pool.end());
  const reader = new Reader({ pool, keys: s.db.keys, log: quiet, now: () => new Date(clock.at) });
  return {
    s,
    made,
    clock,
    reader,
    routes: createRoutes({ provider: reader, work: createWork({ reader, log: quiet }) }, quiet),
    sql: (text, values) => queryAs(s.db.urls.admin, text, values),
  };
}

const rest = (st: Stack, token: string, args: unknown) =>
  st.routes({
    method: "POST",
    path: "/v1/tools/sync_mirror",
    authorization: `Bearer ${token}`,
    address: "203.0.113.1",
    body: JSON.stringify(args),
  });
type Call = { cursor?: string | null; templates?: string[]; limit?: number; erasedDone?: string[] };
const page = async (st: Stack, token: string, args: Call = {}): Promise<MirrorPage> => {
  const answer = await st.reader.syncMirror(token, { ...ARGS, ...args } as SyncMirrorArgs);
  if (!answer.ok) throw new Error(`sync_mirror answered ${answer.code}`);
  return MirrorPage.parse(answer.value);
};
async function fullPass(
  st: Stack,
  token: string,
  cursor: string | null,
): Promise<{ pages: MirrorPage[]; cursor: string }> {
  const pages: MirrorPage[] = [];
  let next = cursor;
  // Each call makes progress, as little as one row on a slow machine: this only stops a pass that never ends.
  for (let n = 0; n < 2_000; n += 1) {
    const one = await page(st, token, { cursor: next });
    pages.push(one);
    next = one.cursor;
    if (one.passComplete) return { pages, cursor: next };
  }
  throw new Error("no pass completed");
}
async function due(st: Stack, client: string): Promise<void> {
  const [row] = await st.sql<{ completed: Date | null }>(
    "select max(completed_at) as completed from ledger.mirror_cursors where client_id = $1",
    [client],
  );
  if (row?.completed === null || row?.completed === undefined) throw new Error("no completed pass");
  st.clock.at = Math.max(st.clock.at, row.completed.getTime() + PASS_SECONDS * 1000 + 1000);
}
type Row = {
  id: string;
  audience: string[];
  ended_at: Date | null;
  reason: string | null;
  confirmed_state: string | null;
  sent_state: string;
};
const rowsOf = (st: Stack, client: string): Promise<Row[]> =>
  st.sql<Row>(
    "select id, audience, ended_at, reason, confirmed_state, sent_state from ledger.mirror_entries where client_id = $1 order by id",
    [client],
  );
const live = async (st: Stack, client: string): Promise<Row[]> =>
  (await rowsOf(st, client)).filter((row) => row.ended_at === null);

type OpenApi = { paths: Record<string, { post: { responses: Record<string, unknown> } }> };

// ---------------------------------------------------------------------------------------------
// pi http
// ---------------------------------------------------------------------------------------------

describe("the mirror at pi http", () => {
  it("stale_cursor answers 409 stale_cursor over REST, and the OpenAPI document lists it for sync_mirror", async () => {
    const st = await stack();
    const { mac } = st.made;
    // The control: a null cursor is a page.
    const first = await rest(st, mac.token, ARGS);
    expect(first.status).toBe(200);
    const cursor = MirrorPage.parse(JSON.parse(first.body)).cursor;
    expect((await rest(st, mac.token, { ...ARGS, cursor })).status).toBe(200);
    // A cursor that is neither the latest nor the one before it.
    expect(await rest(st, mac.token, { ...ARGS, cursor: `mcr_${ulid()}` })).toEqual({
      status: 409,
      body: '{"error":"stale_cursor"}',
      type: "application/json",
    });
    // The OpenAPI document of a client with sync_mirror and another tool: sync_mirror's
    // responses gain 409 and 406, and the other tool's keep today's.
    await st.sql("update policy.clients set tools = '{sync_mirror,get_self}' where id = $1", [mac.id]);
    const spec = JSON.parse(
      (
        await st.routes({
          method: "GET",
          path: "/openapi.json",
          authorization: `Bearer ${mac.token}`,
          address: "203.0.113.1",
          body: "",
        })
      ).body,
    ) as OpenApi;
    // sync_mirror's own two codes are listed for it and for no other tool; the codes every tool
    // lists are http.test.ts's to pin.
    const mirror = Object.keys(spec.paths["/v1/tools/sync_mirror"]?.post.responses ?? {});
    const other = Object.keys(spec.paths["/v1/tools/get_self"]?.post.responses ?? {});
    expect(mirror).toEqual(expect.arrayContaining(["200", "400", "403", "404", "406", "409", "429", "503"]));
    expect(other).toEqual(expect.arrayContaining(["200", "400", "403", "404", "429", "503"]));
    expect(mirror.filter((code) => !other.includes(code)).sort()).toEqual(["406", "409"]);
  });

  it("unsupported_template answers 406 unsupported_template over REST, and the OpenAPI document lists it for sync_mirror", async () => {
    const st = await stack();
    const { mac } = st.made;
    expect(await rest(st, mac.token, { ...ARGS, templates: ["lens_mirror@9"] })).toEqual({
      status: 406,
      body: '{"error":"unsupported_template"}',
      type: "application/json",
    });
    expect(await st.sql("select id from ledger.mirror_entries")).toEqual([]);
    // The control: a version the server knows.
    expect((await rest(st, mac.token, { ...ARGS, templates: ["lens_mirror@9", "lens_mirror@1"] })).status).toBe(200);
    const spec = JSON.parse(
      (
        await st.routes({
          method: "GET",
          path: "/openapi.json",
          authorization: `Bearer ${mac.token}`,
          address: "203.0.113.1",
          body: "",
        })
      ).body,
    ) as OpenApi;
    expect(spec.paths["/v1/tools/sync_mirror"]?.post.responses).toHaveProperty("406");
  });

  it("pi lens revoke ends the mirror client's live rows in the revocation's transaction, and its token answers unauthorized", async () => {
    const st = await stack();
    const { mac, wide } = st.made;
    await fullPass(st, mac.token, null);
    await fullPass(st, wide.token, null);
    const theirs = await rowsOf(st, wide.id);
    const ours = await live(st, mac.id);
    expect(ours.length).toBeGreaterThan(0);
    expect(await pi(["lens", "revoke", "mac"], st.s.admin)).toEqual({ exit: 0, stdout: "", stderr: "" });
    // Every live row of the client ended withdrawn by the command, before any call.
    const after = await rowsOf(st, mac.id);
    for (const row of ours)
      expect(after.find((one) => one.id === row.id)).toMatchObject({ reason: "withdrawn", ended_at: expect.any(Date) });
    // Nothing more is served: the token answers unauthorized, over REST 403 not_permitted.
    expect(await st.reader.syncMirror(mac.token, ARGS)).toEqual({ ok: false, code: "unauthorized" });
    expect(await rest(st, mac.token, ARGS)).toEqual({
      status: 403,
      body: JSON.stringify({ error: "not_permitted", hint: REFUSAL_CODE_HINTS.not_permitted }),
      type: "application/json",
    });
    // The control: the other device's rows are untouched.
    expect(await rowsOf(st, wide.id)).toEqual(theirs);
  });

  it("pi status and pi lens list show each device's live and unconfirmed mirror rows and its last completed pass", async () => {
    const st = await stack();
    const { mac } = st.made;
    const viewOf = async (): Promise<{ status: LensDeviceView; listed: LensDeviceView }> => {
      const status = await pi(["status"], st.s.admin);
      expect(status).toMatchObject({ exit: 0, stderr: "" });
      const listed = await pi(["lens", "list"], st.s.admin);
      expect(listed).toMatchObject({ exit: 0, stderr: "" });
      const fromStatus = (JSON.parse(status.stdout) as { devices: unknown[] }).devices
        .map((one) => LensDeviceView.parse(one))
        .find((one) => one.name === "mac");
      const fromList = (JSON.parse(listed.stdout) as unknown[])
        .map((one) => LensDeviceView.parse(one))
        .find((one) => one.name === "mac");
      if (fromStatus === undefined || fromList === undefined) throw new Error("no device mac");
      for (const canary of ["canary-pi-mirror-title", "canary-pi-mirror-words"])
        expect(status.stdout + listed.stdout).not.toContain(canary);
      return { status: fromStatus, listed: fromList };
    };
    // Before any call: no row and no pass.
    expect((await viewOf()).status).toMatchObject({ mirrorEntries: 0, unconfirmed: 0, lastPassAt: null });
    // A whole pass whose last page the Mac has not yet confirmed.
    const { pages, cursor } = await fullPass(st, mac.token, null);
    const [cursorRow] = await st.sql<{ completed_at: Date }>(
      "select completed_at from ledger.mirror_cursors where id = $1",
      [cursor],
    );
    const rows = await live(st, mac.id);
    const last = pages.at(-1)?.entries.length ?? 0;
    expect(last).toBeGreaterThan(0);
    const seen = await viewOf();
    for (const view of [seen.status, seen.listed]) {
      expect(view.mirrorEntries).toBe(rows.length);
      expect(view.unconfirmed).toBe(last);
      expect(Date.parse(view.lastPassAt ?? "")).toBe(cursorRow?.completed_at.getTime());
    }
    // Confirmed by the next cursor: none unconfirmed.
    await page(st, mac.token, { cursor });
    expect((await viewOf()).status).toMatchObject({ mirrorEntries: rows.length, unconfirmed: 0 });
  });
});

// ---------------------------------------------------------------------------------------------
// The owner's commands
// ---------------------------------------------------------------------------------------------

describe("the mirror at the owner's commands", () => {
  it("L11: after pi clients set-compartments widens the client, and after a narrowing, the next call removes every old row replaced before any entry, and the following pass completes", async () => {
    const st = await stack();
    const { mac } = st.made;
    let { cursor } = await fullPass(st, mac.token, null);
    // The widening goes through pi clients set-compartments. That command widens only and refuses a
    // narrowing with would_narrow, and no command narrows a registration in place, so the narrowing
    // is written to policy.clients directly.
    const changes: { compartments: string[]; change: () => Promise<void> }[] = [
      {
        compartments: BOTH,
        change: async () => {
          expect(
            await pi(["clients", "set-compartments", "mac", "--compartments", BOTH.join(",")], st.s.admin),
          ).toMatchObject({ exit: 0 });
        },
      },
      {
        compartments: OWN,
        change: async () => {
          await st.sql("update policy.clients set compartments = $2 where id = $1", [mac.id, OWN]);
        },
      },
    ];
    for (const { compartments, change } of changes) {
      const old = (await live(st, mac.id)).map((row) => row.id);
      expect(old.length).toBeGreaterThan(0);
      await change();
      // A page holds at most `limit` removals and the replaced removals drain across calls: pages
      // are read until one holds none.
      const drained: MirrorPage[] = [];
      let next = await page(st, mac.token, { cursor, limit: 500 });
      for (let n = 0; next.removals.length > 0; n += 1) {
        if (n === 20) throw new Error("the removals did not drain in 20 calls");
        drained.push(next);
        next = await page(st, mac.token, { cursor: next.cursor, limit: 500 });
      }
      const removals = drained.flatMap((one) => one.removals);
      expect(removals.map((removal) => removal.projection).sort()).toEqual([...old].sort());
      for (const removal of removals) expect(removal.reason).toBe("replaced");
      // No entry before the last removal: every page before the one that holds it carries none.
      for (const one of drained.slice(0, -1)) expect(one.entries).toEqual([]);
      await due(st, mac.id);
      const pass = await fullPass(st, mac.token, next.cursor);
      expect(pass.pages.at(-1)?.passComplete).toBe(true);
      const now = await live(st, mac.id);
      expect(now.length).toBeGreaterThan(0);
      for (const row of now) expect(row.audience).toEqual(compartments);
      expect(now.map((row) => row.id).filter((id) => old.includes(id))).toEqual([]);
      // The Mac confirms the pass's last page before the owner's next change, with the clock at the
      // pass's completion: a call PI_MIRROR_PASS_SECONDS after it would start the next pass.
      const [done] = await st.sql<{ completed_at: Date | null }>(
        "select completed_at from ledger.mirror_cursors where id = $1",
        [pass.cursor],
      );
      if (done?.completed_at === null || done?.completed_at === undefined)
        throw new Error("the pass's cursor holds no completion");
      st.clock.at = done.completed_at.getTime();
      cursor = (await page(st, mac.token, { cursor: pass.cursor })).cursor;
    }
  });

  it("L13: pi erase exposures lists the mirror client", async () => {
    const st = await stack();
    const { mac } = st.made;
    const { pages } = await fullPass(st, mac.token, null);
    // A person whose entry the mirror holds.
    const person = pages
      .flatMap((one) => one.entries)
      .find((entry) => entry.section === "entities" && entry.entity.kind === "person");
    const id = person?.section === "entities" ? person.entity.id : "";
    expect(id).toMatch(/^ent_/);
    const erased = await pi(["erase", "person", id], st.s.admin);
    expect(erased.exit).toBe(0);
    const report = ErasureReport.parse(JSON.parse(erased.stdout));
    expect(report.more.mirror).toBe(1);
    const listed = await pi(["erase", "exposures", report.erasure ?? ""], st.s.admin);
    expect(listed).toMatchObject({ exit: 0, stderr: "" });
    const view = ExposureListView.parse(JSON.parse(listed.stdout));
    expect(view.recipients).toContainEqual(expect.objectContaining({ kind: "client", id: mac.id }));
    // The control: the other device, which synced nothing, is not listed.
    expect(view.recipients.map((one) => one.id)).not.toContain(st.made.wide.id);
  });

  it("L28: pi erase item cap_ serves the key until erasedDone lists it; a key not listed done is served again; a person's erasure serves none", async () => {
    const st = await stack();
    const { mac, meeting } = st.made;
    const first = await fullPass(st, mac.token, null);
    expect(JSON.stringify(first.pages)).toContain(meeting.id);
    expect((await pi(["erase", "item", meeting.id], st.s.admin)).exit).toBe(0);
    const one = await page(st, mac.token, { cursor: first.cursor });
    expect(one.captureErased).toEqual([meeting.key]);
    // Not listed done: served again.
    const two = await page(st, mac.token, { cursor: one.cursor });
    expect(two.captureErased).toEqual([meeting.key]);
    // Listed done with the cursor it came in: confirmed, and served no more.
    const three = await page(st, mac.token, { cursor: two.cursor, erasedDone: [meeting.key] });
    expect(three.captureErased).toEqual([]);
    const four = await page(st, mac.token, { cursor: three.cursor });
    expect(four.captureErased).toEqual([]);
    // A person's erasure removes no capture item, so it serves no key; its removals come all the same.
    const person = first.pages
      .flatMap((one) => one.entries)
      .find((entry) => entry.section === "entities" && entry.entity.kind === "person");
    expect(
      (await pi(["erase", "person", person?.section === "entities" ? person.entity.id : ""], st.s.admin)).exit,
    ).toBe(0);
    const after = await page(st, mac.token, { cursor: four.cursor });
    expect(after.captureErased).toEqual([]);
    expect(after.removals.length).toBeGreaterThan(0);
  });
});
