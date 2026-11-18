import { describe, expect, it } from "vitest";
import { CAUSE_FORM, CAUSE_KINDS, filingWords } from "../outcomes/improvement-filing.ts";
import { type Candidate, type DetachedDefect, detachedCause, ladderStep, matchCarry } from "./admin-reattach.ts";

// The matching rule of the carry-over sweep. A ruling re-attaches only to the one fact of its type
// and subject its item now holds; none is gone; anything else is asked.

const claim = (n: number, over: Partial<Candidate> = {}): Candidate => ({
  claim: String(n).padStart(64, "c"),
  type: "role",
  subject: "ent_owner",
  factKey: String(n).padStart(64, "f"),
  fields: { title: "chief executive", status: "current" },
  ...over,
});
// What the owner was shown when the ruling was made: the claim's subject and its typed fields.
const SHOWN = { subject: "ent_owner", fields: { status: "current", title: "chief executive" } };
const ROLE = { type: "role", subject: "ent_owner", shown: SHOWN };

describe("matchCarry", () => {
  it("re-attaches to the one claim of the same type and subject, beside claims of other types and subjects", () => {
    const one = claim(1);
    expect(matchCarry(ROLE, [claim(2, { type: "commitment" }), one, claim(3, { subject: "ent_other" })])).toEqual({
      outcome: "reattach",
      claim: one.claim,
      factKey: one.factKey,
    });
  });

  it("re-attaches to one fact held by two claims of the item, named by its first claim", () => {
    const [a, b] = [claim(2, { factKey: "k".repeat(64) }), claim(1, { factKey: "k".repeat(64) })];
    expect(matchCarry(ROLE, [a, b])).toEqual({ outcome: "reattach", claim: b.claim, factKey: "k".repeat(64) });
  });

  it("asks about two facts of the same type and subject, naming both claims", () => {
    expect(matchCarry(ROLE, [claim(2), claim(1)])).toEqual({
      outcome: "ask",
      claims: [claim(1).claim, claim(2).claim],
    });
  });

  it("is gone when no claim of the item is of the same type and subject", () => {
    expect(matchCarry(ROLE, [claim(1, { type: "commitment" }), claim(2, { subject: "ent_other" })])).toEqual({
      outcome: "gone",
    });
    expect(matchCarry(ROLE, [])).toEqual({ outcome: "gone" });
  });

  it("never carries a ruling onto a fact that says something else: the same type and people, the opposite value", () => {
    // The owner rejected "P is chief executive of X"; the item is now read as "P left X".
    const people = ["ent_p", "ent_x"];
    const identity = { type: "role", entities: people, shown: { subject: "ent_p", fields: SHOWN.fields } };
    const left = claim(1, {
      subject: "ent_p",
      entities: people,
      fields: { title: "chief executive", status: "ended" },
    });
    expect(matchCarry(identity, [left])).toEqual({ outcome: "ask", claims: [left.claim] });
    const other = claim(2, { subject: "ent_x", entities: people });
    expect(matchCarry(identity, [other])).toEqual({ outcome: "ask", claims: [other.claim] });
    // The same statement, its fields in another order, is carried.
    const same = claim(3, {
      subject: "ent_p",
      entities: people,
      fields: { status: "current", title: "chief executive" },
    });
    expect(matchCarry(identity, [same])).toEqual({ outcome: "reattach", claim: same.claim, factKey: same.factKey });
  });

  it("a fact about the owner names no entity: it is carried only where its fields are what the owner saw", () => {
    const identity = { type: "role", entities: [], shown: SHOWN };
    const changed = claim(1, { entities: [], fields: { title: "chair", status: "current" } });
    expect(matchCarry(identity, [changed])).toEqual({ outcome: "ask", claims: [changed.claim] });
    const kept = claim(2, { entities: [] });
    expect(matchCarry(identity, [kept])).toEqual({ outcome: "reattach", claim: kept.claim, factKey: kept.factKey });
  });

  it("a ruling with no snapshot is never carried by code, whatever matches: made before snapshots, or emptied by an erasure", () => {
    const one = claim(1, { entities: [] });
    expect(matchCarry({ type: "role", subject: "ent_owner" }, [one])).toEqual({ outcome: "ask", claims: [one.claim] });
    expect(matchCarry({ type: "role", entities: [] }, [one])).toEqual({ outcome: "ask", claims: [one.claim] });
  });

  it("with no known type and subject, never re-attaches: one claim is asked about, none is gone", () => {
    expect(matchCarry(undefined, [claim(1)])).toEqual({ outcome: "ask", claims: [claim(1).claim] });
    expect(matchCarry(undefined, [claim(1), claim(2, { type: "commitment" })])).toEqual({
      outcome: "ask",
      claims: [claim(1).claim, claim(2).claim],
    });
    expect(matchCarry(undefined, [])).toEqual({ outcome: "gone" });
  });
});

describe("ladderStep", () => {
  const defect = (over: Partial<DetachedDefect> = {}): DetachedDefect => ({
    open: true,
    dismissed: false,
    taskEnded: false,
    ageHours: 1,
    ...over,
  });
  const on = { tasksOn: true, restricted: false };

  it("files a defect the first time, and waits while its task may still be worked", () => {
    expect(ladderStep({ ...on, defect: undefined })).toBe("file");
    expect(ladderStep({ ...on, defect: defect() })).toBe("wait");
    expect(ladderStep({ ...on, defect: defect({ ageHours: 47.9 }) })).toBe("wait");
  });

  it("asks the owner only after the agent's turn: the task ended, or the wait ran out", () => {
    expect(ladderStep({ ...on, defect: defect({ taskEnded: true }) })).toBe("ask");
    expect(ladderStep({ ...on, defect: defect({ ageHours: 48 }) })).toBe("ask");
  });

  it("asks the owner at once where no agent can be given it", () => {
    expect(ladderStep({ tasksOn: false, restricted: false, defect: undefined })).toBe("ask");
    expect(ladderStep({ tasksOn: true, restricted: true, defect: undefined })).toBe("ask");
  });

  it("the owner's dismissal of the defect stands: nothing is filed and nothing is asked", () => {
    expect(ladderStep({ ...on, defect: defect({ open: false, dismissed: true }) })).toBe("skip");
    expect(ladderStep({ ...on, defect: defect({ open: false, dismissed: true, taskEnded: true }) })).toBe("skip");
  });

  it("files again a defect code closed, when the ruling is found detached again", () => {
    expect(ladderStep({ ...on, defect: defect({ open: false }) })).toBe("file");
  });

  it("the defect's cause and state are ids, codes and counts, and its words are the system's", () => {
    const cause = detachedCause("rul_01JABCDEFGHJKMNPQRSTVWXYZ0", 7);
    expect(cause).toBe("ruling_detached:rul_01jabcdefghjkmnpqrstvwxyz0:7");
    expect(CAUSE_FORM.test(cause)).toBe(true);
    const words = filingWords({
      cause,
      kind: "ruling_detached",
      area: "knowledge",
      severity: "medium",
      state: "verdict=veto generation=7 candidates=2",
    });
    expect(words.title).toBe(CAUSE_KINDS.ruling_detached.title);
    expect(words.note).toBe(`Cause ${cause}. State: verdict=veto generation=7 candidates=2.`);
  });
});
