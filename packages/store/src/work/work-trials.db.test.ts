import { currentDefinition, type RunId, type RunTrial, STAGE_PROMPT_IDS } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { request, testId } from "../test-support/clients.ts";
import { one, readAs, session } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { withAdmin } from "../test-support/work-test-tasks.ts";
import { type Message, ok, type WorkWorld, withWorkWorld } from "../test-support/work-test-world.ts";
import { wakeFacts } from "./dispatch-read.ts";
import { failedRunStreak } from "./dispatch-streaks.ts";

// Trial runs. The owner queues one planner stage on a model and effort they name; the reasoner is
// given them in the run's request; finish_run checks the output as any run's, keeps it sealed on
// the run's `finished` event and writes nothing else; the trials list sums each trial. Runs that
// are not trials are untouched by them. Made-up values only.

const HAIKU: RunTrial = { model: "anthropic/claude-haiku-5.5", effort: "high" };
const ref = (message: Message) => ({ kind: "message" as const, id: message.id as never });
const idea = (message: Message) => ({
  idea: "Introduce two made-up founders.",
  why: "Each needs what the other built.",
  basis: [ref(message)],
  confidence: 0.6,
  test: "Ask one of them.",
});

// What a trial must leave as it was: every row a run may write.
const BOARD = `select
  (select count(*)::int from ledger.hypotheses) as hypotheses, (select count(*)::int from ledger.opportunities) as opportunities,
  (select count(*)::int from ledger.intentions) as intentions, (select count(*)::int from ledger.cases) as cases,
  (select count(*)::int from ledger.cards) as cards,
  (select count(*)::int from ledger.silences) as silences, (select count(*)::int from ledger.decision_point_calls) as calls,
  (select count(*)::int from ledger.basis) as basis`;

// A run that is no trial, queued as the tick queues one under the stage's current prompt.
async function queued(w: WorkWorld, stage: keyof typeof STAGE_PROMPT_IDS): Promise<string> {
  const point = currentDefinition("run_outcome");
  const prompt = point.prompts?.find((one) => one.id === STAGE_PROMPT_IDS[stage]);
  const id = testId("run");
  await queryAs(
    w.db.urls.work,
    `insert into ledger.runs (id, request_id, created_by, compartments, wake_source, wake_key, decision_point, definition_version, prompt_id, prompt_version)
     values ($1, $1, 'system:tick', '{own}', 'daily_sweep', $2, 'run_outcome', $3, $4, $5)`,
    [id, `sweep:${id}`, point.version, prompt?.id, prompt?.version],
  );
  await w.status("run", id, "queued", "system:tick");
  return id;
}

// finish_run called as the reasoner with actions of the test's own: its row, or the code it raised.
async function rawFinish(
  w: WorkWorld,
  token: string,
  sessionId: string,
  run: string,
  actions: unknown[],
): Promise<unknown> {
  try {
    return one(
      await readAs(w.db, token, (query) =>
        query("select * from ledger.finish_run($1, $2, $3, 'finished', null, $4, 'made-up-hash', $5::jsonb)", [
          run,
          request(),
          sessionId,
          currentDefinition("run_outcome").version,
          JSON.stringify(actions),
        ]),
      ),
    );
  } catch (error) {
    return (error as { code?: string }).code ?? "error";
  }
}

describe("trial runs", { timeout: DB_TEST_TIMEOUT }, () => {
  it("an ideas trial carries its model and effort, keeps its checked output sealed on its run, writes nothing to the board, and is listed with its counts", () =>
    withWorkWorld(async (w) => {
      const reasoner = await w.client("reasoner", ["own"], { kind: "reasoner" });
      const message = await w.message();
      await withAdmin(w, async (admin) => {
        const run = await admin.work.queueTrial({ stage: "ideas", trial: HAIKU });
        expect(
          one(
            await w.admin(
              "select wake_source, wake_key, prompt_id, trial_model, trial_effort, compartments, cards from ledger.runs where id = $1",
              [run],
            ),
          ),
        ).toEqual({
          wake_source: "owner_request",
          wake_key: `trial:${run}`,
          prompt_id: "personal_ideas",
          trial_model: HAIKU.model,
          trial_effort: HAIKU.effort,
          compartments: ["own"],
          cards: null,
        });
        // A model id or effort off its form, or an idea for a stage that takes none: refused, and
        // nothing is queued.
        for (const wrong of [
          { stage: "ideas" as const, trial: { model: "Anthropic/Haiku", effort: "high" as const } },
          { stage: "ideas" as const, trial: { model: HAIKU.model, effort: "max" as never } },
          { stage: "translate" as const, trial: HAIKU },
          { stage: "ideas" as const, trial: HAIKU, idea: testId("hyp") as never },
        ]) {
          await expect(admin.work.queueTrial(wrong), JSON.stringify(wrong)).rejects.toMatchObject({
            code: "invalid_argument",
          });
        }
        expect(await w.admin("select id from ledger.runs where trial_model is not null")).toEqual([{ id: run }]);

        const built = ok(await w.work.nextRun(reasoner.token, { requestId: request() })).run;
        expect(built?.id).toBe(run);
        expect(built?.trial).toEqual(HAIKU);
        expect(built?.point.promptId).toBe("personal_ideas");
        // Its steps carry the model call's counts.
        expect(
          ok(
            await w.work.appendStep(reasoner.token, {
              run: run as RunId,
              ordinal: 0,
              step: {
                kind: "model_call",
                promptId: "personal_ideas",
                promptVersion: "1",
                modelId: HAIKU.model,
                costMicroUsd: 900,
                inputTokens: 5000,
                outputTokens: 700,
                ms: 8100,
              },
            }),
          ).go,
        ).toBe(true);
        expect(
          one(
            await w.admin(
              "select input_tokens, output_tokens, ms, cost_microusd::int as cost from ledger.run_steps where run_id = $1",
              [run],
            ),
          ),
        ).toEqual({ input_tokens: 5000, output_tokens: 700, ms: 8100, cost: 900 });

        const board = one(await w.admin(BOARD));
        // An output of another stage's form: refused, and the run goes on.
        const wrong = await w.work.finishRun(reasoner.token, {
          run: run as RunId,
          outcome: "finished",
          output: { lessons: [] },
          requestId: request(),
        });
        expect(wrong.ok ? "ok" : wrong.code).toBe("invalid_request");
        expect(await w.latest("run", run)).toBe("running");
        const output = { ideas: [idea(message)] };
        expect(
          ok(
            await w.work.finishRun(reasoner.token, {
              run: run as RunId,
              outcome: "finished",
              output,
              requestId: request(),
            }),
          ),
        ).toEqual({ recorded: 0, outcome: "finished" });
        expect(one(await w.admin(BOARD))).toEqual(board);
        // The output: the body of the run's `finished` event, sealed, under the attempt's label.
        expect(
          one(
            await w.admin<{ sealed: boolean; compartments: string[] }>(
              "select body_enc is not null as sealed, compartments from ledger.record_events where row_kind = 'run' and row_id = $1 and event = 'finished'",
              [run],
            ),
          ),
        ).toEqual({
          sealed: true,
          compartments: ["own"],
        });
        expect(await admin.work.trialShow(run)).toMatchObject({
          id: run,
          stage: "ideas",
          model: HAIKU.model,
          effort: HAIKU.effort,
          output,
        });
        expect(await admin.work.trialShow(testId("run"))).toBeNull();

        const [listed, ...more] = await admin.work.trials();
        expect(more).toEqual([]);
        expect(listed).toMatchObject({
          id: run,
          stage: "ideas",
          model: HAIKU.model,
          effort: HAIKU.effort,
          outcome: "finished",
          code: null,
          modelCalls: 1,
          toolCalls: 0,
          inputTokens: 5000,
          outputTokens: 700,
          modelMs: 8100,
          costMicroUsd: 900,
          firstTryValid: true,
        });
        expect(listed?.durationMs).toBeGreaterThanOrEqual(0);
        expect(await admin.work.trials("lessons")).toEqual([]);
      });
    }));

  it("a run that is no trial may not send a trial's action, and a trial may send nothing else", () =>
    withWorkWorld(async (w) => {
      const reasoner = await w.client("reasoner", ["own"], { kind: "reasoner" });
      const message = await w.message();
      const normal = await queued(w, "ideas");
      expect(ok(await w.work.nextRun(reasoner.token, { requestId: request() })).run?.trial).toBeUndefined();
      const body = { v: 1, made: "up" };
      expect(await rawFinish(w, reasoner.token, reasoner.session, normal, [{ do: "trial", body_enc: body }])).toBe(
        "22023",
      );
      // The control: the same run finishes with its ideas, which it writes.
      expect(
        ok(
          await w.work.finishRun(reasoner.token, {
            run: normal as RunId,
            outcome: "finished",
            output: { ideas: [idea(message)] },
            requestId: request(),
          }),
        ),
      ).toEqual({ recorded: 1, outcome: "finished" });

      const trial = await withAdmin(w, (admin) => admin.work.queueTrial({ stage: "ideas", trial: HAIKU }));
      ok(await w.work.nextRun(reasoner.token, { requestId: request() }));
      const hyp = testId("hyp");
      const ideaAction = {
        do: "idea",
        id: hyp,
        about_kind: "message",
        about_id: message.id,
        ref_kinds: ["message"],
        ref_ids: [message.id],
        body_enc: body,
      };
      for (const actions of [
        [ideaAction],
        [
          { do: "trial", body_enc: body },
          { do: "trial", body_enc: body },
        ],
        [{ do: "trial", body_enc: "sealed" }],
      ]) {
        expect(await rawFinish(w, reasoner.token, reasoner.session, trial, actions), JSON.stringify(actions)).toBe(
          "22023",
        );
      }
      expect(await w.admin("select id from ledger.hypotheses where id = $1", [hyp])).toEqual([]);
    }));

  it("runs that are not trials are unchanged: a trial is not counted in the day's runs, the failed-run streak or the work report", () =>
    withWorkWorld(async (w) => {
      const reasoner = await w.client("reasoner", ["own"], { kind: "reasoner" });
      const facts = () => session(w.db.urls.work, (query) => wakeFacts(query, "daily_sweep", false, new Date()));
      const before = (await facts()).runsToday;
      await withAdmin(w, async (admin) => {
        const trials: string[] = [];
        for (let n = 0; n < 3; n += 1) {
          const run = await admin.work.queueTrial({ stage: "lessons", trial: HAIKU });
          trials.push(run);
          ok(await w.work.nextRun(reasoner.token, { requestId: request() }));
          expect(
            ok(
              await w.work.finishRun(reasoner.token, {
                run: run as RunId,
                outcome: "failed",
                code: "model_unavailable",
                requestId: request(),
              }),
            ),
          ).toEqual({ recorded: 0, outcome: "failed" });
        }
        expect((await facts()).runsToday).toBe(before);
        expect(await session(w.db.urls.work, (query) => failedRunStreak(query))).toBeNull();
        const report = await admin.work.report(7);
        expect(report.runs.filter((one) => trials.includes(one.id))).toEqual([]);
        // The control: a run that is no trial is counted.
        await queued(w, "ideas");
        expect((await facts()).runsToday).toBe(before + 1);
        const listed = await admin.work.trials("lessons");
        expect(listed.map((one) => [one.outcome, one.code, one.firstTryValid])).toEqual(
          Array(3).fill(["failed", "model_unavailable", false]),
        );
      });
    }));

  it("an erasure drops every trial's stored output; only pi_admin may", () =>
    withWorkWorld(async (w) => {
      const reasoner = await w.client("reasoner", ["own"], { kind: "reasoner" });
      const message = await w.message();
      await withAdmin(w, async (admin) => {
        const run = await admin.work.queueTrial({ stage: "ideas", trial: HAIKU });
        ok(await w.work.nextRun(reasoner.token, { requestId: request() }));
        ok(
          await w.work.finishRun(reasoner.token, {
            run: run as RunId,
            outcome: "finished",
            output: { ideas: [idea(message)] },
            requestId: request(),
          }),
        );
        for (const url of [w.db.urls.work, w.db.urls.reader, w.db.urls.writer]) {
          await expect(queryAs(url, "select ledger.forget_trial_outputs()")).rejects.toMatchObject({ code: "42501" });
        }
        expect(one(await w.admin<{ n: number }>("select ledger.forget_trial_outputs() as n")).n).toBe(1);
        expect(await admin.work.trialShow(run)).toMatchObject({ id: run, output: null });
        expect(await w.latest("run", run)).toBe("finished");
        expect(one(await w.admin<{ n: number }>("select ledger.forget_trial_outputs() as n")).n).toBe(0);
      });
    }));
});
