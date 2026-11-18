import type { ModelUsageEvent } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { testId } from "../../test-support/clients.ts";
import { one } from "../../test-support/connections.ts";
import { type PipelineStore, withPipeline } from "../../test-support/pipeline-fixtures.ts";
import { recordingLogger } from "../../test-support/recording.ts";
import { type WorkClient, type WorkWorld, withWorkWorld } from "../../test-support/work-fixtures.ts";
import { createAdmin } from "../admin.ts";

// Each day's spend split by how its costs were counted, derived at read: `extractionStatus`'s day
// over vault.model_usage and the work status's day over ledger.run_steps' model calls, each total
// unchanged. Made-up model ids and costs only.

const TIMEOUT = 240_000;
const OPENROUTER = "example/model";
const ANTHROPIC = "claude-haiku-5-5";
const today = (): string => new Date().toISOString().slice(0, 10);

const usage = (store: PipelineStore, modelId: string, outcome: ModelUsageEvent["outcome"], costMicroUsd: number) =>
  store.pipeline.recordUsage({
    promptId: "personal_correspondence",
    promptVersion: "1",
    modelId,
    inputTokens: 1,
    outputTokens: 1,
    costMicroUsd,
    outcome,
  });

// A queued run as the tick writes one, taken by the reasoner.
type Taken = { run: string; prompt: string; reasoner: WorkClient };
async function takenRun(w: WorkWorld, reasoner: WorkClient): Promise<Taken> {
  const run = testId("run");
  const prompt = "personal_run";
  await w.work(
    `insert into ledger.runs (id, request_id, created_by, compartments, wake_source, wake_key, decision_point, definition_version, prompt_id, prompt_version)
     values ($1, $2, 'system:tick', '{own}', 'owner_request', $3, 'run_outcome', 1, $4, '1')`,
    [run, testId("req"), `owner_request:${run}`, prompt],
  );
  await w.work(
    "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('run', $1, 'queued', now(), 'system:tick', '{own}')",
    [run],
  );
  expect(await w.take(reasoner)).toBe(run);
  return { run, prompt, reasoner };
}

// One model call step through ledger.append_step, as the reasoner records it.
async function modelCall(
  w: WorkWorld,
  taken: Taken,
  ordinal: number,
  modelId: string,
  cost: number,
  code: string | null = null,
): Promise<void> {
  const [row] = await w.as<{ go: boolean }>(
    taken.reasoner,
    "select ledger.append_step($1::text, $2::integer, $3::text, 'model_call', null, null, $4::text, $5::text, '1', $6::text, $7::bigint) as go",
    [taken.run, ordinal, taken.reasoner.session, code, taken.prompt, modelId, cost],
  );
  expect(row?.go).toBe(true);
}

describe("the cost basis at read", { timeout: TIMEOUT }, () => {
  it("a cost_missing and a timed_out usage row are assumed", () =>
    withPipeline(async (store) => {
      const admin = createAdmin({ url: store.db.urls.admin, keys: store.db.keys, log: recordingLogger().log });
      try {
        // Under either route's id.
        await usage(store, OPENROUTER, "cost_missing", 300);
        await usage(store, ANTHROPIC, "timed_out", 400);
        expect((await admin.extraction.status({ generation: 1 })).spend.todayBasis).toEqual({
          reported: 0,
          price_list: 0,
          assumed: 700,
        });
      } finally {
        await admin.close();
      }
    }));

  it("the three parts sum to the total the budget compares", async () => {
    await withPipeline(async (store) => {
      const admin = createAdmin({ url: store.db.urls.admin, keys: store.db.keys, log: recordingLogger().log });
      try {
        await usage(store, OPENROUTER, "ok", 100);
        await usage(store, OPENROUTER, "rejected", 20);
        await usage(store, OPENROUTER, "check", 500);
        await usage(store, ANTHROPIC, "ok", 200);
        await usage(store, ANTHROPIC, "no_answer", 30);
        await usage(store, OPENROUTER, "cost_missing", 300);
        await usage(store, ANTHROPIC, "timed_out", 400);
        // The keyed replay's id, at zero cost: in no part.
        await usage(store, "replay", "ok", 0);
        const { spend } = await admin.extraction.status({ generation: 1 });
        expect(spend.todayBasis).toEqual({ reported: 620, price_list: 230, assumed: 700 });
        const parts = spend.todayBasis.reported + spend.todayBasis.price_list + spend.todayBasis.assumed;
        expect(spend.today.microUsd).toBe(1550);
        expect(parts).toBe(spend.today.microUsd);
        // The pipeline's budget compares the same sum.
        expect(await store.pipeline.spentSince(today())).toBe(parts);
      } finally {
        await admin.close();
      }
    });

    await withWorkWorld(async (w) => {
      const admin = createAdmin({ url: w.db.urls.admin, keys: w.db.keys, log: recordingLogger().log });
      try {
        const reasoner = await w.reasoner(["own"]);
        const run = await takenRun(w, reasoner);
        await modelCall(w, run, 0, OPENROUTER, 100);
        await modelCall(w, run, 1, ANTHROPIC, 200);
        await modelCall(w, run, 2, OPENROUTER, 300, "cost_missing");
        // A truncated call keeps its code and is read from its id.
        await modelCall(w, run, 3, ANTHROPIC, 50, "truncated");
        await modelCall(w, run, 4, "replay", 0);

        const status = await admin.work.status();
        expect(status.todayBasis).toEqual({ spent: { reported: 100, price_list: 250, assumed: 300 } });
        const sum = (split: Record<string, number>): number => Object.values(split).reduce((total, n) => total + n, 0);
        expect(sum(status.todayBasis.spent)).toBe(status.today.spentMicroUsd);
        // ledger.spend_on, which every append_step compares with the day's line, is the same sum.
        const { spent } = one(
          await w.admin<{ spent: string }>("select ledger.spend_on($1::date)::text as spent", [today()]),
        );
        expect(sum(status.todayBasis.spent)).toBe(Number(spent));
      } finally {
        await admin.close();
      }
    });
  });
});
