import { z } from "zod";
import { Timestamp } from "../ids.ts";
import { MessageId, RulingId } from "./ids.ts";
import { TieRelation } from "./people-ties.ts";
import { UntrustedString } from "./tools-args.ts";
import { Who } from "./tools-views.ts";
import { Tier, WarmthLine } from "./warmth.ts";

const count = z.number().int().nonnegative();

// A chat line has no words and opens nothing, so it is a time alone.
export const PersonPanelLead = z.strictObject({
  tie: TieRelation.nullable(),
  lastContact: z.enum(["message", "meeting", "chat"]).nullable(),
  lastThread: z.strictObject({ message: MessageId, at: Timestamp, subject: UntrustedString.nullable() }).nullable(),
  lastChat: Timestamp.nullable(),
  lastMeeting: z
    .strictObject({ meeting: z.string().min(1).max(80), at: Timestamp, title: UntrustedString.nullable() })
    .nullable(),
});
export type PersonPanelLead = z.infer<typeof PersonPanelLead>;
export const PersonPanel = z.strictObject({
  who: Who,
  warmth: WarmthLine.nullable(),
  ruledTier: Tier.nullable(),
  commitments: z.strictObject({ owedByOwner: count, owedToOwner: count }),
  lead: PersonPanelLead,
  identityRulings: z.array(RulingId),
  ignoreRuling: RulingId.nullable(),
  // The owner's name for them in force, the ruling that gave it; null when they are named by their
  // aliases.
  nameRuling: RulingId.nullable(),
});
export type PersonPanel = z.infer<typeof PersonPanel>;
