import {
  ActivityCategory,
  AffiliationRelation,
  type CommitmentItem,
  DeclineReason,
  FactSource,
  FactType,
  GoalChange,
  LearnedItem,
  LifeDomain,
  OpportunityKind,
  OpportunityStatus,
  PreferencePolarity,
  Provenance,
  RelationshipRelation,
  ReportMark,
  SelfStatus,
  Stage,
} from "@intelligence/contracts/personal";
import { expect, it } from "vitest";
import { authorWords, compartmentWords, eventWords, toolsWords, toolWords, triggerWords } from "./agent-words.ts";
import { answerWords, doneWords, saidDone } from "./card-words.ts";
import { dueWords } from "./commitments.tsx";
import {
  ACTIVITY_WORDS,
  AFFILIATION_WORDS,
  BELIEF_STATUS_WORDS,
  DECLINE_REASON_WORDS,
  FACT_TYPE_WORDS,
  LIFE_DOMAIN_WORDS,
  OPPORTUNITY_KIND_WORDS,
  OPPORTUNITY_STATUS_WORDS,
  POLARITY_WORDS,
  PROVENANCE_WORDS,
  RELATIONSHIP_WORDS,
  REPORT_MARK_WORDS,
  SELF_STATUS_WORDS,
  SOURCE_WORDS,
  STAGE_WORDS,
  sourceWords,
} from "./enum-words.ts";
import { sentenceOf } from "./facts.ts";
import { GOAL_CHANGES } from "./goal-change-words.ts";
import { internalsIn } from "./test-support/internals.ts";
import { dayWords, spanWords, whenWords } from "./time-words.ts";
import { factFrom, provenanceOf } from "./words.ts";

// Each map in enum-words.ts covers every value of its contract's enum, so a value the contract adds
// fails here before it reaches the page as a code.
it("holds one map for each enum the page shows, each with every value", () => {
  const pairs: [Record<string, string>, readonly string[]][] = [
    [OPPORTUNITY_KIND_WORDS, OpportunityKind.options],
    [OPPORTUNITY_STATUS_WORDS, OpportunityStatus.options],
    [STAGE_WORDS, Stage.options],
    [REPORT_MARK_WORDS, ReportMark.options],
    [BELIEF_STATUS_WORDS, LearnedItem.shape.status.options],
    [SELF_STATUS_WORDS, SelfStatus.options],
    [PROVENANCE_WORDS, Provenance.options],
    [SOURCE_WORDS, FactSource.options],
    [FACT_TYPE_WORDS, FactType.options],
    [DECLINE_REASON_WORDS, DeclineReason.options],
    [
      Object.fromEntries(Object.entries(GOAL_CHANGES).map(([key, row]) => [key, row.words])),
      [...GoalChange.options, "target"],
    ],
    [LIFE_DOMAIN_WORDS, LifeDomain.options],
    [AFFILIATION_WORDS, AffiliationRelation.options],
    [RELATIONSHIP_WORDS, RelationshipRelation.options],
    [POLARITY_WORDS, PreferencePolarity.options],
    [ACTIVITY_WORDS, ActivityCategory.options],
  ];
  for (const [map, values] of pairs) {
    expect(Object.keys(map).sort()).toEqual([...values].sort());
    expect(internalsIn(Object.values(map))).toEqual([]);
  }
});

// A fact says where it came from by the store's `source`; one that names none is never said to be mail.
it("says a fact's source by its kind, and never mail for a fact that names none", () => {
  expect(sourceWords("messages")).toBe("From messages");
  expect(sourceWords("screen")).toBe("From your screen");
  expect(sourceWords(undefined)).toBe("From another source");
  expect(factFrom({ provenance: "source" })).toBe("From another source");
  expect(factFrom({ tier: "source", provenance: "source", source: "meeting" })).toBe("From a meeting");
  expect(factFrom({ tier: "source", provenance: "source", source: "mail" })).toBe("From mail");
  expect(PROVENANCE_WORDS.source).not.toMatch(/mail/i);
});

// A commitment says its source as a fact does: an iMessage or meeting commitment has no message.
it("says a commitment's source from its own field, and never mail for one that names none", () => {
  const item = (source: FactSource | undefined, message: string | null): CommitmentItem =>
    ({
      belief: { provenance: "source", tier: "source" },
      message,
      ...(source === undefined ? {} : { source }),
    }) as unknown as CommitmentItem;
  expect(provenanceOf(item("messages", null))).toBe("From messages");
  expect(provenanceOf(item("meeting", null))).toBe("From a meeting");
  expect(provenanceOf(item("screen", null))).toBe("From your screen");
  expect(provenanceOf(item("mail", `msg_${"0".repeat(26)}`))).toBe("From mail");
  expect(provenanceOf(item(undefined, null))).toBe("From another source");
});

it("says a time in the owner's own zone, in words, never as ISO or UTC", () => {
  const now = new Date(2026, 9, 29, 15, 0);
  expect(whenWords(new Date(2026, 9, 29, 10, 59), now)).toMatch(/^today 10:59/);
  expect(whenWords(new Date(2026, 9, 28, 18, 12), now)).toMatch(/^yesterday 6:12/);
  expect(whenWords(new Date(2026, 9, 27, 20, 40), now)).toMatch(/^Tue 8:40/);
  expect(whenWords(new Date(2026, 8, 28, 20, 40), now)).toBe("28 Sep");
  // This year's or last: no year inside a year; past a year, its year.
  expect(whenWords(new Date(2025, 11, 2, 20, 40), now)).toBe("2 Dec");
  expect(whenWords(new Date(2025, 8, 28, 20, 40), now)).toBe("28 Sep 2025");
  expect(dayWords(new Date(2026, 9, 27, 9), now)).toBe("Tue");
  expect(dayWords(new Date(2026, 9, 30, 9), now)).toBe("tomorrow");
  expect(whenWords("2026-10-29T14:00:00.000Z", now)).not.toMatch(/T|Z|UTC/);
  expect([spanWords(1), spanWords(4), spanWords(14), spanWords(90)]).toEqual([
    "1 day",
    "4 days",
    "2 weeks",
    "3 months",
  ]);
});

it("finds every kind of internal the page must not show", () => {
  const found = internalsIn([
    "kind: about_you",
    "at 2026-10-28T09:00:00Z",
    `opp_01J${"0".repeat(23)}`,
    "handed_to_owner",
    "By the UTC day",
    "Waiting for your answer",
  ]);
  // Each of the five internals once at least (a code line of a snake_case code is both); plain words never.
  expect(new Set(found.map((one) => one.slice(one.indexOf(": ") + 2)))).toEqual(
    new Set([
      "kind: about_you",
      "at 2026-10-28T09:00:00Z",
      `opp_01J${"0".repeat(23)}`,
      "handed_to_owner",
      "By the UTC day",
    ]),
  );
});

it("says a due day gone by as late, never as a day to come", () => {
  const now = new Date(2026, 9, 29, 10, 58);
  expect(dueWords(new Date(2026, 9, 24), 5, now)).toBe("Last Sat, 5 days late");
  expect(dueWords(new Date(2026, 9, 28), 1, now)).toBe("Yesterday, 1 day late");
  // Late only as the store counts it: a closed one kept on time is not.
  expect(dueWords(new Date(2026, 9, 24), null, now)).toBe("Last Sat");
  expect(dueWords(new Date(2026, 9, 31), null, now)).toBe("Sat");
  expect(dueWords(null, null, now)).toBe("No date given");
});

it("names an agent's tools in plain words and whose sources a compartment holds, never a command or a code", () => {
  expect(toolsWords(["find_messages", "search", "claim_opportunity", "odd_tool"])).toBe(
    "Read what you know: find messages and search. Take work from the board: take work. And: odd tool",
  );
  expect(toolsWords(["find_messages"])).not.toMatch(/pia|_/);
  expect(compartmentWords("employer:riverside-college")).toBe("Your work at Riverside College");
  expect(compartmentWords("employer:riverside-college-released")).toBe("What your work at Riverside College released");
  expect(compartmentWords("school")).toBe("Kept apart as School");
});

it("says what each answer did in the past tense, never the button's words", () => {
  for (const option of [
    "acknowledge",
    "confirm",
    "reject",
    "go",
    "no_go",
    "dismiss",
    "same",
    "different",
    "accept",
    "approve",
    "decline",
    "done",
    "skip",
  ])
    expect(doneWords(option)).not.toBe(answerWords(option));
  expect(doneWords("no_go")).toBe("Declined");
  expect(doneWords("dismiss")).toBe("Dismissed");
  expect(doneWords("acknowledge")).toBe("Marked seen");
});

// A move's start is "Started", never "cleared to start"; each answer that says what it does has
// its past tense.
it("says a move's start as Started, and each answer that says its effect in the past tense", () => {
  expect(eventWords("cleared")).toBe("Started");
  for (const words of ["Keep deciding it myself", "Keep only those ignored", "Keep the draft", "Never use it again"])
    expect(saidDone(words)).not.toBe(words);
});

// An offer the map's links open reads as what was said.
it("an offer to introduce reads as a sentence, offered or suggested", () => {
  expect(sentenceOf("intro_offer", { person: "Theo Marsh", offer: "offered" }, "Ada Fenn")).toBe(
    "Ada Fenn offered to introduce you to Theo Marsh",
  );
  expect(sentenceOf("intro_offer", { person: "Theo Marsh", offer: "suggested" }, "Ada Fenn")).toBe(
    "Ada Fenn suggested you meet Theo Marsh",
  );
});

// The tables a new tool or trigger fails to compile without say what the patterns and maps said.
it("files each tool under its kind of use, and says one with no words by its name", () => {
  expect(toolsWords(["record_test", "get_self", "set_intention", "next_run"])).toBe(
    "Read what you know: read about you. Propose facts and people: record test. Take work from the board: set a reminder. And: next run",
  );
  expect(toolWords("a_tool_this_page_does_not_know")).toBe("a tool this page does not know");
  expect(toolsWords(["a_tool_this_page_does_not_know"])).toBe("It can: a tool this page does not know");
});

it("says a trigger with no words by its code, an author by what it is", () => {
  expect(triggerWords("explore")).toBe("Explore");
  expect(triggerWords("meeting_soon")).toBe("A meeting coming up");
  expect(["owner", "reasoner", "run:run_1", "client:cli_1", "system:pipeline", "worker"].map(authorWords)).toEqual([
    "You",
    "The planner",
    "The planner",
    "An agent",
    "The system",
    "The system",
  ]);
});
