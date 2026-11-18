// The live Google check's --drive mode: Drive listings, snapshots and the change feed, the
// wait while the owner changes something in the browser, Docs answer counts, the first run and
// the rerun eight or more days later.

import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  createGoogleConnector,
  createGoogleHttp,
  driveAbout,
  driveFolder,
  exchangeCode,
  GoogleError,
  MAX_DOCUMENT_ANSWER_BYTES,
  tokenSource,
} from "@intelligence/personal-google";
// The connector's own masks and builders, which the package does not export from its root.
import { readDocBody, readDocument } from "../src/docs.ts";
import { FILE_FIELDS } from "../src/drive.ts";
import { driveUrl, FOLDER_TYPE } from "../src/drive-scope.ts";
import type { Cursor, Kept, Outcome, Page, Params } from "./check-google-kit.ts";
import {
  account,
  check,
  clientId,
  clientSecret,
  consent,
  DAY_MS,
  isRecord,
  keepToken,
  keptToken,
  line,
  listOf,
  PACE_RUN_MS,
  paced,
  portGet,
  say,
  sleep,
  step,
  strings,
  TOKEN_DIR,
  terminal,
} from "./check-google-kit.ts";

export const DRIVE_TOKEN_FILE = join(TOKEN_DIR, "drive-token.json");
const DOCS_API = "https://docs.googleapis.com/v1/documents/";
const GOOGLE_DOC = "application/vnd.google-apps.document";
const GOOGLE_SHEET = "application/vnd.google-apps.spreadsheet";
// The connector's two listing queries (drive-scope.ts, drive.ts), which the package does not
// export, written from the same folder type.
const FOLDER_QUERY = `mimeType = '${FOLDER_TYPE}' and trashed = false`;
const FILE_QUERY = `mimeType != '${FOLDER_TYPE}' and trashed = false`;
const FOLDER_FIELDS = "nextPageToken,files(id,parents)";
const FEED_FIELDS = `nextPageToken,newStartPageToken,changes(changeType,removed,fileId,file(${FILE_FIELDS}))`;
// The most pages any one Drive listing or feed read takes. A throwaway Drive needs few.
const DRIVE_PAGES = 50;
// How long a feed is read again, and how often, until the owner's change shows; and how long
// after it shows the feed is read once more for entries that came with it.
const FEED_WAIT_MS = 120_000;
const FEED_POLL_MS = 5_000;
const SETTLE_MS = 20_000;
const HEADING_STYLES = ["TITLE", "HEADING_1", "HEADING_2", "HEADING_3", "HEADING_4", "HEADING_5", "HEADING_6"];

// The parameters the connector sends with each Drive call.
const listParams = (q: string, pageSize: number, fields: string, pageToken?: string): Params => [
  ["q", q],
  ["corpora", "user"],
  ["spaces", "drive"],
  ["pageSize", String(pageSize)],
  ["fields", fields],
  ...(pageToken === undefined ? [] : [["pageToken", pageToken] satisfies [string, string]]),
];
const feedParams = (token: string): Params => [
  ["pageToken", token],
  ["includeRemoved", "true"],
  ["restrictToMyDrive", "false"],
  ["spaces", "drive"],
  ["pageSize", "200"],
  ["fields", FEED_FIELDS],
];

// What the script reads of one file or folder. It stays in memory, is only compared and
// counted, and is never written.
type Known = {
  folder: boolean;
  parents: string[];
  name: string;
  mimeType: string;
  modifiedTime: string;
  ownedByMe: boolean;
  canDownload: boolean;
  sharedWithMe: boolean;
  inSharedDrive: boolean;
  trashed: boolean;
};
type Snapshot = Map<string, Known>;
type Change = { fileId: string; removed: boolean; file: Known | null };
type Get = (url: string) => Promise<unknown>;

function known(file: Record<string, unknown>): Known {
  const capabilities = isRecord(file.capabilities) ? file.capabilities : {};
  return {
    folder: file.mimeType === FOLDER_TYPE,
    parents: strings(file.parents),
    name: typeof file.name === "string" ? file.name : "",
    mimeType: typeof file.mimeType === "string" ? file.mimeType : "",
    modifiedTime: typeof file.modifiedTime === "string" ? file.modifiedTime : "",
    ownedByMe: file.ownedByMe === true,
    canDownload: capabilities.canDownload === true,
    sharedWithMe: typeof file.sharedWithMeTime === "string",
    inSharedDrive: typeof file.driveId === "string",
    trashed: file.trashed === true,
  };
}

// One Drive listing, every page, with the connector's parameters.
async function driveList(get: Get, q: string, pageSize: number, fields: string): Promise<Record<string, unknown>[]> {
  const files: Record<string, unknown>[] = [];
  let pageToken: string | undefined;
  for (let pages = 0; pages < DRIVE_PAGES; pages += 1) {
    const body = await get(driveUrl("files", listParams(q, pageSize, fields, pageToken)));
    if (!isRecord(body)) throw new GoogleError("bad_response");
    for (const one of listOf(body.files)) if (isRecord(one) && typeof one.id === "string") files.push(one);
    if (typeof body.nextPageToken !== "string") return files;
    pageToken = body.nextPageToken;
  }
  throw new GoogleError("too_large");
}

// Every folder and file the account sees, by the connector's two queries. The folder listing
// also asks for sharedWithMeTime, for the shared-folder check.
async function snapshot(get: Get): Promise<Snapshot> {
  const all: Snapshot = new Map();
  for (const one of await driveList(
    get,
    FOLDER_QUERY,
    1000,
    "nextPageToken,files(id,mimeType,parents,sharedWithMeTime)",
  ))
    all.set(String(one.id), known(one));
  for (const one of await driveList(get, FILE_QUERY, 200, `nextPageToken,files(${FILE_FIELDS})`))
    all.set(String(one.id), known(one));
  return all;
}

async function startToken(get: Get): Promise<string> {
  const body = await get(driveUrl("changes/startPageToken", []));
  if (!isRecord(body) || typeof body.startPageToken !== "string") throw new GoogleError("bad_response");
  return body.startPageToken;
}

// Every change entry from `token` to the feed's end, with the connector's parameters. A change of
// type drive is left out, as the connector leaves it out.
async function feedSince(get: Get, token: string): Promise<Change[]> {
  const changes: Change[] = [];
  let at = token;
  for (let pages = 0; pages < DRIVE_PAGES; pages += 1) {
    const body = await get(driveUrl("changes", feedParams(at)));
    if (!isRecord(body)) throw new GoogleError("bad_response");
    for (const one of listOf(body.changes)) {
      if (!isRecord(one) || one.changeType === "drive" || typeof one.fileId !== "string") continue;
      changes.push({
        fileId: one.fileId,
        removed: one.removed === true,
        file: isRecord(one.file) ? known(one.file) : null,
      });
    }
    if (typeof body.nextPageToken !== "string") return changes;
    at = body.nextPageToken;
  }
  throw new GoogleError("too_large");
}

// The ids of everything under `folder`, at any depth, by the snapshot's parents.
function inside(all: Snapshot, folder: string): Set<string> {
  const found = new Set<string>();
  for (const [id] of all) {
    const passed = new Set<string>();
    for (
      let at = all.get(id)?.parents[0];
      at !== undefined && !passed.has(at) && passed.size < 100;
      at = all.get(at)?.parents[0]
    ) {
      if (at === folder) {
        found.add(id);
        break;
      }
      passed.add(at);
    }
  }
  return found;
}

// A change the owner may skip.
const wanted = async (what: string): Promise<boolean> =>
  (await terminal.question(`${what} Type yes to do it, or press Enter to skip: `)).trim().toLowerCase() === "yes";

// One change the owner makes: the snapshot and the feed's token before it, a prompt, then the
// feed read again until `seen` holds or FEED_WAIT_MS has passed. With `settle`, once it holds,
// the feed is read once more SETTLE_MS later. An optional change the owner skips is null.
type Watched = { before: Snapshot; changes: Change[] };
async function watch(
  get: Get,
  what: string,
  seen: (changes: Change[], before: Snapshot) => boolean,
  { optional = false, settle = false } = {},
): Promise<Watched | null> {
  if (optional && !(await wanted(what))) return null;
  const before = await snapshot(get);
  const token = await startToken(get);
  say(optional ? "Do it now." : what);
  await terminal.question("Press Enter when it is done: ");
  const deadline = Date.now() + FEED_WAIT_MS;
  let changes = await feedSince(get, token);
  while (!seen(changes, before) && Date.now() < deadline) {
    await sleep(FEED_POLL_MS);
    changes = await feedSince(get, token);
  }
  if (settle && seen(changes, before)) {
    await sleep(SETTLE_MS);
    changes = await feedSince(get, token);
  }
  return { before, changes };
}

// A file's entry, not a folder's and not a removal.
const fileEntries = (changes: Change[]): (Change & { file: Known })[] =>
  changes.filter((one): one is Change & { file: Known } => !one.removed && one.file !== null && !one.file.folder);
const folderEntries = (changes: Change[]): (Change & { file: Known })[] =>
  changes.filter((one): one is Change & { file: Known } => !one.removed && one.file !== null && one.file.folder);

// What one documents.get answered, as counts. The answer itself is dropped.
type DocSeen = {
  status: number;
  bytes: number;
  tabs: number;
  headings: number;
  person: number;
  link: number;
  date: number;
  unsupported: boolean;
};

function docCounts(answer: unknown): Omit<DocSeen, "status" | "bytes" | "unsupported"> {
  const counts = { tabs: 0, headings: 0, person: 0, link: 0, date: 0 };
  const field = (value: unknown, ...path: string[]): unknown =>
    path.reduce((at, name) => (isRecord(at) ? at[name] : undefined), value);
  const content = (elements: unknown): void => {
    for (const element of listOf(elements)) {
      const paragraph = field(element, "paragraph");
      if (isRecord(paragraph)) {
        if (HEADING_STYLES.includes(String(field(paragraph, "paragraphStyle", "namedStyleType")))) counts.headings += 1;
        for (const one of listOf(paragraph.elements)) {
          if (typeof field(one, "person", "personProperties", "name") === "string") counts.person += 1;
          if (typeof field(one, "richLink", "richLinkProperties", "title") === "string") counts.link += 1;
          if (typeof field(one, "dateElement", "dateElementProperties", "displayText") === "string") counts.date += 1;
        }
      }
      for (const row of listOf(field(element, "table", "tableRows")))
        for (const cell of listOf(field(row, "tableCells"))) content(field(cell, "content"));
    }
  };
  const tabs = (list: unknown): void => {
    for (const tab of listOf(list)) {
      counts.tabs += 1;
      content(field(tab, "documentTab", "body", "content"));
      tabs(field(tab, "childTabs"));
    }
  };
  tabs(field(answer, "tabs"));
  return counts;
}

// The rerun of --drive, eight or more days after the first run: does the kept Drive token still refresh.
export async function driveRerun(kept: Kept): Promise<number> {
  const days = Math.floor((Date.now() - kept.issuedAt) / DAY_MS);
  const tokens = tokenSource({ grant: "drive", clientId, clientSecret, refreshToken: kept.refreshToken });
  const seen: { token: "alive" | "refused" | "stale" | "unknown" } = { token: "unknown" };
  await check("drive_token_alive_after_eight_days", async () => {
    try {
      await tokens.accessToken();
      seen.token = "alive";
      return [days >= 8 ? "yes" : "not_observed", days];
    } catch (error) {
      if (error instanceof GoogleError && error.code === "scope_mismatch") {
        seen.token = "stale";
        return "not_observed";
      }
      if (!(error instanceof GoogleError) || error.code !== "oauth_failed") throw error;
      seen.token = "refused";
      return ["no", days];
    }
  });
  if (seen.token === "stale") {
    line({ event: "token_file_stale" });
    say(
      "The Drive token file was written under another scope. Delete $HOME/.config/pi-check/drive-token.json and run this script again with --drive for a new first run.",
    );
    return 2;
  }
  if (seen.token === "alive" && days < 8)
    say("It is not eight days yet. The Drive token file is kept: run this script again with --drive once it is.");
  if (seen.token === "refused" || (seen.token === "alive" && days >= 8)) rmSync(DRIVE_TOKEN_FILE);
  return seen.token === "alive" ? 0 : 1;
}

export async function driveFirstRun(): Promise<number> {
  say("Before the Drive consent, prepare the throwaway account:");
  say(
    "- in My Drive: a folder holding a file and a folder of its own with a file in it, and one more folder to move things into;",
  );
  say(
    "- a Google Doc with two tabs, a heading, a person chip, a link chip and a date chip; a Google Doc of about a million characters; a Google Sheet;",
  );
  say(
    "- from the second throwaway account, shared with this one: a folder holding one file; a Google Doc shared as a viewer; a Google Doc with downloading, printing and copying switched off for viewers; and one file shared directly.",
  );
  await terminal.question("Press Enter when they are ready: ");

  // The grant: its own consent, with the mail grant already held by this client.
  const mailKept = await step("mail_token_file", async () => keptToken());
  if (mailKept === null)
    say(
      "No mail token file is kept, so the mail-token check reports not_observed. Run the mail checks first to observe it.",
    );
  const granted = await consent("drive");
  const grant = { refreshToken: "" };
  await check("drive_grant_scope_is_exact", async (): Promise<Outcome> => {
    try {
      grant.refreshToken = (
        await exchangeCode({
          grant: "drive",
          clientId,
          clientSecret,
          code: granted.code,
          redirectUri: granted.redirectUri,
          codeVerifier: granted.verifier,
        })
      ).refreshToken;
      return "yes";
    } catch (error) {
      if (!(error instanceof GoogleError) || error.code !== "scope_mismatch") throw error;
      return "no";
    }
  });
  const { refreshToken } = grant;
  if (refreshToken === "") return 1;
  keepToken(refreshToken, null, DRIVE_TOKEN_FILE);

  const refresh: { carriesScope: boolean | null } = { carriesScope: null };
  const observing: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    const answer: unknown = await response
      .clone()
      .json()
      .catch(() => null);
    if (isRecord(answer) && "access_token" in answer) refresh.carriesScope = "scope" in answer;
    return response;
  };
  const tokens = tokenSource({ grant: "drive", clientId, clientSecret, refreshToken }, { fetch: observing });
  await tokens.accessToken().catch(() => {});
  await check("drive_refresh_answer_carries_scope", () =>
    refresh.carriesScope === null ? "not_observed" : refresh.carriesScope ? "yes" : "no",
  );
  await check("drive_grant_leaves_mail_token_valid", async () => {
    if (mailKept === null) return "not_observed";
    try {
      await tokenSource({ grant: "mail", clientId, clientSecret, refreshToken: mailKept.refreshToken }).accessToken();
      return "yes";
    } catch (error) {
      if (error instanceof GoogleError && error.code === "oauth_failed") return "no";
      if (error instanceof GoogleError && error.code === "scope_mismatch") return "not_observed";
      throw error;
    }
  });

  // Every documents.get answer this port carries, as counts by file id, in memory only.
  const docsSeen = new Map<string, DocSeen>();
  const measuring: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    const url = String(input);
    if (!url.startsWith(DOCS_API)) return response;
    const bytes = new Uint8Array(await response.arrayBuffer());
    let answer: unknown = null;
    try {
      answer = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      answer = null;
    }
    const id = decodeURIComponent(new URL(url).pathname.slice(new URL(DOCS_API).pathname.length));
    const ok = response.status === 200;
    docsSeen.set(id, {
      status: response.status,
      bytes: bytes.byteLength,
      ...docCounts(ok ? answer : null),
      unsupported: ok && readDocBody(answer) === "unsupported",
    });
    return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
  // The connector's port: one for Drive and Docs, with the document bound.
  const drive = createGoogleHttp({ tokens, deps: { fetch: measuring }, maxAnswerBytes: MAX_DOCUMENT_ANSWER_BYTES });
  const get: Get = (url) => portGet(drive, url);
  const statusOf = (error: unknown): number | undefined => (error instanceof GoogleError ? error.status : undefined);
  const refusedAs = (error: unknown): Outcome => {
    const status = statusOf(error);
    if (status === 400 || status === 403) return ["no", status];
    throw error;
  };

  await check("drive_about_under_metadata_scope", async () => {
    try {
      return (await driveAbout(drive)).address === "" ? "no" : "yes";
    } catch (error) {
      return refusedAs(error);
    }
  });

  // The calls, with the connector's queries and masks. The count is the files answered.
  await check("drive_files_list_queries_accepted", async () => {
    try {
      const folders = await driveList(get, FOLDER_QUERY, 1000, FOLDER_FIELDS);
      const files = await driveList(get, FILE_QUERY, 200, "nextPageToken,files(id)");
      return ["yes", folders.length + files.length];
    } catch (error) {
      return refusedAs(error);
    }
  });
  await check("drive_file_mask_accepted", async () => {
    try {
      const files = await driveList(get, FILE_QUERY, 200, `nextPageToken,files(${FILE_FIELDS})`);
      const [first] = files;
      if (first !== undefined)
        await get(driveUrl(`files/${encodeURIComponent(String(first.id))}`, [["fields", FILE_FIELDS]]));
      await feedSince(get, await startToken(get));
      return [first === undefined ? "not_observed" : "yes", files.length];
    } catch (error) {
      return refusedAs(error);
    }
  });
  await check("drive_root_alias_answers_an_id", async () => {
    const root = await driveFolder(drive, "root");
    return root !== null && root.id !== "" && root.id !== "root" ? "yes" : "no";
  });

  const all = (await step("drive_snapshot", () => snapshot(get))) ?? new Map<string, Known>();
  const entries = [...all.entries()];

  const sharedDrive = await wanted("Is this account a member of a shared drive that holds at least one file?");
  await check("drive_shared_drive_items_absent", () => {
    if (!sharedDrive || all.size === 0) return "not_observed";
    const count = entries.filter(([, one]) => one.inSharedDrive).length;
    return [count === 0 ? "yes" : "no", count];
  });

  // The count is such files that carry one.
  await check("drive_shared_folder_children_lack_shared_time", () => {
    const sharedFolders = entries.filter(([, one]) => one.folder && one.sharedWithMe).map(([id]) => id);
    const children = new Set(sharedFolders.flatMap((folder) => [...inside(all, folder)]));
    const files = [...children].flatMap((id) => {
      const one = all.get(id);
      return one !== undefined && !one.folder && !one.ownedByMe ? [one] : [];
    });
    if (files.length === 0) return "not_observed";
    const count = files.filter((one) => one.sharedWithMe).length;
    return [count === 0 ? "yes" : "no", count];
  });

  // A listing through the connector itself, of My Drive and what is shared with the account,
  // to its end; then one feed call from where it ended.
  const docs = account("google_docs", "acc_00000000000000000000000003");
  const connector = createGoogleConnector("google_docs", docs.credential, drive, {
    roots: ["my-drive", "shared-with-me"],
  });
  const listed = await step("drive_listing", async () => {
    let cursor: Cursor | null = null;
    for (let pages = 0; pages < DRIVE_PAGES; pages += 1) {
      const page: Page = await connector.listChanges(docs.account, cursor, 200);
      cursor = page.next;
      if (page.listing?.ended !== undefined) return page.next;
    }
    throw new GoogleError("too_large");
  });
  await check("drive_start_token_and_changes_accepted", async () => {
    if (listed === null) return "not_observed";
    const page = await connector.listChanges(docs.account, listed, 200);
    // A new listing here would mean the feed refused the start token.
    return page.listing === undefined ? "yes" : "no";
  });

  const read = async (id: string): Promise<DocSeen | undefined> => {
    await paced();
    await readDocument(drive, id).catch(() => undefined);
    return docsSeen.get(id);
  };
  await step("docs_read", async () => {
    for (const [id, one] of entries)
      if (one.mimeType === GOOGLE_DOC && one.canDownload && !docsSeen.has(id)) await read(id);
  });
  const ownDocs = [...docsSeen.entries()]
    .filter(([id]) => all.get(id)?.ownedByMe === true && all.get(id)?.mimeType === GOOGLE_DOC)
    .map(([, seen]) => seen);
  const answered = [...docsSeen.values()].filter((seen) => seen.status === 200);
  // The count is the owner's documents read.
  await check("docs_get_accepted_under_documents_readonly", () => {
    if (ownDocs.length === 0) return "not_observed";
    return [ownDocs.some((seen) => seen.status === 401 || seen.status === 403) ? "no" : "yes", ownDocs.length];
  });
  // The count is the owner's documents whose answer was refused or wrongly typed.
  await check("docs_mask_accepted", () => {
    if (ownDocs.length === 0) return "not_observed";
    const count = ownDocs.filter((seen) => seen.status !== 200 || seen.unsupported).length;
    return [count === 0 ? "yes" : "no", count];
  });
  // The count is the most tabs one document returned.
  await check("docs_tabs_returned", () => {
    if (answered.length === 0) return "not_observed";
    const most = Math.max(...answered.map((seen) => seen.tabs));
    return [most >= 2 ? "yes" : "no", most];
  });
  await check("docs_heading_styles_returned", () => {
    if (answered.length === 0) return "not_observed";
    const count = answered.reduce((sum, seen) => sum + seen.headings, 0);
    return [count > 0 ? "yes" : "no", count];
  });
  await check("docs_chips_returned", () => {
    if (answered.length === 0) return "not_observed";
    const counts = { person: 0, link: 0, date: 0 };
    for (const seen of answered) for (const kind of ["person", "link", "date"] as const) counts[kind] += seen[kind];
    return [counts.person > 0 && counts.link > 0 && counts.date > 0 ? "yes" : "no", counts];
  });
  await check("docs_answer_within_bound", () => {
    if (docsSeen.size === 0) return "not_observed";
    const largest = Math.max(...[...docsSeen.values()].map((seen) => seen.bytes));
    return [largest <= MAX_DOCUMENT_ANSWER_BYTES ? "yes" : "no", largest];
  });
  // The count is the status.
  await check("docs_suggestions_mode_accepted_for_a_viewer", async () => {
    for (const [id, one] of entries) {
      if (one.mimeType !== GOOGLE_DOC || one.ownedByMe || !one.canDownload) continue;
      const rights = await get(driveUrl(`files/${encodeURIComponent(id)}`, [["fields", "id,capabilities(canEdit)"]]));
      if (!isRecord(rights) || !isRecord(rights.capabilities) || rights.capabilities.canEdit !== false) continue;
      const seen = docsSeen.get(id) ?? (await read(id));
      if (seen === undefined) return "not_observed";
      return [seen.status === 200 ? "yes" : seen.status === 400 ? "no" : "not_observed", seen.status];
    }
    return "not_observed";
  });
  // documents.get for a Google Sheet, which the connector never sends. The count is the status.
  await check("docs_refused_for_a_sheet", async () => {
    const sheet = entries.find(([, one]) => one.mimeType === GOOGLE_SHEET);
    if (sheet === undefined) return "not_observed";
    const seen = await read(sheet[0]);
    if (seen === undefined) return "not_observed";
    return [seen.status === 200 ? "no" : "yes", seen.status];
  });
  // For information: what documents.get answers for a Google Doc whose owner switched downloading
  // off; the connector never asks. Yes is an answer with the text; the count is the status.
  await check("docs_answer_for_no_download_file", async () => {
    const locked = entries.find(([, one]) => one.mimeType === GOOGLE_DOC && !one.canDownload);
    if (locked === undefined) return "not_observed";
    const seen = await read(locked[0]);
    if (seen === undefined) return "not_observed";
    return [seen.status === 200 ? "yes" : "no", seen.status];
  });
  // The count is the answers that were a 429, which must be 0.
  await check("docs_pace_within_quota", async () => {
    const smallest = [...docsSeen.entries()]
      .filter(([id, seen]) => seen.status === 200 && all.get(id)?.ownedByMe === true)
      .sort((a, b) => a[1].bytes - b[1].bytes)[0];
    if (smallest === undefined) return "not_observed";
    let limited = 0;
    const counting: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (response.status === 429) limited += 1;
      return response;
    };
    const quota = createGoogleHttp({ tokens, deps: { fetch: counting }, maxAnswerBytes: MAX_DOCUMENT_ANSWER_BYTES });
    const end = Date.now() + PACE_RUN_MS;
    while (Date.now() < end) {
      await paced();
      try {
        await readDocument(quota, smallest[0]);
      } catch (error) {
        if (!(error instanceof GoogleError) || error.code !== "rate_limited") throw error;
      }
    }
    return [limited === 0 ? "yes" : "no", limited];
  });

  await check("drive_bad_change_token_status", async () => {
    try {
      await get(driveUrl("changes", feedParams("made-up-check-token")));
      return ["no", 200];
    } catch (error) {
      const status = statusOf(error);
      if (status === undefined) throw error;
      return [status === 400 || status === 404 || status === 410 ? "yes" : "no", status];
    }
  });

  // The feed: one change at a time, each from a token taken just before it.
  const edited = await step("drive_feed_edit", () =>
    watch(get, "Now, in the browser: type a word into one Google Doc in My Drive.", (changes, before) =>
      fileEntries(changes).some(
        (one) => one.file.mimeType === GOOGLE_DOC && one.file.modifiedTime !== before.get(one.fileId)?.modifiedTime,
      ),
    ),
  );
  await check("drive_change_reports_edit", () => {
    if (edited === null) return "not_observed";
    const found = fileEntries(edited.changes).some(
      (one) =>
        one.file.mimeType === GOOGLE_DOC && one.file.modifiedTime !== edited.before.get(one.fileId)?.modifiedTime,
    );
    return [found ? "yes" : "no", edited.changes.length];
  });

  // For information: whether only opening a document makes a change entry. Its wait is the
  // whole of FEED_WAIT_MS when none comes.
  const viewed = await step("drive_feed_view", () =>
    watch(
      get,
      "Now open one Google Doc in My Drive and read it, without changing anything, then close it.",
      (changes) => changes.length > 0,
    ),
  );
  await check("drive_view_makes_change", () =>
    viewed === null ? "not_observed" : [viewed.changes.length > 0 ? "yes" : "no", viewed.changes.length],
  );

  const renamed = (watched: Watched): (Change & { file: Known }) | undefined =>
    fileEntries(watched.changes).find((one) => {
      const was = watched.before.get(one.fileId);
      return was !== undefined && was.name !== one.file.name;
    });
  const rename = await step("drive_feed_rename", () =>
    watch(
      get,
      "Now rename one file (not a folder) in My Drive.",
      (changes, before) => renamed({ before, changes }) !== undefined,
    ),
  );
  await check("drive_rename_changes_modified_time", () => {
    const one = rename === null ? undefined : renamed(rename);
    if (rename === null || one === undefined) return "not_observed";
    return one.file.modifiedTime !== rename.before.get(one.fileId)?.modifiedTime ? "yes" : "no";
  });

  const movedFile = (watched: Watched): boolean =>
    fileEntries(watched.changes).some((one) => {
      const was = watched.before.get(one.fileId);
      return (
        was !== undefined && !one.file.trashed && was.parents[0] !== one.file.parents[0] && one.file.parents.length > 0
      );
    });
  const move = await step("drive_feed_move", () =>
    watch(get, "Now move one file (not a folder) from one folder of My Drive into another.", (changes, before) =>
      movedFile({ before, changes }),
    ),
  );
  await check("drive_change_reports_move_with_new_parent", () =>
    move === null ? "not_observed" : [movedFile(move) ? "yes" : "no", move.changes.length],
  );

  const movedFolder = (watched: Watched): (Change & { file: Known }) | undefined =>
    folderEntries(watched.changes).find((one) => {
      const was = watched.before.get(one.fileId);
      return was !== undefined && !one.file.trashed && was.parents[0] !== one.file.parents[0];
    });
  const folderMove = await step("drive_feed_folder_move", () =>
    watch(
      get,
      "Now move one folder that holds a file, and a folder with a file in it, into another folder of My Drive.",
      (changes, before) => movedFolder({ before, changes }) !== undefined,
      { settle: true },
    ),
  );
  const folderMoved = folderMove === null ? undefined : movedFolder(folderMove);
  // The count is the entries for anything inside the moved folder.
  await check("drive_folder_move_reports_the_folder_only", () => {
    if (folderMove === null) return "not_observed";
    if (folderMoved === undefined) return ["no", 0];
    const within = inside(folderMove.before, folderMoved.fileId);
    if (within.size === 0) return "not_observed";
    const count = folderMove.changes.filter((one) => within.has(one.fileId)).length;
    return [count === 0 ? "yes" : "no", count];
  });
  // For information: yes when the folder's entry does not name its old parent.
  await check("drive_folder_change_names_old_parent_absent", () => {
    if (folderMove === null || folderMoved === undefined) return "not_observed";
    const old = folderMove.before.get(folderMoved.fileId)?.parents[0];
    if (old === undefined) return "not_observed";
    return folderMoved.file.parents.includes(old) ? "no" : "yes";
  });

  // The count is the files inside it that do not.
  const trashedFolder = (changes: Change[]): Change | undefined =>
    changes.find((one) => one.file?.folder && one.file.trashed);
  const folderTrash = await step("drive_feed_folder_trash", () =>
    watch(
      get,
      "Now move one folder that holds at least one file to the trash.",
      (changes) => trashedFolder(changes) !== undefined,
    ),
  );
  await check("drive_trashed_folder_marks_children_trashed", async () => {
    const folder = folderTrash === null ? undefined : trashedFolder(folderTrash.changes);
    if (folderTrash === null || folder === undefined) return "not_observed";
    const files = [...inside(folderTrash.before, folder.fileId)].filter(
      (id) => folderTrash.before.get(id)?.folder === false,
    );
    let [marked, unmarked] = [0, 0];
    for (const id of files) {
      try {
        const body = await get(driveUrl(`files/${encodeURIComponent(id)}`, [["fields", FILE_FIELDS]]));
        if (isRecord(body) && body.trashed === true) marked += 1;
        else unmarked += 1;
      } catch (error) {
        if (!(error instanceof GoogleError) || error.code !== "not_found") throw error;
      }
    }
    if (marked + unmarked === 0) return "not_observed";
    return [unmarked === 0 ? "yes" : "no", unmarked];
  });

  const trashedFile = (changes: Change[]): Change | undefined => fileEntries(changes).find((one) => one.file.trashed);
  const fileTrash = await step("drive_feed_trash", () =>
    watch(
      get,
      "Now move one file (not a folder) to the trash.",
      (changes) => trashedFile(changes) !== undefined || changes.some((one) => one.removed),
    ),
  );
  const trashedId = fileTrash === null ? undefined : trashedFile(fileTrash.changes)?.fileId;
  await check("drive_change_reports_trash_as_trashed_file", () =>
    fileTrash === null ? "not_observed" : [trashedId !== undefined ? "yes" : "no", fileTrash.changes.length],
  );

  const removal = (changes: Change[]): Change | undefined =>
    changes.find((one) => one.removed && (trashedId === undefined || one.fileId === trashedId)) ??
    changes.find((one) => one.removed);
  const deletion = await step("drive_feed_delete", () =>
    watch(
      get,
      "Now open the trash and delete forever the file you just trashed.",
      (changes) => removal(changes) !== undefined,
    ),
  );
  const deletedId = deletion === null ? undefined : removal(deletion.changes)?.fileId;
  await check("drive_change_reports_removed_on_delete", () =>
    deletion === null ? "not_observed" : [deletedId !== undefined ? "yes" : "no", deletion.changes.length],
  );
  // The count is the status files.get answered.
  await check("drive_files_get_deleted_answers_404", async () => {
    if (deletedId === undefined) return "not_observed";
    try {
      await get(driveUrl(`files/${encodeURIComponent(deletedId)}`, [["fields", FILE_FIELDS]]));
      return ["no", 200];
    } catch (error) {
      const status = statusOf(error);
      if (status === undefined) throw error;
      return [status === 404 ? "yes" : "no", status];
    }
  });

  const unshared = (changes: Change[], before: Snapshot): boolean =>
    changes.some((one) => one.removed && before.get(one.fileId)?.ownedByMe === false);
  const unshare = await step("drive_feed_unshare", () =>
    watch(
      get,
      "In the second throwaway account, stop sharing with this account one file it shared directly.",
      unshared,
      { optional: true },
    ),
  );
  await check("drive_change_reports_removed_on_unshare", () =>
    unshare === null
      ? "not_observed"
      : [unshared(unshare.changes, unshare.before) ? "yes" : "no", unshare.changes.length],
  );

  // For information: whether a change of owner changes modifiedTime, which the revision tag holds.
  const transferred = (watched: Watched): (Change & { file: Known }) | undefined =>
    fileEntries(watched.changes).find((one) => {
      const was = watched.before.get(one.fileId);
      return was !== undefined && was.ownedByMe !== one.file.ownedByMe;
    });
  const transfer = await step("drive_feed_owner_transfer", () =>
    watch(
      get,
      "Make the second throwaway account the owner of one file this account owns (share it, transfer ownership, and accept in the second account).",
      (changes, before) => transferred({ before, changes }) !== undefined,
      { optional: true },
    ),
  );
  await check("drive_owner_transfer_changes_modified_time", () => {
    const one = transfer === null ? undefined : transferred(transfer);
    if (transfer === null || one === undefined) return "not_observed";
    return one.file.modifiedTime !== transfer.before.get(one.fileId)?.modifiedTime ? "yes" : "no";
  });

  say(
    "Done. Run this script again with --drive in eight days, with the same two variables set, to check that the Drive token still refreshes.",
  );
  return 0;
}
