// Agents in words: their names, what they may read and use, what raises their work and its steps.

import { authorParts, compartmentParts, type GapTrigger, type PersonalTool } from "@intelligence/contracts/personal";
import { capital, wordsOf } from "./words.ts";

// An agent's name as the page shows it, everywhere: its registered name,
// capitalised, as Settings lists it ("sable" reads "Sable").
export const agentName = (name: string): string => capital(name);

// Whose sources an agent may read, by compartment, in words: never the compartment's code. A name no
// deployment writes is said as it is named, never as "Other sources".
export function compartmentWords(compartment: string): string {
  const parts = compartmentParts(compartment);
  switch (parts.kind) {
    case "own":
      return "Your own";
    case "public":
      return "Public";
    case "declassified":
      return "What you released to agents";
    case "agent":
      return `${agentName(parts.name)}'s own notes`;
    case "employer":
      return parts.released
        ? `What your work at ${slugWords(parts.slug)} released`
        : `Your work at ${slugWords(parts.slug)}`;
    case "restricted":
      return `Restricted: ${parts.category}`;
    default:
      return `Kept apart as ${slugWords(compartment)}`;
  }
}
// A compartment's slug as a name: "riverside-college" reads "Riverside College".
const slugWords = (slug: string): string =>
  slug
    .split(/[-_:]/)
    .filter((part) => part !== "")
    .map(capital)
    .join(" ");

// What an agent's tools let it do, in words: each kind of use, then its tools, each named in plain
// words, never a command. A row for each tool the contract serves, so a new one fails to compile until
// it is decided: the kind of use it is listed under (null: after them), and what the owner would call it
// (null: its name in words). A tool this page has no row for is listed the same as null, null.
const TOOL_KINDS = {
  read: "read what you know",
  propose: "propose facts and people",
  work: "take work from the board",
} as const;
type ToolRow = { kind: keyof typeof TOOL_KINDS | null; words: string | null };
const TOOLS: Readonly<Record<PersonalTool | "write_back", ToolRow>> = {
  get_self: { kind: "read", words: "read about you" },
  search: { kind: "read", words: "search" },
  get_entity: { kind: "read", words: "look up a person" },
  get_timeline: { kind: "read", words: "read a person's history" },
  find_messages: { kind: "read", words: "find messages" },
  read_message: { kind: "read", words: "read a message" },
  find_facts: { kind: "read", words: "find facts" },
  build_context_pack: { kind: "read", words: "build a brief" },
  get_commitments: { kind: "read", words: "read commitments" },
  sync_memory: { kind: "propose", words: null },
  find_documents: { kind: "read", words: "find documents" },
  get_document: { kind: "read", words: "read a document" },
  get_evidence_span: { kind: "read", words: "read where a fact came from" },
  read_item: { kind: "read", words: "read an item" },
  get_decision_history: { kind: "read", words: null },
  find_paths: { kind: "read", words: "find ways to reach someone" },
  fetch_template: { kind: "read", words: null },
  get_suggestions: { kind: "read", words: null },
  get_beliefs: { kind: "read", words: "read what is known" },
  sync_mirror: { kind: null, words: null },
  list_goals: { kind: "read", words: "read your goals" },
  context: { kind: "read", words: null },
  record_reads: { kind: "propose", words: null },
  list_people: { kind: "read", words: "list people" },
  about: { kind: "read", words: "read how the system works" },
  read_record: { kind: "read", words: "read an agent's record" },
  find_records: { kind: "read", words: "find agents' records" },
  get_open_items: { kind: "read", words: "read what the owner owes" },
  get_changes: { kind: "read", words: "read what changed" },
  record: { kind: "propose", words: "write a finding" },
  propose_about_you: { kind: "propose", words: "propose a fact about you" },
  import_memory: { kind: "propose", words: null },
  answer_owner_question: { kind: "work", words: "answer your question" },
  propose_person: { kind: "propose", words: "propose a person" },
  close_commitment: { kind: "work", words: "close a commitment" },
  reopen_commitment: { kind: "work", words: "reopen a commitment" },
  list_opportunities: { kind: "read", words: "read the work board" },
  claim_opportunity: { kind: "work", words: "take work" },
  release_opportunity: { kind: "work", words: "let work go" },
  propose_hypothesis: { kind: "propose", words: null },
  record_test: { kind: "propose", words: null },
  propose_opportunity: { kind: "propose", words: "propose work" },
  plan_move: { kind: "work", words: "plan a step" },
  report_move: { kind: "work", words: "report a step" },
  set_intention: { kind: "work", words: "set a reminder" },
  propose_task: { kind: "propose", words: "propose a task" },
  hand_off: { kind: "work", words: "hand work on" },
  propose_goal: { kind: "propose", words: null },
  propose_goal_target: { kind: "propose", words: null },
  post_agent_message: { kind: null, words: null },
  read_agent_inbox: { kind: "read", words: null },
  submit_improvement: { kind: null, words: null },
  list_improvements: { kind: "read", words: null },
  get_health: { kind: "read", words: null },
  mark_health_seen: { kind: "work", words: "mark a box problem seen" },
  file_learning: { kind: null, words: "keep what it learned for other agents" },
  list_levers: { kind: "read", words: null },
  set_lever: { kind: null, words: "change a system setting" },
  report_wrong_merge: { kind: "propose", words: "report two people joined as one" },
  report_wrong_relation: { kind: "propose", words: "report two facts wrongly linked" },
  propose_project: { kind: "work", words: "create a project" },
  update_project: { kind: "work", words: "update a project" },
  relay_card_answer: { kind: "work", words: "pass on your answer to a question" },
  list_projects: { kind: "read", words: "read your projects" },
  list_ideas: { kind: "read", words: "read your idea ledger" },
  get_project: { kind: "read", words: "read a project" },
  get_work_time: { kind: "read", words: "read your time by place" },
  read_meeting: { kind: "read", words: "read a meeting's transcript" },
  set_anchor: { kind: "work", words: "anchor a place to a project" },
  lift_anchor: { kind: "work", words: "lift a place's anchor" },
  rule_time: { kind: "work", words: "file time under a project" },
  lift_time_ruling: { kind: "work", words: "take back time it filed" },
  judge_time_proposal: { kind: "work", words: "accept a time suggestion" },
  update_improvement: { kind: null, words: null },
  write_back: { kind: null, words: "say what happened" },
  record_spend: { kind: "propose", words: null },
  start_outcome_test: { kind: null, words: null },
  record_held_out_question: { kind: "propose", words: null },
  record_outcome_task: { kind: "propose", words: null },
  next_run: { kind: null, words: null },
  append_step: { kind: null, words: null },
  finish_run: { kind: null, words: null },
  draft_message: { kind: null, words: null },
  request_research: { kind: null, words: null },
  push_capture: { kind: null, words: null },
};
const toolRow = (tool: string): ToolRow | undefined =>
  Object.hasOwn(TOOLS, tool) ? TOOLS[tool as keyof typeof TOOLS] : undefined;
export const toolWords = (tool: string): string => toolRow(tool)?.words ?? wordsOf(tool).toLowerCase();
export function toolsWords(tools: readonly string[]): string {
  if (tools.length === 0) return "Nothing";
  const named = (some: readonly string[]): string => {
    const words = [...some].sort().map(toolWords);
    return words.length === 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words.at(-1) ?? ""}`;
  };
  const kinds = (Object.keys(TOOL_KINDS) as (keyof typeof TOOL_KINDS)[]).flatMap((kind) => {
    const some = tools.filter((tool) => toolRow(tool)?.kind === kind);
    return some.length === 0 ? [] : [`${capital(TOOL_KINDS[kind])}: ${named(some)}`];
  });
  const other = tools.filter((tool) => (toolRow(tool)?.kind ?? null) === null);
  return [...kinds, ...(other.length === 0 ? [] : [`${kinds.length === 0 ? "It can" : "And"}: ${named(other)}`])].join(
    ". ",
  );
}

// What raises a task for an agent (a gap trigger, raised by code), in words, as Settings' routes
// say which agent takes it; null reads as its code in words.
const TRIGGER_WORDS: Readonly<Record<GapTrigger, string | null>> = {
  explore: null,
  same_person: null,
  unresolved_mention: "Someone named in your mail who is not yet known",
  no_warm_path: "Someone you have no warm way to reach",
  unknown_attendee: "Someone at a meeting you do not know",
  close_no_role: "A close contact whose work is not known",
  meeting_soon: "A meeting coming up",
  commitment_due: "A promise coming due",
  reply_owed: "A reply you owe",
  close_no_tie: "A close contact whose tie to you is not known",
  intro_path: "Someone who offered an introduction",
  deadline_soon: "Something dated coming up on your calendar",
  goal_review: "A goal of yours with no work on it lately",
  meeting_followup: "A meeting you just had, to write up",
  defect: "A defect the system found in itself",
  defect_untriaged: "A defect an agent filed that nobody has picked up",
  card_question: "A question for you that an agent tries first",
  merge_audit: "A check that two records joined by rule are one person",
  card_relay: "A question for you that an agent asks you in conversation",
  owner_queue: "Questions only you answer, which an agent tells you are waiting, with a link",
  dream_finding: "Two facts on file that disagree, for an agent to settle",
};
export const triggerWords = (trigger: string): string =>
  (Object.hasOwn(TRIGGER_WORDS, trigger) ? TRIGGER_WORDS[trigger as GapTrigger] : null) ?? wordsOf(trigger);

// Who raised a card or took a step, in words. A client's id is never shown.
export function authorWords(author: string): string {
  switch (authorParts(author).kind) {
    case "owner":
      return "You";
    case "reasoner":
    case "run":
      return "The planner";
    case "client":
      return "An agent";
    default:
      return "The system";
  }
}

// A ledger event's name in words, as a piece of work's steps show them. One the map does not hold
// reads "A step".
const EVENT_WORDS: Readonly<Record<string, string>> = {
  proposed: "Proposed",
  go: "You said go",
  no_go: "You said no",
  later: "You said later",
  claimed: "An agent took it",
  released: "An agent let it go",
  handed_to_owner: "Handed to you",
  done: "Done",
  expired: "Expired",
  withdrawn: "Withdrawn",
  outcome_met: "It worked",
  outcome_not_met: "It did not work",
  planned: "Planned",
  cleared: "Started",
  reported: "Reported",
  failed: "Failed",
  blocked: "Blocked",
  queued: "Queued",
  started: "Started",
  set: "Set",
  fired: "Reminded you",
  cancelled: "Cancelled",
  open: "Open",
  asked: "Asked you",
  confirmed: "Confirmed",
  rejected: "Rejected",
  supported: "Supported",
  pursued: "Pursued",
  retired: "Retired",
  made: "Made",
  sent: "Sent",
};
export const eventWords = (event: string): string => EVENT_WORDS[event] ?? "A step";

// "Picked it up", "Started", "Reported back: done". Who took it is said under it, never here.
const LEDGER_EVENT_WORDS: Readonly<Record<string, string>> = {
  decided: "You answered",
  // A card the system raised, as the ledger records it: put to the owner, or held while many wait.
  pending: "Asked you",
  deferred: "Held a question back until fewer are waiting",
  completed: "Finished",
  compared: "Compared two records",
  written: "Wrote down a finding",
  renewed: "Kept working",
  raised: "Asked you",
  reattached: "Applied one of your rulings again",
  claimed: "Picked it up",
  released: "Gave it back",
  cleared: "Started",
  queued: "Waiting to start",
  running: "Started",
  routed: "Passed it to another kind of agent",
  handed_to_owner: "Handed to you to decide",
  withdrawn: "Withdrawn",
  expired: "Ran out of time",
};
export const ledgerEventWords = (event: string): string => LEDGER_EVENT_WORDS[event] ?? eventWords(event);
