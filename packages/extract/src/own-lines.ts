import type { OpenedMoment, TriageLane } from "@intelligence/contracts/personal";
import { OWN_LINES_TYPES } from "./lane-versions.ts";
import { ownLineRanges } from "./moments-plan.ts";
import { ownWordMoment } from "./own-word.ts";

export { OWN_LINE_MAX_CHARS } from "./moments-plan.ts";
export { OWN_LINES_PROMPT_ID } from "./own-lines-prompt.ts";

// The own-lines lane: which agent-app moments it asks, and what a day of it may cost. Attribution
// is Lens's mark and code's reading of it: a moment holds no line of the owner's unless a turn says
// so, and nothing a moment's text says makes one.

export const OWN_LINES_TYPE_IDS: readonly string[] = OWN_LINES_TYPES.map((type) => type.id);

// A line this short states no fact alone (triage's MOMENT_DB_MIN_CHARS, by the same reckoning).
const OWN_LINES_MIN_CHARS = 20;

// PI_EXTRACT_OWN_LINES_DAY_USD's default: a day's spend under this prompt past which its moments wait
// for the next day. About 15 dollars a month at the most; `ownLinesCost` and its test size it.
export const OWN_LINES_DAY_MICRO_USD = 500_000;

// A moment an agent-app rule admitted, a chat whose turns hold the owner's word (the same test any
// chat's line passes), not set to a lane by the owner, with at least one such line to send. An `agent`
// turn is the evidence that this Lens separates a user's line from an assistant's in an agent app:
// none sends one today, while a chat-family app outside Lens's own agent list sends `owner` by layout
// under a rule the box marks. So a moment with no `agent` turn is not asked, and one with another
// person in it is no chat with an agent.
export function ownLinesMoment(opened: OpenedMoment, override: TriageLane | undefined): boolean {
  if (!opened.capture.agentApp || override !== undefined || !ownWordMoment(opened)) return false;
  const turns = opened.item.turns ?? [];
  if (!turns.some((turn) => turn.speaker === "agent") || turns.some((turn) => turn.speaker === "participant"))
    return false;
  if (opened.item.participants.length > 0 || opened.capture.facts.participants.length > 0) return false;
  const words = ownLineRanges(opened).reduce(
    (sum, range) => sum + [...opened.item.text.slice(range.from, range.to)].length,
    0,
  );
  return words >= OWN_LINES_MIN_CHARS;
}

// The moment lane's model, Sonnet 5.5, in micro-dollars per token (models' anthropic-turn.ts), at 4
// characters a token as decision records reckon, with an assumed answer of a few claims. An estimate
// for sizing the cap, which reads real spend; nothing is charged by it.
const INPUT_MICRO_USD = 2;
const OUTPUT_MICRO_USD = 10;
const ANSWER_TOKENS = 400;
export const ownLinesCost = (day: { requests: number; requestChars: number }): number =>
  Math.round(day.requests * ((day.requestChars / 4) * INPUT_MICRO_USD + ANSWER_TOKENS * OUTPUT_MICRO_USD));
