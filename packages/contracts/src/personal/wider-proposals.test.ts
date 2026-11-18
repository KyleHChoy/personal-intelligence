import { describe, expect, it } from "vitest";
import { ProposeAboutYouArgs, parseProposalBody } from "./about-you.ts";
import { GOAL_CHANGES } from "./goal-proposals.ts";
import { DecideArgs } from "./owner-decide.ts";
import { ClaimRefusal } from "./tool-errors.ts";
import { PersonalWorkTool } from "./tools.ts";
import { CLAIM_REFUSAL_HINTS } from "./tools-claim-refusals.ts";
import { PersonalWorkArgs, PersonalWorkResults, ProposalDetails, Summary } from "./work.ts";

// Wider agent proposals. The shapes alone; the store's and the database's rules are
// their own packages' tests.

const ULID = "01JA0000000000000000000000";
const accepts = (schema: { safeParse(value: unknown): { success: boolean } }, value: unknown): boolean =>
  schema.safeParse(value).success;
const basis = [{ kind: "message", id: `msg_${ULID}` }];
const goal = `gol_${ULID}`;

describe("summaries and details", () => {
  it("a summary is 1 to 600 code points", () => {
    expect(accepts(Summary, "a".repeat(600))).toBe(true);
    expect(accepts(Summary, "é".repeat(600))).toBe(true);
    expect(accepts(Summary, "a".repeat(601))).toBe(false);
    expect(accepts(Summary, "")).toBe(false);
  });

  it("details: whyNow, plan, decisionNeeded, risks, each 1 to 500 code points, at least one, nothing else", () => {
    expect(accepts(ProposalDetails, { whyNow: "The deadline is Friday." })).toBe(true);
    expect(accepts(ProposalDetails, { whyNow: "a", plan: "b", decisionNeeded: "c", risks: "d" })).toBe(true);
    expect(accepts(ProposalDetails, {})).toBe(false);
    expect(accepts(ProposalDetails, { plan: "x".repeat(501) })).toBe(false);
    expect(accepts(ProposalDetails, { plan: "   " })).toBe(false);
    expect(accepts(ProposalDetails, { label: ["own"] })).toBe(false);
  });

  it("propose_opportunity, propose_task and propose_goal take details; nothing else does", () => {
    const details = { whyNow: "He asked twice.", risks: "None known." };
    const task = {
      kind: "investigate",
      about: { kind: "owner" },
      summary: "Read his calendar for next week.",
      basis,
      requestId: "req-00001",
    };
    expect(accepts(PersonalWorkArgs.propose_task, { ...task, details })).toBe(true);
    expect(accepts(PersonalWorkArgs.propose_opportunity, { ...task, kind: "follow_up", details })).toBe(true);
    expect(
      accepts(PersonalWorkArgs.propose_goal, {
        change: "add",
        statement: "Run a half marathon",
        summary: "He said so twice.",
        basis,
        details,
        requestId: "req-00001",
      }),
    ).toBe(true);
    expect(
      accepts(PersonalWorkArgs.propose_hypothesis, {
        kind: "open_loop",
        about: { kind: "owner" },
        summary: "s",
        basis,
        details,
        requestId: "req-00001",
      }),
    ).toBe(false);
  });
});

describe("propose_goal", () => {
  const args = {
    change: "add",
    statement: "Run a half marathon by spring",
    summary: "He named it in two messages.",
    basis,
    requestId: "req-00001",
  };

  it("is a work tool with its five changes", () => {
    expect(PersonalWorkTool.options).toContain("propose_goal");
    expect([...GOAL_CHANGES]).toEqual(["add", "reword", "pause", "done", "drop"]);
  });

  it("add takes a statement and no goal; a change takes its goal, and a statement only to reword", () => {
    expect(accepts(PersonalWorkArgs.propose_goal, args)).toBe(true);
    expect(accepts(PersonalWorkArgs.propose_goal, { ...args, goal })).toBe(false);
    expect(accepts(PersonalWorkArgs.propose_goal, { ...args, statement: undefined })).toBe(false);
    expect(accepts(PersonalWorkArgs.propose_goal, { ...args, change: "reword", goal })).toBe(true);
    expect(accepts(PersonalWorkArgs.propose_goal, { ...args, change: "reword", goal, statement: undefined })).toBe(
      false,
    );
    for (const change of ["pause", "done", "drop"]) {
      expect(accepts(PersonalWorkArgs.propose_goal, { ...args, change, goal, statement: undefined }), change).toBe(
        true,
      );
      expect(accepts(PersonalWorkArgs.propose_goal, { ...args, change, goal }), change).toBe(false);
      expect(accepts(PersonalWorkArgs.propose_goal, { ...args, change, statement: undefined }), change).toBe(false);
    }
  });

  it("a compartment only narrows an added goal's, and only a personal compartment's name", () => {
    expect(accepts(PersonalWorkArgs.propose_goal, { ...args, compartment: "own" })).toBe(true);
    expect(accepts(PersonalWorkArgs.propose_goal, { ...args, compartment: "nowhere" })).toBe(false);
    expect(
      accepts(PersonalWorkArgs.propose_goal, {
        ...args,
        change: "pause",
        goal,
        statement: undefined,
        compartment: "own",
      }),
    ).toBe(false);
  });

  it("names no label, tier, status or writer; a statement is at most 1 000 code points; basis is refs or the owner's quote", () => {
    for (const extra of [{ label: ["own"] }, { status: "active" }, { tier: "task" }, { by: "owner" }])
      expect(accepts(PersonalWorkArgs.propose_goal, { ...args, ...extra })).toBe(false);
    expect(accepts(PersonalWorkArgs.propose_goal, { ...args, statement: "a".repeat(1001) })).toBe(false);
    expect(
      accepts(PersonalWorkArgs.propose_goal, { ...args, basis: [{ kind: "owner_request", quote: "I want to run" }] }),
    ).toBe(true);
    expect(accepts(PersonalWorkArgs.propose_goal, { ...args, basis: [{ kind: "owner_request", quote: "" }] })).toBe(
      false,
    );
    expect(accepts(PersonalWorkArgs.propose_goal, { ...args, basis: [] })).toBe(false);
  });

  it("answers a status and nothing else", () => {
    for (const status of ["proposed", "pending", "rejected", "in_force"])
      expect(accepts(PersonalWorkResults.propose_goal, { status }), status).toBe(true);
    expect(accepts(PersonalWorkResults.propose_goal, { status: "accepted" })).toBe(false);
    expect(accepts(PersonalWorkResults.propose_goal, { status: "proposed", goal })).toBe(false);
  });

  it("pi decide takes a compartment on one card", () => {
    const decide = { cards: [`crd_${ULID}`], answer: "accept", requestId: "req-00001" };
    expect(accepts(DecideArgs, { ...decide, compartment: "own" })).toBe(true);
    expect(
      accepts(DecideArgs, { ...decide, cards: [`crd_${ULID}`, `crd_01JA0000000000000000000001`], compartment: "own" }),
    ).toBe(false);
    expect(accepts(DecideArgs, { ...decide, compartment: "nowhere" })).toBe(false);
  });
});

describe("an interpretation about the owner", () => {
  const fields = { domain: "career", objective: "build a company that compounds" };
  const args = {
    kind: "goal",
    fields,
    scope: "all",
    interpretation: true,
    statement:
      "You want to found a company of your own within two years, one whose value compounds, rather than join a bank.",
    quotes: ["I'd rather build something that compounds than sit in a bank"],
    requestId: "req-00001",
  };

  it("takes a statement of up to 600 code points and 1 to 5 quotes, and no single quote", () => {
    expect(accepts(ProposeAboutYouArgs, args)).toBe(true);
    expect(accepts(ProposeAboutYouArgs, { ...args, statement: "a".repeat(600) })).toBe(true);
    expect(accepts(ProposeAboutYouArgs, { ...args, statement: "a".repeat(601) })).toBe(false);
    expect(accepts(ProposeAboutYouArgs, { ...args, quotes: [] })).toBe(false);
    expect(accepts(ProposeAboutYouArgs, { ...args, quotes: ["a", "b", "c", "d", "e"] })).toBe(true);
    expect(accepts(ProposeAboutYouArgs, { ...args, quotes: ["a", "b", "c", "d", "e", "f"] })).toBe(false);
    expect(accepts(ProposeAboutYouArgs, { ...args, quote: "I'd rather build" })).toBe(false);
  });

  // A statement alone is a valid form; quotes stay an interpretation's.
  it("quotes without interpretation are refused; a statement without it is the statement form", () => {
    expect(accepts(ProposeAboutYouArgs, { ...args, interpretation: undefined })).toBe(false);
    expect(accepts(ProposeAboutYouArgs, { ...args, interpretation: false })).toBe(false);
    expect(accepts(ProposeAboutYouArgs, { ...args, interpretation: undefined, quotes: undefined })).toBe(true);
    expect(accepts(ProposeAboutYouArgs, { statement: args.statement, requestId: args.requestId })).toBe(true);
  });

  it("keeps one kind with its fields", () => {
    expect(accepts(ProposeAboutYouArgs, { ...args, fields: { domain: "career", state: "a founder" } })).toBe(false);
    expect(accepts(ProposeAboutYouArgs, { ...args, kind: undefined })).toBe(false);
  });

  it("its stored body parses back with the statement and the quotes", () => {
    const { requestId: _none, ...body } = args;
    expect(parseProposalBody(JSON.stringify(body))).toEqual(body);
  });

  it("not_owner_words is a claim refusal with a fixed hint", () => {
    expect(ClaimRefusal.options).toContain("not_owner_words");
    expect(CLAIM_REFUSAL_HINTS.not_owner_words.length).toBeGreaterThan(0);
  });
});
