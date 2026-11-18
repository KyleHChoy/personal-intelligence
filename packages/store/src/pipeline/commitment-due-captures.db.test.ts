import type { AutonomyRules, OpportunityView } from "@intelligence/contracts/personal";
import { autonomyRules, planGapFlags } from "@intelligence/personal-core/planner";
import { describe, expect, it } from "vitest";
import { setTaskTier } from "../admin/admin-tasks.ts";
import { taintCiting } from "../erasure/taint.ts";
import { testId } from "../test-support/clients.ts";
import { session } from "../test-support/connections.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { READING_AGENT_TOOLS, type WorkClient } from "../test-support/work-clients.ts";
import { workAgent } from "../test-support/work-test-tasks.ts";
import { ok, type WorkWorld, withWorkWorld } from "../test-support/work-test-world.ts";
import { createDispatch } from "../work/dispatch.ts";

// commitment_due for a commitment said in a chat, which is stored as a capture: the task is about a
// person the claim names and from the capture, under the claim's label, its basis the person carrying
// the capture's evidence id, so the capture's erasure reaches it. Through the store's dispatch as
// pi_work, the tick's role, with `ontology/autonomy.json`'s 48-hour window. Synthetic rows only.

const OWN = ["own"];
const WORK = ["employer:example"];
const HOUR = 3_600_000;
const at = (base: Date, ms: number): Date => new Date(base.getTime() + ms);
const RULES: AutonomyRules = autonomyRules();
const utcDay = (when: Date): string => when.toISOString().slice(0, 10).replaceAll("-", "");

type Flag = {
  id: string;
  gap_subject: string;
  gap_source: string;
  compartments: string[];
  about_kind: string;
  about_id: string;
  tier: string;
  tainted: boolean;
};

// The tick's step 3b, as autonomy-triggers.db.test.ts runs it: close, then raise.
async function scan(w: WorkWorld, now: Date): Promise<{ raised: number; closed: number }> {
  const dispatch = createDispatch({ url: w.db.urls.work, log: w.log, journal: "" });
  try {
    const flags = await dispatch.gapFlags(now);
    const plan = planGapFlags({
      candidates: await dispatch.gapCandidates(now, RULES),
      open: flags.open,
      history: flags.history,
    });
    const counts = { raised: 0, closed: 0 };
    for (const id of plan.close) if (await dispatch.closeGapFlag(id, now)) counts.closed += 1;
    for (const { gap, card } of plan.raise) if ((await dispatch.raiseGapFlag(gap, !card)) !== null) counts.raised += 1;
    return counts;
  } finally {
    await dispatch.close();
  }
}

const flags = (w: WorkWorld): Promise<Flag[]> =>
  w.admin<Flag>(
    `select id, gap_subject, gap_source, compartments, about_kind, about_id, tier, tainted_at is not null as tainted
     from ledger.opportunities where gap_trigger = 'commitment_due' order by gap_subject`,
  );

const agent = (w: WorkWorld, name: string, compartments: string[]): Promise<WorkClient> =>
  workAgent(w, name, compartments, { tools: READING_AGENT_TOOLS, kinds: ["research"] });

const commitmentTasks = async (w: WorkWorld, client: WorkClient): Promise<OpportunityView[]> =>
  ok(await w.work.listOpportunities(client.token, { scope: "board" })).opportunities.filter(
    (one) => one.gap?.trigger === "commitment_due",
  );

// A commitment claim read from a chat capture under the label, due at `due` (none when null), naming
// the people given; its fact key, its capture and the capture's evidence.
async function chatCommitment(
  w: WorkWorld,
  compartments: string[],
  due: Date | null,
  people: string[],
): Promise<{ claim: string; fact: string; capture: string; evidence: string }> {
  const capture = await w.seed.capture(compartments);
  const claim = await w.seed.claim(compartments, capture.evidenceId, "commitment");
  await w.claims("update knowledge.claims set due_at = $2 where id = $1", [claim, due?.toISOString() ?? null]);
  for (const person of people)
    await w.claims("insert into knowledge.claim_entities (claim_id, entity_id, compartments) values ($1, $2, $3)", [
      claim,
      person,
      compartments,
    ]);
  const [row] = await w.admin<{ fact_key_fp: string }>("select fact_key_fp from knowledge.claims where id = $1", [
    claim,
  ]);
  return { claim, fact: row?.fact_key_fp as string, capture: capture.id, evidence: capture.evidenceId };
}

describe("commitment_due for a commitment said in a chat", { timeout: DB_TEST_TIMEOUT }, () => {
  it("raises one task about the person, from the capture, under its label; none past due, undated, past the window or naming no one", () =>
    withWorkWorld(
      async (w) => {
        const now = new Date();
        const both = await agent(w, "both", [...OWN, ...WORK]);
        await setTaskTier(w.admin, true, now);
        const person = await w.seed.entity("person");
        const due = await chatCommitment(w, WORK, at(now, 48 * HOUR), [person]);
        await chatCommitment(w, WORK, at(now, 48 * HOUR + 1000), [person]);
        await chatCommitment(w, WORK, at(now, -HOUR), [person]);
        await chatCommitment(w, WORK, null, [person]);
        await chatCommitment(w, WORK, at(now, 24 * HOUR), []);

        expect((await scan(w, now)).raised).toBe(1);
        const raised = await flags(w);
        expect(raised).toEqual([
          expect.objectContaining({
            gap_subject: `${due.fact}_${utcDay(at(now, 48 * HOUR))}`,
            gap_source: due.capture,
            compartments: WORK,
            about_kind: "entity",
            about_id: person,
            tier: "task",
            tainted: false,
          }),
        ]);
        expect(await w.latest("opportunity", raised[0]?.id as string)).toBe("go");
        // Its basis is the person, carrying the capture's evidence id; the capture is no ref of it.
        expect(
          await w.admin(
            "select ref_kind, ref_id, evidence_id from ledger.basis where row_kind = 'opportunity' and row_id = $1",
            [raised[0]?.id],
          ),
        ).toEqual([{ ref_kind: "entity", ref_id: person, evidence_id: due.evidence }]);
        // Once: a second tick raises nothing more and closes nothing.
        expect(await scan(w, now)).toEqual({ raised: 0, closed: 0 });

        // The agent's brief names the commitment's fact and the person, with no text of the chat.
        const [task] = await commitmentTasks(w, both);
        expect(task).toMatchObject({
          kind: "research",
          tier: "task",
          summary: null,
          about: { kind: "entity", id: person },
          basis: [{ kind: "entity", id: person }],
          gap: { trigger: "commitment_due", missing: "follow_up", fact: due.fact },
        });
      },
      ["own", "employer:example"],
    ));

  it("invariant 6: a caller whose label does not cover the capture's sees no task, and a veto on the person raises none", () =>
    withWorkWorld(
      async (w) => {
        const now = new Date();
        const own = await agent(w, "own-only", OWN);
        const both = await agent(w, "both", [...OWN, ...WORK]);
        await setTaskTier(w.admin, true, now);
        const colleague = await w.seed.entity("person");
        const hidden = await chatCommitment(w, WORK, at(now, 10 * HOUR), [colleague]);
        const vetoed = await w.seed.entity("person");
        await w.seed.account(OWN, vetoed);
        await chatCommitment(w, OWN, at(now, 10 * HOUR), [vetoed]);
        const [fp] = await w.admin<{ fp: string }>(
          "select value_fp as fp from knowledge.accounts where entity_id = $1",
          [vetoed],
        );
        const ruling = testId("rul");
        await w.admin(
          "insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, labels, details, decided_at, compartments) values ($1, $2, 'veto', 0, '{}', '{}', now(), '{own}')",
          [ruling, testId("req")],
        );
        await w.admin(
          "insert into knowledge.vetoes (ruling_id, subject, value_fps, work_kind, created_at, compartments) values ($1, 'person', $2, null, now(), '{own}')",
          [ruling, [fp?.fp]],
        );

        await scan(w, now);
        expect((await flags(w)).map((one) => [one.gap_source, one.about_id, one.compartments])).toEqual([
          [hidden.capture, colleague, WORK],
        ]);
        expect(await commitmentTasks(w, own)).toEqual([]);
        expect((await commitmentTasks(w, both)).map((one) => one.gap?.fact)).toEqual([hidden.fact]);
      },
      ["own", "employer:example"],
    ));

  it("invariant 10: erasing the capture taints its task and withdraws it, and leaves a task from another capture", () =>
    withWorkWorld(
      async (w) => {
        const now = new Date();
        await agent(w, "own-only", OWN);
        await setTaskTier(w.admin, true, now);
        const person = await w.seed.entity("person");
        const erased = await chatCommitment(w, OWN, at(now, 10 * HOUR), [person]);
        const kept = await chatCommitment(w, OWN, at(now, 20 * HOUR), [person]);
        expect((await scan(w, now)).raised).toBe(2);

        // The capture's removal, as the writer's removal path runs it: the row, then the taint call in
        // the same transaction, with the capture's evidence and the capture as the refs that went.
        await session(w.db.urls.writer, async (query) => {
          await query("begin");
          await query("delete from knowledge.captures where id = $1", [erased.capture]);
          await taintCiting(query, { evidenceIds: [erased.evidence], refs: [{ kind: "capture", id: erased.capture }] });
          await query("commit");
        });

        const after = await flags(w);
        const gone = after.find((one) => one.gap_source === erased.capture);
        const stays = after.find((one) => one.gap_source === kept.capture);
        expect(gone?.tainted).toBe(true);
        expect(await w.latest("opportunity", gone?.id as string)).toBe("withdrawn");
        expect(stays?.tainted).toBe(false);
        expect(await w.latest("opportunity", stays?.id as string)).toBe("go");
        // Its basis no longer holds the erased evidence id.
        expect(
          await w.admin<{ n: number }>("select count(*)::int as n from ledger.basis where evidence_id = $1", [
            erased.evidence,
          ]),
        ).toEqual([{ n: 0 }]);
      },
      ["own"],
    ));
});
