import { KeyId, KeyRef, type Label, type RawItem } from "@intelligence/contracts";
import { PipelineError } from "../claim-pipeline/errors.ts";
import type { PipelineItem } from "../claim-pipeline/ports.ts";
import { sha256 } from "../hash.ts";
import { THE_OWNER } from "../owner.ts";
import { ownerSent } from "./bulk.ts";
import { eventOf, isOwnerAddress, readEvent } from "./events.ts";
import type { ItemContext, ItemMembers } from "./types.ts";

// The stored item the shared parse, readHeaders and interactionFor take, built in memory for
// one raw item. Its label and key are sentinels those functions never read. They are never
// stored, logged or sent, and the label verifies under no key, so no claim can be made from it.

const UNSIGNED = KeyId.parse("personal-unsigned");
export const UNSEALED = KeyRef.parse("personal-unsealed");

const sentinelLabel = (label: Label, evidenceId: PipelineItem["id"]): PipelineItem["label"] => ({
  label,
  vault: "personal",
  evidenceId,
  keyId: UNSIGNED,
  signature: "unsigned",
});

// A lane's stored item, one the owner alone is on, built in memory from what it read.
export const memoryItem = (
  item: Pick<
    PipelineItem,
    "id" | "sourceKind" | "sourceAccount" | "revision" | "contentHash" | "mediaType" | "observedAt" | "ingestedAt"
  > & { compartments: readonly string[] },
): PipelineItem => ({
  id: item.id,
  vault: "personal",
  sourceKind: item.sourceKind,
  sourceAccount: item.sourceAccount,
  revision: item.revision,
  contentHash: item.contentHash,
  mediaType: item.mediaType,
  observedAt: item.observedAt,
  ingestedAt: item.ingestedAt,
  label: sentinelLabel({ compartments: [...item.compartments], readers: [THE_OWNER] }, item.id),
  keyRef: UNSEALED,
  systemOriginated: false,
  payloadState: "present",
  changeKind: "live",
  participantMembers: [THE_OWNER],
});

// The payload's bytes, as the connector handed them over.
export const payloadOf = (raw: RawItem): Uint8Array => new Uint8Array(Buffer.from(raw.payload, "base64"));

// The label of everything one item's reading read: its account's compartment, and the owner.
export const labelOf = (ctx: ItemContext): Label => ({ compartments: [ctx.compartment], readers: [THE_OWNER] });

// An event that cannot be read has only its organizer's address, as the connector wrote it.
function ownerOrganizes(raw: RawItem, ctx: ItemContext): boolean {
  try {
    return readEvent(eventOf(payloadOf(raw)), ctx.ownerAddresses).participants.some(
      (one) => one.owner && one.role === "organizer",
    );
  } catch (error) {
    if (!(error instanceof PipelineError) || error.code !== "parse_failed") throw error;
    return raw.sender !== undefined && isOwnerAddress(raw.sender, ctx.ownerAddresses);
  }
}

// Outbound means Gmail's label, never From: an owner address in From without SENT is a header's
// claim, not Gmail's record, so that message is inbound.
export function membersOf(raw: RawItem, ctx: ItemContext): ItemMembers {
  const sends = raw.sourceKind === "calendar" ? ownerOrganizes(raw, ctx) : ownerSent(raw);
  return { participantMembers: [THE_OWNER], ...(sends ? { senderMember: THE_OWNER } : {}) };
}

export function pipelineItemOf(raw: RawItem, ctx: ItemContext): PipelineItem {
  return {
    id: ctx.evidenceId,
    vault: "personal",
    sourceKind: raw.sourceKind,
    sourceAccount: raw.sourceAccount,
    revision: ctx.revision,
    contentHash: sha256(payloadOf(raw)),
    mediaType: raw.mediaType,
    observedAt: raw.observedAt,
    ingestedAt: raw.observedAt,
    label: sentinelLabel(labelOf(ctx), ctx.evidenceId),
    keyRef: UNSEALED,
    ...(raw.referenceKind === undefined ? {} : { referenceKind: raw.referenceKind }),
    ...(raw.reference === undefined ? {} : { reference: raw.reference }),
    systemOriginated: false,
    payloadState: "present",
    changeKind: raw.changeKind,
    ...membersOf(raw, ctx),
  };
}
