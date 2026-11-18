import type { EvidenceId } from "@intelligence/contracts";
import type { DueItem, ExtractionCommit, PersonalPipelineStore, RunSummary } from "@intelligence/contracts/personal";
import { EXTRACT_GENERATION, runExtraction } from "@intelligence/personal-extract";
import { memoryPipelineStore } from "@intelligence/personal-extract/testing";
import { fakeModelClient } from "@intelligence/personal-models/testing";
import { createPipeline } from "@intelligence/personal-store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addClient, evidenceOf, quiet, type Synced, syncedWorld } from "../test-support/extract-fixtures.ts";

// The pipeline port's contract: the same calls on the in-memory store the extract package's unit
// tests run on and on the real store over the same synced world, each read back by Gmail id, since
// the two give different evidence ids. Where they differ this file fails, so the fake cannot drift
// from the store it stands in for. Each test also asserts the port's rule on both.

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

type Side = {
  name: "memory" | "store";
  store: PersonalPipelineStore;
  outputs: Record<string, unknown>;
  gmailOf(evidenceId: string): string;
  idOf(gmailId: string): EvidenceId;
  now: Date;
};

const made: Synced[] = [];
const closing: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closing.splice(0)) await close();
  for (const one of made.splice(0)) await one.drop();
});

// The two stores over one world: the real one on a copy of the synced database, the fake on the
// same world and clock.
async function sides(): Promise<Side[]> {
  const s = await syncedWorld();
  made.push(s);
  // The memory store starts with two clients' audiences, own and both labels: the same here.
  await addClient(s.db, "contract-own", ["own"]);
  await addClient(s.db, "contract-both", ["own", "employer:example"]);
  const real = createPipeline({ url: s.db.urls.pipeline, keys: s.db.keys, log: quiet });
  closing.push(() => real.close());
  const memory = await memoryPipelineStore(s.w, { now: () => s.now });
  const gmailIds = s.w.accounts.flatMap((box) => box.messages.map((message) => message.id));
  const side = (
    name: Side["name"],
    store: PersonalPipelineStore,
    outputs: Record<string, unknown>,
    idOf: (gmailId: string) => EvidenceId,
  ): Side => {
    const back = new Map(gmailIds.map((gmailId) => [idOf(gmailId) as string, gmailId]));
    return {
      name,
      store,
      outputs,
      idOf,
      now: s.now,
      gmailOf: (evidenceId) => back.get(evidenceId) ?? `unknown:${evidenceId}`,
    };
  };
  return [
    side("memory", memory, memory.outputs, (gmailId) => memory.evidenceIdOf(gmailId)),
    side("store", real, s.outputs, (gmailId) => evidenceOf(s, gmailId) as EvidenceId),
  ];
}

// Both sides' answers to one question, which must be equal.
async function same<T>(all: Side[], read: (side: Side) => Promise<T>): Promise<T> {
  const [memory, store] = await Promise.all(all.map(read));
  expect(memory, "the memory store and the real store differ").toEqual(store);
  return store as T;
}

// The lane's rank the due order puts first: a sent or person-written message, then updates and
// primary mail, then the rest and every agent record.
const rankOf = (item: DueItem): number =>
  item.source !== "email"
    ? 2
    : item.triage.direction === "outbound" || !item.triage.bulk
      ? 0
      : item.triage.category === "updates" || item.triage.category === "primary"
        ? 1
        : 2;

// What `due` answers, by Gmail id, sorted so ties the evidence ids break compare equal. The side's
// own order is checked against the port's rule first: rank, then newest first.
async function dueView(side: Side, options?: Parameters<PersonalPipelineStore["due"]>[2]) {
  const due = await side.store.due(1000, EXTRACT_GENERATION, options);
  for (let i = 1; i < due.length; i += 1) {
    const [a, b] = [due[i - 1] as DueItem, due[i] as DueItem];
    const order = rankOf(a) - rankOf(b) || Date.parse(b.sentAt) - Date.parse(a.sentAt);
    expect(
      order,
      `${side.name} orders ${side.gmailOf(a.evidenceId)} after ${side.gmailOf(b.evidenceId)}`,
    ).toBeLessThanOrEqual(0);
  }
  return due
    .map((item) => ({
      gmailId: side.gmailOf(item.evidenceId),
      source: item.source,
      compartments: item.compartments,
      sentAt: item.sentAt,
      attempts: item.attempts,
      ...(item.source === "email" ? { triage: item.triage, lane: item.lane } : {}),
    }))
    .sort((a, b) => (a.gmailId < b.gmailId ? -1 : 1));
}

// The claims that build beliefs, by the Gmail id of the item each came from, without the ids the
// two stores make differently.
async function claimView(side: Side) {
  return (await side.store.beliefClaims())
    .flatMap((group) => group.claims)
    .map((one) => ({
      gmailId: side.gmailOf(one.claim.primaryEvidenceId),
      type: one.claim.content.type,
      compartments: one.claim.label.compartments,
      origin: one.origin,
      subjectKind: one.subjectKind,
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

async function run(side: Side, commits?: ExtractionCommit[]): Promise<RunSummary> {
  const store: PersonalPipelineStore =
    commits === undefined
      ? side.store
      : {
          ...side.store,
          commit: (batch) => {
            commits.push(structuredClone(batch));
            return side.store.commit(batch);
          },
        };
  const summary = await runExtraction({
    store,
    model: fakeModelClient(side.outputs, []),
    modelId: "example/contract-model",
    log: quiet,
    now: () => side.now,
  });
  if (summary === "already_running") throw new Error(`${side.name}: locked`);
  return summary;
}

describe("the pipeline port, on the memory store and the real store alike", () => {
  it("due: the same items, each with its label, triage and lane, in rank then newest-first order", async () => {
    const all = await sides();
    const due = await same(all, (side) => dueView(side));
    expect(due.length).toBeGreaterThan(0);
  });

  it("due within compartments: only items whose whole label is inside them, the same on both", async () => {
    const all = await sides();
    const own = await same(all, (side) => dueView(side, { compartments: ["own"] }));
    const every = await same(all, (side) => dueView(side));
    for (const item of own)
      expect(
        item.compartments.every((one) => one === "own"),
        item.gmailId,
      ).toBe(true);
    // The world has work mail, so the filter leaves some out.
    expect(own.length).toBeGreaterThan(0);
    expect(own.length).toBeLessThan(every.length);
  });

  it("open: each due message under its own label, revision and change kind, with the owner's addresses", async () => {
    const all = await sides();
    await same(all, async (side) => {
      const due = (await side.store.due(1000, EXTRACT_GENERATION)).filter((item) => item.source === "email");
      const opened = [];
      for (const item of due) {
        const one = await side.store.open(item.evidenceId);
        expect(one, side.gmailOf(item.evidenceId)).not.toBeNull();
        if (one === null) continue;
        // The label it opens under is the one due named.
        expect([one.context.compartment]).toEqual(item.compartments);
        opened.push({
          gmailId: side.gmailOf(item.evidenceId),
          compartment: one.context.compartment,
          revision: one.context.revision,
          changeKind: one.changeKind,
          systemOriginated: one.systemOriginated,
          answersSystem: one.answersSystem,
          ownerAddresses: [...one.context.ownerAddresses].sort(),
        });
      }
      return opened.sort((a, b) => (a.gmailId < b.gmailId ? -1 : 1));
    });
  });

  it("withExtractLock: one holder at a time, and the lock is free again once it ends", async () => {
    const all = await sides();
    await same(all, async (side) => {
      const inner = await side.store.withExtractLock(() => side.store.withExtractLock(async () => "ran"));
      const after = await side.store.withExtractLock(async () => "ran");
      return { inner, after };
    });
  });

  it("defer and countAttempt: a deferred item stays due, waiting, with its tries counted", async () => {
    const all = await sides();
    const gmailId = (await dueView(all[1] as Side))[0]?.gmailId ?? "";
    const entry = await same(all, async (side) => {
      const id = side.idOf(gmailId);
      await side.store.defer(id, EXTRACT_GENERATION, { code: "model_unavailable", lane: "correspondence" });
      await side.store.countAttempt([id], EXTRACT_GENERATION);
      await side.store.countAttempt([id], EXTRACT_GENERATION);
      return (await dueView(side)).find((one) => one.gmailId === gmailId);
    });
    expect(entry?.attempts).toBe(2);
  });

  it("a run: the same counts, the same claims, each under its item's label, and nothing left to do after", async () => {
    const all = await sides();
    const labels = new Map((await dueView(all[1] as Side)).map((item) => [item.gmailId, item.compartments]));
    const first = await same(all, async (side) => (await run(side)).counts);
    expect(first.done).toBeGreaterThan(0);
    const claims = await same(all, claimView);
    expect(claims.length).toBeGreaterThan(0);
    // Each claim's label is its item's.
    for (const claim of claims) expect(claim.compartments, claim.gmailId).toEqual(labels.get(claim.gmailId));
    // The owner's audience is every compartment the claims hold.
    const audience = await same(all, (side) => side.store.ownerAudience());
    expect(audience).toEqual([...new Set(claims.flatMap((claim) => claim.compartments))].sort());
    await same(all, async (side) => (await side.store.audiences()).map((one) => [...one].sort()).sort());
    // What the first run left due, and a second run that commits nothing new.
    await same(all, (side) => dueView(side));
    const second = await same(all, async (side) => (await run(side)).counts);
    expect(second.done).toBe(0);
    await same(all, claimView);
  });

  it("commit is idempotent: the same batch again answers the same and stores no second claim", async () => {
    const all = await sides();
    const batches = new Map<string, ExtractionCommit[]>();
    await same(all, async (side) => {
      const commits: ExtractionCommit[] = [];
      batches.set(side.name, commits);
      return (await run(side, commits)).counts;
    });
    const before = await same(all, claimView);
    const answers = await same(all, async (side) => {
      const out: { gmailId: string; answer: string }[] = [];
      for (const batch of batches.get(side.name) ?? [])
        out.push({ gmailId: side.gmailOf(batch.evidenceId), answer: await side.store.commit(batch) });
      return out.sort((a, b) => (a.gmailId < b.gmailId ? -1 : 1));
    });
    expect(answers.length).toBeGreaterThan(0);
    expect(await same(all, claimView)).toEqual(before);
  });
});
