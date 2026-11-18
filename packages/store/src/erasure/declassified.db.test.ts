import type { SourceDeletion } from "@intelligence/contracts";
import type { EntityId, MessageId } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { CANARY_PERSON, QUENTIN } from "../test-support/cast.ts";
import { testId } from "../test-support/clients.ts";
import { addOwnerAddressUnderived, one } from "../test-support/connections.ts";
import {
  admin,
  commit,
  commitment,
  copies,
  entityOf,
  inWorld,
  plantCopy,
  stored,
  type World,
} from "../test-support/declassified-fixtures.ts";
import { derive, mailFacts, mailRevision, mailSourceId } from "../test-support/items.ts";
import { MAIL } from "../test-support/items-named.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";

// Each copy is written as pi_admin in SQL; the copy of a claim the path does not delete stays, as
// the control.

const sorted = (ids: string[]): string[] => [...ids].sort();

const messageOf = async (world: World, evidenceId: string): Promise<MessageId> =>
  one(await admin<{ id: string }>(world, "select id from knowledge.messages where evidence_id = $1", [evidenceId]))
    .id as MessageId;

// Two items of `own`, each with one claim and its copy: the canary's, which the path removes,
// and Solo's, which stays.
async function twoCopies(world: World): Promise<{ canary: string; solo: string; canaryEvidence: string }> {
  const canaryEvidence = await stored(world, MAIL.canary);
  const soloEvidence = await stored(world, MAIL.solo);
  const [canary] = await commit(world, canaryEvidence, [commitment(world, canaryEvidence, "own")]);
  const [solo] = await commit(world, soloEvidence, [commitment(world, soloEvidence, "own")]);
  if (canary === undefined || solo === undefined) throw new Error("no claims");
  await plantCopy(world, canary);
  await plantCopy(world, solo);
  expect(await copies(world)).toEqual(sorted([canary, solo]));
  return { canary, solo, canaryEvidence };
}

describe("every statement that deletes a claim drops its declassified copy", {
  timeout: DB_TEST_TIMEOUT,
}, () => {
  it("a deletion at the source leaves no copy", () =>
    inWorld(async (world) => {
      const { solo } = await twoCopies(world);
      const deletion = {
        sourceAccount: world.accounts.personalMail.id,
        sourceItemId: mailSourceId(MAIL.canary),
      } as SourceDeletion;
      await world.store.writer.applyDeletion(world.accounts.personalMail, deletion);
      expect(await copies(world)).toEqual([solo]);
    }));

  it("a new revision leaves no copy", () =>
    inWorld(async (world) => {
      const { solo } = await twoCopies(world);
      await world.store.writer.ingestItem(
        world.accounts.personalMail,
        mailRevision(MAIL.canary, world.accounts.personalMail),
        mailFacts(MAIL.canary),
      );
      expect(await copies(world)).toEqual([solo]);
    }));

  it("a re-derive leaves no copy", () =>
    inWorld(async (world) => {
      await twoCopies(world);
      // Quentin's address becomes the owner's, so a re-derive is needed; it deletes every claim.
      await addOwnerAddressUnderived(world.store.db, QUENTIN.address, "own");
      expect((await world.store.writer.rederiveIfNeeded(derive)).rederived).toBe(true);
      expect(await copies(world)).toEqual([]);
      // The decisions stay.
      expect(
        one(
          await admin<{ n: number }>(
            world,
            "select count(*)::int as n from knowledge.owner_decisions where kind = 'declassify'",
          ),
        ).n,
      ).toBe(2);
    }));

  it("a commit that leaves the claim out leaves no copy", () =>
    inWorld(async (world) => {
      const evidence = await stored(world, MAIL.canary);
      const first = commitment(world, evidence, "own", { n: 1 });
      const second = commitment(world, evidence, "own", { n: 2 });
      const [gone, kept] = await commit(world, evidence, [first, second]);
      if (gone === undefined || kept === undefined) throw new Error("no claims");
      await plantCopy(world, gone);
      await plantCopy(world, kept);
      await commit(world, evidence, [second]);
      expect(await copies(world)).toEqual([kept]);
    }));

  it("an erasure of the item leaves no copy", () =>
    inWorld(async (world) => {
      const { solo, canaryEvidence } = await twoCopies(world);
      await world.admin.erasure.eraseItem(
        { kind: "message", id: await messageOf(world, canaryEvidence) },
        { requestId: testId("req") },
      );
      expect(await copies(world)).toEqual([solo]);
    }));

  it("an erasure of a person it names leaves no copy", () =>
    inWorld(async (world) => {
      await stored(world, MAIL.canary);
      const person = await entityOf(world, CANARY_PERSON.address);
      // A claim on Quentin's message that names the canary person, and one on Solo's that names
      // nobody: the erasure removes the first by its naming alone.
      const quentinEvidence = await stored(world, MAIL.fromQuentin);
      const soloEvidence = await stored(world, MAIL.solo);
      const [named] = await commit(world, quentinEvidence, [
        commitment(world, quentinEvidence, "own", { counterparty: person }),
      ]);
      const [solo] = await commit(world, soloEvidence, [commitment(world, soloEvidence, "own")]);
      if (named === undefined || solo === undefined) throw new Error("no claims");
      await plantCopy(world, named);
      await plantCopy(world, solo);
      await world.admin.erasure.erasePerson(person as EntityId, { requestId: testId("req") });
      expect(
        one(await admin<{ n: number }>(world, "select count(*)::int as n from knowledge.claims where id = $1", [named]))
          .n,
      ).toBe(0);
      expect(await copies(world)).toEqual([solo]);
    }));
});
