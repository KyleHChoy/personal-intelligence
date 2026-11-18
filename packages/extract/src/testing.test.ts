import { Belief, ClaimId, type ModelCallRecord } from "@intelligence/contracts";
import type { BeliefRecord, DueItem, EmailDueItem, ExtractionCommit } from "@intelligence/contracts/personal";
import { world } from "@intelligence/personal-core/testing";
import { describe, expect, it } from "vitest";
import { EXTRACT_GENERATION } from "./config.ts";
import { memoryPipelineStore, OWNER_ENTITY } from "./test-support/memory-store.ts";
import { processOne, recordsOf, setup } from "./test-support/support.ts";

const NOW = new Date("2026-09-01T12:00:00.000Z");
const fresh = async () => {
  const w = world({ now: NOW });
  return { w, store: await memoryPipelineStore(w) };
};

// Every due item of a generation, read in pages of `size`, each page after the last one's end.
async function allDue(
  store: Awaited<ReturnType<typeof memoryPipelineStore>>,
  generation: number,
  size: number,
): Promise<DueItem[]> {
  const seen: DueItem[] = [];
  for (;;) {
    const last = seen.at(-1);
    const page = await store.due(
      size,
      generation,
      last === undefined
        ? {}
        : {
            after: {
              sentAt: last.sentAt,
              evidenceId: last.evidenceId,
              ...(last.source === "email" ? { triage: last.triage } : {}),
            },
          },
    );
    if (page.length === 0) return seen;
    seen.push(...page);
  }
}

const belief = (factKey: string, claim: string, confidence: number): Belief =>
  Belief.parse({
    kind: "commitment",
    factKey,
    supportHash: "a".repeat(64),
    subject: OWNER_ENTITY,
    type: "commitment",
    values: {},
    label: { compartments: ["own"], readers: ["m-owner"] },
    status: "active",
    disputed: false,
    confidence,
    lastConfirmedAt: NOW.toISOString(),
    changeKind: "backfill",
    support: [ClaimId.parse(claim)],
  });

// The lane of a due item's stored columns, as a rank: correspondence, transaction, the rest.
const rank = (item: DueItem): number => (item.source !== "email" ? 2 : rankOf(item.triage));
const rankOf = (triage: EmailDueItem["triage"]): number =>
  triage.direction === "outbound" || !triage.bulk
    ? 0
    : triage.category === "updates" || triage.category === "primary"
      ? 1
      : 2;

describe("memoryPipelineStore", () => {
  it("due gives the correspondence lane first, then the transaction lane, then the rest, newest first within each, each item once across pages, and leaves out a done item", async () => {
    const { store } = await fresh();
    const whole = await store.due(10_000, 1);
    const paged = await allDue(store, 1, 7);
    expect(paged.map((one) => one.evidenceId)).toEqual(whole.map((one) => one.evidenceId));
    expect(new Set(paged.map((one) => one.evidenceId)).size).toBe(paged.length);
    for (let at = 1; at < whole.length; at += 1) {
      const [before, after] = [whole[at - 1] as DueItem, whole[at] as DueItem];
      const order =
        rank(before) - rank(after) ||
        Date.parse(after.sentAt) - Date.parse(before.sentAt) ||
        (before.evidenceId < after.evidenceId ? -1 : 1);
      expect(order).toBeLessThan(0);
    }
    expect(new Set(whole.map(rank))).toEqual(new Set([0, 1, 2]));
    // The cursor's lane is the cursor's own: one of an unknown item stays in its lane.
    const transaction = whole.filter((one) => rank(one) === 1);
    const [firstTransaction] = transaction as [DueItem];
    const unknown = {
      sentAt: firstTransaction.sentAt,
      evidenceId: "ev-unknown-cursor" as DueItem["evidenceId"],
      triage: (firstTransaction as EmailDueItem).triage,
    };
    expect((await store.due(10_000, 1, { after: unknown })).every((one) => rank(one) >= 1)).toBe(true);
    const [first] = whole as [DueItem];
    expect(
      await store.commit({
        evidenceId: first.evidenceId,
        generation: 1,
        lane: "correspondence",
        status: "done",
        claims: [],
        unmapped: [],
        unresolved: 0,
      }),
    ).toBe("committed");
    expect((await store.due(10_000, 1)).map((one) => one.evidenceId)).not.toContain(first.evidenceId);
    expect((await store.due(10_000, 2)).map((one) => one.evidenceId)).toContain(first.evidenceId);
    expect(
      (await store.due(10_000, 1, { compartments: ["employer:example"] })).every(
        (one) => one.compartments.join() === "employer:example",
      ),
    ).toBe(true);
  });

  it("the store holds the messages stage 1 keeps: the kept Social and Forums messages, and neither left-out one, no draft and no junk", async () => {
    const { w, store } = await fresh();
    const { handles } = w;
    const held = (id: string) => store.item(store.evidenceIdOf(id)) !== undefined;
    expect(held(handles.socialKeptMessageId)).toBe(true);
    expect(held(handles.forumsKeptMessageId)).toBe(true);
    expect(held(handles.sentPromotionMessageId)).toBe(true);
    expect(held(handles.socialLeftOutMessageId)).toBe(false);
    expect(held(handles.forumsLeftOutMessageId)).toBe(false);
    expect(held(handles.draftMessageId)).toBe(false);
    expect(held(handles.sentSpamMessageId)).toBe(false);
    const junk = w.accounts
      .flatMap((box) => box.messages)
      .filter(
        (one) =>
          one.labelIds.includes("SPAM") ||
          (one.labelIds.includes("CATEGORY_PROMOTIONS") && !one.labelIds.includes("SENT")),
      );
    expect(junk.length).toBeGreaterThan(1);
    for (const one of junk) expect(held(one.id)).toBe(false);
    // Older than the backfill window.
    const old = w.accounts
      .flatMap((box) => box.messages)
      .filter((one) => one.internalDate < NOW.getTime() - 90 * 86_400_000);
    expect(old.length).toBe(5);
    for (const one of old) expect(held(one.id)).toBe(false);
    // Every recorded output is one of this store's items.
    for (const id of Object.keys(store.outputs)) expect(store.item(id)).toBeDefined();
  });

  it("a held message is not due, and is due once released", async () => {
    const { w, store } = await fresh();
    const id = store.evidenceIdOf(w.handles.heldMessageId);
    expect(store.item(id)?.held).toBe(true);
    expect((await store.due(10_000, 1)).map((one) => one.evidenceId)).not.toContain(id);
    store.release(id);
    expect((await store.due(10_000, 1)).map((one) => one.evidenceId)).toContain(id);
  });

  it("the identity port resolves an address only under the item's own compartment, and the owner under each", async () => {
    const { w, store } = await fresh();
    const ask = async (gmailId: string, address: string) => {
      const opened = await store.open(store.evidenceIdOf(gmailId));
      if (opened === null) throw new Error("not stored");
      const resolution = await opened.context.identity.resolve(
        { key: { kind: "address", value: address }, observedAt: NOW.toISOString() },
        "personal",
        "r" as never,
      );
      return { opened, resolution };
    };
    const personal = w.handles.namesWorkOnlyMessageId;
    const work = w.handles.workCommitmentMessageId;
    expect((await ask(personal, w.handles.workOnlyAddress)).resolution).toEqual({ outcome: "not_a_person" });
    const there = await ask(work, w.handles.workOnlyAddress.toUpperCase());
    expect(there.resolution.outcome).toBe("linked");
    if (there.resolution.outcome === "linked") expect(there.opened.kindOf(there.resolution.entity)).toBe("person");
    for (const [gmailId, address] of [
      [personal, "avery@quinn.test"],
      [personal, w.handles.ownerAliasAddress],
      [work, "avery.quinn@employer.test"],
    ] as const) {
      const { opened, resolution } = await ask(gmailId, address);
      expect(resolution).toEqual({ outcome: "linked", entity: OWNER_ENTITY, epoch: 0 });
      expect(opened.kindOf(OWNER_ENTITY)).toBe("owner");
    }
    expect((await ask(work, "avery@quinn.test")).resolution).toEqual({ outcome: "not_a_person" });
    expect((await ask(personal, "Nora Vance")).resolution).toEqual({ outcome: "not_a_person" });
    const opened = await store.open(store.evidenceIdOf(personal));
    expect(opened?.context.ownerAddresses).toEqual(["aq@quinn.test", "avery@quinn.test"]);
    expect(opened?.kindOf(OWNER_ENTITY)).toBeUndefined();
    expect(opened?.systemOriginated).toBe(false);
  });

  it("a commit the store's strict shape refuses is refused, as the store refuses it, and writes nothing; the batch without the extra key is the positive control", async () => {
    const { w, store } = await fresh();
    const id = store.evidenceIdOf(w.handles.planMessageId);
    const batch: ExtractionCommit = {
      evidenceId: id,
      generation: 1,
      lane: "correspondence",
      status: "done",
      claims: [],
      unmapped: [{ id: "u1", proposedType: "plan", reason: "bad_span" }],
      unresolved: 0,
    };
    // A tally riding in a meeting's batch: a key the shape does not hold.
    await expect(store.commit({ ...batch, tally: { candidates: 1 } } as never)).rejects.toMatchObject({
      code: "invalid_argument",
    });
    expect(store.unmapped().filter((one) => one.evidenceId === id)).toEqual([]);
    expect(await store.commit(batch)).toBe("committed");
    expect(store.unmapped().filter((one) => one.evidenceId === id)).toHaveLength(1);
  });

  it("a commit or a saved call for a removed or superseded item writes nothing", async () => {
    const { w, store } = await fresh();
    for (const [gmailId, change, answer] of [
      [w.handles.planMessageId, "remove", "gone"],
      [w.handles.commitmentInboundMessageId, "supersede", "superseded"],
    ] as const) {
      const id = store.evidenceIdOf(gmailId);
      store[change](id);
      expect(
        await store.commit({
          evidenceId: id,
          generation: 1,
          lane: "correspondence",
          status: "done",
          claims: [],
          unmapped: [{ id: "u1", proposedType: "plan", reason: "bad_span" }],
          unresolved: 0,
        }),
      ).toBe(answer);
      const record: ModelCallRecord = {
        key: {
          evidenceId: id,
          revision: 0,
          extractorGeneration: 0,
          promptId: "personal_correspondence",
          promptVersion: "1",
          inputHash: "b".repeat(64),
        },
        keys: [{ evidenceId: id, keyRef: "personal-unsealed" as never }],
        renderedInput: "x",
        rawOutput: "{}",
        outputHash: "c".repeat(64),
        label: { compartments: ["own"], readers: ["m-owner" as never] },
        origin: "live",
      };
      await store.calls("model-a").save(record);
      expect(await store.calls("model-a").find(record.key)).toBeNull();
      expect(store.item(id)?.status).toBeUndefined();
      expect((await store.due(10_000, 1)).map((one) => one.evidenceId)).not.toContain(id);
    }
    expect(store.unmapped()).toEqual([]);
    expect(store.savedCalls()).toEqual([]);
    expect(store.claims()).toEqual([]);
  });

  it("replacing one audience's beliefs leaves another's rows and versions as they were", async () => {
    const { store } = await fresh();
    const own = ["own"];
    const both = ["employer:example", "own"];
    const row = (fp: string, confidence: number): BeliefRecord => ({
      belief: belief(fp, "d".repeat(64), confidence),
      factKeyFp: fp,
      compartments: ["own"],
      provenance: "source",
    });
    expect(await store.replaceBeliefs(own, [row("f1", 0.5), row("f2", 0.5)], 0)).toMatchObject({
      changed: 2,
      stale: false,
    });
    expect(await store.replaceBeliefs(both, [row("f1", 0.5)], 0)).toMatchObject({ changed: 1, stale: false });
    const before = store.beliefs(both);
    // The same rows again change nothing; one changed row raises its version alone.
    expect(await store.replaceBeliefs(own, [row("f1", 0.5), row("f2", 0.5)], 0)).toMatchObject({
      changed: 0,
      stale: false,
    });
    expect(await store.replaceBeliefs(own, [row("f1", 0.9)], 0)).toMatchObject({ changed: 2, stale: false });
    expect(store.beliefs(own).map((one) => [one.factKeyFp, one.version])).toEqual([["f1", 2]]);
    expect(store.beliefs(both)).toEqual(before);
    expect(before.map((one) => one.version)).toEqual([1]);
    expect(await store.pruneAudiences([own])).toEqual({ removed: 1 });
    expect(store.beliefs(both)).toEqual([]);
    expect(store.beliefs(own)).toHaveLength(1);
  });
});

// The memory store gives a notice's claim its mark as the real store does (pipeline.ts,
// isSystemNotice), so a test that rebuilds beliefs counts it at its tier.
describe("memoryPipelineStore, a system notice's claim", () => {
  it("beliefClaims carries `notice` for a record the check marked, and only for it", async () => {
    const s = await setup();
    const id = s.w.handles.commitmentInboundMessageId;
    await processOne(s, id);
    const [record] = recordsOf(s, id);
    if (record === undefined) throw new Error("no claim");
    const given = async () =>
      (await s.store.beliefClaims()).flatMap((group) => group.claims).find((one) => one.claim.id === record.claim.id);
    expect((await given())?.notice).toBeUndefined();
    const { evidenceId: _evidence, ...marked } = { ...record, notice: true as const };
    const commit = {
      evidenceId: record.evidenceId,
      generation: EXTRACT_GENERATION,
      lane: "transaction" as const,
      status: "done" as const,
      unmapped: [],
      unresolved: 0,
    };
    expect(await s.store.commit({ ...commit, claims: [] })).toBe("committed");
    expect(await s.store.commit({ ...commit, claims: [marked] } as never)).toBe("committed");
    expect((await given())?.notice).toBe(true);
  });
});
