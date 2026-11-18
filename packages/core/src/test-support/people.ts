import type {
  ConnectorCursor,
  RawItem,
  SkippedItem,
  SourceAccount,
  SourceAccountId,
  SourceDeletion,
  Timestamp,
} from "@intelligence/contracts";
import { CONTACT_LIMITS, contactDeletion, contactItem, contactItemId, whitelistedContact } from "../items/contacts.ts";
import type { PersonalConnector, PersonalPage } from "../items/types.ts";
import { callPlan, coded, decodeCursor, encodeCursor, type FailureKind, pageLimit } from "./support.ts";

// A label's saved contacts in memory that hand over the pages the People connector would, with
// items from the same core builders. A contact is a People answer's person, as Google sends it.
// Deterministic: its clock is the `now` it is given.

export type FakeContacts = {
  connector(sourceAccount: SourceAccountId): PersonalConnector;
  // A new or changed contact, by its resourceName.
  upsert(person: Record<string, unknown>): void;
  // Deleted at the source: reported on the next sync page.
  remove(resourceName: string): void;
  expireSyncTokens(): void;
  failAt(n: number, kind: FailureKind): void;
  readonly calls: number;
};

type Version = { person: Record<string, unknown>; changed: number; deleted: boolean };
type Token = { seq: number; round: number };
type ListCursor = { fake: "contacts"; phase: "list"; offset: number; from: number };
type SyncCursor = { fake: "contacts"; phase: "sync"; token: Token; after?: number };
type Cursor = ListCursor | SyncCursor;

const nameOf = (person: Record<string, unknown>): string => {
  const name = person.resourceName;
  if (typeof name !== "string" || name === "") throw new Error("a contact with no resourceName");
  return name;
};

export function fakeContacts(
  contacts: Record<string, unknown>[],
  options: { now: Timestamp; pageSize?: number },
): FakeContacts {
  // The People connector's page is Google's: up to 1000, whatever the caller's limit.
  const pageSize = options.pageSize ?? 1000;
  const people = new Map<string, Version[]>(
    contacts.map((person) => [nameOf(person), [{ person: structuredClone(person), changed: 0, deleted: false }]]),
  );
  const latest = (): Version[] => [...people.values()].flatMap((versions) => versions.slice(-1));
  const at = (seq: number): Version[] =>
    [...people.values()].flatMap((versions) => versions.filter((version) => version.changed <= seq).slice(-1));
  let seq = 0;
  let round = 0;
  const plan = callPlan();

  function connector(sourceAccount: SourceAccountId): PersonalConnector {
    function page(
      source: SourceAccount,
      listed: Version[],
      changeKind: "backfill" | "live",
    ): Pick<PersonalPage, "items" | "deletions" | "skipped"> {
      const items: RawItem[] = [];
      const deletions: SourceDeletion[] = [];
      const skipped: SkippedItem[] = [];
      for (const { person, deleted } of listed) {
        const resourceName = nameOf(person);
        if (deleted) {
          deletions.push(contactDeletion(resourceName, { sourceAccount: source.id, now: options.now }));
          continue;
        }
        const read = whitelistedContact(person);
        if (read === null) skipped.push({ sourceItemId: contactItemId(resourceName), reason: "unsupported" });
        else items.push(contactItem(read, { sourceAccount: source.id, changeKind, now: options.now }));
      }
      if (
        skipped.length >
        Math.max(CONTACT_LIMITS.unreadablePerPage, Math.ceil(CONTACT_LIMITS.unreadableShare * listed.length))
      )
        throw coded("bad_response");
      return { items, deletions, skipped };
    }

    function listingPage(
      source: SourceAccount,
      cursor: Omit<ListCursor, "fake" | "phase">,
      first: boolean,
    ): PersonalPage {
      // Every contact that existed when the listing began, as it is now; none deleted.
      const all = at(cursor.from)
        .flatMap((version) => people.get(nameOf(version.person))?.slice(-1) ?? [])
        .filter((version) => !version.deleted);
      const last = cursor.offset + pageSize >= all.length;
      const next: Cursor = last
        ? { fake: "contacts", phase: "sync", token: { seq: cursor.from, round } }
        : { fake: "contacts", phase: "list", ...cursor, offset: cursor.offset + pageSize };
      return {
        ...page(source, all.slice(cursor.offset, cursor.offset + pageSize), "backfill"),
        more: !last,
        next: encodeCursor(next),
        listing: { first, ...(last ? { ended: "complete" as const } : {}) },
      };
    }

    function syncPage(source: SourceAccount, cursor: SyncCursor): PersonalPage {
      const changed = latest()
        .filter((version) => version.changed > (cursor.after ?? cursor.token.seq))
        .sort((a, b) => a.changed - b.changed);
      const listed = changed.slice(0, pageSize);
      const after = listed.at(-1)?.changed;
      const last = changed.length <= pageSize || after === undefined;
      const next: SyncCursor = last
        ? { fake: "contacts", phase: "sync", token: { seq, round } }
        : { fake: "contacts", phase: "sync", token: cursor.token, after };
      return { ...page(source, listed, "live"), more: !last, next: encodeCursor(next) };
    }

    return {
      async listChanges(source: SourceAccount, cursor: ConnectorCursor | null, limit: number): Promise<PersonalPage> {
        const failure = plan.next();
        if (source.id !== sourceAccount || source.connector !== "google_contacts") throw coded("off_allowlist");
        pageLimit(limit);
        const state = cursor === null ? null : decodeCursor<Cursor>(cursor, "contacts");
        if (failure !== undefined && !(failure === "not_found" && state?.phase === "sync")) throw coded(failure);
        const fresh = (): PersonalPage => listingPage(source, { offset: 0, from: seq }, true);
        if (state === null) return fresh();
        if (state.phase === "list") return listingPage(source, state, false);
        return failure === "not_found" || state.token.round < round ? fresh() : syncPage(source, state);
      },
      syncAccessList: async (_source, cursor) => ({
        changes: [],
        next: cursor ?? encodeCursor({ fake: "contacts-access" }),
      }),
      resetCursor: () => null,
    };
  }

  return {
    connector,
    upsert(person) {
      seq += 1;
      const name = nameOf(person);
      people.set(name, [
        ...(people.get(name) ?? []),
        { person: structuredClone(person), changed: seq, deleted: false },
      ]);
    },
    remove(resourceName) {
      const versions = people.get(resourceName);
      if (versions === undefined) throw new Error("unknown contact");
      seq += 1;
      people.set(resourceName, [
        ...versions,
        { person: { resourceName, metadata: { deleted: true } }, changed: seq, deleted: true },
      ]);
    },
    expireSyncTokens() {
      round += 1;
    },
    failAt: plan.failAt,
    get calls() {
      return plan.calls;
    },
  };
}
