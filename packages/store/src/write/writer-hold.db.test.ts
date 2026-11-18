import type { EvidenceId } from "@intelligence/contracts";
import { describe, expect, it } from "vitest";
import { OWNER, QUENTIN, type Who } from "../test-support/cast.ts";
import { addOwnerAddressUnderived, one } from "../test-support/connections.ts";
import { fingerprint, queryAs, type TestDatabase } from "../test-support/database.ts";
import { derive, type MailFixture, mail, mailFacts, mailRevision, mailSourceId } from "../test-support/items.ts";
import { MAIL } from "../test-support/items-named.ts";
import { type PipelineStore, stored, withPipeline } from "../test-support/pipeline-fixtures.ts";
import { withDbAdmin as withAdmin } from "../test-support/ruling-fixtures.ts";
import { evidenceIdOf } from "../test-support/values.ts";

// So a re-derive keeps the decide model's hold, a later revision copies model_hold_at as it copies
// hold_released_at and is screened afresh, `pi messages held` says which held it, and the owner's release
// releases either. Every hold by the decide model here is vault.mark_recovery's, through the Pipeline.

const TIMEOUT = 240_000;
const ME: Who = { address: OWNER.personal, name: OWNER.name };
const SENDER: Who = { address: "corin@tollhouse.test", name: "Corin Tollhouse" };

// A received message from Corin, declared so a re-derive finds its facts. `held` is the term
// list's verdict on it.
const message = (id: string, at: string, over: Partial<MailFixture> = {}): MailFixture =>
  mail({
    id,
    threadId: `thread-${id}`,
    at,
    from: SENDER,
    to: [ME],
    subject: `A note ${id}`,
    labels: ["INBOX"],
    ...over,
  });

type Row = { id: string; held: boolean; evidence_id: string };
const rowOf = async (store: PipelineStore, fixture: MailFixture): Promise<Row> =>
  one(
    await queryAs<Row>(
      store.db.urls.admin,
      `select m.id, m.held, m.evidence_id from knowledge.messages m join vault.evidence_items e on e.id = m.evidence_id where e.source_item_fp = $1`,
      [fingerprint(store.db.keys, "source_id", mailSourceId(fixture))],
    ),
  );

type Marks = { model_hold_at: Date | null; recovery_screened_at: Date | null; hold_released_at: Date | null };
const marksOf = async (db: TestDatabase, evidenceId: string): Promise<Marks> =>
  one(
    await queryAs<Marks>(
      db.urls.admin,
      "select model_hold_at, recovery_screened_at, hold_released_at from vault.evidence_items where id = $1",
      [evidenceId],
    ),
  );

// A message the decide model held, one the term list held, and one decide model held that the owner then released.
async function threeHolds(store: PipelineStore) {
  const { personalMail } = store.accounts;
  const decideModel = message("gm-j2-hold-jev", "2026-09-05T09:00:00Z");
  const markers = message("gm-j2-hold-markers", "2026-09-05T10:00:00Z", { held: true });
  const released = message("gm-j2-hold-released", "2026-09-05T11:00:00Z");
  const decideId = (await stored(store.writer, personalMail, decideModel)) as EvidenceId;
  await stored(store.writer, personalMail, markers);
  const releasedId = (await stored(store.writer, personalMail, released)) as EvidenceId;
  expect(await store.pipeline.markRecovery(decideId, true)).toBe(true);
  expect(await store.pipeline.markRecovery(releasedId, true)).toBe(true);
  await withAdmin(store.db, (owner) => rowOf(store, released).then((row) => owner.held.releaseHeld({ id: row.id })));
  expect((await rowOf(store, decideModel)).held).toBe(true);
  expect((await rowOf(store, markers)).held).toBe(true);
  expect((await rowOf(store, released)).held).toBe(false);
  return { decideModel, markers, released, decideId, releasedId };
}

describe("Jev's hold at the writer", { timeout: TIMEOUT }, () => {
  it("a message held by Jev stays held after a re-derive, as a term-list hold does, and a released one stays released", () =>
    withPipeline(async (store) => {
      const { decideModel, markers, released, decideId } = await threeHolds(store);
      const before = {
        decideModel: await rowOf(store, decideModel),
        markers: await rowOf(store, markers),
        released: await rowOf(store, released),
      };
      const heldAt = (await marksOf(store.db, decideId)).model_hold_at;
      // A re-derive is needed: an owner address is held by a person too.
      await stored(store.writer, store.accounts.personalMail, MAIL.fromQuentin);
      await addOwnerAddressUnderived(store.db, QUENTIN.address, "own");
      expect(await store.writer.rederiveIfNeeded(derive)).toMatchObject({ rederived: true });

      // Every message keeps its id, and its hold or its release.
      expect(await rowOf(store, decideModel)).toEqual(before.decideModel);
      expect(await rowOf(store, markers)).toEqual(before.markers);
      expect(await rowOf(store, released)).toEqual(before.released);
      expect((await marksOf(store.db, decideId)).model_hold_at).toEqual(heldAt);
    }));

  it("a later revision of an item Jev held is held: model_hold_at is copied, and recovery_screened_at is not", () =>
    withPipeline(async (store) => {
      const { personalMail } = store.accounts;
      const decideModel = message("gm-j2-revision-jev", "2026-09-05T09:00:00Z");
      const first = (await stored(store.writer, personalMail, decideModel)) as EvidenceId;
      expect(await store.pipeline.markRecovery(first, true)).toBe(true);
      const marked = await marksOf(store.db, first);
      expect(marked.model_hold_at).not.toBeNull();
      expect(marked.recovery_screened_at).not.toBeNull();

      expect(
        await store.writer.ingestItem(personalMail, mailRevision(decideModel, personalMail), mailFacts(decideModel)),
      ).toBe("stored");
      const second = evidenceIdOf(personalMail, mailSourceId(decideModel), 1);
      const copied = await marksOf(store.db, second);
      expect(copied.model_hold_at).toEqual(marked.model_hold_at);
      // Screened afresh: the backlog lists it again only once it is released, since it is held.
      expect(copied.recovery_screened_at).toBeNull();
      expect(await rowOf(store, decideModel)).toMatchObject({ evidence_id: second, held: true });

      // The control: a later revision of an item the decide model did not hold is not held, and carries no mark.
      const plain = message("gm-j2-revision-plain", "2026-09-05T10:00:00Z");
      const plainFirst = (await stored(store.writer, personalMail, plain)) as EvidenceId;
      expect(await store.pipeline.markRecovery(plainFirst, false)).toBe(false);
      expect(await store.writer.ingestItem(personalMail, mailRevision(plain, personalMail), mailFacts(plain))).toBe(
        "stored",
      );
      const plainSecond = evidenceIdOf(personalMail, mailSourceId(plain), 1);
      expect(await marksOf(store.db, plainSecond)).toEqual({
        model_hold_at: null,
        recovery_screened_at: null,
        hold_released_at: null,
      });
      expect(await rowOf(store, plain)).toMatchObject({ evidence_id: plainSecond, held: false });
      // So the recovery backlog lists the new revision of the plain item, and not the held one.
      expect((await store.pipeline.recoveryBacklog(200)).map((item) => item.evidenceId)).toEqual([plainSecond]);
    }));

  it("pi messages held shows by jev for Jev's hold and by markers for a term-list hold", () =>
    withPipeline(async (store) => {
      const { decideModel, markers } = await threeHolds(store);
      const listed = await withAdmin(store.db, (owner) => owner.held.messages());
      expect(listed.held).toBe(2);
      const by = Object.fromEntries(listed.messages.map((row) => [row.id, row.by]));
      expect(by).toEqual({
        [(await rowOf(store, decideModel)).id]: "jev",
        [(await rowOf(store, markers)).id]: "markers",
      });
      // Newest first.
      expect(listed.messages.map((row) => row.id)).toEqual([
        (await rowOf(store, markers)).id,
        (await rowOf(store, decideModel)).id,
      ]);
    }));

  it("the owner's release releases either hold, never clears model_hold_at, and a later revision of a released item is not held again", () =>
    withPipeline(async (store) => {
      const { personalMail } = store.accounts;
      const { decideModel, markers, decideId } = await threeHolds(store);
      await withAdmin(store.db, async (owner) => {
        expect(await owner.held.releaseHeld({ id: (await rowOf(store, decideModel)).id })).toEqual({ released: 1 });
        expect(await owner.held.releaseHeld({ id: (await rowOf(store, markers)).id })).toEqual({ released: 1 });
        expect(await owner.held.messages()).toEqual({ held: 0, messages: [] });
      });
      expect((await rowOf(store, decideModel)).held).toBe(false);
      expect((await rowOf(store, markers)).held).toBe(false);
      const released = await marksOf(store.db, decideId);
      expect(released.model_hold_at).not.toBeNull();
      expect(released.hold_released_at).not.toBeNull();
      // The decide model's screen, replayed after the release, holds nothing.
      expect(await store.pipeline.markRecovery(decideId, true)).toBe(false);
      expect((await rowOf(store, decideModel)).held).toBe(false);

      // A later revision copies both marks, and the release wins.
      expect(
        await store.writer.ingestItem(personalMail, mailRevision(decideModel, personalMail), mailFacts(decideModel)),
      ).toBe("stored");
      const second = evidenceIdOf(personalMail, mailSourceId(decideModel), 1);
      const copied = await marksOf(store.db, second);
      expect(copied.model_hold_at).toEqual(released.model_hold_at);
      expect(copied.hold_released_at).toEqual(released.hold_released_at);
      expect(await rowOf(store, decideModel)).toMatchObject({ evidence_id: second, held: false });
    }));
});
