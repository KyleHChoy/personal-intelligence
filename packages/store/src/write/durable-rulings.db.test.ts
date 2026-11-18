import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaimRecord } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { createAdmin } from "../admin/admin.ts";
import { setClientRoles, setDefaultTaskRole, setTaskTier } from "../admin/admin-tasks.ts";
import { detachedCause } from "../admin/extraction/admin-reattach.ts";
import type { Shown } from "../admin/rulings/ruling-anchors.ts";
import { openedUnder } from "../core/tx.ts";
import { CANARY_PERSON, QUENTIN } from "../test-support/cast.ts";
import { insertClient } from "../test-support/clients.ts";
import { session } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import { MAIL } from "../test-support/items-named.ts";
import { asOwner, batchOf, claimRecord, countOf, rowsOf, stored } from "../test-support/pipeline-fixtures.ts";
import { recordingLogger } from "../test-support/recording.ts";
import {
  commitment,
  factIdOf,
  factKeyFpOf,
  personOf,
  type RulingStore,
  withRulings,
} from "../test-support/ruling-fixtures.ts";
import { dispatching, gapTick } from "../test-support/work-test-tasks.ts";
import { expireSourceItem, removeSourceItem, SCRUB_ON_SOURCE_DELETION } from "./writer-item-removal.ts";

// Synthetic data, reserved domains only.

const TIMEOUT = 180_000;

type Anchor = {
  claim_type: string | null;
  evidence_ids: string[] | null;
  entity_ids: string[] | null;
  shown_enc: unknown;
  compartments: string[];
};
const anchorOf = async (store: RulingStore, ruling: string): Promise<Anchor | undefined> =>
  (
    await rowsOf<Anchor>(
      store.db,
      "select claim_type, evidence_ids, entity_ids, shown_enc, compartments from knowledge.belief_rulings where ruling_id = $1",
      [ruling],
    )
  )[0];
const pairAnchorOf = async (store: RulingStore, ruling: string) =>
  (
    await rowsOf<{
      claim_type: string | null;
      a_evidence_ids: string[] | null;
      b_evidence_ids: string[] | null;
      entity_ids: string[] | null;
      shown_enc: unknown;
      compartments: string[];
    }>(
      store.db,
      "select claim_type, a_evidence_ids, b_evidence_ids, entity_ids, shown_enc, compartments from knowledge.fact_rulings where ruling_id = $1",
      [ruling],
    )
  )[0];

const commit = async (store: RulingStore, evidenceId: string, claims: ClaimRecord[], generation = 1): Promise<void> => {
  expect(await store.pipeline.commit(batchOf(evidenceId, claims, { generation }))).toBe("committed");
};
const gateRows = (store: RulingStore, generation: number) =>
  rowsOf<{ ruling_id: string; state: string }>(store.db, "select ruling_id, state from policy.carry_gate($1)", [
    generation,
  ]);

// One personal item with one commitment, which the owner rejects.
async function rejected(store: RulingStore) {
  const canary = await stored(store.writer, store.accounts.personalMail, MAIL.canary);
  const quentin = await stored(store.writer, store.accounts.personalMail, MAIL.fromQuentin);
  const person = await personOf(store, CANARY_PERSON.address, "own");
  const old = commitment(canary, "own", store.owner, person, { factKey: "fact-old" });
  await commit(store, canary, [old]);
  const ruling = await store.admin.facts.rejectClaim(factIdOf(store, old), { requestId: "request-g1-reject-0001" });
  return { canary, quentin, person, old, ruling };
}

describe("a ruling's durable anchors", { timeout: TIMEOUT }, () => {
  it("a reject keeps its claim's type, evidence and entities in clear, and what the owner was shown sealed under its own label", () =>
    withRulings(async (store) => {
      const { canary, person, ruling } = await rejected(store);
      const anchor = await anchorOf(store, ruling);
      expect(anchor).toMatchObject({
        claim_type: "commitment",
        evidence_ids: [canary],
        entity_ids: [person],
        compartments: ["own"],
      });
      const shown = JSON.parse(
        openedUnder(
          store.db.keys,
          ["own"],
          { table: "knowledge.belief_rulings", id: ruling, column: "shown_enc" },
          anchor?.shown_enc,
        ),
      ) as Shown;
      expect(shown).toMatchObject({
        version: 1,
        verdict: "reject",
        claims: [{ type: "commitment", fields: { counterparty: person, what: "I will send the lamp rota." } }],
      });
      // The sealed value opens at no other coordinate.
      expect(() =>
        openedUnder(
          store.db.keys,
          ["own"],
          { table: "knowledge.belief_rulings", id: ruling, column: "value_enc" },
          anchor?.shown_enc,
        ),
      ).toThrow();
    }));

  it("a veto keeps the evidence of every claim of its key, and a join keeps each side's apart", () =>
    withRulings(async (store) => {
      const canary = await stored(store.writer, store.accounts.personalMail, MAIL.canary);
      const quentin = await stored(store.writer, store.accounts.personalMail, MAIL.fromQuentin);
      const person = await personOf(store, CANARY_PERSON.address, "own");
      const [x, y, z] = [
        commitment(canary, "own", store.owner, person, { factKey: "fact-x" }),
        commitment(quentin, "own", store.owner, person, { factKey: "fact-x" }),
        commitment(quentin, "own", store.owner, person, { n: 2, factKey: "fact-z" }),
      ];
      await commit(store, canary, [x]);
      await commit(store, quentin, [y, z]);
      const veto = await store.admin.facts.vetoFact(factIdOf(store, x), { requestId: "request-g1-veto-00001" });
      expect(await anchorOf(store, veto)).toMatchObject({
        claim_type: "commitment",
        evidence_ids: [canary, quentin].sort(),
        entity_ids: [person],
      });
      const join = await store.admin.facts.joinFacts(factIdOf(store, x), factIdOf(store, z), {
        requestId: "request-g1-join-00001",
      });
      const pair = await pairAnchorOf(store, join);
      const xFirst = factKeyFpOf(store, "fact-x") < factKeyFpOf(store, "fact-z");
      expect(pair).toMatchObject({
        claim_type: "commitment",
        a_evidence_ids: xFirst ? [canary, quentin].sort() : [quentin],
        b_evidence_ids: xFirst ? [quentin] : [canary, quentin].sort(),
        entity_ids: [person],
      });
      expect(pair?.shown_enc).not.toBeNull();
    }));

  it("the anchors are written once: the admin cannot change them, and a second anchoring changes nothing", () =>
    withRulings(async (store) => {
      const { ruling } = await rejected(store);
      const before = await anchorOf(store, ruling);
      await expect(
        queryAs(store.db.urls.admin, "update knowledge.belief_rulings set claim_type = 'role' where ruling_id = $1", [
          ruling,
        ]),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        queryAs(store.db.urls.admin, "update knowledge.belief_rulings set shown_enc = null where ruling_id = $1", [
          ruling,
        ]),
      ).rejects.toMatchObject({ code: "42501" });
      expect(await rowsOf(store.db, "select knowledge.anchor_rulings(null) as n")).toEqual([{ n: 0 }]);
      expect(
        await rowsOf(store.db, "select knowledge.set_ruling_shown($1, $2::jsonb) as written", [ruling, '{"x":1}']),
      ).toEqual([{ written: false }]);
      expect(await anchorOf(store, ruling)).toEqual(before);
      // No other role runs the writers.
      for (const url of [store.db.urls.pipeline, store.db.urls.reader])
        await expect(queryAs(url, "select knowledge.anchor_rulings(null)")).rejects.toMatchObject({ code: "42501" });
    }));

  it("a domain ruling, which records no item, is carried by its anchors with its value, under a ruling_carry", () =>
    withRulings(async (store) => {
      const canary = await stored(store.writer, store.accounts.personalMail, MAIL.canary);
      const need = commitment(canary, "own", store.owner, store.owner, { factKey: "fact-need", type: "need" });
      await commit(store, canary, [need]);
      const ruling = await store.admin.facts.reclassifyFact(factIdOf(store, need), "domain", "health", {
        requestId: "request-g1-domain-0001",
      });
      const again = commitment(canary, "own", store.owner, store.owner, {
        factKey: "fact-need-new",
        type: "need",
        generation: 2,
      });
      await commit(store, canary, [again], 2);
      expect(await store.admin.extraction.reattachRulings({ generation: 2, dryRun: false })).toMatchObject({
        reattached: 1,
        asked: 0,
      });
      const rows = await rowsOf<{ ruling_id: string; fact_key_fp: string; value_enc: unknown; created_at: Date }>(
        store.db,
        "select ruling_id, fact_key_fp, value_enc, created_at from knowledge.belief_rulings where verdict = 'domain' order by ruling_id = $1 desc",
        [ruling],
      );
      expect(rows).toHaveLength(2);
      const [from, carried] = rows;
      expect(carried?.fact_key_fp).toBe(factKeyFpOf(store, "fact-need-new"));
      expect(carried?.created_at).toEqual(from?.created_at);
      expect(
        openedUnder(
          store.db.keys,
          ["own"],
          { table: "knowledge.belief_rulings", id: carried?.ruling_id as string, column: "value_enc" },
          carried?.value_enc,
        ),
      ).toBe("health");
      // A carry by code is never a decision of the owner's (invariant 11).
      expect(
        await rowsOf(store.db, "select kind, card_id, answer from knowledge.owner_decisions where id = $1", [
          carried?.ruling_id,
        ]),
      ).toEqual([{ kind: "ruling_carry", card_id: null, answer: null }]);
      expect(await countOf(store.db, "ledger.cards")).toBe(0);
    }));

  it("a join whose re-keyed side holds exactly one fact is carried to the two keys its sides now are", () =>
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
        requestId: "request-g1-join-00002",
      });
      await commit(
        store,
        quentin,
        [commitment(quentin, "own", store.owner, person, { factKey: "fact-y", generation: 2 })],
        2,
      );
      await commit(
        store,
        canary,
        [commitment(canary, "own", store.owner, person, { factKey: "fact-x-new", generation: 2 })],
        2,
      );
      expect((await store.admin.extraction.carryOver({ generation: 2 })).rulings.unfound).toEqual([join]);
      expect(await gateRows(store, 2)).toEqual([{ ruling_id: join, state: "carries" }]);
      expect(await store.admin.extraction.reattachRulings({ generation: 2, dryRun: false })).toMatchObject({
        reattached: 1,
        asked: 0,
      });
      const keys = [factKeyFpOf(store, "fact-x-new"), factKeyFpOf(store, "fact-y")].sort();
      expect(
        await rowsOf(
          store.db,
          "select verdict, a_fp, b_fp from knowledge.fact_rulings where ruling_id <> $1 and lifted_at is null",
          [join],
        ),
      ).toEqual([{ verdict: "join", a_fp: keys[0], b_fp: keys[1] }]);
      // The carried ruling is found through its carry: the check lists nothing, and a second run writes nothing.
      expect((await store.admin.extraction.carryOver({ generation: 2 })).rulings.unfound).toEqual([]);
      expect(await gateRows(store, 2)).toEqual([]);
      const rulings = await countOf(store.db, "knowledge.fact_rulings");
      await store.admin.extraction.reattachRulings({ generation: 2, dryRun: false });
      expect(await countOf(store.db, "knowledge.fact_rulings")).toBe(rulings);
    }));

  it("R4, invariant 11: a carry never outranks the owner's later word: a ruling the owner made again themselves is left alone", () =>
    withRulings(async (store) => {
      const { canary, person } = await rejected(store);
      const now = commitment(canary, "own", store.owner, person, { factKey: "fact-new", generation: 2 });
      await commit(store, canary, [now], 2);
      await store.admin.facts.rejectClaim(factIdOf(store, now), { requestId: "request-g1-reject-0002" });
      const before = await countOf(store.db, "knowledge.belief_rulings");
      expect(await store.admin.extraction.reattachRulings({ generation: 2, dryRun: false })).toMatchObject({
        reattached: 0,
        skipped: 1,
      });
      expect(await countOf(store.db, "knowledge.belief_rulings")).toBe(before);
      expect(await countOf(store.db, "knowledge.owner_decisions", "kind = 'ruling_carry'")).toBe(0);
    }));
});

// The tick's gap step, as pi_work.
const tick = (store: RulingStore, now: Date): Promise<void> =>
  dispatching({ db: store.db }, (dispatch) => gapTick(dispatch, now));

type Defect = { id: string; compartments: string[]; status: string; by: string | null };
const defectOf = async (store: RulingStore, cause: string): Promise<Defect | undefined> =>
  (
    await rowsOf<Defect>(
      store.db,
      `select i.id, i.compartments,
         coalesce((select e.status from ledger.improvement_events e where e.improvement_id = i.id and e.event = 'status'
                   order by e.created_at desc, e.id collate "C" desc limit 1), 'open') as status,
         (select e.created_by from ledger.improvement_events e where e.improvement_id = i.id and e.event = 'status'
          order by e.created_at desc, e.id collate "C" desc limit 1) as by
       from ledger.improvements i where i.cause = $1`,
      [cause],
    )
  )[0];
const tasksOf = (store: RulingStore, defect: string) =>
  rowsOf<{ trigger: string; compartments: string[]; role: string | null; event: string }>(
    store.db,
    `select o.gap_trigger as trigger, o.compartments, o.role,
       (select r.event from ledger.record_events r where r.row_kind = 'opportunity' and r.row_id = o.id order by r.id desc limit 1) as event
     from ledger.opportunities o where o.gap_source = $1 order by o.created_at, o.id`,
    [defect],
  );

// A ruling whose evidence, read again, holds two facts of its type naming its entities: no code can
// say which it is. Tasks are on, and one agent holds the default task role. The role is an example.
async function detached(store: RulingStore) {
  const made = await rejected(store);
  await commit(
    store,
    made.canary,
    [
      commitment(made.canary, "own", store.owner, made.person, { factKey: "fact-new-1", generation: 2 }),
      commitment(made.canary, "own", store.owner, made.person, { n: 2, factKey: "fact-new-2", generation: 2 }),
    ],
    2,
  );
  await insertClient(store.db, "keeper", ["own"]);
  await session(store.db.urls.admin, async (query) => {
    await setTaskTier(query, true, new Date());
    await setClientRoles(query, "keeper", ["keeper"], new Date());
    await setDefaultTaskRole(query, "keeper", new Date());
    // A defect raises a task only once the owner has set the role defects go to.
    await query("update policy.work_settings set defect_role = 'keeper'");
    await query("select ledger.assign_defects('keeper')");
  });
  return made;
}

describe("a ruling with no unique carry", { timeout: TIMEOUT }, () => {
  it("is an agent's first: a defect under the ruling's label and a task on the board for its role, and no card", () =>
    withRulings(async (store) => {
      const { ruling } = await detached(store);
      expect(await store.admin.extraction.reattachRulings({ generation: 2, dryRun: true })).toMatchObject({
        tasked: 1,
        asked: 0,
      });
      expect(await defectOf(store, detachedCause(ruling, 2))).toBeUndefined();

      expect(await store.admin.extraction.reattachRulings({ generation: 2, dryRun: false })).toEqual({
        generation: 2,
        dryRun: false,
        reattached: 0,
        gone: 0,
        tasked: 1,
        asked: 0,
        skipped: 0,
      });
      const defect = await defectOf(store, detachedCause(ruling, 2));
      expect(defect).toMatchObject({ compartments: ["own"], status: "open" });
      expect(await countOf(store.db, "ledger.cards")).toBe(0);
      // Never a decision, and the ruling is as it was.
      expect(await countOf(store.db, "knowledge.owner_decisions", "kind = 'ruling_carry'")).toBe(0);
      expect(await countOf(store.db, "knowledge.belief_rulings")).toBe(1);

      // The work tick raises the defect's task: the whole signal an agent gets.
      await tick(store, new Date());
      const tasks = await tasksOf(store, defect?.id as string);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({ trigger: "defect", compartments: ["own"], role: "keeper" });

      // While the task may still be worked, a second sweep writes nothing more and asks nobody.
      expect(await store.admin.extraction.reattachRulings({ generation: 2, dryRun: false })).toMatchObject({
        tasked: 1,
        asked: 0,
      });
      expect(await countOf(store.db, "ledger.improvements", "starts_with(cause, 'ruling_detached:')")).toBe(1);
      expect(await countOf(store.db, "ledger.cards")).toBe(0);
    }));

  it("the owner is asked only after that: when the wait has run out the card is raised and the defect closes", () =>
    withRulings(async (store) => {
      const { ruling } = await detached(store);
      await store.admin.extraction.reattachRulings({ generation: 2, dryRun: false });
      const later = createAdmin({
        url: store.db.urls.admin,
        keys: store.db.keys,
        log: recordingLogger().log,
        now: () => new Date(Date.now() + 49 * 3_600_000),
      });
      try {
        expect(await later.extraction.reattachRulings({ generation: 2, dryRun: false })).toMatchObject({
          tasked: 0,
          asked: 1,
        });
      } finally {
        await later.close();
      }
      expect(await rowsOf(store.db, "select kind, created_by, compartments from ledger.cards")).toEqual([
        { kind: "ruling_carry", created_by: "system:carry", compartments: ["own"] },
      ]);
      expect(await defectOf(store, detachedCause(ruling, 2))).toMatchObject({ status: "done", by: "system:measure" });
      // Asked once: the next sweep skips it.
      expect(await store.admin.extraction.reattachRulings({ generation: 2, dryRun: false })).toMatchObject({
        tasked: 0,
        asked: 0,
        skipped: 1,
      });
    }));

  it("a later generation that holds exactly one such fact carries the ruling by code and closes the defect", () =>
    withRulings(async (store) => {
      const { canary, person, ruling } = await detached(store);
      await store.admin.extraction.reattachRulings({ generation: 2, dryRun: false });
      await commit(
        store,
        canary,
        [commitment(canary, "own", store.owner, person, { factKey: "fact-newer", generation: 3 })],
        3,
      );
      expect(await store.admin.extraction.reattachRulings({ generation: 3, dryRun: false })).toMatchObject({
        reattached: 1,
        tasked: 0,
        asked: 0,
      });
      expect(await defectOf(store, detachedCause(ruling, 2))).toMatchObject({ status: "done" });
      expect(await countOf(store.db, "ledger.cards")).toBe(0);
      expect(
        await rowsOf(store.db, "select kind, card_id from knowledge.owner_decisions where kind = 'ruling_carry'"),
      ).toEqual([{ kind: "ruling_carry", card_id: null }]);
    }));

  it("with tasks off no agent can be given it, and the owner is asked at once", () =>
    withRulings(async (store) => {
      const { canary, person } = await rejected(store);
      await commit(
        store,
        canary,
        [
          commitment(canary, "own", store.owner, person, { factKey: "fact-new-1", generation: 2 }),
          commitment(canary, "own", store.owner, person, { n: 2, factKey: "fact-new-2", generation: 2 }),
        ],
        2,
      );
      expect(await store.admin.extraction.reattachRulings({ generation: 2, dryRun: false })).toMatchObject({
        tasked: 0,
        asked: 1,
      });
      expect(await countOf(store.db, "ledger.improvements", "starts_with(cause, 'ruling_detached:')")).toBe(0);
    }));
});

describe("the carry-over gate", { timeout: TIMEOUT }, () => {
  it("before the raise a ruling is pending; read at the generation it carries, is gone, or is detached", () =>
    withRulings(async (store) => {
      const { canary, person, ruling } = await rejected(store);
      expect(await gateRows(store, 2)).toEqual([{ ruling_id: ruling, state: "pending" }]);
      expect(await store.admin.extraction.carryGate(2)).toMatchObject({ refused: false, max: 0, pending: 1 });

      // One fact of its type naming its entities: the carry would re-attach it.
      await commit(
        store,
        canary,
        [commitment(canary, "own", store.owner, person, { factKey: "fact-new", generation: 2 })],
        2,
      );
      expect(await gateRows(store, 2)).toEqual([{ ruling_id: ruling, state: "carries" }]);

      // Two: only a person can say which, and the gate refuses at the owner's line of none.
      await commit(
        store,
        canary,
        [
          commitment(canary, "own", store.owner, person, { factKey: "fact-new-1", generation: 3 }),
          commitment(canary, "own", store.owner, person, { n: 2, factKey: "fact-new-2", generation: 3 }),
        ],
        3,
      );
      expect(await store.admin.extraction.carryGate(3)).toMatchObject({
        refused: true,
        detached: [ruling],
        unanchored: [],
      });
      expect(await store.pipeline.carryGate(3)).toEqual({ refused: true, max: 0, unanchored: 0, detached: 1 });

      // None of its type: the fact is no longer stated, and nothing is asked.
      await commit(
        store,
        canary,
        [
          commitment(canary, "own", store.owner, person, {
            factKey: "fact-receipt",
            type: "transaction.receipt",
            generation: 4,
          }),
        ],
        4,
      );
      expect(await store.admin.extraction.carryGate(4)).toMatchObject({ refused: false, gone: 1, detached: [] });
    }));

  it("the owner ruling again on every fact a detached ruling could now be clears the gate, and on one of two does not", () =>
    withRulings(async (store) => {
      const { canary, person, ruling } = await rejected(store);
      const again = commitment(canary, "own", store.owner, person, { factKey: "fact-new-1", generation: 2 });
      const other = commitment(canary, "own", store.owner, person, { n: 2, factKey: "fact-new-2", generation: 2 });
      await commit(store, canary, [again, other], 2);
      expect(await store.admin.extraction.carryGate(2)).toMatchObject({ refused: true, detached: [ruling] });
      // The owner's own word on one of the two facts the ruling could now be: it may be about the
      // other, so the question stands.
      await store.admin.facts.rejectClaim(factIdOf(store, again), { requestId: "request-g1-reject-0003" });
      expect(await gateRows(store, 2)).toEqual([{ ruling_id: ruling, state: "detached" }]);
      // And on the other: every fact it could be is ruled on again, and nothing is left to ask.
      await store.admin.facts.rejectClaim(factIdOf(store, other), { requestId: "request-g1-reject-0013" });
      expect(await gateRows(store, 2)).toEqual([]);
      expect(await store.admin.extraction.carryGate(2)).toMatchObject({ refused: false, detached: [] });
      expect(await store.pipeline.carryGate(2)).toMatchObject({ refused: false, detached: 0 });
    }));

  it("the owner ruling later on another fact of the same message settles nothing: the detached ruling still refuses", () =>
    withRulings(async (store) => {
      const { canary, person, ruling } = await rejected(store);
      const other = await personOf(store, QUENTIN.address, "own");
      const elsewhere = commitment(canary, "own", store.owner, other, { n: 3, factKey: "fact-other", generation: 2 });
      await commit(
        store,
        canary,
        [
          commitment(canary, "own", store.owner, person, { factKey: "fact-new-1", generation: 2 }),
          commitment(canary, "own", store.owner, person, { n: 2, factKey: "fact-new-2", generation: 2 }),
          elsewhere,
        ],
        2,
      );
      // A later ruling of the owner's on the same evidence, on a fact about someone else.
      await store.admin.facts.rejectClaim(factIdOf(store, elsewhere), { requestId: "request-g1-reject-0004" });
      expect(await gateRows(store, 2)).toEqual([{ ruling_id: ruling, state: "detached" }]);
      expect(await store.admin.extraction.carryGate(2)).toMatchObject({ refused: true, detached: [ruling] });
    }));

  it("a ruling on a fact about the owner alone, which names no entity, is settled the same way", () =>
    withRulings(async (store) => {
      const canary = await stored(store.writer, store.accounts.personalMail, MAIL.canary);
      // A fact about the owner names no entity: the ruling's entities are an empty list.
      const own = (n: number, factKey: string, generation: number): ClaimRecord => {
        const base = claimRecord(canary, "own", store.owner, { n, factKey });
        return generation === 1
          ? base
          : ({
              ...base,
              claim: {
                ...base.claim,
                id: `${base.claim.id.slice(0, 56)}${generation.toString(16).padStart(8, "0")}`,
                extractorGeneration: generation,
              },
            } as ClaimRecord);
      };
      const old = own(1, "fact-own-old", 1);
      await commit(store, canary, [old]);
      const ruling = await store.admin.facts.rejectClaim(factIdOf(store, old), { requestId: "request-h7-reject-0001" });
      expect((await anchorOf(store, ruling))?.entity_ids).toEqual([]);
      const [one, two] = [own(1, "fact-own-new-1", 2), own(2, "fact-own-new-2", 2)];
      await commit(store, canary, [one, two], 2);
      expect(await gateRows(store, 2)).toEqual([{ ruling_id: ruling, state: "detached" }]);
      await store.admin.facts.rejectClaim(factIdOf(store, one), { requestId: "request-h7-reject-0002" });
      expect(await gateRows(store, 2)).toEqual([{ ruling_id: ruling, state: "detached" }]);
      await store.admin.facts.rejectClaim(factIdOf(store, two), { requestId: "request-h7-reject-0003" });
      expect(await gateRows(store, 2)).toEqual([]);
    }));

  it("a ruling_carry card the owner answered settles its ruling, and one the owner then reopened does not", () =>
    withRulings(async (store) => {
      const { ruling } = await detached(store);
      await store.admin.extraction.reattachRulings({ generation: 2, dryRun: false });
      const later = createAdmin({
        url: store.db.urls.admin,
        keys: store.db.keys,
        log: recordingLogger().log,
        now: () => new Date(Date.now() + 49 * 3_600_000),
      });
      try {
        expect(await later.extraction.reattachRulings({ generation: 2, dryRun: false })).toMatchObject({ asked: 1 });
      } finally {
        await later.close();
      }
      const [card] = await rowsOf<{ id: string }>(store.db, "select id from ledger.cards where kind = 'ruling_carry'");
      expect(await gateRows(store, 2)).toEqual([{ ruling_id: ruling, state: "detached" }]);
      const event = (name: string) =>
        asOwner(
          store.db,
          "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('card', $1, $2, clock_timestamp(), 'owner', '{own}')",
          [card?.id, name],
        );
      await event("decided");
      expect(await gateRows(store, 2)).toEqual([]);
      // Taken back, as the owner's undo leaves a card: it waits again, and so does the ruling.
      await event("pending");
      expect(await gateRows(store, 2)).toEqual([{ ruling_id: ruling, state: "detached" }]);
    }));

  it("a claim of the type about someone else is no carry: detached, never carried", () =>
    withRulings(async (store) => {
      const { canary, ruling } = await rejected(store);
      const other = await personOf(store, QUENTIN.address, "own");
      await commit(
        store,
        canary,
        [commitment(canary, "own", store.owner, other, { factKey: "fact-new", generation: 2 })],
        2,
      );
      expect(await gateRows(store, 2)).toEqual([{ ruling_id: ruling, state: "detached" }]);
    }));

  it("the owner's lever moves the line, and no other role reads the gate", () =>
    withRulings(async (store) => {
      const { canary, person } = await rejected(store);
      await commit(
        store,
        canary,
        [
          commitment(canary, "own", store.owner, person, { factKey: "fact-new-1", generation: 2 }),
          commitment(canary, "own", store.owner, person, { n: 2, factKey: "fact-new-2", generation: 2 }),
        ],
        2,
      );
      expect((await store.admin.extraction.carryGate(2)).refused).toBe(true);
      // The owner's override is a command: `pia levers set extract.carry_gate_max 1`.
      await store.admin.box.setLever("extract.carry_gate_max", 1);
      expect(await store.admin.extraction.carryGate(2)).toMatchObject({ refused: false, max: 1 });
      await expect(queryAs(store.db.urls.reader, "select * from policy.carry_gate(2)")).rejects.toMatchObject({
        code: "42501",
      });
    }));
});

describe("a deletion reaches a ruling's anchors", { timeout: TIMEOUT }, () => {
  it("R6, invariant 10: erasing the item a ruling was made on removes what the owner was shown and the evidence id, and the ruling stays", () =>
    withRulings(async (store) => {
      const dir = await mkdtemp(join(tmpdir(), "pi-durable-rulings-"));
      const erase = createAdmin({
        url: store.db.urls.admin,
        keys: store.db.keys,
        log: recordingLogger().log,
        journal: join(dir, "keys.json.erasures"),
      });
      try {
        const { canary, ruling } = await rejected(store);
        const [message] = await rowsOf<{ id: string }>(
          store.db,
          "select id from knowledge.messages where evidence_id = $1",
          [canary],
        );
        await erase.erasure.eraseItem(
          { kind: "message", id: message?.id as never },
          { requestId: "request-g1-erase-00001" },
        );
        expect(await anchorOf(store, ruling)).toMatchObject({
          claim_type: "commitment",
          evidence_ids: [],
          shown_enc: null,
        });
        // No clear column of either ruling table holds the erased evidence id.
        expect(await countOf(store.db, "knowledge.belief_rulings", "evidence_ids && $1::text[]", [[canary]])).toBe(0);
        // Erased, it is no longer the gate's or the carry's.
        expect(await gateRows(store, 2)).toEqual([]);
      } finally {
        await erase.close();
        await rm(dir, { recursive: true, force: true });
      }
    }));

  it("erasing a person a ruling's claim named empties its evidence too, so it is never carried to a claim about someone else, and the dry run counts it", () =>
    withRulings(async (store) => {
      const dir = await mkdtemp(join(tmpdir(), "pi-durable-rulings-"));
      const erase = createAdmin({
        url: store.db.urls.admin,
        keys: store.db.keys,
        log: recordingLogger().log,
        journal: join(dir, "keys.json.erasures"),
      });
      try {
        const { person, ruling } = await rejected(store);
        const dry = await erase.erasure.erasePerson(person as never, {
          requestId: "request-g1-erase-00002",
          dryRun: true,
        });
        expect(dry.more).toMatchObject({ ruling_anchors: 1 });
        expect((await anchorOf(store, ruling))?.entity_ids).toEqual([person]);
        await erase.erasure.erasePerson(person as never, { requestId: "request-g1-erase-00003" });
        expect(await anchorOf(store, ruling)).toMatchObject({ evidence_ids: [], entity_ids: [], shown_enc: null });
      } finally {
        await erase.close();
        await rm(dir, { recursive: true, force: true });
      }
    }));
});

type Scrubbed = {
  verdict: string;
  claim_fp: string;
  fact_key_fp: string;
  source_item_fp: string | null;
  item_fps: string[] | null;
  lifted: boolean;
  details: Record<string, string>;
};
const rulingOf = async (store: RulingStore, ruling: string): Promise<Scrubbed | undefined> =>
  (
    await rowsOf<Scrubbed>(
      store.db,
      `select r.verdict, r.claim_fp, r.fact_key_fp, r.source_item_fp, r.item_fps, r.lifted_at is not null as lifted, d.details
       from knowledge.belief_rulings r join knowledge.owner_decisions d on d.id = r.ruling_id where r.ruling_id = $1`,
      [ruling],
    )
  )[0];
// Whether any ruling or decision still holds one of these values, in any of the columns an erasure scrubs.
const heldBy = async (store: RulingStore, values: string[]): Promise<number> =>
  (await countOf(
    store.db,
    "knowledge.belief_rulings",
    "claim_fp = any($1) or fact_key_fp = any($1) or source_item_fp = any($1) or item_fps && $1::text[]",
    [values],
  )) +
  (await countOf(
    store.db,
    "knowledge.owner_decisions",
    "details ->> 'claim' = any($1) or details ->> 'factKey' = any($1)",
    [values],
  ));
const HEX = /^[0-9a-f]{64}$/;

describe("an erasure and the belief rulings made on what it removes", { timeout: TIMEOUT }, () => {
  const erasing = async (fn: (store: RulingStore, erase: ReturnType<typeof createAdmin>) => Promise<void>) =>
    withRulings(async (store) => {
      const dir = await mkdtemp(join(tmpdir(), "pi-durable-rulings-"));
      const erase = createAdmin({
        url: store.db.urls.admin,
        keys: store.db.keys,
        log: recordingLogger().log,
        journal: join(dir, "keys.json.erasures"),
      });
      try {
        await fn(store, erase);
      } finally {
        await erase.close();
        await rm(dir, { recursive: true, force: true });
      }
    });
  const messageOf = async (store: RulingStore, evidence: string): Promise<string> =>
    (await rowsOf<{ id: string }>(store.db, "select id from knowledge.messages where evidence_id = $1", [evidence]))[0]
      ?.id as string;

  it("erasing an item keeps a reject and a veto made on it and takes their identifiers of it: the claim, the emptied key, the item; a key another item still states stays", () =>
    erasing(async (store, erase) => {
      const canary = await stored(store.writer, store.accounts.personalMail, MAIL.canary);
      const quentin = await stored(store.writer, store.accounts.personalMail, MAIL.fromQuentin);
      const person = await personOf(store, CANARY_PERSON.address, "own");
      const [old, x, y] = [
        commitment(canary, "own", store.owner, person, { factKey: "fact-old" }),
        commitment(canary, "own", store.owner, person, { n: 2, factKey: "fact-x" }),
        commitment(quentin, "own", store.owner, person, { factKey: "fact-x" }),
      ];
      await commit(store, canary, [old, x]);
      await commit(store, quentin, [y]);
      const ruling = await store.admin.facts.rejectClaim(factIdOf(store, old), { requestId: "request-g1-reject-0009" });
      const veto = await store.admin.facts.vetoFact(factIdOf(store, x), { requestId: "request-g1-veto-00009" });
      const before = { reject: await rulingOf(store, ruling), veto: await rulingOf(store, veto) };
      expect(before.reject).toMatchObject({
        claim_fp: factIdOf(store, old),
        fact_key_fp: factKeyFpOf(store, "fact-old"),
        details: { claim: factIdOf(store, old) },
      });
      expect(before.veto).toMatchObject({
        claim_fp: factIdOf(store, x),
        details: { factKey: factKeyFpOf(store, "fact-x") },
      });
      expect(before.veto?.item_fps).toHaveLength(2);
      const target = { kind: "message", id: (await messageOf(store, canary)) as never } as const;
      const dry = await erase.erasure.eraseItem(target, { requestId: "request-g1-erase-00011", dryRun: true });
      expect(dry.more).toMatchObject({ belief_rulings: 2 });
      expect(await rulingOf(store, ruling)).toEqual(before.reject);
      const real = await erase.erasure.eraseItem(target, { requestId: "request-g1-erase-00012" });
      expect(real.more.belief_rulings).toBe(2);

      // The reject: its row, verdict and standing stay; the claim, the key and the item are values that name nothing.
      const reject = await rulingOf(store, ruling);
      expect(reject).toMatchObject({ verdict: "reject", lifted: false });
      for (const value of [reject?.claim_fp, reject?.fact_key_fp, reject?.source_item_fp]) expect(value).toMatch(HEX);
      expect(reject?.details).toEqual({ claim: reject?.claim_fp });
      // The veto: the claim it was made on went; its key is still stated by the other item, so it
      // holds it and still stands on it; the erased item is off its list.
      const kept = await rulingOf(store, veto);
      expect(kept).toMatchObject({
        verdict: "veto",
        lifted: false,
        fact_key_fp: factKeyFpOf(store, "fact-x"),
        details: { factKey: factKeyFpOf(store, "fact-x") },
      });
      expect(kept?.item_fps).toEqual(before.veto?.item_fps?.filter((fp) => fp !== before.reject?.source_item_fp));
      expect(kept?.item_fps).toHaveLength(1);
      expect(
        await heldBy(store, [
          factIdOf(store, old),
          factIdOf(store, x),
          factKeyFpOf(store, "fact-old"),
          before.reject?.source_item_fp as string,
        ]),
      ).toBe(0);
      // The owner's list of rulings still reads, and names the reject's claim as gone.
      const listed = await store.admin.facts.listRulings();
      expect(listed.find((one) => one.id === ruling)).toMatchObject({ verdict: "reject", claimGone: true });
      expect(listed.find((one) => one.id === veto)).toMatchObject({ verdict: "veto", claimGone: false });
      // Inert: the erased ruling is no longer the gate's or the carry's.
      expect(await gateRows(store, 2)).toEqual([{ ruling_id: veto, state: "pending" }]);

      // The other item too: now no claim holds the veto's key, and it goes from the ruling and its decision.
      await erase.erasure.eraseItem(
        { kind: "message", id: (await messageOf(store, quentin)) as never },
        { requestId: "request-g1-erase-00013" },
      );
      const emptied = await rulingOf(store, veto);
      expect(emptied).toMatchObject({ verdict: "veto", lifted: false, item_fps: [] });
      expect(emptied?.details).toEqual({ factKey: emptied?.fact_key_fp });
      expect(
        await heldBy(store, [factKeyFpOf(store, "fact-x"), factIdOf(store, y), ...(before.veto?.item_fps ?? [])]),
      ).toBe(0);
    }));

  it("erasing a person takes the claim and the key from every ruling made on a claim naming them, on an item that stays too", () =>
    erasing(async (store, erase) => {
      const { quentin, person, old, ruling } = await rejected(store);
      // A fact about the person stated in someone else's message, which the erasure does not remove.
      const y = commitment(quentin, "own", store.owner, person, { factKey: "fact-y" });
      await commit(store, quentin, [y]);
      const veto = await store.admin.facts.vetoFact(factIdOf(store, y), { requestId: "request-g1-veto-00010" });
      const before = await rulingOf(store, veto);
      const dry = await erase.erasure.erasePerson(person as never, {
        requestId: "request-g1-erase-00014",
        dryRun: true,
      });
      const real = await erase.erasure.erasePerson(person as never, { requestId: "request-g1-erase-00015" });
      expect(dry.more.belief_rulings).toBeGreaterThanOrEqual(2);
      expect(real.more.belief_rulings).toBe(dry.more.belief_rulings);
      for (const id of [ruling, veto]) {
        const row = await rulingOf(store, id);
        expect(row).toMatchObject({ lifted: false });
        expect(row?.claim_fp).toMatch(HEX);
        expect(row?.fact_key_fp).toMatch(HEX);
      }
      expect(
        await heldBy(store, [
          factIdOf(store, old),
          factIdOf(store, y),
          factKeyFpOf(store, "fact-old"),
          factKeyFpOf(store, "fact-y"),
        ]),
      ).toBe(0);
      // The veto's item was not the person's own and is still stored: it stays on the ruling's list.
      expect((await rulingOf(store, veto))?.item_fps).toEqual(before?.item_fps);
      expect(await anchorOf(store, veto)).toMatchObject({ evidence_ids: [], entity_ids: [], shown_enc: null });
      expect(await gateRows(store, 2)).toEqual([]);
    }));

  // The source item of an evidence row, as removeSourceItem takes it.
  const itemOf = async (store: RulingStore, evidence: string) => {
    const [row] = await rowsOf<{ source_account_id: string; source_item_fp: string }>(
      store.db,
      "select source_account_id, source_item_fp from vault.evidence_items where id = $1",
      [evidence],
    );
    return { account: { id: row?.source_account_id as string, compartment: "own" }, fp: row?.source_item_fp as string };
  };
  // One call of the writer's, in a transaction of its own, as a sync makes it.
  const asWriter = <T>(store: RulingStore, fn: (tx: { query: never; keys: RulingStore["db"]["keys"] }) => Promise<T>) =>
    session(store.db.urls.writer, async (query) => {
      await query("begin");
      const result = await fn({ query: query as never, keys: store.db.keys });
      await query("commit");
      return result;
    });

  it("an expiry keeps a ruling's anchor on the evidence row that stays and takes what the owner was shown, whatever revisions the item had", () =>
    withRulings(async (store) => {
      // One revision: nothing but the kept row was ever anchored.
      const { canary, quentin, ruling } = await rejected(store);
      const person = await personOf(store, QUENTIN.address, "own");
      expect((await anchorOf(store, ruling))?.shown_enc).not.toBeNull();
      const item = await itemOf(store, canary);
      await asWriter(store, (tx) => expireSourceItem(tx, item.account, item.fp, new Date()));
      expect(await countOf(store.db, "vault.evidence_items", "id = $1 and payload_state = 'expired'", [canary])).toBe(
        1,
      );
      // The row is still there to find the ruling by, so a later erasure of the item reaches it.
      // The sealed copy of the claim went with the item's content: retention covers it.
      expect(await anchorOf(store, ruling)).toMatchObject({ evidence_ids: [canary], shown_enc: null });
      // A join anchored on the expired item and on one that stays loses its snapshot the same way,
      // and keeps both sides' anchors.
      const [x, y] = [
        commitment(quentin, "own", store.owner, person, { factKey: "fact-x" }),
        commitment(quentin, "own", store.owner, person, { n: 2, factKey: "fact-y" }),
      ];
      await commit(store, quentin, [x, y]);
      const join = await store.admin.facts.joinFacts(factIdOf(store, x), factIdOf(store, y), {
        requestId: "request-g7-join-00001",
      });
      expect((await pairAnchorOf(store, join))?.shown_enc).not.toBeNull();
      const other = await itemOf(store, quentin);
      await asWriter(store, (tx) => expireSourceItem(tx, other.account, other.fp, new Date()));
      expect(await pairAnchorOf(store, join)).toMatchObject({
        a_evidence_ids: [quentin],
        b_evidence_ids: [quentin],
        shown_enc: null,
      });
      // The expired item states nothing any more, so the gate reports its ruling gone; with no
      // snapshot no code could carry it either.
      expect((await gateRows(store, 2)).find((row) => row.ruling_id === ruling)?.state).toBe("gone");
    }));

  it("a ruling that holds only a claim's version 1 key, with no anchor and no item, is reached by that key", () =>
    erasing(async (store, erase) => {
      const canary = await stored(store.writer, store.accounts.personalMail, MAIL.canary);
      const person = await personOf(store, CANARY_PERSON.address, "own");
      const first = commitment(canary, "own", store.owner, person, { factKey: "fact-v1" });
      await commit(store, canary, [first]);
      const veto = await store.admin.facts.vetoFact(factIdOf(store, first), { requestId: "request-h4-veto-00001" });
      // The key changed version: the claim now holds the ruling's key as its version 1 key alone.
      await commit(
        store,
        canary,
        [
          {
            ...commitment(canary, "own", store.owner, person, { factKey: "fact-v2", generation: 2 }),
            legacyFactKey: "fact-v1",
          },
        ],
        2,
      );
      // A ruling made before anchors and before a veto recorded its items.
      await asOwner(
        store.db,
        "update knowledge.belief_rulings set claim_type = null, evidence_ids = null, entity_ids = null, shown_enc = null, item_account_ids = null, item_fps = null where ruling_id = $1",
        [veto],
      );
      expect(await rulingOf(store, veto)).toMatchObject({ fact_key_fp: factKeyFpOf(store, "fact-v1"), item_fps: null });
      await erase.erasure.eraseItem(
        { kind: "message", id: (await messageOf(store, canary)) as never },
        { requestId: "request-h4-erase-00001" },
      );
      expect((await rulingOf(store, veto))?.fact_key_fp).toMatch(HEX);
      expect(await heldBy(store, [factKeyFpOf(store, "fact-v1")])).toBe(0);
    }));

  it("a person's erasure takes the item of a reject and of a veto that was deleted at its source before", () =>
    erasing(async (store, erase) => {
      const { quentin, person } = await rejected(store);
      const [y, z] = [
        commitment(quentin, "own", store.owner, person, { factKey: "fact-y" }),
        commitment(quentin, "own", store.owner, person, { n: 2, factKey: "fact-z" }),
      ];
      await commit(store, quentin, [y, z]);
      const reject = await store.admin.facts.rejectClaim(factIdOf(store, y), { requestId: "request-h4-reject-0002" });
      const veto = await store.admin.facts.vetoFact(factIdOf(store, z), { requestId: "request-h4-veto-00002" });
      const before = { reject: await rulingOf(store, reject), veto: await rulingOf(store, veto) };
      expect(before.veto?.item_fps).toHaveLength(1);
      // The message is deleted at its source: the rulings keep its item, and still name the person.
      const item = await itemOf(store, quentin);
      await asWriter(store, (tx) => removeSourceItem(tx, item.account, item.fp, "deleted"));
      expect(await rulingOf(store, reject)).toEqual(before.reject);
      expect((await anchorOf(store, reject))?.entity_ids).toEqual([person]);
      const dry = await erase.erasure.erasePerson(person as never, {
        requestId: "request-h4-erase-00002",
        dryRun: true,
      });
      const real = await erase.erasure.erasePerson(person as never, { requestId: "request-h4-erase-00003" });
      expect(real.more.belief_rulings).toBe(dry.more.belief_rulings);
      const after = { reject: await rulingOf(store, reject), veto: await rulingOf(store, veto) };
      expect(after.reject?.source_item_fp).toMatch(HEX);
      expect(after.reject?.source_item_fp).not.toBe(before.reject?.source_item_fp);
      expect(after.veto?.item_fps).toEqual([]);
      expect(
        await heldBy(store, [
          before.reject?.source_item_fp as string,
          factIdOf(store, y),
          factIdOf(store, z),
          factKeyFpOf(store, "fact-y"),
          factKeyFpOf(store, "fact-z"),
        ]),
      ).toBe(0);
    }));

  it("a ruling keeps an item that is merely not stored: erasing a mail that stated the same fact takes the key and leaves the reject's dropped document and its claim id", () =>
    erasing(async (store, erase) => {
      const canary = await stored(store.writer, store.accounts.personalMail, MAIL.canary);
      const quentin = await stored(store.writer, store.accounts.personalMail, MAIL.fromQuentin);
      const person = await personOf(store, QUENTIN.address, "own");
      // Two items state one fact. The owner rejects the claim of one and vetoes another fact of it.
      const [shared, other] = [
        commitment(quentin, "own", store.owner, person, { factKey: "fact-shared" }),
        commitment(quentin, "own", store.owner, person, { n: 2, factKey: "fact-other" }),
      ];
      await commit(store, quentin, [shared, other]);
      await commit(store, canary, [commitment(canary, "own", store.owner, person, { factKey: "fact-shared" })]);
      const reject = await store.admin.facts.rejectClaim(factIdOf(store, shared), {
        requestId: "request-h6-reject-0001",
      });
      const veto = await store.admin.facts.vetoFact(factIdOf(store, other), { requestId: "request-h6-veto-00001" });
      // The owner removes what held the first item: it is dropped, not erased, and may be stored again.
      const item = await itemOf(store, quentin);
      await asWriter(store, (tx) => removeSourceItem(tx, item.account, item.fp, "dropped", true));
      expect(await countOf(store.db, "vault.evidence_items", "id = $1", [quentin])).toBe(0);
      const before = { reject: await rulingOf(store, reject), veto: await rulingOf(store, veto) };
      expect(before.reject?.source_item_fp).toBe(item.fp);
      expect(before.veto?.item_fps).toEqual([item.fp]);

      const target = { kind: "message", id: (await messageOf(store, canary)) as never } as const;
      const dry = await erase.erasure.eraseItem(target, { requestId: "request-h6-erase-00001", dryRun: true });
      const real = await erase.erasure.eraseItem(target, { requestId: "request-h6-erase-00002" });
      expect(real.more.belief_rulings).toBe(dry.more.belief_rulings);
      // The erasure reached the reject by the erased mail's key, which is gone: nothing stored
      // states the fact. Its document and its claim were not erased, and stay on the ruling.
      const after = await rulingOf(store, reject);
      expect(after).toMatchObject({
        claim_fp: before.reject?.claim_fp,
        source_item_fp: item.fp,
        details: before.reject?.details,
      });
      expect(after?.fact_key_fp).toMatch(HEX);
      expect(after?.fact_key_fp).not.toBe(factKeyFpOf(store, "fact-shared"));
      // A ruling on another fact of the dropped document is not touched at all.
      expect(await rulingOf(store, veto)).toEqual(before.veto);
    }));

  it("a join made on a key a generation moved since goes with the erased item it was anchored on, and its decision loses both keys", () =>
    erasing(async (store, erase) => {
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
        requestId: "request-h1-join-00001",
      });
      // The canary's side is re-keyed and the join awaits its carry: no claim holds `fact-x` now.
      await commit(
        store,
        canary,
        [commitment(canary, "own", store.owner, person, { factKey: "fact-x-new", generation: 2 })],
        2,
      );
      const held = (key: string) =>
        countOf(store.db, "knowledge.fact_rulings", "a_fp = $1 or b_fp = $1", [factKeyFpOf(store, key)]);
      expect(await held("fact-x")).toBe(1);
      const target = { kind: "message", id: (await messageOf(store, canary)) as never } as const;
      const dry = await erase.erasure.eraseItem(target, { requestId: "request-h1-erase-00001", dryRun: true });
      const real = await erase.erasure.eraseItem(target, { requestId: "request-h1-erase-00002" });
      expect(dry.more.fact_rulings).toBe(1);
      expect(real.more.fact_rulings).toBe(1);
      expect(await held("fact-x")).toBe(0);
      expect(await rowsOf(store.db, "select details from knowledge.owner_decisions where id = $1", [join])).toEqual([
        { details: {} },
      ]);
    }));

  it("invariant 10: the owner's close and reopen of a commitment lose its key when only the retire's anchors reach it", () =>
    erasing(async (store, erase) => {
      const canary = await stored(store.writer, store.accounts.personalMail, MAIL.canary);
      const person = await personOf(store, CANARY_PERSON.address, "own");
      await commit(store, canary, [commitment(canary, "own", store.owner, person, { factKey: "fact-old" })]);
      const fact = factKeyFpOf(store, "fact-old");
      await store.admin.commitments.closeCommitment(fact, "done", { requestId: "request-h2-close-0001" });
      await store.admin.commitments.reopenCommitment(fact, { requestId: "request-h2-reopen-001" });
      const closed = await store.admin.commitments.closeCommitment(fact, "done", {
        requestId: "request-h2-close-0002",
      });
      const holding = async (): Promise<number> =>
        (await countOf(
          store.db,
          "knowledge.owner_decisions",
          "details ->> 'factKey' = $1 or subject_fps && array[$1]",
          [fact],
        )) + (await countOf(store.db, "ledger.commitment_reopens", "fact_fp = $1", [fact]));
      expect(await holding()).toBeGreaterThanOrEqual(4);
      // The key moves with a generation, so the erasure's own claims no longer hold it.
      await commit(
        store,
        canary,
        [commitment(canary, "own", store.owner, person, { factKey: "fact-new", generation: 2 })],
        2,
      );
      await erase.erasure.eraseItem(
        { kind: "message", id: (await messageOf(store, canary)) as never },
        { requestId: "request-h2-erase-00001" },
      );
      expect(await holding()).toBe(0);
      expect(
        await rowsOf(
          store.db,
          "select details, tainted_at is not null as tainted from knowledge.owner_decisions where id = $1",
          [closed.decision],
        ),
      ).toEqual([{ details: { retire: closed.retire, at: expect.any(String) }, tainted: true }]);
    }));

  it("a ruling_carry card is tainted when a candidate claim it lists is erased, and the question is asked again of what is left", () =>
    erasing(async (store, erase) => {
      const canary = await stored(store.writer, store.accounts.personalMail, MAIL.canary);
      const quentin = await stored(store.writer, store.accounts.personalMail, MAIL.fromQuentin);
      const person = await personOf(store, CANARY_PERSON.address, "own");
      const [x, y] = [
        commitment(canary, "own", store.owner, person, { factKey: "fact-x" }),
        commitment(quentin, "own", store.owner, person, { factKey: "fact-x" }),
      ];
      await commit(store, canary, [x]);
      await commit(store, quentin, [y]);
      const veto = await store.admin.facts.vetoFact(factIdOf(store, x), { requestId: "request-h3-veto-00001" });
      // Read again, the two items state two facts: only a person can say which the veto is on.
      const [one, two] = [
        commitment(canary, "own", store.owner, person, { factKey: "fact-x-1", generation: 2 }),
        commitment(quentin, "own", store.owner, person, { factKey: "fact-x-2", generation: 2 }),
      ];
      await commit(store, canary, [one], 2);
      await commit(store, quentin, [two], 2);
      expect(await store.admin.extraction.reattachRulings({ generation: 2, dryRun: false })).toMatchObject({
        asked: 1,
      });
      const cards = () =>
        rowsOf<{ id: string; tainted: boolean; body: boolean; state: string }>(
          store.db,
          `select c.id, c.tainted_at is not null as tainted, c.body_enc is not null as body,
             (select e.event from ledger.record_events e where e.row_kind = 'card' and e.row_id = c.id order by e.id desc limit 1) as state
           from ledger.cards c where c.kind = 'ruling_carry' and starts_with(c.case_key, $1) order by c.created_at, c.id`,
          [`ruling_carry:${veto}:`],
        );
      const [asked] = await cards();
      expect(asked).toMatchObject({ tainted: false, body: true, state: "pending" });
      // Its basis: each candidate it lists, by its claim and its evidence. No ref of the card's.
      expect(
        await rowsOf(
          store.db,
          "select ref_id, evidence_id from ledger.basis where row_kind = 'card' and row_id = $1 and ref_kind = 'carry_claim' order by ref_id",
          [asked?.id],
        ),
      ).toEqual(
        [
          { ref_id: factIdOf(store, one), evidence_id: canary },
          { ref_id: factIdOf(store, two), evidence_id: quentin },
        ].sort((a, b) => (a.ref_id < b.ref_id ? -1 : 1)),
      );
      expect((await store.admin.cards.card(asked?.id as never))?.refs).toEqual([]);

      await erase.erasure.eraseItem(
        { kind: "message", id: (await messageOf(store, quentin)) as never },
        { requestId: "request-h3-erase-00001" },
      );
      expect(await cards()).toEqual([{ id: asked?.id, tainted: true, body: false, state: "withdrawn" }]);
      // The veto still stands on the canary's item, with no snapshot left to carry it by: asked again.
      expect(await store.admin.extraction.reattachRulings({ generation: 2, dryRun: false })).toMatchObject({
        asked: 1,
      });
      expect((await cards()).map((card) => [card.tainted, card.state])).toEqual([
        [true, "withdrawn"],
        [false, "pending"],
      ]);
    }));

  it("a deletion at the source scrubs no ruling while the owner has not ruled on it, and does when switched on; a replacement and a drop never do", async () => {
    expect(SCRUB_ON_SOURCE_DELETION).toBe(false);
    // Off, as shipped: the ruling keeps its claim, its key and its item.
    await withRulings(async (store) => {
      const { canary, ruling } = await rejected(store);
      const before = await rulingOf(store, ruling);
      const item = await itemOf(store, canary);
      await asWriter(store, (tx) => removeSourceItem(tx, item.account, item.fp, "deleted"));
      expect(await countOf(store.db, "vault.evidence_items", "id = $1", [canary])).toBe(0);
      expect(await rulingOf(store, ruling)).toEqual(before);
    });
    // On: a replacement still scrubs nothing; a deletion takes what an erasure takes.
    await withRulings(async (store) => {
      const { canary, quentin, person, old, ruling } = await rejected(store);
      const y = commitment(quentin, "own", store.owner, person, { factKey: "fact-y" });
      await commit(store, quentin, [y]);
      const kept = await store.admin.facts.rejectClaim(factIdOf(store, y), { requestId: "request-h5-reject-0001" });
      const before = { ruling: await rulingOf(store, ruling), kept: await rulingOf(store, kept) };
      const replaced = await itemOf(store, quentin);
      await asWriter(store, (tx) => removeSourceItem(tx, replaced.account, replaced.fp, "replaced", true));
      expect(await rulingOf(store, kept)).toEqual(before.kept);
      // Neither does a drop: the owner removed what held the item, and its source still has it.
      const again = await stored(store.writer, store.accounts.personalMail, MAIL.fromQuentin);
      const z = commitment(again, "own", store.owner, person, { factKey: "fact-z" });
      await commit(store, again, [z]);
      const dropped = await store.admin.facts.rejectClaim(factIdOf(store, z), { requestId: "request-h5-reject-0002" });
      const was = await rulingOf(store, dropped);
      const gone = await itemOf(store, again);
      await asWriter(store, (tx) => removeSourceItem(tx, gone.account, gone.fp, "dropped", true));
      expect(await rulingOf(store, dropped)).toEqual(was);
      const deleted = await itemOf(store, canary);
      await asWriter(store, (tx) => removeSourceItem(tx, deleted.account, deleted.fp, "deleted", true));
      const after = await rulingOf(store, ruling);
      expect(after).toMatchObject({ verdict: "reject", lifted: false });
      for (const value of [after?.claim_fp, after?.fact_key_fp, after?.source_item_fp]) expect(value).toMatch(HEX);
      expect(
        await heldBy(store, [
          factIdOf(store, old),
          factKeyFpOf(store, "fact-old"),
          before.ruling?.source_item_fp as string,
        ]),
      ).toBe(0);
    });
  });
});

describe("saved calls", { timeout: TIMEOUT }, () => {
  const KEY = (evidenceId: string) => ({
    evidenceId,
    revision: 0,
    extractorGeneration: 0,
    promptId: "personal_correspondence",
    promptVersion: "1",
    inputHash: "a".repeat(64),
  });
  const save = (store: RulingStore, evidenceId: string, model: string, output: string) =>
    store.pipeline.calls(model).save({
      key: KEY(evidenceId),
      keys: [{ evidenceId, keyRef: "personal-unsealed" }],
      renderedInput: "",
      rawOutput: output,
      outputHash: "b".repeat(64),
      label: { compartments: ["own"], readers: ["m-owner"] },
      origin: "live",
    } as never);
  const A = '{"claims":[],"narrowing":"none"}';
  const B = '{"claims":[],"narrowing":"sensitive"}';

  it("a new call is keyed by its model: two models keep an answer each, and each replays its own", () =>
    withRulings(async (store) => {
      const id = await stored(store.writer, store.accounts.personalMail, MAIL.canary);
      await save(store, id, "model/one", A);
      await save(store, id, "model/two", B);
      expect(await rowsOf(store.db, "select model_id, key_version from vault.model_calls order by model_id")).toEqual([
        { model_id: "model/one", key_version: 2 },
        { model_id: "model/two", key_version: 2 },
      ]);
      expect((await store.pipeline.calls("model/one").find(KEY(id) as never))?.rawOutput).toBe(A);
      expect((await store.pipeline.calls("model/two").find(KEY(id) as never))?.rawOutput).toBe(B);
      expect(await store.pipeline.calls("model/three").find(KEY(id) as never)).toBeNull();
      // The same model's second save of one key writes nothing.
      await save(store, id, "model/one", B);
      expect(await countOf(store.db, "vault.model_calls")).toBe(2);
    }));

  it("a call stored before the model was part of the key is read by its own key, whatever model asks, and is not rewritten", () =>
    withRulings(async (store) => {
      const id = await stored(store.writer, store.accounts.personalMail, MAIL.canary);
      await save(store, id, "model/one", A);
      await queryAs(store.db.urls.admin, "update vault.model_calls set key_version = 1");
      const [before] = await rowsOf(store.db, "select id, model_id, key_version, output_enc from vault.model_calls");
      expect((await store.pipeline.calls("model/two").find(KEY(id) as never))?.rawOutput).toBe(A);
      // The other model's replay saves nothing, and the stored row is as it was.
      expect(await rowsOf(store.db, "select id, model_id, key_version, output_enc from vault.model_calls")).toEqual([
        before,
      ]);
    }));

  it("a retry keeps the answers an item had, replays none of them, and the next answer is saved beside them", () =>
    withRulings(async (store) => {
      const id = await stored(store.writer, store.accounts.personalMail, MAIL.canary);
      await save(store, id, "model/one", A);
      await commit(store, id, []);
      const [message] = await rowsOf<{ id: string }>(
        store.db,
        "select id from knowledge.messages where evidence_id = $1",
        [id],
      );
      expect(await store.admin.extraction.retry({ messageId: message?.id as never })).toEqual({ selected: 1 });
      expect(await rowsOf(store.db, "select superseded_at is not null as superseded from vault.model_calls")).toEqual([
        { superseded: true },
      ]);
      expect(await store.pipeline.calls("model/one").find(KEY(id) as never)).toBeNull();
      await save(store, id, "model/one", B);
      expect(await countOf(store.db, "vault.model_calls")).toBe(2);
      expect((await store.pipeline.calls("model/one").find(KEY(id) as never))?.rawOutput).toBe(B);
    }));
});
