import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { Writable } from "node:stream";
import { fakeKeyEndpoint } from "@intelligence/personal-models/testing";
import { describe, expect, it } from "vitest";
import { type RunDeps, runOnce } from "./run.ts";
import {
  answer,
  calls,
  fakeAgentApi,
  fakeTurnModel,
  IGNORE,
  memoryLogger,
  RUN_ID,
  runRequest,
} from "./test-support/run-doubles.ts";

const OWN = { PATH: "/usr/bin:/bin" };
// The reasoner's key, read by the spend-cap check. Synthetic.
const KEY = "sk-or-synthetic-reasoner-key-0000";
const KEYED = { ...OWN, PI_REASONER_MODEL_KEY: KEY };

const sink = () => {
  const written: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      written.push(chunk.toString("utf8"));
      done();
    },
  });
  return { stream, text: () => written.join("") };
};

// Under the key endpoint's default answer, a 5-dollar limit with all of it left: ok.
const once = async (
  api: ReturnType<typeof fakeAgentApi>,
  model: ReturnType<typeof fakeTurnModel>,
  env: Record<string, string> = KEYED,
  deps: RunDeps = {},
) => {
  const log = memoryLogger();
  const stderr = sink();
  const code = await runOnce(env, {
    startApi: async () => api.api,
    model,
    log,
    stderr: stderr.stream,
    keyFetch: fakeKeyEndpoint().fetch,
    ...deps,
  });
  return { code, log, stderr };
};
const SPEND_OK = {
  event: "spend_cap",
  code: "ok",
  counts: { limit_micro_usd: 5_000_000, remaining_micro_usd: 5_000_000 },
};

describe("runOnce", () => {
  it("no queued run exits 0 and calls no model", async () => {
    const api = fakeAgentApi({ next_run: () => ({ ok: true, value: { run: null } }) });
    const model = fakeTurnModel([answer(IGNORE)]);
    const { code } = await once(api, model);
    expect(code).toBe(0);
    expect(model.requests).toHaveLength(0);
    expect(api.log.map((call) => call.name)).toEqual(["next_run"]);
    expect(api.closed()).toBe(1);
  });

  // A next_run cancelled at its deadline answers unavailable: the exit the timer records, and the
  // reasoner's failure streak counts.
  it("a next_run that answers unavailable exits 1 and calls no model", async () => {
    const api = fakeAgentApi({ next_run: () => ({ ok: false, code: "unavailable" }) });
    const model = fakeTurnModel([answer(IGNORE)]);
    const { code } = await once(api, model);
    expect(code).toBe(1);
    expect(model.requests).toHaveLength(0);
  });

  it("a finished run calls finish_run once with its output and exits 0", async () => {
    const api = fakeAgentApi();
    const { code } = await once(api, fakeTurnModel([answer(IGNORE)]));
    expect(code).toBe(0);
    expect(api.finishes()).toEqual([
      { run: RUN_ID, outcome: "finished", output: IGNORE, requestId: expect.any(String) },
    ]);
    expect(api.closed()).toBe(1);
  });

  it("a failed run calls finish_run with its code and exits 1", async () => {
    const api = fakeAgentApi();
    const { code } = await once(api, fakeTurnModel([new Error("unavailable")]));
    expect(code).toBe(1);
    expect(api.finishes()).toEqual([
      { run: RUN_ID, outcome: "failed", code: "model_unavailable", requestId: expect.any(String) },
    ]);
    expect(api.closed()).toBe(1);
  });

  it("a stopped run exits 0 and calls nothing after the stop", async () => {
    const api = fakeAgentApi({ append_step: () => ({ ok: true, value: { go: false } }) });
    const { code } = await once(api, fakeTurnModel([calls({ name: "get_self" }), answer(IGNORE)]));
    expect(code).toBe(0);
    expect(api.log.map((call) => call.name)).toEqual(["next_run", "append_step"]);
    expect(api.closed()).toBe(1);
  });

  it("two runs in one process share nothing: the second run's first model call holds no text of the first", async () => {
    const first = fakeAgentApi({ get_self: () => ({ ok: true, value: { secret: "first-run-result-text" } }) });
    const firstModel = fakeTurnModel([calls({ name: "get_self" }), answer(IGNORE)]);
    await once(first, firstModel);
    const SECOND = "run_01JABCDEFGHJKMNPQRSTVWXYZ9";
    const second = fakeAgentApi({ next_run: () => ({ ok: true, value: { run: runRequest({}, SECOND) } }) });
    const secondModel = fakeTurnModel([answer(IGNORE)]);
    await once(second, secondModel);
    const sent = JSON.stringify(secondModel.requests[0]);
    for (const text of ["first-run-result-text", RUN_ID, "call_0"]) expect(sent).not.toContain(text);
    expect(secondModel.requests[0]?.messages).toHaveLength(1);
    expect(second.steps()[0]).toMatchObject({ kind: "model_call" });
    expect(second.log.find((call) => call.name === "append_step")?.args.ordinal).toBe(0);
  });

  it("a trial run is reasoned over by its own model and effort, with the reasoner's key; any other run by the configured ones", async () => {
    const vendor = {
      choices: [{ message: { content: JSON.stringify(IGNORE) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.000001 },
    };
    const env = { ...KEYED, PI_REASONER_MODEL: "vendor/configured-model", PI_REASONER_REASONING_EFFORT: "low" };
    const sent = async (trial?: { model: string; effort: string }) => {
      const bodies: { body: Record<string, unknown>; auth: string | null }[] = [];
      const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
        bodies.push({
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
          auth: new Headers(init?.headers).get("authorization"),
        });
        return new Response(JSON.stringify(vendor));
      }) as typeof globalThis.fetch;
      const api = fakeAgentApi({
        next_run: () => ({
          ok: true,
          value: {
            run: { ...runRequest(), ...(trial === undefined ? {} : { trial }) },
          },
        }),
      });
      const code = await runOnce(env, {
        startApi: async () => api.api,
        log: memoryLogger(),
        stderr: sink().stream,
        keyFetch: fakeKeyEndpoint().fetch,
        modelDeps: { fetch, sleep: async () => {} },
      });
      expect(code).toBe(0);
      expect(api.finishes()).toEqual([
        { run: RUN_ID, outcome: "finished", output: IGNORE, requestId: expect.any(String) },
      ]);
      expect(api.steps()[0]).toMatchObject({ kind: "model_call", inputTokens: 10, outputTokens: 2 });
      return bodies.map(({ body, auth }) => ({ model: body.model, reasoning: body.reasoning, auth }));
    };
    expect(await sent({ model: "anthropic/trial-model", effort: "high" })).toEqual([
      { model: "anthropic/trial-model", reasoning: { effort: "high" }, auth: `Bearer ${KEY}` },
    ]);
    expect(await sent()).toEqual([
      { model: "vendor/configured-model", reasoning: { effort: "low" }, auth: `Bearer ${KEY}` },
    ]);
  });

  it("on an Anthropic key, the run goes to Anthropic with no OpenRouter key check, and a trial of another vendor's model ends as failed", async () => {
    const reply = {
      type: "message",
      content: [{ type: "text", text: JSON.stringify(IGNORE) }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 2 },
    };
    const env = {
      ...KEYED,
      PI_REASONER_MODEL_KEY: "sk-ant-test-not-a-real-key-0000",
      PI_REASONER_MODEL: "anthropic/claude-haiku-5.5",
    };
    const go = async (trial?: { model: string; effort: string }) => {
      const urls: string[] = [];
      const fetch = (async (url: string | URL | Request) => {
        urls.push(String(url));
        return new Response(JSON.stringify(reply));
      }) as typeof globalThis.fetch;
      const keyCheck = fakeKeyEndpoint();
      const api = fakeAgentApi({
        next_run: () => ({ ok: true, value: { run: { ...runRequest(), ...(trial === undefined ? {} : { trial }) } } }),
      });
      const code = await runOnce(env, {
        startApi: async () => api.api,
        log: memoryLogger(),
        stderr: sink().stream,
        keyFetch: keyCheck.fetch,
        modelDeps: { fetch, sleep: async () => {} },
      });
      return { code, urls, finishes: api.finishes() };
    };
    const plain = await go();
    expect(plain.code).toBe(0);
    expect(plain.urls).toEqual(["https://api.anthropic.com/v1/messages"]);
    expect(plain.finishes).toEqual([
      { run: RUN_ID, outcome: "finished", output: IGNORE, requestId: expect.any(String) },
    ]);
    const nonAnthropic = await go({ model: "openai/gpt-6-luna", effort: "high" });
    expect(nonAnthropic.code).toBe(1);
    expect(nonAnthropic.urls).toEqual([]);
    expect(nonAnthropic.finishes).toEqual([
      { run: RUN_ID, outcome: "failed", code: "model_unavailable", requestId: expect.any(String) },
    ]);
  });

  it("a fault no code expects is a bug, by its class; a socket's is unavailable, by its errno", async () => {
    const failing = [
      { thrown: new TypeError("sentinel owner@example.com"), logged: { code: "bug", reason: "type_error" } },
      {
        thrown: Object.assign(new Error("sentinel owner@example.com"), { code: "ECONNRESET" }),
        logged: { code: "unavailable", reason: "econnreset" },
      },
    ];
    for (const { thrown, logged } of failing) {
      const { code, log, stderr } = await once(fakeAgentApi(), fakeTurnModel([]), KEYED, {
        startApi: () => Promise.reject(thrown),
      });
      expect(code).toBe(1);
      expect(log.events).toEqual([SPEND_OK, { event: "reasoner_failed", ...logged }]);
      expect(stderr.text()).toBe("");
    }
  });

  it("an unauthorized answer exits 1 with one log line and no stack", async () => {
    const api = fakeAgentApi({ next_run: () => ({ ok: false, code: "unauthorized" }) });
    const { code, log, stderr } = await once(api, fakeTurnModel([]));
    expect(code).toBe(1);
    expect(log.events).toEqual([SPEND_OK, { event: "reasoner_failed", code: "unauthorized" }]);
    expect(stderr.text()).toBe("");
    expect(api.closed()).toBe(1);
  });

  it("an environment that holds a database setting starts no agent API", async () => {
    let started = 0;
    const log = memoryLogger();
    const code = await runOnce(
      { ...OWN, PGPASSWORD: "synthetic" },
      {
        startApi: async () => {
          started += 1;
          return fakeAgentApi().api;
        },
        model: fakeTurnModel([]),
        log,
        stderr: sink().stream,
      },
    );
    expect(code).toBe(1);
    expect(started).toBe(0);
    expect(log.events).toEqual([{ event: "reasoner_failed", code: "wrong_role_url" }]);
  });

  it("with no model id, or no key, runOnce refuses to start with missing_env and names the variable, not its value", async () => {
    for (const [env, missing] of [
      [{ ...OWN, PI_REASONER_MODEL_KEY: "sk-synthetic-key" }, "PI_REASONER_MODEL"],
      [{ ...OWN, PI_REASONER_MODEL: "vendor/synthetic-model" }, "PI_REASONER_MODEL_KEY"],
    ] as const) {
      let started = 0;
      const log = memoryLogger();
      const stderr = sink();
      const code = await runOnce(env, {
        startApi: async () => {
          started += 1;
          return fakeAgentApi().api;
        },
        log,
        stderr: stderr.stream,
      });
      expect(code).toBe(1);
      expect(started).toBe(0);
      expect(log.events).toEqual([{ event: "reasoner_failed", code: "missing_env" }]);
      expect(stderr.text()).toBe(`set ${missing}\n`);
      expect(stderr.text()).not.toContain("synthetic");
    }
  });
});

describe("runOnce's spend cap", () => {
  // The agent API, counting its starts: a refused run starts none and takes no run.
  const counted = () => {
    const api = fakeAgentApi();
    let started = 0;
    return {
      api,
      started: () => started,
      startApi: async () => {
        started += 1;
        return api.api;
      },
    };
  };

  it("a key under the ceiling logs spend_cap ok with the two counts, then takes its run", async () => {
    const api = fakeAgentApi();
    const { code, log } = await once(api, fakeTurnModel([answer(IGNORE)]));
    expect(code).toBe(0);
    expect(log.events[0]).toEqual(SPEND_OK);
    expect(api.log.map((call) => call.name)).toContain("next_run");
  });

  it("a reasoner once whose key is over its ceiling does not call next_run and exits 1", async () => {
    const { api, started, startApi } = counted();
    const model = fakeTurnModel([answer(IGNORE)]);
    const { code, log } = await once(api, model, KEYED, { startApi, keyFetch: fakeKeyEndpoint({ limit: 51 }).fetch });
    expect(code).toBe(1);
    expect(started()).toBe(0);
    expect(api.log).toEqual([]);
    expect(model.requests).toHaveLength(0);
    expect(log.events).toEqual([
      {
        event: "spend_cap",
        code: "spend_cap_too_high",
        counts: { limit_micro_usd: 51_000_000, remaining_micro_usd: 51_000_000 },
      },
      { event: "reasoner_failed", code: "spend_cap_too_high" },
    ]);
  });

  it("each refusal starts no agent API and calls no model, with a key under its ceiling as the positive control", async () => {
    const cases = [
      [{ limit: null }, "spend_cap_missing"],
      [{ limit: 10, remaining: 0 }, "spend_cap_reached"],
      [{ limit: 10, remaining: null }, "spend_cap_unknown"],
      [{ limit: 2, reset: "daily" }, "spend_cap_too_high"],
      [{ limit: 50, reset: "monthly" }, "ok"],
    ] as const;
    for (const [answered, expected] of cases) {
      const { api, started, startApi } = counted();
      const model = fakeTurnModel([answer(IGNORE)]);
      const { code, log } = await once(api, model, KEYED, { startApi, keyFetch: fakeKeyEndpoint(answered).fetch });
      expect(log.events[0]?.code, expected).toBe(expected);
      expect(code, expected).toBe(expected === "ok" ? 0 : 1);
      expect(started(), expected).toBe(expected === "ok" ? 1 : 0);
      expect(model.requests.length, expected).toBe(expected === "ok" ? 1 : 0);
    }
  });

  // A 5xx is retried with the client's waits first; the package's tests show it ends unknown too.
  it("a key endpoint that refuses, times out or answers what does not parse is spend_cap_unknown, and no run is taken", async () => {
    const answers: (() => Promise<Response>)[] = [
      async () => new Response("", { status: 401 }),
      async () => new Response("not json", { status: 200 }),
      async () => new Response(JSON.stringify({ data: { limit: 5, limit_remaining: 5 } }), { status: 200 }),
      async () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      },
    ];
    for (const reply of answers) {
      const { api, started, startApi } = counted();
      const { code, log } = await once(api, fakeTurnModel([]), KEYED, {
        startApi,
        keyFetch: reply as unknown as typeof fetch,
      });
      expect(code).toBe(1);
      expect(started()).toBe(0);
      expect(log.events.at(-1)).toEqual({ event: "reasoner_failed", code: "spend_cap_unknown" });
    }
  });

  it("the ceiling is 50 dollars unless PI_REASONER_KEY_CAP_USD is set", async () => {
    const at = async (limit: number, env: Record<string, string> = KEYED) =>
      (await once(fakeAgentApi(), fakeTurnModel([answer(IGNORE)]), env, { keyFetch: fakeKeyEndpoint({ limit }).fetch }))
        .code;
    expect(await at(50)).toBe(0);
    expect(await at(50.000001)).toBe(1);
    expect(await at(80, { ...KEYED, PI_REASONER_KEY_CAP_USD: "80" })).toBe(0);
    expect(await at(10, { ...KEYED, PI_REASONER_KEY_CAP_USD: "9.5" })).toBe(1);
  });

  it("a reasoning effort other than low, medium or high is refused bad_env at start, naming the variable, before the key is read or the agent API starts", async () => {
    let started = 0;
    const keys = fakeKeyEndpoint();
    const log = memoryLogger();
    const stderr = sink();
    const code = await runOnce(
      {
        ...OWN,
        PI_REASONER_MODEL: "vendor/synthetic-model",
        PI_REASONER_MODEL_KEY: "sk-synthetic-key",
        PI_REASONER_REASONING_EFFORT: "maximum",
      },
      {
        startApi: async () => {
          started += 1;
          return fakeAgentApi().api;
        },
        log,
        stderr: stderr.stream,
        keyFetch: keys.fetch,
      },
    );
    expect(code).toBe(1);
    expect(started).toBe(0);
    expect(keys.calls()).toBe(0);
    expect(log.events).toEqual([{ event: "reasoner_failed", code: "bad_env" }]);
    expect(stderr.text()).toBe("set PI_REASONER_REASONING_EFFORT\n");
  });

  it("a ceiling that is not dollars with at most six decimals is refused bad_env, naming the variable, before the key is read", async () => {
    for (const value of ["20 dollars", "-1", "1.1234567", "1e3", "0x10"]) {
      const keys = fakeKeyEndpoint();
      const { code, log, stderr } = await once(
        fakeAgentApi(),
        fakeTurnModel([]),
        { ...KEYED, PI_REASONER_KEY_CAP_USD: value },
        { keyFetch: keys.fetch },
      );
      expect(code).toBe(1);
      expect(keys.calls()).toBe(0);
      expect(log.events).toEqual([{ event: "reasoner_failed", code: "bad_env" }]);
      expect(stderr.text()).toBe("set PI_REASONER_KEY_CAP_USD\n");
    }
  });

  it("the check sends the reasoner's own key to the key endpoint", async () => {
    const seen: string[] = [];
    const keyFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push(`${String(url)} ${new Headers(init?.headers).get("authorization") ?? ""}`);
      return fakeKeyEndpoint().fetch(url, init);
    }) as typeof fetch;
    await once(fakeAgentApi(), fakeTurnModel([answer(IGNORE)]), KEYED, { keyFetch });
    expect(seen).toEqual([`https://openrouter.ai/api/v1/key Bearer ${KEY}`]);
  });

  it("PI_OPENROUTER_KEY_URL on loopback sends the check there, and nowhere else", async () => {
    const seen: string[] = [];
    const keyFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push(String(url));
      return fakeKeyEndpoint().fetch(url, init);
    }) as typeof fetch;
    const { code } = await once(
      fakeAgentApi(),
      fakeTurnModel([answer(IGNORE)]),
      { ...KEYED, PI_OPENROUTER_KEY_URL: "http://127.0.0.1:8787/api/v1/key" },
      { keyFetch },
    );
    expect(code).toBe(0);
    expect(seen).toEqual(["http://127.0.0.1:8787/api/v1/key"]);
  });

  it("a PI_OPENROUTER_KEY_URL that is not loopback is refused bad_env, naming the variable, before the key is read", async () => {
    for (const value of [
      "https://openrouter.ai/api/v1/key",
      "http://10.0.0.1:80/key",
      "http://127.0.0.1/key",
      "http://localhost:8787/api/v1/key",
    ]) {
      const keys = fakeKeyEndpoint();
      const api = fakeAgentApi();
      let started = false;
      const startApi = async () => {
        started = true;
        return api.api;
      };
      const { code, log, stderr } = await once(
        api,
        fakeTurnModel([]),
        { ...KEYED, PI_OPENROUTER_KEY_URL: value },
        { keyFetch: keys.fetch, startApi },
      );
      expect(code).toBe(1);
      expect(keys.calls()).toBe(0);
      expect(started).toBe(false);
      expect(log.events).toEqual([{ event: "reasoner_failed", code: "bad_env" }]);
      expect(stderr.text()).toBe("set PI_OPENROUTER_KEY_URL\n");
    }
  });

  it("no log line holds the key or its label", async () => {
    const labelled = (async () =>
      new Response(
        JSON.stringify({ data: { label: "owner-named-label", limit: 900, limit_remaining: 900, limit_reset: null } }),
        { status: 200 },
      )) as unknown as typeof fetch;
    for (const keyFetch of [fakeKeyEndpoint().fetch, labelled]) {
      const { log, stderr } = await once(fakeAgentApi(), fakeTurnModel([answer(IGNORE)]), KEYED, { keyFetch });
      const text = JSON.stringify(log.events) + stderr.text();
      expect(text).not.toContain(KEY);
      expect(text).not.toContain("owner-named-label");
    }
  });
});

describe("main", () => {
  const main = join(import.meta.dirname, "main.ts");
  const start = (args: string[], env: Record<string, string>) =>
    spawnSync(process.execPath, [main, ...args], { env: { ...OWN, ...env }, encoding: "utf8", timeout: 30_000 });

  it("with no model id, or no key, main refuses to start with missing_env and names the variable, not its value", () => {
    const noModel = start(["once"], { PI_REASONER_MODEL_KEY: "sk-synthetic-key" });
    expect(noModel.status).toBe(1);
    expect(noModel.stderr).toBe('{"event":"reasoner_failed","code":"missing_env"}\nset PI_REASONER_MODEL\n');
    const noKey = start(["once"], { PI_REASONER_MODEL: "vendor/synthetic-model" });
    expect(noKey.status).toBe(1);
    expect(noKey.stderr).toBe('{"event":"reasoner_failed","code":"missing_env"}\nset PI_REASONER_MODEL_KEY\n');
    expect(noKey.stdout).toBe("");
  });

  it("any argument but once or measure is a usage error with exit 2", () => {
    for (const args of [[], ["twice"], ["once", "more"]]) {
      const result = start(args, {});
      expect(result.status).toBe(2);
      expect(result.stderr).toBe('{"event":"reasoner_failed","code":"usage"}\nusage: pi-reasoner once | measure\n');
    }
  });
});
