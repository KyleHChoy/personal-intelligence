import { LocalEntityId } from "@intelligence/contracts";
import { factKey, keyVersionOf, PERSONAL_ONTOLOGY, PERSONAL_TYPES } from "@intelligence/personal-beliefs";
import { describe, expect, it } from "vitest";
import { EXTRACT_GENERATION } from "./config.ts";
import { PROMPT_VERSIONS, typeLineV2 } from "./message-prompts.ts";

const subject = LocalEntityId.parse("ent_00000000000000000000000001");

describe("the fact key beside the message prompts", () => {
  it("adding a belief kind to a type leaves its fact key and its prompt line unchanged", () => {
    const goal = { type: "goal", subject, fields: { what: "I want to run a marathon next year." } };
    const withKind = {
      ...PERSONAL_ONTOLOGY,
      get: (id: string) => {
        const type = PERSONAL_ONTOLOGY.get(id);
        return type === null ? null : { ...type, beliefKind: "goal" as const };
      },
    };
    expect(factKey(goal, { ontology: withKind })).toBe(factKey(goal, { ontology: PERSONAL_ONTOLOGY }));
    for (const type of PERSONAL_TYPES)
      expect(typeLineV2({ ...type, beliefKind: "goal" })).toBe(typeLineV2({ ...type, beliefKind: undefined }));
  });

  it("the key version and the correspondence prompt move together: generation 5 or later if and only if prompt 4 or later", () => {
    expect(keyVersionOf(EXTRACT_GENERATION) === 2).toBe(Number(PROMPT_VERSIONS.correspondence) >= 4);
  });
});
