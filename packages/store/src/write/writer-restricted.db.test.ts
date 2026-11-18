import { ConnectorCursor } from "@intelligence/contracts";
import type { RestrictedCategory } from "@intelligence/contracts/personal";
import { THE_OWNER } from "@intelligence/personal-core";
import { describe, expect, it } from "vitest";
import type { Keys } from "../core/keys.ts";
import { openedUnder } from "../core/tx.ts";
import { connect, OWNER, QUENTIN, type Who } from "../test-support/cast.ts";
import { SEALED } from "../test-support/catalogue-work.ts";
import { testId } from "../test-support/clients.ts";
import { addOwnerAddressUnderived, type Query, session } from "../test-support/connections.ts";
import { fingerprint, queryAs, type TestDatabase } from "../test-support/database.ts";
import {
  derive,
  ingestMail,
  type MailFixture,
  mail,
  mailFacts,
  mailItem,
  mailRevision,
  mailSourceId,
} from "../test-support/items.ts";
import { type Store, withStore } from "../test-support/store.ts";

// Storing a restricted item at the writer. The screen's verdict is in each fixture's facts
// (`restricted`), as deriveItem sets it from the on categories; sync's own screen is tested in pi's
// sync-restricted test. Every database is made with the health and money keys.

const TIMEOUT = 120_000;
const RESTRICTED: RestrictedCategory[] = ["health", "money"];
const HEALTH = ["own", "restricted:health"];
const ME: Who = { address: OWNER.personal, name: OWNER.name };
const CLINIC: Who = { address: "rhea.moss@clinic-example.test", name: "Rhea Moss" };
const NURSE: Who = { address: "bea.lowe@clinic-example.test", name: "Bea Lowe" };

const received = (id: string, over: Partial<MailFixture> = {}): MailFixture =>
  mail({
    id,
    threadId: `thread-${id}`,
    at: "2026-09-02T09:00:00Z",
    from: CLINIC,
    to: [ME],
    cc: [NURSE],
    subject: `Your lab results ${id}`,
    labels: ["INBOX"],
    text: "Your lab results are ready.",
    ...over,
  });

const withRestricted = <T>(fn: (store: Store) => Promise<T>): Promise<T> => withStore(fn, { restricted: RESTRICTED });

// The general file alone: every key the database's file holds but the restricted ones.
const generalOnly = (keys: Keys): Keys => ({
  compartments: new Map([...keys.compartments].filter(([name]) => !name.startsWith("restricted:"))),
  fingerprintKey: keys.fingerprintKey,
});

// Every table with a compartments column, from the catalogue.
async function labelledTables(db: TestDatabase): Promise<string[]> {
  const rows = await queryAs<{ name: string }>(
    db.urls.admin,
    `select c.table_schema || '.' || c.table_name as name from information_schema.columns c
     join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
     where c.column_name = 'compartments' and c.table_schema in ('policy', 'vault', 'knowledge', 'projections', 'ledger', 'queue') order by 1`,
  );
  return rows.map((row) => row.name);
}

// Every row of every labelled table, as JSON, by table.
async function snapshot(db: TestDatabase, tables: string[]): Promise<Map<string, Set<string>>> {
  const all = new Map<string, Set<string>>();
  for (const table of tables)
    all.set(
      table,
      new Set(
        (await queryAs<{ row: string }>(db.urls.admin, `select to_jsonb(t)::text as row from ${table} t`)).map(
          (one) => one.row,
        ),
      ),
    );
  return all;
}

// The rows a step added, by table, with their labels.
function added(
  before: Map<string, Set<string>>,
  after: Map<string, Set<string>>,
): { table: string; compartments: string[]; entity?: string }[] {
  const rows: { table: string; compartments: string[]; entity?: string }[] = [];
  for (const [table, now] of after) {
    for (const row of now) {
      if (before.get(table)?.has(row)) continue;
      const { compartments, entity_id } = JSON.parse(row) as { compartments: string[]; entity_id?: string };
      rows.push({ table, compartments, ...(entity_id === undefined ? {} : { entity: entity_id }) });
    }
  }
  return rows;
}

// A recorder of every row any statement writes to a labelled table, with the label it wrote:
// a trigger on each table, made by the tables' owner, filling a table of its own. It sees a row
// written and then changed in the same transaction, which the rows left after it cannot show.
async function recordWrites(
  db: TestDatabase,
  tables: string[],
): Promise<{
  clear(): Promise<void>;
  written(): Promise<{ table: string; compartments: string[]; entity?: string }[]>;
}> {
  const asOwner = <T>(fn: (query: Query) => Promise<T>): Promise<T> =>
    session(db.urls.bootstrap, async (query) => {
      await query("set role pi_owner");
      return fn(query);
    });
  await asOwner(async (query) => {
    await query("create table vault.o5_writes (tbl text not null, label text[], entity text)");
    await query(
      `create function vault.o5_record() returns trigger language plpgsql security definer set search_path = pg_catalog as $$
       begin insert into vault.o5_writes values (tg_table_schema || '.' || tg_table_name, new.compartments, to_jsonb(new) ->> 'entity_id'); return new; end $$`,
    );
    for (const table of tables)
      await query(
        `create trigger o5_record after insert or update on ${table} for each row execute function vault.o5_record()`,
      );
  });
  return {
    clear: () => asOwner(async (query) => void (await query("delete from vault.o5_writes"))),
    written: () =>
      asOwner(async (query) =>
        (
          await query<{ tbl: string; label: string[]; entity: string | null }>(
            "select tbl, label, entity from vault.o5_writes",
          )
        ).map((row) => ({
          table: row.tbl,
          compartments: row.label,
          ...(row.entity === null ? {} : { entity: row.entity }),
        })),
      ),
  };
}

const evidenceRows = (db: TestDatabase, fixture: MailFixture) =>
  queryAs<{ id: string; revision: number; compartments: string[] }>(
    db.urls.admin,
    "select id, revision, compartments from vault.evidence_items where source_item_fp = $1 order by revision",
    [fingerprint(db.keys, "source_id", mailSourceId(fixture))],
  );

const messageRow = async (db: TestDatabase, fixture: MailFixture) =>
  (
    await queryAs<{ id: string; held: boolean; compartments: string[] }>(
      db.urls.admin,
      "select m.id, m.held, m.compartments from knowledge.messages m join vault.evidence_items e on e.id = m.evidence_id where e.source_item_fp = $1",
      [fingerprint(db.keys, "source_id", mailSourceId(fixture))],
    )
  )[0];

describe("the label at ingest", { timeout: TIMEOUT }, () => {
  it("a message that matches a health term has every row, in every table, labelled own and restricted:health", () =>
    withRestricted(async ({ db, writer }) => {
      const accounts = await connect(writer);
      const tables = await labelledTables(db);
      expect(tables).toEqual(
        expect.arrayContaining([
          "vault.evidence_items",
          "vault.evidence_blobs",
          "knowledge.messages",
          "knowledge.accounts",
          "knowledge.domains",
          "knowledge.aliases",
          "knowledge.interaction_log",
          "vault.sent_recipients",
        ]),
      );
      const recorder = await recordWrites(db, tables);
      const before = await snapshot(db, tables);
      await recorder.clear();

      const health = received("gm-o5-r1", { restricted: ["health"] });
      expect(await ingestMail(writer, accounts.personalMail, health)).toBe("stored");
      // A message the owner sent from an address seen nowhere else, to a person seen nowhere
      // else, under the same category: its recipient rows are the item's too. The owner's own
      // address is the owner's identity, not the item's: it is kept under the account's
      // compartment, as every item of the account resolves it.
      const sent = mail({
        id: "gm-o5-r1-sent",
        threadId: "thread-gm-o5-r1-sent",
        at: "2026-09-02T10:00:00Z",
        from: { address: OWNER.alias, name: OWNER.name },
        to: [{ address: "ward.clerk@ward-example.test", name: "Ward Clerk" }],
        subject: "My prescription",
        labels: ["SENT"],
        text: "Please renew my prescription.",
        restricted: ["health"],
      });
      expect(await ingestMail(writer, accounts.personalMail, sent)).toBe("stored");

      const [owner] = await queryAs<{ id: string }>(
        db.urls.admin,
        "select id from knowledge.entities where kind = 'owner'",
      );
      const isOwners = (row: { table: string; entity?: string }) =>
        row.table === "knowledge.accounts" && row.entity === owner?.id;
      const all = added(before, await snapshot(db, tables));
      expect(all.filter(isOwners).map((row) => row.compartments)).toEqual([["own"]]);
      const rows = all.filter((row) => !isOwners(row));
      // Rows in each of these tables, so the test sees the item's whole write.
      expect(new Set(rows.map((row) => row.table))).toEqual(
        new Set([
          "vault.evidence_items",
          "vault.evidence_blobs",
          "knowledge.messages",
          "knowledge.accounts",
          "knowledge.domains",
          "knowledge.aliases",
          "knowledge.interaction_log",
          "vault.sent_recipients",
        ]),
      );
      for (const row of rows) expect(row.compartments, row.table).toEqual(HEALTH);
      // And no statement wrote a row under own alone, even for a moment.
      const written = (await recorder.written()).filter((row) => !isOwners(row));
      expect(written.length).toBeGreaterThanOrEqual(rows.length);
      for (const row of written) expect(row.compartments, row.table).toEqual(HEALTH);

      // The control: a message that matches no term is stored under own, in the same tables.
      await recorder.clear();
      const plain = received("gm-o5-r1-plain", { from: QUENTIN, cc: [], subject: "Lunch", text: "Lunch on Friday?" });
      expect(await ingestMail(writer, accounts.personalMail, plain)).toBe("stored");
      expect(new Set((await recorder.written()).map((row) => row.compartments.join(",")))).toEqual(new Set(["own"]));
      expect((await evidenceRows(db, plain)).map((row) => row.compartments)).toEqual([["own"]]);
    }));

  it("an unread email the screen restricts is stored under its label, and a listed row of it takes the label", () =>
    withRestricted(async ({ db, writer }) => {
      const accounts = await connect(writer);
      const fixture = received("gm-o5-unread");
      // A listing named it before it was stored: its listed row is under the account's compartment.
      await writer.finishPage(accounts.personalMail, {
        listing: { first: true },
        listedIds: [mailSourceId(fixture)],
        skippedIds: [],
        next: ConnectorCursor.parse("cursor-o5"),
      });
      const unread = async () => ({
        kind: "unread" as const,
        members: { participantMembers: [THE_OWNER] },
        restricted: ["health" as const],
      });
      expect(await writer.ingestItem(accounts.personalMail, mailItem(fixture, accounts.personalMail), unread)).toBe(
        "unread",
      );
      expect((await evidenceRows(db, fixture)).map((row) => row.compartments)).toEqual([HEALTH]);
      const listed = await queryAs<{ compartments: string[] }>(
        db.urls.admin,
        "select compartments from vault.listed_items where source_item_fp = $1",
        [fingerprint(db.keys, "source_id", mailSourceId(fixture))],
      );
      expect(listed.map((row) => row.compartments)).toEqual([HEALTH]);
    }));

  it("every sealed value of the item opens under both files and fails with the general file alone", () =>
    withRestricted(async ({ db, writer }) => {
      const accounts = await connect(writer);
      expect(await ingestMail(writer, accounts.personalMail, received("gm-o5-r11", { restricted: ["health"] }))).toBe(
        "stored",
      );
      const general = generalOnly(db.keys);
      const labelled = new Set(await labelledTables(db));
      let opened = 0;
      for (const at of SEALED.filter((one) => labelled.has(one.table))) {
        const rows = await queryAs<{ id: string; value: unknown; compartments: string[] }>(
          db.urls.admin,
          `select ${at.id} as id, ${at.column} as value, compartments from ${at.table} where ${at.column} is not null and policy.is_restricted(compartments)`,
        );
        for (const row of rows) {
          const where = { table: at.table, id: row.id, column: at.column };
          expect(row.compartments, at.table).toEqual(HEALTH);
          expect(
            () => openedUnder(db.keys, row.compartments, where, row.value),
            `${at.table}.${at.column}`,
          ).not.toThrow();
          expect(() => openedUnder(general, row.compartments, where, row.value), `${at.table}.${at.column}`).toThrow(
            expect.objectContaining({ code: "open_failed" }),
          );
          // Nor under the source compartment alone, the key a single-name seal would have used.
          expect(() => openedUnder(db.keys, ["own"], where, row.value), `${at.table}.${at.column}`).toThrow(
            expect.objectContaining({ code: "open_failed" }),
          );
          opened += 1;
        }
      }
      // The blob, the evidence row, six message columns, two accounts, a domain and two aliases at least.
      expect(opened).toBeGreaterThanOrEqual(12);
    }));

  it("a message that matches no term is stored under own, as on main", () =>
    withRestricted(async ({ db, writer }) => {
      const accounts = await connect(writer);
      const plain = received("gm-o5-plain", { restricted: [] });
      expect(await ingestMail(writer, accounts.personalMail, plain)).toBe("stored");
      expect((await evidenceRows(db, plain)).map((row) => row.compartments)).toEqual([["own"]]);
      expect((await messageRow(db, plain))?.compartments).toEqual(["own"]);
    }));

  it("a new revision that matches no term keeps restricted:health", () =>
    withRestricted(async ({ db, writer }) => {
      const accounts = await connect(writer);
      const first = received("gm-o5-r9", { restricted: ["health"] });
      expect(await ingestMail(writer, accounts.personalMail, first)).toBe("stored");
      const before = await messageRow(db, first);
      // The next revision's facts carry no category: the screen found nothing.
      const next = { ...first, subject: "A note", text: "See you soon.", restricted: [] };
      expect(
        await writer.ingestItem(accounts.personalMail, mailRevision(first, accounts.personalMail), mailFacts(next)),
      ).toBe("stored");
      expect((await evidenceRows(db, first)).map((row) => [row.revision, row.compartments])).toEqual([
        [0, HEALTH],
        [1, HEALTH],
      ]);
      const after = await messageRow(db, first);
      // The message keeps its id, under the same label.
      expect(after).toEqual({ ...before, compartments: HEALTH });
      // A later revision that matches money too gains it, and keeps health.
      const third = { ...first, subject: "Your bank statement", restricted: ["money"] as RestrictedCategory[] };
      const raw = { ...mailRevision(first, accounts.personalMail), revisionTag: `f:${first.id}:third` };
      expect(await writer.ingestItem(accounts.personalMail, raw, mailFacts(third))).toBe("stored");
      expect((await evidenceRows(db, first)).at(-1)?.compartments).toEqual([
        "own",
        "restricted:health",
        "restricted:money",
      ]);
      expect((await messageRow(db, first))?.compartments).toEqual(["own", "restricted:health", "restricted:money"]);
    }));

  it("a message stored under own that a later revision restricts gets a new message row, and the old one is gone", () =>
    withRestricted(async ({ db, writer }) => {
      const accounts = await connect(writer);
      const first = received("gm-o5-later", { restricted: [] });
      expect(await ingestMail(writer, accounts.personalMail, first)).toBe("stored");
      const before = await messageRow(db, first);
      expect(before?.compartments).toEqual(["own"]);
      expect(
        await writer.ingestItem(
          accounts.personalMail,
          mailRevision(first, accounts.personalMail),
          mailFacts({ ...first, restricted: ["health"] }),
        ),
      ).toBe("stored");
      const after = await messageRow(db, first);
      expect(after?.compartments).toEqual(HEALTH);
      expect(after?.id).not.toBe(before?.id);
      expect(await queryAs(db.urls.admin, "select 1 from knowledge.messages where id = $1", [before?.id])).toEqual([]);
    }));

  it("a lifted category is not added by the screen, and an unlifted one is", () =>
    withRestricted(async ({ db, writer }) => {
      const accounts = await connect(writer);
      const lifted = received("gm-o5-lifted", { restricted: ["health", "money"] });
      // The owner's decision and its lift row, written as pi_admin.
      const ruling = testId("rul");
      await queryAs(
        db.urls.admin,
        "insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, decided_at, details, compartments) values ($1, $2, 'restriction_lift', 0, now(), '{\"category\": \"health\"}'::jsonb, '{own}')",
        [ruling, `lift-${ruling.slice(4, 20)}`],
      );
      await queryAs(
        db.urls.admin,
        "insert into vault.restriction_lifts (account_id, source_item_fp, category, ruling_id, compartments) values ($1, $2, 'health', $3, '{own}')",
        [accounts.personalMail.id, fingerprint(db.keys, "source_id", mailSourceId(lifted)), ruling],
      );
      expect(await ingestMail(writer, accounts.personalMail, lifted)).toBe("stored");
      expect((await evidenceRows(db, lifted)).map((row) => row.compartments)).toEqual([["own", "restricted:money"]]);
    }));

  it("a held message that matches a term is held and restricted", () =>
    withRestricted(async ({ db, writer }) => {
      const accounts = await connect(writer);
      const held = received("gm-o5-held", {
        subject: "Your verification code for the patient portal",
        held: true,
        restricted: ["health"],
      });
      expect(await ingestMail(writer, accounts.personalMail, held)).toBe("stored");
      expect(await messageRow(db, held)).toMatchObject({ held: true, compartments: HEALTH });
      // The control: held and not restricted.
      const plain = received("gm-o5-held-plain", { subject: "Your verification code", held: true, restricted: [] });
      expect(await ingestMail(writer, accounts.personalMail, plain)).toBe("stored");
      expect(await messageRow(db, plain)).toMatchObject({ held: true, compartments: ["own"] });
    }));

  it("an address seen in an own message and a restricted one is one entity, with one accounts row under each label", () =>
    withRestricted(async ({ db, writer }) => {
      const accounts = await connect(writer);
      expect(
        await ingestMail(
          writer,
          accounts.personalMail,
          received("gm-o5-both-own", { subject: "Lunch", text: "Lunch?", restricted: [] }),
        ),
      ).toBe("stored");
      expect(
        await ingestMail(writer, accounts.personalMail, received("gm-o5-both-health", { restricted: ["health"] })),
      ).toBe("stored");
      // And once more under each label: nothing new.
      expect(
        await ingestMail(writer, accounts.personalMail, received("gm-o5-both-health-2", { restricted: ["health"] })),
      ).toBe("stored");
      const rows = await queryAs<{ entity_id: string; compartments: string[] }>(
        db.urls.admin,
        "select entity_id, compartments from knowledge.accounts where value_fp = $1 order by compartments",
        [fingerprint(db.keys, "address", CLINIC.address)],
      );
      expect(rows.map((row) => row.compartments)).toEqual([["own"], HEALTH]);
      expect(new Set(rows.map((row) => row.entity_id)).size).toBe(1);
      // The same for its organization's domain.
      const domains = await queryAs<{ entity_id: string; compartments: string[] }>(
        db.urls.admin,
        "select entity_id, compartments from knowledge.domains where domain_fp = $1 order by compartments",
        [fingerprint(db.keys, "domain", "clinic-example.test")],
      );
      expect(domains.map((row) => row.compartments)).toEqual([["own"], HEALTH]);
      expect(new Set(domains.map((row) => row.entity_id)).size).toBe(1);
    }));

  it("an address seen first in a restricted message is no own row until an own message shows it", () =>
    withRestricted(async ({ db, writer }) => {
      const accounts = await connect(writer);
      expect(
        await ingestMail(writer, accounts.personalMail, received("gm-o5-first-health", { restricted: ["health"] })),
      ).toBe("stored");
      const labels = async () =>
        (
          await queryAs<{ compartments: string[] }>(
            db.urls.admin,
            "select compartments from knowledge.accounts where value_fp = $1 order by compartments",
            [fingerprint(db.keys, "address", CLINIC.address)],
          )
        ).map((row) => row.compartments);
      expect(await labels()).toEqual([HEALTH]);
      expect(
        await ingestMail(
          writer,
          accounts.personalMail,
          received("gm-o5-first-own", { subject: "Lunch", text: "Lunch?", restricted: [] }),
        ),
      ).toBe("stored");
      expect(await labels()).toEqual([["own"], HEALTH]);
    }));

  it("a re-derive keeps every item's label", () =>
    withRestricted(async ({ db, writer }) => {
      const accounts = await connect(writer);
      const health = received("gm-o5-rederive", { restricted: ["health"] });
      const plain = received("gm-o5-rederive-plain", {
        from: QUENTIN,
        cc: [],
        subject: "Lunch",
        text: "Lunch?",
        restricted: [],
      });
      await ingestMail(writer, accounts.personalMail, health);
      await ingestMail(writer, accounts.personalMail, plain);
      const before = { health: await messageRow(db, health), plain: await messageRow(db, plain) };
      // A re-derive is needed: an owner address is held by a person too.
      await addOwnerAddressUnderived(db, QUENTIN.address, "own");
      expect(await writer.rederiveIfNeeded(derive)).toMatchObject({ rederived: true });
      expect(await messageRow(db, health)).toEqual(before.health);
      expect(await messageRow(db, plain)).toEqual(before.plain);
      const nurse = await queryAs<{ compartments: string[] }>(
        db.urls.admin,
        "select compartments from knowledge.accounts where value_fp = $1",
        [fingerprint(db.keys, "address", NURSE.address)],
      );
      expect(nurse.map((row) => row.compartments)).toEqual([HEALTH]);
    }));

  it("the writer refuses facts whose restricted list is not a list of categories, or names one with no key", () =>
    withRestricted(async ({ db, writer }) => {
      const accounts = await connect(writer);
      const fixture = received("gm-o5-bad");
      const facts = mailFacts({ ...fixture, restricted: ["health"] });
      const bad = async (ctx: Parameters<typeof facts>[0]) => {
        const made = await facts(ctx);
        return {
          ...made,
          message: { ...(made as { message: object }).message, restricted: ["own"] },
        } as unknown as Awaited<ReturnType<typeof facts>>;
      };
      await expect(
        writer.ingestItem(accounts.personalMail, mailItem(fixture, accounts.personalMail), bad),
      ).rejects.toMatchObject({ code: "invalid_facts" });
      // A category whose key the file lacks (legal) is refused before anything is sealed.
      await expect(
        writer.ingestItem(
          accounts.personalMail,
          mailItem(fixture, accounts.personalMail),
          mailFacts({ ...fixture, restricted: ["legal"] }),
        ),
      ).rejects.toMatchObject({ code: "invalid_facts" });
      expect(await evidenceRows(db, fixture)).toEqual([]);
    }));
});

describe("the on categories", { timeout: TIMEOUT }, () => {
  it("the writer refuses with restricted_keys_mismatch when the table and the restricted file differ, and answers the on list when they agree", () =>
    withRestricted(async ({ db, writer }) => {
      // The file holds health and money; the table names none.
      await expect(writer.restrictedOn()).rejects.toMatchObject({ code: "restricted_keys_mismatch" });
      await queryAs(db.urls.admin, "insert into policy.restricted_categories (category) values ('health')");
      await expect(writer.restrictedOn()).rejects.toMatchObject({ code: "restricted_keys_mismatch" });
      await queryAs(db.urls.admin, "insert into policy.restricted_categories (category) values ('money')");
      expect(await writer.restrictedOn()).toEqual(["health", "money"]);
      // The table names a category the file lacks.
      await queryAs(db.urls.admin, "insert into policy.restricted_categories (category) values ('legal')");
      await expect(writer.restrictedOn()).rejects.toMatchObject({ code: "restricted_keys_mismatch" });
    }));

  it("with no restricted file and no row, no category is on", () =>
    withStore(async ({ writer }) => {
      expect(await writer.restrictedOn()).toEqual([]);
    }));
});
