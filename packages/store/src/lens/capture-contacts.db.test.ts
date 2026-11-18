import { randomBytes } from "node:crypto";
import { type EvidenceId, Timestamp } from "@intelligence/contracts";
import {
  type CaptureItem,
  type EntityId,
  type MacContactItem,
  MIRROR_QUOTA,
  type MomentItem,
  QUOTA_DEFAULTS,
} from "@intelligence/contracts/personal";
import { PERSONAL_LIMITS } from "@intelligence/personal-core";
import { contactItem, deriveItem, macContactItem, whitelistedContact } from "@intelligence/personal-core/items";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Admin, createAdmin } from "../admin/admin.ts";
import { journalPath } from "../core/journal.ts";
import { sealRow } from "../core/seal.ts";
import { createReader, type Reader } from "../read/read.ts";
import { connect, OWNER } from "../test-support/cast.ts";
import { sha256Hex, testId } from "../test-support/clients.ts";
import { one, session } from "../test-support/connections.ts";
import { createTestDatabase, fingerprint, queryAs, type TestDatabase } from "../test-support/database.ts";
import { eventLogger, recordingLogger } from "../test-support/recording.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { createWriter, type Writer } from "../write/writer.ts";

// The Mac contacts Lens sends, pushed as Lens pushes them and drained by the writer's takeContacts
// as `pi sync` runs it. One database for the file; each test its own phones, addresses and keys.
// Synthetic people on reserved domains and 555 numbers; no model.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T = Math.floor(Date.now() / MINUTE) * MINUTE;
const local = (offset: number): string => `${new Date(T + offset - 5 * HOUR).toISOString().slice(0, 19)}-05:00`;
const MESSAGES = { bundle: "com.apple.MobileSMS", name: "Messages" };
const own = { metadata: { source: { type: "CONTACT", id: "c" } } };

type World = {
  db: TestDatabase;
  writer: Writer;
  reader: Reader;
  admin: Admin;
  token: string;
  google: Awaited<ReturnType<Writer["ensureSourceAccount"]>>;
};
let w: World;
let serial = 0;
const ulid = (): string => `01JMACC${String((serial += 1)).padStart(19, "0")}`;
let batches = 0;

async function addDevice(db: TestDatabase): Promise<string> {
  const capture = { id: testId("cli"), token: `pit_test-mac-capture-${randomBytes(8).toString("hex")}` };
  const mirror = testId("cli");
  const quota = (q: typeof MIRROR_QUOTA) => [q.maxItemsDay, q.maxCharsDay, q.maxRowsDay, q.maxCallsMinute];
  const insertClient = `insert into policy.clients (id, name, token_hash, status, vendor_retention, runtime, compartments, views, tools, kind, id_mode, max_items_day, max_chars_day, max_rows_day, max_calls_minute)
    values ($1, $2, $3, 'active', 'none', 'local', $4, $5, $6, $7, 'stable', $8, $9, $10, $11)`;
  await session(db.urls.admin, async (query) => {
    await query("begin");
    await query(insertClient, [
      capture.id,
      "mac-capture",
      sha256Hex(capture.token),
      ["own"],
      ["self"],
      ["push_capture"],
      "device",
      ...quota(QUOTA_DEFAULTS.device),
    ]);
    await query(insertClient, [
      mirror,
      "mac",
      sha256Hex(`pit_test-mac-${randomBytes(8).toString("hex")}`),
      ["own"],
      ["self", "people", "work"],
      ["sync_mirror"],
      "agent",
      ...quota(MIRROR_QUOTA),
    ]);
    await query("insert into policy.lens_devices (name, capture_client_id, mirror_client_id) values ($1, $2, $3)", [
      "mac",
      capture.id,
      mirror,
    ]);
    await query(
      "insert into vault.source_accounts (id, label, connector, source_kind, compartments) values ($1, 'device:mac', 'lens_activity', 'screen_activity', '{own}')",
      [testId("acc")],
    );
    const rule = testId("csr");
    await query(
      "insert into policy.capture_scope (id, match, value_fp, value_enc, compartment, kinds, source) values ($1, 'bundle', $2, $3, 'own', '{moment}', 'imessage')",
      [
        rule,
        fingerprint(db.keys, "capture_scope", MESSAGES.bundle),
        sealRow(db.keys, "own", { table: "policy.capture_scope", id: rule, column: "value_enc" }, MESSAGES.bundle),
      ],
    );
    await query("commit");
  });
  return capture.token;
}

const contact = (over: Partial<MacContactItem> = {}): MacContactItem => ({
  kind: "contact",
  key: `contact:${ulid()}`,
  revision: 0,
  name: "Lena Ortiz",
  phones: [],
  emails: [],
  ...over,
});
const listing = (keys: string[]) => ({
  kind: "contacts" as const,
  key: `contacts:${ulid()}`,
  revision: 0 as const,
  keys,
});
async function push(items: unknown[]): Promise<void> {
  const answer = await w.reader.pushCapture(w.token, {
    batch: `mac-contacts-${String((batches += 1)).padStart(4, "0")}`,
    items: items as CaptureItem[],
  });
  expect(answer.ok && answer.value.items.every((item) => item.outcome === "accepted")).toBe(true);
}
const take = () => w.writer.takeContacts();

// What is stored: the device's Mac contacts, the person an address or a phone key names, people.
const macContacts = async (): Promise<number> =>
  one(
    await queryAs<{ n: number }>(
      w.db.urls.admin,
      "select count(*)::int as n from knowledge.contacts c join vault.source_accounts a on a.id = c.account_id where a.connector = 'lens_contacts'",
    ),
  ).n;
const personOf = async (address: string): Promise<string | null> =>
  (
    await queryAs<{ entity_id: string }>(
      w.db.urls.admin,
      "select entity_id from knowledge.accounts where value_fp = $1 limit 1",
      [fingerprint(w.db.keys, "address", address)],
    )
  )[0]?.entity_id ?? null;
const people = async (): Promise<number> =>
  one(
    await queryAs<{ n: number }>(
      w.db.urls.admin,
      "select count(*)::int as n from knowledge.entities where kind = 'person'",
    ),
  ).n;
const aliasesOf = async (entity: string): Promise<string[]> =>
  (
    await queryAs<{ id: string; value_enc: unknown; compartments: string[] }>(
      w.db.urls.admin,
      "select id, value_enc, compartments from knowledge.aliases where entity_id = $1 order by id",
      [entity],
    )
  )
    .map((row) => JSON.stringify(row))
    .sort();
const inboxCode = async (key: string): Promise<{ code: string | null; taken: boolean }[]> =>
  queryAs<{ code: string | null; taken: boolean }>(
    w.db.urls.admin,
    "select refused_code as code, taken_at is not null as taken from ledger.capture_inbox where source_key_fp = $1 order by received_at",
    [fingerprint(w.db.keys, "source_id", key)],
  );

// A Google contact of the owner's own account, saved with these addresses and phones.
async function saved(resource: string, person: { name: string; emails: string[]; phones: string[] }): Promise<void> {
  const read = whitelistedContact({
    resourceName: `people/${resource}`,
    metadata: { sources: [{ type: "CONTACT", id: resource, updateTime: new Date(T - HOUR).toISOString() }] },
    names: [{ ...own, displayName: person.name }],
    emailAddresses: person.emails.map((value) => ({ ...own, value })),
    phoneNumbers: person.phones.map((value) => ({ ...own, value })),
  });
  if (read === null) throw new Error("refused");
  const raw = contactItem(read, {
    sourceAccount: w.google.id,
    changeKind: "backfill",
    now: Timestamp.parse(new Date(T).toISOString()),
  });
  expect(await w.writer.ingestItem(w.google, raw, (ctx) => deriveItem(raw, ctx, PERSONAL_LIMITS))).toBe("stored");
}

// One stored source moment of a chat with these handles, drained, its status row done at
// generation 7, so a re-ask is seen as generation 0.
let threads = 0;
async function moment(handles: string[]): Promise<EvidenceId> {
  threads += 1;
  const lines = [...handles.map((_, n) => `Line ${n + 1}: the tiles arrive on Thursday.`), "Thanks, I will be in."];
  const text = lines.join("\n");
  let from = 0;
  const turns = lines.map((line, n) => {
    const turn = {
      from,
      to: from + line.length,
      ...(n < handles.length ? { speaker: "participant" as const, participant: n } : { speaker: "owner" as const }),
      at: local(-HOUR + threads * MINUTE),
    };
    from += line.length + 1;
    return turn;
  });
  const item: MomentItem = {
    kind: "moment",
    key: `moment:${ulid()}`,
    revision: 0,
    observedAt: local(-HOUR + threads * MINUTE),
    endedAt: local(-HOUR + threads * MINUTE),
    app: MESSAGES,
    entity: "chat",
    participants: [...handles].sort().map((handle) => ({ handle })),
    text,
    read: "db",
    turns,
    source: "imessage",
    threadKey: `chat:01JMACCTHREAD${String(threads).padStart(13, "0")}`,
  };
  await push([item]);
  expect(await w.writer.takeCapture()).toMatchObject({ failed: 0, waiting: 0 });
  const evidence = one(
    await queryAs<{ evidence_id: EvidenceId }>(
      w.db.urls.admin,
      "select evidence_id from knowledge.captures where capture_key = $1",
      [item.key],
    ),
  ).evidence_id;
  await queryAs(
    w.db.urls.admin,
    "insert into vault.pipeline_items (evidence_id, waiting, withheld, screened, extractor_generation, updated_at, compartments, facts_enc) values ($1, false, false, true, 7, now(), '{own}', $2)",
    [
      evidence,
      sealRow(
        w.db.keys,
        "own",
        { table: "vault.pipeline_items", id: evidence, column: "facts_enc" },
        JSON.stringify({
          lane: "moment",
          override: false,
          status: "done",
          attempts: 1,
          claims: 0,
          unmapped: 0,
          unresolved: 0,
        }),
      ),
    ],
  );
  return evidence;
}
const generationOf = async (evidence: EvidenceId): Promise<number> =>
  one(
    await queryAs<{ g: number }>(
      w.db.urls.admin,
      "select extractor_generation as g from vault.pipeline_items where evidence_id = $1",
      [evidence],
    ),
  ).g;
const settled = (evidence: EvidenceId) =>
  queryAs(w.db.urls.admin, "update vault.pipeline_items set extractor_generation = 7 where evidence_id = $1", [
    evidence,
  ]);

beforeAll(async () => {
  const db = await createTestDatabase({ compartments: ["own", "employer:example"] });
  const log = eventLogger();
  const writer = createWriter({ url: db.urls.writer, keys: db.keys, log, journal: journalPath(db.keyFile) });
  const reader = createReader({ url: db.urls.reader, keys: db.keys, log });
  const admin = createAdmin({
    url: db.urls.admin,
    keys: db.keys,
    log: recordingLogger().log,
    journal: journalPath(db.keyFile),
  });
  await connect(writer);
  const token = await addDevice(db);
  const google = await writer.ensureSourceAccount("personal", "google_contacts", "own", OWNER.personal);
  w = { db, writer, reader, admin, token, google };
  // The switch, the owner's: on makes the device's lens_contacts account, once.
  expect(await admin.lens.setDeviceContacts("mac", true)).toEqual({ removed: 0 });
  expect(await admin.lens.setDeviceContacts("mac", true)).toEqual({ removed: 0 });
  expect(
    await queryAs(
      db.urls.admin,
      "select label, source_kind, compartments, address_fp from vault.source_accounts where connector = 'lens_contacts'",
    ),
  ).toEqual([{ label: "device:mac", source_kind: "crm", compartments: ["own"], address_fp: null }]);
  // A person the owner knows from mail, by a contact of the owner's own that lists the person's address alone.
  await saved("omar", { name: "Omar Reyes", emails: ["omar.reyes@field.example"], phones: [] });
}, SLOW_DB_TEST_TIMEOUT);

afterAll(async () => {
  await w?.admin.close();
  await w?.reader.close();
  await w?.writer.close();
  await w?.db.drop();
}, SLOW_DB_TEST_TIMEOUT);

describe("the drain of Mac contacts", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("a phone-only Mac contact makes the person its tel: key names, named as saved; the same revision again and a weekly unchanged one are unchanged", async () => {
    const before = await people();
    const lena = contact({ phones: ["+15555550100"] });
    await push([lena]);
    expect(await take()).toMatchObject({ stored: 1, unchanged: 0, failed: 0, waiting: 0, dropped: {} });
    const person = await personOf("tel:+15555550100");
    expect(person).not.toBeNull();
    expect(await people()).toBe(before + 1);
    expect(await aliasesOf(person ?? "")).toHaveLength(1);
    expect(await inboxCode(lena.key)).toEqual([{ code: null, taken: true }]);
    await push([{ ...lena, revision: 1 }]);
    expect(await take()).toMatchObject({ stored: 0, unchanged: 1, removed: 0 });
    expect(await macContacts()).toBeGreaterThanOrEqual(1);
  });

  it("a Mac contact whose email a person holds names that person and makes no one; the owner's address is own_contact; a system id is system_ids", async () => {
    const before = await people();
    const omar = await personOf("omar.reyes@field.example");
    const known = contact({ name: "Omar R.", emails: ["omar.reyes@field.example"], phones: ["+15555550110"] });
    const mine = contact({ name: "Odalys", emails: [OWNER.personal.toLowerCase()] });
    const tripped = contact({ name: `Lena ent_01JABCDEFGHJKMNPQRSTVWXYZ0`, phones: ["+15555550111"] });
    await push([known, mine, tripped]);
    expect(await take()).toMatchObject({ stored: 1, dropped: { own_contact: 1, system_ids: 1 }, failed: 0 });
    expect(await people()).toBe(before);
    expect(
      one(
        await queryAs<{ entity_id: string }>(
          w.db.urls.admin,
          "select k.entity_id from knowledge.contact_addresses k join knowledge.contacts c on c.id = k.contact_id join vault.source_accounts a on a.id = c.account_id where a.connector = 'lens_contacts' and k.value_fp = $1",
          [fingerprint(w.db.keys, "address", "omar.reyes@field.example")],
        ),
      ),
    ).toEqual({ entity_id: omar });
    expect(await inboxCode(mine.key)).toEqual([{ code: "own_contact", taken: true }]);
    expect(await inboxCode(tripped.key)).toEqual([{ code: "system_ids", taken: true }]);
    expect(await personOf("tel:+15555550111")).toBeNull();
  });

  it("with the switch off at drain a row is switched_off; a suppressed phone key stores nothing", async () => {
    const late = contact({ phones: ["+15555550112"] });
    await push([late]);
    await queryAs(w.db.urls.admin, "update policy.lens_devices set contacts = false where name = 'mac'");
    expect(await take()).toMatchObject({ stored: 0, dropped: { switched_off: 1 } });
    await queryAs(w.db.urls.admin, "update policy.lens_devices set contacts = true where name = 'mac'");

    const erased = contact({ phones: ["+15555550113"] });
    await push([erased]);
    expect(await take()).toMatchObject({ stored: 1 });
    const person = await personOf("tel:+15555550113");
    await w.admin.erasure.erasePerson(person as EntityId, { requestId: `mac-contacts-erase-${ulid()}` });
    await push([{ ...erased, revision: 1, name: "Lena Again" }]);
    expect(await take()).toMatchObject({ stored: 0, dropped: { suppressed: 1 } });
    expect(await personOf("tel:+15555550113")).toBeNull();
  });
});

describe("outranking", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("a phone-only Mac contact whose phone a Google contact with an address holds is outranked, its earlier revision removed; after the Google contact drops the phone the next revision is stored", async () => {
    await saved("ines", { name: "Ines Ward", emails: ["ines.ward@stone.example"], phones: ["+15555550130"] });
    const copy = contact({ name: "Ines", phones: ["+15555550130"] });
    await push([copy]);
    expect(await take()).toMatchObject({ stored: 0, dropped: { outranked: 1 } });
    expect(await personOf("tel:+15555550130")).toBeNull();

    const early = contact({ name: "Hal Moss", phones: ["+15555550131"] });
    await push([early]);
    expect(await take()).toMatchObject({ stored: 1 });
    expect(await personOf("tel:+15555550131")).not.toBeNull();
    await saved("hal", { name: "Hal Moss", emails: ["hal.moss@cove.example"], phones: ["+15555550131"] });
    await push([{ ...early, revision: 1 }]);
    expect(await take()).toMatchObject({ stored: 0, dropped: { outranked: 1 } });
    expect(await personOf("tel:+15555550131")).toBeNull();
    await saved("hal", { name: "Hal Moss", emails: ["hal.moss@cove.example"], phones: [] });
    await push([{ ...early, revision: 2 }]);
    expect(await take()).toMatchObject({ stored: 1 });
    expect(await personOf("tel:+15555550131")).not.toBeNull();
  });

  it("one whose handle the owner bound is outranked; one whose phone only a phone-only Google contact holds names that contact's person", async () => {
    const bound = await moment(["+15555550132"]);
    const omar = await personOf("omar.reyes@field.example");
    await session(w.db.urls.admin, async (query) => {
      const ruling = testId("rul");
      await query(
        "insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, labels, details, decided_at, compartments) values ($1, $2, 'identity', 0, '{}', '{}', now(), '{own}')",
        [ruling, testId("req")],
      );
      await query(
        "insert into knowledge.mention_bindings (id, ruling_id, origin, evidence_id, mention_fp, address_fp, created_at, compartments) values ($1, $2, 'owner', $3, $4, $5, now(), '{own}')",
        [
          testId("mbd"),
          ruling,
          bound,
          fingerprint(w.db.keys, "name", "+15555550132"),
          fingerprint(w.db.keys, "address", "omar.reyes@field.example"),
        ],
      );
    });
    expect(omar).not.toBeNull();
    await push([contact({ name: "Someone Else", phones: ["+15555550132"] })]);
    expect(await take()).toMatchObject({ stored: 0, dropped: { outranked: 1 } });
    expect(await personOf("tel:+15555550132")).toBeNull();

    await saved("paz", { name: "Paz Lin", emails: [], phones: ["+15555550135"] });
    const paz = await personOf("tel:+15555550135");
    const before = await people();
    await push([contact({ name: "Paz", phones: ["+15555550135"] })]);
    expect(await take()).toMatchObject({ stored: 1 });
    expect(await people()).toBe(before);
    expect(await personOf("tel:+15555550135")).toBe(paz);
  });

  it("a phone-only Mac contact whose phone a Mac contact with an email holds is outranked, whichever was pushed first", async () => {
    const first = contact({ name: "Rae Kim", phones: ["+15555550140"] });
    await push([first]);
    expect(await take()).toMatchObject({ stored: 1 });
    expect(await personOf("tel:+15555550140")).not.toBeNull();
    await push([contact({ name: "Rae Kim", emails: ["rae.kim@ridge.example"], phones: ["+15555550140"] })]);
    expect(await take()).toMatchObject({ stored: 1, removed: 1 });
    expect(await personOf("tel:+15555550140")).toBeNull();

    // In one batch, phone-only first: the one with an email is drained first, so the other is outranked.
    await push([
      contact({ name: "Ada Fox", phones: ["+15555550141"] }),
      contact({ name: "Ada Fox", emails: ["ada.fox@ridge.example"], phones: ["+15555550141"] }),
    ]);
    expect(await take()).toMatchObject({ stored: 1, dropped: { outranked: 1 } });
    expect(await personOf("tel:+15555550141")).toBeNull();
  });
});

describe("listings and the switch", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("a listing removes what it leaves out with no suppression, keeps one whose revision arrived after it, removes one whose inbox rows are pruned, and an empty one removes all", async () => {
    const suppressions = async () =>
      one(
        await queryAs<{ n: number }>(
          w.db.urls.admin,
          "select (select count(*) from knowledge.suppressions)::int + (select count(*) from knowledge.removed_evidence)::int as n",
        ),
      ).n;
    const a = contact({ name: "Ann Lowe", phones: ["+15555550150"] });
    const b = contact({ name: "Bo Lane", phones: ["+15555550151"] });
    const c = contact({ name: "Cy Moor", phones: ["+15555550152"] });
    await push([a, b, c]);
    expect(await take()).toMatchObject({ stored: 3 });
    const all = await macContacts();
    const gone = await suppressions();
    const pruned = contact({ name: "Di Park", phones: ["+15555550153"] });
    await push([pruned]);
    expect(await take()).toMatchObject({ stored: 1 });
    await queryAs(w.db.urls.admin, "delete from ledger.capture_inbox where source_key_fp = $1", [
      fingerprint(w.db.keys, "source_id", pruned.key),
    ]);

    // A listing of a alone: b, c, the pruned one and the earlier tests' Mac contacts all go.
    const list = listing([a.key]);
    await push([list]);
    // Pushed after the listing: kept by it.
    const after = contact({ name: "Eve Rook", phones: ["+15555550154"] });
    await push([after]);
    const taken = await take();
    expect(taken).toMatchObject({ stored: 1, failed: 0, waiting: 0 });
    expect(await personOf("tel:+15555550150")).not.toBeNull();
    expect(await personOf("tel:+15555550151")).toBeNull();
    expect(await personOf("tel:+15555550152")).toBeNull();
    expect(await personOf("tel:+15555550153")).toBeNull();
    expect(await personOf("tel:+15555550154")).not.toBeNull();
    expect(taken.removed).toBe(all);
    expect(await macContacts()).toBe(2);
    expect(await suppressions()).toBe(gone);

    await push([listing([])]);
    expect(await take()).toMatchObject({ removed: 2 });
    expect(await macContacts()).toBe(0);
  });

  it("a row taken again after a run killed between the ingest and the mark is unchanged", async () => {
    const item = contact({ name: "Gus Hale", phones: ["+15555550160"] });
    await push([item]);
    // As a killed run leaves it: the writer stored the revision, the inbox row is untaken.
    const [account] = await w.writer
      .listSourceAccounts()
      .then((rows) => rows.filter((one) => one.connector === "lens_contacts"));
    if (account === undefined) throw new Error("no lens_contacts account");
    const raw = macContactItem(item, { sourceAccount: account.id, now: Timestamp.parse(new Date().toISOString()) });
    expect(await w.writer.ingestItem(account, raw, (ctx) => deriveItem(raw, ctx, PERSONAL_LIMITS))).toBe("stored");
    expect(await take()).toMatchObject({ stored: 0, unchanged: 1, failed: 0 });
    expect(await inboxCode(item.key)).toEqual([{ code: null, taken: true }]);
  });

  it("pi lens contacts NAME off removes every Mac contact of the device and counts them, and sets due the moments their phones name; the view shows the switch, the stored and the dropped by code", async () => {
    const ivy = await moment(["+15555550170"]);
    await push([
      contact({ name: "Ivy Shaw", phones: ["+15555550170"] }),
      contact({ name: "Jo Park", emails: ["jo.park@ridge.example"] }),
    ]);
    expect(await take()).toMatchObject({ stored: 2, momentsDue: 1 });
    await settled(ivy);
    const stored = await macContacts();
    expect(await w.admin.lens.deviceContacts("mac")).toMatchObject({
      device: "mac",
      on: true,
      stored,
      dropped: expect.objectContaining({ outranked: expect.any(Number), own_contact: 1 }),
    });
    expect(await w.admin.lens.setDeviceContacts("mac", false)).toEqual({ removed: stored });
    expect(await macContacts()).toBe(0);
    expect(await generationOf(ivy)).toBe(0);
    // A device's inbox counts leave its Mac contacts' rows to macContacts.
    const view = (await w.admin.lens.devices()).find((one) => one.name === "mac");
    expect(view?.inbox.dropped).not.toHaveProperty("outranked");
    expect(await w.admin.lens.deviceContacts("mac")).toMatchObject({ on: false, stored: 0 });
    expect((await w.admin.lens.devices()).find((one) => one.name === "mac")?.macContacts).toMatchObject({
      on: false,
      stored: 0,
    });
    await w.admin.lens.setDeviceContacts("mac", true);
  });
});

describe("asked again", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("after a store the moments holding the phone are due with their saved calls kept, a moment of another handle is not; an unchanged revision sets nothing due; after a removal the same", async () => {
    const mine = await moment(["+15555550180"]);
    const other = await moment(["+15555550181"]);
    const item = contact({ name: "Kit Vale", phones: ["+15555550180"] });
    await push([item]);
    expect(await take()).toMatchObject({ stored: 1, momentsDue: 1 });
    expect(await generationOf(mine)).toBe(0);
    expect(await generationOf(other)).toBe(7);
    // The saved calls stay: a re-ask only resets the generation.
    await settled(mine);
    await push([{ ...item, revision: 1 }]);
    expect(await take()).toMatchObject({ unchanged: 1, momentsDue: 0 });
    expect(await generationOf(mine)).toBe(7);
    await push([listing([])]);
    expect(await take()).toMatchObject({ removed: 1, momentsDue: 1 });
    expect(await generationOf(mine)).toBe(0);
  });

  it("a moment the extraction lock refused is set due by the next run", async () => {
    const held = await moment(["+15555550190"]);
    const item = contact({ name: "Lu Park", phones: ["+15555550190"] });
    await push([item]);
    await session(w.db.urls.admin, async (query) => {
      await query("begin");
      await query("select pg_advisory_xact_lock(hashtext('intelligence personal extract'))");
      expect(await take()).toMatchObject({ stored: 1, momentsDue: 0, waiting: 1 });
      await query("commit");
    });
    expect(await generationOf(held)).toBe(7);
    expect(await inboxCode(item.key)).toEqual([{ code: null, taken: false }]);
    expect(await take()).toMatchObject({ stored: 0, momentsDue: 1 });
    expect(await generationOf(held)).toBe(0);
    expect(await inboxCode(item.key)).toEqual([{ code: null, taken: true }]);
  });
});
