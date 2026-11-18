import { randomBytes } from "node:crypto";
import { type EvidenceId, type SourceDeletion, Timestamp } from "@intelligence/contracts";
import {
  type CaptureItem,
  type EntityId,
  type MentionBindingId,
  MIRROR_QUOTA,
  type MomentCaptureFacts,
  type MomentItem,
  QUOTA_DEFAULTS,
} from "@intelligence/contracts/personal";
import { PERSONAL_LIMITS } from "@intelligence/personal-core";
import { contactDeletion, contactItem, deriveItem, whitelistedContact } from "@intelligence/personal-core/items";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Admin, createAdmin } from "../admin/admin.ts";
import { createDb } from "../core/job-db.ts";
import { journalPath } from "../core/journal.ts";
import { openUnder, sealRow, sealUnder } from "../core/seal.ts";
import { labelsDue } from "../identity/warmth-days.ts";
import { createReader, type Reader } from "../read/read.ts";
import { type Accounts, connect, OWNER } from "../test-support/cast.ts";
import { sha256Hex, testId } from "../test-support/clients.ts";
import { one, session } from "../test-support/connections.ts";
import { createTestDatabase, fingerprint, queryAs, type TestDatabase } from "../test-support/database.ts";
import { eventLogger, recordingLogger } from "../test-support/recording.ts";
import { tampering } from "../test-support/tamper.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { age, buildAs, buildRowOf, rowsOf } from "../test-support/warmth-fixtures.ts";
import { rederive } from "../write/rederive.ts";
import { createWriter, type Writer } from "../write/writer.ts";
import { removeSourceItem } from "../write/writer-item-removal.ts";
import { expireOne } from "./capture-retention.ts";

// A source moment's lines as knowledge.chat_lines rows, derived by the sync's participant step as
// pi_writer, over iMessage sessions pushed and drained as Lens and `pi sync` would; their removals;
// the lines catch-up; and the warmth build reading them. Synthetic people on reserved domains and
// 555 numbers. No model.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const OWN = ["own"];
const MESSAGES = { bundle: "com.apple.MobileSMS", name: "Messages" };
const CHAT = { bundle: "test.example.chat", name: "Chat" };
const ME = "me";

type World = {
  db: TestDatabase;
  writer: Writer;
  reader: Reader;
  admin: Admin;
  token: string;
  accounts: Accounts;
  contacts: Awaited<ReturnType<Writer["ensureSourceAccount"]>>;
};
let w: World;
let keys = 0;
let pushes = 0;
let requests = 0;
const req = (): string => `chat-lines-req-${(requests += 1)}`;
const iso = (ms: number): string => new Date(ms).toISOString();

// One iMessage session: its handles (sorted here) and its turns in order, each a handle or ME, a
// minute apart, ending `hoursAgo` hours before now. The drain stamps its push as now, so the
// owner's word holds for a session ended at most six hours ago.
function chatSession(
  handles: string[],
  turns: string[],
  options: { hoursAgo?: number; key?: string; revision?: number; thread?: string | undefined } = {},
): MomentItem {
  keys += 1;
  const sorted = [...handles].sort();
  const end = Date.now() - (options.hoursAgo ?? 1) * HOUR;
  const start = end - turns.length * MINUTE;
  const texts = turns.map((_, n) => `Line ${n + 1}: the tiles arrive on Thursday.`);
  let from = 0;
  const items = turns.map((who, n) => {
    const turn = {
      from,
      to: from + (texts[n] as string).length,
      ...(who === ME
        ? { speaker: "owner" as const }
        : { speaker: "participant" as const, participant: sorted.indexOf(who) }),
      at: iso(start + (n + 1) * MINUTE),
    };
    from = turn.to + 1;
    return turn;
  });
  return {
    kind: "moment",
    key: options.key ?? `moment:01JRCHATQN${String(keys).padStart(16, "0")}`,
    revision: options.revision ?? 0,
    observedAt: iso(start),
    endedAt: iso(end),
    app: MESSAGES,
    entity: "chat",
    participants: sorted.map((handle) => (handle.startsWith("+") ? { handle } : { address: handle })),
    text: texts.join("\n"),
    read: "db",
    turns: items,
    source: "imessage",
    threadKey: options.thread ?? `chat:01JRCHATQNTHREAD${String(keys).padStart(10, "0")}`,
  };
}

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
      OWN,
      ["self"],
      ["push_capture"],
      "device",
      ...quota(QUOTA_DEFAULTS.device),
    ]);
    await query(insertClient, [
      mirror,
      "mac",
      sha256Hex(`pit_test-mac-${randomBytes(8).toString("hex")}`),
      OWN,
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
    for (const [bundle, source] of [
      [MESSAGES.bundle, "imessage"],
      [CHAT.bundle, null],
    ] as const) {
      const id = testId("csr");
      await query(
        `insert into policy.capture_scope (id, match, value_fp, value_enc, compartment, kinds, source) values ($1, 'bundle', $2, $3, 'own', '{moment}', $4)`,
        [
          id,
          fingerprint(db.keys, "capture_scope", bundle),
          sealRow(db.keys, "own", { table: "policy.capture_scope", id, column: "value_enc" }, bundle),
          source,
        ],
      );
    }
    await query("commit");
  });
  return capture.token;
}

async function drained(item: MomentItem): Promise<EvidenceId> {
  pushes += 1;
  expect(
    (
      await w.reader.pushCapture(w.token, {
        batch: `chat-lines-${String(pushes).padStart(4, "0")}`,
        items: [item as CaptureItem],
      })
    ).ok,
  ).toBe(true);
  expect(await w.writer.takeCapture()).toMatchObject({ failed: 0, waiting: 0 });
  return one(
    await queryAs<{ evidence_id: EvidenceId }>(
      w.db.urls.admin,
      "select evidence_id from knowledge.captures where capture_key = $1",
      [item.key],
    ),
  ).evidence_id;
}

const contact = async (
  resource: string,
  person: { name: string; emails?: string[]; phones?: string[] },
): Promise<void> => {
  const own = { metadata: { source: { type: "CONTACT", id: "c" } } };
  const read = whitelistedContact({
    resourceName: `people/${resource}`,
    metadata: { sources: [{ type: "CONTACT", id: resource, updateTime: iso(Date.now() - 2 * DAY) }] },
    names: [{ ...own, displayName: person.name }],
    emailAddresses: (person.emails ?? []).map((value) => ({ ...own, value })),
    phoneNumbers: (person.phones ?? []).map((value) => ({ ...own, value })),
  });
  if (read === null) throw new Error("refused");
  const raw = contactItem(read, {
    sourceAccount: w.contacts.id,
    changeKind: "backfill",
    now: Timestamp.parse(iso(Date.now())),
  });
  expect(await w.writer.ingestItem(w.contacts, raw, (ctx) => deriveItem(raw, ctx, PERSONAL_LIMITS))).toBe("stored");
};
const uncontact = (resource: string) =>
  w.writer.applyDeletion(
    w.contacts,
    contactDeletion(`people/${resource}`, {
      sourceAccount: w.contacts.id,
      now: Timestamp.parse(iso(Date.now())),
    }) as SourceDeletion,
  );

const entityOf = async (address: string): Promise<string> =>
  one(
    await queryAs<{ entity_id: string }>(
      w.db.urls.admin,
      "select entity_id from knowledge.accounts where value_fp = $1 limit 1",
      [fingerprint(w.db.keys, "address", address)],
    ),
  ).entity_id;
const people = async (): Promise<number> =>
  one(
    await queryAs<{ n: number }>(
      w.db.urls.admin,
      "select count(*)::int as n from knowledge.entities where kind = 'person'",
    ),
  ).n;
type Line = { line: number; entity_id: string; direction: string; others: number; compartments: string[] };
const linesOf = (evidence: string): Promise<Line[]> =>
  queryAs<Line>(
    w.db.urls.admin,
    "select line, entity_id, direction, others, compartments from knowledge.chat_lines where evidence_id = $1 order by line, entity_id",
    [evidence],
  );
const sync = () => w.writer.bindParticipants(new Date());
// As the tables' owner, for a row shaped as one written before a migration: no role may update
// it, and row-level security is forced on the table, so the owner lifts the force for this one
// statement and puts it back, in one transaction. Returns how many rows changed.
const asOwner = (sql: string, values: unknown[]): Promise<number> =>
  session(w.db.urls.bootstrap, async (query) => {
    const table = /update (knowledge\.\w+)/.exec(sql)?.[1];
    if (table === undefined) throw new Error("asOwner updates one knowledge table");
    await query("begin");
    await query("set local role pi_owner");
    await query(`alter table ${table} no force row level security`);
    const rows = await query<{ n: number }>(
      `with changed as (${sql} returning 1) select count(*)::int as n from changed`,
      values,
    );
    await query(`alter table ${table} force row level security`);
    await query("commit");
    return rows[0]?.n ?? 0;
  });
const build = () => buildAs(w.db, OWN);
const removed = async (): Promise<boolean> => (await buildRowOf(w.db, OWN))?.removed === true;
const factsOf = async (evidence: string): Promise<MomentCaptureFacts> => {
  const row = one(
    await queryAs<{ id: string; compartments: string[]; facts_enc: unknown }>(
      w.db.urls.admin,
      "select id, compartments, facts_enc from knowledge.captures where evidence_id = $1",
      [evidence],
    ),
  );
  return JSON.parse(
    openUnder(
      w.db.keys,
      row.compartments,
      { table: "knowledge.captures", id: row.id, column: "facts_enc" },
      row.facts_enc as never,
    ),
  ) as MomentCaptureFacts;
};
const asWriter = async <T>(
  fn: (tx: {
    query: Parameters<Parameters<ReturnType<typeof createDb>["transaction"]>[0]>[0];
    keys: TestDatabase["keys"];
  }) => Promise<T>,
): Promise<T> => {
  const db = createDb(w.db.urls.writer, recordingLogger().log);
  try {
    return await db.transaction((query) => fn({ query, keys: w.db.keys }));
  } finally {
    await db.close();
  }
};
const sourceOf = async (evidence: string) =>
  one(
    await queryAs<{ source_account_id: string; source_item_fp: string }>(
      w.db.urls.admin,
      "select source_account_id, source_item_fp from vault.evidence_items where id = $1",
      [evidence],
    ),
  );

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
  const accounts = await connect(writer);
  const token = await addDevice(db);
  const contacts = await writer.ensureSourceAccount("personal", "google_contacts", "own", OWNER.personal);
  w = { db, writer, reader, admin, token, accounts, contacts };
}, SLOW_DB_TEST_TIMEOUT);

afterAll(async () => {
  await w?.admin.close();
  await w?.reader.close();
  await w?.writer.close();
  await w?.db.drop();
}, SLOW_DB_TEST_TIMEOUT);

const LENA = "+15555550301";
const MARA = "+15555550302";
const NILS = "+15555550303";
const UNSAVED = "+15555550304";
const OMAR = "+15555550305";
const OMAR_MAIL = "omar.reyes@field.example";

describe("the derivation", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  beforeAll(async () => {
    await contact("lena", { name: "Lena Park", phones: [LENA] });
    await contact("mara", { name: "Mara Voss", phones: [MARA] });
    await contact("omar", { name: "Omar Reyes", emails: [OMAR_MAIL], phones: [OMAR] });
  }, SLOW_DB_TEST_TIMEOUT);

  it("a one-to-one chat with a phone-only contact gives an outbound row per owner line and an inbound row per theirs, others 1, under the moment's label; a second sync writes nothing", async () => {
    const evidence = await drained(chatSession([LENA], [LENA, ME, LENA, ME]));
    const lena = await entityOf(`tel:${LENA}`);
    expect(await linesOf(evidence)).toEqual([]);
    expect(await sync()).toMatchObject({ linesWritten: 4, linesRemoved: 0, failed: 0 });
    expect(await linesOf(evidence)).toEqual([
      { line: 0, entity_id: lena, direction: "inbound", others: 1, compartments: OWN },
      { line: 1, entity_id: lena, direction: "outbound", others: 1, compartments: OWN },
      { line: 2, entity_id: lena, direction: "inbound", others: 1, compartments: OWN },
      { line: 3, entity_id: lena, direction: "outbound", others: 1, compartments: OWN },
    ]);
    const thread = one(
      await queryAs<{ thread_fp: string; lines_fp: string | null }>(
        w.db.urls.admin,
        "select thread_fp, lines_fp from knowledge.captures where evidence_id = $1",
        [evidence],
      ),
    );
    expect(thread.lines_fp).toMatch(/^[0-9a-f]{64}$/);
    expect(
      await queryAs(w.db.urls.admin, "select distinct thread_fp from knowledge.chat_lines where evidence_id = $1", [
        evidence,
      ]),
    ).toEqual([{ thread_fp: thread.thread_fp }]);
    const stamps = await queryAs(
      w.db.urls.admin,
      "select id, created_at from knowledge.chat_lines where evidence_id = $1 order by id",
      [evidence],
    );
    // Unchanged: nothing written, created_at unmoved.
    expect(await sync()).toMatchObject({ linesWritten: 0, linesRemoved: 0 });
    expect(
      await queryAs(
        w.db.urls.admin,
        "select id, created_at from knowledge.chat_lines where evidence_id = $1 order by id",
        [evidence],
      ),
    ).toEqual(stamps);
  });

  it("a group of the owner, a saved contact and two unsaved numbers gives the contact's rows with others 3, none for the numbers, and makes no person; a number saved later gives its rows at the next sync", async () => {
    const before = await people();
    const evidence = await drained(chatSession([MARA, NILS, UNSAVED], [MARA, NILS, UNSAVED, ME]));
    await sync();
    const mara = await entityOf(`tel:${MARA}`);
    expect(await linesOf(evidence)).toEqual([
      { line: 0, entity_id: mara, direction: "inbound", others: 3, compartments: OWN },
      { line: 3, entity_id: mara, direction: "outbound", others: 3, compartments: OWN },
    ]);
    expect(await people()).toBe(before);
    await contact("nils", { name: "Nils Berg", phones: [NILS] });
    const nils = await entityOf(`tel:${NILS}`);
    expect(await sync()).toMatchObject({ linesWritten: 2, linesRemoved: 0 });
    expect((await linesOf(evidence)).map((row) => [row.line, row.entity_id, row.direction])).toEqual(
      [
        [0, mara, "inbound"],
        [1, nils, "inbound"],
        [3, mara, "outbound"],
        [3, nils, "outbound"],
      ].sort((a, b) => (a[0] as number) - (b[0] as number) || String(a[1]).localeCompare(String(b[1]))),
    );
  });

  it("a person with a phone and an email handle in one chat gets one row per line, and others counts both handles; the owner's unbind of the phone removes its line's row and marks the warmth labels removed", async () => {
    const evidence = await drained(chatSession([OMAR, OMAR_MAIL], [OMAR, OMAR_MAIL, ME]));
    await sync();
    const omar = await entityOf(OMAR_MAIL);
    expect(await linesOf(evidence)).toEqual([
      { line: 0, entity_id: omar, direction: "inbound", others: 2, compartments: OWN },
      { line: 1, entity_id: omar, direction: "inbound", others: 2, compartments: OWN },
      { line: 2, entity_id: omar, direction: "outbound", others: 2, compartments: OWN },
    ]);
    await build();
    expect(await removed()).toBe(false);
    const [binding] = await queryAs<{ id: MentionBindingId }>(
      w.db.urls.admin,
      "select id from knowledge.mention_bindings where evidence_id = $1 and lifted_at is null",
      [evidence],
    );
    expect(await w.admin.mentions.unbindMention(binding?.id as MentionBindingId, { requestId: req() })).toBe(true);
    expect(await sync()).toMatchObject({ linesRemoved: 1 });
    expect((await linesOf(evidence)).map((row) => row.line)).toEqual([1, 2]);
    expect(await removed()).toBe(true);
  });

  it("a handle that is the owner's address gives no row and is counted; the owner's lines still go to the others", async () => {
    const evidence = await drained(chatSession([LENA, OWNER.personal], [OWNER.personal, ME]));
    const counts = await sync();
    expect(counts.ownerHandle).toBeGreaterThanOrEqual(1);
    const lena = await entityOf(`tel:${LENA}`);
    expect(await linesOf(evidence)).toEqual([
      { line: 1, entity_id: lena, direction: "outbound", others: 2, compartments: OWN },
    ]);
  });

  it("forgery: an email handle no contact, mail or meeting knows gives no row, though the step may make the person; one a saved contact knows does", async () => {
    const forged = await drained(chatSession(["stranger@nowhere.example"], ["stranger@nowhere.example", ME]));
    await sync();
    expect(await linesOf(forged)).toEqual([]);
    await contact("pia", { name: "Pia Lund", emails: ["pia.lund@fjord.example"] });
    const known = await drained(chatSession(["pia.lund@fjord.example"], ["pia.lund@fjord.example", ME]));
    await sync();
    const pia = await entityOf("pia.lund@fjord.example");
    expect((await linesOf(known)).map((row) => [row.line, row.entity_id])).toEqual([
      [0, pia],
      [1, pia],
    ]);
  });

  it("the owner's line of a session pushed seven hours after its end gives no row and is counted; the person's line still counts", async () => {
    const evidence = await drained(chatSession([LENA], [LENA, ME], { hoursAgo: 7 }));
    const counts = await sync();
    expect(counts.notOwnerWord).toBeGreaterThanOrEqual(1);
    expect((await linesOf(evidence)).map((row) => [row.line, row.direction])).toEqual([[0, "inbound"]]);
  });

  it("a screen chat (no source) with a saved contact's name gives no row, and its facts hold no lines", async () => {
    keys += 1;
    const text = "Are we on for Thursday?\nYes.";
    const evidence = await drained({
      kind: "moment",
      key: `moment:01JRCHATQN${String(keys).padStart(16, "0")}`,
      revision: 0,
      observedAt: iso(Date.now() - 2 * HOUR),
      endedAt: iso(Date.now() - 2 * HOUR + MINUTE),
      app: CHAT,
      entity: "chat",
      thread: "Lena Park",
      participants: [{ name: "Lena Park" }],
      text,
      read: "ax",
      turns: [
        { from: 0, to: 23, speaker: "participant", participant: 0 },
        { from: 24, to: text.length, speaker: "owner" },
      ],
    });
    await sync();
    expect(await linesOf(evidence)).toEqual([]);
    expect(await factsOf(evidence)).not.toHaveProperty("lines");
  });

  it("facts without lines give none and are counted; the catch-up's dry run counts them, its run reseals them and nulls lines_fp, a second run finds none, and the next sync derives the rows", async () => {
    const evidence = await drained(chatSession([LENA], [LENA, ME]));
    // As stored before lines were sealed: the facts and the evidence row's copy without lines.
    const row = one(
      await queryAs<{
        id: string;
        compartments: string[];
        facts_enc: unknown;
        item_enc: unknown;
        item_compartments: string[];
      }>(
        w.db.urls.admin,
        "select c.id, c.compartments, c.facts_enc, e.item_enc, e.compartments as item_compartments from knowledge.captures c join vault.evidence_items e on e.id = c.evidence_id where c.evidence_id = $1",
        [evidence],
      ),
    );
    const strip = (text: string): string => {
      const { lines: _lines, ...rest } = JSON.parse(text) as MomentCaptureFacts;
      return JSON.stringify(rest);
    };
    const at = { table: "knowledge.captures", id: row.id, column: "facts_enc" };
    const itemAt = { table: "vault.evidence_items", id: evidence, column: "item_enc" };
    await queryAs(w.db.urls.admin, "update knowledge.captures set facts_enc = $2 where id = $1", [
      row.id,
      sealUnder(
        w.db.keys,
        row.compartments,
        at,
        strip(openUnder(w.db.keys, row.compartments, at, row.facts_enc as never)),
      ),
    ]);
    // Outside the store's one function, so the database refuses it but for `tampering`.
    await tampering(w.db, () =>
      queryAs(w.db.urls.admin, "update vault.evidence_items set item_enc = $2 where id = $1", [
        evidence,
        sealUnder(
          w.db.keys,
          row.item_compartments,
          itemAt,
          strip(openUnder(w.db.keys, row.item_compartments, itemAt, row.item_enc as never)),
        ),
      ]),
    );
    expect(await factsOf(evidence)).not.toHaveProperty("lines");
    expect((await sync()).noLines).toBeGreaterThanOrEqual(1);
    expect(await linesOf(evidence)).toEqual([]);

    expect(await w.writer.backfillChatLines({ dryRun: true })).toMatchObject({ missing: 1, filled: 0, failed: 0 });
    expect(await factsOf(evidence)).not.toHaveProperty("lines");
    expect(await w.writer.backfillChatLines({ dryRun: false })).toMatchObject({ missing: 1, filled: 1, failed: 0 });
    expect((await factsOf(evidence)).lines?.turns.map(([who]) => who)).toEqual([0, -1]);
    expect(
      await queryAs(w.db.urls.admin, "select lines_fp from knowledge.captures where evidence_id = $1", [evidence]),
    ).toEqual([{ lines_fp: null }]);
    expect(await w.writer.backfillChatLines({ dryRun: false })).toMatchObject({ missing: 0, filled: 0 });
    await sync();
    expect((await linesOf(evidence)).map((row) => row.direction)).toEqual(["inbound", "outbound"]);
  });

  it("a binding the step ends (its contact removed) removes that handle's rows and marks the warmth labels removed; a newly saved contact only adds rows", async () => {
    // Ivo stays a person through a second contact of Ivo's address alone; the first gives Ivo's phone.
    await contact("ivo-mail", { name: "Ivo Stam", emails: ["ivo.stam@harbor.example"] });
    await contact("ivo", { name: "Ivo Stam", emails: ["ivo.stam@harbor.example"], phones: ["+15555550306"] });
    const evidence = await drained(chatSession(["+15555550306", LENA], ["+15555550306", LENA, ME]));
    await sync();
    expect((await linesOf(evidence)).length).toBe(4);
    await build();
    expect(await removed()).toBe(false);
    await contact("tove", { name: "Tove Lind", phones: ["+15555550307"] });
    const other = await drained(chatSession(["+15555550307"], ["+15555550307", ME]));
    expect(await sync()).toMatchObject({ linesRemoved: 0 });
    expect((await linesOf(other)).length).toBe(2);
    expect(await removed()).toBe(false);
    await uncontact("ivo");
    expect((await sync()).linesRemoved).toBeGreaterThanOrEqual(2);
    const lena = await entityOf(`tel:${LENA}`);
    expect((await linesOf(evidence)).map((row) => row.entity_id)).toEqual([lena, lena]);
    expect(await removed()).toBe(true);
  });
});

describe("removals", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  const VERA = "+15555550311";
  beforeAll(async () => {
    await contact("vera", { name: "Vera Holm", phones: [VERA] });
  }, SLOW_DB_TEST_TIMEOUT);

  it("a new revision deletes the earlier revision's lines in the drain, marks no warmth label removed, and the same sync derives the new ones", async () => {
    const first = chatSession([VERA], [VERA, ME]);
    const evidence = await drained(first);
    await sync();
    expect((await linesOf(evidence)).length).toBe(2);
    await build();
    const next = await drained({
      ...chatSession([VERA], [VERA, ME, VERA], { thread: first.threadKey }),
      key: first.key,
      revision: 1,
    });
    expect(next).not.toBe(evidence);
    expect(await linesOf(evidence)).toEqual([]);
    expect(await removed()).toBe(false);
    await sync();
    expect((await linesOf(next)).map((row) => row.direction)).toEqual(["inbound", "outbound", "inbound"]);
  });

  it("a deletion at the source (a forget) deletes the lines of every revision and marks every warmth label containing their label removed; the next build ranks without them", async () => {
    const evidence = await drained(chatSession([VERA], [VERA, ME]));
    await sync();
    await build();
    const { source_account_id, source_item_fp } = await sourceOf(evidence);
    await asWriter((tx) =>
      removeSourceItem(tx, { id: source_account_id, compartment: "own" }, source_item_fp, "deleted"),
    );
    expect(await linesOf(evidence)).toEqual([]);
    expect(await removed()).toBe(true);
    await build();
    expect(await removed()).toBe(false);
  });

  it("`pi erase item cap_` deletes the moment's lines too", async () => {
    const evidence = await drained(chatSession([VERA], [VERA, ME]));
    await sync();
    expect((await linesOf(evidence)).length).toBe(2);
    const capture = one(
      await queryAs<{ id: string }>(w.db.urls.admin, "select id from knowledge.captures where evidence_id = $1", [
        evidence,
      ]),
    ).id;
    await w.admin.erasure.eraseItem({ kind: "capture", id: capture as never }, { requestId: req() });
    expect(await linesOf(evidence)).toEqual([]);
  });

  it("the retention expiry keeps the lines and marks no warmth label removed; a later sync derives nothing again", async () => {
    const evidence = await drained(chatSession([VERA], [VERA, ME]));
    await sync();
    const before = await linesOf(evidence);
    expect(before.length).toBe(2);
    await build();
    const { source_account_id, source_item_fp } = await sourceOf(evidence);
    await asWriter((tx) =>
      expireOne(
        tx,
        { id: evidence, account: source_account_id as never, fp: source_item_fp, class: "capture_moment" },
        new Date(),
      ),
    );
    expect(
      await queryAs(w.db.urls.admin, "select payload_state from vault.evidence_items where id = $1", [evidence]),
    ).toEqual([{ payload_state: "expired" }]);
    expect(await linesOf(evidence)).toEqual(before);
    expect(await removed()).toBe(false);
    expect(await sync()).toMatchObject({ failed: 0 });
    expect(await linesOf(evidence)).toEqual(before);
  });

  it("removing the saved contact behind a phone person deletes the person's lines (removeUncited) and marks the warmth labels removed", async () => {
    await contact("wim", { name: "Wim Aal", phones: ["+15555550312"] });
    const evidence = await drained(chatSession(["+15555550312"], ["+15555550312", ME]));
    await sync();
    expect((await linesOf(evidence)).length).toBe(2);
    await build();
    await uncontact("wim");
    expect(await linesOf(evidence)).toEqual([]);
    expect(await removed()).toBe(true);
  });

  it("a person's erasure deletes their lines, nulls their slot and drops their turns from the facts, and the next sync derives the others' lines alone and none of theirs", async () => {
    await contact("quill", { name: "Quill Ashby", phones: ["+15555550313"] });
    await contact("sol", { name: "Sol Brandt", phones: ["+15555550314"] });
    const evidence = await drained(chatSession(["+15555550313", "+15555550314"], ["+15555550313", "+15555550314", ME]));
    await sync();
    const quill = await entityOf("tel:+15555550313");
    const sol = await entityOf("tel:+15555550314");
    expect(new Set((await linesOf(evidence)).map((row) => row.entity_id))).toEqual(new Set([quill, sol]));
    await w.admin.erasure.erasePerson(quill as EntityId, { requestId: req() });
    expect((await linesOf(evidence)).some((row) => row.entity_id === quill)).toBe(false);
    const facts = await factsOf(evidence);
    expect(facts.lines?.handles).toEqual([null, "+15555550314"]);
    expect(facts.lines?.turns.map(([who]) => who)).toEqual([1, -1]);
    await sync();
    const after = await linesOf(evidence);
    expect(after.map((row) => [row.line, row.entity_id, row.direction])).toEqual([
      [0, sol, "inbound"],
      [1, sol, "outbound"],
    ]);
    expect(after.every((row) => row.others === 1)).toBe(true);
  });
  // The erased person speaks last, so no later line shifts
  // place, yet the chat shrinks from two others to one; every kept row must carry the new size.
  it("an erased person whose turn is last leaves the others' rows with the chat's new size", async () => {
    await contact("tam", { name: "Tam Ochre", phones: ["+15555550315"] });
    await contact("uma", { name: "Uma Pryce", phones: ["+15555550316"] });
    const evidence = await drained(chatSession(["+15555550315", "+15555550316"], ["+15555550316", ME, "+15555550315"]));
    await sync();
    const tam = await entityOf("tel:+15555550315");
    const uma = await entityOf("tel:+15555550316");
    expect((await linesOf(evidence)).every((row) => row.others === 2)).toBe(true);
    await w.admin.erasure.erasePerson(tam as EntityId, { requestId: req() });
    await sync();
    const after = await linesOf(evidence);
    expect(after.some((row) => row.entity_id === tam)).toBe(false);
    expect(after.filter((row) => row.entity_id === uma).length).toBe(2);
    expect(after.every((row) => row.others === 1)).toBe(true);
  });

  // Once the moment's text has expired, no sync can derive it
  // again, so the erasure itself must delete the person's kept lines (invariant 10).
  it("a person's erasure after the moment's text expired still deletes their kept lines, and marks the warmth labels removed", async () => {
    await contact("vic", { name: "Vic Quarry", phones: ["+15555550317"] });
    const evidence = await drained(chatSession(["+15555550317"], ["+15555550317", ME]));
    await sync();
    const vic = await entityOf("tel:+15555550317");
    expect((await linesOf(evidence)).length).toBe(2);
    await build();
    const { source_account_id, source_item_fp } = await sourceOf(evidence);
    await asWriter((tx) =>
      expireOne(
        tx,
        { id: evidence, account: source_account_id as never, fp: source_item_fp, class: "capture_moment" },
        new Date(),
      ),
    );
    expect((await linesOf(evidence)).length).toBe(2);
    await w.admin.erasure.erasePerson(vic as EntityId, { requestId: req() });
    expect(await linesOf(evidence)).toEqual([]);
    expect(await removed()).toBe(true);
  });
  it("a row rewritten only to gain its handle (version 2 over a pre-0104 row) removes no warmth row", async () => {
    await contact("zeke", { name: "Zeke Dale", phones: ["+15555550321"] });
    const evidence = await drained(chatSession(["+15555550321"], ["+15555550321", ME]));
    await sync();
    expect(await asOwner("update knowledge.chat_lines set handle_fp = null where evidence_id = $1", [evidence])).toBe(
      2,
    );
    expect(await asOwner("update knowledge.captures set lines_fp = null where evidence_id = $1", [evidence])).toBe(1);
    await build();
    await sync();
    expect(await removed()).toBe(false);
    const handles = await queryAs<{ handle_fp: string | null }>(
      w.db.urls.admin,
      "select handle_fp from knowledge.chat_lines where evidence_id = $1",
      [evidence],
    );
    expect(handles.length).toBe(2);
    expect(handles.every((row) => row.handle_fp === fingerprint(w.db.keys, "address", "tel:+15555550321"))).toBe(true);
  });

  it("each row keeps the fingerprint of the account it was resolved through", async () => {
    await contact("wren2", { name: "Wren Abbot", phones: ["+15555550318"] });
    const evidence = await drained(chatSession(["+15555550318"], ["+15555550318", ME]));
    await sync();
    const handles = await queryAs<{ handle_fp: string | null }>(
      w.db.urls.admin,
      "select handle_fp from knowledge.chat_lines where evidence_id = $1",
      [evidence],
    );
    expect(handles.length).toBe(2);
    expect(handles.every((row) => row.handle_fp === fingerprint(w.db.keys, "address", "tel:+15555550318"))).toBe(true);
  });

  it("a re-derive puts an expired moment's lines back on whoever holds their handle, a pre-0104 row on its own person, and drops a line whose handle no one holds", async () => {
    await contact("xeno", { name: "Xeno Birch", phones: ["+15555550319"] });
    await contact("yara", { name: "Yara Coll", phones: ["+15555550320"] });
    const evidence = await drained(chatSession(["+15555550319", "+15555550320"], ["+15555550319", "+15555550320", ME]));
    await sync();
    const xeno = await entityOf("tel:+15555550319");
    const yara = await entityOf("tel:+15555550320");
    const before = await queryAs<{ id: string; entity_id: string; line: number }>(
      w.db.urls.admin,
      "select id, entity_id, line from knowledge.chat_lines where evidence_id = $1 order by id",
      [evidence],
    );
    expect(before.length).toBe(4);
    const { source_account_id, source_item_fp } = await sourceOf(evidence);
    await asWriter((tx) =>
      expireOne(
        tx,
        { id: evidence, account: source_account_id as never, fp: source_item_fp, class: "capture_moment" },
        new Date(),
      ),
    );
    // One of Xeno's rows as written before handles were kept; one of Yara's through a handle no one holds.
    const xenoRow = before.find((row) => row.entity_id === xeno && row.line === 0) as { id: string };
    const yaraRow = before.find((row) => row.entity_id === yara && row.line === 1) as { id: string };
    expect(await asOwner("update knowledge.chat_lines set handle_fp = null where id = $1", [xenoRow.id])).toBe(1);
    expect(
      await asOwner("update knowledge.chat_lines set handle_fp = $2 where id = $1", [
        yaraRow.id,
        fingerprint(w.db.keys, "address", "tel:+15555550399"),
      ]),
    ).toBe(1);
    await build();
    expect(await removed()).toBe(false);
    expect(
      (await asWriter((tx) => rederive(tx, (raw, ctx) => deriveItem(raw, ctx, PERSONAL_LIMITS), { force: true })))
        .rederived,
    ).toBe(true);
    // The dropped line counted where it counted: the warmth labels holding its label go.
    expect(await removed()).toBe(true);
    const after = await queryAs<{ id: string; entity_id: string }>(
      w.db.urls.admin,
      "select id, entity_id from knowledge.chat_lines where evidence_id = $1 order by id",
      [evidence],
    );
    // Every row back with its own id, but the one whose handle no one holds.
    expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id).filter((id) => id !== yaraRow.id));
    expect(after.find((row) => row.id === xenoRow.id)?.entity_id).toBe(xeno);
    expect(new Set(after.map((row) => row.entity_id))).toEqual(new Set([xeno, yara]));
  });
});

describe("the build reads chats", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("a person reached only by chat, keyed only by a tel: key, is ranked two-way with channels chat; a chat with eleven others counts for nobody", async () => {
    await contact("juno", { name: "Juno Pell", phones: ["+15555550321"] });
    await drained(chatSession(["+15555550321"], ["+15555550321", ME, "+15555550321"]));
    const crowd = Array.from({ length: 10 }, (_, n) => `+1555555033${n}`);
    await contact("wren", { name: "Wren Oak", phones: ["+15555550340"] });
    await drained(chatSession(["+15555550340", ...crowd], ["+15555550340", ME]));
    await sync();
    await build();
    const juno = await entityOf("tel:+15555550321");
    const wren = await entityOf("tel:+15555550340");
    const rows = (await rowsOf(w.db, OWN, new Date())) ?? [];
    expect(rows.find((row) => row.entity_id === juno)).toMatchObject({
      two_way: true,
      channels: ["chat"],
      compartments: OWN,
    });
    expect(rows.find((row) => row.entity_id === juno)?.tier).not.toBe("one-way");
    expect(rows.find((row) => row.entity_id === wren)).toBeUndefined();
  });

  it("the cadence rebuilds a label's days when a chat line was created within it since its build, and not for an unchanged moment", async () => {
    await build();
    await age(w.db, 20);
    const due = async () => {
      const db = createDb(w.db.urls.pipeline, recordingLogger().log);
      try {
        return await db.transaction((query) => labelsDue(query));
      } finally {
        await db.close();
      }
    };
    // Nothing new: a sync over unchanged moments writes no line.
    await sync();
    expect(await due()).toEqual([]);
    await contact("kai", { name: "Kai Moor", phones: ["+15555550322"] });
    await drained(chatSession(["+15555550322"], ["+15555550322", ME]));
    await sync();
    expect(await due()).toEqual([OWN]);
  });
});

// Last: the vouch is set once for the device and holds for every push after it.
describe("the owner's word by the backfill vouch", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("an owner's line of a session pushed seven hours after its end counts inside the device's vouched window", async () => {
    await queryAs(
      w.db.urls.admin,
      "update policy.lens_devices set backfill_vouch_from = now() - interval '1 hour', backfill_vouch_to = now() + interval '1 hour', backfill_vouched_at = now() where name = 'mac'",
    );
    const evidence = await drained(chatSession([LENA], [LENA, ME], { hoursAgo: 7 }));
    await sync();
    expect((await linesOf(evidence)).map((row) => [row.line, row.direction])).toEqual([
      [0, "inbound"],
      [1, "outbound"],
    ]);
  });
});
