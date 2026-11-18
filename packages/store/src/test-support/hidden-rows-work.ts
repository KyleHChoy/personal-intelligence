// Invariant 6's world for the work view's reads: the base world of hidden-rows-world.ts, with
// agents that work in it, the work a viewer of `own` sees, and later its hidden twin under
// employer:example. One database before and after, as the read tools' world is (hidden-rows-world.ts
// says why). Everything a viewer is shown is written through the work tools as an agent writes it,
// or as the owner's commands and the timers write it; the few rows no tool writes under
// employer:example (a reading, a job run, a box health card) are written as pi_admin.

import {
  CARD_OPTIONS,
  type CaptureId,
  type CardId,
  type EntityId,
  type OpportunityId,
  type ReadOutcome,
  type RequestId,
} from "@intelligence/contracts/personal";
import { createAdmin } from "../admin/admin.ts";
import { setClientRoles, setTaskTier } from "../admin/admin-tasks.ts";
import { createWork, type Work } from "../agent-work/work.ts";
import { raiseHealth } from "../core/box-health.ts";
import { newId } from "../core/ids.ts";
import { addCompartmentKey, type Keys, loadKeys } from "../core/keys.ts";
import { raiseCard } from "../core/queue.ts";
import { Reader } from "../read/read.ts";
import { seedMeeting } from "./capture-fixtures.ts";
import { testId } from "./clients.ts";
import { type Query, session } from "./connections.ts";
import { queryAs } from "./database.ts";
import { addHiddenProposal, WORK_TIME_WINDOW } from "./hidden-rows-agent-time.ts";
import type { Ask } from "./hidden-rows-asks.ts";
import { HIDDEN, INV6_NOW, type Inv6, openInv6, settle } from "./hidden-rows-world.ts";
import { recordingLogger } from "./recording.ts";
import { seeder } from "./seeder.ts";
import { MISSING_ENTITY } from "./values.ts";
import { AGENT_WORK_TOOLS, insertWorkClient, type WorkClient } from "./work-clients.ts";

// The agents. `narrow` and `peer` are cleared for `own` and each other's agent compartment, as the
// default clearances give agents that share; `bare` for `own` alone, with no record of its own;
// `scout` for employer:example and its own compartment; `both` for every compartment the key file
// holds, the measures' label among them.
const SHARED = ["own", "agent:narrow", "agent:peer"];
const AGENT_KEYS = ["agent:narrow", "agent:peer", "agent:scout", "agent:both"];
const READS = [
  "list_opportunities",
  "list_improvements",
  "get_health",
  "list_projects",
  "get_project",
  "read_agent_inbox",
  "build_context_pack",
  "get_self",
  "list_levers",
  "list_ideas",
  "get_work_time",
  "read_meeting",
];
const TOOLS = [
  ...AGENT_WORK_TOOLS,
  // The change feed, so the board's and the inbox's replies carry `changes.waiting`.
  "get_changes",
  ...READS.slice(1),
  "propose_task",
  "hand_off",
  "record",
  "find_records",
  "propose_project",
  "update_project",
  "post_agent_message",
  "submit_improvement",
  "update_improvement",
];
const DAY = 86_400_000;

export type WorkInv6 = {
  s: Inv6;
  keys: Keys;
  reader: Reader;
  work: Work;
  narrow: WorkClient;
  bare: WorkClient;
  peer: WorkClient;
  scout: WorkClient;
  both: WorkClient;
};

// What the asks name: a project, a defect, a thread, a piece of work, an idea and a recorded meeting.
export type WorkIds = {
  project: string;
  improvement: string;
  thread: string;
  task: string;
  idea: string;
  meeting: string;
};

const request = (): RequestId => testId("req") as RequestId;
const ok = <T>(outcome: ReadOutcome<T>): T => {
  if (!outcome.ok) throw new Error(`expected ok, got ${outcome.code}`);
  return outcome.value;
};

// One connection as pi_admin, as the work tests' world holds one: the admin's row locks need it.
const asAdmin = <T>(w: WorkInv6, fn: (query: Query) => Promise<T>): Promise<T> => session(w.s.store.db.urls.admin, fn);

const withBox = async <T>(w: WorkInv6, fn: (admin: ReturnType<typeof createAdmin>) => Promise<T>): Promise<T> => {
  const admin = createAdmin({ url: w.s.store.db.urls.admin, keys: w.keys as never, log: recordingLogger().log });
  try {
    return await fn(admin);
  } finally {
    await admin.close();
  }
};

// The base world, with the agents' keys added to its key file and the agents registered: the task
// tier on, each agent granted the investigate stage, and each that records given its source
// account, as registering one makes it.
export async function openWorkInv6(): Promise<WorkInv6> {
  const s = await openInv6();
  try {
    const db = s.store.db;
    for (const compartment of AGENT_KEYS) await addCompartmentKey(db.keyFile, compartment);
    const keys = await loadKeys(db.keyFile);
    const clock = { now: () => INV6_NOW };
    const reader = new Reader({ pool: s.store.readerPool, keys, log: s.store.log, ...clock });
    const work = createWork({ reader, log: s.store.log, ...clock });
    const client = (name: string, compartments: string[], tools: readonly string[] = TOOLS) =>
      insertWorkClient(db, name, compartments, { tools });
    const w: WorkInv6 = {
      s,
      keys,
      reader,
      work,
      narrow: await client("narrow", SHARED),
      bare: await client(
        "bare",
        ["own"],
        TOOLS.filter((tool) => tool !== "record"),
      ),
      peer: await client("peer", SHARED),
      scout: await client("scout", [HIDDEN, "agent:scout"]),
      both: await client("both", [...keys.compartments.keys()].sort()),
    };
    await asAdmin(w, async (query) => {
      await setTaskTier(query, true, new Date());
      for (const agent of [w.narrow, w.bare, w.peer, w.scout, w.both]) {
        await query(
          "insert into policy.harness_modes (id, client_id, opportunity_kind, stage, mode, granted_at) values ($1, $2, 'investigate', 'investigate', 'act', now())",
          [testId("hrn"), agent.id],
        );
        if (agent === w.bare) continue;
        await query(
          "insert into vault.source_accounts (id, label, connector, source_kind, compartments) values ($1, $2, 'agent', 'agent_record', $3)",
          [testId("acc"), `agent:${agent.name}`, [`agent:${agent.name}`]],
        );
      }
      // A role the viewer and the hidden agent both hold: `mine`, and a message to the role.
      for (const name of ["narrow", "scout"]) await setClientRoles(query, name, ["fixer"], new Date());
      // Defects go to that role, so `mine` and the health's counts by role have rows on both sides.
      await query("update policy.work_settings set defect_role = 'fixer'");
      await query("select ledger.assign_defects('fixer')");
    });
    return w;
  } catch (error) {
    await s.close().catch(() => {});
    throw error;
  }
}

// A message under `compartments`, as the seeder writes one.
const messageUnder = (w: WorkInv6, compartments: string[]): Promise<string> =>
  asAdmin(w, async (query) => {
    const seed = seeder(w.s.store.db, query);
    const evidence = await seed.evidence(compartments, await seed.sourceAccount(compartments.slice(0, 1)));
    return seed.message(compartments, evidence, { held: false });
  });

// An idea filed on a new message under `compartments`, or that message added to the idea named.
async function idea(w: WorkInv6, by: WorkClient, compartments: string[], to?: string): Promise<string> {
  const message = { kind: "message" as const, id: (await messageUnder(w, compartments)) as never };
  return ok(
    await w.work.proposeHypothesis(by.token, {
      kind: "idea",
      about: message,
      summary: "a shared calendar for the reading club",
      basis: [message],
      ...(to === undefined ? {} : { idea: to as never }),
      requestId: request(),
    }),
  ).hypothesis;
}

// A task about a new person, on a message the pipeline screened and did not withhold, all under
// `compartments`.
async function task(
  w: WorkInv6,
  by: WorkClient,
  compartments: string[],
  options: { project?: string; parent?: string; blockedBy?: string[] } = {},
): Promise<string> {
  const { subject, message } = await asAdmin(w, async (query) => {
    const seed = seeder(w.s.store.db, query);
    const subject = await seed.entity("person");
    await seed.account(compartments, subject);
    const evidence = await seed.evidence(compartments, await seed.sourceAccount(compartments.slice(0, 1)));
    const message = await seed.message(compartments, evidence, { held: false });
    await seed.pipelineItem(compartments, evidence);
    await query(
      "update vault.pipeline_items set waiting = false, withheld = false, screened = true where evidence_id = $1",
      [evidence],
    );
    return { subject, message };
  });
  return ok(
    await w.work.proposeTask(by.token, {
      kind: "investigate",
      about: { kind: "entity", id: subject as never },
      summary: "find who runs it and what it works on",
      basis: [{ kind: "message", id: message as never }],
      ...(options.project === undefined ? {} : { project: options.project as EntityId }),
      ...(options.parent === undefined ? {} : { parent: options.parent as OpportunityId }),
      ...(options.blockedBy === undefined ? {} : { blockedBy: options.blockedBy as OpportunityId[] }),
      requestId: request(),
    }),
  ).opportunity;
}

// Claimed by `by`, with one move planned and progress reported on it.
async function hold(w: WorkInv6, by: WorkClient, id: string, next: string): Promise<void> {
  ok(await w.work.claimOpportunity(by.token, { id: id as never, requestId: request() }));
  const { move } = ok(
    await w.work.planMove(by.token, { opportunity: id as never, stage: "investigate", requestId: request() }),
  );
  ok(
    await w.work.reportMove(by.token, {
      move: move as never,
      outcome: "progress",
      report: { done: ["read the first filing"], next },
      requestId: request(),
    }),
  );
}

const post = async (w: WorkInv6, from: WorkClient, args: Record<string, unknown>): Promise<string> =>
  ok(
    await w.work.postAgentMessage(from.token, {
      kind: "note",
      body: "the search tool times out",
      requestId: request(),
      ...args,
    } as never),
  ).message;

const submit = async (w: WorkInv6, by: WorkClient, title: string, severity: string): Promise<string> =>
  ok(
    await w.work.submitImprovement(by.token, {
      kind: "bug",
      area: "mcp",
      severity,
      title,
      detail: `detail of ${title}`,
      requestId: request(),
    } as never),
  ).improvement;

const update = async (w: WorkInv6, by: WorkClient, improvement: string, status: string, more = {}): Promise<void> => {
  ok(await w.work.updateImprovement(by.token, { improvement, status, requestId: request(), ...more } as never));
};

// Every lease held until one fixed time a day on, as pi_work, which alone may update one: no lease
// lapses between two transcripts of a run, and keeping the twin's leases moves no lease the
// viewer is shown.
const KEPT_UNTIL = new Date(Date.now() + DAY);
const keepLeases = (w: WorkInv6): Promise<unknown> =>
  queryAs(w.s.store.db.urls.work, "update queue.leases set lease_until = $1 where resource_kind = 'opportunity'", [
    KEPT_UNTIL,
  ]);

const VISIBLE_DEFECT = "Search times out";
// The area the visible project is in, and one that holds no project a viewer sees.
const SEEN_AREA = "field-work";
const OTHER_AREA = "back-office";

// What a viewer cleared for `own` is shown, before any twin: a box health card and the defect the
// filing pass files for it (the pass's readings and its other defects are under the measures'
// label, which no viewer here but `both` is cleared for); two defects agents filed, one triaged
// and given a role; a thread between two agents and a note to all; a project with a status, work
// under it that the viewer holds with progress, work that waits on it, and work under no project.
export async function seedVisible(w: WorkInv6): Promise<WorkIds> {
  await asAdmin(w, (query) => raiseHealth(query, new Date(), recordingLogger().log, "hold", "sync_hold"));
  await withBox(w, async (admin) => {
    await admin.box.recordNightly(3);
    await admin.box.fileImprovements();
  });

  const improvement = await submit(w, w.peer, VISIBLE_DEFECT, "medium");
  await submit(w, w.peer, "Timeline misses a day", "low");
  await update(w, w.narrow, improvement, "triaged", { note: "seen twice this week" });
  await withBox(w, (admin) => admin.box.setImprovementRole(improvement, "fixer"));

  const direct = await post(w, w.peer, { to: { client: "narrow" }, subject: "Search", body: "is search slow for you" });
  await post(w, w.narrow, { replyTo: direct, body: "yes, since Monday" });
  // The thread the asks name is the note to all: every viewer here sees it, and the wider client,
  // no party to the thread between two agents, may reply in it.
  const thread = await post(w, w.peer, { to: { all: true }, subject: "Heads up", body: "the board has new work" });
  await post(w, w.narrow, { replyTo: thread, body: "seen, thanks" });

  const project = ok(await w.work.proposeProject(w.peer.token, { name: "Kiln rebuild", requestId: request() }))
    .project as string;
  ok(
    await w.work.updateProject(w.peer.token, {
      project: project as EntityId,
      status: "blocked",
      note: "No brick.",
      requestId: request(),
    }),
  );
  // Two areas of the owner's, and the project in the first by the owner's word. An area's label is
  // `own`, so every viewer here sees both.
  await withBox(w, async (admin) => {
    await admin.areas.add(SEEN_AREA, "Field work");
    await admin.areas.add(OTHER_AREA, "Back office");
    await admin.areas.setProjectArea(project as EntityId, SEEN_AREA);
  });
  const first = await task(w, w.peer, ["own"], { project });
  await task(w, w.peer, ["own"], { project, blockedBy: [first] });
  await task(w, w.peer, ["own"]);
  await hold(w, w.narrow, first, "ask for a quote");
  // Two ideas under `own`, the first with later evidence added, the second newer still.
  const seenIdea = await idea(w, w.peer, ["own"]);
  await idea(w, w.narrow, ["own"], seenIdea);
  await idea(w, w.narrow, ["own"]);
  // A recorded meeting under `own`.
  const { id: meeting } = await seedMeeting(w.s.store.db, ["own"], "The kiln needs new brick.");
  await keepLeases(w);
  await settle(w.s);
  return { project, improvement, thread, task: first, idea: seenIdea, meeting };
}

// The twin, none of it under a label a viewer of `own` is cleared for: under employer:example, a
// project with a status, work under it with a parent and a blocker, work held with progress and
// parked with a note, defects with events and a role, and messages to all and to the viewer's
// role; under the wider client's label, a status and held work on the project the viewer sees, a
// second report of the defect the viewer sees, and a reply in the viewer's thread; and readings,
// job runs, a check result and a box health card the viewer is not cleared for.
export async function addHiddenWork(w: WorkInv6, seen: WorkIds): Promise<WorkIds> {
  const project = ok(await w.work.proposeProject(w.scout.token, { name: "Client onboarding", requestId: request() }))
    .project as string;
  ok(
    await w.work.updateProject(w.scout.token, {
      project: project as EntityId,
      status: "waiting",
      note: "Waiting on the contract.",
      requestId: request(),
    }),
  );
  // The hidden project in each area in turn, by the owner's word: its label lacks `own`, so no
  // viewer of `own` is shown it under either area, in either order, nor its work on the board.
  await withBox(w, async (admin) => {
    await admin.areas.setProjectArea(project as EntityId, OTHER_AREA);
    await admin.areas.setProjectArea(project as EntityId, SEEN_AREA);
  });
  const first = await task(w, w.scout, [HIDDEN], { project });
  const step = await task(w, w.scout, [HIDDEN], { project, parent: first });
  await task(w, w.scout, [HIDDEN], { project, blockedBy: [step] });
  await task(w, w.scout, [HIDDEN]);
  await hold(w, w.scout, first, "read the second filing");
  ok(
    await w.work.setIntention(w.scout.token, {
      opportunity: first as never,
      dueAt: new Date(Date.now() + 3 * DAY).toISOString() as never,
      park: true,
      note: "waiting on a reply",
      requestId: request(),
    }),
  );

  // The wider client, on what the viewer sees: each row is under its own label.
  ok(
    await w.work.updateProject(w.both.token, {
      project: seen.project as EntityId,
      status: "waiting",
      note: "Brick ordered.",
      requestId: request(),
    }),
  );
  await hold(w, w.both, await task(w, w.both, ["own"], { project: seen.project }), "confirm the delivery");
  // A higher severity than the defect's: a report under a wider clearance than the defect's label
  // is recorded and leaves the severity, the list's order and the health counts as they were.
  const merged = ok(
    await w.work.submitImprovement(w.both.token, {
      kind: "bug",
      area: "mcp",
      severity: "critical",
      title: VISIBLE_DEFECT,
      detail: "seen under a wider clearance too",
      requestId: request(),
    } as never),
  );
  if (merged.improvement !== seen.improvement) throw new Error("the wider report did not merge");
  await post(w, w.both, { replyTo: seen.thread, body: "for me as well" });
  await post(w, w.both, { to: { all: true }, subject: "Wider", body: "to all, from a wider clearance" });

  const improvement = await submit(w, w.scout, "A hidden tool fails", "critical");
  await submit(w, w.scout, "A hidden list is slow", "high");
  await update(w, w.scout, improvement, "triaged", { note: "hidden triage" });
  await update(w, w.scout, improvement, "in_progress", { fixRef: "pr:12" });
  // The wider client marks the defect the viewer sees a duplicate of the hidden one: the hidden
  // defect is not within the label the status would be written under, so the call answers as for
  // a defect that is not there and writes nothing.
  const marked = await w.work.updateImprovement(w.both.token, {
    improvement: seen.improvement,
    status: "duplicate",
    duplicateOf: improvement,
    requestId: request(),
  } as never);
  if (marked.ok || marked.code !== "not_found") throw new Error("a hidden duplicate was not answered as absent");
  await withBox(w, (admin) => admin.box.setImprovementRole(improvement, "fixer"));
  const thread = await post(w, w.scout, { to: { all: true }, subject: "Hidden", body: "to all, from employer" });
  await post(w, w.scout, { to: { role: "fixer" }, subject: "Hidden role", body: "to the fixers" });
  // An idea under employer:example, with later evidence; and evidence under the wider client's label
  // added to the idea the viewer sees, newer than any of its own, so it would move the idea first.
  const hiddenIdea = await idea(w, w.scout, [HIDDEN]);
  await idea(w, w.scout, [HIDDEN], hiddenIdea);
  await idea(w, w.both, [HIDDEN], seen.idea);
  // A recorded meeting under employer:example, of the device that recorded the one the viewer sees.
  const [{ account } = { account: "" }] = await asAdmin(w, (query) =>
    query<{ account: string }>("select source_account_id as account from knowledge.captures where id = $1", [
      seen.meeting,
    ]),
  );
  const { id: meeting } = await seedMeeting(w.s.store.db, [HIDDEN], "The hidden contract is signed.", account);

  const measures = [...w.keys.compartments.keys()].sort();
  await asAdmin(w, async (query) => {
    await query(
      `insert into ledger.measure_readings (metric, value, sample, state, compartments)
       values ('a_hidden_measure', 1, 1, 'ok', $1), ('nightly_red', 7, 1, 'failing', $2)`,
      [[HIDDEN], measures],
    );
    await query(
      `insert into ledger.job_runs (job, started_at, ended_at, code, about)
       values ('extract', now() - interval '3 minutes', now() - interval '2 minutes', 'failed', null),
              ('extract', now() - interval '2 minutes', now() - interval '1 minute', 'failed', null),
              ('extract', now() - interval '1 minute', now(), 'failed', null),
              ('canary', now() - interval '1 minute', now(), 'no_claim', 'mail')`,
    );
    // A box health card as raiseHealth raises one, under employer:example: the product raises
    // them under `own` alone, so this is the twin of a row only a later change could write.
    await raiseCard(
      query,
      {
        id: newId("crd") as CardId,
        requestId: newId("crd"),
        kind: "box_health",
        author: "system:health",
        options: [...CARD_OPTIONS.box_health],
        target: null,
        refs: [],
        compartments: [HIDDEN] as never,
        expiresAt: null,
        expiresAfterDays: null,
        caseKey: "box:hold:read_hold",
        run: null,
        body: null,
        bodyFrom: null,
      },
      { now: new Date(), log: recordingLogger().log },
    );
  });
  await keepLeases(w);
  await settle(w.s);
  // A live system proposal on the hidden project, under its label, which get_work_time lists to a
  // client cleared for it.
  const [{ compartments } = { compartments: [HIDDEN] }] = await asAdmin(w, (query) =>
    query<{ compartments: string[] }>("select compartments from knowledge.projects where id = $1", [project]),
  );
  await addHiddenProposal(w, project, compartments);
  return { project, improvement, thread, task: first, idea: hiddenIdea, meeting };
}

type WorkAsk = (token: string) => Promise<ReadOutcome<unknown>>;

// The sections of the bootstrap pack that hold the caller's work.
const WORK_SECTIONS = ["my_work", "handoff", "unreported"];

// Every ask a viewer can make of the work view's reads, in one fixed order: each scope and filter
// of the board, the improvement store with and without `mine` and one defect's history, the
// health read, the levers, the projects and one project, the inbox without marking anything read, and the
// bootstrap pack, whole and its work alone. `ids` are what the asks name.
export function workAsks(w: WorkInv6, ids: WorkIds, tag = ""): Ask[] {
  const { work, reader } = w;
  const asks: Ask[] = [];
  const add = (ask: string, call: WorkAsk): void => {
    asks.push({ ask: `${ask}${tag}`, call: (_reader, token) => call(token) });
  };
  const board = (name: string, args: Record<string, unknown>): void =>
    add(`list_opportunities ${name}`, (token) => work.listOpportunities(token, args as never));
  board("open", {});
  board("open undeclined", { excludeDeclined: true });
  board("open 1", { limit: 1 });
  board("mine", { scope: "mine" });
  board("board", { scope: "board" });
  board("board 1", { scope: "board", limit: 1 });
  board("board tasks", { scope: "board", tier: "task" });
  board("board opportunities", { scope: "board", tier: "opportunity" });
  board("board role", { scope: "board", role: "fixer" });
  board("board project", { scope: "board", project: ids.project });
  board("board area", { scope: "board", area: SEEN_AREA });
  board("board other area", { scope: "board", area: OTHER_AREA });
  board("closed", { scope: "closed" });

  const improvements = (name: string, args: Record<string, unknown>): void =>
    add(`list_improvements ${name}`, (token) => work.listImprovements(token, args as never));
  improvements("all", {});
  improvements("every status", { status: ["open", "triaged", "in_progress", "done", "wont_do", "duplicate"] });
  improvements("one a page", { limit: 1 });
  improvements("50", { limit: 50 });
  improvements("mine", { mine: true });
  improvements("open", { status: ["open"] });
  improvements("taken", { status: ["triaged", "in_progress"] });
  improvements("closed", { status: ["done", "wont_do", "duplicate"] });
  improvements("area", { area: "mcp" });
  improvements("mine open", { mine: true, status: ["open", "triaged", "in_progress"] });
  improvements("one", { improvement: ids.improvement });

  add("get_health", (token) => work.getHealth(token, {} as never));
  // The levers have no label: the same reply for every caller that holds the tool.
  add("list_levers", (token) => work.listLevers(token, {} as never));

  const projects = (name: string, args: Record<string, unknown>): void =>
    add(`list_projects ${name}`, (token) => work.listProjects(token, args as never));
  projects("all", {});
  projects("1", { limit: 1 });
  for (const status of ["active", "blocked", "waiting", "closed"]) projects(status, { status: [status] });
  projects("area", { area: SEEN_AREA });
  projects("other area", { area: OTHER_AREA });
  projects("by area", { order: "area" });
  projects("by area 1", { order: "area", limit: 1 });
  add("get_project", (token) => work.getProject(token, { project: ids.project as EntityId }));
  // The idea ledger, whole and one a page.
  add("list_ideas all", (token) => work.listIdeas(token, {}));
  add("list_ideas 1", (token) => work.listIdeas(token, { limit: 1 }));
  // Work time by place over a fixed window, with the live proposals in it.
  add("get_work_time", (token) => work.getWorkTime(token, WORK_TIME_WINDOW as never));
  // One recorded meeting by its id.
  add("read_meeting", (token) => work.readMeeting(token, { meeting: ids.meeting as CaptureId }));

  const inbox = (name: string, args: Record<string, unknown>): void =>
    add(`read_agent_inbox ${name}`, (token) => work.readAgentInbox(token, { markRead: false, ...args } as never));
  inbox("unread", {});
  inbox("all", { scope: "all" });
  inbox("all 50", { scope: "all", limit: 50 });
  inbox("thread", { scope: "thread", thread: ids.thread });

  add("build_context_pack agent_bootstrap", (token) => reader.buildContextPack(token, { purpose: "agent_bootstrap" }));
  add("build_context_pack my_work", async (token) => {
    const answer = await reader.buildContextPack(token, { purpose: "agent_bootstrap" });
    if (!answer.ok) return answer;
    const items = (answer.value as { items: { section: string }[] }).items;
    return { ok: true, value: items.filter((item) => WORK_SECTIONS.includes(item.section)) };
  });
  return asks;
}

// The asks that name one row, for ids that are not there at all: an id known only in hidden rows
// must answer exactly as these do.
export const ABSENT: WorkIds = {
  project: MISSING_ENTITY,
  improvement: `imp_7${"Z".repeat(25)}`,
  thread: `amg_7${"Z".repeat(25)}`,
  task: `opp_7${"Z".repeat(25)}`,
  idea: `hyp_7${"Z".repeat(25)}`,
  meeting: `cap_7${"Z".repeat(25)}`,
};

// The asks of workAsks that name a row: the same asks, for other ids.
export const namedAsks = (w: WorkInv6, ids: WorkIds, tag: string): Ask[] =>
  workAsks(w, ids, tag).filter((one) =>
    [
      "list_opportunities board project",
      "list_improvements one",
      "get_project",
      "read_agent_inbox thread",
      "read_meeting",
    ].some((name) => one.ask === `${name}${tag}`),
  );
