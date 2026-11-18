// A card's answers in words: what it offers, what each did, and which take a reason.

import { capital, type NEVER_USE, wordsOf } from "./words.ts";

// What each answer a card offers says, and says done (as its toast leads with it: one past-tense verb per
// action, everywhere, never the button's own words, "Dismiss:", "No:"). An answer the map does not hold
// reads as its code in words.
const ANSWERS: Readonly<Record<string, { label: string; done: string }>> = {
  acknowledge: { label: "Seen", done: "Marked seen" },
  seen: { label: "Seen", done: "Marked seen" },
  confirm: { label: "Confirm", done: "Confirmed" },
  reject: { label: "Reject", done: "Rejected" },
  skip: { label: "Skip", done: "Skipped" },
  pursue: { label: "Pursue it", done: "Pursued" },
  not_now: { label: "Not now", done: "Put off" },
  no: { label: "No", done: "Declined" },
  go: { label: "Go ahead", done: "Approved" },
  no_go: { label: "No", done: "Declined" },
  later: { label: "Later", done: "Put off" },
  done: { label: "Done", done: "Marked done" },
  snooze: { label: "Remind me tomorrow", done: "Snoozed until tomorrow" },
  dismiss: { label: "Dismiss", done: "Dismissed" },
  same: { label: "Same", done: "Marked the same" },
  different: { label: "Different", done: "Marked different" },
  shared: { label: "Shared by several people", done: "Marked shared" },
  one_person: { label: "One person", done: "Marked one person" },
  accept: { label: "Accept", done: "Accepted" },
  right: { label: "Right", done: "Marked right" },
  wrong: { label: "Wrong", done: "Marked wrong" },
  approve: { label: "Approve", done: "Approved" },
  decline: { label: "Decline", done: "Declined" },
};
const answerOf = (option: string) => (Object.hasOwn(ANSWERS, option) ? ANSWERS[option] : undefined);
export const answerWords = (option: string): string => answerOf(option)?.label ?? wordsOf(option);
export const doneWords = (option: string): string => answerOf(option)?.done ?? capital(wordsOf(option).toLowerCase());
// A card's or a ruling's own button words, said done.
const DONE_LABELS = {
  Done: "Marked done",
  Drop: "Dropped",
  "Done: I told it": "Told it",
  "Keep the cap": "Kept the cap",
  "Keep deciding it myself": "You keep deciding it",
  "Keep only those ignored": "Kept only those ignored",
  "Keep the draft": "Kept the draft",
  "Let the ruling go": "Let the ruling go",
  "No longer true": "Marked no longer true",
  "Not true": "Marked not true",
  "Mark it not true again": "Marked not true again",
  "Mark it no longer true again": "Marked no longer true again",
  "Never use it again": "Never used again",
  // A result's answers, and an about-you card's Delete.
  "Keep it": "Kept",
  "Not useful": "Marked not useful",
  Delete: "Deleted",
} as const;
// A button's words the page says done, each with its own entry, so rewording a button without its past
// tense fails to compile.
export type DoneLabel = keyof typeof DONE_LABELS;
export const doneLabel = (label: DoneLabel): string => DONE_LABELS[label];
// A ruling on a fact, by its button's words.
export type RulingWords = DoneLabel | typeof NEVER_USE.done | "Answer undone";
// The same, of words that may be no button's (a ruling's note, a move): any other reads as written.
export const saidDone = (note: string): string =>
  Object.hasOwn(DONE_LABELS, note) ? DONE_LABELS[note as DoneLabel] : note;
