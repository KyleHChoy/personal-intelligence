import type {
  ChangeKind,
  ConnectorCursor,
  RawItem,
  SourceAccount,
  SourceAccountId,
  SourceDeletion,
  Timestamp,
} from "@intelligence/contracts";
import { gmailItemId, parseGmailItemId } from "../item-id.ts";
import { gmailItem } from "../items/builders.ts";
import { derivingLabels, isConditionalLabels, isJunk, ownerSent } from "../items/bulk.ts";
import type { ConnectorOptions, GmailMessage, PersonalConnector, PersonalPage } from "../items/types.ts";
import { callPlan, coded, decodeCursor, encodeCursor, type FailureKind, pageLimit, windowStart } from "./support.ts";
import type { WorldAccount } from "./world.ts";

// A Gmail mailbox in memory that hands over the pages the Google connector would, with items from
// the same builder. Deterministic: no random value, and its clock is the `now` it is given.
//
// A listing runs in passes, as the connector's does: the window's sent mail, then the rest of
// the window that is not junk; a reconciling listing (from the reset cursor or an expired
// history id) then names what is older than the window by id alone, and fetches none of it.
// A first listing ends `window`, a reconciling one `complete`. History hands over what was
// added and what had a deriving label changed, junk included, and, after an added message the
// owner sent, the conditional messages of its thread. With `pageBytes`, a page stops at that
// many bytes of payloads and keeps the ids it did not hand over pending in its cursor.

export type FakeGmail = {
  profile(): Promise<{ address: string }>;
  connector(sourceAccount: SourceAccountId, options: ConnectorOptions): PersonalConnector;
  add(message: GmailMessage): void;
  trash(id: string): void;
  // Sets the message's labels. History reports the change.
  relabel(id: string, labelIds: string[]): void;
  deletePermanently(id: string): void;
  // History ids below this one are no longer kept.
  expireHistoryBefore(historyId: string): void;
  // The message is refused when it is read: a `skipped` entry on the page that would carry it.
  forbid(id: string): void;
  // The message is gone when it is read: a deletion on the page that would carry it.
  goneAtGet(id: string): void;
  // The message is read by its headers alone, unreadable, as the connector reads one too large.
  tooLarge(id: string): void;
  failAt(n: number, kind: FailureKind): void;
  // Every `profile` and `listChanges` call so far.
  readonly calls: number;
  // The ids of the messages handed over as items, in order.
  readonly fetched: string[];

  // The HTTP side `pi send` reaches: Google's token URL, which answers a refresh
  // with an access token for the send grant; the send URL, which parses the raw message, stores
  // it under SENT with a new id on the thread named or a new one, and answers the two ids; and
  // the revoke URL, which records the token it was given and answers 200. Any other URL is
  // refused. Every request is recorded, whatever it was.
  fetch: typeof fetch;
  readonly requests: { method: string; url: string; body: string }[];
  readonly revoked: string[];
  // The next send's answer: the status alone, nothing stored; a 200 with this body, stored; the
  // message stored and the request then failed; the message stored and the answer kept until
  // `releaseSend` (or the request's abort).
  failNextSend(status: number): void;
  answerNextSend(body: string): void;
  dropNextSendAnswer(): void;
  holdNextSend(): void;
  releaseSend(): void;
  // An inbound message from `from` on the thread, to the account's address. Its id.
  addReply(threadId: string, from: string): string;
  // A copy of a message the mailbox holds.
  message(id: string): GmailMessage | undefined;
};

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
// The send grant's scopes in the forms Google's token answer names them (google's
// grantedScopesFor("send")).
const SEND_SCOPES = "https://www.googleapis.com/auth/gmail.send openid https://www.googleapis.com/auth/userinfo.email";

type NextSend =
  | { kind: "fail"; status: number }
  | { kind: "answer"; body: string }
  | { kind: "drop" }
  | { kind: "hold" };

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const bodyText = (body: unknown): string =>
  typeof body === "string"
    ? body
    : body instanceof URLSearchParams
      ? body.toString()
      : body === undefined || body === null
        ? ""
        : String(body);

// One raw message as renderMessage writes it: CRLF header lines, folded lines unfolded, encoded
// words decoded, and a base64 text/plain body whose CRLFs become line feeds.
function parseRaw(raw: string): { headers: { name: string; value: string }[]; text: string } {
  const message = Buffer.from(raw, "base64url").toString("utf8");
  const split = message.indexOf("\r\n\r\n");
  if (split < 0) throw new Error("no header block");
  const decodeWords = (value: string): string =>
    value.replace(/=\?UTF-8\?B\?([A-Za-z0-9+/=]*)\?=(?:\s+(?==\?UTF-8\?B\?))?/gi, (_, encoded: string) =>
      Buffer.from(encoded, "base64").toString("utf8"),
    );
  const headers = message
    .slice(0, split)
    .replace(/\r\n(?=[ \t])/g, "")
    .split("\r\n")
    .map((line) => {
      const colon = line.indexOf(":");
      return { name: line.slice(0, colon), value: decodeWords(line.slice(colon + 1).trim()) };
    });
  const text = Buffer.from(message.slice(split + 4).replace(/\s+/g, ""), "base64")
    .toString("utf8")
    .replaceAll("\r\n", "\n");
  return { headers, text };
}

type Pass = "sent" | "rest" | "older";
// A listing: the history id it began at, its pass and how far into it, whether it reconciles,
// its window's start (epoch milliseconds on a whole second; none for a connector built with no
// `since`), and the ids a page listed and has not handed over yet.
type ListCursor = {
  fake: "gmail";
  phase: "list";
  start: number;
  pass: Pass;
  offset: number;
  reconcile: boolean;
  after?: number;
  pending?: string[];
};
// History after `start`, of which `taken` changes are already read. A page left in parts keeps
// what is still to hand over, which of those the owner sent, what its earlier parts handled and
// the threads they asked for.
type HistoryCursor = {
  fake: "gmail";
  phase: "history";
  start: number;
  taken: number;
  pending?: string[];
  sent?: string[];
  seen?: string[];
  threads?: string[];
};
// A reset: a reconciling listing starts at the page that reads it.
type ResetCursor = { fake: "gmail"; phase: "reset" };
type Cursor = ListCursor | HistoryCursor | ResetCursor;

// One message the mailbox holds or held: its labels at each history id they changed at, the id
// it was added at, and the one it was permanently deleted at.
type Stored = { message: GmailMessage; labels: { at: number; labelIds: string[] }[]; added: number; deleted?: number };
// What a page has handed over so far, and how much more it may: `room` messages, and while
// `bytes` has not passed the bound.
type Fetched = Pick<PersonalPage, "items" | "skipped"> & { gone: string[]; room: number; bytes: number };

const FIRST_HISTORY_ID = 1000;
const RESET: ResetCursor = { fake: "gmail", phase: "reset" };
const unique = <T>(values: T[]): T[] => [...new Set(values)];
const sentLabels = (markers: string[]): boolean => ownerSent({ markers } as RawItem);
const junkLabels = (markers: string[]): boolean => isJunk({ markers } as RawItem);
const byDate = (a: GmailMessage, b: GmailMessage): number =>
  b.internalDate - a.internalDate || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// `clock` is the time a sent message or an added reply carries; the fake's `now` when not given.
export function fakeGmail(
  account: WorldAccount,
  options: {
    now: Timestamp;
    pageSize?: number;
    order?: "newest" | "shuffled";
    pageBytes?: number;
    clock?: () => number;
  },
): FakeGmail {
  const pageSize = options.pageSize ?? 50;
  const pageBytes = options.pageBytes ?? Number.POSITIVE_INFINITY;
  const mailbox: Stored[] = account.messages.map((message) => ({
    message,
    labels: [{ at: FIRST_HISTORY_ID, labelIds: message.labelIds }],
    added: FIRST_HISTORY_ID,
  }));
  // What history reports: additions (with the labels the message had then), permanent
  // deletions and label changes (with the labels that were added or removed), each under the
  // id it was made at.
  const history: { id: number; kind: "added" | "deleted" | "labels"; message: string; labels: string[] }[] = [];
  let current = FIRST_HISTORY_ID;
  let floor = FIRST_HISTORY_ID;
  const forbidden = new Set<string>();
  const gone = new Set<string>();
  const large = new Set<string>();
  const fetched: string[] = [];
  const plan = callPlan();

  const held = (id: string): Stored | undefined =>
    mailbox.find((stored) => stored.message.id === id && stored.deleted === undefined);
  const stored = (id: string): Stored => {
    const found = held(id);
    if (found === undefined) throw new Error("unknown message");
    return found;
  };
  const labelsAt = (one: Stored, at: number): string[] =>
    one.labels.filter((entry) => entry.at <= at).at(-1)?.labelIds ?? [];

  // One pass of a listing over the mailbox as it was at the history id `start`, newest first by
  // internalDate, then by id. Shuffled, the newest half is interleaved with the oldest half, one
  // from each in turn: a fixed order that is not newest first.
  function passAt(start: number, pass: Pass, after: number | undefined): string[] {
    const inWindow = (message: GmailMessage): boolean => after === undefined || message.internalDate >= after;
    const newest = mailbox
      .filter((one) => one.added <= start && (one.deleted === undefined || one.deleted > start))
      .filter((one) => {
        const labels = labelsAt(one, start);
        if (pass === "sent") return inWindow(one.message) && sentLabels(labels);
        if (pass === "rest") return inWindow(one.message) && !sentLabels(labels) && !junkLabels(labels);
        return !inWindow(one.message) && !labels.includes("SPAM");
      })
      .map((one) => one.message)
      .sort(byDate)
      .map((message) => message.id);
    if (options.order !== "shuffled") return newest;
    const half = Math.ceil(newest.length / 2);
    return newest.slice(0, half).flatMap((id, at) => [id, ...newest.slice(half + at, half + at + 1)]);
  }

  // A message that is gone, named by the id its item was stored under, at the fake's clock.
  const deletions = (source: SourceAccount, ids: string[]): SourceDeletion[] =>
    ids.map((id) => ({ sourceAccount: source.id, sourceItemId: gmailItemId(id), deletedAt: options.now }));

  const fetchedFor = (size: number): Fetched => ({ items: [], skipped: [], gone: [], room: size, bytes: 0 });

  // Each message as it is now, one at a time, until the page has no room or its payloads have
  // passed the bound, after one message at least. One that is gone is a deletion and one that
  // is refused is skipped, as the connector reports a 404 and a 403; one too large is read by
  // its headers. The ids not reached are returned.
  function fetchSome(ids: string[], source: SourceAccount, changeKind: ChangeKind, into: Fetched): string[] {
    for (const [at, id] of ids.entries()) {
      if (into.bytes > pageBytes || into.room === 0) return ids.slice(at);
      into.room -= 1;
      const now = held(id);
      // Gone or deleted wins over forbidden and over too large; forbidden wins over too large.
      if (now === undefined || gone.has(id)) into.gone.push(id);
      else if (forbidden.has(id)) into.skipped.push({ sourceItemId: gmailItemId(id), reason: "forbidden" });
      else {
        const { text: _text, html: _html, attachments: _attachments, ...headers } = now.message;
        const message = large.has(id) ? { ...headers, unreadable: true } : now.message;
        const item = gmailItem(message, { sourceAccount: source.id, changeKind });
        into.items.push(item);
        into.bytes += item.payload.length;
        fetched.push(id);
      }
    }
    return [];
  }

  // The conditional messages of these threads, as they are now, that are not on the page: each
  // thread asked about once on a page.
  function threadIds(threads: string[], onPage: Set<string>, asked: Set<string>): string[] {
    const found: string[] = [];
    for (const thread of threads) {
      if (asked.has(thread)) continue;
      asked.add(thread);
      const members = mailbox.filter(
        (one) =>
          one.deleted === undefined && one.message.threadId === thread && isConditionalLabels(one.message.labelIds),
      );
      for (const { message } of [...members].sort((a, b) => byDate(b.message, a.message))) {
        if (onPage.has(message.id)) continue;
        onPage.add(message.id);
        found.push(message.id);
      }
    }
    return found;
  }

  function connector(sourceAccount: SourceAccountId, built: ConnectorOptions): PersonalConnector {
    const bound = windowStart(built);
    const window = bound === undefined ? {} : { after: Math.floor(Date.parse(bound) / 1000) * 1000 };

    // Where a listing goes after a pass's page that drained it: the next pass, or history.
    function onward(at: ListCursor): { next: Cursor; more: boolean; ended?: "window" | "complete" } {
      const base = {
        fake: "gmail",
        phase: "list",
        start: at.start,
        offset: 0,
        reconcile: at.reconcile,
        ...(at.after === undefined ? {} : { after: at.after }),
      } as const;
      if (at.pass === "sent") return { next: { ...base, pass: "rest" }, more: true };
      if (at.pass === "rest" && at.reconcile && at.after !== undefined)
        return { next: { ...base, pass: "older" }, more: true };
      return {
        next: { fake: "gmail", phase: "history", start: at.start, taken: 0 },
        more: false,
        ended: at.reconcile ? "complete" : "window",
      };
    }

    function listingPage(source: SourceAccount, at: ListCursor, first: boolean, size: number): PersonalPage {
      const into = fetchedFor(size);
      const all = passAt(at.start, at.pass, at.after);
      const { pending: _pending, ...stood } = at;
      let left: string[];
      let listed: string[] | undefined;
      let offset = at.offset;
      if (at.pending !== undefined) left = fetchSome(at.pending, source, "backfill", into);
      else {
        const ids = all.slice(at.offset, at.offset + size);
        offset = at.offset + size;
        // The older pass names its ids and hands none of them over.
        if (at.pass === "older") {
          listed = ids.map(gmailItemId);
          left = [];
        } else left = fetchSome(ids, source, "backfill", into);
      }
      const moved = { ...stood, offset };
      const { next, more, ended } =
        left.length > 0
          ? { next: { ...moved, pending: left }, more: true }
          : offset < all.length
            ? { next: moved, more: true }
            : onward(at);
      return {
        items: into.items,
        deletions: deletions(source, into.gone),
        skipped: into.skipped,
        more,
        listing: { first, ...(ended === undefined ? {} : { ended }) },
        ...(listed === undefined ? {} : { listed }),
        next: encodeCursor(next),
      };
    }

    const begin = (source: SourceAccount, reconcile: boolean, size: number): PersonalPage =>
      listingPage(
        source,
        { fake: "gmail", phase: "list", start: current, pass: "sent", offset: 0, reconcile, ...window },
        true,
        size,
      );

    // After the added messages a page handed over: the conditional messages of the threads of
    // those the owner sent, then `then`. While added ids are left, all of it waits behind them,
    // with what the page handled and the threads it asked for, so its rest repeats neither.
    function afterAdded(
      source: SourceAccount,
      into: Fetched,
      left: string[],
      sent: Set<string>,
      onPage: Set<string>,
      asked: Set<string>,
      then: string[],
    ): Pick<HistoryCursor, "pending" | "sent" | "seen" | "threads"> {
      const threads = unique(
        into.items.flatMap((one) => (sent.has(parseGmailItemId(one.sourceItemId) ?? "") ? (one.threadId ?? []) : [])),
      );
      const rest = [...threadIds(threads, onPage, asked), ...then];
      if (left.length === 0) return { pending: fetchSome(rest, source, "live", into) };
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

    function historyPage(source: SourceAccount, at: HistoryCursor, size: number): PersonalPage {
      const into = fetchedFor(size);
      const page = (
        base: HistoryCursor,
        rest: Pick<HistoryCursor, "pending" | "sent" | "seen" | "threads">,
        removed: string[] = [],
      ): PersonalPage => {
        const pending = rest.pending ?? [];
        const last = base.taken === 0 && base.start === current;
        return {
          items: into.items,
          deletions: deletions(source, unique([...into.gone, ...removed])),
          skipped: into.skipped,
          more: pending.length > 0 || !last,
          next: encodeCursor(pending.length > 0 ? { ...base, ...rest, pending } : base),
        };
      };
      // A page left in parts: what it had still to hand over, and nothing listed again.
      if (at.pending !== undefined) {
        const { pending, sent = [], seen = [], threads = [], ...base } = at;
        const left = fetchSome(pending, source, "live", into);
        return page(
          base,
          afterAdded(source, into, left, new Set(sent), new Set([...seen, ...pending]), new Set(threads), []),
        );
      }
      // Paging is live: the changes are read again on every page.
      const changes = history.filter((change) => change.id > at.start);
      const read = changes.slice(at.taken, at.taken + size);
      const added = unique(read.filter((change) => change.kind === "added").map((change) => change.message));
      const removed = unique(read.filter((change) => change.kind === "deleted").map((change) => change.message));
      const sent = new Set(
        read.filter((change) => change.kind === "added" && sentLabels(change.labels)).map((change) => change.message),
      );
      // A label change is read only when it touches a deriving label, as the connector reads it.
      const relabelled = unique(
        read
          .filter((change) => change.kind === "labels" && derivingLabels(change.labels).length > 0)
          .map((change) => change.message),
      );
      // The last page's `next` stands at the mailbox's current id.
      const base: HistoryCursor =
        at.taken + size >= changes.length
          ? { fake: "gmail", phase: "history", start: current, taken: 0 }
          : { fake: "gmail", phase: "history", start: at.start, taken: at.taken + size };
      const left = fetchSome(added, source, "live", into);
      const onPage = new Set([...added, ...relabelled]);
      return page(
        base,
        afterAdded(
          source,
          into,
          left,
          sent,
          onPage,
          new Set(),
          relabelled.filter((id) => !added.includes(id)),
        ),
        removed,
      );
    }

    return {
      async listChanges(source: SourceAccount, cursor: ConnectorCursor | null, limit: number): Promise<PersonalPage> {
        const failure = plan.next();
        if (source.id !== sourceAccount || source.connector !== "google_mail") throw coded("off_allowlist");
        const size = Math.min(pageLimit(limit), pageSize);
        const state = cursor === null ? null : decodeCursor<Cursor>(cursor, "gmail");
        if (failure !== undefined && !(failure === "not_found" && state?.phase === "history")) throw coded(failure);
        // No cursor: a first listing, over this connector's window.
        if (state === null) return begin(source, false, size);
        // A stored reset: a reconciling listing, over the window of the connector that reads it.
        if (state.phase === "reset") return begin(source, true, size);
        if (state.phase === "list") return listingPage(source, state, false, size);
        // A history id that is no longer kept, or was never issued, has expired: the page is a
        // reconciling listing's first page.
        const expired = failure === "not_found" || state.start < floor || state.start > current;
        return expired ? begin(source, true, size) : historyPage(source, state, size);
      },
      // These accounts have no access list: no call is made.
      syncAccessList: async (_source, cursor) => ({
        changes: [],
        next: cursor ?? encodeCursor({ fake: "gmail-access" }),
      }),
      resetCursor: () => encodeCursor(RESET),
    };
  }

  // The labels added or removed are what history holds of the change. Labels that are the same
  // set as before are no change, and Gmail records none.
  function relabel(id: string, labelIds: string[]): void {
    const one = stored(id);
    const before = one.message.labelIds;
    const changed = [
      ...labelIds.filter((label) => !before.includes(label)),
      ...before.filter((label) => !labelIds.includes(label)),
    ];
    if (changed.length === 0) return;
    current += 1;
    one.message = { ...one.message, labelIds: [...labelIds] };
    one.labels.push({ at: current, labelIds: [...labelIds] });
    history.push({ id: current, kind: "labels", message: id, labels: changed });
  }

  // The send side.
  const clock = options.clock ?? (() => Date.parse(options.now));
  const requests: { method: string; url: string; body: string }[] = [];
  const revoked: string[] = [];
  const issued = new Set<string>();
  const nextSends: NextSend[] = [];
  const holding: (() => void)[] = [];
  let made = 0;
  const newId = (): string => {
    for (;;) {
      made += 1;
      const id = `19e${made.toString(16).padStart(13, "0")}`;
      if (!mailbox.some((one) => one.message.id === id)) return id;
    }
  };

  function add(message: GmailMessage): void {
    // Gmail never uses an id again, so one the mailbox ever held is refused, deleted or not.
    if (mailbox.some((one) => one.message.id === message.id)) throw new Error("the message id was used");
    current += 1;
    mailbox.push({ message, labels: [{ at: current, labelIds: message.labelIds }], added: current });
    history.push({ id: current, kind: "added", message: message.id, labels: [...message.labelIds] });
  }

  // The sent message as Gmail keeps it: From rewritten to the account's address, a Message-ID
  // and a Date of its own, under SENT, on the thread named or a thread of its own.
  function storeSent(raw: string, threadId: string | undefined): { id: string; threadId: string } {
    const { headers, text } = parseRaw(raw);
    const id = newId();
    const at = clock();
    const kept = headers.filter((one) => !["from", "message-id", "date"].includes(one.name.toLowerCase()));
    const thread = threadId ?? id;
    add({
      id,
      threadId: thread,
      internalDate: at,
      labelIds: ["SENT"],
      headers: [
        { name: "From", value: account.address },
        ...kept,
        { name: "Date", value: new Date(at).toUTCString().replace("GMT", "+0000") },
        { name: "Message-ID", value: `<${id}@fake-gmail.test>` },
      ],
      text,
    });
    return { id, threadId: thread };
  }

  async function send(init: RequestInit, body: string): Promise<Response> {
    const bearer = new Headers(init.headers).get("authorization") ?? "";
    if (!issued.has(bearer.replace(/^Bearer /, "")))
      return json(401, { error: { code: 401, status: "UNAUTHENTICATED" } });
    const next = nextSends.shift();
    if (next?.kind === "fail") return json(next.status, { error: { code: next.status } });
    let parsed: { raw?: unknown; threadId?: unknown };
    try {
      parsed = JSON.parse(body) as typeof parsed;
    } catch {
      return json(400, { error: { code: 400 } });
    }
    if (typeof parsed.raw !== "string" || (parsed.threadId !== undefined && typeof parsed.threadId !== "string"))
      return json(400, { error: { code: 400 } });
    const ids = storeSent(parsed.raw, parsed.threadId as string | undefined);
    if (next?.kind === "drop") throw new TypeError("fetch failed");
    if (next?.kind === "answer") return new Response(next.body, { status: 200 });
    if (next?.kind === "hold") {
      await new Promise<void>((resolve, reject) => {
        holding.push(resolve);
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    }
    return json(200, { ...ids, labelIds: ["SENT"] });
  }

  const fakeFetch: typeof fetch = async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = (init.method ?? "GET").toUpperCase();
    const body = bodyText(init.body);
    requests.push({ method, url, body });
    if (init.signal?.aborted === true) throw new DOMException("aborted", "AbortError");
    if (method === "POST" && url === TOKEN_URL) {
      const token = `fake-send-access-${issued.size + 1}`;
      issued.add(token);
      return json(200, { access_token: token, expires_in: 3600, token_type: "Bearer", scope: SEND_SCOPES });
    }
    if (method === "POST" && url === SEND_URL) return send(init, body);
    if (method === "POST" && url === REVOKE_URL) {
      revoked.push(new URLSearchParams(body).get("token") ?? "");
      return new Response(null, { status: 200 });
    }
    throw new TypeError("off the fake's list");
  };

  return {
    fetch: fakeFetch,
    get requests() {
      return requests.map((one) => ({ ...one }));
    },
    get revoked() {
      return [...revoked];
    },
    failNextSend: (status) => void nextSends.push({ kind: "fail", status }),
    answerNextSend: (body) => void nextSends.push({ kind: "answer", body }),
    dropNextSendAnswer: () => void nextSends.push({ kind: "drop" }),
    holdNextSend: () => void nextSends.push({ kind: "hold" }),
    releaseSend: () => {
      for (const resolve of holding.splice(0)) resolve();
    },
    addReply(threadId, from) {
      const id = newId();
      const at = clock();
      const answered = mailbox
        .find((one) => one.message.threadId === threadId)
        ?.message.headers.find((one) => one.name.toLowerCase() === "message-id")?.value;
      add({
        id,
        threadId,
        internalDate: at,
        labelIds: ["INBOX"],
        headers: [
          { name: "From", value: from },
          { name: "To", value: account.address },
          { name: "Date", value: new Date(at).toUTCString().replace("GMT", "+0000") },
          { name: "Subject", value: "Re: your note" },
          { name: "Message-ID", value: `<${id}@fake-gmail.test>` },
          ...(answered === undefined ? [] : [{ name: "In-Reply-To", value: answered }]),
        ],
        text: "Thank you, that works.",
      });
      return id;
    },
    message: (id) => {
      const found = mailbox.find((one) => one.message.id === id && one.deleted === undefined);
      return found === undefined ? undefined : structuredClone(found.message);
    },
    async profile() {
      const failure = plan.next();
      if (failure !== undefined) throw coded(failure);
      return { address: account.address };
    },
    connector,
    add,
    // Changes only labels that derive nothing: history reports it, and its page hands nothing over.
    trash(id) {
      relabel(id, [...stored(id).message.labelIds.filter((label) => label !== "INBOX" && label !== "TRASH"), "TRASH"]);
    },
    relabel,
    deletePermanently(id) {
      const one = stored(id);
      current += 1;
      one.deleted = current;
      history.push({ id: current, kind: "deleted", message: id, labels: [] });
    },
    expireHistoryBefore(historyId) {
      floor = Math.max(FIRST_HISTORY_ID, Number(historyId));
    },
    // None of these is a change to the mailbox: no history id is used.
    forbid: (id) => void forbidden.add(id),
    goneAtGet: (id) => void gone.add(id),
    tooLarge: (id) => void large.add(id),
    failAt: plan.failAt,
    get calls() {
      return plan.calls;
    },
    get fetched() {
      return [...fetched];
    },
  };
}
