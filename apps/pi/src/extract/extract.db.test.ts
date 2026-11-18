import type { ModelRequest, ModelResponse } from "@intelligence/contracts";
import type { ErasureJournalEntry } from "@intelligence/contracts/personal";
import { EXTRACT_GENERATION } from "@intelligence/personal-extract";
import { fakeDecideClient, fakeKeyEndpoint, fakeModelClient } from "@intelligence/personal-models/testing";
import { appendJournal, createAdmin, createPipeline, journalPath } from "@intelligence/personal-store";
import { queryAs } from "@intelligence/personal-store/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addClient,
  answer,
  builtOnce,
  comparable,
  EMPTY_OUTPUT,
  events,
  evidenceOf,
  expectedFacts,
  fakeOpenRouter,
  findFacts,
  gmailIds,
  MODEL_ID,
  pi,
  quiet,
  SENTINEL_KEY,
  type Synced,
  statuses,
  syncedWorld,
  withAdmin,
} from "../test-support/extract-fixtures.ts";

// `pi extract` and `pi extract check`, in-process on the synthetic world, with the fake model client or a fake
// OpenRouter behind the real client. No test calls OpenRouter.

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const made: Synced[] = [];
afterEach(async () => {
  for (const one of made.splice(0)) await one.drop();
});
const world = async (options?: Parameters<typeof syncedWorld>[0]): Promise<Synced> => {
  const s = await syncedWorld(options);
  made.push(s);
  return s;
};

const runLine = (stderr: string) => events(stderr).find((event) => event.event === "extract_run");
const runs = (s: Synced) =>
  queryAs<{ code: string }>(s.db.urls.admin, "select code from vault.extraction_runs order by seq");
const usage = (s: Synced) =>
  queryAs<{ model_id: string; outcome: string }>(
    s.db.urls.admin,
    "select model_id, outcome from vault.model_usage order by id",
  );
const RETENTION = { data_collection: "deny", require_parameters: true };

describe("pi extract", () => {
  it("extract runs the world and ends with its expected facts", async () => {
    const s = await world();
    // Clients registered first: a belief is built for the audience of each active client.
    const own = await addClient(s.db, "own-client", ["own"]);
    const both = await addClient(s.db, "both-client", ["own", "employer:example"]);
    const calls: string[] = [];
    const result = await pi(["extract"], s.pipeline, { deps: { model: fakeModelClient(s.outputs, calls) } });
    expect(result.exit).toBe(0);
    expect(result.stdout).toBe("");
    expect(runLine(result.stderr)?.code).toBe("ok");

    const rows = await statuses(s.db);
    for (const [gmailId, expected] of Object.entries(s.w.expected.items)) {
      const got = rows.get(evidenceOf(s, gmailId));
      expect([gmailId, got?.status, got?.code]).toEqual([gmailId, expected.status, expected.code]);
    }
    const messages = await gmailIds(s);
    expect(comparable((await findFacts(s.db, own)).facts, messages)).toEqual(expectedFacts(s.w, "own"));
    expect(comparable((await findFacts(s.db, both)).facts, messages)).toEqual(expectedFacts(s.w, "both"));
    // The held message made no call.
    expect(calls).not.toContain(evidenceOf(s, s.w.handles.heldMessageId));
  });

  it("a second extract at once is already_running and exits 0", async () => {
    const s = await world();
    // The first run's first model call waits until the second run has ended.
    let entered: () => void = () => {};
    const inside = new Promise<void>((resolve) => (entered = resolve));
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    const fake = fakeModelClient(s.outputs);
    let first = true;
    const waiting = {
      async complete(request: ModelRequest): Promise<ModelResponse> {
        if (first) {
          first = false;
          entered();
          await released;
        }
        return fake.complete(request);
      },
      embed: fake.embed,
    };
    const running = pi(["extract"], s.pipeline, { deps: { model: waiting } });
    await inside;
    const second = await pi(["extract"], s.pipeline, { deps: { model: fakeModelClient(s.outputs) } });
    // Compared as events: the logger, not the test, orders a line's fields.
    // The lock is asked before the spend cap, so the second run
    // reads no cap, and says `busy` on stdout for the wake and the timer.
    expect({ exit: second.exit, stdout: second.stdout }).toEqual({ exit: 0, stdout: "busy\n" });
    expect(events(second.stderr)).toEqual([{ event: "already_running" }]);
    release();
    expect((await running).exit).toBe(0);
    // The second start left no run row.
    expect(await runs(s)).toEqual([{ code: "ok" }]);
  });

  it("the day's budget, already spent, stops the run before any call and exits 0", async () => {
    const s = await world();
    // Spend written by hand, as earlier runs of the day would have written it.
    const pipeline = createPipeline({ url: s.db.urls.pipeline, keys: s.db.keys, log: quiet });
    try {
      await pipeline.recordUsage({
        promptId: "personal_correspondence",
        promptVersion: "1",
        modelId: MODEL_ID,
        inputTokens: 1,
        outputTokens: 1,
        costMicroUsd: 3_000_000,
        outcome: "ok",
      });
    } finally {
      await pipeline.close();
    }
    const calls: string[] = [];
    const result = await pi(["extract"], s.pipeline, { deps: { model: fakeModelClient(s.outputs, calls) } });
    expect(result.exit).toBe(0);
    expect(runLine(result.stderr)?.code).toBe("budget");
    // The stop code on stdout, which the timer records in ledger.job_runs: exit 0 alone reads as `ok`.
    expect(result.stdout).toBe("budget\n");
    expect(calls).toEqual([]);
    // Nothing was asked: only items the triage skips have a row.
    expect([...(await statuses(s.db)).values()].every((one) => one.status === "skipped")).toBe(true);
    expect(await runs(s)).toEqual([{ code: "budget" }]);

    // The positive control: a day budget above what was spent lets the run call.
    const again = await pi(
      ["extract"],
      { ...s.pipeline, PI_EXTRACT_DAY_USD: "4" },
      { deps: { model: fakeModelClient(s.outputs, calls) } },
    );
    expect(runLine(again.stderr)?.code).toBe("ok");
    expect(again.stdout).toBe("");
    expect(calls.length).toBeGreaterThan(0);
  });

  it("a refused model answer exits 1 and leaves the items waiting", async () => {
    const s = await world();
    // A key at its spend limit answers 402.
    // Its message is words no line of pi's holds: the spend_cap line names its limit counts.
    const openrouter = fakeOpenRouter(() => ({
      status: 402,
      body: { error: { code: 402, message: "vendor words: key over its limit" } },
    }));
    const result = await pi(["extract"], s.pipeline, { deps: { modelFetch: openrouter.fetch } });
    expect(result.exit).toBe(1);
    expect(runLine(result.stderr)).toMatchObject({ code: "model_refused", status: "http_402" });
    // The status is a fixed code, never anything of the body.
    expect(events(result.stderr).at(-1)).toEqual({
      event: "command_failed",
      code: "model_refused",
      status: "http_402",
    });
    expect(result.stderr).not.toContain("vendor words");
    // One request, not retried; the item in hand and every later one untouched.
    expect(openrouter.bodies).toHaveLength(1);
    expect([...(await statuses(s.db)).values()].every((one) => one.status === "skipped")).toBe(true);
    expect(await runs(s)).toEqual([{ code: "model_refused" }]);
  });

  it("a refusal about one item ends it failed and the run goes on; the fifth ends the run", async () => {
    const s = await world();
    const openrouter = fakeOpenRouter(() => ({
      status: 400,
      body: { error: { code: 400, message: "synthetic detail" } },
    }));
    const result = await pi(["extract"], s.pipeline, { deps: { modelFetch: openrouter.fetch } });
    expect(result.exit).toBe(1);
    expect(runLine(result.stderr)).toMatchObject({ code: "model_refused", status: "http_400" });
    expect(events(result.stderr).at(-1)).toEqual({
      event: "command_failed",
      code: "model_refused",
      status: "http_400",
    });
    expect(result.stderr).not.toContain("synthetic detail");
    // Five requests, each about its own item, each item failed with no saved call.
    expect(openrouter.bodies).toHaveLength(5);
    const failed = [...(await statuses(s.db)).values()].filter((one) => one.status !== "skipped");
    expect(failed).toHaveLength(5);
    for (const one of failed) expect(one).toMatchObject({ status: "failed", code: "model_refused_item" });
    expect(await queryAs(s.db.urls.admin, "select count(*)::int as n from vault.model_calls")).toEqual([{ n: 0 }]);
    expect(await runs(s)).toEqual([{ code: "model_refused" }]);
  });

  it("an answer with no cost finishes its item, stops the run and exits 1", async () => {
    const s = await world();
    const openrouter = fakeOpenRouter(() => answer(EMPTY_OUTPUT, { cost: null }));
    const result = await pi(["extract"], s.pipeline, { deps: { modelFetch: openrouter.fetch } });
    expect(result.exit).toBe(1);
    expect(runLine(result.stderr)?.code).toBe("cost_missing");
    // The answer was paid for, so its item is done; the run sent nothing after it.
    expect(openrouter.bodies).toHaveLength(1);
    expect(
      [...(await statuses(s.db)).values()].filter((one) => one.status !== "skipped").map((one) => one.status),
    ).toEqual(["done"]);
    expect(await usage(s)).toEqual([{ model_id: MODEL_ID, outcome: "cost_missing" }]);
  });

  it("every request carries the two retention fields", async () => {
    const s = await world();
    // An answer that names another model: the usage rows still carry the configured id.
    const openrouter = fakeOpenRouter(() => {
      const reply = answer(EMPTY_OUTPUT);
      return { body: { ...(reply.body as object), model: "other/vendor-model" } };
    });
    const result = await pi(["extract", "--max-calls", "3"], s.pipeline, { deps: { modelFetch: openrouter.fetch } });
    expect(result.exit).toBe(0);
    expect(runLine(result.stderr)?.code).toBe("budget");
    expect(openrouter.bodies).toHaveLength(3);
    for (const body of openrouter.bodies) {
      expect(body.provider).toEqual(RETENTION);
      expect(body.model).toBe(MODEL_ID);
      expect(body.tools).toBeUndefined();
    }
    expect(await usage(s)).toEqual([
      { model_id: MODEL_ID, outcome: "ok" },
      { model_id: MODEL_ID, outcome: "ok" },
      { model_id: MODEL_ID, outcome: "ok" },
    ]);
  });

  it("each run leaves one run row with its code, and a run that stops on its budget leaves one too", async () => {
    const s = await world();
    const stopped = await pi(
      ["extract"],
      { ...s.pipeline, PI_EXTRACT_RUN_USD: "0" },
      { deps: { model: fakeModelClient(s.outputs) } },
    );
    expect(stopped.exit).toBe(0);
    expect(await runs(s)).toEqual([{ code: "budget" }]);
    const ran = await pi(["extract"], s.pipeline, { deps: { model: fakeModelClient(s.outputs) } });
    expect(ran.exit).toBe(0);
    expect(await runs(s)).toEqual([{ code: "budget" }, { code: "ok" }]);
  });

  it("with no key stored extract exits 1 with no_model_key and makes no call", async () => {
    const s = await world({ key: false });
    const calls: string[] = [];
    const result = await pi(["extract"], s.pipeline, { deps: { model: fakeModelClient(s.outputs, calls) } });
    expect(result).toMatchObject({ exit: 1, stdout: "" });
    expect(events(result.stderr).at(-1)).toEqual({ event: "command_failed", code: "no_model_key" });
    expect(result.stderr.endsWith("store the OpenRouter key with pi models set-key (pia on the box)\n")).toBe(true);
    expect(calls).toEqual([]);
    expect(await runs(s)).toEqual([]);
  });

  it("no log line holds a merchant, a name or an address", async () => {
    const s = await world();
    const result = await pi(["extract"], s.pipeline, { deps: { model: fakeModelClient(s.outputs) } });
    expect(result.exit).toBe(0);
    const needles = [...Object.values(s.w.canaries), ...s.w.owner.addresses, s.w.owner.name];
    for (const needle of needles) expect(result.stderr, needle).not.toContain(needle);
    // Every line is an event of ids, counts and codes.
    for (const event of events(result.stderr))
      expect(Object.keys(event).every((key) => ["event", "code", "ids", "counts", "durationMs"].includes(key))).toBe(
        true,
      );
    // The positive control: the failed items have their lines, by evidence id.
    expect(events(result.stderr).some((event) => event.event === "extract_item_failed")).toBe(true);
  });
});

// The receipt the check sends, answered as a good model would.
const CHECK_TEXT = "Thank you for your order CL-5520 at Cedar Lamps. Total charged: 31.75 USD on 2026-03-02.";
const GOOD_CHECK = {
  claims: [
    {
      type: "transaction.receipt",
      subject: { key: { kind: "address", value: "owner@birch.example" }, observedAt: "2026-03-02T09:00:00.000Z" },
      fields: { merchant: "Cedar Lamps", amount: 31.75, currency: "USD", date: "2026-03-02", order_ref: "CL-5520" },
      statementKind: "stated_fact",
      basis: "third_party",
      span: `chars:0-${CHECK_TEXT.length}`,
    },
  ],
  narrowing: "none",
};
// Every check's output opens with its spend-cap line, here the harness's key endpoint's.
const lines = (checks: Record<string, string>): string =>
  `spend_cap: ok limit_micro_usd=5000000 remaining_micro_usd=5000000\n${Object.entries(checks)
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n")}\n`;

// FE5: the daily ageing, as the box's timer runs it.
describe("pi extract age", () => {
  const DAY_MS = 86_400_000;
  const byStatus = async (s: Synced): Promise<Record<string, number>> =>
    (JSON.parse((await pi(["extract", "status"], s.admin)).stdout) as { beliefs: { byStatus: Record<string, number> } })
      .beliefs.byStatus;
  // The world with a client, extracted once for the describe; each test gets a copy (builtOnce).
  const extractedOnce = builtOnce(async (s) => {
    await addClient(s.db, "own-client", ["own"]);
    expect((await pi(["extract"], s.pipeline, { deps: { model: fakeModelClient(s.outputs) } })).exit).toBe(0);
  });
  const extracted = async (): Promise<Synced> => {
    const { s } = await extractedOnce();
    made.push(s);
    return s;
  };

  // The beliefs by status as an owner's read made `at` computes them.
  const byStatusAt = async (s: Synced, at: Date): Promise<Record<string, number>> => {
    const admin = createAdmin({ url: s.db.urls.admin, keys: s.db.keys, log: quiet, now: () => at });
    try {
      return (await admin.extraction.status({ generation: EXTRACT_GENERATION })).beliefs.byStatus;
    } finally {
      await admin.close();
    }
  };

  // A status is computed at read: time alone moves it, as a read 400 days on
  // shows, and age rebuilds nothing.
  it("age changes a belief's status by time alone, makes no model call and reads no key", async () => {
    const s = await extracted();
    const before = await byStatus(s);
    expect(before.active).toBeGreaterThan(0);
    // No key stored and no model set: age needs neither.
    await withAdmin(s.db, (admin) => admin.secrets.deleteSecret("openrouter/key"));
    const { PI_EXTRACT_MODEL: _model, ...env } = s.pipeline;
    const calls: string[] = [];
    const aged = await pi(["extract", "age"], env, {
      deps: { model: fakeModelClient(s.outputs, calls), now: () => new Date(s.now.getTime() + 400 * DAY_MS) },
    });
    expect({ exit: aged.exit, stdout: aged.stdout }).toEqual({ exit: 0, stdout: "" });
    expect(events(aged.stderr).at(-1)).toMatchObject({ event: "extract_age", code: "ok" });
    expect(calls).toEqual([]);
    // Read now, nothing moved; read 400 days on, fewer are active, and none is lost.
    expect(await byStatus(s)).toEqual(before);
    const after = await byStatusAt(s, new Date(s.now.getTime() + 400 * DAY_MS));
    expect(after.active ?? 0).toBeLessThan(before.active ?? 0);
    expect(Object.values(after).reduce((a, b) => a + b, 0)).toBe(Object.values(before).reduce((a, b) => a + b, 0));
    // A run's row of its own: code ok, zero items.
    const [row] = await queryAs<Record<string, unknown>>(
      s.db.urls.admin,
      "select code, done, skipped, withheld, failed, waiting, live_calls from vault.extraction_runs order by seq desc limit 1",
    );
    expect(row).toEqual({ code: "ok", done: 0, skipped: 0, withheld: 0, failed: 0, waiting: 0, live_calls: 0 });
  });

  it("age, extract and extract check refuse with erasure_replay_needed while the journal is ahead, and write no run", async () => {
    const s = await extracted();
    const [account] = await queryAs<{ id: string }>(
      s.db.urls.admin,
      "select id from vault.source_accounts order by id limit 1",
    );
    await appendJournal(journalPath(s.pipeline.PI_KEY_FILE ?? ""), {
      seq: 1,
      erasure: "ers_01JABCDEFGHJKMNPQRSTVWXYZ0",
      kind: "item",
      items: [{ account: account?.id ?? "", fp: "a".repeat(64) }],
      suppress: [],
    } as unknown as ErasureJournalEntry);
    const before = await runs(s);
    for (const argv of [["extract", "age"], ["extract"], ["extract", "check"]]) {
      const calls: string[] = [];
      const refused = await pi(argv, s.pipeline, { deps: { model: fakeModelClient(s.outputs, calls) } });
      expect({ argv, exit: refused.exit, stdout: refused.stdout }).toEqual({ argv, exit: 1, stdout: "" });
      expect(events(refused.stderr).at(-1)).toEqual({ event: "command_failed", code: "erasure_replay_needed" });
      expect(calls).toEqual([]);
    }
    expect(await runs(s)).toEqual(before);
  });
});

describe("pi extract check", () => {
  it("check passes on a good answer and fails, line by line, on a rejected output, a missing cost, a cut-off answer and a refused request, and writes its usage row", async () => {
    const s = await world();
    const check = async (reply: Parameters<typeof fakeOpenRouter>[0]) => {
      const openrouter = fakeOpenRouter(reply);
      const result = await pi(["extract", "check"], s.pipeline, { deps: { modelFetch: openrouter.fetch } });
      for (const body of openrouter.bodies) expect(body.provider).toEqual(RETENTION);
      return result;
    };

    const good = await check(() => answer(GOOD_CHECK));
    expect(good).toEqual({
      exit: 0,
      stdout: lines({ accepted: "ok", finish_stop: "ok", schema: "ok", receipt: "ok", cost: "ok" }),
      stderr: "",
    });

    const rejected = await check(() => answer("not a json object"));
    expect(rejected.exit).toBe(1);
    expect(rejected.stdout).toBe(
      lines({ accepted: "ok", finish_stop: "ok", schema: "failed", receipt: "failed", cost: "ok" }),
    );
    expect(events(rejected.stderr).at(-1)).toEqual({ event: "command_failed", code: "check_failed" });

    const costless = await check(() => answer(GOOD_CHECK, { cost: null }));
    expect(costless.stdout).toBe(
      lines({ accepted: "ok", finish_stop: "ok", schema: "ok", receipt: "ok", cost: "failed" }),
    );

    const cut = await check(() => answer('{"claims": [', { finish: "length" }));
    expect(cut.stdout).toBe(
      lines({ accepted: "ok", finish_stop: "failed", schema: "failed", receipt: "failed", cost: "ok" }),
    );

    // A good output that ended with a tool call, or with any reason but stop, did not finish with stop.
    const tool = await check(() => answer(GOOD_CHECK, { finish: "tool_calls" }));
    expect(tool.stdout).toBe(
      lines({ accepted: "ok", finish_stop: "failed", schema: "failed", receipt: "failed", cost: "ok" }),
    );
    const other = await check(() => answer(GOOD_CHECK, { finish: "end_turn" }));
    expect(other.exit).toBe(1);
    expect(other.stdout).toBe(
      lines({ accepted: "ok", finish_stop: "failed", schema: "ok", receipt: "ok", cost: "ok" }),
    );

    // An answer of the example's values, not the message's, is not the expected receipt.
    const copied = await check(() =>
      answer({
        ...GOOD_CHECK,
        claims: [
          {
            ...GOOD_CHECK.claims[0],
            fields: { merchant: "Alder Books", amount: 24.5, currency: "USD", date: "2026-03-02" },
          },
        ],
      }),
    );
    expect(copied.stdout).toBe(
      lines({ accepted: "ok", finish_stop: "ok", schema: "ok", receipt: "failed", cost: "ok" }),
    );

    // A refused request names its status on the accepted line, and nothing of the body.
    const refused = await check(() => ({ status: 401, body: { error: { code: 401, message: "synthetic detail" } } }));
    expect(refused.exit).toBe(1);
    expect(refused.stdout).toBe(
      lines({
        accepted: "failed http_401",
        finish_stop: "not_checked",
        schema: "not_checked",
        receipt: "not_checked",
        cost: "not_checked",
      }),
    );

    // One usage row for each answered check, with the outcome `check`; none for the refused one.
    // It reads and writes no evidence.
    expect(await usage(s)).toEqual(Array.from({ length: 7 }, () => ({ model_id: MODEL_ID, outcome: "check" })));
    expect(await statuses(s.db)).toEqual(new Map());
    expect(await queryAs(s.db.urls.admin, "select count(*)::int as n from vault.model_calls")).toEqual([{ n: 0 }]);
  });
});

// HO5: the key's spend cap, read before the first model call. The harness answers a 5-dollar limit;
// these tests give the key endpoint their own answer.
describe("pi extract's spend cap", () => {
  type KeyAnswer = Parameters<typeof fakeKeyEndpoint>[0];
  const extract = async (s: Synced, answered: KeyAnswer | typeof fetch, env: Record<string, string> = {}) => {
    const calls: string[] = [];
    const keyFetch = typeof answered === "function" ? answered : fakeKeyEndpoint(answered).fetch;
    const result = await pi(
      ["extract"],
      { ...s.pipeline, ...env },
      { deps: { model: fakeModelClient(s.outputs, calls), keyFetch } },
    );
    return { result, calls };
  };
  const refusedWith = async (
    s: Synced,
    answered: KeyAnswer | typeof fetch,
    code: string,
    env: Record<string, string> = {},
  ) => {
    const { result, calls } = await extract(s, answered, env);
    expect(result.exit, code).toBe(1);
    expect(result.stdout).toBe("");
    expect(calls, code).toEqual([]);
    const logged = events(result.stderr);
    expect(logged.map((line) => [line.event, line.code])).toEqual([
      ["spend_cap", code],
      ["command_failed", code],
    ]);
  };
  const okWith = async (s: Synced, answered: KeyAnswer, env: Record<string, string> = {}) => {
    const { result, calls } = await extract(s, answered, env);
    expect(result.exit).toBe(0);
    expect(events(result.stderr)[0]).toMatchObject({ event: "spend_cap", code: "ok" });
    expect(calls.length).toBeGreaterThan(0);
  };

  it("an extract run with a key that has no limit makes no model call and exits 1 with spend_cap_missing, and so for each refusal; a key under its ceiling is the positive control", async () => {
    const s = await world();
    await refusedWith(s, { limit: null }, "spend_cap_missing");
    await refusedWith(s, { limit: 21 }, "spend_cap_too_high");
    await refusedWith(s, { limit: 10, remaining: 0 }, "spend_cap_reached");
    await refusedWith(s, { limit: 10, remaining: null }, "spend_cap_unknown");
    // No run was started: no run row, no usage, no item touched.
    expect(await runs(s)).toEqual([]);
    expect(await usage(s)).toEqual([]);
    await okWith(s, { limit: 20, remaining: 3, reset: "monthly" });
    expect(await runs(s)).toEqual([{ code: "ok" }]);
  });

  it("the refusal's line holds the code and the two counts", async () => {
    const s = await world();
    const { result } = await extract(s, { limit: 30, remaining: 12.5 });
    expect(events(result.stderr)[0]).toEqual({
      event: "spend_cap",
      code: "spend_cap_too_high",
      counts: { limit_micro_usd: 30_000_000, remaining_micro_usd: 12_500_000 },
    });
  });

  it("a 4-dollar daily limit is refused spend_cap_too_high under a 20-dollar ceiling, and a 9-dollar weekly one too", async () => {
    const s = await world();
    await refusedWith(s, { limit: 4, reset: "daily" }, "spend_cap_too_high");
    await refusedWith(s, { limit: 9, reset: "weekly" }, "spend_cap_too_high");
    // The positive control: 31 days of 0.5 dollars is under 20.
    await okWith(s, { limit: 0.5, reset: "daily" });
  });

  it("a key endpoint that times out, answers 500 or answers text that does not parse is spend_cap_unknown and no model call is made", async () => {
    const s = await world();
    const timedOut = (async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }) as unknown as typeof fetch;
    // A 500 is retried as the client retries, here with no wait.
    const outage = (async () =>
      new Response("", { status: 500, headers: { "retry-after": "0" } })) as unknown as typeof fetch;
    const text = (async () => new Response("<html>not json</html>", { status: 200 })) as unknown as typeof fetch;
    const absentReset = (async () =>
      new Response(JSON.stringify({ data: { limit: 5, limit_remaining: 5 } }), {
        status: 200,
      })) as unknown as typeof fetch;
    for (const answered of [timedOut, outage, text, absentReset]) await refusedWith(s, answered, "spend_cap_unknown");
  });

  it("the ceiling is 20 dollars unless PI_EXTRACT_KEY_CAP_USD is set", async () => {
    const s = await world();
    await refusedWith(s, { limit: 20.000001 }, "spend_cap_too_high");
    await refusedWith(s, { limit: 40 }, "spend_cap_too_high", { PI_EXTRACT_KEY_CAP_USD: "39.99" });
    await okWith(s, { limit: 40 }, { PI_EXTRACT_KEY_CAP_USD: "40" });
  });

  it("the check sends the stored key to the key endpoint, and no log line holds the key or its label", async () => {
    const s = await world();
    const seen: string[] = [];
    const labelled = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push(`${String(url)} ${new Headers(init?.headers).get("authorization") ?? ""}`);
      return new Response(
        JSON.stringify({ data: { label: "owner-named-label", limit: 900, limit_remaining: 900, limit_reset: null } }),
        { status: 200 },
      );
    }) as typeof fetch;
    const refused = await extract(s, labelled);
    expect(seen).toEqual([`https://openrouter.ai/api/v1/key Bearer ${SENTINEL_KEY}`]);
    const ran = await extract(s, { limit: 10 });
    for (const result of [refused.result, ran.result]) {
      expect(result.stderr).not.toContain(SENTINEL_KEY);
      expect(result.stderr).not.toContain("owner-named-label");
    }
  });

  it("with PI_OPENROUTER_KEY_URL on loopback the check reads the key there, and nowhere else", async () => {
    const s = await world();
    const seen: string[] = [];
    const keyFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push(String(url));
      return fakeKeyEndpoint().fetch(url, init);
    }) as typeof fetch;
    const { result } = await extract(s, keyFetch, { PI_OPENROUTER_KEY_URL: "http://127.0.0.1:8787/api/v1/key" });
    expect(result.exit).toBe(0);
    expect(seen).toEqual(["http://127.0.0.1:8787/api/v1/key"]);
  });
});

describe("pi extract check's spend cap", () => {
  it("pi extract check prints spend_cap: ok with the two counts, and a refusal's code alone, with no model call", async () => {
    const s = await world();
    const openrouter = fakeOpenRouter(() => answer(GOOD_CHECK));
    const ok = await pi(["extract", "check"], s.pipeline, {
      deps: {
        modelFetch: openrouter.fetch,
        keyFetch: fakeKeyEndpoint({ limit: 12, remaining: 7.25, reset: "monthly" }).fetch,
      },
    });
    expect(ok.exit).toBe(0);
    expect(ok.stdout.split("\n")[0]).toBe("spend_cap: ok limit_micro_usd=12000000 remaining_micro_usd=7250000");
    expect(openrouter.bodies).toHaveLength(1);

    for (const [answered, code] of [
      [{ limit: null }, "spend_cap_missing"],
      [{ limit: 4, reset: "daily" }, "spend_cap_too_high"],
      [{ limit: 5, remaining: 0 }, "spend_cap_reached"],
      [{ limit: 5, remaining: null }, "spend_cap_unknown"],
    ] as const) {
      const refused = await pi(["extract", "check"], s.pipeline, {
        deps: { modelFetch: openrouter.fetch, keyFetch: fakeKeyEndpoint(answered).fetch },
      });
      expect(refused, code).toEqual({
        exit: 1,
        stdout: `spend_cap: ${code}\n`,
        stderr: `${JSON.stringify({ event: "command_failed", code })}\n`,
      });
    }
    // No request but the first check's reached the model, and only it wrote a usage row.
    expect(openrouter.bodies).toHaveLength(1);
    expect(await usage(s)).toEqual([{ model_id: MODEL_ID, outcome: "check" }]);
  });

  it("the check's ceiling is PI_EXTRACT_KEY_CAP_USD when set", async () => {
    const s = await world();
    const openrouter = fakeOpenRouter(() => answer(GOOD_CHECK));
    const at = (env: Record<string, string>) =>
      pi(
        ["extract", "check"],
        { ...s.pipeline, ...env },
        { deps: { modelFetch: openrouter.fetch, keyFetch: fakeKeyEndpoint({ limit: 30 }).fetch } },
      );
    expect((await at({})).stdout).toBe("spend_cap: spend_cap_too_high\n");
    expect((await at({ PI_EXTRACT_KEY_CAP_USD: "30" })).exit).toBe(0);
  });
});

// The decide model in pi extract and pi extract check, with fakeDecideClient or a fake Decisions surface.
const DECIDE_MODEL = "typesafe/jev-1.13";
const NEUTRAL = { human_written: 0.9, special_category: 0.01, quarantine: 0.01 };
// The decide model's two further screens answer "no" for every item, by prompt.
const J2_NONE = { jev_recovery: { account_recovery: 0.01 }, jev_record: { quarantine: 0.01 } };
const neutralFor = (s: Synced) => ({
  ...Object.fromEntries(Object.keys(s.outputs).map((id) => [id, NEUTRAL])),
  ...J2_NONE,
});
// The first screen's calls among fakeDecideClient's calls: the further screens' are
// `<prompt id>:<evidence id>`.
const screenCalls = (calls: string[]) => calls.filter((one) => !one.includes(":"));

describe("pi extract with Jev", () => {
  it("PI_DECIDE_MODEL unset makes no Jev call, and every item ends as on main", async () => {
    const s = await world();
    const decideCalls: string[] = [];
    const result = await pi(["extract"], s.pipeline, {
      deps: { model: fakeModelClient(s.outputs), decideModel: fakeDecideClient(neutralFor(s), decideCalls) },
    });
    expect(result.exit).toBe(0);
    expect(decideCalls).toEqual([]);
    const rows = await statuses(s.db);
    for (const [gmailId, expected] of Object.entries(s.w.expected.items)) {
      const got = rows.get(evidenceOf(s, gmailId));
      expect([gmailId, got?.status, got?.code]).toEqual([gmailId, expected.status, expected.code]);
    }
  });

  it("PI_DECIDE_MODEL set screens each item: the instructing twin is withheld and its usage is Jev's", async () => {
    const s = await world();
    const decideCalls: string[] = [];
    // An answer for every message, a bulk one with no interpreter output included: the decide model screens it.
    const messages = await queryAs<{ id: string }>(s.db.urls.admin, "select evidence_id as id from knowledge.messages");
    const answers = {
      ...Object.fromEntries(messages.map((row) => [row.id, NEUTRAL])),
      ...J2_NONE,
      [evidenceOf(s, s.w.handles.instructionMessageId)]: { ...NEUTRAL, quarantine: 0.97 },
    };
    const result = await pi(
      ["extract"],
      { ...s.pipeline, PI_DECIDE_MODEL: DECIDE_MODEL },
      { deps: { model: fakeModelClient(s.outputs), decideModel: fakeDecideClient(answers, decideCalls) } },
    );
    expect(result.exit).toBe(0);
    expect(decideCalls.length).toBeGreaterThan(0);
    const rows = await statuses(s.db);
    expect(rows.get(evidenceOf(s, s.w.handles.instructionMessageId))).toMatchObject({
      status: "withheld",
      code: "quarantine",
    });
    expect(rows.get(evidenceOf(s, s.w.handles.twinMessageId))?.status).not.toBe("withheld");
    const saved = await queryAs<{ n: number }>(
      s.db.urls.admin,
      "select count(*)::int as n from vault.model_calls where prompt_id = 'jev_screen'",
    );
    expect(saved[0]?.n).toBe(screenCalls(decideCalls).length);
    // Every email item was asked jev_recovery once, and none was held.
    expect(decideCalls.filter((one) => one.startsWith("jev_recovery:")).length).toBeGreaterThan(0);
  });

  it("turning Jev on over an extracted world screens each item once, changes no claim id but the withheld item's, and turning it off leaves the hold", async () => {
    const s = await world();
    expect((await pi(["extract"], s.pipeline, { deps: { model: fakeModelClient(s.outputs) } })).exit).toBe(0);
    const claims = () =>
      queryAs<{ id: string; evidence_id: string }>(
        s.db.urls.admin,
        "select id, evidence_id from knowledge.claims order by id",
      );
    const generations = () =>
      queryAs<{ g: number }>(s.db.urls.admin, "select distinct extractor_generation as g from vault.pipeline_items");
    const before = await claims();
    // Answers that keep every lane, and a hold for one item that was done.
    const messages = await queryAs<{ id: string; bulk: boolean }>(
      s.db.urls.admin,
      "select evidence_id as id, bulk from knowledge.messages",
    );
    const answers: Record<string, unknown> = {
      ...Object.fromEntries(messages.map((row) => [row.id, { ...NEUTRAL, human_written: row.bulk ? 0.1 : 0.9 }])),
      ...J2_NONE,
    };
    const plan = evidenceOf(s, s.w.handles.planMessageId);
    expect((await statuses(s.db)).get(plan)?.status).toBe("done");
    answers[plan] = { ...NEUTRAL, quarantine: 0.97 };

    const decideCalls: string[] = [];
    const on = { ...s.pipeline, PI_DECIDE_MODEL: DECIDE_MODEL };
    const decideDeps = {
      deps: { model: fakeModelClient(s.outputs), decideModel: fakeDecideClient(answers, decideCalls) },
    };
    expect((await pi(["extract"], on, decideDeps)).exit).toBe(0);
    expect(screenCalls(decideCalls).length).toBeGreaterThan(50);
    expect(new Set(decideCalls).size).toBe(decideCalls.length);
    expect((await statuses(s.db)).get(plan)).toMatchObject({ status: "withheld", code: "quarantine" });
    expect(await claims()).toEqual(before.filter((row) => row.evidence_id !== plan));
    expect(await generations()).toEqual([{ g: EXTRACT_GENERATION }]);

    // A second run with the decide model sends nothing; a run with the decide model off leaves the hold and every claim.
    const sent = decideCalls.length;
    expect((await pi(["extract"], on, decideDeps)).exit).toBe(0);
    expect(decideCalls.length).toBe(sent);
    expect((await pi(["extract"], s.pipeline, { deps: { model: fakeModelClient(s.outputs) } })).exit).toBe(0);
    expect((await statuses(s.db)).get(plan)).toMatchObject({ status: "withheld", code: "quarantine" });
    expect(await claims()).toEqual(before.filter((row) => row.evidence_id !== plan));
    expect(await generations()).toEqual([{ g: EXTRACT_GENERATION }]);
  });

  it("the real Jev client goes to the Decisions surface with the provider fields, and its usage rows carry its id", async () => {
    const s = await world();
    // Each of the request's questions answered: the first screen's three as NEUTRAL, the further
    // screen's one "no".
    const surface = fakeOpenRouter((body) =>
      body.questions !== undefined
        ? {
            body: {
              answers: Object.fromEntries(
                Object.keys(body.questions as object).map((id) => [
                  id,
                  { type: "noul", noul: (NEUTRAL as Record<string, number>)[id] ?? 0.01 },
                ]),
              ),
              usage: { input_tokens: 300, output_tokens: 0, cost: 0.0000126 },
            },
          }
        : answer(EMPTY_OUTPUT),
    );
    const result = await pi(
      ["extract", "--max-calls", "2"],
      { ...s.pipeline, PI_DECIDE_MODEL: DECIDE_MODEL },
      { deps: { modelFetch: surface.fetch } },
    );
    expect(result.exit).toBe(0);
    const decisions = surface.bodies.filter((body) => body.questions !== undefined);
    expect(decisions.length).toBeGreaterThan(0);
    for (const body of decisions) {
      expect(Object.keys(body).sort()).toEqual(["model", "provider", "questions", "state"]);
      expect(body.provider).toEqual({ zdr: true, data_collection: "deny" });
      expect(body.model).toBe(DECIDE_MODEL);
    }
    expect((await usage(s)).filter((row) => row.model_id === DECIDE_MODEL).length).toBe(decisions.length);
  });
});

describe("pi extract check with Jev", () => {
  const decideAnswer = (quarantine: number, cost: number | null = 0.0000126) => ({
    body: {
      answers: {
        human_written: { type: "noul", noul: 0.9 },
        special_category: { type: "noul", noul: 0.01 },
        quarantine: { type: "noul", noul: quarantine },
      },
      usage: cost === null ? { input_tokens: 300, output_tokens: 0 } : { input_tokens: 300, output_tokens: 0, cost },
    },
  });

  // The further screens' two answers: one probability, with a cost.
  const oneAnswer = (id: string, p: number) => ({
    body: {
      answers: { [id]: { type: "noul", noul: p } },
      usage: { input_tokens: 300, output_tokens: 0, cost: 0.0000126 },
    },
  });

  it("prints its Jev lines: ok on quarantine at or above 0.9 with a cost, failed otherwise, and jev-calibration's recovery and record lines; none printed with PI_DECIDE_MODEL unset", async () => {
    const s = await world();
    const check = async (
      decideModel: ReturnType<typeof decideAnswer> | undefined,
      env: Record<string, string>,
      j2: { recovery: number; record: number } = { recovery: 0.9, record: 0.9 },
    ) => {
      const surface = fakeOpenRouter((body) => {
        const questions = body.questions as Record<string, unknown> | undefined;
        if (questions === undefined || decideModel === undefined) return answer(GOOD_CHECK);
        if ("account_recovery" in questions) return oneAnswer("account_recovery", j2.recovery);
        if (!("human_written" in questions)) return oneAnswer("quarantine", j2.record);
        return decideModel;
      });
      return pi(["extract", "check"], { ...s.pipeline, ...env }, { deps: { modelFetch: surface.fetch } });
    };
    const five = { accepted: "ok", finish_stop: "ok", schema: "ok", receipt: "ok", cost: "ok" };
    const j2 = { jev_recovery: "ok", jev_record: "ok" };
    expect(await check(decideAnswer(0.95), { PI_DECIDE_MODEL: DECIDE_MODEL })).toEqual({
      exit: 0,
      stdout: lines({ ...five, jev: "ok", ...j2 }),
      stderr: "",
    });
    const low = await check(decideAnswer(0.2), { PI_DECIDE_MODEL: DECIDE_MODEL });
    expect(low.exit).toBe(1);
    expect(low.stdout).toBe(lines({ ...five, jev: "failed", ...j2 }));
    expect((await check(decideAnswer(0.95, null), { PI_DECIDE_MODEL: DECIDE_MODEL })).stdout).toBe(
      lines({ ...five, jev: "failed", ...j2 }),
    );
    // The further screens: account_recovery under 0.7 fails its line; quarantine under 0.8 fails
    // the record's.
    const j2Low = await check(decideAnswer(0.95), { PI_DECIDE_MODEL: DECIDE_MODEL }, { recovery: 0.69, record: 0.79 });
    expect(j2Low.exit).toBe(1);
    expect(j2Low.stdout).toBe(lines({ ...five, jev: "ok", jev_recovery: "failed", jev_record: "failed" }));
    expect(await check(undefined, {})).toEqual({ exit: 0, stdout: lines(five), stderr: "" });
    expect((await usage(s)).filter((row) => row.model_id === DECIDE_MODEL)).toEqual(
      Array.from({ length: 12 }, () => ({ model_id: DECIDE_MODEL, outcome: "check" })),
    );
  });
});
