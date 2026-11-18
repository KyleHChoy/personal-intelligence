import {
  ConnectorCursor,
  type HttpPort,
  type RawItem,
  type SkippedItem,
  type SourceAccount,
  type SourceCredential,
  type SourceDeletion,
  type Timestamp,
} from "@intelligence/contracts";
import {
  CONTACT_LIMITS,
  contactDeletion,
  contactItem,
  type PersonalConnector,
  type PersonalPage,
  whitelistedContact,
} from "@intelligence/personal-core/items";
import { type ContactsPhase, contactsCursor, readContactsCursor } from "./cursor.ts";
import {
  apiGet,
  bad,
  type GoogleDeps,
  GoogleError,
  isRecord,
  optionalToken,
  scopesFor,
  text,
  withDefaults,
} from "./http.ts";

// The People connector for a label's saved contacts: one endpoint, a listing, then changes by sync
// token. A contact is read field by field by core's one reading of it; nothing a contact says is
// followed, and no link it holds is fetched: a website is read as a value.

const CONNECTIONS = "https://people.googleapis.com/v1/people/me/connections";

// PEOPLE_FIELDS_VERSION names this field list: a cursor of another version starts a new listing, so
// every contact is read again with the fields asked for now.
export const PEOPLE_FIELDS = "names,nicknames,emailAddresses,phoneNumbers,organizations,birthdays,urls,metadata";
export const PEOPLE_FIELDS_VERSION = 2;
const fields = { fields: PEOPLE_FIELDS_VERSION };
export const PEOPLE_PAGE_SIZE = 1000;
const FIXED: [string, string][] = [
  ["personFields", PEOPLE_FIELDS],
  ["sources", "READ_SOURCE_TYPE_CONTACT"],
  ["pageSize", String(PEOPLE_PAGE_SIZE)],
  ["requestSyncToken", "true"],
];

// What syncAccessList returns when it is given no cursor: contacts have no access list.
const NO_ACCESS_LIST = ConnectorCursor.parse("none");

type Answer = {
  items: RawItem[];
  deletions: SourceDeletion[];
  skipped: SkippedItem[];
  pageToken?: string;
  syncToken?: string;
};

function peoplePages(
  http: HttpPort,
  deps: GoogleDeps,
): (account: SourceAccount, phase: ContactsPhase | null) => Promise<PersonalPage> {
  const { now } = withDefaults(deps);

  async function read(
    account: SourceAccount,
    live: boolean,
    tokens: [string, string][],
    at: Timestamp,
  ): Promise<Answer> {
    const url = new URL(CONNECTIONS);
    for (const [name, value] of [...FIXED, ...tokens]) url.searchParams.append(name, value);
    const body = (await apiGet(http, url.toString(), deps)).body;
    if (!isRecord(body)) throw bad();
    const [pageToken, syncToken] = [optionalToken(body.nextPageToken), optionalToken(body.nextSyncToken)];
    const { connections } = body;
    if (connections !== undefined && !Array.isArray(connections)) throw bad();

    const items: RawItem[] = [];
    const deletions: SourceDeletion[] = [];
    const skipped: SkippedItem[] = [];
    for (const one of connections ?? []) {
      if (!isRecord(one) || !text(one.resourceName)) throw bad();
      const resourceName = one.resourceName;
      if (isRecord(one.metadata) && one.metadata.deleted === true) {
        deletions.push(contactDeletion(resourceName, { sourceAccount: account.id, now: at }));
        continue;
      }
      const contact = whitelistedContact(one);
      if (contact === null) {
        skipped.push({ sourceItemId: `contact:${resourceName}`, reason: "unsupported" });
        continue;
      }
      items.push(contactItem(contact, { sourceAccount: account.id, changeKind: live ? "live" : "backfill", now: at }));
    }
    const n = connections?.length ?? 0;
    if (skipped.length > Math.max(CONTACT_LIMITS.unreadablePerPage, Math.ceil(CONTACT_LIMITS.unreadableShare * n)))
      throw bad();
    return {
      items,
      deletions,
      skipped,
      ...(pageToken === undefined ? {} : { pageToken }),
      ...(syncToken === undefined ? {} : { syncToken }),
    };
  }

  // The last one, with no next page token, carries the sync token.
  async function listing(account: SourceAccount, pageToken: string | undefined, at: Timestamp): Promise<PersonalPage> {
    const answer = await read(account, false, pageToken === undefined ? [] : [["pageToken", pageToken]], at);
    const last = answer.pageToken === undefined;
    if (last && answer.syncToken === undefined) throw bad();
    return {
      items: answer.items,
      deletions: answer.deletions,
      skipped: answer.skipped,
      more: !last,
      listing: { first: pageToken === undefined, ...(last ? { ended: "complete" as const } : {}) },
      next:
        answer.pageToken !== undefined
          ? contactsCursor({ phase: "list", pageToken: answer.pageToken, ...fields })
          : contactsCursor({ phase: "sync", syncToken: answer.syncToken as string, ...fields }),
    };
  }

  // Paging a sync resends the token with the page token, as Google asks every later request to
  // match the first.
  async function sync(
    account: SourceAccount,
    at: { syncToken: string; pageToken?: string },
    clock: Timestamp,
  ): Promise<PersonalPage> {
    let answer: Answer;
    try {
      answer = await read(
        account,
        true,
        [
          ["syncToken", at.syncToken],
          ...(at.pageToken === undefined ? [] : ([["pageToken", at.pageToken]] as [string, string][])),
        ],
        clock,
      );
    } catch (error) {
      if (error instanceof GoogleError && (error.code === "sync_token_expired" || error.status === 410))
        return listing(account, undefined, clock);
      throw error;
    }
    if (answer.pageToken === undefined && answer.syncToken === undefined) throw bad();
    return {
      items: answer.items,
      deletions: answer.deletions,
      skipped: answer.skipped,
      more: answer.pageToken !== undefined,
      next:
        answer.pageToken !== undefined
          ? contactsCursor({ phase: "sync", syncToken: at.syncToken, pageToken: answer.pageToken, ...fields })
          : contactsCursor({ phase: "sync", syncToken: answer.syncToken as string, ...fields }),
    };
  }

  return (account, phase) => {
    // The connector's clock, read once per page.
    const clock = new Date(now()).toISOString();
    // A cursor of other person fields starts a new listing.
    if (phase === null || phase.fields !== PEOPLE_FIELDS_VERSION) return listing(account, undefined, clock);
    return phase.phase === "list" ? listing(account, phase.pageToken, clock) : sync(account, phase, clock);
  };
}

const sameSet = (one: readonly string[], other: readonly string[]): boolean => {
  const a = new Set(one);
  return a.size === new Set(other).size && other.every((scope) => a.has(scope));
};

// One connector for one label's contacts account. It keeps nothing between calls, never advances a
// cursor, stores nothing and logs nothing. `credential.secret` is never read here: the port's token
// source was built from the same values by the caller.
export function createPeopleConnector(
  credential: SourceCredential,
  http: HttpPort,
  deps: GoogleDeps = {},
): PersonalConnector {
  if (credential.connector !== "google_contacts") throw new GoogleError("off_allowlist");
  if (!sameSet(credential.scopes, scopesFor("contacts"))) throw new GoogleError("scope_mismatch");
  const pages = peoplePages(http, deps);
  return {
    async listChanges(account, cursor, limit) {
      if (account.connector !== "google_contacts" || account.id !== credential.sourceAccount)
        throw new GoogleError("off_allowlist");
      if (!Number.isInteger(limit) || limit < 1) throw new GoogleError("bad_request");
      return pages(account, cursor === null ? null : readContactsCursor(cursor));
    },
    async syncAccessList(_account, cursor) {
      return { changes: [], next: cursor ?? NO_ACCESS_LIST };
    },
    resetCursor: () => null,
  };
}
