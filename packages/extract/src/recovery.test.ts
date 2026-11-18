import type { DueItem, EmailDueItem } from "@intelligence/contracts/personal";
import { ModelClientError } from "@intelligence/personal-models";
import { describe, expect, it } from "vitest";
import { DEFAULT_THRESHOLDS, runThresholds } from "./decision-points.ts";
import { processItem } from "./process-item.ts";
import { screenRecoveryBacklog } from "./recovery.ts";
import { runExtraction } from "./run.ts";
import {
  dueOf,
  NEUTRAL,
  NO_RECOVERY,
  processOne,
  recordsOf,
  type Setup,
  setup,
  withDecideModel,
} from "./test-support/support.ts";

// The recovery screen, on the memory store with fakeDecideClient. The store's own side (the
// function's locks, a re-derive, a later revision) is in the store's database tests.

const recovery = (p: number) => ({ account_recovery: p });
const statusOf = (s: Setup, gmailId: string) => s.store.item(s.store.evidenceIdOf(gmailId))?.status;
const triageOf =
  (row: Partial<EmailDueItem["triage"]>) =>
  (due: DueItem): DueItem =>
    due.source === "email" ? { ...due, triage: { ...due.triage, ...row } } : due;
const runDue = async (s: Setup, gmailId: string, change: (due: DueItem) => DueItem) =>
  processItem(change(await dueOf(s.store, gmailId)), s.deps);

describe("the recovery screen in processItem", () => {
  it("account_recovery 0.75 holds the message, writes no status row, and neither Jev's screen nor Luna is called", async () => {
    const s = await setup();
    const id = s.w.handles.planMessageId;
    withDecideModel(s, { [`jev_recovery:${id}`]: recovery(0.75) });
    expect(await processOne(s, id)).toMatchObject({ status: "held", claims: 0, live: true });
    expect(statusOf(s, id)).toBeUndefined();
    expect(s.store.item(s.store.evidenceIdOf(id))).toMatchObject({
      held: true,
      modelHold: true,
      recoveryScreened: true,
    });
    expect(s.decideCalls).toEqual([]);
    expect(s.otherDecideCalls).toEqual([`jev_recovery:${s.store.evidenceIdOf(id)}`]);
    expect(s.calls).toEqual([]);
    expect((await s.store.due(1000, 1)).some((one) => one.evidenceId === s.store.evidenceIdOf(id))).toBe(false);
  });

  it("at 0.69 the item goes on to Jev's screen and Luna, marked and not held", async () => {
    const s = await setup();
    const id = s.w.handles.planMessageId;
    withDecideModel(s, { [`jev_recovery:${id}`]: recovery(0.69) });
    expect(await processOne(s, id)).toMatchObject({ status: "done", claims: 1 });
    expect(s.decideCalls).toEqual([s.store.evidenceIdOf(id)]);
    expect(s.store.item(s.store.evidenceIdOf(id))).toMatchObject({ held: false, recoveryScreened: true });
    expect(s.store.marks()).toEqual([{ evidenceId: s.store.evidenceIdOf(id), hold: false, held: false }]);
  });

  it("the run's recovery line applies: a grant of 0.6 holds an answer of 0.65", async () => {
    const s = await setup();
    const id = s.w.handles.planMessageId;
    withDecideModel(s, { [`jev_recovery:${id}`]: recovery(0.65) });
    s.deps.thresholds = runThresholds(
      { "extract_recovery@1": { hold: { value: 0.6, source: "thr_01J0000000000000000000000A" } } },
      [],
    );
    expect(await processOne(s, id)).toMatchObject({ status: "held" });
  });

  it("a released message is not held again, whatever the replay answers, and goes on to Luna", async () => {
    const s = await setup();
    const id = s.w.handles.planMessageId;
    withDecideModel(s, { [`jev_recovery:${id}`]: recovery(0.99) });
    expect(await processOne(s, id)).toMatchObject({ status: "held" });
    s.store.release(s.store.evidenceIdOf(id));
    expect(await processOne(s, id)).toMatchObject({ status: "done", claims: 1 });
    expect(s.store.item(s.store.evidenceIdOf(id))).toMatchObject({ held: false });
    // The second recovery call was a replay.
    expect(s.otherDecideCalls).toHaveLength(1);
  });

  it("an item with no text is still called, on its subject, and then skipped no_text", async () => {
    const s = await setup();
    const id = s.w.handles.planMessageId;
    withDecideModel(s);
    expect(await runDue(s, id, triageOf({ chars: 0 }))).toMatchObject({ status: "skipped", code: "no_text" });
    expect(s.otherDecideCalls).toEqual([`jev_recovery:${s.store.evidenceIdOf(id)}`]);
    expect(s.decideCalls).toEqual([]);
    const [request] = s.decideRequests;
    expect(request?.promptId).toBe("jev_recovery");
    expect(JSON.parse(request?.data.message ?? "{}")).toHaveProperty("subject");
  });

  it("the owner's lane skip still gets the recovery call, and can be held", async () => {
    const s = await setup();
    const id = s.w.handles.planMessageId;
    withDecideModel(s, { [`jev_recovery:${id}`]: recovery(0.9) });
    expect(await runDue(s, id, (due) => ({ ...due, lane: "skip" }))).toMatchObject({ status: "held" });
    const t = await setup();
    withDecideModel(t);
    expect(await runDue(t, id, (due) => ({ ...due, lane: "skip" }))).toMatchObject({ status: "skipped" });
    expect(t.otherDecideCalls).toHaveLength(1);
    expect([...t.decideCalls, ...t.calls]).toEqual([]);
  });

  // The owner's release of a withheld item (`pi extract retry --override`) is a release: no
  // later answer holds it again.
  it("an item the owner released with --override is marked and not held, whatever Jev answers", async () => {
    const s = await setup();
    const id = s.w.handles.planMessageId;
    withDecideModel(s, { [`jev_recovery:${id}`]: recovery(0.99) });
    expect(await runDue(s, id, (due) => ({ ...due, override: true }))).toMatchObject({ status: "done" });
    expect(s.store.marks()).toEqual([{ evidenceId: s.store.evidenceIdOf(id), hold: false, held: false }]);
  });

  it("a mark refused because the item was rewritten since it was opened ends the item superseded, with no attempt", async () => {
    const s = await setup();
    const id = s.w.handles.planMessageId;
    withDecideModel(s);
    const store = s.deps.store;
    s.deps.store = {
      ...store,
      markRecovery: async () => Promise.reject(Object.assign(new Error("item_changed"), { code: "item_changed" })),
    };
    expect(await processOne(s, id)).toMatchObject({ status: "superseded" });
    expect(statusOf(s, id)).toBeUndefined();
  });

  it("no answer defers the item model_unavailable with no attempt and marks nothing", async () => {
    const s = await setup();
    const id = s.w.handles.planMessageId;
    withDecideModel(s, {}, null);
    expect(await processOne(s, id)).toMatchObject({ status: "waiting", code: "model_unavailable", live: false });
    expect(statusOf(s, id)).toMatchObject({ status: "waiting", attempts: 0 });
    expect(s.store.marks()).toEqual([]);
    expect(s.calls).toEqual([]);
  });

  it("a rejected recovery answer leaves the item waiting and unmarked", async () => {
    const s = await setup();
    const id = s.w.handles.planMessageId;
    withDecideModel(s, { [`jev_recovery:${id}`]: "rejected:by_test" });
    expect(await processOne(s, id)).toMatchObject({ status: "waiting", code: "interpret_failed", claims: 0 });
    expect(statusOf(s, id)).toMatchObject({ status: "waiting", attempts: 0 });
    expect(s.store.marks()).toEqual([]);
    expect(s.calls).toEqual([]);
  });

  it("with PI_DECIDE_MODEL unset no recovery call is made and every item ends as without the recovery screen", async () => {
    const s = await setup();
    const id = s.w.handles.planMessageId;
    expect(await processOne(s, id)).toMatchObject({ status: "done", claims: 1 });
    expect(s.store.marks()).toEqual([]);
    expect(s.store.item(s.store.evidenceIdOf(id))?.recoveryScreened).toBeUndefined();
  });

  it("turning the recovery screen on raises no generation: claim ids are the same with Jev on and off", async () => {
    const off = await setup();
    const on = await setup();
    withDecideModel(on);
    const id = off.w.handles.commitmentInboundMessageId;
    await processOne(off, id);
    await processOne(on, id);
    const ids = (s: Setup) =>
      recordsOf(s, id)
        .map((record) => record.claim.id)
        .sort();
    expect(ids(on).length).toBeGreaterThan(0);
    expect(ids(on)).toEqual(ids(off));
  });

  it("a mark that fails defers the item commit_failed, and the next run replays the saved call and holds it (crash between save and mark)", async () => {
    const s = await setup();
    const id = s.w.handles.planMessageId;
    withDecideModel(s, { [`jev_recovery:${id}`]: recovery(0.9) });
    const store = s.deps.store;
    let failing = true;
    s.deps.store = {
      ...store,
      markRecovery: async (evidenceId, hold) => {
        if (failing) throw new Error("connection lost");
        return store.markRecovery(evidenceId, hold);
      },
    };
    expect(await processOne(s, id)).toMatchObject({ status: "waiting", code: "commit_failed" });
    expect(s.store.item(s.store.evidenceIdOf(id))?.recoveryScreened).toBeUndefined();
    failing = false;
    expect(await processOne(s, id)).toMatchObject({ status: "held", live: false });
    expect(s.otherDecideCalls).toHaveLength(1);
  });
});

describe("the recovery backlog", () => {
  it("with the recovery screen turned on over an extracted world, every stored email item gets one recovery call over the runs, no status row changes, every claim id is unchanged, and a second pass sends nothing", async () => {
    const s = await setup();
    expect(await runExtraction(s.deps)).toMatchObject({ code: "ok" });
    const statuses = () =>
      Object.fromEntries(
        Object.keys(s.store.outputs)
          .map((id) => [id, s.store.item(id)?.status] as const)
          .filter(([, status]) => status !== undefined),
      );
    const before = statuses();
    const claimIds = s.store
      .claims()
      .map((one) => one.claim.id)
      .sort();
    withDecideModel(s);
    // The recovery pass alone: the first screen's backlog may move a lane, which is that screen's
    // work, not this one's.
    const counts = () => ({ ...(s.store.runs()[0]?.counts ?? ({} as never)) });
    for (let run = 0; run < 5; run += 1) expect(await screenRecoveryBacklog(s.deps, counts())).toBeUndefined();
    // Each stored item that is not held by the term list, one call each.
    const stored = Object.keys(s.store.outputs).filter(
      (id) => s.store.item(id) !== undefined && s.store.item(id)?.held === false,
    );
    expect(stored.length).toBeGreaterThan(10);
    for (const id of stored) expect(s.otherDecideCalls, id).toContain(`jev_recovery:${id}`);
    expect(new Set(s.otherDecideCalls).size).toBe(s.otherDecideCalls.length);
    expect(statuses()).toEqual(before);
    expect(
      s.store
        .claims()
        .map((one) => one.claim.id)
        .sort(),
    ).toEqual(claimIds);
    const calls = s.otherDecideCalls.length;
    await screenRecoveryBacklog(s.deps, counts());
    await runExtraction(s.deps);
    expect(s.otherDecideCalls).toHaveLength(calls);
  });

  it("a backlog request refusal leaves that item unmarked for retry and screens the other items", async () => {
    const s = await setup();
    await runExtraction(s.deps);
    const id = s.w.handles.planMessageId;
    withDecideModel(s);
    const decideModel = s.deps.decideModel;
    if (decideModel === undefined) throw new Error("no jev");
    let refused = 0;
    s.deps.decideModel = {
      ...decideModel,
      model: {
        complete: (request) => {
          if (request.promptId === "jev_recovery" && request.callKey?.evidenceId === s.store.evidenceIdOf(id)) {
            refused += 1;
            return Promise.reject(Object.assign(new ModelClientError("refused"), { status: "http_413" }));
          }
          return decideModel.model.complete(request);
        },
        embed: decideModel.model.embed,
      },
    };
    const counts = { ...(s.store.runs()[0]?.counts ?? ({} as never)) };
    await screenRecoveryBacklog(s.deps, counts);
    await screenRecoveryBacklog(s.deps, counts);
    expect(refused).toBe(2);
    expect(s.store.item(s.store.evidenceIdOf(id))?.recoveryScreened).not.toBe(true);
    expect(s.store.marks().some((one) => one.evidenceId !== s.store.evidenceIdOf(id))).toBe(true);
  });

  it("a rejected backlog answer stays unmarked and does not stop other items being screened", async () => {
    const s = await setup();
    await runExtraction(s.deps);
    const id = s.w.handles.planMessageId;
    withDecideModel(s, { [`jev_recovery:${id}`]: "rejected:by_test" });
    const counts = { ...(s.store.runs()[0]?.counts ?? ({} as never)) };
    await screenRecoveryBacklog(s.deps, counts);
    expect(s.store.item(s.store.evidenceIdOf(id))?.recoveryScreened).not.toBe(true);
    expect(s.store.marks().some((one) => one.evidenceId !== s.store.evidenceIdOf(id))).toBe(true);
  });

  it("a backlog item at or above the line is held, with no status row change", async () => {
    const s = await setup();
    await runExtraction(s.deps);
    const id = s.w.handles.planMessageId;
    const before = statusOf(s, id);
    withDecideModel(s, { [`jev_recovery:${id}`]: recovery(0.8) });
    await runExtraction(s.deps);
    expect(s.store.item(s.store.evidenceIdOf(id))).toMatchObject({ held: true, modelHold: true });
    expect(statusOf(s, id)).toEqual(before);
  });

  it("a run with Jev on records the thresholds it applied, and one with Jev off records none", async () => {
    const s = await setup();
    await runExtraction(s.deps);
    expect(s.store.runs()[0]?.thresholds).toBeUndefined();
    withDecideModel(s);
    await runExtraction(s.deps);
    expect(s.store.runs()[1]?.thresholds).toEqual(DEFAULT_THRESHOLDS.applied);
  });

  it("NEUTRAL screens and NO_RECOVERY answers change nothing an item ends as", () => {
    expect(NEUTRAL.quarantine).toBeLessThan(DEFAULT_THRESHOLDS.quarantine);
    expect(NO_RECOVERY.account_recovery).toBeLessThan(DEFAULT_THRESHOLDS.recovery);
  });
});
