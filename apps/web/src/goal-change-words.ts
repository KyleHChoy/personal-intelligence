import { type GoalChange, TARGET_NO_NAME } from "@intelligence/contracts/personal";
import type { Reply } from "./card-shape.ts";
import { told } from "./words.ts";

// What the owner may be asked to change of a goal, whole: its words, the question, the yes and what the
// yes does.
type GoalChangeRow = {
  words: string;
  ask: (goal: string, proposed: string) => string;
  yes: Reply;
  effect: string;
};
export const GOAL_CHANGES: Readonly<Record<GoalChange | "target", GoalChangeRow>> = {
  target: {
    words: "Set who your goal is after",
    ask: (goal, proposed) => {
      const whom = proposed === TARGET_NO_NAME ? "someone you have no name for" : told(proposed);
      return goal === "" ? `Make ${whom} who your goal is after?` : `Is your goal "${goal}" after ${whom}?`;
    },
    yes: { label: "Yes, set it", done: "Set" },
    effect: "Accepting makes this who your goal is after, so its work can look for a way to them.",
  },
  add: {
    words: "Add a goal",
    ask: (_goal, proposed) => `Add this to your goals: ${told(proposed)}?`,
    yes: { label: "Yes, add it", done: "Added" },
    effect: "Accepting adds this as your goal.",
  },
  reword: {
    words: "Reword your goal",
    ask: (goal, proposed) =>
      goal === "" ? `Reword your goal as: ${told(proposed)}?` : `Reword your goal "${goal}" as "${proposed}"?`,
    yes: { label: "Yes, reword it", done: "Reworded" },
    effect: "Accepting gives your goal these words, as your own.",
  },
  pause: {
    words: "Pause your goal",
    ask: (goal) => `Pause your goal${goal === "" ? "" : ` "${goal}"`}?`,
    yes: { label: "Yes, pause it", done: "Paused" },
    effect: "Accepting pauses your goal.",
  },
  done: {
    words: "Mark your goal done",
    ask: (goal) => `Mark your goal${goal === "" ? "" : ` "${goal}"`} done?`,
    yes: { label: "Yes, mark it done", done: "Marked done" },
    effect: "Accepting marks your goal done.",
  },
  drop: {
    words: "Drop your goal",
    ask: (goal) => `Drop your goal${goal === "" ? "" : ` "${goal}"`}?`,
    yes: { label: "Yes, drop it", done: "Dropped" },
    effect: "Accepting drops your goal.",
  },
};
// The row of a change the card's lines named, if it is one.
export const goalChangeOf = (change: string | null | undefined): GoalChangeRow | undefined =>
  change != null && Object.hasOwn(GOAL_CHANGES, change) ? GOAL_CHANGES[change as keyof typeof GOAL_CHANGES] : undefined;
