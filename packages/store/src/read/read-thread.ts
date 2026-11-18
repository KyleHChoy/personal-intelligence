import { ReadItemArgs, type ThreadView } from "@intelligence/contracts/personal";
import { maskedField, maskedIn, maskedSpans } from "@intelligence/personal-core";
import type { Ctx, Found } from "../core/read-ctx.ts";
import { parsed, type ReadTool } from "../core/read-tool.ts";
import type { Sealed } from "../core/seal.ts";
import { servedOrNone } from "../core/served.ts";
import { factsOf, SUMMARY_COLUMNS, type SummaryRow, summaryOf } from "./read-messages.ts";

// read_item's two fixed queries:
// the named message, then the visible messages of its thread. The row policy returns no held
// message, and the statements say `not held` as well, so a held message is absent from every
// thread, and naming one is as naming a hidden or an absent one: the same first statement, no
// row, not_found.

const LIMIT_DEFAULT = 20;
// The last position `from` takes (ReadItemArgs): `next` is never one a call could not ask from.
const FROM_MAX = 999;
// The most code points of text one call serves, and of one message's text.
const PAGE_CHARS = 50_000;
const MESSAGE_CHARS = 20_000;

export const THREAD_NAMED = `
  select m.id, m.thread_fp, m.compartments, m.thread_id_enc
  from knowledge.messages m
  where m.id = $1 and not m.held
  order by m.id`;

// The thread: the messages whose thread fingerprint and compartments equal the named one's, so
// the same thread id in another mailbox is another thread; a message with no thread is a thread
// of one. Oldest first, then by id, from `from`, one more than asked so `next` is known.
export const THREAD_PAGE = `
  select ${SUMMARY_COLUMNS}, m.body_enc
  from knowledge.messages m
  where not m.held and m.compartments = $2 and (m.thread_fp = $1 or ($1::text is null and m.id = $3))
  order by m.sent_at, m.id
  offset $4
  limit $5`;

type NamedRow = { id: string; thread_fp: string | null; compartments: string[]; thread_id_enc: Sealed | null };
type ThreadRow = SummaryRow & { body_enc: Sealed | null };

export async function readItem(ctx: Ctx, args: ReadItemArgs): Promise<Found<ThreadView> | null> {
  const [named] = await ctx.run<NamedRow>(THREAD_NAMED, [args.message]);
  if (named === undefined) return null;
  const from = args.from ?? 0;
  const limit = args.limit ?? LIMIT_DEFAULT;
  const rows = await ctx.run<ThreadRow>(THREAD_PAGE, [named.thread_fp, named.compartments, named.id, from, limit + 1]);

  const messages: ThreadView["messages"] = [];
  const bound: string[] = [];
  const shown: string[] = [];
  let served = 0;
  // `masked` counts every subject's values and those each served text reaches.
  let masked = 0;
  for (const row of rows.slice(0, limit)) {
    const opened = servedOrNone(ctx, row, "knowledge.messages.body_enc")?.untrusted;
    const body = opened === undefined ? undefined : maskedSpans(opened);
    const text = body === undefined ? null : firstPoints(body.text, MESSAGE_CHARS);
    if (served + (text?.points ?? 0) > PAGE_CHARS) break;
    served += text?.points ?? 0;
    const summary = summaryOf(ctx, row, factsOf(ctx, row));
    masked += (summary.masked ?? 0) + (body === undefined || text === null ? 0 : maskedIn(body.spans, 0, text.points));
    messages.push({
      summary,
      text: text === null ? null : { untrusted: text.text },
      offset: 0,
      cut: text?.cut ?? false,
    });
    // A message whose text was served is bound; one with none was only shown.
    (text === null ? shown : bound).push(row.evidence_id);
  }
  // Past position 999 a thread cannot be paged: no call takes a later `from`.
  const next = messages.length < rows.length && from + messages.length <= FROM_MAX ? from + messages.length : null;
  return {
    value: {
      thread: servedOrNone(ctx, named, "knowledge.messages.thread_id_enc"),
      messages,
      next,
      ...maskedField(masked),
    },
    rows: messages.length,
    read: { bound, shown, factKeyFps: [] },
    chars: served,
  };
}

// A text's first `max` code points, never cut inside a character outside the basic plane, read
// no further than it needs; `cut` says the text goes on.
function firstPoints(text: string, max: number): { text: string; points: number; cut: boolean } {
  let points = 0;
  let end = 0;
  for (const character of text) {
    if (points === max) return { text: text.slice(0, end), points, cut: true };
    points += 1;
    end += character.length;
  }
  return { text, points, cut: false };
}

// One mail thread's visible messages, at most 20 and 50 000 code points a call.
export const READ_ITEM_TOOL: ReadTool<ReadItemArgs, ThreadView> = {
  tool: "read_item",
  parse: (args) => parsed(ReadItemArgs.safeParse(args)),
  work: (ctx, valid) => readItem(ctx, valid),
};
