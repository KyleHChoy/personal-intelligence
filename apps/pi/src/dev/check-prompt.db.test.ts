import { access } from "node:fs/promises";
import { Writable } from "node:stream";
import type { TurnReply, TurnRequest } from "@intelligence/contracts/personal";
import { fakeTurnModel } from "@intelligence/personal-core/testing";
import { fakeKeyEndpoint } from "@intelligence/personal-models/testing";
import type { TurnModel } from "@intelligence/personal-reasoner";
import { queryAs } from "@intelligence/personal-store/testing";
import { describe, expect, it } from "vitest";
import { answer, COST, calls, IGNORE } from "../test-support/work-harness.ts";
import { checkPrompt } from "./check-prompt.ts";

// The prompt check against a database: the work harness with no worker, one run queued with
// `pi work run`, and the reasoner's runOnce with a recorded model handed in, so no live model is
// called. The recorded model finds the world's receipt, reads it (its body holds a canary), calls a
// tool that does not exist, and answers ignore.

const LONG = 600_000;
const RECEIPT_SENDER = "orders@shop.example.com";
const BODY_CANARY = "CANARY-BODY-T6Q9L3";

// The recorded model, one answer for each turn in order. The second is written from what the
// first turn's tool returned, as a recorded model reads an id it was given; each goes through
// the core's fakeTurnModel, which checks the request and the reply.
function recordedReading(): TurnModel & { requests: number } {
  const steps: ((request: TurnRequest) => TurnReply)[] = [
    () => calls({ name: "find_messages", arguments: { sender: RECEIPT_SENDER } }),
    (request) => {
      const last = request.messages.at(-1);
      const id = /"id":"(msg_[0-9A-HJKMNP-TV-Z]{26})"/.exec(last?.role === "tool" ? last.result : "")?.[1];
      if (id === undefined) throw new Error("the recorded model found no message id");
      return calls({ name: "read_message", arguments: { id } });
    },
    () => calls({ name: "send_mail", arguments: {} }),
    () => answer(IGNORE),
  ];
  const model = {
    requests: 0,
    async turn(request: TurnRequest) {
      const step = steps[model.requests];
      model.requests += 1;
      if (step === undefined) throw new Error("the recorded model was asked for more");
      return fakeTurnModel([step(request)]).turn(request);
    },
  };
  return model;
}

function terminal(): Writable & { isTTY: true; text(): string } {
  const chunks: string[] = [];
  const out = new Writable({
    write(chunk: Buffer, _encoding, done) {
      chunks.push(chunk.toString("utf8"));
      done();
    },
  }) as Writable & { isTTY: true; text(): string };
  out.isTTY = true;
  out.text = () => chunks.join("");
  return out;
}

describe("the prompt check, against a database", () => {
  let result: Awaited<ReturnType<typeof checkPrompt>> | undefined;
  let printed = "";
  let model: ReturnType<typeof recordedReading>;

  it(
    "the output holds the parsed actions, the refusals, the turns and the cost, and no text of any tool result",
    async () => {
      model = recordedReading();
      const out = terminal();
      let asked = 0;
      result = await checkPrompt({
        modelIds: ["vendor/model-1"],
        readKey: async () => {
          asked += 1;
          return "placeholder-not-a-key";
        },
        models: [model],
        keyFetch: fakeKeyEndpoint().fetch,
        out,
      });
      printed = out.text();
      expect(result.code).toBe("ok");
      expect(asked).toBe(0);
      expect(model.requests).toBe(4);
      expect(JSON.parse(printed)).toEqual({
        model: "vendor/model-1",
        spendCap: "ok",
        run: { outcome: "finished", code: null },
        output: IGNORE,
        checks: [],
        refusals: [{ step: 5, tool: null, status: "refused", code: null }],
        turns: 4,
        costMicroUsd: 4 * COST,
      });
      expect(printed).not.toContain(BODY_CANARY);
      expect(printed).not.toContain(RECEIPT_SENDER);
      expect(printed).not.toMatch(/msg_[0-9A-HJKMNP-TV-Z]{26}/);
    },
    LONG,
  );

  it(
    "it leaves no database and no temporary directory behind",
    async () => {
      expect(result?.databases).toEqual([expect.stringMatching(/^pi_test_/)]);
      // The local server as the test helper reaches it (store testing.ts), on its throwaway password.
      const server = `postgres://migrator:local-only@127.0.0.1:${Number(process.env.INTELLIGENCE_PG_PORT ?? 54329)}/postgres`;
      expect(await queryAs(server, "select 1 from pg_database where datname = $1", [result?.databases?.[0]])).toEqual(
        [],
      );
      await expect(access(result?.folders?.[0] ?? "")).rejects.toMatchObject({ code: "ENOENT" });
    },
    LONG,
  );

  it(
    "two model ids: each runs on its own copy of one sequence, reads the same request, and the outputs are printed action by action with each run's checks",
    async () => {
      const seen: string[] = [];
      const ignoring: TurnModel = {
        async turn(request) {
          seen.push(request.messages[0]?.role === "user" ? request.messages[0].text : "");
          return fakeTurnModel([answer(IGNORE)]).turn(request);
        },
      };
      // The goal again, citing only the goal: refused twice by the output checks.
      let restated = 0;
      const restating: TurnModel = {
        async turn(request) {
          const first = request.messages[0]?.role === "user" ? request.messages[0].text : "";
          if (restated === 0) seen.push(first);
          restated += 1;
          const goal = /"id":"(gol_[0-9A-HJKMNP-TV-Z]{26})"/.exec(first)?.[1];
          if (goal === undefined) throw new Error("no goal in the request");
          const output = {
            actions: [
              {
                do: "propose",
                kind: "goal_step",
                about: { kind: "goal", id: goal },
                summary: "Keep the weekly sync with Sam prepared",
                basis: [{ kind: "goal", id: goal }],
              },
            ],
          };
          return fakeTurnModel([answer(output)]).turn(request);
        },
      };
      const out = terminal();
      const compared = await checkPrompt({
        modelIds: ["vendor/model-1", "other-vendor/model-2"],
        readKey: async () => "placeholder-not-a-key",
        models: [ignoring, restating],
        keyFetch: fakeKeyEndpoint().fetch,
        out,
      });
      expect(compared.code).toBe("ok");
      expect(compared.databases).toHaveLength(2);
      expect(new Set(compared.databases).size).toBe(2);
      // The same request, ids and all.
      expect(seen).toHaveLength(2);
      expect(seen[0]).toBe(seen[1]);
      const report = JSON.parse(out.text()) as {
        models: string[];
        actions: { index: number; a: unknown; b: unknown }[];
        runs: Record<string, unknown>[];
      };
      expect(report.models).toEqual(["vendor/model-1", "other-vendor/model-2"]);
      expect(report.actions).toEqual([
        {
          index: 0,
          a: IGNORE.actions[0],
          b: expect.objectContaining({ do: "propose", summary: "Keep the weekly sync with Sam prepared" }),
        },
      ]);
      expect(report.runs[0]).toMatchObject({
        model: "vendor/model-1",
        run: { outcome: "finished", code: null },
        checks: [],
        turns: 1,
      });
      const refused = [
        { action: 0, code: "no_citation" },
        { action: 0, code: "restates_goal" },
      ];
      expect(report.runs[1]).toMatchObject({
        model: "other-vendor/model-2",
        run: { outcome: "failed", code: "bad_output" },
        checks: [...refused, ...refused],
        turns: 2,
      });
      const server = `postgres://migrator:local-only@127.0.0.1:${Number(process.env.INTELLIGENCE_PG_PORT ?? 54329)}/postgres`;
      for (const name of compared.databases ?? [])
        expect(await queryAs(server, "select 1 from pg_database where datname = $1", [name])).toEqual([]);
    },
    LONG,
  );
});
