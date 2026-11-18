import { AgentActivity } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { testId } from "../../test-support/clients.ts";
import { sealRow } from "../../test-support/database.ts";
import { DB_TEST_TIMEOUT } from "../../test-support/timeouts.ts";
import { type WorkClient, type WorkWorld, withWorkWorld } from "../../test-support/work-fixtures.ts";
import { createAdmin } from "../admin.ts";

// Made-up values only.

const KIND = "meeting_prep";
const STAGE = "prepare";

// An agent that claimed a go meeting_prep and holds a cleared move.
async function claimed(w: WorkWorld): Promise<{ agent: WorkClient; opportunity: string; move: string }> {
  const agent = await w.agent();
  const intent = await w.intent([KIND], [agent.id]);
  await w.harness(agent, KIND, STAGE);
  const { id } = await w.opportunity({ kind: KIND, at: new Date(Date.now() - 3_600_000) });
  await w.decision(id, "go", { intent });
  const move = await w.claimAndPlan(agent, id, STAGE);
  return { agent, opportunity: id, move };
}

// A move's report through ledger.report_move, its summary sealed as the store seals one: under the
// agent's compartment, bound to `<move>/reported`.
async function report(
  w: WorkWorld,
  agent: WorkClient,
  move: string,
  outcome: "done" | "blocked",
  summary: string,
): Promise<string | null> {
  const body = JSON.stringify(
    sealRow(
      w.db.keys,
      agent.compartments[0] ?? "own",
      { table: "ledger.record_events", id: `${move}/reported`, column: "body_enc" },
      summary,
    ),
  );
  const [reported] = await w.as<{ status: string | null }>(
    agent,
    "select ledger.report_move($1, $2, $3, $4, $5::jsonb, '{}', '{}') as status",
    [move, outcome, testId("req"), agent.session, body],
  );
  return reported?.status ?? null;
}

describe("R-T4: agent activity", { timeout: DB_TEST_TIMEOUT }, () => {
  it("sorts work into its buckets, opens summaries as the agent's, leaves out tainted work and opens no card", () =>
    withWorkWorld(async (w) => {
      const working = await claimed(w);
      const blocked = await claimed(w);
      expect(await report(w, blocked.agent, blocked.move, "blocked", "canary-blocked-reason")).toBe("handed_to_owner");
      // Blocked, then answered go by the owner: it has moved on, so it is blocked no longer.
      const answered = await claimed(w);
      await report(w, answered.agent, answered.move, "blocked", "canary-old-reason");
      await w.decision(answered.opportunity, "go");
      const finished = await claimed(w);
      await report(w, finished.agent, finished.move, "done", "canary-done-summary");
      const record = testId("rec");
      await w.owner(
        "insert into ledger.basis (row_kind, row_id, ref_kind, ref_id, source_class, compartments) values ('move', $1, 'agent_record', $2, 'agent', '{own}')",
        [finished.move, record],
      );
      // A claimed opportunity a deletion tainted, and its move: in no bucket.
      const tainted = await claimed(w);
      await w.owner("update ledger.opportunities set tainted_at = now() where id = $1", [tainted.opportunity]);
      const waiting = await w.card({
        kind: "opportunity_decision",
        state: "pending",
        target: ["opportunity", working.opportunity],
      });
      const notice = await w.card({ kind: "notice", state: "pending" });
      const decided = await w.card({ kind: "owner_question", state: "decided" });
      // An outcome card the cap held back: offered on work handed to the owner, and only there.
      const held = await w.card({ kind: "outcome", state: "deferred", target: ["opportunity", blocked.opportunity] });
      const heldElsewhere = await w.card({
        kind: "outcome",
        state: "deferred",
        target: ["opportunity", working.opportunity],
      });

      const admin = createAdmin({ url: w.db.urls.admin, keys: w.db.keys, log: w.log });
      try {
        const activity = await admin.agents.activity();
        expect(AgentActivity.parse(activity)).toEqual(activity);

        // Work done at one stage may go on to the next (claimed) or to the owner (handed): each bucket is
        // checked for what it must and must not hold.
        const ids = (items: { opportunity: string }[]): string[] => items.map((item) => item.opportunity);
        expect(ids(activity.working)).toContain(working.opportunity);
        expect(ids(activity.working)).not.toContain(blocked.opportunity);
        expect(activity.working.find((item) => item.opportunity === working.opportunity)).toMatchObject({
          kind: KIND,
          task: false,
          status: "claimed",
          holder: working.agent.name,
          move: { id: working.move, stage: STAGE, status: "cleared" },
        });

        // What the work is about, so work with no summary is titled by it.
        const [about] = await w.admin<{ about_kind: string; about_id: string }>(
          "select about_kind, about_id from ledger.opportunities where id = $1",
          [working.opportunity],
        );
        expect(activity.working.find((item) => item.opportunity === working.opportunity)?.about).toMatchObject({
          kind: about?.about_kind,
          id: about?.about_id,
        });

        expect(ids(activity.needsYou.handedToYou)).toContain(blocked.opportunity);
        expect(ids(activity.needsYou.handedToYou)).not.toContain(working.opportunity);
        expect(activity.blocked).toEqual([
          expect.objectContaining({
            opportunity: blocked.opportunity,
            code: "blocked",
            reason: { untrusted: "canary-blocked-reason" },
            move: expect.objectContaining({ id: blocked.move, status: "blocked" }),
          }),
        ]);

        expect(ids(activity.blocked)).not.toContain(answered.opportunity);
        expect(JSON.stringify(activity)).not.toContain("canary-old-reason");

        expect(activity.finished.map((item) => item.move?.id)).toEqual([finished.move]);
        expect(activity.finished[0]?.findings).toEqual([record]);

        // The cards that wait on the owner for agent work, and no other kind or state.
        expect(activity.needsYou.cards.map((card) => card.id)).toEqual([waiting, held]);
        expect(activity.needsYou.cards.find((card) => card.id === held)).toMatchObject({
          kind: "outcome",
          state: "deferred",
          target: { kind: "opportunity", id: blocked.opportunity },
        });
        expect(JSON.stringify(activity)).not.toContain(heldElsewhere);
        expect(JSON.stringify(activity)).not.toContain(notice);
        expect(JSON.stringify(activity)).not.toContain(decided);
        expect(JSON.stringify(activity)).not.toContain(tainted.opportunity);

        // W8: listing opened nothing.
        expect(await w.admin("select id from ledger.owner_views")).toEqual([]);
      } finally {
        await admin.close();
      }
    }));
});
