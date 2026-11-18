import { type OpportunityId, OWNER_PAGE_MOST } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { createAdmin } from "../admin/admin.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { withWorkWorld } from "../test-support/work-fixtures.ts";

// Work handed to the owner always carries its Done and Drop. An outcome card that expired or was
// withdrawn unanswered is raised again, at most twice after one ended; and the Needs you rows carry
// the handed work's waiting card whatever the cap on the cards beside it. Made-up values only.

describe("handed work's outcome card", { timeout: DB_TEST_TIMEOUT }, () => {
  it("is raised again when the last one ended unanswered, at most twice", () =>
    withWorkWorld(async (w) => {
      const { id } = await w.opportunity({ kind: "reply" });
      await w.status("opportunity", id, "handed_to_owner");
      const dispatch = w.dispatch();
      try {
        const raised: string[] = [];
        for (const ending of ["expired", "withdrawn", "expired"]) {
          expect(await dispatch.handedWithoutCard()).toContain(id);
          const card = await dispatch.raiseOutcomeCard({ kind: "opportunity", id: id as OpportunityId }, new Date());
          expect(card).not.toBeNull();
          raised.push(card as string);
          // While it waits, none other is raised.
          expect(await dispatch.handedWithoutCard()).not.toContain(id);
          expect(
            await dispatch.raiseOutcomeCard({ kind: "opportunity", id: id as OpportunityId }, new Date()),
          ).toBeNull();
          await w.status("card", card as string, ending, { by: "system:work" });
        }
        expect(new Set(raised).size).toBe(3);
        // The first and its two raised again ended unanswered: no fourth.
        expect(await dispatch.handedWithoutCard()).not.toContain(id);
        expect(
          await dispatch.raiseOutcomeCard({ kind: "opportunity", id: id as OpportunityId }, new Date()),
        ).toBeNull();
      } finally {
        await dispatch.close();
      }
    }));

  // The task-result cards are withdrawn into the feed; handed work's Done
  // and Drop stay.
  it("keeps its card when the task-result cards are withdrawn", () =>
    withWorkWorld(async (w) => {
      const { id } = await w.opportunity({ kind: "reply" });
      await w.status("opportunity", id, "handed_to_owner");
      const dispatch = w.dispatch();
      try {
        const card = await dispatch.raiseOutcomeCard({ kind: "opportunity", id: id as OpportunityId }, new Date());
        expect(await dispatch.withdrawTaskResultCards(new Date())).toBe(0);
        expect(await w.latest("card", card as string)).toBe("pending");
      } finally {
        await dispatch.close();
      }
    }));

  it("an answered card ends the work, and none is raised again", () =>
    withWorkWorld(async (w) => {
      const { id } = await w.opportunity({ kind: "reply" });
      await w.status("opportunity", id, "handed_to_owner");
      const dispatch = w.dispatch();
      const admin = createAdmin({ url: w.db.urls.admin, keys: w.db.keys, log: w.log });
      try {
        const card = await dispatch.raiseOutcomeCard({ kind: "opportunity", id: id as OpportunityId }, new Date());
        await admin.cards.decide({
          cards: [card as never],
          answer: "acknowledge",
          requestId: "request-r9c-handed-0001",
        });
        expect(await w.latest("opportunity", id)).toBe("done");
        expect(await dispatch.handedWithoutCard()).not.toContain(id);
      } finally {
        await dispatch.close();
        await admin.close();
      }
    }));

  // Done and Drop from the work's own row, with no live card (none raised yet,
  // or each one raised ended unanswered): one is raised and answered in one write; a repeat answers
  // with the first ruling; a live card is the one answered.
  it("the owner's Done or Drop on the work's row needs no live card", () =>
    withWorkWorld(async (w) => {
      const admin = createAdmin({ url: w.db.urls.admin, keys: w.db.keys, log: w.log });
      const dispatch = w.dispatch();
      try {
        // None raised yet: Done raises one and answers it.
        const first = await w.opportunity({ kind: "reply" });
        await w.status("opportunity", first.id, "handed_to_owner");
        const done = {
          opportunity: first.id as OpportunityId,
          answer: "acknowledge" as const,
          requestId: "request-r9a-handed-0001",
        };
        const [answered] = await admin.cards.decideHanded(done);
        expect(await w.latest("opportunity", first.id)).toBe("done");
        expect(await w.latest("card", answered?.card as string)).toBe("decided");
        // A repeat writes nothing more: the same card and ruling.
        expect(await admin.cards.decideHanded(done)).toEqual([answered]);

        // Every card raised ended unanswered, past the tick's re-raises: Drop, with the owner's reason.
        const second = await w.opportunity({ kind: "reply" });
        await w.status("opportunity", second.id, "handed_to_owner");
        for (let n = 0; n < 3; n += 1) {
          const card = await dispatch.raiseOutcomeCard(
            { kind: "opportunity", id: second.id as OpportunityId },
            new Date(),
          );
          await w.status("card", card as string, "expired", { by: "system:work" });
        }
        expect(await dispatch.handedWithoutCard()).not.toContain(second.id);
        await admin.cards.decideHanded({
          opportunity: second.id as OpportunityId,
          answer: "dismiss",
          reason: "wrong_timing",
          requestId: "request-r9a-handed-0002",
        });
        expect(await w.latest("opportunity", second.id)).toBe("no_go");

        // A live card is the one answered: no second card.
        const third = await w.opportunity({ kind: "reply" });
        await w.status("opportunity", third.id, "handed_to_owner");
        const live = await dispatch.raiseOutcomeCard(
          { kind: "opportunity", id: third.id as OpportunityId },
          new Date(),
        );
        const [onLive] = await admin.cards.decideHanded({
          opportunity: third.id as OpportunityId,
          answer: "acknowledge",
          requestId: "request-r9a-handed-0003",
        });
        expect(onLive?.card).toBe(live);

        // Work not handed to the owner is refused, and nothing is raised.
        const fourth = await w.opportunity({ kind: "reply" });
        await expect(
          admin.cards.decideHanded({
            opportunity: fourth.id as OpportunityId,
            answer: "acknowledge",
            requestId: "request-r9a-handed-0004",
          }),
        ).rejects.toMatchObject({ code: "not_found" });
      } finally {
        await dispatch.close();
        await admin.close();
      }
    }));

  it("the Needs you rows carry handed work's pending card past the cap", () =>
    withWorkWorld(async (w) => {
      const { id } = await w.opportunity({ kind: "reply" });
      await w.status("opportunity", id, "handed_to_owner");
      // A full page of older waiting cards beside it.
      const older = new Date(Date.now() - 86_400_000);
      for (let n = 0; n < OWNER_PAGE_MOST; n += 1)
        await w.card({ kind: "opportunity_decision", state: "pending", at: older });
      const card = await w.card({ kind: "outcome", state: "pending", target: ["opportunity", id] });
      const admin = createAdmin({ url: w.db.urls.admin, keys: w.db.keys, log: w.log });
      try {
        const activity = await admin.agents.activity();
        expect(activity.needsYou.cards.length).toBeLessThanOrEqual(OWNER_PAGE_MOST);
        expect(activity.needsYou.cards.filter((one) => one.id === card)).toEqual([
          expect.objectContaining({ kind: "outcome", state: "pending", target: { kind: "opportunity", id } }),
        ]);
        expect(activity.needsYou.handedToYou.map((one) => one.opportunity)).toContain(id);
      } finally {
        await admin.close();
      }
    }));
});
