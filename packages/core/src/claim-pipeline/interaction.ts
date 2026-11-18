import {
  type InteractionRecord,
  type LocalEntityId,
  type Mention,
  RequestId,
  Timestamp,
} from "@intelligence/contracts";
import { messageBodyHash } from "@intelligence/contracts/body-hash";
import { PipelineError } from "./errors.ts";
import { sha256 } from "./hash.ts";
import { readHeaders } from "./headers.ts";
import type { Parsed } from "./parse.ts";
import type { PipelineDeps } from "./ports.ts";
import type { ReadItem } from "./read-set.ts";

type InteractionDeps = Pick<PipelineDeps, "extractorGeneration" | "identity">;

// It is what the interaction log is built from. The members on it are those ingest recorded on the
// item, and the pipeline asks no directory: an item with no record of them leaves no interaction
// record, because whether a member sent it would be a guess. None is made for an automated sender,
// which is never a person, or for an item with no sender.
//
// Every address in the headers is resolved through the identity service for the People store,
// as a mention is. One that is no person, is suppressed or is only a candidate is left out.
// An item a member sent is outbound, and its record carries its recipients and the hash of
// its own body, which is how a sent message is later matched to the draft that was cleared.
export async function interactionFor(
  parsed: Parsed,
  own: ReadItem,
  deps: InteractionDeps,
): Promise<InteractionRecord | null> {
  const { item } = own;
  const { participantMembers, senderMember } = item;
  const { sender, recipients, sentAt } = readHeaders(parsed);
  if (participantMembers === undefined || parsed.sourceKind !== "email" || parsed.automated || sender === undefined)
    return null;
  const addressed = [...new Set(recipients)].filter((address) => address !== sender);

  const entities = new Map<string, LocalEntityId>();
  try {
    for (const [index, address] of [sender, ...addressed].entries()) {
      const mention: Mention = { key: { kind: "address", value: address }, observedAt: item.observedAt };
      // Where the address stood in the headers, never what it was.
      const requestId = RequestId.parse(
        sha256([parsed.evidenceId, parsed.revision, deps.extractorGeneration, "header", index]),
      );
      const resolution = await deps.identity.resolve(mention, "people", requestId);
      if (resolution.outcome === "linked" || resolution.outcome === "created") entities.set(address, resolution.entity);
    }
  } catch {
    throw new PipelineError("control_unavailable");
  }

  const sent = Timestamp.safeParse(sentAt);
  const known = (addresses: string[]): LocalEntityId[] => [
    ...new Set(addresses.flatMap((address) => entities.get(address) ?? [])),
  ];
  return {
    evidenceId: item.id,
    // The Date header is the sender's to write. It is taken only when it is a Timestamp, which
    // the store refuses a record without, and is not after the time the item was observed, so
    // a message dated in the future is not the latest there is.
    occurredAt: sent.success && Date.parse(sent.data) <= Date.parse(item.observedAt) ? sent.data : item.observedAt,
    channel: parsed.sourceKind,
    direction: senderMember === undefined ? "inbound" : "outbound",
    ...(senderMember !== undefined && { sender: senderMember }),
    teamRecipients: [...new Set(participantMembers)].filter((member) => member !== senderMember),
    participants: known([sender, ...addressed]),
    ...(senderMember !== undefined && {
      sent: { recipients: known(addressed), bodyHash: await messageBodyHash(parsed.body ?? "") },
    }),
  };
}
