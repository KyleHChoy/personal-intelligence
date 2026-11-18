import { z } from "zod";
import { Timestamp } from "../ids.ts";
import { RoleName } from "./clients.ts";
import { CardId, EventId, MessageId, OpportunityId, WorkNoticeId } from "./ids.ts";
import { OpportunityKind } from "./opportunity-words.ts";
import { BoxHealthAbout, BoxHealthKind, isAgentSeenKind } from "./owner-health.ts";
import { WorkTier } from "./work.ts";

// Work notices by webhook. What made the work the client's to take, or moved what it holds or set a
// check-back on. A transaction gives a client at most one notice for an item, with the first of its
// events in WORK_NOTICE_ORDER. `outcome`, an applied outcome link on work the client holds or last
// held, raised by the tick.
export const WorkNoticeEvent = z.enum([
  "task_go",
  "routed",
  "returned",
  "opportunity_go",
  "stage_cleared",
  "intention_due",
  "outcome",
  "fallback",
]);
export type WorkNoticeEvent = z.infer<typeof WorkNoticeEvent>;
export const WORK_NOTICE_ORDER: readonly WorkNoticeEvent[] = Object.freeze([
  "intention_due",
  "stage_cleared",
  "routed",
  "returned",
  "task_go",
  "opportunity_go",
  "outcome",
  "fallback",
]);
// What an outcome notice cites: the link's kind
// (OutcomeLinkKind's words, held equal by a test) and id, and the item it rests on when that item
// is a message or an event, by its id. Ids and closed codes only, as every notice field is.
export const WorkNoticeOutcome = z.strictObject({
  kind: z.enum(["met", "not_met", "partial", "advances"]),
  link: z.number().int().positive(),
  evidence: z
    .discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("message"), id: MessageId }),
      z.strictObject({ kind: z.literal("event"), id: EventId }),
    ])
    .nullable(),
});
export type WorkNoticeOutcome = z.infer<typeof WorkNoticeOutcome>;

// A notice's delivery state, and its last code: one of the sender's, or the endpoint's answer.
// `notice_error` is the row the notice function writes, with no client, when it fails; `no_secret`
// a client with an address and no signing secret, which is never sent unsigned.
export const WorkNoticeState = z.enum(["pending", "delivered", "failed", "stale", "rolled"]);
export type WorkNoticeState = z.infer<typeof WorkNoticeState>;
export const WorkNoticeCode = z
  .enum(["notice_error", "no_secret", "bad_address", "timeout", "unreachable", "redirect"])
  .or(z.string().regex(/^http_\d{3}$/));
export type WorkNoticeCode = z.infer<typeof WorkNoticeCode>;

// A notice as the sender reads it from its row: ids, closed codes, a role name the owner chose, the
// time it was written and the item's due time then, and nothing else. No summary, subject, name,
// basis, label, compartment or text: an agent reads the work under its own token.
export const WorkNotice = z.strictObject({
  notice: WorkNoticeId,
  event: WorkNoticeEvent,
  opportunity: OpportunityId,
  tier: WorkTier,
  kind: OpportunityKind,
  role: RoleName.nullable(),
  at: Timestamp,
  deadline: Timestamp.nullable(),
  // On an `outcome` notice alone (the body's check holds the two together).
  outcome: WorkNoticeOutcome.optional(),
});
export type WorkNotice = z.infer<typeof WorkNotice>;

// The body also carries the fields a routine receiver reads, each built by code from the notice's
// codes and times alone.
// The priority, from the due time and the event, as of when the notice was written (its `at`, so
// every try of one notice sends the same body): `high` due within 24 hours or past due; `normal`
// due within 7 days, or an opportunity the owner's go released; `low` otherwise.
const WorkNoticePriority = z.enum(["high", "normal", "low"]);
type WorkNoticePriority = z.infer<typeof WorkNoticePriority>;
const HOUR_MS = 60 * 60 * 1000;
export function noticePriority(notice: Pick<WorkNotice, "event" | "deadline">, now: Date): WorkNoticePriority {
  const left = notice.deadline === null ? null : Date.parse(notice.deadline) - now.getTime();
  if (left !== null && left <= 24 * HOUR_MS) return "high";
  if ((left !== null && left <= 7 * 24 * HOUR_MS) || notice.event === "opportunity_go" || notice.event === "outcome")
    return "normal";
  return "low";
}
// The title and the details: fixed text and codes, never a summary, a name or a model's words.
const noticeTitle = (notice: Pick<WorkNotice, "tier" | "kind" | "event">): string =>
  `PI ${notice.tier}: ${notice.kind} (${notice.event})`;
// An outcome notice names the link's kind and the item it rests on, by id, and the work to read.
export const noticeDetails = (notice: Pick<WorkNotice, "opportunity" | "event" | "role" | "outcome">): string =>
  notice.outcome === undefined
    ? `Claim it with claim_opportunity ${notice.opportunity}. The brief comes with the claim. Event: ${notice.event}. Role: ${notice.role ?? "none"}.`
    : `An outcome of ${notice.opportunity}: ${notice.outcome.kind} (link ${notice.outcome.link}), from ${notice.outcome.evidence === null ? "an item that is no message or event" : `${notice.outcome.evidence.kind} ${notice.outcome.evidence.id}`}. Read the work with read_item ${notice.opportunity}. Event: ${notice.event}. Role: ${notice.role ?? "none"}.`;

// The one body a notice carries: the notice's own fields and the routine's (`id`, the
// opportunity's id; `kind`, already the notice's; `title`; `details`; `deadline`, already the
// notice's; `priority`). The title and the details must be exactly the text code builds from the
// codes, and the priority the one the rule gives, so no other text or value can leave in them.
export const WorkNoticeBody = WorkNotice.extend({
  id: OpportunityId,
  title: z.string(),
  details: z.string(),
  priority: WorkNoticePriority,
}).refine(
  (body) =>
    body.id === body.opportunity &&
    (body.event === "outcome") === (body.outcome !== undefined) &&
    body.title === noticeTitle(body) &&
    body.details === noticeDetails(body) &&
    body.priority === noticePriority(body, new Date(body.at)),
  { message: "built from codes" },
);
export type WorkNoticeBody = z.infer<typeof WorkNoticeBody>;
// Built from the notice's named fields alone: any other key on the object never reaches the body.
export const noticeBody = (notice: WorkNotice): WorkNoticeBody =>
  WorkNoticeBody.parse({
    notice: notice.notice,
    event: notice.event,
    opportunity: notice.opportunity,
    tier: notice.tier,
    kind: notice.kind,
    role: notice.role,
    at: notice.at,
    deadline: notice.deadline,
    ...(notice.outcome === undefined ? {} : { outcome: notice.outcome }),
    id: notice.opportunity,
    title: noticeTitle(notice),
    details: noticeDetails(notice),
    priority: noticePriority(notice, new Date(notice.at)),
  });
// A box health card forwarded to the owner's agents that have an address, by
// the same sender, signing and outbound checks as a work notice, from its own table
// (ledger.health_notices). The card by its id, its kind, what it is about (a word, or a coverage
// row's `<kind>/<id>`) and when it was raised: ids and codes only. A notice grants nothing.
export const HealthNotice = z.strictObject({
  notice: WorkNoticeId,
  event: z.literal("box_health"),
  card: CardId,
  kind: BoxHealthKind,
  about: BoxHealthAbout,
  at: Timestamp,
});
export type HealthNotice = z.infer<typeof HealthNotice>;
const healthTitle = (notice: Pick<HealthNotice, "kind" | "about">): string =>
  `PI box health: ${notice.kind} (${notice.about})`;
// What the agent is asked: a kind an agent may mark is its to look at first, and the owner's only
// when it needs them; any other kind is the owner's at once.
const OWNERS_LOOK = (card: string): string =>
  `They read it with pia status and mark it seen with pia decide ${card} --answer seen.`;
const healthDetails = (notice: Pick<HealthNotice, "card" | "kind">): string =>
  isAgentSeenKind(notice.kind)
    ? `Look at it with get_health. If it needs nothing of the owner (it mended, or it passes), mark it seen with mark_health_seen. If it needs them, tell the owner. ${OWNERS_LOOK(notice.card)}`
    : `Tell the owner the box needs a look. ${OWNERS_LOOK(notice.card)}`;
// The body, as a routine receiver reads a work notice's (`id`, `kind`, `title`, `details`,
// `deadline`, `priority`): `id` is the card, no deadline, always `high`; title and details built
// by code from the codes alone.
export const HealthNoticeBody = HealthNotice.extend({
  id: CardId,
  title: z.string(),
  details: z.string(),
  deadline: z.null(),
  priority: z.literal("high"),
}).refine((body) => body.id === body.card && body.title === healthTitle(body) && body.details === healthDetails(body), {
  message: "built from codes",
});
export type HealthNoticeBody = z.infer<typeof HealthNoticeBody>;
export const healthNoticeBody = (notice: HealthNotice): HealthNoticeBody =>
  HealthNoticeBody.parse({
    notice: notice.notice,
    event: notice.event,
    card: notice.card,
    kind: notice.kind,
    about: notice.about,
    at: notice.at,
    id: notice.card,
    title: healthTitle(notice),
    details: healthDetails(notice),
    deadline: null,
    priority: "high",
  });
