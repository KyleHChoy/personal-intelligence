import { describe, expect, it } from "vitest";
import {
  CONTACT_CLAIMS_V1,
  CONTACT_CLAIMS_V2,
  CONTACT_CLAIMS_V3,
  CONTACT_CLAIMS_V4,
  CONTACT_CLAIMS_VERSION,
  contactClaims,
  relationOfTitle,
} from "./contact-claims.ts";

// Synthetic values only.

const EVIDENCE = "evd_contact_1";
const base = {
  evidenceId: EVIDENCE,
  compartments: ["own"],
  readers: ["m-owner"],
  observedAt: "2026-09-01T09:00:00.000Z",
  people: [{ entity: "ent_maren" }],
  addresses: ["maren@harbor.example"],
};

describe("relationOfTitle", () => {
  it("reads a founder, an owner, an investor and the like from a title", () => {
    for (const title of [
      "Founder",
      "Co-founder & CEO",
      "cofounder",
      "CEO and Founder",
      "Founding Partner",
      "Founder at Example Labs",
    ])
      expect(relationOfTitle(title), title).toBe("founder");
    for (const title of ["Owner", "CEO & Owner", "Business Owner", "Co-Owner"])
      expect(relationOfTitle(title), title).toBe("owner");
    expect(relationOfTitle("Angel Investor")).toBe("investor");
    expect(relationOfTitle("Board Member")).toBe("board");
    expect(relationOfTitle("Chair of the Board")).toBe("board");
    expect(relationOfTitle("Strategic Advisor")).toBe("advisor");
    expect(relationOfTitle("Independent Contractor")).toBe("contractor");
    expect(relationOfTitle("PhD Student")).toBe("student");
    expect(relationOfTitle("Volunteer")).toBe("volunteer");
  });
  it("leaves a job a job", () => {
    for (const title of [
      "Founding Engineer",
      "Product Owner",
      "Investor Relations Manager",
      "Financial Advisor",
      "Founder's Associate",
      "Chief of Staff to the Founder",
      "Founder Relations Manager",
      "Head of Investor Success",
      "Student Success Manager",
      "Head of Research",
      null,
    ])
      expect(relationOfTitle(title), String(title)).toBe("employee");
  });
});

describe("contactClaims", () => {
  it("an organization with a title gives an affiliation and a role about the contact's person, third party, origin source", () => {
    const records = contactClaims({ ...base, organizations: [{ name: "Example Works", title: "Head of Research" }] });
    expect(records.map((record) => [record.claim.content.type, record.claim.content.fields])).toEqual([
      ["affiliation", { relation: "employee", organization_name: "Example Works" }],
      ["role", { title: "Head of Research", organization_name: "Example Works" }],
    ]);
    for (const record of records) {
      expect(record.claim.content.subject).toBe("ent_maren");
      expect(record.origin).toBe("source");
      expect(record.claim.basis).toBe("third_party");
      expect(record.disclosure).toEqual(["third_party"]);
      expect(record.claim.label).toEqual({ compartments: ["own"], readers: ["m-owner"] });
      expect(record.claim.primaryEvidenceId).toBe(EVIDENCE);
      expect(record.entities).toEqual(["ent_maren"]);
    }
  });

  // contact-claims@2, which every writer makes.
  it("contact-claims@2 makes the same claims under its own version and ids, a role keyed by its title, its version 1 key beside it", () => {
    const organizations = [{ name: "Example Works", title: "Head of Research" }];
    const one = contactClaims({ ...base, organizations }, CONTACT_CLAIMS_V1);
    const two = contactClaims({ ...base, organizations }, CONTACT_CLAIMS_V2);
    expect(two.map((record) => record.claim.content)).toEqual(one.map((record) => record.claim.content));
    expect(two.map((record) => record.claim.pipelineVersion)).toEqual(["contact-claims@2", "contact-claims@2"]);
    for (const [n, record] of two.entries()) expect(record.claim.id).not.toBe(one[n]?.claim.id);
    expect(one.map((record) => record.legacyFactKey)).toEqual([undefined, undefined]);
    expect(two.map((record) => record.legacyFactKey)).toEqual(one.map((record) => record.factKey));
    const [affiliation, role] = two;
    expect(affiliation?.factKey).toBe(one[0]?.factKey);
    expect(role?.factKey).not.toBe(one[1]?.factKey);
    const retitled = contactClaims(
      { ...base, organizations: [{ name: "Example Works", title: "Chief of Staff" }] },
      CONTACT_CLAIMS_V2,
    );
    expect(retitled[1]?.factKey).not.toBe(role?.factKey);
    expect(
      contactClaims(
        { ...base, organizations: [{ name: "Example Works", title: "head of  research" }] },
        CONTACT_CLAIMS_V2,
      )[1]?.factKey,
    ).toBe(role?.factKey);
  });

  it("a title with no organization is a role alone; an organization with no title an affiliation alone; blanks give nothing", () => {
    expect(
      contactClaims({ ...base, organizations: [{ name: null, title: "Archivist" }] }).map(
        (one) => one.claim.content.fields,
      ),
    ).toEqual([{ title: "Archivist" }]);
    expect(
      contactClaims({ ...base, organizations: [{ name: "Example Works", title: "  " }] }).map(
        (one) => one.claim.content.type,
      ),
    ).toEqual(["affiliation"]);
    expect(contactClaims({ ...base, organizations: [{ name: " ", title: null }] })).toEqual([]);
    expect(
      contactClaims({ ...base, people: [], organizations: [{ name: "Example Works", title: "Archivist" }] }),
    ).toEqual([]);
  });

  it("claims are made per resolved person, with ids and keys that are the same on every run and differ by person", () => {
    const input = {
      ...base,
      people: [{ entity: "ent_a" }, { entity: "ent_b" }, { entity: "ent_a" }],
      organizations: [{ name: "Example Works", title: null }],
    };
    const first = contactClaims(input);
    expect(first.map((one) => one.claim.content.subject)).toEqual(["ent_a", "ent_b"]);
    expect(contactClaims(input)).toEqual(first);
    expect(new Set(first.map((one) => one.factKey)).size).toBe(2);
  });

  it("at version 1 a role's key does not hold its title, so a changed title is the same fact; another compartment is another fact", () => {
    const [, role] = contactClaims(
      { ...base, organizations: [{ name: "Example Works", title: "Archivist" }] },
      CONTACT_CLAIMS_V1,
    );
    const [, retitled] = contactClaims(
      { ...base, organizations: [{ name: "Example  works", title: "Head Archivist" }] },
      CONTACT_CLAIMS_V1,
    );
    const [, employer] = contactClaims(
      { ...base, compartments: ["employer:example"], organizations: [{ name: "Example Works", title: "Archivist" }] },
      CONTACT_CLAIMS_V1,
    );
    expect(retitled?.factKey).toBe(role?.factKey);
    expect(employer?.factKey).not.toBe(role?.factKey);
  });

  // contact-claims@3, version 2 under the contact quality rules.
  it("contact-claims@4 is in force: a founder's affiliation says founder, and version 3 made for them what it did", () => {
    const organizations = [{ name: "Example Works", title: "Co-founder" }];
    expect(CONTACT_CLAIMS_VERSION).toBe(CONTACT_CLAIMS_V4);
    const [affiliation, role] = contactClaims({ ...base, organizations });
    expect(affiliation?.claim.content.fields).toEqual({ relation: "founder", organization_name: "Example Works" });
    expect(affiliation?.claim.pipelineVersion).toBe("contact-claims@4");
    expect(role?.claim.content.fields).toEqual({ title: "Co-founder", organization_name: "Example Works" });
    const [was] = contactClaims({ ...base, organizations }, CONTACT_CLAIMS_V3);
    expect(was?.claim.content.fields).toEqual({ relation: "employee", organization_name: "Example Works" });
    // Its key holds the relation, so a reclaim removes the claim version 3 made.
    expect(affiliation?.factKey).not.toBe(was?.factKey);
  });

  it("contact-claims@3: a good row makes version 2's claims and keys under its own ids", () => {
    const organizations = [{ name: "Example Works (a research studio)", title: "Head of Research" }];
    const two = contactClaims({ ...base, organizations }, CONTACT_CLAIMS_V2);
    const three = contactClaims({ ...base, organizations }, CONTACT_CLAIMS_V3);
    expect(three.map((record) => record.claim.pipelineVersion)).toEqual(["contact-claims@3", "contact-claims@3"]);
    // Its one trailing parenthetical is set aside, which version 2 kept.
    expect(three.map((record) => record.claim.content.fields)).toEqual([
      { relation: "employee", organization_name: "Example Works" },
      { title: "Head of Research", organization_name: "Example Works" },
    ]);
    expect(two[0]?.claim.content.fields).toEqual({
      relation: "employee",
      organization_name: "Example Works (a research studio)",
    });
    const plain = [{ name: "Example Works", title: "Head of Research" }];
    const [v2, v3] = [
      contactClaims({ ...base, organizations: plain }, CONTACT_CLAIMS_V2),
      contactClaims({ ...base, organizations: plain }),
    ];
    expect(v3.map((record) => [record.factKey, record.legacyFactKey])).toEqual(
      v2.map((record) => [record.factKey, record.legacyFactKey]),
    );
    for (const [n, record] of v3.entries()) expect(record.claim.id).not.toBe(v2[n]?.claim.id);
  });

  it("contact-claims@3 makes no affiliation or role from the contact's own domain, no affiliation from a headline, no role from a headline title, and nothing from a mailbox", () => {
    const fields = (organizations: { name: string | null; title: string | null }[], addresses = base.addresses) =>
      contactClaims({ ...base, addresses, organizations }).map((one) => one.claim.content.fields);
    expect(fields([{ name: "mail.harbor.example", title: "Archivist" }])).toEqual([]);
    expect(fields([{ name: "I sketch for fun at so", title: "Archivist" }])).toEqual([{ title: "Archivist" }]);
    expect(fields([{ name: "Example Works", title: "Archivist at and Curator (#Archivist (Current))" }])).toEqual([
      { relation: "employee", organization_name: "Example Works" },
    ]);
    expect(fields([{ name: "Example Works", title: "Archivist" }], ["research@harbor.example"])).toEqual([]);
    // Version 2 made all of them.
    expect(
      contactClaims(
        { ...base, organizations: [{ name: "mail.harbor.example", title: "Archivist" }] },
        CONTACT_CLAIMS_V2,
      ).length,
    ).toBe(2);
    expect(
      contactClaims(
        {
          ...base,
          addresses: ["research@harbor.example"],
          organizations: [{ name: "Example Works", title: "Archivist" }],
        },
        CONTACT_CLAIMS_V2,
      ).length,
    ).toBe(2);
  });

  it("contact-claims@3 makes no link from a mailbox", () => {
    const links = [{ url: "https://harbor.example/team", kind: "other" as const }];
    expect(contactClaims({ ...base, organizations: [], links })).toHaveLength(1);
    expect(contactClaims({ ...base, addresses: ["info@harbor.example"], organizations: [], links })).toEqual([]);
  });
});
