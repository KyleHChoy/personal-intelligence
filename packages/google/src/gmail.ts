import type {
  ChangeKind,
  HttpPort,
  HttpResponse,
  RawItem,
  SkippedItem,
  SourceAccount,
  SourceDeletion,
  Timestamp,
} from "@intelligence/contracts";
import { gmailItemId, parseGmailItemId } from "@intelligence/personal-core";
import {
  type ConnectorOptions,
  derivingLabels,
  type GmailMessage,
  gmailItem,
  isConditionalLabels,
  type PersonalPage,
} from "@intelligence/personal-core/items";
import { type MailHistory, type MailList, type MailPass, type MailPhase, mailCursor } from "./cursor.ts";
import {
  apiGet,
  bad,
  failed,
  type GoogleDeps,
  GoogleError,
  isRecord,
  MAX_PAGE_BYTES,
  optionalToken,
  type RateLimitReason,
  record,
  text,
  withDefaults,
} from "./http.ts";
import { fullMessage, HEADERS, headersMessage, labelsOf, list } from "./message.ts";

// The Gmail phases: a listing, then history. Every request is a read; nothing here asks for an
// attachment, and nothing a message says is followed.
//
// The listing's states. A `null` cursor reads the profile and starts a first listing: the sent
// pass, then the rest pass, each over the window; the rest pass's last page ends it `window`,
// and history follows at the profile's id. The reset cursor, or an expired history id, starts a
// reconciling listing: the same two passes, then the older pass, which names what is older than
// the window by id alone and fetches nothing; its last page ends it `complete`, and history
// follows. A page that stops at the byte bound keeps the ids it did not fetch as `pending` in
// its cursor, and the next call fetches them first, before it lists again.

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
// A page asks for at most this many messages to fetch, or ids on the pass that fetches none.
const MAX_FETCHED = 50;
const MAX_IDS = 500;
// Google allows one user 6,000 units a minute, and charges 20 for messages.get, 40 for threads.get,
// 5 for messages.list, 2 for history.list and 1 for the profile
// (https://developers.google.com/workspace/gmail/api/reference/quota). Each request waits this many
// ms for each unit the one before it cost: about 5,455 units a minute, nine tenths of the quota,
// which leaves room for anything else that reads the same mailbox.
export const GMAIL_MS_PER_UNIT = 11;
export const UNITS = { get: 20, thread: 40, list: 5, history: 2, profile: 1 } as const;
export const GMAIL_FETCHES_AT_ONCE = 4;
export const GMAIL_RATE_LIMIT_WAIT_MS = 5 * 60_000;
const PAUSE_MS = 30_000;
const RECOVER_MS = 2 * 60_000;
const MOST_SLOWDOWN = 8;
const DAY_SECONDS = 86_400;
// What history is asked for: additions, permanent deletions, and label changes.
const HISTORY_TYPES = ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"];

const unique = (values: string[]): string[] => [...new Set(values)];

export function url(path: string, params: [string, string][]): string {
  const built = new URL(`${API}/${path}`);
  for (const [name, value] of params) built.searchParams.append(name, value);
  return built.toString();
}

export const paging = (most: number, pageToken: string | undefined): [string, string][] => [
  ["maxResults", String(most)],
  ...(pageToken === undefined ? [] : [["pageToken", pageToken] satisfies [string, string]]),
];

export async function read(http: HttpPort, at: string, deps: GoogleDeps): Promise<HttpResponse> {
  try {
    return await apiGet(http, at, deps);
  } catch (error) {
    if (error instanceof GoogleError && error.code === "too_large") throw new GoogleError("bad_response", error.status);
    throw error;
  }
}

export async function gmailProfile(
  http: HttpPort,
  deps: GoogleDeps = {},
): Promise<{ address: string; historyId: string }> {
  const { body } = await read(http, `${API}/profile`, deps);
  if (!isRecord(body) || !text(body.emailAddress) || !text(body.historyId)) throw bad();
  return { address: body.emailAddress, historyId: body.historyId };
}

// A pending alias is not the owner's until they verify it.
export type SendAsAddress = { address: string; primary: boolean };
export async function gmailSendAs(http: HttpPort, deps: GoogleDeps = {}): Promise<SendAsAddress[]> {
  const { body } = await read(http, `${API}/settings/sendAs`, deps);
  if (!isRecord(body) || (body.sendAs !== undefined && !Array.isArray(body.sendAs))) throw bad();
  const entries: unknown[] = (body.sendAs as unknown[] | undefined) ?? [];
  const addresses = entries.flatMap((entry) => {
    if (!isRecord(entry) || !text(entry.sendAsEmail)) throw bad();
    const verified = entry.isPrimary === true || entry.verificationStatus === "accepted";
    return verified ? [{ address: entry.sendAsEmail.trim().toLowerCase(), primary: entry.isPrimary === true }] : [];
  });
  const primary = new Set(addresses.filter((one) => one.primary).map((one) => one.address));
  return unique(addresses.map((one) => one.address))
    .sort()
    .map((address) => ({ address, primary: primary.has(address) }));
}

// With no window there is no `after:`.
function passQuery(pass: MailPass, after: number | undefined): [string, string][] {
  const since = after === undefined ? [] : [`after:${after}`];
  if (pass === "sent")
    return [
      ["labelIds", "SENT"],
      ["q", [...since, "-in:spam"].join(" ")],
    ];
  if (pass === "rest") return [["q", [...since, "-in:sent", "-in:spam", "-category:promotions"].join(" ")]];
  // The older pass overlaps the window by a day, whatever way Gmail rounds.
  return [["q", `before:${(after ?? 0) + DAY_SECONDS} -in:spam`]];
}

// What a page fetched. `gone` holds the ids of messages no longer there; `room` how many more
// it may fetch; `bytes` the length of its items' payloads.
// `clock` is the page's, read once: an epoch internalDate's Date header is checked against it.
type Fetched = {
  items: RawItem[];
  skipped: SkippedItem[];
  gone: string[];
  room: number;
  bytes: number;
  clock: Timestamp;
};
const fetchedFor = (limit: number, clock: Timestamp): Fetched => ({
  items: [],
  skipped: [],
  gone: [],
  room: Math.min(limit, MAX_FETCHED),
  bytes: 0,
  clock,
});

// Each request takes its turn, in the order asked, and starts no sooner than the units the request
// before it cost allow. A rate limit Google keeps up through the port's retries pauses every
// request for PAUSE_MS and halves the pace, and the request is asked again; the pace doubles back
// after each RECOVER_MS without one. Once the pauses, with the calls that met them, would pass
// GMAIL_RATE_LIMIT_WAIT_MS, the call fails `rate_limited`, and so does every later call: the run is
// over for this account, and its cursor stays where its last committed page left it.
export function gmailPace({ now, sleep, onRateLimit }: Required<GoogleDeps>) {
  let next = -Infinity;
  let slowdown = 1;
  let changed = 0;
  let paused = -Infinity;
  let waited = 0;
  let over: GoogleError | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  function turn(units: number): Promise<number> {
    const mine = queue.then(async () => {
      if (slowdown > 1 && now() - changed >= RECOVER_MS) [slowdown, changed] = [slowdown / 2, now()];
      // A pause that begins while this turn waits moves `next`, and the turn waits for it too.
      for (let until = next; until > now(); until = next) {
        await sleep(until - now());
        if (next === until) break;
      }
      const start = now();
      next = start + units * GMAIL_MS_PER_UNIT * slowdown;
      return start;
    });
    queue = mine;
    return mine;
  }

  // A rate limit met by a call that started at `start`. A call that started before the last
  // pause began was paid for by it, and is only asked again.
  function limited(error: GoogleError, start: number): void {
    // The run is already over for this account: reported once, and the pace stays as it was.
    if (over !== null) throw over;
    if (start < paused) return;
    const reason: RateLimitReason = error.reason ?? "too_many_requests";
    const lost = now() - start + PAUSE_MS;
    if (waited + lost > GMAIL_RATE_LIMIT_WAIT_MS) {
      over = error;
      onRateLimit(reason, 0);
      throw error;
    }
    waited += lost;
    paused = now();
    [slowdown, changed] = [Math.min(slowdown * 2, MOST_SLOWDOWN), paused];
    next = Math.max(next, paused + PAUSE_MS);
    onRateLimit(reason, PAUSE_MS);
  }

  return async function call<T>(units: number, send: () => Promise<T>): Promise<T> {
    for (;;) {
      if (over !== null) throw over;
      const start = await turn(units);
      try {
        return await send();
      } catch (error) {
        if (!(error instanceof GoogleError) || error.code !== "rate_limited") throw error;
        limited(error, start);
      }
    }
  };
}

type Paced = (units: number, at: string) => Promise<HttpResponse>;
type Call = ReturnType<typeof gmailPace>;

const deleted = (account: SourceAccount, ids: string[], at: Timestamp): SourceDeletion[] =>
  ids.map((id) => ({ sourceAccount: account.id, sourceItemId: gmailItemId(id), deletedAt: at }));

// The messages.get side of a connector: one message, whole or by its headers, and a page's fetches.
function gmailFetcher(http: HttpPort, deps: GoogleDeps, call: Call) {
  // One messages.get, paced, or why there is no message: it answered 404 or a plain 403, or its
  // answer failed its checks. Any other failure fails the page, a token that could not be had
  // included: the port gives that no status.
  async function asked(
    id: string,
    format: "full" | "metadata",
    clock: Timestamp,
  ): Promise<GmailMessage | "gone" | "forbidden" | "unsupported"> {
    const params: [string, string][] = [
      ["format", format],
      ...(format === "full" ? [] : HEADERS.map((name) => ["metadataHeaders", name] satisfies [string, string])),
    ];
    let body: unknown;
    try {
      ({ body } = await call(UNITS.get, () => apiGet(http, url(`messages/${encodeURIComponent(id)}`, params), deps)));
    } catch (error) {
      if (failed(error, "not_found", 404)) return "gone";
      if (failed(error, "forbidden", 403)) return "forbidden";
      throw error;
    }
    // One message whose shape is refused is that message's alone: it is skipped, and the rest
    // of its page is still handed over. Failing the page would stop the account at it for good.
    try {
      return format === "full" ? fullMessage(body, id, clock) : headersMessage(body, id, clock);
    } catch (error) {
      if (failed(error, "bad_response")) return "unsupported";
      throw error;
    }
  }

  // Only a second answer over the bound skips it.
  async function get(
    id: string,
    clock: Timestamp,
  ): Promise<GmailMessage | "gone" | "forbidden" | "unsupported" | "too_large"> {
    try {
      return await asked(id, "full", clock);
    } catch (error) {
      if (!failed(error, "too_large")) throw error;
    }
    try {
      return await asked(id, "metadata", clock);
    } catch (error) {
      if (failed(error, "too_large")) return "too_large";
      throw error;
    }
  }

  // A fetch already started past the bound is dropped, and asked for again by the next call, so
  // what a page holds never depends on how many fetches run at once. No fetch outlives its page.
  async function fetchSome(
    ids: string[],
    account: SourceAccount,
    changeKind: ChangeKind,
    into: Fetched,
  ): Promise<string[]> {
    const asked: ReturnType<typeof get>[] = [];
    try {
      for (const [at, id] of ids.entries()) {
        if (into.bytes > MAX_PAGE_BYTES || into.room === 0) return ids.slice(at);
        for (const ahead of ids.slice(asked.length, at + Math.min(GMAIL_FETCHES_AT_ONCE, into.room))) {
          const one = get(ahead, into.clock);
          // Its failure is read when its turn comes; until then it must not count as unhandled.
          one.catch(() => {});
          asked.push(one);
        }
        into.room -= 1;
        const got = await asked[at];
        if (got === "gone") into.gone.push(id);
        else if (typeof got === "string") into.skipped.push({ sourceItemId: gmailItemId(id), reason: got });
        else if (got !== undefined) {
          const item = gmailItem(got, { sourceAccount: account.id, changeKind });
          into.items.push(item);
          into.bytes += item.payload.length;
        }
      }
      return [];
    } finally {
      await Promise.allSettled(asked);
    }
  }

  return fetchSome;
}

// Where a listing goes once a pass's page is done, with `pageToken` the token its answer
// carried. A pass's last page leads to the next pass; the listing's last page to history.
function after(
  at: MailList,
  pageToken: string | undefined,
): { next: MailPhase; more: boolean; ended?: "window" | "complete" } {
  const base = {
    phase: "list",
    start: at.start,
    reconcile: at.reconcile,
    ...(at.after === undefined ? {} : { after: at.after }),
  } as const;
  if (pageToken !== undefined) return { next: { ...base, pass: at.pass, pageToken }, more: true };
  if (at.pass === "sent") return { next: { ...base, pass: "rest" }, more: true };
  // A reconciling listing over a window names what is older; one with no window has seen it all.
  if (at.pass === "rest" && at.reconcile && at.after !== undefined)
    return { next: { ...base, pass: "older" }, more: true };
  const history: MailPhase = { phase: "history", historyId: at.start };
  return { next: history, more: false, ended: at.reconcile ? "complete" : "window" };
}

// A thread answer that is gone or malformed adds nothing.
async function threadIds(paced: Paced, threads: string[], onPage: Set<string>, asked: Set<string>): Promise<string[]> {
  const found: string[] = [];
  for (const thread of threads) {
    if (asked.has(thread)) continue;
    asked.add(thread);
    let body: unknown;
    try {
      ({ body } = await paced(UNITS.thread, url(`threads/${encodeURIComponent(thread)}`, [["format", "minimal"]])));
    } catch (error) {
      if (failed(error, "not_found", 404)) continue;
      throw error;
    }
    let conditional: string[];
    try {
      conditional = list(record(body).messages).flatMap((one) => {
        const { id, labelIds } = record(one);
        if (!text(id)) throw bad();
        return isConditionalLabels(labelsOf(labelIds)) ? [id] : [];
      });
    } catch (error) {
      if (failed(error, "bad_response")) continue;
      throw error;
    }
    for (const id of conditional) {
      if (onPage.has(id)) continue;
      onPage.add(id);
      found.push(id);
    }
  }
  return found;
}

// What a history page leaves after its added messages (`afterAdded` in gmailPages).
type Rest = { pending: string[] } & Pick<MailHistory, "sent" | "seen" | "threads">;

// What a history page's answer says: its history id, the ids added and deleted, the added ones the
// owner sent, the relabelled ones, and the next page's token.
function historyChanges(answer: unknown) {
  const body = record(answer);
  const historyId = body.historyId;
  if (!text(historyId)) throw bad();
  const records = list(body.history).map(record);
  // Never from `messages`: only what was added, deleted or relabelled, each id once, in
  // first-seen order.
  const idOf = (entry: unknown): string => {
    const { id } = record(record(entry).message);
    if (!text(id)) throw bad();
    return id;
  };
  const idsOf = (key: "messagesAdded" | "messagesDeleted"): string[] =>
    unique(records.flatMap((one) => list(one[key]).map(idOf)));
  const [added, removed] = [idsOf("messagesAdded"), idsOf("messagesDeleted")];
  const sent = new Set(
    records.flatMap((one) =>
      list(one.messagesAdded).flatMap((entry) => {
        const labels = labelsOf(record(record(entry).message).labelIds);
        return labels.includes("SENT") && !labels.includes("SPAM") ? [idOf(entry)] : [];
      }),
    ),
  );
  // A label change counts only when it touches a deriving label. Any other (read, starred, a
  // user label) changes nothing derived, and its message is not fetched.
  const relabelled = unique(
    records.flatMap((one) =>
      [...list(one.labelsAdded), ...list(one.labelsRemoved)].flatMap((entry) => {
        const id = idOf(entry);
        return derivingLabels(labelsOf(record(entry).labelIds)).length > 0 ? [id] : [];
      }),
    ),
  );
  const pageToken = optionalToken(body.nextPageToken);
  return { historyId, added, removed, sent, relabelled, pageToken };
}

// One connector's handles for its pages: the Gmail pace, the one thing kept between calls; every
// request but messages.get, paced by what it costs; the fetcher of messages; and the window a
// listing starts from.
type GmailRun = {
  readonly http: HttpPort;
  readonly deps: GoogleDeps;
  readonly since: string | undefined;
  readonly call: ReturnType<typeof gmailPace>;
  readonly paced: Paced;
  readonly fetchSome: ReturnType<typeof gmailFetcher>;
};

// One page of a listing. A cursor with pending ids fetches them and lists nothing.
async function listing(
  run: GmailRun,
  account: SourceAccount,
  at: MailList,
  first: boolean,
  limit: number,
  clock: Timestamp,
): Promise<PersonalPage> {
  const fetched = fetchedFor(limit, clock);
  const page = (left: string[], pageToken: string | undefined, listed?: string[]): PersonalPage => {
    const { pending: _pending, pageToken: _sent, ...stood } = at;
    const { next, more, ended } =
      left.length > 0
        ? {
            next: { ...stood, ...(pageToken === undefined ? {} : { pageToken }), pending: left } as MailList,
            more: true,
          }
        : after(at, pageToken);
    return {
      items: fetched.items,
      deletions: deleted(account, fetched.gone, clock),
      skipped: fetched.skipped,
      more,
      listing: { first, ...(ended === undefined ? {} : { ended }) },
      ...(listed === undefined ? {} : { listed }),
      next: mailCursor(next),
    };
  };

  if (at.pending !== undefined)
    return page(await run.fetchSome(at.pending, account, "backfill", fetched), at.pageToken);
  const most = Math.min(limit, at.pass === "older" ? MAX_IDS : MAX_FETCHED);
  const body = record(
    (
      await run.paced(
        UNITS.list,
        url("messages", [["includeSpamTrash", "true"], ...passQuery(at.pass, at.after), ...paging(most, at.pageToken)]),
      )
    ).body,
  );
  const ids = list(body.messages).map((one) => {
    const { id } = record(one);
    if (!text(id)) throw bad();
    return id;
  });
  const pageToken = optionalToken(body.nextPageToken);
  // The older pass names its ids and fetches none of them.
  if (at.pass === "older") return page([], pageToken, ids.map(gmailItemId));
  return page(await run.fetchSome(ids, account, "backfill", fetched), pageToken);
}

// A listing's first page: the profile's history id is where history takes over.
async function begin(
  run: GmailRun,
  account: SourceAccount,
  reconcile: boolean,
  limit: number,
  clock: Timestamp,
): Promise<PersonalPage> {
  const start = (await run.call(UNITS.profile, () => gmailProfile(run.http, run.deps))).historyId;
  const window = run.since === undefined ? {} : { after: Math.floor(Date.parse(run.since) / 1000) };
  return listing(run, account, { phase: "list", start, pass: "sent", reconcile, ...window }, true, limit, clock);
}

// While added ids are left to fetch, all of it waits in `pending` behind them, with the left ids
// the owner sent in `sent`, so their threads are still looked up once they are fetched, and with
// them the ids the page handled and the threads it asked for, so its rest fetches and asks for
// neither again.
async function afterAdded(
  run: GmailRun,
  account: SourceAccount,
  fetched: Fetched,
  left: string[],
  sent: Set<string>,
  onPage: Set<string>,
  asked: Set<string>,
  then: string[],
): Promise<Rest> {
  const threads = unique(
    fetched.items.flatMap((one) => (sent.has(parseGmailItemId(one.sourceItemId) ?? "") ? (one.threadId ?? []) : [])),
  );
  const rest = [...(await threadIds(run.paced, threads, onPage, asked)), ...then];
  if (left.length === 0) return { pending: await run.fetchSome(rest, account, "live", fetched) };
  const pending = [...left, ...rest];
  const stillSent = left.filter((id) => sent.has(id));
  if (stillSent.length === 0) return { pending };
  const seen = [...onPage].filter((id) => !pending.includes(id));
  return {
    pending,
    sent: stillSent,
    ...(seen.length > 0 ? { seen } : {}),
    ...(asked.size > 0 ? { threads: [...asked] } : {}),
  };
}

async function history(
  run: GmailRun,
  account: SourceAccount,
  at: MailHistory,
  limit: number,
  clock: Timestamp,
): Promise<PersonalPage> {
  const fetched = fetchedFor(limit, clock);
  const page = (base: MailHistory, rest: Rest, removed: string[] = [], added = 0): PersonalPage => ({
    added,
    items: fetched.items,
    deletions: deleted(account, unique([...fetched.gone, ...removed]), clock),
    skipped: fetched.skipped,
    more: rest.pending.length > 0 || base.pageToken !== undefined,
    next: mailCursor(rest.pending.length > 0 ? { ...base, ...rest } : base),
  });

  if (at.pending !== undefined) {
    const { pending, sent = [], seen = [], threads = [], ...base } = at;
    const left = await run.fetchSome(pending, account, "live", fetched);
    return page(
      base,
      await afterAdded(
        run,
        account,
        fetched,
        left,
        new Set(sent),
        new Set([...seen, ...pending]),
        new Set(threads),
        [],
      ),
    );
  }

  const params: [string, string][] = [
    ["startHistoryId", at.historyId],
    ...HISTORY_TYPES.map((type) => ["historyTypes", type] satisfies [string, string]),
    ...paging(Math.min(limit, MAX_FETCHED), at.pageToken),
  ];
  let answer: unknown;
  try {
    answer = (await run.paced(UNITS.history, url("history", params))).body;
  } catch (error) {
    // A reconciling listing starts in this same call.
    if (failed(error, "not_found", 404)) return begin(run, account, true, limit, clock);
    throw error;
  }
  const { historyId, added, removed, sent, relabelled, pageToken } = historyChanges(answer);
  const base: MailHistory =
    pageToken === undefined
      ? { phase: "history", historyId }
      : { phase: "history", historyId: at.historyId, pageToken };

  // The added messages first. Then, for those the owner sent, their threads' conditional
  // messages; then each relabelled message not already on the page, fetched as it is now.
  const left = await run.fetchSome(added, account, "live", fetched);
  const onPage = new Set([...added, ...relabelled]);
  return page(
    base,
    await afterAdded(
      run,
      account,
      fetched,
      left,
      sent,
      onPage,
      new Set(),
      relabelled.filter((id) => !added.includes(id)),
    ),
    removed,
    added.length,
  );
}

export function gmailPages(
  http: HttpPort,
  options: ConnectorOptions,
  deps: GoogleDeps,
): (account: SourceAccount, phase: MailPhase | null, limit: number) => Promise<PersonalPage> {
  const defaults = withDefaults(deps);
  const { now } = defaults;
  const call = gmailPace(defaults);
  const run: GmailRun = {
    http,
    deps,
    since: options.since,
    call,
    paced: (units, at) => call(units, () => read(http, at, deps)),
    fetchSome: gmailFetcher(http, deps, call),
  };
  return (account, phase, limit) => {
    // The clock a deletion is dated by, read once per page.
    const clock = new Date(now()).toISOString();
    if (phase === null) return begin(run, account, false, limit, clock);
    // A stored reset: a reconciling listing, over the window of the connector that reads it.
    if (phase.phase === "reset") return begin(run, account, true, limit, clock);
    return phase.phase === "list"
      ? listing(run, account, phase, false, limit, clock)
      : history(run, account, phase, limit, clock);
  };
}
