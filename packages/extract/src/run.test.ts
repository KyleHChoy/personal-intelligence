import type { EvidenceId, ModelRequest } from "@intelligence/contracts";
import { PersonalLogEvent, REJECTED_LENGTH, type RunSummary } from "@intelligence/contracts/personal";
import { VENDOR_RETRY_BASE_MINUTES, VENDOR_RETRY_MAX } from "@intelligence/personal-core/planner";
import { world } from "@intelligence/personal-core/testing";
import { BudgetReached, HttpStatusError, type ModelClient, ModelClientError } from "@intelligence/personal-models";
import { fakeModelClient } from "@intelligence/personal-models/testing";
import { describe, expect, it } from "vitest";
import { EXTRACT_GENERATION } from "./config.ts";
import { DECIDE_SCREEN } from "./question-prompts.ts";
import { runExtraction } from "./run.ts";
import { memoryPipelineStore, OWNER_ENTITY } from "./test-support/memory-store.ts";
import { rebuildBeliefs } from "./test-support/rebuild.ts";
import {
  answering,
  changed,
  NEUTRAL,
  NOW,
  recording,
  recordsOf,
  type Setup,
  setup,
  withDecideModel,
} from "./test-support/support.ts";

const run = async (s: Setup): Promise<RunSummary> => {
  const summary = await runExtraction(s.deps);
  if (summary === "already_running") throw new Error("locked");
  return summary;
};

// The evidence ids a run asks the model about, in the order it asks: due, newest first, not skipped.
const asked = async (s: Setup): Promise<EvidenceId[]> =>
  (await s.store.due(1000, EXTRACT_GENERATION))
    .filter(
      (due) =>
        due.source === "email" &&
        !(due.triage.unreadable || due.triage.chars === 0) &&
        (due.triage.direction === "outbound" ||
          !due.triage.bulk ||
          due.triage.category === "updates" ||
          due.triage.category === "primary"),
    )
    .map((due) => due.evidenceId);

// The model throws for the requests `fail` names, and otherwise answers as the given client does.
const throwing = (inner: ModelClient, fail: (request: ModelRequest, n: number) => Error | undefined): ModelClient => {
  let n = 0;
  return {
    async complete(request) {
      n += 1;
      const error = fail(request, n);
      if (error !== undefined) throw error;
      return inner.complete(request);
    },
    embed: (request) => inner.embed(request),
  };
};

const statusOf = (s: Setup, id: EvidenceId) => s.store.item(id)?.status;

// The screen backlog's mark, and the decide model turned on with answers that keep every backlog item's lane (a
// bulk message is not human-written, any other is), over the given ones by Gmail id.
const DECIDE_KEY = { promptId: DECIDE_SCREEN.id, promptVersion: DECIDE_SCREEN.version };
const withKeptLanes = (
  s: Setup,
  backlog: { evidenceId: EvidenceId; triage: { bulk: boolean } }[],
  answers: Record<string, unknown> = {},
): void => {
  const kept = Object.fromEntries(
    backlog.map((one) => [
      s.store.item(one.evidenceId)?.gmailId ?? "",
      { ...NEUTRAL, human_written: one.triage.bulk ? 0.1 : 0.9 },
    ]),
  );
  withDecideModel(s, { ...kept, ...answers });
};

describe("runExtraction", () => {
  it("the world ends with its expected claims", async () => {
    const s = await setup();
    const summary = await run(s);
    expect(summary.code).toBe("ok");
    for (const [gmailId, expected] of Object.entries(s.w.expected.items)) {
      const status = s.store.item(s.store.evidenceIdOf(gmailId))?.status;
      expect([gmailId, status?.status, status?.code]).toEqual([gmailId, expected.status, expected.code]);
    }
    const owners = new Set(s.w.owner.addresses);
    for (const fact of s.w.expected.facts.both) {
      const records = recordsOf(s, fact.gmailId).filter(
        (one) => one.claim.content.type === fact.type && one.claim.statementKind === fact.statementKind,
      );
      expect([fact.gmailId, records.length]).toEqual([fact.gmailId, 1]);
      const [record] = records;
      expect(record?.claim.basis).toBe(fact.basis);
      expect(record?.disclosure).toEqual(fact.thirdParty ? ["third_party"] : []);
      expect(record?.claim.content.subject === OWNER_ENTITY).toBe(owners.has(fact.subject));
      for (const [name, value] of Object.entries(fact.fields)) {
        if (record?.fieldKinds[name] === "entity")
          expect(record.claim.content.fields[name] === OWNER_ENTITY).toBe(owners.has(value as string));
        else expect([name, record?.claim.content.fields[name]]).toEqual([name, value]);
      }
    }
    // The run writes no stored belief (every answer is computed when asked); the rebuild, kept for
    // the rollback, builds from what it committed the beliefs the world expects.
    expect(s.store.beliefs(["own"])).toEqual([]);
    expect(summary.counts.beliefs).toBe(0);
    const rebuilt = await rebuildBeliefs(s.deps);
    // The facts with a status are the beliefs a client cleared for both compartments reads, a
    // fact that shares another's belief counted once.
    const beliefsOf = (facts: typeof s.w.expected.facts.both) =>
      facts.filter((fact) => fact.status !== undefined && fact.sharesBeliefWith === undefined);
    const both = s.store.beliefs(["employer:example", "own"]);
    expect(both).toHaveLength(beliefsOf(s.w.expected.facts.both).length);
    expect(s.store.beliefs(["own"])).toHaveLength(beliefsOf(s.w.expected.facts.own).length);
    expect(
      s.store
        .beliefs(["own"])
        .filter((row) => row.belief.disputed)
        .map((row) => row.belief.kind),
    ).toEqual([]);
    expect(summary.counts.withheld).toBe(2);
    expect(rebuilt.beliefs).toBe(both.length + s.store.beliefs(["own"]).length);
  });

  it("a run that is refused its budget stops, and the item in hand is untouched", async () => {
    const s = await setup();
    const [firstAsked] = await asked(s);
    s.deps.model = throwing(s.deps.model, () => new BudgetReached("day"));
    const summary = await run(s);
    expect(summary.code).toBe("budget");
    expect(statusOf(s, firstAsked as EvidenceId)).toBeUndefined();
    expect(s.store.runs()).toEqual([summary]);
  });

  it("a refused model answer stops the run and leaves the item untouched", async () => {
    const s = await setup();
    const [firstAsked] = await asked(s);
    s.deps.model = throwing(s.deps.model, () => new ModelClientError("refused"));
    expect((await run(s)).code).toBe("model_refused");
    expect(statusOf(s, firstAsked as EvidenceId)).toBeUndefined();
  });

  it("a refusal about one item (400, 413, 422) ends that item failed, saves no call, and the run goes on", async () => {
    for (const status of [400, 413, 422]) {
      const s = await setup();
      const [first, ...rest] = await asked(s);
      s.deps.model = throwing(s.deps.model, (request) =>
        request.callKey?.evidenceId === first ? new HttpStatusError("refused", status) : undefined,
      );
      const summary = await run(s);
      expect(summary.code).toBe("ok");
      expect(summary.status).toBeUndefined();
      expect(statusOf(s, first as EvidenceId)).toMatchObject({ status: "failed", code: "model_refused_item" });
      expect(s.store.savedCalls().some((one) => one.record.key.evidenceId === first)).toBe(false);
      for (const id of rest) expect(statusOf(s, id)?.status).not.toBe("waiting");
      const line = s.log.lines.find(
        (one) => one.event.event === "extract_item_failed" && one.event.ids?.evidence === first,
      );
      expect(line).toEqual({
        level: "warn",
        event: {
          event: "extract_item_failed",
          code: "model_refused_item",
          status: `http_${status}`,
          ids: { evidence: first },
        },
      });
      expect(PersonalLogEvent.safeParse(line?.event).success).toBe(true);
    }
  });

  it("the fifth item-level refusal of a run ends it model_refused, with the status", async () => {
    const s = await setup();
    const ids = await asked(s);
    expect(ids.length).toBeGreaterThan(5);
    s.deps.model = throwing(s.deps.model, () => new HttpStatusError("refused", 400));
    const summary = await run(s);
    expect(summary).toMatchObject({ code: "model_refused", status: "http_400" });
    expect(summary.counts.failed).toBe(5);
    for (const id of ids.slice(0, 5))
      expect(statusOf(s, id)).toMatchObject({ status: "failed", code: "model_refused_item" });
    expect(statusOf(s, ids[5] as EvidenceId)).toBeUndefined();
    // The row holds the code and counts; the status is the log line's.
    expect(s.store.runs()).toEqual([{ code: "model_refused", counts: summary.counts }]);
    expect(s.log.lines.at(-1)?.event).toMatchObject({
      event: "extract_run",
      code: "model_refused",
      status: "http_400",
    });
    expect(PersonalLogEvent.safeParse(s.log.lines.at(-1)?.event).success).toBe(true);
  });

  it("a refusal about the key or the account (401, 402, 403, 404) ends the run at once, naming its status", async () => {
    for (const status of [401, 402, 403, 404]) {
      const s = await setup();
      const [first] = await asked(s);
      s.deps.model = throwing(s.deps.model, () => new HttpStatusError("refused", status));
      const summary = await run(s);
      expect(summary).toMatchObject({ code: "model_refused", status: `http_${status}` });
      expect(statusOf(s, first as EvidenceId)).toBeUndefined();
      expect(s.log.lines.at(-1)?.event).toMatchObject({
        event: "extract_run",
        code: "model_refused",
        status: `http_${status}`,
      });
    }
  });

  it("an outage after retries (429, 5xx) defers the item as before", async () => {
    for (const status of [429, 503]) {
      const s = await setup();
      const [first] = await asked(s);
      s.deps.model = throwing(s.deps.model, (request) =>
        request.callKey?.evidenceId === first ? new HttpStatusError("unavailable", status) : undefined,
      );
      expect((await run(s)).code).toBe("ok");
      expect(statusOf(s, first as EvidenceId)).toMatchObject({ status: "waiting", code: "model_unavailable" });
    }
  });

  it("five unavailable items in a row add no attempt, and one followed by an answer adds one", async () => {
    const s = await setup();
    const ids = await asked(s);
    s.deps.model = throwing(s.deps.model, () => new ModelClientError("unavailable"));
    const summary = await run(s);
    expect(summary.code).toBe("model_unavailable");
    expect(summary.counts.waiting).toBe(5);
    for (const id of ids.slice(0, 5))
      expect(statusOf(s, id)).toMatchObject({ status: "waiting", code: "model_unavailable", attempts: 0 });

    const other = await setup();
    const inner = other.deps.model;
    other.deps.model = throwing(inner, (request) =>
      request.callKey?.evidenceId === ids[0] ? new ModelClientError("unavailable") : undefined,
    );
    expect((await run(other)).code).toBe("ok");
    expect(statusOf(other, ids[0] as EvidenceId)).toMatchObject({ status: "waiting", attempts: 1 });
  });

  it("an item the vendor failed is taken again once its wait is over, with bounded tries; a content failure never is", async () => {
    let now = NOW;
    const later = (minutes: number) => (now = new Date(now.getTime() + minutes * 60_000));
    const store = await memoryPipelineStore(world({ now: NOW }), { now: () => now });
    const made = await setup({ store, model: fakeModelClient(store.outputs, []), now: () => now });
    const s: Setup = { ...made, store };
    const [away, cut] = await asked(s);
    answering(s, { [store.item(cut as EvidenceId)?.gmailId ?? ""]: REJECTED_LENGTH });
    const answers = s.deps.model;
    // The vendor is away for the first item until `back`; five attempts fail it.
    const back = false;
    s.deps.model = throwing(answers, (request) =>
      !back && request.callKey?.evidenceId === away ? new ModelClientError("unavailable") : undefined,
    );
    await run(s);
    await store.countAttempt(
      Array.from({ length: 4 }, () => away as EvidenceId),
      EXTRACT_GENERATION,
    );
    expect(statusOf(s, away as EvidenceId)).toMatchObject({ status: "failed", code: "model_unavailable" });
    expect(statusOf(s, cut as EvidenceId)).toMatchObject({ status: "failed", code: "cut_off" });

    // Before its wait is over nothing takes it.
    later(VENDOR_RETRY_BASE_MINUTES - 1);
    await run(s);
    expect(statusOf(s, away as EvidenceId)).toMatchObject({ status: "failed", vendorRetries: 1 });
    // Each retry that finds the vendor still away fails it again, twice as far out, until the tries are spent.
    for (let retry = 1; retry <= VENDOR_RETRY_MAX; retry += 1) {
      later(VENDOR_RETRY_BASE_MINUTES * 2 ** (retry - 1));
      await run(s);
      expect(statusOf(s, away as EvidenceId), `retry ${retry}`).toMatchObject({
        status: "waiting",
        vendorRetries: retry,
      });
      await store.countAttempt([away as EvidenceId], EXTRACT_GENERATION);
      expect(statusOf(s, away as EvidenceId)).toMatchObject({ status: "failed", code: "model_unavailable" });
    }
    expect(statusOf(s, away as EvidenceId)?.retryAt).toBeUndefined();
    later(60 * 24 * 30);
    await run(s);
    expect(statusOf(s, away as EvidenceId)).toMatchObject({ status: "failed", vendorRetries: VENDOR_RETRY_MAX });
    // The content failure was never taken again, whatever the time.
    expect(statusOf(s, cut as EvidenceId)).toMatchObject({ status: "failed", code: "cut_off" });
    expect(s.log.lines.filter((line) => line.event.event === "extract_retries_requeued")).toHaveLength(
      VENDOR_RETRY_MAX,
    );
  });

  it("an item the vendor failed is owed the retries the owner's lever sets, not the default", async () => {
    const store = await memoryPipelineStore(world({ now: NOW }), { levers: { "extract.vendor_retry_max": 0 } });
    const made = await setup({ store, model: fakeModelClient(store.outputs, []), now: () => NOW });
    const s: Setup = { ...made, store };
    const [away] = await asked(s);
    s.deps.model = throwing(s.deps.model, (request) =>
      request.callKey?.evidenceId === away ? new ModelClientError("unavailable") : undefined,
    );
    await run(s);
    await store.countAttempt(
      Array.from({ length: 4 }, () => away as EvidenceId),
      EXTRACT_GENERATION,
    );
    expect(statusOf(s, away as EvidenceId)).toMatchObject({
      status: "failed",
      code: "model_unavailable",
      vendorRetries: 0,
    });
    expect(statusOf(s, away as EvidenceId)?.retryAt).toBeUndefined();
  });

  it("a retried item the vendor answers ends done, its retries cleared", async () => {
    let now = NOW;
    const store = await memoryPipelineStore(world({ now: NOW }), { now: () => now });
    const made = await setup({ store, model: fakeModelClient(store.outputs, []), now: () => now });
    const s: Setup = { ...made, store };
    const [away] = await asked(s);
    const answers = s.deps.model;
    s.deps.model = throwing(answers, (request) =>
      request.callKey?.evidenceId === away ? new ModelClientError("unavailable") : undefined,
    );
    await run(s);
    await store.countAttempt(
      Array.from({ length: 4 }, () => away as EvidenceId),
      EXTRACT_GENERATION,
    );
    s.deps.model = answers;
    now = new Date(now.getTime() + VENDOR_RETRY_BASE_MINUTES * 60_000);
    await run(s);
    const status = statusOf(s, away as EvidenceId);
    expect(status?.status).not.toBe("failed");
    expect(status?.status).not.toBe("waiting");
    expect(status?.vendorRetries).toBeUndefined();
  });

  it("five cut-off items in a row do not stop the run", async () => {
    const s = await setup();
    const ids = (await asked(s)).slice(0, 5);
    const outputs: Record<string, unknown> = {};
    for (const id of ids) outputs[s.store.item(id)?.gmailId ?? ""] = REJECTED_LENGTH;
    answering(s, outputs);
    const summary = await run(s);
    expect(summary.code).toBe("ok");
    for (const id of ids) expect(statusOf(s, id)).toMatchObject({ status: "failed", code: "cut_off" });
  });

  it("a run writes its row last, with its code and counts, whatever stopped it", async () => {
    const cases: [RunSummary["code"], (s: Setup) => void][] = [
      ["ok", () => {}],
      [
        "budget",
        (s) => (s.deps.model = throwing(s.deps.model, (_r, n) => (n > 2 ? new BudgetReached("run") : undefined))),
      ],
      [
        "model_refused",
        (s) =>
          (s.deps.model = throwing(s.deps.model, (_r, n) => (n > 2 ? new ModelClientError("refused") : undefined))),
      ],
      [
        "cost_missing",
        (s) =>
          (s.deps.model = throwing(s.deps.model, (_r, n) => (n > 2 ? new BudgetReached("cost_missing") : undefined))),
      ],
      ["model_unavailable", (s) => (s.deps.model = throwing(s.deps.model, () => new ModelClientError("unavailable")))],
    ];
    for (const [code, arrange] of cases) {
      const s = await setup();
      arrange(s);
      const order: string[] = [];
      const store = s.deps.store;
      s.deps.store = {
        ...store,
        commit: (batch) => {
          order.push("commit");
          return store.commit(batch);
        },
        raiseSettledClaims: () => {
          order.push("raiseSettledClaims");
          return store.raiseSettledClaims();
        },
        recordRun: (summary) => {
          order.push("recordRun");
          return store.recordRun(summary);
        },
      };
      const summary = await run(s);
      expect(summary.code).toBe(code);
      expect(s.store.runs()).toEqual([summary]);
      expect(order.at(-1)).toBe("recordRun");
      // The settlement cards are the run's own step.
      expect(order).toContain("raiseSettledClaims");
      expect(summary.counts.beliefs).toBe(0);
      const line = s.log.lines.at(-1);
      expect(line?.event).toMatchObject({ event: "extract_run", code });
    }
  });

  // The after-commit diff, once a run, after the owner's need questions and the held-back
  // settlement cards and before the run's row; a failed pass is logged and the run goes on.
  it("a run passes the after-commit diff once, after its need questions and settlement cards, and a failed pass ends nothing", async () => {
    const s = await setup();
    const order: string[] = [];
    const store = s.deps.store;
    s.deps.store = {
      ...store,
      raiseNeedQuestions: (claimIds) => {
        order.push("raiseNeedQuestions");
        return store.raiseNeedQuestions(claimIds);
      },
      raiseSettledClaims: () => {
        order.push("raiseSettledClaims");
        return store.raiseSettledClaims();
      },
      triggerPass: () => {
        order.push("triggerPass");
        return (store.triggerPass as NonNullable<typeof store.triggerPass>)();
      },
      recordRun: (summary) => {
        order.push("recordRun");
        return store.recordRun(summary);
      },
    };
    expect((await run(s)).code).toBe("ok");
    expect(order).toEqual(["raiseNeedQuestions", "raiseSettledClaims", "triggerPass", "recordRun"]);
    expect(s.store.triggerPasses()).toBe(1);

    const failing = await setup();
    failing.deps.store = { ...failing.deps.store, triggerPass: () => Promise.reject(new Error("down")) };
    expect((await run(failing)).code).toBe("ok");
    expect(failing.log.lines.some((line) => line.event.event === "trigger_pass_failed")).toBe(true);
  });

  it("two store failures in a row end the run as store_unavailable, and nothing more is written", async () => {
    const s = await setup();
    s.store.failWrites();
    const summary = await run(s);
    expect(summary.code).toBe("store_unavailable");
    expect(s.store.runs()).toEqual([]);
    expect(s.store.beliefs(["own"])).toEqual([]);
    expect(s.log.lines.at(-1)).toMatchObject({
      level: "error",
      event: { event: "extract_run", code: "store_unavailable" },
    });

    const other = await setup();
    const store = other.deps.store;
    other.deps.store = { ...store, due: () => Promise.reject(new Error("down")) };
    expect((await run(other)).code).toBe("store_unavailable");
    expect(other.store.runs()).toEqual([]);
  });

  it("a held message makes no call and gets no row, and a released one is taken up", async () => {
    const s = await setup();
    const id = s.store.evidenceIdOf(s.w.handles.heldMessageId);
    await run(s);
    expect(s.calls).not.toContain(id);
    expect(statusOf(s, id)).toBeUndefined();
    s.store.release(id);
    await run(s);
    expect(s.calls).toContain(id);
    expect(statusOf(s, id)).toBeDefined();
  });

  it("a missing cost finishes its item and ends the run", async () => {
    const s = await setup();
    const [firstAsked, second] = await asked(s);
    s.deps.model = throwing(s.deps.model, (_r, n) => (n > 1 ? new BudgetReached("cost_missing") : undefined));
    const summary = await run(s);
    expect(summary.code).toBe("cost_missing");
    expect(statusOf(s, firstAsked as EvidenceId)?.status).not.toBe("waiting");
    expect(statusOf(s, firstAsked as EvidenceId)).toBeDefined();
    expect(statusOf(s, second as EvidenceId)).toBeUndefined();
  });

  it("a second run makes no call and writes nothing", async () => {
    const s = await setup();
    await run(s);
    const calls = [...s.calls];
    const claims = s.store.claims();
    const beliefs = s.store.beliefs(["own"]);
    const second = await run(s);
    expect(s.calls).toEqual(calls);
    expect(s.store.claims()).toEqual(claims);
    expect(s.store.beliefs(["own"])).toEqual(beliefs);
    expect(second.counts).toMatchObject({
      done: 0,
      skipped: 0,
      withheld: 0,
      failed: 0,
      waiting: 0,
      liveCalls: 0,
      beliefsChanged: 0,
    });
  });

  it("raising the generation replays every call", async () => {
    const s = await setup();
    const first = await run(s);
    const calls = [...s.calls];
    s.deps.generation = EXTRACT_GENERATION + 1;
    const second = await run(s);
    expect(s.calls).toEqual(calls);
    expect(second.counts.done).toBe(first.counts.done);
    expect(second.counts.liveCalls).toBe(0);
    expect(s.store.claims().every((one) => one.claim.extractorGeneration === EXTRACT_GENERATION + 1)).toBe(true);
  });

  it("raising the generation re-sends correspondence items and replays transaction items", async () => {
    // A first store's calls: the correspondence ones saved under version 1.
    const first = await setup();
    await run(first);
    const before = first.store.savedCalls();
    const lane = (record: (typeof before)[number]["record"]) => record.key.promptId;
    const older = await setup();
    for (const { record, modelId } of before) {
      const asV1 =
        lane(record) === "personal_correspondence" ? { ...record, key: { ...record.key, promptVersion: "1" } } : record;
      await older.store.calls(modelId).save(asV1);
    }
    await run(older);
    const correspondence = new Set(
      before.filter((one) => lane(one.record) === "personal_correspondence").map((one) => one.record.key.evidenceId),
    );
    const transaction = new Set(
      before.filter((one) => lane(one.record) === "personal_transaction").map((one) => one.record.key.evidenceId),
    );
    expect(correspondence.size).toBeGreaterThan(0);
    expect(transaction.size).toBeGreaterThan(0);
    // Every correspondence item is asked again, live; no transaction item is.
    expect(new Set(older.calls)).toEqual(correspondence);
  });

  it("a parse failure is a status, and the next item still runs", async () => {
    const s = await setup();
    const [firstAsked] = await asked(s);
    const gmailId = s.store.item(firstAsked as EvidenceId)?.gmailId ?? "";
    changed(s, gmailId, (message) => {
      message.text = `${"x".repeat(30_000)}\r\n`;
    });
    const summary = await run(s);
    expect(summary.code).toBe("ok");
    expect(statusOf(s, firstAsked as EvidenceId)).toMatchObject({ status: "failed", code: "parse_failed" });
    expect(summary.counts.done).toBeGreaterThan(0);
  });

  it("no item is taken up twice in one run", async () => {
    const s = await setup();
    const store = s.deps.store;
    const committed: string[] = [];
    // A store whose pages overlap: each page also holds the last item of the one before.
    let previous: Awaited<ReturnType<typeof store.due>> = [];
    s.deps.store = {
      ...store,
      async due(limit, generation, options) {
        const page = await store.due(limit, generation, options);
        const overlap = previous.slice(-1);
        previous = page;
        return page.length === 0 ? page : [...overlap, ...page];
      },
      commit: (batch) => {
        committed.push(batch.evidenceId);
        return store.commit(batch);
      },
    };
    await run(s);
    expect(new Set(committed).size).toBe(committed.length);
    expect(committed.length).toBeGreaterThan(50);
  });

  it("no log event holds a name, an address or claim text", async () => {
    const s = await setup();
    answering(s, { [s.w.handles.planMessageId]: REJECTED_LENGTH });
    await run(s);
    expect(s.log.lines.length).toBeGreaterThan(1);
    const text = JSON.stringify(s.log.lines);
    for (const line of s.log.lines) expect(PersonalLogEvent.safeParse(line.event).success).toBe(true);
    expect(text).not.toContain("@");
    for (const canary of Object.values(s.w.canaries)) expect(text).not.toContain(canary);
    expect(text).not.toContain(s.w.owner.name);
  });

  it("a need question or settlement step that throws is logged and ends nothing", async () => {
    const s = await setup();
    const store = s.deps.store;
    s.deps.store = {
      ...store,
      raiseNeedQuestions: () => Promise.reject(new Error("down")),
      raiseSettledClaims: () => Promise.reject(new Error("down")),
    };
    const summary = await run(s);
    expect(summary.code).toBe("ok");
    expect(s.store.runs()).toEqual([summary]);
    const events = s.log.lines.map((line) => line.event.event);
    expect(events).toContain("need_questions_failed");
    expect(events).toContain("settled_claims_failed");
  });

  describe("documents", () => {
    // Every model call of a document answers no claim; a message answers as the world records.
    const withDocuments = (s: Setup): void => {
      const outputs: Record<string, unknown> = { ...s.store.outputs };
      for (const doc of s.w.expected.documents) {
        try {
          outputs[s.store.documentEvidenceIdOf(doc.fileId)] = { claims: [], narrowing: "none" };
        } catch {
          // A file the world does not store.
        }
      }
      s.deps.model = recording(fakeModelClient(outputs, s.calls), s.requests);
    };
    const documentIds = (s: Setup): Set<string> =>
      new Set(s.w.expected.documents.flatMap((doc) => (doc.stored ? [s.store.documentEvidenceIdOf(doc.fileId)] : [])));

    it("with PI_EXTRACT_DOCUMENTS unset no document is due: a run takes none", async () => {
      const s = await setup();
      withDocuments(s);
      expect((await run(s)).code).toBe("ok");
      const docs = documentIds(s);
      expect(s.calls.filter((id) => docs.has(id))).toEqual([]);
      for (const id of docs) expect(s.store.document(id)?.status).toBeUndefined();
    });

    it("documents are taken only when no message is due, newest modified first, settled, and each once", async () => {
      const s = await setup({ documents: { days: 90 } });
      withDocuments(s);
      const docs = documentIds(s);
      expect((await run(s)).code).toBe("ok");
      const firstDocument = s.calls.findIndex((id) => docs.has(id));
      expect(firstDocument).toBeGreaterThan(0);
      // Every message the run asked about came before the first document.
      expect(s.calls.slice(firstDocument).every((id) => docs.has(id))).toBe(true);
      // The owner's documents in the lane, and no other: the reference one, the shared one and the
      // files that are not Google Docs made no call; the held one is not due.
      const sent = s.calls.slice(firstDocument);
      expect(new Set(sent).size).toBe(sent.length);
      const { referenceDocumentId, sharedDocumentId, heldDocumentId } = s.w.handles;
      for (const fileId of [referenceDocumentId, sharedDocumentId, heldDocumentId])
        expect(sent).not.toContain(s.store.documentEvidenceIdOf(fileId));
      expect(sent).toContain(s.store.documentEvidenceIdOf(s.w.documentCanaries.fileId));
      const modified = sent.map((id) => Date.parse(s.store.document(id)?.modifiedAt ?? ""));
      expect([...modified].sort((a, b) => b - a)).toEqual(modified);
      expect(s.store.document(s.store.documentEvidenceIdOf(referenceDocumentId))?.status).toMatchObject({
        status: "skipped",
        code: "reference",
      });
      expect(s.store.document(s.store.documentEvidenceIdOf(heldDocumentId))?.status).toBeUndefined();
      const before = s.calls.length;
      expect((await run(s)).code).toBe("ok");
      expect(s.calls.length).toBe(before);
    });

    it("a document modified inside the settle time is not taken, and is taken once it has settled", async () => {
      let now = new Date(NOW.getTime());
      const s = await setup({ documents: { days: 90 }, now: () => now });
      withDocuments(s);
      const fresh = await s.store.putDocument(
        "personal",
        {
          id: "1FreshDocument01",
          name: "Fresh plan",
          mimeType: "application/vnd.google-apps.document",
          createdTime: "2026-09-01T09:00:00.000Z",
          modifiedTime: new Date(NOW.getTime() - 30 * 60_000).toISOString(),
          parent: "f",
          root: "1CanaryFolderIdK4t9w2X8Qa",
          ownedByMe: true,
          modifiedByMe: true,
          canDownload: true,
        },
        { blocks: [{ kind: "paragraph", text: "A plan still being written." }] },
      );
      withDocuments(s);
      const outputs = { ...s.store.outputs, [fresh]: { claims: [], narrowing: "none" } };
      for (const id of documentIds(s)) outputs[id] = { claims: [], narrowing: "none" };
      s.deps.model = recording(fakeModelClient(outputs, s.calls), s.requests);
      await run(s);
      expect(s.calls).not.toContain(fresh);
      now = new Date(NOW.getTime() + 31 * 60_000);
      await run(s);
      expect(s.calls).toContain(fresh);
    });

    it("a budget reached on a document stops the run, and the document is due at the next", async () => {
      const s = await setup({ documents: { days: 90 } });
      withDocuments(s);
      const docs = documentIds(s);
      const inner = s.deps.model;
      s.deps.model = throwing(inner, (request) =>
        docs.has(request.callKey?.evidenceId ?? "") ? new BudgetReached("run") : undefined,
      );
      expect((await run(s)).code).toBe("budget");
      const canary = s.store.documentEvidenceIdOf(s.w.documentCanaries.fileId);
      expect(s.store.document(canary)?.status).toBeUndefined();
      s.deps.model = inner;
      expect((await run(s)).code).toBe("ok");
      expect(s.store.document(canary)?.status).toMatchObject({ status: "done", lane: "document" });
    });
  });
});

// The run with the decide model on.
describe("runExtraction with Jev", () => {
  it("five items Jev has no answer for, in a row, end the run model_unavailable", async () => {
    const s = await setup();
    withDecideModel(s, {}, null);
    const summary = await run(s);
    expect(summary.code).toBe("model_unavailable");
    expect(summary.counts.waiting).toBe(5);
    expect(s.calls).toEqual([]);
  });

  it("a Jev refusal ends the run model_refused, and a Jev budget stop ends it budget", async () => {
    for (const [error, code] of [
      [new ModelClientError("refused"), "model_refused"],
      [new BudgetReached("calls"), "budget"],
    ] as const) {
      const s = await setup();
      withDecideModel(s);
      const decideModel = s.deps.decideModel;
      if (decideModel === undefined) throw new Error("no jev");
      s.deps.decideModel = { ...decideModel, model: throwing(decideModel.model, () => error) };
      expect((await run(s)).code).toBe(code);
      expect(s.calls).toEqual([]);
    }
  });

  it("a Jev refusal about the key or the account ends the run naming its status, in the due pass and in the backlog", async () => {
    for (const backlog of [false, true]) {
      const s = await setup();
      if (backlog) {
        await run(s);
        withKeptLanes(s, await s.store.backlog(1000, EXTRACT_GENERATION, DECIDE_KEY));
      } else withDecideModel(s);
      const decideModel = s.deps.decideModel;
      if (decideModel === undefined) throw new Error("no jev");
      s.deps.decideModel = {
        ...decideModel,
        model: throwing(decideModel.model, () => new HttpStatusError("refused", 402)),
      };
      const summary = await run(s);
      expect([backlog, summary.code, summary.status]).toEqual([backlog, "model_refused", "http_402"]);
      expect(s.log.lines.at(-1)?.event).toMatchObject({
        event: "extract_run",
        code: "model_refused",
        status: "http_402",
      });
    }
  });

  it("a backlog Jev refusal about one item (400) leaves that item in the backlog, and the run goes on", async () => {
    const s = await setup();
    await run(s);
    const backlog = await s.store.backlog(1000, EXTRACT_GENERATION, DECIDE_KEY);
    const [first] = backlog;
    if (first === undefined) throw new Error("no backlog");
    const before = structuredClone(statusOf(s, first.evidenceId));
    withKeptLanes(s, backlog);
    const decideModel = s.deps.decideModel;
    if (decideModel === undefined) throw new Error("no jev");
    s.deps.decideModel = {
      ...decideModel,
      model: throwing(decideModel.model, (request) =>
        request.callKey?.evidenceId === first.evidenceId ? new HttpStatusError("refused", 400) : undefined,
      ),
    };
    const summary = await run(s);
    expect(summary.code).toBe("ok");
    expect(statusOf(s, first.evidenceId)).toEqual(before);
    expect((await s.store.backlog(1000, EXTRACT_GENERATION, DECIDE_KEY)).map((one) => one.evidenceId)).toEqual([
      first.evidenceId,
    ]);
  });

  it("the backlog pass screens each item done before Jev was on exactly once, writes no status row and changes no claim", async () => {
    const s = await setup();
    await run(s);
    const claims = s.store.claims();
    const backlog = await s.store.backlog(1000, EXTRACT_GENERATION, DECIDE_KEY);
    expect(backlog.length).toBeGreaterThan(50);
    const before = new Map(backlog.map((one) => [one.evidenceId, structuredClone(statusOf(s, one.evidenceId))]));
    withKeptLanes(s, backlog);
    const first = await run(s);
    expect(first.code).toBe("ok");
    expect([...s.decideCalls].sort()).toEqual(backlog.map((one) => one.evidenceId).sort());
    for (const [id, status] of before) expect(statusOf(s, id)).toEqual(status);
    expect(s.store.claims()).toEqual(claims);
    expect(s.store.claims().every((one) => one.claim.extractorGeneration === EXTRACT_GENERATION)).toBe(true);
    // A second run sends nothing: the saved call is the mark.
    const sent = [...s.decideCalls];
    await run(s);
    expect(s.decideCalls).toEqual(sent);
    expect(await s.store.backlog(1000, EXTRACT_GENERATION, DECIDE_KEY)).toEqual([]);
  });

  it("a claim id is the same with Jev on and off: turning Jev on, then off, raises no generation and changes no claim", async () => {
    const s = await setup();
    await run(s);
    const ids = s.store
      .claims()
      .map((one) => one.claim.id)
      .sort();
    const backlog = await s.store.backlog(1000, EXTRACT_GENERATION, DECIDE_KEY);
    withKeptLanes(s, backlog);
    await run(s);
    expect(
      s.store
        .claims()
        .map((one) => one.claim.id)
        .sort(),
    ).toEqual(ids);
    delete s.deps.decideModel;
    const calls = s.calls.length;
    const off = await run(s);
    expect(off.counts).toMatchObject({ done: 0, skipped: 0, withheld: 0, waiting: 0, liveCalls: 0 });
    expect(s.calls.length).toBe(calls);
    expect(
      s.store
        .claims()
        .map((one) => one.claim.id)
        .sort(),
    ).toEqual(ids);
  });

  it("a backlog withhold applies as narrow: the item is withheld and loses its claims, and no other item changes", async () => {
    const s = await setup();
    await run(s);
    const id = s.store.evidenceIdOf(s.w.handles.planMessageId);
    expect(recordsOf(s, s.w.handles.planMessageId).length).toBeGreaterThan(0);
    const others = s.store.claims().filter((one) => one.evidenceId !== id);
    withKeptLanes(s, await s.store.backlog(1000, EXTRACT_GENERATION, DECIDE_KEY), {
      [s.w.handles.planMessageId]: { ...NEUTRAL, quarantine: 0.95 },
    });
    const summary = await run(s);
    expect(statusOf(s, id)).toMatchObject({
      status: "withheld",
      code: "quarantine",
      withheld: true,
      generation: EXTRACT_GENERATION,
    });
    expect(recordsOf(s, s.w.handles.planMessageId)).toEqual([]);
    expect(s.store.claims()).toEqual(others);
    expect(summary.counts.withheld).toBe(1);
  });

  it("a withheld item stays withheld when Jev is turned off, and Luna is not asked about it", async () => {
    const s = await setup();
    await run(s);
    const plan = s.w.handles.planMessageId;
    withKeptLanes(s, await s.store.backlog(1000, EXTRACT_GENERATION, DECIDE_KEY), {
      [plan]: { ...NEUTRAL, special_category: 0.95 },
    });
    await run(s);
    // And one decide-model withheld when it was first stored, with the decide model on.
    const fresh = await setup();
    withDecideModel(fresh, { [fresh.w.handles.planMessageId]: { ...NEUTRAL, quarantine: 0.95 } });
    await run(fresh);
    for (const [one, gmailId, code] of [
      [s, plan, "sensitive"],
      [fresh, fresh.w.handles.planMessageId, "quarantine"],
    ] as const) {
      delete one.deps.decideModel;
      one.requests.length = 0;
      await run(one);
      const id = one.store.evidenceIdOf(gmailId);
      expect(statusOf(one, id)).toMatchObject({
        status: "withheld",
        code,
        withheld: true,
        generation: EXTRACT_GENERATION,
      });
      expect(one.requests.map((request) => request.callKey?.evidenceId)).not.toContain(id);
    }
  });

  it("a lane change makes the item due again, and it goes to Luna under the same generation", async () => {
    const s = await setup();
    await run(s);
    const backlog = await s.store.backlog(1000, EXTRACT_GENERATION, DECIDE_KEY);
    const bulk = backlog.find((one) => one.committedLane === "skip");
    if (bulk === undefined) throw new Error("no bulk item");
    const gmailId = s.store.item(bulk.evidenceId)?.gmailId ?? "";
    answering(s, { [gmailId]: { claims: [], narrowing: "none" } });
    withKeptLanes(s, backlog, { [gmailId]: NEUTRAL });
    const calls = s.calls.length;
    await run(s);
    expect(statusOf(s, bulk.evidenceId)).toMatchObject({
      status: "done",
      lane: "correspondence",
      generation: EXTRACT_GENERATION,
    });
    expect(s.calls.slice(calls)).toEqual([bulk.evidenceId]);
    // The decide model was asked once: the due pass replayed the backlog's saved call.
    expect(s.decideCalls.filter((one) => one === bulk.evidenceId)).toEqual([bulk.evidenceId]);
  });

  it("a backlog withhold whose commit fails is deferred, and the due pass withholds it from the saved call", async () => {
    const s = await setup();
    await run(s);
    const plan = s.w.handles.planMessageId;
    const id = s.store.evidenceIdOf(plan);
    withKeptLanes(s, await s.store.backlog(1000, EXTRACT_GENERATION, DECIDE_KEY), {
      [plan]: { ...NEUTRAL, quarantine: 0.95 },
    });
    s.store.failCommit(1);
    await run(s);
    expect(statusOf(s, id)).toMatchObject({ status: "withheld", code: "quarantine" });
    expect(s.decideCalls.filter((one) => one === id)).toEqual([id]);
  });

  it("a backlog withhold whose commit and defer both fail ends the run store_unavailable, and saves no call, so the item is screened again", async () => {
    const s = await setup();
    await run(s);
    const plan = s.w.handles.planMessageId;
    const id = s.store.evidenceIdOf(plan);
    const backlog = await s.store.backlog(1000, EXTRACT_GENERATION, DECIDE_KEY);
    // The plan message first, so it is the pass's first commit.
    withKeptLanes(s, backlog, { [plan]: { ...NEUTRAL, quarantine: 0.95 } });
    const store = s.deps.store;
    s.deps.store = {
      ...store,
      backlog: async (...args) =>
        (await store.backlog(...args)).sort((a, b) => (a.evidenceId === id ? -1 : b.evidenceId === id ? 1 : 0)),
      commit: () => Promise.reject(new Error("down")),
      defer: () => Promise.reject(new Error("down")),
    };
    expect((await run(s)).code).toBe("store_unavailable");
    expect(
      s.store
        .savedCalls()
        .filter((one) => one.record.key.evidenceId === id && one.record.key.promptId === DECIDE_KEY.promptId),
    ).toEqual([]);
    s.deps.store = store;
    await run(s);
    expect(statusOf(s, id)).toMatchObject({ status: "withheld", code: "quarantine" });
    expect(s.decideCalls.filter((one) => one === id)).toEqual([id, id]);
  });

  it("a backlog row the owner gave both a lane and a release is not returned, so it takes no place in the limit", async () => {
    const s = await setup();
    await run(s);
    const [both, releaseOnly] = Object.keys(s.store.outputs).filter(
      (id) => s.store.item(id)?.status?.status === "withheld",
    ) as EvidenceId[];
    if (both === undefined || releaseOnly === undefined) throw new Error("two withheld items wanted");
    s.store.override(both, "correspondence");
    s.store.override(releaseOnly);
    await run(s);
    for (const id of [both, releaseOnly]) expect(statusOf(s, id)?.status).toBe("done");
    const ids = (await s.store.backlog(1000, EXTRACT_GENERATION, DECIDE_KEY)).map((one) => one.evidenceId);
    expect(ids).not.toContain(both);
    expect(ids).toContain(releaseOnly);
  });

  it("Jev away during the backlog pass changes no status row, and the items are screened at a later run", async () => {
    const s = await setup();
    await run(s);
    const backlog = await s.store.backlog(1000, EXTRACT_GENERATION, DECIDE_KEY);
    const before = new Map(backlog.map((one) => [one.evidenceId, structuredClone(statusOf(s, one.evidenceId))]));
    withDecideModel(s, {}, null);
    await run(s);
    for (const [id, status] of before) expect(statusOf(s, id)).toEqual(status);
    withKeptLanes(s, backlog);
    await run(s);
    expect(await s.store.backlog(1000, EXTRACT_GENERATION, DECIDE_KEY)).toEqual([]);
  });

  it("every item withheld before Jev was on is still withheld after a run with Jev, whatever Jev answers, also when it is unavailable", async () => {
    for (const fallback of [{ ...NEUTRAL, human_written: 0.01 }, null]) {
      const s = await setup();
      await run(s);
      const withheld = Object.keys(s.store.outputs).filter((id) => s.store.item(id)?.status?.status === "withheld");
      expect(withheld.length).toBeGreaterThan(0);
      withDecideModel(s, {}, fallback);
      await run(s);
      for (const id of withheld)
        expect(s.store.item(id)?.status).toMatchObject({
          status: "withheld",
          withheld: true,
          generation: EXTRACT_GENERATION,
        });
    }
  });
});
