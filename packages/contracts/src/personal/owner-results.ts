import { z } from "zod";
import { Timestamp } from "../ids.ts";
import { CardLine } from "./card-line.ts";
import { ClientName, MoveId, OpportunityId } from "./ids.ts";
import { OpportunityKind } from "./opportunity-words.ts";
import { ResultOutcome } from "./owner-dashboard.ts";
import { OwnerWorkItem } from "./owner-reads.ts";
import { OWNER_PAGE_MOST, OwnerCursor } from "./owner-reads-paging.ts";
import { UntrustedString } from "./tools-args.ts";
import type { MoveStatus } from "./work.ts";

// Code derives both from the stored lines and the move's status, never a model. `found`: the move
// reported done with a "found" line; `stopped`: it failed, or reported done with nothing found;
// `blocked`: it reported blocked (ResultOutcome, in owner-reads.ts, which agentActivity's finished work
// carries too). The headline is the first line of the agent's "found" words, cut at a word boundary to
// about HEADLINE_CHARS, null when there are none; it is served inside { untrusted }, being the agent's
// words, under the label of the lines it is cut from.
export const HEADLINE_CHARS = 90;
const headline = UntrustedString.nullable();

// The agent's words after the result's "found" heading (card-kinds-outcome.ts writes the heading as a
// code line, then the words as an agent's line).
// What was found: the agent's words under the "found" heading (a report's summary), else under
// "deliverable" (what report_move delivers when the report has no summary).
const wordsUnder = (lines: readonly CardLine[], code: string): string | null => {
  const at = lines.findIndex(
    (line) =>
      line.from === "code" && line.key === "heading" && line.value?.[0]?.kind === "code" && line.value[0].code === code,
  );
  const words = at < 0 ? undefined : lines[at + 1];
  return words === undefined || words.from !== "agent" ? null : words.text;
};
const foundWords = (lines: readonly CardLine[]): string | null =>
  wordsUnder(lines, "found") ?? wordsUnder(lines, "deliverable");

// The first line of what was found, whitespace folded, cut at the last space before HEADLINE_CHARS
// (or at HEADLINE_CHARS when no space falls in its second half) and marked cut with an ellipsis.
export function resultHeadline(lines: readonly CardLine[]): string | null {
  const first = foundWords(lines)
    ?.split(/\r?\n/)
    .find((one) => one.trim() !== "");
  if (first === undefined) return null;
  const chars = [...first.replace(/\s+/g, " ").trim()];
  if (chars.length <= HEADLINE_CHARS) return chars.join("");
  const cut = chars.slice(0, HEADLINE_CHARS);
  const space = cut.lastIndexOf(" ");
  const kept = (space >= HEADLINE_CHARS / 2 ? cut.slice(0, space) : cut).join("").replace(/[\s,;:.-]+$/, "");
  return `${kept}…`;
}

// How a finished move ended, from its status and its lines.
export function resultOutcome(status: MoveStatus | null, lines: readonly CardLine[]): ResultOutcome {
  if (status === "blocked") return "blocked";
  return status === "done" && resultHeadline(lines) !== null ? "found" : "stopped";
}

// Each is the move that reported, when, its lines as an outcome card's (card-kinds-outcome.ts: what was
// asked and by whom, what was found, its parts and its sources by name), and the owner's judgment of it.
export const OwnerResult = z.strictObject({
  move: MoveId,
  reportedAt: Timestamp,
  lines: z.array(CardLine),
  judged: z.enum(["keep", "not_useful"]).nullable(),
  // Always served; optional so a result written before them still parses.
  outcome: ResultOutcome.optional(),
  headline: headline.optional(),
});
export type OwnerResult = z.infer<typeof OwnerResult>;

// Each says what was made in code's words: the task's kind, what it is about (as a work item's `about`),
// the agent whose move finished it and when; and its outcome and headline, the headline marked as the
// agent's.
export const SHELF_MOST = 20;
export const ShelfLine = z.strictObject({
  move: MoveId,
  opportunity: OpportunityId,
  kind: OpportunityKind,
  agent: ClientName.nullable(),
  about: OwnerWorkItem.shape.about.unwrap().unwrap(),
  doneAt: Timestamp,
  // As a result's: always served, optional so an older line still parses. The headline is the one
  // agent's words a line carries, inside { untrusted }.
  outcome: ResultOutcome.optional(),
  headline: headline.optional(),
});
export type ShelfLine = z.infer<typeof ShelfLine>;

// On the first page only: `thisWeek`, this week's few results to judge, never a queue; and `unopened`, the
// shelf's lines.
export const OwnerResults = z.strictObject({
  results: z.array(OwnerResult).max(OWNER_PAGE_MOST),
  next: OwnerCursor.nullable(),
  thisWeek: z.array(OwnerResult).max(3).optional(),
  unopened: z.array(ShelfLine).max(SHELF_MOST).optional(),
});
export type OwnerResults = z.infer<typeof OwnerResults>;

export const OpenResultArgs = z.strictObject({ move: MoveId });
export type OpenResultArgs = z.infer<typeof OpenResultArgs>;
