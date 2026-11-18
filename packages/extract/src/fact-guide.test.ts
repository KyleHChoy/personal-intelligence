import { KIND_REGISTRY } from "@intelligence/contracts/personal";
import { ADDED_FACT_TYPES, PROJECT_FINDING_TYPES } from "@intelligence/personal-beliefs";
import { describe, expect, it } from "vitest";
import { CORRESPONDENCE_V4_TYPES } from "./lane-versions.ts";
import { typeLineV2 } from "./message-prompts.ts";

// The ontology's types and the extraction prompts' definition of each kind are the kind
// registry's, so they cannot drift. Every pinned version's text stays as it was: the registry
// quotes the ontology's meanings, and the fact-kind versions take its belongs and examples.
describe("the kind registry, the ontology and the extraction prompts", () => {
  const types = [...CORRESPONDENCE_V4_TYPES, ...ADDED_FACT_TYPES, ...PROJECT_FINDING_TYPES];
  const typed = Object.entries(KIND_REGISTRY.kinds).filter(([, entry]) => entry.type !== null);

  it("each kind with a type is the current version's type: fields, subject kinds and belief kind", () => {
    expect(typed.length).toBe(18);
    for (const [kind, entry] of typed) {
      const type = types.find((one) => one.id === entry.type);
      expect(type, kind).toBeDefined();
      expect(
        type?.fields.map((field) => ({ name: field.name, kind: field.kind, required: field.required })),
        kind,
      ).toEqual(entry.fields);
      expect(type?.subjectKinds, kind).toEqual(entry.subjectKinds);
      expect(type?.beliefKind ?? null, kind).toBe(entry.beliefKind);
    }
  });

  it("a prompt's line for each kind shows the registry's definition", () => {
    for (const [kind, entry] of typed) {
      const type = types.find((one) => one.id === entry.type) as (typeof types)[number];
      expect(type.meaning, kind).toBe(entry.means);
      expect(typeLineV2(type), kind).toContain(entry.means);
    }
  });
});
