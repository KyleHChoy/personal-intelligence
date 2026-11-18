import { createHash } from "node:crypto";
import type { ModelRequest, ModelResponse } from "@intelligence/contracts";
import { DecideIdentityOutput, type KeyedCallRecord, type KeyedCallStore } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import type { ModelClient } from "./client/client.ts";
import { ModelClientError, ModelOutputRejected } from "./client/errors.ts";
import { type Prompt, promptTextHash } from "./client/prompts.ts";
import { completeKeyedWithReplay } from "./keyed-replay.ts";
import { fakeKeyedCallStore } from "./test-support/fakes.ts";
import { request as baseRequest, label, thrown } from "./test-support/support.ts";

// completeKeyedWithReplay, on a hand-written client and the in-memory store. The prompt is a test's
// own with the identity point's schema.

const entry = (prompt: Omit<Prompt, "textHash">): Prompt =>
  Object.freeze({ ...prompt, textHash: promptTextHash(prompt) });
const PROMPT = entry({
  id: "test_identity",
  version: "1",
  instructions: JSON.stringify({ same_person: { type: "noul", instructions: "Are these one person?" } }),
  slots: ["pair"],
  outputSchemaId: "JevIdentityOutput",
  outputSchema: DecideIdentityOutput,
  tools: "none",
});
const TOOLED = entry({ ...PROMPT, id: "test_identity_tooled", tools: "allowed" });
const REGISTRY: readonly Prompt[] = Object.freeze([PROMPT, TOOLED]);

const A = "1".repeat(64);
const B = "2".repeat(64);
const CANARY = "canary-name-Quillon";
const CALL = {
  point: "identity_name_only",
  version: 1,
  subject: `pair:${A}:${B}`,
  refs: [A, B],
  modelId: "typesafe/jev-1.13",
};
const COMPARTMENTS = ["own"];

const request = (
  pair: unknown = { a: { name: CANARY }, b: { name: "Q. Example" } },
  overrides: Record<string, unknown> = {},
): ModelRequest =>
  baseRequest({
    promptId: PROMPT.id,
    promptVersion: PROMPT.version,
    data: { pair: JSON.stringify(pair) },
    callKey: undefined,
    ...overrides,
  });

// A client that answers from a script, one output per call; a string is a rejection with that raw text.
const scripted = (outputs: readonly unknown[]) => {
  const sent: ModelRequest[] = [];
  const client: ModelClient = {
    async complete(req): Promise<ModelResponse> {
      const output = outputs[Math.min(sent.length, outputs.length - 1)];
      sent.push(req);
      if (typeof output === "string") throw new ModelOutputRejected(output);
      return {
        output,
        label: req.label,
        usage: { inputTokens: 40, outputTokens: 1, cost: 0.00001 },
        modelId: "typesafe/jev-1.13",
      };
    },
    async embed() {
      throw new ModelClientError("bad_purpose");
    },
  };
  return { client, sent };
};

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const code = (error: unknown): string => (error as ModelClientError).code;

describe("completeKeyedWithReplay", () => {
  it("makes one call per key, sends the request as given, and replays after with nothing sent", async () => {
    const { client, sent } = scripted([{ same_person: 0.9 }]);
    const store = fakeKeyedCallStore();
    const first = await completeKeyedWithReplay(client, store, request(), CALL, COMPARTMENTS, REGISTRY);
    expect(first.output).toEqual({ same_person: 0.9 });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.callKey).toBeUndefined();
    const again = await completeKeyedWithReplay(client, store, request(), CALL, COMPARTMENTS, REGISTRY);
    expect(again).toEqual({
      output: { same_person: 0.9 },
      label,
      usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
      modelId: "replay",
    });
    expect(sent).toHaveLength(1);
    const [record] = store.records();
    expect(store.records()).toHaveLength(1);
    expect(record).toEqual({
      key: {
        point: CALL.point,
        version: 1,
        promptId: PROMPT.id,
        promptVersion: "1",
        subject: CALL.subject,
        inputHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
      rawOutput: '{"same_person":0.9}',
      outputHash: sha('{"same_person":0.9}'),
      refs: [A, B],
      compartments: ["own"],
      modelId: "typesafe/jev-1.13",
    });
  });

  it("a key whose input changed is a miss: a second call", async () => {
    const { client, sent } = scripted([{ same_person: 0.9 }, { same_person: 0.2 }]);
    const store = fakeKeyedCallStore();
    await completeKeyedWithReplay(client, store, request(), CALL, COMPARTMENTS, REGISTRY);
    const changed = await completeKeyedWithReplay(
      client,
      store,
      request({ a: { name: "Other" }, b: { name: "Q. Example" } }),
      CALL,
      COMPARTMENTS,
      REGISTRY,
    );
    expect(changed.output).toEqual({ same_person: 0.2 });
    expect(sent).toHaveLength(2);
    expect(new Set(store.records().map((one) => one.key.inputHash)).size).toBe(2);
  });

  it("a record the store returns for another key is a miss", async () => {
    const { client, sent } = scripted([{ same_person: 0.9 }]);
    const inner = fakeKeyedCallStore();
    await completeKeyedWithReplay(client, inner, request(), CALL, COMPARTMENTS, REGISTRY);
    const [saved] = inner.records();
    const wrong: KeyedCallStore = {
      find: async () => (saved === undefined ? null : { ...saved, key: { ...saved.key, version: 2 } }),
      save: async () => {},
    };
    await completeKeyedWithReplay(client, wrong, request(), CALL, COMPARTMENTS, REGISTRY);
    expect(sent).toHaveLength(2);
  });

  it("a saved record whose output hash does not match is refused, with nothing sent", async () => {
    const { client, sent } = scripted([{ same_person: 0.9 }]);
    const store = fakeKeyedCallStore();
    await completeKeyedWithReplay(client, store, request(), CALL, COMPARTMENTS, REGISTRY);
    const [saved] = store.records() as [KeyedCallRecord];
    const tampered = fakeKeyedCallStore([{ ...saved, rawOutput: '{"same_person":0.1}' }]);
    expect(code(await thrown(completeKeyedWithReplay(client, tampered, request(), CALL, COMPARTMENTS, REGISTRY)))).toBe(
      "bad_record",
    );
    expect(sent).toHaveLength(1);
  });

  it("a rejection is saved and replays as a rejection with no second call", async () => {
    for (const output of ["rejected:by_test", { same_person: 1.5 }]) {
      const { client, sent } = scripted([output]);
      const store = fakeKeyedCallStore();
      expect(
        await thrown(completeKeyedWithReplay(client, store, request(), CALL, COMPARTMENTS, REGISTRY)),
      ).toBeInstanceOf(ModelOutputRejected);
      expect(store.records()).toHaveLength(1);
      expect(
        await thrown(completeKeyedWithReplay(client, store, request(), CALL, COMPARTMENTS, REGISTRY)),
      ).toBeInstanceOf(ModelOutputRejected);
      expect(sent).toHaveLength(1);
    }
  });

  it("a rejected text that the schema would accept is saved with a marker, so it replays as a rejection", async () => {
    const { client, sent } = scripted(['{"same_person":0.5}']);
    const store = fakeKeyedCallStore();
    expect(
      await thrown(completeKeyedWithReplay(client, store, request(), CALL, COMPARTMENTS, REGISTRY)),
    ).toBeInstanceOf(ModelOutputRejected);
    expect(store.records()[0]?.rawOutput).toBe('rejected:not_by_schema {"same_person":0.5}');
    expect(
      await thrown(completeKeyedWithReplay(client, store, request(), CALL, COMPARTMENTS, REGISTRY)),
    ).toBeInstanceOf(ModelOutputRejected);
    expect(sent).toHaveLength(1);
  });

  it("no rendered input is stored", async () => {
    for (const output of [{ same_person: 0.9 }, "rejected:by_test"]) {
      const { client } = scripted([output]);
      const store = fakeKeyedCallStore();
      await completeKeyedWithReplay(client, store, request(), CALL, COMPARTMENTS, REGISTRY).catch(() => undefined);
      expect(store.records()).toHaveLength(1);
      expect(JSON.stringify(store.records())).not.toContain(CANARY);
    }
  });

  it("a bad subject, empty compartments, bad refs, no model id, a call key and tools are refused before any call", async () => {
    const { client, sent } = scripted([{ same_person: 0.9 }, { same_person: 0.9 }, { same_person: 0.9 }]);
    const store = fakeKeyedCallStore();
    const ulid = "01JABCDEFGHJKMNPQRSTVWXYZ0";
    const subjects = [
      `pair:${B}:${A}`,
      `pair:${A}:${A}`,
      `pair:${A}:${"F".repeat(64)}`,
      `pair:${A.slice(1)}:${B}`,
      `draft:drf_${ulid.toLowerCase()}`,
      `draft:drf_${ulid.slice(1)}`,
      `draft:drf_${ulid.slice(1)}I`,
      `evidence:${A}`,
      // A fact pair is two fact key fingerprints, sorted, as a pair's are.
      `facts:${B}:${A}`,
      `facts:${A}:${A}`,
      `facts:${A}`,
      "",
    ];
    for (const subject of subjects) {
      expect(
        code(
          await thrown(completeKeyedWithReplay(client, store, request(), { ...CALL, subject }, COMPARTMENTS, REGISTRY)),
        ),
        subject,
      ).toBe("bad_key");
    }
    expect(code(await thrown(completeKeyedWithReplay(client, store, request(), CALL, [], REGISTRY)))).toBe("bad_key");
    // Refs the store's check would refuse, after a paid call that could then never be replayed.
    for (const refs of [[], Array.from({ length: 101 }, (_, n) => `r${n}`), ["has space"], ["x".repeat(129)]]) {
      expect(
        code(
          await thrown(completeKeyedWithReplay(client, store, request(), { ...CALL, refs }, COMPARTMENTS, REGISTRY)),
        ),
        String(refs.length),
      ).toBe("bad_key");
    }
    expect(
      code(
        await thrown(
          completeKeyedWithReplay(client, store, request(), { ...CALL, modelId: "" }, COMPARTMENTS, REGISTRY),
        ),
      ),
    ).toBe("bad_key");
    const callKey = {
      evidenceId: "e".repeat(64),
      revision: 0,
      extractorGeneration: 0,
      promptId: PROMPT.id,
      promptVersion: "1",
      inputHash: "a".repeat(64),
    };
    expect(
      code(
        await thrown(
          completeKeyedWithReplay(client, store, request(undefined, { callKey }), CALL, COMPARTMENTS, REGISTRY),
        ),
      ),
    ).toBe("bad_key");
    const tools = [{ name: "get_entity", description: "Reads an entity.", argsSchema: { type: "object" } }];
    for (const promptId of [PROMPT.id, TOOLED.id]) {
      const tooled = { ...request(), promptId, tools } as ModelRequest;
      expect(
        code(await thrown(completeKeyedWithReplay(client, store, tooled, CALL, COMPARTMENTS, REGISTRY))),
        promptId,
      ).toBe("tools_not_allowed");
    }
    expect(sent).toHaveLength(0);
    expect(store.records()).toEqual([]);

    // The positive controls: a sorted pair, a sorted fact pair and a draft id are taken.
    await completeKeyedWithReplay(client, store, request(), CALL, COMPARTMENTS, REGISTRY);
    await completeKeyedWithReplay(
      client,
      store,
      request(),
      { ...CALL, subject: `facts:${A}:${B}` },
      COMPARTMENTS,
      REGISTRY,
    );
    await completeKeyedWithReplay(
      client,
      store,
      request(),
      { ...CALL, subject: `draft:drf_${ulid}` },
      COMPARTMENTS,
      REGISTRY,
    );
    expect(sent).toHaveLength(3);
  });
});
