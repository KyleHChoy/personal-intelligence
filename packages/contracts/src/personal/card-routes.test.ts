import { describe, expect, it } from "vitest";
import { AGENT_ATTEMPT_KINDS, AGENT_RULING_KINDS, AGENT_SETTLES, CARD_NOT_ASKED } from "./card-attempts.ts";
import { CARD_OPTIONS } from "./card-kinds.ts";
import {
  CARD_RELAY_AFTER_ATTEMPT,
  CARD_RELAY_KINDS,
  CARD_RELAY_NEVER,
  isCardRelayKind,
  RELAYED_CONFIRM_KINDS,
} from "./card-relays.ts";

// Every card kind has one route. The four lists are disjoint and together
// hold every kind CARD_OPTIONS names, so a new kind fails here until it is placed.

const LISTS = {
  CARD_RELAY_NEVER,
  AGENT_ATTEMPT_KINDS,
  CARD_RELAY_KINDS,
  CARD_NOT_ASKED,
} as const;

describe("the card lists", () => {
  it("place every card kind in exactly one list", () => {
    for (const kind of Object.keys(CARD_OPTIONS)) {
      const holding = Object.entries(LISTS)
        .filter(([, list]) => (list as readonly string[]).includes(kind))
        .map(([name]) => name);
      expect({ kind, holding: holding.length }).toEqual({ kind, holding: 1 });
    }
  });

  it("name only card kinds", () => {
    for (const list of Object.values(LISTS))
      for (const kind of list) expect(Object.hasOwn(CARD_OPTIONS, kind)).toBe(true);
  });

  it("keep what only the owner answers out of every agent's reach", () => {
    for (const kind of [
      "goal_proposal",
      "question_rule",
      "draft_waiting",
      "grant_suggestion",
      "grant_lift_suggestion",
      "research_request",
    ])
      expect(CARD_RELAY_NEVER).toContain(kind);
  });

  // The owner's ruling: a question that reaches the owner and takes an answer is asked through
  // the agent of the question role, unless its answer releases, sends, pays, grants, writes the
  // owner's own words or merges identities.
  it("ask through an agent every kind that reaches the owner with an answer a relayed word may carry", () => {
    for (const kind of ["opportunity_decision", "lesson", "client_preference", "owner_question", "idea", "about_you"])
      expect(CARD_RELAY_KINDS).toContain(kind);
    for (const kind of [...CARD_RELAY_NEVER, ...CARD_NOT_ASKED]) expect(isCardRelayKind(kind)).toBe(false);
  });

  it("ask through an agent after an attempt only kinds an agent is asked first, never an identity", () => {
    for (const kind of CARD_RELAY_AFTER_ATTEMPT) {
      expect(AGENT_ATTEMPT_KINDS).toContain(kind);
      expect(isCardRelayKind(kind)).toBe(true);
    }
    expect(isCardRelayKind("agent_claim")).toBe(true);
    expect(isCardRelayKind("shared_address")).toBe(false);
    // A reminder is due when it is raised: it goes to the owner, never through an agent.
    expect(isCardRelayKind("reminder")).toBe(false);
    // A relation audit is the owner's own check of a model's relation, which outranks agents' reports.
    expect(isCardRelayKind("relation_audit")).toBe(false);
  });

  // A relayed confirm of a claim is the owner's word relayed: read at its own tier, never theirs.
  it("read a relayed confirm at its own tier only for the claim kinds, each asked through an agent", () => {
    expect([...RELAYED_CONFIRM_KINDS].sort()).toEqual(["about_you", "agent_claim"]);
    for (const kind of RELAYED_CONFIRM_KINDS) expect(isCardRelayKind(kind)).toBe(true);
  });

  it("store a ruling only for a kind an agent settles, with options of its own", () => {
    for (const kind of AGENT_RULING_KINDS) {
      const answers = AGENT_SETTLES[kind] ?? [];
      expect(answers.length).toBeGreaterThan(0);
      for (const answer of answers) expect(CARD_OPTIONS[kind]).toContain(answer);
    }
  });
});
