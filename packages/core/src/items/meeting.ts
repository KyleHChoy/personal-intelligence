import type { InteractionRecord, LocalEntityId, Mention, Timestamp } from "@intelligence/contracts";
import { PipelineError } from "../claim-pipeline/errors.ts";
import { resolutionRequestId } from "../limits.ts";
import { THE_OWNER } from "../owner.ts";
import type { EventFacts, ItemContext } from "./types.ts";

// Every participant that is not the owner is resolved through the identity port, as the shared code
// resolves a header's addresses.

type Meeting = {
  record: InteractionRecord;
  participants: { entity: LocalEntityId; role: "organizer" | "participant" }[];
  names: { entity: LocalEntityId; name: string }[];
};

export async function meetingRecord(facts: EventFacts, ctx: ItemContext, observedAt: Timestamp): Promise<Meeting> {
  const participants: Meeting["participants"] = [];
  const names: Meeting["names"] = [];
  try {
    for (const [index, one] of facts.participants.entries()) {
      if (one.owner) continue;
      const mention: Mention = { key: { kind: "address", value: one.person.address }, observedAt };
      const resolution = await ctx.identity.resolve(mention, "people", resolutionRequestId(ctx, "participant", index));
      if (resolution.outcome !== "linked" && resolution.outcome !== "created") continue;
      const { entity } = resolution;
      if (entity === ctx.ownerEntity) continue;
      if (!participants.some((known) => known.entity === entity))
        participants.push({ entity, role: one.role === "organizer" ? "organizer" : "participant" });
      const { name } = one.person;
      if (name !== undefined && !names.some((known) => known.entity === entity && known.name === name))
        names.push({ entity, name });
    }
  } catch {
    // The port's own error could name an address, so it is dropped.
    throw new PipelineError("control_unavailable");
  }

  const organizes = facts.participants.some((one) => one.owner && one.role === "organizer");
  return {
    record: {
      evidenceId: ctx.evidenceId,
      occurredAt: facts.startsAt ?? observedAt,
      channel: "calendar",
      direction: "meeting",
      ...(organizes ? { sender: THE_OWNER } : {}),
      teamRecipients: facts.participants.some((one) => one.owner) ? [THE_OWNER] : [],
      participants: participants.map((one) => one.entity),
    },
    participants,
    names,
  };
}
