import { ClaimRecord, LensDeviceView, MIRROR_QUOTA, QUOTA_DEFAULTS } from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registrationFingerprint } from "../../read/oauth.ts";
import { sha256Hex, testId } from "../../test-support/clients.ts";
import { one, readAs, session } from "../../test-support/connections.ts";
import { fingerprint, queryAs, sealRow } from "../../test-support/database.ts";
import { openStore, type TestStore } from "../../test-support/store.ts";
import { refusedWith, registration } from "../../test-support/values.ts";

// A Mac's two clients in the admin. One database for the file, compartments `own` and
// `employer:example`, a restricted category on; each test its own device names.

const TIMEOUT = 180_000;
const NOW = new Date("2026-10-07T12:00:00.000Z");

let store: TestStore;
beforeAll(async () => {
  store = await openStore({ now: NOW });
  await store.admin.restricted.addRestrictedCategory("health");
}, TIMEOUT);
afterAll(async () => {
  await store?.close();
});

const admin = <Row = Record<string, unknown>>(text: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(store.db.urls.admin, text, values);

type ClientRow = {
  id: string;
  kind: string;
  status: string;
  token_hash: string;
  vendor_retention: string;
  runtime: string;
  compartments: string[];
  views: string[];
  tools: string[];
  id_mode: string;
  max_items_day: number;
  max_chars_day: number;
  max_rows_day: number;
  max_calls_minute: number;
};
const clientOf = async (name: string): Promise<ClientRow | undefined> =>
  (
    await admin<ClientRow>(
      `select id, kind, status, token_hash, vendor_retention, runtime, compartments, views, tools, id_mode, max_items_day, max_chars_day::int as max_chars_day, max_rows_day, max_calls_minute
       from policy.clients where name = $1`,
      [name],
    )
  )[0];
const deviceRows = (name: string) =>
  admin<{ capture_client_id: string; mirror_client_id: string }>(
    "select capture_client_id, mirror_client_id from policy.lens_devices where name = $1",
    [name],
  );
const accountsOf = (name: string) =>
  admin<{ connector: string; source_kind: string; compartments: string[]; address: boolean }>(
    "select connector, source_kind, compartments, (address_fp is not null or address_enc is not null) as address from vault.source_accounts where label = $1 order by connector",
    [`device:${name}`],
  );
const quotaOf = (row: ClientRow | undefined) =>
  row === undefined
    ? undefined
    : {
        maxItemsDay: row.max_items_day,
        maxCharsDay: row.max_chars_day,
        maxRowsDay: row.max_rows_day,
        maxCallsMinute: row.max_calls_minute,
      };

describe("Admin: Lens devices", { timeout: TIMEOUT }, () => {
  it("pi lens add makes two clients, one device row and four accounts in one transaction, and a failure leaves none", async () => {
    const tokens = await store.admin.lens.addDevice("lens-one", {
      compartments: ["own"],
      views: ["self", "people", "work"],
    });
    // The capture token alone: the mirror's first is the first rotation's.
    expect(Object.keys(tokens)).toEqual(["capture"]);
    expect(tokens.capture).toMatch(/^pit_[A-Za-z0-9_-]{43}$/);

    const capture = await clientOf("lens-one-capture");
    const mirror = await clientOf("lens-one");
    expect(capture).toMatchObject({
      kind: "device",
      status: "active",
      vendor_retention: "none",
      compartments: ["own"],
      views: ["self"],
      tools: ["push_capture"],
      token_hash: sha256Hex(tokens.capture),
    });
    expect(quotaOf(capture)).toEqual(QUOTA_DEFAULTS.device);
    expect(mirror).toMatchObject({
      kind: "agent",
      status: "active",
      compartments: ["own"],
      views: ["self", "people", "work"],
      tools: ["sync_mirror"],
    });
    // A hash no token printed has: the mirror client answers nothing until it is rotated.
    expect(mirror?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(mirror?.token_hash).not.toBe(capture?.token_hash);
    expect(quotaOf(mirror)).toEqual(MIRROR_QUOTA);
    expect(await deviceRows("lens-one")).toEqual([{ capture_client_id: capture?.id, mirror_client_id: mirror?.id }]);
    expect(await accountsOf("lens-one")).toEqual([
      { connector: "lens_activity", source_kind: "screen_activity", compartments: ["own"], address: false },
      { connector: "lens_blocks", source_kind: "time_block", compartments: ["own"], address: false },
      { connector: "lens_meetings", source_kind: "transcript", compartments: ["own"], address: false },
      // Work time: the fourth, for the owner's tasks.
      { connector: "lens_tasks", source_kind: "owner_task", compartments: ["own"], address: false },
    ]);

    // A failure part-way: the mirror's name is taken, after the capture client went in. Nothing of
    // the device is left: no capture client, no device row, no account.
    await store.admin.clients.addClient(registration("lens-taken", ["own"]));
    expect(
      await refusedWith(() =>
        store.admin.lens.addDevice("lens-taken", { compartments: ["own"], views: ["self", "people", "work"] }),
      ),
    ).toEqual({ name: "AdminError", code: "duplicate_name" });
    expect(await clientOf("lens-taken-capture")).toBeUndefined();
    expect(await deviceRows("lens-taken")).toEqual([]);
    expect(await accountsOf("lens-taken")).toEqual([]);
    // A name whose capture client would not be a client name is refused before any statement.
    expect(
      await refusedWith(() => store.admin.lens.addDevice("a".repeat(33), { compartments: ["own"], views: ["self"] })),
    ).toEqual({ name: "AdminError", code: "invalid_registration" });
  });

  it("work time R41: pi lens tasks NAME on makes the lens_tasks account of a device that lacks one, once, and off makes none", async () => {
    await store.admin.lens.addDevice("lens-old", { compartments: ["own"], views: ["self"] });
    await admin("delete from vault.source_accounts where label = 'device:lens-old' and connector = 'lens_tasks'");
    const tasksAccounts = () =>
      admin<{ id: string }>(
        "select id from vault.source_accounts where label = 'device:lens-old' and connector = 'lens_tasks'",
      );
    await store.admin.lens.setDeviceTasks("lens-old", false);
    expect(await tasksAccounts()).toEqual([]);
    await store.admin.lens.setDeviceTasks("lens-old", true);
    const [made] = await tasksAccounts();
    expect(await accountsOf("lens-old")).toContainEqual({
      connector: "lens_tasks",
      source_kind: "owner_task",
      compartments: ["own"],
      address: false,
    });
    // Once: on again, and off then on, keep the one account.
    await store.admin.lens.setDeviceTasks("lens-old", true);
    await store.admin.lens.setDeviceTasks("lens-old", false);
    await store.admin.lens.setDeviceTasks("lens-old", true);
    expect(await tasksAccounts()).toEqual([made]);
    expect(
      one(await admin<{ tasks: boolean }>("select tasks from policy.lens_devices where name = 'lens-old'")),
    ).toEqual({ tasks: true });
    // No device of the name: not_found, and no account.
    expect(await refusedWith(() => store.admin.lens.setDeviceTasks("lens-none", true))).toEqual({
      name: "AdminError",
      code: "not_found",
    });
    expect(await accountsOf("lens-none")).toEqual([]);
  });

  it("a restricted compartment is refused restricted_not_served", async () => {
    expect(
      await refusedWith(() =>
        store.admin.lens.addDevice("lens-health", { compartments: ["own", "restricted:health"], views: ["self"] }),
      ),
    ).toEqual({
      name: "AdminError",
      code: "restricted_not_served",
    });
    expect(await clientOf("lens-health")).toBeUndefined();
    expect(await clientOf("lens-health-capture")).toBeUndefined();
    expect(await deviceRows("lens-health")).toEqual([]);
    // The control: an employer compartment beside own is taken.
    await store.admin.lens.addDevice("lens-work", {
      compartments: ["own", "employer:example"],
      views: ["self", "work"],
    });
    expect((await clientOf("lens-work"))?.compartments).toEqual(["own", "employer:example"]);
  });

  it("the mirror client is registered with stable ids and retention none", async () => {
    await store.admin.lens.addDevice("lens-ids", { compartments: ["own"], views: ["self"] });
    expect(await clientOf("lens-ids")).toMatchObject({ id_mode: "stable", vendor_retention: "none", runtime: "local" });
    expect(await clientOf("lens-ids-capture")).toMatchObject({ id_mode: "stable", vendor_retention: "none" });
  });

  it("set-tools, set-compartments and quota refuse a device client with device_fixed, and change an agent client, as the control", async () => {
    await store.admin.lens.addDevice("lens-fixed", { compartments: ["own"], views: ["self"] });
    const before = await clientOf("lens-fixed-capture");
    expect(await refusedWith(() => store.admin.clients.setTools("lens-fixed-capture", ["get_self"]))).toEqual({
      name: "AdminError",
      code: "device_fixed",
    });
    expect(
      await refusedWith(() => store.admin.clients.setCompartments("lens-fixed-capture", ["own", "employer:example"])),
    ).toEqual({ name: "AdminError", code: "device_fixed" });
    expect(
      await refusedWith(() => store.admin.clients.setQuota("lens-fixed-capture", { maxCallsMinute: 600 })),
    ).toEqual({
      name: "AdminError",
      code: "device_fixed",
    });
    expect(await clientOf("lens-fixed-capture")).toEqual(before);

    // The control: the device's mirror client is an agent, and the owner may widen it.
    await store.admin.clients.setCompartments("lens-fixed", ["own", "employer:example"]);
    await store.admin.clients.setQuota("lens-fixed", { maxCallsMinute: 30 });
    expect(await clientOf("lens-fixed")).toMatchObject({
      compartments: ["employer:example", "own"],
      max_calls_minute: 30,
    });
    await store.admin.clients.addClient(registration("lens-agent", ["own"]));
    await store.admin.clients.setTools("lens-agent", ["get_self"]);
    expect((await clientOf("lens-agent"))?.tools).toEqual(["get_self"]);
  });

  it("clients add refuses kind device, and lens add makes one with its device row", async () => {
    const device = registration("lens-direct", ["own"], { kind: "device", views: ["self"], tools: ["push_capture"] });
    expect(await refusedWith(() => store.admin.clients.addClient(device))).toEqual({
      name: "AdminError",
      code: "device_fixed",
    });
    expect(await clientOf("lens-direct")).toBeUndefined();
    await store.admin.lens.addDevice("lens-made", { compartments: ["own"], views: ["self"] });
    const made = await clientOf("lens-made-capture");
    expect(made?.kind).toBe("device");
    expect(one(await deviceRows("lens-made")).capture_client_id).toBe(made?.id);
  });

  it("revoke ends both clients in one transaction, and the inbox rows pushed before it stay", async () => {
    await store.admin.lens.addDevice("lens-gone", { compartments: ["own"], views: ["self"] });
    const capture = await clientOf("lens-gone-capture");
    const sessionId = testId("ses");
    await asOwnerRows("insert into ledger.sessions (id, client_id, compartments) values ($1, $2, '{own}')", [
      sessionId,
      capture?.id,
    ]);
    await asOwnerRows(
      `insert into ledger.capture_inbox (id, client_id, session_id, batch, source_key_fp, revision, kind, content_fp, body_bytes, compartments, body_enc)
       values ($1, $2, $3, 'batch-gone-1', $4, 0, 'forget', $4, 2, '{own}', '{}'::jsonb)`,
      [testId("cin"), capture?.id, sessionId, "c".repeat(64)],
    );
    await store.admin.lens.revokeDevice("lens-gone");
    const rows = await admin<{ name: string; status: string; revoked_at: Date }>(
      "select name, status, revoked_at from policy.clients where name in ('lens-gone', 'lens-gone-capture') order by name",
    );
    expect(rows.map((row) => [row.name, row.status])).toEqual([
      ["lens-gone", "revoked"],
      ["lens-gone-capture", "revoked"],
    ]);
    // One statement in one transaction: the same instant on both.
    expect(rows[0]?.revoked_at.getTime()).toBe(rows[1]?.revoked_at.getTime());
    expect(
      await admin("select count(*)::int as n from ledger.capture_inbox where client_id = $1", [capture?.id]),
    ).toEqual([{ n: 1 }]);
    // A second revoke changes nothing; an unknown name is not_found.
    await store.admin.lens.revokeDevice("lens-gone");
    expect(await refusedWith(() => store.admin.lens.revokeDevice("lens-nobody"))).toEqual({
      name: "AdminError",
      code: "not_found",
    });
  });

  it("rotate gives one channel a new token and leaves the other", async () => {
    await store.admin.lens.addDevice("lens-turn", { compartments: ["own"], views: ["self"] });
    const unissued = (await clientOf("lens-turn"))?.token_hash;
    const fresh = await store.admin.lens.rotateDevice("lens-turn", "capture");
    expect((await clientOf("lens-turn-capture"))?.token_hash).toBe(sha256Hex(fresh));
    expect((await clientOf("lens-turn"))?.token_hash).toBe(unissued);
    const mirror = await store.admin.lens.rotateDevice("lens-turn", "mirror");
    expect((await clientOf("lens-turn"))?.token_hash).toBe(sha256Hex(mirror));
    await store.admin.lens.revokeDevice("lens-turn");
    expect(await refusedWith(() => store.admin.lens.rotateDevice("lens-turn", "mirror"))).toEqual({
      name: "AdminError",
      code: "not_found",
    });
    expect(await refusedWith(() => store.admin.lens.rotateDevice("lens-nobody", "capture"))).toEqual({
      name: "AdminError",
      code: "not_found",
    });
  });

  it("oauth approve refuses kind device", async () => {
    const device = registration("lens-oauth", ["own"], { kind: "device", views: ["self"], tools: ["push_capture"] });
    const pending = `oc_${"A".repeat(32)}`;
    await store.reader.oauth.register(pending, {
      redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
      clientName: null,
    });
    const print = registrationFingerprint(pending);
    expect(await refusedWith(() => store.admin.clients.approveOAuth(device, print))).toEqual({
      name: "AdminError",
      code: "device_fixed",
    });
    expect(await clientOf("lens-oauth")).toBeUndefined();
    // The control: an agent is approved, with its code.
    expect((await store.admin.clients.approveOAuth(registration("lens-oauth", ["own"]), print)).code).toMatch(
      /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/,
    );
  });

  it("devices shows counts, ids and times, and no name, title, URL or host", async () => {
    const tokens = await store.admin.lens.addDevice("lens-seen", { compartments: ["own"], views: ["self"] });
    const capture = await clientOf("lens-seen-capture");
    const mirror = await clientOf("lens-seen");
    const meetings = one(
      await admin<{ id: string }>(
        "select id from vault.source_accounts where label = 'device:lens-seen' and connector = 'lens_meetings'",
      ),
    ).id;

    // The inbox, as policy.push_capture and the drain leave it: two waiting, a forget waiting, one
    // taken, one refused out of scope at drain and one dropped for a system id.
    const sessionId = testId("ses");
    await asOwnerRows("insert into ledger.sessions (id, client_id, compartments) values ($1, $2, '{own}')", [
      sessionId,
      capture?.id,
    ]);
    const inbox = async (
      kind: string,
      state: { refused?: string; taken?: boolean; body?: boolean; source?: string },
    ): Promise<void> => {
      await asOwnerRows(
        `insert into ledger.capture_inbox (id, client_id, session_id, batch, source_key_fp, revision, kind, content_fp, body_bytes, compartments, body_enc, refused_code, taken_at, source)
         values ($1, $2, $3, 'batch-seen-1', $4, 0, $5, $4, 10, '{own}', $6::jsonb, $7, $8, $9)`,
        [
          testId("cin"),
          capture?.id,
          sessionId,
          sha256Hex(`key ${Math.random()}`),
          kind,
          state.body === false ? null : "{}",
          state.refused ?? null,
          state.taken === true ? NOW : null,
          state.source ?? null,
        ],
      );
    };
    await inbox("moment", {});
    await inbox("meeting", {});
    await inbox("forget", {});
    await inbox("forget", { taken: true, body: false });
    await inbox("moment", { taken: true, body: false });
    await inbox("moment", { refused: "out_of_scope", body: false });
    await inbox("moment", { refused: "system_ids", body: false });
    await inbox("moment", { refused: "recovery", body: false, source: "imessage" });
    // One push call, logged as policy.log_call logs it, under the capture token.
    await readAs(store.db, tokens.capture, (query) => query("select policy.log_call('push_capture', 1, 'ok')"));

    // Two meetings of the device: one today with two blanked segments, an explicit_self claim and
    // a third_party one; one ten days ago, outside the seven days, with an explicit_self claim.
    const today = await seedMeeting(meetings, { day: "2026-10-07", blanked: 2 });
    await seedClaim(today, "explicit_self", 1);
    await seedClaim(today, "third_party", 2);
    const old = await seedMeeting(meetings, { day: "2026-09-27", blanked: 1 });
    await seedClaim(old, "explicit_self", 3);

    const views = (await store.admin.lens.devices()).filter((view) => view.name === "lens-seen");
    expect(views).toHaveLength(1);
    const view = LensDeviceView.parse(views[0]);
    const pushed = one(
      await admin<{ at: Date }>(
        "select max(at) as at from policy.calls where client_id = $1 and tool = 'push_capture'",
        [capture?.id],
      ),
    ).at;
    expect(view).toEqual({
      name: "lens-seen",
      capture: capture?.id,
      mirror: mirror?.id,
      status: "active",
      inbox: { waiting: 2, forgetsWaiting: 1, refused: { out_of_scope: 1 }, dropped: { recovery: 1, system_ids: 1 } },
      blankedSegments: 3,
      lastPushAt: pushed.toISOString(),
      // The Mac's contacts, off and none stored on this device.
      macContacts: { on: false, stored: 0, dropped: {} },
      lastPassAt: null,
      mirrorEntries: 0,
      unconfirmed: 0,
      ownWords: [{ day: "2026-10-07", count: 1 }],
      // The device's task events, activity facts and people made by name: none in this world.
      taskEvents: [],
      activity: [],
      peopleMade: [],
      sourceMoments: { stored: 0, dropped: { recovery: 1 } },
    });
    const text = JSON.stringify(views);
    for (const canary of [TITLE, HOST, URL_TEXT, "canary-lens-words"]) expect(text).not.toContain(canary);

    // Revoked, it reads revoked, and its counts stay.
    await store.admin.lens.revokeDevice("lens-seen");
    expect((await store.admin.lens.devices()).find((one) => one.name === "lens-seen")).toMatchObject({
      status: "revoked",
      inbox: { waiting: 2 },
    });
  });
});

const TITLE = "canary-lens-title Board review";
const HOST = "canary-lens.example.test";
const URL_TEXT = "https://canary-lens.example.test/call";

// A statement as pi_owner with bind values: `set role` and a bound statement go on one
// connection as two queries.
async function asOwnerRows(text: string, values: unknown[]): Promise<void> {
  await session(store.db.urls.bootstrap, async (query) => {
    await query("set role pi_owner");
    await query(text, values);
  });
}

// One stored meeting of the device's meeting account, as the meeting drain writes it: its blob, its
// evidence row and its knowledge.captures row with sealed CaptureFacts. Its evidence id.
async function seedMeeting(account: string, { day, blanked }: { day: string; blanked: number }): Promise<string> {
  const keys = store.db.keys;
  const evidenceId = sha256Hex(`lens meeting ${day} ${Math.random()}`);
  const blob = testId("blb");
  const sealed = (table: string, id: string, column: string, value: string): string =>
    JSON.stringify(sealRow(keys, "own", { table, id, column }, value));
  const capture = testId("cap");
  const facts = {
    kind: "meeting",
    app: { bundle: "test.lens.meetings", name: "Meetings" },
    title: TITLE,
    account: null,
    host: HOST,
    consent: true,
    mode: "call",
    series: null,
    part: null,
    calendar: null,
    speakers: [],
    linked: null,
    url: URL_TEXT,
    counts: { segments: 4, chars: 40, minutes: 30, blanked },
  };
  await admin("insert into vault.evidence_blobs (blob_ref, envelope, compartments) values ($1, $2::jsonb, '{own}')", [
    blob,
    sealed("vault.evidence_blobs", blob, "envelope", Buffer.from("canary-lens-words").toString("base64")),
  ]);
  await admin(
    `insert into vault.evidence_items (id, source_account_id, source_kind, source_item_fp, revision_tag_fp, revision, next_revision_id, content_hash, media_type,
       observed_at, change_kind, participant_members, system_originated, answers_system, payload_state, compartments, readers, blob_ref, item_enc)
     values ($1, $2, 'transcript', $3, $4, 0, $5, $6, 'application/json', $7, 'live', '{m-owner}', false, false, 'present', '{own}', '{m-owner}', $8, $9::jsonb)`,
    [
      evidenceId,
      account,
      fingerprint(keys, "source_id", `lens-${evidenceId}`),
      fingerprint(keys, "revision_tag", `h:lens-${evidenceId}`),
      `${evidenceId}:1`,
      sha256Hex(`content ${evidenceId}`),
      `${day}T09:00:00Z`,
      blob,
      sealed("vault.evidence_items", evidenceId, "item_enc", JSON.stringify(facts)),
    ],
  );
  await admin(
    `insert into knowledge.captures (id, evidence_id, source_account_id, capture_key, revision, kind, started_at, ended_at, first_pushed_at, local_day, facts_enc, compartments)
     values ($1, $2, $3, $4, 0, 'meeting', $5, $5, $5, $6, $7::jsonb, '{own}')`,
    [
      capture,
      evidenceId,
      account,
      `meeting:${capture.slice(4)}`,
      `${day}T09:00:00Z`,
      day,
      sealed("knowledge.captures", capture, "facts_enc", JSON.stringify(facts)),
    ],
  );
  return evidenceId;
}

// One claim on the meeting, with the basis given, sealed as the pipeline seals one.
async function seedClaim(evidenceId: string, basis: "explicit_self" | "third_party", n: number): Promise<void> {
  const id = sha256Hex(`lens claim ${evidenceId} ${n}`);
  const owner = `ent_${"0".repeat(25)}1`;
  const record = {
    claim: {
      id,
      content: { type: "commitment", subject: owner, fields: { counterparty: owner, what: "canary-lens-words" } },
      statementKind: "stated_fact",
      basis,
      validFrom: "2026-10-07T09:00:00.000Z",
      evidence: [{ evidenceId, span: `seg:${n}` }],
      primaryEvidenceId: evidenceId,
      label: { compartments: ["own"], readers: ["m-owner"] },
      destination: "personal",
      pipelineVersion: "1",
      extractorGeneration: 1,
      changeKind: "live",
      systemOriginated: false,
      origin: "source",
      identityEpoch: 0,
    },
    subjectKind: "owner",
    disclosure: basis === "third_party" ? ["third_party"] : [],
    factKey: `lens fact ${evidenceId} ${n}`,
    lane: "correspondence",
    fieldKinds: { counterparty: "entity", what: "text" },
    entities: [],
    origin: "source",
    answersSystem: false,
  };
  // The fixture is a claim the store would write.
  expect(ClaimRecord.safeParse(record).success).toBe(true);
  await admin(
    `insert into knowledge.claims (id, evidence_id, type, valid_from, fact_key_fp, extractor_generation, readers, content_enc, compartments)
     values ($1, $2, 'commitment', now(), $3, 1, '{m-owner}', $4::jsonb, '{own}')`,
    [
      id,
      evidenceId,
      sha256Hex(`fact ${id}`),
      JSON.stringify(
        sealRow(store.db.keys, "own", { table: "knowledge.claims", id, column: "content_enc" }, JSON.stringify(record)),
      ),
    ],
  );
}
