import { z } from "zod";
import { Timestamp } from "../ids.ts";
import { Handle, RequestId, ULID_PATTERN } from "./ids.ts";
import { RecordSpendArgs, RecordSpendResult } from "./record-spend.ts";
import { WriteBackArgs, WriteBackResult } from "./signals.ts";
import { UntrustedString } from "./tools-args.ts";

// The box's weekly outcome test: whether a reader with only the read tools can do what the system
// is for. The visible tasks are data here, in general words. As many again are held out: written on
// the box from the owner's own records, kept sealed, and known to no builder, so a gap between the
// two says the visible ones were tuned to.
//
// What a score can show: on the same questions and tools, whether an answer got better or worse,
// and whether what is cited exists. What it cannot: whether an answer is true or whole, or whether
// it was of use to the owner. A model judges what code cannot check, and it knows only what the
// answer and its rubric tell it.

export const OUTCOME_SUITE = "outcome-test@1";
export const OUTCOME_TEST_LIMITS =
  "A model judged what code could not check: a score shows change on the same questions and that cited ids exist, not that an answer is true, whole or useful to the owner.";

const code = z.string().regex(/^[a-z0-9_:]{1,64}$/);
const cap = z.number().int().min(0).max(2);

const OutcomeTestCheck = z.discriminatedUnion("kind", [
  // At least `min` items in the section: does the field exist.
  z.strictObject({ kind: z.literal("section"), section: code, min: z.number().int().positive(), capOnFail: cap }),
  // Every id cited was given by a tool in this run, and at least one is cited.
  z.strictObject({ kind: z.literal("sources_resolve"), capOnFail: cap }),
  // Every date in the section parses and is before today.
  z.strictObject({ kind: z.literal("past"), section: code, capOnFail: cap }),
  // Every date in the section parses and is today or later.
  z.strictObject({ kind: z.literal("upcoming"), section: code, capOnFail: cap }),
  // The tool built for this was called, so the designed route was tried.
  z.strictObject({ kind: z.literal("used"), tools: z.array(code).min(1), capOnFail: cap }),
]);
type OutcomeTestCheck = z.infer<typeof OutcomeTestCheck>;

export const OutcomeTestTask = z.strictObject({
  id: code,
  question: z.string().min(1),
  sections: z.array(code),
  checks: z.array(OutcomeTestCheck),
  // What each score from 0 to 3 means, for this task.
  rubric: z.tuple([z.string(), z.string(), z.string(), z.string()]),
});
export type OutcomeTestTask = z.infer<typeof OutcomeTestTask>;

const SOURCES: OutcomeTestCheck = { kind: "sources_resolve", capOnFail: 1 };

export const OUTCOME_TASKS: readonly OutcomeTestTask[] = [
  {
    id: "who_and_priorities",
    question: "Who is the owner, what is their current work, and what are their top priorities now?",
    sections: ["identity", "current_work", "priorities"],
    checks: [
      { kind: "section", section: "identity", min: 1, capOnFail: 1 },
      { kind: "section", section: "current_work", min: 1, capOnFail: 1 },
      { kind: "section", section: "priorities", min: 1, capOnFail: 2 },
      { kind: "used", tools: ["get_self"], capOnFail: 2 },
      SOURCES,
    ],
    rubric: [
      "Nothing usable.",
      "Identity only, or stale or noisy lines taken as current.",
      "Identity and work are right, priorities are inferred or partial.",
      "Identity, current work and priorities, all current and cited.",
    ],
  },
  {
    id: "recent_and_applying",
    question: "What did the owner do yesterday and today, and what are they applying to or pursuing right now?",
    sections: ["yesterday", "today", "pursuing"],
    checks: [
      { kind: "section", section: "yesterday", min: 1, capOnFail: 2 },
      { kind: "section", section: "today", min: 1, capOnFail: 2 },
      { kind: "section", section: "pursuing", min: 1, capOnFail: 2 },
      { kind: "used", tools: ["get_self", "find_facts"], capOnFail: 2 },
      SOURCES,
    ],
    rubric: [
      "Nothing usable.",
      "Where time went with no content, or nothing on what is being pursued.",
      "Real events or real applications, not both.",
      "What was done, in content, and each thing being pursued with its state.",
    ],
  },
  {
    id: "what_is_owed",
    question: "What does the owner owe people or programs, and what of that is overdue?",
    sections: ["owed", "overdue"],
    checks: [
      { kind: "section", section: "owed", min: 1, capOnFail: 1 },
      { kind: "past", section: "overdue", capOnFail: 1 },
      { kind: "used", tools: ["get_commitments"], capOnFail: 2 },
      SOURCES,
    ],
    rubric: [
      "Nothing, or an empty list taken as nothing owed.",
      "Obligations found only by reading mail, or mixed with remarks that are not obligations.",
      "Real obligations from the designed read, with some due dates.",
      "Every obligation found is real, dated where a date exists, overdue ones compared with today.",
    ],
  },
  {
    id: "next_meeting",
    question: "Prepare the owner for their next meeting with a person: who, when, why, and what happened last time.",
    sections: ["logistics", "purpose", "history"],
    checks: [
      { kind: "section", section: "logistics", min: 1, capOnFail: 1 },
      { kind: "upcoming", section: "logistics", capOnFail: 1 },
      { kind: "section", section: "purpose", min: 1, capOnFail: 2 },
      { kind: "section", section: "history", min: 1, capOnFail: 2 },
      { kind: "used", tools: ["build_context_pack", "get_timeline", "about"], capOnFail: 2 },
      SOURCES,
    ],
    rubric: [
      "Nothing usable.",
      "A time and a name.",
      "Logistics and history, or logistics and purpose.",
      "Logistics, purpose and what was said last time, about the right person.",
    ],
  },
  {
    id: "relationships",
    question:
      "Pick three of the owner's closest relationships. For each, what is its state and what should happen next?",
    sections: ["relationship", "next"],
    checks: [
      { kind: "section", section: "relationship", min: 3, capOnFail: 1 },
      { kind: "section", section: "next", min: 3, capOnFail: 2 },
      { kind: "used", tools: ["about", "get_entity", "get_timeline"], capOnFail: 2 },
      SOURCES,
    ],
    rubric: [
      "Nothing usable.",
      "Names and numbers, closest people blank.",
      "State for three, next steps only inferred.",
      "State and a next step for three who really are close.",
    ],
  },
  {
    id: "introductions",
    question: "For an organization the owner is pursuing, who could introduce them, and by what tie?",
    sections: ["path"],
    checks: [
      { kind: "section", section: "path", min: 1, capOnFail: 1 },
      { kind: "used", tools: ["search", "find_facts", "about"], capOnFail: 2 },
      SOURCES,
    ],
    rubric: [
      "Nothing.",
      "People at that organization by address only.",
      "A direct contact with a real tie.",
      "A named person who could introduce them to someone they do not know, with the tie cited.",
    ],
  },
  {
    id: "projects",
    question: "What are the owner's active projects, the latest decisions on each, and each one's next step?",
    sections: ["project", "decision", "next_step"],
    checks: [
      { kind: "section", section: "project", min: 1, capOnFail: 1 },
      { kind: "section", section: "decision", min: 1, capOnFail: 2 },
      { kind: "section", section: "next_step", min: 1, capOnFail: 2 },
      {
        kind: "used",
        tools: ["get_entity", "get_timeline", "find_facts", "list_projects", "get_project"],
        capOnFail: 2,
      },
      SOURCES,
    ],
    rubric: [
      "Nothing.",
      "Project names with empty records, or state pieced together from mail.",
      "Status for some projects from the project's own record.",
      "Each active project with its decisions and next step from its record.",
    ],
  },
  {
    id: "what_next",
    question: "What should the owner do next, and what could an agent do for them without being asked?",
    sections: ["owner_next", "agent_can"],
    checks: [
      { kind: "section", section: "owner_next", min: 1, capOnFail: 1 },
      { kind: "section", section: "agent_can", min: 1, capOnFail: 2 },
      SOURCES,
    ],
    rubric: [
      "Nothing.",
      "Only prohibitions, or only inference by the reader.",
      "Next steps the records offer, with what an agent may do left unclear.",
      "Next steps the records offer and what an agent may do unasked, each resting on a source.",
    ],
  },
];

// What each held-out question must be about. Classes only: the wording is written on the box, from
// the owner's records, and never leaves it.
export const HELD_OUT_CLASSES = [
  "obligation",
  "meeting",
  "person",
  "project",
  "decision",
  "recent_event",
  "organization",
  "deadline",
] as const;
export const HELD_OUT_COUNT = 8;
const HELD_OUT_RUBRIC: OutcomeTestTask["rubric"] = [
  "Nothing of what the key names.",
  "A little of what the key names, or some of it wrong.",
  "Most of what the key names.",
  "Everything the key names, with its source.",
];
export const heldOutTask = (id: string, question: string): OutcomeTestTask => ({
  id,
  question,
  sections: ["answer"],
  checks: [SOURCES],
  rubric: HELD_OUT_RUBRIC,
});

// The answering model's whole answer, and the judge's.
export const OutcomeTestAnswer = z.strictObject({
  answer: z.string().max(20_000),
  items: z
    .array(
      z.strictObject({
        section: z.string().max(64),
        text: z.string().max(4_000),
        date: z.string().max(40).optional(),
        sources: z.array(z.string().max(128)).max(20),
      }),
    )
    .max(60),
  unknown: z.string().max(4_000).optional(),
});
export type OutcomeTestAnswer = z.infer<typeof OutcomeTestAnswer>;
export const OutcomeTestJudgement = z.strictObject({
  score: z.number().int().min(0).max(3),
  reason: z.string().max(2_000),
});
export type OutcomeTestJudgement = z.infer<typeof OutcomeTestJudgement>;
// A held-out question as its writer gives it: what is asked, and the key only the judge sees.
export const HeldOutQuestion = z.strictObject({
  question: z.string().min(1).max(2_000),
  key: z.array(z.string().min(1).max(500)).min(1).max(10),
});
export type HeldOutQuestion = z.infer<typeof HeldOutQuestion>;

export type CheckResult = { code: string; passed: boolean; capOnFail: number };

const dayOf = (text: string | undefined): string | null => {
  const match = /^\d{4}-\d{2}-\d{2}/.exec(text ?? "");
  return match === null || Number.isNaN(Date.parse(match[0])) ? null : match[0];
};

const checkCode = (check: OutcomeTestCheck): string => {
  if (check.kind === "sources_resolve") return "sources_resolve";
  if (check.kind === "used") return `used:${check.tools[0]}`;
  return `${check.kind}:${check.section}`;
};

// Code's part of the score: nothing here reads the words of an answer, only its shape, its ids and
// its dates.
export function checkAnswer(
  checks: readonly OutcomeTestCheck[],
  value: OutcomeTestAnswer,
  run: { today: string; used: ReadonlySet<string>; seen: (ref: string) => boolean },
): CheckResult[] {
  const results = checks.map((check): CheckResult => {
    const items = "section" in check ? value.items.filter((item) => item.section === check.section) : [];
    const passed = (): boolean => {
      switch (check.kind) {
        case "section":
          return items.length >= check.min;
        case "sources_resolve": {
          const cited = value.items.flatMap((item) => item.sources);
          return cited.length > 0 && cited.every(run.seen);
        }
        case "past":
          return items.every((item) => {
            const day = dayOf(item.date);
            return day !== null && day < run.today;
          });
        case "upcoming":
          return items.every((item) => {
            if (item.date === undefined) return true;
            const day = dayOf(item.date);
            return day !== null && day >= run.today;
          });
        case "used":
          return check.tools.some((tool) => run.used.has(tool));
      }
    };
    return { code: checkCode(check), passed: passed(), capOnFail: check.capOnFail };
  });
  return value.answer.trim() === "" ? [{ code: "answer", passed: false, capOnFail: 0 }, ...results] : results;
}

export const capOf = (results: readonly CheckResult[]): number =>
  Math.min(3, ...results.filter((one) => !one.passed).map((one) => one.capOnFail));

// The judge can lower a score within what code allows, and never raise it past. A cap of 0 needs no
// judge; anything else with no judgement has no score.
export const finalScore = (allowed: number, judge: number | null): number | null => {
  if (allowed === 0) return 0;
  return judge === null ? null : Math.min(allowed, judge);
};

// The agent API's three tools for it. Each names no label, client or destination.
const OutcomeRunId = z
  .string()
  .regex(new RegExp(`^otr_${ULID_PATTERN}$`))
  .brand<"OutcomeRunId">();
const HeldOutId = z
  .string()
  .regex(new RegExp(`^hoq_${ULID_PATTERN}$`))
  .brand<"HeldOutId">();

const modelId = z.string().min(1).max(128);

export const StartOutcomeTestArgs = z.strictObject({
  suite: z.literal(OUTCOME_SUITE),
  // How many tasks it means to ask, so a run cut short shows as one.
  tasks: z.number().int().min(1).max(64),
  answerModel: modelId,
  judgeModel: modelId,
  requestId: RequestId,
});
export type StartOutcomeTestArgs = z.infer<typeof StartOutcomeTestArgs>;
export const StartOutcomeTestResult = z.discriminatedUnion("go", [
  z.strictObject({
    go: z.literal(true),
    run: OutcomeRunId.or(Handle),
    at: Timestamp,
    heldOut: z.array(
      z.strictObject({ id: HeldOutId.or(Handle), class: z.string(), question: UntrustedString, key: UntrustedString }),
    ),
  }),
  z.strictObject({ go: z.literal(false), code: z.enum(["not_due", "budget", "killed"]) }),
]);
export type StartOutcomeTestResult = z.infer<typeof StartOutcomeTestResult>;

export const RecordHeldOutQuestionArgs = z.strictObject({
  class: z.enum(HELD_OUT_CLASSES),
  question: HeldOutQuestion.shape.question,
  key: z.string().min(1).max(6_000),
  requestId: RequestId,
});
export type RecordHeldOutQuestionArgs = z.infer<typeof RecordHeldOutQuestionArgs>;
export const RecordHeldOutQuestionResult = z.strictObject({ id: HeldOutId.or(Handle) });
export type RecordHeldOutQuestionResult = z.infer<typeof RecordHeldOutQuestionResult>;

export const RecordOutcomeTaskArgs = z.strictObject({
  run: OutcomeRunId.or(Handle),
  // A visible task's code, or a held-out question's id.
  task: code.or(HeldOutId).or(Handle),
  heldOut: z.boolean(),
  score: z.number().int().min(0).max(3).nullable(),
  codeCap: z.number().int().min(0).max(3),
  judgeScore: z.number().int().min(0).max(3).nullable(),
  // The answering and judging models that replied, so the store can refuse a judge marking itself.
  answerModel: modelId.nullable(),
  judgeModel: modelId.nullable(),
  failed: z.array(code).max(32),
  toolCalls: z.number().int().nonnegative(),
  costMicroUsd: z.number().int().nonnegative(),
  answer: z.string().max(200_000),
  scoring: z.string().max(20_000),
  requestId: RequestId,
});
export type RecordOutcomeTaskArgs = z.infer<typeof RecordOutcomeTaskArgs>;
export const RecordOutcomeTaskResult = z.strictObject({ recorded: z.boolean() });
export type RecordOutcomeTaskResult = z.infer<typeof RecordOutcomeTaskResult>;

// What an agent loop on the box calls beyond the read tools, for the work tools' maps.
export const LOOP_TOOL_ARGS = {
  write_back: WriteBackArgs,
  record_spend: RecordSpendArgs,
  start_outcome_test: StartOutcomeTestArgs,
  record_held_out_question: RecordHeldOutQuestionArgs,
  record_outcome_task: RecordOutcomeTaskArgs,
};
export const LOOP_TOOL_RESULTS = {
  write_back: WriteBackResult,
  record_spend: RecordSpendResult,
  start_outcome_test: StartOutcomeTestResult,
  record_held_out_question: RecordHeldOutQuestionResult,
  record_outcome_task: RecordOutcomeTaskResult,
};
