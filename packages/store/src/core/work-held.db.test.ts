import { AgentLongWork, ContextPack } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { setTaskTier } from "../admin/admin-tasks.ts";
import { request, testId } from "../test-support/clients.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { AGENT_WORK_TOOLS, type WorkClient } from "../test-support/work-clients.ts";
import {
  age,
  claim,
  type Dispatch,
  dispatching,
  expiryTick,
  held,
  later,
  task,
  withAdmin,
  workAgent,
} from "../test-support/work-test-tasks.ts";
import { ok, type WorkWorld, withWorkWorld } from "../test-support/work-test-world.ts";

// Work held to a date, at the store on a real database: a check-back holds its work for the client that set it,
// with or without a live lease, so no other agent is offered it or takes it; the caller's list, its pack and its
// brief say whose it is, how, and why it waited; the tick never takes work from its last holder; a task reported
// blocked with what it waits on stays its reporter's; and the owner's stop is named. Time is moved two ways, as
// long-work.db.test.ts moves it: a lease row is aged in place as pi_work, for what the database reads with its
// own clock, and the dispatcher is handed a later `now`. Synthetic rows only. Every refusal has its control in
// the same test.

const OWN = ["own"];
const AGENTS = ["scout", "other"].map((name) => `agent:${name}`);
const WORLD = ["own", ...AGENTS];
const TOOLS = [...AGENT_WORK_TOOLS, "propose_task", "hand_off", "build_context_pack"];
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const events = (w: WorkWorld, id: string) =>
  w.admin<{ event: string; by: string; code: string | null }>(
    "select event, by, code from ledger.record_events where row_kind = 'opportunity' and row_id = $1 order by id",
    [id],
  );
const intentionState = async (w: WorkWorld, id: string): Promise<string | undefined> =>
  (
    await w.admin<{ event: string }>(
      "select event from ledger.record_events where row_kind = 'intention' and row_id = $1 order by id desc limit 1",
      [id],
    )
  )[0]?.event;
const holderOf = async (w: WorkWorld, id: string): Promise<string | undefined> =>
  (
    await w.admin<{ holder: string }>(
      "select holder from queue.leases where resource_kind = 'opportunity' and resource_id = $1",
      [id],
    )
  )[0]?.holder;
const offered = async (w: WorkWorld, client: WorkClient): Promise<string[]> =>
  ok(await w.work.listOpportunities(client.token, {})).opportunities.map((one) => one.id);
const mine = async (w: WorkWorld, client: WorkClient, id: string) =>
  ok(await w.work.listOpportunities(client.token, { scope: "mine" })).opportunities.find((one) => one.id === id) as
    | {
        held?: string;
        brief?: { checkBack?: { note: { untrusted: string } | null; waiting: boolean; holds: boolean } };
      }
    | undefined;
const pack = async (w: WorkWorld, client: WorkClient) =>
  ContextPack.parse(ok(await w.reader.buildContextPack(client.token, { purpose: "agent_bootstrap" })));
// Who is on what, as the owner's page reads it.
const longWork = (w: WorkWorld) =>
  withAdmin(w, async (admin) => AgentLongWork.parse(await admin.agents.longWork()).work);
const stop = (w: WorkWorld, state: "on" | "off") =>
  w.admin(
    "insert into ledger.kill_switch (request_id, created_at, created_by, compartments, state) values ($1, now(), 'owner', '{own}', $2)",
    [request(), state],
  );
const NOTE = "the meeting moved to the ninth; the agenda comes the day before";
const HELD = { ok: false, code: "not_found", refusal: "work_held" };
const agent = (w: WorkWorld, name: string): Promise<WorkClient> =>
  workAgent(w, name, [...OWN, ...AGENTS], { tools: TOOLS });
// The tick's steps 3 to 4b for one piece of work: what is past its time, the check-backs due, and
// the holds that lapsed.
const tick = (dispatch: Dispatch, id: string, now: Date): Promise<string[]> =>
  expiryTick(dispatch, id, now, { checkBacks: true });

describe("work held to a date", { timeout: DB_TEST_TIMEOUT }, () => {
  it("replay: work deferred to a date days away, by a holder whose lease had lapsed, is never offered to another agent, never closed, and comes back to its holder with its note", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const scout = await agent(w, "scout");
      const other = await agent(w, "other");
      const { id } = await held(w, scout);
      // Never offered to the other agent, and never taken by it: asked at every step.
      const untouched = async (step: string): Promise<void> => {
        expect(await offered(w, other), step).not.toContain(id);
        expect(await claim(w, other, id), step).toEqual(HELD);
        expect(await holderOf(w, id), step).toBe(scout.id);
      };
      await dispatching(w, async (dispatch) => {
        // The 30-minute lease ran out an hour ago, and the tick put the work back on the board.
        await age(w, id, 1);
        expect(await tick(dispatch, id, new Date())).toEqual(["opportunity_lease"]);
        // The holder defers it to a date five days away, with why, holding no live lease.
        const dueAt = later(5 * DAY);
        const { intention } = ok(
          await w.work.setIntention(scout.token, {
            opportunity: id as never,
            dueAt: dueAt.toISOString() as never,
            note: NOTE,
            requestId: request(),
          }),
        );
        await untouched("deferred");
        // It is the holder's own, said so, with its date and its note, in its list and its pack.
        expect(await mine(w, scout, id)).toMatchObject({
          held: "held_until",
          brief: { checkBack: { note: { untrusted: NOTE }, waiting: true, holds: true } },
        });
        expect((await pack(w, scout)).items.find((one) => one.kind === "held_work" && one.id === id)).toMatchObject({
          state: "held_until",
          checkBack: { dueAt: dueAt.toISOString(), note: { untrusted: NOTE } },
        });
        // Two days pass, far past the lapsed lease's own 24 hours, with a tick each day.
        await age(w, id, 25);
        await tick(dispatch, id, new Date());
        await untouched("after one day");
        await age(w, id, 25);
        await tick(dispatch, id, new Date());
        await untouched("after two days");
        expect(await mine(w, scout, id)).toMatchObject({ held: "held_until" });
        expect(await intentionState(w, intention)).toBe("set");
        // The owner's page says the same: the work is its holder's, lapsed, held until the date.
        expect((await longWork(w)).find((one) => one.opportunity === id)).toMatchObject({
          holder: "scout",
          lapsed: true,
          parkedBy: "scout",
          parkedUntil: dueAt.toISOString(),
        });
        // The date comes: the check-back returns the work to its holder alone.
        expect(await tick(dispatch, id, new Date(dueAt.getTime() + 60_000))).toContain("preferred");
        expect(await intentionState(w, intention)).toBe("fired");
        await untouched("at the date");
      });
      // The first agent returns: its list shows the work came back, with the note it left.
      expect(await mine(w, scout, id)).toMatchObject({
        held: "returned",
        brief: { checkBack: { note: { untrusted: NOTE }, waiting: false } },
      });
      // It takes it up again, and the brief gives the note back.
      const taken = ok(await claim(w, scout, id)) as { brief?: { checkBack?: { note: { untrusted: string } } } };
      expect(taken.brief?.checkBack?.note).toEqual({ untrusted: NOTE });
      expect(await mine(w, scout, id)).toMatchObject({ held: "held" });
      // Never closed, and never another agent's: every event is the holder's claim, a return to
      // the board, or the lapse of a preference.
      const all = await events(w, id);
      expect(all.map((one) => one.event).filter((event) => event !== "go" && event !== "claimed")).toEqual([
        "proposed",
      ]);
      expect(all.filter((one) => one.event === "claimed").map((one) => one.by)).toEqual([
        `client:${scout.id}`,
        `client:${scout.id}`,
      ]);
    }, WORLD));

  it("A5: a check-back holds claimed work under its lease; with park false it is a reminder that holds nothing", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const scout = await agent(w, "scout");
      const other = await agent(w, "other");
      const kept = await held(w, scout);
      const loose = await held(w, scout);
      const dueAt = later(3 * DAY).toISOString() as never;
      ok(await w.work.setIntention(scout.token, { opportunity: kept.id as never, dueAt, requestId: request() }));
      ok(
        await w.work.setIntention(scout.token, {
          opportunity: loose.id as never,
          dueAt,
          park: false,
          requestId: request(),
        }),
      );
      expect(await mine(w, scout, kept.id)).toMatchObject({ held: "held_until" });
      expect(await mine(w, scout, loose.id)).toMatchObject({
        held: "held",
        brief: { checkBack: { waiting: true, holds: false } },
      });
      // The owner's page shows a hold as one, and a reminder as none.
      const shown = await longWork(w);
      expect(shown.find((one) => one.opportunity === kept.id)).toMatchObject({
        holder: "scout",
        lapsed: false,
        parkedUntil: dueAt,
      });
      expect(shown.find((one) => one.opportunity === loose.id)).toMatchObject({
        holder: "scout",
        lapsed: false,
        parkedUntil: null,
      });
      await dispatching(w, async (dispatch) => {
        // Two days on: the held work's lease still runs; the reminder's ran out long ago.
        for (const id of [kept.id, loose.id]) await age(w, id, 49);
        expect(await tick(dispatch, kept.id, new Date())).toEqual([]);
        expect(await tick(dispatch, loose.id, new Date())).toEqual(["opportunity_lease", "hold_lapsed"]);
      });
      expect(await claim(w, other, kept.id)).toEqual(HELD);
      expect(await offered(w, other)).not.toContain(kept.id);
      // The reminder held nothing: the work is no longer the first agent's, and another takes it.
      expect(await mine(w, scout, loose.id)).toBeUndefined();
      ok(await claim(w, other, loose.id));
    }, WORLD));

  it("A5: the tick never takes work from its last holder: an earlier holder's check-back on work back on the board is cancelled", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const scout = await agent(w, "scout");
      const other = await agent(w, "other");
      const { id } = await held(w, scout);
      const dueAt = later(2 * HOUR);
      // The first holder leaves a reminder and lets the work go: a day on, with its lease long run
      // out, the second takes it and works. (A hand-off or a release would cancel the reminder.)
      const stale = ok(
        await w.work.setIntention(scout.token, {
          opportunity: id as never,
          dueAt: dueAt.toISOString() as never,
          park: false,
          requestId: request(),
        }),
      ).intention;
      await age(w, id, 25);
      ok(await claim(w, other, id));
      const { move } = ok(
        await w.work.planMove(other.token, { opportunity: id as never, stage: "investigate", requestId: request() }),
      );
      ok(
        await w.work.reportMove(other.token, {
          move: move as never,
          outcome: "progress",
          report: { done: ["read the first filing"], next: "read the second" },
          requestId: request(),
        }),
      );
      await dispatching(w, async (dispatch) => {
        // Its 30-minute lease ran out an hour ago, as it does between an agent's runs.
        await age(w, id, 1);
        expect(await tick(dispatch, id, new Date())).toEqual(["opportunity_lease"]);
        // The earlier holder's check-back comes due while the work is back on the board.
        expect(await tick(dispatch, id, new Date(dueAt.getTime() + 60_000))).toEqual(["not_preferred"]);
      });
      expect(await intentionState(w, stale)).toBe("cancelled");
      // The work, its lease row and its open move are still the second holder's.
      expect(await holderOf(w, id)).toBe(other.id);
      expect(await claim(w, scout, id)).toEqual(HELD);
      ok(await claim(w, other, id));
      expect(
        await w.admin(
          "select event from ledger.record_events where row_kind = 'move' and row_id = $1 and event = 'failed'",
          [move],
        ),
      ).toEqual([]);
    }, WORLD));

  it("blocked: a task reported blocked with what it waits on stays its reporter's, held to a date; with nothing given it returns and is not offered to its reporter", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const scout = await agent(w, "scout");
      const other = await agent(w, "other");
      const waiting = await held(w, scout);
      const resumeAt = later(4 * DAY).toISOString();
      expect(
        ok(
          await w.work.reportMove(scout.token, {
            move: waiting.move as never,
            outcome: "blocked",
            report: {
              reason: "the agenda is not out yet",
              waitingOn: "the organizer's agenda",
              resumeAt: resumeAt as never,
            },
            requestId: request(),
          }),
        ),
      ).toEqual({ move: waiting.move, opportunity: "claimed", heldUntil: resumeAt });
      expect((await events(w, waiting.id)).at(-1)).toMatchObject({ event: "claimed" });
      expect(await mine(w, scout, waiting.id)).toMatchObject({
        held: "held_until",
        brief: { checkBack: { note: { untrusted: "the organizer's agenda" }, holds: true } },
      });
      expect(await offered(w, other)).not.toContain(waiting.id);
      expect(await claim(w, other, waiting.id)).toEqual({ ok: false, code: "not_found", refusal: "work_held" });
      // A time the hold cannot take refuses the whole report: nothing is kept.
      const soon = await held(w, scout);
      expect(
        await w.work.reportMove(scout.token, {
          move: soon.move as never,
          outcome: "blocked",
          report: { reason: "waiting", waitingOn: "a reply", resumeAt: later(HOUR / 2).toISOString() as never },
          requestId: request(),
        }),
      ).toEqual({ ok: false, code: "invalid_request", refusal: "due_too_soon" });
      expect(
        await w.admin(
          "select 1 from ledger.record_events where row_kind = 'move' and row_id = $1 and event = 'reported'",
          [soon.move],
        ),
      ).toEqual([]);
      // With nothing it waits on, the task goes back to the board for another agent, and its
      // reporter is not offered it again: a decline is in force, as a release leaves one.
      const given = await held(w, scout);
      expect(
        ok(
          await w.work.reportMove(scout.token, {
            move: given.move as never,
            outcome: "blocked",
            report: { reason: "this needs access I do not have" },
            requestId: request(),
          }),
        ),
      ).toMatchObject({ opportunity: "go" });
      expect(
        await w.admin<{ reason: string; days: number }>(
          "select reason, round(extract(epoch from expires_at - created_at) / 86400)::int as days from ledger.work_declines where opportunity_id = $1 and client_id = $2",
          [given.id, scout.id],
        ),
      ).toEqual([{ reason: "blocked", days: 7 }]);
      expect(
        ok(await w.work.listOpportunities(scout.token, { excludeDeclined: true })).opportunities.map((one) => one.id),
      ).not.toContain(given.id);
      expect(await offered(w, other)).toContain(given.id);
    }, WORLD));

  it("the stop: a claim and a renewal the owner's stop refused say so, and work held to a date stays held through the stop", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const scout = await agent(w, "scout");
      const other = await agent(w, "other");
      const { id } = await held(w, scout);
      const open = await task(w, other);
      ok(
        await w.work.setIntention(scout.token, {
          opportunity: id as never,
          dueAt: later(3 * DAY).toISOString() as never,
          requestId: request(),
        }),
      );
      await stop(w, "on");
      const stopped = { ok: false, code: "not_found", refusal: "kill_switch" };
      expect(await claim(w, scout, id)).toEqual(stopped);
      expect(await claim(w, scout, open)).toEqual(stopped);
      // Work the caller cannot see answers the plain not_found, stopped or not.
      expect(await claim(w, scout, testId("opp"))).toEqual({ ok: false, code: "not_found" });
      // Two days stopped: the work held to a date is still its holder's.
      await age(w, id, 49);
      await stop(w, "off");
      await dispatching(w, async (dispatch) => {
        expect(await tick(dispatch, id, new Date())).toEqual([]);
      });
      expect(await claim(w, other, id)).toEqual({ ok: false, code: "not_found", refusal: "work_held" });
      ok(await claim(w, scout, id));
    }, WORLD));
});
