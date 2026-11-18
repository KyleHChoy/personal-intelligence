import { randomBytes } from "node:crypto";
import type {
  BlockItem,
  CaptureId,
  CaptureItem,
  CardId,
  ForgetItem,
  MomentItem,
  NewCard,
} from "@intelligence/contracts/personal";
import { fakeLens, type LensWorld } from "@intelligence/personal-core/testing";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { journalPath, readJournal } from "../../core/journal.ts";
import { sealRow } from "../../core/seal.ts";
import type { ErasureHook } from "../../erasure/erasure-hook.ts";
import { createPipeline } from "../../pipeline/pipeline.ts";
import { createReader, type Reader } from "../../read/read.ts";
import { sha256Hex, testId } from "../../test-support/clients.ts";
import { one, session } from "../../test-support/connections.ts";
import {
  copyTestDatabase,
  createTestDatabase,
  fingerprint,
  queryAs,
  type TestDatabase,
} from "../../test-support/database.ts";
import { addLensDevice } from "../../test-support/lens-setup.ts";
import { eventLogger } from "../../test-support/recording.ts";
import { withErasureHook as withHook } from "../../test-support/waits.ts";
import { createWriter, type Writer } from "../../write/writer.ts";
import { type Admin, createAdmin } from "../admin.ts";

// settleForgets, `pi erase settle`'s store side. A forget is settled through the owner surface's
// own erasure path as an erasure of kind device_forget. One database for the file, with `own` and
// `employer:example` and no Google label, so no meeting waits; the restore has a database of its
// own. Devices are registered by hand as the device registration makes them; items reach the inbox
// through Reader.pushCapture and the vault through Writer.takeCapture. Claims are hand-written rows
// on the capture's evidence, as the extraction would write them. Every refusal has its control in
// the same test.

const TIMEOUT = 120_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const T = Math.floor(Date.now() / MINUTE) * MINUTE;
const local = (offset: number): string => `${new Date(T + offset - 5 * HOUR).toISOString().slice(0, 19)}-05:00`;
const SYNC = "select pg_advisory_lock(hashtext('intelligence personal sync'))";

type Channel = { id: string; name: string; token: string };
type Device = {
  name: string;
  capture: Channel;
  mirror: Channel;
  accounts: { meetings: string; activity: string; blocks: string };
};

let db: TestDatabase;
let writer: Writer;
let reader: Reader;
let owner: Admin;
let log: ReturnType<typeof eventLogger>;
let lens: LensWorld;
let mac: Device;

const admin = <Row = Record<string, unknown>>(
  sql: string,
  values?: unknown[],
  target: TestDatabase = db,
): Promise<Row[]> => queryAs<Row>(target.urls.admin, sql, values);
const count = async (
  table: string,
  where = "true",
  values: unknown[] = [],
  target: TestDatabase = db,
): Promise<number> =>
  one(await admin<{ n: number }>(`select count(*)::int as n from ${table} where ${where}`, values, target)).n;

const addDevice = (name: string, target: TestDatabase = db): Promise<Device> => addLensDevice(target, name);
async function insertScope(rule: LensWorld["scope"][number], target: TestDatabase = db): Promise<void> {
  const id = testId("csr");
  const fp = (value: string) => fingerprint(target.keys, "capture_scope", value);
  const sealed = (column: string, value: string) =>
    sealRow(target.keys, "own", { table: "policy.capture_scope", id, column }, value);
  await admin(
    "insert into policy.capture_scope (id, match, value_fp, value_enc, account_fp, account_enc, compartment, kinds) values ($1, $2, $3, $4, $5, $6, $7, $8)",
    [
      id,
      rule.match,
      fp(rule.value),
      sealed("value_enc", rule.value),
      rule.account === undefined ? null : fp(rule.account),
      rule.account === undefined ? null : sealed("account_enc", rule.account),
      rule.compartment,
      rule.kinds,
    ],
    target,
  );
}

let keys = 0;
const keyOf = <K extends "meeting" | "moment" | "block" | "forget">(kind: K): `${K}:${string}` =>
  `${kind}:01JFRGET${String((keys += 1)).padStart(18, "0")}`;
let batches = 0;
const batch = (): string => `forget-batch-${String((batches += 1)).padStart(4, "0")}`;
const READER = { bundle: "test.example.reader", name: "Reader" };
const moment = (over: Partial<MomentItem> = {}): MomentItem => ({
  kind: "moment",
  key: keyOf("moment"),
  revision: 0,
  observedAt: local(-3 * HOUR),
  endedAt: local(-3 * HOUR + 5 * MINUTE),
  app: READER,
  url: "https://wiki.example.org/teams/alpha/plan",
  window: "Alpha plan",
  entity: "doc",
  participants: [],
  text: "The alpha plan, second draft.",
  read: "ax",
  ...over,
});
const meeting = () => ({ ...structuredClone(lens.meetings[1]), key: keyOf("meeting") }) as CaptureItem;
const blockDay = (): BlockItem => ({ ...structuredClone(lens.blocks[0] as BlockItem), key: keyOf("block") });
const forget = (named: string[]): ForgetItem => ({ kind: "forget", key: keyOf("forget"), keys: named });

async function push(items: CaptureItem[], device: Device = mac, using: Reader = reader): Promise<void> {
  const answer = await using.pushCapture(device.capture.token, { batch: batch(), items });
  expect(answer.ok, JSON.stringify(answer)).toBe(true);
  if (answer.ok)
    for (const item of answer.value.items) expect(item.outcome, `${item.key} ${item.code ?? ""}`).toBe("accepted");
}

const accountOf = (key: string, device: Device = mac): string =>
  key.startsWith("meeting:")
    ? device.accounts.meetings
    : key.startsWith("moment:")
      ? device.accounts.activity
      : device.accounts.blocks;
const fpOf = (value: string, target: TestDatabase = db): string => fingerprint(target.keys, "source_id", value);
// Every (account, fingerprint) pair a forget of `key` names: a block key's plain key and each of
// its splits.
const pairsOf = (key: string, splits: string[] = [], device: Device = mac): { account: string; fp: string }[] => [
  { account: accountOf(key, device), fp: fpOf(key) },
  ...splits.map((compartment) => ({ account: accountOf(key, device), fp: fpOf(`${key}#${compartment}`) })),
];
const sortPairs = <P extends { account: string; fp: string }>(pairs: P[]): P[] =>
  [...pairs].sort((a, b) => (`${a.account} ${a.fp}` < `${b.account} ${b.fp}` ? -1 : 1));

const storedOf = async (key: string, target: TestDatabase = db): Promise<number> =>
  (await count("knowledge.captures", "capture_key = $1", [key], target)) +
  (await count(
    "vault.evidence_items",
    "source_item_fp = any($1)",
    [[fpOf(key, target), fpOf(`${key}#own`, target), fpOf(`${key}#employer:example`, target)]],
    target,
  ));
const captureIdOf = async (key: string): Promise<CaptureId> =>
  one(await admin<{ id: string }>("select id from knowledge.captures where capture_key = $1", [key])).id as CaptureId;
const evidenceIdOf = async (key: string): Promise<string> =>
  one(await admin<{ evidence_id: string }>("select evidence_id from knowledge.captures where capture_key = $1", [key]))
    .evidence_id;
const forgetRow = async (item: ForgetItem, device: Device = mac, target: TestDatabase = db) =>
  one(
    await admin<{ body: boolean; taken: boolean }>(
      "select body_enc is not null as body, taken_at is not null as taken from ledger.capture_inbox where client_id = $1 and source_key_fp = $2",
      [device.capture.id, fpOf(item.key, target)],
      target,
    ),
  );
const removedRows = async (pairs: { account: string; fp: string }[], target: TestDatabase = db) =>
  sortPairs(
    await admin<{ account: string; fp: string; reason: string; erasure_id: string | null }>(
      "select source_account_id as account, source_item_fp as fp, reason, erasure_id from knowledge.removed_evidence where (source_account_id, source_item_fp) in (select * from unnest($1::text[], $2::text[])) order by 1, 2",
      [pairs.map((pair) => pair.account), pairs.map((pair) => pair.fp)],
      target,
    ),
  );

// A claim on an item's evidence, as the extraction would write it, by hand as pi_admin.
async function claimOn(evidenceId: string): Promise<string> {
  const id = sha256Hex(`forget claim ${evidenceId} ${randomBytes(4).toString("hex")}`);
  const row = one(
    await admin<{ compartments: string[] }>("select compartments from vault.evidence_items where id = $1", [
      evidenceId,
    ]),
  );
  await admin(
    `insert into knowledge.claims (id, evidence_id, type, valid_from, fact_key_fp, extractor_generation, readers, content_enc, compartments)
     select $1, e.id, 'commitment', now(), $3, 1, e.readers, $4::jsonb, e.compartments from vault.evidence_items e where e.id = $2`,
    [
      id,
      evidenceId,
      fingerprint(db.keys, "fact", `fact ${id}`),
      JSON.stringify(
        sealRow(db.keys, row.compartments[0] ?? "own", { table: "knowledge.claims", id, column: "content_enc" }, "{}"),
      ),
    ],
  );
  return id;
}

// A connection that holds a lock until released.
async function holding(url: string, sql: string): Promise<{ release: () => Promise<void> }> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query(sql);
  return {
    release: async () => {
      await client.end();
    },
  };
}

const newAdmin = (target: TestDatabase = db, journal = journalPath(target.keyFile)): Admin =>
  createAdmin({ url: target.urls.admin, keys: target.keys, log, journal });

beforeAll(async () => {
  db = await createTestDatabase({ compartments: ["own", "employer:example"] });
  log = eventLogger();
  writer = createWriter({ url: db.urls.writer, keys: db.keys, log, journal: journalPath(db.keyFile) });
  reader = createReader({ url: db.urls.reader, keys: db.keys, log });
  owner = newAdmin();
  lens = fakeLens({ now: new Date(T - 3 * DAY) });
  mac = await addDevice("mac");
  for (const rule of lens.scope) await insertScope(rule);
}, TIMEOUT);

afterEach(async () => {
  // A forget a test left waiting settles in no later test.
  await admin("delete from ledger.capture_inbox where kind = 'forget' and taken_at is null");
});

afterAll(async () => {
  await owner?.close();
  await reader?.close();
  await writer?.close();
  await db?.drop();
});

describe("settleForgets", { timeout: TIMEOUT }, () => {
  it("pi erase settle removes every item a forget names and everything derived, taints the ledger rows resting on it, runs every erasure hook with its exposure links, and writes no ruling", async () => {
    const [seen, talk, day] = [moment(), meeting(), blockDay()];
    // A key the forget names that was never sent.
    const never = keyOf("moment");
    await push([seen, talk, day]);
    expect(await writer.takeCapture()).toMatchObject({ failed: 0 });
    const seenEvidence = await evidenceIdOf(seen.key);
    const claims = [await claimOn(seenEvidence), await claimOn(await evidenceIdOf(talk.key))];
    // A model saw the moment.
    const pipeline = createPipeline({ url: db.urls.pipeline, keys: db.keys, log });
    try {
      expect(await pipeline.noteExposure("openai/gpt-6-luna", "personal_correspondence", [seenEvidence as never])).toBe(
        1,
      );
    } finally {
      await pipeline.close();
    }
    // A card resting on the meeting's evidence.
    const card = testId("crd") as CardId;
    await owner.cards.raiseCard({
      id: card,
      requestId: testId("req"),
      kind: "notice",
      author: "system:test",
      options: ["acknowledge"],
      target: null,
      refs: [],
      compartments: ["own"],
      expiresAt: null,
      expiresAfterDays: null,
      caseKey: null,
      run: null,
      body: "a card about a meeting",
      bodyFrom: "code",
    } as NewCard);
    await session(db.urls.bootstrap, async (query) => {
      await query("begin");
      await query("set local role pi_owner");
      await query("alter table ledger.basis no force row level security");
      await query(
        "insert into ledger.basis (row_kind, row_id, ref_kind, ref_id, evidence_id, source_class, owner_backed, compartments) values ('card', $1, 'capture', $2, $3, 'source', false, '{own}')",
        [card, await captureIdOf(talk.key), await evidenceIdOf(talk.key)],
      );
      await query("alter table ledger.basis force row level security");
      await query("commit");
    });
    const before = {
      rulings: await count("knowledge.owner_decisions"),
      cards: await count("ledger.cards"),
      returned: await count("ledger.capture_erasures"),
      seq: (await readJournal(journalPath(db.keyFile))).seq,
    };

    const notice = forget([seen.key, talk.key, day.key, never]);
    await push([notice]);
    let ran = 0;
    const settled = await withHook(
      {
        name: "test_ran",
        run: async () => {
          ran += 1;
          return 0;
        },
      },
      () => owner.lens.settleForgets(),
    );
    expect(settled).toEqual({ settled: 1, alreadyRemoved: 0, failed: 0 });
    expect(ran).toBe(1);

    // Everything of the items is gone: captures, evidence, blobs, claims.
    for (const key of [seen.key, talk.key, day.key]) expect(await storedOf(key), key).toBe(0);
    expect(await count("knowledge.claims", "id = any($1)", [claims])).toBe(0);
    // A removed-evidence row for every pair, stored or not, the block's plain key among them.
    const pairs = sortPairs([
      ...pairsOf(seen.key),
      ...pairsOf(talk.key),
      ...pairsOf(day.key, ["own", "employer:example"]),
      ...pairsOf(never),
    ]);
    const erasure = one(
      await admin<{ id: string; ruling_id: string | null; seq: number }>(
        "select id, ruling_id, journal_seq::int as seq from knowledge.erasures where kind = 'device_forget'",
      ),
    );
    expect(erasure).toMatchObject({ ruling_id: null, seq: before.seq + 1 });
    expect(await removedRows(pairs)).toEqual(
      sortPairs(pairs).map((pair) => ({ ...pair, reason: "device_forget", erasure_id: erasure.id })),
    );
    // The journal line: its kind, its pairs and nothing to suppress.
    const journal = await readJournal(journalPath(db.keyFile));
    expect(journal.seq).toBe(before.seq + 1);
    const line = journal.entries.at(-1) as {
      seq: number;
      erasure: string;
      kind: string;
      items: { account: string; fp: string }[];
      suppress: string[];
    };
    expect({ ...line, items: sortPairs(line.items) }).toEqual({
      seq: before.seq + 1,
      erasure: erasure.id,
      kind: "device_forget",
      items: pairs,
      suppress: [],
    });
    // The ledger row resting on the meeting is tainted; the exposure is linked to the erasure.
    expect(
      one(
        await admin<{ tainted: boolean }>("select tainted_at is not null as tainted from ledger.cards where id = $1", [
          card,
        ]),
      ).tainted,
    ).toBe(true);
    expect(
      one(
        await admin<{ tainted: boolean; evidence: string | null }>(
          "select tainted_at is not null as tainted, evidence_id as evidence from ledger.basis where row_id = $1",
          [card],
        ),
      ),
    ).toEqual({ tainted: true, evidence: null });
    expect(
      await count("ledger.erasure_exposures l join ledger.exposures x on x.id = l.exposure_id", "l.erasure_id = $1", [
        erasure.id,
      ]),
    ).toBeGreaterThanOrEqual(1);
    // No ruling, no card, no key back to the Mac.
    expect({
      rulings: await count("knowledge.owner_decisions"),
      cards: await count("ledger.cards"),
      returned: await count("ledger.capture_erasures"),
    }).toEqual({
      rulings: before.rulings,
      cards: before.cards,
      returned: before.returned,
    });
    // The forget row is done with.
    expect(await forgetRow(notice)).toEqual({ body: false, taken: true });
    const logged = log.events.filter((one_) => one_.event === "forgets_settled").at(-1);
    expect(logged).toBeDefined();
    expect(Object.keys(logged ?? {}).sort()).toEqual(["counts", "event"]);
    expect(Object.values(logged?.counts ?? {}).every((value) => typeof value === "number")).toBe(true);
  });

  it("a later push of a forgotten key is dropped removed", async () => {
    const [seen, day] = [moment(), blockDay()];
    const never = keyOf("moment");
    await push([seen, day]);
    await writer.takeCapture();
    await push([forget([seen.key, day.key, never])]);
    expect(await owner.lens.settleForgets()).toMatchObject({ settled: 1, failed: 0 });
    // A new revision of each, and the key never sent, pushed after: dropped at drain.
    const later = [
      { ...seen, revision: 1, text: "The alpha plan, again." },
      { ...day, revision: 1 },
      moment({ key: never as MomentItem["key"] }),
    ];
    const control = moment();
    await push([...later, control]);
    const counts = await writer.takeCapture();
    expect(counts.dropped.removed).toBe(3);
    expect(counts.taken).toBe(1);
    for (const item of later) expect(await storedOf(item.key), item.key).toBe(0);
    expect(await storedOf(control.key)).toBe(2);
  });

  it("a forget of a block key removes every split", async () => {
    const day = blockDay();
    await push([day]);
    await writer.takeCapture();
    expect(await count("knowledge.captures", "capture_key = $1", [day.key])).toBe(2);
    await push([forget([day.key])]);
    expect(await owner.lens.settleForgets()).toMatchObject({ settled: 1, failed: 0 });
    expect(await storedOf(day.key)).toBe(0);
    const pairs = pairsOf(day.key, ["own", "employer:example"]);
    expect((await removedRows(pairs)).map((row) => row.reason)).toEqual([
      "device_forget",
      "device_forget",
      "device_forget",
    ]);
  });

  it("a forget naming a key another device sent removes nothing of that device's", async () => {
    const other = await addDevice("other");
    const theirs = moment();
    await push([theirs], other);
    await writer.takeCapture();
    await push([forget([theirs.key])]);
    expect(await owner.lens.settleForgets()).toMatchObject({ settled: 1, failed: 0 });
    expect(await storedOf(theirs.key)).toBe(2);
    // Recorded under this device's own account, never the other's.
    expect(await removedRows(pairsOf(theirs.key, [], other))).toEqual([]);
    expect((await removedRows(pairsOf(theirs.key))).map((row) => row.reason)).toEqual(["device_forget"]);
    // The control: the other device's own forget removes it.
    await push([forget([theirs.key])], other);
    expect(await owner.lens.settleForgets()).toMatchObject({ settled: 1, failed: 0 });
    expect(await storedOf(theirs.key)).toBe(0);
  });

  it("a forget whose settlement fails is counted and holds back no other", async () => {
    const [kept, gone] = [moment(), moment()];
    await push([kept, gone]);
    await writer.takeCapture();
    const [spoiled, fine] = [forget([kept.key]), forget([gone.key])];
    await push([spoiled]);
    await push([fine]);
    // The first forget's body is the second's envelope, bound to the second's row: it opens nowhere here.
    await admin(
      `update ledger.capture_inbox set body_enc = (select body_enc from ledger.capture_inbox where client_id = $1 and source_key_fp = $3)
       where client_id = $1 and source_key_fp = $2`,
      [mac.capture.id, fpOf(spoiled.key), fpOf(fine.key)],
    );
    expect(await owner.lens.settleForgets()).toEqual({ settled: 1, alreadyRemoved: 0, failed: 1 });
    expect(await storedOf(gone.key)).toBe(0);
    expect(await storedOf(kept.key)).toBe(2);
    // Rolled back and left for the next run.
    expect(await forgetRow(spoiled)).toEqual({ body: true, taken: false });
    expect(await removedRows(pairsOf(kept.key))).toEqual([]);
    expect(await owner.lens.settleForgets()).toMatchObject({ settled: 0, failed: 1 });
  });

  it("at the ceiling, a forget is settled", async () => {
    const stored = moment();
    await push([stored]);
    await writer.takeCapture();
    const full = createReader({ url: db.urls.reader, keys: db.keys, log, captureCeilingBytes: 1 });
    try {
      const refused = moment();
      const notice = forget([stored.key]);
      const answer = await full.pushCapture(mac.capture.token, { batch: batch(), items: [refused, notice] });
      expect(answer).toEqual({
        ok: true,
        value: {
          items: [
            { key: refused.key, outcome: "refused", code: "ceiling" },
            { key: notice.key, outcome: "accepted" },
          ],
        },
      });
    } finally {
      await full.close();
    }
    expect(await owner.lens.settleForgets()).toMatchObject({ settled: 1, failed: 0 });
    expect(await storedOf(stored.key)).toBe(0);
  });

  it("while a sync holds the lock, settle answers sync_running and the next run takes the forget", async () => {
    const seen = moment();
    await push([seen]);
    await writer.takeCapture();
    const notice = forget([seen.key]);
    await push([notice]);
    const sync = await holding(db.urls.writer, SYNC);
    try {
      await expect(owner.lens.settleForgets()).rejects.toMatchObject({ code: "sync_running" });
    } finally {
      await sync.release();
    }
    expect(await forgetRow(notice)).toEqual({ body: true, taken: false });
    expect(await storedOf(seen.key)).toBe(2);
    expect(await owner.lens.settleForgets()).toMatchObject({ settled: 1, failed: 0 });
    expect(await storedOf(seen.key)).toBe(0);
  });

  it("a forget that races an owner erasure settles cleanly, its pair counted already_removed", async () => {
    const seen = moment();
    await push([seen]);
    await writer.takeCapture();
    expect(
      (
        await owner.erasure.eraseItem(
          { kind: "capture", id: await captureIdOf(seen.key) },
          { requestId: testId("req") },
        )
      ).items,
    ).toBe(1);
    const notice = forget([seen.key]);
    await push([notice]);
    const settled = await owner.lens.settleForgets();
    expect(settled.failed).toBe(0);
    expect(settled.alreadyRemoved).toBe(1);
    expect(await forgetRow(notice)).toEqual({ body: false, taken: true });
    // The owner's erasure's row stands.
    expect((await removedRows(pairsOf(seen.key))).map((row) => row.reason)).toEqual(["owner_erasure"]);
  });

  it("a forget and a pi erase on two connections take two journal numbers", async () => {
    const [first, second] = [moment(), moment()];
    await push([first, second]);
    await writer.takeCapture();
    await push([forget([first.key])]);
    const target = await captureIdOf(second.key);
    const other = newAdmin();
    try {
      let enter: () => void = () => {};
      let resume: () => void = () => {};
      const entered = new Promise<void>((resolve) => (enter = resolve));
      const gate = new Promise<void>((resolve) => (resume = resolve));
      const hold: ErasureHook = {
        name: "test_hold",
        run: async () => {
          enter();
          await gate;
          return 0;
        },
      };
      await withHook(hold, async () => {
        const settling = owner.lens.settleForgets();
        await entered;
        await expect(
          other.erasure.eraseItem({ kind: "capture", id: target }, { requestId: testId("req") }),
        ).rejects.toMatchObject({ code: "sync_running" });
        resume();
        expect(await settling).toMatchObject({ settled: 1, failed: 0 });
      });
      await other.erasure.eraseItem({ kind: "capture", id: target }, { requestId: testId("req") });
    } finally {
      await other.close();
    }
    const last = await admin<{ kind: string; seq: number }>(
      "select kind, journal_seq::int as seq from knowledge.erasures order by journal_seq desc limit 2",
    );
    const [later, earlier] = last;
    expect([earlier?.kind, later?.kind]).toEqual(["device_forget", "item"]);
    expect((later?.seq ?? 0) - (earlier?.seq ?? 0)).toBe(1);
    expect((await readJournal(journalPath(db.keyFile))).seq).toBe(later?.seq);
  });
});

describe("a restore", { timeout: TIMEOUT }, () => {
  it("after a restore from a dump taken before the forget, replay removes it again before the first read and writes no ruling, and the resent forget settles as already_removed", async () => {
    const box = await createTestDatabase({ compartments: ["own", "employer:example"] });
    const seen = moment();
    const notice = forget([seen.key]);
    let device = mac;
    {
      const boxWriter = createWriter({ url: box.urls.writer, keys: box.keys, log });
      const boxReader = createReader({ url: box.urls.reader, keys: box.keys, log });
      try {
        device = await addDevice("mac", box);
        for (const rule of lens.scope) await insertScope(rule, box);
        await push([seen], device, boxReader);
        expect(await boxWriter.takeCapture()).toMatchObject({ taken: 1 });
        // The forget is pushed before the dump, and settled only after it.
        await push([notice], device, boxReader);
      } finally {
        await boxReader.close();
        await boxWriter.close();
      }
    }
    const dump = await copyTestDatabase(box);
    try {
      const live = newAdmin(box);
      try {
        expect(await live.lens.settleForgets()).toMatchObject({ settled: 1, failed: 0 });
      } finally {
        await live.close();
      }
      expect(await storedOf(seen.key, box)).toBe(0);
      // The box restored from the dump, beside the journal it kept.
      const restored = newAdmin(dump, journalPath(box.keyFile));
      try {
        expect(await storedOf(seen.key, dump)).toBe(2);
        expect(await restored.erasure.level()).toBe("behind");
        expect(await restored.erasure.replayErasures()).toEqual({ applied: 1, journalled: 0 });
        expect(await restored.erasure.level()).toBe("level");
        expect(await storedOf(seen.key, dump)).toBe(0);
        expect(
          one(
            await admin<{ kind: string; ruling: string | null }>(
              "select kind, ruling_id as ruling from knowledge.erasures",
              [],
              dump,
            ),
          ),
        ).toEqual({ kind: "device_forget", ruling: null });
        expect(await count("knowledge.owner_decisions", "true", [], dump)).toBe(0);
        expect(await count("knowledge.removed_evidence", "reason = 'device_forget'", [], dump)).toBe(1);
        // Lens resends the forget; the one the dump held settles with nothing left to remove.
        const settled = await restored.lens.settleForgets();
        expect(settled).toMatchObject({ failed: 0 });
        expect(settled.alreadyRemoved).toBe(1);
        expect(await forgetRow(notice, device, dump)).toEqual({ body: false, taken: true });
        expect(await count("knowledge.owner_decisions", "true", [], dump)).toBe(0);
        expect(await count("knowledge.removed_evidence", "true", [], dump)).toBe(1);
      } finally {
        await restored.close();
      }
    } finally {
      await dump.drop();
      await box.drop();
    }
  });
});
