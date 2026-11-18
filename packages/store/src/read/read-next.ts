import type { HeldState, NextMove, NextMoves, OpportunityId } from "@intelligence/contracts/personal";
import { DAY_MS } from "@intelligence/personal-core";
import { autonomyRules } from "@intelligence/personal-core/planner";
import {
  composeNext,
  type Finding,
  meetingsToShow,
  type OwedReply,
  replyAsks,
} from "@intelligence/personal-core/views";
import { stamp } from "../core/db.ts";
import { type Ctx, mergeReads, type ReadSet, readOfRests, sortedRead } from "../core/read-ctx.ts";
import type { Sealed } from "../core/seal.ts";
import { servedOrNone } from "../core/served.ts";
import { servedText } from "./read-fact-rows.ts";
import { groupWho } from "./read-group-who.ts";
import { loadGroups } from "./read-groups.ts";
import { BODIES } from "./read-messages.ts";
import type { OpenRead } from "./read-open-items.ts";
import { boundHead, capText } from "./read-self.ts";
import { MEETING_COLUMNS, type MeetingRow, meetingsOf } from "./read-who.ts";

// What agents wrote back on these sources, the latest of each, as the caller may read it.
export const MARKS_ON = `
  select distinct on (m.ref_id) m.ref_id, m.state, m.created_at
  from ledger.signal_marks m
  where m.ref_id = any($1::text[]) and m.tainted_at is null
  order by m.ref_id, m.created_at desc, m.id desc`;

// A reply the owner owes: the latest message of a thread that a person wrote or the owner sent, not bulk,
// held or failing authentication, from a person the owner has mailed, on a thread the owner wrote in before
// it, with nothing from the owner to that person since. It reads the thread as it stands, so it says nothing of whether a plan on that thread is done: a reply
// closes no open item, and only takes this line away. The newest first, since code then orders by whether each
// asks anything and a scan cut oldest first would drop what was just asked; one more than it keeps, so `more` is true.
export const OWED_REPLIES = `
  select m.id, m.evidence_id, m.sent_at, m.subject_enc, m.compartments,
    (select i.entity_id from knowledge.interaction_log i
     join knowledge.entities e on e.id = i.entity_id and e.kind = 'person'
     where i.evidence_id = m.evidence_id and i.entity_role = 'sender'
     order by i.id limit 1) as entity_id
  from knowledge.messages m
  where m.direction = 'inbound' and not m.held and not m.bulk and coalesce(m.auth, '') <> 'fail'
    and m.thread_fp is not null and m.sent_at >= $1 and m.sent_at <= $2
    and not exists (select 1 from knowledge.messages t
                    where t.thread_fp = m.thread_fp and t.id <> m.id and not t.held
                      and (t.direction = 'outbound' or (not t.bulk and t.auth is distinct from 'fail'))
                      and (t.sent_at > m.sent_at or (t.sent_at = m.sent_at and t.id collate "C" > m.id collate "C")))
    and exists (select 1 from knowledge.messages o
                where o.thread_fp = m.thread_fp and o.direction = 'outbound' and not o.held and o.sent_at < m.sent_at)
    and exists (select 1 from knowledge.interaction_log s
                join knowledge.entities e on e.id = s.entity_id and e.kind = 'person'
                where s.evidence_id = m.evidence_id and s.entity_role = 'sender'
                  and exists (select 1 from knowledge.interaction_log o
                              join knowledge.messages w on w.evidence_id = o.evidence_id and w.direction = 'outbound' and not w.held
                              where o.entity_id = s.entity_id and o.direction = 'outbound' and o.entity_role = 'recipient')
                  and not exists (select 1 from knowledge.interaction_log o
                                  join knowledge.messages w on w.evidence_id = o.evidence_id and w.direction = 'outbound' and not w.held
                                    and w.sent_at > m.sent_at
                                  where o.entity_id = s.entity_id and o.direction = 'outbound' and o.entity_role = 'recipient'))
  order by m.sent_at desc, m.id
  limit $3`;
const OWED_REPLY_SCAN = 12;
const FEED_REPLY_SCAN = 50;
const FEED_ROOM = { meeting: 3, overdue: 50, due_soon: 50, reply: 50, goal: 0 } as const;
// How many of them one read opens to see whether they ask, the newest first. The rest are read by their subject.
const OWED_REPLY_BODIES = 5;

// A task that looked at exactly this message and reported done. Agents cannot send mail, so done may mean a draft is
// ready: the line stays, for a client that can list the task says so and names it, below what no task has looked at.
// Any other client reads the reply as if no task looked. A later message on the
// thread is another message. Failed or withdrawn work looked at nothing, a tainted task's report is not read, and a row
// under a label the caller cannot see is not returned, so it moves nothing.
export const SETTLED_REPLIES = `
  select o.gap_source as message, o.id
  from ledger.opportunities o
  where o.gap_trigger = 'reply_owed' and o.gap_source = any($1::text[]) and o.tainted_at is null
    and (select r.event from ledger.record_events r
         where r.row_kind = 'opportunity' and r.row_id = o.id and r.event not in ('reported', 'outcome_met', 'outcome_not_met')
         order by r.id desc limit 1) = 'done'
  order by o.gap_source, o.id`;

// The next timed meetings with a person at them, not cancelled or declined: meeting_soon's reading of one. More than
// one, since a title is sealed and one that says it is moving must not hide a firm one behind it.
const NEXT_MEETINGS_READ = 5;
export const NEXT_MEETINGS = `
  select ${MEETING_COLUMNS}, d.recurring
  from knowledge.events v
  join knowledge.event_details d on d.event_id = v.id
  where not d.cancelled and not d.all_day and coalesce(d.owner_response, 'accepted') <> 'declined'
    and d.starts_at > $1 and d.starts_at <= $2
    and exists (select 1 from knowledge.event_participants p
                join knowledge.entities e on e.id = p.entity_id and e.kind = 'person'
                where p.event_id = v.id)
  order by d.starts_at, v.id
  limit ${NEXT_MEETINGS_READ}`;
const MEETING_LOOK_AHEAD_DAYS = 7;

type ReplyRow = {
  id: string;
  evidence_id: string;
  sent_at: Date;
  subject_enc: Sealed | null;
  compartments: string[];
  entity_id: string;
};

// The block, and what each move served, by its source's id, for a read log of what `fit` kept.
type NextRead = { value: NextMoves; readOf: (moves: readonly NextMove[]) => ReadSet };

export async function nextMovesOf(
  ctx: Ctx,
  now: Date,
  input: {
    // Mail only for a client shown mail: the People view's, as get_self's applications are.
    mail: boolean;
    // Bodies only for a client that may read a message whole, as read_message serves it.
    bodies: boolean;
    // A task that looked, only for a client that holds list_opportunities and the Work view, which can read of it.
    tasks: boolean;
    open: OpenRead;
    findings: readonly Finding[];
    zone: string | null;
    // Room for every move (get_self's `moves`).
    whole?: boolean;
    // Room for the change feed, which clears what it no longer finds, so it reads far more than any block shows.
    feed?: boolean;
    // Leave out what an agent handled, and mark what one holds. The owner's backtest asks what the
    // sources alone would have shown, so it does not.
    marks: boolean;
  },
): Promise<NextRead> {
  const rules = autonomyRules();
  const groups = await loadGroups(ctx);
  const scanned = input.mail
    ? await ctx.run<ReplyRow>(OWED_REPLIES, [
        new Date(now.getTime() - rules.replyOwedWithinDays * DAY_MS).toISOString(),
        now.toISOString(),
        (input.feed === true ? FEED_REPLY_SCAN : OWED_REPLY_SCAN) + 1,
      ])
    : [];
  const rows = scanned.slice(0, input.feed === true ? FEED_REPLY_SCAN : OWED_REPLY_SCAN);
  const lookedAt =
    rows.length === 0 || !input.tasks
      ? new Map<string, string>()
      : new Map(
          (await ctx.run<{ message: string; id: string }>(SETTLED_REPLIES, [rows.map((row) => row.id)])).map(
            (row) => [row.message, row.id] as const,
          ),
        );
  const who = await groupWho(ctx, groups, [...new Set(rows.map((row) => row.entity_id))]);
  // Opened to tell an ask from advice and nothing else: no word of a body is served, so it is not logged as bound.
  const toOpen = input.bodies
    ? rows
        .filter((row) => !lookedAt.has(row.id))
        .slice(0, OWED_REPLY_BODIES)
        .map((row) => row.id)
    : [];
  const opened =
    toOpen.length === 0
      ? []
      : await ctx.run<{ id: string; compartments: string[]; body_enc: Sealed | null }>(BODIES, [toOpen]);
  const bodyOf = new Map(
    opened.flatMap((row) => {
      const body = servedOrNone(ctx, row, "knowledge.messages.body_enc")?.untrusted;
      return body === undefined ? [] : [[row.id, body] as const];
    }),
  );
  const allReplies: OwedReply[] = rows.map((row) => {
    const subject = servedOrNone(ctx, row, "knowledge.messages.subject_enc")?.untrusted;
    const body = bodyOf.get(row.id);
    const task = lookedAt.get(row.id);
    return {
      message: row.id,
      who: who.get(groups.idOf(row.entity_id)) ?? who.get(row.entity_id) ?? null,
      what: subject === undefined ? null : { untrusted: capText(servedText(subject)) },
      at: stamp(row.sent_at),
      asks: replyAsks(subject, body),
      bodyRead: body !== undefined,
      ...(task === undefined ? {} : { task: task as OpportunityId }),
    };
  });
  const meetingRows = await ctx.run<MeetingRow & { recurring: boolean | null }>(NEXT_MEETINGS, [
    now.toISOString(),
    new Date(now.getTime() + MEETING_LOOK_AHEAD_DAYS * DAY_MS).toISOString(),
  ]);
  // What agents wrote back: handled clears a signal, the rest hold it. What fell late after the write-back is
  // news, and an owed reply's mail clears by itself. A meeting stays on the calendar; only its move is cleared.
  const marked = !input.marks
    ? new Map<string, { state: string; at: Date }>()
    : new Map(
        (
          await ctx.run<{ ref_id: string; state: string; created_at: Date }>(MARKS_ON, [
            [
              ...input.open.items.map((item) => item.source.id as string),
              ...rows.map((row) => row.id),
              ...meetingRows.map((row) => row.id as string),
            ],
          ])
        ).map((row) => [row.ref_id, { state: row.state, at: row.created_at }] as const),
      );
  const handled = (id: string): boolean => marked.get(id)?.state === "handled";
  const openItems = input.open.items.filter((item) => {
    const mark = marked.get(item.source.id as string);
    if (mark?.state !== "handled") return true;
    return item.overdue && item.due !== null && Date.parse(item.due) > mark.at.getTime();
  });
  const replies = allReplies.filter((one) => !handled(one.message));
  const found = meetingRows.length === 0 ? new Map() : await meetingsOf(ctx, meetingRows, groups);
  const slots = new Set(meetingRows.flatMap((row) => (row.recurring === true ? [row.id as string] : [])));
  // Their titles as the head of get_self serves one: dated and cut.
  const { meeting, moving, slot } = meetingsToShow(
    boundHead({
      upcoming: meetingRows.flatMap((row) => found.get(row.id) ?? []),
      changes: [],
      timeZone: input.zone,
    }).upcoming,
    (one) => slots.has(one.id),
  );
  const composed = composeNext({
    now,
    zone: input.zone,
    items: openItems,
    more: input.open.cut || scanned.length > rows.length,
    replies,
    meeting,
    moving,
    recurring: meeting !== null && slots.has(meeting.id),
    slot,
    findings: input.findings,
    hours: { due: rules.commitmentDueHours },
    strangers: input.open.strangers,
    ...(input.whole === true ? { whole: true } : {}),
    ...(input.feed === true ? { room: FEED_ROOM } : {}),
  });
  const value: NextMoves = {
    ...composed,
    moves: composed.moves.flatMap((move) => {
      const state = marked.get(move.source.id as string)?.state;
      if (state === undefined) return [move];
      if (state !== "handled") return [{ ...move, state: state as HeldState }];
      return move.kind === "meeting" && move.moving === true ? [] : [move];
    }),
  };

  const evidenceOfReply = new Map(rows.map((row) => [row.id, row.evidence_id]));
  return {
    value,
    readOf: (moves) => {
      const ids = moves.map((move) => move.source.id as string);
      const rests = ids.flatMap((id) => input.open.rests.get(id) ?? []);
      return sortedRead(
        mergeReads(readOfRests(rests), {
          shown: [
            ...ids.flatMap((id) => evidenceOfReply.get(id) ?? []),
            ...meetingRows.flatMap((row) => (ids.includes(row.id) ? [row.evidence_id] : [])),
            ...moves.flatMap((move) => (move.reported ?? []).map((one) => one.record as string)),
          ],
        }),
      );
    },
  };
}
