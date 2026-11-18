import {
  type IdentityResolver,
  type InteractionRecord,
  type LocalEntityId,
  type RawItem,
  Timestamp,
} from "@intelligence/contracts";
import { CodedError, PageUrl } from "@intelligence/contracts/personal";
import { normalizeAddress } from "../addresses.ts";
import { PipelineError } from "../claim-pipeline/errors.ts";
import { readHeaders } from "../claim-pipeline/headers.ts";
import { interactionFor } from "../claim-pipeline/interaction.ts";
import type { Limits } from "../claim-pipeline/limits.ts";
import { parse } from "../claim-pipeline/parse.ts";
import { EXTRACTOR_GENERATION } from "../limits.ts";
import { THE_OWNER } from "../owner.ts";
import { labelOf, membersOf, payloadOf, pipelineItemOf } from "./adapter.ts";
import { isDraft, messageCategory, ownerSent, personalBulk } from "./bulk.ts";
import { deriveContact } from "./contacts.ts";
import { deriveDocument } from "./documents.ts";
import { eventOf, isOwnerAddress, readEvent } from "./events.ts";
import { recoveryHold } from "./hold.ts";
import { mailAuthOf } from "./mail-auth.ts";
import { meetingRecord } from "./meeting.ts";
import { blockMarks, headersOnly } from "./message.ts";
import { isFullName, nameFor, namesOf } from "./names.ts";
import { restrictedCategories } from "./screen.ts";
import type { ItemContext, ItemFacts, MessageFacts } from "./types.ts";

// An email is read by the shared claim pipeline, with no model and no network; an event is read
// here. Nothing a header, a title or a body says is followed, and no person, name or time comes
// from a body.

// What a reading gave, or null when it was refused as parse_failed. Any other failure
// passes through, so the writer rolls the item back.
async function orUnread<T>(read: () => T | Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof PipelineError && error.code === "parse_failed") return null;
    throw error;
  }
}

async function deriveEmail(raw: RawItem, ctx: ItemContext, limits: Limits): Promise<ItemFacts> {
  const item = pipelineItemOf(raw, ctx);
  const members = membersOf(raw, ctx);
  const payload = payloadOf(raw);
  // When the parse refuses the payload, the headers alone are parsed, and only when they are
  // refused too is the item unread.
  const head = headersOnly(payload);
  const whole = await orUnread(() => parse(item, payload, limits));
  const parsed = whole ?? (await orUnread(() => parse(item, head, limits)));
  const marks = await orUnread(() => blockMarks(head));
  const unread = async (): Promise<ItemFacts> => {
    const subject = (await namesOf(head).catch(() => null))?.subject ?? null;
    const restricted = restrictedCategories({ subject, text: whole?.body ?? null }, ctx.restrictedOn ?? []);
    return { kind: "unread", members, ...(restricted.length === 0 ? {} : { restricted }) };
  };
  if (parsed === null || marks === null) return unread();

  // The names, the subject and the builder's lines are read from the headers alone, so the body is
  // parsed once. The text is evidence copied for reading: never cut or cleaned.
  const headers = readHeaders(parsed);
  const read = await namesOf(head);
  const text = whole?.body === undefined || whole.body.trim() === "" ? null : whole.body;
  // The sender's name is the one written with the first From address, never one another
  // header gives that address.
  const [from] = parsed.parties ?? [];
  const senderName =
    raw.sender === undefined || from?.address !== raw.sender ? undefined : nameFor(from.name, raw.sender);
  const references = parsed.headers.references;
  const messageAt = (at: Timestamp): MessageFacts => ({
    subject: read.subject,
    at,
    ...(raw.sender === undefined
      ? {}
      : { sender: { address: raw.sender, ...(senderName === undefined ? {} : { name: senderName }) } }),
    category: messageCategory(raw.markers),
    text,
    unreadable: whole === null || marks.unreadable,
    // Nothing else differs for it.
    held: recoveryHold({ subject: read.subject, ...(raw.sender === undefined ? {} : { sender: raw.sender }), text }),
    // The two marks are independent.
    restricted: restrictedCategories({ subject: read.subject, text }, ctx.restrictedOn ?? []),
    attachments: marks.attachments,
    ...(headers.messageId === undefined ? {} : { messageId: headers.messageId }),
    ...(references === undefined ? {} : { references }),
    // From the topmost Authentication-Results header, for the From address.
    auth: mailAuthOf(new TextDecoder().decode(head), raw.sender),
  });

  // Social and Forums are lifted for a sender the owner has written to. Its time is the one a
  // record would carry: the Date header when it is not after observedAt.
  if (parsed.automated || personalBulk(raw, ctx.senderWrittenTo)) {
    const sent = Timestamp.safeParse(headers.sentAt);
    const at = sent.success && Date.parse(sent.data) <= Date.parse(raw.observedAt) ? sent.data : raw.observedAt;
    return { kind: "email", members, bulk: true, message: messageAt(at) };
  }

  // Notes which entity each address resolved to, as the shared code asks about it. The shared parse
  // lets through any address with an "@"; one normalizeAddress refuses is nobody here, and the port
  // is never asked about it.
  const entities = new Map<string, LocalEntityId>();
  const identity: IdentityResolver = {
    resolve: async (mention, store, requestId, from) => {
      if (normalizeAddress(mention.key.value) === null) return { outcome: "not_a_person" };
      const resolution = await ctx.identity.resolve(mention, store, requestId, from);
      if (resolution.outcome === "linked" || resolution.outcome === "created")
        entities.set(mention.key.value, resolution.entity);
      return resolution;
    },
  };
  const made = await interactionFor(
    parsed,
    { item, label: labelOf(ctx) },
    { extractorGeneration: EXTRACTOR_GENERATION, identity },
  );
  if (made === null) return unread();

  const others = (list: LocalEntityId[]): LocalEntityId[] => list.filter((entity) => entity !== ctx.ownerEntity);
  const record: InteractionRecord = {
    ...made,
    // The Date header is the sender's to write. The shared code hands on only a timestamp; this is
    // a second line against a time a timestamp cannot hold (a year 0 to 99, or a negative one): a
    // time that is not a timestamp is observedAt, as a Date after observedAt is, so the writer is
    // never handed a time it refuses.
    occurredAt: Timestamp.safeParse(made.occurredAt).success ? made.occurredAt : raw.observedAt,
    participants: others(made.participants),
    ...(made.sent === undefined ? {} : { sent: { ...made.sent, recipients: others(made.sent.recipients) } }),
  };
  const sender = entities.get(headers.sender ?? "");
  const counterparts = [...new Set([...record.participants, ...(record.sent?.recipients ?? [])])];

  const names: { entity: LocalEntityId; name: string }[] = [];
  for (const { address, name } of read.names) {
    const entity = entities.get(address);
    if (entity === undefined || entity === ctx.ownerEntity) continue;
    if (!names.some((known) => known.entity === entity && known.name === name)) names.push({ entity, name });
  }

  const ownName =
    ownerSent(raw) && raw.sender !== undefined && isOwnerAddress(raw.sender, ctx.ownerAddresses)
      ? senderName
      : undefined;
  const ownerNames = ownName !== undefined && isFullName(ownName) ? [ownName] : [];

  return {
    kind: "email",
    members,
    bulk: false,
    message: messageAt(record.occurredAt),
    record,
    roles: counterparts.map((entity) => ({ entity, role: entity === sender ? "sender" : "recipient" })),
    names,
    ...(ownerNames.length === 0 ? {} : { ownerNames }),
  };
}

async function deriveEvent(raw: RawItem, ctx: ItemContext): Promise<ItemFacts> {
  const members = membersOf(raw, ctx);
  const facts = await orUnread(() => readEvent(eventOf(payloadOf(raw)), ctx.ownerAddresses));
  if (facts === null) return { kind: "unread", members };
  return { kind: "event", members, facts, ...(await meetingRecord(facts, ctx, raw.observedAt)) };
}

// Nothing on a page is resolved: no person, account, alias, domain, interaction or event comes from
// one. A page is derived only with its request (`no_page_request`), so a page of nobody's request
// is never stored; one whose source item id is not a canonical page URL is unread. The title is the
// shared parse's reading of an HTML page as a document, through the sentinel reference kind
// `register` as a document's: its `<title>`, or with none its first heading or line, all of it the
// page's own untrusted text. A text/plain page has none.
async function derivePage(raw: RawItem, ctx: ItemContext, limits: Limits): Promise<ItemFacts> {
  const members = { participantMembers: [THE_OWNER] };
  if (ctx.page === undefined) throw new CodedError("no_page_request");
  const url = PageUrl.safeParse(raw.sourceItemId).data;
  if (url === undefined || url !== raw.sourceItemId) return { kind: "unread", members };
  const read =
    raw.mediaType === "text/html"
      ? await orUnread(() => parse({ ...pipelineItemOf(raw, ctx), referenceKind: "register" }, payloadOf(raw), limits))
      : null;
  const { requestId, about, names } = ctx.page;
  return {
    kind: "page",
    members,
    page: { url, title: read?.document?.title ?? null, requestId, about, names: [...names] },
  };
}

export async function deriveItem(raw: RawItem, ctx: ItemContext, limits: Limits): Promise<ItemFacts> {
  if (isDraft(raw)) throw new CodedError("draft");
  if (raw.sourceKind === "crm") return deriveContact(raw, ctx);
  if (raw.sourceKind === "document") return deriveDocument(raw, ctx, limits);
  if (raw.sourceKind === "web_research") return derivePage(raw, ctx, limits);
  return raw.sourceKind === "calendar" ? deriveEvent(raw, ctx) : deriveEmail(raw, ctx, limits);
}
