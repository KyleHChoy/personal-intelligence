import { PersonalWorkTool } from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { queryAs } from "../test-support/database.ts";
import { type Ask, transcript } from "../test-support/hidden-rows-asks.ts";
import {
  ABSENT,
  addHiddenWork,
  namedAsks,
  openWorkInv6,
  seedVisible,
  type WorkIds,
  type WorkInv6,
  workAsks,
} from "../test-support/hidden-rows-work.ts";
import { HIDDEN } from "../test-support/hidden-rows-world.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";

// I1, the work view's reads: with every ask a viewer not cleared for employer:example can make of
// the work tools that only read, the replies are byte-identical before and after the hidden twin's
// rows are added: under employer:example, and under a wider client's label on the very project,
// defect and thread the viewer sees. Two viewers: one cleared for `own` and the agent compartments
// of the agents it shares with, as agents are registered, and one cleared for `own` alone. Every
// comparison has its control: two runs of one world compare equal, and a client cleared for every
// compartment is given different replies. The read tools have read-tools-hidden-rows.db.test.ts.
// Not covered here: the tools that write (WRITES, below), whose refusals and replays are each
// tool's own tests'; a work tick, a deletion or an erasure over the hidden rows; and the closed
// board with hidden closed work.
//
// Do not weaken, skip or delete this test to make a change pass.

const TIMEOUT = SLOW_DB_TEST_TIMEOUT;

// The work tools that write. Every other work tool only reads, and must be asked here: a read tool
// added to the contract fails this test until it is asked, or listed here as one that writes.
const WRITES: readonly string[] = [
  "claim_opportunity",
  "release_opportunity",
  "propose_hypothesis",
  "record_test",
  "propose_opportunity",
  "plan_move",
  "report_move",
  "set_intention",
  "propose_task",
  "hand_off",
  "propose_goal",
  "propose_goal_target",
  "post_agent_message",
  "submit_improvement",
  "update_improvement",
  "propose_project",
  "update_project",
  "write_back",
  "record_spend",
  "start_outcome_test",
  "record_held_out_question",
  "record_outcome_task",
  "set_lever",
  "report_wrong_merge",
  "report_wrong_relation",
  "relay_card_answer",
  "mark_health_seen",
  "file_learning",
  "set_anchor",
  "lift_anchor",
  "rule_time",
  "lift_time_ruling",
  "judge_time_proposal",
];
// A read with no label: a setting is a number or a code, the same for every caller that holds the
// tool, so the twin has nothing to add to it and the wider client's reply does not differ either.
const UNLABELLED: readonly string[] = ["list_levers"];
// A read of one row by its id that no other row adds to: the wider client is answered the meeting
// the viewer sees the same before and after, and the twin's own meeting is asked by its id below.
const ONE_ROW: readonly string[] = ["read_meeting"];
// Read by an ask's own filter, not a tool of the work view: the bootstrap pack's my_work.
const PACK = "build_context_pack";

let w: WorkInv6;
let seen: WorkIds;
let added: WorkIds;
let asks: Ask[];
// Each viewer's transcript before the twin and after it, and the wider client's.
const base = new Map<string, string[]>();
const hidden = new Map<string, string[]>();
let wideBase: string[];

const viewers = (): { name: string; token: string }[] => [
  { name: "narrow", token: w.narrow.token },
  { name: "bare", token: w.bare.token },
];

beforeAll(async () => {
  w = await openWorkInv6();
  seen = await seedVisible(w);
  asks = workAsks(w, seen);
  for (const { name, token } of viewers()) base.set(name, await transcript(w.s, asks, token));
  wideBase = await transcript(w.s, asks, w.both.token);
  added = await addHiddenWork(w, seen);
  for (const { name, token } of viewers()) hidden.set(name, await transcript(w.s, asks, token));
}, TIMEOUT);

afterAll(async () => {
  await w?.s.close();
});

// The first line that differs, for a readable failure.
const firstDifference = (a: string[], b: string[]): string | null => {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1)
    if (a[index] !== b[index]) return `${a[index] ?? "(none)"}\n--- became ---\n${b[index] ?? "(none)"}`;
  return null;
};

const reply = (line: string | undefined): string => line?.slice(line.indexOf("\t") + 1) ?? "";
const line = (lines: string[] | undefined, ask: string): string =>
  reply(lines?.find((one) => one.startsWith(`${ask}\t`)));

describe("I1: a viewer's work reads do not change with rows it cannot see", { timeout: TIMEOUT }, () => {
  it("the asks reach every work tool that only reads", () => {
    for (const tool of WRITES) expect(PersonalWorkTool.options, tool).toContain(tool);
    const reads = PersonalWorkTool.options.filter((tool) => !WRITES.includes(tool));
    const asked = new Set(asks.map((one) => one.ask.split(" ")[0]));
    expect([...asked].sort()).toEqual([...reads, PACK].sort());
  });

  it("the base world gives each viewer something to see", () => {
    const narrow = base.get("narrow");
    // No ask of the viewer that shares is refused; the one cleared for `own` alone is answered
    // not_found for a project it cannot see, before and after alike.
    for (const one of narrow ?? []) expect(one, one.split("\t")[0]).toContain('"ok":true');
    expect(line(narrow, "list_opportunities mine")).toContain(seen.task);
    expect(line(narrow, "list_opportunities mine")).toContain('"progress":{');
    expect(line(narrow, "list_opportunities board")).toContain(seen.task);
    expect(line(narrow, "list_opportunities board project")).toContain(seen.task);
    expect(line(narrow, "list_improvements mine")).toContain(seen.improvement);
    expect(line(narrow, "list_improvements one")).toContain('"events":[{');
    expect(line(narrow, "list_projects blocked")).toContain(seen.project);
    // Part C: the project's area is served, a filter by it finds the project and its work, and a
    // filter by the other area finds neither.
    expect(line(narrow, "list_projects area")).toContain(seen.project);
    expect(line(narrow, "list_projects area")).toContain('"key":"field-work"');
    expect(line(narrow, "list_projects other area")).not.toContain(seen.project);
    expect(line(narrow, "list_projects by area")).toContain(seen.project);
    expect(line(narrow, "list_opportunities board area")).toContain(seen.task);
    expect(line(narrow, "list_opportunities board other area")).not.toContain(seen.task);
    expect(line(narrow, "get_project")).toContain(seen.task);
    expect(line(narrow, "read_agent_inbox thread")).toContain(seen.thread);
    expect(line(narrow, "build_context_pack my_work")).toContain(seen.task);
    expect(line(narrow, "list_levers")).toContain('"key":"lessons.digest_weekly"');
    expect(line(narrow, "read_meeting")).toContain("The kiln needs new brick.");
    // The board's and the inbox's replies carry the change feed's count, so it is compared too:
    // the note to all and the work newly the viewer's wait in its feed.
    for (const ask of ["list_opportunities open", "list_opportunities board", "read_agent_inbox unread"])
      expect(line(narrow, ask), ask).toMatch(/"changes":\{"waiting":[1-9]\d*\}/);
    // The box health card, in the owner's own compartment, and the defect filed for it: both viewers'.
    for (const lines of base.values()) {
      expect(line(lines, "get_health")).toContain('"cards":[{');
      expect(line(lines, "get_health")).toContain('"defects":[{');
      // The measures are under a label neither is cleared for.
      expect(line(lines, "get_health")).toContain('"measures":[],"checks":[],"jobs":[]');
    }
  });

  it("the hidden twin added rows a viewer of `own` is not cleared for in every table it names", async () => {
    const [row] = await queryAs<Record<string, number>>(
      w.s.store.db.urls.admin,
      `select
         (select count(*)::int from knowledge.projects where $1 = any (compartments)) as projects,
         (select count(*)::int from ledger.opportunities where $1 = any (compartments)) as opportunities,
         (select count(*)::int from ledger.opportunities where $1 = any (compartments) and project_id = $2) as under_the_seen_project,
         (select count(*)::int from ledger.moves where $1 = any (compartments)) as moves,
         (select count(*)::int from ledger.record_events where $1 = any (compartments) and row_kind = 'move' and code = 'progress') as progress,
         (select count(*)::int from ledger.intentions where $1 = any (compartments) and kind = 'check_back') as check_backs,
         (select count(*)::int from knowledge.claims where $1 = any (compartments)) as claims,
         (select count(*)::int from ledger.improvements where $1 = any (compartments) and client_id is not null) as improvements,
         (select count(*)::int from ledger.improvement_events where $1 = any (compartments) and event = 'status') as statuses,
         (select count(*)::int from ledger.improvement_events where $1 = any (compartments) and improvement_id = $3) as reports_of_the_seen_defect,
         (select count(*)::int from ledger.agent_messages where $1 = any (compartments)) as messages,
         (select count(*)::int from ledger.agent_messages where $1 = any (compartments) and thread_id = $4) as in_the_seen_thread,
         (select count(*)::int from ledger.measure_readings where $1 = any (compartments)) as readings,
         (select count(*)::int from ledger.job_runs) as job_runs,
         (select count(*)::int from ledger.cards where $1 = any (compartments) and kind = 'box_health') as health_cards`,
      [HIDDEN, seen.project, seen.improvement, seen.thread],
    );
    for (const [table, count] of Object.entries(row ?? { none: 0 })) expect(count, table).toBeGreaterThanOrEqual(1);
  });

  it("every reply is byte-identical after the hidden rows are added", () => {
    for (const { name } of viewers()) {
      const [before, after] = [base.get(name) ?? [], hidden.get(name) ?? []];
      expect(firstDifference(before, after), name).toBeNull();
      expect(after, name).toEqual(before);
    }
  });

  it("control: two runs of one world compare equal", async () => {
    for (const { name, token } of viewers()) expect(await transcript(w.s, asks, token), name).toEqual(hidden.get(name));
  });

  it("control: a client cleared for every compartment is given different replies, tool by tool", async () => {
    const wideHidden = await transcript(w.s, asks, w.both.token);
    expect(wideHidden).not.toEqual(wideBase);
    // Each read tool's replies differ somewhere: the twin reaches every tool, not one of them.
    const tools = [...new Set(asks.map((one) => one.ask.split(" ")[0]))];
    for (const tool of tools) {
      const of = (lines: string[]) => lines.filter((one) => one.startsWith(`${tool} `) || one.startsWith(`${tool}\t`));
      if (UNLABELLED.includes(tool ?? "") || ONE_ROW.includes(tool ?? ""))
        expect(of(wideHidden), tool).toEqual(of(wideBase));
      else expect(of(wideHidden), tool).not.toEqual(of(wideBase));
    }
  });

  it("each id known only in hidden rows answers exactly as an id that is not there", async () => {
    const [known, absent] = [namedAsks(w, added, ""), namedAsks(w, ABSENT, "")];
    expect(known).toHaveLength(5);
    for (const { name, token } of viewers()) {
      const [got, want] = [await transcript(w.s, known, token), await transcript(w.s, absent, token)];
      for (const [index, one] of got.entries())
        expect(reply(one), `${name}: ${known[index]?.ask}`).toBe(reply(want[index]));
    }
    // Control: the wider client is served each of them.
    const served = await transcript(w.s, known, w.both.token);
    expect(line(served, "get_project")).toContain(added.task);
    expect(line(served, "list_improvements one")).toContain(added.improvement);
    expect(line(served, "read_agent_inbox thread")).toContain(added.thread);
    expect(line(served, "list_opportunities board project")).toContain(added.task);
    expect(line(served, "read_meeting")).toContain("The hidden contract is signed.");
    // Part C: the hidden project is in the visible project's area, so the wider client is served
    // its work under that area, which no viewer of `own` alone was.
    // The area's key names no hidden row, so its ask is not among the named ones: it is read from
    // the wider client's whole transcript.
    expect(line(await transcript(w.s, asks, w.both.token), "list_opportunities board area")).toContain(added.task);
  });
});
