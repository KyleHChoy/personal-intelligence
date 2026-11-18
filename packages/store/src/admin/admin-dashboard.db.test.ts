import { AgentLongWork, type EntityId, OwnerProjects, SystemMeasures } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { request, testId } from "../test-support/clients.ts";
import { recordingLogger } from "../test-support/recording.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { AGENT_WORK_TOOLS, type WorkClient } from "../test-support/work-clients.ts";
import { ok, type WorkWorld, withWorkWorld } from "../test-support/work-test-world.ts";
import { createAdmin } from "./admin.ts";
import { setClientRoles, setDefaultTaskRole, setTaskTier } from "./admin-tasks.ts";

// The dashboard's owner-side reads over a store shaped like a used one: the System room's measures
// (admin-system.ts), the Projects room (admin-project-board.ts) and who is on what
// (admin-long-work.ts), with the open defects the System room lists beside them. The world is made
// through the calls that make it on a box: an agent's project tools, its moves and reports, the
// owner's area and project commands, and the filing pass. Synthetic rows only; every name is an
// example.

const HOUR = 3_600_000;
const AGENT = "agent:scout";
const WORLD = ["own", AGENT];
const TOOLS = [
  ...new Set([
    ...AGENT_WORK_TOOLS,
    "propose_task",
    "record",
    "propose_project",
    "update_project",
    "get_project",
    "set_intention",
    "list_improvements",
    "update_improvement",
  ]),
];
const MEASURE = "backup_age_days";

async function scoutOf(w: WorkWorld): Promise<WorkClient> {
  const client = await w.client("scout", WORLD, { tools: TOOLS });
  for (const kind of ["investigate", "research"]) await w.harness(client, kind, "investigate");
  await w.admin(
    "insert into vault.source_accounts (id, label, connector, source_kind, compartments) values ($1, $2, 'agent', 'agent_record', $3)",
    [testId("acc"), AGENT, [AGENT]],
  );
  await setClientRoles(w.admin, "scout", ["builder"], new Date());
  return client;
}

// A task under a project, on a message the pipeline screened, claimed by the agent with a move.
async function heldTask(w: WorkWorld, client: WorkClient, project: EntityId, summary: string) {
  const subject = await w.seed.entity("person");
  await w.seed.account(["own"], subject);
  const message = await w.message(["own"]);
  await w.seed.pipelineItem(["own"], message.evidence);
  await w.admin(
    "update vault.pipeline_items set waiting = false, withheld = false, screened = true where evidence_id = $1",
    [message.evidence],
  );
  const opportunity = ok(
    await w.work.proposeTask(client.token, {
      kind: "investigate",
      about: { kind: "entity", id: subject as never },
      summary,
      basis: [{ kind: "message", id: message.id as never }],
      project,
      requestId: request(),
    }),
  ).opportunity as string;
  ok(await w.work.claimOpportunity(client.token, { id: opportunity as never, requestId: request() }));
  const { move } = ok(
    await w.work.planMove(client.token, {
      opportunity: opportunity as never,
      stage: "investigate",
      requestId: request(),
    }),
  );
  return { opportunity, move };
}

const progress = (w: WorkWorld, client: WorkClient, move: string, report: { done: string[]; next: string }) =>
  w.work.reportMove(client.token, { move, outcome: "progress", report, requestId: request() } as never);

describe("the dashboard's reads of the system, its projects and its long work", { timeout: DB_TEST_TIMEOUT }, () => {
  it("an empty store answers empty shapes", () =>
    withWorkWorld(async (w) => {
      const admin = createAdmin({ url: w.db.urls.admin, keys: w.keys as never, log: recordingLogger().log });
      try {
        const measures = await admin.box.measures();
        expect(SystemMeasures.parse(measures).measures).toEqual([]);
        const projects = await admin.projects.overview();
        expect(OwnerProjects.parse(projects)).toMatchObject({ projects: [], areas: [], more: false });
        const long = await admin.agents.longWork();
        expect(AgentLongWork.parse(long)).toMatchObject({ work: [], more: false });
        expect(await admin.box.improvements()).toMatchObject({ total: 0, open: 0, defects: [] });
      } finally {
        await admin.close();
      }
    }, WORLD));

  it("a used store answers its measures, its projects with their area, standing, work and changes, and who is on what", () =>
    withWorkWorld(async (w) => {
      const start = new Date();
      let clock = start;
      const admin = createAdmin({
        url: w.db.urls.admin,
        keys: w.keys as never,
        log: recordingLogger().log,
        now: () => clock,
      });
      try {
        await setTaskTier(w.admin, true, start);
        const scout = await scoutOf(w);
        await setDefaultTaskRole(w.admin, "builder", start);
        // The role defects go to: unset, no defect has a role.
        await w.admin("update policy.work_settings set defect_role = 'builder'", []);
        await w.admin("select ledger.assign_defects('builder')", []);

        // The owner's areas, in the owner's order, one retired.
        await admin.areas.add("field-work", "Field work");
        await admin.areas.add("back-office", "Back office");
        await admin.areas.add("old-yard", "The old yard");
        await admin.areas.retire("old-yard");
        await admin.areas.order(["back-office"]);

        // A project the agent made, which the owner put in an area and the agent says is blocked;
        // and one the owner made and closed.
        const kiln = ok(await w.work.proposeProject(scout.token, { name: "Kiln rebuild", requestId: request() }))
          .project as EntityId;
        await admin.areas.setProjectArea(kiln, "field-work");
        ok(
          await w.work.updateProject(scout.token, {
            project: kiln,
            status: "blocked",
            note: "No brick until the supplier answers.",
            requestId: request(),
          }),
        );
        const shed = await admin.projects.add("Shed roof", { requestId: request() });
        expect(await admin.projects.close(shed, { requestId: request() })).toBe(true);

        // Work held, with two progress reports; and work parked, with when it is due back.
        const held = await heldTask(w, scout, kiln, "find a second brick supplier");
        ok(await progress(w, scout, held.move, { done: ["asked the first supplier"], next: "ask two more" }));
        ok(
          await progress(w, scout, held.move, {
            done: ["asked the first supplier", "asked two more"],
            next: "compare the quotes",
          }),
        );
        const parked = await heldTask(w, scout, kiln, "book the kiln inspection");
        const dueBack = new Date(start.getTime() + 48 * HOUR).toISOString();
        ok(
          await w.work.setIntention(scout.token, {
            opportunity: parked.opportunity,
            dueAt: dueBack,
            note: "the inspector is back in two days",
            requestId: request(),
          } as never),
        );

        // A measure low on two filing passes thirteen hours apart: the second files a defect, which
        // the agent takes with a fix reference.
        await w.admin(
          `insert into ledger.job_runs (job, started_at, ended_at, code)
           values ('backup', now() - interval '20 days', now() - interval '20 days', 'ok')`,
        );
        await admin.box.fileImprovements();
        clock = new Date(start.getTime() + 13 * HOUR);
        expect((await admin.box.fileImprovements()).filed).toBeGreaterThanOrEqual(1);
        const filed = ok(await w.work.listImprovements(scout.token, { mine: true } as never)).improvements.find(
          (one) => one.cause === `measure_floor:${MEASURE}`,
        );
        ok(
          await w.work.updateImprovement(scout.token, {
            improvement: filed?.id,
            status: "in_progress",
            fixRef: "pr:12",
            requestId: request(),
          } as never),
        );

        // The System room's measures: the low one first, low since its first low reading. A
        // reading's time is the database's clock, so the two passes' readings are read back.
        const readings = (
          await w.admin<{ read_at: Date }>(
            "select read_at from ledger.measure_readings where metric = $1 and state = 'failing' order by read_at",
            [MEASURE],
          )
        ).map((row) => row.read_at.toISOString());
        expect(readings).toHaveLength(2);
        const measures = SystemMeasures.parse(await admin.box.measures());
        const low = measures.measures.find((one) => one.metric === MEASURE);
        expect(low).toMatchObject({
          state: "failing",
          healthy: { test: "at_most", value: 8 },
          minSample: 1,
          failingSince: readings[0],
          readAt: readings[1],
          stale: false,
        });
        expect(low?.value).toBeGreaterThanOrEqual(19);
        expect(measures.measures[0]?.state).toBe("failing");
        expect(new Set(measures.measures.map((one) => one.metric)).size).toBe(measures.measures.length);
        // Read three days on with no pass since, the same reading is no longer current, and its
        // low run still began where it began.
        clock = new Date(Date.now() + 72 * HOUR);
        expect((await admin.box.measures()).measures.find((one) => one.metric === MEASURE)).toMatchObject({
          state: "failing",
          stale: true,
          failingSince: readings[0],
          readAt: readings[1],
        });
        // Back to the present: the agent's leases are live now, and lapse within the hour.
        clock = new Date();

        // The open defect, with who holds it and its fix.
        const defects = await admin.box.improvements();
        expect(defects.defects.find((one) => one.improvement === filed?.id)).toMatchObject({
          status: "in_progress",
          role: "builder",
          heldBy: "scout",
          fixRef: "pr:12",
          cause: `measure_floor:${MEASURE}`,
        });

        // The Projects room: both projects, each with where it stands and who said so.
        const board = OwnerProjects.parse(await admin.projects.overview());
        expect(board.more).toBe(false);
        expect(board.areas).toEqual([
          { key: "back-office", name: { untrusted: "Back office" }, retired: false },
          { key: "field-work", name: { untrusted: "Field work" }, retired: false },
          { key: "old-yard", name: { untrusted: "The old yard" }, retired: true },
        ]);
        expect(board.projects.map((one) => one.id).sort()).toEqual([kiln, shed].sort());
        const made = board.projects.find((one) => one.id === kiln);
        expect(made).toMatchObject({
          name: { untrusted: "Kiln rebuild" },
          status: { value: "blocked", by: { kind: "agent", client: "scout" } },
          createdBy: "scout",
          area: "field-work",
          more: false,
        });
        expect(board.projects.find((one) => one.id === shed)).toMatchObject({
          name: { untrusted: "Shed roof" },
          status: { value: "closed", by: { kind: "owner" } },
          createdBy: "owner",
          area: null,
          work: [],
        });
        // Its open work: the held piece with its latest report, the parked one with when it is due.
        const work = new Map(made?.work.map((one) => [one.opportunity, one]));
        expect([...work.keys()].sort()).toEqual([held.opportunity, parked.opportunity].sort());
        expect(work.get(held.opportunity as never)).toMatchObject({
          task: true,
          status: "claimed",
          holder: "scout",
          lapsed: false,
          project: kiln,
          summary: { untrusted: "find a second brick supplier" },
          progress: {
            done: [{ untrusted: "asked the first supplier" }, { untrusted: "asked two more" }],
            next: { untrusted: "compare the quotes" },
            by: "scout",
          },
          parkedUntil: null,
        });
        expect(work.get(held.opportunity as never)?.since).not.toBeNull();
        // Held to its date under a live lease: its holder's, not lapsed.
        expect(work.get(parked.opportunity as never)).toMatchObject({
          holder: "scout",
          lapsed: false,
          progress: null,
          parkedBy: "scout",
          parkedUntil: dueBack,
        });
        // What changed this week: the agent's word, the project made, and the steps of its work.
        expect(made?.changes).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "status", value: "blocked", by: { kind: "agent", client: "scout" } }),
            expect.objectContaining({ kind: "field", field: "created", by: "agent" }),
            expect.objectContaining({ kind: "work", opportunity: held.opportunity, event: "claimed" }),
            expect.objectContaining({ kind: "work", opportunity: parked.opportunity, event: "claimed" }),
          ]),
        );

        // Who is on what: both pieces, the same rows the project lists.
        const long = AgentLongWork.parse(await admin.agents.longWork());
        expect(long.more).toBe(false);
        const followed = long.work.filter((one) => one.project === kiln);
        expect(followed.map((one) => one.opportunity).sort()).toEqual([held.opportunity, parked.opportunity].sort());
        for (const one of followed) expect(one).toEqual(work.get(one.opportunity));
      } finally {
        await admin.close();
      }
    }, WORLD));
});
