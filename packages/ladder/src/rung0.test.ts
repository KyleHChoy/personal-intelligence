import { IntentId } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import type { BasisFact, OpportunityFacts, WakeFacts } from "./facts.ts";
import { basisTrusted, opportunityGo, REASONER_DEFERRED_CARDS_MAX, wakeWorthRun } from "./rung0.ts";

// One test for each line of each function's order, each with facts equal to the case that
// returns run or go but for one field. Made-up ids.
const INTENT = IntentId.parse("int_01JABCDEFGHJKMNPQRSTVWXYZ0");
const INTENT2 = IntentId.parse("int_01JABCDEFGHJKMNPQRSTVWXYZ1");

const wake: WakeFacts = {
  source: "daily_sweep",
  killSwitch: false,
  anchorVetoed: false,
  reasonerRegistered: true,
  reasonerDeferredCards: 0,
  pendingCardsInClearance: 0,
  maxPendingCards: 10,
  runsToday: 0,
  maxRunsPerDay: 4,
  spentTodayMicroUsd: 0,
  maxMicroUsdPerDay: 1_000_000,
};

describe("wakeWorthRun", () => {
  it("the base case runs", () => {
    expect(wakeWorthRun(wake)).toEqual({ output: "run", reason: "wake" });
  });

  it("the kill switch skips first", () => {
    expect(wakeWorthRun({ ...wake, killSwitch: true, anchorVetoed: true })).toEqual({
      output: "skip",
      reason: "kill_switch",
    });
  });

  it("a vetoed wake is skipped before the budget is read", () => {
    expect(wakeWorthRun({ ...wake, anchorVetoed: true, runsToday: 99, spentTodayMicroUsd: 99_000_000 })).toEqual({
      output: "skip",
      reason: "vetoed",
    });
  });

  it("no reasoner skips", () => {
    expect(wakeWorthRun({ ...wake, reasonerRegistered: false })).toEqual({ output: "skip", reason: "no_reasoner" });
  });

  it("pending cards within the reasoner's clearance at the ceiling skip with owner_backlog", () => {
    expect(wakeWorthRun({ ...wake, pendingCardsInClearance: 10 })).toEqual({ output: "skip", reason: "owner_backlog" });
    expect(wakeWorthRun({ ...wake, pendingCardsInClearance: 9 })).toEqual({ output: "run", reason: "wake" });
  });

  it("one deferred card of the reasoner does not stop the planner; the threshold does", () => {
    const facts = { ...wake, maxPendingCards: 20, pendingCardsInClearance: 10 };
    expect(wakeWorthRun({ ...facts, reasonerDeferredCards: 1 })).toEqual({ output: "run", reason: "wake" });
    expect(wakeWorthRun({ ...facts, reasonerDeferredCards: REASONER_DEFERRED_CARDS_MAX - 1 })).toEqual({
      output: "run",
      reason: "wake",
    });
    expect(wakeWorthRun({ ...facts, reasonerDeferredCards: REASONER_DEFERRED_CARDS_MAX })).toEqual({
      output: "skip",
      reason: "owner_backlog",
    });
  });

  it("a spent budget skips, by runs or by dollars", () => {
    expect(wakeWorthRun({ ...wake, runsToday: 4 })).toEqual({ output: "skip", reason: "budget" });
    expect(wakeWorthRun({ ...wake, spentTodayMicroUsd: 1_000_000 })).toEqual({ output: "skip", reason: "budget" });
  });

  it("the owner's request skips the backlog and the run count and not the dollar ceiling", () => {
    const owner: WakeFacts = { ...wake, source: "owner_request" };
    expect(wakeWorthRun({ ...owner, reasonerDeferredCards: 3, pendingCardsInClearance: 10, runsToday: 4 })).toEqual({
      output: "run",
      reason: "wake",
    });
    expect(wakeWorthRun({ ...owner, spentTodayMicroUsd: 1_000_000 })).toEqual({ output: "skip", reason: "budget" });
    expect(wakeWorthRun({ ...owner, anchorVetoed: true })).toEqual({ output: "skip", reason: "vetoed" });
    expect(wakeWorthRun({ ...owner, reasonerRegistered: false })).toEqual({ output: "skip", reason: "no_reasoner" });
  });
});

const sent: BasisFact = {
  refKind: "message",
  sourceClass: "source",
  ownerBacked: true,
  flagged: false,
  tainted: false,
  threadFp: "t1",
  isAbout: false,
};
const inbound: BasisFact = { ...sent, ownerBacked: false };

const opportunity: OpportunityFacts = {
  kind: "meeting_prep",
  vetoed: false,
  cardPending: false,
  caseEverCarded: false,
  proposedByClass: "run",
  aboutOwner: false,
  restsOnOwnerHypothesis: false,
  caseClosed: null,
  intents: [{ id: INTENT, mode: "policy_decides", open: 0, maxOpen: 3, activeClients: 1 }],
  basis: [sent],
};

describe("opportunityGo", () => {
  it("the base case goes, under its intent", () => {
    expect(opportunityGo(opportunity)).toEqual({ output: "go", reason: "intent", intent: INTENT });
  });

  it("an owner_question is the owner's to decide: an answer counts only after their own go", () => {
    expect(opportunityGo({ ...opportunity, kind: "owner_question" })).toBe("cannot_decide");
    // Not vacuous: its one stage is internal, so it would otherwise go under its intent.
    expect(opportunityGo({ ...opportunity, kind: "investigate" })).toMatchObject({ output: "go" });
  });

  it("a veto is no_go, whatever else holds", () => {
    expect(
      opportunityGo({ ...opportunity, vetoed: true, cardPending: true, proposedByClass: "client", intents: [] }),
    ).toEqual({ output: "no_go", reason: "vetoed" });
  });

  it("an opportunity with a pending card cannot decide", () => {
    expect(opportunityGo({ ...opportunity, cardPending: true })).toBe("cannot_decide");
  });

  it("a case whose card expired, with no new source ref, is no_go", () => {
    expect(
      opportunityGo({
        ...opportunity,
        caseEverCarded: true,
        caseClosed: { by: "expiry", daysSince: 30, newSourceRef: false },
      }),
    ).toEqual({ output: "no_go", reason: "expired_no_news" });
  });

  it("with a new source ref inside 7 days it is still no_go", () => {
    expect(
      opportunityGo({
        ...opportunity,
        caseEverCarded: true,
        caseClosed: { by: "expiry", daysSince: 6, newSourceRef: true },
      }),
    ).toEqual({ output: "no_go", reason: "expired_no_news" });
  });

  it("a case the owner declined is no_go", () => {
    expect(
      opportunityGo({
        ...opportunity,
        caseEverCarded: true,
        caseClosed: { by: "owner", daysSince: 2, newSourceRef: false },
      }),
    ).toEqual({ output: "no_go", reason: "owner_declined" });
  });

  it("a case that ever had a card, with news after 7 days, cannot decide and never goes, whether the owner answered the card or it expired", () => {
    for (const by of ["owner", "expiry"] as const) {
      expect(
        opportunityGo({ ...opportunity, caseEverCarded: true, caseClosed: { by, daysSince: 7, newSourceRef: true } }),
        by,
      ).toBe("cannot_decide");
    }
    expect(opportunityGo({ ...opportunity, caseEverCarded: true })).toBe("cannot_decide");
  });

  it("a client's proposal cannot decide", () => {
    expect(opportunityGo({ ...opportunity, proposedByClass: "client" })).toBe("cannot_decide");
    // A gap flag the system proposes, back after the owner declined it, is the owner's card.
    expect(opportunityGo({ ...opportunity, proposedByClass: "system" })).toBe("cannot_decide");
  });

  it("a client's proposal its proposer staked a bet on goes as the agent's go, on read-only work alone", () => {
    const betted = { ...opportunity, proposedByClass: "client", bet: true } as const;
    expect(opportunityGo(betted)).toEqual({ output: "go", reason: "agent_bet", intent: INTENT });
    // A bet asks no owner-backed source, as a task's go asks none, but nothing tainted or flagged.
    expect(opportunityGo({ ...betted, basis: [inbound] })).toMatchObject({ output: "go", reason: "agent_bet" });
    expect(opportunityGo({ ...betted, basis: [{ ...inbound, flagged: true }] })).toBe("cannot_decide");
    expect(opportunityGo({ ...betted, basis: [{ ...sent, tainted: true }] })).toBe("cannot_decide");
    // Work about the owner is open to a bet, as a task about the owner is; a hypothesis about the owner never is.
    expect(opportunityGo({ ...betted, aboutOwner: true })).toMatchObject({ output: "go", reason: "agent_bet" });
    expect(opportunityGo({ ...betted, restsOnOwnerHypothesis: true })).toBe("cannot_decide");
    // An intent whose mode is owner_decides still authorizes the kind for an agent's bet.
    const owner = { id: INTENT2, mode: "owner_decides", open: 0, maxOpen: 3, activeClients: 1 } as const;
    expect(opportunityGo({ ...betted, intents: [owner] })).toEqual({
      output: "go",
      reason: "agent_bet",
      intent: INTENT2,
    });
    expect(opportunityGo({ ...betted, intents: [] })).toBe("cannot_decide");
    expect(opportunityGo({ ...betted, intents: [{ ...owner, activeClients: 0 }] })).toBe("cannot_decide");
    // Never work that drafts or sends, nor an owner_question.
    for (const kind of ["follow_up", "reply", "introduction", "owner_question"] as const)
      expect(opportunityGo({ ...betted, kind }), kind).toBe("cannot_decide");
    // The owner's earlier no on the case, a veto, a card waiting or ever raised on it, all outrank a bet.
    expect(opportunityGo({ ...betted, vetoed: true })).toEqual({ output: "no_go", reason: "vetoed" });
    expect(
      opportunityGo({
        ...betted,
        caseEverCarded: true,
        caseClosed: { by: "owner", daysSince: 2, newSourceRef: false },
      }),
    ).toEqual({ output: "no_go", reason: "owner_declined" });
    expect(opportunityGo({ ...betted, caseEverCarded: true })).toBe("cannot_decide");
    expect(opportunityGo({ ...betted, cardPending: true })).toBe("cannot_decide");
    // At its intent's max_open it waits, as any go does.
    expect(opportunityGo({ ...betted, intents: [{ ...owner, open: 3 }] })).toEqual({
      output: "later",
      reason: "max_open",
      intent: INTENT2,
    });
    // A bet is a client's alone: a run's or the system's proposal is decided as before.
    expect(opportunityGo({ ...opportunity, proposedByClass: "system", bet: true })).toBe("cannot_decide");
    expect(opportunityGo({ ...opportunity, bet: true })).toEqual({ output: "go", reason: "intent", intent: INTENT });
  });

  it("about the owner cannot decide", () => {
    expect(opportunityGo({ ...opportunity, aboutOwner: true })).toBe("cannot_decide");
    expect(opportunityGo({ ...opportunity, restsOnOwnerHypothesis: true })).toBe("cannot_decide");
  });

  it("a follow_up and a reply cannot decide, whatever the intent", () => {
    for (const kind of ["follow_up", "reply"] as const)
      expect(opportunityGo({ ...opportunity, kind }), kind).toBe("cannot_decide");
    for (const kind of ["investigate", "goal_step", "life_admin"] as const)
      expect(opportunityGo({ ...opportunity, kind }), kind).toMatchObject({ output: "go" });
  });

  it("no intent, or any intent whose mode is owner_decides, cannot decide", () => {
    expect(opportunityGo({ ...opportunity, intents: [] })).toBe("cannot_decide");
    const owner = { id: INTENT2, mode: "owner_decides", open: 0, maxOpen: 3, activeClients: 1 } as const;
    expect(opportunityGo({ ...opportunity, intents: [...opportunity.intents, owner] })).toBe("cannot_decide");
  });

  it("an intent that lists no active client cannot decide", () => {
    expect(
      opportunityGo({
        ...opportunity,
        intents: [{ id: INTENT, mode: "policy_decides", open: 0, maxOpen: 3, activeClients: 0 }],
      }),
    ).toBe("cannot_decide");
  });

  it("an untrusted basis cannot decide", () => {
    expect(opportunityGo({ ...opportunity, basis: [inbound] })).toBe("cannot_decide");
  });

  it("an intent at max_open is later", () => {
    expect(
      opportunityGo({
        ...opportunity,
        intents: [{ id: INTENT, mode: "policy_decides", open: 3, maxOpen: 3, activeClients: 1 }],
      }),
    ).toEqual({ output: "later", reason: "max_open", intent: INTENT });
  });

  it("the first intent is the one that decides", () => {
    const second = { id: INTENT2, mode: "policy_decides", open: 0, maxOpen: 3, activeClients: 1 } as const;
    expect(opportunityGo({ ...opportunity, intents: [...opportunity.intents, second] })).toEqual({
      output: "go",
      reason: "intent",
      intent: INTENT,
    });
  });
});

describe("basisTrusted", () => {
  it("an owner-backed message alone is trusted", () => {
    expect(basisTrusted([sent])).toBe(true);
  });

  it("a basis of agent refs alone is not trusted", () => {
    expect(
      basisTrusted([{ ...sent, refKind: "hypothesis", sourceClass: "agent", ownerBacked: false, threadFp: null }]),
    ).toBe(false);
  });

  it("a source ref that is not owner-backed, alone, is not trusted", () => {
    expect(basisTrusted([inbound])).toBe(false);
  });

  it("a system ref is not a source", () => {
    expect(basisTrusted([{ ...sent, sourceClass: "system", ownerBacked: false }])).toBe(false);
  });

  it("a flagged ref is not trusted", () => {
    expect(basisTrusted([sent, { ...inbound, flagged: true }])).toBe(false);
    expect(basisTrusted([{ ...sent, flagged: true }])).toBe(false);
  });

  it("a tainted ref is not trusted", () => {
    expect(basisTrusted([sent, { ...inbound, tainted: true }])).toBe(false);
  });

  it("an inbound message in the thread of an owner-backed message of the same basis is trusted", () => {
    expect(basisTrusted([sent, inbound])).toBe(true);
  });

  it("an inbound message beside an owner-backed message of another thread is not trusted", () => {
    expect(basisTrusted([sent, { ...inbound, threadFp: "t2" }])).toBe(false);
  });

  it("a system-class message beside an owner-backed message of another thread is not trusted, and in the same thread is", () => {
    const system: BasisFact = { ...inbound, sourceClass: "system" };
    expect(basisTrusted([sent, { ...system, threadFp: "t2" }])).toBe(false);
    expect(basisTrusted([sent, system])).toBe(true);
  });

  it("a message with no thread fingerprint is vouched for by nothing", () => {
    expect(
      basisTrusted([
        { ...sent, threadFp: null },
        { ...inbound, threadFp: null },
      ]),
    ).toBe(false);
  });

  it("the event the opportunity is about needs no thread, and an event it is not about does", () => {
    const event: BasisFact = { ...inbound, refKind: "event", threadFp: null };
    expect(basisTrusted([sent, { ...event, isAbout: true }])).toBe(true);
    expect(basisTrusted([sent, event])).toBe(false);
  });

  it("an owner-backed event vouches for no message", () => {
    const event: BasisFact = { ...sent, refKind: "event", isAbout: true };
    expect(basisTrusted([event])).toBe(true);
    expect(basisTrusted([event, inbound])).toBe(false);
  });

  it("an entity or a goal beside an owner-backed message changes nothing", () => {
    expect(
      basisTrusted([
        sent,
        { ...inbound, refKind: "entity", sourceClass: "derived", threadFp: null },
        { ...inbound, refKind: "goal", sourceClass: "owner", threadFp: null },
      ]),
    ).toBe(true);
  });
});
