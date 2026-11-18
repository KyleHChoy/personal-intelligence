import type { ImportedExtras } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { CONTACT_CLAIMS_V2, CONTACT_CLAIMS_V3 } from "./contact-claims.ts";
import {
  IMPORT_CLAIMS_V2,
  IMPORT_CLAIMS_V3,
  IMPORT_CLAIMS_VERSION,
  type ImportClaimsInput,
  importClaimCounts,
  importClaims,
} from "./import-claims.ts";

// Contact import: the claims code makes from an imported contact. Made-up names.

const SUBJECT = "ent_import_subject";
const extras = (more: Partial<ImportedExtras> = {}): ImportedExtras => ({
  kind: "person",
  profiles: [],
  pastRoles: [],
  industries: [],
  education: [],
  boards: [],
  relations: [],
  tags: [],
  notes: [],
  provenance: { adapter: "mapped-csv" },
  ...more,
});
const input = (more: Partial<ImportClaimsInput> = {}): ImportClaimsInput => ({
  evidenceId: "evd_import_1",
  compartments: ["own"],
  readers: ["m-owner"],
  observedAt: "2026-09-30T00:00:00.000Z",
  organizations: [{ name: "Lumen Capital Example", title: "Partner" }],
  imported: extras(),
  people: [{ entity: SUBJECT }],
  addresses: ["ines@lumen.example"],
  ...more,
});
const shapes = (records: ReturnType<typeof importClaims>) =>
  records.map(({ claim }) => ({
    type: claim.content.type,
    fields: claim.content.fields,
    span: claim.evidence[0]?.span,
    validFrom: claim.validFrom,
    validTo: claim.validTo,
  }));

describe("importClaims", () => {
  it("makes the current role an employee affiliation and a role, as a saved contact's, a third party's use-only statement", () => {
    const records = importClaims(input());
    expect(shapes(records)).toEqual([
      {
        type: "affiliation",
        fields: { relation: "employee", organization_name: "Lumen Capital Example" },
        span: "organizations/0",
        validFrom: "2026-09-30T00:00:00.000Z",
        validTo: undefined,
      },
      {
        type: "role",
        fields: { title: "Partner", organization_name: "Lumen Capital Example" },
        span: "organizations/0",
        validFrom: "2026-09-30T00:00:00.000Z",
        validTo: undefined,
      },
    ]);
    for (const record of records) {
      expect([
        record.claim.basis,
        record.claim.origin,
        record.origin,
        record.disclosure,
        record.claim.pipelineVersion,
        record.subjectKind,
      ]).toEqual(["third_party", "source", "source", ["third_party"], IMPORT_CLAIMS_VERSION, "person"]);
      expect(record.claim.label).toEqual({ compartments: ["own"], readers: ["m-owner"] });
      expect(record.entities).toEqual([SUBJECT]);
    }
  });

  it("makes each past role end at its end date, or at the row's time with none, and starts it at its start", () => {
    const records = importClaims(
      input({
        organizations: [],
        imported: extras({
          pastRoles: [
            { title: "Analyst", organization: "Fern Bank Example", from: "2015-01-01", to: "2019-06-30" },
            { organization: "Old Mill Example" },
          ],
        }),
      }),
    );
    expect(shapes(records)).toEqual([
      {
        type: "affiliation",
        fields: { relation: "employee", organization_name: "Fern Bank Example" },
        span: "imported/pastRoles/0",
        validFrom: "2015-01-01T00:00:00.000Z",
        validTo: "2019-06-30T23:59:59.999Z",
      },
      {
        type: "role",
        fields: { title: "Analyst", organization_name: "Fern Bank Example" },
        span: "imported/pastRoles/0",
        validFrom: "2015-01-01T00:00:00.000Z",
        validTo: "2019-06-30T23:59:59.999Z",
      },
      {
        type: "affiliation",
        fields: { relation: "employee", organization_name: "Old Mill Example" },
        span: "imported/pastRoles/1",
        validFrom: "2026-09-30T00:00:00.000Z",
        validTo: "2026-09-30T00:00:00.000Z",
      },
    ]);
  });

  it("makes boards board affiliations, schools alumnus affiliations, and an organization row worked at an employee affiliation, each once", () => {
    const records = importClaims(
      input({
        imported: extras({
          boards: [{ organization: "Harbor Arts Example", title: "Trustee" }],
          education: ["North College Example"],
          relations: [
            { kind: "works_at", name: "Bright Group Example" },
            { kind: "works_at", name: "Lumen Capital Example" },
            { kind: "managed_by" },
            { kind: "household_member" },
          ],
          industries: ["Health"],
          location: "Portland",
          tags: [{ key: "Status", value: "want to meet" }],
          notes: ["A note."],
        }),
      }),
    );
    expect(shapes(records).map(({ type, fields }) => ({ type, fields }))).toEqual([
      { type: "affiliation", fields: { relation: "employee", organization_name: "Lumen Capital Example" } },
      { type: "role", fields: { title: "Partner", organization_name: "Lumen Capital Example" } },
      { type: "affiliation", fields: { relation: "board", organization_name: "Harbor Arts Example" } },
      { type: "affiliation", fields: { relation: "alumnus", organization_name: "North College Example" } },
      { type: "affiliation", fields: { relation: "employee", organization_name: "Bright Group Example" } },
    ]);
  });

  it("carries the row's confidence and standing on every claim", () => {
    const records = importClaims(
      input({ imported: extras({ provenance: { adapter: "mapped-csv", confidence: 0.45, standing: "probable" } }) }),
    );
    expect(records.map((one) => [one.confidence, one.standing])).toEqual([
      [0.45, "probable"],
      [0.45, "probable"],
    ]);
    expect(importClaims(input()).every((one) => one.confidence === undefined && one.standing === undefined)).toBe(true);
  });

  it("makes each claim about each person, with ids fixed by the item, and none with no person", () => {
    const two = importClaims(
      input({ people: [{ entity: SUBJECT }, { entity: "ent_import_other" }, { entity: SUBJECT }] }),
    );
    expect(two.length).toBe(4);
    expect(new Set(two.map((one) => one.claim.id)).size).toBe(4);
    expect(importClaims(input()).map((one) => one.claim.id)).toEqual(importClaims(input()).map((one) => one.claim.id));
    expect(importClaims(input({ people: [] }))).toEqual([]);
  });

  it("at key version 2 is made by its own version, with its version 1 key beside it", () => {
    const [v1] = importClaims(input());
    const [v2] = importClaims(input(), CONTACT_CLAIMS_V2);
    expect(v2?.claim.pipelineVersion).toBe(IMPORT_CLAIMS_V2);
    expect(v2?.legacyFactKey).toBe(v1?.factKey);
    expect(v2?.claim.id).not.toBe(v1?.claim.id);
  });

  it("counts a record's claims by type for a dry run", () => {
    const addresses = ["ines@lumen.example"];
    expect(
      importClaimCounts({
        organizations: [{ name: "Lumen Capital Example", title: "Partner" }],
        imported: extras({ boards: [{ organization: "Harbor Arts Example" }] }),
        addresses,
      }),
    ).toEqual({ role: 1, affiliation: 2, link: 0 });
    // And its links.
    expect(
      importClaimCounts({
        organizations: [],
        imported: extras({}),
        links: [{ url: "https://lumen.example/team", kind: "other" }],
        addresses,
      }),
    ).toEqual({ role: 0, affiliation: 0, link: 1 });
    // Under the version in force's rules.
    expect(
      importClaimCounts({
        organizations: [{ name: "lumen.example", title: "Partner" }],
        imported: extras({ education: ["North College Example"] }),
        addresses,
      }),
    ).toEqual({ role: 0, affiliation: 1, link: 0 });
    expect(
      importClaimCounts({
        organizations: [{ name: "Lumen Capital Example", title: "Partner" }],
        imported: extras({}),
        links: [{ url: "https://lumen.example/team", kind: "other" }],
        addresses: ["team@lumen.example"],
      }),
    ).toEqual({ role: 0, affiliation: 0, link: 0 });
  });

  // contact-import@5, at contact-claims@3, under the contact quality rules.
  it("at contact-claims@3 applies the rules to every organization a row names, and a mailbox row makes nothing", () => {
    const row = input({
      organizations: [{ name: "www.Lumen.Example", title: "Partner" }],
      imported: extras({
        pastRoles: [
          { title: "Analyst", organization: "Fern Bank Example, Inc." },
          { title: "Associate", organization: "Founders, operators and builders who gather" },
        ],
        boards: [{ organization: "Harbor Arts Example" }, { organization: "My weekend garden club for" }],
        education: ["North College Example (Class of 2010)"],
        relations: [{ kind: "works_at", name: "partners.example.org" }],
      }),
    });
    const records = importClaims(row, CONTACT_CLAIMS_V3);
    expect(records.every((one) => one.claim.pipelineVersion === IMPORT_CLAIMS_V3)).toBe(true);
    expect(shapes(records).map(({ type, fields, span }) => ({ type, fields, span }))).toEqual([
      {
        type: "affiliation",
        fields: { relation: "employee", organization_name: "Fern Bank Example, Inc." },
        span: "imported/pastRoles/0",
      },
      {
        type: "role",
        fields: { title: "Analyst", organization_name: "Fern Bank Example, Inc." },
        span: "imported/pastRoles/0",
      },
      { type: "role", fields: { title: "Associate" }, span: "imported/pastRoles/1" },
      {
        type: "affiliation",
        fields: { relation: "board", organization_name: "Harbor Arts Example" },
        span: "imported/boards/0",
      },
      {
        type: "affiliation",
        fields: { relation: "alumnus", organization_name: "North College Example" },
        span: "imported/education/0",
      },
    ]);
    // Version 2 made every one of them.
    expect(importClaims(row, CONTACT_CLAIMS_V2).length).toBe(10);
    expect(
      importClaims(
        input({
          addresses: ["admissions@lumen.example"],
          links: [{ url: "https://lumen.example/team", kind: "other" }],
        }),
        CONTACT_CLAIMS_V3,
      ),
    ).toEqual([]);
  });
});
