import type { KnownCardKind } from "@intelligence/contracts/personal";
import type { Reply } from "./card-shape.ts";

// One row for each card kind the contract's CARD_OPTIONS holds, so a kind with no row fails to compile:
// its group's heading, what it is when no line says, the key its content takes when opened, its rank
// within its group, its answers as plain replies that say what they do (an answer not named keeps the
// page's own words for it, card-words.ts `answerWords`; `done` is the toast's past tense, where the
// answer's own is not enough), where a question code asks came from, in place of "From the system",
// why it is put to the owner, and whether an agent can help answer it. Its question is `QUESTIONS` in
// questions.ts, what its lines do beyond every card's is `KIND_STEPS` in cards.ts.
export type CardKindRow = {
  group: string;
  title: string;
  claim: string;
  rank: number;
  replies: Readonly<Record<string, Reply>>;
  askedFrom?: string;
  whyAsked?: string;
  askable?: true;
};

// A rank for the kinds no order was asked for: within a group, they go last, newest first together.
const UNRANKED = 100;
const YES_KEEP = { label: "Yes, keep it", done: "Kept" };

export const CARD_KINDS: Readonly<Record<KnownCardKind, CardKindRow>> = {
  // About you.
  about_you: {
    group: "About you",
    title: "Something an agent says about you",
    claim: "What was said",
    rank: 0,
    replies: { confirm: YES_KEEP, reject: { label: "No, delete it", done: "Deleted" } },
    askable: true,
  },
  owner_question: {
    group: "About you",
    title: "A question for you",
    claim: "Question",
    rank: 1,
    replies: { confirm: { label: "Yes" }, reject: { label: "No" }, skip: { label: "Ask me later" } },
    whyAsked:
      "The planner asks so it works from what is true for you now. Your answer settles it; Skip, under ···, leaves it open for later.",
    askable: true,
  },
  client_preference: {
    group: "About you",
    title: "A preference an agent noted",
    claim: "Preference",
    rank: 2,
    replies: { confirm: { label: "Yes, remember it" }, reject: { label: "No, forget it", done: "Forgotten" } },
  },
  // To approve: what is the owner's to approve before what an agent only suggests.
  opportunity_decision: {
    group: "To approve",
    title: "Work an agent proposes",
    claim: "Proposal",
    rank: 3,
    replies: {
      go: { label: "Yes, go ahead" },
      no_go: { label: "No, drop it", done: "Dropped" },
      later: { label: "Ask me later" },
    },
    askable: true,
  },
  research_request: {
    group: "To approve",
    title: "An agent asks to search the web",
    claim: "Request",
    rank: 4,
    replies: { approve: { label: "Yes, search" }, decline: { label: "No, don't search" } },
    askedFrom: "An agent asks",
  },
  goal_proposal: {
    group: "To approve",
    title: "A change to your goals",
    claim: "Proposal",
    rank: 5,
    replies: {
      accept: { label: "Yes, change it", done: "Changed" },
      reject: { label: "No, leave it", done: "Left as it was" },
    },
    askable: true,
  },
  draft_waiting: {
    group: "To approve",
    title: "A draft waits to be sent",
    claim: "Draft",
    rank: 6,
    replies: { reject: { label: "No, discard it", done: "Discarded" } },
  },
  idea: {
    group: "To approve",
    title: "An idea from the planner",
    claim: "Idea",
    rank: 7,
    replies: { pursue: { label: "Yes, pursue it" }, not_now: { label: "Not now" }, no: { label: "No" } },
    askable: true,
  },
  tier_proposal: {
    group: "To approve",
    title: "Set this tier for the others like them?",
    claim: "Proposal",
    rank: 8,
    replies: {
      confirm: { label: "Yes, move them", done: "Moved" },
      reject: { label: "No, leave them", done: "Left as they were" },
    },
  },
  time_effort: {
    group: "To approve",
    title: "Is this a project of its own?",
    claim: "Proposal",
    rank: 9,
    replies: {
      confirm: { label: "Yes, make it a project", done: "Made a project" },
      reject: { label: "No, leave it", done: "Left unfiled" },
    },
  },
  // Neither answer of these two grants or lifts anything: the command on the card does, in the terminal.
  grant_lift_suggestion: {
    group: "To approve",
    title: "Ask about an agent's quotes again?",
    claim: "Suggestion",
    rank: 10,
    replies: {
      confirm: { label: "Yes, I'll run the command", done: "Run the command in the terminal" },
      reject: { label: "No, keep it on", done: "Not suggested again for a month" },
    },
  },
  grant_suggestion: {
    group: "To approve",
    title: "Keep an agent's quotes without asking?",
    claim: "Suggestion",
    rank: 11,
    replies: {
      confirm: { label: "Yes, I'll run the command", done: "Run the command in the terminal" },
      reject: { label: "No, keep asking me", done: "Not suggested again for a month" },
    },
  },
  // Facts to check.
  same_person_batch: {
    group: "Facts to check",
    title: "Pairs your agents could not settle",
    claim: "Question",
    rank: 12,
    replies: {
      all_same: { label: "Yes, each is one person" },
      all_different: { label: "No, each is two people" },
      leave: { label: "Leave them, ask only if something changes" },
    },
    askedFrom: "From your contacts, mail and your agents",
    askable: true,
  },
  question_rule: {
    group: "Facts to check",
    title: "A rule from your answers",
    claim: "Question",
    rank: 13,
    replies: {
      confirm: { label: "Yes, make it a rule", done: "Rule set" },
      decline: { label: "No, keep asking", done: "Kept" },
    },
    askedFrom: "From your own answers",
  },
  same_person: {
    group: "Facts to check",
    title: "Are these the same person?",
    claim: "Question",
    rank: 14,
    replies: { same: { label: "Yes, one person" }, different: { label: "No, two people" } },
    askedFrom: "From your contacts and mail",
    askable: true,
  },
  shared_address: {
    group: "Facts to check",
    title: "Is this address shared by more than one person?",
    claim: "Question",
    rank: 15,
    replies: { shared: { label: "Yes, shared" }, one_person: { label: "No, one person" } },
    askedFrom: "From your contacts and mail",
    askable: true,
  },
  same_fact: {
    group: "Facts to check",
    title: "Do these two say the same thing?",
    claim: "Question",
    rank: 16,
    replies: { same: { label: "Yes, one fact" }, different: { label: "No, two facts" }, skip: { label: "Not sure" } },
    askedFrom: "Two statements from your sources",
    askable: true,
  },
  agent_claim: {
    group: "Facts to check",
    title: "A fact an agent reported",
    claim: "What was said",
    rank: 17,
    replies: { confirm: { label: "Yes, that's right" }, reject: { label: "No, not true", done: "Marked not true" } },
    askable: true,
  },
  relation_audit: {
    group: "Facts to check",
    title: "Do these two statements relate as the system thinks?",
    claim: "Question",
    rank: 18,
    replies: { right: { label: "Yes" }, wrong: { label: "No" }, skip: { label: "Not sure" } },
    askedFrom: "A check on how the system reads your facts",
    askable: true,
  },
  lesson: {
    group: "Facts to check",
    title: "A lesson the planner drew",
    claim: "Lesson",
    rank: 19,
    replies: { confirm: { label: "Yes, keep it", done: "Kept" }, reject: { label: "No, drop it", done: "Dropped" } },
    whyAsked:
      "The planner drew this from how your earlier answers went. Confirmed, it shapes its next runs; rejected, it is dropped.",
  },
  // Work to check, and reminders.
  outcome: {
    group: "Work to check",
    title: "What an agent found",
    claim: "Finding",
    rank: UNRANKED,
    replies: {},
    askable: true,
  },
  reminder: {
    group: "Reminders",
    title: "A reminder",
    claim: "Reminder",
    rank: UNRANKED,
    replies: {
      done: { label: "Yes, it's done" },
      snooze: { label: "Remind me tomorrow" },
      dismiss: { label: "No longer needed" },
    },
  },
  // Notices: what went wrong on the box first.
  box_health: {
    group: "Notices",
    title: "Something on the box needs a look",
    claim: "Notice",
    rank: 20,
    replies: { seen: { label: "Mark it seen", done: "Marked seen" } },
  },
  notice: {
    group: "Notices",
    title: "A notice from the system",
    claim: "Notice",
    rank: UNRANKED,
    replies: { acknowledge: { label: "Mark it seen" }, seen: { label: "Mark it seen" } },
  },
  ignore_narrowed: {
    group: "Notices",
    title: "One of your ignores now covers fewer addresses",
    claim: "Notice",
    rank: UNRANKED,
    replies: {},
  },
  ruling_carry: {
    group: "Notices",
    title: "A ruling of yours needs a new home",
    claim: "Notice",
    rank: UNRANKED,
    replies: {},
  },
  calibration_drift: {
    group: "Notices",
    title: "The planner's predictions have drifted",
    claim: "Notice",
    rank: UNRANKED,
    replies: {},
  },
  stale_restatement: {
    group: "Notices",
    title: "An agent keeps repeating something out of date",
    claim: "Notice",
    rank: UNRANKED,
    replies: {},
  },
};

// A kind's row; a kind the page was not built with has none.
export const cardKindRow = (kind: string): CardKindRow | undefined =>
  Object.hasOwn(CARD_KINDS, kind) ? CARD_KINDS[kind as KnownCardKind] : undefined;
export const kindRank = (kind: string): number => cardKindRow(kind)?.rank ?? UNRANKED;
