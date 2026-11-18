import { describe, expect, it } from "vitest";
import {
  AreaKey,
  AreaView,
  ListProjectsArgs,
  ListProjectsResult,
  ProposeProjectArgs,
  UpdateProjectArgs,
} from "./projects.ts";
import { CLAIM_REFUSAL_FIELDS, CLAIM_REFUSAL_HINTS } from "./tools-claim-refusals.ts";
import { PersonalWorkArgs } from "./work.ts";

// Synthetic keys and names only.

const ENT = "ent_01JABCDEFGHJKMNPQRSTVWXYZ0";
const REQUEST = "req-01JABCDEFGH";
const accepts = (schema: { safeParse(value: unknown): { success: boolean } }, value: unknown): boolean =>
  schema.safeParse(value).success;

describe("areas in the project tools", () => {
  it("a key is a lower case letter, then 1 to 31 lower case letters, digits or hyphens", () => {
    for (const key of ["field-work", "a1", `a${"b".repeat(31)}`]) expect(accepts(AreaKey, key), key).toBe(true);
    for (const key of ["", "a", "Field", "field work", "1st", "-field", "field_work", `a${"b".repeat(32)}`, null])
      expect(accepts(AreaKey, key), String(key)).toBe(false);
  });

  it("an area is served as its key, its name as source text and whether it is retired, and nothing else", () => {
    const area = { key: "field-work", name: { untrusted: "Field work" }, retired: false };
    expect(accepts(AreaView, area)).toBe(true);
    expect(accepts(AreaView, { ...area, id: "are_01JABCDEFGHJKMNPQRSTVWXYZ0" })).toBe(false);
    expect(accepts(AreaView, { ...area, compartments: ["own"] })).toBe(false);
    expect(accepts(AreaView, { key: "field-work", name: "Field work", retired: false })).toBe(false);
  });

  it("propose_project takes an area's key, never null or a name", () => {
    const args = { name: "Kiln rebuild", requestId: REQUEST };
    expect(accepts(ProposeProjectArgs, args)).toBe(true);
    expect(accepts(ProposeProjectArgs, { ...args, area: "field-work" })).toBe(true);
    expect(accepts(ProposeProjectArgs, { ...args, area: null })).toBe(false);
    expect(accepts(ProposeProjectArgs, { ...args, area: "Field work" })).toBe(false);
  });

  it("update_project takes an area alone, and null for none", () => {
    const args = { project: ENT, requestId: REQUEST };
    expect(accepts(UpdateProjectArgs, args)).toBe(false);
    expect(accepts(UpdateProjectArgs, { ...args, area: "field-work" })).toBe(true);
    expect(accepts(UpdateProjectArgs, { ...args, area: null })).toBe(true);
    expect(accepts(UpdateProjectArgs, { ...args, area: "Field work" })).toBe(false);
  });

  it("list_projects filters by an area and orders by the areas, and always answers the areas", () => {
    expect(accepts(ListProjectsArgs, { area: "field-work", order: "area" })).toBe(true);
    expect(accepts(ListProjectsArgs, { order: "changed" })).toBe(true);
    expect(accepts(ListProjectsArgs, { order: "name" })).toBe(false);
    expect(accepts(ListProjectsArgs, { area: ["field-work"] })).toBe(false);
    expect(accepts(ListProjectsResult, { projects: [], areas: [] })).toBe(true);
    expect(accepts(ListProjectsResult, { projects: [] })).toBe(false);
  });

  it("the board takes an area's key", () => {
    expect(accepts(PersonalWorkArgs.list_opportunities, { scope: "board", area: "field-work" })).toBe(true);
    expect(accepts(PersonalWorkArgs.list_opportunities, { scope: "board", area: "Field work" })).toBe(false);
  });

  it("an area that cannot be used is a named refusal on the area, with a hint that names no area", () => {
    for (const tool of ["propose_project", "update_project"] as const)
      expect(CLAIM_REFUSAL_FIELDS[tool]?.area_unknown).toEqual({ field: "area" });
    expect(CLAIM_REFUSAL_HINTS.area_unknown).toContain("list_projects");
  });
});
