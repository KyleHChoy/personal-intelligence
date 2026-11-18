import type { EvidenceId } from "@intelligence/contracts";
import { type ModelClient, ModelClientError } from "@intelligence/personal-models";
import { fakeModelClient } from "@intelligence/personal-models/testing";
import { describe, expect, it } from "vitest";
import { REASK_SUFFIX } from "./reask-prompt.ts";
import { runExtraction } from "./run.ts";
import { processOne, processRecord, type Setup, setup, withDecideModel } from "./test-support/support.ts";

// A request refusal belongs to its item, while authentication failures still stop the run.
// The intake preserves existing owner-confirmed claims by deferring instead of finalizing it;
// a re-ask's request refusal leaves the first answer intact.

const refused = (status: string): Error => Object.assign(new ModelClientError("refused"), { status });
const failing = (error: Error): ModelClient => ({
  complete: () => Promise.reject(error),
  embed: () => Promise.reject(error),
});

const AWAY = () => new ModelClientError("unavailable");
const ITEM_REFUSED = () => refused("http_400");
const KEY_REFUSED = () => refused("http_401");
const OTHER = () => new Error("store_gone");

type End = "throws" | { status: string; code?: string };
const ended = async (run: () => Promise<{ status: string; code?: string }>): Promise<End> => {
  try {
    const { status, code } = await run();
    return { status, ...(code === undefined ? {} : { code }) };
  } catch {
    return "throws";
  }
};

const WAITS_NO_ATTEMPT = { status: "waiting", code: "model_unavailable" };
const WAITS = { status: "waiting", code: "commit_failed" };

const recordOf = (s: Setup, kind: "finding" | "proposal", body: string, output: unknown): EvidenceId => {
  const at = new Date(Date.parse(s.w.now) - 3_600_000).toISOString();
  const id = s.store.putRecord({ client: "alpha", kind, body, recordedAt: at as never, cites: [] });
  s.store.outputs[id] = output;
  return id;
};

const STATEMENT = JSON.stringify({
  statement: "The owner prefers meetings before 10am",
  quote: "I like to meet before ten",
  kind: "need",
});
const PREFERS = {
  type: "preference",
  subject: { key: { kind: "address", value: "someone@example.org" }, observedAt: "2026-10-01T00:00:00Z" },
  fields: { domain: "career", object: "meetings before 10am", polarity: "prefers" },
  statementKind: "stated_fact",
  basis: "third_party",
  span: "chars:0-10",
};

describe("how a model error ends an item", () => {
  it("a message's call", async () => {
    const end = async (error: Error) => {
      const s = await setup();
      s.deps.model = failing(error);
      return ended(() => processOne(s, s.w.handles.planMessageId));
    };
    expect(await end(AWAY())).toEqual(WAITS_NO_ATTEMPT);
    expect(await end(ITEM_REFUSED())).toEqual({ status: "failed", code: "model_refused_item" });
    expect(await end(KEY_REFUSED())).toBe("throws");
    expect(await end(OTHER())).toEqual(WAITS);
  });

  it.each(["http_400", "http_413", "http_422"])(
    "a finding's call: a refusal of its request fails only the item (%s)",
    async (status) => {
      const end = async (error: Error) => {
        const s = await setup();
        const id = recordOf(s, "finding", "Nora will send the lease by Friday.", { claims: [], narrowing: "none" });
        s.deps.model = failing(error);
        return ended(() => processRecord(s, id));
      };
      expect(await end(AWAY())).toEqual(WAITS_NO_ATTEMPT);
      expect(await end(refused(status))).toEqual({ status: "failed", code: "model_refused_item" });
      expect(await end(KEY_REFUSED())).toBe("throws");
      expect(await end(OTHER())).toEqual(WAITS);
    },
  );

  it("a finding too long to send is skipped, and a schema's refusal fails it", async () => {
    const s = await setup();
    const long = recordOf(s, "finding", "word ".repeat(20_000), { claims: [], narrowing: "none" });
    s.deps.model = fakeModelClient(s.store.outputs, s.calls);
    expect(await ended(() => processRecord(s, long))).toEqual({ status: "skipped", code: "too_long" });
    const bad = recordOf(s, "finding", "A record the model answers badly.", "rejected:by_test");
    s.deps.model = fakeModelClient(s.store.outputs, s.calls);
    expect(await ended(() => processRecord(s, bad))).toEqual({ status: "failed", code: "interpret_failed" });
  });

  it.each(["http_400", "http_413", "http_422"])("a statement's call: as a finding's (%s)", async (status) => {
    const end = async (error: Error) => {
      const s = await setup();
      const id = recordOf(s, "proposal", STATEMENT, { claims: [PREFERS], narrowing: "none" });
      s.deps.model = failing(error);
      return ended(() => processRecord(s, id));
    };
    expect(await end(AWAY())).toEqual(WAITS_NO_ATTEMPT);
    expect(await end(refused(status))).toEqual({ status: "failed", code: "model_refused_item" });
    expect(await end(OTHER())).toEqual(WAITS);
  });

  it.each(["http_400", "http_413", "http_422"])(
    "the claim intake's check: its own failure waits with an attempt, never final (%s)",
    async (status) => {
      const end = async (error: Error) => {
        const s = await setup();
        const id = recordOf(s, "proposal", STATEMENT, { claims: [PREFERS], narrowing: "none" });
        s.deps.model = fakeModelClient(s.store.outputs, s.calls);
        withDecideModel(s);
        const decideModel = s.deps.decideModel;
        if (decideModel === undefined) throw new Error("no decide model");
        s.deps.decideModel = { ...decideModel, model: failing(error) };
        return ended(() => processRecord(s, id));
      };
      expect(await end(AWAY())).toEqual(WAITS_NO_ATTEMPT);
      expect(await end(new ModelClientError("bad_record"))).toEqual({ status: "waiting", code: "interpret_failed" });
      expect(await end(refused(status))).toEqual({ status: "waiting", code: "model_refused_item" });
      expect(await end(OTHER())).toEqual(WAITS);
    },
  );

  it("an intake request refusal preserves previously extracted claims", async () => {
    const s = await setup();
    const id = recordOf(s, "proposal", STATEMENT, { claims: [PREFERS], narrowing: "none" });
    s.deps.model = fakeModelClient(s.store.outputs, s.calls);
    expect(await processRecord(s, id)).toMatchObject({ status: "done" });
    const before = s.store.claims().filter((one) => one.evidenceId === id);
    expect(before.length).toBeGreaterThan(0);
    withDecideModel(s);
    const decideModel = s.deps.decideModel;
    if (decideModel === undefined) throw new Error("no decide model");
    s.deps.decideModel = { ...decideModel, model: failing(refused("http_413")) };
    expect(await processRecord(s, id)).toMatchObject({ status: "waiting", code: "model_refused_item" });
    expect(s.store.claims().filter((one) => one.evidenceId === id)).toEqual(before);
  });

  it("an item refusal does not block later records and is not bought again on the next run", async () => {
    const s = await setup();
    const refusedId = recordOf(s, "finding", "Nora will send the lease by Friday.", { claims: [], narrowing: "none" });
    const other = recordOf(s, "finding", "The owner wants meetings before ten.", { claims: [], narrowing: "none" });
    const model = fakeModelClient(s.store.outputs, s.calls);
    let requests = 0;
    s.deps.model = {
      complete: (request) => {
        if (request.callKey?.evidenceId === refusedId) {
          requests += 1;
          return Promise.reject(refused("http_422"));
        }
        return model.complete(request);
      },
      embed: model.embed,
    };
    await runExtraction(s.deps);
    expect(s.calls).toContain(other);
    await runExtraction(s.deps);
    expect(requests).toBe(1);
  });

  it("a re-ask: a failure or a refusal of its request leaves the first answer", async () => {
    const end = async (error: Error) => {
      const s = await setup();
      s.deps.reask = true;
      const id = s.w.handles.planMessageId;
      const evidence = s.store.evidenceIdOf(id);
      const output = structuredClone(s.store.outputs[evidence]) as { claims: { fields: object }[]; narrowing: string };
      const first = fakeModelClient({
        ...s.store.outputs,
        [evidence]: {
          ...output,
          claims: output.claims.map((claim) => ({
            ...claim,
            fields: { ...claim.fields, what: "Lunch at the station is booked for everyone" },
          })),
        },
      });
      s.deps.model = {
        complete: (request) =>
          request.promptId.endsWith(REASK_SUFFIX) ? Promise.reject(error) : first.complete(request),
        embed: (request) => first.embed(request),
      };
      return ended(() => processOne(s, id));
    };
    expect(await end(AWAY())).toEqual(WAITS_NO_ATTEMPT);
    expect(await end(ITEM_REFUSED())).toEqual({ status: "done" });
    expect(await end(KEY_REFUSED())).toBe("throws");
    expect(await end(OTHER())).toEqual(WAITS);
    expect(await end(new ModelClientError("bad_record"))).toEqual({ status: "done" });
  });
});
