import type {
  EvidenceId,
  Label,
  MemberId,
  ModelRequest,
  ReferenceKind,
  Routed,
  Timestamp,
} from "@intelligence/contracts";
import { LIMITS } from "../limits.ts";
import { parse } from "../parse.ts";
import type { PipelineItem } from "../ports.ts";
import { evidence, type ItemOptions } from "./support.ts";

// Made-up values for the document and interaction tests: reference documents, the members on an item and a
// model that does what an item tells it. Nothing here is real data.

// --- the members on an item ---

// RULING: the pipeline makes no directory call. The members among a message's sender and
// recipients come with the evidence item itself, as `EvidenceItem.participantMembers`, which
// ingest records when it writes the item. THE SLOT: until the contract carries that field, this
// one function says how the list travels with an item. An item with none is left as it is.
// Beside the list the contract has `senderMember`: the member who sent the item, when one did.
// `sender` puts it on the item; an item without it was sent by nobody on the team.
export const withParticipants = (item: PipelineItem, members: string[] | undefined, sender?: string): PipelineItem =>
  ({
    ...item,
    ...(members !== undefined && { participantMembers: members as MemberId[] }),
    ...(sender !== undefined && { senderMember: sender as MemberId }),
  }) as PipelineItem;

// --- reference documents ---

// What the source system reports about a reference document beside its bytes: the contract's
// `ReferenceFacts`, written out here until the contracts branch that holds it is on main. A
// document's own content never sets any of it (invariant 1). `replaces` is the source item id of
// the version this one supersedes, and the contract refuses `enforced` on a draft.
export interface DocumentMetadata {
  status: "approved" | "draft";
  enforced: boolean;
  sourceLink: string;
  effectiveFrom?: Timestamp;
  replaces?: string;
  owner?: { kind: "address" | "source_id" | "name"; value: string };
}

// The facts travel on the item as `EvidenceItem.reference`: an input beside the bytes, never
// inside them.
export const withMetadata = (item: PipelineItem, metadata: DocumentMetadata): PipelineItem =>
  ({ ...item, reference: metadata }) as PipelineItem;

// What the vault reader's `reference(item)` answers for a reference item: the item's facts, and
// the evidence id of the version it replaces when the vault holds one. Null for an item that
// carries no facts. The method is optional on the library's EvidenceReader; a test hands
// it over beside the reader the fake vault gives.
export interface ReferenceAnswer {
  facts: DocumentMetadata;
  replaces?: EvidenceId;
}

export const referenceReader = (replaced: Record<string, EvidenceId> = {}) => ({
  async reference(item: PipelineItem): Promise<ReferenceAnswer | null> {
    const facts = (item as { reference?: DocumentMetadata }).reference;
    if (facts === undefined) return null;
    const replaces = facts.replaces === undefined ? undefined : replaced[facts.replaces];
    return { facts, ...(replaces !== undefined && { replaces }) };
  },
});

export const SHARED: Label = {
  compartments: ["org", "source:acct-reference"],
  readers: ["m-tomas", "m-ines"],
} as Label;

// An item of a folder a person confirmed as reference: the evidence writer set its kind from
// its source account. Its label is the folder's sharing.
export function referenceItem(
  id: string,
  kind: ReferenceKind,
  metadata?: DocumentMetadata,
  options: ItemOptions = {},
): PipelineItem {
  const item: PipelineItem = {
    ...evidence(id, {
      sourceKind: "document",
      mediaType: "text/html",
      account: "acct-reference",
      compartments: SHARED.compartments,
      readers: SHARED.readers,
      ...options,
    }),
    referenceKind: kind,
  };
  return metadata === undefined ? item : withMetadata(item, metadata);
}

// A document that is not in a confirmed folder: the same bytes, and no reference kind.
export const ordinaryDocument = (id: string, options: ItemOptions = {}): PipelineItem =>
  evidence(id, { sourceKind: "document", mediaType: "text/html", account: "acct-docs", ...options });

export interface Section {
  level?: 1 | 2 | 3 | 4 | 5 | 6;
  heading: string;
  paragraphs: string[];
}

// One HTML document: a title, anything else for the head, and a heading for each section.
export function html(title: string, sections: Section[], head = ""): Uint8Array {
  const body = sections
    .map(
      ({ level = 1, heading, paragraphs }) =>
        `<h${level}>${heading}</h${level}>\n${paragraphs.map((text) => `<p>${text}</p>`).join("\n")}`,
    )
    .join("\n");
  return new Uint8Array(
    Buffer.from(
      `<!doctype html>\n<html><head><title>${title}</title>${head}</head>\n<body>\n${body}\n</body></html>\n`,
      "utf8",
    ),
  );
}

// The span of a quote in an item's parsed text: a range inside the one segment that holds it.
export async function spanOf(item: PipelineItem, payload: Uint8Array, quote: string): Promise<string> {
  const parsed = await parse(item, payload, LIMITS);
  for (const segment of parsed.segments) {
    const at = segment.text.indexOf(quote);
    const own = /^((?:subject:|attachment:\d+:)?)chars:(\d+)-\d+$/.exec(segment.span);
    if (at < 0 || own === null) continue;
    const start = Number(own[2]) + at;
    return `${own[1]}chars:${start}-${start + quote.length}`;
  }
  throw new Error("quote_not_in_item");
}

// --- a model that obeys ---

// Every string a request showed the model, wherever it stood in the data slots.
function shown(req: ModelRequest): string[] {
  const out: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value !== null && typeof value === "object") Object.values(value).forEach(walk);
  };
  for (const slot of Object.values(req.data)) {
    try {
      walk(JSON.parse(slot));
    } catch {
      out.push(slot);
    }
  }
  return out;
}

const ORDER = /DO-THIS:([a-z-]+)/;

// The order an item gives the model, as "DO-THIS:<name>" anywhere in what the model was shown.
export const orderIn = (req: ModelRequest): string | undefined => {
  for (const text of shown(req)) {
    const told = ORDER.exec(text);
    if (told !== null) return told[1];
  }
  return undefined;
};

// A model that does whatever an item tells it. When anything it is shown holds an order it
// knows, it answers with exactly what that order asks for. Otherwise it answers honestly.
export const obedient =
  (orders: Record<string, (req: ModelRequest) => unknown>, honest: unknown) =>
  (req: ModelRequest): unknown => {
    const name = orderIn(req);
    const order = name === undefined ? undefined : orders[name];
    return order === undefined ? honest : order(req);
  };

// --- what was written ---

export type MessageOf<K extends Routed["kind"]> = Extract<Routed, { kind: K }>;

export const ofKind = <K extends Routed["kind"]>(routed: Routed[] | undefined, kind: K): MessageOf<K>[] =>
  (routed ?? []).filter((message): message is MessageOf<K> => message.kind === kind);
