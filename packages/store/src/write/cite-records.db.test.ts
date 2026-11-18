import { DECISION_POINT_PINS } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { sealUnder } from "../core/seal.ts";
import { testId } from "../test-support/clients.ts";
import { one, readAs, session } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import { type AgentWorld, rowsOf, withAgents } from "../test-support/pipeline-fixtures.ts";
import { seeder } from "../test-support/seeder.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { insertWorkClient, type WorkClient } from "../test-support/work-clients.ts";

// A planner basis cites a fact from an agent record by the record. ledger.add_basis resolves an
// agent_record ref to the record's evidence id, only for a record the caller may read; one it may
// not answers as one that does not exist (invariant 6); and the record's removal taints what cites
// it (invariant 10). Made-up values only.

const PIN = DECISION_POINT_PINS["run_outcome@7"] ?? "";
const req = (): string => testId("req");

type Planner = { world: AgentWorld; reasoner: WorkClient; label: string[]; message: string };

// A world with one message under `own`, and a reasoner cleared for `own` and alpha's records.
async function planner(world: AgentWorld): Promise<Planner> {
  const message = await session(world.db.urls.admin, async (query) => {
    const seed = seeder(world.db, query);
    return seed.message(["own"], await seed.evidence(["own"], await seed.sourceAccount(["own"])));
  });
  const label = ["agent:alpha", "own"];
  return { world, reasoner: await insertWorkClient(world.db, "thinker", label, { kind: "reasoner" }), label, message };
}

// An ideas run queued as the tick queues one, and taken by the reasoner.
async function ideasRun({ world, reasoner }: Planner): Promise<string> {
  const id = testId("run");
  const request = req();
  await queryAs(
    world.db.urls.work,
    `with run as (
       insert into ledger.runs (id, request_id, created_by, compartments, wake_source, wake_key, decision_point, definition_version, prompt_id, prompt_version)
       values ($1, $2, 'system:work', $3, 'owner_request', $4, 'run_outcome', 7, 'personal_ideas', '3') returning id)
     insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) select 'run', run.id, 'queued', now(), 'system:work', $3 from run`,
    [id, request, ["own"], `owner:${request}`],
  );
  const [run] = await readAs(world.db, reasoner.token, (query) =>
    query<{ run_id: string }>("select run_id from ledger.next_run($1, $2)", [req(), reasoner.session]),
  );
  if (run?.run_id !== id) throw new Error("next_run took another run");
  return id;
}

// One idea about the message, citing these refs, as finish_run's action.
const idea = (p: Planner, refs: [kind: string, id: string][], id = testId("hyp")) => ({
  do: "idea",
  id,
  about_kind: "message",
  about_id: p.message,
  ref_kinds: refs.map(([kind]) => kind),
  ref_ids: refs.map(([, ref]) => ref),
  body_enc: sealUnder(
    p.world.db.keys,
    p.label,
    { table: "ledger.hypotheses", id, column: "body_enc" },
    `made-up idea ${id}`,
  ),
});

// finish_run as the reasoner: its one row, or none when a ref did not resolve.
const finish = async (
  p: Planner,
  run: string,
  actions: unknown[],
): Promise<{ recorded: number; outcome: string } | null> =>
  (
    await readAs(p.world.db, p.reasoner.token, (query) =>
      query<{ recorded: number; outcome: string }>(
        "select * from ledger.finish_run($1, $2, $3, 'finished', null, 7, $4, $5::jsonb)",
        [run, req(), p.reasoner.session, PIN, JSON.stringify(actions)],
      ),
    )
  )[0] ?? null;

const basisOf = (world: AgentWorld, row: string) =>
  rowsOf<{
    ref_kind: string;
    ref_id: string;
    evidence_id: string | null;
    source_class: string;
    owner_backed: boolean;
    tainted: boolean;
  }>(
    world.db,
    "select ref_kind, ref_id, evidence_id, source_class, owner_backed, tainted_at is not null as tainted from ledger.basis where row_kind = 'hypothesis' and row_id = $1 order by id",
    [row],
  );

describe("a basis cites an agent record", { timeout: DB_TEST_TIMEOUT }, () => {
  it("an ideas output citing a record finishes, and its basis row resolves to the record's evidence, agent-class and never owner-backed", () =>
    withAgents(async (world) => {
      const p = await planner(world);
      const { record, evidence } = await world.record("alpha");
      const run = await ideasRun(p);
      const action = idea(p, [
        ["message", p.message],
        ["agent_record", record],
      ]);
      expect(await finish(p, run, [action])).toEqual({ recorded: 1, outcome: "finished" });
      const basis = await basisOf(world, action.id);
      expect(
        basis.map(({ ref_kind, ref_id, source_class, owner_backed, tainted }) => ({
          ref_kind,
          ref_id,
          source_class,
          owner_backed,
          tainted,
        })),
      ).toEqual([
        { ref_kind: "message", ref_id: p.message, source_class: "source", owner_backed: false, tainted: false },
        { ref_kind: "agent_record", ref_id: record, source_class: "agent", owner_backed: false, tainted: false },
      ]);
      expect(basis[1]?.evidence_id).toBe(evidence);
      // The idea's label is the attempt's, the reasoner's whole clearance, which covers the record.
      expect(
        one(
          await rowsOf<{ compartments: string[] }>(
            world.db,
            "select compartments from ledger.hypotheses where id = $1",
            [action.id],
          ),
        ).compartments,
      ).toEqual(p.label);
    }));

  it("a record the caller may not read is refused as one that does not exist, and nothing is written", () =>
    withAgents(async (world) => {
      const p = await planner(world);
      const visible = await world.record("alpha");
      // Beta's record carries agent:beta, outside the reasoner's clearance; one flagged; one removed.
      const hidden = await world.record("beta");
      const flagged = await world.record("alpha");
      await queryAs(world.db.urls.pipeline, "update ledger.agent_writes set flagged_at = now() where id = $1", [
        flagged.record,
      ]);
      const removed = await world.record("alpha");
      expect(await world.admin.agents.removeRecord(removed.record)).toEqual({ removed: 1 });
      const absent = testId("rec");
      const run = await ideasRun(p);
      for (const ref of [absent, hidden.record, flagged.record, removed.record]) {
        const action = idea(p, [
          ["message", p.message],
          ["agent_record", ref],
        ]);
        expect(await finish(p, run, [action]), ref === absent ? "absent" : ref).toBeNull();
        expect(await rowsOf(world.db, "select id from ledger.hypotheses where id = $1", [action.id])).toEqual([]);
      }
      // The positive control: the same run finishes citing a record it may read.
      expect(
        await finish(p, run, [
          idea(p, [
            ["message", p.message],
            ["agent_record", visible.record],
          ]),
        ]),
      ).toEqual({ recorded: 1, outcome: "finished" });
    }));

  it("a record whose writer held a view the caller lacks is refused; within the caller's views it resolves", () =>
    withAgents(async (world) => {
      const { record } = await world.record("alpha");
      const narrow = await insertWorkClient(world.db, "narrow", ["agent:alpha", "own"], { views: ["self", "people"] });
      const wide = await insertWorkClient(world.db, "wide", ["agent:alpha", "own"]);
      const add = (client: WorkClient): Promise<boolean> =>
        session(world.db.urls.work, async (query) => {
          await query("begin");
          await query("select set_config('pi.client_token', $1, true)", [client.token]);
          const { ok } = one(
            await query<{ ok: boolean }>(
              "select ledger.add_basis('run', $1, $2::text[], array['agent_record'], array[$3], $2::text[]) as ok",
              [testId("run"), ["agent:alpha", "own"], record],
            ),
          );
          await query("rollback");
          return ok;
        });
      expect(await add(narrow)).toBe(false);
      expect(await add(wide)).toBe(true);
    }));

  // A work view shows a record ref only to a caller whose own row
  // policy returns the record (work-views.ts VISIBLE_RECORDS).
  it("a caller lacking the writer's views is not returned the record row the work views filter by", () =>
    withAgents(async (world) => {
      const { record } = await world.record("alpha");
      const narrow = await insertWorkClient(world.db, "narrow-reader", ["agent:alpha", "own"], {
        views: ["self", "people"],
      });
      const wide = await insertWorkClient(world.db, "wide-reader", ["agent:alpha", "own"]);
      const seen = (client: WorkClient) =>
        readAs(world.db, client.token, (query) =>
          query<{ id: string }>("select w.id from ledger.agent_writes w where w.id = any($1::text[])", [[record]]),
        );
      expect(await seen(narrow)).toEqual([]);
      expect(await seen(wide)).toEqual([{ id: record }]);
    }));

  it("removing the record taints the idea citing it: withdrawn, its body gone", () =>
    withAgents(async (world) => {
      const p = await planner(world);
      const { record, evidence } = await world.record("alpha");
      const other = await world.record("alpha");
      const run = await ideasRun(p);
      const citing = idea(p, [
        ["message", p.message],
        ["agent_record", record],
      ]);
      const bystander = idea(p, [
        ["message", p.message],
        ["agent_record", other.record],
      ]);
      expect(await finish(p, run, [citing, bystander])).toEqual({ recorded: 2, outcome: "finished" });
      expect(await world.admin.agents.removeRecord(record)).toEqual({ removed: 1 });
      const rows = await rowsOf<{ id: string; tainted: boolean; body: boolean }>(
        world.db,
        "select id, tainted_at is not null as tainted, body_enc is not null as body from ledger.hypotheses where id = any($1) order by id",
        [[citing.id, bystander.id]],
      );
      expect(new Map(rows.map((row) => [row.id, { tainted: row.tainted, body: row.body }]))).toEqual(
        new Map([
          [citing.id, { tainted: true, body: false }],
          [bystander.id, { tainted: false, body: true }],
        ]),
      );
      const basis = await basisOf(world, citing.id);
      expect(basis.find((row) => row.ref_kind === "agent_record")).toMatchObject({ evidence_id: null, tainted: true });
      expect(await rowsOf(world.db, "select id from vault.evidence_items where id = $1", [evidence])).toEqual([]);
    }));
});
