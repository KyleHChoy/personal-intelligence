import type { ClaimRecord } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { type Candidate, matchCarry } from "../extraction/admin-reattach.ts";
import { type Shown, shownText, withinLabel } from "./ruling-anchors.ts";

const record = (type: string, subject: string, fields: Record<string, unknown>): ClaimRecord =>
  ({ claim: { content: { type, subject, fields }, validFrom: "2026-03-01T00:00:00.000Z" } }) as unknown as ClaimRecord;

describe("shownText", () => {
  it("keeps the verdict and each claim's type, subject, fields and time, and nothing else of the record", () => {
    const shown = JSON.parse(
      shownText("veto", [record("role", "ent_one", { title: "Engineer", organization: "ent_org" })]),
    ) as Shown;
    expect(shown).toEqual({
      version: 1,
      verdict: "veto",
      claims: [
        {
          type: "role",
          subject: "ent_one",
          fields: { title: "Engineer", organization: "ent_org" },
          validFrom: "2026-03-01T00:00:00.000Z",
        },
      ],
    });
  });

  it("keeps both sides of a join, in the order of its keys", () => {
    const shown = JSON.parse(
      shownText("join", [record("need", "ent_one", { what: "a" }), record("need", "ent_one", { what: "b" })]),
    ) as Shown;
    expect(shown.claims.map((one) => one.fields.what)).toEqual(["a", "b"]);
  });
});

describe("withinLabel", () => {
  it("holds only when the ruling's label has every compartment of the claim shown", () => {
    expect(withinLabel(["own"], ["own"])).toBe(true);
    expect(withinLabel(["own"], ["agent:one", "own"])).toBe(true);
    expect(withinLabel(["employer:example", "own"], ["own"])).toBe(false);
  });
});

// The carry by anchors: a type and the entities the ruled claim named, with no subject to read.
const claim = (n: number, over: Partial<Candidate> = {}): Candidate => ({
  claim: String(n).padStart(64, "c"),
  type: "role",
  subject: "ent_one",
  factKey: String(n).padStart(64, "f"),
  entities: ["ent_one", "ent_org"],
  ...over,
});
// The claim the owner saw, from the ruling's snapshot: without it code carries nothing.
const SHOWN = { subject: "ent_one", fields: {} };
const ANCHOR = { type: "role", entities: ["ent_org", "ent_one"], shown: SHOWN };

describe("matchCarry by a ruling's anchors", () => {
  it("re-attaches to the one fact of the type that names exactly the ruling's entities, in any order", () => {
    const one = claim(1);
    expect(
      matchCarry(ANCHOR, [
        claim(2, { entities: ["ent_one", "ent_other_org"] }),
        one,
        claim(3, { type: "affiliation" }),
      ]),
    ).toEqual({ outcome: "reattach", claim: one.claim, factKey: one.factKey });
  });

  it("asks about two facts that name the same entities, naming both", () => {
    expect(matchCarry(ANCHOR, [claim(2), claim(1)])).toEqual({
      outcome: "ask",
      claims: [claim(1).claim, claim(2).claim],
    });
  });

  it("asks, never guesses, when claims of the type name other entities: a claim about someone else is no match", () => {
    const other = claim(1, { entities: ["ent_two", "ent_org"] });
    expect(matchCarry(ANCHOR, [other])).toEqual({ outcome: "ask", claims: [other.claim] });
    const fewer = claim(2, { entities: ["ent_one"] });
    expect(matchCarry(ANCHOR, [fewer])).toEqual({ outcome: "ask", claims: [fewer.claim] });
  });

  it("is gone when the evidence holds no claim of the type", () => {
    expect(matchCarry(ANCHOR, [claim(1, { type: "commitment" })])).toEqual({ outcome: "gone" });
    expect(matchCarry(ANCHOR, [])).toEqual({ outcome: "gone" });
  });

  it("an owner-side ruling, which names no entity, re-attaches only to a claim that names none", () => {
    const own = claim(1, { type: "need", entities: [] });
    const about = claim(2, { type: "need", entities: ["ent_two"] });
    const need = { type: "need", entities: [], shown: SHOWN };
    expect(matchCarry(need, [own, about])).toEqual({
      outcome: "reattach",
      claim: own.claim,
      factKey: own.factKey,
    });
    expect(matchCarry(need, [about])).toEqual({ outcome: "ask", claims: [about.claim] });
  });

  it("with a subject and entities both known, holds to both", () => {
    const identity = { type: "role", subject: "ent_one", entities: ["ent_one", "ent_org"], shown: SHOWN };
    expect(matchCarry(identity, [claim(1, { subject: "ent_two" })])).toEqual({ outcome: "gone" });
    expect(matchCarry(identity, [claim(1)])).toMatchObject({ outcome: "reattach" });
  });
});
