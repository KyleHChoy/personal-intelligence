import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type Admin, createAdmin } from "../admin/admin.ts";
import { rewriteCaptureItem } from "../lens/capture-item.ts";
import { committedAs as inTransaction, one, session, sqlState } from "../test-support/connections.ts";
import { queryAs, type TestDatabase } from "../test-support/database.ts";
import { type LoggedCall, recordingLogger } from "../test-support/recording.ts";
import { seeder } from "../test-support/seeder.ts";
import { withDatabase } from "../test-support/store.ts";
import { KEY_RECORD } from "./key-fingerprint.ts";
import { generateKeyFile, type Keys, loadKeys } from "./keys.ts";
import { open, type Sealed, sealUnder } from "./seal.ts";

// What the box holds to by itself, on synthetic rows: evidence content no update changes, and the
// key file's recorded identity.

const TIMEOUT = 180_000;
const REFUSED = "23514";
const NO_GRANT = "42501";

// One mail item and one screen moment, each with its blob, as the admin seeds them.
const seeded = (db: TestDatabase) =>
  session(db.urls.admin, async (query) => {
    const seed = seeder(db, query);
    const mail = await seed.evidence(["own"]);
    const moment = (await seed.capture(["own"])).evidenceId;
    const spare = await seed.blob(["own"]);
    const blobOf = async (id: string): Promise<string> =>
      one(await query<{ blob_ref: string }>("select blob_ref from vault.evidence_items where id = $1", [id])).blob_ref;
    return { mail, moment, spare, mailBlob: await blobOf(mail), momentBlob: await blobOf(moment) };
  });
const itemAt = (id: string) => ({ table: "vault.evidence_items", id, column: "item_enc" });
const sealedItem = (db: TestDatabase, id: string, facts: object) =>
  sealUnder(db.keys, ["own"], itemAt(id), JSON.stringify(facts));
const factsOf = async (db: TestDatabase, id: string): Promise<unknown> => {
  const row = one(
    await queryAs<{ item_enc: Sealed }>(db.urls.admin, "select item_enc from vault.evidence_items where id = $1", [id]),
  );
  return JSON.parse(
    open(db.keys, { id, compartments: ["own"], item_enc: row.item_enc }, "vault.evidence_items.item_enc", "throw"),
  );
};

describe("evidence content is kept unchanged", { timeout: TIMEOUT }, () => {
  it("refuses an update of a blob's envelope or reference, as the admin and as the writer", () =>
    withDatabase(async (db) => {
      const { mailBlob, momentBlob } = await seeded(db);
      for (const url of [db.urls.admin, db.urls.writer]) {
        expect(
          await sqlState(() =>
            queryAs(
              url,
              "update vault.evidence_blobs set envelope = (select envelope from vault.evidence_blobs where blob_ref = $2) where blob_ref = $1",
              [mailBlob, momentBlob],
            ),
          ),
        ).toBe(REFUSED);
        expect(
          await sqlState(() =>
            queryAs(url, "update vault.evidence_blobs set blob_ref = $2 where blob_ref = $1", [mailBlob, "blb_other"]),
          ),
        ).toBe(REFUSED);
      }
      // An update that changes neither passes, so a statement that sets a column to itself is no fault.
      expect(
        await sqlState(() =>
          queryAs(db.urls.admin, "update vault.evidence_blobs set envelope = envelope where blob_ref = $1", [mailBlob]),
        ),
      ).toBeNull();
    }));

  it("refuses a changed content hash, another blob, and rewritten facts, as the admin and as the writer; every other runtime role holds no such update", () =>
    withDatabase(async (db) => {
      const { mail, moment, spare } = await seeded(db);
      const before = await factsOf(db, mail);
      for (const url of [db.urls.admin, db.urls.writer]) {
        expect(
          await sqlState(() =>
            queryAs(url, "update vault.evidence_items set content_hash = $2 where id = $1", [mail, "0".repeat(64)]),
          ),
        ).toBe(REFUSED);
        expect(
          await sqlState(() =>
            queryAs(url, "update vault.evidence_items set blob_ref = $2 where id = $1", [mail, spare]),
          ),
        ).toBe(REFUSED);
        expect(
          await sqlState(() =>
            queryAs(url, "update vault.evidence_items set item_enc = $2 where id = $1", [
              mail,
              sealedItem(db, mail, { planted: true }),
            ]),
          ),
        ).toBe(REFUSED);
        // A capture's facts too, outside the store's one function.
        expect(
          await sqlState(() =>
            queryAs(url, "update vault.evidence_items set item_enc = $2 where id = $1", [
              moment,
              sealedItem(db, moment, { planted: true }),
            ]),
          ),
        ).toBe(REFUSED);
        // The setting admits a capture's facts alone: mail's stay refused under it.
        expect(
          await sqlState(() =>
            inTransaction(url, async (query) => {
              await query("select set_config('pi.evidence_rewrite', 'capture_facts', true)");
              await query("update vault.evidence_items set item_enc = $2 where id = $1", [
                mail,
                sealedItem(db, mail, { planted: true }),
              ]);
            }),
          ),
        ).toBe(REFUSED);
      }
      for (const url of [db.urls.pipeline, db.urls.restricted, db.urls.reader, db.urls.work, db.urls.proxy]) {
        expect(
          await sqlState(() =>
            queryAs(
              url,
              "update vault.evidence_items set item_enc = item_enc, content_hash = content_hash where id = $1",
              [mail],
            ),
          ),
        ).toBe(NO_GRANT);
        expect(
          await sqlState(() =>
            queryAs(url, "update vault.evidence_blobs set envelope = envelope where blob_ref = $1", [spare]),
          ),
        ).toBe(NO_GRANT);
      }
      expect(await factsOf(db, mail)).toEqual(before);
    }));

  it("lets what is not content change, and lets expiry and removal run as before", () =>
    withDatabase(async (db) => {
      const { mail, moment, mailBlob } = await seeded(db);
      // A hold's release and the derived members: no content.
      await queryAs(db.urls.admin, "update vault.evidence_items set hold_released_at = now() where id = $1", [mail]);
      await queryAs(
        db.urls.writer,
        "update vault.evidence_items set participant_members = '{m-owner}', sender_member = 'm-owner' where id = $1",
        [mail],
      );
      // Expiry, as the writer writes it (writer-item-removal.ts): the blob gone, the facts sealed
      // again over the empty object, in one statement; then the blob's own row.
      await inTransaction(db.urls.writer, async (query) => {
        await query(
          "update vault.evidence_items set blob_ref = null, payload_state = 'expired', expired_at = now(), item_enc = $2 where id = $1",
          [mail, sealedItem(db, mail, {})],
        );
        await query("delete from vault.evidence_blobs where blob_ref = $1", [mailBlob]);
      });
      expect(await factsOf(db, mail)).toEqual({});
      // Expired twice is sealed twice: still no fault.
      await queryAs(db.urls.writer, "update vault.evidence_items set item_enc = $2 where id = $1", [
        mail,
        sealedItem(db, mail, {}),
      ]);
      // The other expiry (writer-documents.ts, capture-write.ts): the payload gone, the facts kept.
      await queryAs(
        db.urls.writer,
        "update vault.evidence_items set blob_ref = null, payload_state = 'expired' where id = $1",
        [moment],
      );
      // An expired item takes no blob again.
      expect(
        await sqlState(() =>
          queryAs(
            db.urls.writer,
            "update vault.evidence_items set blob_ref = $2, payload_state = 'present' where id = $1",
            [mail, mailBlob],
          ),
        ),
      ).toBe(REFUSED);
      // A deletion notice removes the row: a delete is no update.
      await queryAs(db.urls.admin, "delete from knowledge.captures where evidence_id = $1", [moment]);
      await queryAs(db.urls.admin, "delete from vault.evidence_items where id = $1", [moment]);
      expect(await queryAs(db.urls.admin, "select 1 from vault.evidence_items where id = $1", [moment])).toEqual([]);
    }));

  it("seals a capture's facts again through the store's one function, inside a transaction alone, and leaves the setting cleared", () =>
    withDatabase(async (db) => {
      const { moment } = await seeded(db);
      const item = { evidenceId: moment, compartments: ["own"] };
      for (const [url, facts] of [
        [db.urls.admin, { vouched: true }],
        [db.urls.writer, { lines: 2 }],
      ] as const) {
        await inTransaction(url, async (query) => {
          await rewriteCaptureItem(query, db.keys, item, facts);
          // Cleared after its one statement: the next rewrite in the same transaction is refused.
          await query("savepoint after");
          expect(
            await sqlState(() =>
              query("update vault.evidence_items set item_enc = $2 where id = $1", [
                moment,
                sealedItem(db, moment, { planted: true }),
              ]),
            ),
          ).toBe(REFUSED);
          await query("rollback to savepoint after");
        });
        expect(await factsOf(db, moment)).toEqual(facts);
      }
      // Outside a transaction the setting ends with its own statement, so the update is refused.
      expect(
        await sqlState(() =>
          session(db.urls.admin, (query) => rewriteCaptureItem(query, db.keys, item, { planted: true })),
        ),
      ).toBe(REFUSED);
      expect(await factsOf(db, moment)).toEqual({ lines: 2 });
    }));
});

// The admin under a key set, as a start of the box holds one; what it logged beside its answer.
async function underKeys<T>(
  db: TestDatabase,
  keys: Keys,
  fn: (admin: Admin) => Promise<T>,
): Promise<{ result: T; calls: LoggedCall[] }> {
  const { log, calls } = recordingLogger();
  const admin = createAdmin({ url: db.urls.admin, keys, log, now: () => new Date() });
  try {
    return { result: await fn(admin), calls };
  } finally {
    await admin.close();
  }
}
const check = async (db: TestDatabase, keys: Keys) =>
  (await underKeys(db, keys, (admin) => admin.box.checkKeys())).result;
// The open `key_changed` cards, as `pia status` lists them.
const keyCards = async (db: TestDatabase): Promise<string[]> =>
  (await underKeys(db, db.keys, (admin) => admin.accounts.status())).result.boxHealth
    .filter((row) => row.kind === "key_changed")
    .map((row) => row.about);
// Another key file's keys: none of them the database's.
async function otherKeys(compartments: string[]): Promise<Keys> {
  const folder = await mkdtemp(join(tmpdir(), "pi-other-keys-"));
  try {
    await generateKeyFile(join(folder, "keys.json"), compartments);
    return await loadKeys(join(folder, "keys.json"));
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
const withKey = (keys: Keys, compartment: string, from: Keys): Keys => ({
  ...keys,
  compartments: new Map([...keys.compartments, [compartment, from.compartments.get(compartment) as never]]),
});

describe("the key file's recorded identity", { timeout: TIMEOUT }, () => {
  it("is recorded at the first check, sealed, and found the same at the next; a key added since is taken into it", () =>
    withDatabase(async (db) => {
      expect(await check(db, db.keys)).toBe("recorded");
      expect(await check(db, db.keys)).toBe("same");
      const [row] = await queryAs<{ value_enc: unknown }>(
        db.urls.admin,
        "select value_enc from policy.secrets where name = $1",
        [KEY_RECORD],
      );
      // One sealed row: no mark of any key is in clear.
      expect(JSON.stringify(row?.value_enc)).not.toMatch(/[0-9a-f]{64}/);
      const more = withKey(db.keys, "agent:alpha", await otherKeys(["agent:alpha"]));
      expect(await check(db, more)).toBe("added");
      expect(await check(db, more)).toBe("same");
      expect(await keyCards(db)).toEqual([]);
    }));

  it("a key that differs, or one that is gone, raises one card and logs a count alone; the keys as recorded close it", () =>
    withDatabase(async (db) => {
      const first = withKey(db.keys, "agent:alpha", await otherKeys(["agent:alpha"]));
      expect(await check(db, first)).toBe("recorded");
      // Another key under the same name.
      const swapped = withKey(db.keys, "agent:alpha", await otherKeys(["agent:alpha"]));
      const { result, calls } = await underKeys(db, swapped, (admin) => admin.box.checkKeys());
      expect(result).toBe("changed");
      expect(calls.map((call) => call.event)).toContainEqual({
        event: "key_file_changed",
        code: "key_changed",
        counts: { keys: 1 },
      });
      expect(JSON.stringify(calls)).not.toContain("agent:alpha");
      expect(await keyCards(db)).toEqual(["key_file"]);
      // Checked again while it stands: still one card.
      expect(await check(db, swapped)).toBe("changed");
      expect(await keyCards(db)).toEqual(["key_file"]);
      // The file as recorded, back: the card is closed by code.
      expect(await check(db, first)).toBe("same");
      expect(await keyCards(db)).toEqual([]);
      // An older copy, without the key added since: gone is a change too.
      expect(await check(db, db.keys)).toBe("changed");
      expect(await keyCards(db)).toEqual(["key_file"]);
    }));

  it("the owner's accept records the keys held now and closes the card", () =>
    withDatabase(async (db) => {
      const first = withKey(db.keys, "agent:alpha", await otherKeys(["agent:alpha"]));
      const second = withKey(db.keys, "agent:alpha", await otherKeys(["agent:alpha"]));
      expect(await check(db, first)).toBe("recorded");
      expect(await check(db, second)).toBe("changed");
      await underKeys(db, second, (admin) => admin.box.acceptKeys());
      expect(await keyCards(db)).toEqual([]);
      expect(await check(db, second)).toBe("same");
      expect(await check(db, first)).toBe("changed");
    }));

  it("a record the keys held now cannot open is a changed key", () =>
    withDatabase(async (db) => {
      expect(await check(db, db.keys)).toBe("recorded");
      // Another file altogether, with the same names: its `own` key does not open the record.
      const other = await otherKeys([...db.keys.compartments.keys()]);
      expect(await check(db, other)).toBe("changed");
      expect(await keyCards(db)).toEqual(["key_file"]);
      expect(await check(db, db.keys)).toBe("same");
      expect(await keyCards(db)).toEqual([]);
    }));
});

describe("a job the timer records every day", { timeout: TIMEOUT }, () => {
  const DAY = 24 * 60 * 60_000;
  const at = async <T>(db: TestDatabase, now: Date, fn: (admin: Admin) => Promise<T>): Promise<T> => {
    const admin = createAdmin({ url: db.urls.admin, keys: db.keys, log: recordingLogger().log, now: () => now });
    try {
      return await fn(admin);
    } finally {
      await admin.close();
    }
  };
  const stopped = async (db: TestDatabase, now: Date): Promise<string[]> => {
    await at(db, now, (admin) => admin.box.recordCoverage([]));
    return (await at(db, now, (admin) => admin.accounts.status())).boxHealth
      .filter((row) => row.kind === "detector_stopped")
      .map((row) => row.about)
      .sort();
  };

  it("is read as stopped after three days with no row, and a lane_off row a day keeps a job turned off from it", () =>
    withDatabase(async (db) => {
      const now = new Date();
      const JOBS = ["extract", "reasoner", "outcome_test", "improvement_filing"] as const;
      const run = (job: (typeof JOBS)[number], when: Date, code: string) =>
        at(db, when, (admin) => admin.box.recordJob({ job, code, startedAt: new Date(when.getTime() - 60_000) }));
      for (const job of JOBS) await run(job, new Date(now.getTime() - 4 * DAY), "ok");
      // The box ran since: a settle a day ago.
      await at(db, now, (admin) =>
        admin.box.recordJob({ job: "erase_settle", code: "ok", startedAt: new Date(now.getTime() - DAY) }),
      );
      // Two of them turned off since, as the timer records a switch: once a day.
      for (const days of [3, 2, 1])
        for (const job of ["extract", "outcome_test"] as const)
          await run(job, new Date(now.getTime() - days * DAY), "lane_off");
      expect(await stopped(db, now)).toEqual(expect.arrayContaining(["improvement_filing", "reasoner"]));
      expect(await stopped(db, now)).not.toEqual(expect.arrayContaining(["extract"]));
      expect(await stopped(db, now)).not.toEqual(expect.arrayContaining(["outcome_test"]));
      // A run of each closes its card at the next record.
      const later = new Date(now.getTime() + 60 * 60_000);
      for (const job of ["reasoner", "improvement_filing"] as const) await run(job, later, "ok");
      expect(await stopped(db, new Date(later.getTime() + 60_000))).toEqual([]);
    }));
});
