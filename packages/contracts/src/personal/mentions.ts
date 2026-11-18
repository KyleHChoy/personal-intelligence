import { z } from "zod";
import { EntityId, MentionId } from "./ids.ts";
import { Hex64 } from "./primitives.ts";
import { FactType, UntrustedString } from "./tools-args.ts";

// A name mention no one resolved, filed with its item's commit, and what the owner lists to bind one. A
// filed mention is never a claim and no client reads it.

// The field a subject's mention stands in; an entity field's mention is filed under its own name.
export const MENTION_FIELD = "subject";

export const FiledMention = z.strictObject({
  name: z.string().min(1).max(200),
  type: FactType,
  field: z.string().regex(/^[a-z][a-z_]{0,39}$/),
  firstHand: z.boolean().optional(),
  subjectFp: Hex64.optional(),
  speakerFp: Hex64.optional(),
});
export type FiledMention = z.infer<typeof FiledMention>;

// One row of `pi identity mentions`: a filed name in one item, once with how many of its mentions it
// stands for, and one person an alias of whose under the item's compartment has that name's
// fingerprint. The name is for the owner's terminal alone.
export const MentionCandidate = z.strictObject({
  mention: MentionId,
  count: z.number().int().min(1),
  entity: EntityId,
  established: z.boolean(),
  type: FactType,
  field: z.string().regex(/^[a-z][a-z_]{0,39}$/),
  name: UntrustedString,
});
export type MentionCandidate = z.infer<typeof MentionCandidate>;
