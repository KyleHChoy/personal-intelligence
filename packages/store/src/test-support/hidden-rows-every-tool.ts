// Invariant 6 over the whole tool catalogue: which hidden-rows test asks each tool, the tools that
// cannot be given a row they may not see, and the asks of every-tool-hidden-rows.db.test.ts.

import {
  methodOf,
  OUTCOME_SUITE,
  onWorkPort,
  PersonalTool,
  type ReadOutcome,
  TOOL_NAMES,
  TOOL_WIRE,
  type ToolName,
} from "@intelligence/contracts/personal";
import { correspondentsOf, HIDDEN_ONLY } from "@intelligence/personal-core/testing";
import { setClientRoles } from "../admin/admin-tasks.ts";
import { sealRow } from "../core/seal.ts";
import { testId } from "./clients.ts";
import { commitClaims } from "./commitment-fixtures.ts";
import { asTablesOwner, session } from "./connections.ts";
import { fingerprint, queryAs } from "./database.ts";
import { ABSENT_AGENT_OPS, AGENT_OPS_ASKS, seedHiddenAgentOps } from "./hidden-rows-agent-ops.ts";
import { ABSENT_PLACE, AGENT_TIME_ASKS, seedHiddenAgentTime } from "./hidden-rows-agent-time.ts";
import type { WorkIds, WorkInv6 } from "./hidden-rows-work.ts";
import { addHidden, admin, HIDDEN, settle } from "./hidden-rows-world.ts";
import { seeder } from "./seeder.ts";
import { MISSING_ENTITY } from "./values.ts";
import { buildAs } from "./warmth-fixtures.ts";
import { insertWorkClient, RUN_TOOLS, type WorkClient } from "./work-clients.ts";

// Every tool a registration may list and every tool served.
export const CATALOGUE: readonly string[] = [...new Set<string>([...TOOL_NAMES, ...PersonalTool.options])].sort();

// The hidden-rows tests, by the name COVERAGE uses for each.
export const HIDDEN_ROWS_TESTS = {
  read: "read-tools-hidden-rows.db.test.ts",
  work: "work-tools-hidden-rows.db.test.ts",
  every: "every-tool-hidden-rows.db.test.ts",
} as const;
export type HiddenRowsTest = keyof typeof HIDDEN_ROWS_TESTS;

// `asked`: the test whose asks reach the tool. `cannotLeak`: why no row of another compartment can
// change what the tool answers; reviewed, one line each.
export type Coverage = { asked: HiddenRowsTest } | { cannotLeak: string };

const asked = (test: HiddenRowsTest): Coverage => ({ asked: test });

export const COVERAGE: Readonly<Record<string, Coverage>> = Object.freeze({
  // The read tools of read-tools-hidden-rows.db.test.ts.
  get_self: asked("read"),
  search: asked("read"),
  get_entity: asked("read"),
  get_timeline: asked("read"),
  find_messages: asked("read"),
  read_message: asked("read"),
  find_facts: asked("read"),
  build_context_pack: asked("read"),
  get_commitments: asked("read"),
  get_open_items: asked("read"),
  get_changes: asked("read"),
  // The work view's reads, of work-tools-hidden-rows.db.test.ts.
  list_opportunities: asked("work"),
  read_agent_inbox: asked("work"),
  list_improvements: asked("work"),
  get_health: asked("work"),
  list_levers: asked("work"),
  list_projects: asked("work"),
  list_ideas: asked("work"),
  get_project: asked("work"),
  get_work_time: asked("work"),
  read_meeting: asked("work"),
  // The rest of the read tools.
  sync_memory: asked("every"),
  find_documents: asked("every"),
  get_document: asked("every"),
  get_evidence_span: asked("every"),
  read_item: asked("every"),
  get_decision_history: {
    cannotLeak: "not built: the reader answers unavailable before any statement, whatever the arguments",
  },
  find_paths: asked("every"),
  fetch_template: asked("every"),
  get_suggestions: asked("every"),
  get_beliefs: asked("every"),
  sync_mirror: asked("every"),
  list_goals: asked("every"),
  context: asked("every"),
  record_reads: asked("every"),
  list_people: asked("every"),
  about: asked("every"),
  read_record: asked("every"),
  find_records: asked("every"),
  // The write tools.
  record: asked("every"),
  propose_about_you: asked("every"),
  import_memory: {
    cannotLeak: "its answer is the count of changes in the call, whatever happened to each",
  },
  answer_owner_question: asked("every"),
  propose_person: asked("every"),
  close_commitment: asked("every"),
  reopen_commitment: asked("every"),
  push_capture: {
    cannotLeak:
      "each outcome is read from the calling device's own inbox rows, by its client id, and the owner's scope rules",
  },
  // The work tools that write.
  claim_opportunity: asked("every"),
  release_opportunity: asked("every"),
  propose_hypothesis: asked("every"),
  record_test: asked("every"),
  propose_opportunity: asked("every"),
  plan_move: asked("every"),
  report_move: asked("every"),
  set_intention: asked("every"),
  propose_task: asked("every"),
  hand_off: asked("every"),
  propose_goal: asked("every"),
  propose_goal_target: asked("every"),
  post_agent_message: asked("every"),
  submit_improvement: asked("every"),
  update_improvement: asked("every"),
  mark_health_seen: asked("every"),
  file_learning: asked("every"),
  // An agent's anchors and rulings on work time.
  set_anchor: asked("every"),
  lift_anchor: asked("every"),
  rule_time: asked("every"),
  lift_time_ruling: asked("every"),
  judge_time_proposal: asked("every"),
  set_lever: {
    cannotLeak:
      "a lever is a setting with no label, the same for every caller that holds the tool (list_levers' UNLABELLED)",
  },
  propose_project: asked("every"),
  update_project: asked("every"),
  write_back: asked("every"),
  report_wrong_merge: asked("every"),
  report_wrong_relation: asked("every"),
  relay_card_answer: asked("every"),
  record_spend: {
    cannotLeak: "its one bit is the owner's global daily money ceiling, which the owner's decision keeps global",
  },
  start_outcome_test: asked("every"),
  record_held_out_question: {
    cannotLeak: "it writes under the caller's clearance and reads back only its own request id within its keys",
  },
  record_outcome_task: asked("every"),
  // The run tools.
  next_run: asked("every"),
  append_step: asked("every"),
  finish_run: asked("every"),
  // The propose tool.
  draft_message: asked("every"),
  // The research tool: a registration may list it, and no port serves it.
  request_research: { cannotLeak: "no port serves it: tool-wire.ts has no row for it, so no call reaches the store" },
});

// What the asks name: the hidden twin's rows, or ids no row has.
export type Ids = {
  entity: string;
  message: string;
  event: string;
  fact: string;
  document: string;
  reference: string;
  record: string;
  project: string;
  projectName: string;
  opportunity: string;
  move: string;
  idea: string;
  improvement: string;
  title: string;
  thread: string;
  card: string;
  healthCard: string;
  learning: string;
  learningStatement: string;
  relation: string;
  goal: string;
  commitment: string;
  close: string;
  run: string;
  outcomeRun: string;
  client: string;
  // The hidden person's two addresses, as a report of a wrong merge names them.
  address: string;
  otherAddress: string;
  // A system proposal, the scout's anchor and ruling, and the place it anchored.
  timeProposal: string;
  agentAnchor: string;
  agentRuling: string;
  anchorPlace: string;
};

const none = (prefix: string): string => `${prefix}_7${"Z".repeat(25)}`;
export const ABSENT_IDS: Ids = {
  entity: MISSING_ENTITY,
  message: none("msg"),
  event: none("evt"),
  fact: "f".repeat(64),
  document: none("doc"),
  reference: none("doc"),
  record: none("rec"),
  project: MISSING_ENTITY,
  projectName: "A project nobody named",
  opportunity: none("opp"),
  move: none("mov"),
  idea: none("hyp"),
  improvement: none("imp"),
  title: "A defect nobody filed",
  thread: none("amg"),
  card: none("crd"),
  ...ABSENT_AGENT_OPS,
  goal: none("gol"),
  commitment: "e".repeat(64),
  close: none("rec"),
  run: none("run"),
  outcomeRun: none("otr"),
  client: "nobody",
  address: "nobody.one@example.org",
  otherAddress: "nobody.two@example.org",
  timeProposal: none("tpr"),
  agentAnchor: none("aan"),
  agentRuling: none("atr"),
  anchorPlace: ABSENT_PLACE,
};

// The person only employer:example knows, and a second address of theirs this file gives them, so a
// report that they are two people names every address they have.
const HIDDEN_PERSON = HIDDEN_ONLY[0] as { address: string };
const OTHER_ADDRESS = "hidden.person1.home@hidden.example.org";

// People under `own` no ask but one names, so a proposal about one merges into no other's work.
const FRESH = 12;

// What the viewer sees that an ask names beside a hidden id: a person and a message under `own`,
// and the base world's project, defect and thread.
export type Visible = {
  entity: string;
  fresh: string[];
  message: string;
  improvement: string;
  account: string;
  project: string;
};

type Args = Record<string, unknown>;
// One ask that names a row: asked with an id no row has, then with the hidden twin's. `wide`, the
// client of its control (`both` when left out); `narrowOnly`, an ask the viewer of `own` alone cannot
// make at all (it holds no record account); `noControl`, why no client is given the hidden row.
export type NamedAsk = {
  ask: string;
  tool: ToolName;
  by: "agent" | "reasoner";
  args: (ids: Ids, seen: Visible) => Args;
  wide?: "both" | "scout";
  narrowOnly?: true;
  noControl?: string;
};

const DAY = 86_400_000;
const text = (value: unknown): string => JSON.stringify(value);
const summary = "check who runs it";
const message = (id: string) => ({ kind: "message", id });
// The k-th of the people no other ask names.
const fresh = (v: Visible, k: number): string => {
  const one = v.fresh[k];
  if (one === undefined) throw new Error(`no fresh person ${k}`);
  return one;
};

const named = (
  ask: string,
  tool: ToolName,
  args: NamedAsk["args"],
  more: Omit<NamedAsk, "ask" | "tool" | "args" | "by"> & { by?: NamedAsk["by"] } = {},
): NamedAsk => ({ ask, tool, args, by: more.by ?? "agent", ...more });

export const NAMED: readonly NamedAsk[] = [
  ...AGENT_TIME_ASKS,
  // Reads.
  named("find_documents entity", "find_documents", (x) => ({ entity: x.entity })),
  named("get_document", "get_document", (x) => ({ id: x.document })),
  named("get_evidence_span", "get_evidence_span", (x) => ({ fact: x.fact })),
  named("read_item", "read_item", (x) => ({ message: x.message })),
  named("find_paths", "find_paths", (x) => ({ target: x.entity })),
  named("fetch_template", "fetch_template", (x) => ({ document: x.reference })),
  named("get_beliefs entity", "get_beliefs", (x) => ({ entity: x.entity, state: "any" })),
  named("context entity", "context", (x) => ({ task: "prepare for the meeting", entity: x.entity })),
  named("context event", "context", (x) => ({ task: "prepare for the meeting", event: x.event })),
  named("record_reads record", "record_reads", (x) => ({ record: x.record })),
  named("about", "about", (x) => ({ subject: { id: x.entity } })),
  named("read_record", "read_record", (x) => ({ record: x.record })),
  named("find_records project", "find_records", (x) => ({ project: x.project })),
  named("find_records subject", "find_records", (x) => ({ subject: x.entity })),
  named("find_records client", "find_records", (x) => ({ client: x.client })),
  // Writes.
  named("record cites", "record", (x) => ({ kind: "note", body: "a note", cites: [x.message] })),
  named("record project", "record", (x) => ({ kind: "finding", body: "a finding", project: x.project }), {
    narrowOnly: true,
  }),
  named("record supersedes", "record", (x) => ({ kind: "note", body: "a later note", supersedes: x.record }), {
    narrowOnly: true,
  }),
  named("propose_about_you", "propose_about_you", (x) => ({ statement: "The owner keeps bees.", cites: [x.message] })),
  named("answer_owner_question", "answer_owner_question", (x) => ({
    opportunity: x.opportunity,
    answer: { quote: "yes, go ahead" },
  })),
  named("propose_person relationship", "propose_person", (x) => ({
    kind: "relationship",
    fields: { person: x.entity, relation: "friend", closeness: "active" },
    basis: "they met at the club",
  })),
  named("propose_person cites", "propose_person", (x) => ({
    kind: "person",
    fields: { name: "Jo Example", known_how: "the reading club" },
    basis: "they met at the club",
    cites: [x.message],
  })),
  named(
    "close_commitment",
    "close_commitment",
    (x, v) => ({ commitment: x.commitment, ending: "done", evidence: [v.message] }),
    { wide: "scout" },
  ),
  named(
    "close_commitment evidence",
    "close_commitment",
    (x) => ({ commitment: x.commitment, ending: "done", evidence: [x.message] }),
    { wide: "scout" },
  ),
  named("reopen_commitment", "reopen_commitment", (x) => ({ close: x.close }), { wide: "scout" }),
  // Work. The scout holds the hidden work: its controls plan, report and set a check-back on it
  // before it gives the work back.
  named("plan_move", "plan_move", (x) => ({ opportunity: x.opportunity, stage: "investigate" }), { wide: "scout" }),
  named(
    "report_move",
    "report_move",
    (x) => ({ move: x.move, outcome: "progress", report: { done: ["read the filing"], next: "ask for a quote" } }),
    { wide: "scout" },
  ),
  named(
    "set_intention",
    "set_intention",
    (x) => ({ opportunity: x.opportunity, dueAt: new Date(Date.now() + 3 * DAY).toISOString() }),
    { wide: "scout" },
  ),
  named("claim_opportunity", "claim_opportunity", (x) => ({ id: x.opportunity }), { wide: "scout" }),
  named("release_opportunity", "release_opportunity", (x) => ({ id: x.opportunity, reason: "no_time" }), {
    wide: "scout",
  }),
  named("hand_off", "hand_off", (x) => ({ id: x.opportunity, role: null, reason: "other" }), { wide: "scout" }),
  named("propose_hypothesis about", "propose_hypothesis", (x, v) => ({
    kind: "idea",
    about: { kind: "entity", id: x.entity },
    summary,
    basis: [message(v.message)],
  })),
  named("propose_hypothesis idea", "propose_hypothesis", (x, v) => ({
    kind: "idea",
    about: { kind: "entity", id: fresh(v, 0) },
    summary,
    basis: [message(v.message)],
    idea: x.idea,
  })),
  named("record_test", "record_test", (x, v) => ({
    hypothesis: x.idea,
    result: "supports",
    basis: [message(v.message)],
  })),
  named("propose_opportunity about", "propose_opportunity", (x, v) => ({
    kind: "investigate",
    about: { kind: "entity", id: x.entity },
    summary,
    basis: [message(v.message)],
  })),
  named("propose_opportunity project", "propose_opportunity", (x, v) => ({
    kind: "investigate",
    about: { kind: "entity", id: fresh(v, 1) },
    summary,
    basis: [message(v.message)],
    project: x.project,
  })),
  named("propose_task about", "propose_task", (x) => ({
    kind: "investigate",
    about: { kind: "entity", id: x.entity },
    summary,
    basis: [message(x.message)],
  })),
  named("propose_task project", "propose_task", (x, v) => ({
    kind: "investigate",
    about: { kind: "entity", id: fresh(v, 2) },
    summary,
    basis: [message(v.message)],
    project: x.project,
  })),
  named("propose_task parent", "propose_task", (x, v) => ({
    kind: "investigate",
    about: { kind: "entity", id: fresh(v, 3) },
    summary,
    basis: [message(v.message)],
    parent: x.opportunity,
  })),
  named("propose_task blockedBy", "propose_task", (x, v) => ({
    kind: "investigate",
    about: { kind: "entity", id: fresh(v, 4) },
    summary,
    basis: [message(v.message)],
    blockedBy: [x.opportunity],
  })),
  named("propose_goal", "propose_goal", (x, v) => ({
    change: "drop",
    goal: x.goal,
    summary,
    basis: [message(v.message)],
  })),
  named("propose_goal_target", "propose_goal_target", (x, v) => ({
    goal: x.goal,
    entity: fresh(v, 5),
    summary,
    basis: [message(v.message)],
  })),
  named("propose_goal_target entity", "propose_goal_target", (x) => ({
    goal: x.goal,
    entity: x.entity,
    summary,
    basis: [message(x.message)],
  })),
  named("post_agent_message", "post_agent_message", (x) => ({ kind: "note", replyTo: x.thread, body: "for me too" })),
  named("submit_improvement", "submit_improvement", (x) => ({
    kind: "bug",
    area: "mcp",
    severity: "low",
    title: x.title,
    detail: "seen again",
  })),
  named("update_improvement", "update_improvement", (x) => ({ improvement: x.improvement, status: "triaged" })),
  named(
    "update_improvement duplicateOf",
    "update_improvement",
    (x, v) => ({ improvement: v.improvement, status: "duplicate", duplicateOf: x.improvement }),
    {
      noControl:
        "a status is written under the defect's own label, which the hidden defect is never within, so every caller is answered not_found (hidden-rows-work.ts checks it for the wide client)",
    },
  ),
  named("propose_project", "propose_project", (x) => ({ name: x.projectName }), { wide: "scout" }),
  named("update_project", "update_project", (x) => ({ project: x.project, note: "Waiting on the kiln." })),
  named("write_back message", "write_back", (x) => ({ source: { kind: "message", id: x.message }, state: "handled" })),
  named("write_back opportunity", "write_back", (x) => ({
    source: { kind: "opportunity", id: x.opportunity },
    state: "handled",
  })),
  named("report_wrong_merge", "report_wrong_merge", (x) => ({
    entity: x.entity,
    parts: [[x.address], [x.otherAddress]],
    because: "different_employers",
    cites: [x.message],
  })),
  named("relay_card_answer", "relay_card_answer", (x) => ({
    card: x.card,
    option: "acknowledge",
    quote: "yes, that is right",
  })),
  named("record_outcome_task", "record_outcome_task", (x) => ({
    run: x.outcomeRun,
    task: "kiln_quote",
    heldOut: false,
    score: 2,
    codeCap: 3,
    judgeScore: 2,
    answerModel: "model-a",
    judgeModel: "model-b",
    failed: [],
    toolCalls: 1,
    costMicroUsd: 1,
    answer: "an answer",
    scoring: "a scoring",
  })),
  ...AGENT_OPS_ASKS,
  // Run.
  named(
    "append_step",
    "append_step",
    (x) => ({ run: x.run, ordinal: 0, step: { kind: "output_check", code: "no_citation" } }),
    {
      by: "reasoner",
    },
  ),
  named("finish_run", "finish_run", (x) => ({ run: x.run, outcome: "failed" }), { by: "reasoner" }),
  // Propose.
  named("draft_message reply", "draft_message", (x) => ({ replyTo: x.message, body: "Thanks, see you then." })),
  named("draft_message opportunity", "draft_message", (x, v) => ({
    opportunity: x.opportunity,
    account: v.account,
    to: ["jo@example.org"],
    subject: "Kiln",
    body: "Is the kiln free on Monday?",
  })),
  named("draft_message basis", "draft_message", (x, v) => ({
    basis: [message(x.message)],
    account: v.account,
    to: ["jo@example.org"],
    subject: "Kiln",
    body: "Is the kiln free on Monday?",
  })),
];

// Every write takes a request id: a fresh one each call, so no call is a replay of another.
export const withRequest = (tool: ToolName, args: Args): Args => {
  const given = { ...args, requestId: testId("req") };
  return TOOL_WIRE[tool].args.safeParse(given).success || !TOOL_WIRE[tool].args.safeParse(args).success ? given : args;
};

// One call of a tool, through the port that serves it, as the agent API makes it.
export async function callTool(w: WorkInv6, token: string, tool: ToolName, args: Args): Promise<ReadOutcome<unknown>> {
  const port = (onWorkPort(tool) ? w.work : w.reader) as unknown as Record<
    string,
    (token: string, args: unknown) => Promise<ReadOutcome<unknown>>
  >;
  const method = port[methodOf(tool)];
  if (method === undefined) throw new Error(`no port method for ${tool}`);
  return method.call(port, token, withRequest(tool, args));
}

// The clients that ask, given every tool they may hold here, their quotas lifted so no ask is
// refused for its count: the viewer cleared for `own` and the agent compartments it shares, the one
// cleared for `own` alone, and the one reasoner a box holds, cleared for `own` for the viewers' asks
// and for every compartment for the controls (widenReasoner). The controls' clients: `both`, cleared
// for every compartment; and `scout`, cleared for employer:example and its own agent compartment, who
// holds the hidden work and closes the hidden commitment. With the owner's release of closes to
// agents on, so a close is asked of the commitment and not refused for the switch.
export type EveryClients = {
  agent: WorkClient;
  bare: WorkClient;
  reasoner: WorkClient;
  wide: Record<"both" | "scout", string>;
};

export async function everyClients(w: WorkInv6): Promise<EveryClients> {
  const db = w.s.store.db;
  const agentTools = CATALOGUE.filter(
    (tool) =>
      !(RUN_TOOLS as readonly string[]).includes(tool) && tool !== "push_capture" && tool !== "request_research",
  );
  const reasoner = await insertWorkClient(db, "reason-own", ["own"], { kind: "reasoner", tools: [...RUN_TOOLS] });
  await session(db.urls.admin, async (query) => {
    const agents = [w.narrow.id, w.bare.id, w.both.id, w.scout.id];
    await query("update policy.clients set tools = $1 where id = any ($2)", [agentTools, agents]);
    await query(
      `update policy.clients set max_calls_minute = 600, max_items_day = 100000, max_chars_day = 100000000,
         max_rows_day = 1000000 where id = any ($1)`,
      [[...agents, reasoner.id]],
    );
    // The owner's switches the asks need on: agents' reports of wrong merges, and questions relayed
    // through the role every agent here holds.
    await query("update policy.work_settings set identity_agents = 'on', question_role = 'fixer'");
    for (const name of ["narrow", "bare", "scout", "both"]) await setClientRoles(query, name, ["fixer"], new Date());
  });
  await w.s.store.admin.commitments.setAgentCloses(true, { requestId: testId("req") });
  return { agent: w.narrow, bare: w.bare, reasoner, wide: { both: w.both.token, scout: w.scout.token } };
}

// The people view built for each asking client's audience, as the pipeline builds it after new
// evidence: before the viewers' first asks, so none is answered `rebuilding`, and again once the hidden
// rows are in, so list_people is asked of a build that read them. The wide client's build then holds
// the people only employer:example knows: list_people's control.
export async function buildPeople(w: WorkInv6): Promise<void> {
  for (const client of [w.narrow, w.bare, w.both]) await buildAs(w.s.store.db, [...client.compartments]);
}

// The reasoner cleared for every compartment the key file holds, holding the hidden run: next_run
// takes it, so the run tools' controls are asked of a run the caller holds.
export async function widenReasoner(w: WorkInv6, reasoner: WorkClient, run: string): Promise<void> {
  await session(w.s.store.db.urls.admin, async (query) => {
    await query("update policy.clients set compartments = $1 where id = $2", [
      [...w.keys.compartments.keys()].sort(),
      reasoner.id,
    ]);
  });
  for (let tries = 0; tries < 10; tries += 1) {
    const taken = await w.work.nextRun(reasoner.token, { requestId: testId("req") as never });
    if (!taken.ok) throw new Error(`next_run was refused: ${text(taken)}`);
    if (taken.value.run === null || taken.value.run === undefined) break;
    if (taken.value.run.id === run) return;
  }
  throw new Error("the widened reasoner did not take the hidden run");
}

// What the viewer sees beside the hidden rows: people, each with an address, a message and an
// agent's answer on a card under `own`; the owner's mail account; the base world's defect.
export async function seedVisibleRows(w: WorkInv6, seen: WorkIds): Promise<Visible> {
  const mail = w.s.base.accounts.find((one) => one.compartment === "own");
  if (mail === undefined) throw new Error("no own mail account");
  return session(w.s.store.db.urls.admin, async (query) => {
    const seed = seeder(w.s.store.db, query);
    const person = async (): Promise<string> => {
      const entity = await seed.entity("person");
      await seed.account(["own"], entity);
      return entity;
    };
    const entity = await person();
    const fresh: string[] = [];
    for (let k = 0; k < FRESH; k += 1) fresh.push(await person());
    const evidence = await seed.evidence(["own"], await seed.sourceAccount(["own"]));
    const one = await seed.message(["own"], evidence, { held: false });
    await seed.interaction(["own"], evidence, entity);
    // An agent's answer on a card, which a card_relay task's brief reads (ledger.card_relay_question).
    await seed.into("ledger.card_answers")(["own"]);
    return { entity, fresh, message: one, improvement: seen.improvement, account: mail.label, project: seen.project };
  });
}

// The hidden twin's rows the asks name, beside those addHiddenWork added, none under a label a
// viewer of `own` is cleared for: the read world's twin (addHidden: mail, meetings, people only
// employer:example knows, claims and their beliefs); and under employer:example, a commitment of the
// owner's to one of those people, a second address of theirs, a document and a reference document, a
// card, a goal, a queued run and a project. And the controls' own: the wide client's note and outcome
// test run, under its clearance, and the scout's close of the hidden commitment.
export async function seedHiddenRows(w: WorkInv6, added: WorkIds): Promise<Ids> {
  const label = [HIDDEN];
  // The read world's twin, with as many rows per table as it has people, so it writes to each,
  // the people only employer:example knows among them (hiddenWorld names them after the rest).
  const twin = await addHidden(w.s, correspondentsOf(w.s.base).length + HIDDEN_ONLY.length);
  const event = twin.events[0];
  if (event === undefined) throw new Error("the twin added no meeting");
  const [person] = await admin<{ id: string }>(
    w.s,
    `select distinct e.id from knowledge.entities e join knowledge.accounts a on a.entity_id = e.id
     where e.kind = 'person' and a.value_fp = $1
       and not exists (select 1 from knowledge.accounts o where o.entity_id = e.id and not o.compartments <@ '{employer:example}'::text[])`,
    [fingerprint(w.s.store.db.keys, "address", HIDDEN_PERSON.address)],
  );
  // A claim of the twin's and the message it was read from, whose thread a commitment of the owner's
  // to the person only employer:example knows joins (the twin's own commitments name no other party,
  // so get_commitments lists none of them).
  const [support] = await admin<{ claim: string; message: string }>(
    w.s,
    `select c.id as claim, m.id as message from knowledge.claims c
     join knowledge.messages m on m.evidence_id = c.evidence_id
     where m.compartments = '{employer:example}' and m.thread_fp is not null order by c.id limit 1`,
  );
  if (support === undefined || person === undefined)
    throw new Error("the twin added no claim, or no person only employer:example knows");
  // The commitment, committed as the extraction commits one, on a message of its own in the twin's
  // thread, and known an hour before the world's date (the reader's clock). It is computed when
  // asked under each clearance that holds employer:example: the wide client's, whose sync_memory,
  // get_beliefs and get_commitments are the control, and the scout's, cleared for nothing outside
  // its label but agent compartments, which closes it.
  const owed = await session(w.s.store.db.urls.admin, async (query) => {
    const seed = seeder(w.s.store.db, query);
    const evidenceId = await seed.evidence(label, await seed.sourceAccount(label));
    const id = await seed.message(label, evidenceId, { held: false });
    await query(
      "update knowledge.messages set thread_fp = (select m.thread_fp from knowledge.messages m where m.id = $2) where id = $1",
      [id, support.message],
    );
    return { id, evidenceId };
  });
  const known = new Date(w.s.store.now.getTime() - 3_600_000).toISOString();
  const key = `hidden-commitment-${testId("k")}`;
  const records = await commitClaims(w.s.store, w.s.owner, [
    {
      key,
      subject: w.s.owner,
      counterparty: person.id,
      claims: [{ message: { ...owed, sentAt: known, compartment: HIDDEN }, what: "Send the hidden plan.", at: known }],
    },
  ]);
  const claims = (records.get(key) ?? []).map((one) => fingerprint(w.s.store.db.keys, "claim", one.claim.id));
  await asTablesOwner(w.s.store.db, ["knowledge.claims"], (query) =>
    query("update knowledge.claims set first_known_at = $1, created_at = $1 where id = any ($2)", [known, claims]),
  );
  const commitment = fingerprint(w.s.store.db.keys, "fact", key);
  const seeded = await session(w.s.store.db.urls.admin, async (query) => {
    const seed = seeder(w.s.store.db, query);
    const document = await seed.document(label, { title: "Hidden plan" });
    const reference = await seed.document(label, { title: "Hidden template" });
    await query("update knowledge.documents set reference = true where id = $1", [reference]);
    const card = testId("crd");
    await query(
      `insert into ledger.cards (id, request_id, created_at, created_by, kind, options, compartments)
       values ($1, $2, now(), 'system:seed', 'notice', '{acknowledge}', $3)`,
      [card, testId("req"), label],
    );
    // A later message in the commitment's thread, the close's evidence.
    const later = await seed.message(label, await seed.evidence(label, await seed.sourceAccount(label)), {
      held: false,
    });
    await query(
      "update knowledge.messages set thread_fp = (select m.thread_fp from knowledge.messages m where m.id = $2), sent_at = now() where id = $1",
      [later, support.message],
    );
    const goal = await seed.goalState(label);
    // The hidden person's second address.
    const address = testId("adr");
    await query(
      `insert into knowledge.accounts (id, entity_id, kind, value_fp, domain_fp, compartments, value_enc)
       values ($1, $2, 'email', $3, $4, $5, $6)`,
      [
        address,
        person.id,
        fingerprint(w.s.store.db.keys, "address", OTHER_ADDRESS),
        fingerprint(w.s.store.db.keys, "domain", OTHER_ADDRESS.split("@")[1] as string),
        label,
        JSON.stringify(
          sealRow(
            w.s.store.db.keys,
            HIDDEN,
            { table: "knowledge.accounts", id: address, column: "value_enc" },
            OTHER_ADDRESS,
          ),
        ),
      ],
    );
    const [move] = await query<{ id: string }>("select id from ledger.moves where opportunity_id = $1 limit 1", [
      added.task,
    ]);
    return { document, reference, card, goal, later, move: move?.id ?? "" };
  });
  // A run queued under employer:example, on the hidden message, as the tick queues one: the reasoner
  // takes it only once widened (widenReasoner).
  const run = testId("run");
  await queryAs(
    w.s.store.db.urls.work,
    `insert into ledger.runs (id, request_id, created_by, compartments, wake_source, wake_key, decision_point, definition_version, prompt_id, prompt_version)
     values ($1, $2, 'system:tick', $3, 'owner_request', $4, 'run_outcome', 1, 'reasoning_run', '1')`,
    [run, testId("req"), label, `owner_request:${run}`],
  );
  await queryAs(w.s.store.db.urls.work, "select ledger.add_basis('run', $1, $2, $3, $4, null)", [
    run,
    label,
    ["message"],
    [support.message],
  ]);
  await queryAs(
    w.s.store.db.urls.work,
    "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('run', $1, 'queued', clock_timestamp(), 'system:tick', $2)",
    [run, label],
  );
  // A project of the scout's after the listed asks' first transcript, beside addHiddenWork's.
  const filings = await w.work.proposeProject(w.scout.token, {
    name: "Hidden filings",
    requestId: testId("req") as never,
  });
  if (!filings.ok) throw new Error(`the scout's project was refused: ${text(filings)}`);
  const record = await w.reader.record(w.both.token, {
    kind: "note",
    body: "a note under a wider clearance",
    requestId: testId("req") as never,
  });
  if (!record.ok) throw new Error(`the wide client's record was refused: ${record.code}`);
  // The close cites an item its caller read whole.
  const read = await w.reader.readMessage(w.scout.token, { id: seeded.later as never });
  if (!read.ok) throw new Error(`the close's evidence was not read: ${read.code}`);
  const close = await w.reader.closeCommitment(w.scout.token, {
    commitment,
    ending: "done",
    evidence: [seeded.later as never],
    requestId: testId("req") as never,
  });
  if (!close.ok) throw new Error(`the hidden commitment's close was refused: ${text(close)}`);
  // An outcome test run of the wide client's own, under its clearance.
  const started = await w.work.startOutcomeTest(w.both.token, {
    suite: OUTCOME_SUITE,
    tasks: 3,
    answerModel: "model-a",
    judgeModel: "model-b",
    requestId: testId("req") as never,
  });
  if (!started.ok || !started.value.go)
    throw new Error(`the wide client's outcome test did not start: ${text(started)}`);
  const ops = await seedHiddenAgentOps(w);
  const time = await seedHiddenAgentTime(w);
  await settle(w.s);
  const { later: _later, ...rows } = seeded;
  return {
    ...rows,
    ...ops,
    ...time,
    run,
    entity: person?.id ?? "",
    message: support.message,
    event,
    fact: support.claim,
    commitment,
    close: close.value.close as string,
    outcomeRun: started.value.run as string,
    record: record.value.recordId as string,
    project: added.project,
    projectName: "Client onboarding",
    opportunity: added.task,
    idea: added.idea,
    improvement: added.improvement,
    title: "A hidden tool fails",
    thread: added.thread,
    client: "both",
    address: HIDDEN_PERSON.address,
    otherAddress: OTHER_ADDRESS,
  };
}
