import { PassThrough, Writable } from "node:stream";
import type { ModelRequest, ModelResponse } from "@intelligence/contracts";
import { EXTRACT_GENERATION } from "@intelligence/personal-extract";
import { fakeDecideClient, fakeModelClient } from "@intelligence/personal-models/testing";
import { createPipeline } from "@intelligence/personal-store";
import { queryAs } from "@intelligence/personal-store/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunDeps } from "../command-types.ts";
import { run } from "../commands.ts";
import {
  addClient,
  builtOnce,
  comparable,
  type Env,
  events,
  evidenceOf,
  findFacts,
  gmailIds,
  MODEL_ID,
  pi,
  quiet,
  type Synced,
  statuses,
  sync,
  syncedWorld,
} from "../test-support/extract-fixtures.ts";

// `pi extract status`, `review` and `retry`, in process on the synthetic world, with the fake model
// client.

vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });

const made: Synced[] = [];
afterEach(async () => {
  for (const one of made.splice(0)) await one.drop();
});

// The world, synced and extracted once with the fake model. `calls` collects the evidence id of
// each live call of every later run made with `extract`.
// Built once for the file; each test gets a copy.
const extractedOnce = builtOnce(async (s) => {
  await addClient(s.db, "own-client", ["own"]);
  expect((await pi(["extract"], s.pipeline, { deps: { model: fakeModelClient(s.outputs) } })).exit).toBe(0);
});
async function extracted(): Promise<
  Synced & { calls: string[]; extract(env?: Env, deps?: RunDeps): Promise<{ exit: number; stderr: string }> }
> {
  const { s } = await extractedOnce();
  made.push(s);
  const calls: string[] = [];
  const extract = async (env: Env = {}, deps: RunDeps = {}) =>
    pi(["extract"], { ...s.pipeline, ...env }, { deps: { model: fakeModelClient(s.outputs, calls), ...deps } });
  return { ...s, calls, extract };
}

const messageIdOf = async (s: Synced, gmailId: string): Promise<string> => {
  const [row] = await queryAs<{ id: string }>(
    s.db.urls.admin,
    "select id from knowledge.messages where evidence_id = $1",
    [evidenceOf(s, gmailId)],
  );
  if (row === undefined) throw new Error("no such message");
  return row.id;
};

const status = async (s: Synced): Promise<Record<string, unknown>> => {
  const result = await pi(["extract", "status"], s.admin);
  expect(result.exit).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
};

const factsOf = async (s: Synced, gmailId: string): Promise<number> => {
  const token = await addClient(s.db, `reader-${Math.random().toString(36).slice(2, 8)}`, ["own", "employer:example"]);
  const messages = await gmailIds(s);
  return comparable((await findFacts(s.db, token)).facts, messages).filter((fact) => fact.gmailId === gmailId).length;
};

// A review through `run`, with the owner's answers given as each question is asked.
async function review(
  s: Synced,
  argv: string[],
  answer: (question: string) => string,
): Promise<{ exit: number; stdout: string; stderr: string; paused: boolean }> {
  const stdin = new PassThrough();
  let stderr = "";
  const err = new Writable({
    write(chunk: Buffer, _encoding, done) {
      stderr += chunk.toString("utf8");
      done();
    },
  });
  let stdout = "";
  const out = new Writable({
    write(chunk: Buffer, _encoding, done) {
      const text = chunk.toString("utf8");
      stdout += text;
      if (text.endsWith(": ") && /\((right|missed)/.test(text)) stdin.write(`${answer(text)}\n`);
      done();
    },
  });
  const exit = await run(["extract", "review", ...argv], s.admin, {
    stdout: out,
    stderr: err,
    stdin,
    stdoutIsTTY: true,
  });
  // Whether the review let go of its input: a terminal's input left flowing keeps the process up.
  const paused = stdin.isPaused();
  stdin.end();
  return { exit, stdout, stderr, paused };
}

describe("pi extract status", () => {
  it("jev-item-decisions: a run with Jev on raises no generation, so status counts nothing due after it, with or without PI_DECIDE_MODEL", async () => {
    const s = await extracted();
    const due = ((await status(s)) as { due: number }).due;
    // The decide model's recovery and record screens answer "no" by prompt.
    const neutral = {
      ...Object.fromEntries(
        Object.keys(s.outputs).map((id) => [id, { human_written: 0.9, special_category: 0.01, quarantine: 0.01 }]),
      ),
      jev_recovery: { account_recovery: 0.01 },
      jev_record: { quarantine: 0.01 },
    };
    expect(
      (await s.extract({ PI_DECIDE_MODEL: "typesafe/jev-1.13" }, { decideModel: fakeDecideClient(neutral) })).exit,
    ).toBe(0);
    expect(((await status(s)) as { due: number }).due).toBeLessThanOrEqual(due);
    const result = await pi(["extract", "status"], { ...s.admin, PI_DECIDE_MODEL: "typesafe/jev-1.13" });
    expect(result.exit).toBe(0);
    expect((JSON.parse(result.stdout) as { due: number }).due).toBe(((await status(s)) as { due: number }).due);
  });

  it("B9: with no active client, and then with two of different clearance, status shows every expected belief of the world once each", async () => {
    const s = await syncedWorld();
    made.push(s);
    const extract = () => pi(["extract"], s.pipeline, { deps: { model: fakeModelClient(s.outputs) } });
    const beliefs = s.w.expected.facts.both.filter(
      (fact) => fact.status !== undefined && fact.sharesBeliefWith === undefined,
    );
    const byKind: Record<string, number> = {};
    for (const fact of beliefs) byKind[fact.type] = (byKind[fact.type] ?? 0) + 1;
    // The world's disputed beliefs, by kind, as it plants them. Its two
    // titles for one person are two facts and two beliefs, and none of its beliefs is disputed.
    const disputedByKind: Record<string, number> = {};
    for (const fact of beliefs)
      if (fact.disputed === true) disputedByKind[fact.type] = (disputedByKind[fact.type] ?? 0) + 1;
    const expected = { total: beliefs.length, byKind, disputedByKind };
    expect((await extract()).exit).toBe(0);
    expect((await status(s)).beliefs).toMatchObject(expected);
    await addClient(s.db, "own-client", ["own"]);
    await addClient(s.db, "work-client", ["employer:example"]);
    expect((await extract()).exit).toBe(0);
    expect((await status(s)).beliefs).toMatchObject(expected);
  });

  it("status prints counts, ids and times, and no content", async () => {
    const s = await extracted();
    const result = await pi(["extract", "status"], s.admin);
    expect(result.exit).toBe(0);
    for (const needle of [...Object.values(s.w.canaries), ...s.w.owner.addresses]) {
      expect(result.stdout, needle).not.toContain(needle);
      expect(result.stderr, needle).not.toContain(needle);
    }
    const view = JSON.parse(result.stdout) as { items: unknown[]; claims: Record<string, number>; due: number };
    expect(view.items.length).toBeGreaterThan(0);
    expect(view.due).toBe(0);
    // The positive control: the canary claims are there, as counts.
    expect(Object.values(view.claims).reduce((sum, n) => sum + n, 0)).toBeGreaterThan(0);
  });

  it("status shows the withheld items with their codes, the last ten runs' codes and the day of the last answered call", async () => {
    const s = await extracted();
    let view = (await status(s)) as {
      withheld: { count: number; messages: { id: string; code: string }[] };
      runs: { code: string }[];
      lastAnswered: string | null;
    };
    expect(view.lastAnswered).toBeNull();
    const withheld = Object.entries(s.w.expected.items).filter(([, item]) => item.status === "withheld");
    expect(view.withheld.count).toBe(withheld.length);
    const ids = await Promise.all(
      withheld.map(async ([gmailId, item]) => ({ id: await messageIdOf(s, gmailId), code: item.code })),
    );
    expect(
      view.withheld.messages.map(({ id, code }) => ({ id, code })).sort((a, b) => a.id.localeCompare(b.id)),
    ).toEqual(ids.sort((a, b) => a.id.localeCompare(b.id)));

    // Eleven more runs: ten are listed, newest first. A budget of zero makes one of them `budget`
    // when anything is due; with nothing due each is `ok`.
    for (let n = 0; n < 11; n += 1) expect((await s.extract()).exit).toBe(0);
    const pipeline = createPipeline({ url: s.db.urls.pipeline, keys: s.db.keys, log: quiet });
    try {
      await pipeline.recordUsage({
        promptId: "personal_correspondence",
        promptVersion: "1",
        modelId: MODEL_ID,
        inputTokens: 1,
        outputTokens: 1,
        costMicroUsd: 10,
        outcome: "check",
      });
    } finally {
      await pipeline.close();
    }
    view = (await status(s)) as typeof view;
    expect(view.runs).toHaveLength(10);
    expect(view.runs.every((one) => one.code === "ok")).toBe(true);
    expect(view.lastAnswered).toBe(new Date().toISOString().slice(0, 10));
  });
});

describe("pi extract review", () => {
  it("a review of three items stores three items' verdicts, and status then shows them by type, generation and model", async () => {
    const s = await extracted();
    let item = 0;
    const result = await review(s, ["--sample", "3"], (question) => {
      if (question.includes("missed")) return item++ === 0 ? "missed" : "";
      return "right";
    });
    expect(result.exit).toBe(0);
    expect(result.stdout.endsWith(`${JSON.stringify({ reviewed: 3 })}\n`)).toBe(true);
    expect(result.paused).toBe(true);
    const stored = await queryAs<{ n: number }>(
      s.db.urls.admin,
      "select count(distinct evidence_id)::int as n from vault.extraction_reviews",
    );
    // Each item reviewed leaves a row, one with no claim and nothing missed included.
    expect(stored[0]?.n).toBe(3);
    const view = (await status(s)) as {
      reviews: { type: string; verdict: string; generation: number; model: string | null; count: number }[];
    };
    expect(view.reviews.length).toBeGreaterThan(0);
    for (const one of view.reviews) {
      expect(one.generation).toBe(EXTRACT_GENERATION);
      expect(one.model).toBe(MODEL_ID);
      expect(["right", "missed", "nothing"]).toContain(one.verdict);
    }
    expect(view.reviews.filter((one) => one.verdict === "missed").reduce((sum, one) => sum + one.count, 0)).toBe(1);
    // The claims judged are the claims shown.
    const shown = (result.stdout.match(/^claim \d+: /gm) ?? []).length;
    expect(view.reviews.filter((one) => one.verdict === "right").reduce((sum, one) => sum + one.count, 0)).toBe(shown);
  });

  it("an item with no claim and nothing missed is stored as reviewed, and is not sampled again", async () => {
    const s = await extracted();
    // The largest sample, larger than the world, so every done item is reviewed once.
    const first = await review(s, ["--sample", "500"], (question) => (question.includes("missed") ? "" : "right"));
    expect(first.exit, first.stderr).toBe(0);
    const reviewed = Number(/\{"reviewed":(\d+)\}\n$/.exec(first.stdout)?.[1] ?? -1);
    expect(reviewed).toBeGreaterThan(0);
    const [stored] = await queryAs<{ n: number }>(
      s.db.urls.admin,
      "select count(distinct evidence_id)::int as n from vault.extraction_reviews",
    );
    expect(stored?.n).toBe(reviewed);
    const view = (await status(s)) as { reviews: { type: string; verdict: string; count: number }[] };
    // The positive control: the sample held items with no claim.
    expect(
      view.reviews.filter((one) => one.verdict === "nothing").reduce((sum, one) => sum + one.count, 0),
    ).toBeGreaterThan(0);
    const again = await review(s, ["--sample", "500"], (question) => (question.includes("missed") ? "" : "right"));
    expect(again.stdout.endsWith(`${JSON.stringify({ reviewed: 0 })}\n`)).toBe(true);
  });

  it("review with a type samples only items that hold a claim of it", async () => {
    const s = await extracted();
    const result = await review(s, ["--type", "plan", "--sample", "50"], (question) =>
      question.includes("missed") ? "" : "right",
    );
    expect(result.exit, result.stderr).toBe(0);
    const items = result.stdout.split(/^item \d+ of \d+: /m).slice(1);
    const [plans] = await queryAs<{ n: number }>(
      s.db.urls.admin,
      "select count(distinct evidence_id)::int as n from knowledge.claims where type = 'plan'",
    );
    expect(plans?.n).toBeGreaterThan(0);
    expect(items).toHaveLength(plans?.n ?? -1);
    for (const one of items) expect(one).toMatch(/^claim \d+: plan /m);
  });
});

describe("pi extract retry", () => {
  it("retry with a lane sends the item through that lane on the next run", async () => {
    const s = await extracted();
    const gmailId = s.w.handles.planMessageId;
    const evidence = evidenceOf(s, gmailId);
    expect((await statuses(s.db)).get(evidence)?.lane).toBe("correspondence");
    const retried = await pi(
      ["extract", "retry", "--message", await messageIdOf(s, gmailId), "--lane", "transaction"],
      s.admin,
    );
    expect(retried).toEqual({ exit: 0, stdout: `${JSON.stringify({ selected: 1 })}\n`, stderr: "" });
    expect((await s.extract()).exit).toBe(0);
    // Its saved call was set aside, so it was asked again, under the lane the owner chose.
    expect(s.calls).toEqual([evidence]);
    expect((await statuses(s.db)).get(evidence)?.lane).toBe("transaction");
    const [call] = await queryAs<{ prompt_id: string }>(
      s.db.urls.admin,
      "select prompt_id from vault.model_calls where evidence_id = $1 and superseded_at is null",
      [evidence],
    );
    expect(call?.prompt_id).toBe("personal_transaction");
  });

  it("retry into the skip lane removes the item's facts at the next run, and not before", async () => {
    const s = await extracted();
    const gmailId = s.w.handles.receiptCanaryMessageId;
    expect(await factsOf(s, gmailId)).toBe(1);
    expect(
      (await pi(["extract", "retry", "--message", await messageIdOf(s, gmailId), "--lane", "skip"], s.admin)).exit,
    ).toBe(0);
    // Not before: the retry removes no claim itself.
    expect(await factsOf(s, gmailId)).toBe(1);
    expect((await s.extract()).exit).toBe(0);
    expect(await factsOf(s, gmailId)).toBe(0);
    expect((await statuses(s.db)).get(evidenceOf(s, gmailId))?.status).toBe("skipped");
    expect(s.calls).toEqual([]);
  });

  it("retry after a model change asks the new model, and one model's saved answer is never replayed as another's", async () => {
    const s = await extracted();
    const second = { PI_EXTRACT_MODEL: "example/second-model" };
    // With nothing due a new model asks nothing.
    expect((await s.extract(second)).exit).toBe(0);
    expect(s.calls).toEqual([]);

    // A retried item is asked again, of the new model, its first answer set aside. A released one
    // is due again too, and its saved answer is keyed by the model that gave it: the new model is
    // asked, and both answers are kept.
    const asked = s.w.handles.commitmentInboundMessageId;
    const replayed = s.w.handles.quarantineMessageId;
    expect((await pi(["extract", "retry", "--message", await messageIdOf(s, asked)], s.admin)).exit).toBe(0);
    expect(
      (await pi(["extract", "retry", "--message", await messageIdOf(s, replayed), "--override"], s.admin)).exit,
    ).toBe(0);
    expect((await s.extract(second)).exit).toBe(0);
    expect([...s.calls].sort()).toEqual([evidenceOf(s, asked), evidenceOf(s, replayed)].sort());
    const models = await queryAs<{ evidence_id: string; model_id: string; live: boolean }>(
      s.db.urls.admin,
      "select evidence_id, model_id, superseded_at is null as live from vault.model_calls where evidence_id = any ($1)",
      [[evidenceOf(s, asked), evidenceOf(s, replayed)]],
    );
    const of = (evidence: string) =>
      models
        .filter((row) => row.evidence_id === evidence)
        .map((row) => `${row.model_id} ${row.live ? "live" : "set aside"}`)
        .sort();
    expect(of(evidenceOf(s, asked))).toEqual([`${MODEL_ID} set aside`, "example/second-model live"].sort());
    expect(of(evidenceOf(s, replayed))).toEqual([`${MODEL_ID} live`, "example/second-model live"].sort());
  });

  it("retry --all or --status over fifty items changes nothing without --yes, and prints its count", async () => {
    const s = await extracted();
    const before = await queryAs(
      s.db.urls.admin,
      "select evidence_id, waiting, xmin::text as version from vault.pipeline_items order by 1",
    );
    const calls = await queryAs(s.db.urls.admin, "select id from vault.model_calls order by 1");
    expect(before.length).toBeGreaterThan(50);
    const done = [...(await statuses(s.db)).values()].filter((one) => one.status === "done").length;
    for (const [argv, selected] of [
      [["--all"], before.length],
      [["--status", "done"], done],
    ] as const) {
      if (selected <= 50) continue;
      const result = await pi(["extract", "retry", ...argv], s.admin);
      expect(result, argv.join(" ")).toEqual({
        exit: 1,
        stdout: `${JSON.stringify({ selected })}\n`,
        stderr: `${JSON.stringify({ event: "command_failed", code: "confirm_needed" })}\nadd --yes to set aside ${selected} saved answers; each costs one live call\n`,
      });
    }
    expect(
      await queryAs(
        s.db.urls.admin,
        "select evidence_id, waiting, xmin::text as version from vault.pipeline_items order by 1",
      ),
    ).toEqual(before);
    expect(await queryAs(s.db.urls.admin, "select id from vault.model_calls order by 1")).toEqual(calls);

    // With --yes it goes ahead.
    const confirmed = await pi(["extract", "retry", "--all", "--yes"], s.admin);
    expect(confirmed).toEqual({ exit: 0, stdout: `${JSON.stringify({ selected: before.length })}\n`, stderr: "" });
    expect(await queryAs(s.db.urls.admin, "select id from vault.model_calls where superseded_at is null")).toEqual([]);
    expect(await queryAs(s.db.urls.admin, "select id from vault.model_calls order by 1")).toEqual(calls);
  });

  it("an overridden item is processed once with its narrowing ignored, and a new revision is screened afresh", async () => {
    const s = await extracted();
    const gmailId = s.w.handles.quarantineMessageId;
    const id = await messageIdOf(s, gmailId);
    const listed = (await status(s)) as { withheld: { messages: { id: string; code: string }[] } };
    expect(listed.withheld.messages).toContainEqual(expect.objectContaining({ id, code: "quarantine" }));
    expect(await pi(["extract", "retry", "--message", id, "--override"], s.admin)).toEqual({
      exit: 0,
      stdout: `${JSON.stringify({ released: 1 })}\n`,
      stderr: "",
    });

    // The next run sends no request: the saved answer is replayed, its narrowing ignored.
    expect((await s.extract()).exit).toBe(0);
    expect(s.calls).toEqual([]);
    expect((await statuses(s.db)).get(evidenceOf(s, gmailId))?.status).toBe("done");
    expect(await factsOf(s, gmailId)).toBe(1);

    // The same message stored again, as a new revision: it is screened afresh, and withheld again.
    const source = s.sources.find((one) => one.label === "personal");
    const message = s.w.accounts.find((one) => one.label === "personal")?.messages.find((one) => one.id === gmailId);
    source?.gmail.relabel(gmailId, [...(message?.labelIds ?? []), "SENT"]);
    await sync(s.db, s.w, s.now, s.sources);
    expect(
      (
        await s.extract(
          {},
          {
            model: fakeModelClient(
              { ...s.outputs, [evidenceOf(s, gmailId, 1)]: s.outputs[evidenceOf(s, gmailId)] },
              s.calls,
            ),
          },
        )
      ).exit,
    ).toBe(0);
    expect(s.calls).toEqual([evidenceOf(s, gmailId, 1)]);
    expect((await statuses(s.db)).get(evidenceOf(s, gmailId, 1))?.status).toBe("withheld");
    expect(await factsOf(s, gmailId)).toBe(0);
  });

  it("retry --override for a message that is not withheld is not_found", async () => {
    const s = await extracted();
    const done = await messageIdOf(s, s.w.handles.receiptCanaryMessageId);
    const result = await pi(["extract", "retry", "--message", done, "--override"], s.admin);
    expect(result).toMatchObject({ exit: 1, stdout: "" });
    expect(events(result.stderr).at(-1)).toEqual({ event: "command_failed", code: "not_found" });
    // An id that names no message is not_found too.
    const unknown = await pi(["extract", "retry", "--message", `msg_${"0".repeat(25)}9`], s.admin);
    expect(events(unknown.stderr).at(-1)).toEqual({ event: "command_failed", code: "not_found" });
  });

  it("retry during a run prints extract_running and exits 1", async () => {
    const s = await extracted();
    const gmailId = s.w.handles.planMessageId;
    const id = await messageIdOf(s, gmailId);
    expect((await pi(["extract", "retry", "--message", id], s.admin)).exit).toBe(0);
    // A run whose one call waits until the retry has been tried.
    let entered: () => void = () => {};
    const inside = new Promise<void>((resolve) => (entered = resolve));
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    const fake = fakeModelClient(s.outputs);
    const waiting = {
      async complete(request: ModelRequest): Promise<ModelResponse> {
        entered();
        await released;
        return fake.complete(request);
      },
      embed: fake.embed,
    };
    const running = s.extract({}, { model: waiting });
    await inside;
    const refused = await pi(["extract", "retry", "--message", id], s.admin);
    expect(refused).toMatchObject({ exit: 1, stdout: "" });
    expect(events(refused.stderr)[0]).toEqual({ event: "command_failed", code: "extract_running" });
    release();
    expect((await running).exit).toBe(0);
    // The positive control: once the run has ended the retry goes ahead.
    expect((await pi(["extract", "retry", "--message", id], s.admin)).exit).toBe(0);
  });
});
