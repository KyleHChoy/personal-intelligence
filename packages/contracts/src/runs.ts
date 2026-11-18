import { z } from "zod";
import { ClaimId, EvidenceId, Handle, ResearchTemplateId, Timestamp } from "./ids.ts";
import { OutcomeCheck, PartyRole } from "./ledger.ts";
import { PublicIdentifier } from "./research.ts";

// The ledger's records that hold a campaign goal, a citation, a tool, a decision point or model
// usage: what wakes a run, the run request, and what a run appends. They are here and not in
// ledger.ts because tools.ts and models.ts read ledger.ts, and this file reads them.

// --- what wakes a run ---

// --- a run ---

// --- what the reasoner's model proposes ---

const probability = z.number().min(0).max(1);
const span = z.string().min(1);
const research = z
  .array(z.strictObject({ template: ResearchTemplateId, identifiers: z.array(PublicIdentifier).min(1) }))
  .max(5);

// What the agent loop's final turn proposes. No label, destination, side, store, member or
// quote: code sets each of those, and takes each quote from the tool
// results the run read. A candidate's parties are handles and its texts' recipients positions
// in parties; a record is a DecisionRecord without id, runId and label, its reasoning given as
// evidence id and span. A turn that makes tool calls has no output, so the schema takes null.
export const ReasonerOutput = z
  .discriminatedUnion("decision", [
    z.strictObject({
      decision: z.literal("stay_silent"),
      reason: z.enum(["no_candidate", "below_bar", "waiting_is_better"]),
      research: research.optional(),
    }),
    z.strictObject({
      decision: z.literal("propose"),
      candidates: z
        .array(
          z.strictObject({
            parties: z
              .array(z.strictObject({ entity: Handle, role: PartyRole }))
              .min(1)
              .max(10),
            support: z.array(z.strictObject({ claimId: ClaimId, evidenceId: EvidenceId, span })).min(1),
            prediction: z.strictObject({ check: OutcomeCheck, probability }),
            probabilityIfWaiting: probability,
            texts: z.array(
              z.strictObject({
                kind: z.enum(["introduction", "invitation"]),
                recipients: z.array(z.number().int().nonnegative()).min(1),
                text: z.string().min(1).max(4000),
              }),
            ),
          }),
        )
        .min(1)
        .max(10),
      research: research.optional(),
    }),
    z.strictObject({
      decision: z.literal("record_decisions"),
      records: z
        .array(
          z.strictObject({
            project: Handle,
            threadId: z.string().min(1),
            decision: ClaimId,
            reasoning: z.array(z.strictObject({ evidenceId: EvidenceId, span })),
            alternatives: z.array(ClaimId),
            expectation: ClaimId.optional(),
            owner: Handle.optional(),
            checkBackAt: Timestamp.optional(),
          }),
        )
        .min(1)
        .max(20),
    }),
  ])
  .nullable();
export type ReasonerOutput = z.infer<typeof ReasonerOutput>;

// --- appending to the ledger ---
