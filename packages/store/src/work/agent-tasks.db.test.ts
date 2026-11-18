import {
  type AgentRecordId,
  type OpportunityId,
  type OpportunityView,
  PROPOSE_TASK_NEXT,
  TASK_KINDS,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { cancelTask, coordination, setGapRoute, setTaskTier } from "../admin/admin-tasks.ts";
import { request, testId } from "../test-support/clients.ts";
import { readAs } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import { asOwner } from "../test-support/pipeline-fixtures.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { TASK_AGENT_TOOLS, type WorkClient } from "../test-support/work-clients.ts";
import { personUnder as person } from "../test-support/work-seeds.ts";
import { ownerUpdate, proposed, screened, type TaskOptions, workAgent } from "../test-support/work-test-tasks.ts";
import { ok, type WorkWorld, withWorkWorld } from "../test-support/work-test-world.ts";
import { createDispatch } from "./dispatch.ts";

// Synthetic rows only; role names are examples.

const OWN = ["own"];
const WORK = ["employer:example"];
// A record's label is its writer's clearance with `agent:<name>`: the agents cleared for own share
// every agent compartment, as the default clearances give them, so each reads what the others
// write.
const NAMES = ["scout", "peer", "runner", "net", "wide", "other"];
const AGENTS = NAMES.map((name) => `agent:${name}`);
const WORLD = ["own", "employer:example", ...AGENTS];

// One update to an opportunity past its forced row security: a test's stand-in for a taint or a
// due date no tool writes directly.
const setOpportunity = (w: WorkWorld, set: string, id: string): Promise<unknown> =>
  ownerUpdate(w, "ledger.opportunities", set, "id = $1", [id]);

async function agent(w: WorkWorld, name: string, compartments = OWN, roles: string[] = []): Promise<WorkClient> {
  const client = await workAgent(w, name, compartments.includes("own") ? [...compartments, ...AGENTS] : compartments, {
    tools: TASK_AGENT_TOOLS,
    kinds: ["investigate", "research"],
    roles,
  });
  await w.harness(client, "meeting_prep", "prepare");
  return client;
}
const task = (w: WorkWorld, client: WorkClient, subject: string, options: TaskOptions = {}) =>
  proposed(w, client, { subject, ...options });

const count = async (w: WorkWorld, sql: string, values: unknown[] = []): Promise<number> =>
  (await w.admin<{ n: number }>(sql, values))[0]?.n ?? -1;
const cardsOn = (w: WorkWorld, id: string): Promise<number> =>
  count(w, "select count(*)::int as n from ledger.cards where target_id = $1", [id]);
const board = async (w: WorkWorld, client: WorkClient) =>
  ok(await w.work.listOpportunities(client.token, { scope: "board" }));
const open = async (w: WorkWorld, client: WorkClient): Promise<OpportunityView[]> =>
  ok(await w.work.listOpportunities(client.token, {})).opportunities;
const lastEvent = async (w: WorkWorld, id: string) =>
  (
    await w.admin<{ event: string; by: string; code: string | null; role: string | null }>(
      "select event, by, code, role from ledger.record_events where row_kind = 'opportunity' and row_id = $1 order by id desc limit 1",
      [id],
    )
  )[0];
const finding = async (w: WorkWorld, client: WorkClient, kind: "finding" | "note" = "finding") =>
  ok(
    await w.reader.record(client.token, {
      kind,
      body: `a ${kind} by ${client.name}: the clinic is run by its two founders`,
      requestId: request(),
    }),
  ).recordId as AgentRecordId;

describe("agent tasks", { timeout: DB_TEST_TIMEOUT }, () => {
  it("AS4: a task is decided by code with no card, merges into an open one the caller sees, and is refused while the tier is off", () =>
    withWorkWorld(async (w) => {
      const scout = await agent(w, "scout");
      const peer = await agent(w, "peer");
      const subject = await person(w);
      // Off until the owner turns it on: refused, nothing written.
      const before = await task(w, scout, subject);
      expect(before).toEqual({ ok: false, code: "not_permitted" });
      expect(await count(w, "select count(*)::int as n from ledger.opportunities")).toBe(0);
      const intent = await setTaskTier(w.admin, true, new Date());
      expect(await setTaskTier(w.admin, true, new Date())).toBe(intent);

      const made = ok(await task(w, scout, subject));
      expect(made).toEqual({ opportunity: made.opportunity, status: "go" });
      const [row] = await w.admin<{ tier: string; role: string | null; kind: string }>(
        "select tier, role, kind from ledger.opportunities where id = $1",
        [made.opportunity],
      );
      expect(row).toEqual({ tier: "task", role: null, kind: "investigate" });
      expect(
        await w.admin(
          "select decided_by, rung, reason, intent_id from ledger.opportunity_decisions where opportunity_id = $1",
          [made.opportunity],
        ),
      ).toEqual([{ decided_by: "policy", rung: 0, reason: "task", intent_id: intent }]);
      expect(
        await w.admin("select point, output, escalated from ledger.decision_point_calls where subject_id = $1", [
          made.opportunity,
        ]),
      ).toEqual([{ point: "task_go", output: "go", escalated: false }]);
      expect(await cardsOn(w, made.opportunity)).toBe(0);
      // Another agent proposing the same work is given the open task, and nothing is written.
      const rows = await count(w, "select count(*)::int as n from ledger.opportunities");
      expect(ok(await task(w, peer, subject))).toEqual({
        opportunity: made.opportunity,
        status: "go",
        merged: true,
        next: PROPOSE_TASK_NEXT.merged,
      });
      expect(await count(w, "select count(*)::int as n from ledger.opportunities")).toBe(rows);
      // A task about the owner is taken.
      const message = await w.message(OWN);
      const args = {
        kind: "investigate" as const,
        summary: "investigate the cited message",
        basis: [{ kind: "message" as const, id: message.id as never }],
      };
      expect(
        await w.work.proposeTask(scout.token, {
          ...args,
          about: { kind: "entity", id: subject as never },
          role: "nobody-holds",
          requestId: request(),
        }),
      ).toEqual({ ok: false, code: "unknown_role" });
      expect(
        await w.work.proposeTask(scout.token, {
          ...args,
          kind: "research" as never,
          about: { kind: "entity", id: subject as never },
          requestId: request(),
        }),
      ).toEqual({ ok: false, code: "invalid_request" });
      const asked = ok(
        await w.work.proposeOpportunity(scout.token, {
          ...args,
          about: { kind: "entity", id: (await person(w)) as never },
          requestId: request(),
        }),
      );
      expect(await w.admin("select tier from ledger.opportunities where id = $1", [asked.opportunity])).toEqual([
        { tier: "opportunity" },
      ]);
      expect(await w.latest("opportunity", asked.opportunity)).toBe("proposed");
      // An opportunity of a task kind the owner says go to is listed only to a client its intent
      // lists, never through the task intent.
      const listing = await w.intent(["investigate"], [scout]);
      await w.decideGo(asked.opportunity, listing);
      expect((await open(w, scout)).map((one) => one.id)).toContain(asked.opportunity);
      expect((await open(w, peer)).map((one) => one.id)).not.toContain(asked.opportunity);
      const unseen = await w.message(WORK);
      expect(
        await w.work.proposeTask(peer.token, {
          ...args,
          basis: [{ kind: "message", id: unseen.id as never }],
          about: { kind: "entity", id: subject as never },
          requestId: request(),
        }),
      ).toEqual({
        ok: false,
        code: "not_found",
      });
      const quoted = ok(
        await w.work.proposeTask(peer.token, {
          ...args,
          basis: [{ kind: "owner_request", quote: "find out who runs it" }],
          about: { kind: "entity", id: subject as never },
          requestId: request(),
        }),
      );
      expect(quoted).toEqual({
        opportunity: made.opportunity,
        status: "go",
        merged: true,
        next: PROPOSE_TASK_NEXT.merged,
      });
      expect(await count(w, "select count(*)::int as n from ledger.agent_writes where client_id = $1", [peer.id])).toBe(
        0,
      );

      // A task the caller cannot see does not merge: the employer's, about someone both labels know.
      const both = await person(w, OWN);
      await w.seed.account(WORK, both);
      const insider = await agent(w, "insider", WORK);
      const hidden = ok(await task(w, insider, both, { compartments: WORK }));
      const mine = ok(await task(w, scout, both));
      expect(mine.opportunity).not.toBe(hidden.opportunity);
      expect(mine).toEqual({ opportunity: mine.opportunity, status: "go" });
    }, WORLD));

  it("AS5, AS7, AS9: routed by role, handed off, released with a reason, returned on a lapsed lease, and done only with sources and a write-back, with no card", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const scout = await agent(w, "scout", OWN, ["research"]);
      const runner = await agent(w, "runner");
      const net = await agent(w, "net", OWN, ["network"]);
      const subject = await person(w);
      const { opportunity: id } = ok(await task(w, scout, subject, { role: "research" }));

      expect((await open(w, runner)).map((one) => one.id)).not.toContain(id);
      expect(await w.work.claimOpportunity(runner.token, { id, requestId: request() })).toEqual({
        ok: false,
        code: "not_found",
        refusal: "work_for_other_role",
      });
      expect((await open(w, scout)).find((one) => one.id === id)).toMatchObject({ tier: "task", role: "research" });
      const seen = await board(w, runner);
      expect(seen.roles).toEqual({ mine: [], all: ["network", "research"] });
      expect(seen.opportunities.find((one) => one.id === id)).toMatchObject({
        tier: "task",
        role: "research",
        status: "go",
      });
      ok(await w.work.claimOpportunity(scout.token, { id, requestId: request() }));
      expect((await board(w, runner)).opportunities.find((one) => one.id === id)).toMatchObject({
        status: "claimed",
        holder: "scout",
      });

      expect(
        await w.work.handOff(runner.token, { id, role: "network", reason: "other_role", requestId: request() }),
      ).toEqual({ ok: false, code: "not_found", refusal: "work_not_held" });
      expect(
        await w.work.handOff(scout.token, { id, role: "nobody-holds", reason: "other_role", requestId: request() }),
      ).toEqual({ ok: false, code: "unknown_role" });
      expect(
        ok(await w.work.handOff(scout.token, { id, role: "network", reason: "other_role", requestId: request() })),
      ).toEqual({ handedOff: true });
      expect(await lastEvent(w, id)).toEqual({ event: "go", by: "system:handoff", code: null, role: null });
      expect(
        await w.admin("select by, code, role from ledger.record_events where row_id = $1 and event = 'routed'", [id]),
      ).toEqual([{ by: `client:${scout.id}`, code: "other_role", role: "network" }]);
      expect(await count(w, "select count(*)::int as n from queue.leases where resource_id = $1", [id])).toBe(0);
      expect(await w.work.claimOpportunity(scout.token, { id, requestId: request() })).toEqual({
        ok: false,
        code: "not_found",
        refusal: "work_for_other_role",
      });
      const early = await finding(w, net);
      ok(await w.work.claimOpportunity(net.token, { id, requestId: request() }));

      expect(await w.work.releaseOpportunity(net.token, { id, requestId: request() })).toEqual({
        ok: false,
        code: "invalid_request",
        refusal: "release_needs_reason",
      });
      ok(await w.work.releaseOpportunity(net.token, { id, reason: "no_time", requestId: request() }));
      expect(await lastEvent(w, id)).toMatchObject({ event: "go", code: "no_time" });

      const note = await finding(w, net, "note");
      ok(await w.work.claimOpportunity(net.token, { id, requestId: request() }));
      const { move } = ok(
        await w.work.planMove(net.token, { opportunity: id, stage: "investigate", requestId: request() }),
      );
      const report = {
        deliverable: "The clinic is run by its two founders.",
        next: "Propose the founders as people for the owner to confirm.",
      };
      expect(ok(await w.work.reportMove(net.token, { move, outcome: "done", report, requestId: request() }))).toEqual({
        move,
        refused: ["needs_sources", "needs_writeback"],
      });
      for (const cited of [early, note]) {
        const sources = [{ kind: "agent_record" as const, id: cited }, "the clinic's own site"];
        expect(
          ok(
            await w.work.reportMove(net.token, {
              move,
              outcome: "done",
              report: { ...report, sources },
              requestId: request(),
            }),
          ),
        ).toEqual({ move, refused: ["needs_writeback"] });
      }
      // The database holds the same rule without the store: no write-back since the claim.
      const raw = await readAs(w.db, net.token, (query) =>
        query<{ status: string | null }>("select ledger.report_move($1, 'done', $2, $3, null, '{}', '{}') as status", [
          move,
          request(),
          net.session,
        ]),
      );
      expect(raw).toEqual([{ status: null }]);
      // A finding written while the reporter held the task before releasing it still counts once it
      // claims the task again, so a blocked task released and claimed again does not loop.
      const between = await finding(w, net);
      ok(await w.work.releaseOpportunity(net.token, { id, reason: "no_time", requestId: request() }));
      ok(await w.work.claimOpportunity(net.token, { id, requestId: request() }));
      const done = ok(
        await w.work.reportMove(net.token, {
          move,
          outcome: "done",
          report: { ...report, sources: [{ kind: "agent_record", id: between }, "the clinic's own site"] },
          requestId: request(),
        }),
      );
      // The subject is a person the owner has no path to: the report is marked web_only.
      expect(done).toEqual({ move, opportunity: "done", marks: ["web_only"] });

      expect(await cardsOn(w, id)).toBe(0);
      const dispatch = createDispatch({ url: w.db.urls.work, log: w.log, journal: "" });
      try {
        expect(await dispatch.reportsWithoutCard()).not.toContain(move);
        const { opportunity: lapsing } = ok(await task(w, runner, await person(w)));
        ok(await w.work.claimOpportunity(runner.token, { id: lapsing, requestId: request() }));
        await queryAs(
          w.db.urls.work,
          "update queue.leases set lease_until = now() - interval '1 minute' where resource_id = $1",
          [lapsing],
        );
        const now = new Date();
        const expired = (await dispatch.expired(now)).filter((one) => one.kind === "opportunity_lease");
        expect(expired).toEqual([{ kind: "opportunity_lease", opportunity: lapsing }]);
        for (const one of expired) expect(await dispatch.expire(one, now)).toBe(true);
        expect(await lastEvent(w, lapsing)).toMatchObject({ event: "go", code: "lease_expired" });
        // A claim that takes over a lapsed lease writes the same code.
        ok(await w.work.claimOpportunity(runner.token, { id: lapsing, requestId: request() }));
        const late = ok(
          await w.work.planMove(runner.token, { opportunity: lapsing, stage: "investigate", requestId: request() }),
        );
        // Lapsed more than 24 hours ago: past the holder's own 24 hours, another agent may take it.
        await queryAs(
          w.db.urls.work,
          "update queue.leases set lease_until = now() - interval '25 hours' where resource_id = $1",
          [lapsing],
        );
        // A task's report needs the reporter's live lease.
        expect(
          await w.work.reportMove(runner.token, {
            move: late.move,
            outcome: "failed",
            report: { reason: "ran out of time" },
            requestId: request(),
          }),
        ).toMatchObject({ ok: false, code: "not_found" });
        ok(await w.work.claimOpportunity(scout.token, { id: lapsing, requestId: request() }));
        expect(
          await w.admin(
            "select by, code from ledger.record_events where row_id = $1 and event = 'go' order by id desc limit 1",
            [lapsing],
          ),
        ).toEqual([{ by: "system:lease", code: "lease_expired" }]);
        const counts = await coordination(w.admin, new Date(Date.now() - 86_400_000));
        expect(counts).toMatchObject({
          tasks: { proposed: 2, go: 2, carded: 0, done: 1, failed: 0, cancelled: 0 },
          duplicates: 0,
          leasesExpired: 2,
          handOffs: 1,
          waitingPastDay: 0,
        });
        expect(counts.writebacks).toBe(1);
      } finally {
        await dispatch.close();
      }
    }, WORLD));

  it("projects-and-long-work: a task routed to the caller's own role, of a kind it is not cleared for at its stage, is refused no_harness_mode", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const scout = await agent(w, "scout", OWN, ["research"]);
      // Holds the role, cleared only to prepare a meeting: not to investigate.
      const chief = await workAgent(w, "wide", [...OWN, ...AGENTS], {
        tools: TASK_AGENT_TOOLS,
        kinds: [],
        roles: ["chief-of-staff"],
      });
      await w.harness(chief, "meeting_prep", "prepare");
      const runner = await agent(w, "runner", OWN, ["chief-of-staff"]);
      const { opportunity: id } = ok(await task(w, scout, await person(w), { role: "chief-of-staff" }));

      expect((await open(w, chief)).map((one) => one.id)).not.toContain(id);
      expect((await board(w, chief)).opportunities.find((one) => one.id === id)).toMatchObject({
        role: "chief-of-staff",
        kind: "investigate",
        stage: "investigate",
      });
      expect(await w.work.claimOpportunity(chief.token, { id, requestId: request() })).toEqual({
        ok: false,
        code: "not_found",
        refusal: "no_harness_mode",
      });
      // The positive control: the same task, claimed by a holder of the role cleared for its stage.
      ok(await w.work.claimOpportunity(runner.token, { id, requestId: request() }));
    }, WORLD));

  it("AS6, AS8: a task plans only internal stages; failed closes it, blocked returns it; the owner's cancel holds; tier off stops moves; gap flags take their route", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const scout = await agent(w, "scout", OWN, ["network"]);
      for (const kind of [
        "follow_up",
        "reply",
        "meeting_prep",
        "investigate",
        "goal_step",
        "life_admin",
        "owner_question",
        "research",
      ]) {
        const [row] = await asOwner<{ task: boolean }>(w.db, "select ledger.task_kind($1) as task", [kind]);
        expect(row?.task, kind).toBe(TASK_KINDS.includes(kind as never));
      }
      await asOwner(w.db, "alter table policy.stage_plan no force row level security");
      await asOwner(
        w.db,
        "insert into policy.stage_plan (opportunity_kind, ordinal, stage, internal) values ('investigate', 2, 'draft', true)",
      );
      await w.harness(scout, "investigate", "draft");
      const { opportunity: id } = ok(await task(w, scout, await person(w)));
      ok(await w.work.claimOpportunity(scout.token, { id, requestId: request() }));
      const first = ok(
        await w.work.planMove(scout.token, { opportunity: id, stage: "investigate", requestId: request() }),
      );
      // The store asks the contracts' plan, whose last stage is investigate: sources and a write-back.
      const wrote = await finding(w, scout);
      const sources = [{ kind: "agent_record" as const, id: wrote }];
      expect(
        ok(
          await w.work.reportMove(scout.token, {
            move: first.move,
            outcome: "done",
            report: { deliverable: "d", next: "n", sources },
            requestId: request(),
          }),
        ),
      ).toMatchObject({
        move: first.move,
        opportunity: "claimed",
      });
      expect(
        await w.work.planMove(scout.token, { opportunity: id, stage: "draft", requestId: request() }),
      ).toMatchObject({
        ok: false,
        code: "not_permitted",
      });
      await asOwner(w.db, "delete from policy.stage_plan where opportunity_kind = 'investigate' and stage = 'draft'");

      // Neither to the owner.
      for (const [outcome, status] of [
        ["failed", "withdrawn"],
        ["blocked", "go"],
      ] as const) {
        const { opportunity } = ok(await task(w, scout, await person(w)));
        ok(await w.work.claimOpportunity(scout.token, { id: opportunity, requestId: request() }));
        const { move } = ok(
          await w.work.planMove(scout.token, { opportunity, stage: "investigate", requestId: request() }),
        );
        expect(
          ok(
            await w.work.reportMove(scout.token, {
              move,
              outcome,
              report: { reason: "nothing worth keeping" },
              requestId: request(),
            }),
          ),
        ).toEqual({ move, opportunity: status });
        expect(await lastEvent(w, opportunity)).toMatchObject({ event: status, code: outcome });
        expect(await cardsOn(w, opportunity)).toBe(0);
      }

      const subject = await person(w);
      const { opportunity: cancelled } = ok(await task(w, scout, subject));
      expect(await cancelTask(w.admin, cancelled as OpportunityId, new Date())).toBe(true);
      expect(await lastEvent(w, cancelled)).toMatchObject({ event: "no_go", code: "cancelled" });
      expect(await w.admin("select kind, target_id from knowledge.owner_decisions where kind = 'task_cancel'")).toEqual(
        [{ kind: "task_cancel", target_id: cancelled }],
      );
      const again = ok(
        await w.work.proposeTask(scout.token, {
          kind: "investigate",
          about: { kind: "entity", id: subject as never },
          summary: "the same work",
          basis: (
            await w.admin<{ ref_kind: "message"; ref_id: string }>(
              "select ref_kind, ref_id from ledger.basis where row_id = $1",
              [cancelled],
            )
          ).map((one) => ({ kind: one.ref_kind, id: one.ref_id as never })),
          requestId: request(),
        }),
      );
      expect(again.status).toBe("no_go");
      expect(again.next).toBe(PROPOSE_TASK_NEXT.no_go);
      expect(
        await w.admin("select reason from ledger.opportunity_decisions where opportunity_id = $1", [again.opportunity]),
      ).toEqual([{ reason: "owner_declined" }]);
      // Invariant 11: the owner's no binds the work, whoever proposes it: another agent's proposal of
      // it goes to the owner, never go by code.
      const peer = await agent(w, "peer");
      const other = ok(await task(w, peer, subject));
      expect(other.status).toBe("proposed");
      expect(
        await w.admin("select count(*)::int as n from ledger.opportunity_decisions where opportunity_id = $1", [
          other.opportunity,
        ]),
      ).toEqual([{ n: 0 }]);
      expect(
        await w.admin("select escalated from ledger.decision_point_calls where subject_id = $1", [other.opportunity]),
      ).toEqual([{ escalated: true }]);

      await setGapRoute(w.admin, "unresolved_mention", "network", new Date());
      const raise = async (trigger: string): Promise<string | null> => {
        const message = await screened(w);
        const [row] = await queryAs<{ id: string | null }>(
          w.db.urls.work,
          "select ledger.raise_gap_flag($1, $2, $3, 'message', $4, 'message', $4, null, null, true) as id",
          [testId("opp"), trigger, testId("fp").replace(/[^A-Za-z0-9_]/g, "_"), message.id],
        );
        return row?.id ?? null;
      };
      const routed = await raise("unresolved_mention");
      const free = await raise("no_warm_path");
      expect(
        await w.admin("select id, tier, role from ledger.opportunities where id = any ($1) order by role nulls last", [
          [routed, free],
        ]),
      ).toEqual([
        { id: routed, tier: "task", role: "network" },
        { id: free, tier: "task", role: null },
      ]);
      // A flag reported failed rests in the quiet days, as a done one does.
      ok(await w.work.claimOpportunity(scout.token, { id: free as OpportunityId, requestId: request() }));
      const tried = ok(
        await w.work.planMove(scout.token, {
          opportunity: free as OpportunityId,
          stage: "investigate",
          requestId: request(),
        }),
      );
      expect(
        ok(
          await w.work.reportMove(scout.token, {
            move: tried.move,
            outcome: "failed",
            report: { reason: "no path found" },
            requestId: request(),
          }),
        ),
      ).toEqual({ move: tried.move, opportunity: "withdrawn" });
      const dispatch = createDispatch({ url: w.db.urls.work, log: w.log, journal: "" });
      try {
        expect((await dispatch.gapFlags(new Date())).history.quiet.size).toBe(1);
      } finally {
        await dispatch.close();
      }

      const { opportunity: held } = ok(await task(w, scout, await person(w)));
      ok(await w.work.claimOpportunity(scout.token, { id: held, requestId: request() }));
      expect(await setTaskTier(w.admin, false, new Date())).toBeNull();
      expect(await task(w, scout, await person(w))).toEqual({ ok: false, code: "not_permitted" });
      expect(
        await w.work.planMove(scout.token, { opportunity: held, stage: "investigate", requestId: request() }),
      ).toMatchObject({ ok: false, code: "not_permitted" });
      expect(await raise("unresolved_mention")).toBeNull();
      expect(
        await w.admin(
          "select kind from knowledge.owner_decisions where kind in ('task_tier', 'client_roles', 'gap_route') order by decided_at",
        ),
      ).toEqual([{ kind: "task_tier" }, { kind: "client_roles" }, { kind: "gap_route" }, { kind: "task_tier" }]);
      // On again, a new intent, and the task left open goes on under it.
      expect(await setTaskTier(w.admin, true, new Date())).not.toBeNull();
      ok(await w.work.claimOpportunity(scout.token, { id: held, requestId: request() }));
      ok(await w.work.planMove(scout.token, { opportunity: held, stage: "investigate", requestId: request() }));
    }, WORLD));

  it("invariant 11: the owner's no binds the work across clearances, kinds and triggers, and the board filters before its page", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const scout = await agent(w, "scout");
      // Wider than scout: its tasks' label holds the employer's compartment too.
      const wide = await agent(w, "wide", [...OWN, ...WORK]);
      const flag = async (
        trigger: string,
        subject: string,
        aboutKind: "entity" | "message",
        aboutId: string,
        decide = true,
      ): Promise<string | null> => {
        const message = await screened(w);
        const [row] = await queryAs<{ id: string | null }>(
          w.db.urls.work,
          "select ledger.raise_gap_flag($1, $2, $3, $4, $5, 'message', $6, null, null, $7) as id",
          [testId("opp"), trigger, subject, aboutKind, aboutId, message.id, decide],
        );
        return row?.id ?? null;
      };
      const decisions = (id: string) =>
        count(w, "select count(*)::int as n from ledger.opportunity_decisions where opportunity_id = $1", [id]);

      // 1. A no on scout's task binds the wider agent's proposal of the same work: the owner's card, never go.
      const first = await person(w);
      const { opportunity: cancelled } = ok(await task(w, scout, first));
      expect(await cancelTask(w.admin, cancelled as OpportunityId, new Date())).toBe(true);
      const widened = ok(await task(w, wide, first));
      expect(widened.status).toBe("proposed");
      expect(await decisions(widened.opportunity)).toBe(0);

      // 1. A no on a gap flag (research, under `own` alone) binds an agent's investigate of the same thing.
      const second = await person(w);
      const declinedFlag = (await flag("no_warm_path", second, "entity", second)) as string;
      expect(await w.latest("opportunity", declinedFlag)).toBe("go");
      expect(await cancelTask(w.admin, declinedFlag as OpportunityId, new Date())).toBe(true);
      expect(ok(await task(w, scout, second)).status).toBe("proposed");

      // 2. A carded flag (research) binds an agent's investigate as a carded investigate does.
      const third = await person(w);
      const carded = (await flag("unknown_attendee", third, "entity", third, false)) as string;
      expect(await w.latest("opportunity", carded)).toBe("proposed");
      await w.admin(
        `insert into ledger.cards (id, request_id, created_at, created_by, kind, target_kind, target_id, options, expires_after_days, case_key, compartments)
           select $1, $2, now(), 'system:work', 'opportunity', 'opportunity', o.id, '{go,no_go}', 14, o.case_id, o.compartments from ledger.opportunities o where o.id = $3`,
        [testId("crd"), testId("req"), carded],
      );
      // Its gap filled: closed by code, so no open task merges the proposal; the card still binds.
      await w.status("opportunity", carded, "withdrawn", "system:gaps");
      const afterCard = ok(await task(w, scout, third));
      expect(afterCard).toEqual({
        opportunity: afterCard.opportunity,
        status: "proposed",
        next: PROPOSE_TASK_NEXT.proposed,
      });

      // 3a. A no on an agent's investigate (a label wider than the flag's) makes a flag about the same
      // thing the owner's card, under the union of the labels, with no decision by code.
      const fourth = await person(w);
      const { opportunity: agentNo } = ok(await task(w, scout, fourth));
      expect(await cancelTask(w.admin, agentNo as OpportunityId, new Date())).toBe(true);
      const asCard = (await flag("no_warm_path", fourth, "entity", fourth)) as string;
      expect(asCard).not.toBeNull();
      expect(await w.latest("opportunity", asCard)).toBe("proposed");
      expect(await decisions(asCard)).toBe(0);
      const [scoutLabel] = await w.admin<{ compartments: string[] }>(
        "select compartments from ledger.opportunities where id = $1",
        [agentNo],
      );
      expect(
        (
          await w.admin<{ compartments: string[] }>("select compartments from ledger.opportunities where id = $1", [
            asCard,
          ])
        )[0]?.compartments,
      ).toEqual(scoutLabel?.compartments);
      // The tick keys it by its gap's label, so it is neither closed nor raised again while the gap holds.
      const dispatch = createDispatch({ url: w.db.urls.work, log: w.log, journal: "" });
      try {
        const read = await dispatch.gapFlags(new Date());
        expect(read.open.find((one) => one.id === asCard)?.labelKey).toBe("own");

        // 3b. A no on one trigger about a person stops another trigger about them under the same label.
        const fifth = await person(w);
        const noOne = (await flag("no_warm_path", fifth, "entity", fifth)) as string;
        expect(await cancelTask(w.admin, noOne as OpportunityId, new Date())).toBe(true);
        expect(await flag("unknown_attendee", fifth, "entity", fifth)).toBeNull();
        // The tick's own card for a new source still goes to the owner.
        expect(await flag("no_warm_path", fifth, "entity", fifth, false)).not.toBeNull();

        // 3c. A declined flag later tainted is still read as declined.
        await setOpportunity(w, "tainted_at = now()", noOne);
        const after = await dispatch.gapFlags(new Date());
        expect(after.history.declined.get(`no_warm_path\n${fifth}\nown`)?.size).toBe(1);
      } finally {
        await dispatch.close();
      }

      // 5. The board's tier filter applies before its page: the soonest item is an opportunity.
      const { opportunity: asked } = ok(
        await w.work.proposeOpportunity(scout.token, {
          kind: "investigate",
          about: { kind: "entity", id: (await person(w)) as never },
          summary: "investigate the cited person",
          basis: [{ kind: "message", id: (await screened(w)).id as never }],
          requestId: request(),
        }),
      );
      await w.decideGo(asked, await w.intent(["investigate"], [scout]));
      await setOpportunity(w, "due_at = now() - interval '1 day'", asked);
      const tasks = ok(
        await w.work.listOpportunities(scout.token, { scope: "board", tier: "task", limit: 1 }),
      ).opportunities;
      expect(tasks.map((one) => one.tier)).toEqual(["task"]);
    }, WORLD));

  it("AS10, invariant 6: a client without own sees no own task, holder, route or count, whatever own tasks do", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const narrow = await agent(w, "narrow", WORK);
      const wide = await agent(w, "wide", OWN, ["research"]);
      const other = await agent(w, "other", OWN, ["network"]);
      const theirs = await person(w, WORK);
      ok(await task(w, narrow, theirs, { compartments: WORK }));
      const before = JSON.stringify(await board(w, narrow));
      const openBefore = JSON.stringify(await open(w, narrow));
      // Own tasks are proposed, claimed, handed off, released and cancelled.
      const { opportunity } = ok(await task(w, wide, await person(w), { role: "research" }));
      ok(await w.work.claimOpportunity(wide.token, { id: opportunity, requestId: request() }));
      ok(
        await w.work.handOff(wide.token, {
          id: opportunity,
          role: "network",
          reason: "other_role",
          requestId: request(),
        }),
      );
      ok(await w.work.claimOpportunity(other.token, { id: opportunity, requestId: request() }));
      ok(await w.work.releaseOpportunity(other.token, { id: opportunity, reason: "other", requestId: request() }));
      expect(await cancelTask(w.admin, opportunity as OpportunityId, new Date())).toBe(true);
      expect(JSON.stringify(await board(w, narrow))).toBe(before);
      expect(JSON.stringify(await open(w, narrow))).toBe(openBefore);
      // And the narrow client cannot claim or hand off what it cannot see: not_found, as for no row.
      const { opportunity: hidden } = ok(await task(w, wide, await person(w)));
      expect(await w.work.claimOpportunity(narrow.token, { id: hidden, requestId: request() })).toEqual({
        ok: false,
        code: "not_found",
      });
      expect(
        await w.work.handOff(narrow.token, { id: hidden, role: null, reason: "other", requestId: request() }),
      ).toEqual({ ok: false, code: "not_found" });
    }, WORLD));

  // A summary that names no work is refused at write with its fixed code, before any row but the
  // call's (no opportunity, hypothesis or quoted note); one that names the work is taken.
  it("a vague summary is refused vague_summary and writes only the call row", () =>
    withWorkWorld(async (w) => {
      const scout = await agent(w, "scout");
      const about = { kind: "entity" as const, id: (await person(w)) as never };
      const basis = [{ kind: "message" as const, id: (await screened(w)).id as never }];
      const quoted = [...basis, { kind: "owner_request" as const, quote: "look into the clinic founder" }];
      const rows = async (): Promise<number[]> =>
        Promise.all(
          ["ledger.opportunities", "ledger.hypotheses", "ledger.agent_writes"].map((table) =>
            count(w, `select count(*)::int as n from ${table}`),
          ),
        );
      const before = await rows();
      const refused = { ok: false, code: "invalid_request", refusal: "vague_summary" };
      const vague = ["x", "test", "tbd", "...", "follow up"];
      for (const summary of vague) {
        expect(
          await w.work.proposeOpportunity(scout.token, {
            kind: "investigate",
            about,
            summary,
            basis: quoted,
            requestId: request(),
          }),
          summary,
        ).toEqual(refused);
        expect(
          await w.work.proposeTask(scout.token, {
            kind: "investigate",
            about,
            summary,
            basis: quoted,
            requestId: request(),
          }),
          summary,
        ).toEqual(refused);
        expect(
          await w.work.proposeHypothesis(scout.token, {
            kind: "open_loop",
            about,
            summary,
            basis,
            requestId: request(),
          }),
          summary,
        ).toEqual(refused);
      }
      expect(await rows()).toEqual(before);
      const calls = await w.admin<{ tool: string; outcome: string }>(
        "select tool, outcome from policy.calls where client_id = $1 and tool like 'propose_%' order by id",
        [scout.id],
      );
      expect(calls).toHaveLength(vague.length * 3);
      expect(new Set(calls.map((one) => one.outcome))).toEqual(new Set(["invalid_request"]));
      ok(
        await w.work.proposeOpportunity(scout.token, {
          kind: "investigate",
          about,
          summary: "Find a warm intro to the clinic founder",
          basis: quoted,
          requestId: request(),
        }),
      );
      await setTaskTier(w.admin, true, new Date());
      ok(
        await w.work.proposeTask(scout.token, {
          kind: "investigate",
          about,
          summary: "Find who founded the clinic",
          basis,
          requestId: request(),
        }),
      );
      ok(
        await w.work.proposeHypothesis(scout.token, {
          kind: "open_loop",
          about,
          summary: "The clinic founder is waiting on a reply",
          basis,
          requestId: request(),
        }),
      );
    }, WORLD));
});
