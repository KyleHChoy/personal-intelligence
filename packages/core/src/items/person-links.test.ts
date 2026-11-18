import { describe, expect, it } from "vitest";
import { hostKind, linkClaims, linkFactKey, personLink, uniqueLinks } from "./person-links.ts";

// A link on a person, in its normal form, its kind by host, and its claims.
// Synthetic URLs on reserved and example domains only.

describe("personLink", () => {
  it("normalizes: https, the host in lower case, no query, fragment or trailing slash; no scheme reads as https", () => {
    expect(personLink("http://Maren-Holt.Example/Writing/?utm=1#top")).toEqual({
      url: "https://maren-holt.example/Writing",
      kind: "other",
    });
    expect(personLink("  maren-holt.example/  ")).toEqual({ url: "https://maren-holt.example", kind: "other" });
    expect(personLink("HTTPS://maren-holt.example:8443/a//")).toEqual({
      url: "https://maren-holt.example:8443/a",
      kind: "other",
    });
    expect(personLink("https://maren-holt.example/a")?.url).toBe(personLink("https://MAREN-HOLT.example/a/?x=1")?.url);
  });

  it("folds a LinkedIn profile to linkedin.com/in/<slug>, as its identity key does", () => {
    for (const written of [
      "https://www.linkedin.com/in/Maren-Holt-Example/",
      "uk.linkedin.com/in/maren-holt-example?trk=x",
      "http://linkedin.com/in/maren-holt-example/details/experience",
    ]) {
      expect(personLink(written), written).toEqual({
        url: "https://linkedin.com/in/maren-holt-example",
        kind: "linkedin",
      });
    }
    // A LinkedIn page that is no profile keeps its own path, still LinkedIn's.
    expect(personLink("https://www.linkedin.com/company/holt-works-example/")).toEqual({
      url: "https://www.linkedin.com/company/holt-works-example",
      kind: "linkedin",
    });
  });

  it("derives the kind from the host and its subdomains only, never from a look-alike", () => {
    expect(hostKind("github.com")).toBe("github");
    expect(hostKind("gist.github.com")).toBe("github");
    expect(hostKind("x.com")).toBe("x");
    expect(hostKind("twitter.com")).toBe("x");
    expect(hostKind("mobile.twitter.com")).toBe("x");
    for (const host of [
      "linkedin.com.evil.example",
      "evil-linkedin.com",
      "github.com.example",
      "notx.com",
      "maren-holt.example",
    ])
      expect(hostKind(host), host).toBe("other");
    expect(personLink("https://github.com/maren-example")).toEqual({
      url: "https://github.com/maren-example",
      kind: "github",
    });
    expect(personLink("https://linkedin.com.evil.example/in/maren")?.kind).toBe("other");
  });

  it("reads a host with a port and no scheme as https, and folds a LinkedIn profile whatever the scheme's case", () => {
    expect(personLink("maren-holt.example:8080/x")).toEqual({
      url: "https://maren-holt.example:8080/x",
      kind: "other",
    });
    expect(personLink("HTTPS://www.linkedin.com/in/Jane-Example")).toEqual({
      url: "https://linkedin.com/in/jane-example",
      kind: "linkedin",
    });
    expect(personLink("javascript:1")).toBeNull();
  });

  it("refuses what is no http(s) link: javascript:, data:, mailto:, a user or password, an IP, one label, a private name space, an internationalized look-alike, too long", () => {
    for (const value of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "data:text/html,<b>x</b>",
      "mailto:maren@holt.example",
      "ftp://maren-holt.example/file",
      "https://maren@maren-holt.example/",
      "https://user:secret@maren-holt.example/",
      "https://192.0.2.10/maren",
      "http://localhost/maren",
      "https://xn--lnkedin-3gb.com/in/maren",
      "https://lіnkedin.com/in/maren",
      "https://maren.localhost/x",
      "https://nas.local/maren",
      "https://wiki.corp.internal/maren",
      "http://printer.lan",
      "https://wiki.corp/maren",
      "https://nas.home/maren",
      "https://portal.intranet/maren",
      "https://box.private/maren",
      "https://router.home.arpa/admin",
      "",
      "   ",
      `https://maren-holt.example/${"a".repeat(500)}`,
    ]) {
      expect(personLink(value), value).toBeNull();
    }
  });

  it("takes a given kind over the host's, and keeps a label of one to 200 code points", () => {
    expect(personLink("https://maren-holt.example", { kind: "personal_site", label: " Site " })).toEqual({
      url: "https://maren-holt.example",
      kind: "personal_site",
      label: "Site",
    });
    expect(personLink("https://maren-holt.example", { label: "x".repeat(201) })).toEqual({
      url: "https://maren-holt.example",
      kind: "other",
    });
  });

  it("keeps each URL once, the first link that gave it, and at most the bound", () => {
    const links = uniqueLinks(
      [
        personLink("https://maren-holt.example/", { kind: "personal_site" }),
        null,
        personLink("maren-holt.example"),
        personLink("https://github.com/maren-example"),
      ],
      5,
    );
    expect(links).toEqual([
      { url: "https://maren-holt.example", kind: "personal_site" },
      { url: "https://github.com/maren-example", kind: "github" },
    ]);
    expect(uniqueLinks(links, 1)).toHaveLength(1);
  });
});

describe("linkClaims", () => {
  const input = {
    evidenceId: "evd_links_1",
    compartments: ["own"],
    readers: ["m-owner"],
    observedAt: "2026-09-30T00:00:00.000Z",
    links: [
      { url: "https://linkedin.com/in/maren-holt-example", kind: "linkedin" as const },
      { url: "https://maren-holt.example", kind: "personal_site" as const, label: "Site" },
    ],
    people: [{ entity: "ent_links_a" }, { entity: "ent_links_a" }],
  };

  it("makes one use-only link claim per link and person, a third party's statement, keyed by its URL alone", () => {
    const records = linkClaims({ ...input, confidence: 0.8, standing: "verified" }, "contact-import@3");
    expect(records.map((one) => one.claim.content)).toEqual([
      {
        type: "link",
        subject: "ent_links_a",
        fields: { url: "https://linkedin.com/in/maren-holt-example", kind: "linkedin" },
      },
      {
        type: "link",
        subject: "ent_links_a",
        fields: { url: "https://maren-holt.example", kind: "personal_site", label: "Site" },
      },
    ]);
    for (const record of records) {
      expect([
        record.claim.basis,
        record.claim.origin,
        record.disclosure,
        record.subjectKind,
        record.claim.pipelineVersion,
        record.confidence,
        record.standing,
      ]).toEqual(["third_party", "source", ["third_party"], "person", "contact-import@3", 0.8, "verified"]);
      expect(record.fieldKinds).toEqual({
        url: "text",
        kind: "enum",
        ...(record.claim.content.fields.label === undefined ? {} : { label: "text" }),
      });
    }
    expect(records.map((one) => one.claim.evidence[0]?.span)).toEqual(["links/0", "links/1"]);
  });

  it("keys one URL on one person as one fact whatever its kind or label, and two compartments or two people apart", () => {
    const key = linkFactKey("ent_links_a", "https://maren-holt.example", ["own"]);
    expect(
      linkClaims({ ...input, links: [{ url: "https://maren-holt.example", kind: "other" }] }, "v")[0]?.factKey,
    ).toBe(key);
    expect(
      linkClaims(
        { ...input, links: [{ url: "https://maren-holt.example", kind: "personal_site", label: "Home" }] },
        "w",
      )[0]?.factKey,
    ).toBe(key);
    expect(linkFactKey("ent_links_a", "https://maren-holt.example", ["employer:example"])).not.toBe(key);
    expect(linkFactKey("ent_links_b", "https://maren-holt.example", ["own"])).not.toBe(key);
    expect(linkFactKey("ent_links_a", "https://maren-holt.example/x", ["own"])).not.toBe(key);
  });
});
