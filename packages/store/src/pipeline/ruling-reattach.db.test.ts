import type { ClaimRecord, FactId } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { createAdmin } from "../admin/admin.ts";
import { questionBody } from "../admin/extraction/admin-reattach.ts";
import { openedUnder } from "../core/tx.ts";
import { asWords } from "../test-support/card-lines.ts";
import { CANARY_PERSON, QUENTIN } from "../test-support/cast.ts";
import { MAIL } from "../test-support/items-named.ts";
import { batchOf, countOf, rowsOf, stored } from "../test-support/pipeline-fixtures.ts";
import { recordingLogger } from "../test-support/recording.ts";
import {
  commitment,
  factIdOf,
  factKeyFpOf,
  personOf,
  type RulingStore,
  withRulings,
} from "../test-support/ruling-fixtures.ts";

// `pia extract carry-over --reattach`. A generation raise deletes the claim a ruling named and
// makes the item's facts again, maybe under new keys; the sweep re-attaches the ruling by code
// where the item now holds exactly one fact of its type and subject, asks the owner about the rest,
// and writes nothing on a dry run. Synthetic data, reserved domains only.

const TIMEOUT = 180_000;

// Every row the sweep may write, counted.
const written = async (store: RulingStore) => ({
  decisions: await countOf(store.db, "knowledge.owner_decisions"),
  rulings: await countOf(store.db, "knowledge.belief_rulings"),
  factRulings: await countOf(store.db, "knowledge.fact_rulings"),
  cards: await countOf(store.db, "ledger.cards"),
});

const commit = async (store: RulingStore, evidenceId: string, claims: ClaimRecord[], generation = 1): Promise<void> => {
  expect(await store.pipeline.commit(batchOf(evidenceId, claims, { generation }))).toBe("committed");
};

// Two personal items: `canary`, whose claim the owner rejects, and `quentin`, which states the same
// fact under the same key, so the fact key's type and subject are still known after the raise.
async function rejected(store: RulingStore, options: { witness?: boolean } = {}) {
  const canary = await stored(store.writer, store.accounts.personalMail, MAIL.canary);
  const quentin = await stored(store.writer, store.accounts.personalMail, MAIL.fromQuentin);
  const person = await personOf(store, CANARY_PERSON.address, "own");
  const old = commitment(canary, "own", store.owner, person, { factKey: "fact-old" });
  await commit(store, canary, [old]);
  if (options.witness !== false)
    await commit(store, quentin, [commitment(quentin, "own", store.owner, person, { factKey: "fact-old" })]);
  const ruling = await store.admin.facts.rejectClaim(factIdOf(store, old), { requestId: "request-d4-reject-0001" });
  return { canary, quentin, person, ruling };
}

const beliefClaimIds = async (store: RulingStore): Promise<string[]> =>
  (await store.pipeline.beliefClaims()).flatMap((group) => group.claims.map((one) => one.claim.id as string));
const NONE = { reattached: 0, gone: 0, tasked: 0, asked: 0, skipped: 0 };

describe("re-attaching rulings a generation raise orphaned", { timeout: TIMEOUT }, () => {
  it("a reject whose item now holds one fact of its type and subject is carried to it, the belief excludes it again, and a second run writes nothing", () =>
    withRulings(async (store) => {
      const { canary, person, ruling } = await rejected(store);
      // The raise: the item's commitment is made again under a new key, beside a receipt.
      const now = commitment(canary, "own", store.owner, person, { factKey: "fact-new", generation: 2 });
      const receipt = commitment(canary, "own", store.owner, person, {
        n: 2,
        factKey: "fact-receipt",
        type: "transaction.receipt",
        generation: 2,
      });
      await commit(store, canary, [now, receipt], 2);
      expect((await store.admin.extraction.carryOver({ generation: 2 })).rulings.unfound).toEqual([ruling]);
      expect(await beliefClaimIds(store)).toContain(now.claim.id);

      // The dry run counts it and writes nothing.
      const before = await written(store);
      expect(await store.admin.extraction.reattachRulings({ generation: 2, dryRun: true })).toEqual({
        generation: 2,
        dryRun: true,
        ...NONE,
        reattached: 1,
      });
      expect(await written(store)).toEqual(before);

      expect(await store.admin.extraction.reattachRulings({ generation: 2, dryRun: false })).toEqual({
        generation: 2,
        dryRun: false,
        ...NONE,
        reattached: 1,
      });
      const [carry] = await rowsOf<{
        id: string;
        kind: string;
        details: unknown;
        card_id: string | null;
        answer: string | null;
        target_kind: string | null;
      }>(
        store.db,
        "select id, kind, details, card_id, answer, target_kind from knowledge.owner_decisions where kind = 'ruling_carry'",
      );
      expect(carry).toMatchObject({
        kind: "ruling_carry",
        details: { from: ruling, claim: factIdOf(store, now) },
        card_id: null,
        answer: null,
        target_kind: null,
      });
      const rows = await rowsOf(
        store.db,
        "select ruling_id, verdict, claim_fp, source_account_id, fact_key_fp, compartments, lifted_at from knowledge.belief_rulings order by created_at, ruling_id",
      );
      expect(rows).toEqual([
        expect.objectContaining({ ruling_id: ruling, claim_fp: expect.any(String), lifted_at: null }),
        {
          ruling_id: carry?.id,
          verdict: "reject",
          claim_fp: factIdOf(store, now),
          source_account_id: store.accounts.personalMail.id,
          fact_key_fp: factKeyFpOf(store, "fact-new"),
          compartments: ["own"],
          lifted_at: null,
        },
      ]);
      // The belief build is given the item's claim no more; the check finds the ruling through its carry.
      expect(await beliefClaimIds(store)).not.toContain(now.claim.id);
      expect((await store.admin.extraction.carryOver({ generation: 2 })).rulings.unfound).toEqual([]);

      // The carry is no decision of the owner's: no card, no answer, and the owner's own corrections are
      // still the one they made. Lessons and calibration read card answers and labels.
      expect(
        await countOf(
          store.db,
          "knowledge.owner_decisions",
          "kind in ('answer', 'card_label', 'silence_verdict', 'harm', 'correction')",
        ),
      ).toBe(1);
      expect(await countOf(store.db, "ledger.cards")).toBe(0);

      // A second run writes nothing.
      const after = await written(store);
      expect(await store.admin.extraction.reattachRulings({ generation: 2, dryRun: false })).toEqual({
        generation: 2,
        dryRun: false,
        ...NONE,
      });
      expect(await written(store)).toEqual(after);
    }));

  it("two facts of the type and subject raise one question naming both claims, and write no ruling", () =>
    withRulings(async (store) => {
      const { canary, person, ruling } = await rejected(store);
      const [one, two] = [
        commitment(canary, "own", store.owner, person, { factKey: "fact-new-1", generation: 2 }),
        commitment(canary, "own", store.owner, person, { n: 2, factKey: "fact-new-2", generation: 2 }),
      ];
      await commit(store, canary, [one, two], 2);
      const before = await written(store);
      expect(await store.admin.extraction.reattachRulings({ generation: 2, dryRun: true })).toEqual({
        generation: 2,
        dryRun: true,
        ...NONE,
        asked: 1,
      });
      expect(await written(store)).toEqual(before);

      expect(await store.admin.extraction.reattachRulings({ generation: 2, dryRun: false })).toEqual({
        generation: 2,
        dryRun: false,
        ...NONE,
        asked: 1,
      });
      expect(await written(store)).toEqual({ ...before, cards: before.cards + 1 });
      const [card] = await rowsOf<{
        id: string;
        kind: string;
        created_by: string;
        case_key: string;
        options: string[];
        compartments: string[];
      }>(store.db, "select id, kind, created_by, case_key, options, compartments from ledger.cards");
      expect(card).toMatchObject({
        kind: "ruling_carry",
        created_by: "system:carry",
        case_key: `ruling_carry:${ruling}:2`,
        options: ["acknowledge"],
        compartments: ["own"],
      });
      const lines = (await store.admin.cards.card(card?.id as never))?.lines ?? [];
      expect(asWords(lines)).toContainEqual({
        text: questionBody(ruling, "reject", 2, [factIdOf(store, one), factIdOf(store, two)].sort()),
        from: "code",
      });
      // Its stored body is read into its parts: the ruling, its verdict and each candidate by id.
      const lost = lines.find((line) => line.key === "ruling_lost");
      expect(lost?.value?.slice(0, 2)).toEqual([
        { kind: "id", of: "ruling", id: ruling },
        { kind: "code", code: "reject" },
      ]);
      expect(lost?.value?.slice(4)).toEqual(
        [factIdOf(store, one), factIdOf(store, two)].sort().map((id) => ({ kind: "id", of: "fact", id })),
      );

      // The question stands: a second run neither asks again nor rules.
      expect(await store.admin.extraction.reattachRulings({ generation: 2, dryRun: false })).toEqual({
        generation: 2,
        dryRun: false,
        ...NONE,
        skipped: 1,
      });
      expect(await written(store)).toEqual({ ...before, cards: before.cards + 1 });
    }));

  it("an item that holds no fact of the type and subject after the raise is gone, and nothing is written", () =>
    withRulings(async (store) => {
      const { canary, person } = await rejected(store);
      await commit(
        store,
        canary,
        [
          commitment(canary, "own", store.owner, person, {
            factKey: "fact-receipt",
            type: "transaction.receipt",
            generation: 2,
          }),
        ],
        2,
      );
      const before = await written(store);
      expect(await store.admin.extraction.reattachRulings({ generation: 2, dryRun: false })).toEqual({
        generation: 2,
        dryRun: false,
        ...NONE,
        gone: 1,
      });
      expect(await written(store)).toEqual(before);
    }));

  it("durable-judgement: with no claim left to say which fact it was, the ruling's anchors do, and it is carried", () =>
    withRulings(async (store) => {
      const { canary, person } = await rejected(store, { witness: false });
      await commit(
        store,
        canary,
        [commitment(canary, "own", store.owner, person, { factKey: "fact-new", generation: 2 })],
        2,
      );
      expect(await store.admin.extraction.reattachRulings({ generation: 2, dryRun: false })).toEqual({
        generation: 2,
        dryRun: false,
        ...NONE,
        reattached: 1,
      });
      expect(await countOf(store.db, "knowledge.belief_rulings")).toBe(2);
    }));

  it("a ruling is never carried onto a fact of the same type and people that says something else: the agents and then the owner are asked", () =>
    withRulings(async (store) => {
      const { canary, person } = await rejected(store, { witness: false });
      // The item read again: one commitment naming the same person, saying the opposite.
      await commit(
        store,
        canary,
        [
          commitment(canary, "own", store.owner, person, {
            factKey: "fact-new",
            generation: 2,
            what: "I will not send the lamp rota.",
          }),
        ],
        2,
      );
      expect(await store.admin.extraction.reattachRulings({ generation: 2, dryRun: false })).toEqual({
        generation: 2,
        dryRun: false,
        ...NONE,
        asked: 1,
      });
      expect(await countOf(store.db, "knowledge.belief_rulings")).toBe(1);
      expect(await countOf(store.db, "knowledge.owner_decisions", "kind = 'ruling_carry'")).toBe(0);
    }));

  it("a ruling with no snapshot of what the owner saw is never carried by code", () =>
    withRulings(async (store) => {
      const { canary, person, ruling } = await rejected(store, { witness: false });
      await rowsOf(store.db, "select knowledge.forget_ruling_anchors('{}', array[$1])", [person]);
      expect(
        await rowsOf(store.db, "select shown_enc from knowledge.belief_rulings where ruling_id = $1", [ruling]),
      ).toEqual([{ shown_enc: null }]);
      await commit(
        store,
        canary,
        [commitment(canary, "own", store.owner, person, { factKey: "fact-new", generation: 2 })],
        2,
      );
      const report = await store.admin.extraction.reattachRulings({ generation: 2, dryRun: false });
      expect(report.reattached).toBe(0);
      expect(await countOf(store.db, "knowledge.owner_decisions", "kind = 'ruling_carry'")).toBe(0);
    }));

  it("a carried ruling keeps what the owner saw, marked as carried, never the new claim's words", () =>
    withRulings(async (store) => {
      const { canary, person, ruling } = await rejected(store, { witness: false });
      // The same statement, read again with another time: the snapshot must keep the first.
      await commit(
        store,
        canary,
        [
          commitment(canary, "own", store.owner, person, {
            factKey: "fact-new",
            generation: 2,
            validFrom: "2026-10-01T09:00:00.000Z",
          }),
        ],
        2,
      );
      expect((await store.admin.extraction.reattachRulings({ generation: 2, dryRun: false })).reattached).toBe(1);
      const rows = await rowsOf<{ ruling_id: string; compartments: string[]; shown_enc: unknown }>(
        store.db,
        "select ruling_id, compartments, shown_enc from knowledge.belief_rulings order by (ruling_id = $1) desc",
        [ruling],
      );
      const [first, carried] = rows.map((row) =>
        JSON.parse(
          openedUnder(
            store.db.keys,
            row.compartments,
            { table: "knowledge.belief_rulings", id: row.ruling_id, column: "shown_enc" },
            row.shown_enc,
          ),
        ),
      );
      expect(first.carriedFrom).toBeUndefined();
      expect(carried).toEqual({ ...first, carriedFrom: ruling });
      expect(carried.claims[0].validFrom).toBe("2026-09-01T09:00:00.000Z");
      // The anchor sweep leaves it as it is.
      await store.admin.extraction.anchorRulings();
      expect(
        await rowsOf(store.db, "select shown_enc from knowledge.belief_rulings where ruling_id = $1", [
          rows[1]?.ruling_id,
        ]),
      ).toEqual([{ shown_enc: rows[1]?.shown_enc }]);
    }));

  it("durable-judgement: with no claim left and a new claim that names someone else, it is asked about, never guessed", () =>
    withRulings(async (store) => {
      const { canary } = await rejected(store, { witness: false });
      const other = await personOf(store, QUENTIN.address, "own");
      await commit(
        store,
        canary,
        [commitment(canary, "own", store.owner, other, { factKey: "fact-new", generation: 2 })],
        2,
      );
      expect(await store.admin.extraction.reattachRulings({ generation: 2, dryRun: false })).toEqual({
        generation: 2,
        dryRun: false,
        ...NONE,
        asked: 1,
      });
      expect(await countOf(store.db, "knowledge.belief_rulings")).toBe(1);
    }));

  it("an item not yet raised is skipped until its raise", () =>
    withRulings(async (store) => {
      const { canary, person } = await rejected(store);
      // The item is made again at generation 1, under a new key: its claims are of an earlier generation.
      await commit(store, canary, [commitment(canary, "own", store.owner, person, { n: 2, factKey: "fact-new" })], 1);
      const before = await written(store);
      expect(await store.admin.extraction.reattachRulings({ generation: 2, dryRun: false })).toEqual({
        generation: 2,
        dryRun: false,
        ...NONE,
        skipped: 1,
      });
      expect(await written(store)).toEqual(before);
    }));

  it("a join whose re-keyed side has two candidates becomes a question, and no ruling is written", () =>
    withRulings(async (store) => {
      const canary = await stored(store.writer, store.accounts.personalMail, MAIL.canary);
      const quentin = await stored(store.writer, store.accounts.personalMail, MAIL.fromQuentin);
      const person = await personOf(store, CANARY_PERSON.address, "own");
      const [x, y] = [
        commitment(canary, "own", store.owner, person, { factKey: "fact-x" }),
        commitment(quentin, "own", store.owner, person, { factKey: "fact-y" }),
      ];
      await commit(store, canary, [x]);
      await commit(store, quentin, [y]);
      const join = await store.admin.facts.joinFacts(factIdOf(store, x), factIdOf(store, y), {
        requestId: "request-d4-join-00001",
      });
      // Both items raised: `fact-y` is kept, `fact-x` is made again as two facts.
      await commit(
        store,
        quentin,
        [commitment(quentin, "own", store.owner, person, { factKey: "fact-y", generation: 2 })],
        2,
      );
      const [one, two] = [
        commitment(canary, "own", store.owner, person, { factKey: "fact-x1", generation: 2 }),
        commitment(canary, "own", store.owner, person, { n: 2, factKey: "fact-x2", generation: 2 }),
      ];
      await commit(store, canary, [one, two], 2);
      expect((await store.admin.extraction.carryOver({ generation: 2 })).rulings.unfound).toEqual([join]);

      const before = await written(store);
      expect(await store.admin.extraction.reattachRulings({ generation: 2, dryRun: false })).toEqual({
        generation: 2,
        dryRun: false,
        ...NONE,
        asked: 1,
      });
      expect(await written(store)).toEqual({ ...before, cards: before.cards + 1 });
      const [card] = await rowsOf<{ id: string; case_key: string }>(store.db, "select id, case_key from ledger.cards");
      expect(card?.case_key).toBe(`ruling_carry:${join}:2`);
      // The candidates it lists are its basis, so a deletion of one taints the card.
      expect(
        await rowsOf(
          store.db,
          "select ref_id from ledger.basis where row_kind = 'card' and row_id = $1 and ref_kind = 'carry_claim' order by ref_id",
          [card?.id],
        ),
      ).toEqual([factIdOf(store, one), factIdOf(store, two)].sort().map((ref_id) => ({ ref_id })));
      const lines = asWords((await store.admin.cards.card(card?.id as never))?.lines ?? []);
      expect(lines).toContainEqual({
        text: questionBody(join, "join", 2, [factIdOf(store, one), factIdOf(store, two)].sort()),
        from: "code",
      });
    }));

  it("a ruling under a compartment the run cannot open is skipped and nothing is touched", () =>
    withRulings(async (store) => {
      const work = await stored(store.writer, store.accounts.workMail, MAIL.workCanary);
      const person = await personOf(store, CANARY_PERSON.address, "employer:example");
      const old = commitment(work, "employer:example", store.owner, person, { factKey: "fact-work" });
      await commit(store, work, [old]);
      await store.admin.facts.rejectClaim(factIdOf(store, old) as FactId, { requestId: "request-d4-work-00001" });
      await commit(
        store,
        work,
        [commitment(work, "employer:example", store.owner, person, { factKey: "fact-work-new", generation: 2 })],
        2,
      );

      const keys = {
        ...store.db.keys,
        compartments: new Map([...store.db.keys.compartments].filter(([compartment]) => compartment === "own")),
      };
      const narrow = createAdmin({ url: store.db.urls.admin, keys, log: recordingLogger().log });
      try {
        const before = await written(store);
        expect(await narrow.extraction.reattachRulings({ generation: 2, dryRun: false })).toEqual({
          generation: 2,
          dryRun: false,
          ...NONE,
          skipped: 1,
        });
        expect(await written(store)).toEqual(before);
      } finally {
        await narrow.close();
      }
      // The control: the admin that opens it carries it by its anchors.
      expect(await store.admin.extraction.reattachRulings({ generation: 2, dryRun: false })).toEqual({
        generation: 2,
        dryRun: false,
        ...NONE,
        reattached: 1,
      });
    }));
});
