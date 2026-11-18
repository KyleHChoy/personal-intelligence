import { z } from "zod";

// Shapes the store seals and opens again. A sealed value is the system's own writing, but it is
// read back through a decryption and a JSON parse, so each read checks it against its shape
// rather than trusting a cast; one that fails is a stored value that does not open.

// What `knowledge.messages.facts_enc` holds (the writer's `sealedFacts`): counts, the unreadable
// mark and the attachments' metadata, and a sender's own two header values when it had them.
export const SealedMessageFacts = z.object({
  chars: z.number().int().nonnegative(),
  unreadable: z.boolean(),
  attachments: z.array(z.object({ name: z.string(), type: z.string(), size: z.number().int().nonnegative() })),
  messageId: z.string().optional(),
  references: z.array(z.string()).optional(),
});
export type SealedMessageFacts = z.infer<typeof SealedMessageFacts>;
