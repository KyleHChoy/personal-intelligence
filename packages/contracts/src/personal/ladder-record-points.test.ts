import { createHash } from "node:crypto";
import {
  DECISION_POINT_PINS,
  DECISION_POINTS,
  EFFECT_CLASS,
  OWNER_ONLY_EFFECTS,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";

// The ladder's canonical JSON (packages/ladder/src/hash.ts), written out again here:
// contracts imports nothing in the repository, and the ladder's own load check reads the same pins.
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item: unknown) => canonicalJson(item ?? null)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const fields = Object.entries(value).filter(([, held]) => held !== undefined);
    fields.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${fields.map(([name, held]) => `${JSON.stringify(name)}:${canonicalJson(held)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
const hashOf = (value: unknown): string => createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");

const NEW = ["record_echo", "about_you", "client_preference"] as const;
const point = (id: string) => DECISION_POINTS.find((definition) => definition.id === id);

describe("the decision points of about_you, client_preference and record_echo", () => {
  it("no new point maps a model rung to an external effect, and none holds an owner-only effect", () => {
    const ownerOnly = new Set<string>(OWNER_ONLY_EFFECTS);
    for (const id of NEW) {
      const definition = point(id);
      expect(definition, id).toBeDefined();
      const effects = Object.values(definition?.outputs ?? {});
      if (definition?.rungs.some((rung) => rung >= 1 && rung <= 3))
        expect(
          effects.map((effect) => EFFECT_CLASS[effect]),
          id,
        ).not.toContain("external");
      for (const effect of effects) expect(ownerOnly.has(effect), `${id} ${effect}`).toBe(false);
    }
    for (const effect of ["mark_echo", "accept_about_owner", "admit_client_preference"] as const)
      expect(EFFECT_CLASS[effect], effect).toBe("internal_reversible");
  });

  it("about_you@1 and client_preference@1 have rung 4 only", () => {
    expect(point("about_you")).toEqual({
      id: "about_you",
      version: 1,
      rungs: [4],
      outputs: { confirm: "accept_about_owner", reject: "decline" },
      queue: "about_you",
      onNoAnswer: "expire",
      expiresAfterDays: 30,
    });
    expect(point("client_preference")).toEqual({
      id: "client_preference",
      version: 1,
      rungs: [4],
      outputs: { confirm: "admit_client_preference", reject: "decline" },
      queue: "client_preference",
      onNoAnswer: "expire",
      expiresAfterDays: 30,
    });
  });

  it("record_echo@1 has rung 0 only", () => {
    expect(point("record_echo")).toEqual({
      id: "record_echo",
      version: 1,
      rungs: [0],
      outputs: { echo: "mark_echo", stale: "mark_echo", new: "record_silence", undecided: "record_silence" },
    });
  });

  it("the pins match", () => {
    for (const definition of DECISION_POINTS)
      expect(DECISION_POINT_PINS[`${definition.id}@${definition.version}`], definition.id).toBe(hashOf(definition));
  });
});
