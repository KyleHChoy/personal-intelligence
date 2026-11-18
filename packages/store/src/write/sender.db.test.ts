import { gmailItemId } from "@intelligence/personal-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdmin } from "../admin/admin.ts";
import { fingerprint } from "../core/fingerprint.ts";
import { sealRow } from "../core/seal.ts";
import { createPipeline } from "../pipeline/pipeline.ts";
import type { Sender } from "../send/sender.ts";
import { one } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import { MAIL } from "../test-support/items-named.ts";
import { batchOf, stored } from "../test-support/pipeline-fixtures.ts";
import { recordingLogger } from "../test-support/recording.ts";
import {
  asSuperuser,
  connectSend,
  draftingClient,
  latestEvent,
  messageOf,
  RECIPIENT,
  type SendWorld,
  seedDraft,
  sendCounts,
  senderOf,
  sendSecretName,
  sendWorld,
  synced,
  useOnlyClaim,
} from "../test-support/sender-fixtures.ts";
import { refusedWith } from "../test-support/values.ts";

// The store's Sender, as pi_proxy, with the key file narrowed as the wrapper narrows it: the
// fingerprint key, `own` and every `agent:` key. Drafts are seeded through ledger.append_draft and
// ledger.append_gate_decision as pi_reader.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const open: { world: SendWorld; senders: Sender[] }[] = [];

async function setUp(): Promise<{ world: SendWorld; sender: Sender }> {
  const world = await sendWorld();
  const sender = senderOf(world);
  open.push({ world, senders: [sender] });
  await connectSend(world);
  await synced(world, world.accounts.personalMail.id);
  return { world, sender };
}

afterEach(async () => {
  for (const { world, senders } of open.splice(0)) {
    for (const sender of senders) await sender.close();
    await world.close();
  }
});

const codeOf = async (run: () => Promise<unknown>): Promise<unknown> => (await refusedWith(run)).code;

// A text of at least 12 code points that ties a draft to a use-only claim that repeats it.
const SECRET_PLAN = "moving the heron ledger to the north office";

describe("Sender: check", () => {
  it("a draft whose sealed body was replaced by another is draft_mismatch", async () => {
    const { world, sender } = await setUp();
    const client = await draftingClient(world, "jev");
    const first = await seedDraft(world, client);
    const second = await seedDraft(world, client, { body: "Another text altogether." });
    // The second draft's sealed body, sealed again for the first draft's row, as a holder of
    // the database who also holds the key could do.
    const body = sealRow(
      world.db.keys,
      "own",
      { table: "ledger.drafts", id: first.id, column: "body_enc" },
      JSON.stringify(second.payload),
    );
    await asSuperuser(world.db, "ledger.drafts", "update ledger.drafts set body_enc = $2 where id = $1", [
      first.id,
      body,
    ]);
    expect(await codeOf(() => sender.check(first.id))).toBe("draft_mismatch");
    expect((await sender.check(second.id)).fp).toBe(second.values.payloadFp);
  });

  it("a draft whose recipient or body fingerprints do not match its payload is draft_mismatch", async () => {
    const { world, sender } = await setUp();
    const client = await draftingClient(world, "jev");
    const recipients = await seedDraft(world, client);
    const body = await seedDraft(world, client, { body: "A second text." });
    await asSuperuser(world.db, "ledger.drafts", "update ledger.drafts set recipient_fps = $2 where id = $1", [
      recipients.id,
      [fingerprint(world.db.keys, "address", "other@one-message.test")],
    ]);
    await asSuperuser(world.db, "ledger.drafts", "update ledger.drafts set body_fp = $2 where id = $1", [
      body.id,
      "0".repeat(64),
    ]);
    expect(await codeOf(() => sender.check(recipients.id))).toBe("draft_mismatch");
    expect(await codeOf(() => sender.check(body.id))).toBe("draft_mismatch");
    const plain = await seedDraft(world, client, { body: "A third text." });
    const checked = await sender.check(plain.id);
    expect(checked).toMatchObject({ fp: plain.values.payloadFp, label: "personal", payload: plain.payload });
  });

  it("a sender given the admin's URL refuses every call", async () => {
    const { world } = await setUp();
    const client = await draftingClient(world, "jev");
    const draft = await seedDraft(world, client);
    const wrong = senderOf(world, world.db.urls.admin);
    open[0]?.senders.push(wrong);
    for (const call of [
      () => wrong.check(draft.id),
      () => wrong.list(),
      () => wrong.status(),
      () => wrong.secret("personal"),
      () => wrong.erasureLevel(),
    ]) {
      expect(await codeOf(call)).toBe("wrong_role");
    }
  });
});

describe("Sender: the gate at send", () => {
  it("the gate at send reads the facts again: a veto added since the draft was made fails it", async () => {
    const { world, sender } = await setUp();
    const client = await draftingClient(world, "jev");
    const draft = await seedDraft(world, client);
    expect(await latestEvent(world, "draft", draft.id)).toBe("made");
    const admin = createAdmin({ url: world.db.urls.admin, keys: world.db.keys, log: recordingLogger().log });
    try {
      await admin.cards.addVeto({ kind: "proposal" }, { requestId: "veto-proposal-1" });
    } finally {
      await admin.close();
    }
    const answer = await sender.gate(draft.id, draft.values.payloadFp, { firstContact: true, newThread: true });
    expect(answer.cleared).toBe(false);
    expect(answer.outcome.checks.vetoes).toBe(false);
    expect(answer.outcome.causes).toContain("about_vetoed");
    // A refused gate writes nothing.
    expect((await sendCounts(world)).gateRows).toBe(0);
  });

  it("a claim that does not open fails disclosure", async () => {
    const { world, sender } = await setUp();
    const claim = await useOnlyClaim(world, MAIL.canary, SECRET_PLAN);
    // Sealed for another row, so it opens nowhere here.
    await asSuperuser(world.db, "knowledge.claims", "update knowledge.claims set content_enc = $2 where id = $1", [
      claim,
      sealRow(world.db.keys, "own", { table: "knowledge.claims", id: "another", column: "content_enc" }, "{}"),
    ]);
    const client = await draftingClient(world, "jev");
    const draft = await seedDraft(world, client, { body: "Nothing in this text repeats the claim." });
    const view = await sender.show(draft.id);
    expect(view.held).toEqual([{ id: claim, tie: "unopened", value: null }]);
    expect(view.outcome.checks.disclosure).toBe(false);
    expect(view.revealCode).toBeNull();
  });

  it("a draft labelled own and its author's own agent: compartment opens and is sent", async () => {
    const { world, sender } = await setUp();
    const client = await draftingClient(world, "jev", ["own", "agent:jev"]);
    const draft = await seedDraft(world, client);
    const checked = await sender.check(draft.id);
    const answer = await sender.gate(draft.id, checked.fp, { firstContact: true, newThread: true });
    expect(answer.cleared).toBe(true);
    if (!answer.cleared) return;
    const send = await sender.begin({
      draft: draft.id,
      decision: answer.decision,
      fp: checked.fp,
      firstContact: answer.firstContact,
      newThread: answer.newThread,
      released: [],
    });
    expect(send).toMatch(/^snt_/);
    expect(await sender.finish(send ?? "", { outcome: "sent", id: "gm-sent-1", threadId: "th-sent-1" })).toBe(true);
    expect(await latestEvent(world, "draft", draft.id)).toBe("sent");
  });

  it("finish is handed the fingerprint the writer computes for the copy's source item id", async () => {
    const { world, sender } = await setUp();
    const client = await draftingClient(world, "jev");
    const draft = await seedDraft(world, client);
    const answer = await sender.gate(draft.id, draft.values.payloadFp, { firstContact: true, newThread: true });
    if (!answer.cleared) throw new Error("expected the gate to clear");
    const send =
      (await sender.begin({
        draft: draft.id,
        decision: answer.decision,
        fp: draft.values.payloadFp,
        firstContact: true,
        newThread: true,
        released: [],
      })) ?? "";
    await sender.finish(send, { outcome: "sent", id: "gm-sent-2", threadId: "th-sent-2" });
    const row = one(
      await queryAs<{ source_item_fp: string; thread_fp: string }>(
        world.db.urls.admin,
        "select source_item_fp, thread_fp from ledger.sent_messages where id = $1",
        [send],
      ),
    );
    // What the writer stores for the copy: the source_id fingerprint of its source item id.
    expect(row.source_item_fp).toBe(fingerprint(world.db.keys, "source_id", gmailItemId("gm-sent-2")));
    expect(row.thread_fp).toBe(fingerprint(world.db.keys, "thread", "th-sent-2"));
  });

  it("a draft labelled with another client's agent: compartment opens and is gate_refused at channel_cap, and nothing is sent", async () => {
    const { world, sender } = await setUp();
    const client = await draftingClient(world, "jev", ["own", "agent:luna"]);
    const draft = await seedDraft(world, client);
    expect((await sender.check(draft.id)).fp).toBe(draft.values.payloadFp);
    const answer = await sender.gate(draft.id, draft.values.payloadFp, { firstContact: true, newThread: true });
    expect(answer.cleared).toBe(false);
    expect(answer.outcome.checks.channel_cap).toBe(false);
    expect(answer.outcome.causes).toContain("label_over_cap");
    expect((await sendCounts(world)).sends).toBe(0);
  });

  it("a draft whose label holds an employer: compartment is label_not_held and writes nothing", async () => {
    const { world, sender } = await setUp();
    const client = await draftingClient(world, "jev", ["own", "employer:example"]);
    const draft = await seedDraft(world, client);
    const before = await sendCounts(world);
    for (const call of [
      () => sender.check(draft.id),
      () => sender.show(draft.id),
      () => sender.gate(draft.id, draft.values.payloadFp, { firstContact: true, newThread: true }),
    ]) {
      expect(await codeOf(call)).toBe("label_not_held");
    }
    expect(await sendCounts(world)).toEqual(before);
  });
});

describe("Sender: show and the release", () => {
  it("show returns the first eight characters of the fingerprint as the code, and marks a first contact and a new thread", async () => {
    const { world, sender } = await setUp();
    const client = await draftingClient(world, "jev");
    const draft = await seedDraft(world, client);
    const view = await sender.show(draft.id);
    expect(view.code).toBe(draft.values.payloadFp.slice(0, 8));
    expect(view.firstContacts).toEqual([RECIPIENT]);
    expect(view.newThread).toBe(true);
    expect(view.flags).toEqual(["--first-contact", "--new-thread"]);
    expect(view.label).toBe("personal");
  });

  it("show returns the flagged and the unscreened counts apart", async () => {
    const { world, sender } = await setUp();
    // One message extraction has not screened, and one it withheld.
    const unscreened = await messageOf(
      world,
      await stored(world.writer, world.accounts.personalMail, MAIL.fromQuentin),
    );
    const withheldEvidence = await stored(world.writer, world.accounts.personalMail, MAIL.canary);
    const pipeline = createPipeline({ url: world.db.urls.pipeline, keys: world.db.keys, log: recordingLogger().log });
    try {
      await pipeline.commit(batchOf(withheldEvidence, [], { status: "withheld" }));
    } finally {
      await pipeline.close();
    }
    const withheld = await messageOf(world, withheldEvidence);
    const client = await draftingClient(world, "jev");
    const draft = await seedDraft(world, client, {
      basis: [
        { kind: "message", id: unscreened },
        { kind: "message", id: withheld },
      ],
    });
    const view = await sender.show(draft.id);
    expect(view.counts).toMatchObject({ flagged: 1, unscreened: 1, missing: 0, tainted: 0 });
    expect(view.basis).toEqual(
      expect.arrayContaining([
        { kind: "message", id: unscreened },
        { kind: "message", id: withheld },
      ]),
    );
  });

  it("show returns, for a held draft, each failing check with its causes, and for disclosure each claim's id, tie and value", async () => {
    const { world, sender } = await setUp();
    const claim = await useOnlyClaim(world, MAIL.canary, SECRET_PLAN);
    const client = await draftingClient(world, "jev");
    const draft = await seedDraft(world, client, { body: `About ${SECRET_PLAN}, shall we talk?`, disclosure: "held" });
    expect(await latestEvent(world, "draft", draft.id)).toBe("held");
    const view = await sender.show(draft.id);
    expect(view.outcome.checks.disclosure).toBe(false);
    expect(view.outcome.causes).toContain("use_only_revealed");
    // Held at phase draft and not released: authority names it too.
    expect(view.outcome.causes).toContain("held_at_draft");
    expect(view.held).toEqual([{ id: claim, tie: "text_value", value: SECRET_PLAN }]);
  });

  it("show returns the reveal code after every held claim, and the code changes when the set of held claims changes", async () => {
    const { world, sender } = await setUp();
    await useOnlyClaim(world, MAIL.canary, SECRET_PLAN);
    const client = await draftingClient(world, "jev");
    const draft = await seedDraft(world, client, {
      body: `About ${SECRET_PLAN} and the lantern rota schedule.`,
      disclosure: "held",
    });
    const before = await sender.show(draft.id);
    expect(before.revealCode).toMatch(/^[0-9a-f]{8}$/);
    expect(await sender.revealCode(draft.id)).toBe(before.revealCode);
    await useOnlyClaim(world, MAIL.fromQuentin, "the lantern rota schedule", { n: 2 });
    const after = await sender.show(draft.id);
    expect(after.held).toHaveLength(2);
    expect(after.revealCode).not.toBe(before.revealCode);
  });

  it("gate with the code show returned releases the held claims and clears a draft held by disclosure alone; with an old code it is reveal_mismatch and writes nothing", async () => {
    const { world, sender } = await setUp();
    const claim = await useOnlyClaim(world, MAIL.canary, SECRET_PLAN);
    const client = await draftingClient(world, "jev");
    const draft = await seedDraft(world, client, { body: `About ${SECRET_PLAN}.`, disclosure: "held" });
    const old = (await sender.show(draft.id)).revealCode ?? "";
    const without = await sender.gate(draft.id, draft.values.payloadFp, { firstContact: true, newThread: true });
    expect(without.cleared).toBe(false);
    expect(without.outcome.causes).toEqual(expect.arrayContaining(["use_only_revealed", "held_at_draft"]));
    const released = await sender.gate(draft.id, draft.values.payloadFp, {
      reveal: old,
      firstContact: true,
      newThread: true,
    });
    expect(released).toMatchObject({ cleared: true, released: [claim] });
    // A further claim comes to hold the draft: the old code no longer releases it.
    await useOnlyClaim(world, MAIL.fromQuentin, `About ${SECRET_PLAN}.`, { n: 3 });
    const before = await sendCounts(world);
    expect(
      await codeOf(() =>
        sender.gate(draft.id, draft.values.payloadFp, { reveal: old, firstContact: true, newThread: true }),
      ),
    ).toBe("reveal_mismatch");
    expect(await sendCounts(world)).toEqual(before);
  });

  it("a disclosure candidate under an employer: compartment is not opened and is counted on show", async () => {
    const { world, sender } = await setUp();
    await useOnlyClaim(world, MAIL.canary, SECRET_PLAN, { work: true });
    const client = await draftingClient(world, "jev");
    const draft = await seedDraft(world, client, { body: `About ${SECRET_PLAN}.` });
    const view = await sender.show(draft.id);
    expect(view.leftOut).toBe(1);
    expect(view.held).toEqual([]);
    expect(view.outcome.checks.disclosure).toBe(true);
  });
});

describe("Sender: secrets, list and status", () => {
  it("a send secret is sealed, and opens only under its own name", async () => {
    const { world, sender } = await setUp();
    await sender.putSecret("spare", "the-value");
    expect(await sender.secret("spare")).toBe("the-value");
    const row = one(
      await asSuperuser<{ value_enc: unknown }>(
        world.db,
        "policy.secrets",
        "select value_enc from policy.secrets where name = $1",
        [sendSecretName("spare")],
      ),
    );
    expect(JSON.stringify(row.value_enc)).not.toContain("the-value");
    // The same envelope under another name opens nowhere.
    await asSuperuser(world.db, "policy.secrets", "update policy.secrets set value_enc = $2 where name = $1", [
      sendSecretName("personal"),
      row.value_enc,
    ]);
    expect(await codeOf(() => sender.secret("personal"))).toBe("open_failed");
    expect(await sender.deleteSecret("spare")).toBe(true);
    expect(await sender.deleteSecret("spare")).toBe(false);
  });

  it("list and status return ids, statuses, names and times only", async () => {
    const { world, sender } = await setUp();
    const client = await draftingClient(world, "jev");
    const made = await seedDraft(world, client);
    const held = await seedDraft(world, client, { body: "A held one.", disclosure: "held" });
    const listed = await sender.list();
    expect(listed.drafts.map((draft) => [draft.id, draft.status, draft.failed])).toEqual([
      [made.id, "made", []],
      [held.id, "held", ["disclosure"]],
    ]);
    const status = await sender.status();
    expect(status.labels).toEqual([{ label: "personal", connectedAt: expect.any(String), orphaned: false }]);
    expect(status.counts).toMatchObject({ made: 1, held: 1 });
    const printed = JSON.stringify([listed, status]);
    for (const text of [RECIPIENT, made.payload.subject, made.payload.body, "send-refresh-token"])
      expect(printed).not.toContain(text);
  });

  it("list marks a sent send copy missing after 30 minutes, and not one whose copy an erasure cleared", async () => {
    const { world, sender } = await setUp();
    const client = await draftingClient(world, "jev");
    const sentIds: string[] = [];
    for (const body of ["The first sent text.", "The second sent text."]) {
      const draft = await seedDraft(world, client, { body });
      const answer = await sender.gate(draft.id, draft.values.payloadFp, { firstContact: true, newThread: true });
      if (!answer.cleared) throw new Error("expected the gate to clear");
      const send =
        (await sender.begin({
          draft: draft.id,
          decision: answer.decision,
          fp: draft.values.payloadFp,
          firstContact: true,
          newThread: true,
          released: [],
        })) ?? "";
      await sender.finish(send, { outcome: "sent", id: `gm-${sentIds.length}`, threadId: `th-${sentIds.length}` });
      sentIds.push(send);
    }
    // Both sent 31 minutes ago, aged once both are sent: a copy missing stops the next send.
    await asSuperuser(
      world.db,
      "ledger.sent_messages",
      "update ledger.sent_messages set sent_at = now() - interval '31 minutes' where id = any($1)",
      [sentIds],
    );
    // The second's copy was erased: forget_sent_source cleared its source fingerprint.
    await asSuperuser(
      world.db,
      "ledger.sent_messages",
      "update ledger.sent_messages set source_item_fp = null where id = $1",
      [sentIds[1]],
    );
    const listed = await sender.list();
    expect(listed.sends.filter((send) => send.copyMissing).map((send) => send.id)).toEqual([sentIds[0]]);
    expect((await sender.status()).counts.copyMissing).toBe(1);
  });
});
