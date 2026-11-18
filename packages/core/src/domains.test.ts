import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CONSUMER_DOMAINS,
  consumerDomain,
  foldDomain,
  mentionDomain,
  mentionOrganization,
  organizationDomain,
  organizationOfDomain,
  useRegistrableDomain,
} from "./domains.ts";
import { documentationFold, useDocumentationFold } from "./test-support/domains.ts";

// Every personal test process runs with the documentation fold (test-support/fold-setup.ts). The tests of
// production's fold put the vendored list alone back first, and the fold back after.

describe("organizationDomain", () => {
  it("a provider's domain, or one under it, has no organization", () => {
    for (const domain of [
      "gmail.com",
      "googlemail.com",
      "outlook.com",
      "hotmail.com",
      "live.com",
      "msn.com",
      "yahoo.com",
      "icloud.com",
      "me.com",
      "mac.com",
      "aol.com",
      "proton.me",
      "protonmail.com",
      "gmx.com",
    ]) {
      expect(CONSUMER_DOMAINS, domain).toContain(domain);
    }
    for (const domain of [
      "yahoo.co.uk",
      "comcast.net",
      "privaterelay.appleid.com",
      "duck.com",
      "qq.com",
      "fastmail.com",
    ])
      expect(CONSUMER_DOMAINS, domain).toContain(domain);
    for (const domain of CONSUMER_DOMAINS) {
      expect(organizationDomain(`alex@${domain}`), domain).toBeNull();
      expect(organizationDomain(`Alex@${domain.toUpperCase()}`), domain).toBeNull();
      expect(organizationDomain(`alex@mail.${domain}`), domain).toBeNull();
    }
  });

  it("an organization address gives its registrable domain", () => {
    expect(organizationDomain("alex@example.com")).toBe("example.com");
    expect(organizationDomain("Alex@Mail.Lab.Example.org")).toBe("lab.example.org");
    expect(organizationDomain("alex@mail.example.co.uk")).toBe("example.co.uk");
    expect(organizationDomain("alex@example.co.uk")).toBe("example.co.uk");
    expect(organizationDomain("alex@willow.test")).toBe("willow.test");
    expect(organizationDomain("alex@team.willow.test")).toBe("willow.test");
    expect(organizationDomain("alex@localhost")).toBeNull();
    expect(organizationDomain("alex@co.uk")).toBeNull();
    expect(organizationDomain("not an address")).toBeNull();
  });

  it("a provider is matched by whole labels, never by a suffix of one", () => {
    expect(consumerDomain("acme.example")).toBe(false);
    expect(consumerDomain("gmail.com.example")).toBe(false);
    expect(consumerDomain("x.privaterelay.appleid.com")).toBe(true);
    // The relay's own parent is no provider: an address there is the company's.
    expect(organizationOfDomain("appleid.com")).toBe("appleid.com");
    expect(organizationOfDomain("privaterelay.appleid.com")).toBeNull();
  });
});

describe("foldDomain", () => {
  it("is the registrable domain, or the domain itself when it has none", () => {
    expect(foldDomain("mail.example.co.uk")).toBe("example.co.uk");
    expect(foldDomain("mail.gmail.com")).toBe("gmail.com");
    expect(foldDomain("co.uk")).toBe("co.uk");
  });

  it("the tests' fold, and only it, folds a name under a documentation domain to one label below it, and keeps the domain itself", () => {
    expect(foldDomain("quarry.example.org")).toBe("quarry.example.org");
    expect(foldDomain("mail.lab.example.org")).toBe("lab.example.org");
    expect(foldDomain("a.b.shop.example.com")).toBe("shop.example.com");
    expect(foldDomain("people.example.net")).toBe("people.example.net");
    expect(foldDomain("example.org")).toBe("example.org");
    // Matched by whole labels: a domain that only ends in the same letters is not one.
    expect(foldDomain("mail.myexample.org")).toBe("myexample.org");
    expect(organizationDomain("pat@harbor.example.org")).not.toBe(organizationDomain("lee@quarry.example.org"));
    expect(organizationDomain("pat@example.org")).toBe("example.org");
    expect(documentationFold("mail.example.co.uk")).toBe("example.co.uk");
  });
});

// Production folds by the vendored list alone, with no case for
// any domain's name, the documentation domains' included.
describe("foldDomain, by the vendored list alone", () => {
  beforeAll(() => useRegistrableDomain());
  afterAll(() => useDocumentationFold());

  it("folds every name under a documentation domain to that domain, as the list says", () => {
    expect(foldDomain("quarry.example.org")).toBe("example.org");
    expect(foldDomain("a.b.shop.example.com")).toBe("example.com");
    expect(foldDomain("people.example.net")).toBe("example.net");
    expect(organizationDomain("pat@harbor.example.org")).toBe(organizationDomain("lee@quarry.example.org"));
    expect(mentionOrganization("domain:mail.lab.example.org")).toBe("example.org");
    expect(foldDomain("mail.example.co.uk")).toBe("example.co.uk");
    expect(organizationDomain("alex@co.uk")).toBeNull();
  });
});

describe("mentionDomain", () => {
  it("reads a domain mention's domain in lower case, and nothing else", () => {
    expect(mentionDomain("domain:Alder.Example")).toBe("alder.example");
    expect(mentionDomain("domain:mail.lab.example.org")).toBe("mail.lab.example.org");
    for (const value of [
      "alder.example",
      "domain:",
      "domain:localhost",
      "domain:a@alder.example",
      "domain: alder.example",
      "domain:alder..example",
      "project:this",
      "name:Alder",
    ]) {
      expect(mentionDomain(value), value).toBeNull();
    }
  });

  it("mentionOrganization folds the mention's domain, and a provider's is none", () => {
    expect(mentionOrganization("domain:mail.lab.example.org")).toBe("lab.example.org");
    expect(mentionOrganization("domain:Alder.Example")).toBe("alder.example");
    expect(mentionOrganization("domain:gmail.com")).toBeNull();
    expect(mentionOrganization("name:Alder")).toBeNull();
  });
});
