import { composeOpenItems } from "@intelligence/personal-core/views";
import { fakeModelClient } from "@intelligence/personal-models/testing";
import { describe, expect, it } from "vitest";
import { EVAL_DUE_NOTICES, evaluateDueNotices } from "./eval/eval-due-notices.ts";
import { checkNotice, EVAL_NOTICE_OWNER, type EvalNotice, openEvalNotice } from "./eval/eval-transactions.ts";
import { keptVersions } from "./kept-versions.ts";
import { FACT_KIND_VERSIONS } from "./lane-versions.ts";
import { processItem } from "./process-item.ts";
import { promptAt } from "./prompts.ts";
import { changed, dueOf, processOne, type Setup, setup } from "./test-support/support.ts";
import { triageBy } from "./triage.ts";

// A notice from triage through the prompt's text and the check to the open items' read. The model here
// is a fake: this proves what code does with an answer, and the prompt's words. Whether the real model
// answers so is what `pi extract check --world --lane notices` asks. Every line is invented.
const V3 = () => promptAt("transaction", "3").instructions;
const V4 = () => promptAt("transaction", FACT_KIND_VERSIONS.transaction).instructions;
const OVERDUE = EVAL_DUE_NOTICES[0] as EvalNotice;
const LATE = OVERDUE.paragraphs[0] as string;
const planFrom = (span: string, what: string, when: string) => ({
  claims: [
    {
      type: "plan",
      subject: { key: { kind: "address", value: "x@x.example" }, observedAt: OVERDUE.sentAt },
      fields: { what, when },
      statementKind: "stated_fact",
      basis: "third_party",
      span,
    },
  ],
  narrowing: "none",
});

describe("a notice that says something is due, by what each step does", () => {
  it("automated mail reaches the transaction lane by rung 0, with no decide model and with a low score", () => {
    const row = {
      unreadable: false,
      chars: 400,
      direction: "inbound",
      bulk: true,
      category: "updates",
      knownCorrespondent: false,
    } as never;
    expect(triageBy(row)).toMatchObject({ lane: "transaction", by: "routed" });
    expect(triageBy(row, undefined, 0.1)).toMatchObject({ lane: "transaction", by: "jev" });
    expect(triageBy({ ...(row as object), category: "promotions" } as never)).toMatchObject({
      lane: "skip",
      code: "bulk",
    });
  });

  it("version 3's own words make a notice of something due a reminder that gives no claim", () => {
    expect(V3()).toContain("a reminder that only asks the owner to act give no claim");
    expect(V4()).not.toContain("a reminder that only asks the owner to act");
  });

  it("version 4 says a deadline on the owner is a plan, past or to come, and an opening is nothing", () => {
    const text = V4();
    expect(text).toContain("for each deadline it puts on the owner");
    expect(text).toContain("whether its date is still ahead or has passed");
    expect(text).toContain("A notice that says a thing is overdue and gives no date takes the message's date");
    expect(text).toContain("A date anyone could act on is no deadline of the owner's");
    expect(text).toContain("A thing done.");
    expect(text).toContain("Example message of a deadline that has passed");
    expect(text).toContain('Example output for that opening: {"claims":[],"narrowing":"none"}');
    expect(text).toContain("Marketing, a promotion, an offer, a sale, a discount, a newsletter");
  });
});

describe("a model's plan for a notice, through the check", () => {
  const SPAN = `chars:0-${OVERDUE.paragraphs[0]?.length}`;

  it("keeps a date already past as the owner's, a notice's, and the read serves it overdue with its source", async () => {
    const version = FACT_KIND_VERSIONS.transaction;
    const output = planFrom(SPAN, LATE, "2026-10-18") as never;
    const { claims, unmapped } = await checkNotice(OVERDUE, output, undefined, undefined, undefined, version);
    expect(unmapped).toEqual([]);
    expect(claims).toHaveLength(1);
    const [record] = claims;
    expect(record).toMatchObject({ subjectKind: "owner", notice: true });
    expect(record?.claim.content.subject).toBe(EVAL_NOTICE_OWNER);
    const fields = record?.claim.content.fields as { what: string; when: string };
    expect(fields).toEqual({ what: LATE, when: "2026-10-18" });
    const { items } = composeOpenItems(
      {
        owner: { id: `ent_${"0".repeat(26)}`, kind: "owner", name: null, address: null } as never,
        commitments: [],
        nextSteps: [],
        events: [],
        closes: [],
        plans: [
          {
            key: "0".repeat(64),
            match: "words",
            what: fields.what,
            when: fields.when,
            at: Date.parse(OVERDUE.sentAt),
            ownMail: false,
            bulk: true,
            sender: "fingerprint",
            refs: { message: "msg_x" as never },
          },
        ],
      },
      new Date("2026-10-22T12:00:00.000Z"),
      "UTC",
    );
    expect(items).toMatchObject([
      { due: "2026-10-18", overdue: true, lateDays: 4, what: { untrusted: LATE }, source: { message: "msg_x" } },
    ]);
  });

  it("takes the subject line as its words, in this lane", async () => {
    const span = `subject:chars:0-${OVERDUE.subject.length}`;
    const output = planFrom(span, OVERDUE.subject, "2026-10-18") as never;
    const { claims, unmapped } = await checkNotice(OVERDUE, output);
    expect(unmapped).toEqual([]);
    expect(claims.map((one) => one.claim.content.fields.what)).toEqual([OVERDUE.subject]);
  });

  it("refuses words the message does not hold", async () => {
    const { claims, unmapped } = await checkNotice(
      OVERDUE,
      planFrom(SPAN, "An invented bill is due.", "2026-10-18") as never,
    );
    expect(claims).toEqual([]);
    expect(unmapped.map((one) => one.reason)).toEqual(["bad_fields"]);
  });
});

describe("the evaluation that asks the real model", () => {
  it("passes on the answers it wants and fails on a plan for an advertisement or none for a deadline", async () => {
    const opened = new Map(EVAL_DUE_NOTICES.map((one) => [openEvalNotice(one).context.evidenceId, one]));
    const answers = (wrong: boolean) =>
      Object.fromEntries(
        [...opened].map(([id, notice]) => {
          const expected = notice.expected[0];
          const text = notice.paragraphs[0] as string;
          const when = expected?.type === "plan" ? expected.when : "2026-11-01";
          const asked = wrong ? expected === undefined : expected !== undefined;
          return [id, asked ? planFrom(`chars:0-${text.length}`, text, when) : { claims: [], narrowing: "none" }];
        }),
      );
    const right = await evaluateDueNotices({ model: fakeModelClient(answers(false)) });
    expect(right.failed).toEqual([]);
    expect(right.passed).toBe(true);
    const off = await evaluateDueNotices({ model: fakeModelClient(answers(true)) });
    expect(off.passed).toBe(false);
    expect(off.failed).toHaveLength(EVAL_DUE_NOTICES.length);
  });
});

describe("which version a retry that keeps its answers asks", () => {
  const versions = (s: Setup) => s.requests.map((one) => `${one.promptId}@${one.promptVersion}`);
  const sayingDue = (s: Setup, id: string) =>
    changed(s, id, (message) => {
      message.text = `${LATE}\nReport deadline: Sunday, September 20, 2026`;
    });

  it("a notice the retry chose is asked anew though version 2 is saved, then replays; another replays", async () => {
    const s = await setup();
    const { receiptGroupedMessageId: saying, receiptCanaryMessageId: quiet } = s.w.handles;
    sayingDue(s, saying);
    const [due, plain] = [await dueOf(s.store, saying), await dueOf(s.store, quiet)];
    await processItem(due, s.deps);
    await processItem(plain, s.deps);
    expect(versions(s)).toEqual(["personal_transaction@2", "personal_transaction@2"]);
    s.deps.factKinds = ["transaction"];
    await processItem(
      { ...due, ask: { lane: "transaction", version: FACT_KIND_VERSIONS.transaction } } as typeof due,
      s.deps,
    );
    await processItem(plain, s.deps);
    await processItem(
      { ...due, ask: { lane: "transaction", version: FACT_KIND_VERSIONS.transaction } } as typeof due,
      s.deps,
    );
    expect(versions(s)).toEqual([
      "personal_transaction@2",
      "personal_transaction@2",
      `personal_transaction@${FACT_KIND_VERSIONS.transaction}`,
    ]);
  });

  it("what the retry prices is what the run replays and asks, and off it buys nothing new", () => {
    expect(keptVersions("transaction", true)).toMatchObject({
      replays: ["personal_transaction@2", "personal_transaction@3", "personal_transaction@4"],
      ask: { version: FACT_KIND_VERSIONS.transaction, name: `personal_transaction@${FACT_KIND_VERSIONS.transaction}` },
    });
    expect(keptVersions("transaction", false)).toEqual({ replays: ["personal_transaction@2"], ask: null });
    const none = { subject: "Your log is overdue", body: null, outbound: false, projects: [] };
    expect(keptVersions("transaction", true).ask?.choose(none)).toBe("words");
    expect(keptVersions("transaction", true).ask?.choose({ ...none, subject: "Your package shipped" })).toBeNull();
    const anchored = [{ project: "ent_x", name: "Alder Kiln", anchored: true, vetoed: false }] as never;
    const quiet = { subject: "Hello", body: "Hello.", outbound: false, projects: anchored };
    expect(keptVersions("correspondence", true).ask?.choose(quiet)).toBe("project");
    expect(keptVersions("correspondence", true).ask?.choose({ ...quiet, projects: [] })).toBeNull();
  });

  it("a choice holds at its version, a commit that did not ask it drops it, and the lane off pays nothing", async () => {
    const s = await setup();
    const { receiptGroupedMessageId: id } = s.w.handles;
    sayingDue(s, id);
    const due = await dueOf(s.store, id);
    await processItem(due, s.deps);
    const chosen = { ...due, ask: { lane: "transaction", version: "3" } } as typeof due;
    // Off: the flag buys nothing.
    await processItem(chosen, s.deps);
    expect(versions(s)).toEqual(["personal_transaction@2"]);
    // On: that version, and no later one.
    s.deps.factKinds = ["transaction"];
    await processItem(chosen, s.deps);
    await processItem(chosen, s.deps);
    expect(versions(s)).toEqual(["personal_transaction@2", "personal_transaction@3"]);
  });

  it("an anchor replays what a message has, at any version, and a retry's choice buys the version that reads the project", async () => {
    const inProject = [{ project: "ent_x", name: "Alder Kiln", anchored: true, vetoed: false }] as never;
    const s = await setup();
    const { planMessageId: id } = s.w.handles;
    const due = await dueOf(s.store, id);
    await processItem(due, s.deps);
    expect(versions(s)).toEqual(["personal_correspondence@4"]);
    s.deps.factKinds = ["correspondence"];
    changed(
      s,
      id,
      () => {},
      (opened) => ({ ...opened, projects: inProject }),
    );
    await processItem(due, s.deps);
    expect(versions(s)).toEqual(["personal_correspondence@4"]);
    await processItem(
      { ...due, ask: { lane: "correspondence", version: FACT_KIND_VERSIONS.correspondence } } as typeof due,
      s.deps,
    );
    expect(versions(s)).toEqual([
      "personal_correspondence@4",
      `personal_correspondence@${FACT_KIND_VERSIONS.correspondence}`,
    ]);

    // A new message's answer of that version, made before it had a project, replays as it was made.
    const fresh = await setup({ factKinds: ["correspondence"] });
    const freshDue = await dueOf(fresh.store, fresh.w.handles.planMessageId);
    await processItem(freshDue, fresh.deps);
    expect(versions(fresh)).toEqual([`personal_correspondence@${FACT_KIND_VERSIONS.correspondence}`]);
    changed(
      fresh,
      fresh.w.handles.planMessageId,
      () => {},
      (opened) => ({ ...opened, projects: inProject }),
    );
    await processItem(freshDue, fresh.deps);
    expect(versions(fresh)).toHaveLength(1);
  });

  it("a mark made in one lane means nothing to an item that has moved", async () => {
    const s = await setup();
    const { planMessageId: id } = s.w.handles;
    const due = await dueOf(s.store, id);
    await processItem(due, s.deps);
    s.deps.factKinds = ["correspondence"];
    await processItem({ ...due, ask: { lane: "transaction", version: "4" } } as typeof due, s.deps);
    expect(versions(s)).toEqual(["personal_correspondence@4"]);
  });

  it("an owner's action replays a notice that says something is due: only the retry chooses what pays", async () => {
    const s = await setup();
    const { receiptGroupedMessageId: id } = s.w.handles;
    sayingDue(s, id);
    const due = await dueOf(s.store, id);
    await processItem(due, s.deps);
    s.deps.factKinds = ["transaction"];
    await processItem(due, s.deps);
    expect(versions(s)).toEqual(["personal_transaction@2"]);
  });

  it("mail the retry chose for its words is asked the version that can read it, though an earlier call is saved; other mail replays", async () => {
    const s = await setup();
    const { planMessageId: saying, commitmentOutboundMessageId: quiet } = s.w.handles;
    changed(s, saying, (message) => {
      message.text = "Happy to introduce you to a friend at the lab.";
    });
    const [due, plain] = [await dueOf(s.store, saying), await dueOf(s.store, quiet)];
    await processItem(due, s.deps);
    await processItem(plain, s.deps);
    expect(versions(s)).toEqual(["personal_correspondence@4", "personal_correspondence@4"]);
    s.deps.factKinds = ["correspondence"];
    await processItem(
      { ...due, ask: { lane: "correspondence", version: FACT_KIND_VERSIONS.correspondence } } as typeof due,
      s.deps,
    );
    await processItem(plain, s.deps);
    expect(versions(s)).toEqual([
      "personal_correspondence@4",
      "personal_correspondence@4",
      `personal_correspondence@${FACT_KIND_VERSIONS.correspondence}`,
    ]);
  });

  it("with the lane's switch off it stays where it was", async () => {
    const s = await setup();
    const { receiptGroupedMessageId: id } = s.w.handles;
    sayingDue(s, id);
    await processOne(s, id);
    expect(versions(s)).toEqual(["personal_transaction@2"]);
  });
});
