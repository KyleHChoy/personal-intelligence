import { EvidenceId, LocalEntityId, type ParsedItem } from "@intelligence/contracts";
import { SourceAccountId } from "@intelligence/contracts/personal";
import { PipelineError } from "../claim-pipeline/errors.ts";
import { parse, segmentAt } from "../claim-pipeline/parse.ts";
import { PERSONAL_LIMITS } from "../limits.ts";
import { pipelineItemOf } from "./adapter.ts";
import { gmailItem, messageBlock } from "./builders.ts";
import type { GmailMessage, ItemContext } from "./types.ts";

// The passage one fact cites: the whole text of the segment its span falls in. The store keeps a
// message's body and subject, not its bytes, so the message block is written again from them, by
// the builder every message block is written with, and read by the shared parse and segmentAt: no
// rule of the parse is copied. The block's one header is a From of no one, so a quote is credited
// only by an address written in the text, and only the sender's own words are served: a span in a
// quoted or forwarded segment has no passage, as no fact cites one. Where a segment ends inside
// quoted or forwarded text can turn on names only the original's headers gave, so none of it is
// served. Above a quote, an introduction line that names someone only by such a name stays in the
// sender's text: that passage holds the line (two, when the introduction is wrapped) more than the
// segment extraction checked, and never less.

// The texts the store keeps of one message: its body and its subject, each null when it has none.
export type KeptTexts = { body: string | null; subject: string | null };

// Sentinels for the in-memory item, as adapter.ts's: never stored, logged or sent.
const SENDER = "passage@invalid";
const AT = { sourceAccount: SourceAccountId.parse("acc_00000000000000000000000000"), changeKind: "live" } as const;
const CONTEXT: ItemContext = {
  evidenceId: EvidenceId.parse("passage"),
  revision: 0,
  compartment: "passage",
  ownerAddresses: [],
  ownerEntity: LocalEntityId.parse("passage"),
  identity: { resolve: () => Promise.reject(new Error("a passage resolves no one")) },
};

// The segment's text, or null when the span names a text the store does not keep (an
// attachment's), falls in no segment or in a quoted or forwarded one, or the parse refuses the
// texts.
export async function passageOf(texts: KeptTexts, span: string): Promise<string | null> {
  const message: GmailMessage = {
    id: "0",
    threadId: "0",
    internalDate: 0,
    labelIds: [],
    headers: [
      { name: "From", value: SENDER },
      ...(texts.subject === null ? [] : [{ name: "Subject", value: texts.subject }]),
    ],
    ...(texts.body === null ? {} : { text: texts.body }),
  };
  try {
    const parsed = await parse(pipelineItemOf(gmailItem(message, AT), CONTEXT), messageBlock(message), PERSONAL_LIMITS);
    const segment = segmentAt(parsed, span);
    return segment === undefined || segment.quoted ? null : segment.text;
  } catch (error) {
    if (error instanceof PipelineError) return null;
    throw error;
  }
}

// An agent record's passage: the extract lane reads a finding's body as one segment,
// `chars:0-<length>` (the extract package's readRecord), so the passage of a span inside it is
// the whole body, and a span outside it has none.
export function recordPassageOf(body: string, span: string): string | null {
  const parsed: ParsedItem = {
    evidenceId: EvidenceId.parse("passage"),
    revision: 0,
    sourceKind: "research_note",
    automated: false,
    segments: [{ span: `chars:0-${body.length}`, quoted: false, text: body }],
    headers: {},
    replyChainEvidenceIds: [],
  };
  return segmentAt(parsed, span)?.text ?? null;
}
