import { TYPED_FIELDS, TypedClaimType } from "@intelligence/contracts/personal";
import { ADDED_FACT_TYPES } from "@intelligence/personal-beliefs";
import { describe, expect, it } from "vitest";
import { CORRESPONDENCE_V4_TYPES } from "./lane-versions.ts";

// The view, status and visited types are typed kinds too, though only the fact-kind versions offer
// them.
const TYPES = [...CORRESPONDENCE_V4_TYPES, ...ADDED_FACT_TYPES];

// A typed claim's fields are its ontology type's, so the contract's TYPED_FIELDS and this package's
// ontology cannot drift. Each typed kind is a correspondence type at version 4; its field names are
// the type's, and every field the type requires is one the typed kind requires too.
describe("typed claim fields", () => {
  it("every typed kind is an ontology belief kind, with the type's field names and its required fields", () => {
    for (const kind of TypedClaimType.options) {
      const type = TYPES.find((one) => one.id === kind);
      expect(type, kind).toBeDefined();
      expect(type?.beliefKind, kind).toBeDefined();
      const shape = TYPED_FIELDS[kind].shape as Record<string, { isOptional(): boolean }>;
      const names = new Set(type?.fields.map((field) => field.name));
      for (const name of Object.keys(shape)) expect(names.has(name), `${kind}.${name}`).toBe(true);
      for (const field of type?.fields ?? [])
        if (field.required) expect(shape[field.name]?.isOptional(), `${kind}.${field.name}`).toBe(false);
    }
  });

  // A typed claim is never about the owner, so a kind whose only subject is the owner (a status) is
  // no typed kind.
  it("covers every keyed belief kind a person can be the subject of", () => {
    const keyed = TYPES.filter(
      (type) => type.beliefKind !== undefined && type.subjectKinds.some((kind) => kind === "person"),
    ).map((type) => type.id);
    expect([...TypedClaimType.options].sort()).toEqual([...keyed].sort());
  });
});
