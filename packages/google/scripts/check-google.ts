// The live Google check. Only the owner runs it, against a throwaway Google
// account, from a checkout:
//
//   node packages/google/scripts/check-google.ts
//
// It is not part of the package and no test runs it.
//
// With --drive it runs the Drive grant's checks instead:
//
//   node packages/google/scripts/check-google.ts --drive
//
// - The same two variables, and the same output rules: never a file's name, a title, an id or
//   a token, and at most counts.
// - It asks for the drive grant through scopesFor("drive"), a consent of its own, on the
//   throwaway account that already holds the mail grant. It keeps that refresh token in
//   $HOME/.config/pi-check/drive-token.json, beside the first, for the later rerun with --drive,
//   which checks only that the token still refreshes. It reads the mail token file, if there is
//   one, only to refresh that token once, and changes nothing in it.
// - It holds the two read-only Drive scopes, so it changes nothing in the Drive. It waits, with
//   a prompt, while the owner makes each change in the browser.
// - Its Drive and Docs requests are the connector's own: its URL builder, FILE_FIELDS, the
//   listing queries, its feed parameters, readDocument with DOC_MASK, driveAbout and
//   driveFolder, and a listing through the connector itself. Besides those it reads files.get
//   with capabilities(canEdit), and documents.get for a sheet and for a file whose owner
//   switched downloading off, which the connector never asks for. It asks for no export, no
//   download, no comment, no revision and no sharing list.

import {
  createGoogleHttp,
  createPeopleConnector,
  exchangeCode,
  GoogleError,
  PEOPLE_FIELDS,
  PEOPLE_PAGE_SIZE,
  scopesFor,
  type TokenSource,
  tokenSource,
} from "@intelligence/personal-google";
import { DRIVE_TOKEN_FILE, driveFirstRun, driveRerun } from "./check-google-drive.ts";
import type { Account, Params } from "./check-google-kit.ts";
import {
  check,
  clientId,
  clientSecret,
  consent,
  direct,
  isRecord,
  keptToken,
  line,
  listAll,
  listOf,
  MAX_PAGES,
  refused,
  say,
  step,
  terminal,
} from "./check-google-kit.ts";
import { firstRun, rerun } from "./check-google-mail.ts";

// The contacts part. Every line holds a check name, a result and at most a
// count: never a name, an address, a number or a token.
const PEOPLE = "https://people.googleapis.com/v1/people/me/connections";
const peopleUrl = (params: Params): string => {
  const url = new URL(PEOPLE);
  for (const [name, value] of params) url.searchParams.append(name, value);
  return url.toString();
};
const fixedPeople = (fields = PEOPLE_FIELDS): Params => [
  ["personFields", fields],
  ["sources", "READ_SOURCE_TYPE_CONTACT"],
  ["pageSize", String(PEOPLE_PAGE_SIZE)],
  ["requestSyncToken", "true"],
];
const reasonOf = (body: unknown): string | null => {
  const error = isRecord(body) && isRecord(body.error) ? body.error : null;
  const detail = listOf(error?.details).find((one) => isRecord(one) && typeof one.reason === "string");
  return isRecord(detail) ? String(detail.reason) : null;
};

// A whole listing sent directly, as the connector sends it: each contact's update time by its
// resource name, held in memory only, the number of values of another source, and the sync token.
async function directListing(
  tokens: TokenSource,
): Promise<{ updated: Map<string, string>; foreign: number; syncToken: string | null }> {
  const updated = new Map<string, string>();
  let foreign = 0;
  let pageToken: string | null = null;
  for (let pages = 0; pages < MAX_PAGES; pages += 1) {
    const answer = await direct(
      tokens,
      peopleUrl([...fixedPeople(), ...(pageToken === null ? [] : ([["pageToken", pageToken]] as Params))]),
    );
    if (answer.status !== 200 || !isRecord(answer.body)) throw new GoogleError("bad_response", answer.status);
    for (const person of listOf(answer.body.connections)) {
      if (!isRecord(person)) continue;
      const sources = listOf(isRecord(person.metadata) ? person.metadata.sources : undefined);
      const own = sources.find((one) => isRecord(one) && one.type === "CONTACT");
      if (typeof person.resourceName === "string" && isRecord(own) && typeof own.updateTime === "string")
        updated.set(person.resourceName, own.updateTime);
      for (const field of ["names", "nicknames", "emailAddresses", "phoneNumbers", "organizations", "birthdays"]) {
        for (const value of listOf(person[field])) {
          const source = isRecord(value) && isRecord(value.metadata) ? value.metadata.source : undefined;
          if (!isRecord(source) || source.type !== "CONTACT") foreign += 1;
        }
      }
    }
    const next = answer.body.nextPageToken;
    if (typeof next !== "string")
      return {
        updated,
        foreign,
        syncToken: typeof answer.body.nextSyncToken === "string" ? answer.body.nextSyncToken : null,
      };
    pageToken = next;
  }
  return { updated, foreign, syncToken: null };
}

async function contactsRun(): Promise<number> {
  const address = process.env.PI_CHECK_ADDRESS ?? "";
  if (address === "") {
    line({ event: "missing_env" });
    return 1;
  }
  const granted = await consent("contacts", address);
  // The token answer's scope is noted on its way, and only whether it is the three.
  const seen: { scope: string | null } = { scope: null };
  const observing: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    const answer: unknown = await response
      .clone()
      .json()
      .catch(() => null);
    if (isRecord(answer) && typeof answer.scope === "string") seen.scope = answer.scope;
    return response;
  };
  const exchanged: { refreshToken: string; code: string } = { refreshToken: "", code: "" };
  try {
    exchanged.refreshToken = (
      await exchangeCode(
        {
          grant: "contacts",
          clientId,
          clientSecret,
          code: granted.code,
          redirectUri: granted.redirectUri,
          codeVerifier: granted.verifier,
          expectedAddress: address,
        },
        { fetch: observing },
      )
    ).refreshToken;
  } catch (error) {
    exchanged.code = error instanceof GoogleError ? error.code : "error";
  }
  await check("people_token_scope_is_the_three", () =>
    seen.scope === null ? "not_observed" : exchanged.code === "scope_mismatch" ? "no" : "yes",
  );
  await check("people_id_token_names_the_account", () =>
    exchanged.code === "wrong_account" ? "no" : exchanged.refreshToken === "" ? "not_observed" : "yes",
  );
  if (exchanged.refreshToken === "") return 1;

  const tokens = tokenSource({ grant: "contacts", clientId, clientSecret, refreshToken: exchanged.refreshToken });
  const http = createGoogleHttp({ tokens });
  const sourceAccount = "acc_00000000000000000000000003" as Account["id"];
  const people = createPeopleConnector(
    { connector: "google_contacts", sourceAccount, scopes: [...scopesFor("contacts")], secret: "unused" },
    http,
  );
  const contactsAccount: Account = {
    id: sourceAccount,
    connector: "google_contacts",
    sourceKind: "crm",
    vault: "personal",
    externalRef: "check",
    accessSyncKind: "none",
    compartments: ["own"],
    markerCompartments: [],
  };

  const listed = await step("people_listing", () => listAll(people, contactsAccount, 1000));
  await check("people_connections_accepted", () =>
    listed === null ? "no" : ["yes", listed.pages.reduce((sum, page) => sum + page.items.length, 0)],
  );
  await check("people_sync_token_returned", () => (listed === null ? "not_observed" : listed.ended ? "yes" : "no"));
  const before = await step("people_direct_listing", () => directListing(tokens));
  await check("people_sources_leave_out_profile", () =>
    before === null ? "not_observed" : [before.foreign === 0 ? "yes" : "no", before.foreign],
  );

  // A sync token sent with another field list, and a token that is none.
  await check("people_changed_parameters_refused", async () => {
    if (before?.syncToken === undefined || before.syncToken === null) return "not_observed";
    return refused(
      (await direct(tokens, peopleUrl([...fixedPeople("names"), ["syncToken", before.syncToken]]))).status,
      400,
    );
  });
  await check("people_bad_token_answer", async () => {
    const answer = await direct(tokens, peopleUrl([...fixedPeople(), ["syncToken", "not-a-sync-token"]]));
    const expiredLike =
      answer.status === 410 || (answer.status === 400 && reasonOf(answer.body) === "EXPIRED_SYNC_TOKEN");
    return [expiredLike ? "yes" : "no", answer.status];
  });

  // Whether a photo change alone moves a contact's update time, which the contact's tag leaves out
  // with the photo.
  await terminal.question(
    "In Google Contacts for the throwaway account, change one contact's photo and nothing else, then press Enter: ",
  );
  const afterPhoto = await step("people_listing_after_photo", () => directListing(tokens));
  await check("people_update_time_moves_on_photo", () => {
    if (before === null || afterPhoto === null) return "not_observed";
    const moved = [...afterPhoto.updated].filter(
      ([name, at]) => before.updated.has(name) && before.updated.get(name) !== at,
    ).length;
    return [moved > 0 ? "yes" : "no", moved];
  });

  await terminal.question("Now edit one contact's name and delete another contact, then press Enter: ");
  const changes =
    listed === null
      ? null
      : await step("people_sync_page", () => people.listChanges(contactsAccount, listed.next, 1000));
  await check("people_change_reported", () =>
    changes === null || changes.listing !== undefined
      ? "not_observed"
      : [changes.items.length > 0 ? "yes" : "no", changes.items.length],
  );
  await check("people_deletion_reported", () =>
    changes === null || changes.listing !== undefined
      ? "not_observed"
      : [changes.deletions.length > 0 ? "yes" : "no", changes.deletions.length],
  );
  // A quota answer cannot be provoked on purpose on a throwaway account.
  await check("people_quota_headers", () => "not_observed");
  say("Done. No token was kept for the contacts part.");
  return 0;
}

let exit = 1;
try {
  if (process.argv.includes("--contacts")) exit = await contactsRun();
  else if (process.argv.includes("--drive")) {
    const kept = keptToken(DRIVE_TOKEN_FILE);
    exit = kept === null ? await driveFirstRun() : await driveRerun(kept);
  } else {
    const kept = keptToken();
    exit = kept === null ? await firstRun() : await rerun(kept);
  }
} catch (error) {
  // Never the error itself: it may hold what the account holds.
  line({ event: "check_failed", code: error instanceof GoogleError ? error.code : "error" });
}
terminal.close();
process.exit(exit);
