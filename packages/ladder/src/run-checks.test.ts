import { IdeasOutput, LessonsOutput, type ReasoningAction, ReasoningOutput } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import {
  checkIdeas,
  checkLessons,
  checkRunOutput,
  checkStageOutput,
  REFUSAL_REASONS,
  refusalText,
} from "./run-checks.ts";

// The checks of a run's output, with made-up names and ids. A good planner's output passes; each
// refusal is shown against that output changed in one place.

const GOAL = "gol_01JABCDEFGHJKMNPQRSTVWXYZ0";
const MESSAGE_A = "msg_01JABCDEFGHJKMNPQRSTVWXYZ1";
const MESSAGE_B = "msg_01JABCDEFGHJKMNPQRSTVWXYZ2";
const PERSON = "ent_01JABCDEFGHJKMNPQRSTVWXYZ3";
const HYPOTHESIS = "hyp_01JABCDEFGHJKMNPQRSTVWXYZ4";
const goal = { kind: "goal", id: GOAL } as const;
const request = {
  goals: [
    {
      id: GOAL,
      statement: { untrusted: "Find 5 people in my network who could advise Northwind's move into managed services" },
    },
  ],
};

const hypothesis = {
  do: "investigate",
  kind: "open_loop",
  about: goal,
  summary:
    "You appear to be hiring a sales development rep for May: you told Dana Ortiz so, and asked a job board for a quote.",
  basis: [
    { kind: "message", id: MESSAGE_A },
    { kind: "message", id: MESSAGE_B },
  ],
} as const;
const boards = {
  do: "propose",
  kind: "investigate",
  about: goal,
  hypothesis: 0,
  summary:
    "Compare three job boards and two sales communities for hiring an SDR, by cost, reach and applicant quality, and recommend two.",
  basis: [{ kind: "message", id: MESSAGE_B }],
} as const;
const listing = {
  do: "propose",
  kind: "goal_step",
  about: { kind: "message", id: MESSAGE_A },
  hypothesis: 0,
  summary:
    "Prepare a draft SDR job listing and a five-point screening rubric from the role you described to Dana Ortiz.",
  basis: [{ kind: "message", id: MESSAGE_A }],
} as const;
// What today's run proposed: the goal again, citing only the goal.
const restating = {
  do: "propose",
  kind: "goal_step",
  about: goal,
  summary: "Find 5 people in your network who could advise on Northwind's move into managed services.",
  basis: [{ kind: "goal", id: GOAL }],
} as const;

const output = (...actions: unknown[]): ReasoningOutput => ReasoningOutput.parse({ actions });
const check = (...actions: unknown[]) => checkRunOutput(output(...actions), request);
const with_ = (action: object, change: object): ReasoningAction => ({ ...action, ...change }) as ReasoningAction;

describe("the checks of a run's output", () => {
  it("a planner's output passes: a cited hypothesis and concrete work that follows from it", () => {
    expect(check(hypothesis, boards, listing)).toEqual([]);
    expect(check({ do: "ignore", reason: "nothing_to_do" })).toEqual([]);
    // A proposal with no hypothesis passes when it cites a fact and names its target.
    expect(check(with_(listing, { hypothesis: undefined }))).toEqual([]);
  });

  it("a proposal that restates its goal and names no target is refused", () => {
    expect(check(restating)).toEqual([
      { action: 0, code: "no_citation" },
      { action: 0, code: "restates_goal" },
    ]);
    // Cited, and still the goal again.
    expect(check(hypothesis, with_(restating, { hypothesis: 0 }))).toEqual([{ action: 1, code: "restates_goal" }]);
    // The same words about a person, or naming people the goal does not, name a target.
    expect(
      check(with_(restating, { about: { kind: "entity", id: PERSON }, basis: [{ kind: "entity", id: PERSON }] })),
    ).toEqual([]);
    expect(
      check(
        hypothesis,
        with_(restating, {
          hypothesis: 0,
          summary:
            "Find 5 people in your network who could advise on Northwind's move: start with Dana Ortiz and Omar Pike.",
        }),
      ),
    ).toEqual([]);
    // A goal that names its people: work on them that says what to produce is not the goal again
    // for sharing their names, and the goal's own words, names and all, still are.
    const named = {
      goals: [{ id: GOAL, statement: { untrusted: "Get Dana Ortiz and Lee Park to advise Northwind" } }],
    };
    expect(
      checkRunOutput(
        output(
          with_(listing, {
            about: goal,
            hypothesis: undefined,
            summary: "Prepare a one-page ask for Dana Ortiz and Lee Park to advise Northwind.",
          }),
        ),
        named,
      ),
    ).toEqual([]);
    expect(
      checkRunOutput(
        output(
          with_(listing, {
            about: goal,
            hypothesis: undefined,
            summary: "Get Dana Ortiz and Lee Park to advise Northwind.",
          }),
        ),
        named,
      ),
    ).toEqual([{ action: 0, code: "restates_goal" }]);
    // People found by search and named, not cited by id, are targets.
    expect(
      check(
        hypothesis,
        with_(boards, {
          summary:
            "Ask Dana Ortiz and Omar Pike, found in your network, whether they would advise Northwind's move into managed services.",
        }),
      ),
    ).toEqual([]);
    // A hypothesis that only restates the goal is refused too: its own investigate work would.
    expect(
      check(
        with_(hypothesis, {
          summary: "You want to find 5 people in your network to advise Northwind's move into managed services.",
        }),
      ),
    ).toEqual([{ action: 0, code: "restates_goal" }]);
  });

  it("a hypothesis or a proposal that cites no message, event or person is refused; a proposal may cite its hypothesis instead", () => {
    expect(check(with_(hypothesis, { basis: [{ kind: "goal", id: GOAL }] }))).toEqual([
      { action: 0, code: "no_citation" },
    ]);
    expect(check(with_(listing, { hypothesis: undefined, basis: [{ kind: "goal", id: GOAL }] }))).toEqual([
      { action: 0, code: "no_citation" },
    ]);
    expect(check(hypothesis, with_(listing, { basis: [{ kind: "goal", id: GOAL }] }))).toEqual([]);
    expect(check(with_(listing, { hypothesis: undefined, basis: [{ kind: "hypothesis", id: HYPOTHESIS }] }))).toEqual(
      [],
    );
  });

  it("a hypothesis index must name an earlier investigate action that is not about the owner", () => {
    expect(check(listing)).toEqual([{ action: 0, code: "unknown_hypothesis" }]);
    expect(check(with_(listing, { hypothesis: 1 }), hypothesis)).toEqual([{ action: 0, code: "unknown_hypothesis" }]);
    expect(check(listing, with_(boards, { hypothesis: 0 }))).toEqual([
      { action: 0, code: "unknown_hypothesis" },
      { action: 1, code: "unknown_hypothesis" },
    ]);
    expect(check(with_(hypothesis, { about: { kind: "owner" } }), boards)).toEqual([
      { action: 1, code: "owner_hypothesis" },
    ]);
  });

  it("a question for the owner names the hypothesis it tests", () => {
    const question = {
      do: "propose",
      kind: "owner_question",
      about: { kind: "entity", id: PERSON },
      hypothesis: 0,
      summary: "What do you know about Dana Ortiz, and is she the person you would hire the SDR through?",
      basis: [{ kind: "message", id: MESSAGE_A }],
    } as const;
    expect(check(hypothesis, question)).toEqual([]);
    expect(check(hypothesis, with_(question, { hypothesis: undefined }))).toEqual([
      { action: 1, code: "unknown_hypothesis" },
    ]);
    expect(check(with_(hypothesis, { about: { kind: "owner" } }), question)).toEqual([
      { action: 1, code: "owner_hypothesis" },
    ]);
  });

  it("caps: ten hypotheses a run and ten proposals a hypothesis", () => {
    const eleven = Array.from({ length: 11 }, (_, n) =>
      with_(hypothesis, { about: { kind: "entity", id: `ent_01JABCDEFGHJKMNPQRSTVWX${String(n).padStart(2, "0")}0` } }),
    );
    expect(check(...eleven)).toEqual([{ action: 10, code: "too_many_hypotheses" }]);
    const eleventh = Array.from({ length: 11 }, (_, n) =>
      with_(listing, { about: { kind: "entity", id: `ent_01JABCDEFGHJKMNPQRSTVWX${String(n).padStart(2, "0")}1` } }),
    );
    expect(check(hypothesis, ...eleventh)).toEqual([{ action: 11, code: "too_many_opportunities" }]);
  });

  it("an action that leaves the system is refused as work of a kind that only reads and prepares, and allowed as a follow_up", () => {
    const send = with_(listing, { summary: "Send the SDR listing to Dana Ortiz and the job board." });
    expect(check(hypothesis, send)).toEqual([{ action: 1, code: "external_action" }]);
    for (const summary of [
      "Post the listing on two job boards.",
      "Pay the job board's quote.",
      "Publish the listing.",
    ]) {
      expect(check(hypothesis, with_(listing, { summary })), summary).toEqual([{ action: 1, code: "external_action" }]);
    }
    expect(check(hypothesis, with_(send, { kind: "follow_up" }))).toEqual([]);
  });

  it("two actions on one case are refused, counting the investigate work a hypothesis with no proposal opens", () => {
    expect(
      check(
        hypothesis,
        boards,
        with_(boards, { summary: "Ask two recruiting firms for their SDR placement fees and terms." }),
      ),
    ).toEqual([{ action: 2, code: "same_case" }]);
    // A hypothesis no proposal names opens investigate work on its goal, resting on that
    // hypothesis; an investigate proposal on the same goal resting on none is another case,
    // as it is in the database.
    expect(check(hypothesis, with_(boards, { hypothesis: undefined }))).toEqual([]);
  });

  it("the model is told the indexes and codes, and nothing of what it wrote", () => {
    const text = refusalText(check(restating));
    expect(text).toBe(
      `output refused: action 0 no_citation (${REFUSAL_REASONS.no_citation}); action 0 restates_goal (${REFUSAL_REASONS.restates_goal}). Fix those actions and answer again.`,
    );
    expect(text).not.toContain("Northwind");
  });
});

// Each stage's output, checked by its stage's checks.
describe("the planner split's checks", () => {
  const idea = {
    idea: "Introduce Dana Ortiz to the recruiter you met in March: she is hiring an SDR and he places sales reps.",
    why: "Two people you know solve each other's problem, and an introduction costs you one note.",
    basis: [
      { kind: "entity", id: PERSON },
      { kind: "message", id: MESSAGE_A },
    ],
    confidence: 0.6,
    test: "Ask Dana Ortiz whether she has a recruiter already.",
  } as const;

  it("an idea that cites a message, an event or a person passes; one that cites only a goal or a hypothesis is no_citation", () => {
    expect(checkIdeas(IdeasOutput.parse({ ideas: [idea] }), request)).toEqual([]);
    const goalOnly = { ...idea, basis: [goal] };
    const hypothesisOnly = { ...idea, basis: [{ kind: "hypothesis", id: HYPOTHESIS }] };
    expect(checkIdeas(IdeasOutput.parse({ ideas: [idea, goalOnly, hypothesisOnly] }), request)).toEqual([
      { action: 1, code: "no_citation" },
      { action: 2, code: "no_citation" },
    ]);
  });

  it("an agent record is a citation, never an about: with a goal it passes, alone it is no_citation", () => {
    const record = { kind: "agent_record", id: "rec_01JABCDEFGHJKMNPQRSTVWXYZ3" } as const;
    const withGoal = { ...idea, basis: [goal, record] };
    const recordOnly = { ...idea, basis: [record] };
    expect(checkIdeas(IdeasOutput.parse({ ideas: [withGoal, recordOnly] }), request)).toEqual([
      { action: 1, code: "no_citation" },
    ]);
  });

  it("an idea that is its goal again, about the goal, is restates_goal", () => {
    const restated = {
      ...idea,
      idea: "Find 5 people in your network who could advise Northwind's move into managed services.",
      basis: [goal, { kind: "message", id: MESSAGE_A }],
    };
    expect(checkIdeas(IdeasOutput.parse({ ideas: [restated] }), request)).toEqual([
      { action: 0, code: "restates_goal" },
    ]);
  });

  it("a lesson cites a decided case", () => {
    const lessons = LessonsOutput.parse({
      lessons: [
        { lesson: "Prefers named introductions to research memos.", basis: [{ kind: "hypothesis", id: HYPOTHESIS }] },
        { lesson: "Declines anything that takes a weekend.", basis: [{ kind: "message", id: MESSAGE_A }] },
      ],
    });
    expect(checkLessons(lessons)).toEqual([{ action: 1, code: "no_citation" }]);
  });

  // A lesson may rest on an action its block showed, and on no other decision.
  it("a lesson may cite an action of its block, and never a decision the block did not show", () => {
    const shown = "rul_01JABCDEFGHJKMNPQRSTVWXYZ5";
    const other = "rul_01JABCDEFGHJKMNPQRSTVWXYZ6";
    const lessons = LessonsOutput.parse({
      lessons: [
        { lesson: "Gives research tasks before introductions.", basis: [{ kind: "decision", id: shown }] },
        {
          lesson: "Prefers named introductions.",
          basis: [
            { kind: "hypothesis", id: HYPOTHESIS },
            { kind: "decision", id: other },
          ],
        },
        { lesson: "Declines weekend work.", basis: [{ kind: "decision", id: other }] },
      ],
    });
    expect(checkLessons(lessons, { actions: [{ decision: shown }] })).toEqual([
      { action: 1, code: "no_citation" },
      { action: 2, code: "no_citation" },
    ]);
    // A run shown no actions may cite none.
    expect(checkLessons(lessons)).toEqual([0, 1, 2].map((action) => ({ action, code: "no_citation" })));
  });

  it("a translate run's proposals rest on its idea: no hypothesis index, no investigate or remind, at most ten", () => {
    const question = {
      do: "propose",
      kind: "owner_question",
      about: { kind: "entity", id: PERSON },
      summary: "Do you know who recruits for Dana Ortiz's team?",
      basis: [{ kind: "hypothesis", id: HYPOTHESIS }],
    };
    const draft = {
      do: "propose",
      kind: "follow_up",
      about: { kind: "entity", id: PERSON },
      summary: "Draft a note introducing Dana Ortiz to the recruiter you met in March.",
      basis: [{ kind: "hypothesis", id: HYPOTHESIS }],
    };
    const ok = ReasoningOutput.parse({ actions: [question, draft] });
    expect(checkRunOutput(ok, request, "translate")).toEqual([]);
    // Outside a translate run the question must name a hypothesis of its output.
    expect(checkRunOutput(ok, request)).toEqual([{ action: 0, code: "unknown_hypothesis" }]);
    const wrong = ReasoningOutput.parse({
      actions: [
        hypothesis,
        question,
        draft,
        { ...draft, about: { kind: "message", id: MESSAGE_A } },
        { ...draft, about: { kind: "message", id: MESSAGE_B } },
      ],
    });
    // Up to ten proposals now (no tight limits while the planner is being tried): only the
    // investigate is refused.
    expect(checkRunOutput(wrong, request, "translate")).toEqual([{ action: 0, code: "wrong_stage" }]);
  });

  it("an output of another stage's shape is null, and each shape goes to its stage's checks", () => {
    const ideas = IdeasOutput.parse({ ideas: [idea] });
    const lessons = LessonsOutput.parse({ lessons: [] });
    const ignore = ReasoningOutput.parse({ actions: [{ do: "ignore", reason: "nothing_to_do" }] });
    const actions = ReasoningOutput.parse({ actions: [hypothesis, boards] });
    expect(checkStageOutput("ideas", ideas, request)).toEqual([]);
    expect(checkStageOutput("lessons", lessons, request)).toEqual([]);
    expect(checkStageOutput(null, actions, request)).toEqual([]);
    // An ignore alone is every stage's.
    for (const stage of ["ideas", "translate", "lessons", null] as const)
      expect(checkStageOutput(stage, ignore, request), String(stage)).toEqual([]);
    for (const [stage, output] of [
      ["translate", ideas],
      ["ideas", lessons],
      ["ideas", actions],
      ["lessons", actions],
      [null, ideas],
    ] as const) {
      expect(checkStageOutput(stage, output, request), String(stage)).toBeNull();
    }
  });
});
