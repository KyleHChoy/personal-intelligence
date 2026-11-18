import { z } from "zod";
import { Fingerprint } from "./ids.ts";

// The Work store's shapes: the project each claim belongs to, and decision threads. A model may
// propose a binding or a thread; work's code checks it.

export const ThreadEntryRole = z.enum(["option", "proposal", "objection", "question", "decision", "reversal"]);
export type ThreadEntryRole = z.infer<typeof ThreadEntryRole>;

// A source structure that ties a claim to a project, by its keyed fingerprint.
export const ProjectAnchor = z.object({
  kind: z.enum(["channel", "email_thread", "crm_deal", "document", "meeting_series"]),
  fp: Fingerprint,
});
export type ProjectAnchor = z.infer<typeof ProjectAnchor>;
