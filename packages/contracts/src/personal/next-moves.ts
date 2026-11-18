import { z } from "zod";
import { DateOnly, Timestamp } from "../ids.ts";
import { EventId, GoalId, Handle, MessageId, OpportunityId } from "./ids.ts";
import { AGENT_REPORTS_SHOWN, AgentReport, OpenItemSource } from "./open-items.ts";
import { Hex64 } from "./primitives.ts";
import { HeldState } from "./signals.ts";
import { UntrustedString } from "./tools-args.ts";
import { Who } from "./tools-views.ts";

// What holds now, at the top of get_self and context: typed signals with their sources, in a fixed
// order that ranks nothing. Agents decide what to do. Computed by code at each read from what the
// caller's token returned, stored nowhere. Nothing here sends, closes or changes anything.

// How many of each kind a block holds. A kind with no room says `more`. Replies get two because no
// other list shows them; what is late or falling due is on `openItems` beside this. `goal` is kept
// for a client that reads the kind; none is served any more, and agents decide what serves a goal.
export const NextMoveKind = z.enum(["meeting", "overdue", "due_soon", "reply", "goal"]);
export type NextMoveKind = z.infer<typeof NextMoveKind>;
export const NEXT_MOVE_ROOM: Readonly<Record<NextMoveKind, number>> = Object.freeze({
  // A firm one, and a moving one ahead of it.
  meeting: 2,
  overdue: 2,
  due_soon: 1,
  reply: 2,
  goal: 0,
});
export const NEXT_MOVES_MOST = Object.values(NEXT_MOVE_ROOM).reduce((sum, room) => sum + room, 0);
// get_self's `moves`: the same kinds in the same order, each with this much room, so `more` has somewhere to go.
export const NEXT_MOVE_WHOLE_ROOM: Readonly<Record<NextMoveKind, number>> = Object.freeze({
  // And a repeating slot ahead of a one-off.
  meeting: 3,
  overdue: 10,
  due_soon: 10,
  reply: 12,
  goal: 0,
});
const NEXT_MOVES_WHOLE = Object.values(NEXT_MOVE_WHOLE_ROOM).reduce((sum, room) => sum + room, 0);

// `why` is code's own fixed words and numbers, never a source's, so it needs no { untrusted }.
// `what` is the item's, the title's, the subject's or the goal's. `source` is where it can be read: an
// open item's source, or the message, event or goal. `unconfirmed`: an agent reported this and nobody
// has confirmed it. `reported`: what agents' findings say beside it, which moves nothing. `step`: no
// longer served, kept for a client that reads it: agents decide the next step.
// `moving`: a meeting whose own title says it is being moved or called off; the time stays the calendar's.
// `recurring`: a slot that repeats, shown only when no one-off meeting is in reach; it says nothing of whether the owner goes.
// `asks`: a reply whose body, where the caller may read one, or else its subject, asks for an answer.
// `task`: a task looked at this very reply and reported done, for a client that holds list_opportunities and the Work
// view; it is on that tool's closed scope, and may hold a draft. The reply stays.
// `state`: an agent wrote back that it drafted this or that it needs the owner's decision, so a second
// agent does not redo it.
export const NextMove = z.strictObject({
  kind: NextMoveKind,
  what: UntrustedString.nullable(),
  why: z.string().min(1).max(160),
  at: z.union([DateOnly, Timestamp]).nullable(),
  source: z.strictObject({
    kind: z.enum([...OpenItemSource.options, "message", "event", "goal"]),
    id: Hex64.or(EventId).or(MessageId).or(GoalId).or(Handle),
  }),
  who: Who.optional(),
  unconfirmed: z.literal(true).optional(),
  reported: z.array(AgentReport).min(1).max(AGENT_REPORTS_SHOWN).optional(),
  step: UntrustedString.optional(),
  moving: z.literal(true).optional(),
  recurring: z.literal(true).optional(),
  asks: z.literal(true).optional(),
  task: OpportunityId.or(Handle).optional(),
  state: HeldState.optional(),
});
export type NextMove = z.infer<typeof NextMove>;

export const NextMoves = z.strictObject({ moves: z.array(NextMove).max(NEXT_MOVES_WHOLE), more: z.boolean() });
export type NextMoves = z.infer<typeof NextMoves>;
