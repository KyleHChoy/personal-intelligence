import {
  ConnectorCursor,
  type HttpPort,
  type HttpRequest,
  RawItem,
  type SourceDeletion,
} from "@intelligence/contracts";
import {
  type ConnectorOptions,
  type GmailMessage,
  gmailItem,
  type PersonalPage,
} from "@intelligence/personal-core/items";
import { describe, expect, it } from "vitest";
import { createGoogleConnector } from "./connector.ts";
import { type MailPhase, mailCursor } from "./cursor.ts";
import {
  GMAIL_FETCHES_AT_ONCE,
  GMAIL_MS_PER_UNIT,
  GMAIL_RATE_LIMIT_WAIT_MS,
  gmailProfile,
  gmailSendAs,
} from "./gmail.ts";
import { createGoogleHttp, type GoogleDeps, GoogleError, MAX_ANSWER_BYTES, type TokenSource } from "./http.ts";
import { account, accountId, credential, failureOf as failure, headersOf } from "./test-support/fixtures.ts";

// Hand-written Gmail answers on reserved domains. No test reaches the network: every request
// goes through the real port to a fake fetch that plays one small mailbox, with its passes.

const SINCE = "2026-03-01T00:00:00.000Z";
// The window's start in whole epoch seconds.
const AFTER = 1_772_323_200;
const NEWER = Date.UTC(2026, 2, 4, 10, 5);
const API = "/gmail/v1/users/me";
const MIB = 1024 * 1024;

// `wait`: a slow answer, after which the clock has moved that many ms.
type Reply = { status: number; body?: unknown; large?: true; wait?: number };
type Pass = "sent" | "rest" | "older";
type ListPage = { ids: string[]; next?: string };
type Mailbox = {
  historyId?: string;
  // By pass, then by page token; "" is a pass's first page. A missing pass lists nothing.
  passes?: Partial<Record<Pass, Record<string, ListPage | Reply>>>;
  // By message id: a format=full answer body, or a reply with its status. A missing id answers 404.
  messages?: Record<string, unknown>;
  // By thread id: a format=minimal answer, or a reply. A missing id answers 404.
  threads?: Record<string, unknown>;
  // By "<startHistoryId>|<pageToken>". A missing key answers 404.
  history?: Record<string, unknown>;
  // By path, such as "/messages/m1" or "/messages": how many times it answers 429, with
  // `limitedWith` as its body (Google's rateLimitExceeded by default), before its usual answer.
  limited?: Record<string, number>;
  limitedWith?: unknown;
  // By path: how many turns of the event loop its answer takes, so answers can end out of order.
  ticks?: Record<string, number>;
  // How far the clock moves at each call; 10 ms by default.
  callMs?: number;
};

const isReply = (value: unknown): value is Reply =>
  typeof value === "object" && value !== null && typeof (value as Reply).status === "number";
const reply = (value: unknown): Reply => (isReply(value) ? value : { status: 200, body: value });

const b64 = (value: string): string => Buffer.from(value).toString("base64url");

// One messages.get answer, as Gmail writes it under format=full: a plain text body.
const answer = (
  id: string,
  labelIds: string[] = ["INBOX"],
  body = `Body of ${id}`,
  over: Record<string, unknown> = {},
) => ({
  id,
  threadId: `t-${id}`,
  labelIds,
  snippet: "fake-snippet of the body",
  internalDate: String(NEWER),
  sizeEstimate: 2048,
  historyId: "999",
  payload: {
    partId: "",
    mimeType: "text/plain",
    filename: "",
    headers: headersOf(id),
    body: { size: body.length, data: b64(body) },
  },
  ...over,
});
// What the connector should read of that answer.
const read = (
  id: string,
  labelIds: string[] = ["INBOX"],
  body = `Body of ${id}`,
  threadId = `t-${id}`,
): GmailMessage => ({ id, threadId, internalDate: NEWER, labelIds, headers: headersOf(id), text: body });
const item = (message: GmailMessage, changeKind: "backfill" | "live" = "backfill"): RawItem =>
  gmailItem(message, { sourceAccount: accountId, changeKind });
const items = (ids: string[], changeKind: "backfill" | "live" = "backfill"): RawItem[] =>
  ids.map((id) => item(read(id), changeKind));
// The injected clock, and the deletions a page dated by it names.
const CLOCK = "2026-03-10T12:00:00.000Z";
const gone = (...ids: string[]): SourceDeletion[] =>
  ids.map((id) => ({ sourceAccount: accountId, sourceItemId: `gmail-id:${id}`, deletedAt: CLOCK }));

// A token source whose first `good` tokens are had, and whose next request fails as a token
// endpoint answering `status` makes the real one fail.
function failingTokens(good: number, code: "forbidden" | "not_found", status: number) {
  const asked = { times: 0, failed: 0 };
  const tokens: TokenSource = {
    accessToken: async () => {
      asked.times += 1;
      if (asked.times <= good) return "fake-access-token";
      asked.failed += 1;
      throw new GoogleError(code, status);
    },
    invalidate: () => {},
  };
  return { asked, tokens };
}

// Which pass a messages.list call is, by its fixed query.
const passOf = (url: URL): Pass =>
  url.searchParams.get("labelIds") === "SENT"
    ? "sent"
    : (url.searchParams.get("q") ?? "").startsWith("before:")
      ? "older"
      : "rest";

function google(
  box: Mailbox,
  options: ConnectorOptions = {},
  timeoutMs = 1000,
  tokens: TokenSource = { accessToken: async () => "fake-access-token", invalidate: () => {} },
) {
  const calls: URL[] = [];
  const requests: HttpRequest[] = [];
  // How many requests are in flight, the most there were, and, for each request, how many were
  // in flight when it started.
  const flight = { now: 0, most: 0, alongside: [] as [string, number][] };
  // The clock moves 10 ms for each call and by every sleep.
  const clock = { at: Date.parse(CLOCK), sleeps: [] as number[], starts: [] as [string, number][] };
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const path = url.pathname.slice(API.length);
    calls.push(url);
    clock.starts.push([path, clock.at]);
    flight.alongside.push([path, flight.now]);
    clock.at += box.callMs ?? 10;
    flight.now += 1;
    flight.most = Math.max(flight.most, flight.now);
    for (let tick = 0; tick < (box.ticks?.[path] ?? 1); tick += 1)
      await new Promise((resolve) => setImmediate(resolve));
    flight.now -= 1;
    const left = box.limited?.[path] ?? 0;
    if (left > 0) {
      (box.limited as Record<string, number>)[path] = left - 1;
      return new Response(
        JSON.stringify(
          box.limitedWith ?? { error: { code: 429, errors: [{ domain: "usageLimits", reason: "rateLimitExceeded" }] } },
        ),
        { status: 429 },
      );
    }
    const { status, body, large, wait } = route(url);
    if (wait !== undefined) clock.at += wait;
    if (large === true)
      return new Response("{}", { status, headers: { "Content-Length": String(MAX_ANSWER_BYTES + 1) } });
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  };
  function route(url: URL): Reply {
    const path = url.pathname;
    if (path === `${API}/profile`)
      return {
        status: 200,
        body: {
          emailAddress: "owner@example.org",
          messagesTotal: 3,
          threadsTotal: 3,
          historyId: box.historyId ?? "1000",
        },
      };
    if (path === `${API}/messages`) {
      const pages = box.passes?.[passOf(url)] ?? { "": { ids: [] } };
      const page = pages[url.searchParams.get("pageToken") ?? ""];
      if (page === undefined) return { status: 400 };
      if (isReply(page)) return page;
      return {
        status: 200,
        body: {
          messages: page.ids.map((id) => ({ id, threadId: `t-${id}` })),
          ...(page.next === undefined ? {} : { nextPageToken: page.next }),
          resultSizeEstimate: page.ids.length,
        },
      };
    }
    if (path.startsWith(`${API}/messages/`)) {
      const found = box.messages?.[decodeURIComponent(path.slice(`${API}/messages/`.length))];
      return found === undefined ? { status: 404 } : reply(found);
    }
    if (path.startsWith(`${API}/threads/`)) {
      const found = box.threads?.[decodeURIComponent(path.slice(`${API}/threads/`.length))];
      return found === undefined ? { status: 404 } : reply(found);
    }
    if (path === `${API}/history`) {
      const found =
        box.history?.[`${url.searchParams.get("startHistoryId")}|${url.searchParams.get("pageToken") ?? ""}`];
      return found === undefined ? { status: 404 } : reply(found);
    }
    return { status: 400 };
  }
  // Each rate limit the connector reports: its reason and how long it pauses.
  const limits: [string, number][] = [];
  const deps: GoogleDeps = {
    fetch,
    sleep: async (ms) => {
      clock.sleeps.push(ms);
      clock.at += ms;
    },
    now: () => clock.at,
    random: () => 0.5,
    timeoutMs,
    onRateLimit: (reason, pausedMs) => void limits.push([reason, pausedMs]),
  };
  const port = createGoogleHttp({ tokens, deps });
  // Records each request as the connector built it, before the port adds anything.
  const http: HttpPort = {
    send: (req) => {
      requests.push(req);
      return port.send(req);
    },
  };
  const withOptions = (other: ConnectorOptions) => createGoogleConnector("google_mail", credential, http, other, deps);
  const connector = withOptions(options);
  const page = (cursor: ConnectorCursor | null, limit = 100): Promise<PersonalPage> =>
    connector.listChanges(account, cursor, limit);
  const paths = (): string[] => calls.map((url) => url.pathname.slice(API.length));
  const lists = (): URL[] => calls.filter((url) => url.pathname === `${API}/messages`);
  return { calls, requests, flight, clock, limits, deps, http, connector, page, paths, lists, withOptions };
}

// The cursor's own content, which only this package reads.
const decoded = (cursor: ConnectorCursor): Record<string, unknown> =>
  JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
const at = (phase: MailPhase): ConnectorCursor => mailCursor(phase);
const HISTORY = at({ phase: "history", historyId: "1000" });
const restPass = (over: Partial<Extract<MailPhase, { phase: "list" }>> = {}): ConnectorCursor =>
  at({ phase: "list", start: "1000", pass: "rest", reconcile: false, after: AFTER, ...over });

// Every page from `cursor` until the listing ends, at most `most`.
async function run(
  page: (cursor: ConnectorCursor | null) => Promise<PersonalPage>,
  cursor: ConnectorCursor | null,
  most = 20,
): Promise<PersonalPage[]> {
  const pages: PersonalPage[] = [];
  for (let next = cursor; pages.length < most; ) {
    const one = await page(next);
    pages.push(one);
    if (one.listing?.ended !== undefined) break;
    next = one.next;
  }
  return pages;
}

describe("the Gmail profile", () => {
  it("profile returns the address and history id", async () => {
    const { http, deps, calls, requests } = google({ historyId: "4242" });
    expect(await gmailProfile(http, deps)).toEqual({ address: "owner@example.org", historyId: "4242" });
    expect(calls.map(String)).toEqual(["https://gmail.googleapis.com/gmail/v1/users/me/profile"]);
    expect(requests[0]?.timeoutMs).toBe(1000);

    for (const body of [
      { emailAddress: "owner@example.org" },
      { historyId: "1" },
      { emailAddress: "", historyId: "1" },
      { emailAddress: "owner@example.org", historyId: 1 },
      [],
    ]) {
      const fetch: typeof globalThis.fetch = async () => new Response(JSON.stringify(body), { status: 200 });
      expect(
        (await failure(gmailProfile(createGoogleHttp({ tokens: null, deps: { ...deps, fetch } }), deps))).code,
      ).toBe("bad_response");
    }
  });
});

describe("the Gmail send-as list", () => {
  const answering = (deps: GoogleDeps, body: unknown) => {
    const calls: string[] = [];
    const fetch: typeof globalThis.fetch = async (input) => {
      calls.push(String(input));
      return new Response(JSON.stringify(body), { status: 200 });
    };
    return { http: createGoogleHttp({ tokens: null, deps: { ...deps, fetch } }), calls };
  };

  it("returns the primary address and the verified aliases, lower-cased, once each, and leaves a pending one out", async () => {
    const { deps } = google({});
    const { http, calls } = answering(deps, {
      sendAs: [
        { sendAsEmail: "owner@example.org", isPrimary: true, isDefault: true },
        { sendAsEmail: "Owner.Alias@alias-one.test", verificationStatus: "accepted" },
        { sendAsEmail: "owner.alias@alias-one.test", verificationStatus: "accepted" },
        { sendAsEmail: "unverified@alias-two.test", verificationStatus: "pending" },
        { sendAsEmail: "unknown@alias-two.test" },
      ],
    });
    expect(await gmailSendAs(http, deps)).toEqual([
      { address: "owner.alias@alias-one.test", primary: false },
      { address: "owner@example.org", primary: true },
    ]);
    expect(calls).toEqual(["https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs"]);
  });

  it("reads an empty answer as none, and refuses one that does not parse", async () => {
    const { deps } = google({});
    expect(await gmailSendAs(answering(deps, {}).http, deps)).toEqual([]);
    for (const body of [{ sendAs: {} }, { sendAs: [{ isPrimary: true }] }, { sendAs: [{ sendAsEmail: "" }] }, []]) {
      expect((await failure(gmailSendAs(answering(deps, body).http, deps))).code).toBe("bad_response");
    }
  });
});

describe("a Gmail listing's queries", () => {
  it("the sent pass asks for the SENT label, and the rest pass for everything but sent mail and junk", async () => {
    const { lists, page } = google(
      {
        passes: { sent: { "": { ids: ["s1"], next: "p2" }, p2: { ids: [] } }, rest: { "": { ids: ["r1"] } } },
        messages: { s1: answer("s1", ["SENT"]), r1: answer("r1") },
      },
      { since: SINCE },
    );
    const pages = await run(page, null);
    expect(pages.map((one) => one.items)).toEqual([[item(read("s1", ["SENT"]))], [], items(["r1"])]);
    expect(lists().map((url) => [...url.searchParams.entries()])).toEqual([
      [
        ["includeSpamTrash", "true"],
        ["labelIds", "SENT"],
        ["q", `after:${AFTER} -in:spam`],
        ["maxResults", "50"],
      ],
      [
        ["includeSpamTrash", "true"],
        ["labelIds", "SENT"],
        ["q", `after:${AFTER} -in:spam`],
        ["maxResults", "50"],
        ["pageToken", "p2"],
      ],
      [
        ["includeSpamTrash", "true"],
        ["q", `after:${AFTER} -in:sent -in:spam -category:promotions`],
        ["maxResults", "50"],
      ],
    ]);
  });

  it("a window is an after: in whole epoch seconds in both fetching passes, and the older pass a before: one day later", async () => {
    // A since inside a second is rounded down to it.
    const { lists, page } = google({ passes: {} }, { since: "2026-03-01T00:00:00.900Z" });
    const pages = await run((cursor) => page(cursor, 9999), google({}).connector.resetCursor());
    expect(pages).toHaveLength(3);
    expect(lists().map((url) => url.searchParams.get("q"))).toEqual([
      `after:${AFTER} -in:spam`,
      `after:${AFTER} -in:sent -in:spam -category:promotions`,
      `before:${AFTER + 86_400} -in:spam`,
    ]);
    // The older pass asks for up to 500 ids, the fetching passes for up to 50 messages.
    expect(lists().map((url) => url.searchParams.get("maxResults"))).toEqual(["50", "50", "500"]);
    // A smaller limit is a smaller page.
    const small = google({ passes: {} }, { since: SINCE });
    await small.page(null, 7);
    expect(small.lists()[0]?.searchParams.get("maxResults")).toBe("7");
  });

  it("the older pass overlaps the window by a day", async () => {
    const { lists, page } = google({ passes: {} }, { since: SINCE });
    await run(page, google({}).connector.resetCursor());
    const [sent, , older] = lists().map((url) => url.searchParams.get("q") ?? "");
    const after = Number(/after:(\d+)/.exec(sent ?? "")?.[1]);
    const before = Number(/before:(\d+)/.exec(older ?? "")?.[1]);
    expect(before - after).toBe(86_400);
  });

  it("the sent pass leaves out spam", async () => {
    const { lists, page } = google({ passes: {} }, { since: SINCE });
    await page(null);
    const [sent] = lists();
    expect(sent?.searchParams.get("labelIds")).toBe("SENT");
    expect(sent?.searchParams.get("q")?.split(" ")).toContain("-in:spam");
    expect(sent?.searchParams.get("includeSpamTrash")).toBe("true");
  });

  it("no query holds anything but the fixed operators", async () => {
    // Messages whose headers and labels name operators: none of it reaches a query.
    const loud = answer("s1", ["SENT", "Label_in:anywhere"], "q=in:anywhere before:0", {
      payload: { mimeType: "text/plain", headers: [{ name: "Subject", value: "after:0 OR in:anywhere" }] },
    });
    const { lists, page } = google(
      {
        passes: { sent: { "": { ids: ["s1"] } }, rest: { "": { ids: [] } }, older: { "": { ids: ["o1"] } } },
        messages: { s1: loud },
      },
      { since: SINCE },
    );
    await run(page, google({}).connector.resetCursor());
    expect(lists()).toHaveLength(3);
    for (const url of lists()) {
      for (const word of url.searchParams.get("q")?.split(" ") ?? [])
        expect(word).toMatch(/^(after:\d+|before:\d+|-in:sent|-in:spam|-category:promotions)$/);
      expect(
        [...url.searchParams.keys()].every((key) =>
          ["includeSpamTrash", "labelIds", "q", "maxResults", "pageToken"].includes(key),
        ),
      ).toBe(true);
      expect(url.searchParams.getAll("labelIds").every((label) => label === "SENT")).toBe(true);
    }
    // With no since there is no window, and no after:.
    const unbounded = google({ passes: {} });
    await run(unbounded.page, null);
    expect(unbounded.lists().map((url) => url.searchParams.get("q"))).toEqual([
      "-in:spam",
      "-in:sent -in:spam -category:promotions",
    ]);
  });
});

describe("a Gmail listing", () => {
  it("every mail item is what gmailItem makes of the message read, drafts and trash included", async () => {
    const labels: Record<string, string[]> = {
      m1: ["INBOX", "CATEGORY_PERSONAL"],
      m2: ["DRAFT"],
      m3: ["TRASH"],
      m4: ["INBOX", "Label_7"],
    };
    const ids = Object.keys(labels);
    const { page } = google({
      passes: { rest: { "": { ids } } },
      messages: Object.fromEntries(ids.map((id) => [id, answer(id, labels[id])])),
    });
    const { items: got, deletions, skipped } = await page(restPass());
    expect(got).toEqual(ids.map((id) => item(read(id, labels[id]))));
    for (const one of got) {
      expect(RawItem.safeParse(one).success).toBe(true);
      expect([one.depth, one.changeKind, one.sourceAccount]).toEqual(["full", "backfill", accountId]);
    }
    expect(got.map((one) => one.markers)).toEqual(Object.values(labels));
    expect([deletions, skipped]).toEqual([[], []]);
  });

  it("a message gone between listing and fetch is a source deletion", async () => {
    const { page } = google({
      passes: { rest: { "": { ids: ["m1", "m2", "m3"] } } },
      messages: { m1: answer("m1"), m3: answer("m3") },
    });
    const result = await page(restPass());
    expect(result.items).toEqual(items(["m1", "m3"]));
    // Named by the id its item would be stored under, and dated by the injected clock.
    expect(result.deletions).toEqual(gone("m2"));
    expect(result.skipped).toEqual([]);
  });

  it("a message answered 403 is skipped as forbidden and the page completes", async () => {
    const forbidden = { status: 403, body: { error: { code: 403, errors: [{ reason: "forbidden" }] } } };
    const { page } = google({
      passes: { rest: { "": { ids: ["m1", "m2", "m3"] } } },
      messages: { m1: answer("m1"), m2: forbidden, m3: answer("m3") },
    });
    const result = await page(restPass());
    expect(result.items).toEqual(items(["m1", "m3"]));
    expect(result.skipped).toEqual([{ sourceItemId: "gmail-id:m2", reason: "forbidden" }]);
    expect(result.deletions).toEqual([]);

    // Any other failure of messages.get fails the page.
    for (const [status, code] of [
      [400, "bad_response"],
      [410, "not_found"],
      [401, "unauthorized"],
    ] as const) {
      const failing = google({
        passes: { rest: { "": { ids: ["m1", "m2"] } } },
        messages: { m1: answer("m1"), m2: { status } },
      });
      expect((await failure(failing.page(restPass()))).code).toBe(code);
    }
    for (const reason of ["quotaExceeded", "dailyLimitExceeded", "rateLimitExceeded", "userRateLimitExceeded"]) {
      const spent = google({
        passes: { rest: { "": { ids: ["m1", "m2"] } } },
        messages: { m1: answer("m1"), m2: { status: 403, body: { error: { code: 403, errors: [{ reason }] } } } },
      });
      expect((await failure(spent.page(restPass()))).code, reason).toBe("rate_limited");
    }
  });

  it("a token that cannot be had in the middle of a listing fails the page: no skip and no deletion", async () => {
    const box: Mailbox = {
      passes: { sent: { "": { ids: ["m1", "m2", "m3"] } } },
      messages: { m1: answer("m1"), m2: answer("m2"), m3: answer("m3") },
    };
    for (const [code, status] of [
      ["forbidden", 403],
      ["not_found", 404],
      ["not_found", 410],
    ] as const) {
      // Tokens for the profile, the list and the first message; the next one cannot be had.
      const { asked, tokens } = failingTokens(3, code, status);
      const { page, paths } = google(box, {}, 1000, tokens);
      const error = await failure(page(null));
      expect([error.code, error.status], String(status)).toEqual([code, undefined]);
      // The page stops there: m2 is not skipped or reported deleted. m3's fetch, started beside
      // m2's, cannot have its token either, so neither is ever sent.
      expect(paths()).toEqual(["/profile", "/messages", "/messages/m1"]);
      expect(asked.failed).toBe(2);
    }
    // The positive control: with tokens, the same page hands over all three.
    expect((await google(box).page(null)).items).toHaveLength(3);
  });

  it("an empty mailbox gives two empty passes and a listing that ends", async () => {
    const { page, paths } = google(
      {
        historyId: "1000",
        passes: {
          sent: { "": { status: 200, body: { resultSizeEstimate: 0 } } },
          rest: { "": { status: 200, body: { resultSizeEstimate: 0 } } },
        },
      },
      { since: SINCE },
    );
    const first = await page(null);
    expect(first).toEqual({
      items: [],
      deletions: [],
      skipped: [],
      more: true,
      listing: { first: true },
      next: first.next,
    });
    const second = await page(first.next);
    expect(second).toEqual({
      items: [],
      deletions: [],
      skipped: [],
      more: false,
      listing: { first: false, ended: "window" },
      next: second.next,
    });
    expect(paths()).toEqual(["/profile", "/messages", "/messages"]);
    expect(decoded(second.next)).toEqual({ v: 4, connector: "google_mail", phase: "history", historyId: "1000" });
  });

  it("a list answer over the bound fails the page bad_response", async () => {
    const { page } = google({ passes: { sent: { "": { status: 200, large: true } } } });
    const error = await failure(page(null));
    expect([error.code, error.status]).toEqual(["bad_response", 200]);
    // The same of a history answer, a thread answer and the profile.
    const history = google({ history: { "1000|": { status: 200, large: true } } });
    expect((await failure(history.page(HISTORY))).code).toBe("bad_response");
    const thread = google({
      messages: { m1: answer("m1", ["SENT"]) },
      threads: { "t-m1": { status: 200, large: true } },
      history: {
        "1000|": {
          historyId: "1010",
          history: [{ id: "1001", messagesAdded: [{ message: { id: "m1", threadId: "t-m1", labelIds: ["SENT"] } }] }],
        },
      },
    });
    expect((await failure(thread.page(HISTORY))).code).toBe("bad_response");
    const fetch: typeof globalThis.fetch = async () =>
      new Response("{}", { status: 200, headers: { "Content-Length": String(MAX_ANSWER_BYTES + 1) } });
    expect((await failure(gmailProfile(createGoogleHttp({ tokens: null, deps: { fetch } })))).code).toBe(
      "bad_response",
    );
    // The positive control: the same list, small, is read.
    expect((await google({ passes: { sent: { "": { ids: [] } } } }).page(null)).listing).toEqual({ first: true });
  });
});

describe("a Gmail listing's passes", () => {
  const box: Mailbox = {
    historyId: "1000",
    passes: {
      sent: { "": { ids: ["s1"], next: "p2" }, p2: { ids: ["s2"] } },
      rest: { "": { ids: ["r1"] } },
      older: { "": { ids: ["o1", "o2"], next: "q2" }, q2: { ids: ["o3"] } },
    },
    messages: {
      s1: answer("s1", ["SENT"]),
      s2: answer("s2", ["SENT"]),
      r1: answer("r1"),
      o1: answer("o1"),
      o2: answer("o2"),
      o3: answer("o3"),
    },
    history: { "1000|": { historyId: "1000" } },
  };

  it("a pass's last page leads to the next pass with more true", async () => {
    const { page } = google(box, { since: SINCE });
    const first = await page(null);
    expect([first.more, decoded(first.next)]).toEqual([
      true,
      {
        v: 4,
        connector: "google_mail",
        phase: "list",
        start: "1000",
        pass: "sent",
        pageToken: "p2",
        reconcile: false,
        after: AFTER,
      },
    ]);
    const second = await page(first.next);
    // The sent pass's last page: the rest pass, from its start.
    expect([second.more, second.listing, decoded(second.next)]).toEqual([
      true,
      { first: false },
      { v: 4, connector: "google_mail", phase: "list", start: "1000", pass: "rest", reconcile: false, after: AFTER },
    ]);
    expect(second.items).toEqual([item(read("s2", ["SENT"]))]);
  });

  it("a first listing ends window at the rest pass's last page, and continues in history", async () => {
    const { page, paths, calls } = google(box, { since: SINCE });
    const pages = await run(page, null);
    expect(pages.map((one) => [one.listing, one.more])).toEqual([
      [{ first: true }, true],
      [{ first: false }, true],
      [{ first: false, ended: "window" }, false],
    ]);
    // Sent mail first, then the rest; nothing older is listed or fetched.
    expect(pages.flatMap((one) => one.items)).toEqual([
      item(read("s1", ["SENT"])),
      item(read("s2", ["SENT"])),
      item(read("r1")),
    ]);
    expect(pages.every((one) => one.listed === undefined)).toBe(true);
    calls.length = 0;
    await page(pages[2]?.next ?? null);
    expect(paths()).toEqual(["/history"]);
    expect(calls[0]?.searchParams.get("startHistoryId")).toBe("1000");
  });

  it("a reconciling listing ends complete at the older pass's last page and moves to history", async () => {
    const { page, paths, calls } = google(box, { since: SINCE });
    const reset = google(box).connector.resetCursor();
    const pages = await run(page, reset);
    expect(pages.map((one) => [one.listing, one.more, one.listed])).toEqual([
      [{ first: true }, true, undefined],
      [{ first: false }, true, undefined],
      [{ first: false }, true, undefined],
      [{ first: false }, true, ["gmail-id:o1", "gmail-id:o2"]],
      [{ first: false, ended: "complete" }, false, ["gmail-id:o3"]],
    ]);
    calls.length = 0;
    await page(pages[4]?.next ?? null);
    expect(paths()).toEqual(["/history"]);
    expect(calls[0]?.searchParams.get("startHistoryId")).toBe("1000");
  });

  it("a listing from the reset cursor, or after an expired history id, fetches the window and lists what is older by id alone", async () => {
    // Started by the reset cursor, and resumed page by page by a connector built with another
    // since: the cursor's window is used, and no id of the older pass is fetched.
    const reset = google(box, { since: SINCE });
    const later = reset.withOptions({ since: "2025-01-01T00:00:00.000Z" });
    const pages = [await reset.page(reset.connector.resetCursor())];
    while (pages.at(-1)?.listing?.ended === undefined)
      pages.push(await later.listChanges(account, (pages.at(-1) as PersonalPage).next, 100));
    expect(pages.flatMap((one) => one.items)).toEqual([
      item(read("s1", ["SENT"])),
      item(read("s2", ["SENT"])),
      item(read("r1")),
    ]);
    expect(pages.flatMap((one) => one.listed ?? [])).toEqual(["gmail-id:o1", "gmail-id:o2", "gmail-id:o3"]);
    expect(reset.paths().filter((path) => path.startsWith("/messages/"))).toEqual([
      "/messages/s1",
      "/messages/s2",
      "/messages/r1",
    ]);
    expect(reset.lists().map((url) => url.searchParams.get("q"))).toEqual([
      `after:${AFTER} -in:spam`,
      `after:${AFTER} -in:spam`,
      `after:${AFTER} -in:sent -in:spam -category:promotions`,
      `before:${AFTER + 86_400} -in:spam`,
      `before:${AFTER + 86_400} -in:spam`,
    ]);

    // Started by an expired history id, in the same call: the same reconciling listing.
    const expired = google({ ...box, history: {} }, { since: SINCE });
    const relisted = await run(expired.page, HISTORY);
    expect(expired.paths().slice(0, 3)).toEqual(["/history", "/profile", "/messages"]);
    expect(relisted.at(-1)?.listing).toEqual({ first: false, ended: "complete" });
    expect(relisted.flatMap((one) => one.listed ?? [])).toEqual(["gmail-id:o1", "gmail-id:o2", "gmail-id:o3"]);
    expect(expired.paths().filter((path) => path.startsWith("/messages/o"))).toEqual([]);
  });

  it("an older id is in listed and in no item", async () => {
    // A message in the window that is also on the older pass's first day is in both.
    const edge: Mailbox = { ...box, passes: { ...box.passes, older: { "": { ids: ["r1", "o1"] } } } };
    const { page } = google(edge, { since: SINCE });
    const pages = await run(page, google({}).connector.resetCursor());
    const older = pages.at(-1);
    expect(older?.listed).toEqual(["gmail-id:r1", "gmail-id:o1"]);
    expect([older?.items, older?.deletions, older?.skipped]).toEqual([[], [], []]);
    expect(JSON.stringify(pages)).not.toContain("Notes o1");
  });

  it("a listing resumed by a connector built with another since resends the cursor's after", async () => {
    const first = google(box, { since: SINCE });
    const begun = await first.page(null);
    const other = first.withOptions({ since: "2026-02-01T00:00:00.000Z" });
    await other.listChanges(account, begun.next, 100);
    expect(first.lists().map((url) => url.searchParams.get("q"))).toEqual([
      `after:${AFTER} -in:spam`,
      `after:${AFTER} -in:spam`,
    ]);
    // The control: that connector's own new listing sends its own window.
    await other.listChanges(account, null, 100);
    expect(first.lists().at(-1)?.searchParams.get("q")).toBe(`after:${Date.UTC(2026, 1, 1) / 1000} -in:spam`);
  });

  it("the same cursor gives the same page", async () => {
    const { page, connector } = google(box, { since: SINCE });
    for (const start of [null, connector.resetCursor()]) {
      const pages = await run(page, start);
      for (const [index, one] of pages.entries())
        expect(await page(index === 0 ? start : (pages[index - 1] as PersonalPage).next)).toEqual(one);
      expect(new Set(pages.map((one) => one.next)).size).toBe(pages.length);
    }
  });

  it("a version 1 cursor fails bad_cursor", async () => {
    const { page, calls } = google(box, { since: SINCE });
    const v1 = (value: unknown): ConnectorCursor =>
      ConnectorCursor.parse(
        Buffer.from(JSON.stringify({ v: 1, connector: "google_mail", ...(value as object) })).toString("base64url"),
      );
    for (const cursor of [
      v1({ phase: "reset" }),
      v1({ phase: "list", start: "1000", pageToken: "p2", toEnd: false }),
      v1({ phase: "history", historyId: "1000" }),
    ]) {
      expect((await failure(page(cursor))).code).toBe("bad_cursor");
    }
    expect(calls).toHaveLength(0);
    // The control: the same phases at the current version are read.
    expect(decoded(HISTORY)).toEqual({ v: 4, connector: "google_mail", phase: "history", historyId: "1000" });
    await page(HISTORY);
    expect(calls).toHaveLength(1);
  });

  it("a version 2 cursor fails bad_cursor", async () => {
    // Version 2 had no `sent` on a history cursor: a sent message pending in one would lose its
    // thread check.
    const { page, calls } = google(box, { since: SINCE });
    const v2 = (value: object): ConnectorCursor =>
      ConnectorCursor.parse(
        Buffer.from(JSON.stringify({ v: 2, connector: "google_mail", ...value })).toString("base64url"),
      );
    const phases = [
      { phase: "reset" },
      { phase: "list", start: "1000", pass: "rest", reconcile: false, after: AFTER },
      { phase: "history", historyId: "1000" },
      { phase: "history", historyId: "1010", pending: ["b10"] },
    ];
    for (const phase of phases) expect((await failure(page(v2(phase)))).code).toBe("bad_cursor");
    expect(calls).toHaveLength(0);
    // The control: the same phases at the current version are read.
    for (const phase of phases)
      expect(decoded(at(phase as MailPhase))).toEqual({ v: 4, connector: "google_mail", ...phase });
    await page(at({ phase: "history", historyId: "1000" }));
    expect(calls).toHaveLength(1);
  });

  it("a version 3 cursor fails bad_cursor", async () => {
    // Version 3 had no `seen` or `threads` on a history cursor: the rest of a history page would
    // fetch again a message its first part handed over, and ask again for a thread.
    const { page, calls } = google(box, { since: SINCE });
    const v3 = (value: object): ConnectorCursor =>
      ConnectorCursor.parse(
        Buffer.from(JSON.stringify({ v: 3, connector: "google_mail", ...value })).toString("base64url"),
      );
    const phases = [
      { phase: "reset" },
      { phase: "list", start: "1000", pass: "rest", reconcile: false, after: AFTER },
      { phase: "history", historyId: "1000" },
      { phase: "history", historyId: "1010", pending: ["b10"], sent: ["b10"] },
    ];
    for (const phase of phases) expect((await failure(page(v3(phase)))).code).toBe("bad_cursor");
    expect(calls).toHaveLength(0);
    // The control: the same phases at the current version are read.
    for (const phase of phases)
      expect(decoded(at(phase as MailPhase))).toEqual({ v: 4, connector: "google_mail", ...phase });
    await page(at({ phase: "history", historyId: "1000" }));
    expect(calls).toHaveLength(1);
  });
});

describe("Gmail history", () => {
  const added = (...ids: string[]) => ids.map((id) => ({ message: { id, threadId: `t-${id}`, labelIds: ["INBOX"] } }));
  const TYPES = ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"];

  it("added messages are live items, deleted ones are source deletions, each list de-duplicated", async () => {
    const { calls, page } = google({
      messages: { m1: answer("m1"), m2: answer("m2"), m9: answer("m9") },
      history: {
        "1000|": {
          historyId: "1010",
          history: [
            { id: "1001", messages: [{ id: "m9", threadId: "t-m9" }], messagesAdded: added("m1", "m2") },
            { id: "1002", messages: [{ id: "m3", threadId: "t-m3" }], messagesDeleted: added("m3") },
            { id: "1003", messagesAdded: added("m1"), messagesDeleted: added("m4", "m3") },
            { id: "1004", messages: [{ id: "m9", threadId: "t-m9" }] },
          ],
        },
      },
    });
    const result = await page(HISTORY);
    expect(result.items).toEqual(items(["m1", "m2"], "live"));
    expect(result.deletions).toEqual(gone("m3", "m4"));
    expect(result.listing).toBeUndefined();
    // Ids come from messagesAdded and messagesDeleted only, each fetched once, with format=full.
    expect(calls.map((url) => url.pathname.slice(API.length))).toEqual(["/history", "/messages/m1", "/messages/m2"]);
    expect(calls.slice(1).map((url) => url.searchParams.get("format"))).toEqual(["full", "full"]);
  });

  it("a label change fetches its message only when a deriving label changed, and hands it over as an item", async () => {
    const labelled = (id: string, ...labelIds: string[]) => ({
      message: { id, threadId: `t-${id}`, labelIds: ["INBOX"] },
      labelIds,
    });
    const { calls, page } = google({
      messages: {
        m1: answer("m1"),
        m4: answer("m4", ["INBOX", "CATEGORY_PROMOTIONS"]),
        m5: answer("m5", ["INBOX", "CATEGORY_UPDATES"]),
      },
      history: {
        "1000|": {
          historyId: "1010",
          history: [
            // Moved from spam to the inbox: SPAM is a deriving label, INBOX is not.
            {
              id: "1001",
              messages: [{ id: "m1" }],
              labelsRemoved: [labelled("m1", "SPAM")],
              labelsAdded: [labelled("m1", "INBOX")],
            },
            // Read, starred, filed under a user label: nothing the derived rows depend on.
            {
              id: "1002",
              labelsAdded: [labelled("m2", "STARRED"), labelled("m3", "Label_7", "IMPORTANT")],
              labelsRemoved: [labelled("m2", "UNREAD", "INBOX")],
            },
            { id: "1003", labelsAdded: [labelled("m4", "Label_7", "CATEGORY_PROMOTIONS")], messagesAdded: added("m5") },
            // A message already fetched as an added one, and one already fetched for its labels.
            { id: "1004", labelsAdded: [labelled("m5", "CATEGORY_UPDATES")], labelsRemoved: [labelled("m1", "SPAM")] },
            // A label change of a message that is gone by now, and an entry that names no label.
            { id: "1005", labelsAdded: [labelled("m6", "SPAM"), { message: { id: "m7" } }] },
          ],
        },
      },
    });
    const result = await page(HISTORY);
    // Added ones first, then those whose deriving labels changed, each fetched once.
    expect(calls.map((url) => url.pathname.slice(API.length))).toEqual([
      "/history",
      "/messages/m5",
      "/messages/m1",
      "/messages/m4",
      "/messages/m6",
    ]);
    expect(result.items).toEqual([
      item(read("m5", ["INBOX", "CATEGORY_UPDATES"]), "live"),
      item(read("m1"), "live"),
      item(read("m4", ["INBOX", "CATEGORY_PROMOTIONS"]), "live"),
    ]);
    // Each item's revision tag carries the deriving labels the message has now.
    expect(result.items.map((one) => one.revisionTag)).toEqual([
      "f:m5:CATEGORY_UPDATES",
      "f:m1:",
      "f:m4:CATEGORY_PROMOTIONS",
    ]);
    expect(result.deletions).toEqual(gone("m6"));
    expect(result.skipped).toEqual([]);

    // The control: with only labels that derive nothing changed, no message is fetched.
    const quiet = google({
      messages: { m2: answer("m2") },
      history: {
        "1000|": {
          historyId: "1010",
          history: [
            { id: "1001", labelsAdded: [labelled("m2", "STARRED")], labelsRemoved: [labelled("m2", "UNREAD")] },
          ],
        },
      },
    });
    expect(await quiet.page(HISTORY)).toMatchObject({ items: [], deletions: [], skipped: [] });
    expect(quiet.paths()).toEqual(["/history"]);
  });

  it("an added message that is gone is a source deletion, once", async () => {
    const { page } = google({
      messages: { m1: answer("m1"), m3: { status: 403 } },
      history: {
        "1000|": {
          historyId: "1010",
          history: [
            { id: "1001", messagesAdded: added("m1", "m2", "m3") },
            { id: "1002", messagesDeleted: added("m2") },
          ],
        },
      },
    });
    const result = await page(HISTORY);
    expect(result.items).toEqual(items(["m1"], "live"));
    expect(result.deletions).toEqual(gone("m2"));
    expect(result.skipped).toEqual([{ sourceItemId: "gmail-id:m3", reason: "forbidden" }]);
  });

  it("a gone message and another deleted one are both source deletions, the gone one first, each once", async () => {
    const { page } = google({
      messages: { m1: answer("m1") },
      history: {
        "1000|": {
          historyId: "1010",
          history: [
            { id: "1001", messagesDeleted: added("m5", "m2") },
            { id: "1002", messagesAdded: added("m1", "m2", "m6") },
          ],
        },
      },
    });
    const result = await page(HISTORY);
    expect(result.items).toEqual(items(["m1"], "live"));
    expect(result.deletions).toEqual(gone("m2", "m6", "m5"));
  });

  it("a token that cannot be had in the middle of history fails the page: no relist, no skip and no deletion", async () => {
    const box: Mailbox = {
      historyId: "5000",
      passes: { sent: { "": { ids: ["m1"] } } },
      messages: { m1: answer("m1"), m2: answer("m2") },
      history: { "1000|": { historyId: "1010", history: [{ id: "1001", messagesAdded: added("m1", "m2") }] } },
    };
    for (const [code, status] of [
      ["forbidden", 403],
      ["not_found", 404],
      ["not_found", 410],
    ] as const) {
      // No token for history.list itself: a 404 there must not read as an expired history id.
      const atOnce = failingTokens(0, code, status);
      const none = google(box, {}, 1000, atOnce.tokens);
      const first = await failure(none.page(HISTORY));
      expect([first.code, first.status]).toEqual([code, undefined]);
      expect(none.calls).toHaveLength(0);
      expect(atOnce.asked.failed).toBe(1);

      // Tokens for history.list and the first added message; none for the second.
      const later = failingTokens(2, code, status);
      const some = google(box, {}, 1000, later.tokens);
      const second = await failure(some.page(HISTORY));
      expect([second.code, second.status]).toEqual([code, undefined]);
      expect(some.paths()).toEqual(["/history", "/messages/m1"]);
      expect(later.asked.failed).toBe(1);
    }
    // The positive control: with tokens, the same page hands over both.
    expect((await google(box).page(HISTORY)).items).toHaveLength(2);
  });

  it("a page with no history returns nothing and the page's history id in its next cursor", async () => {
    const { calls, page } = google({ history: { "1000|": { historyId: "1234" }, "1234|": { historyId: "1234" } } });
    const result = await page(HISTORY);
    // A history page with no records lists no message as added.
    expect(result).toEqual({ items: [], deletions: [], skipped: [], more: false, next: result.next, added: 0 });
    calls.length = 0;
    await page(result.next);
    expect(calls[0]?.searchParams.get("startHistoryId")).toBe("1234");
    expect(calls[0]?.searchParams.has("pageToken")).toBe(false);
  });

  it("a later history page resends the start id and the four types with the page token", async () => {
    const { calls, page } = google({
      messages: { m1: answer("m1"), m2: answer("m2") },
      history: {
        "1000|": { historyId: "1010", nextPageToken: "h2", history: [{ id: "1001", messagesAdded: added("m1") }] },
        "1000|h2": { historyId: "1010", history: [{ id: "1002", messagesAdded: added("m2") }] },
        "1010|": { historyId: "1010" },
      },
    });
    const first = await page(HISTORY, 40);
    expect(Object.fromEntries(calls[0]?.searchParams ?? [])).toEqual({
      startHistoryId: "1000",
      historyTypes: "labelRemoved",
      maxResults: "40",
    });
    expect(calls[0]?.searchParams.getAll("historyTypes")).toEqual(TYPES);

    calls.length = 0;
    const second = await page(first.next, 40);
    expect(calls[0]?.pathname).toBe(`${API}/history`);
    expect(Object.fromEntries(calls[0]?.searchParams ?? [])).toEqual({
      startHistoryId: "1000",
      historyTypes: "labelRemoved",
      maxResults: "40",
      pageToken: "h2",
    });
    expect(calls[0]?.searchParams.getAll("historyTypes")).toEqual(TYPES);
    expect(second.items).toEqual(items(["m2"], "live"));

    // The last page moves the start to the page's history id.
    calls.length = 0;
    await page(second.next, 40);
    expect(calls[0]?.searchParams.get("startHistoryId")).toBe("1010");
    expect(calls[0]?.searchParams.has("pageToken")).toBe(false);
  });

  // Coverage compares it with what sync decided.
  it("a history page reports added as its record count, and a pending page 0", async () => {
    const labelled = (id: string, ...labelIds: string[]) => ({
      message: { id, threadId: `t-${id}`, labelIds: ["INBOX"] },
      labelIds,
    });
    const { page } = google({
      messages: { m1: answer("m1"), m3: { status: 403 }, m5: answer("m5") },
      history: {
        "1000|": {
          historyId: "1010",
          history: [
            { id: "1001", messagesAdded: added("m1", "m2") },
            { id: "1002", messagesAdded: added("m1", "m3"), messagesDeleted: added("m2") },
            // A deriving label changed: fetched and handed over, and no addition.
            { id: "1003", labelsRemoved: [labelled("m5", "SPAM")] },
          ],
        },
      },
    });
    const result = await page(HISTORY);
    // m1, m2 and m3: three ids listed as added, though one item was handed over.
    expect(result.added).toBe(3);
    expect(result.items.map((one) => one.sourceItemId)).toEqual(["gmail-id:m1", "gmail-id:m5"]);

    // A label change alone lists nothing as added.
    const quiet = google({
      messages: { m5: answer("m5") },
      history: { "1000|": { historyId: "1010", history: [{ id: "1001", labelsRemoved: [labelled("m5", "SPAM")] }] } },
    });
    expect((await quiet.page(HISTORY)).added).toBe(0);

    // A page that only fetches the ids a byte bound left pending lists none again: they were
    // counted on the page that listed them.
    const ids = Array.from({ length: 12 }, (_, at) => `b${String(at + 1).padStart(2, "0")}`);
    const big = (id: string): string => `${id} `.repeat((2 * MIB) / 4);
    const bounded = google({
      messages: Object.fromEntries(ids.map((id) => [id, answer(id, ["INBOX"], big(id))])),
      history: {
        "1000|": {
          historyId: "1010",
          history: [{ id: "1001", messagesAdded: ids.map((id) => ({ message: { id } })) }],
        },
      },
    });
    const first = await bounded.page(HISTORY);
    expect([first.items.length, first.more, first.added]).toEqual([9, true, 12]);
    const second = await bounded.page(first.next);
    expect([second.items.length, second.added]).toEqual([3, 0]);

    // A listing's page carries no added.
    const listing = await google(
      { historyId: "5000", passes: { sent: { "": { ids: ["m1"] } } }, messages: { m1: answer("m1", ["SENT"]) } },
      { since: SINCE },
    ).page(null);
    expect(listing.listing).toBeDefined();
    expect(listing.added).toBeUndefined();
  });

  it("an expired history id starts a new listing", async () => {
    const { page, paths } = google(
      { historyId: "5000", passes: { sent: { "": { ids: ["m1"] } } }, messages: { m1: answer("m1", ["SENT"]) } },
      { since: SINCE },
    );
    const result = await page(HISTORY);
    // Never an error and never an empty page: the new listing's first page, which reconciles.
    expect(paths()).toEqual(["/history", "/profile", "/messages", "/messages/m1"]);
    expect(result.listing).toEqual({ first: true });
    expect(result.items).toEqual([item(read("m1", ["SENT"]))]);
    expect(decoded(result.next)).toMatchObject({
      phase: "list",
      start: "5000",
      pass: "rest",
      reconcile: true,
      after: AFTER,
    });

    // A 410 is not an expiry for Gmail: it fails the page.
    const ended = google({ history: { "1000|": { status: 410 } } });
    expect((await failure(ended.page(HISTORY))).code).toBe("not_found");
  });
});

describe("the threads of mail the owner sent", () => {
  // Each added message's history record carries its id, thread and labels, as Gmail's does.
  const history = (...added: [string, string[]][]) => ({
    "1000|": {
      historyId: "1010",
      history: [
        {
          id: "1001",
          messagesAdded: added.map(([id, labelIds]) => ({ message: { id, threadId: "t-shared", labelIds } })),
        },
      ],
    },
  });
  const minimal = (...messages: [string, string[]][]) => ({
    id: "t-shared",
    historyId: "1009",
    messages: messages.map(([id, labelIds]) => ({ id, threadId: "t-shared", labelIds })),
  });
  const inThread = (id: string, labelIds: string[]) => answer(id, labelIds, `Body of ${id}`, { threadId: "t-shared" });
  const readIn = (id: string, labelIds: string[]) => read(id, labelIds, `Body of ${id}`, "t-shared");

  it("an added message the owner sent asks for its thread once, and fetches the thread's conditional messages after it", async () => {
    const { calls, page, paths } = google({
      messages: {
        m5: inThread("m5", ["SENT"]),
        m6: inThread("m6", ["SENT", "INBOX"]),
        a1: inThread("a1", ["INBOX", "CATEGORY_SOCIAL"]),
        s1: inThread("s1", ["INBOX", "CATEGORY_SOCIAL"]),
        f1: inThread("f1", ["INBOX", "CATEGORY_FORUMS"]),
      },
      threads: {
        "t-shared": minimal(
          ["s1", ["INBOX", "CATEGORY_SOCIAL"]],
          ["u1", ["INBOX", "CATEGORY_UPDATES"]],
          ["o1", ["SENT", "CATEGORY_SOCIAL"]],
          ["a1", ["INBOX", "CATEGORY_SOCIAL"]],
          ["m5", ["SENT"]],
          ["f1", ["INBOX", "CATEGORY_FORUMS"]],
          ["j1", ["SPAM", "CATEGORY_SOCIAL"]],
        ),
      },
      history: history(["m5", ["SENT"]], ["a1", ["INBOX", "CATEGORY_SOCIAL"]], ["m6", ["SENT", "INBOX"]]),
    });
    const result = await page(HISTORY);
    // Two sent messages of one thread: it is asked for once, with format=minimal.
    expect(paths()).toEqual([
      "/history",
      "/messages/m5",
      "/messages/a1",
      "/messages/m6",
      "/threads/t-shared",
      "/messages/s1",
      "/messages/f1",
    ]);
    expect(calls[4]?.searchParams.get("format")).toBe("minimal");
    expect(result.items).toEqual([
      item(readIn("m5", ["SENT"]), "live"),
      item(readIn("a1", ["INBOX", "CATEGORY_SOCIAL"]), "live"),
      item(readIn("m6", ["SENT", "INBOX"]), "live"),
      item(readIn("s1", ["INBOX", "CATEGORY_SOCIAL"]), "live"),
      item(readIn("f1", ["INBOX", "CATEGORY_FORUMS"]), "live"),
    ]);
  });

  it("a thread answer that is gone or malformed hands over nothing more and the page completes", async () => {
    const answers: unknown[] = [
      { status: 404 },
      { messages: "none" },
      { messages: [{ labelIds: ["CATEGORY_SOCIAL"] }] },
      { messages: [{ id: "s1", labelIds: "CATEGORY_SOCIAL" }] },
      "text",
      undefined,
    ];
    for (const thread of answers) {
      const { page, paths } = google({
        messages: { m5: inThread("m5", ["SENT"]), s1: inThread("s1", ["CATEGORY_SOCIAL"]) },
        threads: thread === undefined ? {} : { "t-shared": thread },
        history: history(["m5", ["SENT"]]),
      });
      const result = await page(HISTORY);
      expect([result.items, result.skipped], JSON.stringify(thread)).toEqual([
        [item(readIn("m5", ["SENT"]), "live")],
        [],
      ]);
      expect(paths()).toEqual(["/history", "/messages/m5", "/threads/t-shared"]);
      expect(result.next).not.toBe(HISTORY);
    }
    // Any other failure fails the page.
    const failing = google({
      messages: { m5: inThread("m5", ["SENT"]) },
      threads: { "t-shared": { status: 400 } },
      history: history(["m5", ["SENT"]]),
    });
    expect((await failure(failing.page(HISTORY))).code).toBe("bad_response");
  });

  it("a listing asks for no thread", async () => {
    const { paths, page } = google(
      {
        passes: { sent: { "": { ids: ["m5"] } } },
        messages: { m5: inThread("m5", ["SENT"]) },
        threads: { "t-shared": minimal(["s1", ["CATEGORY_SOCIAL"]]) },
      },
      { since: SINCE },
    );
    await run(page, null);
    expect(paths().some((path) => path.startsWith("/threads/"))).toBe(false);
  });

  it("a message under SENT and SPAM asks for no thread", async () => {
    const { paths, page } = google({
      messages: { m5: inThread("m5", ["SENT", "SPAM"]), m6: inThread("m6", ["INBOX"]) },
      threads: { "t-shared": minimal(["s1", ["CATEGORY_SOCIAL"]]) },
      history: history(["m5", ["SENT", "SPAM"]], ["m6", ["INBOX"]]),
    });
    expect((await page(HISTORY)).items).toHaveLength(2);
    expect(paths()).toEqual(["/history", "/messages/m5", "/messages/m6"]);
  });
});

describe("a page's bounds and pace", () => {
  // Twelve messages of 2 MiB of plain text each: every answer is under the port's bound.
  const ids = Array.from({ length: 12 }, (_, at) => `b${String(at + 1).padStart(2, "0")}`);
  const big = (id: string): string => `${id} `.repeat((2 * MIB) / 4);
  const bigBox = (): Mailbox => ({
    passes: { rest: { "": { ids, next: "p2" } } },
    messages: Object.fromEntries(ids.map((id) => [id, answer(id, ["INBOX"], big(id))])),
  });

  it("a page stops fetching at the byte bound and leaves the rest pending, and the next call fetches them before listing", async () => {
    const { page, paths, calls } = google(bigBox());
    const first = await page(restPass());
    // Each payload is about 3.65 MiB: the ninth takes the page past 32 MiB, and it stops there.
    const sizes = first.items.map((one) => one.payload.length);
    expect(first.items).toHaveLength(9);
    expect(sizes.slice(0, 8).reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(32 * MIB);
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBeGreaterThan(32 * MIB);
    expect(first.items.map((one) => one.sourceItemId)).toEqual(ids.slice(0, 9).map((id) => `gmail-id:${id}`));
    expect(first.more).toBe(true);
    expect(decoded(first.next)).toEqual({
      v: 4,
      connector: "google_mail",
      phase: "list",
      start: "1000",
      pass: "rest",
      pageToken: "p2",
      reconcile: false,
      after: AFTER,
      pending: ["b10", "b11", "b12"],
    });

    // The next call fetches the three, with no list call before the last of them.
    calls.length = 0;
    const second = await page(first.next);
    expect(paths()).toEqual(["/messages/b10", "/messages/b11", "/messages/b12"]);
    expect(second.items).toEqual(["b10", "b11", "b12"].map((id) => item(read(id, ["INBOX"], big(id)))));
    expect([second.more, second.listing]).toEqual([true, { first: false }]);
    // Then the listing goes on where the list page stood.
    expect(decoded(second.next)).toEqual({
      v: 4,
      connector: "google_mail",
      phase: "list",
      start: "1000",
      pass: "rest",
      pageToken: "p2",
      reconcile: false,
      after: AFTER,
    });
  });

  it("a page always fetches one message", async () => {
    // A page of one, by its limit, from a list page and from pending ids alike.
    const { page } = google(bigBox());
    const handed: string[] = [];
    let cursor = restPass();
    for (let call = 0; call < 12; call += 1) {
      const one = await page(cursor, 1);
      expect(one.items, String(call)).toHaveLength(1);
      handed.push(...one.items.map((raw) => raw.sourceItemId));
      cursor = one.next;
    }
    expect(handed).toEqual(ids.map((id) => `gmail-id:${id}`));
    // The control: the bound never stops a page before its first message.
    const pending = await google(bigBox()).page(restPass({ pageToken: "p2", pending: ["b01"] }));
    expect(pending.items).toHaveLength(1);
  });

  it("a history page's deletions come with its first part", async () => {
    const box = bigBox();
    box.history = {
      "1000|": {
        historyId: "1010",
        history: [
          {
            id: "1001",
            messagesAdded: ids.map((id) => ({ message: { id } })),
            messagesDeleted: [{ message: { id: "d1" } }],
          },
        ],
      },
    };
    const { page, paths, calls } = google(box);
    const first = await page(HISTORY);
    expect([first.items.length, first.deletions, first.more]).toEqual([9, gone("d1"), true]);
    expect(decoded(first.next)).toEqual({
      v: 4,
      connector: "google_mail",
      phase: "history",
      historyId: "1010",
      pending: ["b10", "b11", "b12"],
    });
    calls.length = 0;
    const second = await page(first.next);
    expect(paths()).toEqual(["/messages/b10", "/messages/b11", "/messages/b12"]);
    expect([second.items.length, second.deletions, second.more]).toEqual([3, [], false]);
    expect(second.items.every((one) => one.changeKind === "live")).toBe(true);
    expect(decoded(second.next)).toEqual({ v: 4, connector: "google_mail", phase: "history", historyId: "1010" });
  });

  it("a sent message whose fetch the byte bound defers still has its thread checked when it is fetched", async () => {
    // Twelve messages of 2 MiB in one history page; the tenth the owner sent, in a thread with a
    // conditional Social message. Whether its thread is looked up is read from its history
    // record's labels, before it is fetched.
    const box = bigBox();
    const labels = (id: string): string[] => (id === "b10" ? ["SENT"] : ["INBOX"]);
    box.messages = {
      ...box.messages,
      b10: answer("b10", ["SENT"], big("b10"), { threadId: "t-shared" }),
      c1: answer("c1", ["INBOX", "CATEGORY_SOCIAL"], "Body of c1", { threadId: "t-shared" }),
    };
    box.threads = {
      "t-shared": {
        id: "t-shared",
        historyId: "1009",
        messages: [
          { id: "b10", threadId: "t-shared", labelIds: ["SENT"] },
          { id: "c1", threadId: "t-shared", labelIds: ["INBOX", "CATEGORY_SOCIAL"] },
        ],
      },
    };
    box.history = {
      "1000|": {
        historyId: "1010",
        history: [
          {
            id: "1001",
            messagesAdded: ids.map((id) => ({
              message: { id, threadId: id === "b10" ? "t-shared" : `t-${id}`, labelIds: labels(id) },
            })),
          },
        ],
      },
    };
    const { page, paths, calls } = google(box);

    const first = await page(HISTORY);
    expect(first.items.map((one) => one.sourceItemId)).toEqual(ids.slice(0, 9).map((id) => `gmail-id:${id}`));
    expect(paths().some((path) => path.startsWith("/threads/"))).toBe(false);
    expect(first.more).toBe(true);
    expect(decoded(first.next)).toEqual({
      v: 4,
      connector: "google_mail",
      phase: "history",
      historyId: "1010",
      pending: ["b10", "b11", "b12"],
      sent: ["b10"],
      seen: ids.slice(0, 9),
    });

    // The next page fetches the three, then asks for the sent one's thread and fetches its
    // conditional message after it.
    calls.length = 0;
    const second = await page(first.next);
    expect(paths()).toEqual(["/messages/b10", "/messages/b11", "/messages/b12", "/threads/t-shared", "/messages/c1"]);
    expect(second.items).toEqual([
      item(read("b10", ["SENT"], big("b10"), "t-shared"), "live"),
      item(read("b11", ["INBOX"], big("b11")), "live"),
      item(read("b12", ["INBOX"], big("b12")), "live"),
      item(read("c1", ["INBOX", "CATEGORY_SOCIAL"], "Body of c1", "t-shared"), "live"),
    ]);
    expect([second.more, decoded(second.next)]).toEqual([
      false,
      { v: 4, connector: "google_mail", phase: "history", historyId: "1010" },
    ]);
  });

  it("the rest of a history page fetches no message its first part handed over, and asks for no thread it asked for", async () => {
    // One history page adds a Social message c1 and, after nine messages of 2 MiB, a sent
    // message s2, both in thread t-shared, which also holds d1, a Social message not on the
    // page. With `withA1`, a sent message a1 of the same thread comes first.
    const pageOf = (withA1: boolean) => {
      const nine = ids.slice(0, 9);
      const shared = (id: string, labelIds: string[], body = `Body of ${id}`) =>
        answer(id, labelIds, body, { threadId: "t-shared" });
      const box = bigBox();
      box.messages = {
        ...box.messages,
        a1: shared("a1", ["SENT"]),
        c1: shared("c1", ["INBOX", "CATEGORY_SOCIAL"]),
        d1: shared("d1", ["INBOX", "CATEGORY_SOCIAL"]),
        s2: shared("s2", ["SENT"]),
      };
      box.threads = {
        "t-shared": {
          id: "t-shared",
          historyId: "1009",
          messages: [
            ["a1", ["SENT"]],
            ["c1", ["INBOX", "CATEGORY_SOCIAL"]],
            ["d1", ["INBOX", "CATEGORY_SOCIAL"]],
            ["s2", ["SENT"]],
          ].map(([id, labelIds]) => ({ id, threadId: "t-shared", labelIds })),
        },
      };
      const record = (id: string, labelIds: string[]) => ({
        message: { id, threadId: id.startsWith("b") ? `t-${id}` : "t-shared", labelIds },
      });
      const addedIds = [...(withA1 ? ["a1"] : []), "c1", ...nine, "s2"];
      const labels = (id: string): string[] =>
        id === "a1" || id === "s2" ? ["SENT"] : id === "c1" ? ["INBOX", "CATEGORY_SOCIAL"] : ["INBOX"];
      box.history = {
        "1000|": {
          historyId: "1010",
          history: [{ id: "1001", messagesAdded: addedIds.map((id) => record(id, labels(id))) }],
        },
      };
      return box;
    };

    // Without a1: the first part fetches c1 and stops before s2; the rest fetches s2, asks for
    // its thread once, and fetches d1 and not c1.
    const plain = google(pageOf(false));
    const first = await plain.page(HISTORY);
    expect(first.items.map((one) => one.sourceItemId)).toEqual(
      ["c1", ...ids.slice(0, 9)].map((id) => `gmail-id:${id}`),
    );
    expect(plain.paths().some((path) => path.startsWith("/threads/"))).toBe(false);
    expect(decoded(first.next)).toEqual({
      v: 4,
      connector: "google_mail",
      phase: "history",
      historyId: "1010",
      pending: ["s2"],
      sent: ["s2"],
      seen: ["c1", ...ids.slice(0, 9)],
    });
    plain.calls.length = 0;
    const second = await plain.page(first.next);
    expect(plain.paths()).toEqual(["/messages/s2", "/threads/t-shared", "/messages/d1"]);
    expect(second.items.map((one) => one.sourceItemId)).toEqual(["gmail-id:s2", "gmail-id:d1"]);
    expect([second.more, decoded(second.next)]).toEqual([
      false,
      { v: 4, connector: "google_mail", phase: "history", historyId: "1010" },
    ]);

    // With a1: the first part asks for the thread and leaves d1 pending after s2; the rest
    // fetches s2 and d1 and asks for the thread no more.
    const twice = google(pageOf(true));
    const one = await twice.page(HISTORY);
    expect(twice.paths().filter((path) => path.startsWith("/threads/"))).toEqual(["/threads/t-shared"]);
    // The cursor names what the first part handled and the thread it asked for.
    const handled = ["a1", "c1", ...ids.slice(0, 9)];
    expect(decoded(one.next)).toEqual({
      v: 4,
      connector: "google_mail",
      phase: "history",
      historyId: "1010",
      pending: ["s2", "d1"],
      sent: ["s2"],
      seen: handled,
      threads: ["t-shared"],
    });
    twice.calls.length = 0;
    const two = await twice.page(one.next);
    expect(twice.paths()).toEqual(["/messages/s2", "/messages/d1"]);
    expect(two.items.map((raw) => raw.sourceItemId)).toEqual(["gmail-id:s2", "gmail-id:d1"]);
    expect(two.more).toBe(false);
  });

  it("each request waits its turn: 11 ms a quota unit, so 220 ms after a fetch and 55 ms after a list", async () => {
    // The clock moves only by the waits.
    const { page, clock, paths } = google({
      callMs: 0,
      passes: { rest: { "": { ids: ["m1", "m2", "m3"], next: "p2" }, p2: { ids: ["m4"] } } },
      messages: { m1: answer("m1"), m2: answer("m2"), m3: answer("m3"), m4: answer("m4") },
    });
    const first = await page(restPass());
    await page(first.next);
    expect(paths()).toEqual(["/messages", "/messages/m1", "/messages/m2", "/messages/m3", "/messages", "/messages/m4"]);
    // A list costs 5 units and a fetch 20: three messages on one page, and the first of the next,
    // with the second list between them.
    expect(clock.sleeps).toEqual([55, 220, 220, 220, 55]);
    expect([GMAIL_MS_PER_UNIT * 20, GMAIL_MS_PER_UNIT * 5]).toEqual([220, 55]);
  });

  it("at most four fetches are in flight at once, and no other request goes alongside one", async () => {
    const ids = ["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8"];
    const { page, flight } = google({
      passes: { rest: { "": { ids, next: "p2" }, p2: { ids: ["m9"] } } },
      messages: Object.fromEntries([...ids, "m9"].map((id) => [id, answer(id)])),
    });
    const first = await page(restPass());
    expect(first.items).toEqual(items(ids));
    await page(first.next);
    const fetches = flight.alongside.filter(([path]) => path.startsWith("/messages/"));
    expect(Math.max(...fetches.map(([, alongside]) => alongside))).toBe(GMAIL_FETCHES_AT_ONCE - 1);
    expect(flight.most).toBe(4);
    for (const [path, alongside] of flight.alongside)
      if (!path.startsWith("/messages/")) expect(alongside, path).toBe(0);
  });

  it("a page hands its items over in the list's order, newest first, whatever order the answers end in", async () => {
    const { page, flight } = google({
      passes: { rest: { "": { ids: ["m1", "m2", "m3"] } } },
      messages: { m1: answer("m1"), m2: answer("m2"), m3: answer("m3") },
      ticks: { "/messages/m1": 8, "/messages/m3": 3 },
    });
    expect((await page(restPass())).items).toEqual(items(["m1", "m2", "m3"]));
    expect(flight.most).toBe(3);
  });

  it("a rate limit pauses 30 s, halves the pace and goes on; the pace comes back after two minutes without one", async () => {
    // m1 answers 429 five times, so the port gives up once; m2's answer takes two minutes.
    const { page, clock, limits } = google({
      callMs: 0,
      passes: { rest: { "": { ids: ["m1"], next: "p2" }, p2: { ids: ["m2"], next: "p3" }, p3: { ids: ["m3"] } } },
      messages: { m1: answer("m1"), m2: { status: 200, body: answer("m2"), wait: 120_000 }, m3: answer("m3") },
      limited: { "/messages/m1": 5 },
    });
    const first = await page(restPass());
    expect(first.items).toEqual(items(["m1"]));
    // The port's four backoffs, then the pause; the retry starts when it ends.
    expect(clock.sleeps).toEqual([55, 750, 1500, 3000, 6000, 30_000]);
    expect(limits).toEqual([["rate_limit_exceeded", 30_000]]);
    // Half the pace: 440 ms after a fetch and 110 after a list.
    clock.sleeps.length = 0;
    const second = await page(first.next);
    expect(second.items).toEqual(items(["m2"]));
    expect(clock.sleeps).toEqual([440, 110]);
    // Two minutes later the pace is whole again.
    clock.sleeps.length = 0;
    expect((await page(second.next)).items).toEqual(items(["m3"]));
    expect(clock.sleeps).toEqual([55]);
  });

  it("a rate-limited list, history or thread call waits and goes on too", async () => {
    const box = (): Mailbox => ({
      callMs: 0,
      passes: { rest: { "": { ids: ["m1"] } } },
      messages: { m1: answer("m1"), m2: answer("m2", ["SENT"]) },
      history: {
        "1000|": {
          historyId: "1010",
          history: [{ id: "1001", messagesAdded: [{ message: { id: "m2", threadId: "t-m2", labelIds: ["SENT"] } }] }],
        },
      },
      threads: { "t-m2": { id: "t-m2", messages: [{ id: "m2", labelIds: ["SENT"] }] } },
    });
    for (const path of ["/messages", "/history", "/threads/t-m2"]) {
      const { page, limits, calls } = google({ ...box(), limited: { [path]: 5 } });
      const one = await page(path === "/messages" ? restPass() : HISTORY);
      expect(one.items, path).toHaveLength(1);
      expect(limits, path).toEqual([["rate_limit_exceeded", 30_000]]);
      expect(
        calls.filter((url) => url.pathname === `${API}${path}`),
        path,
      ).toHaveLength(6);
    }
  });

  it("with several fetches limited at once, a pause is taken once, and the end is reported once", async () => {
    const ids = ["m1", "m2", "m3", "m4"];
    const { page, limits, clock } = google({
      callMs: 0,
      passes: { rest: { "": { ids } } },
      messages: Object.fromEntries(ids.map((id) => [id, answer(id)])),
      limited: Object.fromEntries(ids.map((id) => [`/messages/${id}`, 1000])),
    });
    expect((await failure(page(restPass()))).code).toBe("rate_limited");
    const ends = limits.filter(([, paused]) => paused === 0);
    expect(ends).toHaveLength(1);
    expect(limits.at(-1)).toEqual(["rate_limit_exceeded", 0]);
    // Each pause is one 30 s sleep, and no request began during one.
    expect(clock.sleeps.filter((ms) => ms === 30_000).length).toBeLessThanOrEqual(limits.length - 1);
  });

  it("past five minutes of rate limits in one run the page fails rate_limited with its reason, and the connector asks for nothing more", async () => {
    const { page, calls, limits } = google({
      callMs: 0,
      passes: { rest: { "": { ids: ["m1"] } } },
      messages: { m1: answer("m1") },
      limited: { "/messages/m1": 1000 },
      limitedWith: { error: { code: 403, errors: [{ domain: "usageLimits", reason: "userRateLimitExceeded" }] } },
    });
    const error = await failure(page(restPass()));
    expect([error.code, error.reason]).toEqual(["rate_limited", "user_rate_limit_exceeded"]);
    // Each round is the port's five attempts, 11.25 s of backoff, and a 30 s pause: seven fit in
    // five minutes, and the eighth would not, so it ends there with no pause.
    expect(limits).toEqual([
      ...Array.from({ length: 7 }, () => ["user_rate_limit_exceeded", 30_000]),
      ["user_rate_limit_exceeded", 0],
    ]);
    expect(calls.filter((url) => url.pathname === `${API}/messages/m1`)).toHaveLength(40);
    expect(GMAIL_RATE_LIMIT_WAIT_MS).toBe(300_000);
    // The run is over for this connector: a later page fails at once, with no request.
    const asked = calls.length;
    expect((await failure(page(restPass()))).code).toBe("rate_limited");
    expect(calls).toHaveLength(asked);
  });
});

describe("more", () => {
  it("more is true exactly when the source has another page, whatever the page holds", async () => {
    const { page } = google(
      {
        historyId: "1000",
        passes: { sent: { "": { ids: ["m1"], next: "p2" }, p2: { ids: [] } }, rest: { "": { ids: ["m2"] } } },
        messages: { m1: answer("m1", ["SENT"]), m2: answer("m2") },
        history: {
          // A page of label changes that derive nothing hands nothing over, and still leads on.
          "1000|": {
            historyId: "1010",
            nextPageToken: "h2",
            history: [{ id: "1001", labelsAdded: [{ message: { id: "m1" }, labelIds: ["STARRED"] }] }],
          },
          "1000|h2": { historyId: "1010", history: [{ id: "1002", messagesAdded: [{ message: { id: "m2" } }] }] },
          "1010|": { historyId: "1010" },
        },
      },
      { since: SINCE },
    );
    const pages: PersonalPage[] = [await page(null)];
    for (let next = 1; next < 6; next += 1) pages.push(await page((pages.at(-1) as PersonalPage).next));
    expect(pages.map((one) => [one.items.length, one.listing?.ended, one.more])).toEqual([
      [1, undefined, true],
      // The sent pass's empty last page: the rest pass is still to read.
      [0, undefined, true],
      [1, "window", false],
      [0, undefined, true],
      [1, undefined, false],
      [0, undefined, false],
    ]);
  });
});

describe("every Gmail page", () => {
  const box: Mailbox = {
    historyId: "1000",
    passes: { sent: { "": { ids: ["m1"] } }, rest: { "": { ids: ["m2"] } } },
    messages: { m1: answer("m1", ["SENT"]), m2: answer("m2"), m4: answer("m4") },
    history: {
      "1000|": {
        historyId: "1005",
        history: [
          { id: "1001", messagesAdded: [{ message: { id: "m4" } }], messagesDeleted: [{ message: { id: "m2" } }] },
        ],
      },
    },
  };

  it("every API request is a read with the timeout from deps", async () => {
    const { requests, page, http, deps } = google(box, {}, 4321);
    const first = await page(null);
    const second = await page(first.next);
    await page(second.next);
    await gmailProfile(http, deps);
    expect(requests).toHaveLength(8);
    for (const request of requests) {
      expect(request).toEqual({ method: "GET", url: request.url, headers: {}, timeoutMs: 4321, kind: "read" });
      expect(new URL(request.url).origin).toBe("https://gmail.googleapis.com");
    }
  });

  it("a profile, list or history request starts only when nothing else is in flight", async () => {
    const { flight, calls, page } = google(box);
    const first = await page(null);
    const second = await page(first.next);
    await page(second.next);
    expect(calls).toHaveLength(7);
    for (const [path, alongside] of flight.alongside)
      if (!path.startsWith("/messages/")) expect(alongside, path).toBe(0);
  });
});
