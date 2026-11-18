import type { EvidenceId } from "@intelligence/contracts";
import type { FactId } from "@intelligence/contracts/personal";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { fingerprint } from "../../core/fingerprint.ts";
import { openStatus } from "../../core/status-facts.ts";
import { createPipeline } from "../../pipeline/pipeline.ts";
import { CANARIES } from "../../test-support/cast.ts";
import { testId } from "../../test-support/clients.ts";
import type { MailFixture } from "../../test-support/items.ts";
import { MAIL } from "../../test-support/items-named.ts";
import {
  batchOf,
  claimRecord,
  countOf,
  type PipelineStore,
  rowsOf,
  stored,
  withAgents,
} from "../../test-support/pipeline-fixtures.ts";
import { recordingLogger } from "../../test-support/recording.ts";
import { withRulings as withAdmin } from "../../test-support/ruling-fixtures.ts";

// The admin's side of extraction. Each refusal has its positive control in the same test.

const TIMEOUT = 240_000;
const evidence = (value: string): EvidenceId => value as EvidenceId;
const EXTRACT = "select pg_advisory_lock(hashtext('intelligence personal extract'))";

const messageOf = async (store: PipelineStore, evidenceId: string): Promise<string> =>
  (await rowsOf<{ id: string }>(store.db, "select id from knowledge.messages where evidence_id = $1", [evidenceId]))[0]
    ?.id ?? "";

// A saved call for an item, under a model id.
const saveCall = (store: PipelineStore, evidenceId: string, model: string) =>
  store.pipeline.calls(model).save({
    key: {
      evidenceId,
      revision: 0,
      extractorGeneration: 0,
      promptId: "personal_correspondence",
      promptVersion: "1",
      inputHash: "a".repeat(64),
    },
    keys: [{ evidenceId, keyRef: "personal-unsealed" }],
    renderedInput: "",
    rawOutput: '{"claims":[],"narrowing":"none"}',
    outputHash: "b".repeat(64),
    label: { compartments: ["own"], readers: ["m-owner"] },
    origin: "live",
  } as never);

const usage = (
  store: PipelineStore,
  outcome: "ok" | "rejected" | "timed_out" | "cost_missing" | "no_answer" | "check",
  cost = 10,
) =>
  store.pipeline.recordUsage({
    promptId: "personal_correspondence",
    promptVersion: "1",
    modelId: "configured/model",
    inputTokens: 1,
    outputTokens: 1,
    costMicroUsd: cost,
    outcome,
  });

// Many messages of one shape, each its own source item.
const many = (count: number): MailFixture[] =>
  Array.from({ length: count }, (_, n) => ({
    ...MAIL.fromQuentin,
    id: `gm-many-${String(n).padStart(4, "0")}`,
    threadId: `thread-many-${n}`,
    messageId: `many-${n}@lighthouse.test`,
    at: `2026-09-0${1 + (n % 9)}T08:00:00Z`,
  }));

describe("the admin's extraction commands", { timeout: TIMEOUT }, () => {
  it("a retry that keeps its answers says what would pay at any size, marks what it chose with its version, and the mark holds only if asked", () =>
    withAdmin(async (store) => {
      const { admin, pipeline, writer, accounts, db } = store;
      const notice = await stored(writer, accounts.personalMail, {
        ...MAIL.solo,
        id: "gm-notice",
        threadId: "thread-notice",
        messageId: "notice@lighthouse.test",
        subject: "Your Week 3 log is overdue",
      });
      const quiet = await stored(writer, accounts.personalMail, MAIL.fromQuentin);
      const unsaved = await stored(writer, accounts.personalMail, MAIL.canary);
      for (const id of [notice, quiet]) await saveCall(store, id, "configured/model");
      for (const id of [notice, quiet, unsaved]) await pipeline.commit(batchOf(id, [], { lane: "transaction" }));
      const off = { replays: ["personal_correspondence@1"], ask: null };
      const keepOff = { correspondence: off, transaction: off, agent: off };
      const keepOn = {
        ...keepOff,
        transaction: {
          replays: ["personal_correspondence@1"],
          ask: {
            version: "4",
            name: "personal_transaction@4",
            choose: ({ subject }: { subject: string | null }) =>
              subject?.includes("overdue") === true ? ("words" as const) : null,
          },
        },
      };
      const selection = { inLane: "transaction", status: "done" } as const;
      // Off: it promises only what the run would buy, the one with nothing saved, and leaves no mark.
      await expect(admin.extraction.retry(selection, { keepAnswers: keepOff })).rejects.toMatchObject({
        code: "confirm_needed",
        selected: 3,
        cost: { asked: 1 },
      });
      // On: two pay, what it chose and the one with nothing saved. Few items, and it still asks.
      const refused = await admin.extraction.retry(selection, { keepAnswers: keepOn }).catch((error: unknown) => error);
      expect(refused).toMatchObject({ code: "confirm_needed", selected: 3, cost: { asked: 2 } });
      expect((refused as { cost: { chars: number } }).cost.chars).toBeGreaterThan(0);
      expect(await pipeline.due(10, 1)).toEqual([]);
      expect(await admin.extraction.retry(selection, { keepAnswers: keepOn, confirmed: true })).toMatchObject({
        selected: 3,
        asked: 2,
      });
      const marked = async (): Promise<[string, string | undefined][]> =>
        (await pipeline.due(10, 1)).flatMap((item) =>
          item.source === "email" && item.ask !== undefined ? [[item.evidenceId, item.ask.version]] : [],
        );
      expect(await marked()).toEqual([[notice, "4"]]);
      const statusOf = async () => {
        const [row] = await rowsOf<{ compartments: string[]; facts_enc: unknown }>(
          db,
          "select compartments, facts_enc from vault.pipeline_items where evidence_id = $1",
          [notice],
        );
        return openStatus({ keys: db.keys } as never, row?.compartments ?? [], notice, row?.facts_enc);
      };
      // A commit that asked it keeps it, so a later replay takes the same version.
      await pipeline.commit(batchOf(notice, [], { lane: "transaction", ask: { lane: "transaction", version: "4" } }));
      expect((await statusOf()).ask).toEqual({ lane: "transaction", version: "4" });
      // A commit that did not, as with the lane off, drops it, so it cannot pay later.
      await pipeline.commit(batchOf(notice, [], { lane: "transaction" }));
      expect((await statusOf()).ask).toBeUndefined();
    }));

  it("the status holds counts, codes, ids and times, and no content", () =>
    withAdmin(async (store) => {
      const { admin, pipeline, writer, accounts, owner, db } = store;
      const done = await stored(writer, accounts.personalMail, MAIL.canary);
      const withheld = await stored(writer, accounts.personalMail, MAIL.fromQuentin);
      const waiting = await stored(writer, accounts.personalMail, MAIL.solo);
      await stored(writer, accounts.personalMail, MAIL.crowd);
      const claim = claimRecord(done, "own", owner);
      await pipeline.commit(
        batchOf(done, [claim], { unmapped: [{ id: "u-1", proposedType: "plan", reason: "bad_times" }], unresolved: 2 }),
      );
      await pipeline.commit(batchOf(withheld, [], { status: "withheld", code: "quarantine" }));
      await pipeline.defer(evidence(waiting), 1, { code: "model_unavailable", lane: "correspondence" });
      await usage(store, "ok", 1500);
      await usage(store, "check", 500);

      const status = await admin.extraction.status({ generation: 1 });
      expect(status.items).toEqual(
        expect.arrayContaining([
          { lane: "correspondence", status: "done", code: null, count: 1 },
          { lane: "correspondence", status: "withheld", code: "quarantine", count: 1 },
          { lane: "correspondence", status: "waiting", code: "model_unavailable", count: 1 },
        ]),
      );
      // The waiting item and the one with no row.
      expect(status.due).toBe(2);
      expect((await admin.extraction.status({ generation: 2 })).due).toBe(3);
      expect((await admin.extraction.status({ generation: 2 })).due).toBe((await pipeline.due(100, 2)).length);
      expect(status.claims).toEqual({ commitment: 1 });
      expect(status.unmapped).toEqual([{ reason: "bad_times", proposedType: "plan", count: 1 }]);
      expect(status.unresolved).toBe(2);
      expect(status.beliefs).toEqual({
        total: 1,
        multiMessage: 0,
        byKind: { commitment: 1 },
        disputedByKind: {},
        byStatus: { active: 1, stale: 0, dormant: 0, expired: 0, closed: 0 },
      });
      expect(status.spend.today).toEqual({ liveCalls: 1, microUsd: 2000 });
      // Each prompt's live calls (a check's left out) and spend today (a check's in),
      // so the prompts sum to the day's.
      expect(status.spend.todayByPrompt).toEqual({ personal_correspondence: { liveCalls: 1, microUsd: 2000 } });
      expect(status.withheld).toEqual({
        count: 1,
        messages: [{ id: await messageOf(store, withheld), at: "2026-09-02T08:15:00.000Z", code: "quarantine" }],
        documents: [],
      });
      const text = JSON.stringify(status);
      for (const content of [CANARIES.subject, CANARIES.bodyText, CANARIES.address, "Statement number", "Lamp rota"])
        expect(text).not.toContain(content);
      expect(await countOf(db, "vault.pipeline_items")).toBe(3);
    }));

  // A client's narrower audience holding the same fact under another status changes nothing.
  it("status counts beliefs by status: each fact key once, computed under the owner's audience (FE5 R31, R29)", () =>
    withAdmin(async ({ admin, pipeline, writer, accounts, owner, db }) => {
      const home = await stored(writer, accounts.personalMail, MAIL.canary);
      const work = await stored(writer, accounts.workMail, MAIL.workCanary);
      const one = claimRecord(home, "own", owner, { factKey: "k-home" });
      const two = claimRecord(work, "employer:example", owner, { factKey: "k-work" });
      await pipeline.commit(batchOf(home, [one]));
      await pipeline.commit(batchOf(work, [two]));
      expect(await pipeline.ownerAudience()).toEqual(["employer:example", "own"]);
      // The owner's retire of one fact closes it at once.
      await admin.facts.retireFact(fingerprint(db.keys, "claim", two.claim.id) as FactId, { requestId: testId("req") });
      expect((await admin.extraction.status({ generation: 1 })).beliefs.byStatus).toEqual({
        active: 1,
        stale: 0,
        dormant: 0,
        expired: 0,
        closed: 1,
      });
    }));

  it("status counts by kind a belief on a confirmed agent record's claim, under the record's whole label", () =>
    withAgents(async (world) => {
      const finding = await world.record("alpha");
      const [row] = await rowsOf<{ compartments: string[] }>(
        world.db,
        "select compartments from vault.evidence_items where id = $1",
        [finding.evidence],
      );
      const label = row?.compartments ?? [];
      expect(label.length).toBeGreaterThan(1);
      const claim = claimRecord(finding.evidence, label, world.owner, { origin: "agent_record", basis: "third_party" });
      await world.pipeline.commit(batchOf(finding.evidence, [claim], { lane: "agent" }));
      // Unconfirmed, an agent's claim builds no belief.
      expect((await world.admin.extraction.status({ generation: 1 })).beliefs).toMatchObject({ total: 0 });
      const [card] = await rowsOf<{ id: string }>(world.db, "select id from ledger.cards where kind = 'agent_claim'");
      await world.admin.cards.decide({
        cards: [card?.id as never],
        answer: "confirm",
        requestId: testId("req").slice(4),
      });
      expect((await world.admin.extraction.status({ generation: 1 })).beliefs).toMatchObject({
        byKind: { commitment: 1 },
        disputedByKind: {},
      });
    }));

  it("with claims under two compartments, status counts each fact once, from the owner's audience", () =>
    withAdmin(async (store) => {
      const { admin, pipeline, writer, accounts, owner } = store;
      const home = await stored(writer, accounts.personalMail, MAIL.canary);
      const work = await stored(writer, accounts.workMail, MAIL.workCanary);
      const one = claimRecord(home, "own", owner, { factKey: "k-home" });
      const two = claimRecord(work, "employer:example", owner, { factKey: "k-work" });
      await pipeline.commit(batchOf(home, [one]));
      await pipeline.commit(batchOf(work, [two]));
      expect(await pipeline.ownerAudience()).toEqual(["employer:example", "own"]);
      expect((await admin.extraction.status({ generation: 1 })).beliefs).toEqual({
        total: 2,
        multiMessage: 0,
        byKind: { commitment: 2 },
        disputedByKind: {},
        byStatus: { active: 2, stale: 0, dormant: 0, expired: 0, closed: 0 },
      });
    }));

  it("a compartment's first claim counts at once, with no rebuild between", () =>
    withAdmin(async (store) => {
      const { admin, pipeline, writer, accounts, owner } = store;
      const home = await stored(writer, accounts.personalMail, MAIL.canary);
      const one = claimRecord(home, "own", owner, { factKey: "k-home" });
      await pipeline.commit(batchOf(home, [one]));
      expect((await admin.extraction.status({ generation: 1 })).beliefs).toMatchObject({
        total: 1,
        byKind: { commitment: 1 },
      });
      // A first claim in employer:example: the owner's audience is now both, and its fact counts.
      const work = await stored(writer, accounts.workMail, MAIL.workCanary);
      await pipeline.commit(batchOf(work, [claimRecord(work, "employer:example", owner, { factKey: "k-work" })]));
      expect(await pipeline.ownerAudience()).toEqual(["employer:example", "own"]);
      expect((await admin.extraction.status({ generation: 1 })).beliefs).toMatchObject({
        total: 2,
        byKind: { commitment: 2 },
      });
    }));

  it("status prints the last ten codes and the day of the last answered call, and no content", () =>
    withAdmin(async (store) => {
      const { admin, pipeline } = store;
      expect((await admin.extraction.status({ generation: 1 })).lastAnswered).toBeNull();
      const counts = {
        done: 0,
        skipped: 0,
        withheld: 0,
        failed: 0,
        waiting: 0,
        claims: 0,
        unmapped: 0,
        unresolved: 0,
        liveCalls: 0,
        beliefs: 0,
        beliefsChanged: 0,
        beliefsMixed: 0,
        beliefsFailed: 0,
        beliefsRemoved: 0,
        rebuildMs: 0,
      };
      for (let n = 0; n < 12; n += 1)
        await pipeline.recordRun({ code: n === 11 ? "budget" : "ok", counts: { ...counts, done: n } });
      const status = await admin.extraction.status({ generation: 1 });
      expect(status.runs).toHaveLength(10);
      expect(status.runs[0]).toMatchObject({ code: "budget", counts: { done: 11 } });
      expect(status.runs.map((run) => run.counts.done)).toEqual([11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
      expect(status.runs[0]?.day).toBe(new Date().toISOString().slice(0, 10));
    }));

  it("lastAnswered is the day of a cost_missing answer and of a check, and not of a timed-out attempt", () =>
    withAdmin(async (store) => {
      const { admin, db } = store;
      const today = new Date().toISOString().slice(0, 10);
      for (const outcome of ["timed_out", "no_answer"] as const) await usage(store, outcome);
      expect((await admin.extraction.status({ generation: 1 })).lastAnswered).toBeNull();
      for (const outcome of ["cost_missing", "check"] as const) {
        await rowsOf(db, "delete from vault.model_usage where outcome in ('cost_missing', 'check')");
        await usage(store, outcome);
        expect((await admin.extraction.status({ generation: 1 })).lastAnswered, outcome).toBe(today);
      }
    }));

  // What extraction's budget compares is its own lane, so `today`, its split
  // by prompt and by basis, and `lastAnswered` read that lane alone; the night's spend is
  // `dreamToday`, beside them.
  it("today, todayByPrompt, todayBasis and lastAnswered read the extract lane alone; dreamToday the dream lane", () =>
    withAdmin(async (store) => {
      const { admin, pipeline } = store;
      const dream = (outcome: "ok" | "check", cost: number) =>
        pipeline.recordUsage(
          {
            promptId: "personal_source_check",
            promptVersion: "1",
            modelId: "configured/model",
            inputTokens: 1,
            outputTokens: 1,
            costMicroUsd: cost,
            outcome,
          },
          "dream",
        );
      await dream("ok", 500);
      await dream("check", 7);
      let spend = (await admin.extraction.status({ generation: 1 })).spend;
      expect(spend.today).toEqual({ liveCalls: 0, microUsd: 0 });
      expect(spend.todayByPrompt).toEqual({});
      expect(spend.todayBasis.reported + spend.todayBasis.price_list + spend.todayBasis.assumed).toBe(0);
      expect(spend.dreamToday).toEqual({ liveCalls: 1, microUsd: 507 });
      expect((await admin.extraction.status({ generation: 1 })).lastAnswered).toBeNull();
      await usage(store, "ok", 10);
      const status = await admin.extraction.status({ generation: 1 });
      spend = status.spend;
      expect(spend.today).toEqual({ liveCalls: 1, microUsd: 10 });
      expect(spend.todayByPrompt).toEqual({ personal_correspondence: { liveCalls: 1, microUsd: 10 } });
      expect(spend.todayBasis.reported + spend.todayBasis.price_list + spend.todayBasis.assumed).toBe(10);
      expect(spend.dreamToday).toEqual({ liveCalls: 1, microUsd: 507 });
      expect(status.lastAnswered).toBe(new Date().toISOString().slice(0, 10));
    }));

  it("status lists the newest fifty withheld items with their codes", () =>
    withAdmin(async (store) => {
      const { admin, pipeline, writer, accounts } = store;
      const ids: string[] = [];
      for (const fixture of many(52)) ids.push(await stored(writer, accounts.personalMail, fixture));
      for (const [n, id] of ids.entries())
        await pipeline.commit(batchOf(id, [], { status: "withheld", code: n % 2 === 0 ? "sensitive" : "quarantine" }));
      const { withheld } = await admin.extraction.status({ generation: 1 });
      expect(withheld.count).toBe(52);
      expect(withheld.messages).toHaveLength(50);
      const times = withheld.messages.map((one) => one.at);
      expect([...times].sort().reverse()).toEqual(times);
      expect(new Set(withheld.messages.map((one) => one.code))).toEqual(new Set(["sensitive", "quarantine"]));
    }));

  it("multiMessage counts a belief whose support spans two messages", () =>
    withAdmin(async (store) => {
      const { admin, pipeline, writer, accounts, owner } = store;
      const a = await stored(writer, accounts.personalMail, MAIL.canary);
      const b = await stored(writer, accounts.personalMail, MAIL.fromQuentin);
      // One fact stated in both messages, and one in the first alone.
      await pipeline.commit(
        batchOf(a, [
          claimRecord(a, "own", owner, { n: 1, factKey: "spans" }),
          claimRecord(a, "own", owner, { n: 2, factKey: "single" }),
        ]),
      );
      await pipeline.commit(batchOf(b, [claimRecord(b, "own", owner, { n: 1, factKey: "spans" })]));
      expect((await admin.extraction.status({ generation: 1 })).beliefs).toMatchObject({
        total: 2,
        multiMessage: 1,
      });
    }));

  it("a sample leaves out reviewed items and is half items with no claim, and with a type holds only items with a claim of it", () =>
    withAdmin(async (store) => {
      const { admin, pipeline, writer, accounts, owner } = store;
      const ids: string[] = [];
      for (const fixture of many(10)) ids.push(await stored(writer, accounts.personalMail, fixture));
      for (const [n, id] of ids.entries()) {
        const claims = n < 5 ? [claimRecord(id, "own", owner, { type: n < 2 ? "plan" : "commitment" })] : [];
        await pipeline.commit(batchOf(id, claims));
      }
      // One item with a claim is reviewed already.
      await admin.extraction.recordReview([{ evidenceId: ids[0] ?? "", type: "plan", verdict: "right" }]);
      const sample = await admin.extraction.reviewSample({ sample: 6 });
      expect(sample).toHaveLength(6);
      expect(sample.map((item) => item.evidenceId)).not.toContain(ids[0]);
      expect(sample.filter((item) => item.claims.length > 0)).toHaveLength(3);
      expect(sample.filter((item) => item.claims.length === 0)).toHaveLength(3);
      // Content is opened for the terminal.
      expect(sample.find((item) => item.claims.length > 0)?.claims[0]?.fields).toMatchObject({
        what: expect.stringContaining("Statement number"),
      });
      expect(sample[0]?.message.subject).toBe(MAIL.fromQuentin.subject);
      const plans = await admin.extraction.reviewSample({ sample: 6, type: "plan" });
      expect(plans.map((item) => item.evidenceId)).toEqual([ids[1]]);
    }));

  it("a verdict keeps the model that answered, through a later retry under another model", () =>
    withAdmin(async (store) => {
      const { admin, pipeline, writer, accounts, db } = store;
      const id = await stored(writer, accounts.personalMail, MAIL.canary);
      await saveCall(store, id, "first/model");
      await pipeline.commit(batchOf(id, []));
      await admin.extraction.recordReview([{ evidenceId: id, type: "commitment", verdict: "missed" }]);
      expect(await admin.extraction.retry({ messageId: await messageOf(store, id) })).toEqual({ selected: 1 });
      await saveCall(store, id, "second/model");
      await pipeline.commit(batchOf(id, []));
      const { reviews } = await admin.extraction.status({ generation: 1 });
      expect(reviews).toEqual([
        { type: "commitment", verdict: "missed", generation: 1, model: "first/model", count: 1 },
      ]);
      expect(await countOf(db, "vault.extraction_reviews")).toBe(1);
    }));

  it("an item already reviewed is not stored again, so a terminal review that sampled it before an import adds nothing", () =>
    withAdmin(async (store) => {
      const { admin, pipeline, writer, accounts, db } = store;
      const id = await stored(writer, accounts.personalMail, MAIL.canary);
      await saveCall(store, id, "first/model");
      await pipeline.commit(batchOf(id, []));
      expect(await admin.extraction.recordReview([{ evidenceId: id, type: "commitment", verdict: "missed" }])).toBe(1);
      expect(await admin.extraction.recordReview([{ evidenceId: id, type: "commitment", verdict: "nothing" }])).toBe(0);
      expect(await countOf(db, "vault.extraction_reviews")).toBe(1);
    }));

  it("a retry by lane selects the items that lane holds, by the owner's lane when set, and sets no lane", () =>
    withAdmin(async (store) => {
      const { admin, pipeline, writer, accounts, db } = store;
      const a = await stored(writer, accounts.personalMail, MAIL.canary);
      const b = await stored(writer, accounts.personalMail, MAIL.fromQuentin);
      const c = await stored(writer, accounts.personalMail, MAIL.solo);
      for (const id of [a, b, c]) await saveCall(store, id, "configured/model");
      await pipeline.commit(batchOf(a, []));
      await pipeline.commit(batchOf(b, [], { lane: "transaction" }));
      await pipeline.commit(batchOf(c, [], { status: "failed", code: "cut_off" }));

      // Keeping the answers: waiting again, every saved call still there.
      const held = await rowsOf<{ id: string }>(db, "select id from vault.model_calls order by id");
      const off = { replays: ["personal_correspondence@1"], ask: null };
      const keepAnswers = { correspondence: off, transaction: off, agent: off };
      await expect(
        admin.extraction.retry({ inLane: "correspondence", status: "done" }, { keepAnswers }),
      ).rejects.toMatchObject({ code: "confirm_needed", selected: 1, cost: { asked: 0, chars: 0 } });
      expect(await pipeline.due(10, 1)).toEqual([]);
      expect(
        await admin.extraction.retry({ inLane: "correspondence", status: "done" }, { keepAnswers, confirmed: true }),
      ).toEqual({ selected: 1, asked: 0, chars: 0 });
      expect(await rowsOf<{ id: string }>(db, "select id from vault.model_calls order by id")).toEqual(held);
      expect((await pipeline.due(10, 1)).map((item) => item.evidenceId)).toEqual([a]);
      await pipeline.commit(batchOf(a, []));
      expect(await admin.extraction.retry({ inLane: "correspondence", status: "done" })).toEqual({ selected: 1 });
      expect(
        (
          await rowsOf<{ evidence_id: string }>(
            db,
            "select evidence_id from vault.model_calls where superseded_at is null order by evidence_id",
          )
        ).map((row) => row.evidence_id),
      ).toEqual([b, c].sort());
      const due = await pipeline.due(10, 1);
      expect(due.map((item) => item.evidenceId)).toEqual([a]);
      expect(due.map((item) => (item.source === "email" ? item.ask : undefined))).toEqual([undefined]);
      // A due item carries a lane only when one was set: the retry set none.
      expect(due.map((item) => (item.source === "email" ? item.lane : undefined))).toEqual([undefined]);
      // The owner's lane moves an item into the lane it selects.
      expect(await admin.extraction.retry({ messageId: await messageOf(store, c) }, { lane: "transaction" })).toEqual({
        selected: 1,
      });
      expect(await admin.extraction.retry({ inLane: "transaction" })).toEqual({ selected: 2 });
      expect(await countOf(db, "vault.model_calls", "superseded_at is null")).toBe(0);
      expect(await countOf(db, "vault.model_calls")).toBe(3);
    }));

  it("retry supersedes the selected items' saved calls and no other, keeps them, and leaves every claim in place", () =>
    withAdmin(async (store) => {
      const { admin, pipeline, writer, accounts, owner, db } = store;
      const a = await stored(writer, accounts.personalMail, MAIL.canary);
      const b = await stored(writer, accounts.personalMail, MAIL.fromQuentin);
      const c = await stored(writer, accounts.personalMail, MAIL.solo);
      for (const id of [a, b, c]) await saveCall(store, id, "configured/model");
      await pipeline.commit(batchOf(a, [claimRecord(a, "own", owner)]));
      await pipeline.commit(batchOf(b, [], { status: "failed", code: "cut_off" }));
      await pipeline.commit(batchOf(c, [], { status: "withheld", code: "sensitive" }));

      expect(await admin.extraction.retry({ messageId: await messageOf(store, a) })).toEqual({ selected: 1 });
      expect(
        (
          await rowsOf<{ evidence_id: string }>(
            db,
            "select evidence_id from vault.model_calls where superseded_at is null order by evidence_id",
          )
        ).map((row) => row.evidence_id),
      ).toEqual([b, c].sort());
      expect(await countOf(db, "knowledge.claims")).toBe(1);
      expect((await pipeline.due(10, 1)).map((item) => item.evidenceId)).toEqual([a]);

      expect(await admin.extraction.retry({ status: "failed" })).toEqual({ selected: 1 });
      expect(
        (
          await rowsOf<{ evidence_id: string }>(
            db,
            "select evidence_id from vault.model_calls where superseded_at is null",
          )
        ).map((row) => row.evidence_id),
      ).toEqual([c]);
      expect(await admin.extraction.retry({ all: true }, { lane: "transaction" })).toEqual({ selected: 3 });
      expect(await countOf(db, "vault.model_calls", "superseded_at is null")).toBe(0);
      expect(await countOf(db, "vault.model_calls")).toBe(3);
      expect(await countOf(db, "knowledge.claims")).toBe(1);
      const due = await pipeline.due(10, 1);
      expect(due.map((item) => (item.source === "email" ? item.lane : undefined))).toEqual([
        "transaction",
        "transaction",
        "transaction",
      ]);
      expect(due.every((item) => item.attempts === 0 && !item.override)).toBe(true);
      await expect(admin.extraction.retry({ messageId: "msg_00000000000000000000000000" })).rejects.toMatchObject({
        name: "AdminError",
        code: "not_found",
      });
    }));

  it("retry over fifty items changes nothing until it is confirmed", () =>
    withAdmin(async (store) => {
      const { admin, pipeline, writer, accounts, db } = store;
      for (const fixture of many(51)) {
        const id = await stored(writer, accounts.personalMail, fixture);
        await saveCall(store, id, "configured/model");
        await pipeline.commit(batchOf(id, []));
      }
      await expect(admin.extraction.retry({ status: "done" })).rejects.toMatchObject({
        name: "AdminError",
        code: "confirm_needed",
        selected: 51,
      });
      await expect(admin.extraction.retry({ all: true })).rejects.toMatchObject({
        code: "confirm_needed",
        selected: 51,
      });
      expect(await countOf(db, "vault.model_calls")).toBe(51);
      expect(await pipeline.due(100, 1)).toEqual([]);
      expect(await admin.extraction.retry({ all: true }, { confirmed: true })).toEqual({ selected: 51 });
      expect(await countOf(db, "vault.model_calls", "superseded_at is null")).toBe(0);
      expect(await countOf(db, "vault.model_calls")).toBe(51);
    }));

  it("retry --override marks a withheld item released and keeps its saved call, and is not_found for an item that is not withheld; a retry without it clears the release", () =>
    withAdmin(async (store) => {
      const { admin, pipeline, writer, accounts, db } = store;
      const withheld = await stored(writer, accounts.personalMail, MAIL.canary);
      const done = await stored(writer, accounts.personalMail, MAIL.fromQuentin);
      await saveCall(store, withheld, "configured/model");
      await pipeline.commit(batchOf(withheld, [], { status: "withheld", code: "sensitive" }));
      await pipeline.commit(batchOf(done, []));
      await expect(admin.extraction.release(await messageOf(store, done))).rejects.toMatchObject({
        name: "AdminError",
        code: "not_found",
      });
      await expect(admin.extraction.release("msg_00000000000000000000000000")).rejects.toMatchObject({
        code: "not_found",
      });

      await admin.extraction.release(await messageOf(store, withheld));
      expect(await countOf(db, "vault.model_calls")).toBe(1);
      expect((await pipeline.due(10, 1))[0]).toMatchObject({ evidenceId: withheld, override: true });
      // The next run commits it: done, and no longer withheld.
      await pipeline.commit(batchOf(withheld, []));
      expect(
        await rowsOf(db, "select withheld, screened from vault.pipeline_items where evidence_id = $1", [withheld]),
      ).toEqual([{ withheld: false, screened: true }]);
      // A retry without the override clears the release.
      await admin.extraction.retry({ messageId: await messageOf(store, withheld) });
      expect((await pipeline.due(10, 1))[0]).toMatchObject({ evidenceId: withheld, override: false });
    }));

  it("a retry of a held message leaves it out of due", () =>
    withAdmin(async (store) => {
      const { admin, pipeline, writer, accounts } = store;
      const held = await stored(writer, accounts.personalMail, { ...MAIL.solo, held: true });
      expect(await admin.extraction.retry({ messageId: await messageOf(store, held) })).toEqual({ selected: 1 });
      expect(await pipeline.due(10, 1)).toEqual([]);
    }));

  it("retry and release refuse with extract_running while the extract lock is held on another connection, and work once it is free", () =>
    withAdmin(async (store) => {
      const { admin, pipeline, writer, accounts, db } = store;
      const id = await stored(writer, accounts.personalMail, MAIL.canary);
      await saveCall(store, id, "configured/model");
      await pipeline.commit(batchOf(id, [], { status: "withheld", code: "quarantine" }));
      const message = await messageOf(store, id);
      const run = new pg.Client({ connectionString: db.urls.pipeline });
      await run.connect();
      try {
        await run.query(EXTRACT);
        await expect(admin.extraction.retry({ messageId: message })).rejects.toMatchObject({
          name: "AdminError",
          code: "extract_running",
        });
        await expect(admin.extraction.release(message)).rejects.toMatchObject({ code: "extract_running" });
        expect(await countOf(db, "vault.model_calls")).toBe(1);
      } finally {
        await run.end();
      }
      await admin.extraction.release(message);
      expect(await admin.extraction.retry({ messageId: message })).toEqual({ selected: 1 });
    }));

  it("a run started while retry holds its transaction ends already_running", () =>
    withAdmin(async (store) => {
      const { db } = store;
      // The admin's transaction-level try on the extract key, held open.
      const owner = new pg.Client({ connectionString: db.urls.admin });
      await owner.connect();
      try {
        await owner.query("begin");
        expect(
          (await owner.query("select pg_try_advisory_xact_lock(hashtext('intelligence personal extract')) as held"))
            .rows,
        ).toEqual([{ held: true }]);
        const second = createPipeline({ url: db.urls.pipeline, keys: db.keys, log: recordingLogger().log });
        try {
          expect(await second.withExtractLock(async () => "ran")).toBe("already_running");
          await owner.query("commit");
          expect(await second.withExtractLock(async () => "ran")).toBe("ran");
        } finally {
          await second.close();
        }
      } finally {
        await owner.end();
      }
    }));
});
