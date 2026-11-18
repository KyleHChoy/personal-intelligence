import type { CardId, FactId } from "@intelligence/contracts/personal";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { newId } from "../core/ids.ts";
import { ERASURE_HOOKS } from "../erasure/erasure-hooks.ts";
import { CANARY_PERSON } from "../test-support/cast.ts";
import { session, sqlState } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import { MAIL } from "../test-support/items-named.ts";
import { batchOf, stored } from "../test-support/pipeline-fixtures.ts";
import {
  beliefsUnder,
  commitment,
  factIdOf,
  factKeyFpOf,
  personOf,
  type RulingStore,
  withRulings,
} from "../test-support/ruling-fixtures.ts";

// The belief build itself is tested in `pi` (fact-groups.db.test.ts).

const TIMEOUT = 180_000;
const OWN = ["own"];
const BOTH = ["employer:example", "own"];
const BELIEFS = "select pg_advisory_xact_lock(hashtext('intelligence personal beliefs'))";
let request = 0;
const requestId = (): string => `request-k3b-${String((request += 1)).padStart(8, "0")}`;
const refused = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => "resolved",
    (error: unknown) => (error as { code?: string }).code,
  );

// Three facts of the owner's to the canary person, two under `own` and one under the employer's
// compartment, and one of the canary person's to the owner: a fact of another subject.
async function facts(store: RulingStore) {
  const { pipeline, writer, accounts, owner } = store;
  const canary = await stored(writer, accounts.personalMail, MAIL.canary);
  const solo = await stored(writer, accounts.personalMail, MAIL.solo);
  const work = await stored(writer, accounts.workMail, MAIL.workCanary);
  const person = await personOf(store, CANARY_PERSON.address, "own");
  const stove = commitment(canary, "own", owner, person, { factKey: "fact-stove" });
  const lamp = commitment(solo, "own", owner, person, { factKey: "fact-lamp" });
  const theirs = commitment(solo, "own", person, owner, { n: 2, factKey: "fact-theirs" });
  const rota = commitment(
    work,
    "employer:example",
    owner,
    await personOf(store, CANARY_PERSON.address, "employer:example"),
    { factKey: "fact-rota" },
  );
  expect(await pipeline.commit(batchOf(canary, [stove]))).toBe("committed");
  expect(await pipeline.commit(batchOf(solo, [lamp, theirs]))).toBe("committed");
  expect(await pipeline.commit(batchOf(work, [rota]))).toBe("committed");
  const id = (record: typeof stove): FactId => factIdOf(store, record);
  return { stove, lamp, theirs, rota, id, items: { canary, solo, work } };
}
const sorted = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a]);

describe("the owner's joins and splits", { timeout: TIMEOUT }, () => {
  it("join and split: the rows and decisions, each refusal, the list and the lift", () =>
    withRulings(async (store) => {
      const { admin } = store;
      const { stove, lamp, theirs, rota, id } = await facts(store);
      const [a, b] = sorted(factKeyFpOf(store, "fact-stove"), factKeyFpOf(store, "fact-lamp"));

      const again = requestId();
      const join = await admin.facts.joinFacts(id(lamp), id(stove), { requestId: again });
      // A repeated request id returns the first ruling and writes nothing.
      expect(await admin.facts.joinFacts(id(lamp), id(stove), { requestId: again })).toBe(join);
      expect(
        await queryAs(
          store.db.urls.admin,
          "select ruling_id, verdict, a_fp, b_fp, compartments, lifted_at from knowledge.fact_rulings",
        ),
      ).toEqual([{ ruling_id: join, verdict: "join", a_fp: a, b_fp: b, compartments: OWN, lifted_at: null }]);
      expect(
        await queryAs(store.db.urls.admin, "select kind, details from knowledge.owner_decisions where id = $1", [join]),
      ).toEqual([{ kind: "fact_join", details: { a, b } }]);

      // One ruling in force on a pair: the same again, or the other, is refused until a lift.
      expect(await refused(admin.facts.joinFacts(id(stove), id(lamp), { requestId: requestId() }))).toBe(
        "already_ruled",
      );
      expect(await refused(admin.facts.splitFacts(id(stove), id(lamp), { requestId: requestId() }))).toBe(
        "conflicting_ruling",
      );
      // D17: a join of another subject's fact is refused; a split of it is not.
      expect(await refused(admin.facts.joinFacts(id(stove), id(theirs), { requestId: requestId() }))).toBe(
        "not_one_fact",
      );
      await admin.facts.splitFacts(id(stove), id(theirs), { requestId: requestId() });
      // One fact key twice, and an unknown claim.
      expect(await refused(admin.facts.joinFacts(id(stove), id(stove), { requestId: requestId() }))).toBe(
        "invalid_argument",
      );
      expect(
        await refused(admin.facts.joinFacts(id(stove), "f".repeat(64) as FactId, { requestId: requestId() })),
      ).toBe("not_found");
      // A join across labels takes both keys' compartments.
      const across = await admin.facts.joinFacts(id(stove), id(rota), { requestId: requestId() });
      expect(
        await queryAs(store.db.urls.admin, "select compartments from knowledge.fact_rulings where ruling_id = $1", [
          across,
        ]),
      ).toEqual([{ compartments: BOTH }]);

      expect(
        (await admin.facts.listFactRulings()).map(({ verdict, liftedAt, gone }) => ({ verdict, liftedAt, gone })),
      ).toEqual([
        { verdict: "join", liftedAt: null, gone: false },
        { verdict: "split", liftedAt: null, gone: false },
        { verdict: "join", liftedAt: null, gone: false },
      ]);
      expect(await admin.facts.liftFactRuling(join, { requestId: requestId() })).toBe(true);
      expect(await admin.facts.liftFactRuling(join, { requestId: requestId() })).toBe(false);
      expect((await admin.facts.listFactRulings())[0]?.liftedAt).not.toBeNull();
      expect(
        await queryAs(store.db.urls.admin, "select kind from knowledge.owner_decisions where supersedes = $1", [join]),
      ).toEqual([{ kind: "fact_ruling_lift" }]);
      // Lifted, the pair takes the other ruling.
      await admin.facts.splitFacts(id(stove), id(lamp), { requestId: requestId() });
    }));

  it("every ruling and lift moves the mark, and the pipeline reads those in force", () =>
    withRulings(async (store) => {
      const { admin, pipeline } = store;
      const { stove, lamp, id } = await facts(store);

      const read = await pipeline.beliefDecisions();
      const join = await admin.facts.joinFacts(id(stove), id(lamp), { requestId: requestId() });
      const after = await pipeline.beliefDecisions();
      expect(after.mark).toBe(read.mark + 1);
      const [a, b] = sorted(factKeyFpOf(store, "fact-stove"), factKeyFpOf(store, "fact-lamp"));
      expect(after.factRulings).toEqual([
        { id: join, verdict: "join", a, b, at: expect.any(String), compartments: OWN },
      ]);

      await admin.facts.liftFactRuling(join, { requestId: requestId() });
      const lifted = await pipeline.beliefDecisions();
      expect(lifted.mark).toBe(after.mark + 1);
      expect(lifted.factRulings).toEqual([]);
    }));

  it("0066: the rulings are the admin's, policy.fact_rulings the pipeline's and the restricted role's alone", () =>
    withRulings(async (store) => {
      const { db } = store;
      const { stove, lamp, id } = await facts(store);
      await store.admin.facts.joinFacts(id(stove), id(lamp), { requestId: requestId() });
      for (const url of [db.urls.reader, db.urls.writer, db.urls.pipeline, db.urls.work]) {
        expect(await sqlState(() => queryAs(url, "select * from knowledge.fact_rulings")), url).toBe("42501");
      }
      for (const url of [db.urls.reader, db.urls.writer, db.urls.admin, db.urls.work]) {
        expect(await sqlState(() => queryAs(url, "select * from policy.fact_rulings()")), url).toBe("42501");
      }
      expect(await queryAs(db.urls.pipeline, "select verdict from policy.fact_rulings()")).toEqual([
        { verdict: "join" },
      ]);
    }));

  it("a same_fact card's answer joins its pair, waiting for a rebuild's beliefs lock, and both commit", () =>
    withRulings(async (store) => {
      const { admin, db } = store;
      const { stove, lamp, id } = await facts(store);
      const raise = async (): Promise<CardId> => {
        const card = (
          await admin.cards.raiseCard({
            id: newId("crd") as CardId,
            requestId: requestId(),
            kind: "same_fact",
            author: "system:extract",
            options: ["same", "different", "skip"],
            target: { kind: "claim", id: id(stove) },
            refs: [],
            compartments: ["own"],
            expiresAt: null,
            expiresAfterDays: 14,
            caseKey: factKeyFpOf(store, "fact-lamp"),
            run: null,
            body: null,
            bodyFrom: null,
          })
        ).id;
        return card;
      };
      const card = await raise();
      // The card shows the two keys, each with its newest claim.
      const shown = await admin.cards.card(card);
      expect(shown?.lines.map((line) => line.text)).toEqual(
        expect.arrayContaining([
          `fact a: ${factKeyFpOf(store, "fact-stove")}`,
          `fact b: ${factKeyFpOf(store, "fact-lamp")}`,
        ]),
      );

      // A rebuild's write holds the beliefs lock; the answer waits for it.
      const client = new pg.Client({ connectionString: db.urls.pipeline });
      await client.connect();
      await client.query("begin");
      await client.query(BELIEFS);
      let settled = false;
      const decided = admin.cards.decide({ cards: [card], answer: "same", requestId: requestId() }).finally(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(settled).toBe(false);
      await client.query("commit");
      await client.end();
      const [answer] = await decided;
      const [a, b] = sorted(factKeyFpOf(store, "fact-stove"), factKeyFpOf(store, "fact-lamp"));
      expect(await queryAs(db.urls.admin, "select verdict, a_fp, b_fp from knowledge.fact_rulings")).toEqual([
        { verdict: "join", a_fp: a, b_fp: b },
      ]);
      expect(answer?.ruling).toMatch(/^rul_/);
      // The pair's join rests on a decision of its own, beside the card's answer.
      expect(
        await queryAs(db.urls.admin, "select kind from knowledge.owner_decisions where request_id = $1", [
          `card_${answer?.ruling}`,
        ]),
      ).toEqual([{ kind: "fact_join" }]);
      void lamp;
    }));

  it("invariant 11: the mark only rises, past an erasure's delete and a join; the erasure scrubs the keys from the decisions", () =>
    withRulings(async (store) => {
      const { admin, pipeline, db } = store;
      const { stove, lamp, theirs, id, items } = await facts(store);
      const join = await admin.facts.joinFacts(id(stove), id(lamp), { requestId: requestId() });
      const read = await pipeline.beliefDecisions();
      // The erasure of the item that holds the lamp's only claim: its hook deletes the join and
      // scrubs the decision behind it. A split made after it brings the row count back.
      const hook = ERASURE_HOOKS.find((one) => one.name === "fact_rulings");
      const erased = {
        evidenceIds: [items.solo],
        refs: [],
        addressFps: [],
        sources: [],
        records: [],
        recordEvidenceIds: [],
        erasureId: null,
        factKeyFps: [factKeyFpOf(store, "fact-lamp")],
        nameFps: [],
        claimKeys: [],
        claimIds: [],
      };
      expect(
        await session(
          db.urls.admin,
          (query) => hook?.run(query, erased, { dryRun: false, now: new Date(), keys: db.keys }) ?? Promise.resolve(-1),
        ),
      ).toBe(1);
      const split = await admin.facts.splitFacts(id(stove), id(theirs), { requestId: requestId() });
      expect(await queryAs(db.urls.admin, "select ruling_id from knowledge.fact_rulings")).toEqual([
        { ruling_id: split },
      ]);
      // A count of the rows would be the mark the rebuild read; the counter has risen by two.
      expect((await pipeline.beliefDecisions()).mark).toBe(read.mark + 2);
      // The join's decision keeps its id and kind, and no longer names the erased key; the split's,
      // which names none, keeps its keys.
      expect(
        await queryAs(db.urls.admin, "select kind, details from knowledge.owner_decisions where id = $1", [join]),
      ).toEqual([{ kind: "fact_join", details: {} }]);
      const [a, b] = sorted(factKeyFpOf(store, "fact-stove"), factKeyFpOf(store, "fact-theirs"));
      expect(
        await queryAs(db.urls.admin, "select details from knowledge.owner_decisions where id = $1", [split]),
      ).toEqual([{ details: { a, b } }]);
      // pi_admin cannot lower the counter.
      expect(
        await sqlState(() => queryAs(db.urls.admin, "update policy.owner_settings set fact_rulings_mark = 0")),
      ).toBe("42501");
    }));

  it("a veto of a merged-in key closes the joined belief at once, and its lift opens it again", () =>
    withRulings(async (store) => {
      const { admin } = store;
      const { stove, lamp, id } = await facts(store);
      await admin.facts.joinFacts(id(stove), id(lamp), { requestId: requestId() });
      const joined = () => beliefsUnder(store, OWN, ["fact-stove", "fact-lamp"]);
      // One belief of the two keys, resting on both claims.
      const before = await joined();
      expect(before.map((one) => [one.status, one.support])).toEqual([
        ["active", [lamp.claim.id, stove.claim.id].sort()],
      ]);
      const veto = await admin.facts.vetoFact(id(lamp), { requestId: requestId() });
      expect((await joined()).map((one) => one.status)).toEqual(["closed"]);
      await admin.facts.liftRuling(veto, { requestId: requestId() });
      expect(await joined()).toEqual(before);
    }));

  it("a same_fact card's `same` is refused for two keys of different subjects; `different` splits them", () =>
    withRulings(async (store) => {
      const { admin, db } = store;
      const { stove, id } = await facts(store);
      const raise = async (): Promise<CardId> =>
        (
          await admin.cards.raiseCard({
            id: newId("crd") as CardId,
            requestId: requestId(),
            kind: "same_fact",
            author: "system:extract",
            options: ["same", "different", "skip"],
            target: { kind: "claim", id: id(stove) },
            refs: [],
            compartments: ["own"],
            expiresAt: null,
            expiresAfterDays: 14,
            caseKey: factKeyFpOf(store, "fact-theirs"),
            run: null,
            body: null,
            bodyFrom: null,
          })
        ).id;
      const card = await raise();
      expect(await refused(admin.cards.decide({ cards: [card], answer: "same", requestId: requestId() }))).toBe(
        "not_one_fact",
      );
      expect(await queryAs(db.urls.admin, "select verdict from knowledge.fact_rulings")).toEqual([]);
      await admin.cards.decide({ cards: [card], answer: "different", requestId: requestId() });
      expect(await queryAs(db.urls.admin, "select verdict from knowledge.fact_rulings")).toEqual([
        { verdict: "split" },
      ]);
    }));

  // The page's Undo of a same_fact answer lifts the join or split it made, by
  // the answer's own ruling id, and the card waits for the owner again; a repeat writes nothing more.
  it("a same_fact answer's ruling lifts the split it made, and the card waits again", () =>
    withRulings(async (store) => {
      const { admin, db } = store;
      const { stove, id } = await facts(store);
      const card = (
        await admin.cards.raiseCard({
          id: newId("crd") as CardId,
          requestId: requestId(),
          kind: "same_fact",
          author: "system:extract",
          options: ["same", "different", "skip"],
          target: { kind: "claim", id: id(stove) },
          refs: [],
          compartments: ["own"],
          expiresAt: null,
          expiresAfterDays: 14,
          caseKey: factKeyFpOf(store, "fact-theirs"),
          run: null,
          body: null,
          bodyFrom: null,
        })
      ).id;
      const [answer] = await admin.cards.decide({ cards: [card], answer: "different", requestId: requestId() });
      const [split] = await queryAs<{ ruling_id: string }>(
        db.urls.admin,
        "select ruling_id from knowledge.fact_rulings where lifted_at is null",
      );
      expect(split?.ruling_id).not.toBe(answer?.ruling);
      const again = requestId();
      expect(await admin.facts.liftFactRuling(answer?.ruling as never, { requestId: again })).toBe(true);
      expect(await admin.facts.liftFactRuling(answer?.ruling as never, { requestId: again })).toBe(true);
      expect(
        await queryAs(
          db.urls.admin,
          "select d.supersedes from knowledge.owner_decisions d where d.kind = 'fact_ruling_lift'",
        ),
      ).toEqual([{ supersedes: split?.ruling_id }]);
      expect(
        await queryAs(db.urls.admin, "select count(*)::int as n from knowledge.fact_rulings where lifted_at is null"),
      ).toEqual([{ n: 0 }]);
      expect(
        await queryAs(
          db.urls.admin,
          "select event from ledger.record_events where row_kind = 'card' and row_id = $1 order by id desc limit 1",
          [card],
        ),
      ).toEqual([{ event: "pending" }]);
      // Lifted already: nothing is in force to lift.
      expect(await admin.facts.liftFactRuling(answer?.ruling as never, { requestId: requestId() })).toBe(false);
      // Answered again, and lifted by the split's own id, as `pi facts rulings` lists it: the card waits again too.
      await admin.cards.decide({ cards: [card], answer: "different", requestId: requestId() });
      const [again2] = await queryAs<{ ruling_id: string }>(
        db.urls.admin,
        "select ruling_id from knowledge.fact_rulings where lifted_at is null",
      );
      expect(await admin.facts.liftFactRuling(again2?.ruling_id as never, { requestId: requestId() })).toBe(true);
      expect(
        await queryAs(
          db.urls.admin,
          "select event from ledger.record_events where row_kind = 'card' and row_id = $1 order by id desc limit 1",
          [card],
        ),
      ).toEqual([{ event: "pending" }]);
    }));
});
