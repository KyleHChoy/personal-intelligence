import type { DueItem, EmailDueItem, OpenedItem } from "@intelligence/contracts/personal";
import { ModelClientError } from "@intelligence/personal-models";
import { describe, expect, it } from "vitest";
import { EXTRACT_GENERATION } from "./config.ts";
import { processItem } from "./process-item.ts";
import {
  answering,
  changed,
  DECIDE_MODEL_ID,
  dueOf,
  MODEL_ID,
  NEUTRAL,
  processOne,
  recordsOf,
  type Setup,
  setup,
  unmappedOf,
  withDecideModel,
} from "./test-support/support.ts";

type Output = {
  claims: { subject: unknown; fields: Record<string, unknown>; [key: string]: unknown }[];
  narrowing: string;
};
const outputOf = (s: Setup, gmailId: string): Output =>
  structuredClone(s.store.outputs[s.store.evidenceIdOf(gmailId)]) as Output;
const statusOf = (s: Setup, gmailId: string) => s.store.item(s.store.evidenceIdOf(gmailId))?.status;

// The identity port of the opened item, counting what it is asked.
const counting =
  (asked: string[]) =>
  (opened: OpenedItem): OpenedItem => ({
    ...opened,
    context: {
      ...opened.context,
      identity: {
        resolve: (mention, ...rest) => {
          asked.push(mention.key.value);
          return opened.context.identity.resolve(mention, ...rest);
        },
      },
    },
  });

describe("processItem", () => {
  it("a skipped item makes no call", async () => {
    const s = await setup();
    const outcome = await processOne(s, s.w.handles.forumsKeptMessageId);
    expect(outcome).toMatchObject({ status: "skipped", code: "bulk", live: false });
    expect(s.calls).toEqual([]);
    expect(statusOf(s, s.w.handles.forumsKeptMessageId)?.status).toBe("skipped");
  });

  it("a quarantine or special category item ends withheld before the check: no mention is resolved and nothing is written", async () => {
    const s = await setup();
    const { quarantineMessageId: quarantine, sensitiveMessageId: sensitive } = s.w.handles;
    const asked: string[] = [];
    changed(s, quarantine, () => {}, counting(asked));
    expect(await processOne(s, quarantine)).toMatchObject({
      status: "withheld",
      code: "quarantine",
      claims: 0,
      unmapped: 0,
    });
    expect(await processOne(s, sensitive)).toMatchObject({ status: "withheld", code: "sensitive" });
    expect(asked).toEqual([]);
    expect([...recordsOf(s, quarantine), ...unmappedOf(s, quarantine), ...recordsOf(s, sensitive)]).toEqual([]);
    expect(statusOf(s, quarantine)).toMatchObject({ withheld: true, screened: true });
  });

  it("an overridden item is processed once with its narrowing ignored, and a new revision is screened afresh", async () => {
    const s = await setup();
    const { quarantineMessageId: id } = s.w.handles;
    await processOne(s, id);
    s.store.override(s.store.evidenceIdOf(id));
    const due = await dueOf(s.store, id);
    expect(due.override).toBe(true);
    expect(await processItem(due, s.deps)).toMatchObject({ status: "done", claims: 1, live: false });
    expect(recordsOf(s, id)).toHaveLength(1);
    expect(statusOf(s, id)).toMatchObject({ status: "done", withheld: false, screened: true });
    expect(s.calls).toHaveLength(1);
    // A new revision has a status row of its own and no release: the saved answer withholds it.
    expect(await processItem({ ...due, override: false }, s.deps)).toMatchObject({
      status: "withheld",
      code: "quarantine",
    });
  });

  it("a released special_category item commits its claims labelled own alone", async () => {
    const s = await setup();
    const { sensitiveMessageId: id } = s.w.handles;
    const text = s.w.accounts[0]?.messages.find((one) => one.id === id)?.text?.trimEnd() ?? "";
    const due = await dueOf(s.store, id);
    const sender =
      s.w.accounts[0]?.messages
        .find((one) => one.id === id)
        ?.headers.find((one) => one.name === "From")
        ?.value.match(/<(.+)>/)?.[1] ?? "";
    const mention = (address: string) => ({ key: { kind: "address", value: address }, observedAt: due.sentAt });
    answering(s, {
      [id]: {
        claims: [
          {
            type: "commitment",
            subject: mention(sender),
            fields: { counterparty: mention("avery@quinn.test"), what: text },
            statementKind: "stated_fact",
            basis: "explicit_self",
            span: `chars:0-${text.length}`,
          },
        ],
        narrowing: "special_category",
      },
    });
    expect(await processOne(s, id)).toMatchObject({ status: "withheld", code: "sensitive" });
    s.store.override(due.evidenceId);
    expect(await processOne(s, id)).toMatchObject({ status: "done", claims: 1 });
    expect(recordsOf(s, id).map((one) => one.claim.label.compartments)).toEqual([["own"]]);
  });

  it("a released item run again under a new generation ignores its narrowing again", async () => {
    const s = await setup();
    const { quarantineMessageId: id } = s.w.handles;
    await processOne(s, id);
    s.store.override(s.store.evidenceIdOf(id));
    await processOne(s, id);
    s.deps.generation = EXTRACT_GENERATION + 1;
    expect(await processItem(await dueOf(s.store, id, EXTRACT_GENERATION + 1), s.deps)).toMatchObject({
      status: "done",
      claims: 1,
    });
    expect(s.calls).toHaveLength(1);
  });

  it("a retry without the override clears the release, and the item is withheld again", async () => {
    const s = await setup();
    const { quarantineMessageId: id } = s.w.handles;
    await processOne(s, id);
    s.store.override(s.store.evidenceIdOf(id));
    await processOne(s, id);
    s.store.retry(s.store.evidenceIdOf(id));
    expect((await dueOf(s.store, id)).override).toBe(false);
    expect(await processOne(s, id)).toMatchObject({ status: "withheld", code: "quarantine" });
    expect(recordsOf(s, id)).toEqual([]);
    expect(s.calls).toHaveLength(2);
  });

  it("participants only yields the claims that none yields", async () => {
    const plain = await setup();
    const s = await setup();
    const { planMessageId: id } = s.w.handles;
    const output = outputOf(s, id);
    output.narrowing = "participants_only";
    answering(s, { [id]: output });
    await processOne(plain, id);
    await processOne(s, id);
    expect(recordsOf(s, id)).toEqual(recordsOf(plain, id));
    expect(recordsOf(s, id)).toHaveLength(1);
  });

  it("a calls.save that throws ends the item commit_failed with an attempt, and the next run asks again", async () => {
    const s = await setup();
    const { planMessageId: id } = s.w.handles;
    s.store.failSave(1);
    expect(await processOne(s, id)).toMatchObject({ status: "waiting", code: "commit_failed", live: true });
    expect(statusOf(s, id)).toMatchObject({ status: "waiting", attempts: 1 });
    expect(await processOne(s, id)).toMatchObject({ status: "done", claims: 1 });
    expect(s.calls).toEqual([s.store.evidenceIdOf(id), s.store.evidenceIdOf(id)]);
  });

  it("an item with five attempts is failed until retried", async () => {
    const s = await setup();
    const { planMessageId: id } = s.w.handles;
    changed(
      s,
      id,
      () => {},
      (opened) => ({
        ...opened,
        context: { ...opened.context, identity: { resolve: () => Promise.reject(new Error("down")) } },
      }),
    );
    for (let attempt = 1; attempt <= 5; attempt += 1)
      expect(await processOne(s, id)).toMatchObject({ status: "waiting", code: "check_failed" });
    expect(statusOf(s, id)).toMatchObject({ status: "failed", code: "check_failed", attempts: 5 });
    await expect(dueOf(s.store, id)).rejects.toThrow("not due");
    s.store.retry(s.store.evidenceIdOf(id));
    expect((await dueOf(s.store, id)).attempts).toBe(0);
  });

  it("a retried item's new answer replaces its old claims", async () => {
    const s = await setup();
    const { planMessageId: id } = s.w.handles;
    await processOne(s, id);
    const [before] = recordsOf(s, id);
    s.store.retry(s.store.evidenceIdOf(id));
    const output = outputOf(s, id);
    output.claims[0] = { ...output.claims[0], statementKind: "decision" } as Output["claims"][number];
    answering(s, { [id]: output });
    await processOne(s, id);
    const after = recordsOf(s, id);
    expect(after).toHaveLength(1);
    expect(after[0]?.claim.id).not.toBe(before?.claim.id);
    expect(after[0]?.claim.statementKind).toBe("decision");
  });

  it("an item retried into the skip lane loses its claims at its next commit, and not before", async () => {
    const s = await setup();
    const { planMessageId: id } = s.w.handles;
    await processOne(s, id);
    s.store.retry(s.store.evidenceIdOf(id), "skip");
    expect(recordsOf(s, id)).toHaveLength(1);
    expect(await processOne(s, id)).toMatchObject({ status: "skipped" });
    expect(recordsOf(s, id)).toEqual([]);
  });

  it("a withheld item is committed with no claim and counted, under its code", async () => {
    const s = await setup();
    const { quarantineMessageId: id } = s.w.handles;
    expect(await processOne(s, id)).toMatchObject({ status: "withheld", code: "quarantine", claims: 0 });
    expect(statusOf(s, id)).toMatchObject({ status: "withheld", code: "quarantine" });
  });

  it("a parse failure is a status", async () => {
    const s = await setup();
    const { planMessageId: id } = s.w.handles;
    changed(s, id, (message) => {
      message.text = `${"x".repeat(30_000)}\r\n`;
    });
    expect(await processOne(s, id)).toMatchObject({ status: "failed", code: "parse_failed" });
    expect(s.calls).toEqual([]);
  });

  it("an item whose label is not its row's compartment fails at once, with no call", async () => {
    const s = await setup();
    const { planMessageId: id } = s.w.handles;
    const due = await dueOf(s.store, id);
    expect(await processItem({ ...due, compartments: ["employer:example"] }, s.deps)).toMatchObject({
      status: "failed",
      code: "parse_failed",
    });
    expect(statusOf(s, id)).toMatchObject({ status: "failed", attempts: 0 });
    expect(s.calls).toEqual([]);
  });
});

// The decide-model call before extraction, with fakeDecideClient.
describe("processItem with Jev", () => {
  const over = (p: number) => ({ ...NEUTRAL, quarantine: p, special_category: p });
  const extractPrompts = (s: Setup) => s.requests.map((request) => request.promptId);
  const runDue = async (s: Setup, gmailId: string, change: (due: DueItem) => DueItem) =>
    processItem(change(await dueOf(s.store, gmailId)), s.deps);
  const triageOf =
    (row: Partial<EmailDueItem["triage"]>) =>
    (due: DueItem): DueItem =>
      due.source === "email" ? { ...due, triage: { ...due.triage, ...row } } : due;

  it("quarantine 0.95 withholds quarantine and Luna is not called", async () => {
    const s = await setup();
    const id = s.w.handles.planMessageId;
    withDecideModel(s, { [id]: { ...NEUTRAL, quarantine: 0.95 } });
    expect(await processOne(s, id)).toMatchObject({ status: "withheld", code: "quarantine", live: true });
    expect(s.calls).toEqual([]);
    expect(s.decideCalls).toEqual([s.store.evidenceIdOf(id)]);
    expect(statusOf(s, id)).toMatchObject({ status: "withheld", withheld: true, generation: EXTRACT_GENERATION });
  });

  it("a claim id is the same with Jev on and off, for the same item and generation", async () => {
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
    expect(on.decideCalls).toEqual([on.store.evidenceIdOf(id)]);
    expect(ids(on).length).toBeGreaterThan(0);
    expect(ids(on)).toEqual(ids(off));
    expect(recordsOf(on, id).every((record) => record.claim.extractorGeneration === EXTRACT_GENERATION)).toBe(true);
  });

  it("special_category 0.95 withholds sensitive; with both over, quarantine wins; 0.69 on both goes on (the line is 0.7)", async () => {
    const s = await setup();
    const {
      planMessageId: plan,
      commitmentInboundMessageId: commitment,
      thirdPartyReversalMessageId: third,
    } = s.w.handles;
    withDecideModel(s, {
      [plan]: { ...NEUTRAL, special_category: 0.95 },
      [commitment]: over(0.95),
      [third]: over(0.69),
    });
    expect(await processOne(s, plan)).toMatchObject({ status: "withheld", code: "sensitive" });
    expect(await processOne(s, commitment)).toMatchObject({ status: "withheld", code: "quarantine" });
    expect(await processOne(s, third)).toMatchObject({ status: "done" });
    expect(s.calls).toEqual([s.store.evidenceIdOf(third)]);
  });

  it("an inbound bulk message with human_written 0.8 is correspondence and goes to Luna", async () => {
    const s = await setup();
    const id = s.w.handles.planMessageId;
    withDecideModel(s, { [id]: { ...NEUTRAL, human_written: 0.8 } });
    await runDue(s, id, triageOf({ bulk: true, category: "promotions" }));
    expect(extractPrompts(s)).toEqual(["personal_correspondence"]);
    expect(statusOf(s, id)).toMatchObject({ lane: "correspondence" });
  });

  it("a non-bulk inbound message with human_written 0.2 is transaction under Updates, and skip under Social", async () => {
    const s = await setup();
    const id = s.w.handles.planMessageId;
    withDecideModel(s, { [id]: { ...NEUTRAL, human_written: 0.2 } });
    await runDue(s, id, triageOf({ category: "updates" }));
    expect(extractPrompts(s)).toEqual(["personal_transaction"]);
    const t = await setup();
    withDecideModel(t, { [id]: { ...NEUTRAL, human_written: 0.2 } });
    expect(await runDue(t, id, triageOf({ category: "social" }))).toMatchObject({
      status: "skipped",
      code: "bulk",
      live: true,
    });
    expect(t.calls).toEqual([]);
  });

  it("an outbound message keeps correspondence whatever human_written says, and is still withheld on quarantine", async () => {
    const s = await setup();
    const { commitmentOutboundMessageId: id, planMessageId: plan } = s.w.handles;
    withDecideModel(s, {
      [id]: { ...NEUTRAL, human_written: 0.01 },
      [plan]: { ...NEUTRAL, human_written: 0.01, quarantine: 0.95 },
    });
    await processOne(s, id);
    expect(extractPrompts(s)).toEqual(["personal_correspondence"]);
    expect(await runDue(s, plan, triageOf({ direction: "outbound" }))).toMatchObject({
      status: "withheld",
      code: "quarantine",
    });
  });

  // Triage's line 4 decides the lane before the decide model's; the decide model is still asked, and its holds still hold.
  it("a known correspondent's inbound mail with human_written 0.1 goes to correspondence, Jev still asked, and is still withheld on quarantine", async () => {
    const s = await setup();
    const { planMessageId: id, commitmentInboundMessageId: held } = s.w.handles;
    withDecideModel(s, {
      [id]: { ...NEUTRAL, human_written: 0.1 },
      [held]: { ...NEUTRAL, human_written: 0.1, quarantine: 0.95 },
    });
    await runDue(s, id, triageOf({ category: "updates", knownCorrespondent: true }));
    expect(extractPrompts(s)).toEqual(["personal_correspondence"]);
    expect(s.decideCalls).toEqual([s.store.evidenceIdOf(id)]);
    expect(statusOf(s, id)).toMatchObject({ lane: "correspondence" });
    expect(await runDue(s, held, triageOf({ knownCorrespondent: true }))).toMatchObject({
      status: "withheld",
      code: "quarantine",
    });
    // The control: the same score from a sender the owner does not correspond with.
    const t = await setup();
    withDecideModel(t, { [id]: { ...NEUTRAL, human_written: 0.1 } });
    await runDue(t, id, triageOf({ category: "updates" }));
    expect(extractPrompts(t)).toEqual(["personal_transaction"]);
  });

  it("the owner's lane wins over Jev's", async () => {
    const s = await setup();
    const id = s.w.handles.planMessageId;
    withDecideModel(s, { [id]: { ...NEUTRAL, human_written: 0.99 } });
    await runDue(s, id, (due) => ({ ...due, lane: "transaction" }));
    expect(extractPrompts(s)).toEqual(["personal_transaction"]);
    expect(s.decideCalls).toHaveLength(1);
  });

  it("the owner's lane skip ends skipped with no call, whatever the fake would answer", async () => {
    const s = await setup();
    const id = s.w.handles.planMessageId;
    withDecideModel(s, { [id]: over(0.99) });
    expect(await runDue(s, id, (due) => ({ ...due, lane: "skip" }))).toMatchObject({ status: "skipped" });
    expect([...s.decideCalls, ...s.calls]).toEqual([]);
  });

  it("an owner's lane correspondence on an item with no text is opened and goes on as today; with no owner lane it is skipped no_text with no call", async () => {
    const s = await setup();
    const id = s.w.handles.planMessageId;
    withDecideModel(s);
    expect(await runDue(s, id, (due) => ({ ...triageOf({ chars: 0 })(due), lane: "correspondence" }))).toMatchObject({
      status: "done",
      claims: 1,
    });
    const t = await setup();
    withDecideModel(t);
    expect(await runDue(t, id, triageOf({ unreadable: true }))).toMatchObject({ status: "skipped", code: "no_text" });
    expect([...t.decideCalls, ...t.calls]).toEqual([]);
  });

  it("an overridden item is not withheld, and with both lane and override no call is made", async () => {
    const s = await setup();
    const id = s.w.handles.planMessageId;
    withDecideModel(s, { [id]: over(0.99) });
    expect(await runDue(s, id, (due) => ({ ...due, override: true }))).toMatchObject({ status: "done", claims: 1 });
    expect(s.decideCalls).toHaveLength(1);
    const t = await setup();
    withDecideModel(t, { [id]: over(0.99) });
    expect(await runDue(t, id, (due) => ({ ...due, override: true, lane: "correspondence" }))).toMatchObject({
      status: "done",
      claims: 1,
    });
    expect(t.decideCalls).toEqual([]);
  });

  it("no answer defers model_unavailable with no attempt, and Luna is not called", async () => {
    const s = await setup();
    const id = s.w.handles.planMessageId;
    withDecideModel(s, {}, null);
    expect(await processOne(s, id)).toMatchObject({ status: "waiting", code: "model_unavailable", live: false });
    expect(statusOf(s, id)).toMatchObject({ status: "waiting", attempts: 0 });
    expect(s.calls).toEqual([]);
  });

  it("a Jev error that is not a rejection (a broken saved call, a refused request) leaves the item waiting interpret_failed, and Luna is not called", async () => {
    for (const code of ["bad_record", "bad_request"] as const) {
      const s = await setup();
      const id = s.w.handles.planMessageId;
      withDecideModel(s);
      const decideModel = s.deps.decideModel;
      if (decideModel === undefined) throw new Error("no jev");
      s.deps.decideModel = {
        ...decideModel,
        model: { complete: () => Promise.reject(new ModelClientError(code)), embed: decideModel.model.embed },
      };
      // A failed recovery check is never a safe verdict: the item waits, unmarked, to be tried again.
      expect(await processOne(s, id)).toMatchObject({ status: "waiting", code: "interpret_failed" });
      expect(s.calls).toEqual([]);
    }
  });

  it("a rejection goes on with rung 0's lane and no narrowing", async () => {
    const s = await setup();
    const id = s.w.handles.planMessageId;
    withDecideModel(s, { [id]: "rejected:by_test" });
    expect(await runDue(s, id, triageOf({ bulk: true, category: "primary" }))).toMatchObject({ live: true });
    expect(extractPrompts(s)).toEqual(["personal_transaction"]);
    const t = await setup();
    withDecideModel(t, { [id]: "rejected:by_test" });
    expect(await runDue(t, id, triageOf({ bulk: true, category: "social" }))).toMatchObject({
      status: "skipped",
      code: "bulk",
    });
  });

  it("a replay sends nothing and gives the same outcome whatever the fake would now answer", async () => {
    const s = await setup();
    const id = s.w.handles.planMessageId;
    withDecideModel(s);
    expect(await processOne(s, id)).toMatchObject({ status: "done", claims: 1 });
    // A new generation makes the item due again; its saved call replays.
    withDecideModel(s, { [id]: over(0.99) });
    s.deps.generation = EXTRACT_GENERATION + 1;
    expect(await processOne(s, id)).toMatchObject({ status: "done", claims: 1 });
    expect(s.decideCalls).toHaveLength(1);
  });

  it("Jev's saved calls are their own namespace, under its model id", async () => {
    const s = await setup();
    const id = s.w.handles.planMessageId;
    withDecideModel(s);
    await processOne(s, id);
    expect(
      s.store
        .savedCalls()
        .map((one) => [one.record.key.promptId, one.modelId])
        .sort(),
    ).toEqual([
      ["jev_recovery", DECIDE_MODEL_ID],
      ["jev_screen", DECIDE_MODEL_ID],
      ["personal_correspondence", MODEL_ID],
    ]);
  });

  it("the Jev request carries the fitted slot in its message slot, under the item's label", async () => {
    const s = await setup();
    const id = s.w.handles.planMessageId;
    withDecideModel(s);
    await processOne(s, id);
    // The recovery call comes first; the screen after it.
    const request = s.decideRequests.find((one) => one.promptId === "jev_screen");
    expect(s.decideRequests.map((one) => one.promptId)).toEqual(["jev_recovery", "jev_screen"]);
    expect(request).toMatchObject({ promptId: "jev_screen", promptVersion: "1", label: s.requests[0]?.label });
    expect(JSON.parse(request?.data.message ?? "{}")).toMatchObject({ direction: "inbound", cut: false });
  });

  it("the world's injection twins: the instructing message is withheld, its neutral twin is not", async () => {
    const s = await setup();
    const {
      instructionMessageId: instruction,
      twinMessageId: twin,
      bodyInstructionMessageId: bodyInstruction,
      bodyTwinMessageId: bodyTwin,
    } = s.w.handles;
    withDecideModel(s, {
      [instruction]: { ...NEUTRAL, quarantine: 0.97 },
      [bodyInstruction]: { ...NEUTRAL, quarantine: 0.97 },
      [twin]: NEUTRAL,
      [bodyTwin]: NEUTRAL,
    });
    for (const id of [instruction, bodyInstruction])
      expect(await processOne(s, id)).toMatchObject({ status: "withheld", code: "quarantine" });
    for (const id of [twin, bodyTwin]) expect((await processOne(s, id)).status).not.toBe("withheld");
  });
});

describe("the second-degree version of the correspondence lane", () => {
  const versions = (s: Setup) => s.requests.map((request) => `${request.promptId}@${request.promptVersion}`);

  it("with PI_EXTRACT_SECOND_DEGREE unset the lanes ask their current versions", async () => {
    const s = await setup();
    expect(await processOne(s, s.w.handles.planMessageId)).toMatchObject({ status: "done", claims: 1, live: true });
    expect(versions(s)).toEqual(["personal_correspondence@4"]);
  });

  it("with it set, a new item is asked the second-degree version", async () => {
    const s = await setup({ secondDegree: true });
    expect(await processOne(s, s.w.handles.planMessageId)).toMatchObject({ status: "done", claims: 1, live: true });
    expect(versions(s)).toEqual(["personal_correspondence@5"]);
  });

  it("an item already done keeps its saved call and is not re-asked", async () => {
    const s = await setup();
    const id = s.w.handles.planMessageId;
    const due = await dueOf(s.store, id);
    expect(await processItem(due, s.deps)).toMatchObject({ status: "done", claims: 1, live: true });
    const claims = recordsOf(s, id).map((one) => one.claim.id);
    // The switch is set, and the item is due again with its saved call kept (a refile's state).
    s.deps.secondDegree = true;
    expect(await processItem(due, s.deps)).toMatchObject({ claims: 1, live: false });
    expect(versions(s)).toEqual(["personal_correspondence@4"]);
    expect(s.calls).toHaveLength(1);
    expect(s.store.savedCalls().map((one) => one.record.key.promptVersion)).toEqual(["4"]);
    expect(recordsOf(s, id).map((one) => one.claim.id)).toEqual(claims);
  });
});

// A lane's fact-kind version is asked of its new items only, and
// only with the lane in PI_EXTRACT_FACT_KINDS; an item already done keeps its saved call.
describe("the fact-kind versions of the message lanes", () => {
  const versions = (s: Setup) => s.requests.map((request) => `${request.promptId}@${request.promptVersion}`);

  it("with no lane named, every lane asks its current version", async () => {
    const s = await setup();
    await processOne(s, s.w.handles.planMessageId);
    await processOne(s, s.w.handles.receiptCanaryMessageId);
    expect(versions(s)).toEqual(["personal_correspondence@4", "personal_transaction@2"]);
  });

  it("a lane named asks its new items the fact-kind version; a lane not named is unchanged", async () => {
    const s = await setup({ factKinds: ["transaction"] });
    expect(await processOne(s, s.w.handles.receiptCanaryMessageId)).toMatchObject({
      status: "done",
      claims: 1,
      live: true,
    });
    await processOne(s, s.w.handles.planMessageId);
    expect(versions(s)).toEqual(["personal_transaction@4", "personal_correspondence@4"]);
    const both = await setup({ factKinds: ["correspondence"], secondDegree: true });
    expect(await processOne(both, both.w.handles.planMessageId)).toMatchObject({
      status: "done",
      claims: 1,
      live: true,
    });
    expect(versions(both)).toEqual(["personal_correspondence@11"]);
  });

  it("an item already done keeps its saved call and is not re-asked", async () => {
    const s = await setup();
    const id = s.w.handles.receiptCanaryMessageId;
    const due = await dueOf(s.store, id);
    expect(await processItem(due, s.deps)).toMatchObject({ status: "done", claims: 1, live: true });
    const claims = recordsOf(s, id).map((one) => one.claim.id);
    s.deps.factKinds = ["transaction"];
    expect(await processItem(due, s.deps)).toMatchObject({ claims: 1, live: false });
    expect(versions(s)).toEqual(["personal_transaction@2"]);
    expect(s.store.savedCalls().map((one) => one.record.key.promptVersion)).toEqual(["2"]);
    expect(recordsOf(s, id).map((one) => one.claim.id)).toEqual(claims);
  });
});

describe("an agent's close and fill", () => {
  const dueRecord = async (s: Setup, id: string) => {
    const found = (await s.store.due(1000, 1)).find((one) => one.evidenceId === id);
    if (found?.source !== "agent_record") throw new Error("not due");
    return found;
  };

  it("a close or a fill whose body code cannot read is skipped by its code, with no call", async () => {
    const s = await setup();
    const at = new Date(Date.parse(s.w.now) - 3_600_000).toISOString();
    for (const [kind, code] of [
      ["close", "bad_close"],
      ["fill", "bad_fill"],
    ] as const) {
      const id = s.store.putRecord({ client: "alpha", kind, body: "{}", recordedAt: at as never });
      expect(await processItem(await dueRecord(s, id), s.deps)).toMatchObject({
        status: "skipped",
        code,
        claims: 0,
        live: false,
      });
      expect(s.store.record(id)?.status).toMatchObject({ lane: "agent", status: "skipped", code });
    }
    expect(s.calls).toEqual([]);
  });
});
