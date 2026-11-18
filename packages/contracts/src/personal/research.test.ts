import { PublicIdentifier } from "@intelligence/contracts";
import type { PersonalReads, ReadOutcome } from "@intelligence/contracts/personal";
import {
  DECISION_DETAILS,
  EFFECT_CLASS,
  FactView,
  FetcherAnswer,
  FetcherRequest,
  FetchOutcome,
  OwnerDecisionKind,
  PageId,
  PageUrl,
  PersonalLogEvent,
  PersonalRef,
  PersonalTool,
  RESEARCH_TEMPLATES,
  RESEARCH_TOOL_VIEW,
  ResearchAnswer,
  ResearchArgs,
  ResearchDecisionAnswer,
  ResearchDecisionDetails,
  ResearchFetchId,
  ResearchGateCause,
  ResearchRefusal,
  ResearchRequestId,
  ResearchSettingsPatch,
  ResearchState,
  ResearchTemplateId,
  TriageLane,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";

// The shapes of public sources and the research lane. Made-up values only, on .example hosts.
const ULID = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const at = "2026-03-04T10:00:00Z";
const accepts = (schema: { safeParse(value: unknown): { success: boolean } }, value: unknown): boolean =>
  schema.safeParse(value).success;

const search = {
  kind: "search",
  requestId: "req-0001",
  template: "person_role",
  identifiers: [
    { kind: "person_name", value: "Alex Example" },
    { kind: "organization_name", value: "Example Works" },
  ],
  about: `ent_${ULID}`,
};
const link = { kind: "link", requestId: "req-0002", message: `msg_${ULID}`, url: "https://news.example/story" };

// Every schema inside a schema, with the object key it sits under: objects, unions, arrays,
// wrappers and both sides of a pipe.
type Def = {
  shape?: Record<string, unknown>;
  element?: unknown;
  innerType?: unknown;
  options?: unknown[];
  in?: unknown;
  out?: unknown;
  keyType?: unknown;
  valueType?: unknown;
};
function keysOf(schema: unknown, seen = new Set<unknown>()): string[] {
  if (typeof schema !== "object" || schema === null || seen.has(schema)) return [];
  seen.add(schema);
  const def = (schema as { _zod?: { def?: Def } })._zod?.def;
  if (def === undefined) return [];
  const own = Object.keys(def.shape ?? {});
  const children = [
    ...Object.values(def.shape ?? {}),
    def.element,
    def.innerType,
    def.in,
    def.out,
    def.keyType,
    def.valueType,
    ...(def.options ?? []),
  ];
  return [...own, ...children.flatMap((child) => keysOf(child, seen))];
}

describe("research contracts", () => {
  it("each research id has its prefix and a ULID", () => {
    for (const [schema, prefix] of [
      [ResearchRequestId, "rsq"],
      [PageId, "pag"],
      [ResearchFetchId, "rft"],
    ] as const) {
      expect(accepts(schema, `${prefix}_${ULID}`), prefix).toBe(true);
      expect(accepts(schema, `msg_${ULID}`), prefix).toBe(false);
      expect(accepts(schema, `${prefix}_${ULID.toLowerCase()}`), prefix).toBe(false);
    }
  });

  it("ResearchArgs refuses a free-text field, a url kind, four identifiers and an unknown template", () => {
    expect(accepts(ResearchArgs, search)).toBe(true);
    expect(accepts(ResearchArgs, link)).toBe(true);
    expect(
      accepts(ResearchArgs, { ...search, template: "person_profile", identifiers: search.identifiers.slice(0, 1) }),
    ).toBe(true);
    expect(accepts(ResearchArgs, { ...search, query: "who is Alex Example" })).toBe(false);
    expect(accepts(ResearchArgs, { ...search, purpose: "an intro" })).toBe(false);
    expect(accepts(ResearchArgs, { ...link, note: "read this" })).toBe(false);
    expect(accepts(ResearchArgs, { kind: "url", requestId: "req-0003", url: "https://news.example/story" })).toBe(
      false,
    );
    const four = [
      ...search.identifiers,
      { kind: "domain", value: "example.com" },
      { kind: "person_name", value: "Sam Example" },
    ];
    expect(accepts(ResearchArgs, { ...search, identifiers: four })).toBe(false);
    expect(accepts(ResearchArgs, { ...search, identifiers: [] })).toBe(false);
    expect(accepts(ResearchArgs, { ...search, template: "anything_goes" })).toBe(false);
    // An identifier is the shared PublicIdentifier: no operator, no slash, no at sign.
    expect(
      accepts(ResearchArgs, { ...search, identifiers: [{ kind: "person_name", value: "Alex OR site:example.com" }] }),
    ).toBe(false);
    expect(accepts(ResearchArgs, { ...search, identifiers: [{ kind: "email", value: "alex@example.com" }] })).toBe(
      false,
    );
    // Every write carries a request id.
    const { requestId: _search, ...unkeyed } = search;
    expect(accepts(ResearchArgs, unkeyed)).toBe(false);
    expect(accepts(ResearchArgs, { ...link, url: "https://news.example/story?ref=1" })).toBe(true);
    expect(accepts(ResearchArgs, { ...link, url: "ftp://news.example/story" })).toBe(false);
    expect(accepts(ResearchArgs, { ...search, about: `msg_${ULID}` })).toBe(false);
  });

  it("a search's identifiers are one of its template's combinations of kinds, in any order", () => {
    const name = { kind: "person_name", value: "Alex Example" };
    const organization = { kind: "organization_name", value: "Example Works" };
    const domain = { kind: "domain", value: "example.com" };
    const with_ = (template: string, identifiers: unknown[]) => ({ ...search, template, identifiers });
    expect(accepts(ResearchArgs, with_("person_role", [organization, name]))).toBe(true);
    expect(accepts(ResearchArgs, with_("person_role", [name, domain]))).toBe(true);
    expect(accepts(ResearchArgs, with_("person_profile", [name]))).toBe(true);
    expect(accepts(ResearchArgs, with_("organization_profile", [domain]))).toBe(true);
    expect(accepts(ResearchArgs, with_("organization_filings", [organization]))).toBe(true);
    expect(accepts(ResearchArgs, with_("person_role", [name]))).toBe(false);
    expect(accepts(ResearchArgs, with_("person_role", [name, organization, domain]))).toBe(false);
    expect(accepts(ResearchArgs, with_("person_role", [name, name]))).toBe(false);
    expect(accepts(ResearchArgs, with_("organization_filings", [name]))).toBe(false);
    expect(accepts(ResearchArgs, with_("organization_filings", [domain]))).toBe(false);
    expect(accepts(ResearchArgs, with_("organization_profile", [organization, domain]))).toBe(false);
  });

  it("PageUrl refuses a user part, a port, a scheme other than http and https, a reserved top-level domain, and a URL over 2 048 characters, and drops a fragment in its canonical form", () => {
    for (const url of [
      "https://news.example/story",
      "http://news.example/",
      "https://news.example/a?b=1",
      "https://203.0.113.9/x",
      "https://[2001:db8::1]/x",
    ]) {
      expect(accepts(PageUrl, url), url).toBe(true);
    }
    for (const url of [
      "https://alex@news.example/story",
      "https://alex:secret@news.example/story",
      "https://news.example:8443/story",
      "ftp://news.example/story",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "https://intranet.internal/story",
      "https://box.local/",
      "https://metadata.localhost/",
      "https://news.test/",
      "https://news.example./",
      "https://news.example/a b",
      "https://news.example/a\nb",
      "https://news.example\\@evil.example/",
      "news.example/story",
      "",
    ]) {
      expect(accepts(PageUrl, url), url).toBe(false);
    }
    const path = (length: number): string =>
      `https://news.example/${"a".repeat(length - "https://news.example/".length)}`;
    expect(accepts(PageUrl, path(2048))).toBe(true);
    expect(accepts(PageUrl, path(2049))).toBe(false);
    // The canonical form: a lower-case host, no fragment, a scheme's default port dropped.
    expect(PageUrl.parse("https://News.Example/Story#section-2")).toBe("https://news.example/Story");
    expect(PageUrl.parse("https://news.example:443/a?b=1#c")).toBe("https://news.example/a?b=1");
    expect(PageUrl.parse("http://news.example:80")).toBe("http://news.example/");
  });

  it("RESEARCH_TEMPLATES is frozen and every row's kinds are identifier kinds", () => {
    expect(Object.keys(RESEARCH_TEMPLATES)).toEqual([
      "person_role",
      "person_profile",
      "organization_profile",
      "organization_people",
      "organization_filings",
    ]);
    expect(Object.isFrozen(RESEARCH_TEMPLATES)).toBe(true);
    const kinds = PublicIdentifier.options.map((option) => option.shape.kind.value);
    for (const [id, row] of Object.entries(RESEARCH_TEMPLATES)) {
      expect(accepts(ResearchTemplateId, id), id).toBe(true);
      expect(Object.isFrozen(row) && Object.isFrozen(row.kinds), id).toBe(true);
      expect(row.version, id).toBe(1);
      expect(row.words.length, id).toBeGreaterThan(0);
      expect(row.kinds.length, id).toBeGreaterThan(0);
      for (const set of row.kinds) {
        expect(Object.isFrozen(set), id).toBe(true);
        expect(set.length, id).toBeGreaterThan(0);
        expect(set.length, id).toBeLessThanOrEqual(3);
        for (const kind of set) expect(kinds, `${id} ${kind}`).toContain(kind);
      }
    }
  });

  it("FetcherRequest and FetcherAnswer refuse an extra key", () => {
    const requests = [
      {
        kind: "search",
        query: { words: RESEARCH_TEMPLATES.person_role.words, values: ["Alex Example", "Example Works"] },
      },
      { kind: "page", url: "https://news.example/story" },
      { kind: "robots", url: "https://news.example/robots.txt" },
    ];
    for (const request of requests) {
      expect(accepts(FetcherRequest, request), request.kind).toBe(true);
      expect(accepts(FetcherRequest, { ...request, client: "claude-code" }), request.kind).toBe(false);
    }
    expect(
      accepts(FetcherRequest, {
        kind: "search",
        query: { words: "x", values: ["Alex Example"], entity: `ent_${ULID}` },
      }),
    ).toBe(false);
    // A robots request is for /robots.txt on the page's scheme and host, and nothing else.
    expect(accepts(FetcherRequest, { kind: "robots", url: "https://news.example/story" })).toBe(false);
    expect(accepts(FetcherRequest, { kind: "robots", url: "https://news.example/robots.txt?x=1" })).toBe(false);
    expect(accepts(FetcherRequest, { kind: "page", url: "https://news.example:8080/story" })).toBe(false);

    const answers = [
      { kind: "search", urls: ["https://news.example/a", "https://profiles.example/b?id=1"], outcome: null },
      { kind: "search", urls: [], outcome: "no_provider" },
      {
        kind: "page",
        url: "https://news.example/story",
        status: 200,
        mediaType: "text/html",
        body: "PGh0bWw+PC9odG1sPg==",
        outcome: null,
      },
      {
        kind: "page",
        url: "https://news.example/story",
        status: 301,
        mediaType: null,
        body: null,
        outcome: "redirect",
      },
      {
        kind: "page",
        url: "https://news.example/story",
        status: null,
        mediaType: null,
        body: null,
        outcome: "timeout",
      },
      {
        kind: "robots",
        url: "https://news.example/robots.txt",
        body: "User-agent: *\nDisallow: /private\n",
        outcome: null,
      },
      { kind: "robots", url: "https://news.example/robots.txt", body: null, outcome: "http_5xx" },
    ];
    for (const answer of answers) {
      expect(accepts(FetcherAnswer, answer), JSON.stringify(answer)).toBe(true);
      expect(accepts(FetcherAnswer, { ...answer, request: `rsq_${ULID}` }), answer.kind).toBe(false);
    }
    // A body comes exactly with no outcome, and the fetcher never answers a store's outcome.
    expect(accepts(FetcherAnswer, { ...answers[2], outcome: "stored" })).toBe(false);
    expect(accepts(FetcherAnswer, { ...answers[3], body: "eA==" })).toBe(false);
    expect(accepts(FetcherAnswer, { ...answers[2], body: "not base64!" })).toBe(false);
    expect(accepts(FetcherAnswer, { ...answers[6], outcome: "fresh" })).toBe(false);
    expect(accepts(FetcherAnswer, { ...answers[5], body: "x".repeat(64 * 1024 + 1) })).toBe(false);
    expect(accepts(FetcherAnswer, { ...answers[5], body: "x".repeat(64 * 1024) })).toBe(true);
  });

  it("a search answer holds at most 10 URLs", () => {
    const urls = Array.from({ length: 11 }, (_, i) => `https://news.example/${i}`);
    expect(accepts(FetcherAnswer, { kind: "search", urls: urls.slice(0, 10), outcome: null })).toBe(true);
    expect(accepts(FetcherAnswer, { kind: "search", urls, outcome: null })).toBe(false);
    expect(accepts(FetcherAnswer, { kind: "search", urls: ["https://box.internal/"], outcome: null })).toBe(false);
    // A search that failed names no URL.
    expect(accepts(FetcherAnswer, { kind: "search", urls: urls.slice(0, 1), outcome: "search_failed" })).toBe(false);
    expect(accepts(FetcherAnswer, { kind: "search", urls: [], outcome: "search_failed" })).toBe(true);
  });

  it("no field of ResearchArgs, ResearchAnswer, FetcherRequest or FetcherAnswer is named label, compartment, reader, client, destination or grant", () => {
    const forbidden = /^(labels?|compartments?|readers?|clients?|destinations?|grants?)$/i;
    for (const [name, schema] of Object.entries({ ResearchArgs, ResearchAnswer, FetcherRequest, FetcherAnswer })) {
      const keys = keysOf(schema);
      expect(keys.length, name).toBeGreaterThan(0);
      expect(
        keys.filter((key) => forbidden.test(key)),
        name,
      ).toEqual([]);
    }
    // The positive control: the walk finds a key where one is.
    expect(keysOf(PersonalLogEvent)).toContain("client");
  });

  it("FactView refuses a message and a page together", () => {
    const person = { id: `ent_${ULID}`, kind: "person", name: { untrusted: "Alex Example" }, address: null };
    const page = { id: `pag_${ULID}`, url: { untrusted: "https://news.example/story" }, fetchedAt: at };
    const role = {
      id: "a".repeat(64),
      type: "role",
      subject: person,
      statedBy: null,
      basis: "third_party",
      statementKind: "stated_fact",
      at,
      message: null,
      document: null,
      passage: null,
      page,
      capture: null,
      segment: null,
      thirdParty: true,
      agentReported: false,
      provenance: "source",
      fields: { title: { untrusted: "Director" }, organization_name: { untrusted: "Example Works" } },
    };
    expect(accepts(FactView, role)).toBe(true);
    expect(accepts(FactView, { ...role, page: null, message: `msg_${ULID}` })).toBe(true);
    expect(accepts(FactView, { ...role, message: `msg_${ULID}` })).toBe(false);
    expect(accepts(FactView, { ...role, document: `doc_${ULID}`, passage: { start: 0, end: 4 } })).toBe(false);
    // A page's URL came from the web: it is untrusted, and its id is a page id.
    expect(accepts(FactView, { ...role, page: { ...page, url: "https://news.example/story" } })).toBe(false);
    expect(accepts(FactView, { ...role, page: { ...page, id: `doc_${ULID}` } })).toBe(false);
    expect(accepts(FactView, { ...role, page: { ...page, title: { untrusted: "x" } } })).toBe(false);
    const { page: _page, ...missing } = role;
    expect(accepts(FactView, missing)).toBe(false);
  });

  it("the closed lists hold exactly the expected words", () => {
    expect(ResearchRefusal.options).toEqual(["invalid_request", "not_found", "not_permitted", "rate_limited"]);
    expect(ResearchState.options).toEqual([
      "pending",
      "approved",
      "declined",
      "expired",
      "withdrawn",
      "running",
      "waiting",
      "done",
      "failed",
      "tainted",
    ]);
    expect(ResearchGateCause.options).toEqual([
      "no_authority",
      "bad_form",
      "private_url",
      "origin",
      "vetoed",
      "erased",
      "sealed",
      "budget",
    ]);
    expect(FetchOutcome.options).toEqual([
      "stored",
      "repeat",
      "fresh",
      "expired",
      "redirect",
      "not_text",
      "too_large",
      "timeout",
      "refused_address",
      "robots",
      "http_4xx",
      "http_5xx",
      "gone",
      "no_provider",
      "search_failed",
      "bad_answer",
    ]);
    expect(ResearchDecisionAnswer.options).toEqual(["approve", "decline", "typed"]);
    expect(accepts(ResearchAnswer, { request: `rsq_${ULID}`, state: "pending" })).toBe(true);
    expect(accepts(ResearchAnswer, { request: `rsq_${ULID}`, state: "approved" })).toBe(false);
    expect(accepts(ResearchAnswer, { request: `rsq_${ULID}`, state: "pending", found: 0 })).toBe(false);
  });

  it("request_research is a tool of its own kind, view people, filed through fileResearch", async () => {
    expect(PersonalTool.options).toContain("request_research");
    expect(RESEARCH_TOOL_VIEW).toEqual({ request_research: "people" });
    expect(Object.isFrozen(RESEARCH_TOOL_VIEW)).toBe(true);
    // These lines compile only while the port's method takes ResearchArgs and answers a
    // ResearchAnswer or a refusal.
    const file: PersonalReads["fileResearch"] = async (_token, args) =>
      args.kind === "link"
        ? { ok: false, code: "not_permitted" }
        : { ok: true, value: { request: ResearchRequestId.parse(`rsq_${ULID}`), state: "pending" } };
    const filed: ReadOutcome<ResearchAnswer> = await file("token", ResearchArgs.parse(search));
    expect(filed).toEqual({ ok: true, value: { request: `rsq_${ULID}`, state: "pending" } });
    expect(await file("token", ResearchArgs.parse(link))).toEqual({ ok: false, code: "not_permitted" });
  });

  it("the shapes research adds elsewhere: a page ref, a page lane, two log ids, two decision kinds and one effect", () => {
    expect(accepts(PersonalRef, { kind: "page", id: `pag_${ULID}` })).toBe(true);
    expect(accepts(PersonalRef, { kind: "page", id: `msg_${ULID}` })).toBe(false);
    expect(TriageLane.options).toContain("page");
    expect(
      accepts(PersonalLogEvent, {
        event: "research_fetch_ended",
        ids: { request: `rsq_${ULID}`, fetch: `rft_${ULID}` },
        code: "timeout",
      }),
    ).toBe(true);
    expect(
      accepts(PersonalLogEvent, { event: "research_fetch_ended", ids: { request: "https://news.example/" } }),
    ).toBe(false);
    expect(OwnerDecisionKind.options).toContain("research");
    expect(OwnerDecisionKind.options).toContain("research_settings");
    expect(EFFECT_CLASS.run_research).toBe("external");
  });

  it("a research decision's details hold the owner's private-URL flag, and a settings decision only known caps", () => {
    expect(DECISION_DETAILS.research).toBe(ResearchDecisionDetails);
    expect(DECISION_DETAILS.research_settings).toBe(ResearchSettingsPatch);
    expect(accepts(ResearchDecisionDetails, {})).toBe(true);
    expect(accepts(ResearchDecisionDetails, { privateUrl: true })).toBe(true);
    expect(accepts(ResearchDecisionDetails, { privateUrl: false })).toBe(false);
    expect(accepts(ResearchDecisionDetails, { url: "https://news.example/" })).toBe(false);
    expect(accepts(ResearchSettingsPatch, { maxSearchesPerDay: 20 })).toBe(true);
    expect(accepts(ResearchSettingsPatch, { clientLinkRequests: true, cardExpiryDays: 7 })).toBe(true);
    expect(accepts(ResearchSettingsPatch, {})).toBe(false);
    expect(accepts(ResearchSettingsPatch, { maxSearchesPerDay: undefined })).toBe(false);
    expect(accepts(ResearchSettingsPatch, { maxPagesPerRequest: 11 })).toBe(false);
    expect(accepts(ResearchSettingsPatch, { cardExpiryDays: 91 })).toBe(false);
    expect(accepts(ResearchSettingsPatch, { maxFetchesPerDay: -1 })).toBe(false);
    expect(accepts(ResearchSettingsPatch, { vendor: "any" })).toBe(false);
  });
});
