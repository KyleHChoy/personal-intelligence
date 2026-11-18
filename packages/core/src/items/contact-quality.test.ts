import { describe, expect, it } from "vitest";
import {
  contactQualityRules,
  mailboxContact,
  organizationReading,
  ownDomainsOf,
  providerDomain,
  titleKept,
} from "./contact-quality.ts";

// The contact quality rules. Made-up headlines and addresses on reserved domains; the organization
// names that must pass are public companies and schools, no person's.

const read = (name: string, own: string[] = []) => organizationReading(name, own);
const kept = (name: string) => ({ kind: "name", name });
const REFUSED = { kind: "refused" };
const OWN = { kind: "own_domain" };

describe("contact quality rules", () => {
  it("ontology/contact-quality.json parses", () => {
    const rules = contactQualityRules();
    expect(rules.organizationMostWords).toBe(6);
    expect(rules.roleLocalParts).toEqual(
      expect.arrayContaining(["info", "research", "ux.research", "productivity", "noreply", "no-reply", "admissions"]),
    );
    expect(rules.providerDomains).toEqual(expect.arrayContaining(["textfree.us"]));
  });

  describe("a domain as the organization", () => {
    it("the contact's own domain, a parent or a subdomain of it, in any case or with www., is its own", () => {
      const own = ownDomainsOf(["ines@mail.lumen.example", "profile:linkedin.com/in/ines-example"]);
      expect(own).toEqual(["mail.lumen.example"]);
      expect(read("mail.lumen.example", own)).toEqual(OWN);
      expect(read("Lumen.Example", own)).toEqual(OWN);
      expect(read("www.lumen.example", own)).toEqual(OWN);
      expect(read("us.mail.lumen.example", own)).toEqual(OWN);
      expect(read("admission.north.example", ownDomainsOf(["ines@north.example"]))).toEqual(OWN);
    });

    it("any other domain is no name", () => {
      expect(read("harbor.example", ["lumen.example"])).toEqual(REFUSED);
      expect(read("https://harbor.example/", [])).toEqual(REFUSED);
      // Not a sibling: a shared parent is no relation.
      expect(read("a.lumen.example", ["b.lumen.example"])).toEqual(REFUSED);
    });

    it("a mail or messaging provider's domain never names an organization, the contact's own or not", () => {
      for (const one of [
        "gmail.com",
        "iCloud.com",
        "outlook.com",
        "yahoo.com",
        "textfree.us",
        "vtext.com",
        "mail.yahoo.com",
      ])
        expect(providerDomain(one)).toBe(true);
      expect(providerDomain("lumen.example")).toBe(false);
      expect(providerDomain("Lumen Capital")).toBe(false);
      // A provider's domain leaves a role its title, even as the contact's own domain.
      expect(read("textfree.us", ["textfree.us"])).toEqual(REFUSED);
      expect(read("gmail.com", ["gmail.com"])).toEqual(REFUSED);
    });
  });

  describe("a headline as the organization", () => {
    it("a comma, a bar, an at sign or a line break", () => {
      expect(read("Founders, operators and builders through events that connect, teach,")).toEqual(REFUSED);
      expect(read("Northfield CS'15, Advisor @ Example Ventures, Example 30u30")).toEqual(REFUSED);
      expect(read("Advisor @ Example Ventures")).toEqual(REFUSED);
      expect(read("Example Works | Example Labs")).toEqual(REFUSED);
      expect(read("Example Works\nExample Labs")).toEqual(REFUSED);
    });

    it("more than six words, after one trailing parenthetical is set aside", () => {
      expect(read("Garden Supply Vendor and Tool Lessor Example")).toEqual(REFUSED);
      expect(read("Example County Food Bank Volunteer Network")).toEqual(
        kept("Example County Food Bank Volunteer Network"),
      );
      expect(read("Example County Food Bank Volunteer Network (since the flood of last year)")).toEqual(
        kept("Example County Food Bank Volunteer Network"),
      );
    });

    it("a first-person start", () => {
      expect(read("I build boats at so")).toEqual(REFUSED);
      expect(read("I'm building something new")).toEqual(REFUSED);
      expect(read("I’m between roles")).toEqual(REFUSED);
      expect(read("My own studio")).toEqual(REFUSED);
    });

    it("a dangling preposition or conjunction at the end", () => {
      for (const end of ["at", "of", "and", "for", "to", "with", "so"])
        expect(read(`Example Works ${end}`), end).toEqual(REFUSED);
      expect(read("Example Works and.")).toEqual(REFUSED);
    });

    it("keeps one trailing parenthetical narrow: the name before it is kept", () => {
      expect(read("Example Hub (the largest startup hub in town)")).toEqual(kept("Example Hub"));
      expect(read("Example Hub (Springfield, Oregon)")).toEqual(kept("Example Hub"));
      expect(read("(a startup hub)")).toEqual(REFUSED);
    });

    it("a comma before a legal suffix alone is part of a name", () => {
      expect(read("Example Works, Inc.")).toEqual(kept("Example Works, Inc."));
      expect(read("Example Partners, L.P.")).toEqual(kept("Example Partners, L.P."));
      expect(read("Example Works, Example Labs")).toEqual(REFUSED);
    });

    it("real organization names pass", () => {
      for (const name of [
        "Deutsche Bank",
        "Rolls-Royce",
        "The University of Example at Springfield",
        "Y Combinator",
        "AT&T",
        "Procter & Gamble",
        "Ernst & Young",
      ]) {
        expect(read(name, ["lumen.example"]), name).toEqual(kept(name));
      }
    });
  });

  describe("a headline as the title", () => {
    it("a hash, a nested parenthetical, or a dangling at", () => {
      expect(titleKept("Dean at and Professor of Example (#Dean (Current))")).toBe(false);
      expect(titleKept("Dean at and Professor of Example")).toBe(false);
      expect(titleKept("Lecturer at, and Fellow")).toBe(false);
      expect(titleKept("Researcher at & Fellow")).toBe(false);
      expect(titleKept("Dean (Interim (Acting))")).toBe(false);
      expect(titleKept("Engineer #2")).toBe(false);
      expect(titleKept("Founder | Speaker")).toBe(false);
      expect(titleKept("Advisor @ Example Ventures")).toBe(false);
      expect(titleKept("I build things")).toBe(false);
      expect(titleKept("Head of")).toBe(false);
    });

    it("normal titles pass, with a comma, a parenthetical or many words", () => {
      for (const title of [
        "Executive Director",
        "Professor of Mathematics",
        "VP, Engineering",
        "Partner (Retired)",
        "Senior Vice President of Global Business Development",
        "Researcher at Example Labs",
        "Chief of Staff",
      ]) {
        expect(titleKept(title), title).toBe(true);
      }
    });
  });

  describe("a function's mailbox", () => {
    it("a contact whose every email address has a role-like local part, by the local part alone", () => {
      expect(mailboxContact(["research@lumen.example"])).toBe(true);
      expect(mailboxContact(["ux.research@lumen.example"])).toBe(true);
      expect(mailboxContact(["UX_Research@lumen.example"])).toBe(true);
      expect(mailboxContact(["productivity+team@lumen.example", "No-Reply@harbor.example"])).toBe(true);
      expect(mailboxContact(["info@gmail.com"])).toBe(true);
    });

    it("is not one with a person's address, or with no email address", () => {
      expect(mailboxContact(["research@lumen.example", "ines@lumen.example"])).toBe(false);
      expect(mailboxContact(["ines.research@lumen.example"])).toBe(false);
      expect(mailboxContact([])).toBe(false);
      expect(mailboxContact(["profile:linkedin.com/in/info"])).toBe(false);
      expect(mailboxContact(["tel:+15125550100"])).toBe(false);
    });
  });
});
