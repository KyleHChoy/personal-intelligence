import type { EvidenceId, ModelRequest } from "@intelligence/contracts";
import type { PersonalPipelineStore } from "@intelligence/contracts/personal";
import { type ModelClient, ModelClientError, withBudget } from "@intelligence/personal-models";
import { fakeDecideClient, fakeModelClient } from "@intelligence/personal-models/testing";
import { describe, expect, it } from "vitest";
import { EXTRACT_GENERATION } from "./config.ts";
import { exposing } from "./exposing.ts";
import { processItem } from "./process-item.ts";
import {
  DECIDE_MODEL_ID,
  dueOf,
  MODEL_ID,
  NEUTRAL,
  processOne,
  recording,
  type Setup,
  setup,
  withDecideModel,
} from "./test-support/support.ts";

// The model route's half of the vendor exposure record: `exposing` notes an item's exposure, and
// the note commits, before the request is sent; a replay, a call the budget refuses and a note that
// fails send nothing and note nothing that was not sent. On the memory store and the fakes.

// The order things happen in: each note and each send, by what it carried.
type Step =
  | { kind: "note"; modelId: string; promptId: string; ids: string[] }
  | { kind: "send"; promptId: string; evidenceId: string | undefined };

// The store, with each note it is asked for kept in `steps` once it has been written.
function watchedStore(s: Setup, steps: Step[]): Pick<PersonalPipelineStore, "noteExposure"> {
  return {
    async noteExposure(modelId, promptId, ids) {
      const written = await s.store.noteExposure(modelId, promptId, ids);
      steps.push({ kind: "note", modelId, promptId, ids: [...ids] });
      return written;
    },
  };
}

// A vendor client that keeps each request it is sent in `steps` before passing it on.
const sending = (inner: ModelClient, steps: Step[]): ModelClient => ({
  complete(request) {
    steps.push({ kind: "send", promptId: request.promptId, evidenceId: request.callKey?.evidenceId });
    return inner.complete(request);
  },
  embed: (request) => inner.embed(request),
});

// A vendor that is away: every request fails after it has left.
const away: ModelClient = {
  complete: () => Promise.reject(new ModelClientError("unavailable")),
  embed: () => Promise.reject(new ModelClientError("unavailable")),
};

// The extract model, wrapped as `pi extract` wraps it: exposing innermost, around the vendor client.
function exposed(s: Setup, steps: Step[], vendor: ModelClient = fakeModelClient(s.store.outputs, s.calls)): void {
  s.deps.model = exposing(sending(recording(vendor, s.requests), steps), watchedStore(s, steps), MODEL_ID);
}

const notes = (steps: Step[]): Step[] => steps.filter((step) => step.kind === "note");

describe("exposing", () => {
  it("a live call notes its exposure before the request: a fetch that throws still leaves the row", async () => {
    const s = await setup();
    const steps: Step[] = [];
    exposed(s, steps, away);
    const id = s.store.evidenceIdOf(s.w.handles.planMessageId);
    const outcome = await processOne(s, s.w.handles.planMessageId);
    expect(outcome).toMatchObject({ status: "waiting", code: "model_unavailable", live: false });
    const [request] = s.requests;
    if (request === undefined) throw new Error("no request was sent");
    expect(steps).toEqual([
      { kind: "note", modelId: MODEL_ID, promptId: request.promptId, ids: [id] },
      { kind: "send", promptId: request.promptId, evidenceId: id },
    ]);
    expect(s.store.exposures()).toEqual([
      { modelId: MODEL_ID, promptId: request.promptId, evidenceId: id, day: s.w.now.slice(0, 10) },
    ]);
  });

  it("a call that is answered is noted once, before it is sent, under the item's evidence id and the prompt's id", async () => {
    const s = await setup();
    const steps: Step[] = [];
    exposed(s, steps);
    const id = s.store.evidenceIdOf(s.w.handles.planMessageId);
    expect(await processOne(s, s.w.handles.planMessageId)).toMatchObject({ status: "done", live: true });
    expect(steps.map((step) => step.kind)).toEqual(["note", "send"]);
    expect(s.store.exposures().map((one) => one.evidenceId)).toEqual([id]);
  });

  it("a replayed call notes nothing", async () => {
    const s = await setup();
    const steps: Step[] = [];
    exposed(s, steps);
    expect(await processOne(s, s.w.handles.planMessageId)).toMatchObject({ status: "done", live: true });
    // A new generation makes the item due again and replays its saved call.
    s.deps.generation = EXTRACT_GENERATION + 1;
    const before = steps.length;
    expect(await processOne(s, s.w.handles.planMessageId)).toMatchObject({ status: "done", live: false });
    expect(steps.slice(before)).toEqual([]);
    expect(s.calls).toHaveLength(1);
  });

  it("a call the budget refuses notes nothing", async () => {
    const s = await setup();
    const steps: Step[] = [];
    exposed(s, steps);
    s.deps.model = withBudget(s.deps.model, {
      spentRun: () => 0,
      spentDay: async () => 0,
      costMissing: () => false,
      runMicroUsd: 1,
      dayMicroUsd: 1,
      maxCalls: 0,
    });
    await expect(processOne(s, s.w.handles.planMessageId)).rejects.toMatchObject({ code: "budget_reached" });
    expect(steps).toEqual([]);
    expect(s.store.exposures()).toEqual([]);
  });

  it("a failed note makes no request and defers the item", async () => {
    const s = await setup();
    const steps: Step[] = [];
    exposed(s, steps);
    s.store.failNotes();
    const outcome = await processOne(s, s.w.handles.planMessageId);
    expect(outcome).toMatchObject({ status: "waiting", code: "model_unavailable", live: false });
    expect(s.requests).toEqual([]);
    expect(s.calls).toEqual([]);
    expect(s.store.item(s.store.evidenceIdOf(s.w.handles.planMessageId))?.status).toMatchObject({
      status: "waiting",
      code: "model_unavailable",
    });
  });

  it("a request with no call key, or one the store does not hold, is never sent", async () => {
    const s = await setup();
    const steps: Step[] = [];
    const client = exposing(
      sending(fakeModelClient(s.store.outputs, s.calls), steps),
      watchedStore(s, steps),
      MODEL_ID,
    );
    const request = {
      promptId: "personal_correspondence",
      promptVersion: "1",
      data: {},
      label: { compartments: ["own"], readers: ["owner"] },
      trustGroup: "personal-openrouter",
    } as unknown as ModelRequest;
    await expect(client.complete(request)).rejects.toMatchObject({ code: "bad_key" });
    const unknown = {
      ...request,
      callKey: {
        evidenceId: "f".repeat(64) as EvidenceId,
        revision: 0,
        extractorGeneration: 0,
        promptId: "personal_correspondence",
        promptVersion: "1",
        inputHash: "0".repeat(64),
      },
    } as ModelRequest;
    await expect(client.complete(unknown)).rejects.toMatchObject({ code: "unavailable" });
    // An embedding carries text too, and names no item: it is refused.
    await expect(client.embed({} as never)).rejects.toMatchObject({ code: "bad_purpose" });
    expect(steps).toEqual([]);
  });

  it("Jev's and Luna's clients are both wrapped: each call is noted under its own model id and prompt", async () => {
    const s = await setup();
    const steps: Step[] = [];
    exposed(s, steps);
    withDecideModel(s);
    const decideModel = s.deps.decideModel;
    if (decideModel === undefined) throw new Error("Jev is on");
    s.deps.decideModel = {
      ...decideModel,
      model: exposing(sending(decideModel.model, steps), watchedStore(s, steps), DECIDE_MODEL_ID),
    };
    const id = s.store.evidenceIdOf(s.w.handles.planMessageId);
    expect(await processItem(await dueOf(s.store, s.w.handles.planMessageId), s.deps)).toMatchObject({
      status: "done",
      live: true,
    });
    const extractModel = s.requests[0]?.promptId;
    expect(steps).toEqual([
      { kind: "note", modelId: DECIDE_MODEL_ID, promptId: "jev_recovery", ids: [id] },
      { kind: "send", promptId: "jev_recovery", evidenceId: id },
      { kind: "note", modelId: DECIDE_MODEL_ID, promptId: "jev_screen", ids: [id] },
      { kind: "send", promptId: "jev_screen", evidenceId: id },
      { kind: "note", modelId: MODEL_ID, promptId: extractModel, ids: [id] },
      { kind: "send", promptId: extractModel, evidenceId: id },
    ]);
  });

  it("a Jev request refused for want of a zero-retention endpoint and sent again without zdr has its exposure row written before the first send, once", async () => {
    // The zero-retention retry is the decide-model client's own, inside it: two sends for one call. The
    // client here stands in for it. The first decide-model call of an item is the recovery screen's.
    const s = await setup();
    const steps: Step[] = [];
    const inner = fakeDecideClient({ [s.store.evidenceIdOf(s.w.handles.planMessageId)]: NEUTRAL });
    const retrying: ModelClient = {
      async complete(request) {
        steps.push({ kind: "send", promptId: `${request.promptId}`, evidenceId: request.callKey?.evidenceId });
        steps.push({ kind: "send", promptId: `${request.promptId}`, evidenceId: request.callKey?.evidenceId });
        return inner.complete(request);
      },
      embed: (request) => inner.embed(request),
    };
    withDecideModel(s);
    const decideModel = s.deps.decideModel;
    if (decideModel === undefined) throw new Error("Jev is on");
    s.deps.decideModel = { ...decideModel, model: exposing(retrying, watchedStore(s, steps), DECIDE_MODEL_ID) };
    s.deps.model = fakeModelClient(s.store.outputs, s.calls);
    await processOne(s, s.w.handles.planMessageId);
    const decideSteps = steps.filter((step) => step.promptId === "jev_recovery");
    expect(decideSteps.map((step) => step.kind)).toEqual(["note", "send", "send"]);
  });

  it("an agent record's finding is noted under its own evidence id", async () => {
    const s = await setup();
    const steps: Step[] = [];
    const body = "nora.vance@example.org will send the signed lease by Friday.";
    const id = s.store.putRecord({ client: "alpha", kind: "finding", body });
    s.store.outputs[id] = { claims: [], narrowing: "none" };
    exposed(s, steps);
    const due = (await s.store.due(1000, 1)).find((one) => one.evidenceId === id);
    if (due === undefined) throw new Error("not due");
    await processItem(due, s.deps);
    expect(notes(steps)).toEqual([{ kind: "note", modelId: MODEL_ID, promptId: "personal_agent_record", ids: [id] }]);
  });
});
