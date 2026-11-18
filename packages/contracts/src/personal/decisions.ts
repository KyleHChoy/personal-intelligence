import { z } from "zod";
import { Timestamp } from "../ids.ts";
import { AgentRecordId, ClientName, Handle } from "./ids.ts";
import { UntrustedString } from "./tools-args.ts";

// A decision record as get_decision_history and the project brief serve it: something an agent
// wrote and nobody checked.
export const DecisionRecordView = z.strictObject({
  id: AgentRecordId.or(Handle),
  client: ClientName,
  at: Timestamp,
  question: UntrustedString,
  chosen: UntrustedString,
  alternatives: z.array(UntrustedString),
  reasoning: UntrustedString.nullable(),
  expectation: UntrustedString.nullable(),
  reviewAt: Timestamp.nullable(),
  removed: z.boolean(),
  provenance: z.literal("agent_reported"),
});
export type DecisionRecordView = z.infer<typeof DecisionRecordView>;
