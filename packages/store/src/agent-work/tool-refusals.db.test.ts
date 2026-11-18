import { describe, expect, it } from "vitest";
import { createAdmin } from "../admin/admin.ts";
import { setTaskTier } from "../admin/admin-tasks.ts";
import { request, testId } from "../test-support/clients.ts";
import { session, sqlState } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { TASK_AGENT_TOOLS, type WorkClient } from "../test-support/work-clients.ts";
import { ownerUpdate, task as taskOf, workAgent } from "../test-support/work-test-tasks.ts";
import { ok, type WorkWorld, withWorkWorld } from "../test-support/work-test-world.ts";
import { createWriter } from "../write/writer.ts";

// Why a call was refused, as the call log keeps it and `pi outcomes` counts it; and a report the
// database did not keep, told by what the caller's own view of the work shows. Synthetic rows only.

const OWN = ["own"];
const WORKER = [...OWN, "agent:worker"];
const LABELS = [...WORKER, "public"];

const agent = (w: WorkWorld, name: string): Promise<WorkClient> =>
  workAgent(w, name, WORKER, { tools: TASK_AGENT_TOOLS });
const task = (w: WorkWorld, client: WorkClient): Promise<string> =>
  taskOf(w, client, { summary: "find who runs the canary clinic" });

async function planned(w: WorkWorld, client: WorkClient, id: string): Promise<never> {
  ok(await w.work.claimOpportunity(client.token, { id: id as never, requestId: request() }));
  return ok(
    await w.work.planMove(client.token, { opportunity: id as never, stage: "investigate", requestId: request() }),
  ).move as never;
}

const failed = (w: WorkWorld, client: WorkClient, move: never) =>
  w.work.reportMove(client.token, { move, outcome: "failed", report: { reason: "nothing new" }, requestId: request() });

describe("a report the database did not keep", { timeout: DB_TEST_TIMEOUT }, () => {
  it("says so by the work's state, a lease that ended or work that closed, and a stranger's move stays plain", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const client = await agent(w, "reporter");
      const lapsed = await task(w, client);
      const move = await planned(w, client, lapsed);
      await ownerUpdate(w, "queue.leases", "lease_until = now() - interval '1 minute'", "resource_id = $1", [lapsed]);
      expect(await failed(w, client, move)).toEqual({ ok: false, code: "not_found", refusal: "work_not_held" });

      // A lease that lapsed, more than its holder's 24 hours ago, and another agent took: still open,
      // and still not the reporter's.
      const taken = await task(w, client);
      const takenMove = await planned(w, client, taken);
      await ownerUpdate(w, "queue.leases", "lease_until = now() - interval '25 hours'", "resource_id = $1", [taken]);
      ok(
        await w.work.claimOpportunity((await agent(w, "third-holder")).token, {
          id: taken as never,
          requestId: request(),
        }),
      );
      expect(await failed(w, client, takenMove)).toEqual({ ok: false, code: "not_found", refusal: "work_not_held" });

      // Reported once, sent again: the first answer, never a refusal.
      const closing = await task(w, client);
      const second = await planned(w, client, closing);
      const first = ok(await failed(w, client, second));
      expect(ok(await failed(w, client, second))).toEqual(first);

      // Closed before the report came: reported by another move of its own, then the old move's.
      const shut = await task(w, client);
      const third = await planned(w, client, shut);
      await ownerUpdate(w, "queue.leases", "lease_until = now() - interval '25 hours'", "resource_id = $1", [shut]);
      const other = await agent(w, "second-holder");
      const reclaimed = await planned(w, other, shut);
      ok(await failed(w, other, reclaimed));
      expect(await failed(w, client, third)).toEqual({ ok: false, code: "not_found", refusal: "work_closed" });

      // A move of someone else's, and one that does not exist, say nothing of any work.
      const held = await task(w, other);
      const theirs = await planned(w, other, held);
      expect(await failed(w, client, theirs)).toEqual({ ok: false, code: "not_found" });
      expect(await failed(w, client, testId("mov") as never)).toEqual({ ok: false, code: "not_found" });
    }, LABELS));
});

describe("why a call was refused", { timeout: DB_TEST_TIMEOUT }, () => {
  it("is kept beside its row and counted by tool and field, in codes alone", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const client = await agent(w, "refused");
      const schema = { why: { reason: "schema_invalid_union", field: "opportunity" } };
      expect(await w.work.refusedWork(client.token, "plan_move", schema)).toEqual({
        ok: false,
        code: "invalid_request",
      });
      expect(await w.work.refusedWork(client.token, "plan_move", schema)).toEqual({
        ok: false,
        code: "invalid_request",
      });
      expect(await w.reader.refused(client.token, "record", { why: { reason: "ids_in_prose" } })).toEqual({
        ok: false,
        code: "invalid_request",
      });
      // A report that lacks something counts by the first thing it lacks.
      const id = await task(w, client);
      const move = await planned(w, client, id);
      expect(
        ok(await w.work.reportMove(client.token, { move, outcome: "done", report: {}, requestId: request() })),
      ).toMatchObject({ refused: expect.arrayContaining(["needs_deliverable"]) });
      // A call a tool's schema refused with no code given, and one with nothing to say.
      expect(await w.work.claimOpportunity(client.token, { id: testId("opp") as never, requestId: request() })).toEqual(
        {
          ok: false,
          code: "not_found",
        },
      );

      const admin = createAdmin({ url: w.db.urls.admin, keys: w.db.keys, log: w.log });
      try {
        const { usage } = await admin.box.outcomes(14);
        expect(usage.refusedFields).toEqual(
          expect.arrayContaining([
            {
              tool: "plan_move",
              outcome: "invalid_request",
              reason: "schema_invalid_union",
              field: "opportunity",
              calls: 2,
            },
            { tool: "record", outcome: "invalid_request", reason: "ids_in_prose", field: null, calls: 1 },
            { tool: "report_move", outcome: "invalid_request", reason: "needs_deliverable", field: null, calls: 1 },
            { tool: "claim_opportunity", outcome: "not_found", reason: null, field: null, calls: 1 },
          ]),
        );
        expect(usage.refusedFields[0]?.calls).toBe(2);
        expect(usage.tools.find((one) => one.tool === "plan_move")?.refusals).toEqual({ invalid_request: 2 });
      } finally {
        await admin.close();
      }
    }, LABELS));

  it("a tool's defect says why its calls were refused, so its taker needs no box", () =>
    withWorkWorld(async (w) => {
      const client = await agent(w, "refusals");
      await session(w.db.urls.reader, async (query) => {
        await query("begin");
        await query("select set_config('pi.client_token', $1, true)", [client.token]);
        const log = (outcome: string, reason: string | null, field: string | null, n: number) =>
          Promise.all(
            Array.from({ length: n }, () =>
              query("select policy.log_call('record', 0, $1, $2::text, $3::text)", [outcome, reason, field]),
            ),
          );
        await log("invalid_request", "schema_custom", "requestId", 12);
        await log("not_found", null, null, 6);
        await log("ok", null, null, 4);
        await query("commit");
      });
      const admin = createAdmin({ url: w.db.urls.admin, keys: w.db.keys, log: w.log });
      try {
        await admin.box.fileImprovements();
      } finally {
        await admin.close();
      }
      const rows = await queryAs<{ cause_state: string }>(
        w.db.urls.admin,
        "select cause_state from ledger.improvements where cause = 'tool_refusals:record'",
      );
      expect(rows).toEqual([
        { cause_state: "refused=18 calls=22 invalid_request.schema_custom.requestid=12 not_found=6" },
      ]);
    }, LABELS));

  it("the log takes a code and nothing else, and only its own client's", () =>
    withWorkWorld(async (w) => {
      const client = await agent(w, "format");
      const log = (reason: string, field: string | null) =>
        sqlState(() =>
          session(w.db.urls.reader, async (query) => {
            await query("begin");
            await query("select set_config('pi.client_token', $1, true)", [client.token]);
            await query("select policy.log_call('record', 0, 'invalid_request', $1::text, $2::text)", [reason, field]);
            await query("commit");
          }),
        );
      expect(await log("Some words a model wrote", null)).toBe("23514");
      expect(await log("schema_custom", "a name with spaces")).toBe("23514");
      const stranger = await sqlState(() =>
        queryAs(w.db.urls.reader, "select policy.log_call('record', 0, 'invalid_request', 'store'::text, null::text)"),
      );
      expect(stranger).toBe("42501");
    }, LABELS));
});

// A handoff the caller wrote, cited on a release or a hand-off, that the work can never rest on:
// one removed since, or one whose label (always its writer's whole clearance, its own agent
// compartment included) is wider than the work's. Each is named, never left to the generic
// "record with kind handoff first", which writing it again would not fix.
describe("a handoff the work cannot rest on", { timeout: DB_TEST_TIMEOUT }, () => {
  const SCOUT = [...OWN, "agent:scout"];
  const takeIn = async (w: WorkWorld): Promise<void> => {
    const writer = createWriter({ url: w.db.urls.writer, keys: w.db.keys, log: w.log });
    try {
      await writer.takeRecords();
    } finally {
      await writer.close();
    }
  };
  const handoff = async (w: WorkWorld, client: WorkClient): Promise<string> =>
    ok(
      await w.reader.record(client.token, {
        kind: "handoff",
        body: "The registry asks for a second form.",
        requestId: request(),
      }),
    ).recordId;
  const release = (w: WorkWorld, client: WorkClient, id: string, record?: string) =>
    w.work.releaseOpportunity(client.token, {
      id: id as never,
      reason: "blocked",
      ...(record === undefined ? {} : { record: record as never }),
      requestId: request(),
    });
  const handOff = (w: WorkWorld, client: WorkClient, id: string, record: string) =>
    w.work.handOff(client.token, { id: id as never, reason: "blocked", record: record as never, requestId: request() });
  const invalid = (refusal: string) => ({ ok: false, code: "invalid_request", refusal });
  const takenIn = async (w: WorkWorld, record: string): Promise<boolean> =>
    (
      await w.admin<{ in: boolean }>("select evidence_id is not null as in from ledger.agent_writes where id = $1", [
        record,
      ])
    )[0]?.in ?? false;

  it("one wider than the work's label is named at once, taken in or not, and writing it again does not help", () =>
    withWorkWorld(
      async (w) => {
        await setTaskTier(w.admin, true, new Date());
        // Work under `own` alone, as a task the system raises from an `own` source is.
        const lead = await workAgent(w, "lead", OWN, { tools: TASK_AGENT_TOOLS });
        const scout = await workAgent(w, "scout", SCOUT, { tools: TASK_AGENT_TOOLS, account: true });
        const id = await task(w, lead);
        expect(await w.admin("select compartments from ledger.opportunities where id = $1", [id])).toEqual([
          { compartments: OWN },
        ]);
        ok(await w.work.claimOpportunity(scout.token, { id: id as never, requestId: request() }));
        const note = await handoff(w, scout);
        expect(await release(w, scout, id, note)).toEqual(invalid("record_label_wider"));
        expect(await handOff(w, scout, id, note)).toEqual(invalid("record_label_wider"));
        await takeIn(w);
        const again = await handoff(w, scout);
        await takeIn(w);
        for (const record of [note, again]) {
          expect(await release(w, scout, id, record)).toEqual(invalid("record_label_wider"));
          expect(await handOff(w, scout, id, record)).toEqual(invalid("record_label_wider"));
        }
        // Nothing was written; without the record the same release is taken.
        expect(ok(await release(w, scout, id))).toEqual({ released: true });
      },
      [...SCOUT, "agent:lead"],
    ));

  it("one removed since it was written is named, before or after it was taken in", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const scout = await workAgent(w, "scout", SCOUT, { tools: TASK_AGENT_TOOLS, account: true });
      const id = await task(w, scout);
      ok(await w.work.claimOpportunity(scout.token, { id: id as never, requestId: request() }));
      // The writer's removal: no body, and tainted.
      const removed = (record: string) =>
        ownerUpdate(w, "ledger.agent_writes", "body_enc = null, tainted_at = now()", "id = $1", [record]);
      const early = await handoff(w, scout);
      await removed(early);
      const later = await handoff(w, scout);
      await takeIn(w);
      expect(await takenIn(w, later)).toBe(true);
      await removed(later);
      for (const record of [early, later]) {
        expect(await release(w, scout, id, record)).toEqual(invalid("record_removed"));
        expect(await handOff(w, scout, id, record)).toEqual(invalid("record_removed"));
      }
      // The control: a handoff written again and taken in is cited.
      const fresh = await handoff(w, scout);
      await takeIn(w);
      expect(ok(await handOff(w, scout, id, fresh))).toEqual({ handedOff: true });
    }, SCOUT));
});
