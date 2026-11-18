import { createHash, randomBytes } from "node:crypto";
import {
  type CaptureItem,
  type CaptureMention,
  type MeetingItem,
  MIRROR_QUOTA,
  type MomentItem,
  QUOTA_DEFAULTS,
} from "@intelligence/contracts/personal";
import { type Admin, createAdmin, createReader, googleSecretName, openRow } from "@intelligence/personal-store";
import {
  createTestDatabase,
  fingerprint,
  queryAs,
  sealRow,
  type TestDatabase,
} from "@intelligence/personal-store/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunDeps } from "../command-types.ts";
import { quiet } from "../test-support/extract-fixtures.ts";
import { CLIENT, pi } from "../test-support/sync-db-fixtures.ts";

// The drain in `pi sync`. `pi sync` runs in-process against a fake Google that answers by URL, with
// its clock injected: no network and no wait. One database for the file, its tests in order: the
// first runs with no Google label connected, the rest with the label `personal`. The device is
// registered by hand as addDevice makes it, its scope written by hand as pi_admin. Times are the
// real clock's, so the database's clock and the items' agree. Reserved domains only.

const TIMEOUT = 120_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const T = Math.floor(Date.now() / MINUTE) * MINUTE;
const local = (offset: number): string => `${new Date(T + offset - 5 * HOUR).toISOString().slice(0, 19)}-05:00`;
const utc = (offset: number): string => new Date(T + offset).toISOString();
const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

const OWNER_ADDRESS = "owner@quinn.test";
const NELL: CaptureMention = { name: "Nell Ashdown", address: "nell.ashdown@example.org" };
const MEET = { bundle: "test.example.meet", name: "Meet" };
const READER = { bundle: "test.example.reader", name: "Reader" };

type Channel = { id: string; token: string };
type Device = { capture: Channel; mirror: Channel };

let db: TestDatabase;
let owner: Admin;
let mac: Device;
const env = (): Record<string, string> => ({ PI_DATABASE_URL_WRITER: db.urls.writer, PI_KEY_FILE: db.keyFile });
const admin = <Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(db.urls.admin, sql, values);
const one = <Row>(rows: Row[]): Row => {
  expect(rows).toHaveLength(1);
  return rows[0] as Row;
};

async function addDevice(name: string): Promise<Device> {
  const channel = (): Channel => ({
    id: `cli_01JPDRAN${randomBytes(9)
      .toString("hex")
      .toUpperCase()
      .replace(/[ILOU]/g, "X")
      .slice(0, 18)}`,
    token: `pit_test-${name}-${randomBytes(8).toString("hex")}`,
  });
  const device: Device = { capture: channel(), mirror: channel() };
  const insert = `insert into policy.clients (id, name, token_hash, status, vendor_retention, runtime, compartments, views, tools, kind, id_mode, max_items_day, max_chars_day, max_rows_day, max_calls_minute)
    values ($1, $2, $3, 'active', 'none', 'local', $4, $5, $6, $7, 'stable', $8, $9, $10, $11)`;
  const quota = (q: typeof MIRROR_QUOTA) => [q.maxItemsDay, q.maxCharsDay, q.maxRowsDay, q.maxCallsMinute];
  await admin(insert, [
    device.capture.id,
    `${name}-capture`,
    sha256Hex(device.capture.token),
    ["own"],
    ["self"],
    ["push_capture"],
    "device",
    ...quota(QUOTA_DEFAULTS.device),
  ]);
  await admin(insert, [
    device.mirror.id,
    name,
    sha256Hex(device.mirror.token),
    ["own"],
    ["self", "people", "work"],
    ["sync_mirror"],
    "agent",
    ...quota(MIRROR_QUOTA),
  ]);
  await admin("insert into policy.lens_devices (name, capture_client_id, mirror_client_id) values ($1, $2, $3)", [
    name,
    device.capture.id,
    device.mirror.id,
  ]);
  for (const [connector, kind] of [
    ["lens_meetings", "transcript"],
    ["lens_activity", "screen_activity"],
    ["lens_blocks", "time_block"],
  ] as const) {
    const id = `acc_01JPDRAN${randomBytes(9)
      .toString("hex")
      .toUpperCase()
      .replace(/[ILOU]/g, "X")
      .slice(0, 18)}`;
    await admin(
      "insert into vault.source_accounts (id, label, connector, source_kind, compartments) values ($1, $2, $3, $4, '{own}')",
      [id, `device:${name}`, connector, kind],
    );
  }
  return device;
}

async function insertScope(match: "bundle" | "host", value: string, kinds: string[]): Promise<void> {
  const id = `csr_01JPDRAN${randomBytes(9)
    .toString("hex")
    .toUpperCase()
    .replace(/[ILOU]/g, "X")
    .slice(0, 18)}`;
  await admin(
    "insert into policy.capture_scope (id, match, value_fp, value_enc, compartment, kinds) values ($1, $2, $3, $4, 'own', $5)",
    [
      id,
      match,
      fingerprint(db.keys, "capture_scope", value),
      sealRow(db.keys, "own", { table: "policy.capture_scope", id, column: "value_enc" }, value),
      kinds,
    ],
  );
}

let keys = 0;
const keyOf = <K extends "meeting" | "moment">(kind: K): `${K}:${string}` =>
  `${kind}:01JPDRAN${String((keys += 1)).padStart(18, "0")}`;
let batches = 0;
const moment = (over: Partial<MomentItem> = {}): MomentItem => ({
  kind: "moment",
  key: keyOf("moment"),
  revision: 0,
  observedAt: local(-3 * HOUR),
  endedAt: local(-3 * HOUR + 5 * MINUTE),
  app: READER,
  url: "https://wiki.example.org/teams/alpha/plan",
  entity: "doc",
  participants: [],
  text: "The alpha plan, second draft.",
  read: "ax",
  ...over,
});
const meeting = (from: number, to: number, speaker: CaptureMention): MeetingItem => ({
  kind: "meeting",
  key: keyOf("meeting"),
  revision: 0,
  startedAt: local(from),
  endedAt: local(to),
  app: MEET,
  title: "A call",
  consent: true,
  mode: "call",
  speakers: [
    { label: "S1", owner: true, mention: { address: OWNER_ADDRESS } },
    { label: "S2", owner: false, mention: speaker },
  ],
  segments: [
    { speaker: "S1", fromMs: 0, toMs: 20_000, channel: "input", text: "Shall we start?" },
    { speaker: "S2", fromMs: 20_000, toMs: 40_000, channel: "output", text: "Yes, let us." },
  ],
});

async function push(items: CaptureItem[], device: Device = mac): Promise<void> {
  const reader = createReader({ url: db.urls.reader, keys: db.keys, log: quiet });
  try {
    const answer = await reader.pushCapture(device.capture.token, {
      batch: `pi-drain-batch-${String((batches += 1)).padStart(4, "0")}`,
      items,
    });
    expect(answer).toEqual({
      ok: true,
      value: { items: items.map((item) => ({ key: item.key, outcome: "accepted" })) },
    });
  } finally {
    await reader.close();
  }
}

const stored = async (item: CaptureItem): Promise<boolean> =>
  (await admin("select 1 from knowledge.captures where capture_key = $1", [item.key])).length > 0;
const lines = (stderr: string): Record<string, unknown>[] =>
  stderr
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
const takenLine = (stderr: string) =>
  lines(stderr).find((line) => line.event === "capture_taken") as
    | { event: string; counts: Record<string, number> }
    | undefined;

// The calendar's events, which the fake Google lists as its incremental sync does, and its clock.
type GoogleEvent = Record<string, unknown>;
const calendar: GoogleEvent[] = [];
let clock = T;
let syncs = 0;
const delivered = new Set<string>();
function google(): RunDeps {
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const path = `${url.host}${url.pathname}`;
    if (path === "oauth2.googleapis.com/token")
      return json({
        access_token: "sentinel-access-token",
        expires_in: 3600,
        token_type: "Bearer",
        scope:
          "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.events.readonly",
      });
    if (path === "gmail.googleapis.com/gmail/v1/users/me/profile")
      return json({ emailAddress: OWNER_ADDRESS, historyId: "1000" });
    if (path === "gmail.googleapis.com/gmail/v1/users/me/messages") return json({ resultSizeEstimate: 0 });
    if (path === "gmail.googleapis.com/gmail/v1/users/me/history") return json({ historyId: "1000" });
    if (path === "www.googleapis.com/calendar/v3/calendars/primary/events") {
      // A full listing hands over every event; an incremental one, with a sync token, only those
      // not handed over yet, as Google's does.
      const items = url.searchParams.has("syncToken")
        ? calendar.filter((one) => !delivered.has(one.id as string))
        : calendar;
      for (const one of items) delivered.add(one.id as string);
      return json({ items, nextSyncToken: `sync-${(syncs += 1)}` });
    }
    return json({}, 404);
  };
  return { google: { fetch, sleep: async () => {}, now: () => clock, random: () => 0.5, timeoutMs: 5000 } };
}
const googleEvent = (id: string, from: number, to: number, guest: string): GoogleEvent => ({
  id,
  status: "confirmed",
  etag: `etag-${id}`,
  updated: utc(-2 * DAY),
  summary: `Event ${id}`,
  start: { dateTime: utc(from) },
  end: { dateTime: utc(to) },
  organizer: { email: OWNER_ADDRESS, self: true },
  attendees: [
    { email: OWNER_ADDRESS, self: true, responseStatus: "accepted" },
    { email: guest, responseStatus: "accepted" },
  ],
});
const eventIdOf = async (id: string): Promise<string> =>
  one(
    await admin<{ id: string }>(
      "select d.event_id as id from knowledge.event_details d join vault.source_accounts a on a.id = d.account_id where a.connector = 'google_calendar' and d.source_event_fp = $1",
      [fingerprint(db.keys, "source_id", id)],
    ),
  ).id;

beforeAll(async () => {
  db = await createTestDatabase({ compartments: ["own", "employer:example"] });
  owner = createAdmin({ url: db.urls.admin, keys: db.keys, log: quiet });
  mac = await addDevice("mac");
  await insertScope("host", "wiki.example.org", ["moment"]);
  await insertScope("bundle", MEET.bundle, ["meeting"]);
}, TIMEOUT);

afterAll(async () => {
  await owner?.close();
  await db?.drop();
});

describe("the drain in pi sync", { timeout: TIMEOUT }, () => {
  it("the drain runs with no Google label connected, and no_accounts comes only after it", async () => {
    const item = moment();
    await push([item]);
    const result = await pi(["sync"], env());
    expect({ exit: result.exit, stdout: result.stdout }).toEqual({ exit: 0, stdout: "" });
    const logged = lines(result.stderr);
    expect(logged.at(-1)).toEqual({ event: "no_accounts" });
    expect(takenLine(result.stderr)?.counts.taken).toBe(1);
    expect(logged.findIndex((line) => line.event === "capture_taken")).toBeLessThan(logged.length - 1);
    expect(await stored(item)).toBe(true);
    // A run that moves nothing logs no capture_taken line.
    const quietRun = await pi(["sync"], env());
    expect(quietRun).toEqual({ exit: 0, stdout: "", stderr: `${JSON.stringify({ event: "no_accounts" })}\n` });
  });

  it("the capture_taken log line holds counts and codes and no canary", async () => {
    const canary = "CANARY-PI-DRAIN-LOG-4b2f";
    const kept = moment({ window: canary, text: `Kept: ${canary}.` });
    const tripped = moment({ window: canary, text: `See ent_01JPDRANSYSTEMXDS000000000 and ${canary}.` });
    await push([kept, tripped]);
    const result = await pi(["sync"], env());
    expect(result.exit).toBe(0);
    expect(result.stderr).not.toContain(canary);
    expect(result.stderr).not.toContain(sha256Hex(canary));
    const line = takenLine(result.stderr);
    expect(line).toBeDefined();
    expect(Object.keys(line ?? {}).every((key) => ["event", "ids", "counts"].includes(key))).toBe(true);
    expect(Object.values(line?.counts ?? {}).every((value) => typeof value === "number")).toBe(true);
    expect(line?.counts.taken).toBe(1);
    expect(Object.entries(line?.counts ?? {}).some(([name, value]) => name.includes("system_ids") && value === 1)).toBe(
      true,
    );
    expect(await stored(kept)).toBe(true);
    expect(await stored(tripped)).toBe(false);
  });

  it("inbox rows pushed before the device's clients are revoked are still drained", async () => {
    const gone = await addDevice("gone");
    const item = moment();
    await push([item], gone);
    // The revocation, by hand as `pi lens revoke` makes it: both clients, at once.
    await admin("update policy.clients set status = 'revoked', revoked_at = now() where id = any($1)", [
      [gone.capture.id, gone.mirror.id],
    ]);
    const result = await pi(["sync"], env());
    expect(result.exit).toBe(0);
    expect(await stored(item)).toBe(true);
  });

  it("L27: a meeting whose event arrives in the same sync run is linked, and its CaptureFacts hold the event's owner-backing and each speaker's participant", async () => {
    // From here on the label `personal` is connected.
    await owner.secrets.setSecret(googleSecretName("personal", "client"), CLIENT);
    await owner.secrets.setSecret(googleSecretName("personal", "refresh_token"), "sentinel-refresh-token-7f3a91");
    calendar.push(googleEvent("evpidrainlink01", -3 * HOUR, -2 * HOUR, NELL.address ?? ""));
    const linked = meeting(-3 * HOUR + 5 * MINUTE, -2 * HOUR, NELL);
    // A forged long meeting overlapping an accepted event, with no attendee in common.
    const forged = meeting(-4 * HOUR, -HOUR, { name: "Forger", address: "forger@example.net" });
    await push([linked, forged]);
    clock = T;
    const result = await pi(["sync"], env(), google());
    expect(result.exit, result.stderr).toBe(0);
    const eventId = await eventIdOf("evpidrainlink01");
    const nell = one(
      await admin<{ entity_id: string }>("select entity_id from knowledge.event_participants where event_id = $1", [
        eventId,
      ]),
    ).entity_id;
    const row = one(
      await admin<{ id: string; event_id: string | null; compartments: string[]; facts_enc: unknown }>(
        "select id, event_id, compartments, facts_enc from knowledge.captures where capture_key = $1",
        [linked.key],
      ),
    );
    expect(row.event_id).toBe(eventId);
    // The event is the personal label's: the label stays own.
    expect(row.compartments).toEqual(["own"]);
    const facts = JSON.parse(
      openRow(db.keys, "own", { table: "knowledge.captures", id: row.id, column: "facts_enc" }, row.facts_enc as never),
    ) as { linked: unknown };
    expect(facts.linked).toEqual({ event: eventId, ownerBacked: true, speakers: { S2: nell } });
    expect(
      one(
        await admin<{ event_id: string | null }>("select event_id from knowledge.captures where capture_key = $1", [
          forged.key,
        ]),
      ).event_id,
    ).toBeNull();
  });

  it("a meeting waits until a calendar sync of every connected label has completed after its end, and at most 24 hours", async () => {
    const old = meeting(-26 * HOUR, -25 * HOUR, NELL);
    const recent = meeting(-90 * MINUTE, -HOUR, NELL);
    await push([old, recent]);
    // The calendar's last sync completed before both ended: the one over 24 hours ago is taken.
    clock = T - 26 * HOUR;
    let result = await pi(["sync"], env(), google());
    expect(result.exit, result.stderr).toBe(0);
    expect(takenLine(result.stderr)?.counts).toMatchObject({ taken: 1, waiting: 1 });
    expect([await stored(old), await stored(recent)]).toEqual([true, false]);
    clock = T - 2 * HOUR;
    result = await pi(["sync"], env(), google());
    expect(result.exit, result.stderr).toBe(0);
    expect(await stored(recent)).toBe(false);
    // A sync after its end: taken.
    clock = T;
    result = await pi(["sync"], env(), google());
    expect(result.exit, result.stderr).toBe(0);
    expect(await stored(recent)).toBe(true);
  });

  it("a drain that fails after the labels synced leaves their rows, and the next run takes the inbox", async () => {
    const item = moment();
    await push([item]);
    calendar.push(googleEvent("evpidrainkept01", 5 * HOUR, 6 * HOUR, "orla.finn@example.org"));
    const asOwner = (sql: string) => queryAs(db.urls.bootstrap, `set role pi_owner; ${sql}`);
    await asOwner("revoke select on ledger.capture_inbox from pi_writer");
    try {
      clock = T;
      const failed = await pi(["sync"], env(), google());
      expect(failed.exit).toBe(1);
      // The label's calendar went through, and its outcome stands.
      expect(await eventIdOf("evpidrainkept01")).toMatch(/^evt_/);
      expect(await admin("select last_outcome from vault.source_accounts where connector = 'google_calendar'")).toEqual(
        [{ last_outcome: "ok" }],
      );
      expect(await stored(item)).toBe(false);
    } finally {
      await asOwner("grant select on ledger.capture_inbox to pi_writer");
    }
    const next = await pi(["sync"], env(), google());
    expect(next.exit, next.stderr).toBe(0);
    expect(await stored(item)).toBe(true);
  });
});
