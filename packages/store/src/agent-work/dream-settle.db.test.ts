import type { OpportunityId } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { dreamFindingId } from "../core/ids.ts";
import { type OwnerWorld, withOwnerWorld } from "../test-support/card-task-world.ts";
import { request, testId } from "../test-support/clients.ts";
import { queryAs } from "../test-support/database.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { READING_AGENT_TOOLS } from "../test-support/work-clients.ts";
import { workAgent } from "../test-support/work-test-tasks.ts";
import { ok } from "../test-support/work-test-world.ts";

// A conflict dreaming found, settled by an agent end to end: the tick's gap and task for the finding,
// the agent's claim of it, its report with report.settle, what a read is given for an audience that
// sees both claims and for one that does not, and the owner's lift taking it back. Made-up values only.

const OWN = ["own"];
const WIDE = ["employer:example", "own"];
const WORK = ["employer:example"];
const KEYS = ["own", "employer:example", "agent:scout"];

type Finding = { id: string; a: string; b: string; aFact: string; bFact: string };

// Two claims that disagree, one in `own` and one in work mail, each with its value row, and the
// finding the dream pass filed about a person, under both claims' labels.
async function finding(w: OwnerWorld): Promise<Finding> {
  const person = testId("ent");
  await w.admin("insert into knowledge.entities (id, kind) values ($1, 'person')", [person]);
  const [aClaim, bClaim] = [await w.seed.claim(OWN), await w.seed.claim(WORK)];
  const [a, b] = [await w.seed.claimValue(OWN, aClaim), await w.seed.claimValue(WORK, bClaim)].sort() as [
    string,
    string,
  ];
  const factOf = async (key: string): Promise<string> =>
    (
      await w.admin<{ fp: string }>(
        "select c.fact_key_fp as fp from knowledge.claim_values v join knowledge.claims c on c.id = v.claim_id where v.claim_key = $1",
        [key],
      )
    )[0]?.fp ?? "";
  const id = dreamFindingId();
  await queryAs(
    w.db.urls.pipeline,
    `insert into ledger.dream_findings (id, kind, relation_id, a_key, b_key, subject, judge, compartments)
     values ($1, 'conflict', 1, $2, $3, $4, 'model:test/opus@personal_claim_relations@1', $5::text[])`,
    [id, a, b, person, WIDE],
  );
  return { id, a, b, aFact: await factOf(a), bFact: await factOf(b) };
}

// The settlements a read of both claims' fact keys is given, under `clearance`.
const settlementsRead = async (
  w: OwnerWorld,
  clearance: string[],
  f: Finding,
): Promise<{ id: string; word: string }[]> =>
  queryAs(
    w.db.urls.pipeline,
    "select id, word from policy.belief_inputs_under($1::text[], $2::text[], now() + interval '1 minute') where part = 'settlement'",
    [clearance, [f.aFact, f.bFact]],
  );

describe("an agent settles a conflict dreaming found", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("through its task and report_move; read as settled only where both claims are seen; lifted by the owner", () =>
    withOwnerWorld(KEYS, "dream-settle", async (w) => {
      await w.admin("update policy.work_settings set default_task_role = 'chief-of-staff'");
      const agent = await workAgent(w, "scout", [...WIDE, "agent:scout"], {
        tools: READING_AGENT_TOOLS,
        kinds: ["research"],
      });
      await w.admin("update policy.clients set roles = array['chief-of-staff'] where name = 'scout'");
      const f = await finding(w);

      // No task until the owner routes the trigger to a role.
      expect(await queryAs(w.db.urls.work, "select subject from ledger.dream_finding_gaps(now())")).toEqual([]);
      await w.admin(
        "insert into knowledge.owner_decisions (id, request_id, kind, answer, queue_depth, decided_at, compartments) values ('rul_00000000000000000000000077', 'route-dream-finding', 'gap_route', 'route', 0, now(), '{own}')",
      );
      await w.admin(
        "insert into policy.gap_routes (trigger, role, ruling_id) values ('dream_finding', 'chief-of-staff', 'rul_00000000000000000000000077')",
      );
      // The tick's gap, under the finding's own label, and its task.
      const gaps = await queryAs<{ subject: string; label: string[]; about_id: string }>(
        w.db.urls.work,
        "select subject, label, about_id from ledger.dream_finding_gaps(now())",
      );
      expect(gaps.map((one) => [one.subject, one.label])).toEqual([[f.id, WIDE]]);
      const [raised] = await queryAs<{ id: string | null }>(
        w.db.urls.work,
        "select ledger.raise_gap_flag($1, 'dream_finding', $2, 'entity', $3, 'entity', $3, null, null, true) as id",
        [testId("opp"), f.id, gaps[0]?.about_id],
      );
      const task = raised?.id as OpportunityId;
      expect(task).toBeTruthy();
      expect(await w.admin("select role, compartments from ledger.opportunities where id = $1", [task])).toEqual([
        { role: "chief-of-staff", compartments: WIDE },
      ]);

      ok(await w.work.claimOpportunity(agent.token, { id: task, requestId: request() }));
      const { move } = ok(
        await w.work.planMove(agent.token, { opportunity: task, stage: "investigate", requestId: request() }),
      );
      const record = ok(
        await w.reader.record(agent.token, {
          kind: "finding",
          body: "What the two facts' sources say.",
          requestId: request(),
        }),
      ).recordId;
      // A settlement of another finding is refused, and nothing is written.
      const wrong = await w.work.reportMove(agent.token, {
        move,
        outcome: "done",
        report: {
          deliverable: "Settled.",
          next: "Nothing.",
          sources: [{ kind: "agent_record", id: record }],
          settle: { finding: "dfd_00000000000000000000000009", holds: "a" },
        } as never,
        requestId: request(),
      });
      expect(ok(wrong)).toMatchObject({ refused: ["settle_not_asked"] });
      const done = await w.work.reportMove(agent.token, {
        move,
        outcome: "done",
        report: {
          deliverable: "The newer source holds.",
          next: "Nothing more is needed.",
          sources: [{ kind: "agent_record", id: record }],
          settle: { finding: f.id, holds: "b" },
        } as never,
        requestId: request(),
      });
      expect(ok(done)).not.toHaveProperty("refused");
      const [settlement] = await w.admin<{
        id: string;
        holds_key: string;
        client_name: string;
        compartments: string[];
        cited_ids: string[];
      }>("select id, holds_key, client_name, compartments, cited_ids from ledger.belief_settlements");
      expect(settlement).toMatchObject({
        holds_key: f.b,
        client_name: "scout",
        compartments: WIDE,
        cited_ids: [record],
      });
      // Never the owner's word: no owner decision is written for it.
      expect(
        await w.admin("select id from knowledge.owner_decisions where details ->> 'settlement' is not null"),
      ).toEqual([]);

      // A reader that sees both claims is given it; one that sees only `own` is given nothing (invariant 6).
      expect(await settlementsRead(w, WIDE, f)).toEqual([{ id: settlement?.id, word: f.b }]);
      expect(await settlementsRead(w, OWN, f)).toEqual([]);
      // With a settlement in force the finding raises no second task.
      expect(await queryAs(w.db.urls.work, "select subject from ledger.dream_finding_gaps(now())")).toEqual([]);

      // The owner's lift (invariant 11): off every read, and the finding is open again.
      expect(await w.owner.extraction.liftSettlement(settlement?.id ?? "")).toEqual({
        id: settlement?.id,
        lifted: true,
      });
      expect(await settlementsRead(w, WIDE, f)).toEqual([]);
      expect(
        (
          await queryAs<{ subject: string }>(w.db.urls.work, "select subject from ledger.dream_finding_gaps(now())")
        ).map((one) => one.subject),
      ).toEqual([f.id]);
      // A new task for it: the answer the owner took back is not given again, the other may be.
      const [again] = await queryAs<{ id: string | null }>(
        w.db.urls.work,
        "select ledger.raise_gap_flag($1, 'dream_finding', $2, 'entity', $3, 'entity', $3, null, null, true) as id",
        [testId("opp"), f.id, gaps[0]?.about_id],
      );
      const next = again?.id as OpportunityId;
      ok(await w.work.claimOpportunity(agent.token, { id: next, requestId: request() }));
      const step = ok(
        await w.work.planMove(agent.token, { opportunity: next, stage: "investigate", requestId: request() }),
      );
      const reread = ok(
        await w.reader.record(agent.token, { kind: "finding", body: "Read both again.", requestId: request() }),
      ).recordId;
      const report = (holds: "a" | "b") =>
        w.work.reportMove(agent.token, {
          move: step.move,
          outcome: "done",
          report: {
            deliverable: "Read again.",
            next: "Nothing.",
            sources: [{ kind: "agent_record", id: reread }],
            settle: { finding: f.id, holds },
          } as never,
          requestId: request(),
        });
      expect(ok(await report("b"))).toMatchObject({ refused: ["settle_refused"] });
      expect(ok(await report("a"))).not.toHaveProperty("refused");
      expect(await settlementsRead(w, WIDE, f)).toEqual([expect.objectContaining({ word: f.a })]);
    }));
});
