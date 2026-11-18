import {
  type CardId,
  DECISION_POINT_PINS,
  type ReadOutcome,
  type ReasoningAction,
  type RunId,
  type RunRequest,
} from "@intelligence/contracts/personal";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { Admin } from "../admin/admin.ts";
import { CARD_KINDS } from "../admin/cards/card-kinds.ts";
import { newId } from "../core/ids.ts";
import { openUnder } from "../core/seal.ts";
import { ERASURE_HOOKS } from "../erasure/erasure-hooks.ts";
import { request, testId } from "../test-support/clients.ts";
import { one, session } from "../test-support/connections.ts";
import { queryAs, scanForPlaintext } from "../test-support/database.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import type { WorkClient } from "../test-support/work-clients.ts";
import { type Message, ok, type WorkWorld, withWorkWorld } from "../test-support/work-test-world.ts";
import { CLOSED_CODE_POINTS } from "./work-cases.ts";
import { webStepAt } from "./work-runs.ts";

// Work for the reasoner, on a real database. A run is queued as the tick queues one, as pi_work;
// the reasoner takes it, steps it and finishes it through Work with its token. Every refusal has
// its positive control.

const BOTH = ["own", "employer:example"];
const code = (outcome: ReadOutcome<unknown>): string => (outcome.ok ? "ok" : outcome.code);
const ref = (message: Message) => ({ kind: "message" as const, id: message.id as never });

type Taken = { run: RunId; request: RunRequest };

async function reasoner(w: WorkWorld, compartments = ["own"]): Promise<WorkClient> {
  return w.client("reasoner", compartments, { kind: "reasoner" });
}

// A run anchored on a fresh message, queued and taken by the reasoner.
async function taken(w: WorkWorld, r: WorkClient, message?: Message): Promise<Taken & { message: Message }> {
  const anchor = message ?? (await w.message());
  const run = (await w.queuedRun(["own"], [["message", anchor.id]])) as RunId;
  const value = ok(await w.work.nextRun(r.token, { requestId: request() }));
  if (value.run === null) throw new Error("no run taken");
  expect(value.run.id).toBe(run);
  return { run, request: value.run, message: anchor };
}

const finish = (w: WorkWorld, r: WorkClient, run: RunId, actions: ReasoningAction[], requestId = request()) =>
  w.work.finishRun(r.token, { run, outcome: "finished", output: { actions: actions as never }, requestId });

const propose = (message: Message, summary = "follow up on the quote"): ReasoningAction => ({
  do: "propose",
  kind: "follow_up",
  about: ref(message),
  summary,
  basis: [ref(message)],
});

describe("Work, for the reasoner", { timeout: DB_TEST_TIMEOUT }, () => {
  it("a run request holds only what the reasoner's clearance covers", () =>
    withWorkWorld(async (w) => {
      const r = await reasoner(w);
      const agent = await w.client("agent");
      const wide = await w.client("wide", BOTH);
      const ownGoal = await w.goal(["own"], "learn to sail");
      await w.goal(BOTH, "a goal at work");
      const seen = await w.message();
      const ownOpportunity = ok(
        await w.work.proposeOpportunity(agent.token, {
          kind: "investigate",
          about: ref(seen),
          summary: "an own one",
          basis: [ref(seen)],
          requestId: request(),
        }),
      ).opportunity;
      const hidden = await w.message(BOTH);
      ok(
        await w.work.proposeOpportunity(wide.token, {
          kind: "investigate",
          about: ref(hidden),
          summary: "a wide one",
          basis: [ref(hidden)],
          requestId: request(),
        }),
      );
      const { request: built, message } = await taken(w, r);
      expect(built.anchors).toEqual([ref(message)]);
      expect(built.goals).toEqual([{ id: ownGoal, statement: { untrusted: "learn to sail" } }]);
      expect(built.open.map((view) => view.id)).toEqual([ownOpportunity]);
      expect(built.open[0]?.summary).toEqual({ untrusted: "an own one" });
      expect(built).toMatchObject({
        attempt: 1,
        source: "owner_request",
        point: { id: "run_outcome", version: 1, promptId: "reasoning_run", promptVersion: "1" },
      });
      expect(built.limits).toEqual({
        maxTurns: 12,
        maxToolCalls: 40,
        maxOutputTokens: 4000,
        maxInputCodePoints: 200000,
        ceilingMicroUsdPerToken: 20,
      });
      // Its read log: nothing bound, and the anchors' and open work's evidence shown (N13).
      const logged = one(
        await w.admin<{ tool: string; bound: string[]; shown: string[] }>(
          "select tool, bound, shown from ledger.read_log where client_id = $1",
          [r.id],
        ),
      );
      expect(logged.tool).toBe("next_run");
      expect(logged.bound).toEqual([]);
      expect([...logged.shown].sort()).toEqual([message.evidence, seen.evidence].sort());
      // No run: an empty answer, logged as ok.
      expect(ok(await w.work.nextRun(r.token, { requestId: request() }))).toEqual({ run: null });
    }));

  it("a run request lists a case the owner declined under closed, and a handed opportunity under open", () =>
    withWorkWorld(async (w) => {
      const r = await reasoner(w);
      const agent = await w.client("agent");
      const declinedAbout = await w.message();
      const declined = ok(
        await w.work.proposeOpportunity(agent.token, {
          kind: "follow_up",
          about: ref(declinedAbout),
          summary: "declined follow-up on the message",
          basis: [ref(declinedAbout)],
          requestId: request(),
        }),
      ).opportunity;
      await w.status("opportunity", declined, "no_go", "owner");
      const handedAbout = await w.message();
      const handed = ok(
        await w.work.proposeOpportunity(agent.token, {
          kind: "reply",
          about: ref(handedAbout),
          summary: "handed reply to the message",
          basis: [ref(handedAbout)],
          requestId: request(),
        }),
      ).opportunity;
      await w.status("opportunity", handed, "handed_to_owner", "system:work");
      const { request: built } = await taken(w, r);
      expect(built.open.map((view) => [view.id, view.status])).toEqual([[handed, "handed_to_owner"]]);
      expect(built.closed).toHaveLength(1);
      expect(built.closed[0]).toMatchObject({
        rowKind: "opportunity",
        kind: "follow_up",
        about: ref(declinedAbout),
        by: "owner",
      });
    }));

  // FE1.4: the request is a pack the reasoner's vendor receives.
  it("next_run logs the run request's evidence ids as shown and binds nothing: what its closed cases and intentions cite included", () =>
    withWorkWorld(async (w) => {
      const r = await reasoner(w);
      const agent = await w.client("agent");
      const declinedAbout = await w.message();
      const declined = ok(
        await w.work.proposeOpportunity(agent.token, {
          kind: "follow_up",
          about: ref(declinedAbout),
          summary: "declined follow-up on the message",
          basis: [ref(declinedAbout)],
          requestId: request(),
        }),
      ).opportunity;
      await w.status("opportunity", declined, "no_go", "owner");
      // An intention, set by a run that cited its own anchor.
      const first = await taken(w, r);
      const due = new Date(Date.now() + 86_400_000).toISOString();
      ok(
        await finish(w, r, first.run, [
          { do: "remind", about: ref(first.message), dueAt: due, summary: "check back", basis: [ref(first.message)] },
        ]),
      );
      // A reasoner whose vendor retains what it is sent: the read log's trigger records it.
      await w.admin("update policy.clients set vendor_retention = 'retains' where id = $1", [r.id]);
      // A goal its goals block lists: the read log names it by its id.
      const goal = await w.goal(["own"], "a goal the request lists");
      const second = await taken(w, r);
      expect(second.request.closed).toHaveLength(1);
      expect(second.request.intentions).toHaveLength(1);
      const logged = await w.admin<{ bound: string[]; shown: string[]; goals: string[] }>(
        "select bound, shown, goals from ledger.read_log where client_id = $1 and tool = 'next_run' order by read_at desc, id desc limit 1",
        [r.id],
      );
      expect(one(logged).bound).toEqual([]);
      expect(one(logged).goals).toEqual([goal]);
      expect([...one(logged).shown].sort()).toEqual(
        [second.message.evidence, declinedAbout.evidence, first.message.evidence].sort(),
      );
      const exposed = await w.admin<{ ref: string }>(
        "select ref from ledger.exposures where recipient = $1 and route = 'next_run' order by ref",
        [r.id],
      );
      expect(exposed.map((row) => row.ref).sort()).toEqual(
        [second.message.evidence, declinedAbout.evidence, first.message.evidence].sort(),
      );
    }));

  it("a second attempt's request holds nothing of the first", () =>
    withWorkWorld(async (w) => {
      const r = await reasoner(w);
      const first = await taken(w, r);
      expect(
        ok(
          await w.work.appendStep(r.token, {
            run: first.run,
            ordinal: 0,
            step: {
              kind: "model_call",
              promptId: "reasoning_run",
              promptVersion: "1",
              modelId: "test/model",
              costMicroUsd: 10,
            },
          }),
        ),
      ).toEqual({ go: true });
      // The lease ran out: the tick returns the run to the queue.
      await queryAs(w.db.urls.work, "select ledger.end_run($1::text, 'queued'::text, null::text)", [first.run]);
      const second = ok(await w.work.nextRun(r.token, { requestId: request() })).run;
      expect(second?.attempt).toBe(2);
      expect({ ...second, attempt: 1 }).toEqual(first.request);
    }));

  it("an investigate about the owner makes a hypothesis and no opportunity", () =>
    withWorkWorld(async (w) => {
      const r = await reasoner(w);
      const { run, message } = await taken(w, r);
      const outcome = ok(
        await finish(w, r, run, [
          {
            do: "investigate",
            kind: "preference",
            about: { kind: "owner" },
            summary: "prefers calls to mail",
            basis: [ref(message)],
          },
        ]),
      );
      expect(outcome).toEqual({ recorded: 1, outcome: "finished" });
      expect(await w.admin("select about_owner from ledger.hypotheses where created_by = $1", [`run:${run}`])).toEqual([
        { about_owner: true },
      ]);
      expect(await w.admin("select count(*)::int as n from ledger.opportunities")).toEqual([{ n: 0 }]);
      // The positive control: about a message, the hypothesis and its investigate opportunity.
      const next = await taken(w, r);
      ok(
        await finish(w, r, next.run, [
          {
            do: "investigate",
            kind: "open_loop",
            about: ref(next.message),
            summary: "an open loop",
            basis: [ref(next.message)],
          },
        ]),
      );
      expect(await w.admin("select kind from ledger.opportunities where created_by = $1", [`run:${next.run}`])).toEqual(
        [{ kind: "investigate" }],
      );
    }));

  it("a ref the reasoner cannot see refuses the whole output with not_found and leaves the run running", () =>
    withWorkWorld(async (w) => {
      const r = await reasoner(w);
      const { run, message } = await taken(w, r);
      const hidden = await w.message(BOTH);
      expect(code(await finish(w, r, run, [propose(message), propose(hidden)]))).toBe("not_found");
      expect(await w.latest("run", run)).toBe("running");
      expect(await w.admin("select count(*)::int as n from ledger.opportunities")).toEqual([{ n: 0 }]);
      expect(await w.admin("select count(*)::int as n from ledger.decision_point_calls")).toEqual([{ n: 0 }]);
      expect(ok(await finish(w, r, run, [propose(message)]))).toEqual({ recorded: 1, outcome: "finished" });
    }));

  it("output with a key named label is invalid_request and writes nothing", () =>
    withWorkWorld(async (w) => {
      const r = await reasoner(w);
      const { run, message } = await taken(w, r);
      const labelled = { ...propose(message), label: ["own"] } as unknown as ReasoningAction;
      expect(code(await finish(w, r, run, [labelled]))).toBe("invalid_request");
      expect(await w.latest("run", run)).toBe("running");
      expect(await w.admin("select count(*)::int as n from ledger.opportunities")).toEqual([{ n: 0 }]);
      expect(ok(await finish(w, r, run, [propose(message)]))).toEqual({ recorded: 1, outcome: "finished" });
    }));

  it("nothing a step carries is sealed, and no model output is in any column after a run", () =>
    withWorkWorld(async (w) => {
      const r = await reasoner(w);
      const { run, message } = await taken(w, r);
      const steps = [
        {
          kind: "model_call" as const,
          promptId: "reasoning_run",
          promptVersion: "1",
          modelId: "test/model",
          costMicroUsd: 120,
        },
        { kind: "tool_call" as const, tool: "read_message" as const, status: "ok" as const },
        { kind: "tool_call" as const, tool: null, status: "refused" as const, code: "not_permitted" as const },
        { kind: "output_check" as const, code: "restates_goal" as const },
        {
          kind: "model_call" as const,
          promptId: "reasoning_run",
          promptVersion: "1",
          modelId: "test/model",
          costMicroUsd: 90,
          code: "truncated" as const,
        },
      ];
      for (const [ordinal, step] of steps.entries())
        expect(ok(await w.work.appendStep(r.token, { run, ordinal, step }))).toEqual({ go: true });
      expect(
        await w.admin(
          "select kind, status, tool, code, model_id, cost_microusd::int as cost from ledger.run_steps where run_id = $1 order by ordinal",
          [run],
        ),
      ).toEqual([
        { kind: "model_call", status: null, tool: null, code: null, model_id: "test/model", cost: 120 },
        { kind: "tool_call", status: "ok", tool: "read_message", code: null, model_id: null, cost: null },
        { kind: "tool_call", status: "refused", tool: null, code: "not_permitted", model_id: null, cost: null },
        { kind: "output_check", status: "refused", tool: null, code: "restates_goal", model_id: null, cost: null },
        { kind: "model_call", status: null, tool: null, code: "truncated", model_id: "test/model", cost: 90 },
      ]);
      // What `pi work show` prints: each step with its code, the check's among them.
      const pool = new pg.Pool({ connectionString: w.db.urls.admin, max: 1 });
      try {
        const shown = (await new Admin({ pool, keys: w.db.keys, log: w.log }).work.showWork(run)) as {
          steps: unknown[];
        };
        // A model call's token counts and time, and a tool call's result size: none here.
        const counts = { input_tokens: null, output_tokens: null, ms: null, result_code_points: null };
        expect(shown.steps).toEqual([
          {
            attempt: 1,
            ordinal: 0,
            kind: "model_call",
            tool: null,
            status: null,
            code: null,
            cost_microusd: 120,
            ...counts,
          },
          {
            attempt: 1,
            ordinal: 1,
            kind: "tool_call",
            tool: "read_message",
            status: "ok",
            code: null,
            cost_microusd: null,
            ...counts,
          },
          {
            attempt: 1,
            ordinal: 2,
            kind: "tool_call",
            tool: null,
            status: "refused",
            code: "not_permitted",
            cost_microusd: null,
            ...counts,
          },
          {
            attempt: 1,
            ordinal: 3,
            kind: "output_check",
            tool: null,
            status: "refused",
            code: "restates_goal",
            cost_microusd: null,
            ...counts,
          },
          {
            attempt: 1,
            ordinal: 4,
            kind: "model_call",
            tool: null,
            status: null,
            code: "truncated",
            cost_microusd: 90,
            ...counts,
          },
        ]);
      } finally {
        await pool.end();
      }
      const answers = ["remind canary platypus", "investigate canary echidna", "propose canary bilby"];
      ok(
        await finish(w, r, run, [
          {
            do: "remind",
            about: ref(message),
            dueAt: new Date(Date.now() + 86_400_000).toISOString(),
            summary: answers[0] as string,
            basis: [ref(message)],
          },
          {
            do: "investigate",
            kind: "open_loop",
            about: ref(message),
            summary: answers[1] as string,
            basis: [ref(message)],
          },
          {
            ...propose(message, answers[2]),
            forecast: { probability: 0.4, probabilityIfWaiting: 0.2 },
          } as ReasoningAction,
        ]),
      );
      expect(await scanForPlaintext(w.db.urls.admin, answers)).toEqual([]);
      // The run shown says what it made, by run id, and what its sessions were shown.
      const again = new pg.Pool({ connectionString: w.db.urls.admin, max: 1 });
      try {
        const shown = (await new Admin({ pool: again, keys: w.db.keys, log: w.log }).work.showWork(run)) as {
          read: number;
          made: Record<string, number>;
        };
        const [made] = await w.admin(
          "select (select count(*) from ledger.opportunities where run_id = $1)::int as opportunities, (select count(*) from ledger.hypotheses where run_id = $1)::int as hypotheses, (select count(*) from ledger.cards where run_id = $1)::int as cards",
          [run],
        );
        expect(made?.opportunities).toBeGreaterThan(0);
        expect(shown.made).toEqual(made);
        expect(shown.read).toBeGreaterThanOrEqual(0);
      } finally {
        await again.end();
      }
    }));

  it("a web step's query or URL is sealed under the attempt's label and opens there; it counts toward no turn; only a web step holds one; any erasure's hook drops it and keeps the step", () =>
    withWorkWorld(async (w) => {
      await w.admin("update policy.work_settings set max_turns = 1");
      const r = await reasoner(w);
      const { run } = await taken(w, r);
      const query = "canary wombat cooperative annual report";
      const url = "https://example.com/canary-numbat";
      const model = {
        kind: "model_call" as const,
        promptId: "reasoning_run",
        promptVersion: "1",
        modelId: "test/model",
        costMicroUsd: 1,
      };
      expect(ok(await w.work.appendStep(r.token, { run, ordinal: 0, step: model }))).toEqual({ go: true });
      // With max_turns 1, the web steps after the one model call are still recorded.
      expect(
        ok(await w.work.appendStep(r.token, { run, ordinal: 1, step: { kind: "web_search", text: query } })),
      ).toEqual({ go: true });
      expect(ok(await w.work.appendStep(r.token, { run, ordinal: 2, step: { kind: "web_fetch", text: url } }))).toEqual(
        { go: true },
      );
      expect(
        code(await w.work.appendStep(r.token, { run, ordinal: 3, step: { kind: "web_search", text: "" } as never })),
      ).toBe("invalid_request");
      const rows = await w.admin<{
        ordinal: number;
        kind: string;
        status: string | null;
        tool: string | null;
        cost: number | null;
        compartments: string[];
        detail_enc: unknown;
      }>(
        "select ordinal, kind, status, tool, cost_microusd::int as cost, compartments, detail_enc from ledger.run_steps where run_id = $1 order by ordinal",
        [run],
      );
      expect(rows.map(({ ordinal, kind, status, tool, cost }) => ({ ordinal, kind, status, tool, cost }))).toEqual([
        { ordinal: 0, kind: "model_call", status: null, tool: null, cost: 1 },
        { ordinal: 1, kind: "web_search", status: null, tool: null, cost: null },
        { ordinal: 2, kind: "web_fetch", status: null, tool: null, cost: null },
      ]);
      expect(rows[0]?.detail_enc).toBeNull();
      const opened = rows
        .slice(1)
        .map((row) => openUnder(w.db.keys, row.compartments, webStepAt(run, 1, row.ordinal), row.detail_enc as never));
      expect(opened).toEqual([query, url]);
      expect(await scanForPlaintext(w.db.urls.admin, [query, url])).toEqual([]);
      // Only a web step holds one: the table refuses it on any other.
      // No runtime role may update a step, so the constraint is read from the catalogue.
      const [detail] = await w.admin<{ def: string }>(
        "select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'run_steps_detail' and conrelid = 'ledger.run_steps'::regclass",
      );
      expect(detail?.def).toMatch(/web_search.*web_fetch.*OR \(?detail_enc IS NULL\)?/);
      // The positive control of the bound: the next model call is past max_turns.
      expect(ok(await w.work.appendStep(r.token, { run, ordinal: 3, step: model }))).toEqual({ go: false });

      expect(ERASURE_HOOKS.map((hook) => hook.name)).toContain("web_requests");
      for (const other of [w.db.urls.work, w.db.urls.reader, w.db.urls.writer]) {
        await expect(queryAs(other, "select ledger.forget_web_requests()")).rejects.toMatchObject({ code: "42501" });
      }
      expect(one(await w.admin<{ n: number }>("select ledger.forget_web_requests() as n")).n).toBe(2);
      expect(
        await w.admin("select kind, detail_enc from ledger.run_steps where run_id = $1 order by ordinal", [run]),
      ).toEqual([
        { kind: "model_call", detail_enc: null },
        { kind: "web_search", detail_enc: null },
        { kind: "web_fetch", detail_enc: null },
      ]);
      expect(one(await w.admin<{ n: number }>("select ledger.forget_web_requests() as n")).n).toBe(0);
    }));

  it("one call row is written for each action", () =>
    withWorkWorld(async (w) => {
      const r = await reasoner(w);
      const { run, message } = await taken(w, r);
      const other = await w.message();
      ok(
        await finish(w, r, run, [
          propose(message),
          propose(other),
          { do: "investigate", kind: "at_risk", about: ref(other), summary: "at risk", basis: [ref(other)] },
        ]),
      );
      const calls = await w.admin<{ point: string; version: number; definition_hash: string; subject_kind: string }>(
        "select point, version, definition_hash, subject_kind from ledger.decision_point_calls where run_id = $1 order by id",
        [run],
      );
      expect(calls.map((row) => row.subject_kind).sort()).toEqual(["hypothesis", "opportunity", "opportunity"]);
      // Under the definition the run was queued with, never the newest (a one-pass run is @3).
      const [queued] = await w.admin<{ definition_version: number }>(
        "select definition_version from ledger.runs where id = $1",
        [run],
      );
      const version = queued?.definition_version;
      for (const row of calls)
        expect(row).toMatchObject({
          point: "run_outcome",
          version,
          definition_hash: DECISION_POINT_PINS[`run_outcome@${version}`],
        });
      // Each run_outcome call row is a tool call of finish_run's one calls row.
      expect(
        await w.admin("select tool, rows, outcome from policy.calls where client_id = $1 and tool = 'finish_run'", [
          r.id,
        ]),
      ).toEqual([{ tool: "finish_run", rows: 1, outcome: "ok" }]);
    }));

  it("finish_run twice records once", () =>
    withWorkWorld(async (w) => {
      const r = await reasoner(w);
      const { run, message } = await taken(w, r);
      const requestId = request();
      const first = ok(await finish(w, r, run, [propose(message)], requestId));
      expect(ok(await finish(w, r, run, [propose(message)], requestId))).toEqual(first);
      expect(ok(await finish(w, r, run, [propose(message)]))).toEqual(first);
      expect(await w.admin("select count(*)::int as n from ledger.opportunities")).toEqual([{ n: 1 }]);
    }));

  it("a step past a bound answers go false", () =>
    withWorkWorld(async (w) => {
      await w.admin("update policy.work_settings set max_turns = 1");
      const r = await reasoner(w);
      const { run } = await taken(w, r);
      const model = {
        kind: "model_call" as const,
        promptId: "reasoning_run",
        promptVersion: "1",
        modelId: "test/model",
        costMicroUsd: 1,
      };
      expect(ok(await w.work.appendStep(r.token, { run, ordinal: 0, step: model }))).toEqual({ go: true });
      expect(ok(await w.work.appendStep(r.token, { run, ordinal: 1, step: model }))).toEqual({ go: false });
      expect(await w.latest("run", run)).toBe("failed");
    }));

  it("append_step for a run the caller never took is not_found, and not a stop", () =>
    withWorkWorld(async (w) => {
      const r = await reasoner(w);
      const queued = (await w.queuedRun()) as RunId;
      const step = { kind: "tool_call" as const, tool: "search" as const, status: "ok" as const };
      expect(code(await w.work.appendStep(r.token, { run: queued, ordinal: 0, step }))).toBe("not_found");
      expect(code(await w.work.appendStep(r.token, { run: `run_${"0".repeat(26)}` as RunId, ordinal: 0, step }))).toBe(
        "not_found",
      );
      // The positive control: once taken, the same step is recorded.
      expect(ok(await w.work.nextRun(r.token, { requestId: request() })).run?.id).toBe(queued);
      expect(ok(await w.work.appendStep(r.token, { run: queued, ordinal: 0, step }))).toEqual({ go: true });
    }));

  it("after an erasure a step answers go false and finish_run answers stopped with nothing recorded", () =>
    withWorkWorld(async (w) => {
      const r = await reasoner(w);
      const { run, message } = await taken(w, r);
      const step = { kind: "tool_call" as const, tool: "search" as const, status: "ok" as const };
      expect(ok(await w.work.appendStep(r.token, { run, ordinal: 0, step }))).toEqual({ go: true });
      const ruling = testId("rul");
      await w.admin(
        "insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, labels, details, decided_at, compartments) values ($1, $2, 'erase', 0, '{}', '{}', now(), '{own}')",
        [ruling, request()],
      );
      await w.admin(
        "insert into knowledge.erasures (id, ruling_id, kind, journal_seq, erased_at, items, suppressed, tainted_rows, compartments) values ($1, $2, 'item', policy.erasure_mark() + 1, now(), 0, 0, 0, '{own}')",
        [testId("ers"), ruling],
      );
      expect(ok(await w.work.appendStep(r.token, { run, ordinal: 1, step }))).toEqual({ go: false });
      expect(ok(await finish(w, r, run, [propose(message)]))).toEqual({ recorded: 0, outcome: "stopped" });
      expect(await w.admin("select count(*)::int as n from ledger.opportunities")).toEqual([{ n: 0 }]);
      expect(await w.latest("run", run)).toBe("stopped");
    }));

  it("the rows finish_run wrote carry the attempt's session", () =>
    withWorkWorld(async (w) => {
      const r = await reasoner(w);
      const { run, message } = await taken(w, r);
      ok(
        await finish(w, r, run, [
          propose(message),
          { do: "investigate", kind: "open_loop", about: ref(message), summary: "a loop", basis: [ref(message)] },
        ]),
      );
      const attempt = one(
        await w.admin<{ session_id: string }>("select session_id from ledger.run_attempts where run_id = $1", [run]),
      ).session_id;
      expect(attempt).toBe(w.reader.sessions.of(r.id as never));
      for (const table of ["ledger.opportunities", "ledger.hypotheses", "ledger.decision_point_calls"]) {
        expect(await w.admin(`select distinct session_id from ${table} where run_id = $1`, [run]), table).toEqual([
          { session_id: attempt },
        ]);
      }
    }));
});

// The planner's learning loop: the closed cases of a run request carry what was proposed, the
// owner's decision and note, and what came of it.
describe("the planner's learning loop", { timeout: DB_TEST_TIMEOUT }, () => {
  // The owner's decision on a case's card, as `pi decide` gives it.
  async function decided(
    w: WorkWorld,
    admin: Admin,
    target: { kind: "opportunity" | "hypothesis"; id: string },
    answer: string,
    note?: string,
  ): Promise<void> {
    const kind = target.kind === "opportunity" ? "opportunity_decision" : "owner_question";
    const card = newId("crd") as CardId;
    await admin.cards.raiseCard({
      id: card,
      requestId: request(),
      kind,
      author: "reasoner",
      options: [...(CARD_KINDS[kind]?.options ?? [])],
      target: target as never,
      refs: [],
      compartments: await w.label(
        target.kind === "opportunity" ? "ledger.opportunities" : "ledger.hypotheses",
        target.id,
      ),
      expiresAt: null,
      expiresAfterDays: 14,
      caseKey: null,
      run: null,
      body: null,
      bodyFrom: null,
    });
    await admin.cards.decide({ cards: [card], answer, ...(note === undefined ? {} : { note }), requestId: request() });
  }

  // A move of the opportunity's, done, as plan_move and report_move leave one (written as
  // pi_owner, as the definer functions write it).
  async function doneMove(
    w: WorkWorld,
    opportunity: string,
    client: WorkClient,
    intent: string,
    harness: string,
  ): Promise<void> {
    const [decision] = await w.admin<{ id: string }>(
      "select id::text as id from ledger.opportunity_decisions where opportunity_id = $1 order by id desc limit 1",
      [opportunity],
    );
    const assignment = newId("asg");
    const move = newId("mov");
    await session(w.db.urls.bootstrap, async (query) => {
      await query("set role pi_owner");
      await query(
        "insert into ledger.assignments (id, request_id, created_by, compartments, opportunity_id, client_id, intent_id) values ($1, $1, 'system:test', '{own}', $2, $3, $4)",
        [assignment, opportunity, client.id, intent],
      );
      await query(
        `insert into ledger.moves (id, request_id, created_by, compartments, opportunity_id, assignment_id, stage, harness_mode_id, decision_id, intent_id, effect_class)
         values ($1, $1, $2, '{own}', $3, $4, 'investigate', $5, $6, $7, 'internal_reversible')`,
        [move, `client:${client.id}`, opportunity, assignment, harness, decision?.id, intent],
      );
      await query(
        "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('move', $1, 'done', clock_timestamp(), $2, '{own}')",
        [move, `client:${client.id}`],
      );
    });
  }

  // A case's events placed `minutes` before the database's now. The owner's answers carry the
  // admin process's clock and a definer function's events the database's, and the two need not
  // agree to the millisecond under load, so a test that orders cases by time sets each time.
  const placed = (w: WorkWorld, rowKind: string, id: string, minutes: number): Promise<unknown> =>
    session(w.db.urls.bootstrap, async (query) => {
      await query("set role pi_owner");
      await query(
        "update ledger.record_events set at = now() - make_interval(mins => $3) where row_kind = $1 and row_id = $2",
        [rowKind, id, minutes],
      );
    });

  const adminOf = (w: WorkWorld): { admin: Admin; end: () => Promise<void> } => {
    const pool = new pg.Pool({ connectionString: w.db.urls.admin, max: 2 });
    return { admin: new Admin({ pool, keys: w.db.keys, log: w.log }), end: () => pool.end() };
  };

  it("a closed case carries its summary, what the owner answered and note, and what came of it, newest first; an open case the owner did not answer is not one", () =>
    withWorkWorld(async (w) => {
      const r = await reasoner(w);
      const agent = await w.client("agent");
      const tester = await w.client("tester");
      const { admin, end } = adminOf(w);
      try {
        // Declined, with the owner's note: process, not progress.
        const m1 = await w.message();
        const declined = ok(
          await w.work.proposeOpportunity(agent.token, {
            kind: "goal_step",
            about: ref(m1),
            summary: "Build a scorecard for evaluating advisers",
            basis: [ref(m1)],
            requestId: request(),
          }),
        ).opportunity;
        await decided(w, admin, { kind: "opportunity", id: declined }, "no_go", "process, not progress");
        // Approved, with a note, under an intent its agent works, and a move of it done.
        const intent = await w.intent(["investigate"], [agent]);
        const harness = await w.harness(agent, "investigate", "investigate");
        const m2 = await w.message();
        const approved = ok(
          await w.work.proposeOpportunity(agent.token, {
            kind: "investigate",
            about: ref(m2),
            summary: "Research Omar Haddad and Fernway Logistics for fit",
            basis: [ref(m2)],
            requestId: request(),
          }),
        ).opportunity;
        await decided(w, admin, { kind: "opportunity", id: approved }, "go", "more like this");
        expect(await w.latest("opportunity", approved)).toBe("go");
        await doneMove(w, approved, agent, intent, harness);
        // A hypothesis another client's test supported: settled by the system, not the owner.
        const m3 = await w.message();
        const hypothesis = ok(
          await w.work.proposeHypothesis(agent.token, {
            kind: "open_loop",
            about: ref(m3),
            summary: "Tomas Reyes is a high-context connector",
            basis: [ref(m3)],
            requestId: request(),
          }),
        ).hypothesis;
        ok(
          await w.work.recordTest(tester.token, {
            hypothesis,
            result: "supports",
            basis: [ref(m3)],
            requestId: request(),
          }),
        );
        // Open and unanswered: no case of the list.
        const m4 = await w.message();
        const open = ok(
          await w.work.proposeOpportunity(agent.token, {
            kind: "follow_up",
            about: ref(m4),
            summary: "Draft a note to the introducer",
            basis: [ref(m4)],
            requestId: request(),
          }),
        ).opportunity;

        // Newest first: the hypothesis, then the approved case, then the declined one.
        await placed(w, "opportunity", declined, 30);
        await placed(w, "opportunity", approved, 20);
        await placed(w, "hypothesis", hypothesis, 10);
        const { request: built } = await taken(w, r);
        const none = { moves: { done: 0, failed: 0, blocked: 0 }, tests: { supports: 0, refutes: 0, inconclusive: 0 } };
        expect(built.closed.map((one) => one.id)).toEqual([hypothesis, approved, declined]);
        expect(built.closed.map((one) => one.id)).not.toContain(open);
        expect(built.closed[0]).toEqual({
          rowKind: "hypothesis",
          kind: "open_loop",
          about: ref(m3),
          closedAt: expect.any(String),
          by: "policy",
          id: hypothesis,
          status: "supported",
          summary: { untrusted: "Tomas Reyes is a high-context connector" },
          decision: null,
          note: null,
          outcome: { ...none, tests: { supports: 1, refutes: 0, inconclusive: 0 } },
        });
        expect(built.closed[1]).toMatchObject({
          rowKind: "opportunity",
          kind: "investigate",
          by: "owner",
          status: "go",
          summary: { untrusted: "Research Omar Haddad and Fernway Logistics for fit" },
          decision: "go",
          note: { untrusted: "more like this" },
          outcome: { ...none, moves: { done: 1, failed: 0, blocked: 0 } },
        });
        expect(built.closed[2]).toMatchObject({
          rowKind: "opportunity",
          kind: "goal_step",
          by: "owner",
          status: "no_go",
          summary: { untrusted: "Build a scorecard for evaluating advisers" },
          decision: "no_go",
          note: { untrusted: "process, not progress" },
          outcome: none,
        });
        // The note is sealed with the decision and in the status event, and in clear in neither.
        const [ruling] = await w.admin<{ body: boolean }>(
          "select body_enc is not null as body from knowledge.owner_decisions where kind = 'answer' and target_id = $1",
          [declined],
        );
        expect(ruling?.body).toBe(true);
        expect(await scanForPlaintext(w.db.urls.admin, ["process, not progress", "more like this"])).toEqual([]);
        // The owner's question answered with a note is a case of the list too, their answer a word.
        const asked = ok(
          await w.work.proposeHypothesis(agent.token, {
            kind: "preference",
            about: { kind: "owner" },
            summary: "You prefer operators to investors as advisers",
            basis: [ref(m1)],
            requestId: request(),
          }),
        ).hypothesis;
        await decided(w, admin, { kind: "hypothesis", id: asked }, "reject", "investors are fine too");
        await placed(w, "hypothesis", asked, 5);
        const again = await taken(w, r);
        expect(again.request.closed[0]).toMatchObject({
          id: asked,
          rowKind: "hypothesis",
          status: "rejected",
          by: "owner",
          decision: "reject",
          note: { untrusted: "investors are fine too" },
        });
      } finally {
        await end();
      }
    }));

  it("the list is capped at 50 cases and at CLOSED_CODE_POINTS of JSON text, keeping the newest", () =>
    withWorkWorld(async (w) => {
      const r = await reasoner(w);
      const agent = await w.client("agent");
      const decline = async (summary: string): Promise<string> => {
        const about = await w.message();
        const id = ok(
          await w.work.proposeOpportunity(agent.token, {
            kind: "follow_up",
            about: ref(about),
            summary,
            basis: [ref(about)],
            requestId: request(),
          }),
        ).opportunity;
        await w.status("opportunity", id, "no_go", "owner");
        return id;
      };
      const short: string[] = [];
      for (let n = 0; n < 55; n += 1) short.push(await decline(`a short case ${n}`));
      const first = (await taken(w, r)).request.closed;
      expect(first).toHaveLength(50);
      expect(first.map((one) => one.id)).toEqual(short.slice(5).reverse());
      expect([...JSON.stringify(first)].length).toBeLessThanOrEqual(CLOSED_CODE_POINTS);
      // Long summaries: fewer than 50 fit, the newest first.
      const long: string[] = [];
      for (let n = 0; n < 40; n += 1) long.push(await decline(`${n} long case ${"é".repeat(260)}`));
      const second = (await taken(w, r)).request.closed;
      expect(second.length).toBeLessThan(50);
      expect(second.length).toBeGreaterThan(20);
      expect(second.map((one) => one.id)).toEqual(long.slice(40 - second.length).reverse());
      expect(second.reduce((sum, one) => sum + [...JSON.stringify(one)].length, 0)).toBeLessThanOrEqual(
        CLOSED_CODE_POINTS,
      );
    }));

  // Which closed cases a run sees: by relevance to the run's focus, then by recency.
  type Ref = { kind: string; id: string };
  // A case's events moved back by `days`, as pi_owner may (the definer functions' role).
  const backdate = (w: WorkWorld, rowKind: string, id: string, days: number): Promise<unknown> =>
    session(w.db.urls.bootstrap, async (query) => {
      await query("set role pi_owner");
      await query(
        "update ledger.record_events set at = at - make_interval(days => $3) where row_kind = $1 and row_id = $2",
        [rowKind, id, days],
      );
    });
  const declinedBy = async (
    w: WorkWorld,
    client: WorkClient,
    about: Ref,
    options: { basis?: Ref[]; kind?: string; days?: number } = {},
  ): Promise<string> => {
    const cited = await w.message(client.compartments);
    const id = ok(
      await w.work.proposeOpportunity(client.token, {
        kind: (options.kind ?? "follow_up") as never,
        about: about as never,
        summary: "a case about the cited message",
        basis: [ref(cited), ...(options.basis ?? [])] as never,
        requestId: request(),
      }),
    ).opportunity;
    await w.status("opportunity", id, "no_go", "owner");
    if (options.days !== undefined) await backdate(w, "opportunity", id, options.days);
    return id;
  };
  const takenOn = async (w: WorkWorld, r: WorkClient, anchors: [kind: string, id: string][]): Promise<RunRequest> => {
    await w.queuedRun(["own"], anchors);
    const value = ok(await w.work.nextRun(r.token, { requestId: request() }));
    if (value.run === null) throw new Error("no run taken");
    return value.run;
  };

  it("a run sees the cases that share its focus, of the last 180 days, first, then the others of the last 30; a case it cannot see changes nothing", () =>
    withWorkWorld(async (w) => {
      const r = await reasoner(w);
      const agent = await w.client("agent");
      const tester = await w.client("tester");
      const wide = await w.client("wide", BOTH);
      const person = await w.seed.entity("person");
      await w.seed.account(["own"], person);
      const entity = { kind: "entity", id: person };
      const goal = await w.goal(["own"], "hire two operators");
      // The hypothesis the run is about: open, so no case of its own.
      const onIt = await w.message();
      const anchor = ok(
        await w.work.proposeHypothesis(agent.token, {
          kind: "at_risk",
          about: ref(onIt),
          summary: "the quote is at risk",
          basis: [ref(onIt)],
          requestId: request(),
        }),
      ).hypothesis;

      const aboutPerson = await declinedBy(w, agent, entity, { kind: "investigate", days: 100 });
      const citesPerson = await declinedBy(w, agent, ref(await w.message()), { basis: [entity], days: 120 });
      const forGoal = await declinedBy(w, agent, { kind: "goal", id: goal }, { kind: "goal_step" });
      const onItsMessage = await declinedBy(w, agent, ref(onIt), { days: 20 });
      const m = await w.message();
      const sameKind = ok(
        await w.work.proposeHypothesis(agent.token, {
          kind: "at_risk",
          about: ref(m),
          summary: "another at risk",
          basis: [ref(m)],
          requestId: request(),
        }),
      ).hypothesis;
      ok(
        await w.work.recordTest(tester.token, {
          hypothesis: sameKind,
          result: "supports",
          basis: [ref(m)],
          requestId: request(),
        }),
      );
      await backdate(w, "hypothesis", sameKind, 150);
      const tooOld = await declinedBy(w, agent, entity, { days: 200 });
      const oldOther = await declinedBy(w, agent, ref(await w.message()), { days: 40 });
      const others: string[] = [];
      for (let n = 0; n < 3; n += 1) others.push(await declinedBy(w, agent, ref(await w.message())));
      // About the same person, under a label the reasoner does not hold, and the newest of all.
      const hidden = await declinedBy(w, wide, entity);

      const built = await takenOn(w, r, [
        ["entity", person],
        ["goal", goal],
        ["hypothesis", anchor],
      ]);
      const ids = built.closed.map((one) => one.id);
      expect(ids).toEqual([forGoal, onItsMessage, aboutPerson, citesPerson, sameKind, ...others.toReversed()]);
      expect(ids).not.toContain(tooOld);
      expect(ids).not.toContain(oldOther);
      expect(ids).not.toContain(hidden);
      expect(built.closed[2]).toMatchObject({ about: entity, kind: "investigate", decision: "no_go" });

      // The control: a run with no anchor sees the recent cases alone, newest first.
      const plain = await takenOn(w, r, []);
      expect(plain.closed.map((one) => one.id)).toEqual([...others.toReversed(), forGoal, onItsMessage]);
    }));

  it("the 10 newest other cases are kept before the relevant ones, which fill the rest of the 50", () =>
    withWorkWorld(async (w) => {
      const r = await reasoner(w);
      const agent = await w.client("agent");
      const person = await w.seed.entity("person");
      await w.seed.account(["own"], person);
      const relevant: string[] = [];
      for (let n = 0; n < 45; n += 1) relevant.push(await declinedBy(w, agent, { kind: "entity", id: person }));
      const others: string[] = [];
      for (let n = 0; n < 12; n += 1) others.push(await declinedBy(w, agent, ref(await w.message())));
      const built = await takenOn(w, r, [["entity", person]]);
      expect(built.closed.map((one) => one.id)).toEqual([
        ...relevant.slice(5).toReversed(),
        ...others.slice(2).toReversed(),
      ]);
    }));

  // The planner's work carries its kind's default expectation, as an agent's does.
  it("a run's proposals get their kind's default expectation, labelled as the opportunity; none for a kind with no default, a merge or a repeat", () =>
    withWorkWorld(async (w) => {
      const r = await reasoner(w);
      const expected = (opportunity: string) =>
        w.admin(
          "select ordinal, origin, subject_kind, outcome_type, horizon_days, compartments, created_by from ledger.expected_outcomes where opportunity_id = $1 order by ordinal",
          [opportunity],
        );
      const { run, message } = await taken(w, r);
      const requestId = request();
      const output = [
        propose(message),
        {
          do: "propose",
          kind: "meeting_prep",
          about: ref(message),
          summary: "prepare for the pilot meeting",
          basis: [ref(message)],
        },
        {
          do: "propose",
          kind: "life_admin",
          about: ref(message),
          summary: "renew the parking permit",
          basis: [ref(message)],
        },
      ] as ReasoningAction[];
      ok(await finish(w, r, run, output, requestId));
      const made = await w.admin<{ id: string; kind: string }>(
        "select id, kind from ledger.opportunities where created_by = $1",
        [`run:${run}`],
      );
      const of = (kind: string): string => one(made.filter((row) => row.kind === kind)).id;
      const author = `client:${r.id}`;
      expect(await expected(of("follow_up"))).toEqual([
        {
          ordinal: 0,
          origin: "default",
          subject_kind: "counterpart",
          outcome_type: "answered",
          horizon_days: 14,
          compartments: await w.label("ledger.opportunities", of("follow_up")),
          created_by: author,
        },
      ]);
      expect(await expected(of("meeting_prep"))).toMatchObject([
        {
          origin: "default",
          outcome_type: "meeting_held",
          horizon_days: 30,
          compartments: await w.label("ledger.opportunities", of("meeting_prep")),
        },
      ]);
      expect(await expected(of("life_admin"))).toEqual([]);
      // A repeat answers as before and writes nothing more.
      ok(await finish(w, r, run, output, requestId));
      expect(await w.admin("select count(*)::int as n from ledger.expected_outcomes")).toEqual([{ n: 2 }]);
      // A second run's follow-up about the same message merges into the open one: nothing attached twice.
      const next = await taken(w, r, message);
      ok(await finish(w, r, next.run, [propose(message, "follow up on the quote again")]));
      expect(
        await w.admin("select count(*)::int as n from ledger.opportunities where created_by = $1", [`run:${next.run}`]),
      ).toEqual([{ n: 0 }]);
      expect(await expected(of("follow_up"))).toHaveLength(1);
      expect(await w.admin("select count(*)::int as n from ledger.expected_outcomes")).toEqual([{ n: 2 }]);
    }));
});
