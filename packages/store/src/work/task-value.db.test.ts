import type { AgentRecordId, MoveId } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { createAdmin } from "../admin/admin.ts";
import { setTaskTier } from "../admin/admin-tasks.ts";
import { request, testId } from "../test-support/clients.ts";
import { session } from "../test-support/connections.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { TASK_AGENT_TOOLS, type WorkClient } from "../test-support/work-clients.ts";
import { ok, type WorkWorld, withWorkWorld } from "../test-support/work-test-world.ts";

// Whether finished work was used: what code can show, within the task's own label, and the owner's Keep
// or Not useful, which outranks it. The weekly few to judge. Synthetic rows only.

const LABELS = ["own", "agent:scout", "work"];
const WEEK = 7 * 86_400_000;

async function scout(w: WorkWorld): Promise<WorkClient> {
  const client = await w.client("scout", ["own", "agent:scout"], { tools: TASK_AGENT_TOOLS });
  await w.harness(client, "investigate", "investigate");
  return client;
}

// A task about a person, worked and reported done now.
async function finished(
  w: WorkWorld,
  client: WorkClient,
): Promise<{ opportunity: string; move: MoveId; person: string; record: string }> {
  const person = await w.seed.entity("person");
  await w.seed.account(["own"], person);
  const message = await w.message(["own"]);
  await w.seed.pipelineItem(["own"], message.evidence);
  await w.admin(
    "update vault.pipeline_items set waiting = false, withheld = false, screened = true where evidence_id = $1",
    [message.evidence],
  );
  const { opportunity } = ok(
    await w.work.proposeTask(client.token, {
      kind: "investigate",
      about: { kind: "entity", id: person as never },
      summary: "find who runs the clinic",
      basis: [{ kind: "message", id: message.id as never }],
      requestId: request(),
    }),
  );
  ok(await w.work.claimOpportunity(client.token, { id: opportunity as never, requestId: request() }));
  const { move } = ok(
    await w.work.planMove(client.token, {
      opportunity: opportunity as never,
      stage: "investigate",
      requestId: request(),
    }),
  );
  const record = ok(
    await w.reader.record(client.token, { kind: "finding", body: "two founders run it", requestId: request() }),
  ).recordId as AgentRecordId;
  ok(
    await w.work.reportMove(client.token, {
      move,
      outcome: "done",
      summary: "two founders",
      report: { deliverable: "two names", next: "nothing", sources: [{ kind: "agent_record", id: record }] },
      requestId: request(),
    }),
  );
  return { opportunity, move: move as MoveId, person, record };
}

type Row = {
  opportunity_id: string;
  cited: boolean;
  acted: boolean;
  confirmed: boolean;
  rejected: boolean;
  judged: string | null;
  reason: string | null;
  used: boolean;
  dropped: boolean;
  scored: boolean;
};
const standingOf = async (
  w: WorkWorld,
  opportunity: string,
  until: Date,
  within: string[] = LABELS,
): Promise<Row | undefined> =>
  (
    await session(w.db.urls.work, (query) =>
      query<Row>(
        "select opportunity_id, cited, acted, confirmed, rejected, judged, reason, used, dropped, scored from ledger.task_value($1, $2, $3)",
        [new Date(Date.now() - 90 * 86_400_000).toISOString(), until.toISOString(), within],
      ),
    )
  ).find((row) => row.opportunity_id === opportunity);

const wroteTo = (w: WorkWorld, person: string, at: Date, compartments: string[]) =>
  w.admin(
    `insert into knowledge.interaction_log (id, evidence_id, member_id, entity_id, direction, channel, occurred_at, entity_role, compartments, readers)
     values ($1, (select id from vault.evidence_items limit 1), 'owner', $2, 'outbound', 'email', $3, 'recipient', $4, '{}')`,
    [testId("itr"), person, at, compartments],
  );

// What read_record logs: the record's id in `shown`, and its bound evidence apart.
const READ_RECORD =
  "insert into ledger.read_log (session_id, client_id, tool, read_at, compartments, bound, shown, fact_key_fps) values ($1, $2, 'read_record', $3, '{own,agent:scout}', '{}', $4, '{}')";

describe("whether finished work was used", { timeout: DB_TEST_TIMEOUT }, () => {
  it("young work with no signal does not count against its trigger; a week on it does", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const { opportunity } = await finished(w, await scout(w));
      expect(await standingOf(w, opportunity, new Date())).toMatchObject({
        used: false,
        scored: false,
        dropped: false,
      });
      expect(await standingOf(w, opportunity, new Date(Date.now() + WEEK + 60_000))).toMatchObject({
        used: false,
        scored: true,
      });
    }, LABELS));

  it("the owner writing to the person within a week is used; later, or under a label the task does not hold, is not", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const { opportunity, person } = await finished(w, await scout(w));
      const narrow = ["own", "agent:scout"];
      // Under a label a viewer cannot see: it moves nothing they see (invariant 6). One who can, it does.
      await wroteTo(w, person, new Date(Date.now() + 60_000), ["own", "work"]);
      expect((await standingOf(w, opportunity, new Date(Date.now() + 120_000), narrow))?.acted).toBe(false);
      expect((await standingOf(w, opportunity, new Date(Date.now() + 120_000)))?.acted).toBe(true);
      // Past the week.
      await wroteTo(w, person, new Date(Date.now() + 2 * WEEK), narrow);
      expect((await standingOf(w, opportunity, new Date(Date.now() + 3 * WEEK), narrow))?.acted).toBe(false);
      await wroteTo(w, person, new Date(Date.now() + 60_000), narrow);
      expect(await standingOf(w, opportunity, new Date(Date.now() + 120_000), narrow)).toMatchObject({
        acted: true,
        used: true,
        scored: true,
      });
    }, LABELS));

  it("the owner confirming a fact the task's records made is used; rejecting it is not", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const { opportunity, record } = await finished(w, await scout(w));
      const message = await w.message(["own"]);
      await session(w.db.urls.bootstrap, async (owner) => {
        await owner("set role pi_owner");
        await owner("alter table ledger.agent_writes no force row level security");
        try {
          await owner("update ledger.agent_writes set evidence_id = $2 where id = $1", [record, message.evidence]);
        } finally {
          await owner("alter table ledger.agent_writes force row level security");
        }
      });
      const claim = await w.seed.claim(["own"], message.evidence);
      const answerCard = async (given: string): Promise<void> => {
        const id = testId("crd");
        await session(w.db.urls.work, (query) =>
          query(
            "insert into ledger.cards (id, request_id, created_at, created_by, kind, target_kind, target_id, options, compartments) values ($1, $1, now(), 'system:extract', 'about_you', 'claim', $2, '{confirm,reject}', '{own}')",
            [id, claim],
          ),
        );
        await w.admin(
          "insert into knowledge.owner_decisions (id, request_id, kind, answer, card_id, queue_depth, labels, details, decided_at, compartments) values ($1, $2, 'answer', $3, $4, 0, '{}', '{}', now(), '{own}')",
          [testId("rul"), testId("req"), given, id],
        );
      };
      await answerCard("reject");
      expect(await standingOf(w, opportunity, new Date())).toMatchObject({
        confirmed: false,
        rejected: true,
        used: false,
      });
      await answerCard("confirm");
      expect(await standingOf(w, opportunity, new Date())).toMatchObject({ confirmed: true, used: true, scored: true });
    }, LABELS));

  it("another agent reading a finding by its id is cited; the writer reading it again is not", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const { opportunity, record } = await finished(w, await scout(w));
      expect((await standingOf(w, opportunity, new Date()))?.cited).toBe(false);
      const reader = await w.client("second", ["own", "agent:scout"], { tools: TASK_AGENT_TOOLS });
      const tester = await w.client("tester", ["own", "agent:scout"], {
        tools: [...TASK_AGENT_TOOLS, "start_outcome_test"],
      });
      const [session_] = await w.admin<{ id: string }>("select id from ledger.sessions limit 1");
      await session(w.db.urls.bootstrap, async (owner) => {
        await owner("set role pi_owner");
        await owner(READ_RECORD, [session_?.id, tester.id, new Date(Date.now() + 60_000), [record]]);
      });
      // The outcome test reading it shows nobody used the work.
      expect((await standingOf(w, opportunity, new Date(Date.now() + 120_000)))?.cited).toBe(false);
      await session(w.db.urls.bootstrap, async (owner) => {
        await owner("set role pi_owner");
        await owner(READ_RECORD, [session_?.id, reader.id, new Date(Date.now() + 60_000), [record]]);
      });
      expect(await standingOf(w, opportunity, new Date(Date.now() + 120_000))).toMatchObject({
        cited: true,
        used: true,
      });
    }, LABELS));

  it("the owner's Not useful outranks what code showed, and keeps its reason; their Keep outranks its absence", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const admin = createAdmin({ url: w.db.urls.admin, keys: w.db.keys, log: w.log });
      try {
        const { opportunity, move, person } = await finished(w, await scout(w));
        await wroteTo(w, person, new Date(Date.now() + 60_000), ["own", "agent:scout"]);
        await expect(
          admin.cards.judgeResult({ move, answer: "keep", reason: "other" as never, requestId: request() }),
        ).rejects.toMatchObject({ code: "invalid_argument" });
        await admin.cards.judgeResult({ move, answer: "not_useful", reason: "not_worth_it", requestId: request() });
        const until = new Date(Date.now() + 120_000);
        expect(await standingOf(w, opportunity, until)).toMatchObject({
          acted: true,
          judged: "not_useful",
          reason: "not_worth_it",
          used: false,
          dropped: true,
          scored: true,
        });
        await admin.cards.judgeResult({ move, answer: "keep", requestId: request() });
        expect(await standingOf(w, opportunity, until)).toMatchObject({ judged: "keep", used: true, dropped: false });
        // `none` clears it, and what code showed counts again.
        await admin.cards.judgeResult({ move, answer: "none", requestId: request() });
        expect(await standingOf(w, opportunity, until)).toMatchObject({ judged: null, used: true });

        const view = await admin.box.outcomes(14);
        expect(view.value.triggers.find((one) => one.trigger === "investigate")).toMatchObject({ done: 1, used: 1 });
        expect(view.metrics.find((one) => one.metric === "task_used_share")).toMatchObject({
          sample: 1,
          state: "no_data",
        });
      } finally {
        await admin.close();
      }
    }, LABELS));

  it("a standing holds only what the viewer's labels can see", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      await finished(w, await scout(w));
      const rows = await session(w.db.urls.work, (query) =>
        query<{ trigger: string; scored: number }>("select trigger, scored from ledger.task_standing($1, $2)", [
          new Date(Date.now() - 86_400_000).toISOString(),
          LABELS,
        ]),
      );
      expect(rows.map((row) => row.trigger)).toContain("investigate");
      const hidden = await session(w.db.urls.work, (query) =>
        query("select trigger from ledger.task_standing($1, $2)", [
          new Date(Date.now() - 86_400_000).toISOString(),
          ["work"],
        ]),
      );
      expect(hidden).toEqual([]);
    }, LABELS));

  it("asks about at most three of last fortnight's results a week, the same three all week, each judged taking a place until undone", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      // A week on, so what is reported now is before the week it is drawn in.
      const later = new Date(Date.now() + 8 * 86_400_000);
      const admin = createAdmin({ url: w.db.urls.admin, keys: w.db.keys, log: w.log, now: () => later });
      try {
        const client = await scout(w);
        for (let n = 0; n < 5; n += 1) await finished(w, client);
        const first = (await admin.cards.results()).thisWeek ?? [];
        expect(first).toHaveLength(3);
        expect(((await admin.cards.results()).thisWeek ?? []).map((one) => one.move)).toEqual(
          first.map((one) => one.move),
        );
        const [one] = first;
        if (one === undefined) throw new Error("none");
        await admin.cards.judgeResult({ move: one.move, answer: "keep", requestId: request() });
        const after = (await admin.cards.results()).thisWeek ?? [];
        expect(after).toHaveLength(2);
        expect(after.map((row) => row.move)).not.toContain(one.move);
        // An Undo gives its place back.
        await admin.cards.judgeResult({ move: one.move, answer: "none", requestId: request() });
        expect(((await admin.cards.results()).thisWeek ?? []).map((row) => row.move)).toEqual(
          first.map((row) => row.move),
        );
        // A later page does not ask again.
        const { next } = await admin.cards.results({ limit: 1 });
        const page = await admin.cards.results({ limit: 1, cursor: next ?? "" });
        expect(page.thisWeek).toBeUndefined();
      } finally {
        await admin.close();
      }
    }, LABELS));
});
