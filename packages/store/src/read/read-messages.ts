import {
  FindMessagesArgs,
  type MessageCategory,
  type MessageId,
  type MessageList,
  type MessageSummary,
  type MessageView,
  ReadMessageArgs,
  SealedMessageFacts,
} from "@intelligence/contracts/personal";
import { maskCredentials, maskedField, maskedIn, maskedSpans, normalizeAddress } from "@intelligence/personal-core";
import { gmailLink } from "@intelligence/personal-core/items";
import { stamp } from "../core/db.ts";
import { fingerprint } from "../core/fingerprint.ts";
import { type Ctx, epochSeconds, type Found, shownOnly } from "../core/read-ctx.ts";
import { parsed, type ReadTool, timed } from "../core/read-tool.ts";
import type { Sealed } from "../core/seal.ts";
import { parseOr, servedJson, servedOrNone } from "../core/served.ts";
import { zonedBounds } from "../core/zone.ts";
import { ENTITY } from "./read-fact-rows.ts";
import { loadGroups } from "./read-groups.ts";

// The two message tools' fixed queries. Each reads knowledge.messages, and for an entity
// interaction_log and entities, under the caller's token and nothing else. The row policy returns
// no held message; the statements say `not held` as well. Every filter is on a clear column or a
// fingerprint: nothing here matches on what a message says.

const FOUND_DEFAULT = 20;
const FOUND_MAX = 50;
const SLICE_DEFAULT = 20_000;
const SLICE_MAX = 50_000;
const ATTACHMENTS_MAX = 50;

// The columns a result opens, and never body_enc: fifty results bring no sealed body out.
export const SUMMARY_COLUMNS =
  "m.id, m.sent_at, m.direction, m.bulk, m.category, m.subject_enc, m.sender_enc, m.sender_name_enc, m.facts_enc, m.compartments, m.evidence_id";

// Every filter given, newest first, ties by id, one row more than asked so `more` is known.
// Every match is found first, by the indexes led by the label key, and only then ordered and
// cut: a cut in the same select as the messages would let the planner
// walk the messages of every compartment in time order, or by sender, and drop the hidden ones
// as it went, so that a call's work told how many it passed. An entity's messages
// are those its visible rows name, read once. The matches are kept by id and time alone; only
// the page's rows are read whole, by their ids.
const FIND = `
  with found as materialized (
    select m.id, m.sent_at
    from knowledge.messages m
    where not m.held
      and m.sent_at <= to_timestamp($1) and ($2::float8 is null or m.sent_at >= to_timestamp($2))
      and ($3::text[] is null or m.evidence_id in (select i.evidence_id from knowledge.interaction_log i where i.entity_id = any($3::text[])))
      and ($4::text is null or m.sender_fp = $4)
      and ($5::text is null or m.sender_domain_fp = $5)
      and ($6::text is null or m.category = $6)
  )
  select ${SUMMARY_COLUMNS}
  from knowledge.messages m
  where m.id in (select found.id from found order by found.sent_at desc, found.id limit $7)
  order by m.sent_at desc, m.id`;

export type SummaryRow = {
  id: string;
  sent_at: Date;
  direction: "inbound" | "outbound";
  bulk: boolean;
  category: MessageCategory;
  subject_enc: Sealed | null;
  sender_enc: Sealed | null;
  sender_name_enc: Sealed | null;
  facts_enc: Sealed | null;
  compartments: string[];
  evidence_id: string;
};

type Facts = SealedMessageFacts;

// A `sender` argument read: an address with an `@`, else a domain, exactly that domain. Null
// for anything else, which the call refuses as invalid_request.
type SenderReading = { kind: "address" | "domain"; value: string };

function readSender(sender: string): SenderReading | null {
  if (sender.includes("@")) {
    const address = normalizeAddress(sender);
    return address === null ? null : { kind: "address", value: address };
  }
  let domain = sender.trim().toLowerCase();
  while (domain.endsWith(".")) domain = domain.slice(0, -1);
  return domain.includes(".") && !/\s/.test(domain) ? { kind: "domain", value: domain } : null;
}

// The sealed facts, written by the writer as JSON. A value that does not read as JSON of their
// shape is a stored value that does not open.
export const factsOf = (ctx: Ctx, row: SummaryRow): Facts =>
  parseOr(SealedMessageFacts.safeParse(servedJson(ctx, row, "knowledge.messages.facts_enc")));

// An opened value with its credential-shaped values masked, and their count.
function maskedValue(value: { untrusted: string } | null): {
  value: { untrusted: string } | null;
  masked: number;
} {
  if (value === null) return { value, masked: 0 };
  const { text, masked } = maskCredentials(value.untrusted);
  return { value: { untrusted: text }, masked };
}

// What a result of find_messages carries, and what read_message carries with it. The subject is
// masked; `masked` counts its values.
export function summaryOf(ctx: Ctx, row: SummaryRow, facts: Facts): MessageSummary {
  const address = servedOrNone(ctx, row, "knowledge.messages.sender_enc");
  const subject = maskedValue(servedOrNone(ctx, row, "knowledge.messages.subject_enc"));
  return {
    id: row.id as MessageId,
    at: stamp(row.sent_at),
    direction: row.direction,
    bulk: row.bulk,
    category: row.category,
    subject: subject.value,
    sender: address === null ? null : { address, name: servedOrNone(ctx, row, "knowledge.messages.sender_name_enc") },
    chars: facts.chars,
    attachments: facts.attachments.length,
    ...maskedField(subject.masked),
  };
}

type FindArgs = FindMessagesArgs & { reading: SenderReading | null };

async function findMessages(ctx: Ctx, args: FindArgs, now: Date): Promise<Found<MessageList> | null> {
  if (args.entity !== undefined && (await ctx.run(ENTITY, [args.entity])).length === 0) return null;
  const limit = Math.min(args.limit ?? FOUND_DEFAULT, FOUND_MAX);
  const reading = args.reading;
  const rows = await ctx.run<SummaryRow>(FIND, [
    epochSeconds(args.to === undefined ? now : new Date(args.to)),
    args.from === undefined ? null : epochSeconds(new Date(args.from)),
    // Contacts and identity: an entity is its group's visible members.
    args.entity === undefined ? null : (await loadGroups(ctx)).membersOf(args.entity),
    reading?.kind === "address" ? fingerprint(ctx.keys, "address", reading.value) : null,
    reading?.kind === "domain" ? fingerprint(ctx.keys, "domain", reading.value) : null,
    args.category ?? null,
    limit + 1,
  ]);
  const kept = rows.slice(0, limit);
  const messages = kept.map((row) => summaryOf(ctx, row, factsOf(ctx, row)));
  return {
    value: { messages, more: rows.length > limit },
    rows: messages.length,
    read: shownOnly(kept.map((row) => row.evidence_id)),
  };
}

// The one row with that id, never a held one: a held id and an unknown one send this same
// statement and get the same empty answer.
const READ = `
  select ${SUMMARY_COLUMNS}, m.thread_id_enc, m.body_enc
  from knowledge.messages m
  where m.id = $1 and not m.held
  order by m.id`;

type MessageRow = SummaryRow & { thread_id_enc: Sealed | null; body_enc: Sealed | null };

async function readMessage(ctx: Ctx, args: ReadMessageArgs): Promise<Found<MessageView> | null> {
  const [row] = await ctx.run<MessageRow>(READ, [args.id]);
  if (row === undefined) return null;
  const facts = factsOf(ctx, row);
  const threadId = servedOrNone(ctx, row, "knowledge.messages.thread_id_enc");
  const opened = servedOrNone(ctx, row, "knowledge.messages.body_enc")?.untrusted;
  // `masked` counts the subject's values and those the window reaches.
  const body = opened === undefined ? undefined : maskedSpans(opened);
  // Cut by code points, never inside a character outside the basic plane.
  const offset = args.offset ?? 0;
  const end = offset + Math.min(args.limit ?? SLICE_DEFAULT, SLICE_MAX);
  const points = body === undefined ? null : Array.from(body.text);
  const text = points === null ? null : points.slice(offset, end);
  const summary = summaryOf(ctx, row, facts);
  const masked = (summary.masked ?? 0) + (body === undefined ? 0 : maskedIn(body.spans, offset, end));
  return {
    value: {
      // The subject's count is part of the whole one, which replaces it.
      ...summary,
      ...maskedField(masked),
      // A message the source gave no thread is a thread of one: its own id.
      thread: threadId ?? { untrusted: row.id },
      text: text === null ? null : { untrusted: text.join("") },
      offset,
      more: points !== null && points.length > end,
      unreadable: facts.unreadable,
      attachmentList: facts.attachments
        .slice(0, ATTACHMENTS_MAX)
        .map(({ name, type, size }) => ({ name: { untrusted: name }, type: { untrusted: type }, size })),
      link: gmailLink(threadId?.untrusted),
    },
    rows: 1,
    // Its text was asked for by id and given: the message is bound.
    read: { bound: [row.evidence_id], shown: [], factKeyFps: [] },
    // The code points of the slice served, which the read quota counts.
    chars: text?.length ?? 0,
  };
}

// find_messages' arguments, with its `sender` read as an address or a domain; null when either
// fails, so a sender that is neither is refused as any other bad argument.
function finding(args: FindMessagesArgs | null): FindArgs | null {
  if (args === null) return null;
  if (args.sender === undefined) return { ...args, reading: null };
  const reading = readSender(args.sender);
  return reading === null ? null : { ...args, reading };
}

export const FIND_MESSAGES_TOOL: ReadTool<FindArgs, MessageList> = {
  tool: "find_messages",
  parse: (args) => finding(timed(parsed(FindMessagesArgs.safeParse(args)))),
  work: async (ctx, valid, _client, env) => findMessages(ctx, await zonedBounds(ctx, valid), env.now()),
};

export const READ_MESSAGE_TOOL: ReadTool<ReadMessageArgs, MessageView> = {
  tool: "read_message",
  parse: (args) => parsed(ReadMessageArgs.safeParse(args)),
  work: (ctx, valid) => readMessage(ctx, valid),
};

export const BODIES = `
  select m.id, m.compartments, m.body_enc
  from knowledge.messages m
  where m.id = any($1::text[]) and not m.held
  order by m.id`;
