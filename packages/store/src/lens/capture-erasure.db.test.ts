import { randomBytes } from "node:crypto";
import {
  type CaptureId,
  type CaptureItem,
  type CaptureMention,
  type EntityId,
  type MeetingItem,
  MIRROR_QUOTA,
  type MomentItem,
  QUOTA_DEFAULTS,
} from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Admin, createAdmin } from "../admin/admin.ts";
import { journalPath } from "../core/journal.ts";
import { openUnder, sealRow } from "../core/seal.ts";
import { ERASURE_HOOKS } from "../erasure/erasure-hooks.ts";
import { createReader, type Reader } from "../read/read.ts";
import { type Accounts, connect, OWNER } from "../test-support/cast.ts";
import { sha256Hex, testId } from "../test-support/clients.ts";
import { one, session } from "../test-support/connections.ts";
import { createTestDatabase, fingerprint, queryAs, type TestDatabase } from "../test-support/database.ts";
import { event, ingestEvent } from "../test-support/items.ts";
import { eventLogger } from "../test-support/recording.ts";
import { createWriter, type Writer } from "../write/writer.ts";

// The captures hook and the erasure of a capture item. One database for the file; the device is
// registered by hand as the device registration makes it. Every item and event here is over a day
// ago, so no meeting waits for a calendar.

const TIMEOUT = 120_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T = Math.floor(Date.now() / MINUTE) * MINUTE;
const local = (offset: number): string => `${new Date(T + offset - 5 * HOUR).toISOString().slice(0, 19)}-05:00`;
const utc = (offset: number): string => new Date(T + offset).toISOString();

type Channel = { id: string; name: string; token: string };
type Device = { capture: Channel; mirror: Channel; accounts: { meetings: string; activity: string; blocks: string } };

let db: TestDatabase;
let writer: Writer;
let reader: Reader;
let owner: Admin;
let accounts: Accounts;
let mac: Device;

const admin = <Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(db.urls.admin, sql, values);
const count = async (table: string, where = "true", values: unknown[] = []): Promise<number> =>
  one(await admin<{ n: number }>(`select count(*)::int as n from ${table} where ${where}`, values)).n;

async function addDevice(name: string): Promise<Device> {
  const channel = (client: string): Channel => ({
    id: testId("cli"),
    name: client,
    token: `pit_test-${client}-${randomBytes(8).toString("hex")}`,
  });
  const device: Device = {
    capture: channel(`${name}-capture`),
    mirror: channel(name),
    accounts: { meetings: testId("acc"), activity: testId("acc"), blocks: testId("acc") },
  };
  const insert = `insert into policy.clients (id, name, token_hash, status, vendor_retention, runtime, compartments, views, tools, kind, id_mode, max_items_day, max_chars_day, max_rows_day, max_calls_minute)
    values ($1, $2, $3, 'active', 'none', 'local', $4, $5, $6, $7, 'stable', $8, $9, $10, $11)`;
  const quota = (q: typeof MIRROR_QUOTA) => [q.maxItemsDay, q.maxCharsDay, q.maxRowsDay, q.maxCallsMinute];
  await session(db.urls.admin, async (query) => {
    await query("begin");
    await query(insert, [
      device.capture.id,
      device.capture.name,
      sha256Hex(device.capture.token),
      ["own"],
      ["self"],
      ["push_capture"],
      "device",
      ...quota(QUOTA_DEFAULTS.device),
    ]);
    await query(insert, [
      device.mirror.id,
      device.mirror.name,
      sha256Hex(device.mirror.token),
      ["own"],
      ["self", "people", "work"],
      ["sync_mirror"],
      "agent",
      ...quota(MIRROR_QUOTA),
    ]);
    await query("insert into policy.lens_devices (name, capture_client_id, mirror_client_id) values ($1, $2, $3)", [
      name,
      device.capture.id,
      device.mirror.id,
    ]);
    for (const [id, connector, kind] of [
      [device.accounts.meetings, "lens_meetings", "transcript"],
      [device.accounts.activity, "lens_activity", "screen_activity"],
      [device.accounts.blocks, "lens_blocks", "time_block"],
    ] as const) {
      await query(
        "insert into vault.source_accounts (id, label, connector, source_kind, compartments) values ($1, $2, $3, $4, '{own}')",
        [id, `device:${name}`, connector, kind],
      );
    }
    await query("commit");
  });
  return device;
}

// `source` marks a source rule.
async function insertScope(rule: {
  match: "bundle" | "host";
  value: string;
  compartment: string;
  kinds: string[];
  source?: string;
}): Promise<void> {
  const id = testId("csr");
  await admin(
    "insert into policy.capture_scope (id, match, value_fp, value_enc, compartment, kinds, source) values ($1, $2, $3, $4, $5, $6, $7)",
    [
      id,
      rule.match,
      fingerprint(db.keys, "capture_scope", rule.value),
      sealRow(db.keys, "own", { table: "policy.capture_scope", id, column: "value_enc" }, rule.value),
      rule.compartment,
      rule.kinds,
      rule.source ?? null,
    ],
  );
}

let keys = 0;
const keyOf = <K extends "meeting" | "moment" | "forget">(kind: K): `${K}:${string}` =>
  `${kind}:01JERASE${String((keys += 1)).padStart(18, "0")}`;
let batches = 0;
const batch = (): string => `erasure-batch-${String((batches += 1)).padStart(4, "0")}`;
const DEVON: CaptureMention = { name: "Devon Erasable", address: "devon.erasable@example.org" };
const ROBIN: CaptureMention = { name: "Robin Keptvale", address: "robin.keptvale@example.org" };
const READER = { bundle: "test.example.reader", name: "Reader" };
const MEET = { bundle: "test.example.meet", name: "Meet" };
const MESSAGES = { bundle: "com.apple.MobileSMS", name: "Messages" };
const sourceMoment = (participants: CaptureMention[] = [{ handle: "+15555550123" }]): MomentItem => {
  const lines = ["Can you send the tile quote?", "Sending it tonight."];
  return {
    kind: "moment",
    key: keyOf("moment"),
    revision: 0,
    observedAt: local(-30 * HOUR),
    endedAt: local(-30 * HOUR + 2 * MINUTE),
    app: MESSAGES,
    entity: "chat",
    participants,
    text: lines.join("\n"),
    read: "db",
    turns: [
      { from: 0, to: lines[0]?.length ?? 0, speaker: "participant", participant: 0, at: local(-30 * HOUR) },
      {
        from: (lines[0]?.length ?? 0) + 1,
        to: lines.join("\n").length,
        speaker: "owner",
        at: local(-30 * HOUR + 2 * MINUTE),
      },
    ],
    source: "imessage",
    threadKey: "chat:01JERASETHREADKEY000000001",
  };
};
const moment = (over: Partial<MomentItem> = {}): MomentItem => ({
  kind: "moment",
  key: keyOf("moment"),
  revision: 0,
  observedAt: local(-30 * HOUR),
  endedAt: local(-30 * HOUR + 5 * MINUTE),
  app: READER,
  url: "https://wiki.example.org/teams/alpha/plan",
  window: "Alpha plan",
  entity: "chat",
  participants: [],
  text: "The alpha plan, second draft.",
  read: "ax",
  ...over,
});

async function push(items: CaptureItem[]): Promise<void> {
  const answer = await reader.pushCapture(mac.capture.token, { batch: batch(), items });
  expect(answer.ok, JSON.stringify(answer)).toBe(true);
}
const captureOf = async (key: string) =>
  one(
    await admin<{ id: string; evidence_id: string; compartments: string[]; facts_enc: unknown }>(
      "select id, evidence_id, compartments, facts_enc from knowledge.captures where capture_key = $1",
      [key],
    ),
  );
const factsText = async (key: string): Promise<string> => {
  const row = await captureOf(key);
  return openUnder(
    db.keys,
    row.compartments,
    { table: "knowledge.captures", id: row.id, column: "facts_enc" },
    row.facts_enc as never,
  );
};

// An hour of the personal calendar thirty hours ago, the owner accepting and Devon attending.
const DEVON_EVENT = event({
  event: {
    id: "everasedevon01",
    status: "confirmed",
    etag: '"etag-everasedevon01"',
    updated: utc(-40 * HOUR),
    summary: "Planning",
    start: { dateTime: utc(-30 * HOUR) },
    end: { dateTime: utc(-29 * HOUR) },
    organizer: { email: OWNER.personal, self: true },
    attendees: [
      { email: OWNER.personal, self: true, responseStatus: "accepted" },
      { email: DEVON.address ?? "", displayName: DEVON.name ?? "", responseStatus: "accepted" },
    ],
  },
  title: "Planning",
  startsAt: utc(-30 * HOUR),
  endsAt: utc(-29 * HOUR),
  allDay: false,
});

beforeAll(async () => {
  db = await createTestDatabase({ compartments: ["own", "employer:example"] });
  const log = eventLogger();
  writer = createWriter({ url: db.urls.writer, keys: db.keys, log, journal: journalPath(db.keyFile) });
  reader = createReader({ url: db.urls.reader, keys: db.keys, log });
  owner = createAdmin({ url: db.urls.admin, keys: db.keys, log, journal: journalPath(db.keyFile) });
  accounts = await connect(writer);
  mac = await addDevice("mac");
  await insertScope({ match: "host", value: "wiki.example.org", compartment: "own", kinds: ["moment"] });
  await insertScope({ match: "bundle", value: MEET.bundle, compartment: "own", kinds: ["meeting"] });
  // Messages read from its own database.
  await insertScope({
    match: "bundle",
    value: MESSAGES.bundle,
    compartment: "own",
    kinds: ["moment"],
    source: "imessage",
  });
  await ingestEvent(writer, accounts.personalCalendar, DEVON_EVENT);
}, TIMEOUT);

afterAll(async () => {
  await owner?.close();
  await reader?.close();
  await writer?.close();
  await db?.drop();
});

describe("the captures hook and the erasure of a capture item", { timeout: TIMEOUT }, () => {
  it("ERASURE_HOOKS holds captures after pages and before the erasure's exposure links, last", () => {
    const names = ERASURE_HOOKS.map((hook) => hook.name);
    expect(names.indexOf("captures")).toBe(names.indexOf("pages") + 1);
    expect(names.at(-1)).toBe("vendor_exposures");
  });

  it("pi erase item cap_ removes the knowledge.captures row before the evidence row and writes the key to capture_erasures; a forget's key and a person's erasure write none", async () => {
    const item = moment();
    await push([item]);
    expect(await writer.takeCapture()).toMatchObject({ taken: 1, failed: 0 });
    const row = await captureOf(item.key);
    const id = row.id as CaptureId;
    // A dry run counts and writes nothing.
    const dry = await owner.erasure.eraseItem({ kind: "capture", id }, { requestId: testId("req"), dryRun: true });
    expect(dry.items).toBe(1);
    expect(await count("knowledge.captures", "id = $1", [id])).toBe(1);
    expect(await count("ledger.capture_erasures")).toBe(0);

    const report = await owner.erasure.eraseItem({ kind: "capture", id }, { requestId: testId("req") });
    expect(report).toMatchObject({ items: 1, people: 0 });
    // The capture row cites its evidence by a foreign key, so the evidence row could go only after it.
    expect(await count("knowledge.captures", "id = $1", [id])).toBe(0); // erasure-proves: knowledge.captures.evidence_id
    expect(await count("vault.evidence_items", "id = $1", [row.evidence_id])).toBe(0);
    expect(
      await admin(
        "select source_account_id as account, reason from knowledge.removed_evidence where source_item_fp = $1",
        [fingerprint(db.keys, "source_id", item.key)],
      ),
    ).toEqual([{ account: mac.accounts.activity, reason: "owner_erasure" }]);
    expect(
      one(
        await admin<{ kind: string; ruled: boolean }>(
          "select kind, ruling_id is not null as ruled from knowledge.erasures where id = $1",
          [report.erasure],
        ),
      ),
    ).toEqual({ kind: "item", ruled: true });
    // The key goes back to the Mac, to its mirror client, unconfirmed.
    expect(await admin("select client_id, capture_key, confirmed_at from ledger.capture_erasures")).toEqual([
      { client_id: mac.mirror.id, capture_key: item.key, confirmed_at: null },
    ]);

    // A forget's key writes none, settled through the same erasure path.
    const forgotten = moment();
    await push([forgotten]);
    await writer.takeCapture();
    await push([{ kind: "forget", key: keyOf("forget"), keys: [forgotten.key] }]);
    expect(await owner.lens.settleForgets()).toMatchObject({ settled: 1, failed: 0 });
    expect(await count("knowledge.captures", "capture_key = $1", [forgotten.key])).toBe(0);
    expect(await count("ledger.capture_erasures")).toBe(1);
  });

  it("a push of a key that has an owner_erasure removed-evidence row is dropped removed", async () => {
    const item = moment();
    await push([item]);
    await writer.takeCapture();
    await owner.erasure.eraseItem(
      { kind: "capture", id: (await captureOf(item.key)).id as CaptureId },
      { requestId: testId("req") },
    );
    const control = moment();
    await push([{ ...item, revision: 1, text: "The alpha plan, once more." }, control]);
    const counts = await writer.takeCapture();
    expect(counts.dropped.removed).toBe(1);
    expect(counts.taken).toBe(1);
    expect(await count("knowledge.captures", "capture_key = $1", [item.key])).toBe(0);
    expect(await count("knowledge.captures", "capture_key = $1", [control.key])).toBe(1);
  });

  it("a person's erasure clears the person's mentions and speaker entries from CaptureFacts", async () => {
    // A meeting linked to Devon's event, with Devon as S2 and an attendee, and a moment naming Devon and Robin.
    const talk: MeetingItem = {
      kind: "meeting",
      key: keyOf("meeting"),
      revision: 0,
      startedAt: local(-30 * HOUR + 5 * MINUTE),
      endedAt: local(-29 * HOUR),
      app: MEET,
      title: "Planning",
      consent: true,
      mode: "call",
      calendar: {
        start: local(-30 * HOUR),
        end: local(-29 * HOUR),
        organizer: { address: OWNER.personal },
        attendees: [DEVON, ROBIN],
      },
      attendees: [
        { name: DEVON.name ?? "Devon", email: DEVON.address ?? "" },
        { name: ROBIN.name ?? "Robin", email: ROBIN.address ?? "" },
      ],
      speakers: [
        { label: "S1", owner: true, mention: { address: OWNER.personal } },
        { label: "S2", owner: false, mention: DEVON },
        { label: "S3", owner: false, mention: ROBIN },
      ],
      segments: [
        { speaker: "S2", fromMs: 0, toMs: 20_000, channel: "output", text: "The plan holds." },
        { speaker: "S3", fromMs: 20_000, toMs: 40_000, channel: "output", text: "Agreed." },
      ],
    };
    const chat = moment({ participants: [DEVON, ROBIN] });
    await push([talk, chat]);
    expect(await writer.takeCapture()).toMatchObject({ taken: 2, failed: 0 });
    const devon = one(
      await admin<{ entity_id: string }>("select distinct entity_id from knowledge.accounts where value_fp = $1", [
        fingerprint(db.keys, "address", DEVON.address ?? ""),
      ]),
    ).entity_id;
    const before = await factsText(talk.key);
    expect(before).toContain(DEVON.address);
    expect(before).toContain(devon);
    expect(await factsText(chat.key)).toContain(DEVON.address);

    const report = await owner.erasure.erasePerson(devon as EntityId, { requestId: testId("req") });
    expect(report.more.captures).toBe(2);
    for (const key of [talk.key, chat.key]) {
      const after = await factsText(key);
      for (const gone of [DEVON.address ?? "", DEVON.name ?? "", devon])
        expect(after, `${key} ${gone}`).not.toContain(gone);
      // The control: Robin's mentions stay.
      expect(after, key).toContain(ROBIN.address);
    }
    // The capture items themselves stay, and no key goes back to the Mac.
    expect(await count("knowledge.captures", "capture_key = any($1)", [[talk.key, chat.key]])).toBe(2);
    expect(await count("ledger.capture_erasures", "capture_key = any($1)", [[talk.key, chat.key]])).toBe(0);
  });

  it("the next push's ack carries the keys the owner erased that no ack has carried, once, oldest first", async () => {
    const pushed = async (items: CaptureItem[]) => {
      const answer = await reader.pushCapture(mac.capture.token, { batch: batch(), items });
      if (!answer.ok) throw new Error(answer.code);
      return answer.value;
    };
    const [first, second] = [moment(), moment()];
    await pushed([first, second]);
    expect(await writer.takeCapture()).toMatchObject({ failed: 0 });
    // A push now carries, and marks, what earlier tests erased.
    await pushed([moment()]);
    for (const item of [first, second])
      await owner.erasure.eraseItem(
        { kind: "capture", id: (await captureOf(item.key)).id as CaptureId },
        { requestId: testId("req") },
      );
    const ack = await pushed([moment()]);
    expect(ack.erased).toEqual([first.key, second.key]);
    expect(ack.items).toHaveLength(1);
    // Once: the push after holds none, while the mirror has still not confirmed them.
    expect((await pushed([moment()])).erased).toBeUndefined();
    expect(
      await count(
        "ledger.capture_erasures",
        "capture_key = any($1) and confirmed_at is null and acked_at is not null",
        [[first.key, second.key]],
      ),
    ).toBe(2);
  });

  it("a push carries at most 500 erased keys, and the next carries the rest", async () => {
    await reader.pushCapture(mac.capture.token, { batch: batch(), items: [moment()] });
    const keys = Array.from({ length: 502 }, (_, n) => `moment:01JERASEB${String(n).padStart(17, "0")}`);
    // As pi_owner, as ledger.capture_erased writes them.
    await session(db.urls.bootstrap, async (query) => {
      await query("begin");
      await query("set local role pi_owner");
      await query(
        "insert into ledger.capture_erasures (client_id, capture_key, compartments) select $1, k, '{own}' from unnest($2::text[]) k",
        [mac.mirror.id, keys],
      );
      await query("commit");
    });
    const acks: (string[] | undefined)[] = [];
    for (let n = 0; n < 3; n += 1) {
      const answer = await reader.pushCapture(mac.capture.token, { batch: batch(), items: [moment()] });
      acks.push(answer.ok ? answer.value.erased : undefined);
    }
    expect(acks.map((one) => one?.length)).toEqual([500, 2, undefined]);
    expect(new Set([...(acks[0] ?? []), ...(acks[1] ?? [])])).toEqual(new Set(keys));
  });

  // L59's forget half: a source moment is forgotten and erased by its key as any moment is, and a
  // later push of its key is dropped removed, so the forget sticks.
  it("a forget of a source moment's key removes it and its claims, and a later revision of the key is dropped removed; pi erase item returns a source moment's key", async () => {
    const [forgotten, erased, control] = [sourceMoment(), sourceMoment(), sourceMoment()];
    await push([forgotten, erased]);
    // Earlier tests leave pushes undrained; this drain takes them too.
    expect(await writer.takeCapture()).toMatchObject({ failed: 0 });
    expect(await count("knowledge.captures", "capture_key = any($1)", [[forgotten.key, erased.key]])).toBe(2);
    const claim = fingerprint(db.keys, "claim", testId("fct"));
    const cited = await captureOf(forgotten.key);
    await admin(
      `insert into knowledge.claims (id, evidence_id, type, valid_from, fact_key_fp, extractor_generation, readers, content_enc, compartments)
       select $1, e.id, 'commitment', now(), $3, 1, e.readers, $4::jsonb, e.compartments from vault.evidence_items e where e.id = $2`,
      [
        claim,
        cited.evidence_id,
        fingerprint(db.keys, "fact", `fact ${claim}`),
        JSON.stringify(sealRow(db.keys, "own", { table: "knowledge.claims", id: claim, column: "content_enc" }, "{}")),
      ],
    );
    await push([{ kind: "forget", key: keyOf("forget"), keys: [forgotten.key] }]);
    expect(await owner.lens.settleForgets()).toMatchObject({ settled: 1, failed: 0 });
    expect(await count("knowledge.captures", "capture_key = $1", [forgotten.key])).toBe(0);
    expect(await count("knowledge.claims", "id = $1", [claim])).toBe(0);
    // Lens resends the session (its next revision) before it learns of the forget: dropped.
    await push([{ ...forgotten, revision: 1 }, control]);
    const counts = await writer.takeCapture();
    expect(counts.dropped.removed).toBe(1);
    expect(await count("knowledge.captures", "capture_key = $1", [forgotten.key])).toBe(0);
    // The owner's erasure of a source moment returns its key to the Mac, as any item's.
    await owner.erasure.eraseItem(
      { kind: "capture", id: (await captureOf(erased.key)).id as CaptureId },
      { requestId: testId("req") },
    );
    expect(await count("ledger.capture_erasures", "capture_key = $1", [erased.key])).toBe(1);
    expect(await count("knowledge.captures", "capture_key = $1", [control.key])).toBe(1);
  });
});
