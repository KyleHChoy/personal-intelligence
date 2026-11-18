import { randomBytes } from "node:crypto";
import {
  type CaptureItem,
  MIRROR_QUOTA,
  type MomentCaptureFacts,
  type MomentItem,
  QUOTA_DEFAULTS,
} from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Admin, createAdmin } from "../admin/admin.ts";
import { journalPath } from "../core/journal.ts";
import { openUnder, sealRow } from "../core/seal.ts";
import { createReader, type Reader } from "../read/read.ts";
import { sha256Hex, testId } from "../test-support/clients.ts";
import { one, session, sqlState } from "../test-support/connections.ts";
import { createTestDatabase, fingerprint, queryAs, type TestDatabase } from "../test-support/database.ts";
import { eventLogger } from "../test-support/recording.ts";
import { refusedWith } from "../test-support/values.ts";
import { createWriter, type Writer } from "../write/writer.ts";

// `pia lens backfill vouch NAME`: the owner's one vouch for a device's first backfill of source
// moments, and the drain's `vouched` mark. One database for the file; the device and its source
// rule are written by hand, as the drain's tests write them. Synthetic Messages sessions on 555
// numbers. Every refusal has its control in the same test.

const TIMEOUT = 120_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const T = Math.floor(Date.now() / MINUTE) * MINUTE;
const local = (offset: number): string => `${new Date(T + offset - 5 * HOUR).toISOString().slice(0, 19)}-05:00`;
const MESSAGES = { bundle: "com.apple.MobileSMS", name: "Messages" };
const CHAT = { bundle: "test.example.chat", name: "Chat" };

let db: TestDatabase;
let writer: Writer;
let reader: Reader;
let owner: Admin;
let token: string;
let other: string;

const admin = <Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(db.urls.admin, sql, values);

// A device as `pi lens add NAME` makes it, by hand; its capture token.
async function addDevice(name: string): Promise<string> {
  const capture = { id: testId("cli"), token: `pit_test-${name}-capture-${randomBytes(8).toString("hex")}` };
  const mirror = testId("cli");
  const quota = (q: typeof MIRROR_QUOTA) => [q.maxItemsDay, q.maxCharsDay, q.maxRowsDay, q.maxCallsMinute];
  const insert = `insert into policy.clients (id, name, token_hash, status, vendor_retention, runtime, compartments, views, tools, kind, id_mode, max_items_day, max_chars_day, max_rows_day, max_calls_minute)
    values ($1, $2, $3, 'active', 'none', 'local', $4, $5, $6, $7, 'stable', $8, $9, $10, $11)`;
  await session(db.urls.admin, async (query) => {
    await query("begin");
    await query(insert, [
      capture.id,
      `${name}-capture`,
      sha256Hex(capture.token),
      ["own"],
      ["self"],
      ["push_capture"],
      "device",
      ...quota(QUOTA_DEFAULTS.device),
    ]);
    await query(insert, [
      mirror,
      name,
      sha256Hex(`pit_test-${name}-${randomBytes(8).toString("hex")}`),
      ["own"],
      ["self", "people", "work"],
      ["sync_mirror"],
      "agent",
      ...quota(MIRROR_QUOTA),
    ]);
    await query("insert into policy.lens_devices (name, capture_client_id, mirror_client_id) values ($1, $2, $3)", [
      name,
      capture.id,
      mirror,
    ]);
    await query(
      "insert into vault.source_accounts (id, label, connector, source_kind, compartments) values ($1, $2, 'lens_activity', 'screen_activity', '{own}')",
      [testId("acc"), `device:${name}`],
    );
    await query("commit");
  });
  return capture.token;
}

async function rule(bundle: string, source: string | null): Promise<void> {
  const id = testId("csr");
  await admin(
    "insert into policy.capture_scope (id, match, value_fp, value_enc, compartment, kinds, source) values ($1, 'bundle', $2, $3, 'own', '{moment}', $4)",
    [
      id,
      fingerprint(db.keys, "capture_scope", bundle),
      sealRow(db.keys, "own", { table: "policy.capture_scope", id, column: "value_enc" }, bundle),
      source,
    ],
  );
}

let keys = 0;
const keyOf = (): string => `moment:01JVXXCHED${String((keys += 1)).padStart(16, "0")}`;
// A backfilled session of one Messages chat, two days old: the participant's line, then the owner's.
const session_ = (over: Partial<MomentItem> = {}): MomentItem => {
  const lines = ["Did you book the ferry for Saturday?", "Yes, I will send you the tickets tonight."];
  const text = lines.join("\n");
  return {
    kind: "moment",
    key: keyOf(),
    revision: 0,
    observedAt: local(-2 * DAY),
    endedAt: local(-2 * DAY + 2 * MINUTE),
    app: MESSAGES,
    entity: "chat",
    participants: [{ handle: "+15555550401" }],
    text,
    read: "db",
    turns: [
      { from: 0, to: lines[0]?.length ?? 0, speaker: "participant", participant: 0, at: local(-2 * DAY) },
      { from: (lines[0]?.length ?? 0) + 1, to: text.length, speaker: "owner", at: local(-2 * DAY + 2 * MINUTE) },
    ],
    source: "imessage",
    threadKey: "chat:01JVXXCHEDTHREAD0000000001",
    ...over,
  };
};
// A chat of another app read from the screen, as old.
const screen = (): MomentItem => {
  const text = "Yes, I will send you the tickets tonight.";
  return {
    kind: "moment",
    key: keyOf(),
    revision: 0,
    observedAt: local(-2 * DAY),
    endedAt: local(-2 * DAY),
    app: CHAT,
    window: "Ferry",
    entity: "chat",
    participants: [{ name: "Lena Park" }],
    text,
    read: "ax",
    turns: [{ from: 0, to: text.length, speaker: "owner" }],
  };
};

let batches = 0;
async function push(items: CaptureItem[], capture = token): Promise<void> {
  batches += 1;
  const answer = await reader.pushCapture(capture, { batch: `vouch-batch-${String(batches).padStart(4, "0")}`, items });
  expect(answer.ok, JSON.stringify(answer)).toBe(true);
  if (answer.ok) for (const item of answer.value.items) expect(item.outcome, item.key).toBe("accepted");
}
async function factsOf(
  key: string,
): Promise<{ facts: MomentCaptureFacts; item: MomentCaptureFacts; generation: number | null }> {
  const row = one(
    await admin<{
      id: string;
      compartments: string[];
      facts_enc: unknown;
      evidence_id: string;
      item_compartments: string[];
      item_enc: unknown;
      generation: number | null;
    }>(
      `select c.id, c.compartments, c.facts_enc, c.evidence_id, e.compartments as item_compartments, e.item_enc, p.extractor_generation as generation
       from knowledge.captures c join vault.evidence_items e on e.id = c.evidence_id left join vault.pipeline_items p on p.evidence_id = e.id where c.capture_key = $1`,
      [key],
    ),
  );
  return {
    facts: JSON.parse(
      openUnder(
        db.keys,
        row.compartments,
        { table: "knowledge.captures", id: row.id, column: "facts_enc" },
        row.facts_enc as never,
      ),
    ) as MomentCaptureFacts,
    item: JSON.parse(
      openUnder(
        db.keys,
        row.item_compartments,
        { table: "vault.evidence_items", id: row.evidence_id, column: "item_enc" },
        row.item_enc as never,
      ),
    ) as MomentCaptureFacts,
    generation: row.generation,
  };
}
const code = (value: string) => ({ name: "AdminError", code: value });

beforeAll(async () => {
  db = await createTestDatabase({ compartments: ["own"] });
  const log = eventLogger();
  writer = createWriter({ url: db.urls.writer, keys: db.keys, log, journal: journalPath(db.keyFile) });
  reader = createReader({ url: db.urls.reader, keys: db.keys, log });
  owner = createAdmin({ url: db.urls.admin, keys: db.keys, log, journal: journalPath(db.keyFile) });
  token = await addDevice("mac");
  other = await addDevice("spare");
  await rule(MESSAGES.bundle, "imessage");
  await rule(CHAT.bundle, null);
}, TIMEOUT);

afterAll(async () => {
  await owner?.close();
  await reader?.close();
  await writer?.close();
  await db?.drop();
});

describe("the owner's one vouch for a backfill", { timeout: TIMEOUT }, () => {
  it("refused for no such device and for a device with no source moment pushed; the control is vouched", async () => {
    expect(await refusedWith(() => owner.lens.vouchBackfill("absent"))).toEqual(code("not_found"));
    expect(await refusedWith(() => owner.lens.vouchBackfill("spare"))).toEqual(code("not_found"));
    // A session the drain dropped (a recovery marker) is no backfill stored: the window starts at
    // the first one stored.
    const code_ = "Enter the verification code 551920 to continue.";
    const dropped = session_({
      text: `${code_}\nOk.`,
      turns: [
        { from: 0, to: code_.length, speaker: "participant", participant: 0, at: local(-2 * DAY) },
        { from: code_.length + 1, to: code_.length + 4, speaker: "owner", at: local(-2 * DAY + 2 * MINUTE) },
      ],
    });
    await push([dropped], other);
    expect((await writer.takeCapture()).dropped.recovery).toBe(1);
    expect(await refusedWith(() => owner.lens.vouchBackfill("spare"))).toEqual(code("not_found"));
    expect(await admin("select backfill_vouched_at from policy.lens_devices where name = 'spare'")).toEqual([
      { backfill_vouched_at: null },
    ]);
    // The control: the spare device pushes a session that is stored, and its vouch starts there.
    const kept = session_();
    await push([kept], other);
    await writer.takeCapture();
    const answer = await owner.lens.vouchBackfill("spare");
    expect(answer.moments).toBe(1);
    const stored = one(
      await admin<{ at: Date }>("select received_at as at from ledger.capture_inbox where source_key_fp = $1", [
        fingerprint(db.keys, "source_id", kept.key),
      ]),
    ).at;
    expect(answer.from).toBe(stored.toISOString());
  });

  it("a backfill stored before the vouch is vouched by it: its facts gain the mark and it is due again; a screen moment pushed beside it is not", async () => {
    const [first, late, chat] = [session_(), session_(), screen()];
    await push([first, chat]);
    await push([late]);
    expect(await writer.takeCapture()).toMatchObject({ taken: 3, failed: 0 });
    expect((await factsOf(first.key)).facts).not.toHaveProperty("vouched");
    const answer = await owner.lens.vouchBackfill("mac");
    expect(answer.moments).toBe(2);
    expect(Date.parse(answer.to) - Date.parse(answer.from)).toBe(48 * HOUR);
    const pushed = one(
      await admin<{ at: Date }>(
        "select min(i.received_at) as at from ledger.capture_inbox i join policy.lens_devices d on d.capture_client_id = i.client_id where d.name = 'mac' and i.source is not null",
      ),
    ).at;
    expect(answer.from).toBe(pushed.toISOString());
    for (const key of [first.key, late.key]) {
      const stored = await factsOf(key);
      expect([stored.facts.vouched, stored.item.vouched], key).toEqual([true, true]);
      // Never extracted, it has no pipeline row and is due as it was; one extracted before is set
      // waiting by the anchor re-check's replay (admin-projects.ts replayMoments, its own tests).
      expect([null, 0], key).toContain(stored.generation);
    }
    expect((await factsOf(chat.key)).facts).not.toHaveProperty("vouched");
  });

  it("a session pushed later inside the window is vouched at drain; one pushed after it is not, nor is a screen moment", async () => {
    const [inside, chat] = [session_(), screen()];
    await push([inside, chat]);
    await writer.takeCapture();
    expect((await factsOf(inside.key)).facts.vouched).toBe(true);
    expect((await factsOf(chat.key)).facts).not.toHaveProperty("vouched");
    // The window's end moved into the past, as pi_owner, the trigger and the forced row security lifted for the statement: a
    // revision pushed now is past it.
    await session(db.urls.bootstrap, async (query) => {
      await query("begin");
      await query("set local role pi_owner");
      await query("alter table policy.lens_devices disable trigger lens_devices_vouch_once");
      await query("alter table policy.lens_devices no force row level security");
      expect(
        await query(
          "update policy.lens_devices set backfill_vouch_from = now() - interval '3 days', backfill_vouch_to = now() - interval '1 day' where name = 'mac' returning name",
        ),
      ).toHaveLength(1);
      await query("alter table policy.lens_devices force row level security");
      await query("alter table policy.lens_devices enable trigger lens_devices_vouch_once");
      await query("commit");
    });
    const after = {
      ...inside,
      revision: 1,
      text: `${inside.text}!`,
      turns: inside.turns?.map((turn, n) => (n === 1 ? { ...turn, to: turn.to + 1 } : turn)),
    } as MomentItem;
    await push([after]);
    await writer.takeCapture();
    expect((await factsOf(inside.key)).facts).not.toHaveProperty("vouched");
  });

  it("a second vouch is refused, and the database holds the window once: no update moves, reopens or clears it", async () => {
    expect(await refusedWith(() => owner.lens.vouchBackfill("mac"))).toEqual(code("already_settled"));
    expect(
      await sqlState(() =>
        admin(
          "update policy.lens_devices set backfill_vouch_to = backfill_vouch_to - interval '1 hour' where name = 'mac'",
        ),
      ),
    ).toBe("23514");
    expect(
      await sqlState(() =>
        admin(
          "update policy.lens_devices set backfill_vouch_from = null, backfill_vouch_to = null, backfill_vouched_at = null where name = 'mac'",
        ),
      ),
    ).toBe("23514");
    // The control: the device's other columns still change.
    expect(await sqlState(() => admin("update policy.lens_devices set tasks = true where name = 'mac'"))).toBeNull();
    // The writer reads the window and writes none; the reader reads none.
    expect(
      await admin("select count(*)::int as n from policy.lens_devices where backfill_vouched_at is not null"),
    ).toEqual([{ n: 2 }]);
    expect(
      await sqlState(() =>
        queryAs(db.urls.writer, "update policy.lens_devices set backfill_vouch_to = now() where name = 'spare'"),
      ),
    ).toBe("42501");
    expect(await sqlState(() => queryAs(db.urls.reader, "select backfill_vouch_from from policy.lens_devices"))).toBe(
      "42501",
    );
  });
});
