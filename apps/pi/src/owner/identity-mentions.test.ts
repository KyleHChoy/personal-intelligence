import type { MentionCandidate } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { mentionLines } from "./identity.ts";

const ULID = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const candidate = {
  mention: `umn_${ULID}`,
  count: 2,
  entity: `ent_${ULID}`,
  established: true,
  type: "role",
  field: "subject",
  name: { untrusted: "Bryn Calder" },
} as MentionCandidate;

describe("pi identity mentions", () => {
  it("mentions prints ids and counts, and names only on a terminal", () => {
    expect(mentionLines([candidate], false)).toEqual([
      { mention: `umn_${ULID}`, count: 2, entity: `ent_${ULID}`, established: true, type: "role", field: "subject" },
    ]);
    expect(JSON.stringify(mentionLines([candidate], false))).not.toContain("Bryn");
    expect(mentionLines([candidate], true)).toEqual([
      {
        mention: `umn_${ULID}`,
        count: 2,
        entity: `ent_${ULID}`,
        established: true,
        type: "role",
        field: "subject",
        name: "Bryn Calder",
      },
    ]);
    expect(mentionLines([], true)).toEqual([]);
  });
});
