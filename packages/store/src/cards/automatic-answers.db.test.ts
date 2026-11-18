import { describe, expect, it } from "vitest";
import { testId } from "../test-support/clients.ts";
import { withWorkWorld as withLedgerWorld } from "../test-support/work-fixtures.ts";
import { withWorkWorld } from "../test-support/work-test-world.ts";

// The lessons count reads knowledge.owner_decisions, which has no author column, so an answer by
// anyone else is never written there. These tests pin that reader. Made-up values only.

const TIMEOUT = 240_000;

describe("an automatic answer is not the owner's", { timeout: TIMEOUT }, () => {
  it("the lessons count leaves out an idea's or opportunity's answer by policy or by a client, and counts the owner's decision on it", () =>
    withLedgerWorld(async (w) => {
      const reasoner = await w.reasoner(["own"]);
      await w.settings({ lessons_every: 1 });
      const lessonsKeys = async (): Promise<string[]> =>
        (await w.dispatch().wakeCandidates(new Date()))
          .filter((one) => one.source === "lessons_due")
          .map((one) => one.wakeKey);
      const mail = await w.mail();
      const opportunity = await w.opportunity();
      const idea = await w.hypothesis({ kind: "idea", about: ["message", mail.id], refs: [["message", mail.id]] });
      const client = `client:${reasoner.id}`;

      // Every answer the count reads, written by an author other than the owner.
      for (const by of ["policy", client]) {
        for (const event of ["go", "handed_to_owner", "later", "no_go"])
          await w.status("opportunity", opportunity.id, event, { by });
        for (const event of ["pursued", "not_now", "rejected"]) await w.status("hypothesis", idea.id, event, { by });
      }
      expect(await lessonsKeys()).toEqual([]);

      // The count reads the owner's decisions alone: a status event, even theirs, is not one; their
      // answer on each card is, so two batches of one.
      await w.status("opportunity", opportunity.id, "no_go", { by: "owner" });
      expect(await lessonsKeys()).toEqual([]);
      for (const [kind, target, answer] of [
        ["opportunity_decision", ["opportunity", opportunity.id], "no_go"],
        ["idea", ["hypothesis", idea.id], "pursued"],
      ] as const) {
        const card = await w.card({ kind, target: [...target] });
        await w.admin(
          `insert into knowledge.owner_decisions (id, request_id, kind, target_kind, target_id, answer, card_id, queue_depth, labels, details, decided_at, compartments)
           values ($1, $2, 'answer', $3, $4, $5, $6, 0, '{}', '{}', now(), '{own}')`,
          [testId("rul"), testId("req"), target[0], target[1], answer, card],
        );
      }
      expect(await lessonsKeys()).toEqual(["lessons:2"]);
    }));

  it("knowledge.owner_decisions has no column naming an author", () =>
    withWorkWorld(async (w) => {
      const columns = async (schema: string, table: string): Promise<string[]> =>
        (
          await w.admin<{ name: string }>(
            "select column_name as name from information_schema.columns where table_schema = $1 and table_name = $2",
            [schema, table],
          )
        ).map((row) => row.name);
      // A later author column fails here, so its counting is decided then.
      const author = /(^|_)(by|author|actor|client|agent|run|session|writer|policy)(_|$)/;
      const decisions = await columns("knowledge", "owner_decisions");
      expect(decisions).toContain("decided_at");
      expect(decisions.filter((name) => author.test(name))).toEqual([]);
      // The positive control: record_events' author column is caught.
      expect((await columns("ledger", "record_events")).filter((name) => author.test(name))).toContain("by");
    }));
});
