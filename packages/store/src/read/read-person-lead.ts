import type {
  AgentReport,
  CurrentStanding,
  MeetingPointer,
  MeetingView,
  MessageId,
  NextStep,
  PersonLead,
  ThreadPointer,
  TieRelation,
  Tier,
  UntrustedString,
  Who,
} from "@intelligence/contracts/personal";
import { DAY_MS } from "@intelligence/personal-core";
import { stamp } from "../core/db.ts";
import type { Ctx } from "../core/read-ctx.ts";
import { DIRECT_INTERACTION } from "../core/statements.ts";
import { capText } from "./read-self.ts";

// What a person's page leads with: pointers and code's fields, never words
// about what was said. Every part is of rows the caller's token returns.

// The group's (`$1`) latest direct message the token returns, never a held one, found in full first
// by the members' rows and then cut, as FIRST_THREAD finds the first: a cut beside the messages
// would let the planner walk every message in time order. Up to `$2`, so a message with a Date header
// in the future points nowhere yet.
const LAST_THREAD = `
  with mail as materialized (
    select m.id, m.sent_at, m.evidence_id
    from knowledge.messages m
    where m.evidence_id in (
      select i.evidence_id from knowledge.interaction_log i
      where i.entity_id = any($1) and ${DIRECT_INTERACTION})
      and not m.held and m.sent_at <= $2
  )
  select mail.id, mail.sent_at, mail.evidence_id from mail
  order by mail.sent_at desc, mail.id
  limit 1`;

// The latest direct message with each person of `$1`, as LAST_THREAD finds a group's: one attendee's
// row per person, for a meeting's attendees.
export const LAST_THREADS = `
  with mail as materialized (
    select i.entity_id, m.id, m.sent_at, m.evidence_id
    from knowledge.interaction_log i
    join knowledge.messages m on m.evidence_id = i.evidence_id
    where i.entity_id = any($1::text[]) and not m.held and m.sent_at <= $2
      and ${DIRECT_INTERACTION}
  )
  select distinct on (mail.entity_id) mail.entity_id, mail.id, mail.sent_at, mail.evidence_id
  from mail
  order by mail.entity_id, mail.sent_at desc, mail.id`;

export type LastThreadRow = { id: string; sent_at: Date; evidence_id: string };

export const threadPointer = (row: { id: string; sent_at: Date }): ThreadPointer => ({
  message: row.id as MessageId,
  at: stamp(row.sent_at),
});

export async function lastThreadOf(
  ctx: Ctx,
  members: readonly string[],
  now: Date,
): Promise<LastThreadRow | undefined> {
  const [row] = await ctx.run<LastThreadRow>(LAST_THREAD, [[...members], now.toISOString()]);
  return row;
}

// Whether the message `$1` is one the group `$2` sent the owner and got nothing back on: primary, not
// bulk, and with no row of it going out to them, over rows the token returns.
const FROM_THEM = `
  select m.category = 'primary' and not m.bulk and not exists (
      select 1 from knowledge.interaction_log o
      where o.evidence_id = m.evidence_id and o.entity_id = any($2::text[]) and o.direction = 'outbound') as yes
  from knowledge.messages m
  where m.id = $1
  order by m.id`;

export async function lastIsFromThem(ctx: Ctx, message: string, members: readonly string[]): Promise<boolean> {
  const [row] = await ctx.run<{ yes: boolean }>(FROM_THEM, [message, [...members]]);
  return row?.yes === true;
}

// An open commitment between the owner and the person, by its belief.
// `remark`: undated, from a chat, on no project.
export type OpenWithThem = {
  fact: string;
  direction: "owed_by_owner" | "owed_to_owner";
  due: string | null;
  remark?: boolean;
};

// Earliest due first, undated last, then by fact, so one store gives one answer.
const firstDue = (commitments: readonly OpenWithThem[]): OpenWithThem | undefined =>
  [...commitments].sort(
    (a, b) =>
      Number(a.due === null) - Number(b.due === null) ||
      (a.due ?? "").localeCompare(b.due ?? "") ||
      a.fact.localeCompare(b.fact),
  )[0];

// How long a message from them can still be owed an answer, and how long a last contact counts as being
// in touch. Older mail is history, and a silence shorter than this says nothing.
export const UNANSWERED_DAYS = 14;
const QUIET_DAYS = 14;

// Each kind states only what its rows show. A message counts as unanswered only while nothing later passed
// between them, a meeting held since or a two-way chat, and for UNANSWERED_DAYS. `lastTwoWayChat`: the warmth
// line's channels hold a chat, so a two-way time newer than any pointer is read as one. `closeTie`: the owner
// stated they are close. With no two-way chat seen, a silence is what this system can see and says nothing of
// them, and the owner's word outranks it: it reads `channel_unseen`, never `quiet`, with or without a contact
// to date it. `unread`: the owner stated them close, and the warmth line cannot yet say what it saw: no
// silence is read from it at all. An undated chat remark someone owes the owner is no step: nothing in it is
// the owner's to do (`remark`). It stays in the open list until it lapses.
export function nextStepOf(input: {
  commitments: readonly OpenWithThem[];
  nextMeeting: MeetingPointer | null;
  lastThread: ThreadPointer | null;
  lastFromThem: boolean;
  lastMeeting: MeetingPointer | null;
  lastTwoWayAt: string | null;
  lastTwoWayChat?: boolean;
  closeTie?: boolean;
  unread?: boolean;
  now: Date;
}): NextStep | undefined {
  const commitment = (direction: OpenWithThem["direction"]): NextStep | undefined => {
    const one = firstDue(
      input.commitments.filter(
        (row) => row.direction === direction && !(direction === "owed_to_owner" && row.remark === true),
      ),
    );
    return one === undefined
      ? undefined
      : { kind: direction, fact: one.fact, ...(one.due === null ? {} : { due: one.due as NextStep["due"] }) };
  };
  const owed = commitment("owed_by_owner");
  if (owed !== undefined) return owed;
  if (input.nextMeeting !== null)
    return { kind: "meeting", meeting: input.nextMeeting.meeting, at: input.nextMeeting.at };
  const contacts = [input.lastThread?.at, input.lastMeeting?.at, input.lastTwoWayAt ?? undefined].flatMap((at) =>
    at === undefined ? [] : [at],
  );
  const newest = contacts.sort().at(-1);
  const thread = input.lastThread;
  const daysSince = (at: string): number =>
    Math.max(0, Math.floor((input.now.getTime() - new Date(at).getTime()) / DAY_MS));
  if (thread !== null && input.lastFromThem && newest === thread.at && daysSince(thread.at) <= UNANSWERED_DAYS)
    return { kind: "unanswered", message: thread.message, at: thread.at };
  const theirs = commitment("owed_to_owner");
  if (theirs !== undefined) return theirs;
  const unseen = input.closeTie === true && input.lastTwoWayChat !== true;
  if (newest === undefined) return unseen ? { kind: "channel_unseen" } : undefined;
  const days = daysSince(newest);
  if (input.unread === true && days >= QUIET_DAYS) return undefined;
  const via =
    newest === thread?.at
      ? "message"
      : newest === input.lastMeeting?.at
        ? "meeting"
        : input.lastTwoWayChat === true
          ? "chat"
          : "message";
  const silent = unseen ? "channel_unseen" : "quiet";
  return { kind: days < QUIET_DAYS ? "in_touch" : silent, at: newest as NextStep["at"], days, via };
}

type WarmthReading = {
  tier?: Tier | null;
  tierSource?: string | null;
  rebuilding?: boolean;
  stale?: boolean;
  warmth?: number | null;
  lastTwoWayAt?: string | null;
  // Whether the group has chat lines the line was built before: policy.group_chat_newer, asked only of a tie
  // the owner stated close. Absent is not asked.
  chatNewer?: boolean;
};
export const statedClose = (warmth: WarmthReading | undefined, closeness: string | undefined): boolean =>
  closeness === "inner" || (warmth?.tierSource === "owner" && (warmth.tier === "inner" || warmth.tier === "close"));

// Whether a warmth line cannot say no chat was seen: none, being rebuilt, built before the group's last merge
// or lift, or built before chat lines it holds. A line at zero with no two-way contact says the same until
// someone asks, since it also looks that way when it was built before their chats were bound. Asked and not out of
// date, it is the truth: the system has seen no contact.
const warmthUnread = (warmth: WarmthReading | undefined): boolean =>
  warmth === undefined ||
  warmth.rebuilding === true ||
  warmth.stale === true ||
  warmth.chatNewer === true ||
  (warmth.chatNewer === undefined && warmth.warmth === 0 && (warmth.lastTwoWayAt ?? null) === null);

// Whether a group's chat lines are newer than the caller's warmth build, within its clearance.
export async function groupChatNewer(ctx: Ctx, members: readonly string[]): Promise<boolean> {
  const [row] = await ctx.run<{ newer: boolean }>("select policy.group_chat_newer($1::text[]) as newer", [
    [...members],
  ]);
  return row?.newer === true;
}

// Whether the owner stated this tie is close and a warmth line can say what was seen: a tier they set
// among the closest two, or a closeness they confirmed. A tier the score gave says only how much the system
// saw.
export const ownerStatedClose = (warmth: WarmthReading | undefined, closeness: string | undefined): boolean =>
  !warmthUnread(warmth) && statedClose(warmth, closeness);

// The owner stated this tie is close, and the line cannot say what it saw.
export const closeTieUnread = (warmth: WarmthReading | undefined, closeness: string | undefined): boolean =>
  warmthUnread(warmth) && statedClose(warmth, closeness);

// The owner stated this tie is close, and the line holds no contact, however current: the contact may sit on
// another record of this name.
export const closeTieSawNothing = (warmth: WarmthReading | undefined, closeness: string | undefined): boolean =>
  statedClose(warmth, closeness) &&
  (warmth?.rebuilding === true ||
    warmth?.stale === true ||
    ((warmth?.warmth ?? 0) === 0 && (warmth?.lastTwoWayAt ?? null) === null));

export const meetingPointer = (meeting: MeetingView | null): MeetingPointer | null =>
  meeting?.startsAt === null || meeting?.startsAt === undefined ? null : { meeting: meeting.id, at: meeting.startsAt };

const nameOf = (who: Who | null | undefined): string | undefined =>
  who?.name?.untrusted ?? who?.address?.untrusted ?? undefined;
const bounded = (text: string | undefined): UntrustedString | null =>
  text === undefined ? null : { untrusted: capText(text) };

// Pure: the lead, from what the page has read. Its organization is a role's or an affiliation's alone,
// never the one the person's address is on: a mail domain is no employer.
export function personLead(input: {
  tier: Tier | null;
  tie: TieRelation | null;
  openCommitments: number | null;
  lastThread: ThreadPointer | null;
  lastMeeting: MeetingView | null;
  current: CurrentStanding;
  nextStep?: NextStep | undefined;
  reported?: readonly AgentReport[];
  // The last two-way contact the warmth line read, and whether its channels hold a chat.
  lastTwoWay?: { at: string; chat: boolean } | undefined;
}): PersonLead {
  const { role, affiliation } = input.current;
  const lastMeeting = meetingPointer(input.lastMeeting);
  const pointed =
    input.lastThread !== null && (lastMeeting === null || input.lastThread.at >= lastMeeting.at)
      ? "message"
      : lastMeeting !== null
        ? "meeting"
        : null;
  const newestPointer = pointed === "message" ? input.lastThread?.at : lastMeeting?.at;
  const chatAt =
    input.lastTwoWay?.chat === true && (newestPointer === undefined || input.lastTwoWay.at > newestPointer)
      ? input.lastTwoWay.at
      : undefined;
  const lastContact = chatAt === undefined ? pointed : "chat";
  return {
    tier: input.tier,
    tie: input.tie,
    openCommitments: input.openCommitments,
    lastContact,
    lastThread: input.lastThread,
    lastMeeting,
    ...(chatAt === undefined ? {} : { lastChatAt: chatAt as NonNullable<PersonLead["lastChatAt"]> }),
    role: bounded(role?.title?.untrusted),
    organization: bounded(
      nameOf(role?.organization) ??
        role?.organizationName?.untrusted ??
        nameOf(affiliation?.organization) ??
        affiliation?.organizationName?.untrusted,
    ),
    ...(input.nextStep === undefined ? {} : { nextStep: input.nextStep }),
    ...(input.reported === undefined || input.reported.length === 0 ? {} : { reported: [...input.reported] }),
  };
}
