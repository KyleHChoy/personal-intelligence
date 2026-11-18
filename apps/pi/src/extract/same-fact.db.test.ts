import { BELIEF_TYPES, SAME_FACT_CARDS_PER_DAY } from "@intelligence/contracts/personal";
import { sameFactRequestId } from "@intelligence/personal-store";
import {
  DB_TEST_TIMEOUT,
  fingerprint,
  MAIL,
  type PipelineStore,
  queryAs,
  stored,
  withPipeline,
} from "@intelligence/personal-store/testing";
import { describe, expect, it } from "vitest";
import {
  asAdmin,
  commitAll,
  groupingRows,
  sameFactCards,
  scripted,
  situation,
  sweep,
} from "../test-support/same-fact-fixtures.ts";

// The same-fact sweep on Postgres: the sweep as `pi extract` runs it, in shadow (D12), over beliefs
// computed under each clearance, writing knowledge.same_fact_judgments and raising same_fact cards
// as pi_pipeline. A shadow sweep raises one card and groups nothing; a replay pays nothing; the
// fifth card of a day for a label is the last. Invariant 5: no model answer reaches a fact key, a
// label or a tier, and the database refuses a judgment whose label is not its two claims'.

const yes = { answer: "yes", cites: [] };

// The beliefs computed for each audience, each active client's and the owner's, as of the
// database's clock, with every field a model could reach for: the fact key, the label, the
// audience, the support (by stored claim id) and the tier.
const beliefRows = async (store: PipelineStore) =>
  (await store.pipeline.sweepBeliefs(BELIEF_TYPES)).flatMap(({ audience, records }) =>
    records.map((record) => ({
      audience,
      fact_key_fp: record.factKeyFp,
      compartments: record.compartments,
      support: record.belief.support.map((id) => fingerprint(store.db.keys, "claim", id)).sort(),
      tier: record.tier ?? null,
    })),
  );

describe("the same-fact sweep in shadow", { timeout: DB_TEST_TIMEOUT }, () => {
  it("raises one card for two phrasings of one fact, writes its row, and changes no belief", () =>
    withPipeline(async (store) => {
      const canary = await stored(store.writer, store.accounts.personalMail, MAIL.canary);
      const solo = await stored(store.writer, store.accounts.personalMail, MAIL.solo);
      await commitAll(store, canary, [situation(store, canary, "own", 1, "lives in Portland")]);
      await commitAll(store, solo, [situation(store, solo, "own", 1, "based in Portland, OR")]);
      const before = await beliefRows(store);
      expect(before).toHaveLength(2);

      const decideModel = scripted(() => ({ same_fact: 0.97 }));
      const counts = await sweep(
        store,
        decideModel,
        scripted(() => yes),
      );
      expect(counts).toMatchObject({ pairs: 1, asked: 1, accept: 1, saved: 1, raised: 1 });
      const [row, ...others] = await groupingRows(store);
      expect(others).toEqual([]);
      expect(row).toMatchObject({
        audience: ["own"],
        band: "accept",
        rung: 1,
        state: "proposed",
        compartments: ["own"],
      });
      expect(row?.calls).toHaveLength(1);
      expect(row?.calls[0]).toMatch(/^dcc_/);
      const [card, ...more] = await sameFactCards(store);
      expect(more).toEqual([]);
      expect(card).toMatchObject({
        request_id: sameFactRequestId(row?.a_fp ?? "", row?.b_fp ?? "", ["own"]),
        compartments: ["own"],
        options: ["same", "different", "skip"],
        expires_after_days: 14,
      });
      // The join's shape: a claim of key a as its target, key b's fingerprint as its case.
      const [shape] = await asAdmin<{ target_kind: string; target_id: string; case_key: string }>(
        store,
        "select target_kind, target_id, case_key from ledger.cards where id = $1",
        [card?.id],
      );
      expect(shape).toMatchObject({ target_kind: "claim", case_key: row?.b_fp });
      const [target] = await asAdmin<{ fact_key_fp: string }>(
        store,
        "select fact_key_fp from knowledge.claims where id = $1",
        [shape?.target_id],
      );
      expect(target?.fact_key_fp).toBe(row?.a_fp);
      expect(row?.card_id).toBe(card?.id);
      // The saved call is the pair's, under the pair's label, and names its two items.
      const calls = await asAdmin<{ subject: string; compartments: string[]; refs: string[] }>(
        store,
        "select subject, compartments, refs from vault.decision_calls",
      );
      expect(calls).toEqual([
        { subject: `facts:${row?.a_fp}:${row?.b_fp}`, compartments: ["own"], refs: [canary, solo].sort() },
      ]);

      // Nothing groups: the beliefs are as they were.
      expect(await beliefRows(store)).toEqual(before);
      // A second sweep asks nothing again and raises nothing.
      expect(
        await sweep(
          store,
          decideModel,
          scripted(() => yes),
        ),
      ).toMatchObject({ pairs: 1, asked: 0, raised: 0 });
      expect(decideModel.sent).toHaveLength(1);
      expect(await sameFactCards(store)).toHaveLength(1);
    }));

  it("a replay pays nothing: with the rows gone, the same answers come back from the saved calls, and the card is linked, not raised again", () =>
    withPipeline(async (store) => {
      const canary = await stored(store.writer, store.accounts.personalMail, MAIL.canary);
      await commitAll(store, canary, [
        situation(store, canary, "own", 1, "lives in Portland"),
        situation(store, canary, "own", 2, "based in Portland, OR"),
      ]);
      const [decideModel, extractModel] = [
        scripted(() => ({ same_fact: 0.6 })),
        scripted(() => ({ answer: "unsure", cites: [] })),
      ];
      await sweep(store, decideModel, extractModel);
      const first = await groupingRows(store);
      expect(first).toEqual([expect.objectContaining({ band: "middle", rung: 4, state: "proposed" })]);
      expect(first[0]?.calls).toHaveLength(2);
      expect([decideModel.sent.length, extractModel.sent.length]).toEqual([1, 1]);

      await asAdmin(store, "delete from knowledge.same_fact_judgments");
      const again = await sweep(store, decideModel, extractModel);
      expect(again).toMatchObject({ asked: 1, middle: 1, saved: 1, raised: 0 });
      expect([decideModel.sent.length, extractModel.sent.length]).toEqual([1, 1]);
      expect(await groupingRows(store)).toEqual(first);
      expect(await sameFactCards(store)).toHaveLength(1);
      const [usage] = await asAdmin<{ n: number }>(store, "select count(*)::int as n from vault.decision_calls");
      expect(usage?.n).toBe(2);
    }));

  it(`at most ${SAME_FACT_CARDS_PER_DAY} cards a day for a label, newest pair first; the rest wait with no card`, () =>
    withPipeline(async (store) => {
      const canary = await stored(store.writer, store.accounts.personalMail, MAIL.canary);
      const domains = ["home", "travel", "health", "money", "career", "faith"];
      await commitAll(
        store,
        canary,
        domains.flatMap((domain, n) => [
          situation(
            store,
            canary,
            "own",
            2 * n + 1,
            "lives in Portland",
            domain,
            `2026-09-${String(10 + n).padStart(2, "0")}T09:00:00.000Z`,
          ),
          situation(
            store,
            canary,
            "own",
            2 * n + 2,
            "based in Portland, OR",
            domain,
            `2026-09-${String(10 + n).padStart(2, "0")}T09:00:00.000Z`,
          ),
        ]),
      );
      const counts = await sweep(
        store,
        scripted(() => ({ same_fact: 0.97 })),
      );
      expect(counts).toMatchObject({ pairs: 6, saved: 6, raised: SAME_FACT_CARDS_PER_DAY, cardsCapped: 1 });
      const rows = await groupingRows(store);
      const waiting = rows.filter((row) => row.card_id === null);
      expect(waiting).toHaveLength(1);
      // The oldest pair, the "home" one, is the one left: newest pair first.
      const home = ["lives in Portland", "based in Portland, OR"]
        .map((phrase) => fingerprint(store.db.keys, "fact", `k3a situation home ${phrase}`))
        .sort();
      expect([waiting[0]?.a_fp, waiting[0]?.b_fp]).toEqual(home);
      expect(await sweep(store)).toMatchObject({ raised: 0, cardsCapped: 1 });
      expect(await sameFactCards(store)).toHaveLength(SAME_FACT_CARDS_PER_DAY);
    }));
});

describe("invariant 5: no model output reaches a fact key, a label or a tier", { timeout: DB_TEST_TIMEOUT }, () => {
  it("whatever Jev and Luna answer, the beliefs keep their keys, labels and tiers, and each judgment's label is its two claims'", () =>
    withPipeline(async (store) => {
      const canary = await stored(store.writer, store.accounts.personalMail, MAIL.canary);
      const work = await stored(store.writer, store.accounts.workMail, MAIL.workCanary);
      await commitAll(store, canary, [
        situation(store, canary, "own", 1, "lives in Portland"),
        situation(store, canary, "own", 2, "based in Portland, OR"),
      ]);
      await commitAll(store, work, [situation(store, work, "employer:example", 1, "lives in Portland now")]);
      const before = await beliefRows(store);
      // An extract model answer that names a label, a fact key and a tier is refused by its closed schema.
      const forged = {
        answer: "yes",
        cites: [],
        compartments: ["employer:example"],
        label: { compartments: ["own"] },
        factKey: "f".repeat(64),
        tier: "owner",
      };
      await sweep(
        store,
        scripted(() => ({ same_fact: 0.5 })),
        scripted(() => forged),
      );
      expect(await beliefRows(store)).toEqual(before);
      const rows = await groupingRows(store);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        const read = await asAdmin<{ fact_key_fp: string; compartments: string[] }>(
          store,
          `select c.fact_key_fp, c.compartments from knowledge.same_fact_judgments j
           join knowledge.claims c on c.id in (j.a_claim, j.b_claim)
           where j.a_fp = $1 and j.b_fp = $2 and j.compartments = $3 order by c.fact_key_fp`,
          [row.a_fp, row.b_fp, row.compartments],
        );
        expect(read.map((one) => one.fact_key_fp)).toEqual([row.a_fp, row.b_fp]);
        expect(row.compartments).toEqual([...new Set(read.flatMap((one) => one.compartments))].sort());
        expect(row.band).toBe("middle");
      }
      // Every card's label is its pair's.
      for (const card of await sameFactCards(store))
        expect(rows.map((row) => JSON.stringify(row.compartments))).toContain(JSON.stringify(card.compartments));
    }));

  it("the database refuses a judgment whose label is not its two claims', or whose keys are not theirs", () =>
    withPipeline(async (store) => {
      const canary = await stored(store.writer, store.accounts.personalMail, MAIL.canary);
      await commitAll(store, canary, [
        situation(store, canary, "own", 1, "lives in Portland"),
        situation(store, canary, "own", 2, "based in Portland, OR"),
      ]);
      const [a, b] = await asAdmin<{ id: string; fact_key_fp: string }>(
        store,
        'select id, fact_key_fp from knowledge.claims where evidence_id = $1 order by fact_key_fp collate "C"',
        [canary],
      );
      if (a === undefined || b === undefined) throw new Error("no two claims");
      const insert = (compartments: string[], keys = [a.fact_key_fp, b.fact_key_fp]) =>
        queryAs(
          store.db.urls.pipeline,
          "insert into knowledge.same_fact_judgments (a_fp, b_fp, a_claim, b_claim, band, rung, state, pair_at, compartments) values ($1, $2, $3, $4, 'accept', 1, 'accepted', now(), $5)",
          [keys[0], keys[1], a.id, b.id, compartments],
        );
      const refused = async (run: Promise<unknown>): Promise<string | undefined> => {
        try {
          await run;
          return undefined;
        } catch (error) {
          return (error as { code?: string }).code;
        }
      };
      expect(await refused(insert(["employer:example", "own"]))).toBe("23514");
      expect(await refused(insert(["own"], [a.fact_key_fp, "f".repeat(64)]))).toBe("23514");
      // The positive control: the label code computes is taken.
      expect(await refused(insert(["own"]))).toBeUndefined();
    }));
});
