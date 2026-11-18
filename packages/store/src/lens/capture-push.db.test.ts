import { createHash, randomBytes } from "node:crypto";
import {
  type BlockItem,
  type CaptureItem,
  type ForgetItem,
  type MeetingItem,
  MIRROR_QUOTA,
  type MomentItem,
  PushCaptureAck,
  type PushCaptureArgs,
  QUOTA_DEFAULTS,
} from "@intelligence/contracts/personal";
import { captureBlock } from "@intelligence/personal-core/lens";
import { fakeLens, type LensWorld } from "@intelligence/personal-core/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fingerprint } from "../core/fingerprint.ts";
import { openRow, sealRow } from "../core/seal.ts";
import { Reader } from "../read/read.ts";
import { sha256Hex, testId } from "../test-support/clients.ts";
import { one, readAs, session, sqlState } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import { openStore, type TestStore } from "../test-support/store.ts";

// Reader.pushCapture. One store for the file. Each device is registered by hand as the device
// registration makes it: its two clients, its policy.lens_devices row and its three source
// accounts. Every item is the world's (fakeLens), under a key of its own, so no test replays
// another's. Every refusal has its control in the same test.

const TIMEOUT = 120_000;
const NOW = new Date("2026-10-07T12:00:00.000Z");

type Channel = { id: string; name: string; token: string };
type Device = {
  name: string;
  capture: Channel;
  mirror: Channel;
  accounts: { meetings: string; activity: string; blocks: string };
};

let store: TestStore;
let lens: LensWorld;
let mac: Device;

// A device as `pi lens add NAME` makes it: the capture client NAME-capture (kind device,
// push_capture, self, own, retention none, the device quota), the mirror client NAME (kind agent,
// sync_mirror unless given more, ids stable, the mirror quota), the policy.lens_devices row naming
// both, and the three source accounts device:NAME, in one transaction.
async function addDevice(name: string, options: { mirrorTools?: string[]; row?: boolean } = {}): Promise<Device> {
  const channel = (client: string): Channel => ({
    id: testId("cli"),
    name: client,
    token: `pit_test-${client}-${randomBytes(8).toString("hex")}`,
  });
  const device: Device = {
    name,
    capture: channel(`${name}-capture`),
    mirror: channel(name),
    accounts: { meetings: testId("acc"), activity: testId("acc"), blocks: testId("acc") },
  };
  const insertClient = `insert into policy.clients (id, name, token_hash, status, vendor_retention, runtime, compartments, views, tools, kind, id_mode, max_items_day, max_chars_day, max_rows_day, max_calls_minute)
    values ($1, $2, $3, 'active', 'none', 'local', $4, $5, $6, $7, 'stable', $8, $9, $10, $11)`;
  const quota = (q: typeof MIRROR_QUOTA) => [q.maxItemsDay, q.maxCharsDay, q.maxRowsDay, q.maxCallsMinute];
  await session(store.db.urls.admin, async (query) => {
    await query("begin");
    await query(insertClient, [
      device.capture.id,
      device.capture.name,
      sha256Hex(device.capture.token),
      ["own"],
      ["self"],
      ["push_capture"],
      "device",
      ...quota(QUOTA_DEFAULTS.device),
    ]);
    await query(insertClient, [
      device.mirror.id,
      device.mirror.name,
      sha256Hex(device.mirror.token),
      ["own"],
      ["self", "people", "work"],
      options.mirrorTools ?? ["sync_mirror"],
      "agent",
      ...quota(MIRROR_QUOTA),
    ]);
    if (options.row !== false)
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

// Keys and batches of their own. The ULIDs here begin unlike the world's.
let keys = 0;
let batches = 0;
const ulid = (): string => `01JPVSHTEST${String((keys += 1)).padStart(15, "0")}`;
const fresh = <T extends CaptureItem>(item: T): T => ({ ...structuredClone(item), key: `${item.kind}:${ulid()}` });
const batch = (): string => `push-batch-${String((batches += 1)).padStart(4, "0")}`;
const args = (items: unknown[]): PushCaptureArgs => ({ batch: batch(), items }) as PushCaptureArgs;

const moment = (handle: keyof LensWorld["handles"]): MomentItem => {
  const found = lens.moments.find((item) => item.key === lens.handles[handle]);
  if (found === undefined) throw new Error(`no moment ${handle}`);
  return fresh(found);
};
const meeting = (handle: keyof LensWorld["handles"]): MeetingItem => {
  const found = lens.meetings.find((item) => item.key === lens.handles[handle]);
  if (found === undefined) throw new Error(`no meeting ${handle}`);
  return fresh(found);
};
const blockDay = (): BlockItem => fresh(lens.blocks[0] as BlockItem);
const forget = (named: string[]): ForgetItem => ({ kind: "forget", key: `forget:${ulid()}`, keys: named });
const withoutUrl = (item: MomentItem): MomentItem => {
  const { url: _url, ...rest } = item;
  return rest;
};

const push = (items: unknown[], device: Device = mac, reader: Reader = store.reader) =>
  reader.pushCapture(device.capture.token, args(items));
const ack = (outcomes: { item: CaptureItem; outcome: "accepted" | "replayed" | "refused"; code?: string }[]) => ({
  ok: true,
  value: {
    items: outcomes.map(({ item, outcome, code }) => ({
      key: item.key,
      outcome,
      ...(code === undefined ? {} : { code }),
    })),
  },
});

type InboxRow = {
  id: string;
  kind: string;
  compartments: string[];
  scope_fps: string[];
  source_key_fp: string;
  content_fp: string;
  body_bytes: number;
  body_enc: unknown;
  evidence_id: string | null;
  refused_code: string | null;
  session_id: string;
};
const inbox = (device: Device = mac): Promise<InboxRow[]> =>
  queryAs<InboxRow>(
    store.db.urls.admin,
    "select id, kind, compartments, scope_fps, source_key_fp, content_fp, body_bytes, body_enc, evidence_id, refused_code, session_id from ledger.capture_inbox where client_id = $1 order by received_at, id",
    [device.capture.id],
  );
const rowOf = async (item: CaptureItem, device: Device = mac): Promise<InboxRow | undefined> =>
  (await inbox(device)).find((row) => row.source_key_fp === fingerprint(store.db.keys, "source_id", item.key));
const calls = (device: Device = mac) =>
  queryAs<{ tool: string; outcome: string }>(
    store.db.urls.admin,
    "select tool, outcome from policy.calls where client_id = $1 order by id",
    [device.capture.id],
  );
const scopeFp = (value: string): string => fingerprint(store.db.keys, "capture_scope", value);

// As pi_owner, which policy.push_capture runs as and whose insert policies are `true`: rows a
// test seeds for the bounds, committed.
async function asOwner(sql: string, values: unknown[]): Promise<void> {
  await session(store.db.urls.bootstrap, async (query) => {
    await query("begin");
    await query("set local role pi_owner");
    await query(sql, values);
    await query("commit");
  });
}

// `count` inbox rows of the device's capture client, received `ago` before now, of its first
// session: what earlier accepted pushes would have left.
async function seedInbox(device: Device, count: number, ago: string): Promise<void> {
  const sessionId = (await inbox(device))[0]?.session_id;
  if (sessionId === undefined) throw new Error("the device has pushed nothing yet");
  const prefix = randomBytes(4).toString("hex");
  await asOwner(
    `insert into ledger.capture_inbox (id, client_id, session_id, batch, source_key_fp, revision, kind, scope_fps, content_fp, body_bytes, received_at, compartments)
     select 'cin_' || $5 || lpad(n::text, 19, '0'), $1, $2, 'seeded-batch', encode(sha256(convert_to($6 || 'k' || n, 'utf8')), 'hex'), 0, 'moment', '{}',
            encode(sha256(convert_to($6 || 'c' || n, 'utf8')), 'hex'), 100, now() - $4::interval, '{own}'
     from generate_series(1, $3::int) as n`,
    [device.capture.id, sessionId, count, ago, crockford7(), prefix],
  );
}
const crockford7 = (): string => testId("x").slice(-7);

// `source` marks a source rule.
async function insertScope(rule: LensWorld["scope"][number] & { source?: "imessage" }): Promise<void> {
  const id = testId("csr");
  const sealed = (column: string, value: string) =>
    sealRow(store.db.keys, "own", { table: "policy.capture_scope", id, column }, value);
  await queryAs(
    store.db.urls.admin,
    "insert into policy.capture_scope (id, match, value_fp, value_enc, account_fp, account_enc, compartment, kinds, source) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    [
      id,
      rule.match,
      scopeFp(rule.value),
      sealed("value_enc", rule.value),
      rule.account === undefined ? null : scopeFp(rule.account),
      rule.account === undefined ? null : sealed("account_enc", rule.account),
      rule.compartment,
      rule.kinds,
      rule.source ?? null,
    ],
  );
}

beforeAll(async () => {
  store = await openStore({ now: NOW });
  lens = fakeLens({ now: NOW });
  mac = await addDevice("mac");
  // The world's scope, and a host rule a browser meeting can match.
  for (const rule of [
    ...lens.scope,
    { match: "host" as const, value: "meet.example.org", compartment: "own", kinds: ["meeting" as const] },
  ])
    await insertScope(rule);
}, TIMEOUT);

afterAll(async () => {
  await store?.close();
});

describe("Reader.pushCapture: who may push", { timeout: TIMEOUT }, () => {
  it("push_capture reaches the inbox only through policy.push_capture, which raises 42501 for no client, a client of another kind, and a session that is not the client's", async () => {
    // A client of kind agent holding push_capture, which no registration allows: inserted by hand.
    const agent = { id: testId("cli"), token: `pit_test-agent-${randomBytes(8).toString("hex")}` };
    await queryAs(
      store.db.urls.admin,
      `insert into policy.clients (id, name, token_hash, status, vendor_retention, runtime, compartments, views, tools) values ($1, 'pusher-agent', $2, 'active', 'none', 'local', '{own}', '{self}', '{push_capture}')`,
      [agent.id, sha256Hex(agent.token)],
    );
    const agentSession = testId("ses");
    await readAs(store.db, agent.token, (query) => query("select policy.open_session($1)", [agentSession]));

    // The control first: the device's own push is accepted, and so has a session of its own.
    const item = moment("inScopeMoment");
    expect(await push([item])).toEqual(ack([{ item, outcome: "accepted" }]));
    const own = (await rowOf(item))?.session_id;
    expect(own).toMatch(/^ses_/);

    const call = (token: string | null, sessionId: string) => () =>
      readAs(store.db, token, (query) =>
        query("select * from policy.push_capture($1, $2, '[]'::jsonb, false)", [sessionId, "sql-batch-0001"]),
      );
    expect(await sqlState(call(null, own as string))).toBe("42501");
    expect(await sqlState(call(agent.token, agentSession))).toBe("42501");
    expect(await sqlState(call(mac.capture.token, agentSession))).toBe("42501");
    // The control: the device with its own session passes the permission check and is refused
    // only for its empty items.
    expect(await sqlState(call(mac.capture.token, own as string))).toBe("22023");
  });

  it("a client of kind device holds exactly push_capture, self and own, and push_capture is refused for any other kind or a device no policy.lens_devices row names", async () => {
    const agent = { id: testId("cli"), token: `pit_test-agent2-${randomBytes(8).toString("hex")}` };
    await queryAs(
      store.db.urls.admin,
      `insert into policy.clients (id, name, token_hash, status, vendor_retention, runtime, compartments, views, tools) values ($1, 'pusher-agent-two', $2, 'active', 'none', 'local', '{own}', '{self}', '{push_capture}')`,
      [agent.id, sha256Hex(agent.token)],
    );
    const orphan = await addDevice("orphan", { row: false });
    const item = moment("inScopeMoment");
    expect(await store.reader.pushCapture(agent.token, args([item]))).toEqual({ ok: false, code: "not_permitted" });
    expect(await push([item], orphan)).toEqual({ ok: false, code: "not_permitted" });
    expect(
      await queryAs(store.db.urls.admin, "select 1 from ledger.capture_inbox where client_id = any ($1)", [
        [agent.id, orphan.capture.id],
      ]),
    ).toEqual([]);
    // The control: the same item from a registered device.
    expect(await push([item])).toEqual(ack([{ item, outcome: "accepted" }]));
  });

  it("a revoked device's capture token is unauthorized and writes no row", async () => {
    const gone = await addDevice("gone");
    const item = moment("inScopeMoment");
    expect(await push([item], gone)).toEqual(ack([{ item, outcome: "accepted" }]));
    await queryAs(
      store.db.urls.admin,
      "update policy.clients set status = 'revoked', revoked_at = now() where id = $1",
      [gone.capture.id],
    );
    expect(await push([moment("inScopeMoment")], gone)).toEqual({ ok: false, code: "unauthorized" });
    expect(await inbox(gone)).toHaveLength(1);
  });
});

describe("Reader.pushCapture: the arguments", { timeout: TIMEOUT }, () => {
  it("a push carrying a label, a compartment, an entity id or any system id field is refused invalid_request and writes only its call row", async () => {
    const base = moment("inScopeMoment");
    const entity = `ent_${ulid()}`;
    const forged: unknown[][] = [
      [{ ...base, compartments: ["employer:example"] }],
      [{ ...base, label: { compartments: ["own"], readers: ["mac"] } }],
      [{ ...base, compartment: "employer:example" }],
      [{ ...base, entity: entity }],
      [{ ...base, entityId: entity }],
      [{ ...base, subject: entity }],
      [{ ...base, beliefId: `bel_${ulid().slice(4)}` }],
      [{ ...base, factKey: "fact:owner.employer" }],
      [{ ...base, evidenceId: "e".repeat(64) }],
      [{ ...base, participants: [{ name: "Devon Marsh", entityId: entity }] }],
      [{ ...meeting("linkedMeeting"), eventId: lens.linkedEvent.id }],
      [{ ...blockDay(), compartments: ["own"] }],
    ];
    for (const items of forged) {
      const before = { rows: (await inbox()).length, calls: (await calls()).length };
      expect(await push(items), JSON.stringify(Object.keys(items[0] as object))).toEqual({
        ok: false,
        code: "invalid_request",
      });
      expect((await inbox()).length).toBe(before.rows);
      const after = await calls();
      expect(after.length).toBe(before.calls + 1);
      expect(after.at(-1)).toEqual({ tool: "push_capture", outcome: "invalid_request" });
    }
    // A label or compartment beside the batch is refused the same way.
    expect(
      await store.reader.pushCapture(mac.capture.token, {
        ...args([base]),
        compartments: ["employer:example"],
      } as PushCaptureArgs),
    ).toEqual({ ok: false, code: "invalid_request" });
    expect(await rowOf(base)).toBeUndefined();
    // The control: the item as the contract has it.
    expect(await push([base])).toEqual(ack([{ item: base, outcome: "accepted" }]));
  });

  it("The inbox's shapes are strict: an off-shape item fails the whole batch as invalid_request", async () => {
    const good = moment("inScopeMoment");
    const offShape: unknown[] = [
      { ...moment("inScopeMoment"), kind: "note" },
      { ...moment("inScopeMoment"), text: "x".repeat(4001) },
      { ...moment("inScopeMoment"), read: "model" },
      { ...meeting("roomMeeting"), summary: "A model's summary." },
    ];
    for (const bad of offShape) {
      expect(await push([good, bad])).toEqual({ ok: false, code: "invalid_request" });
      expect(await rowOf(good)).toBeUndefined();
    }
    expect(await push([good])).toEqual(ack([{ item: good, outcome: "accepted" }]));
  });

  it("a batch holding a moment URL with a query or a fragment is invalid_request whole and writes only its call row", async () => {
    const good = moment("inScopeMoment");
    for (const url of [
      "https://wiki.example.org/teams/alpha?reset=abc",
      "https://wiki.example.org/teams/alpha#token",
      "https://wiki.example.org/teams/alpha?",
      "https://wiki.example.org/teams/alpha#",
    ]) {
      const before = (await calls()).length;
      expect(await push([good, { ...moment("inScopeMoment"), url }]), url).toEqual({
        ok: false,
        code: "invalid_request",
      });
      expect(await rowOf(good)).toBeUndefined();
      expect((await calls()).length).toBe(before + 1);
    }
    const second = moment("inScopeMoment");
    expect(await push([good, second])).toEqual(
      ack([
        { item: good, outcome: "accepted" },
        { item: second, outcome: "accepted" },
      ]),
    );
  });

  it("Bounds: a batch of 51 items, a moment over 4 000 code points, a block day of 501 blocks and a forget of 501 keys are each invalid_request", async () => {
    const fifty = Array.from({ length: 50 }, () => moment("inScopeMoment"));
    expect(await push([...fifty, moment("inScopeMoment")])).toEqual({ ok: false, code: "invalid_request" });
    const day = blockDay();
    const first = day.blocks[0];
    if (first === undefined) throw new Error("no block");
    expect(await push([{ ...day, blocks: Array.from({ length: 501 }, () => first) }])).toEqual({
      ok: false,
      code: "invalid_request",
    });
    expect(await push([forget(Array.from({ length: 501 }, () => `moment:${ulid()}`))])).toEqual({
      ok: false,
      code: "invalid_request",
    });
    // A moment's text is counted in code points: 4 000 emoji pass, 4 001 do not.
    const wide = moment("inScopeMoment");
    expect(await push([{ ...wide, text: "\u{1F600}".repeat(4001) }])).toEqual({ ok: false, code: "invalid_request" });
    expect(await rowOf(fifty[0] as MomentItem)).toBeUndefined();
    // The controls: 50 items, and 4 000 code points.
    expect((await push(fifty)).ok).toBe(true);
    const at = { ...wide, text: "\u{1F600}".repeat(4000) };
    expect(await push([at])).toEqual(ack([{ item: at, outcome: "accepted" }]));
  });
});

describe("Reader.pushCapture: the inbox row", { timeout: TIMEOUT }, () => {
  it("A row's compartments are {own}, set by the function, and its body is sealed under own", async () => {
    const item = moment("gmailAccountMoment");
    expect(await push([item])).toEqual(ack([{ item, outcome: "accepted" }]));
    const row = await rowOf(item);
    if (row === undefined) throw new Error("no row");
    // The rule that admitted it labels employer:example; the row is still the staging label.
    expect(row.compartments).toEqual(["own"]);
    const at = { table: "ledger.capture_inbox", id: row.id, column: "body_enc" };
    expect(JSON.parse(openRow(store.db.keys, "own", at, row.body_enc as never))).toEqual(item);
    expect(() => openRow(store.db.keys, "employer:example", at, row.body_enc as never)).toThrow();
    // Bound to its row: under another row's id it does not open.
    expect(() => openRow(store.db.keys, "own", { ...at, id: `cin_${ulid()}` }, row.body_enc as never)).toThrow();
  });

  it("an accepted row keeps its key's and content's fingerprints and its size, and an item refused at push leaves no body in the inbox", async () => {
    const accepted = moment("inScopeMoment");
    const refused = moment("outOfScopeMoment");
    expect(await push([accepted, refused])).toEqual(
      ack([
        { item: accepted, outcome: "accepted" },
        { item: refused, outcome: "refused", code: "out_of_scope" },
      ]),
    );
    const row = await rowOf(accepted);
    expect(row).toMatchObject({
      kind: "moment",
      source_key_fp: fingerprint(store.db.keys, "source_id", accepted.key),
      content_fp: fingerprint(
        store.db.keys,
        "content_hash",
        createHash("sha256").update(captureBlock(accepted)).digest("hex"),
      ),
      evidence_id: null,
      refused_code: null,
    });
    expect(row?.body_bytes).toBeGreaterThan(0);
    expect(row?.body_enc).not.toBeNull();
    expect([...(row?.scope_fps ?? [])].sort()).toEqual(
      [scopeFp("test.example.reader"), scopeFp("wiki.example.org")].sort(),
    );
    const left = await rowOf(refused);
    expect(left === undefined || left.body_enc === null).toBe(true);
  });

  it("a push writes one call row and no read-log row", async () => {
    const readLog = async () =>
      one(await queryAs<{ n: number }>(store.db.urls.admin, "select count(*)::int as n from ledger.read_log")).n;
    const before = { calls: (await calls()).length, reads: await readLog() };
    const item = moment("inScopeMoment");
    expect((await push([item, moment("outOfScopeMoment")])).ok).toBe(true);
    const after = await calls();
    expect(after.length).toBe(before.calls + 1);
    expect(after.at(-1)).toEqual({ tool: "push_capture", outcome: "ok" });
    expect(await readLog()).toBe(before.reads);
  });

  it("the capture_pushed log line holds counts, codes and the client id, and no canary", async () => {
    const from = store.log.events.length;
    const inScope = moment("inScopeMoment");
    const outOfScope = moment("outOfScopeMoment");
    expect((await push([inScope, outOfScope])).ok).toBe(true);
    const events = store.log.events.slice(from);
    const pushed = events.filter((event) => event.event === "capture_pushed");
    expect(pushed).toHaveLength(1);
    const [line] = pushed;
    expect(line?.ids?.device).toBe(mac.capture.id);
    expect(line?.counts?.accepted).toBe(1);
    expect(
      Object.entries(line?.counts ?? {}).some(([name, count]) => name.endsWith("out_of_scope") && count === 1),
    ).toBe(true);
    const text = JSON.stringify(events);
    for (const needle of [
      ...Object.values(lens.canaries),
      inScope.key.slice(7),
      outOfScope.key.slice(7),
      "wiki.example.org",
      "test.example.reader",
      "test.example.games",
      "player-two",
      mac.capture.token,
    ]) {
      expect(text, needle).not.toContain(needle);
    }
  });
});

describe("Reader.pushCapture: the scope", { timeout: TIMEOUT }, () => {
  it("an item with a host matches host rules only, never a bundle rule", async () => {
    // test.example.mail has a bundle rule for moments; a moment from it on a host no rule names is out of scope.
    const mail = moment("recoveryMoment");
    const hosted = { ...fresh(mail), url: "https://unruled.example.net/inbox" };
    const bare = withoutUrl(fresh(mail));
    expect(await push([hosted, bare])).toEqual(
      ack([
        { item: hosted, outcome: "refused", code: "out_of_scope" },
        { item: bare, outcome: "accepted" },
      ]),
    );
  });

  it("a browser meeting is accepted whether a host rule names it, it has no host, or no rule names its host; a browser moment with no rule is still out_of_scope", async () => {
    const browser = { bundle: "com.google.Chrome", name: "Chrome" };
    const hosted: MeetingItem = { ...meeting("roomMeeting"), app: browser, host: "meet.example.org" };
    const { host: _host, ...bare } = { ...meeting("roomMeeting"), app: browser, host: "meet.example.org" };
    const elsewhere: MeetingItem = { ...meeting("roomMeeting"), app: browser, host: "other.example.org" };
    // The control: a moment on the same unnamed host.
    const unruled = { ...moment("unruledBrowserMoment"), url: "https://other.example.org/room" };
    expect(await push([hosted, bare, elsewhere, unruled])).toEqual(
      ack([
        { item: hosted, outcome: "accepted" },
        { item: bare as MeetingItem, outcome: "accepted" },
        { item: elsewhere, outcome: "accepted" },
        { item: unruled, outcome: "refused", code: "out_of_scope" },
      ]),
    );
    // Its surface's fingerprints travel, so the drain can label it.
    expect((await rowOf(elsewhere))?.scope_fps).toContain(scopeFp("other.example.org"));
  });

  it("a moment from mail.google.com with no account is out_of_scope, and one whose account an employer:example rule names is accepted", async () => {
    const named = moment("gmailAccountMoment");
    const none = moment("gmailNoAccountMoment");
    const other = { ...moment("gmailAccountMoment"), account: "someone.else@example.org" };
    expect(await push([none, named, other])).toEqual(
      ack([
        { item: none, outcome: "refused", code: "out_of_scope" },
        { item: named, outcome: "accepted" },
        { item: other, outcome: "refused", code: "out_of_scope" },
      ]),
    );
    expect((await rowOf(named))?.scope_fps).toContain(scopeFp(named.account as string));
  });

  it("a Zoom meeting is accepted with an account an employer:example rule names, with no account, and with an account no rule names", async () => {
    const named = meeting("accountMeeting");
    const none = meeting("noAccountMeeting");
    const other = { ...meeting("accountMeeting"), account: "someone.else@example.org" };
    expect(await push([named, none, other])).toEqual(
      ack([
        { item: named, outcome: "accepted" },
        { item: none, outcome: "accepted" },
        { item: other, outcome: "accepted" },
      ]),
    );
    expect((await rowOf(other))?.scope_fps).toContain(scopeFp("someone.else@example.org"));
  });

  it("a moment from a browser on a host no rule names is out_of_scope, whatever rules name other hosts", async () => {
    const unruled = moment("unruledBrowserMoment");
    const ruled = { ...moment("unruledBrowserMoment"), url: "https://wiki.example.org/teams/beta" };
    const bare = withoutUrl(moment("unruledBrowserMoment"));
    expect(await push([unruled, ruled, bare])).toEqual(
      ack([
        { item: unruled, outcome: "refused", code: "out_of_scope" },
        { item: ruled, outcome: "accepted" },
        { item: bare, outcome: "refused", code: "out_of_scope" },
      ]),
    );
  });

  it("a block day is accepted when one block matches a rule of kind block, and refused out_of_scope when none does", async () => {
    const day = blockDay();
    const games = { bundle: "test.example.games", name: "Games" };
    const unruled: BlockItem = {
      ...blockDay(),
      blocks: day.blocks.map(({ host: _host, account: _account, ...block }) => ({ ...block, app: games })),
    };
    expect(await push([day, unruled])).toEqual(
      ack([
        { item: day, outcome: "accepted" },
        { item: unruled, outcome: "refused", code: "out_of_scope" },
      ]),
    );
    // Its scope fingerprints are the distinct ones of its blocks' bundles, hosts and accounts.
    const expected = [
      scopeFp("test.example.reader"),
      scopeFp("wiki.example.org"),
      scopeFp("us.zoom.xos"),
      scopeFp(day.blocks[1]?.account as string),
    ];
    expect([...((await rowOf(day))?.scope_fps ?? [])].sort()).toEqual(expected.sort());
  });

  // L54's push half: its own device, so the rules it adds and the calls it makes change no other
  // test's.
  it("a source moment is admitted only by a source rule, a Messages screen moment by none, and a block of Messages by its own rule", async () => {
    const messages = await addDevice("messages");
    const source = (handle: "sourceMoment" | "groupSourceMoment" | "messagesScreenMoment"): MomentItem => {
      const found = lens.sources.find((item) => item.key === lens.handles[handle]);
      if (found === undefined) throw new Error(`no source moment ${handle}`);
      return fresh(found);
    };
    const MESSAGES = { bundle: "com.apple.MobileSMS", name: "Messages" };
    const dayOfMessages = (): BlockItem => {
      const day = blockDay();
      return {
        ...day,
        blocks: day.blocks
          .slice(0, 1)
          .map(({ host: _host, account: _account, ...block }) => ({ ...block, app: MESSAGES })),
      };
    };
    // With no rule for the bundle: each refused.
    const [first, screen] = [source("sourceMoment"), source("messagesScreenMoment")];
    expect(await push([first, screen], messages)).toEqual(
      ack([
        { item: first, outcome: "refused", code: "out_of_scope" },
        { item: screen, outcome: "refused", code: "out_of_scope" },
      ]),
    );
    // A plain rule of the bundle for moments and blocks admits no source moment and no screen
    // moment, but a block of Messages.
    await insertScope({ match: "bundle", value: MESSAGES.bundle, compartment: "own", kinds: ["moment", "block"] });
    const [plain, screenToo, day] = [source("sourceMoment"), source("messagesScreenMoment"), dayOfMessages()];
    expect(await push([plain, screenToo, day], messages)).toEqual(
      ack([
        { item: plain, outcome: "refused", code: "out_of_scope" },
        { item: screenToo, outcome: "refused", code: "out_of_scope" },
        { item: day, outcome: "accepted" },
      ]),
    );
    // A source rule admits source moments, and still no screen moment.
    await insertScope({
      match: "bundle",
      value: MESSAGES.bundle,
      compartment: "own",
      kinds: ["moment"],
      source: "imessage",
    });
    const [admitted, group, screenStill] = [
      source("sourceMoment"),
      source("groupSourceMoment"),
      source("messagesScreenMoment"),
    ];
    expect(await push([admitted, group, screenStill], messages)).toEqual(
      ack([
        { item: admitted, outcome: "accepted" },
        { item: group, outcome: "accepted" },
        { item: screenStill, outcome: "refused", code: "out_of_scope" },
      ]),
    );
    // The inbox row keeps the source in clear; a block's has none.
    const sources = await queryAs<{ kind: string; source: string | null }>(
      store.db.urls.admin,
      "select kind, source from ledger.capture_inbox where client_id = $1 order by received_at, id",
      [messages.capture.id],
    );
    expect(sources).toEqual([
      { kind: "block", source: null },
      { kind: "moment", source: "imessage" },
      { kind: "moment", source: "imessage" },
    ]);
    // The function holds the screen rule itself: an item the store marks a source bundle's with no
    // source is refused whatever the rules, and a source on a block is invalid.
    const sessionId = (
      await queryAs<{ session_id: string }>(
        store.db.urls.admin,
        "select session_id from ledger.capture_inbox where client_id = $1 limit 1",
        [messages.capture.id],
      )
    )[0]?.session_id;
    const raw = (item: Record<string, unknown>) => () =>
      readAs(store.db, messages.capture.token, (query) =>
        query("select * from policy.push_capture($1, $2, $3::jsonb, false)", [
          sessionId,
          batch(),
          JSON.stringify([item]),
        ]),
      );
    const row = (kind: string, extra: Record<string, unknown>) => ({
      id: testId("cin"),
      kind,
      source_key_fp: createHash("sha256").update(testId("key")).digest("hex"),
      revision: 0,
      content_fp: "b".repeat(64),
      body_bytes: 2,
      body_enc: { v: 1, nonce: "n", ciphertext: "c", tag: "t" },
      surfaces: [
        { bundle_fp: scopeFp(MESSAGES.bundle), host_fp: null, account_fp: null, browser: false, multi_account: false },
      ],
      ...extra,
    });
    expect(await sqlState(raw(row("block", { source: "imessage", source_bundle: false })))).toBe("22023");
    expect(await sqlState(raw(row("block", { source: null, source_bundle: true })))).toBe("22023");
    expect(await sqlState(raw(row("moment", { source: null, source_bundle: "yes" })))).toBe("22023");
    expect(await sqlState(raw(row("moment", { source: "screen", source_bundle: true })))).toBe("22023");
    const screenRows = await readAs(store.db, messages.capture.token, (query) =>
      query<{ outcome: string; code: string | null }>(
        "select outcome, code from policy.push_capture($1, $2, $3::jsonb, false)",
        [sessionId, batch(), JSON.stringify([row("moment", { source: null, source_bundle: true })])],
      ),
    );
    expect(screenRows).toEqual([{ outcome: "refused", code: "out_of_scope" }]);
  });

  it("a rule removed with removeScope admits nothing more, and what it admitted stays stored", async () => {
    const id = await store.admin.lens.addScope({
      match: "host",
      value: "removed.example.org",
      compartment: "own",
      kinds: ["moment"],
    });
    const before = { ...moment("inScopeMoment"), url: "https://removed.example.org/page" };
    expect(await push([before])).toEqual(ack([{ item: before, outcome: "accepted" }]));
    await store.admin.lens.removeScope(id);
    const after = { ...moment("inScopeMoment"), url: "https://removed.example.org/page" };
    expect(await push([after])).toEqual(ack([{ item: after, outcome: "refused", code: "out_of_scope" }]));
    expect((await rowOf(before))?.body_enc).not.toBeNull();
  });
});

describe("Reader.pushCapture: idempotency and the ack", { timeout: TIMEOUT }, () => {
  it("Idempotency: a key and revision seen again is replayed with the same content and a conflict with other content, a lower revision is out_of_order, and a higher one is accepted", async () => {
    const first = { ...moment("inScopeMoment"), revision: 2 };
    expect(await push([first])).toEqual(ack([{ item: first, outcome: "accepted" }]));
    const rows = (await inbox()).length;
    expect(await push([first])).toEqual(ack([{ item: first, outcome: "replayed" }]));
    const changed = { ...first, text: `${first.text} and more` };
    expect(await push([changed])).toEqual(ack([{ item: changed, outcome: "refused", code: "conflict" }]));
    const lower = { ...first, revision: 1 };
    expect(await push([lower])).toEqual(ack([{ item: lower, outcome: "refused", code: "out_of_order" }]));
    expect((await inbox()).length).toBe(rows);
    const higher = { ...changed, revision: 3 };
    expect(await push([higher])).toEqual(ack([{ item: higher, outcome: "accepted" }]));
    expect((await inbox()).length).toBe(rows + 1);
    // A forget's key the same way.
    const notice = forget([first.key]);
    expect(await push([notice])).toEqual(ack([{ item: notice, outcome: "accepted" }]));
    expect(await push([notice])).toEqual(ack([{ item: notice, outcome: "replayed" }]));
    const other = { ...notice, keys: [higher.key, `moment:${ulid()}`] };
    expect(await push([other])).toEqual(ack([{ item: other, outcome: "refused", code: "conflict" }]));
  });

  it("an item holding a system id is dropped at drain, not at push: the push accepts it", async () => {
    const tripped = moment("systemIdMoment");
    expect(await push([tripped])).toEqual(ack([{ item: tripped, outcome: "accepted" }]));
    expect((await rowOf(tripped))?.refused_code).toBeNull();
  });

  it("the ack says accepted for an erased key, and nothing of what the drain will decide", async () => {
    const erased = moment("inScopeMoment");
    await queryAs(
      store.db.urls.admin,
      "insert into knowledge.removed_evidence (id, source_account_id, source_item_fp, evidence_ids, reason, removed_at, compartments) values ($1, $2, $3, '{}', 'device_forget', now(), '{own}')",
      [testId("rme"), mac.accounts.activity, fingerprint(store.db.keys, "source_id", erased.key)],
    );
    const systemId = moment("systemIdMoment");
    const recovery = moment("recoveryMoment");
    const recoveryMeeting = meeting("recoveryMeeting");
    const answer = await push([erased, systemId, recovery, recoveryMeeting]);
    // Exactly the key and the outcome of each, in order: no code, count or other field.
    expect(answer).toEqual(
      ack([erased, systemId, recovery, recoveryMeeting].map((item) => ({ item, outcome: "accepted" as const }))),
    );
    if (answer.ok) expect(PushCaptureAck.parse(answer.value)).toEqual(answer.value);
    // The control: a refusal the ack may carry does carry its code.
    const outOfScope = moment("outOfScopeMoment");
    expect(await push([outOfScope])).toEqual(ack([{ item: outOfScope, outcome: "refused", code: "out_of_scope" }]));
  });
});

describe("Reader.pushCapture: the rate limit and the storage ceiling, the push half", { timeout: TIMEOUT }, () => {
  it("the 5 001st item in 24 hours is rate_limited, and a batch of forgets alone after it is accepted", async () => {
    const day = await addDevice("daybound");
    const first = moment("inScopeMoment");
    expect(await push([first], day)).toEqual(ack([{ item: first, outcome: "accepted" }]));
    // 4 998 more in the last day, and three older than a day, which count for nothing.
    await seedInbox(day, 4998, "1 hour");
    await seedInbox(day, 3, "25 hours");
    const fiveThousandth = moment("inScopeMoment");
    expect(await push([fiveThousandth], day)).toEqual(ack([{ item: fiveThousandth, outcome: "accepted" }]));
    const over = moment("inScopeMoment");
    expect(await push([over], day)).toEqual({ ok: false, code: "rate_limited" });
    // A batch holding a capture item is refused whole, forgets and all.
    expect(await push([forget([first.key]), moment("inScopeMoment")], day)).toEqual({
      ok: false,
      code: "rate_limited",
    });
    expect(await rowOf(over, day)).toBeUndefined();
    const notice = forget([first.key, fiveThousandth.key]);
    expect(await push([notice], day)).toEqual(ack([{ item: notice, outcome: "accepted" }]));
  });

  it("at the storage ceiling every capture item is refused ceiling and every forget is accepted", async () => {
    const full = new Reader({
      pool: store.readerPool,
      keys: store.db.keys,
      log: store.log,
      now: () => NOW,
      captureCeilingBytes: 1,
    });
    const items = [
      moment("inScopeMoment"),
      meeting("roomMeeting"),
      blockDay(),
      forget([`moment:${ulid()}`]),
      moment("outOfScopeMoment"),
    ];
    expect(await push(items, mac, full)).toEqual(
      ack([
        { item: items[0] as CaptureItem, outcome: "refused", code: "ceiling" },
        { item: items[1] as CaptureItem, outcome: "refused", code: "ceiling" },
        { item: items[2] as CaptureItem, outcome: "refused", code: "ceiling" },
        { item: items[3] as CaptureItem, outcome: "accepted" },
        { item: items[4] as CaptureItem, outcome: "refused", code: "ceiling" },
      ]),
    );
    expect((await rowOf(items[0] as CaptureItem))?.body_enc ?? null).toBeNull();
    expect((await rowOf(items[3] as CaptureItem))?.kind).toBe("forget");
    // The control: under the default ceiling the same item is accepted.
    expect(await push([items[0] as CaptureItem])).toEqual(
      ack([{ item: items[0] as CaptureItem, outcome: "accepted" }]),
    );
  });

  it("the 121st call in a minute is rate_limited", async () => {
    const minute = await addDevice("minute");
    // 119 calls in the last minute, and five older, which count for nothing.
    const seed = (count: number, ago: string) =>
      asOwner(
        "insert into policy.calls (client_id, tool, at, rows, outcome) select $1, 'push_capture', now() - $3::interval, 1, 'ok' from generate_series(1, $2::int)",
        [minute.capture.id, count, ago],
      );
    await seed(119, "5 seconds");
    await seed(5, "61 seconds");
    const hundredTwentieth = moment("inScopeMoment");
    expect(await push([hundredTwentieth], minute)).toEqual(ack([{ item: hundredTwentieth, outcome: "accepted" }]));
    expect(await push([moment("inScopeMoment")], minute)).toEqual({ ok: false, code: "rate_limited" });
    // The call rate holds for every call, a batch of forgets alone among them.
    expect(await push([forget([hundredTwentieth.key])], minute)).toEqual({ ok: false, code: "rate_limited" });
    expect(await inbox(minute)).toHaveLength(1);
  });
});

// A device of its own, so its switch changes nothing another test pushes. Synthetic values:
// reserved domains, 555 numbers.
describe("Reader.pushCapture: Mac contacts", { timeout: TIMEOUT }, () => {
  const contact = (over: Record<string, unknown> = {}) => ({
    kind: "contact",
    key: `contact:${ulid()}`,
    revision: 0,
    name: "Lena Ortiz",
    phones: ["+15555550100"],
    emails: ["lena@example.com"],
    ...over,
  });
  const listing = (named: string[]) => ({ kind: "contacts", key: `contacts:${ulid()}`, revision: 0, keys: named });
  const switchOn = (device: Device, on: boolean) =>
    queryAs(store.db.urls.admin, "update policy.lens_devices set contacts = $2 where name = $1", [device.name, on]);
  let book: Device;
  beforeAll(async () => {
    book = await addDevice("contacts-mac");
  }, TIMEOUT);

  it("with the switch off a contact and a listing are refused out_of_scope and leave no row; on, each is accepted with no scope and replays as R15", async () => {
    const lena = contact() as unknown as CaptureItem;
    const list = listing([lena.key]) as unknown as CaptureItem;
    expect(await push([lena, list], book)).toEqual(
      ack([
        { item: lena, outcome: "refused", code: "out_of_scope" },
        { item: list, outcome: "refused", code: "out_of_scope" },
      ]),
    );
    expect(await inbox(book)).toEqual([]);

    await switchOn(book, true);
    expect(await push([lena], book)).toEqual(ack([{ item: lena, outcome: "accepted" }]));
    expect(await push([list], book)).toEqual(ack([{ item: list, outcome: "accepted" }]));
    const rows = await inbox(book);
    expect(rows.map((row) => [row.kind, row.compartments, row.scope_fps, row.refused_code, row.evidence_id])).toEqual([
      ["contact", ["own"], [], null, null],
      ["contacts", ["own"], [], null, null],
    ]);
    expect(rows.every((row) => row.body_enc !== null)).toBe(true);

    expect(await push([lena], book)).toEqual(ack([{ item: lena, outcome: "replayed" }]));
    const renamed = { ...lena, name: "Lena M. Ortiz" } as CaptureItem;
    expect(await push([renamed], book)).toEqual(ack([{ item: renamed, outcome: "refused", code: "conflict" }]));
    const next = { ...renamed, revision: 2 } as CaptureItem;
    expect(await push([next], book)).toEqual(ack([{ item: next, outcome: "accepted" }]));
    const lower = { ...lena, revision: 1 } as CaptureItem;
    expect(await push([lower], book)).toEqual(ack([{ item: lower, outcome: "refused", code: "out_of_order" }]));
    expect(await inbox(book)).toHaveLength(3);

    // Off again: refused, as a task is with its switch off.
    await switchOn(book, false);
    const later = contact() as unknown as CaptureItem;
    expect(await push([later], book)).toEqual(ack([{ item: later, outcome: "refused", code: "out_of_scope" }]));
    expect(await inbox(book)).toHaveLength(3);
  });

  it("a batch with a contact key twice, or a listing at a revision other than 0, fails whole as invalid_request", async () => {
    await switchOn(book, true);
    const lena = contact();
    expect(await push([lena, { ...lena, name: "Lena Ortiz Two" }], book)).toEqual({
      ok: false,
      code: "invalid_request",
    });
    expect(await push([{ ...listing([]), revision: 1 }], book)).toEqual({ ok: false, code: "invalid_request" });
    expect(await push([contact({ phones: [], emails: [] })], book)).toEqual({ ok: false, code: "invalid_request" });
    await switchOn(book, false);
  });
});
