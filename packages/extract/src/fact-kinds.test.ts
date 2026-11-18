import type { Claim, ClaimContent } from "@intelligence/contracts";
import { BELIEF_TYPES, type BeliefClaim } from "@intelligence/contracts/personal";
import {
  BELIEF_RULES,
  legacyFactKeys,
  PERSONAL_ONTOLOGY,
  personalFactKey,
  personalType,
  reclassify,
  rulableKind,
  settle,
} from "@intelligence/personal-beliefs";
import { proposalLine, renderLine } from "@intelligence/personal-core/views";
import { describe, expect, it } from "vitest";
import { ontologyFor } from "./lane-versions.ts";

// The view, status and visited kinds, their
// fact keys, the status supersession rule and the kind ruling's bounds.
const OWNER = "ent_00000000000000000000000OWN" as ClaimContent["subject"];
const content = (type: string, fields: Record<string, unknown>): ClaimContent => ({ type, subject: OWNER, fields });
const key = (type: string, fields: Record<string, unknown>) =>
  personalFactKey(content(type, fields), "", ["own"], undefined, 2);
const status = (state: string, extra: Record<string, unknown> = {}) => ({
  domain: "travel",
  organization_name: "Consulate",
  process: "visa application",
  state,
  ...extra,
});

let n = 0;
const claim = (type: string, fields: Record<string, unknown>, at: string): BeliefClaim => {
  n += 1;
  const id = n.toString(16).padStart(64, "0");
  return {
    claim: {
      id,
      content: content(type, fields),
      statementKind: "stated_fact",
      basis: "third_party",
      validFrom: at,
      evidence: [{ evidenceId: id, span: "chars:0-1" }],
      primaryEvidenceId: id,
      label: { compartments: ["own"], readers: [] },
      systemOriginated: false,
    } as unknown as Claim,
    origin: "agent_record",
    subjectKind: "owner",
  };
};

describe("the view, status and visited kinds", () => {
  it("are belief types with a rule each, in the whole ontology and in no lane's view", () => {
    for (const type of ["view", "status", "visited"]) {
      expect(BELIEF_TYPES, type).toContain(type);
      expect(BELIEF_RULES[type as "view"], type).toBeDefined();
      expect(personalType(type)?.beliefKind, type).toBe(type);
      for (const lane of ["correspondence", "transaction", "document", "meeting", "moment"] as const)
        expect(ontologyFor(lane).get(type), `${lane}: ${type}`).toBeNull();
    }
  });

  it("a status keys by its organization and process: a new state or domain is the same fact, another organization another", () => {
    const first = key("status", status("in review"));
    expect(key("status", status("approved", { domain: "admin", since: "2026-05-01" }))).toBe(first);
    expect(key("status", status("in review", { organization_name: "Embassy" }))).not.toBe(first);
    expect(key("status", status("in review", { process: "passport renewal" }))).not.toBe(first);
  });

  it("a visit keys by its place alone; a view by its domain and topic, the view a value", () => {
    expect(key("visited", { domain: "travel", place: "Lisbon", when: "2026-03-10" })).toBe(
      key("visited", { domain: "interests", place: "lisbon" }),
    );
    expect(key("visited", { domain: "travel", place: "Lisbon" })).not.toBe(
      key("visited", { domain: "travel", place: "Porto" }),
    );
    const remote = key("view", { domain: "career", view: "remote teams ship faster", topic: "remote work" });
    expect(key("view", { domain: "career", view: "remote teams ship slower", topic: "Remote work" })).toBe(remote);
    expect(key("view", { domain: "career", view: "remote teams ship faster", topic: "hiring" })).not.toBe(remote);
    // A view stored with no topic keeps its key by the view itself.
    const untopical = key("view", { domain: "career", view: "remote teams ship faster" });
    expect(untopical).not.toBe(remote);
    expect(key("view", { domain: "career", view: "Remote teams ship faster" })).toBe(untopical);
    expect(key("view", { domain: "career", view: "remote teams ship slower" })).not.toBe(untopical);
  });

  it("a view with a topic keeps its first key as a legacy key, so a ruling on a stored view still finds it", () => {
    const view = content("view", { domain: "career", view: "remote teams ship faster", topic: "remote work" });
    const [, alt] = legacyFactKeys(view, "", ["own"]);
    expect(alt).toBe(key("view", { domain: "career", view: "remote teams ship faster" }));
    expect(
      legacyFactKeys(content("view", { domain: "career", view: "remote teams ship faster" }), "", ["own"]),
    ).toHaveLength(1);
  });

  it("a view's latest word on its topic is the answer, with no dispute", () => {
    const earlier = claim(
      "view",
      { domain: "career", topic: "remote work", view: "remote teams ship faster" },
      "2026-05-01T10:00:00.000Z",
    );
    const later = claim(
      "view",
      { domain: "career", topic: "remote work", view: "remote teams ship slower" },
      "2026-05-03T10:00:00.000Z",
    );
    const settled = settle(BELIEF_RULES.view, [earlier, later]);
    expect(settled.claims.map((one) => one.id)).toEqual([later.claim.id]);
    expect(settled.conflict(settled.claims)).toBe(false);
  });

  it("every belief kind has a rule", () => {
    for (const type of BELIEF_TYPES) {
      const kind = PERSONAL_ONTOLOGY.get(type)?.beliefKind;
      expect(kind, type).toBeDefined();
      expect(BELIEF_RULES[kind as keyof typeof BELIEF_RULES], type).toBeDefined();
    }
  });

  it("the six kinds keep the keys they had: a situation's until and momentary stay values", () => {
    expect(key("situation", { domain: "home", state: "moving to Denver", until: "2026-09-01", momentary: false })).toBe(
      key("situation", { domain: "home", state: "moving to Denver" }),
    );
    expect(key("preference", { domain: "travel", object: "aisle seats", polarity: "prefers" })).not.toBe(
      key("preference", { domain: "travel", object: "aisle seats", polarity: "avoids" }),
    );
  });

  it("a status's latest state supersedes the earlier, with no dispute, whoever said each", () => {
    const rule = BELIEF_RULES.status;
    if (rule === undefined) throw new Error("no status rule");
    const earlier = claim("status", status("in review"), "2026-05-01T10:00:00.000Z");
    const later = claim("status", status("approved"), "2026-05-03T10:00:00.000Z");
    const settled = settle(rule, [earlier, later]);
    expect(settled.claims.map((one) => one.id)).toEqual([later.claim.id]);
    expect(settled.conflict(settled.claims)).toBe(false);
    // Two claims of the latest state both support it.
    const again = claim("status", status("approved"), "2026-05-02T10:00:00.000Z");
    expect(
      settle(rule, [earlier, again, later])
        .claims.map((one) => one.id)
        .sort(),
    ).toEqual([again.claim.id, later.claim.id].sort());
  });

  // The exclusion of a claim heard in a meeting and the source tiers apply before the newest
  // wins, so a newer claim heard in a meeting, or one of a lower tier, never replaces the owner's state.
  it("a status's newest claim wins within the top tier, after a heard claim is left out where the owner's word is", () => {
    const rule = BELIEF_RULES.status;
    if (rule === undefined) throw new Error("no status rule");
    const stated = claim("status", status("approved"), "2026-05-01T10:00:00.000Z");
    const his: BeliefClaim = {
      ...stated,
      origin: "source",
      ownerSaid: true,
      claim: { ...stated.claim, basis: "explicit_self" },
    };
    // A newer statement heard in a meeting, credited to nobody.
    const heardOne = claim("status", status("rejected"), "2026-05-05T10:00:00.000Z");
    const heard: BeliefClaim = {
      ...heardOne,
      origin: "source",
      meeting: true,
      claim: { ...heardOne.claim, evidence: [{ evidenceId: heardOne.claim.id, span: "seg:0-10" }] } as unknown as Claim,
    };
    expect(settle(rule, [his, heard]).claims.map((one) => one.id)).toEqual([his.claim.id]);
    // A newer claim of a lower tier (a third party's, `source`) than the owner's own word states something else.
    const third: BeliefClaim = {
      ...claim("status", status("in review"), "2026-05-07T10:00:00.000Z"),
      origin: "source",
    };
    expect(settle(rule, [his, heard, third]).claims.map((one) => one.id)).toEqual([his.claim.id]);
    // Within one tier the newest still wins.
    const later: BeliefClaim = { ...claim("status", status("mailed"), "2026-05-09T10:00:00.000Z"), origin: "source" };
    expect(settle(rule, [third, later]).claims.map((one) => one.id)).toEqual([later.claim.id]);
  });

  // The owner's confirm was of the state then: a later notice of the next state moves it, while a
  // later third party's claim still does not, and the owner's own later word moves it back.
  it("a status the owner confirmed moves when a later notice states its next state", () => {
    const rule = BELIEF_RULES.status;
    if (rule === undefined) throw new Error("no status rule");
    const confirmed: BeliefClaim = {
      ...claim("status", status("in review"), "2026-05-01T10:00:00.000Z"),
      origin: "source",
      ownerConfirmed: true,
    };
    const notice: BeliefClaim = {
      ...claim("status", status("approved"), "2026-05-04T10:00:00.000Z"),
      origin: "source",
      notice: true,
    };
    expect(settle(rule, [confirmed, notice]).claims.map((one) => one.id)).toEqual([notice.claim.id]);
    const third: BeliefClaim = {
      ...claim("status", status("rejected"), "2026-05-06T10:00:00.000Z"),
      origin: "source",
    };
    expect(settle(rule, [confirmed, notice, third]).claims.map((one) => one.id)).toEqual([notice.claim.id]);
    const stated = claim("status", status("withdrawn"), "2026-05-08T10:00:00.000Z");
    const his: BeliefClaim = {
      ...stated,
      origin: "source",
      ownerSaid: true,
      claim: { ...stated.claim, basis: "explicit_self" },
    };
    expect(settle(rule, [confirmed, notice, third, his]).claims.map((one) => one.id)).toEqual([his.claim.id]);
    // The owner's own stated word is not replaced by a later notice.
    const after: BeliefClaim = {
      ...claim("status", status("approved"), "2026-05-12T10:00:00.000Z"),
      origin: "source",
      notice: true,
    };
    expect(settle(rule, [his, after]).claims.map((one) => one.id)).toEqual([his.claim.id]);
    // A reminder repeating a state already moved past does not step back.
    const reminder: BeliefClaim = {
      ...claim("status", status("in review"), "2026-05-05T10:00:00.000Z"),
      origin: "source",
      notice: true,
    };
    expect(settle(rule, [confirmed, notice, reminder]).claims.map((one) => one.id)).toEqual([notice.claim.id]);
    // An earlier notice never replaces a later state the owner confirmed.
    const early: BeliefClaim = { ...notice, claim: { ...notice.claim, validFrom: "2026-04-01T10:00:00.000Z" } };
    expect(settle(rule, [confirmed, early]).claims.map((one) => one.id)).toEqual([confirmed.claim.id]);
  });

  it("a view and a visit hold no value that can differ: every claim counts", () => {
    const one = claim("visited", { domain: "travel", place: "Lisbon", when: "2026-03-10" }, "2026-05-01T10:00:00.000Z");
    const two = claim("visited", { domain: "travel", place: "Lisbon", when: "2026-04-10" }, "2026-05-02T10:00:00.000Z");
    expect(settle(BELIEF_RULES.visited as NonNullable<typeof BELIEF_RULES.visited>, [one, two]).claims).toHaveLength(2);
  });

  it("a kind ruling moves a situation to a view, never to or from a status or a visit", () => {
    expect(rulableKind("situation", "view")).toBe(true);
    expect(rulableKind("view", "goal")).toBe(true);
    for (const [from, to] of [
      ["situation", "status"],
      ["situation", "visited"],
      ["status", "situation"],
      ["visited", "goal"],
      ["goal", "preference"],
    ])
      expect(rulableKind(from as string, to as string), `${from} to ${to}`).toBe(false);
    expect(typeof reclassify).toBe("function");
  });

  it("each renders as a line in plain words", () => {
    expect(proposalLine("status", status("in review"))).toBe("Consulate, visa application (travel): in review");
    expect(proposalLine("visited", { domain: "travel", place: "Lisbon" })).toBe("Visited (travel): Lisbon");
    expect(proposalLine("view", { domain: "career", view: "remote teams ship faster", topic: "remote work" })).toBe(
      "View on remote work (career): remote teams ship faster",
    );
    expect(typeof renderLine).toBe("function");
  });
});
