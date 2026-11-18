import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaimRecord } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { createAdmin } from "../admin/admin.ts";
import { reopenId } from "../core/ids.ts";
import { CANARY_PERSON, QUENTIN, SOLO } from "../test-support/cast.ts";
import { testId } from "../test-support/clients.ts";
import { session } from "../test-support/connections.ts";
import { MAIL } from "../test-support/items-named.ts";
import { asOwner, batchOf, countOf, rowsOf, stored } from "../test-support/pipeline-fixtures.ts";
import { recordingLogger } from "../test-support/recording.ts";
import {
  commitment,
  factIdOf,
  factKeyFpOf,
  personOf,
  type RulingStore,
  withRulings,
} from "../test-support/ruling-fixtures.ts";
import { seeder } from "../test-support/seeder.ts";

// A generation may have moved a fact's key, so that no claim names the old one while an item the erasure
// leaves still states the fact; a ruling still anchored on that item holds the key. Each case erases one
// of two items first, and the other after it. Synthetic data, reserved domains only.

const TIMEOUT = 180_000;
const HEX = /^[0-9a-f]{64}$/;

const erasing = (fn: (store: RulingStore, erase: ReturnType<typeof createAdmin>) => Promise<void>) =>
  withRulings(async (store) => {
    const dir = await mkdtemp(join(tmpdir(), "pi-gone-keys-"));
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
const commit = async (store: RulingStore, evidenceId: string, claims: ClaimRecord[], generation = 1): Promise<void> => {
  expect(await store.pipeline.commit(batchOf(evidenceId, claims, { generation }))).toBe("committed");
};
const messageOf = async (store: RulingStore, evidence: string): Promise<string> =>
  (await rowsOf<{ id: string }>(store.db, "select id from knowledge.messages where evidence_id = $1", [evidence]))[0]
    ?.id as string;
// Every place a commitment's key is held outside its claims.
const holding = async (store: RulingStore, fact: string): Promise<Record<string, number>> => ({
  decisions: await countOf(
    store.db,
    "knowledge.owner_decisions",
    "details ->> 'factKey' = $1 or details ->> 'a' = $1 or details ->> 'b' = $1 or subject_fps && array[$1]",
    [fact],
  ),
  reopens: await countOf(store.db, "ledger.commitment_reopens", "fact_fp = $1", [fact]),
  rulings: await countOf(store.db, "knowledge.belief_rulings", "fact_key_fp = $1", [fact]),
  pairs: await countOf(store.db, "knowledge.fact_rulings", "a_fp = $1 or b_fp = $1", [fact]),
  hides: await countOf(store.db, "knowledge.goal_key_rulings", "fact_key_fp = $1", [fact]),
  closes: await countOf(store.db, "ledger.agent_writes", "close_fact_fp = $1", [fact]),
});
const NOTHING = { decisions: 0, reopens: 0, rulings: 0, pairs: 0, hides: 0, closes: 0 };
// The owner's hide of a goal by a fact key and a reopen of the commitment, as the admin writes them.
const hideAndReopen = (store: RulingStore, fact: string): Promise<void> =>
  session(store.db.urls.admin, async (query) => {
    const decision = async (kind: string, details: object, subject: string[]): Promise<string> => {
      const id = testId("rul");
      await query(
        "insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, labels, details, decided_at, compartments, subject_fps) values ($1, $2, $3, 0, '{}', $4, now(), '{own}', $5)",
        [id, testId("req"), kind, JSON.stringify(details), subject],
      );
      return id;
    };
    await query(
      "insert into knowledge.goal_key_rulings (ruling_id, verdict, fact_key_fp, created_at, compartments) values ($1, 'hide', $2, now(), '{own}')",
      [await decision("release", {}, []), fact],
    );
    await query(
      "insert into ledger.commitment_reopens (id, close_id, fact_fp, by, decision_id, compartments, at) values ($1, null, $2, 'owner', $3, '{own}', now())",
      [reopenId(), fact, await decision("commitment_reopen", { factKey: fact }, [fact])],
    );
  });
// An agent's close of a commitment, as ledger.close_commitment writes one, not yet taken in.
const agentClose = async (store: RulingStore, fact: string): Promise<string> => {
  const { id } = (await session(store.db.urls.admin, (query) =>
    seeder(store.db, query).into("ledger.agent_writes")(["own"]),
  )) as { id: string };
  await asOwner(
    store.db,
    "update ledger.agent_writes set kind = 'close', tool = 'close_commitment', close_fact_fp = $2, close_ending = 'done' where id = $1",
    [id, fact],
  );
  return id;
};
const closeOf = (store: RulingStore, close: string) =>
  rowsOf<{ emptied: boolean; close_fact_fp: string }>(
    store.db,
    "select body_enc is null as emptied, close_fact_fp from ledger.agent_writes where id = $1",
    [close],
  );
// What a dry run counted and the real run did, for every hook that removes by a fact key or a ruling.
const KEYED = [
  "agent_closes",
  "subject_decisions",
  "belief_rulings",
  "ruling_anchors",
  "fact_rulings",
  "fact_cards",
  "goal_keys",
];
const sameCounts = (dry: { more: Record<string, number> }, real: { more: Record<string, number> }): void => {
  for (const hook of KEYED) expect(real.more[hook], hook).toBe(dry.more[hook]);
};
const eraseMessage = async (
  store: RulingStore,
  erase: ReturnType<typeof createAdmin>,
  evidence: string,
  requestId: string,
) => {
  const target = { kind: "message", id: (await messageOf(store, evidence)) as never } as const;
  const dry = await erase.erasure.eraseItem(target, { requestId: `${requestId}-dry`, dryRun: true });
  const real = await erase.erasure.eraseItem(target, { requestId });
  return { dry, real };
};

describe("a fact key is gone only when nothing that stays holds it", { timeout: TIMEOUT }, () => {
  it("case A: the owner's close of a commitment two items state stands when one is erased, though a generation moved its key and the retire was carried", () =>
    erasing(async (store, erase) => {
      const canary = await stored(store.writer, store.accounts.personalMail, MAIL.canary);
      const quentin = await stored(store.writer, store.accounts.personalMail, MAIL.fromQuentin);
      const person = await personOf(store, CANARY_PERSON.address, "own");
      await commit(store, canary, [commitment(canary, "own", store.owner, person, { factKey: "fact-old" })]);
      await commit(store, quentin, [commitment(quentin, "own", store.owner, person, { factKey: "fact-old" })]);
      const fact = factKeyFpOf(store, "fact-old");
      await store.admin.commitments.closeCommitment(fact, "done", { requestId: "request-a1-close-0001" });
      await store.admin.commitments.reopenCommitment(fact, { requestId: "request-a1-reopen-001" });
      const closed = await store.admin.commitments.closeCommitment(fact, "done", {
        requestId: "request-a1-close-0002",
      });
      const anchors = async (): Promise<string[] | null | undefined> =>
        (
          await rowsOf<{ evidence_ids: string[] | null }>(
            store.db,
            "select evidence_ids from knowledge.belief_rulings where ruling_id = $1",
            [closed.retire],
          )
        )[0]?.evidence_ids;
      expect([...((await anchors()) ?? [])].sort()).toEqual([canary, quentin].sort());
      // The key moves with a generation, and the retire is carried to the new key: the first one
      // stays as it was, on a key no claim holds any more.
      await commit(
        store,
        canary,
        [commitment(canary, "own", store.owner, person, { factKey: "fact-new", generation: 2 })],
        2,
      );
      await commit(
        store,
        quentin,
        [commitment(quentin, "own", store.owner, person, { factKey: "fact-new", generation: 2 })],
        2,
      );
      await store.admin.extraction.reattachRulings({ generation: 2, dryRun: false });
      expect(await countOf(store.db, "knowledge.claims", "fact_key_fp = $1", [fact])).toBe(0);
      const before = await holding(store, fact);
      expect(before.reopens).toBeGreaterThanOrEqual(1);
      const decisionOf = () =>
        rowsOf(
          store.db,
          "select details ->> 'factKey' as fact, tainted_at is not null as tainted from knowledge.owner_decisions where id = $1",
          [closed.decision],
        );

      // The other item still states the commitment: nothing about its close goes.
      const first = await eraseMessage(store, erase, canary, "request-a1-erase-00001");
      expect(first.real.more.belief_rulings).toBe(first.dry.more.belief_rulings);
      expect(first.real.more.subject_decisions).toBe(first.dry.more.subject_decisions);
      expect(await holding(store, fact)).toEqual(before);
      expect(await decisionOf()).toEqual([{ fact, tainted: false }]);
      // Only the erased evidence left the retire's anchors.
      expect(await anchors()).toEqual([quentin]);

      // The last item that states it goes: now the key is gone, everywhere.
      await eraseMessage(store, erase, quentin, "request-a1-erase-00002");
      expect(await holding(store, fact)).toEqual(NOTHING);
      expect(await decisionOf()).toEqual([{ fact: null, tainted: true }]);
    }));

  it("case B: a join awaiting its carry, a goal hide and a reopen on a moved key stay while the join is anchored on an item that stays, though a ruling anchored only on the erased item names the key", () =>
    erasing(async (store, erase) => {
      const canary = await stored(store.writer, store.accounts.personalMail, MAIL.canary);
      const quentin = await stored(store.writer, store.accounts.personalMail, MAIL.fromQuentin);
      const person = await personOf(store, CANARY_PERSON.address, "own");
      const old = commitment(canary, "own", store.owner, person, { factKey: "fact-old" });
      await commit(store, canary, [old]);
      // A ruling anchored on the canary's item alone.
      const reject = await store.admin.facts.rejectClaim(factIdOf(store, old), { requestId: "request-b1-reject-001" });
      const [also, other] = [
        commitment(quentin, "own", store.owner, person, { factKey: "fact-old" }),
        commitment(quentin, "own", store.owner, person, { n: 2, factKey: "fact-x" }),
      ];
      await commit(store, quentin, [also, other]);
      // A join whose first side both items state.
      const joined = await store.admin.facts.joinFacts(factIdOf(store, also), factIdOf(store, other), {
        requestId: "request-b1-join-00001",
      });
      const fact = factKeyFpOf(store, "fact-old");
      const sides = async () =>
        (
          await rowsOf<{ a_fp: string; a_evidence_ids: string[]; b_evidence_ids: string[] }>(
            store.db,
            "select a_fp, a_evidence_ids, b_evidence_ids from knowledge.fact_rulings where ruling_id = $1",
            [joined],
          )
        )[0];
      const side = async (): Promise<string[] | undefined> => {
        const row = await sides();
        return row === undefined ? undefined : row.a_fp === fact ? row.a_evidence_ids : row.b_evidence_ids;
      };
      expect([...((await side()) ?? [])].sort()).toEqual([canary, quentin].sort());
      // The owner's hide of a goal by the key, and a reopen of the commitment, as the admin writes them.
      await session(store.db.urls.admin, async (query) => {
        const decision = async (kind: string, details: object, subject: string[]): Promise<string> => {
          const id = testId("rul");
          await query(
            "insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, labels, details, decided_at, compartments, subject_fps) values ($1, $2, $3, 0, '{}', $4, now(), '{own}', $5)",
            [id, testId("req"), kind, JSON.stringify(details), subject],
          );
          return id;
        };
        await query(
          "insert into knowledge.goal_key_rulings (ruling_id, verdict, fact_key_fp, created_at, compartments) values ($1, 'hide', $2, now(), '{own}')",
          [await decision("release", {}, []), fact],
        );
        await query(
          "insert into ledger.commitment_reopens (id, close_id, fact_fp, by, decision_id, compartments, at) values ($1, null, $2, 'owner', $3, '{own}', now())",
          [reopenId(), fact, await decision("commitment_reopen", { factKey: fact }, [fact])],
        );
      });
      // A generation moves the key: the join awaits its carry, on a key no claim holds.
      await commit(
        store,
        canary,
        [commitment(canary, "own", store.owner, person, { factKey: "fact-new", generation: 2 })],
        2,
      );
      await commit(
        store,
        quentin,
        [
          commitment(quentin, "own", store.owner, person, { factKey: "fact-new", generation: 2 }),
          commitment(quentin, "own", store.owner, person, { n: 2, factKey: "fact-x", generation: 2 }),
        ],
        2,
      );
      expect(await countOf(store.db, "knowledge.claims", "fact_key_fp = $1", [fact])).toBe(0);
      const before = await holding(store, fact);
      expect(before).toMatchObject({ pairs: 1, hides: 1, reopens: 1, rulings: 1 });

      const first = await eraseMessage(store, erase, canary, "request-b1-erase-00001");
      for (const hook of ["fact_rulings", "goal_keys", "subject_decisions", "belief_rulings"])
        expect(first.real.more[hook], hook).toBe(first.dry.more[hook]);
      expect(first.real.more.fact_rulings).toBe(0);
      // The join, the hide and the reopen stand, and the join lost only the erased evidence.
      expect(await holding(store, fact)).toEqual(before);
      expect(await side()).toEqual([quentin]);
      expect(
        await rowsOf(store.db, "select details from knowledge.owner_decisions where id = $1", [joined]),
      ).not.toEqual([{ details: {} }]);
      // The ruling made on the erased item alone lost the erased claim and its anchors, and keeps
      // the key, which the item left standing still states.
      expect(
        await rowsOf(
          store.db,
          "select claim_fp, fact_key_fp, evidence_ids from knowledge.belief_rulings where ruling_id = $1",
          [reject],
        ),
      ).toEqual([{ claim_fp: expect.stringMatching(HEX), fact_key_fp: fact, evidence_ids: [] }]);
      expect(await countOf(store.db, "knowledge.belief_rulings", "claim_fp = $1", [factIdOf(store, old)])).toBe(0);

      // The other item goes too: the key is gone, and everything on it.
      const second = await eraseMessage(store, erase, quentin, "request-b1-erase-00002");
      expect(second.real.more.fact_rulings).toBe(second.dry.more.fact_rulings);
      expect(await holding(store, fact)).toEqual(NOTHING);
      expect(await sides()).toBeUndefined();
    }));

  it("an agent's close of an erased commitment is emptied and names nothing, so it is not in force again once the owner's reopen of it is gone", () =>
    erasing(async (store, erase) => {
      const canary = await stored(store.writer, store.accounts.personalMail, MAIL.canary);
      const person = await personOf(store, CANARY_PERSON.address, "own");
      await commit(store, canary, [commitment(canary, "own", store.owner, person, { factKey: "fact-closed" })]);
      const fact = factKeyFpOf(store, "fact-closed");
      // An agent's close of the commitment, as ledger.close_commitment writes one, not yet taken in.
      const { id: close } = (await session(store.db.urls.admin, (query) =>
        seeder(store.db, query).into("ledger.agent_writes")(["own"]),
      )) as { id: string };
      await asOwner(
        store.db,
        "update ledger.agent_writes set kind = 'close', tool = 'close_commitment', close_fact_fp = $2, close_ending = 'done' where id = $1",
        [close, fact],
      );
      // The owner reopens it: the close is held back by a reopen row that names it.
      await store.admin.commitments.reopenCommitment(fact, { requestId: "request-c1-reopen-001" });
      expect(
        await countOf(store.db, "ledger.commitment_reopens", "close_id = $1 and fact_fp = $2", [close, fact]),
      ).toBe(1);
      const inForce = (): Promise<number> =>
        countOf(
          store.db,
          "ledger.agent_writes w",
          "w.kind = 'close' and w.body_enc is not null and not exists (select 1 from ledger.commitment_reopens r where r.close_id = w.id)",
        );
      expect(await inForce()).toBe(0);

      const { dry, real } = await eraseMessage(store, erase, canary, "request-c1-erase-00001");
      expect(dry.more.agent_closes).toBe(1);
      expect(real.more.agent_closes).toBe(1);
      expect(await holding(store, fact)).toEqual(NOTHING);
      expect(
        await rowsOf(
          store.db,
          "select kind, body_enc is null as emptied, tainted_at is not null as tainted, close_fact_fp from ledger.agent_writes where id = $1",
          [close],
        ),
      ).toEqual([{ kind: "close", emptied: true, tainted: true, close_fact_fp: expect.stringMatching(HEX) }]);
      // Its reopen row went with the key, and still no close is in force: none is found by the
      // key of a commitment stated again.
      expect(await countOf(store.db, "ledger.commitment_reopens", "close_id = $1", [close])).toBe(0);
      expect(await inForce()).toBe(0);
    }));
});

describe("a join or a split names every person either side names", { timeout: TIMEOUT }, () => {
  it("a person's erasure takes a join whose second side alone names them, though the item that states it stays: the row, the decision's two keys, what the owner was shown and everything else on that side's key", () =>
    erasing(async (store, erase) => {
      // Solo wrote one message. Quentin's message states every fact here, and Solo takes no part in it.
      await stored(store.writer, store.accounts.personalMail, MAIL.solo);
      const quentin = await stored(store.writer, store.accounts.personalMail, MAIL.fromQuentin);
      const [solo, other] = [await personOf(store, SOLO.address, "own"), await personOf(store, QUENTIN.address, "own")];
      // Two joins: the first side of each names Quentin, the second names Solo.
      const claims = [
        commitment(quentin, "own", store.owner, other, { n: 1, factKey: "fact-a1" }),
        commitment(quentin, "own", store.owner, solo, { n: 2, factKey: "fact-b1" }),
        commitment(quentin, "own", store.owner, other, { n: 3, factKey: "fact-a2" }),
        commitment(quentin, "own", store.owner, solo, { n: 4, factKey: "fact-b2" }),
      ] as const;
      await commit(store, quentin, [...claims]);
      const anchored = await store.admin.facts.joinFacts(factIdOf(store, claims[0]), factIdOf(store, claims[1]), {
        requestId: "request-d1-join-00001",
      });
      const before = await store.admin.facts.joinFacts(factIdOf(store, claims[2]), factIdOf(store, claims[3]), {
        requestId: "request-d1-join-00002",
      });
      const pairOf = (ruling: string) =>
        rowsOf<{ entity_ids: string[]; shown: boolean }>(
          store.db,
          "select entity_ids, shown_enc is not null as shown from knowledge.fact_rulings where ruling_id = $1",
          [ruling],
        );
      // The join names both sides' people, and seals what the owner was shown of both claims.
      expect(await pairOf(anchored)).toEqual([{ entity_ids: [other, solo].sort(), shown: true }]);
      // One anchored before a join named its second side's people: Quentin alone.
      await asOwner(store.db, "update knowledge.fact_rulings set entity_ids = $2 where ruling_id = $1", [
        before,
        [other],
      ]);
      const gone = [factKeyFpOf(store, "fact-b1"), factKeyFpOf(store, "fact-b2")];
      for (const fact of gone) await hideAndReopen(store, fact);
      for (const fact of gone) expect(await holding(store, fact)).toMatchObject({ pairs: 1, hides: 1, reopens: 1 });

      const dry = await erase.erasure.erasePerson(solo as never, { requestId: "request-d1-erase-0001", dryRun: true });
      const real = await erase.erasure.erasePerson(solo as never, { requestId: "request-d1-erase-0002" });
      sameCounts(dry, real);
      expect(real.more.fact_rulings).toBeGreaterThanOrEqual(2);
      // Quentin's message stays, with the claims that do not name Solo.
      expect(await countOf(store.db, "vault.evidence_items", "id = $1", [quentin])).toBe(1);
      expect(
        await countOf(store.db, "knowledge.claims", "id = any ($1)", [
          [factIdOf(store, claims[0]), factIdOf(store, claims[2])],
        ]),
      ).toBe(2);
      // Both joins are gone, with what they sealed; their decisions hold neither key; nothing else
      // holds a key of the side that named Solo.
      for (const ruling of [anchored, before]) {
        expect(await pairOf(ruling)).toEqual([]);
        expect(await rowsOf(store.db, "select details from knowledge.owner_decisions where id = $1", [ruling])).toEqual(
          [{ details: {} }],
        );
      }
      for (const fact of gone) expect(await holding(store, fact)).toEqual(NOTHING);
    }));
});

describe("one set of gone keys for an erasure", { timeout: TIMEOUT }, () => {
  it("a key only a ruling on the erased item still names is one of them: an agent's close of it is emptied before it loses the key, and the hide on it goes", () =>
    erasing(async (store, erase) => {
      const canary = await stored(store.writer, store.accounts.personalMail, MAIL.canary);
      const person = await personOf(store, CANARY_PERSON.address, "own");
      const old = commitment(canary, "own", store.owner, person, { factKey: "fact-old" });
      await commit(store, canary, [old]);
      const reject = await store.admin.facts.rejectClaim(factIdOf(store, old), { requestId: "request-e1-reject-001" });
      // A ruling made before rulings had anchors, on a key a generation then moved: no claim of
      // the item names the key, and nothing but the ruling's item leads to it.
      await asOwner(
        store.db,
        "update knowledge.belief_rulings set claim_type = null, evidence_ids = null, entity_ids = null, shown_enc = null where ruling_id = $1",
        [reject],
      );
      await commit(
        store,
        canary,
        [commitment(canary, "own", store.owner, person, { factKey: "fact-new", generation: 2 })],
        2,
      );
      const fact = factKeyFpOf(store, "fact-old");
      expect(await countOf(store.db, "knowledge.claims", "fact_key_fp = $1", [fact])).toBe(0);
      const close = await agentClose(store, fact);
      await hideAndReopen(store, fact);

      const { dry, real } = await eraseMessage(store, erase, canary, "request-e1-erase-00001");
      sameCounts(dry, real);
      expect(real.more.agent_closes).toBe(1);
      // The close lost its body before it lost the key: none keeps a body with no key to find it by.
      expect(await closeOf(store, close)).toEqual([{ emptied: true, close_fact_fp: expect.stringMatching(HEX) }]);
      expect(await holding(store, fact)).toEqual(NOTHING);
      expect(
        await rowsOf(store.db, "select fact_key_fp from knowledge.belief_rulings where ruling_id = $1", [reject]),
      ).toEqual([{ fact_key_fp: expect.stringMatching(HEX) }]);
    }));

  it("the dry run counts the owner's decisions on a commitment an agent closed from elsewhere: the close's own claim holds no key", () =>
    erasing(async (store, erase) => {
      const canary = await stored(store.writer, store.accounts.personalMail, MAIL.canary);
      const person = await personOf(store, CANARY_PERSON.address, "own");
      await commit(store, canary, [commitment(canary, "own", store.owner, person, { factKey: "fact-closed" })]);
      const fact = factKeyFpOf(store, "fact-closed");
      // An agent's close taken in: its record has an evidence row of its own, which does not rest
      // on the canary's message, and a close claim under the commitment's key.
      const close = await agentClose(store, fact);
      const taken = await session(store.db.urls.admin, async (query) => {
        const seed = seeder(store.db, query);
        const evidence = await seed.evidence(["own"]);
        return { evidence, claim: await seed.claim(["own"], evidence) };
      });
      await session(store.db.urls.bootstrap, async (query) => {
        await query("set role pi_owner");
        await query("begin");
        await query("alter table knowledge.claims no force row level security");
        await query("alter table knowledge.claims disable trigger user");
        await query("update knowledge.claims set closes = true, fact_key_fp = $2 where id = $1", [taken.claim, fact]);
        await query("alter table knowledge.claims enable trigger user");
        await query("alter table knowledge.claims force row level security");
        await query("update ledger.agent_writes set evidence_id = $2 where id = $1", [close, taken.evidence]);
        await query("commit");
      });
      await hideAndReopen(store, fact);
      expect(await countOf(store.db, "knowledge.claims", "closes and fact_key_fp = $1", [fact])).toBe(1);

      const { dry, real } = await eraseMessage(store, erase, canary, "request-f1-erase-00001");
      expect(real.more.subject_decisions).toBeGreaterThanOrEqual(1);
      sameCounts(dry, real);
      expect(await holding(store, fact)).toEqual(NOTHING);
      expect(await countOf(store.db, "knowledge.claims", "id = $1", [taken.claim])).toBe(0);
    }));

  it("a lifted ruling holds no key: what else is on a key a generation moved goes with the erased item, though the lifted veto was anchored on an item that stays too", () =>
    erasing(async (store, erase) => {
      const canary = await stored(store.writer, store.accounts.personalMail, MAIL.canary);
      const quentin = await stored(store.writer, store.accounts.personalMail, MAIL.fromQuentin);
      const person = await personOf(store, CANARY_PERSON.address, "own");
      const first = commitment(canary, "own", store.owner, person, { factKey: "fact-old" });
      await commit(store, canary, [first]);
      await commit(store, quentin, [commitment(quentin, "own", store.owner, person, { factKey: "fact-old" })]);
      const fact = factKeyFpOf(store, "fact-old");
      const veto = await store.admin.facts.vetoFact(factIdOf(store, first), { requestId: "request-g2-veto-00001" });
      expect(await store.admin.facts.liftRuling(veto, { requestId: "request-g2-lift-00001" })).toBe(true);
      await hideAndReopen(store, fact);
      for (const evidence of [canary, quentin])
        await commit(
          store,
          evidence,
          [commitment(evidence, "own", store.owner, person, { factKey: "fact-new", generation: 2 })],
          2,
        );
      expect(await countOf(store.db, "knowledge.claims", "fact_key_fp = $1", [fact])).toBe(0);
      expect(await holding(store, fact)).toMatchObject({ hides: 1, reopens: 1, rulings: 1 });

      const { dry, real } = await eraseMessage(store, erase, canary, "request-g2-erase-00001");
      sameCounts(dry, real);
      // Nothing in force rules on the key and no claim holds it: it is gone, the lifted veto's own
      // copy of it too.
      expect(await holding(store, fact)).toEqual(NOTHING);
      expect(
        await rowsOf(
          store.db,
          "select fact_key_fp, lifted_at is not null as lifted from knowledge.belief_rulings where ruling_id = $1",
          [veto],
        ),
      ).toEqual([{ fact_key_fp: expect.stringMatching(HEX), lifted: true }]);
    }));
});
