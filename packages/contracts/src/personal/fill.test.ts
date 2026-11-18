import { describe, expect, it } from "vitest";
import { Fill, FillBody, keptFill, MoveReport, parseFillBody } from "./work.ts";

// The fill an explore task's report carries, and the code that keeps only what its flag lists.

const source = ["https://example.org/team"];
const fill = Fill.parse({
  role: { title: "Head of Research", organization: { name: "Northwind" }, sources: source },
  identity: { linkedin: "https://linkedin.com/in/ada-example", sources: source },
  links: { urls: ["https://ada.example.org"], sources: source },
});

describe("a fill", () => {
  it("keeps the fields its flag lists and drops and counts the rest", () => {
    expect(keptFill(fill, ["role", "identity"])).toEqual({
      fill: { role: fill.role, identity: fill.identity },
      dropped: 1,
    });
    expect(keptFill(fill, ["role", "identity", "links", "relations"])).toEqual({ fill, dropped: 0 });
  });

  it("keeps nothing when it fills no listed field", () => {
    expect(keptFill(fill, ["domain", "relations"])).toEqual({ fill: null, dropped: 3 });
  });

  it("rides on a move report, and its body is strict and names a node", () => {
    expect(MoveReport.safeParse({ deliverable: "x", fill }).success).toBe(true);
    expect(MoveReport.safeParse({ fill: {} }).success).toBe(false);
    const body = { v: 1, node: "ent_01JABCDEFGHJKMNPQRSTVWXYZ0", fill };
    expect(FillBody.safeParse(body).success).toBe(true);
    expect(parseFillBody(JSON.stringify(body))?.node).toBe(body.node);
    expect(parseFillBody(JSON.stringify({ ...body, label: ["own"] }))).toBeNull();
    expect(parseFillBody("not json")).toBeNull();
  });

  it("names an entity by its id alone, never a handle", () => {
    const handle = `hdl_${"A".repeat(26)}`;
    expect(
      Fill.safeParse({ role: { title: "Engineer", organization: { entity: handle }, sources: source } }).success,
    ).toBe(false);
    expect(
      Fill.safeParse({ relations: [{ other: { entity: handle }, relation: "colleague", sources: source }] }).success,
    ).toBe(false);
    expect(
      Fill.safeParse({
        relations: [{ other: { entity: "ent_01JABCDEFGHJKMNPQRSTVWXYZ0" }, relation: "colleague", sources: source }],
      }).success,
    ).toBe(true);
  });

  it("takes one identifier, and an organization by exactly one of entity, domain or name", () => {
    expect(
      Fill.safeParse({ identity: { email: "ada@example.org", linkedin: "https://linkedin.com/in/x", sources: source } })
        .success,
    ).toBe(false);
    expect(
      Fill.safeParse({
        affiliation: {
          organization: { name: "Northwind", domain: "northwind.example" },
          relation: "employee",
          sources: source,
        },
      }).success,
    ).toBe(false);
  });
});
