import { describe, expect, it } from "vitest";
import { session } from "../../test-support/connections.ts";
import { batchOf, countOf, MAIL, rowsOf, stored, withPipeline } from "../../test-support/pipeline-fixtures.ts";
import { recordingLogger } from "../../test-support/recording.ts";
import { seeder } from "../../test-support/seeder.ts";
import { createAdmin } from "../admin.ts";
import { refusals } from "./admin-refusals.ts";

// Refused candidates on a real store: the codes a row keeps, what `pi outcomes` counts of them and
// of the repair and the re-ask, and the two reads and the one write the owner measures and recovers
// them with.

const TIMEOUT = 120_000;

// The seeded saved call is the correspondence lane's; no other lane has one.
const SAVED = {
  correspondence: "personal_correspondence@1",
  transaction: "personal_transaction@1",
  agent: "personal_agent_record@1",
};

const WORDING = {
  id: "u-wording",
  proposedType: "situation",
  reason: "bad_fields" as const,
  field: "what",
  issue: "not_in_passage",
};
const OTHER = { id: "u-other", proposedType: "plan", reason: "bad_speaker" as const };

describe("refused candidates", { timeout: TIMEOUT }, () => {
  it("a row keeps its field and issue sealed; a replay gives an older row its detail and leaves an equal one alone", () =>
    withPipeline(async ({ pipeline, writer, accounts, db }) => {
      const id = await stored(writer, accounts.personalMail, MAIL.canary);
      const { field: _f, issue: _i, ...older } = WORDING;
      await pipeline.commit(batchOf(id, [], { unmapped: [older] }));
      const rows = () =>
        rowsOf<{ id: string; xmin: string; facts: string }>(
          db,
          "select id, xmin::text as xmin, facts_enc::text as facts from vault.unmapped_claims",
        );
      const [before] = await rows();
      expect(before?.facts).not.toContain("not_in_passage");
      await pipeline.commit(batchOf(id, [], { unmapped: [WORDING] }));
      const [after] = await rows();
      expect(after?.id).toBe(before?.id);
      expect(after?.xmin).not.toBe(before?.xmin);
      await pipeline.commit(batchOf(id, [], { unmapped: [WORDING] }));
      expect((await rows())[0]?.xmin).toBe(after?.xmin);
      await expect(
        pipeline.commit(batchOf(id, [], { unmapped: [{ ...WORDING, issue: "the words he wrote" }] })),
      ).rejects.toThrow();
    }));

  it("pi outcomes counts them by type, field and reason, by week and overall, and the repair's and the re-ask's use", () =>
    withPipeline(async ({ pipeline, writer, accounts, db }) => {
      const first = await stored(writer, accounts.personalMail, MAIL.canary);
      const second = await stored(writer, accounts.workMail, MAIL.workCanary);
      await pipeline.commit(batchOf(first, [], { unmapped: [WORDING, OTHER], repaired: 2, reasked: true }));
      await pipeline.commit(batchOf(second, [], { unmapped: [{ ...WORDING, id: "u-work" }] }));
      await pipeline.recordUsage({
        promptId: "personal_correspondence_reask",
        promptVersion: "4",
        modelId: "configured/model",
        inputTokens: 3,
        outputTokens: 2,
        costMicroUsd: 1400,
        outcome: "ok",
      });
      const admin = createAdmin({ url: db.urls.admin, keys: db.keys, log: recordingLogger().log });
      try {
        const { refusals, metrics } = await admin.box.outcomes(14);
        expect(refusals.total).toBe(3);
        expect(refusals.all[0]).toMatchObject({
          source: "email",
          type: "situation",
          reason: "bad_fields",
          field: "what",
          issue: "not_in_passage",
          count: 2,
        });
        expect(refusals.all[1]).toMatchObject({
          type: "plan",
          reason: "bad_speaker",
          field: null,
          issue: null,
          count: 1,
        });
        expect(refusals.weeks.reduce((sum, week) => sum + week.refused, 0)).toBe(3);
        expect(refusals.weeks[0]?.week).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(refusals).toMatchObject({ repaired: 2, reasked: 1, reask: { calls: 1, microUsd: 1400 } });
        expect(metrics.find((one) => one.metric === "candidates_refused")).toMatchObject({
          value: 1,
          sample: 3,
          state: "no_data",
        });
      } finally {
        await admin.close();
      }
    }));

  it("candidates_refused counts only claims a model proposed: code-built ones are no denominator", () =>
    withPipeline(async ({ pipeline, writer, accounts, db }) => {
      const asked = await stored(writer, accounts.personalMail, MAIL.canary);
      const unasked = await stored(writer, accounts.workMail, MAIL.workCanary);
      await pipeline.commit(batchOf(asked, [], { unmapped: [WORDING] }));
      await session(db.urls.admin, async (query) => {
        const seed = seeder(db, query);
        await seed.modelCall(["own"], asked);
        await seed.claim(["own"], asked);
        // A claim from an item no model read: as a contact import's, an owner's word or a goal's.
        await seed.claim(["employer:example"], unasked);
      });
      const view = await session(db.urls.admin, (query) =>
        refusals(query, db.keys, { within: ["own", "employer:example"], since: "2000-01-01T00:00:00.000Z" }),
      );
      expect(view.weeks.reduce((sum, week) => sum + week.claims, 0)).toBe(1);
    }));

  it("replay-refused also selects an item its repair kept whole: it has no refusal row, and the revert must reach it", () =>
    withPipeline(async ({ pipeline, writer, accounts, db }) => {
      const repaired = await stored(writer, accounts.personalMail, MAIL.canary);
      await pipeline.commit(batchOf(repaired, [], { repaired: 1 }));
      await session(db.urls.admin, (query) => seeder(db, query).modelCall(["own"], repaired));
      const admin = createAdmin({ url: db.urls.admin, keys: db.keys, log: recordingLogger().log });
      try {
        expect(
          await admin.extraction.replayRefused({
            generation: 1,
            confirmed: false,
            saved: SAVED,
          }),
        ).toEqual({ selected: 1, skipped: 0, replayed: 1 });
      } finally {
        await admin.close();
      }
      expect((await pipeline.due(10, 1)).map((one) => one.evidenceId)).toContain(repaired);
    }));

  it("replay-refused skips an item whose only saved call is another lane's: a replay would buy its own", () =>
    withPipeline(async ({ pipeline, writer, accounts, db }) => {
      const id = await stored(writer, accounts.personalMail, MAIL.canary);
      await pipeline.commit(batchOf(id, [], { lane: "transaction", unmapped: [WORDING] }));
      await session(db.urls.admin, (query) => seeder(db, query).modelCall(["own"], id));
      const admin = createAdmin({ url: db.urls.admin, keys: db.keys, log: recordingLogger().log });
      try {
        expect(await admin.extraction.replayRefused({ generation: 1, confirmed: false, saved: SAVED })).toEqual({
          selected: 0,
          skipped: 1,
          replayed: 0,
        });
      } finally {
        await admin.close();
      }
    }));

  it("replay-refused leaves a document out and counts it: triage reads its age at the run, and an old one would commit skipped and lose its claims", () =>
    withPipeline(async ({ pipeline, writer, accounts, db }) => {
      const id = await stored(writer, accounts.personalMail, MAIL.canary);
      await pipeline.commit(batchOf(id, [], { lane: "document", unmapped: [WORDING] }));
      await session(db.urls.admin, (query) => seeder(db, query).modelCall(["own"], id));
      const admin = createAdmin({ url: db.urls.admin, keys: db.keys, log: recordingLogger().log });
      try {
        expect(await admin.extraction.replayRefused({ generation: 1, confirmed: true, saved: SAVED })).toEqual({
          selected: 0,
          skipped: 1,
          replayed: 0,
        });
      } finally {
        await admin.close();
      }
      expect((await pipeline.due(10, 1)).map((one) => one.evidenceId)).not.toContain(id);
    }));

  it("a row outside the compartments read is in no count", () =>
    withPipeline(async ({ pipeline, writer, accounts, db }) => {
      const own = await stored(writer, accounts.personalMail, MAIL.canary);
      const work = await stored(writer, accounts.workMail, MAIL.workCanary);
      await pipeline.commit(batchOf(own, [], { unmapped: [WORDING], repaired: 1 }));
      await pipeline.commit(batchOf(work, [], { unmapped: [{ ...WORDING, id: "u-work" }], repaired: 4 }));
      const view = await session(db.urls.admin, (query) =>
        refusals(query, db.keys, { within: ["own"], since: "2000-01-01T00:00:00.000Z" }),
      );
      expect(view).toMatchObject({ total: 1, repaired: 1 });
    }));

  it("refusedItems is the newest refused messages, as the pipeline reads them, and callCost a prompt's mean", () =>
    withPipeline(async ({ pipeline, writer, accounts }) => {
      const refused = await stored(writer, accounts.personalMail, MAIL.canary);
      const clean = await stored(writer, accounts.workMail, MAIL.workCanary);
      await pipeline.commit(batchOf(refused, [], { unmapped: [WORDING] }));
      await pipeline.commit(batchOf(clean, []));
      const items = await pipeline.refusedItems(10, 1);
      expect(items.map((one) => one.evidenceId)).toEqual([refused]);
      expect(items[0]?.committedLane).toBe("correspondence");
      expect(await pipeline.refusedItems(10, 2)).toEqual([]);
      expect(await pipeline.refusedItems(10, 1, { compartments: ["employer:example"] })).toEqual([]);

      expect(await pipeline.callCost("personal_correspondence")).toBeNull();
      const event = {
        promptId: "personal_correspondence",
        promptVersion: "4",
        modelId: "configured/model",
        inputTokens: 1,
        outputTokens: 1,
        outcome: "ok" as const,
      };
      await pipeline.recordUsage({ ...event, costMicroUsd: 1000 });
      await pipeline.recordUsage({ ...event, costMicroUsd: 2000 });
      expect(await pipeline.callCost("personal_correspondence")).toBe(1500);
    }));

  it("replay-refused sets only items with a field refused waiting, keeps their saved answers, and marks the commit as backfill", () =>
    withPipeline(async ({ pipeline, writer, accounts, db }) => {
      const fields = await stored(writer, accounts.personalMail, MAIL.canary);
      const speaker = await stored(writer, accounts.workMail, MAIL.workCanary);
      const notSaved = await stored(writer, accounts.personalMail, MAIL.solo);
      await pipeline.commit(batchOf(fields, [], { unmapped: [WORDING] }));
      await pipeline.commit(batchOf(speaker, [], { unmapped: [OTHER] }));
      await pipeline.commit(batchOf(notSaved, [], { unmapped: [{ ...WORDING, id: "u-unsaved" }] }));
      await session(db.urls.admin, (query) => seeder(db, query).modelCall(["own"], fields));
      const admin = createAdmin({ url: db.urls.admin, keys: db.keys, log: recordingLogger().log });
      try {
        expect(
          await admin.extraction.replayRefused({
            generation: 1,
            confirmed: false,
            saved: SAVED,
          }),
        ).toEqual({
          selected: 1,
          skipped: 1,
          replayed: 1,
        });
      } finally {
        await admin.close();
      }
      expect((await pipeline.due(10, 1)).map((one) => one.evidenceId)).toContain(fields);
      expect((await pipeline.due(10, 1)).map((one) => one.evidenceId)).not.toContain(speaker);
      expect((await pipeline.due(10, 1)).map((one) => one.evidenceId)).not.toContain(notSaved);
      expect(await countOf(db, "vault.unmapped_claims")).toBe(3);
    }));
});
