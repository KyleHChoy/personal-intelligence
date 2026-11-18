import { describe, expect, it } from "vitest";
import { testId } from "../test-support/clients.ts";
import { type WorkWorld, withWorkWorld } from "../test-support/work-fixtures.ts";

// The lessons wake counts the owner's
// `plan`-kind decisions on knowledge.owner_decisions alone, an answer by its card's kind, each
// untainted and within the reasoner's clearance, its target's row too. Made-up values only.

const TIMEOUT = 240_000;

type Decision = {
  target?: [string, string];
  card?: string;
  answer?: string;
  compartments?: string[];
  tainted?: boolean;
};

async function decide(w: WorkWorld, kind: string, options: Decision = {}): Promise<void> {
  await w.admin(
    `insert into knowledge.owner_decisions (id, request_id, kind, target_kind, target_id, answer, card_id, queue_depth, labels, details, decided_at, tainted_at, compartments)
     values ($1, $2, $3, $4, $5, $6, $7, 0, '{}', '{}', now(), $8, $9)`,
    [
      testId("rul"),
      testId("req"),
      kind,
      options.target?.[0] ?? null,
      options.target?.[1] ?? null,
      options.answer ?? null,
      options.card ?? null,
      options.tainted === true ? new Date() : null,
      options.compartments ?? ["own"],
    ],
  );
}

const lessonsKeys = async (w: WorkWorld): Promise<string[]> =>
  (await w.dispatch().wakeCandidates(new Date()))
    .filter((one) => one.source === "lessons_due")
    .map((one) => one.wakeKey);

describe("every planning decision wakes lessons", { timeout: TIMEOUT }, () => {
  it("counts a goal reword, a task, a commitment close and an opportunity answer once each, and nothing else", () =>
    withWorkWorld(async (w) => {
      await w.reasoner(["own"]);
      await w.settings({ lessons_every: 1 });
      expect(await lessonsKeys(w)).toEqual([]);

      // The goal's own goal_set is one; its reword another.
      const { goal } = await w.goal({ compartments: ["own"] });
      expect(await lessonsKeys(w)).toEqual(["lessons:1"]);
      await decide(w, "goal_reword", { target: ["goal", goal] });
      expect(await lessonsKeys(w)).toEqual(["lessons:2"]);
      const opportunity = await w.opportunity();
      await decide(w, "task_add", { target: ["opportunity", opportunity.id] });
      expect(await lessonsKeys(w)).toEqual(["lessons:3"]);
      await decide(w, "commitment_close", { answer: "done" });
      expect(await lessonsKeys(w)).toEqual(["lessons:4"]);
      // An opportunity answer: one owner decision; its status event is not counted again.
      const asked = await w.card({ kind: "opportunity_decision", target: ["opportunity", opportunity.id] });
      await decide(w, "answer", { target: ["opportunity", opportunity.id], card: asked, answer: "go" });
      await w.status("opportunity", opportunity.id, "go", { by: "owner" });
      expect(await lessonsKeys(w)).toEqual(["lessons:5"]);

      // None of these counts.
      await decide(w, "answer", { card: await w.card({ kind: "about_you" }), answer: "confirm" });
      await decide(w, "answer", { card: await w.card({ kind: "lesson" }), answer: "confirm" });
      await decide(w, "warmth_tier", { answer: "close" });
      await decide(w, "card_label", { target: ["card", asked], answer: "right" });
      await decide(w, "erase");
      await decide(w, "goal_reword", { target: ["goal", goal], tainted: true });
      // Outside the clearance: the decision's label, or its target's.
      await decide(w, "goal_reword", { target: ["goal", goal], compartments: ["employer:example"] });
      const elsewhere = await w.opportunity({ compartments: ["employer:example"] });
      await decide(w, "task_add", { target: ["opportunity", elsewhere.id] });
      // An answer on a card outside the clearance, and on a tainted card.
      await decide(w, "answer", {
        card: await w.card({ kind: "opportunity_decision", compartments: ["employer:example"] }),
        answer: "go",
      });
      const tainted = await w.card({ kind: "opportunity_decision" });
      await w.owner("update ledger.cards set tainted_at = now() where id = $1", [tainted]);
      await decide(w, "answer", { card: tainted, answer: "go" });
      // A target kind whose label is not checked here does not count.
      await decide(w, "note_add", { target: ["belief", testId("blf")] });
      expect(await lessonsKeys(w)).toEqual(["lessons:5"]);
      // A target with no label of its own, a person's entity, leaves the decision's to stand.
      await decide(w, "note_add", { target: ["entity", testId("ent")], answer: "colleague" });
      expect(await lessonsKeys(w)).toEqual(["lessons:6"]);

      // The key advances by lessons_every.
      await w.settings({ lessons_every: 2 });
      expect(await lessonsKeys(w)).toEqual(["lessons:3"]);
    }));
});
