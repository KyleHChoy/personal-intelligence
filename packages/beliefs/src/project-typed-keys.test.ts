import { describe, expect, it } from "vitest";
import { KEY_V2_GENERATION, keyVersionOf, matchKey, personalFactKey } from "./fact-key.ts";
import { personalType } from "./ontology.ts";

const PROJECT = "ent_01JABCDEFGHJKMNPQRSTVWXYZ0";
const EVIDENCE = "a".repeat(64);
const LABEL = ["agent:scout", "own"];
const version = keyVersionOf(KEY_V2_GENERATION);

describe("a project's typed kinds", () => {
  it("are ontology types whose one subject kind is a project, with the fields the contract types", () => {
    const fields = (id: string): string[] => (personalType(id)?.fields ?? []).map((field) => field.name);
    for (const id of ["project.status", "project.next_step", "project.decision"])
      expect(personalType(id)?.subjectKinds, id).toEqual(["project"]);
    expect(fields("project.status")).toEqual(["status", "what"]);
    expect(fields("project.next_step")).toEqual(["what", "who", "due"]);
    expect(fields("project.decision")).toEqual(["what"]);
  });

  it("key a status by its project alone, so every status of a project is one fact", () => {
    const key = (status: string, evidence: string): string =>
      personalFactKey(
        { type: "project.status", subject: PROJECT as never, fields: { status } },
        evidence as never,
        LABEL,
        undefined,
        version,
      );
    expect(key("blocked", EVIDENCE)).toBe(key("active", "b".repeat(64)));
    expect(() =>
      matchKey({ type: "project.status", subject: PROJECT as never, fields: { status: "blocked" } }, version),
    ).not.toThrow();
  });

  it("key a decision and a next step without failing", () => {
    for (const [type, fields] of [
      ["project.decision", { what: "Fire in April." }],
      ["project.next_step", { what: "Order the firebrick.", who: PROJECT }],
    ] as const) {
      const content = { type, subject: PROJECT as never, fields };
      expect(typeof personalFactKey(content, EVIDENCE as never, LABEL, undefined, version), type).toBe("string");
      expect(() => matchKey(content, version), type).not.toThrow();
    }
  });
});
