import type { SourceDeletion } from "@intelligence/contracts";
import { THE_OWNER } from "@intelligence/personal-core";
import { describe, expect, it } from "vitest";
import { CANARY_PERSON, QUENTIN } from "../test-support/cast.ts";
import { addOwnerAddressUnderived } from "../test-support/connections.ts";
import { derive, mailFacts, mailRevision, mailSourceId } from "../test-support/items.ts";
import { MAIL } from "../test-support/items-named.ts";
import { batchOf, stored } from "../test-support/pipeline-fixtures.ts";
import {
  commitment,
  factIdOf,
  factKeyFpOf,
  personOf,
  type RulingStore,
  withRulings,
} from "../test-support/ruling-fixtures.ts";
import { evidenceIdOf } from "../test-support/values.ts";

// The store's half of rulings in the belief build: beliefClaims leaves out a rejected claim by its item
// and fact key, beliefDecisions gives each fact veto as a decision on its belief with the rulings mark.
// The belief computed from them is tested in @intelligence/personal-beliefs and end to end in `pi`.

const TIMEOUT = 180_000;

// The claim ids beliefClaims gives for one fact key.
const given = async (store: RulingStore, factKey: string): Promise<string[]> =>
  ((await store.pipeline.beliefClaims()).find((group) => group.factKeyFp === factKeyFpOf(store, factKey))?.claims ?? [])
    .map((one) => one.claim.id)
    .sort();

describe("rulings in the pipeline's belief reads", { timeout: TIMEOUT }, () => {
  it("a rejected claim is given to no build, and the other claims of its fact key are", () =>
    withRulings(async (store) => {
      const { pipeline, writer, accounts, owner, admin } = store;
      const canary = await stored(writer, accounts.personalMail, MAIL.canary);
      const solo = await stored(writer, accounts.personalMail, MAIL.solo);
      const person = await personOf(store, CANARY_PERSON.address, "own");
      const rejected = commitment(canary, "own", owner, person, { factKey: "fact-rota" });
      const kept = commitment(solo, "own", owner, person, { factKey: "fact-rota" });
      expect(await pipeline.commit(batchOf(canary, [rejected]))).toBe("committed");
      expect(await pipeline.commit(batchOf(solo, [kept]))).toBe("committed");
      // The positive control: both are given before the ruling.
      expect(await given(store, "fact-rota")).toEqual([rejected.claim.id, kept.claim.id].sort());

      await admin.facts.rejectClaim(factIdOf(store, rejected), { requestId: "request-rul-p3-000001" });
      expect(await given(store, "fact-rota")).toEqual([kept.claim.id]);
      // The claim is still stored.
      expect(await admin.facts.show(factIdOf(store, rejected))).not.toBeNull();
    }));

  it("a rejection holds for the claim of a new revision of the item, and after EXTRACT_GENERATION is raised", () =>
    withRulings(async (store) => {
      const { pipeline, writer, accounts, owner, admin } = store;
      const first = await stored(writer, accounts.personalMail, MAIL.canary);
      const person = await personOf(store, CANARY_PERSON.address, "own");
      const record = commitment(first, "own", owner, person, { factKey: "fact-rota" });
      expect(await pipeline.commit(batchOf(first, [record]))).toBe("committed");
      await admin.facts.rejectClaim(factIdOf(store, record), { requestId: "request-rul-p3-000002" });

      // A new revision of the item: a new evidence id, so a new claim id, of the same source item.
      await writer.ingestItem(
        accounts.personalMail,
        mailRevision(MAIL.canary, accounts.personalMail),
        mailFacts(MAIL.canary),
      );
      const second = evidenceIdOf(accounts.personalMail, mailSourceId(MAIL.canary), 1);
      const revised = commitment(second, "own", owner, person, { factKey: "fact-rota" });
      expect(revised.claim.id).not.toBe(record.claim.id);
      expect(await pipeline.commit(batchOf(second, [revised]))).toBe("committed");
      expect(await given(store, "fact-rota")).toEqual([]);

      // A raised generation: the item extracted again, with another claim id.
      const raised = commitment(second, "own", owner, person, { factKey: "fact-rota", generation: 2 });
      expect(raised.claim.id).not.toBe(revised.claim.id);
      expect(await pipeline.commit(batchOf(second, [raised], { generation: 2 }))).toBe("committed");
      expect(await given(store, "fact-rota")).toEqual([]);

      // The control: another fact key of the same item is not rejected.
      const other = commitment(second, "own", owner, person, { n: 2, factKey: "fact-lamp", generation: 2 });
      expect(await pipeline.commit(batchOf(second, [raised, other], { generation: 2 }))).toBe("committed");
      expect(await given(store, "fact-lamp")).toEqual([other.claim.id]);
    }));

  it("beliefDecisions gives each fact veto in force as a veto of its belief, keyed by its fact key, after the mark", () =>
    withRulings(async (store) => {
      const { pipeline, writer, accounts, owner, admin } = store;
      // No retire or veto is in force yet.
      expect(await pipeline.beliefDecisions()).toMatchObject({ mark: 0, retirements: [], factRulings: [] });
      const canary = await stored(writer, accounts.personalMail, MAIL.canary);
      const work = await stored(writer, accounts.workMail, MAIL.workCanary);
      const own = commitment(canary, "own", owner, await personOf(store, CANARY_PERSON.address, "own"), {
        factKey: "fact-rota",
      });
      const both = commitment(
        work,
        "employer:example",
        owner,
        await personOf(store, CANARY_PERSON.address, "employer:example"),
        { factKey: "fact-lamp" },
      );
      const alsoOwn = commitment(canary, "own", owner, await personOf(store, CANARY_PERSON.address, "own"), {
        n: 2,
        factKey: "fact-lamp",
      });
      expect(await pipeline.commit(batchOf(canary, [own, alsoOwn]))).toBe("committed");
      expect(await pipeline.commit(batchOf(work, [both]))).toBe("committed");

      const first = await admin.facts.vetoFact(factIdOf(store, own), { requestId: "request-rul-p4-000001" });
      const second = await admin.facts.vetoFact(factIdOf(store, both), { requestId: "request-rul-p4-000002" });
      const read = await pipeline.beliefDecisions();
      expect(read.mark).toBe(2);
      expect(read.decisions).toEqual([
        {
          id: first,
          kind: "veto",
          targetKind: "belief",
          targetId: factKeyFpOf(store, "fact-rota"),
          decidedBy: THE_OWNER,
          decidedAt: expect.any(String),
          label: { compartments: ["own"], readers: [THE_OWNER] },
        },
        {
          id: second,
          kind: "veto",
          targetKind: "belief",
          targetId: factKeyFpOf(store, "fact-lamp"),
          decidedBy: THE_OWNER,
          decidedAt: expect.any(String),
          label: { compartments: ["employer:example", "own"], readers: [THE_OWNER] },
        },
      ]);

      // A lifted veto is given no more, and the lift raises the mark.
      await admin.facts.liftRuling(first, { requestId: "request-rul-p4-000003" });
      const lifted = await pipeline.beliefDecisions();
      expect(lifted.mark).toBe(3);
      expect(lifted.decisions.map((decision) => decision.id)).toEqual([second]);
      // A reject is no decision: it is left out of beliefClaims instead. It raises the mark.
      await admin.facts.rejectClaim(factIdOf(store, alsoOwn), { requestId: "request-rul-p4-000004" });
      // The rulings are what this test pins: not the `same_fact` relations the commits above wrote
      // between the two items' equal claims, nor the dream's settlements and checks.
      expect(await pipeline.beliefDecisions()).toMatchObject({
        mark: 4,
        retirements: [],
        decisions: lifted.decisions,
        reclassifications: [],
        goAt: null,
        factRulings: [],
        groupings: [],
        groupingMode: "shadow",
        reopens: [],
      });
    }));

  it("a ruling holds through a re-derive and the next extract", () =>
    withRulings(async (store) => {
      const { pipeline, writer, accounts, owner, admin } = store;
      const canary = await stored(writer, accounts.personalMail, MAIL.canary);
      const solo = await stored(writer, accounts.personalMail, MAIL.solo);
      const rejected = commitment(canary, "own", owner, await personOf(store, CANARY_PERSON.address, "own"), {
        factKey: "fact-rota",
      });
      const vetoed = commitment(solo, "own", owner, await personOf(store, QUENTIN.address, "own"), {
        factKey: "fact-lamp",
      });
      expect(await pipeline.commit(batchOf(canary, [rejected]))).toBe("committed");
      expect(await pipeline.commit(batchOf(solo, [vetoed]))).toBe("committed");
      const reject = await admin.facts.rejectClaim(factIdOf(store, rejected), { requestId: "request-rul-p9-000001" });
      const veto = await admin.facts.vetoFact(factIdOf(store, vetoed), { requestId: "request-rul-p9-000002" });

      // A new owner address makes a re-derive due; it deletes every claim, and the rulings stay.
      await addOwnerAddressUnderived(store.db, QUENTIN.address, "own");
      expect(await writer.rederiveIfNeeded(derive)).toMatchObject({ rederived: true });
      expect((await pipeline.beliefClaims()).flatMap((group) => group.claims)).toEqual([]);
      expect((await admin.facts.listRulings()).map(({ id, claimGone }) => ({ id, claimGone }))).toEqual([
        { id: reject, claimGone: true },
        { id: veto, claimGone: true },
      ]);

      // The next extract commits the same facts again, naming the people the re-derive made anew
      // (Quentin is now the owner): the reject and the veto hold for them.
      const again = commitment(canary, "own", owner, await personOf(store, CANARY_PERSON.address, "own"), {
        factKey: "fact-rota",
      });
      const lamp = commitment(solo, "own", owner, owner, { factKey: "fact-lamp" });
      expect(await pipeline.commit(batchOf(canary, [again]))).toBe("committed");
      expect(await pipeline.commit(batchOf(solo, [lamp]))).toBe("committed");
      expect(await given(store, "fact-rota")).toEqual([]);
      expect(await given(store, "fact-lamp")).toEqual([lamp.claim.id]);
      expect((await pipeline.beliefDecisions()).decisions.map((decision) => decision.targetId)).toEqual([
        factKeyFpOf(store, "fact-lamp"),
      ]);
      expect((await admin.facts.listRulings()).map(({ claimGone }) => claimGone)).toEqual([false, false]);
    }));

  it("a rejection whose claims are gone leaves out nothing else", () =>
    withRulings(async (store) => {
      const { pipeline, writer, accounts, owner, admin } = store;
      const canary = await stored(writer, accounts.personalMail, MAIL.canary);
      const solo = await stored(writer, accounts.personalMail, MAIL.solo);
      const person = await personOf(store, CANARY_PERSON.address, "own");
      const rejected = commitment(canary, "own", owner, person, { factKey: "fact-rota" });
      const kept = commitment(solo, "own", owner, person, { factKey: "fact-rota" });
      const other = commitment(solo, "own", owner, person, { n: 2, factKey: "fact-lamp" });
      expect(await pipeline.commit(batchOf(canary, [rejected]))).toBe("committed");
      expect(await pipeline.commit(batchOf(solo, [kept, other]))).toBe("committed");
      await admin.facts.rejectClaim(factIdOf(store, rejected), { requestId: "request-rul-gone-0001" });

      // Its item is deleted at the source: the ruling names no claim, and leaves out none.
      const deletion = {
        sourceAccount: accounts.personalMail.id,
        sourceItemId: mailSourceId(MAIL.canary),
      } as SourceDeletion;
      await writer.applyDeletion(accounts.personalMail, deletion);
      expect(await given(store, "fact-rota")).toEqual([kept.claim.id]);
      expect(await given(store, "fact-lamp")).toEqual([other.claim.id]);
      expect((await admin.facts.listRulings()).map((one) => one.claimGone)).toEqual([true]);
    }));
});
