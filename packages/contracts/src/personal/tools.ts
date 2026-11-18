// The tools by family and what a tool's name alone decides: a read tool's view, budget and
// compaction, the view any tool needs, and which tools a program calls. It imports nothing downstream,
// so any module may read a name from it and the unions below close no import cycle. tool-wire.ts
// gives each served tool its arguments and result.
import { z } from "zod";
import type { PersonalView } from "./subjects.ts";

// The budget a read tool is checked against. A text tool serves the text of an item it was asked for
// by id, and is checked against items, code points and calls; every other read tool is a list, checked
// against rows and calls.
export const ReadBudget = z.enum(["text", "list"]);
export type ReadBudget = z.infer<typeof ReadBudget>;

// What a path of a compacted result holds (compact.ts): a belief (a CompiledBelief), a commitment's
// BeliefItem, a fact (a FactView), a pack item (a PackItem), or a belief line (a BeliefLine). A
// belief's cites are its own: each is a fact, or a held cite, which its `held` says.
export type CompactShape = "belief" | "commitment" | "fact" | "item" | "line";
// `compact`: the paths of a result's beliefs, facts and pack items, keys joined by "." and a list's
// elements as "[]"; left out, the result holds none, and only what every result leaves out goes.
// false: the strict form is sent, for a result a program reads or one nothing serves yet.
type ReadRow = { view: PersonalView; budget: ReadBudget; compact?: Readonly<Record<string, CompactShape>> | false };

// One row per read tool. tool-wire.ts gives each its arguments and result.
export const READ_TOOLS = Object.freeze({
  get_self: {
    view: "self",
    budget: "list",
    compact: { "sections[].lines[]": "line", "housekeeping.lines[]": "line" },
  },
  search: { view: "people", budget: "list", compact: { "matches[].fact": "fact" } },
  get_entity: {
    view: "people",
    budget: "list",
    compact: { "facts.beliefs[]": "belief", "facts.claims[]": "fact", "lines[]": "line" },
  },
  get_timeline: { view: "people", budget: "list", compact: { "entries[].fact": "fact" } },
  find_messages: { view: "people", budget: "list" },
  read_message: { view: "people", budget: "text" },
  find_facts: { view: "work", budget: "list", compact: { "facts[]": "fact" } },
  build_context_pack: {
    view: "self",
    budget: "list",
    compact: { "items[]": "item", "items[].belief": "belief", "items[].commitment.belief": "commitment" },
  },
  get_commitments: { view: "work", budget: "list", compact: { "commitments[].belief": "commitment" } },
  // Each section of the memory template needs its own view as well; one the client lacks is left
  // out of the projection, never refused.
  sync_memory: { view: "self", budget: "list", compact: false },
  find_documents: { view: "work", budget: "list" },
  get_document: { view: "work", budget: "text" },
  get_evidence_span: { view: "people", budget: "text" },
  read_item: { view: "people", budget: "text" },
  get_decision_history: { view: "work", budget: "list", compact: false },
  find_paths: { view: "people", budget: "list" },
  fetch_template: { view: "work", budget: "text" },
  get_suggestions: { view: "work", budget: "list" },
  get_beliefs: { view: "people", budget: "list", compact: { "beliefs[]": "belief" } },
  sync_mirror: { view: "self", budget: "list", compact: false },
  // The goals the owner set with `pi goal add` for work: every tool that names a goal id
  // (list_opportunities, propose_hypothesis, propose_opportunity) needs the work view.
  list_goals: { view: "work", budget: "list" },
  // Each other part also needs its own view (people for the cards, work for commitments and goals):
  // one the client lacks is left out, never refused.
  context: {
    view: "self",
    budget: "list",
    compact: { "sections[].lines[]": "line", "people[].lines[]": "line", "commitments[].belief": "commitment" },
  },
  // Who was shown the caller's own records, the view the notes section needs.
  record_reads: { view: "self", budget: "list" },
  // The caller's audience's people by warmth tier.
  list_people: { view: "people", budget: "list" },
  // A person or an organization, the whole picture.
  about: { view: "people", budget: "list" },
  // Agent records read back, the view the notes section needs. A project filter needs work too.
  read_record: { view: "self", budget: "list" },
  find_records: { view: "self", budget: "list" },
  get_open_items: { view: "self", budget: "list" },
  // What changed since this client last read: typed signals and what agents wrote back.
  get_changes: { view: "self", budget: "list" },
} satisfies Record<string, ReadRow>);

const READ_TOOL_NAMES = Object.keys(READ_TOOLS) as [keyof typeof READ_TOOLS, ...(keyof typeof READ_TOOLS)[]];
export const PersonalReadTool = z.enum(READ_TOOL_NAMES);
export type PersonalReadTool = z.infer<typeof PersonalReadTool>;

// The write tools. close_commitment and reopen_commitment are an agent's close of a commitment and
// the reopening of its own.
export const PersonalWriteTool = z.enum([
  "record",
  "propose_about_you",
  "import_memory",
  "answer_owner_question",
  "propose_person",
  "close_commitment",
  "reopen_commitment",
]);
export type PersonalWriteTool = z.infer<typeof PersonalWriteTool>;

// The work tools, which any client of kind agent may hold, and the run tools, which only a client
// of kind reasoner may hold.
export const PersonalWorkTool = z.enum([
  "list_opportunities",
  "claim_opportunity",
  "release_opportunity",
  "propose_hypothesis",
  "record_test",
  "propose_opportunity",
  "plan_move",
  "report_move",
  "set_intention",
  // Read-only work for another agent, and a task given to another role.
  "propose_task",
  "hand_off",
  // A goal or a goal change, a card for the owner.
  "propose_goal",
  // The person or organization a goal is after, a card for the owner.
  "propose_goal_target",
  // Agents write to each other, and file what is wrong with the system itself.
  "post_agent_message",
  "read_agent_inbox",
  "submit_improvement",
  "list_improvements",
  "update_improvement",
  // The system's health, in ids, counts and codes.
  "get_health",
  // An agent's seen on a box health card that needs nothing of the owner.
  "mark_health_seen",
  // What an agent learned about the tools and ways of working, for every agent of its scope; the
  // owner sees and vetoes each.
  "file_learning",
  // The tunable numbers the code registers, and an agent's change to one inside its range.
  "list_levers",
  "set_lever",
  // Projects, which an agent may create and update; the owner's word outranks an agent's on each.
  "propose_project",
  "update_project",
  "list_projects",
  "list_ideas",
  "get_project",
  // Work time by place, and an agent's anchors and rulings that sort it into projects.
  "get_work_time",
  // A recorded meeting's transcript and the owner's typed notes.
  "read_meeting",
  "set_anchor",
  "lift_anchor",
  "rule_time",
  "lift_time_ruling",
  "judge_time_proposal",
  // What an agent says happened on a signal or an item: its record, never knowledge.
  "write_back",
  // An agent's report that one person's addresses are two people's: a proposal, split when a second
  // agent names the same split.
  "report_wrong_merge",
  // An agent's report that a model's relation in effect is wrong: it counts against its kind only when
  // a second agent or the second model's later check agrees.
  "report_wrong_relation",
  // What the owner answered a card with, given to the agent in conversation. Never a default: the owner
  // grants it with the question role.
  "relay_card_answer",
  // What an agent loop on the box spent on its model. Never a default: only the outcome test's
  // registration lists it.
  "record_spend",
  // The weekly outcome test. Never a default: only its own client's registration lists them.
  "start_outcome_test",
  "record_held_out_question",
  "record_outcome_task",
]);
export type PersonalWorkTool = z.infer<typeof PersonalWorkTool>;

export const PersonalRunTool = z.enum(["next_run", "append_step", "finish_run"]);
export type PersonalRunTool = z.infer<typeof PersonalRunTool>;

// The propose tool, inert until the owner accepts it.
export const PersonalProposeTool = z.enum(["draft_message"]);
export type PersonalProposeTool = z.infer<typeof PersonalProposeTool>;

// The research tool: a tool of its own kind. It files a request
// that raises a card; its arguments are research.ts's ResearchArgs.
const PersonalResearchTool = z.enum(["request_research"]);
type PersonalResearchTool = z.infer<typeof PersonalResearchTool>;

// Lens's capture tool: a client of kind device holds it and nothing else.
export const PersonalCaptureTool = z.enum(["push_capture"]);
export type PersonalCaptureTool = z.infer<typeof PersonalCaptureTool>;

// Every tool a registration may list.
export const PersonalTool = z.enum([
  ...PersonalReadTool.options,
  ...PersonalWriteTool.options,
  ...PersonalWorkTool.options,
  ...PersonalRunTool.options,
  ...PersonalProposeTool.options,
  ...PersonalResearchTool.options,
  ...PersonalCaptureTool.options,
]);
export type PersonalTool = z.infer<typeof PersonalTool>;

// Every tool served, whether or not a client is offered it, in the order tools/list gives them. The
// type comes from this list, so a family left out of it is no tool anywhere.
export const TOOL_NAMES = Object.freeze([
  ...PersonalReadTool.options,
  ...PersonalWriteTool.options,
  ...PersonalWorkTool.options,
  ...PersonalRunTool.options,
  ...PersonalProposeTool.options,
  ...PersonalCaptureTool.options,
]);
export type ToolName = (typeof TOOL_NAMES)[number];

// The view each read tool needs, from its row in READ_TOOLS.
export const TOOL_VIEW: Readonly<Record<PersonalReadTool, PersonalView>> = Object.freeze(
  Object.fromEntries(PersonalReadTool.options.map((name) => [name, READ_TOOLS[name].view])),
) as Record<PersonalReadTool, PersonalView>;

export const READ_BUDGET: Readonly<Record<PersonalReadTool, ReadBudget>> = Object.freeze(
  Object.fromEntries(PersonalReadTool.options.map((name) => [name, READ_TOOLS[name].budget])),
) as Record<PersonalReadTool, ReadBudget>;

// The work tools that read, and the read budget each spends as a read tool of that class does: checked
// before their work, refused with the window spent. Every other work tool spends none.
export const WORK_READ_BUDGET: Readonly<Partial<Record<PersonalWorkTool, ReadBudget>>> = Object.freeze({
  list_projects: "list",
  get_project: "list",
  get_work_time: "list",
  read_meeting: "text",
});
// Every tool whose calls a read budget counts, as policy.tool_names marks them `read`.
export const BUDGETED_TOOLS: readonly (PersonalReadTool | PersonalWorkTool)[] = Object.freeze([
  ...PersonalReadTool.options,
  ...(Object.keys(WORK_READ_BUDGET) as PersonalWorkTool[]),
]);

// The one view every work and run tool needs.
export const WORK_TOOL_VIEW: PersonalView = "work";
// The research tool's view: a request names a person or an organization, or a message. TOOL_VIEW
// stays over the read tools.
export const RESEARCH_TOOL_VIEW: Readonly<Record<PersonalResearchTool, PersonalView>> = Object.freeze({
  request_research: "people",
});
// The view of the send proxy's tool, as WORK_TOOL_VIEW is the work tools'.
export const SEND_TOOL_VIEW: Readonly<Record<PersonalProposeTool, PersonalView>> = Object.freeze({
  draft_message: "work",
});

// The view a tool needs: a read tool's own, the send proxy's and the research tool's, `work` for
// every other work or run tool, and none for a write or a capture.
export function toolView(tool: PersonalTool): PersonalView | null {
  if (Object.hasOwn(READ_TOOLS, tool)) return TOOL_VIEW[tool as PersonalReadTool];
  if (tool === "draft_message") return SEND_TOOL_VIEW[tool];
  if (tool === "request_research") return RESEARCH_TOOL_VIEW[tool];
  return PersonalWriteTool.safeParse(tool).success || PersonalCaptureTool.safeParse(tool).success
    ? null
    : WORK_TOOL_VIEW;
}

// The tools a program calls, never an agent (Lens, the memory adapter, the reasoner's run loop):
// refused with the code and an invalid_request's arguments, and no hint, and not listed to an agent
// that works the board unless it asks.
export const PROGRAM_TOOLS: readonly string[] = Object.freeze([
  "push_capture",
  "sync_mirror",
  "import_memory",
  "sync_memory",
  "start_outcome_test",
  "record_held_out_question",
  "record_outcome_task",
  ...PersonalRunTool.options,
]);

// The calls whose prose the owner does not read, so an id in it is no one's to see: agent-to-agent
// mail, the improvement store, what the outcome test keeps, and a program's. Every other write,
// work or propose tool's prose is checked, and a handoff note, for the caller's own next session,
// is not (the agent API tells it by its kind).
export const PROSE_UNCHECKED_TOOLS: readonly string[] = Object.freeze([
  "post_agent_message",
  "submit_improvement",
  "update_improvement",
  "record_spend",
  "start_outcome_test",
  "record_held_out_question",
  "record_outcome_task",
  "import_memory",
  "push_capture",
  ...PersonalRunTool.options,
]);
