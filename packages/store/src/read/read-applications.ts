import {
  type ApplicationSign,
  type ApplicationState,
  type BeliefLine,
  DeclineReason,
} from "@intelligence/contracts/personal";
import { DAY_MS } from "@intelligence/personal-core";
import {
  type ApplicationItem,
  applicationSignsOf,
  type Finding,
  saysEnded,
  subjectState,
} from "@intelligence/personal-core/views";
import { stamp } from "../core/db.ts";
import type { Ctx, ReadSet } from "../core/read-ctx.ts";
import type { Sealed } from "../core/seal.ts";
import { servedOrNone } from "../core/served.ts";
import { opportunitySummary } from "../core/work-views.ts";
import { servedText } from "./read-fact-rows.ts";
import { BODIES } from "./read-messages.ts";
import { capText } from "./read-self.ts";

// Subject lines of the mail the caller's token returns, a held message left out, and for a client that
// may read a message whole, the body of the few newest signs a body could end.

// How far back and how many subjects one read opens, newest first. Past the cap the oldest go unread.
const APPLICATION_DAYS = 60;
const APPLICATION_SCAN = 1000;
// How many bodies one read opens, the newest signs first.
const APPLICATION_BODIES = 5;
const ENDABLE: ReadonlySet<ApplicationState> = new Set(["offer", "in_progress", "applied"]);

// Promotions, forums and social mail hold no application of the owner's: the categories left out cost
// the read most of its rows.
const RECENT_SUBJECTS = `
  select m.id, m.evidence_id, m.sent_at, m.subject_enc, m.sender_enc, m.compartments, m.bulk, m.direction
  from knowledge.messages m
  where not m.held and coalesce(m.auth, '') <> 'fail' and m.sent_at >= $1 and m.sent_at <= $2
    and (m.category is null or m.category in ('primary', 'updates'))
  order by m.sent_at desc, m.id
  limit $3`;

// The caller's own steps the owner said no to, in the window, while that is still the row's latest event. It
// starts from the owner's no events, so its cost is bounded by those. Own alone: the board opens no other agent's
// summary, so another's no says nothing here, as code cannot read its words.
const OWNER_NOES = `
  with me as (select 'client:' || c.id as author from policy.current_client() c)
  select o.id, o.compartments, o.body_enc, s.at, s.code
  from ledger.record_events s
  join ledger.opportunities o on o.id = s.row_id
  where s.row_kind = 'opportunity' and s.event = 'no_go' and s.by = 'owner' and s.at >= $1
    and o.created_by = (select author from me) and o.tainted_at is null and o.tier = 'opportunity'
    and not exists (select 1 from ledger.record_events r where r.row_kind = 'opportunity' and r.row_id = o.id and r.id > s.id)
  order by s.at desc, o.id collate "C" desc
  limit $2`;
// Most of them say nothing of an application, and that is known only once opened; past this the oldest go unread.
const OWNER_NOES_READ = 50;

type SubjectRow = {
  id: string;
  evidence_id: string;
  sent_at: Date;
  subject_enc: Sealed | null;
  sender_enc: Sealed | null;
  compartments: string[];
  bulk: boolean;
  direction: string;
};

const capOrNull = (from: string | undefined): string | null => (from === undefined ? null : capText(servedText(from)));

// `mail`: whether this client is shown mail, the People view's. Without it the signs are the lines and
// the items alone. `bodies`: it may also read a message whole, as read_message serves it. The read log
// names the messages shown by their evidence ids. A body read here is never bound: the client is given
// one state, not the text, and `bound` is what a close may cite as read whole.
export async function applicationsOf(
  ctx: Ctx,
  now: Date,
  input: {
    mail: boolean;
    bodies: boolean;
    lines: readonly BeliefLine[];
    openItems: readonly ApplicationItem[];
    findings: readonly Finding[];
    // Whether this client may read its own closed work, as list_opportunities serves it.
    ownerNoes: boolean;
  },
): Promise<{ signs: ApplicationSign[]; read: ReadSet }> {
  const rows = input.mail
    ? await ctx.run<SubjectRow>(RECENT_SUBJECTS, [
        new Date(now.getTime() - APPLICATION_DAYS * DAY_MS).toISOString(),
        now.toISOString(),
        APPLICATION_SCAN,
      ])
    : [];
  // A sender is opened only for a subject that says something: most say nothing.
  const said = rows.flatMap((row) => {
    const opened = servedOrNone(ctx, row, "knowledge.messages.subject_enc")?.untrusted;
    if (opened === undefined) return [];
    const subject = capText(servedText(opened));
    const message = { subject, bulk: row.bulk, outbound: row.direction === "outbound" };
    const state = subjectState(message);
    return state === null ? [] : [{ row, state, message }];
  });
  // `said` keeps the rows' order, the newest first.
  const toRead = input.bodies
    ? said
        .filter((one) => ENDABLE.has(one.state) && !one.message.outbound)
        .slice(0, APPLICATION_BODIES)
        .map((one) => one.row.id)
    : [];
  const opened =
    toRead.length === 0
      ? []
      : await ctx.run<{ id: string; compartments: string[]; body_enc: Sealed | null }>(BODIES, [toRead]);
  const ended = new Set(
    opened.flatMap((row) => {
      const body = servedOrNone(ctx, row, "knowledge.messages.body_enc")?.untrusted;
      return body !== undefined && saysEnded(body) ? [row.id] : [];
    }),
  );
  const messages = said.map(({ row, message }) => ({
    ...message,
    id: row.id,
    from: capOrNull(servedOrNone(ctx, row, "knowledge.messages.sender_enc")?.untrusted),
    at: stamp(row.sent_at),
    ...(ended.has(row.id) ? { ended: true as const } : {}),
  }));
  const noRows = input.ownerNoes
    ? await ctx.run<{ id: string; compartments: string[]; body_enc: Sealed | null; at: Date; code: string | null }>(
        OWNER_NOES,
        [new Date(now.getTime() - APPLICATION_DAYS * DAY_MS).toISOString(), OWNER_NOES_READ],
      )
    : [];
  const ownerNoes = noRows.flatMap((row) => {
    const what = opportunitySummary(ctx, row);
    if (what === null) return [];
    const reason = DeclineReason.safeParse(row.code);
    return [
      {
        id: row.id,
        what: capText(what.untrusted),
        at: stamp(row.at),
        ...(reason.success ? { reason: reason.data } : {}),
      },
    ];
  });
  const signs = applicationSignsOf({
    ownerNoes,
    messages,
    lines: input.lines,
    openItems: input.openItems,
    now,
    findings: input.findings,
  });
  const evidenceOf = new Map(rows.map((row) => [row.id, row.evidence_id]));
  const served = signs.flatMap((sign) => (sign.message === undefined ? [] : [sign.message as string]));
  return {
    signs,
    read: {
      bound: [],
      shown: [
        ...new Set([
          ...served.flatMap((id) => evidenceOf.get(id) ?? []),
          ...signs.flatMap((sign) => (sign.reported ?? []).map((one) => one.record as string)),
        ]),
      ],
      factKeyFps: [],
    },
  };
}
