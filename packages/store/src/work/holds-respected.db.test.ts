import { ContextPack, type ImprovementView } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { setClientRoles, setDefaultTaskRole, setTaskTier } from "../admin/admin-tasks.ts";
import { servedPartKey } from "../admin/outcomes/served-parts.ts";
import { ALL_TOOLS, request, testId } from "../test-support/clients.ts";
import { session } from "../test-support/connections.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { AGENT_WORK_TOOLS, type WorkClient } from "../test-support/work-clients.ts";
import {
  age,
  claim,
  type Dispatch,
  dispatching,
  gapTick,
  later,
  task,
  withAdmin,
  workAgent,
} from "../test-support/work-test-tasks.ts";
import { ok, type WorkWorld, withWorkWorld } from "../test-support/work-test-world.ts";

// A hold is respected where it should be, and the owner's word outranks it, at the store on a real
// database: a held defect task counts toward a role's five and is never displaced, while the owner's
// unsetting of the role and a gap that truly filled close it; the tick announces no return while a
// check-back holds; a release ends every hold of its holder; a reminder beside a hold leaves the
// lease; the owner's stop and the cap of 20 refuse a check-back; the owner frees held work; stale
// lease rows never crowd the caller's own list; and a reading keeps no part its label does not bound.
// Synthetic rows only; names and roles are examples. Every refusal has its control in the same test.

const OWN = ["own"];
const AGENTS = ["scout", "other"].map((name) => `agent:${name}`);
const WORLD = ["own", ...AGENTS];
const TOOLS = [
  ...ALL_TOOLS,
  ...AGENT_WORK_TOOLS,
  "propose_task",
  "hand_off",
  "build_context_pack",
  "submit_improvement",
  "list_improvements",
  "update_improvement",
];
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const defer = (w: WorkWorld, client: WorkClient, id: string, days: number, more: Record<string, unknown> = {}) =>
  w.work.setIntention(client.token, {
    opportunity: id as never,
    dueAt: later(days * DAY).toISOString() as never,
    requestId: request(),
    ...more,
  });
const release = (w: WorkWorld, client: WorkClient, id: string) =>
  w.work.releaseOpportunity(client.token, { id: id as never, reason: "no_time", requestId: request() });

const lease = async (w: WorkWorld, id: string) =>
  (
    await w.admin<{ holder: string; live: boolean; far: boolean }>(
      `select holder, lease_until >= now() as live, lease_until > now() + interval '1 day' as far
       from queue.leases where resource_kind = 'opportunity' and resource_id = $1`,
      [id],
    )
  )[0];
const events = (w: WorkWorld, id: string) =>
  w.admin<{ event: string; by: string; code: string | null }>(
    "select event, by, code from ledger.record_events where row_kind = 'opportunity' and row_id = $1 order by id",
    [id],
  );
const checkBacks = (w: WorkWorld, id: string) =>
  w.admin<{ state: string }>(
    `select (select r.event from ledger.record_events r where r.row_kind = 'intention' and r.row_id = i.id order by r.id desc limit 1) as state
     from ledger.intentions i where i.opportunity_id = $1 order by i.created_at, i.id`,
    [id],
  );

// The tick's lease step and its lapse step for one piece of work: what each wrote.
async function leaseTick(dispatch: Dispatch, id: string, now: Date): Promise<string[]> {
  const written: string[] = [];
  for (const one of await dispatch.expired(now))
    if (one.kind === "opportunity_lease" && one.opportunity === id && (await dispatch.expire(one, now)))
      written.push("lease_expired");
  if ((await dispatch.lapsedHolds(now)).includes(id as never) && (await dispatch.lapseHold(id as never, now)))
    written.push("hold_lapsed");
  return written;
}

const defectRole = async (w: WorkWorld, role: string | null): Promise<void> => {
  await w.admin("update policy.work_settings set defect_role = $1", [role]);
  await w.admin("select ledger.assign_defects($1)", [role]);
};
const NIGHTLY = "Nightly tests red";
const nightly = async (w: WorkWorld, token: string): Promise<ImprovementView> => {
  const all = ok(
    await w.work.listImprovements(token, { status: ["open", "triaged", "in_progress", "done"] } as never),
  ).improvements;
  const found = all.find((one) => one.title?.untrusted === NIGHTLY);
  if (found === undefined) throw new Error("not filed");
  return found;
};
const tasksOf = (w: WorkWorld, defect: string) =>
  w.admin<{ id: string; subject: string; event: string; code: string | null }>(
    `select o.id, o.gap_subject as subject, e.event, e.code
     from ledger.opportunities o
     cross join lateral (select r.event, r.code from ledger.record_events r where r.row_kind = 'opportunity' and r.row_id = o.id order by r.id desc limit 1) e
     where o.gap_source = $1 order by o.created_at, o.id`,
    [defect],
  );
const HELD = { ok: false, code: "not_found", refusal: "work_held" };
const agent = (w: WorkWorld, name: string, compartments = [...OWN, ...AGENTS]): Promise<WorkClient> =>
  workAgent(w, name, compartments, { tools: TOOLS, kinds: ["investigate", "research"] });

describe("a hold is respected", { timeout: DB_TEST_TIMEOUT }, () => {
  it("six defects, one held: the held task counts toward the five and is not displaced; the owner's unsetting of the role withdraws every task, held or not; a role set again raises with no wait", () =>
    withWorkWorld(
      async (w) => {
        const all = [...w.keys.compartments.keys()].sort();
        await setTaskTier(w.admin, true, new Date());
        const builder = await agent(w, "builder", all);
        await setClientRoles(w.admin, "builder", ["builder"], new Date());
        await setDefaultTaskRole(w.admin, "builder", new Date());
        const file = async (n: number, severity: string): Promise<string> => {
          const id = testId("imp");
          await w.admin(
            "select ledger.file_improvement($1, $2, $3, $4, 'value=1', 'bug', 'other', $5, $6, $7, '{}', '{}', '{}', now())",
            [id, testId("ime"), testId("req"), `measure_floor:m${n}`, severity, all, String(n).repeat(64)],
          );
          return id;
        };
        // Five defects of the system's, medium, in this order of filing.
        const ids: string[] = [];
        for (let n = 0; n < 5; n += 1) ids.push(await file(n, "medium"));
        const taskOf = async (defect: string) => (await tasksOf(w, defect)).at(-1);
        const open = async (): Promise<string[]> =>
          (
            await w.admin<{ source: string }>(
              `select o.gap_source as source from ledger.opportunities o
               where o.gap_trigger = 'defect'
                 and (select r.event from ledger.record_events r where r.row_kind = 'opportunity' and r.row_id = o.id order by r.id desc limit 1) in ('go', 'claimed')
               order by o.gap_source`,
            )
          ).map((row) => row.source);
        await defectRole(w, "builder");
        await dispatching(w, async (dispatch) => {
          const now = new Date();
          await gapTick(dispatch, now);
          expect(await open()).toEqual([...ids].sort());

          // The last in line is taken, deferred to a date, and its lease runs out: back on the
          // board, held by its check-back alone.
          const last = ids[4] as string;
          const held = await taskOf(last);
          if (held === undefined) throw new Error("no task");
          ok(await claim(w, builder, held.id));
          ok(await defer(w, builder, held.id, 5));
          await age(w, held.id, 24 * 5 + 2);
          expect(await leaseTick(dispatch, held.id, now)).toEqual(["lease_expired"]);
          expect((await lease(w, held.id))?.live).toBe(false);

          // A sixth, more severe: it takes a place among the five, and the place it takes is the
          // last unheld one's, never the held one's.
          const severe = await file(5, "high");
          await gapTick(dispatch, now);
          await gapTick(dispatch, now);
          expect(await open()).toEqual([severe, ids[0], ids[1], ids[2], last].sort());
          expect(await taskOf(last)).toMatchObject({ id: held.id, event: "go" });
          expect((await lease(w, held.id))?.holder).toBe(builder.id);
          expect((await taskOf(ids[3] as string))?.event).toBe("withdrawn");
          expect(await checkBacks(w, held.id)).toEqual([{ state: "set" }]);

          // One more is being worked under a live lease when the owner unsets the role: the
          // owner's word outranks both, so every defect task is withdrawn, and says why; the held
          // one's check-back goes with it.
          const working = await taskOf(ids[0] as string);
          ok(await claim(w, builder, working?.id ?? ""));
          await defectRole(w, null);
          await gapTick(dispatch, now);
          expect(await open()).toEqual([]);
          for (const defect of [last, ids[0] as string, severe])
            expect(await taskOf(defect), defect).toMatchObject({ event: "withdrawn", code: "no_defect_role" });
          expect(await lease(w, held.id)).toBeUndefined();
          expect(await lease(w, working?.id ?? "")).toBeUndefined();
          expect(await checkBacks(w, held.id)).toEqual([{ state: "cancelled" }]);

          // The owner sets a role again: the standing defects' next tasks are raised at the next
          // pass, under the cap, with no wait, each under a subject of its own.
          await defectRole(w, "builder");
          await gapTick(dispatch, now);
          expect(await open()).toEqual([severe, ids[0], ids[1], ids[2], last].sort());
          const raised = await tasksOf(w, last);
          expect(raised.map((one) => one.event)).toEqual(["withdrawn", "go"]);
          expect(raised[1]?.subject).not.toBe(raised[0]?.subject);
          // The one the sixth displaced ended for another cause, and waits its days.
          expect((await tasksOf(w, ids[3] as string)).map((one) => one.event)).toEqual(["withdrawn"]);
        });
      },
      ["own", "employer:example"],
    ));

  it("a gap that truly filled closes its task though its last holder still holds it by check-back, and the check-back goes with it", () =>
    withWorkWorld(
      async (w) => {
        const all = [...w.keys.compartments.keys()].sort();
        await setTaskTier(w.admin, true, new Date());
        const builder = await agent(w, "builder", all);
        await setClientRoles(w.admin, "builder", ["builder"], new Date());
        await setDefaultTaskRole(w.admin, "builder", new Date());
        await defectRole(w, "builder");
        await withAdmin(w, async (admin) => {
          await admin.box.recordNightly(3);
          await admin.box.fileImprovements();
        });
        const filed = await nightly(w, builder.token);
        await dispatching(w, async (dispatch) => {
          const now = new Date();
          await gapTick(dispatch, now);
          const [first] = await tasksOf(w, filed.id);
          if (first === undefined) throw new Error("no task");
          ok(await claim(w, builder, first.id));
          ok(await defer(w, builder, first.id, 5));
          // Under its lease, live to the check-back's date, the pass leaves it to its holder.
          await withAdmin(w, async (admin) => {
            await admin.box.recordNightly(0);
            await admin.box.fileImprovements();
          });
          await gapTick(dispatch, now);
          expect(await tasksOf(w, filed.id)).toMatchObject([{ id: first.id, event: "claimed" }]);
          // The lease run out, the hold is the check-back's alone: the defect has recovered, so
          // the task is closed, with no code, and the check-back is cancelled.
          await age(w, first.id, 24 * 5 + 2);
          expect(await leaseTick(dispatch, first.id, now)).toEqual(["lease_expired"]);
          await gapTick(dispatch, now);
          expect(await tasksOf(w, filed.id)).toMatchObject([{ id: first.id, event: "withdrawn", code: null }]);
          expect(await lease(w, first.id)).toBeUndefined();
          expect(await checkBacks(w, first.id)).toEqual([{ state: "cancelled" }]);
        });
      },
      ["own", "employer:example"],
    ));

  it("a reminder beside a hold leaves the lease; no return is announced while the check-back holds; the holder's release opens the work at once", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const scout = await agent(w, "scout");
      const other = await agent(w, "other");
      const id = await task(w, scout);
      ok(await claim(w, scout, id));
      ok(await defer(w, scout, id, 4));
      expect((await lease(w, id))?.far).toBe(true);
      // A reminder kept beside it holds nothing and shortens nothing.
      ok(await defer(w, scout, id, 6, { park: false, keepEarlier: true }));
      expect((await lease(w, id))?.far).toBe(true);

      await dispatching(w, async (dispatch) => {
        // The lease ran out an hour ago, then a day and more passes: the work is on the board,
        // still held, and the tick writes no lapse of a preference that would say it came back.
        await age(w, id, 24 * 4 + 2);
        expect(await leaseTick(dispatch, id, new Date())).toEqual(["lease_expired"]);
        await age(w, id, 30);
        expect(await leaseTick(dispatch, id, new Date())).toEqual([]);
        expect((await events(w, id)).filter((one) => one.code === "preference_lapsed")).toEqual([]);
        expect(await claim(w, other, id)).toEqual(HELD);
      });

      // Released by its holder from the board: every hold of its own ends, and another agent takes it.
      expect(ok(await release(w, scout, id))).toEqual({ released: true });
      expect(await lease(w, id)).toBeUndefined();
      expect((await checkBacks(w, id)).map((one) => one.state)).toEqual(["cancelled", "cancelled"]);
      ok(await claim(w, other, id));
      // One release, one decline.
      expect(
        await w.admin("select count(*)::int as n from ledger.work_declines where opportunity_id = $1", [id]),
      ).toEqual([{ n: 1 }]);
    }, WORLD));

  it("a holder whose lease ran out over a day ago, the work still held by its check-back, hands it off; a check-back refused there for another cause is not told the work is not held", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const scout = await agent(w, "scout");
      const other = await agent(w, "other");
      const id = await task(w, scout);
      ok(await claim(w, scout, id));
      ok(await defer(w, scout, id, 4));
      await dispatching(w, async (dispatch) => {
        await age(w, id, 24 * 4 + 2);
        expect(await leaseTick(dispatch, id, new Date())).toEqual(["lease_expired"]);
        await age(w, id, 30);
      });
      // The lease ran out 32 hours ago; the check-back alone holds the work.
      expect(await claim(w, other, id)).toEqual(HELD);

      // The holder's session read an item since erased, so its check-back is refused: for that,
      // never as work it does not hold.
      await session(w.db.urls.bootstrap, async (query) => {
        await query("set role pi_owner");
        await query(
          `insert into ledger.read_log (session_id, client_id, tool, compartments, bound, shown, fact_key_fps)
           select s.id, s.client_id, 'search', '{own}', array[repeat('f', 64)], '{}', '{}'
           from ledger.sessions s join policy.clients c on c.id = s.client_id where c.name = 'scout'`,
        );
      });
      expect(await defer(w, scout, id, 5)).toEqual({ ok: false, code: "not_found" });

      // Only the holder hands it off, and it does: its check-back goes with the work.
      const handOff = (client: WorkClient) =>
        w.work.handOff(client.token, { id: id as never, role: null, reason: "other", requestId: request() });
      expect(await handOff(other)).toEqual({ ok: false, code: "not_found", refusal: "work_not_held" });
      expect(ok(await handOff(scout))).toEqual({ handedOff: true });
      expect(await lease(w, id)).toBeUndefined();
      expect((await checkBacks(w, id)).map((one) => one.state)).toEqual(["cancelled"]);
      ok(await claim(w, other, id));
    }, WORLD));

  it("the owner's stop and the cap of 20 refuse a check-back, each by name; the owner frees held work by a decision of their own: its holder's check-backs cancelled, its open move closed, no decline; a lease row long run out is nothing to free", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const scout = await agent(w, "scout");
      const other = await agent(w, "other");
      const first = await task(w, scout);
      ok(await claim(w, scout, first));
      const { move } = ok(
        await w.work.planMove(scout.token, { opportunity: first as never, stage: "investigate", requestId: request() }),
      );
      // Work it let go four days ago, with no check-back: its lease row is still its own.
      const stale = await task(w, scout);
      ok(await claim(w, scout, stale));
      await age(w, stale, 100);

      // Stopped: no check-back is set, and the lease is as it was.
      await w.killSwitch("on");
      expect(await defer(w, scout, first, 3)).toEqual({ ok: false, code: "not_found", refusal: "kill_switch" });
      expect(await checkBacks(w, first)).toEqual([]);
      expect((await lease(w, first))?.far).toBe(false);
      await w.killSwitch("off");
      ok(await defer(w, scout, first, 3));

      // Twenty held, and the next is refused; a reminder, which holds nothing, is taken.
      for (let n = 1; n < 20; n += 1) {
        const id = await task(w, scout);
        ok(await claim(w, scout, id));
        ok(await defer(w, scout, id, 3));
      }
      const extra = await task(w, scout);
      ok(await claim(w, scout, extra));
      expect(await defer(w, scout, extra, 3)).toEqual({ ok: false, code: "not_found", refusal: "holds_full" });
      ok(await defer(w, scout, extra, 3, { park: false }));
      // Another check-back on work it already holds is not one more piece of work.
      ok(await defer(w, scout, first, 4));

      // The owner frees one: back on the board by the owner, no lease, no check-back waiting, no
      // decline, and any agent takes it. Work nobody holds is not freed.
      await withAdmin(w, async (admin) => {
        expect(await admin.work.freeWork(first as never)).toBe(true);
        expect(await admin.work.freeWork(first as never)).toBe(false);
        // A lease row whose hold is long over holds nothing: not found, and nothing written.
        expect(await admin.work.freeWork(stale as never)).toBe(false);
      });
      expect((await events(w, stale)).filter((one) => one.by === "owner")).toEqual([]);
      // One decision of the owner's, on the work, as a cancel is one.
      expect(
        await w.admin("select kind, target_kind from knowledge.owner_decisions where target_id = $1", [first]),
      ).toEqual([{ kind: "work_free", target_kind: "opportunity" }]);
      // The move its holder planned and never reported is closed, as a lapse closes one.
      expect(
        await w.admin(
          "select event, by, code from ledger.record_events where row_kind = 'move' and row_id = $1 order by id desc limit 1",
          [move],
        ),
      ).toEqual([{ event: "failed", by: "owner", code: "abandoned" }]);
      expect((await events(w, first)).at(-1)).toEqual({ event: "go", by: "owner", code: "owner_freed" });
      expect(await lease(w, first)).toBeUndefined();
      expect((await checkBacks(w, first)).map((one) => one.state)).not.toContain("set");
      expect(await w.admin("select 1 from ledger.work_declines where opportunity_id = $1", [first])).toEqual([]);
      ok(await claim(w, other, first));
      // And the freed place is the holder's to use again.
      ok(await defer(w, scout, extra, 3));
    }, WORLD));

  it("stale lease rows never crowd out the work the caller has", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const scout = await agent(w, "scout");
      // Twenty pieces of work it let go long ago, whose rows are still its own: the section's cap.
      for (let n = 0; n < 20; n += 1) {
        const id = await task(w, scout);
        ok(await claim(w, scout, id));
        await age(w, id, 100);
      }
      const live = await task(w, scout);
      ok(await claim(w, scout, live));
      const pack = ContextPack.parse(ok(await w.reader.buildContextPack(scout.token, { purpose: "agent_bootstrap" })));
      expect(pack.items.filter((one) => one.kind === "held_work").map((one) => one.id)).toEqual([live]);
      expect(
        ok(await w.work.listOpportunities(scout.token, { scope: "mine" })).opportunities.map((one) => one.id),
      ).toEqual([live]);
    }, WORLD));

  it("a reading keeps only parts of the closed list, and none an erasure or another label counts", () =>
    withWorkWorld(async (w) => {
      await withAdmin(w, async (admin) => {
        await admin.box.backupTaken();
        await admin.box.fileImprovements();
        // The owner's own report still says whether a dump is owed after an erasure.
        const view = await admin.box.outcomes(30);
        const backup = view.metrics.find((one) => one.metric === "backup_age_days");
        expect(backup?.ownerParts).toEqual({ erased_since_dump: 0 });
        expect(backup?.parts).toBeUndefined();
      });
      const stored = await w.admin<{ metric: string; parts: Record<string, number> | null }>(
        "select metric, parts from ledger.measure_readings order by metric, id",
      );
      expect(stored.length).toBeGreaterThan(0);
      expect(stored.find((one) => one.metric === "backup_age_days")?.parts).toBeNull();
      for (const one of stored)
        for (const key of Object.keys(one.parts ?? {}))
          expect(servedPartKey(one.metric, key), `${one.metric}.${key}`).toBe(true);
    }));
});
