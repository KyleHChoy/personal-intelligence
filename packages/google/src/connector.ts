import { ConnectorCursor, type HttpPort, type SourceCredential, Timestamp } from "@intelligence/contracts";
import type { ConnectorOptions, PersonalConnector } from "@intelligence/personal-core/items";
import { calendarPages } from "./calendar.ts";
import { driveCursor, mailCursor, readCalendarCursor, readDriveCursor, readMailCursor } from "./cursor.ts";
import { drivePages } from "./drive.ts";
import { gmailPages } from "./gmail.ts";
import { type GoogleDeps, GoogleError, scopesFor } from "./http.ts";

// What syncAccessList returns when it is given no cursor: these accounts have no access list.
const NO_ACCESS_LIST = ConnectorCursor.parse("none");

// One connector for one source account. It keeps nothing between calls and never advances a cursor:
// sync stores `next` only after the page commits. `credential.secret` is never read here: the
// port's token source was built from the same values by the caller.
export function createGoogleConnector(
  id: "google_mail" | "google_calendar" | "google_docs",
  credential: SourceCredential,
  http: HttpPort,
  options: ConnectorOptions = {},
  deps: GoogleDeps = {},
): PersonalConnector {
  // The mail and calendar connectors hold nothing outside the mail grant; the Drive connector holds
  // exactly the Drive grant.
  if (credential.connector !== id) throw new GoogleError("off_allowlist");
  if (id === "google_docs") {
    const wanted = scopesFor("drive");
    const held = new Set(credential.scopes);
    if (held.size !== wanted.length || !wanted.every((one) => held.has(one))) throw new GoogleError("scope_mismatch");
    return driveConnector(credential, http, options, deps);
  }
  if (credential.scopes.some((scope) => !scopesFor("mail").includes(scope))) throw new GoogleError("scope_mismatch");
  // A since that is no timestamp would make Gmail list the whole mailbox, with no window.
  if (options.since !== undefined && !Timestamp.safeParse(options.since).success) throw new GoogleError("bad_request");
  const mail = gmailPages(http, options, deps);
  const calendar = calendarPages(http, options, deps);

  return {
    async listChanges(account, cursor, limit) {
      if (account.connector !== id || account.id !== credential.sourceAccount) throw new GoogleError("off_allowlist");
      if (!Number.isInteger(limit) || limit < 1) throw new GoogleError("bad_request");
      if (id === "google_mail") return mail(account, cursor === null ? null : readMailCursor(cursor), limit);
      return calendar(account, cursor === null ? null : readCalendarCursor(cursor), limit);
    },
    async syncAccessList(_account, cursor) {
      return { changes: [], next: cursor ?? NO_ACCESS_LIST };
    },
    // No call is made. A calendar listing has no window to run past, so its reset is no cursor.
    resetCursor: () => (id === "google_mail" ? mailCursor({ phase: "reset" }) : null),
  };
}

// The Drive connector, over a port the caller built with MAX_DOCUMENT_ANSWER_BYTES. Its accounts
// have no access list. A reset makes no call and is the same cursor every time: the next listing
// fetches every document in scope whatever is stored.
function driveConnector(
  credential: SourceCredential,
  http: HttpPort,
  options: ConnectorOptions,
  deps: GoogleDeps,
): PersonalConnector {
  const drive = drivePages(http, options, deps);
  return {
    async listChanges(account, cursor, limit) {
      if (account.connector !== "google_docs" || account.id !== credential.sourceAccount)
        throw new GoogleError("off_allowlist");
      if (!Number.isInteger(limit) || limit < 1) throw new GoogleError("bad_request");
      return drive.page(account, cursor === null ? null : readDriveCursor(cursor), limit);
    },
    async syncAccessList(_account, cursor) {
      return { changes: [], next: cursor ?? NO_ACCESS_LIST };
    },
    resetCursor: () => driveCursor({ phase: "d_reset" }),
  };
}
