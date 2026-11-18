import { describe, expect, it } from "vitest";
import { hasIdToken, proseFieldsWithIds } from "./prose-ids.ts";

describe("ids in prose", () => {
  for (const prefix of ["itn", "cap", "amg"]) {
    it(`refuses a ${prefix} id in prose but permits the same id in a ref`, () => {
      const id = `${prefix}_01J00000000000000000000001`;
      expect(hasIdToken(`Read ${id} next.`)).toBe(true);
      expect(
        proseFieldsWithIds({ report: { deliverable: `Read ${id} next.`, sources: [{ kind: "capture", id }] } }),
      ).toEqual(["report.deliverable"]);
      expect(proseFieldsWithIds({ sources: [{ kind: "capture", id }] })).toEqual([]);
    });
  }
});
