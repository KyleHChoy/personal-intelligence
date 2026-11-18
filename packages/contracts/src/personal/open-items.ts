import { z } from "zod";
import { DateOnly, Timestamp } from "../ids.ts";
import { AgentRecordId, CaptureId, DocumentId, EventId, Handle, MessageId } from "./ids.ts";
import { Hex64 } from "./primitives.ts";
import { UntrustedString } from "./tools-args.ts";
import { Who } from "./tools-views.ts";

// What the owner owes and what is overdue: one list computed at read from what is stored, stored
// nowhere. The owner's page and every agent read the same items.

// The most one answer holds, and what get_self, context and the bootstrap pack each carry at their top.
export const OPEN_ITEMS_MOST = 50;
// What the owner's page reads, so its counts rest on every open item.
export const OWNER_OPEN_ITEMS_MOST = 200;
export const OPEN_ITEMS_SHOWN = 15;
// A project's lines on its get_entity.
export const PROJECT_OPEN_ITEMS = 5;

// Where an item comes from: an open commitment, a next step an agent reported, a dated plan, or a
// calendar event code reads as a reminder or a deadline.
export const OpenItemSource = z.enum(["commitment", "next_step", "plan", "calendar"]);
export type OpenItemSource = z.infer<typeof OpenItemSource>;

// What an agent's finding says beside a structured field: its one sentence, the record it stands in, who
// wrote it and when. `unconfirmed` is always true. It changes no state, date or status: a finding is a
// model's words, and only a source or the owner moves a field.
export const AGENT_REPORTS_SHOWN = 3;
export const AgentReport = z.strictObject({
  said: UntrustedString,
  record: AgentRecordId.or(Handle),
  client: z.string().min(1).max(200),
  at: Timestamp,
  unconfirmed: z.literal(true),
});
export type AgentReport = z.infer<typeof AgentReport>;

// `source.id` is a commitment's fact, a next step's or plan's fingerprint of its fact and its words,
// or the calendar event's id: one item for one id. `message`, `document`, `capture` and `record` say where it can be read,
// which stays so after it lapses. `lateDays` is whole days in the owner's zone, 0 for what passed
// earlier today, and null unless `overdue`. `due` is the deadline. A reminder's own date is `remindAt`,
// never its `due`: `due` is then the date its title names, or null when it names none. A `record` on
// a plan says an agent reported it and nobody has confirmed it, and `agent` is who, a client's name.
// `repliedAt`: the owner's later message on a plan's thread, which closes nothing.
export const OpenItem = z.strictObject({
  // Null for a commitment whose message is held, as get_commitments serves it.
  what: UntrustedString.nullable(),
  due: z.union([DateOnly, Timestamp]).nullable(),
  remindAt: z.union([DateOnly, Timestamp]).optional(),
  repliedAt: Timestamp.optional(),
  source: z.strictObject({
    kind: OpenItemSource,
    id: Hex64.or(EventId).or(Handle),
    message: MessageId.or(Handle).optional(),
    document: DocumentId.or(Handle).optional(),
    capture: CaptureId.or(Handle).optional(),
    record: AgentRecordId.or(Handle).optional(),
    agent: z.string().min(1).max(200).optional(),
  }),
  whoActs: Who,
  project: Who.nullable(),
  overdue: z.boolean(),
  lateDays: z.number().int().nonnegative().nullable(),
  // What agents reported of this item's date, unconfirmed: the item stands as its source says.
  reported: z.array(AgentReport).min(1).max(AGENT_REPORTS_SHOWN).optional(),
});
export type OpenItem = z.infer<typeof OpenItem>;

// Soonest due first, undated last. `more` says some were cut; every order and cut is over what the
// caller's token returned.
export const OpenItems = z.strictObject({ items: z.array(OpenItem).max(OWNER_OPEN_ITEMS_MOST), more: z.boolean() });
export type OpenItems = z.infer<typeof OpenItems>;

// The list as get_self, context and a project's page carry it, the soonest first.
export const ShownOpenItems = z.strictObject({ items: z.array(OpenItem).max(OPEN_ITEMS_SHOWN), more: z.boolean() });
export type ShownOpenItems = z.infer<typeof ShownOpenItems>;

export const GetOpenItemsArgs = z
  .strictObject({ limit: z.number().int().min(1).max(OPEN_ITEMS_MOST).optional() })
  .meta({ examples: [{}, { limit: 10 }] });
export type GetOpenItemsArgs = z.infer<typeof GetOpenItemsArgs>;

// The owner's Done or Drop on an item that is no commitment. A commitment closes by closeCommitment.
export const OpenItemEnding = z.enum(["done", "dropped"]);
export type OpenItemEnding = z.infer<typeof OpenItemEnding>;
const ITEM_KEY = Hex64.or(EventId);
const CLOSABLE = z.enum(["next_step", "plan", "calendar"]);

// The decisions' clear details: a fingerprint or an id, the source's kind, and when.
// `match` is what the item's words match across statements, a Drop's reach; `due` its date when closed,
// a later date ending the close.
export const OpenItemCloseDetails = z.strictObject({
  key: ITEM_KEY,
  match: Hex64.nullable(),
  due: z.union([DateOnly, Timestamp]).nullable(),
  source: CLOSABLE,
  at: Timestamp,
});
export type OpenItemCloseDetails = z.infer<typeof OpenItemCloseDetails>;
export const OpenItemReopenDetails = z.strictObject({ key: ITEM_KEY, at: Timestamp });
export type OpenItemReopenDetails = z.infer<typeof OpenItemReopenDetails>;

// What the page posts.
const RequestKey = z.string().min(1).max(200);
export const CloseOpenItemBody = z.strictObject({
  source: CLOSABLE,
  key: ITEM_KEY,
  ending: OpenItemEnding,
  requestId: RequestKey,
});
export type CloseOpenItemBody = z.infer<typeof CloseOpenItemBody>;
export const ReopenOpenItemBody = z.strictObject({ key: ITEM_KEY, requestId: RequestKey });
export type ReopenOpenItemBody = z.infer<typeof ReopenOpenItemBody>;
