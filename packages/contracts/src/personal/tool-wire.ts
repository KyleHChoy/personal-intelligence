import type { z } from "zod";
import { AboutArgs } from "./about.ts";
import { AboutView } from "./about-view.ts";
import {
  AnswerOwnerQuestionAck,
  AnswerOwnerQuestionArgs,
  AnswerOwnerQuestionPublished,
  ProposeAboutYouAck,
  ProposeAboutYouArgs,
  ProposeAboutYouPublished,
} from "./about-you.ts";
import { AgentRecordAck, AgentRecordArgs, RecordFind, RecordRead, RecordReads } from "./agent-records.ts";
import { PushCaptureAck, PushCaptureArgs } from "./capture-push.ts";
import {
  CloseCommitmentAck,
  CloseCommitmentArgs,
  ReopenCommitmentAck,
  ReopenCommitmentArgs,
} from "./commitment-close.ts";
import { ContextView } from "./context.ts";
import { EvidenceSpan, PathList, ThreadView } from "./evidence-reads.ts";
import { GoalList } from "./goals.ts";
import { ImportMemoryAck, ImportMemoryArgs, MemoryProjection, SyncMemoryArgs } from "./memory.ts";
import { MirrorPage } from "./mirror.ts";
import { GetOpenItemsArgs, OpenItems } from "./open-items.ts";
import { BeliefList, CommitmentList, ContextPack, EntityView } from "./packs.ts";
import { SelfView } from "./packs-self.ts";
import { ProposePersonAck, ProposePersonArgs, ProposePersonPublished } from "./people-proposals.ts";
import { SuggestionList } from "./requests.ts";
import { DraftMessageArgs, DraftMessageResult } from "./send.ts";
import { ChangesView, GetChangesArgs } from "./signals.ts";
import {
  type PersonalCaptureTool,
  PersonalReadTool,
  PersonalRunTool,
  PersonalWorkTool,
  type PersonalWriteTool,
  type ToolName,
} from "./tools.ts";
import {
  BuildContextPackArgs,
  ContextArgs,
  FetchTemplateArgs,
  FindDocumentsArgs,
  FindFactsArgs,
  FindMessagesArgs,
  FindPathsArgs,
  FindRecordsArgs,
  GetBeliefsArgs,
  GetCommitmentsArgs,
  GetDocumentArgs,
  GetEntityArgs,
  GetEvidenceSpanArgs,
  GetSelfArgs,
  GetSuggestionsArgs,
  GetTimelineArgs,
  ListGoalsArgs,
  NotBuiltArgs,
  NotBuiltResult,
  ReadItemArgs,
  ReadMessageArgs,
  ReadRecordArgs,
  RecordReadsArgs,
  SearchArgs,
  SyncMirrorArgs,
} from "./tools-args.ts";
import {
  DocumentList,
  DocumentView,
  FactList,
  MessageList,
  MessageView,
  SearchResult,
  TemplateView,
  TimelineView,
} from "./tools-views.ts";
import { ListPeopleArgs, PeopleList } from "./warmth.ts";
import { PersonalWorkArgs, PersonalWorkResults } from "./work.ts";

// Each served tool on the wire: its arguments, its strict result and, for a tool that still takes
// deprecated keys, the schema tools/list sends in place of the one that parses. The ports
// (tool-ports.ts), the agent API's tools and the test fakes are built from these rows. Only index.ts
// re-exports this file, and tool-ports.ts imports its types; no other contracts module imports it, since it imports every result.

export type ToolWire = { args: z.ZodType; result: z.ZodType; published?: z.ZodType };

// The port method that serves a tool: its name in camel case.
export type MethodOf<T extends string> = T extends `${infer Head}_${infer Rest}`
  ? `${Head}${Capitalize<MethodOf<Rest>>}`
  : T;
export const methodOf = <T extends string>(tool: T): MethodOf<T> =>
  tool.replace(/_([a-z])/g, (_all, letter: string) => letter.toUpperCase()) as MethodOf<T>;

export const READ_TOOL_WIRE = Object.freeze({
  get_self: { args: GetSelfArgs, result: SelfView },
  search: { args: SearchArgs, result: SearchResult },
  get_entity: { args: GetEntityArgs, result: EntityView },
  get_timeline: { args: GetTimelineArgs, result: TimelineView },
  find_messages: { args: FindMessagesArgs, result: MessageList },
  read_message: { args: ReadMessageArgs, result: MessageView },
  find_facts: { args: FindFactsArgs, result: FactList },
  build_context_pack: { args: BuildContextPackArgs, result: ContextPack },
  get_commitments: { args: GetCommitmentsArgs, result: CommitmentList },
  sync_memory: { args: SyncMemoryArgs, result: MemoryProjection },
  find_documents: { args: FindDocumentsArgs, result: DocumentList },
  get_document: { args: GetDocumentArgs, result: DocumentView },
  get_evidence_span: { args: GetEvidenceSpanArgs, result: EvidenceSpan },
  read_item: { args: ReadItemArgs, result: ThreadView },
  get_decision_history: { args: NotBuiltArgs, result: NotBuiltResult },
  find_paths: { args: FindPathsArgs, result: PathList },
  fetch_template: { args: FetchTemplateArgs, result: TemplateView },
  get_suggestions: { args: GetSuggestionsArgs, result: SuggestionList },
  get_beliefs: { args: GetBeliefsArgs, result: BeliefList },
  sync_mirror: { args: SyncMirrorArgs, result: MirrorPage },
  list_goals: { args: ListGoalsArgs, result: GoalList },
  context: { args: ContextArgs, result: ContextView },
  record_reads: { args: RecordReadsArgs, result: RecordReads },
  list_people: { args: ListPeopleArgs, result: PeopleList },
  about: { args: AboutArgs, result: AboutView },
  read_record: { args: ReadRecordArgs, result: RecordRead },
  find_records: { args: FindRecordsArgs, result: RecordFind },
  get_open_items: { args: GetOpenItemsArgs, result: OpenItems },
  get_changes: { args: GetChangesArgs, result: ChangesView },
} satisfies Record<PersonalReadTool, ToolWire>);

// Each read tool's strict argument schema. The table is frozen; a schema in it is not, because the
// schema library sets a schema's methods on first use.
export const PersonalToolArgs = Object.freeze(
  Object.fromEntries(PersonalReadTool.options.map((name) => [name, READ_TOOL_WIRE[name].args])),
) as { readonly [K in PersonalReadTool]: (typeof READ_TOOL_WIRE)[K]["args"] };

// What the provider serves besides the reads.
export const WRITE_TOOL_WIRE = Object.freeze({
  record: { args: AgentRecordArgs, result: AgentRecordAck },
  propose_about_you: { args: ProposeAboutYouArgs, result: ProposeAboutYouAck, published: ProposeAboutYouPublished },
  import_memory: { args: ImportMemoryArgs, result: ImportMemoryAck },
  answer_owner_question: {
    args: AnswerOwnerQuestionArgs,
    result: AnswerOwnerQuestionAck,
    published: AnswerOwnerQuestionPublished,
  },
  propose_person: { args: ProposePersonArgs, result: ProposePersonAck, published: ProposePersonPublished },
  close_commitment: { args: CloseCommitmentArgs, result: CloseCommitmentAck },
  reopen_commitment: { args: ReopenCommitmentArgs, result: ReopenCommitmentAck },
  push_capture: { args: PushCaptureArgs, result: PushCaptureAck },
} satisfies Record<PersonalWriteTool | PersonalCaptureTool, ToolWire>);

type WorkName = PersonalWorkTool | PersonalRunTool;
const WORK_ROWS = Object.fromEntries(
  [...PersonalWorkTool.options, ...PersonalRunTool.options].map((name) => [
    name,
    { args: PersonalWorkArgs[name], result: PersonalWorkResults[name] },
  ]),
) as { [K in WorkName]: { args: (typeof PersonalWorkArgs)[K]; result: (typeof PersonalWorkResults)[K] } };

// What the work port serves: the work and run tools, whose rows are PersonalWorkArgs' and
// PersonalWorkResults', and the one propose tool served.
export const WORK_TOOL_WIRE = Object.freeze({
  ...WORK_ROWS,
  draft_message: { args: DraftMessageArgs, result: DraftMessageResult },
});

// Every served tool's row: a tool with none does not compile.
export const TOOL_WIRE = Object.freeze({
  ...READ_TOOL_WIRE,
  ...WRITE_TOOL_WIRE,
  ...WORK_TOOL_WIRE,
} satisfies Record<ToolName, ToolWire>);

// A key of a tool's arguments, whichever shape a call of it takes.
type KeysOf<T> = T extends unknown ? keyof T & string : never;
export type ToolArgKey<T extends ToolName> = KeysOf<z.input<(typeof TOOL_WIRE)[T]["args"]>>;

// Whether a tool's call reaches the work port, not the provider.
export const onWorkPort = (tool: ToolName): boolean => Object.hasOwn(WORK_TOOL_WIRE, tool);
