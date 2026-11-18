import { readFileSync } from "node:fs";
import {
  ExpectedOutcome,
  OPEN_STATUSES,
  OpportunityKind,
  OpportunityStatus,
  OutcomeLink,
  OutcomeRules,
  PersonalWorkArgs,
  WorkWatch,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";

// The expectation, watch and link shapes, the two statuses and the outcome rules.

const ULID = "01J00000000000000000000000";
const accepts = (schema: { safeParse(value: unknown): { success: boolean } }, value: unknown): boolean =>
  schema.safeParse(value).success;
const rules = (): unknown =>
  JSON.parse(readFileSync(new URL("../../../../ontology/outcomes.json", import.meta.url), "utf8"));

describe("an expected outcome", () => {
  it("takes the fields of its type alone", () => {
    expect(accepts(ExpectedOutcome, { type: "answered", success: {} })).toBe(true);
    expect(
      accepts(ExpectedOutcome, {
        subject: { id: `ent_${ULID}` },
        type: "role",
        success: { title: "head of research" },
        horizonDays: 60,
      }),
    ).toBe(true);
    expect(
      accepts(ExpectedOutcome, {
        subject: { name: "Pat Example" },
        type: "relationship",
        success: { relation: "colleague" },
        failure: { relation: "other" },
      }),
    ).toBe(true);
    // A field outside the type's, a type's field on an outcome event, a value of the wrong form, no
    // field at all on a claim type, a failure on an outcome event, an unknown type.
    expect(accepts(ExpectedOutcome, { type: "role", success: { title: "head of research", salary: "high" } })).toBe(
      false,
    );
    expect(accepts(ExpectedOutcome, { type: "answered", success: { title: "head of research" } })).toBe(false);
    expect(accepts(ExpectedOutcome, { type: "relationship", success: { relation: "best_friend_forever" } })).toBe(
      false,
    );
    expect(accepts(ExpectedOutcome, { type: "role", success: {} })).toBe(false);
    expect(accepts(ExpectedOutcome, { type: "answered", success: {}, failure: {} })).toBe(false);
    expect(accepts(ExpectedOutcome, { type: "favourite_colour", success: {} })).toBe(false);
    expect(accepts(ExpectedOutcome, { type: "answered", success: {}, horizonDays: 366 })).toBe(false);
    expect(accepts(ExpectedOutcome, { type: "answered", success: {}, label: ["own"] })).toBe(false);
    // A goal_claim is on the work's own goal, never a subject the agent names.
    expect(accepts(ExpectedOutcome, { type: "goal_claim", success: {} })).toBe(true);
    expect(accepts(ExpectedOutcome, { subject: { id: `ent_${ULID}` }, type: "goal_claim", success: {} })).toBe(false);
  });

  it("is optional on the two propose tools, and at most five", () => {
    const opportunity = {
      kind: "follow_up",
      about: { kind: "entity", id: `ent_${ULID}` },
      summary: "Follow up with Pat on the pilot",
      basis: [{ kind: "entity", id: `ent_${ULID}` }],
      requestId: "req-00000001",
    };
    expect(accepts(PersonalWorkArgs.propose_opportunity, opportunity)).toBe(true);
    expect(
      accepts(PersonalWorkArgs.propose_opportunity, { ...opportunity, expects: [{ type: "answered", success: {} }] }),
    ).toBe(true);
    expect(accepts(PersonalWorkArgs.propose_opportunity, { ...opportunity, expects: [] })).toBe(false);
    expect(
      accepts(PersonalWorkArgs.propose_opportunity, {
        ...opportunity,
        expects: Array.from({ length: 6 }, () => ({ type: "answered", success: {} })),
      }),
    ).toBe(false);
    expect(
      accepts(PersonalWorkArgs.propose_task, {
        ...opportunity,
        kind: "investigate",
        expects: [{ type: "role", success: { title: "chair" } }],
      }),
    ).toBe(true);
    expect(
      accepts(PersonalWorkArgs.propose_task, {
        ...opportunity,
        kind: "investigate",
        expects: [{ type: "role", success: { chair: true } }],
      }),
    ).toBe(false);
  });
});

describe("a watch", () => {
  it("is a message or an entity on plan_move and report_move", () => {
    const plan = { opportunity: `opp_${ULID}`, stage: "investigate", requestId: "req-00000001" };
    expect(
      accepts(PersonalWorkArgs.plan_move, {
        ...plan,
        watch: [
          { kind: "message", id: `msg_${ULID}` },
          { kind: "entity", id: `ent_${ULID}` },
        ],
      }),
    ).toBe(true);
    expect(accepts(PersonalWorkArgs.plan_move, { ...plan, watch: [{ kind: "goal", id: `gol_${ULID}` }] })).toBe(false);
    expect(accepts(PersonalWorkArgs.plan_move, { ...plan, watch: [{ kind: "message", id: `hdl_${ULID}` }] })).toBe(
      false,
    );
    expect(
      accepts(PersonalWorkArgs.report_move, {
        move: `mov_${ULID}`,
        outcome: "done",
        watch: [{ kind: "message", id: `msg_${ULID}` }],
        requestId: "req-00000001",
      }),
    ).toBe(true);
    expect(accepts(WorkWatch, { opportunity: `opp_${ULID}`, kind: "thread", key: "a".repeat(64), until: null })).toBe(
      true,
    );
    expect(accepts(WorkWatch, { opportunity: `opp_${ULID}`, kind: "mailbox", key: "a".repeat(64), until: null })).toBe(
      false,
    );
  });
});

describe("an outcome link", () => {
  const link = {
    opportunity: `opp_${ULID}`,
    goal: null,
    evidence: "b".repeat(64),
    claimKey: null,
    kind: "met",
    path: "watched",
    judge: "rule",
    attribution: "caused",
    passage: null,
    applied: true,
    judgedAt: "2026-10-24T12:00:00.000Z",
  };
  it("names its judge by a closed form", () => {
    expect(accepts(OutcomeLink, link)).toBe(true);
    for (const judge of ["model:example/model-1@personal_outcome_judge@1", `agent:cli_${ULID}`, `owner:rul_${ULID}`])
      expect(accepts(OutcomeLink, { ...link, judge }), judge).toBe(true);
    for (const judge of ["model", "agent:pat", "owner:me", "rule:reply"])
      expect(accepts(OutcomeLink, { ...link, judge }), judge).toBe(false);
    expect(accepts(OutcomeLink, { ...link, kind: "unrelated" })).toBe(false);
    expect(accepts(OutcomeLink, { ...link, passage: { start: 4, end: 4 } })).toBe(false);
    expect(accepts(OutcomeLink, { ...link, compartments: ["own"] })).toBe(false);
  });
});

describe("the statuses and the rules", () => {
  it("outcome_met and outcome_not_met are statuses, and closed", () => {
    for (const status of ["outcome_met", "outcome_not_met"]) {
      expect(accepts(OpportunityStatus, status)).toBe(true);
      expect(OPEN_STATUSES).not.toContain(status);
    }
  });

  it("ontology/outcomes.json parses, with a default or none for every kind but introduction, which has none, and a 90-day grace", () => {
    const parsed = OutcomeRules.parse(rules());
    expect(Object.keys(parsed.defaults).sort()).toEqual(
      OpportunityKind.options.filter((kind) => kind !== "introduction").sort(),
    );
    expect(parsed.graceDays).toBe(90);
    expect(parsed.defaults).toMatchObject({
      follow_up: { type: "answered" },
      reply: { type: "answered" },
      meeting_prep: { type: "meeting_held" },
      goal_step: { type: "goal_claim" },
    });
  });
});
