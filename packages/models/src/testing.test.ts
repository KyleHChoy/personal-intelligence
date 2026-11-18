import { type EvidenceId, ModelRequest } from "@intelligence/contracts";
import { REJECTED_LENGTH } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { ModelClientError, ModelOutputRejected } from "./client/errors.ts";
import { fakeDecideClient, fakeKeyedCallStore, fakeModelClient } from "./test-support/fakes.ts";
import * as real from "./test-support/support.ts";

const evidence = "e".repeat(64) as EvidenceId;
const other = "f".repeat(64) as EvidenceId;
const label = ModelRequest.parse({
  promptId: "p",
  promptVersion: "1",
  data: {},
  label: { compartments: ["own"], readers: ["m-owner"] },
  trustGroup: "t",
}).label;
const at = "2026-03-04T10:00:00Z";

const request = (evidenceId: EvidenceId, inputHash = "a".repeat(64)): ModelRequest =>
  ModelRequest.parse({
    promptId: "personal_correspondence",
    promptVersion: "1",
    data: { message: "{}" },
    label,
    trustGroup: "personal-openrouter",
    callKey: {
      evidenceId,
      revision: 0,
      extractorGeneration: 0,
      promptId: "personal_correspondence",
      promptVersion: "1",
      inputHash,
    },
  });

const claim = {
  type: "commitment",
  subject: { key: { kind: "address", value: "alex@example.com" }, observedAt: at },
  fields: { what: "I will send the report." },
  statementKind: "stated_fact",
  basis: "explicit_self",
  span: "body:0",
};
const output = { claims: [claim], narrowing: "none" };
const empty = { claims: [], narrowing: "none" };

async function rejection(promise: Promise<unknown>): Promise<ModelOutputRejected> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(ModelOutputRejected);
  return error as ModelOutputRejected;
}

describe("fakeModelClient", () => {
  it("the fake answers by evidence id and records the call", async () => {
    const calls: string[] = [];
    const client = fakeModelClient({ [evidence]: output }, calls);
    const asked = request(evidence);
    const response = await client.complete(asked);
    expect(response).toEqual({ output, label, usage: { inputTokens: 0, outputTokens: 0, cost: 0 }, modelId: "fake" });
    // The label is the request's own, copied by code.
    expect(response.label).toBe(asked.label);
    expect(calls).toEqual([evidence]);
    await client.complete(request(evidence));
    expect(calls).toEqual([evidence, evidence]);
  });

  it("an output keyed by evidence id and input hash answers that input alone, and the evidence id's own output answers the rest", async () => {
    const first = "1".repeat(64);
    const second = "2".repeat(64);
    const client = fakeModelClient({ [`${evidence}/${first}`]: output, [evidence]: empty });
    expect((await client.complete(request(evidence, first))).output).toEqual(output);
    expect((await client.complete(request(evidence, second))).output).toEqual(empty);
  });

  it("the fake rejects an output the shared InterpreterOutput refuses, with its JSON as the raw text", async () => {
    const reserved = {
      claims: [{ ...claim, fields: { what: "x", label: { compartments: ["public"] } } }],
      narrowing: "none",
    };
    const unknown = { ...empty, extra: true };
    const client = fakeModelClient({ [evidence]: reserved, [other]: unknown });
    expect((await rejection(client.complete(request(evidence)))).rawOutput).toBe(JSON.stringify(reserved));
    expect((await rejection(client.complete(request(other)))).rawOutput).toBe(JSON.stringify(unknown));
  });

  it("the fake rejects a string output with that string as the raw text", async () => {
    const client = fakeModelClient({ [evidence]: REJECTED_LENGTH });
    expect((await rejection(client.complete(request(evidence)))).rawOutput).toBe(REJECTED_LENGTH);
  });

  it("the fake is unavailable for an id it has no output for", async () => {
    const calls: string[] = [];
    const client = fakeModelClient({ [evidence]: empty }, calls);
    const error = await client.complete(request(other)).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ModelClientError);
    expect(error).not.toBeInstanceOf(ModelOutputRejected);
    expect((error as ModelClientError).code).toBe("unavailable");
    expect(calls).toEqual([other]);
    // A request with no call key names no item, so nothing answers it.
    const { callKey: _none, ...keyless } = request(evidence);
    expect(
      ((await client.complete(keyless as ModelRequest).catch((thrown: unknown) => thrown)) as ModelClientError).code,
    ).toBe("unavailable");
  });

  it("the fake embeds nothing", async () => {
    const error = await fakeModelClient({})
      .embed({} as never)
      .catch((thrown: unknown) => thrown);
    expect((error as ModelClientError).code).toBe("bad_purpose");
  });
});

describe("the fake and the real client", () => {
  it("the fake and the real client accept and reject the same outputs", async () => {
    const good = real.OUTPUT;
    const [first] = good.claims;
    const reserved = {
      claims: [{ ...first, fields: { what: "x", label: { compartments: ["public"] } } }],
      narrowing: "none",
    };
    const unknown = { ...good, extra: true };
    const notAnObject = [good];
    const sameRaw = async (fakeOutput: unknown, body: Record<string, unknown>): Promise<string> => {
      const fakeError = await rejection(fakeModelClient({ [real.evidenceId]: fakeOutput }).complete(real.request()));
      const { model } = real.client([{ body }]);
      const realError = await rejection(model.complete(real.request()));
      expect(realError.rawOutput).toBe(fakeError.rawOutput);
      return realError.rawOutput;
    };

    // The positive control: both accept the good output, and answer the same output.
    const { model } = real.client([{ body: real.answer({ content: JSON.stringify(good) }) }]);
    expect((await model.complete(real.request())).output).toEqual(
      (await fakeModelClient({ [real.evidenceId]: good }).complete(real.request())).output,
    );

    for (const output of [reserved, unknown, notAnObject]) {
      expect(await sameRaw(output, real.answer({ content: JSON.stringify(output) }))).toBe(JSON.stringify(output));
    }
    expect(await sameRaw(REJECTED_LENGTH, real.answer({ finish: "length" }))).toBe(REJECTED_LENGTH);
  });
});

describe("fakeDecideClient", () => {
  const screen = { human_written: 0.9, special_category: 0.05, quarantine: 0.01 };
  // A request of `promptId`, with a call key for `evidenceId` or none.
  const decideModel = (promptId: string, evidenceId?: EvidenceId, inputHash = "a".repeat(64)): ModelRequest => {
    const { callKey, ...rest } = request(evidenceId ?? evidence, inputHash);
    return evidenceId === undefined ? { ...rest, promptId } : { ...rest, promptId, callKey: { ...callKey!, promptId } };
  };
  const unavailable = async (promise: Promise<unknown>) => {
    const error = await promise.catch((thrown: unknown) => thrown);
    expect(error).not.toBeInstanceOf(ModelOutputRejected);
    expect((error as ModelClientError).code).toBe("unavailable");
  };

  it("jev_screen: answers by evidence id, then by evidence id and input hash, and records each call", async () => {
    const calls: string[] = [];
    const first = "1".repeat(64);
    const client = fakeDecideClient(
      { [evidence]: screen, [`${evidence}/${first}`]: { ...screen, quarantine: 0.95 } },
      calls,
    );
    const response = await client.complete(decideModel("jev_screen", evidence));
    expect(response).toEqual({
      output: screen,
      label,
      usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
      modelId: "fake",
    });
    expect((await client.complete(decideModel("jev_screen", evidence, first))).output).toEqual({
      ...screen,
      quarantine: 0.95,
    });
    expect(calls).toEqual([evidence, evidence]);
  });

  it("jev_screen: rejects a string with that string, and an output DecideScreenOutput refuses with its JSON", async () => {
    const out = { ...screen, quarantine: 2 };
    const client = fakeDecideClient({ [evidence]: "rejected:by_test", [other]: out });
    expect((await rejection(client.complete(decideModel("jev_screen", evidence)))).rawOutput).toBe("rejected:by_test");
    expect((await rejection(client.complete(decideModel("jev_screen", other)))).rawOutput).toBe(JSON.stringify(out));
  });

  it("jev_screen: unavailable for an id it has no output for and for a request with no call key; embeds nothing", async () => {
    await unavailable(fakeDecideClient({}).complete(decideModel("jev_screen", evidence)));
    await unavailable(fakeDecideClient({ jev_screen: screen }).complete(decideModel("jev_screen")));
    expect(
      (
        (await fakeDecideClient({})
          .embed({} as never)
          .catch((thrown: unknown) => thrown)) as ModelClientError
      ).code,
    ).toBe("bad_purpose");
  });

  it("another prompt: answers by prompt and evidence id with input hash, then prompt and evidence id, then prompt alone", async () => {
    const calls: string[] = [];
    const first = "1".repeat(64);
    const outputs = {
      [`jev_recovery:${evidence}/${first}`]: { account_recovery: 0.9 },
      [`jev_recovery:${evidence}`]: { account_recovery: 0.5 },
      jev_recovery: { account_recovery: 0.1 },
      [evidence]: screen,
    };
    const client = fakeDecideClient(outputs, calls);
    expect((await client.complete(decideModel("jev_recovery", evidence, first))).output).toEqual({
      account_recovery: 0.9,
    });
    expect((await client.complete(decideModel("jev_recovery", evidence))).output).toEqual({ account_recovery: 0.5 });
    expect((await client.complete(decideModel("jev_recovery", other))).output).toEqual({ account_recovery: 0.1 });
    expect((await client.complete(decideModel("jev_recovery"))).output).toEqual({ account_recovery: 0.1 });
    expect(calls).toEqual([
      `jev_recovery:${evidence}`,
      `jev_recovery:${evidence}`,
      `jev_recovery:${other}`,
      "jev_recovery",
    ]);
    // The screen's unprefixed outputs never answer another prompt.
    await unavailable(fakeDecideClient({ [evidence]: screen }).complete(decideModel("jev_record", evidence)));
  });

  it("another prompt: parsed by its own schema; a string or a refused output is a rejection; an unknown prompt is unavailable", async () => {
    const client = fakeDecideClient({
      jev_record: { quarantine: 0.2 },
      jev_identity: { same_person: 0.7 },
      [`jev_identity:${evidence}`]: screen,
      [`jev_record:${evidence}`]: "rejected:by_test",
      test_other: { quarantine: 0.2 },
    });
    expect((await client.complete(decideModel("jev_record"))).output).toEqual({ quarantine: 0.2 });
    expect((await client.complete(decideModel("jev_identity"))).output).toEqual({ same_person: 0.7 });
    expect((await rejection(client.complete(decideModel("jev_identity", evidence)))).rawOutput).toBe(
      JSON.stringify(screen),
    );
    expect((await rejection(client.complete(decideModel("jev_record", evidence)))).rawOutput).toBe("rejected:by_test");
    await unavailable(client.complete(decideModel("test_other")));
    await unavailable(fakeDecideClient({}).complete(decideModel("jev_identity")));
  });
});

describe("fakeKeyedCallStore", () => {
  const key = {
    point: "identity_name_only",
    version: 1,
    promptId: "jev_identity",
    promptVersion: "1",
    subject: `pair:${"1".repeat(64)}:${"2".repeat(64)}`,
    inputHash: "a".repeat(64),
  };
  const record = {
    key,
    rawOutput: "{}",
    outputHash: "b".repeat(64),
    refs: ["r"],
    compartments: ["own"],
    modelId: "fake",
  };

  it("finds a record by its whole key, and returns copies from records()", async () => {
    const store = fakeKeyedCallStore();
    await store.save(record);
    expect(await store.find({ ...key })).toEqual(record);
    expect(await store.find({ ...key, version: 2 })).toBeNull();
    store.records()[0]!.refs.push("changed");
    expect(store.records()).toEqual([record]);
    expect(await fakeKeyedCallStore([record]).find(key)).toEqual(record);
  });
});
