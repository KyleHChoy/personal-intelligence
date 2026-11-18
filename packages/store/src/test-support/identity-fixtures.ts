import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RawItem, Timestamp } from "@intelligence/contracts";
import type { EntityId } from "@intelligence/contracts/personal";
import { PERSONAL_LIMITS } from "@intelligence/personal-core";
import { contactItem, deriveItem, whitelistedContact } from "@intelligence/personal-core/items";
import { Admin } from "../admin/admin.ts";
import type { IngestAnswer, SourceAccountRow } from "../write/writer-types.ts";
import { type Accounts, connect, OWNER } from "./cast.ts";
import { testId } from "./clients.ts";
import { one } from "./connections.ts";
import { fingerprint, queryAs, type TestDatabase } from "./database.ts";
import { ingestMail, type MailFixture } from "./items.ts";
import { MAIL } from "./items-named.ts";
import { openStore, type TestStore } from "./store.ts";

// A test world for contacts and identity (n4, n5): the owner's two labels with mail, calendar
// and contacts accounts, an Admin with a journal, and contacts built by core's whitelist.
// Made-up values on reserved domains only.

export const NOW = "2026-09-15T12:00:00Z" as Timestamp;
const own = { metadata: { source: { type: "CONTACT", id: "c" } } };

export type SavedPerson = {
  names?: string[];
  nicknames?: string[];
  emails: string[];
  phone?: string;
  organization?: string;
  title?: string;
  birthday?: { month: number; day: number };
};

export function contactRaw(
  account: SourceAccountRow,
  resource: string,
  person: SavedPerson,
  updateTime = "2026-09-01T09:00:00Z",
): RawItem {
  const read = whitelistedContact({
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
  if (read === null) throw new Error("refused");
  return contactItem(read, { sourceAccount: account.id, changeKind: "backfill", now: NOW });
}

export type IdentityWorld = {
  store: TestStore;
  db: TestDatabase;
  accounts: Accounts & { personalContacts: SourceAccountRow; workContacts: SourceAccountRow };
  admin: Admin;
  journal: string;
  save(account: SourceAccountRow, resource: string, person: SavedPerson): Promise<IngestAnswer>;
  mail(fixture: MailFixture, account?: SourceAccountRow): Promise<IngestAnswer>;
  person(address: string): Promise<EntityId>;
  fp(address: string): string;
  sql<Row = Record<string, unknown>>(text: string, values?: unknown[]): Promise<Row[]>;
  count(table: string, where?: string, values?: unknown[]): Promise<number>;
};

// `compartments`: more keys for the store, such as an agent's for a client that records.
export async function inIdentityWorld(
  fn: (world: IdentityWorld) => Promise<void>,
  compartments: readonly string[] = [],
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-identity-"));
  const store = await openStore({ compartments: ["own", "employer:example", ...compartments] });
  try {
    const journal = join(dir, "keys.json.erasures");
    const base = await connect(store.writer);
    const accounts = {
      ...base,
      personalContacts: await store.writer.ensureSourceAccount("personal", "google_contacts", "own", OWNER.personal),
      workContacts: await store.writer.ensureSourceAccount("work", "google_contacts", "employer:example", OWNER.work),
    };
    const admin = new Admin({ pool: store.adminPool, keys: store.db.keys, log: store.log, journal });
    const sql = <Row = Record<string, unknown>>(text: string, values?: unknown[]) =>
      queryAs<Row>(store.db.urls.admin, text, values);
    const fp = (address: string) => fingerprint(store.db.keys, "address", address);
    await fn({
      store,
      db: store.db,
      accounts,
      admin,
      journal,
      save: (account, resource, person) => {
        const raw = contactRaw(account, resource, person);
        return store.writer.ingestItem(account, raw, (ctx) => deriveItem(raw, ctx, PERSONAL_LIMITS));
      },
      mail: (fixture, account = accounts.personalMail) => ingestMail(store.writer, account, fixture),
      person: async (address) =>
        one(
          await sql<{ entity_id: string }>(
            "select min(entity_id) as entity_id from knowledge.accounts where value_fp = $1",
            [fp(address)],
          ),
        ).entity_id as EntityId,
      fp,
      sql,
      count: async (table, where = "true", values = []) =>
        one(await sql<{ n: number }>(`select count(*)::int as n from ${table} where ${where}`, values)).n,
    });
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

export const req = (): string => testId("req");
export { MAIL };
