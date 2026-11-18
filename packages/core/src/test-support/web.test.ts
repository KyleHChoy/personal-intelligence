import { FetcherAnswer } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { type FakeWebWorld, fakeWeb } from "./web.ts";

const MiB = 1024 * 1024;
const page = (url: string, body: string, mediaType = "text/html; charset=utf-8") => ({
  url,
  status: 200,
  mediaType,
  body,
});
const decoded = (answer: FetcherAnswer): string | null =>
  answer.kind === "page" && answer.body !== null ? Buffer.from(answer.body, "base64").toString("utf8") : null;

const WEB: FakeWebWorld = {
  search: [
    {
      query: { words: "public professional profile of this named person", values: ["Mara Ellison"] },
      urls: ["https://profiles.example/people/mara-ellison", "https://slow.example/x"],
    },
  ],
  pages: [
    page("https://profiles.example/people/mara-ellison", "<html><body><p>Studio director.</p></body></html>"),
    page("https://filings.example/annual.txt", "Director: Mara Ellison\n", "text/plain"),
    { url: "https://profiles.example/people/m-ellison", status: 301, mediaType: "text/html", body: "" },
    page("https://profiles.example/photo", "PNG", "image/png"),
    page("https://archive.example/big", "x".repeat(MiB + 1)),
    page("https://archive.example/whole", "x".repeat(MiB)),
    { url: "https://profiles.example/people/former", status: 404, mediaType: "text/html", body: "Not found" },
    { url: "https://profiles.example/people/banned", status: 403, mediaType: "text/html", body: "No" },
    { url: "https://flaky.example/x", status: 503, mediaType: "text/html", body: "Later" },
    { url: "https://slow.example/x", timeout: true },
  ],
  robots: [
    {
      origin: "https://boards.example",
      status: 200,
      mediaType: "text/plain",
      body: "User-agent: *\nDisallow: /private/\n",
    },
    { origin: "https://flaky.example", status: 503, mediaType: "text/plain", body: "" },
    { origin: "https://huge.example", status: 200, mediaType: "text/plain", body: "#".repeat(64 * 1024 + 1) },
  ],
};

describe("fakeWeb", () => {
  it("the fake web records every request and answers what the world says", async () => {
    const web = fakeWeb(WEB);
    const ask = (request: unknown) => web.ask(request);

    const found = await ask({
      kind: "search",
      query: { words: "public professional profile of this named person", values: ["Mara Ellison"] },
    });
    expect(found).toEqual({
      kind: "search",
      urls: ["https://profiles.example/people/mara-ellison", "https://slow.example/x"],
      outcome: null,
    });
    expect(
      await ask({
        kind: "search",
        query: { words: "public professional profile of this named person", values: ["Nobody Known"] },
      }),
    ).toEqual({ kind: "search", urls: [], outcome: null });

    const html = await ask({ kind: "page", url: "https://profiles.example/people/mara-ellison" });
    expect(html).toMatchObject({
      kind: "page",
      url: "https://profiles.example/people/mara-ellison",
      status: 200,
      mediaType: "text/html",
      outcome: null,
    });
    expect(decoded(html)).toBe("<html><body><p>Studio director.</p></body></html>");
    expect(await ask({ kind: "page", url: "https://filings.example/annual.txt" })).toMatchObject({
      status: 200,
      mediaType: "text/plain",
      outcome: null,
    });

    const outcomes = async (url: string) => {
      const answer = await ask({ kind: "page", url });
      return answer.kind === "page" ? [answer.status, answer.body, answer.outcome] : null;
    };
    expect(await outcomes("https://profiles.example/people/m-ellison")).toEqual([301, null, "redirect"]);
    expect(await outcomes("https://profiles.example/photo")).toEqual([200, null, "not_text"]);
    expect(await outcomes("https://archive.example/big")).toEqual([200, null, "too_large"]);
    expect((await outcomes("https://archive.example/whole"))?.[2]).toBeNull();
    expect(await outcomes("https://profiles.example/people/former")).toEqual([404, null, "gone"]);
    expect(await outcomes("https://profiles.example/people/banned")).toEqual([403, null, "http_4xx"]);
    expect(await outcomes("https://flaky.example/x")).toEqual([503, null, "http_5xx"]);
    expect(await outcomes("https://slow.example/x")).toEqual([null, null, "timeout"]);
    // A URL the world does not hold is not found.
    expect(await outcomes("https://profiles.example/people/unknown")).toEqual([404, null, "gone"]);

    expect(await ask({ kind: "robots", url: "https://boards.example/robots.txt" })).toEqual({
      kind: "robots",
      url: "https://boards.example/robots.txt",
      body: "User-agent: *\nDisallow: /private/\n",
      outcome: null,
    });
    expect(await ask({ kind: "robots", url: "https://flaky.example/robots.txt" })).toEqual({
      kind: "robots",
      url: "https://flaky.example/robots.txt",
      body: null,
      outcome: "http_5xx",
    });
    expect(await ask({ kind: "robots", url: "https://profiles.example/robots.txt" })).toEqual({
      kind: "robots",
      url: "https://profiles.example/robots.txt",
      body: null,
      outcome: "gone",
    });
    expect(await ask({ kind: "robots", url: "https://huge.example/robots.txt" })).toEqual({
      kind: "robots",
      url: "https://huge.example/robots.txt",
      body: null,
      outcome: "too_large",
    });

    // Every answer is one the fetcher may give.
    for (const request of web.requests)
      expect(FetcherAnswer.safeParse(await fakeWeb(WEB).ask(request)).success).toBe(true);
    // Every request, in order, as it was given.
    expect(web.requests).toHaveLength(17);
    expect(web.requests[0]).toEqual({
      kind: "search",
      query: { words: "public professional profile of this named person", values: ["Mara Ellison"] },
    });
    expect(web.requests.at(-1)).toEqual({ kind: "robots", url: "https://huge.example/robots.txt" });
  });

  it("with no provider every search answers no_provider, as the fetcher does until a search provider is configured", async () => {
    const { search: _search, ...noProvider } = WEB;
    const web = fakeWeb(noProvider);
    expect(
      await web.ask({
        kind: "search",
        query: { words: "public professional profile of this named person", values: ["Mara Ellison"] },
      }),
    ).toEqual({ kind: "search", urls: [], outcome: "no_provider" });
    expect(web.requests).toHaveLength(1);
  });

  it("a request that is not a FetcherRequest is recorded and refused bad_request", async () => {
    const web = fakeWeb(WEB);
    await expect(
      web.ask({ kind: "page", url: "https://profiles.example/people/mara-ellison", referer: "x" }),
    ).rejects.toMatchObject({ code: "bad_request" });
    await expect(web.ask({ kind: "page", url: "http://intranet.local/" })).rejects.toMatchObject({
      code: "bad_request",
    });
    expect(web.requests).toHaveLength(2);
  });

  it("refuses a world whose search names more than ten URLs or a URL that is no page URL", () => {
    const urls = Array.from({ length: 11 }, (_, n) => `https://profiles.example/p${n}`);
    expect(() => fakeWeb({ ...WEB, search: [{ query: { words: "w", values: ["v"] }, urls }] })).toThrow();
    expect(() => fakeWeb({ ...WEB, pages: [page("https://intranet.local/x", "x")] })).toThrow();
  });
});
