import { z } from "zod";
import { DateOnly, Timestamp } from "../ids.ts";
import { BeliefKind } from "../ontology.ts";
import { GOALS_LISTED, ListedGoal } from "./goals.ts";
import { EventId, Handle, MessageId, OpportunityId } from "./ids.ts";
import { LIFE_DOMAINS, LifeDomain } from "./knowledge-model.ts";
import { NextMoves } from "./next-moves.ts";
import { AGENT_REPORTS_SHOWN, AgentReport, ShownOpenItems } from "./open-items.ts";
import { BeliefLine, SelfSection } from "./packs.ts";
import { WorkNow } from "./packs-work-time.ts";
import { DeclineReason, Hex64 } from "./primitives.ts";
import { UntrustedString } from "./tools-args.ts";
import { ContactCount, MeetingView } from "./tools-views.ts";

// A fingerprint, or for a client in session mode a one-time handle.
const fingerprintOrHandle = Hex64.or(Handle);

// get_self's answer. In this file, not tools-views.ts, since `sections` hold belief lines. Its lines are
// the owner's own beliefs of every kind, which only the owner's own words build; a goal line is what the
// owner wrote in mail, never a goal set with `pi goal add`, which `goals` lists. One belief about the
// owner that closed or expired in the last thirty days, as one line: its kind, its status, the day the
// store recorded that status, and the words of its latest cite the caller can read, null for a held one.
export const SELF_CHANGE_DAYS = 30;
export const SELF_CHANGES = 10;
export const SelfChange = z.strictObject({
  kind: BeliefKind,
  status: z.enum(["closed", "expired"]),
  at: DateOnly,
  what: UntrustedString.nullable(),
});
export type SelfChange = z.infer<typeof SelfChange>;

// What automated mail said: statement-ready, sign-in, shipment and merge notices. They are not life
// facts, so they sit apart from `sections`: the newest first, at most SELF_HOUSEKEEPING_LINES, none
// older than NOTICE_LAPSE_DAYS unless get_self's `history` asks. `more` says one was cut or lapsed.
export const SELF_HOUSEKEEPING_LINES = 5;
export const NOTICE_LAPSE_DAYS = 14;
export const SelfHousekeeping = z.strictObject({
  lines: z.array(BeliefLine).max(SELF_HOUSEKEEPING_LINES),
  more: z.boolean(),
});
export type SelfHousekeeping = z.infer<typeof SelfHousekeeping>;

// One sign of an application of the owner's, computed at read: `applied`, a confirmation; `in_progress`, an
// interview or an update; `offer`; `closed`, turned down or withdrawn; `deadline`, a date to apply by; `stated`, a
// line the owner's beliefs hold. A sign is a subject line or a phrase, never a record that the owner applied. It
// names where it can be read. `reported`: only an agent's finding says it, unconfirmed. `owner_no`: the owner said
// no on a card to a step toward it, in the agent's words. That is all it proves: no to the step, not that they will
// not apply, and a later finding sits beside it. `reason` is the code they gave. `step_handled`: the same card,
// with the reason already_handled. It is no no: it says the step was dealt with.
export const ApplicationState = z.enum([
  "applied",
  "in_progress",
  "offer",
  "closed",
  "deadline",
  "stated",
  "reported",
  "owner_no",
  "step_handled",
]);
export type ApplicationState = z.infer<typeof ApplicationState>;
export const ApplicationSign = z.strictObject({
  state: ApplicationState,
  what: UntrustedString,
  from: UntrustedString.optional(),
  at: Timestamp,
  due: z.union([DateOnly, Timestamp]).optional(),
  message: MessageId.or(Handle).optional(),
  fact: fingerprintOrHandle.optional(),
  event: EventId.or(Handle).optional(),
  opportunity: OpportunityId.or(Handle).optional(),
  reason: DeclineReason.optional(),
  // A `deadline` whose date, in `due` or in its own words, has passed: no longer live.
  passed: z.literal(true).optional(),
  // A finding that names this application, or, on a `reported` sign, that says it. Unconfirmed: the sign's
  // state stays what its source says.
  reported: z.array(AgentReport).min(1).max(AGENT_REPORTS_SHOWN).optional(),
});
export type ApplicationSign = z.infer<typeof ApplicationSign>;
export const APPLICATIONS_SHOWN = 15;

export const SelfView = z.strictObject({
  // The goals the owner set (`list_goals`'s, as the token returns them), first, the one they call
  // their first priority at the head. See `withheld`: empty can mean this client is not shown them.
  goals: z.array(ListedGoal).max(GOALS_LISTED).optional(),
  // The parts this client's registration leaves out, whatever the owner has or has not: `goals` for
  // a client without list_goals and the Work view, `work` for one without the Work view,
  // `applications` for one without the People view, which is shown no mail. A function of the
  // registration alone, so it says nothing of any row (invariant 6).
  withheld: z
    .array(z.enum(["goals", "work", "applications"]))
    .min(1)
    .optional(),
  // The few moves worth doing now.
  next: NextMoves.optional(),
  // What the owner owes and what is overdue, first, at most OPEN_ITEMS_SHOWN.
  openItems: ShownOpenItems.optional(),
  // Asked for one life domain: `sections` holds it alone, and the addresses, the week, the contacts,
  // the open items and the work are left out, because they were not asked for, not because there are none.
  domain: LifeDomain.optional(),
  addresses: z.array(UntrustedString),
  // The owner's time zone, an IANA name, set with `pi owner timezone`; null while unset, when
  // every day boundary is UTC's.
  timeZone: z.string().nullable(),
  // Every event that ends after now and starts within seven days, cancelled ones excluded,
  // earliest first.
  upcoming: z.array(MeetingView),
  // The top twenty by emails30d, then emails90d, then meetings90d.
  contacts: z.array(ContactCount),
  // `sections`, one a domain with anything current. The packs and the planner's self block compile the owner's
  // stated beliefs for themselves; no field holds them here, so no reader can serve them past the wire form's
  // paths and handles.
  sections: z
    .array(SelfSection)
    .max(LIFE_DOMAINS.length + 1)
    .optional(),
  // Absent when no notice is current.
  housekeeping: SelfHousekeeping.optional(),
  // Newest first; every sign is a row the token returned. Left out when a domain other than career is asked.
  applications: z.array(ApplicationSign).max(APPLICATIONS_SHOWN).optional(),
  // At most SELF_CHANGES, newest first.
  changes: z.array(SelfChange).max(SELF_CHANGES),
  // Observed work, for a client with the Self and Work views; else absent.
  work: WorkNow.optional(),
});
export type SelfView = z.infer<typeof SelfView>;
