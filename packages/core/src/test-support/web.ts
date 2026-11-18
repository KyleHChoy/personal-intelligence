import { FetcherAnswer, FetcherRequest, type FetchOutcome, PageUrl } from "@intelligence/contracts/personal";
import { coded } from "./support.ts";

// A recorded web for the research lane: the fetcher's line protocol answered from what the world
// holds, on reserved hosts only. It answers as the fetcher does: no redirect followed, only a 2xx
// text/html or text/plain body read, up to 1 MiB for a page and 64 KiB for robots.txt, a 404 or 410
// as `gone`. Every request is recorded as it was given, before anything is checked, so a test can
// say what would have left.

// One page as a site would answer it: its status, its media type as sent (parameters and all)
// and its body as text. A page that never answers is `timeout`.
export type WebPage = { url: string; status: number; mediaType: string; body: string } | { url: string; timeout: true };

// One recorded search: the query as `resolveQuery` gives it, and the URLs the vendor answered.
export type WebSearch = { query: { words: string; values: string[] }; urls: string[] };

// A host's robots.txt, by its origin (`https://host`). A host with none answers 404.
export type WebRobots = { origin: string; status: number; mediaType: string; body: string };

// `search` absent is no provider, as a fetcher with no search provider answers.
export type FakeWebWorld = { search?: WebSearch[]; pages: WebPage[]; robots: WebRobots[] };

export type FakeWeb = {
  ask(request: unknown): Promise<FetcherAnswer>;
  // Every request given, in order, as given.
  readonly requests: unknown[];
};

const MAX_PAGE = 1024 * 1024;
const MAX_ROBOTS = 64 * 1024;
const MAX_URLS = 10;
const TEXT = ["text/html", "text/plain"];

const bare = (mediaType: string): string => (mediaType.split(";")[0] ?? "").trim().toLowerCase();
const sameQuery = (a: WebSearch["query"], b: WebSearch["query"]): boolean =>
  a.words === b.words && a.values.length === b.values.length && a.values.every((value, at) => value === b.values[at]);

// What an answer that is not a body comes to, as the fetcher reads the status.
function statusOutcome(status: number): FetchOutcome | null {
  if (status >= 300 && status < 400) return "redirect";
  if (status === 404 || status === 410) return "gone";
  if (status >= 400 && status < 500) return "http_4xx";
  if (status >= 500) return "http_5xx";
  return null;
}

type Read = { status: number | null; mediaType: string | null; body: string | null; outcome: FetchOutcome | null };

// One answer read as the fetcher reads it: the status first, then the media type, then the size.
function read(answer: WebPage | undefined, limit: number): Read {
  if (answer === undefined) return { status: 404, mediaType: null, body: null, outcome: "gone" };
  if ("timeout" in answer) return { status: null, mediaType: null, body: null, outcome: "timeout" };
  const mediaType = bare(answer.mediaType);
  const byStatus = statusOutcome(answer.status);
  if (byStatus !== null) return { status: answer.status, mediaType, body: null, outcome: byStatus };
  if (!TEXT.includes(mediaType)) return { status: answer.status, mediaType, body: null, outcome: "not_text" };
  if (Buffer.byteLength(answer.body, "utf8") > limit)
    return { status: answer.status, mediaType, body: null, outcome: "too_large" };
  return { status: answer.status, mediaType, body: answer.body, outcome: null };
}

export function fakeWeb(world: FakeWebWorld): FakeWeb {
  // The world itself must be one the fetcher could answer: page URLs, at most ten per search.
  const search = world.search?.map((one) => ({
    query: one.query,
    urls: PageUrl.array().max(MAX_URLS).parse(one.urls),
  }));
  const pages = new Map(world.pages.map((one) => [PageUrl.parse(one.url), one]));
  const robots = new Map(world.robots.map((one) => [new URL(one.origin).origin, one]));
  const requests: unknown[] = [];

  const ask = async (given: unknown): Promise<FetcherAnswer> => {
    requests.push(structuredClone(given));
    const parsed = FetcherRequest.safeParse(given);
    if (!parsed.success) throw coded("bad_request");
    const request = parsed.data;
    if (request.kind === "search") {
      if (search === undefined) return { kind: "search", urls: [], outcome: "no_provider" };
      return {
        kind: "search",
        urls: search.find((one) => sameQuery(one.query, request.query))?.urls ?? [],
        outcome: null,
      };
    }
    if (request.kind === "robots") {
      const one = robots.get(new URL(request.url).origin);
      const { body, outcome } = read(one === undefined ? undefined : { url: request.url, ...one }, MAX_ROBOTS);
      return FetcherAnswer.parse({ kind: "robots", url: request.url, body, outcome });
    }
    const { status, mediaType, body, outcome } = read(pages.get(request.url), MAX_PAGE);
    return FetcherAnswer.parse({
      kind: "page",
      url: request.url,
      status,
      mediaType,
      body: body === null ? null : Buffer.from(body, "utf8").toString("base64"),
      outcome,
    });
  };

  return { ask, requests };
}
