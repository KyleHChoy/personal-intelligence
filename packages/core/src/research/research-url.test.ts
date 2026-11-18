import { describe, expect, it } from "vitest";
import { canonicalUrl, idShaped, isPrivateUrl } from "./research-url.ts";

describe("canonicalUrl", () => {
  it("gives the canonical form of a page URL, and nothing for one that is not", () => {
    expect(canonicalUrl("https://Profiles.Example/people/mara-ellison#top")).toBe(
      "https://profiles.example/people/mara-ellison",
    );
    expect(canonicalUrl("https://profiles.example")).toBe("https://profiles.example/");
    expect(canonicalUrl("ftp://profiles.example/x")).toBeUndefined();
    expect(canonicalUrl("https://user@profiles.example/x")).toBeUndefined();
    expect(canonicalUrl("https://profiles.example:8443/x")).toBeUndefined();
    expect(canonicalUrl("https://intranet.local/x")).toBeUndefined();
    expect(canonicalUrl("not a url")).toBeUndefined();
  });
});

describe("isPrivateUrl", () => {
  it("query, fragment, user part, port, percent byte and token segment are each private; a plain profile path is not", () => {
    const plain = "https://profiles.example/people/mara-ellison";
    expect(isPrivateUrl(plain)).toBe(false);
    expect(isPrivateUrl("https://profiles.example/")).toBe(false);
    expect(isPrivateUrl(`${plain}?ref=mail`)).toBe(true);
    // An empty query is still a query.
    expect(isPrivateUrl(`${plain}?`)).toBe(true);
    expect(isPrivateUrl(`${plain}#section`)).toBe(true);
    expect(isPrivateUrl(`${plain}#`)).toBe(true);
    expect(isPrivateUrl("https://mara@profiles.example/people/mara-ellison")).toBe(true);
    expect(isPrivateUrl("https://:secret@profiles.example/people/mara-ellison")).toBe(true);
    expect(isPrivateUrl("https://profiles.example:8443/people/mara-ellison")).toBe(true);
    // The scheme's own default port, written out, is no port of its own.
    expect(isPrivateUrl("https://profiles.example:443/people/mara-ellison")).toBe(false);
    expect(isPrivateUrl("https://profiles.example/people/mara%20ellison")).toBe(true);
    expect(isPrivateUrl("https://share.example/d/8fK2mQ9xLp4RtZ7vWb3N")).toBe(true);
    expect(isPrivateUrl("https://share.example/d/8fK2mQ9xLp4RtZ7v")).toBe(true);
  });

  it("a long segment of letters alone, or one under 16 characters, is not a token", () => {
    expect(isPrivateUrl("https://boards.example/organizations-and-their-boards")).toBe(false);
    expect(isPrivateUrl("https://boards.example/annual-2025")).toBe(false);
    // Fifteen characters with digits and letters: under the bound.
    expect(isPrivateUrl("https://share.example/d/8fK2mQ9xLp4RtZ7")).toBe(false);
    // A segment that holds a dot is not of the token's characters.
    expect(isPrivateUrl("https://filings.example/ellison-studio-2025.txt")).toBe(false);
  });

  it("text that does not parse as a URL is private", () => {
    expect(isPrivateUrl("not a url")).toBe(true);
    expect(isPrivateUrl("")).toBe(true);
  });
});

describe("idShaped", () => {
  const person = (value: string) => ({ kind: "person_name" as const, value });
  const organization = (value: string) => ({ kind: "organization_name" as const, value });
  const domain = (value: string) => ({ kind: "domain" as const, value });

  it("personal ids, 64-hex digests and UUIDs are refused; Mary-Jane Okoro, al-Ahram, t-mobile and Cafe24 are names", () => {
    expect(idShaped(organization("ent_01JABCDEFGHJKMNPQRSTVWXYZ0"))).toBe(true);
    expect(idShaped(person("msg_01JABCDEFGHJKMNPQRSTVWXYZ0"))).toBe(true);
    expect(idShaped(organization("rsq_01JABCDEFGHJKMNPQRSTVWXYZ0"))).toBe(true);
    expect(idShaped(organization("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"))).toBe(true);
    expect(idShaped(organization("123e4567-e89b-12d3-a456-426614174000"))).toBe(true);
    expect(idShaped(person("Mary-Jane Okoro"))).toBe(false);
    expect(idShaped(person("al-Ahram"))).toBe(false);
    expect(idShaped(organization("al-Ahram"))).toBe(false);
    expect(idShaped(organization("t-mobile"))).toBe(false);
    expect(idShaped(organization("Cafe24"))).toBe(false);
    expect(idShaped(domain("cafe24.example"))).toBe(false);
  });

  it("six digits, or a token with a run of eight hex characters and two digits, is an id", () => {
    expect(idShaped(organization("Studio 123456"))).toBe(true);
    expect(idShaped(organization("Ref 1a2b3c4d Holdings"))).toBe(true);
    expect(idShaped(organization("Deadbeef Cafe"))).toBe(false);
    expect(idShaped(domain("a123456.example"))).toBe(true);
    expect(idShaped(domain("ellisonstudio.example"))).toBe(false);
  });
});
