import { ConnectorCursor, type RawItem, type Timestamp } from "@intelligence/contracts";
import { PERSONAL_LIMITS } from "@intelligence/personal-core";
import {
  contactDeletion,
  contactItem,
  deriveItem,
  type ItemContext,
  type ItemFacts,
  whitelistedContact,
} from "@intelligence/personal-core/items";
import { describe, expect, it } from "vitest";
import { connect, OWNER } from "../test-support/cast.ts";
import { testId } from "../test-support/clients.ts";
import { addOwnerAddressUnderived, one } from "../test-support/connections.ts";
import { fingerprint, queryAs, scanForPlaintext, type TestDatabase } from "../test-support/database.ts";
import { type Store, withStore } from "../test-support/store.ts";
import type { Writer } from "./writer.ts";
import type { SourceAccountRow } from "./writer-types.ts";

// A contact's rows, what cites a person, what a deletion, a skip and a listing remove, the
// suppression check and the re-derive. Contacts are built by core's own whitelist and item builder.
// Made-up values on reserved domains only.

const TIMEOUT = 180_000;
const NOW = "2026-09-15T12:00:00Z" as Timestamp;
const AT = "2026-09-01T00:00:00Z";
const own = { metadata: { source: { type: "CONTACT", id: "c" } } };

type Person = {
  names?: string[];
  nicknames?: string[];
  emails: string[];
  phone?: string;
  organization?: string;
  title?: string;
  birthday?: { month: number; day: number };
};
// A People answer's person, as the connector hands it to the whitelist.
const answer = (resource: string, person: Person, updateTime = "2026-09-01T09:00:00Z") => ({
  resourceName: `people/${resource}`,
  metadata: { sources: [{ type: "CONTACT", id: resource, updateTime }] },
  names: (person.names ?? []).map((displayName) => ({ ...own, displayName })),
  nicknames: (person.nicknames ?? []).map((value) => ({ ...own, value })),
  emailAddresses: person.emails.map((value) => ({ ...own, value })),
  phoneNumbers: person.phone === undefined ? [] : [{ ...own, value: person.phone }],
  organizations:
    person.organization === undefined && person.title === undefined
      ? []
      : [{ ...own, name: person.organization, title: person.title }],
  birthdays: person.birthday === undefined ? [] : [{ ...own, date: person.birthday }],
});
function contactRaw(account: SourceAccountRow, resource: string, person: Person, updateTime?: string): RawItem {
  const read = whitelistedContact(answer(resource, person, updateTime));
  if (read === null) throw new Error("refused");
  return contactItem(read, { sourceAccount: account.id, changeKind: "backfill", now: NOW });
}
const derive =
  (raw: RawItem) =>
  (ctx: ItemContext): Promise<ItemFacts> =>
    deriveItem(raw, ctx, PERSONAL_LIMITS);
const ingest = (writer: Writer, account: SourceAccountRow, raw: RawItem) =>
  writer.ingestItem(account, raw, derive(raw));
const cursor = (value: string) => ConnectorCursor.parse(value);

const admin = <Row = Record<string, unknown>>(db: TestDatabase, text: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(db.urls.admin, text, values);
const count = async (db: TestDatabase, table: string, where = "true", values: unknown[] = []): Promise<number> =>
  one(await admin<{ n: number }>(db, `select count(*)::int as n from ${table} where ${where}`, values)).n;
const fp = (db: TestDatabase, address: string) => fingerprint(db.keys, "address", address);
const entityOf = async (db: TestDatabase, address: string): Promise<string | undefined> =>
  (
    await admin<{ entity_id: string }>(db, "select entity_id from knowledge.accounts where value_fp = $1", [
      fp(db, address),
    ])
  )[0]?.entity_id;
const contactsOf = (db: TestDatabase, account: SourceAccountRow) =>
  count(db, "knowledge.contacts", "account_id = $1", [account.id]);

async function contactsAccounts(store: Store) {
  const accounts = await connect(store.writer);
  return {
    ...accounts,
    personalContacts: await store.writer.ensureSourceAccount("personal", "google_contacts", "own", OWNER.personal),
    workContacts: await store.writer.ensureSourceAccount("work", "google_contacts", "employer:example", OWNER.work),
  };
}

// A suppression, as an erasure of a person leaves it.
async function suppress(db: TestDatabase, address: string): Promise<void> {
  const ruling = testId("rul");
  await admin(
    db,
    `insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, labels, details, decided_at, compartments) values ($1, $2, 'erase', 0, '{}', '{}', $3, '{own}')`,
    [ruling, testId("req"), AT],
  );
  const erasure = testId("ers");
  await admin(
    db,
    `insert into knowledge.erasures (id, ruling_id, kind, journal_seq, erased_at, items, suppressed, tainted_rows, compartments) values ($1, $2, 'person', 1, $3, 0, 1, 0, '{own}')`,
    [erasure, ruling, AT],
  );
  await admin(
    db,
    `insert into knowledge.suppressions (id, erasure_id, kind, value_fp, added_at, compartments) values ($1, $2, 'address', $3, $4, '{own}')`,
    [testId("sup"), erasure, fp(db, address), AT],
  );
}

const MAREN: Person = {
  names: ["Maren Holt"],
  nicknames: ["Mare"],
  emails: ["maren@contacts-writer.test"],
  phone: "555-0101",
  organization: "Holt Works Example",
  title: "Engineer",
  birthday: { month: 3, day: 4 },
};
const SAM: Person = { names: ["Sam Orrin"], emails: ["sam@contacts-writer.test", "sam.orrin@contacts-writer.example"] };

describe("the writer and a contact", { timeout: TIMEOUT }, () => {
  it("every row of a contact carries its account's compartment", () =>
    withStore(async (store) => {
      const { workContacts } = await contactsAccounts(store);
      expect(await ingest(store.writer, workContacts, contactRaw(workContacts, "w1", MAREN))).toBe("stored");
      for (const table of [
        "knowledge.contacts",
        "knowledge.contact_addresses",
        "knowledge.aliases",
        "vault.evidence_items",
      ]) {
        const rows = await admin<{ compartments: string[] }>(
          store.db,
          `select distinct compartments from ${table} where compartments <> '{own}'`,
        );
        expect(
          rows.map((row) => row.compartments),
          table,
        ).toEqual([["employer:example"]]);
      }
      const accounts = await admin<{ compartments: string[] }>(
        store.db,
        "select compartments from knowledge.accounts where value_fp = $1",
        [fp(store.db, "maren@contacts-writer.test")],
      );
      expect(accounts.map((row) => row.compartments)).toEqual([["employer:example"]]);
    }));

  it("a one-address contact's names are aliases and a two-address contact's are none", () =>
    withStore(async (store) => {
      const { personalContacts } = await contactsAccounts(store);
      await ingest(store.writer, personalContacts, contactRaw(personalContacts, "c1", MAREN));
      await ingest(store.writer, personalContacts, contactRaw(personalContacts, "c2", SAM));
      const maren = await entityOf(store.db, "maren@contacts-writer.test");
      expect(await count(store.db, "knowledge.aliases", "entity_id = $1", [maren])).toBe(2);
      for (const address of SAM.emails)
        expect(
          await count(store.db, "knowledge.aliases", "entity_id = $1", [await entityOf(store.db, address)]),
          address,
        ).toBe(0);
    }));

  it("a contact's rows commit with its evidence row or not at all", () =>
    withStore(async (store) => {
      const { personalContacts } = await contactsAccounts(store);
      const raw = contactRaw(personalContacts, "c1", MAREN);
      const failing = async (ctx: ItemContext): Promise<ItemFacts> => {
        await deriveItem(raw, ctx, PERSONAL_LIMITS);
        throw new Error("derive failed after the port answered");
      };
      await expect(store.writer.ingestItem(personalContacts, raw, failing)).rejects.toThrow();
      for (const table of [
        "knowledge.contacts",
        "knowledge.contact_addresses",
        "vault.evidence_items",
        "knowledge.accounts",
        "knowledge.aliases",
      ]) {
        expect(
          await count(
            store.db,
            table,
            table === "knowledge.accounts" ? "value_fp = $1" : "true",
            table === "knowledge.accounts" ? [fp(store.db, "maren@contacts-writer.test")] : [],
          ),
          table,
        ).toBe(0);
      }
      // The positive control.
      expect(await ingest(store.writer, personalContacts, raw)).toBe("stored");
      expect(await count(store.db, "knowledge.contacts")).toBe(1);
    }));

  it("contact facts on a mail item are refused and nothing is written", () =>
    withStore(async (store) => {
      const { personalMail, personalContacts } = await contactsAccounts(store);
      const raw = contactRaw(personalContacts, "c1", MAREN);
      const asMail = {
        ...raw,
        sourceKind: "email" as const,
        sourceAccount: personalMail.id,
        mediaType: "message/rfc822",
      };
      await expect(store.writer.ingestItem(personalMail, asMail, derive(raw))).rejects.toMatchObject({
        code: "invalid_facts",
      });
      expect(await count(store.db, "knowledge.contacts")).toBe(0);
      expect(await count(store.db, "vault.evidence_items")).toBe(0);
    }));

  it("a canary contact's name, phone number, organization and title are in no column, and a phone number is in no fingerprint column", () =>
    withStore(async (store) => {
      const { personalContacts } = await contactsAccounts(store);
      const canary = {
        name: "Canaryname Contactwriter",
        nickname: "Canarynick",
        phone: "555-0177",
        organization: "Canary Organization Example",
        title: "Canary Title Example",
      };
      await ingest(
        store.writer,
        personalContacts,
        contactRaw(personalContacts, "c1", {
          names: [canary.name],
          nicknames: [canary.nickname],
          emails: ["canary@contacts-writer.test"],
          phone: canary.phone,
          organization: canary.organization,
          title: canary.title,
        }),
      );
      expect(await scanForPlaintext(store.db.urls.admin, Object.values(canary))).toEqual([]);
      const kinds = ["address", "name", "domain", "source_id", "revision_tag", "thread"] as const;
      expect(
        await scanForPlaintext(
          store.db.urls.admin,
          kinds.map((kind) => fingerprint(store.db.keys, kind, canary.phone)),
        ),
      ).toEqual([]);
    }));

  it("two addresses on one contact are two people", () =>
    withStore(async (store) => {
      const { personalContacts } = await contactsAccounts(store);
      await ingest(store.writer, personalContacts, contactRaw(personalContacts, "c2", SAM));
      const [a, b] = [await entityOf(store.db, SAM.emails[0] ?? ""), await entityOf(store.db, SAM.emails[1] ?? "")];
      expect(a).toBeDefined();
      expect(b).toBeDefined();
      expect(a).not.toBe(b);
      expect(await count(store.db, "knowledge.contact_addresses")).toBe(2);
    }));

  it("a 25-address contact's row holds 25 address fingerprints and 20 contact address rows; a two-address contact's row holds the name fingerprints of its names and nicknames, and it has no alias", () =>
    withStore(async (store) => {
      const { personalContacts } = await contactsAccounts(store);
      const emails = Array.from({ length: 25 }, (_, i) => `p${i}@contacts-writer.test`);
      await ingest(
        store.writer,
        personalContacts,
        contactRaw(personalContacts, "big", { names: ["Many Addresses"], emails }),
      );
      const big = one(
        await admin<{ address_fps: string[]; id: string }>(store.db, "select id, address_fps from knowledge.contacts"),
      );
      expect([...big.address_fps].sort()).toEqual(emails.map((one) => fp(store.db, one)).sort());
      expect(await count(store.db, "knowledge.contact_addresses", "contact_id = $1", [big.id])).toBe(20);

      await ingest(
        store.writer,
        personalContacts,
        contactRaw(personalContacts, "sam", { names: ["Sam Orrin"], nicknames: ["Sammy"], emails: SAM.emails }),
      );
      const sam = one(
        await admin<{ name_fps: string[] }>(
          store.db,
          "select name_fps from knowledge.contacts where cardinality(address_fps) = 2",
        ),
      );
      expect([...sam.name_fps].sort()).toEqual(
        ["Sam Orrin", "Sammy"].map((name) => fingerprint(store.db.keys, "name", name)).sort(),
      );
      expect(await count(store.db, "knowledge.aliases")).toBe(0);
    }));
});

describe("what cites a person, and what goes", { timeout: TIMEOUT }, () => {
  it("a person seen only on a contact is removed with it and kept while it is stored", () =>
    withStore(async (store) => {
      const { personalContacts } = await contactsAccounts(store);
      await ingest(store.writer, personalContacts, contactRaw(personalContacts, "c1", MAREN));
      const maren = await entityOf(store.db, "maren@contacts-writer.test");
      expect(await count(store.db, "knowledge.entities", "id = $1", [maren])).toBe(1);
      await store.writer.applyDeletion(
        personalContacts,
        contactDeletion("people/c1", { sourceAccount: personalContacts.id, now: NOW }),
      );
      expect(await count(store.db, "knowledge.entities", "id = $1", [maren])).toBe(0);
      for (const table of [
        "knowledge.contacts",
        "knowledge.contact_addresses",
        "knowledge.aliases",
        "vault.evidence_items",
        "vault.listed_items",
      ])
        expect(await count(store.db, table), table).toBe(0);
    }));

  it("a new revision replaces the contact's rows and removes who only the earlier one named", () =>
    withStore(async (store) => {
      const { personalContacts } = await contactsAccounts(store);
      await ingest(store.writer, personalContacts, contactRaw(personalContacts, "c1", MAREN));
      const [before] = await admin<{ id: string }>(store.db, "select id from knowledge.contacts");
      const moved = { ...MAREN, emails: ["maren.new@contacts-writer.test"] };
      expect(
        await ingest(store.writer, personalContacts, contactRaw(personalContacts, "c1", moved, "2026-09-02T09:00:00Z")),
      ).toBe("stored");
      expect(await entityOf(store.db, "maren@contacts-writer.test")).toBeUndefined();
      expect(await entityOf(store.db, "maren.new@contacts-writer.test")).toBeDefined();
      const after = await admin<{ id: string }>(store.db, "select id from knowledge.contacts");
      expect(after).toEqual([before]);
      expect(await count(store.db, "knowledge.contact_addresses")).toBe(1);
    }));

  it("a complete listing with one skipped id that was never stored removes every unnamed contact and leaves the skipped id", () =>
    withStore(async (store) => {
      const { personalContacts } = await contactsAccounts(store);
      for (const resource of ["c1", "c2", "c3"])
        await ingest(
          store.writer,
          personalContacts,
          contactRaw(personalContacts, resource, {
            names: [`Name ${resource}`],
            emails: [`${resource}@contacts-writer.test`],
          }),
        );
      const { removed, reconciled } = await store.writer.finishPage(personalContacts, {
        listing: { first: true, ended: "complete" },
        listedIds: ["contact:people/c1"],
        skippedIds: ["contact:people/never-stored"],
        next: cursor("contacts-cursor-1"),
      });
      expect({ removed, reconciled }).toEqual({ removed: 2, reconciled: true });
      expect(await contactsOf(store.db, personalContacts)).toBe(1);
    }));

  it("a stored contact whose next revision is skipped has no row after that page, outside a listing and inside one, and is stored again when a revision that reads arrives", () =>
    withStore(async (store) => {
      const { personalContacts } = await contactsAccounts(store);
      const raw = contactRaw(personalContacts, "c1", MAREN);
      await ingest(store.writer, personalContacts, raw);
      const outside = await store.writer.finishPage(personalContacts, {
        listedIds: [],
        skippedIds: ["contact:people/c1"],
        next: cursor("contacts-cursor-2"),
      });
      expect(outside.removed).toBe(1);
      expect(outside.unreadable).toBe(1);
      expect(await contactsOf(store.db, personalContacts)).toBe(0);
      expect(await count(store.db, "knowledge.suppressions")).toBe(0);
      expect(await count(store.db, "knowledge.removed_evidence")).toBe(0);
      expect(await ingest(store.writer, personalContacts, raw)).toBe("stored");
      const inside = await store.writer.finishPage(personalContacts, {
        listing: { first: true },
        listedIds: [],
        skippedIds: ["contact:people/c1"],
        next: cursor("contacts-cursor-3"),
      });
      expect(inside.removed).toBe(1);
      expect(await contactsOf(store.db, personalContacts)).toBe(0);
      expect(await ingest(store.writer, personalContacts, raw)).toBe("stored");
      expect(await contactsOf(store.db, personalContacts)).toBe(1);
    }));

  it("a skipped mail id is still left as it is", () =>
    withStore(async (store) => {
      const { personalMail } = await contactsAccounts(store);
      const result = await store.writer.finishPage(personalMail, {
        listedIds: [],
        skippedIds: ["anything"],
        next: cursor("mail-cursor"),
      });
      expect(result).toEqual({ removed: 0, reconciled: false, recordsRemoved: 0 });
    }));

  it("a person on a contact and in another contact stays when either goes, and goes with the second", () =>
    withStore(async (store) => {
      const { personalContacts } = await contactsAccounts(store);
      await ingest(store.writer, personalContacts, contactRaw(personalContacts, "c1", MAREN));
      await ingest(
        store.writer,
        personalContacts,
        contactRaw(personalContacts, "c2", { names: ["Maren H"], emails: MAREN.emails }),
      );
      const maren = await entityOf(store.db, "maren@contacts-writer.test");
      await store.writer.applyDeletion(
        personalContacts,
        contactDeletion("people/c1", { sourceAccount: personalContacts.id, now: NOW }),
      );
      expect(await entityOf(store.db, "maren@contacts-writer.test")).toBe(maren);
      await store.writer.applyDeletion(
        personalContacts,
        contactDeletion("people/c2", { sourceAccount: personalContacts.id, now: NOW }),
      );
      expect(await entityOf(store.db, "maren@contacts-writer.test")).toBeUndefined();
    }));
});

describe("suppression", { timeout: TIMEOUT }, () => {
  it("a contact that lists a suppressed address is not stored, whatever else it lists; the positive control is stored", () =>
    withStore(async (store) => {
      const { personalContacts } = await contactsAccounts(store);
      const raw = contactRaw(personalContacts, "c2", SAM);
      await suppress(store.db, SAM.emails[1] ?? "");
      expect(await ingest(store.writer, personalContacts, raw)).toBe("suppressed");
      expect(await count(store.db, "vault.evidence_items")).toBe(0);
      expect(await entityOf(store.db, SAM.emails[0] ?? "")).toBeUndefined();
      expect(await ingest(store.writer, personalContacts, contactRaw(personalContacts, "c1", MAREN))).toBe("stored");
    }));

  it("a 25-address contact whose 22nd address is suppressed is not stored", () =>
    withStore(async (store) => {
      const { personalContacts } = await contactsAccounts(store);
      const emails = Array.from({ length: 25 }, (_, i) => `p${i}@contacts-writer.test`);
      await suppress(store.db, emails[21] ?? "");
      expect(await ingest(store.writer, personalContacts, contactRaw(personalContacts, "big", { emails }))).toBe(
        "suppressed",
      );
      expect(
        await ingest(
          store.writer,
          personalContacts,
          contactRaw(personalContacts, "small", { emails: emails.slice(0, 21) }),
        ),
      ).toBe("stored");
    }));

  it("a stored contact whose next revision lists a suppressed address has no row after it, no new suppression and no removed-evidence row, and is stored again when a later revision lists none", () =>
    withStore(async (store) => {
      const { personalContacts } = await contactsAccounts(store);
      await ingest(store.writer, personalContacts, contactRaw(personalContacts, "c1", MAREN));
      await suppress(store.db, "erased@contacts-writer.test");
      const listed = { ...MAREN, emails: [...MAREN.emails, "erased@contacts-writer.test"] };
      expect(
        await ingest(
          store.writer,
          personalContacts,
          contactRaw(personalContacts, "c1", listed, "2026-09-03T09:00:00Z"),
        ),
      ).toBe("suppressed");
      expect(await contactsOf(store.db, personalContacts)).toBe(0);
      expect(await count(store.db, "vault.evidence_items")).toBe(0);
      expect(await count(store.db, "knowledge.suppressions")).toBe(1);
      expect(await count(store.db, "knowledge.removed_evidence")).toBe(0);
      expect(
        await ingest(store.writer, personalContacts, contactRaw(personalContacts, "c1", MAREN, "2026-09-04T09:00:00Z")),
      ).toBe("stored");
      expect(await contactsOf(store.db, personalContacts)).toBe(1);
    }));

  it("a contact whose value is an erased address with a leading space is suppressed", () =>
    withStore(async (store) => {
      const { personalContacts } = await contactsAccounts(store);
      await suppress(store.db, "erased@contacts-writer.test");
      expect(
        await ingest(
          store.writer,
          personalContacts,
          contactRaw(personalContacts, "c1", { names: ["Erased"], emails: [" erased@contacts-writer.test"] }),
        ),
      ).toBe("suppressed");
      expect(
        await ingest(
          store.writer,
          personalContacts,
          contactRaw(personalContacts, "c2", { names: ["Kept"], emails: [" kept@contacts-writer.test"] }),
        ),
      ).toBe("stored");
    }));

  it("a refused value whose normalizeAddress form is suppressed suppresses the contact, and nothing of it is stored; no refused: marker is in any stored row", () =>
    withStore(async (store) => {
      const { personalContacts } = await contactsAccounts(store);
      await suppress(store.db, "jürgen@contacts-writer.test");
      const refused = {
        names: ["Jürgen"],
        emails: ["kept@contacts-writer.test", "Jürgen <Jürgen@contacts-writer.test>"],
      };
      expect(await ingest(store.writer, personalContacts, contactRaw(personalContacts, "c1", refused))).toBe(
        "suppressed",
      );
      expect(await count(store.db, "vault.evidence_items")).toBe(0);
      // The positive control: another refused form is stored without its marker.
      const other = { names: ["Ölga"], emails: ["olga@contacts-writer.test", "Ölga <ölga@contacts-writer.test>"] };
      const raw = contactRaw(personalContacts, "c2", other);
      expect(raw.markers).toContain("refused:ölga@contacts-writer.test");
      expect(await ingest(store.writer, personalContacts, raw)).toBe("stored");
      expect(await scanForPlaintext(store.db.urls.admin, ["refused:", "ölga@contacts-writer.test"])).toEqual([]);
    }));

  it("an erased contact is not stored again, changed or not", () =>
    withStore(async (store) => {
      const { personalContacts } = await contactsAccounts(store);
      const ruling = testId("rul");
      await admin(
        store.db,
        `insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, labels, details, decided_at, compartments) values ($1, $2, 'erase', 0, '{}', '{}', $3, '{own}')`,
        [ruling, testId("req"), AT],
      );
      const erasure = testId("ers");
      await admin(
        store.db,
        `insert into knowledge.erasures (id, ruling_id, kind, journal_seq, erased_at, items, suppressed, tainted_rows, compartments) values ($1, $2, 'item', 1, $3, 1, 0, 0, '{own}')`,
        [erasure, ruling, AT],
      );
      await admin(
        store.db,
        `insert into knowledge.removed_evidence (id, erasure_id, source_account_id, source_item_fp, evidence_ids, reason, removed_at, compartments) values ($1, $2, $3, $4, '{}', 'owner_erasure', $5, '{own}')`,
        [testId("rme"), erasure, personalContacts.id, fingerprint(store.db.keys, "source_id", "contact:people/c1"), AT],
      );
      expect(await ingest(store.writer, personalContacts, contactRaw(personalContacts, "c1", MAREN))).toBe("removed");
      expect(
        await ingest(
          store.writer,
          personalContacts,
          contactRaw(personalContacts, "c1", { ...MAREN, names: ["Changed"] }),
        ),
      ).toBe("removed");
      expect(await ingest(store.writer, personalContacts, contactRaw(personalContacts, "c2", MAREN))).toBe("stored");
    }));
});

describe("the re-derive", { timeout: TIMEOUT }, () => {
  it("no contact makes a re-derive needed; a re-derive leaves every ruling, gives each person the id it had and gives a contact's rows again", () =>
    withStore(async (store) => {
      const { personalContacts } = await contactsAccounts(store);
      await ingest(store.writer, personalContacts, contactRaw(personalContacts, "c1", MAREN));
      await ingest(store.writer, personalContacts, contactRaw(personalContacts, "c2", SAM));
      await ingest(
        store.writer,
        personalContacts,
        contactRaw(personalContacts, "c3", { names: ["Becomes Owner"], emails: ["later.owner@contacts-writer.test"] }),
      );
      const rederive = () => store.writer.rederiveIfNeeded((raw, ctx) => deriveItem(raw, ctx, PERSONAL_LIMITS));
      expect((await rederive()).rederived).toBe(false);

      const ruling = testId("rul");
      await admin(
        store.db,
        `insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, labels, details, decided_at, compartments) values ($1, $2, 'identity', 0, '{}', '{}', $3, '{own}')`,
        [ruling, testId("req"), AT],
      );
      const [low, high] = SAM.emails.map((one) => fp(store.db, one)).sort();
      await admin(
        store.db,
        "insert into knowledge.identity_rulings (ruling_id, verdict, a_fp, b_fp, created_at) values ($1, 'same', $2, $3, $4)",
        [ruling, low, high, AT],
      );
      const people = async () => Promise.all([...MAREN.emails, ...SAM.emails].map((one) => entityOf(store.db, one)));
      const rows = async () => ({
        contacts: (
          await admin<{ line: string }>(
            store.db,
            "select account_id || ' ' || source_contact_fp || ' ' || updated_at::text || ' ' || array_to_string(address_fps, ',') || ' ' || array_to_string(name_fps, ',') as line from knowledge.contacts where cardinality(address_fps) <> 1 or address_fps[1] <> $1 order by 1",
            [fp(store.db, "later.owner@contacts-writer.test")],
          )
        ).map((row) => row.line),
        addresses: (
          await admin<{ line: string }>(
            store.db,
            "select value_fp || ' ' || entity_id as line from knowledge.contact_addresses where value_fp <> $1 order by 1",
            [fp(store.db, "later.owner@contacts-writer.test")],
          )
        ).map((row) => row.line),
        rulings: await admin(store.db, "select * from knowledge.identity_rulings"),
      });
      const before = { people: await people(), rows: await rows() };

      // An address of a stored contact becomes the owner's, which is what makes a re-derive.
      await addOwnerAddressUnderived(store.db, "later.owner@contacts-writer.test", "own");
      expect((await rederive()).rederived).toBe(true);
      expect({ people: await people(), rows: await rows() }).toEqual(before);
      // The contact that now lists an owner address derives nothing.
      expect(await count(store.db, "knowledge.contacts")).toBe(2);
    }));
});

// A contact saved with a phone and no address is a person keyed by the phone, and every contact's
// E.164 phones are fingerprinted, so a source moment's handle finds it.
describe("phone keys and phone fingerprints", { timeout: TIMEOUT }, () => {
  const LENA: Person = { names: ["Lena Park"], nicknames: ["Len"], emails: [], phone: "+1 (555) 555-0101" };
  const telFp = (db: TestDatabase, phone: string) => fp(db, `tel:${phone}`);
  const phoneFp = (db: TestDatabase, phone: string) => fingerprint(db.keys, "phone", phone);

  it("a phone-only contact is stored and makes a person keyed tel:, named by its names; deleted, the person goes", () =>
    withStore(async (store) => {
      const { personalContacts } = await contactsAccounts(store);
      expect(await ingest(store.writer, personalContacts, contactRaw(personalContacts, "p1", LENA))).toBe("stored");
      const lena = await entityOf(store.db, "tel:+15555550101");
      expect(lena).toBeDefined();
      expect(await admin(store.db, "select kind from knowledge.accounts where entity_id = $1", [lena])).toEqual([
        { kind: "email" },
      ]);
      expect(await count(store.db, "knowledge.aliases", "entity_id = $1", [lena])).toBe(2);
      expect(await admin(store.db, "select address_fps, phone_fps from knowledge.contacts")).toEqual([
        { address_fps: [telFp(store.db, "+15555550101")], phone_fps: [phoneFp(store.db, "+15555550101")] },
      ]);
      // Its key names no organization: no domain row.
      expect(await count(store.db, "knowledge.domains")).toBe(0);
      // Removed, the person goes, as a contact's person does.
      await store.writer.applyDeletion(
        personalContacts,
        contactDeletion("people/p1", { sourceAccount: personalContacts.id, now: NOW }),
      );
      expect(await count(store.db, "knowledge.entities", "id = $1", [lena])).toBe(0);
      expect(await count(store.db, "knowledge.contacts")).toBe(0);
    }));

  it("as amended: a contact with an address keeps it as its one identifier, and its row holds the phone fingerprints of its E.164 phones alone", () =>
    withStore(async (store) => {
      const { personalContacts } = await contactsAccounts(store);
      await ingest(
        store.writer,
        personalContacts,
        contactRaw(personalContacts, "a1", {
          names: ["Omar Reyes"],
          emails: ["omar@contacts-writer.test"],
          phone: "+15555550103",
        }),
      );
      await ingest(
        store.writer,
        personalContacts,
        contactRaw(personalContacts, "a2", {
          names: ["Theo Marsh"],
          emails: ["theo@contacts-writer.test"],
          phone: "555-0104",
        }),
      );
      expect(await entityOf(store.db, "tel:+15555550103")).toBeUndefined();
      const rows = await admin<{ phone_fps: string[] }>(
        store.db,
        "select phone_fps from knowledge.contacts order by updated_at, id",
      );
      expect(rows.map((row) => row.phone_fps).sort((a, b) => a.length - b.length)).toEqual([
        [],
        [phoneFp(store.db, "+15555550103")],
      ]);
    }));

  it("a contact stored before phone_fps gains it at the participant step's catch-up, a bounded number a sync, from its sealed phones", () =>
    withStore(async (store) => {
      const { personalContacts } = await contactsAccounts(store);
      await ingest(
        store.writer,
        personalContacts,
        contactRaw(personalContacts, "b1", {
          names: ["Nina Cole"],
          emails: ["nina@contacts-writer.test"],
          phone: "+15555550105",
        }),
      );
      await admin(store.db, "update knowledge.contacts set phone_fps = null");
      const counts = await store.writer.bindParticipants(new Date(NOW));
      expect(counts.phonesFilled).toBe(1);
      expect(await admin(store.db, "select phone_fps from knowledge.contacts")).toEqual([
        { phone_fps: [phoneFp(store.db, "+15555550105")] },
      ]);
      expect((await store.writer.bindParticipants(new Date(NOW))).phonesFilled).toBe(0);
    }));

  // A national number read in the owner's region, at write time.
  it("with the owner's zone in the North American plan, a contact's national number is fingerprinted as +1 and the row marked with the region; a phone-only contact of one is still no person", () =>
    withStore(async (store) => {
      const { personalContacts } = await contactsAccounts(store);
      await ingest(
        store.writer,
        personalContacts,
        contactRaw(personalContacts, "n0", {
          names: ["Ada Brook"],
          emails: ["ada@contacts-writer.test"],
          phone: "(555) 555-0110",
        }),
      );
      await admin(store.db, "update policy.owner_settings set time_zone = 'US/Central'");
      await ingest(
        store.writer,
        personalContacts,
        contactRaw(personalContacts, "n1", {
          names: ["Bo Brook"],
          emails: ["bo@contacts-writer.test"],
          phone: "(555) 555-0111",
        }),
      );
      await ingest(
        store.writer,
        personalContacts,
        contactRaw(personalContacts, "n2", { names: ["Cy Brook"], emails: [], phone: "555.555.0112" }),
      );
      const rows = await admin<{ address_fps: string[]; phone_fps: string[]; phone_region: string | null }>(
        store.db,
        "select address_fps, phone_fps, phone_region from knowledge.contacts order by updated_at, id",
      );
      expect(rows).toEqual(
        expect.arrayContaining([
          { address_fps: [fp(store.db, "ada@contacts-writer.test")], phone_fps: [], phone_region: null },
          {
            address_fps: [fp(store.db, "bo@contacts-writer.test")],
            phone_fps: [phoneFp(store.db, "+15555550111")],
            phone_region: "1",
          },
        ]),
      );
      // The phone-only contact is keyed in E.164 form alone, as the connector reads no zone.
      expect(await entityOf(store.db, "tel:+15555550112")).toBeUndefined();
      // The catch-up fills the row written before the zone again, once.
      expect((await store.writer.bindParticipants(new Date(NOW))).phonesFilled).toBe(1);
      expect(
        await admin(store.db, "select phone_fps, phone_region from knowledge.contacts where address_fps = array[$1]", [
          fp(store.db, "ada@contacts-writer.test"),
        ]),
      ).toEqual([{ phone_fps: [phoneFp(store.db, "+15555550110")], phone_region: "1" }]);
      expect((await store.writer.bindParticipants(new Date(NOW))).phonesFilled).toBe(0);
    }));

  it("a re-derive keeps every phone person's id, and the contact's phone fingerprints", () =>
    withStore(async (store) => {
      const { personalContacts } = await contactsAccounts(store);
      await ingest(store.writer, personalContacts, contactRaw(personalContacts, "p1", LENA));
      await ingest(
        store.writer,
        personalContacts,
        contactRaw(personalContacts, "c3", { names: ["Becomes Owner"], emails: ["later.owner@contacts-writer.test"] }),
      );
      const lena = await entityOf(store.db, "tel:+15555550101");
      const fps = await admin(store.db, "select phone_fps from knowledge.contacts where address_fps = array[$1]", [
        telFp(store.db, "+15555550101"),
      ]);
      await addOwnerAddressUnderived(store.db, "later.owner@contacts-writer.test", "own");
      expect((await store.writer.rederiveIfNeeded((raw, ctx) => deriveItem(raw, ctx, PERSONAL_LIMITS))).rederived).toBe(
        true,
      );
      expect(await entityOf(store.db, "tel:+15555550101")).toBe(lena);
      expect(
        await admin(store.db, "select phone_fps from knowledge.contacts where address_fps = array[$1]", [
          telFp(store.db, "+15555550101"),
        ]),
      ).toEqual(fps);
    }));
});
