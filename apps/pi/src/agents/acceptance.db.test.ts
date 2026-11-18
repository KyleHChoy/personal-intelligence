import type { PersonalTool, PersonalView } from "@intelligence/contracts/personal";
import { REGISTRY } from "@intelligence/personal-ladder";
import {
  type Admin,
  createAdmin,
  createReader,
  createWork,
  type Reader,
  type Work,
} from "@intelligence/personal-store";
import { type WorkWorld, withWorkWorld } from "@intelligence/personal-store/testing";
import { describe, expect, it } from "vitest";
import { runTick } from "../work/tick.ts";

// The acceptance run: the loop the system is built for, played end to end on a synthetic world, as
// a script an agent could follow. Every step an agent takes is one call of the agent API, the calls
// a client with no shell and no repository has; the filing pass, the coverage record and the work
// tick are the box's own jobs, run here as the box's timer runs them. Each step asserts the reply.
//
//   1. The owner is asked too much: the measure of questions a week is over its line on two filing
//      passes, and the second files a defect. The box's record finds seven lanes silent, and each
//      condition files a defect of its own.
//   2. The work tick raises a task for the measure's defect, and five, no more, for the box health
//      defects of the same role.
//   3. An agent reads the health with the measure's parts and the box, lists its defects, claims
//      the task, finds the lever that measure judges, moves it, takes the defect with that lever as
//      its fix reference, reports progress and reports done. A lever it did not move, and a claim
//      of no fix, do not take the defect.
//   4. The measure recovers, and the next filing pass closes the defect. A box health condition
//      ends, and its defect closes with nothing named.
//   5. Work that lasts days: an agent creates a project, proposes a task under it, claims it,
//      reports progress on two days, defers it with a note and hands it off; a second agent claims
//      it and reads the project back in one call: both reports, the note and the hand-off.
//   6. The outcomes report's goal line counts no act of the owner's for any of it, and says what
//      each closed defect was taken with.
//   7. The deferral comes due after the hand-off: the tick cancels the first holder's check-back
//      and leaves the work with the agent that holds it.
//   8. A defect task nobody claimed expires, and is raised again while its defect stands.
//
// What this run does for the agents, which an agent cannot do itself. A pass here is not "an agent
// did all of this unaided":
// - The measure is made to fail by forty-five question cards written as the admin, and it recovers
//   because the admin's clock is moved past the measure's window, not because the lever worked. The agent's change is real (the lever
//   is moved and its history holds it) and so is the reference, which the store checks; whether
//   moving that lever lowers the questions is not exercised. Step 4 proves the filing pass closes
//   the defect once the measure reads ok, and that the close counts as taken with a lever.
// - Time is moved by hand: the admin's clock is set forward for the filing passes, the lease rows
//   are aged by an update as pi_work, and the later ticks are given times days on.
// - The filing pass, the coverage record and the work tick are called directly, in the order the
//   steps need, not by the box's timers. Nothing pings an agent: each agent's calls are made by
//   this script at the moment the script chooses.
// - Ids are handed in: the defect's id is read through the agent's own list, but the task, the
//   move, the project and the work are carried from one call's reply to the next by the script,
//   and the second agent is told which work to claim instead of finding it on its board.
// - The setup is the owner's commands: the task tier, both agents with their tools (the lever tool
//   among them), views and compartments, their roles, their harness grants, and the role defects
//   go to. Without that last command no agent is assigned a defect and no task is raised.
// - The goal line is read through the admin, which no agent holds.
// - There is no model, no harness and no code change. Whether a real agent can find the cause is
//   not exercised: the script knows which lever to move.
//
// Synthetic rows only; names, roles and words are examples.

const TIMEOUT = 600_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const VIEWS: PersonalView[] = ["self", "people", "work"];
const TOOLS: PersonalTool[] = [
  "get_self",
  "record",
  "list_opportunities",
  "claim_opportunity",
  "plan_move",
  "report_move",
  "set_intention",
  "propose_task",
  "hand_off",
  "get_health",
  "list_improvements",
  "update_improvement",
  "list_levers",
  "set_lever",
  "propose_project",
  "update_project",
  "list_projects",
  "get_project",
];
const AGENTS = ["fixer", "second"] as const;
const WORLD = ["own", ...AGENTS.map((name) => `agent:${name}`)];
// The measure this run follows: the questions that reach the owner a week, which the one lever an
// agent may move is judged by.
const MEASURE = "owner_questions_per_week";
const CAUSE = `measure_floor:${MEASURE}`;
const LEVER = "lessons.digest_weekly";
const WINDOW_DAYS = 30;
// Forty-five questions in the filing pass's fourteen days: over the line of twenty a week.
const QUESTIONS = 45;
// Lanes the box's record finds silent: more than the five tasks one role is given at a time.
const LANES = 7;
const lane = (n: number) => `q${String(n).padStart(2, "0")}`;

const ok = <T>(outcome: { ok: true; value: T } | { ok: false; code: string }): T => {
  if (!outcome.ok) throw new Error(`answered ${outcome.code}`);
  return outcome.value;
};
let serial = 0;
const request = (): string => `acceptance-${String((serial += 1)).padStart(6, "0")}`;

type Agent = { name: string; token: string; id: string };
type Api = { admin: Admin; reader: Reader; work: Work };

// The owner's setup, each the owner's own command: an agent registered, its roles, and what it may
// do on a research or an investigate task.
async function register(w: WorkWorld, admin: Admin, name: string, roles: string[]): Promise<Agent> {
  const { token } = await admin.clients.addClient({
    name,
    kind: "agent",
    runtime: "local",
    vendorRetention: "none",
    compartments: WORLD as never,
    views: VIEWS,
    tools: TOOLS,
  });
  await admin.work.setClientRoles(name, roles);
  for (const kind of ["research", "investigate"] as const)
    await admin.work.grantHarnessMode({ client: name as never, kind, stage: "investigate", mode: "act" });
  const [row] = await w.admin<{ id: string }>("select id from policy.clients where name = $1", [name]);
  return { name, token, id: row?.id ?? "" };
}

// The defect tasks of one defect, oldest first, each with where it stands.
const tasksOf = (w: WorkWorld, defect: string) =>
  w.admin<{ subject: string; event: string }>(
    `select o.gap_subject as subject,
       (select r.event from ledger.record_events r where r.row_kind = 'opportunity' and r.row_id = o.id order by r.id desc limit 1) as event
     from ledger.opportunities o where o.gap_trigger = 'defect' and o.gap_source = $1 order by o.created_at, o.id`,
    [defect],
  );

// Hours pass on a piece of held work: its lease row moved back, as pi_work, which alone may update
// it. The database's functions read their own clock, so this is how a test moves it.
const age = (w: WorkWorld, opportunity: string, hours: number): Promise<unknown> =>
  w.work(
    `update queue.leases set lease_until = lease_until - make_interval(hours => $2::int),
       first_taken_at = first_taken_at - make_interval(hours => $2::int),
       preferred_until = preferred_until - make_interval(hours => $2::int)
     where resource_kind = 'opportunity' and resource_id = $1`,
    [opportunity, hours],
  );

// One of the caller's defects by its cause, over every page of the list.
const defectOf = async ({ work }: Api, agent: Agent, args: Record<string, unknown>, cause = CAUSE) => {
  let after: string | undefined;
  for (;;) {
    const page = ok(
      await work.listImprovements(agent.token, {
        limit: 50,
        ...args,
        ...(after === undefined ? {} : { after }),
      } as never),
    );
    const found = page.improvements.find((one) => one.cause === cause);
    if (found !== undefined || !page.more) return found;
    after = page.next;
  }
};
const boardOf = async ({ work }: Api, agent: Agent) =>
  ok(await work.listOpportunities(agent.token, { scope: "board" })).opportunities;
const claim = ({ work }: Api, agent: Agent, id: string) =>
  work.claimOpportunity(agent.token, { id: id as never, requestId: request() as never });
const progress = ({ work }: Api, agent: Agent, move: string, report: { done: string[]; next: string }) =>
  work.reportMove(agent.token, {
    move: move as never,
    outcome: "progress",
    report,
    requestId: request() as never,
  } as never);

describe("the acceptance run", () => {
  it(
    "a defect is filed, worked and closed, and work lasts days and changes hands, with no act of the owner's",
    () =>
      withWorkWorld(
        async (w) => {
          // The filing pass reads the admin's clock; the database and the tick read their own.
          const start = new Date();
          let clock = start;
          const admin = createAdmin({
            url: w.db.urls.admin,
            keys: w.db.keys,
            log: w.log,
            recordEnabled: true,
            now: () => clock,
          });
          const reader = createReader({ url: w.db.urls.reader, keys: w.db.keys, log: w.log });
          const api: Api = { admin, reader, work: createWork({ reader, log: w.log }) };
          const { work } = api;
          const dispatch = w.dispatch();
          const tick = (at?: Date) =>
            runTick({ dispatch, registry: REGISTRY, log: w.log, now: () => at ?? new Date() });
          const goal = async () => (await admin.box.outcomes(WINDOW_DAYS)).headline.goal;
          try {
            // Setup, the owner's: the task tier on, two agents, their roles, the role defects go to.
            await admin.work.setTaskTier(true);
            const fixer = await register(w, admin, "fixer", ["builder"]);
            const second = await register(w, admin, "second", ["reviewer"]);
            await admin.work.setDefaultTaskRole("builder");
            // The goal's measure says nothing while no agent is assigned the defects.
            expect((await goal()).defectsWithoutOwner).toMatchObject({ state: "no_data", code: "no_defect_role" });
            await admin.box.setDefectRole("builder");
            // Forty-five questions already reached the owner, a minute before the first pass, so
            // both passes count them: what the loop below is about, and no part of it.
            const asked = new Date(start.getTime() - 60_000);
            for (let n = 0; n < QUESTIONS; n += 1) await w.card({ kind: "owner_question", at: asked });
            // The goal line before the loop. The setup's commands are acts the measure sees.
            const before = await goal();
            expect(before.ownerActions.metric).toBe("owner_actions_per_week");
            expect(before.ownerActions.sample).toBeGreaterThan(0);
            expect(before.ownerActions.parts?.commands).toBe(before.ownerActions.sample);
            expect(before.defectsWithoutOwner).toMatchObject({ sample: 0, state: "no_data", code: "small_sample" });

            // 1. The box's own record finds seven lanes silent. The measure of the owner's questions
            // is over its line on two passes, and the second files its defect.
            const silent = Array.from({ length: LANES }, (_, n) => ({
              kind: "lane" as const,
              id: lane(n),
              state: "silent" as const,
              code: "due_not_committed",
              counts: {},
            }));
            await admin.box.recordCoverage(silent);
            await admin.box.fileImprovements();
            // One failing reading files nothing for the measure.
            expect(await defectOf(api, fixer, {})).toBeUndefined();
            clock = new Date(start.getTime() + 13 * HOUR);
            expect((await admin.box.fileImprovements()).filed).toBeGreaterThanOrEqual(1);

            // 2. The work tick raises one task for the measure's defect, for its role. The box
            // health conditions are more than five defects for the same role: five tasks, no more.
            await tick();
            const boxTasks = await w.admin<{ source: string; cause: string }>(
              `select o.gap_source as source, i.cause from ledger.opportunities o join ledger.improvements i on i.id = o.gap_source
               where o.gap_trigger = 'defect' and i.cause like 'box_health:%'
                 and (select r.event from ledger.record_events r where r.row_kind = 'opportunity' and r.row_id = o.id order by r.id desc limit 1) = 'go'
               order by o.gap_source`,
              [],
            );
            expect(boxTasks).toHaveLength(5);

            // 3. The agent's turn. It reads the health: the measure is failing, above its line, and
            // its parts say what the questions were; the box says what stands and what runs.
            const health = ok(await work.getHealth(fixer.token, {} as never));
            const reading = health.measures.find((one) => one.metric === MEASURE);
            expect(reading).toMatchObject({ state: "failing", healthy: { test: "at_most", value: 20 } });
            expect(reading?.parts?.owner_question).toBe(QUESTIONS);
            expect(health.box).toMatchObject({ holds: [], migration: expect.stringMatching(/^\d{4}$/) });
            expect(health.cards.length).toBeGreaterThanOrEqual(LANES);
            expect(health.defects.reduce((sum, one) => sum + one.open, 0)).toBeGreaterThan(LANES);
            // Its defects: those whose role it holds.
            const filed = await defectOf(api, fixer, { mine: true });
            expect(filed).toMatchObject({ status: "open", assigneeRole: "builder", by: "system", fixRef: null });
            expect(filed?.title?.untrusted).toBe("Measure above its healthy line");
            expect(filed?.causeState).toMatch(/ line=at_most_20 side=above$/);
            const defect = filed?.id ?? "";
            // Another role's agent is not listed it as its own.
            expect(await defectOf(api, second, { mine: true })).toBeUndefined();
            // The task the tick raised, on the board: about the defect, by its id alone.
            const raised = (await boardOf(api, fixer)).filter(
              (one) => one.gap?.trigger === "defect" && one.gap.ask?.endsWith(` The defect: ${defect}.`) === true,
            );
            expect(raised).toHaveLength(1);
            expect(raised[0]).toMatchObject({ kind: "research", tier: "task", role: "builder", status: "go" });
            const task = raised[0]?.id ?? "";
            // It claims the task.
            expect(ok(await claim(api, fixer, task)).opportunity).toMatchObject({ id: task, status: "claimed" });
            // It takes the defect by naming what it changed. Nothing named, a lever it has not
            // moved, and a look with no fix do not take it.
            const take = (fixRef?: string) =>
              work.updateImprovement(fixer.token, {
                improvement: defect,
                status: "in_progress",
                ...(fixRef === undefined ? {} : { fixRef }),
                requestId: request(),
              } as never);
            expect(await take()).toMatchObject({ ok: false, refusal: "needs_fix_ref" });
            expect(await take(`lever:${LEVER}`)).toMatchObject({ ok: false, refusal: "fix_ref_refused" });
            expect(await take("none:not_reproducible")).toMatchObject({ ok: false, refusal: "fix_ref_refused" });
            // The lever this measure once judged limits nothing since the owner's no-cap ruling, so
            // moving it fixes nothing: the agent takes the defect with the change it made.
            ok(await take("pr:4242"));
            expect(await defectOf(api, fixer, { mine: true })).toMatchObject({
              status: "in_progress",
              heldBy: "fixer",
              fixRef: "pr:4242",
            });
            // No agent closes a defect the system filed: its measure does.
            expect(
              await work.updateImprovement(fixer.token, {
                improvement: defect,
                status: "done",
                requestId: request(),
              } as never),
            ).toMatchObject({ ok: false, refusal: "closes_by_measure" });
            // It plans its move and says where the work stands.
            const { move } = ok(
              await work.planMove(fixer.token, {
                opportunity: task as never,
                stage: "investigate",
                requestId: request() as never,
              }),
            );
            expect(
              ok(
                await progress(api, fixer, move, {
                  done: ["found the lesson cards among the questions"],
                  next: "ask fewer",
                }),
              ),
            ).toEqual({ move, opportunity: "claimed" });
            // It writes what it found, and reports done citing it.
            const finding = ok(
              await reader.record(fixer.token, {
                kind: "finding",
                body: "The owner is asked more than twenty questions a week. The fix is in pull request 4242.",
                requestId: request(),
              } as never),
            ).recordId;
            expect(
              ok(
                await work.reportMove(fixer.token, {
                  move: move as never,
                  outcome: "done",
                  report: {
                    deliverable: "The weekly lesson cards are lowered to two.",
                    next: "The next filing passes read the measure.",
                    sources: [{ kind: "agent_record", id: finding }, "the health read's parts"],
                  },
                  requestId: request() as never,
                } as never),
              ),
            ).toMatchObject({ move, opportunity: "done" });
            // A pass a day on: nothing moved the unread lever, and its guard never blames it.
            clock = new Date(start.getTime() + 26 * HOUR);
            await admin.box.fileImprovements();
            expect(await defectOf(api, fixer, {}, `lever_change:${LEVER}`)).toBeUndefined();

            // 4. A lane is covered again at the box's next record: its card is withdrawn. Sixteen
            // days on the questions have left the measure's window. The next filing pass reads the
            // measure ok and closes its defect, and closes the lane's with nothing named.
            await admin.box.recordCoverage([{ kind: "lane", id: lane(0), state: "covered", counts: {} }]);
            clock = new Date(start.getTime() + 16 * DAY);
            expect((await admin.box.fileImprovements()).closed).toBeGreaterThanOrEqual(2);
            expect(await defectOf(api, fixer, { status: ["done"] })).toMatchObject({ id: defect, status: "done" });
            expect(await defectOf(api, fixer, { status: ["done"] }, `box_health:silent:lane.${lane(0)}`)).toMatchObject(
              { status: "done", fixRef: null },
            );
            const recovered = ok(await work.getHealth(fixer.token, {} as never));
            expect(recovered.measures.find((one) => one.metric === MEASURE)).toMatchObject({ state: "ok" });
            // The tick leaves no task open for it.
            await tick();
            expect(
              (await boardOf(api, fixer)).filter(
                (one) => one.gap?.ask?.endsWith(` The defect: ${defect}.`) === true && one.status !== "done",
              ),
            ).toEqual([]);
            // Who wrote on the defect: the agent and the measure, never the owner.
            const authors = (
              await w.admin<{ created_by: string }>(
                "select distinct created_by from ledger.improvement_events where improvement_id = $1",
                [defect],
              )
            ).map((row) => row.created_by);
            expect(authors).toEqual(expect.arrayContaining([`client:${fixer.id}`, "system:measure"]));
            expect(authors).not.toContain("owner");

            // 5. Work that lasts days. The agent creates a project and a task under it.
            const project = ok(
              await work.proposeProject(fixer.token, { name: "Backup drill", requestId: request() } as never),
            ).project;
            const subject = await w.person();
            const basis = await w.mail();
            const proposed = ok(
              await work.proposeTask(fixer.token, {
                kind: "investigate",
                about: { kind: "entity", id: subject.id },
                summary: "find who keeps the second copy and how it is tested",
                basis: [{ kind: "message", id: basis.id }],
                project,
                requestId: request(),
              } as never),
            );
            expect(proposed).toMatchObject({ status: "go" });
            const long = proposed.opportunity as string;
            ok(await claim(api, fixer, long));
            const step = ok(
              await work.planMove(fixer.token, {
                opportunity: long as never,
                stage: "investigate",
                requestId: request() as never,
              }),
            ).move;
            // Day one's report.
            const first = { done: ["read the last drill's notes"], next: "ask who holds the second copy" };
            expect(ok(await progress(api, fixer, step, first))).toEqual({ move: step, opportunity: "claimed" });
            // A day passes, six hours at a time: the lease runs out, the tick returns the work to
            // the board for its holder alone, and the holder takes it back.
            for (let beat = 0; beat < 4; beat += 1) {
              await age(w, long, 6);
              await tick();
              // Another agent is not given it while it is its holder's.
              if (beat === 0) expect(await claim(api, second, long)).toMatchObject({ ok: false });
              expect(ok(await claim(api, fixer, long)).opportunity).toMatchObject({ id: long, status: "claimed" });
            }
            // Day two's report: what is done so far, and what comes next.
            const latest = {
              done: ["read the last drill's notes", "found who holds the second copy"],
              next: "run the restore with them",
            };
            expect(ok(await progress(api, fixer, step, latest))).toEqual({ move: step, opportunity: "claimed" });
            // Where the project stands, in the agent's word.
            ok(await work.updateProject(fixer.token, { project, status: "waiting", requestId: request() } as never));
            // It defers the task two days, with a note.
            const deferred = ok(
              await work.setIntention(fixer.token, {
                opportunity: long,
                dueAt: new Date(Date.now() + 2 * DAY).toISOString(),
                note: "the holder of the second copy is back on Thursday",
                requestId: request(),
              } as never),
            );
            expect(deferred.intention).toMatch(/^itn_/);
            // It hands the task to the reviewing role.
            expect(
              ok(
                await work.handOff(fixer.token, {
                  id: long,
                  role: "reviewer",
                  reason: "other_role",
                  requestId: request(),
                } as never),
              ),
            ).toEqual({ handedOff: true });
            // The second agent claims it: its brief answers where the work was left.
            const taken = ok(await claim(api, second, long));
            expect(taken.opportunity).toMatchObject({ id: long, status: "claimed" });
            expect(taken.brief?.progress).toMatchObject({ next: { untrusted: latest.next }, by: "fixer" });
            // And reads the project back in one call: its status, its open work with its holder
            // and the latest report, and the hand-off among the work's steps.
            const view = ok(await work.getProject(second.token, { project } as never));
            expect(view.status).toMatchObject({ value: "waiting", by: { kind: "agent", client: "fixer" } });
            expect(view.work.map((one) => one.id)).toEqual([long]);
            expect(view.work[0]).toMatchObject({
              holder: "second",
              status: "claimed",
              progress: {
                done: latest.done.map((line) => ({ untrusted: line })),
                next: { untrusted: latest.next },
                by: "fixer",
              },
            });
            expect(view.changes).toEqual(
              expect.arrayContaining([
                expect.objectContaining({ kind: "status", value: "waiting" }),
                expect.objectContaining({ kind: "work", opportunity: long, event: "claimed" }),
                expect.objectContaining({ kind: "work", opportunity: long, event: "routed" }),
              ]),
            );
            // How the work went, in the same call: both days' reports, the newest first.
            expect(view.work[0]?.reports?.map((one) => one.next)).toEqual([
              { untrusted: latest.next },
              { untrusted: first.next },
            ]);
            expect(view.work[0]?.reports?.[1]).toMatchObject({
              done: first.done.map((line) => ({ untrusted: line })),
              by: "fixer",
            });
            // The first holder's check-back with its note, and the hand-off: who, to whom and why.
            expect(view.work[0]?.checkBack).toMatchObject({
              dueAt: expect.any(String),
              note: { untrusted: "the holder of the second copy is back on Thursday" },
              by: "fixer",
            });
            // The hand-off ended the first holder's hold: its check-back no longer waits.
            expect(view.work[0]?.checkBack?.waiting).toBe(false);
            expect(view.work[0]?.handOff).toMatchObject({ by: "fixer", to: "reviewer", reason: "other_role" });

            // 7. The deferral's date passes: the tick runs an hour past the check-back's time. The
            // check-back was the first holder's and the hand-off cancelled it, so the tick finds
            // nothing to fire and takes nothing from the agent that holds the work.
            const intentionEvents = () =>
              w.admin<{ event: string }>(
                "select event from ledger.record_events where row_kind = 'intention' and row_id = $1 order by id",
                [deferred.intention],
              );
            expect((await intentionEvents()).map((row) => row.event)).toEqual(["set", "cancelled"]);
            // The second agent keeps the work those two days: its lease is moved on with the clock,
            // as an agent that renews it would have it.
            await age(w, long, -(2 * 24 + 2));
            await tick(new Date(Date.now() + 2 * DAY + HOUR));
            expect((await intentionEvents()).map((row) => row.event)).toEqual(["set", "cancelled"]);
            // The work is still the second agent's: it takes it again, and the first is refused.
            expect(ok(await claim(api, second, long)).opportunity).toMatchObject({ id: long, status: "claimed" });
            expect(await claim(api, fixer, long)).toMatchObject({ ok: false });
            // The project reads back the same work, held, with the check-back no longer waiting.
            const later = ok(await work.getProject(second.token, { project } as never));
            expect(later.work.map((one) => one.id)).toEqual([long]);
            expect(later.work[0]).toMatchObject({ holder: "second", status: "claimed" });
            expect(later.work[0]?.checkBack).toMatchObject({ by: "fixer", waiting: false });

            // 6. The goal line, two days on: nothing in the run was an act of the owner's, and
            // nothing reached the owner as a question.
            clock = new Date(start.getTime() + 2 * DAY);
            const after = await goal();
            expect(after.ownerActions.sample).toBe(before.ownerActions.sample);
            expect(after.ownerActions.parts).toEqual(before.ownerActions.parts);
            expect(after.ownerQuestions?.sample ?? 0).toBe(before.ownerQuestions?.sample ?? 0);
            // The defects closed with no command of the owner's on them. The parts say what each was
            // taken with: the measure's with the agent's pull request, the lane's with nothing.
            expect(after.defectsWithoutOwner.parts).toMatchObject({
              lever: 0,
              pr: 1,
              commit: 0,
              owner_command: 0,
            });
            expect(after.defectsWithoutOwner.parts?.recovered_untaken).toBeGreaterThanOrEqual(1);
            expect(after.defectsWithoutOwner.value).toBe(1);

            // 8. A defect task nobody claimed. Fifteen days on it has expired, and its place is
            // taken by the next defect in line; once those have run their fourteen days too, the
            // defect still stands and its task is raised again.
            const waiting = boxTasks.find((one) => one.cause !== `box_health:silent:lane.${lane(0)}`);
            const unclaimed = waiting?.source ?? "";
            await tick(new Date(Date.now() + 15 * DAY));
            expect((await tasksOf(w, unclaimed)).map((one) => one.event)).toEqual(["expired"]);
            await tick(new Date(Date.now() + 30 * DAY));
            const again = await tasksOf(w, unclaimed);
            expect(again.map((one) => one.event)).toEqual(["expired", "go"]);
            expect(again[1]?.subject).toBe(`${unclaimed}_1000001`);
          } finally {
            await reader.close();
            await admin.close();
          }
        },
        { compartments: WORLD },
      ),
    TIMEOUT,
  );
});
