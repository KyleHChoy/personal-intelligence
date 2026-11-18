import { z } from "zod";
import { Timestamp } from "../ids.ts";
import { CardId, EventId, OpportunityId } from "./ids.ts";
import { OpenItem, OWNER_OPEN_ITEMS_MOST } from "./open-items.ts";
import { OwedVerb } from "./owed-verb.ts";
import { UntrustedString } from "./tools-args.ts";
import { MeetingView } from "./tools-views.ts";

// The shapes the owner's page reads beyond the store's own: what the owner owes by its verb, a goal's
// next step, how a finished task ended, and a meeting's call and calendar links.

// `rest` is null where the wording is held. Set only on what the owner owes (a commitment
// `owed_by_owner`, an open item the owner acts on), absent on the rest; optional so an older answer
// still parses.
export const owedFields = { verb: OwedVerb.optional(), rest: UntrustedString.nullable().optional() };

// The open items as the owner's page reads them (open-items.ts), each with its verb as above.
export const OwnerOpenItem = OpenItem.extend(owedFields);
export type OwnerOpenItem = z.infer<typeof OwnerOpenItem>;
export const OwnerOpenItems = z.strictObject({
  items: z.array(OwnerOpenItem).max(OWNER_OPEN_ITEMS_MOST),
  more: z.boolean(),
});
export type OwnerOpenItems = z.infer<typeof OwnerOpenItems>;

// `proposals`: the cards waiting on the owner whose target is a change proposed to this goal or a
// piece of its work, oldest first, as `listPending` lists them. `next`: the goal's next step, the
// first of: a waiting proposal (`card`, when it was raised); work of the goal handed to the owner
// (`handed`, since then); else the goal's open work by the soonest of its due date (`due`) and the
// start, still to come, of the meeting it is about (`event`). Null when none. Both are read within
// the owner's audience, from what `work` and `listPending` already show. Always served; optional so
// an older answer still parses.
export const GoalNextStep = z.strictObject({
  kind: z.enum(["card", "handed", "due", "event"]),
  at: Timestamp,
  opportunity: OpportunityId.nullable(),
  card: CardId.nullable(),
  event: EventId.nullable(),
});
export type GoalNextStep = z.infer<typeof GoalNextStep>;

// How a finished task ended (owner-results.ts `resultOutcome`): found, stopped or blocked.
export const ResultOutcome = z.enum(["found", "stopped", "blocked"]);
export type ResultOutcome = z.infer<typeof ResultOutcome>;

// A meeting as the owner's page reads it: `callLink`, the meeting address from the event's conference data
// or its location, and `inviteLink`, the calendar's own address for the event, each an https URL as the
// source wrote it, inside { untrusted }, never made a link by the server; the page makes one only of an
// address its fixed host list allows (pi-web-client `safe-link.ts`) and shows any other as text. Absent for
// an event with none, and for one stored before the connector kept them until a new revision of it is
// synced. No agent read serves them. The people on it are `participants`, each by entity id within the
// owner's label.
export const OwnerEvent = MeetingView.extend({
  callLink: UntrustedString.optional(),
  inviteLink: UntrustedString.optional(),
});
export type OwnerEvent = z.infer<typeof OwnerEvent>;

// A finished piece of work (owner-reads.ts `AgentActivity`): when it ended, how, and its headline, as a
// result says them; `resultOutcome`, since `outcome` is the work's outcome link. Always served;
// optional so an older answer still parses.
export const finishedFields = {
  doneAt: Timestamp,
  resultOutcome: ResultOutcome.optional(),
  headline: UntrustedString.nullable().optional(),
};
