import { z } from "zod";
import { HttpStatus } from "./extraction.ts";
import {
  AgentRecordId,
  CaptureId,
  CaptureInboxId,
  CardId,
  ClientId,
  ClientName,
  DraftId,
  EntityId,
  ErasureId,
  EventId,
  GoalId,
  Handle,
  HypothesisId,
  IntentId,
  IntentionId,
  MessageId,
  MoveId,
  OpportunityId,
  PersonalEvidenceId,
  ResearchFetchId,
  ResearchRequestId,
  RulingId,
  RunId,
  SentId,
  SessionId,
  SourceAccountId,
  WorkNoticeId,
} from "./ids.ts";
import { MemoryProjectionId } from "./memory.ts";
import { Hex64 } from "./primitives.ts";
import { PersonalTool } from "./tools.ts";

// Lower-case words joined by underscores. A fixed word in code, never taken from data.
const snake = z.string().regex(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/);

// The only thing the personal logger accepts: an event code, ids under their own names, counts, a
// duration and a code. No field takes a free string.
export const PersonalLogEvent = z.strictObject({
  event: snake.max(64),
  ids: z
    .strictObject({
      client: ClientName.optional(),
      entity: EntityId.optional(),
      message: MessageId.optional(),
      event: EventId.optional(),
      account: SourceAccountId.optional(),
      evidence: PersonalEvidenceId.optional(),
      record: AgentRecordId.optional(),
      session: SessionId.optional(),
      card: CardId.optional(),
      ruling: RulingId.optional(),
      erasure: ErasureId.optional(),
      // A reasoner in session mode is given its run as a handle.
      run: RunId.or(Handle).optional(),
      opportunity: OpportunityId.optional(),
      hypothesis: HypothesisId.optional(),
      move: MoveId.optional(),
      intention: IntentionId.optional(),
      goal: GoalId.optional(),
      intent: IntentId.optional(),
      draft: DraftId.optional(),
      send: SentId.optional(),
      projection: MemoryProjectionId.optional(),
      request: ResearchRequestId.optional(),
      fetch: ResearchFetchId.optional(),
      // Lens: a stored capture item, a device's capture client, and an inbox row.
      capture: CaptureId.optional(),
      device: ClientId.optional(),
      inbox: CaptureInboxId.optional(),
      // A work notice the sender delivered or failed.
      notice: WorkNoticeId.optional(),
      // The shadow sampler's fact key as its keyed fingerprint, 64 hex, an id the ledger already
      // keeps in clear; never the fact key itself.
      fact: Hex64.optional(),
    })
    .optional(),
  counts: z.record(snake, z.number().int().nonnegative()).optional(),
  durationMs: z.number().int().nonnegative().optional(),
  code: snake.optional(),
  // The tool an mcp_call was for, one of the fixed names or `unknown`: a name sent is logged only
  // when it matches a tool served, which is the agent API's to decide.
  tool: PersonalTool.or(z.literal("unknown")).optional(),
  // Why an mcp_call was refused, a fixed code the agent API chose (a claim refusal's, a schema
  // issue's, `store`, or a class of a name or method that is no tool or method served); and the
  // refused argument's name, only ever a key of the tool's own schema.
  reason: snake.max(64).optional(),
  argument: z
    .string()
    .regex(/^[a-z][A-Za-z0-9_]*$/)
    .max(64)
    .optional(),
  status: HttpStatus.optional(),
  // `wake`, an extraction run started by the proposal wake; `capture`, a run of one capture item
  // the owner named (`pi extract --capture`).
  source: z.enum(["wake", "capture"]).optional(),
});
export type PersonalLogEvent = z.infer<typeof PersonalLogEvent>;

// Whose budget a model call's usage counts against.
export type UsageLane = "extract" | "dream";

export type PersonalLogger = {
  info(e: PersonalLogEvent): void;
  warn(e: PersonalLogEvent): void;
  error(e: PersonalLogEvent): void;
};
