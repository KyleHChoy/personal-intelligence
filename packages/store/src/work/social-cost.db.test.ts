import { AGENT_STANDING_SAY, AgentRecords, AgentWeeks, ContextPack } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { createAdmin } from "../admin/admin.ts";
import { setTaskTier } from "../admin/admin-tasks.ts";
import { ownerQuestions } from "../admin/outcomes/admin-outcomes-questions.ts";
import { taintCiting } from "../erasure/taint.ts";
import { ALL_TOOLS, request } from "../test-support/clients.ts";
import { readAs, session } from "../test-support/connections.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { TASK_AGENT_TOOLS, type WorkClient } from "../test-support/work-clients.ts";
import { workAgent } from "../test-support/work-test-tasks.ts";
import { type Message, ok, type WorkWorld, withWorkWorld } from "../test-support/work-test-world.ts";
import { createWriter } from "../write/writer.ts";

// Social cost tracked: a write_back needs_owner pays first as the other questions to the owner do (ledger.write_back over ledger.tried_holds), counted in
// questions_paid_share; the agent's start pack opens with its standing (ledger.my_standing); the owner reads each agent's weeks
// (ledger.agent_weeks_within) from `pia agents record` and the System room. Reads go through the reader under each client's token, as `pi mcp` makes
// them. Synthetic rows only.

const LABELS = ["own", "agent:scout", "agent:wren", "employer:example"];
const TOOLS = [
  ...new Set([...ALL_TOOLS, ...TASK_AGENT_TOOLS, "find_messages", "read_message", "build_context_pack", "write_back"]),
];
const UNPAID = { ok: false, code: "invalid_request", refusal: "question_unpaid" };

const agent = async (w: WorkWorld, name: string): Promise<WorkClient> => {
  const client = await w.client(name, ["own", `agent:${name}`], { tools: TOOLS });
  await w.harness(client, "investigate", "investigate");
  return client;
};

// Searched with find_messages and read whole by the client: what it tried.
async function tried(w: WorkWorld, client: WorkClient, message: Message) {
  ok(await w.reader.findMessages(client.token, {}));
  ok(await w.reader.readMessage(client.token, { id: message.id as never }));
  return {
    searches: [{ tool: "find_messages" as const, query: "the delivery date" }],
    sources: [message.id as never],
    why: "No message names a delivery date.",
  };
}

const needsOwner = (w: WorkWorld, client: WorkClient, message: Message, given?: Awaited<ReturnType<typeof tried>>) =>
  w.work.writeBack(client.token, {
    source: { kind: "message", id: message.id as never },
    state: "needs_owner",
    ...(given === undefined ? {} : { tried: given }),
    requestId: request(),
  });

const marks = (w: WorkWorld, client: WorkClient) =>
  w.admin<{ state: string; question_tools: string[] | null; question_sources: string[] | null; paid: boolean }>(
    `select state, question_tools, question_sources, question_paid_at is not null as paid
     from ledger.signal_marks where client_id = $1 order by created_at, id`,
    [client.id],
  );

// A refused call in the client's own call log, as the agent API writes one.
const refusedCall = (w: WorkWorld, client: WorkClient, tool: string, reason: string, field: string) =>
  readAs(w.db, client.token, (query) =>
    query("select policy.log_call($1, 0, 'invalid_request', $2, $3)", [tool, reason, field]),
  );

describe("social cost enforced and tracked", { timeout: DB_TEST_TIMEOUT }, () => {
  it("refuses a write_back needs_owner question_unpaid without a tried the logs bear out, after not_found on a source it cannot see; writes a paid one with its tools and sources; keeps none on another state; and counts it in questions_paid_share within the reading's label", () =>
    withWorkWorld(async (w) => {
      const scout = await agent(w, "scout");
      const message = await w.message(["own"]);

      // No tried: refused, nothing written. A source it cannot see answers not_found first.
      expect(await needsOwner(w, scout, message)).toEqual(UNPAID);
      const hidden = await w.message(["employer:example"]);
      expect(await needsOwner(w, scout, hidden)).toMatchObject({ ok: false, code: "not_found" });
      // Searched, but the source never read: refused.
      ok(await w.reader.findMessages(scout.token, {}));
      expect(
        await needsOwner(w, scout, message, {
          searches: [{ tool: "find_messages", query: "the delivery date" }],
          sources: [message.id as never],
          why: "No message names a delivery date.",
        }),
      ).toEqual(UNPAID);
      expect(await marks(w, scout)).toEqual([]);

      // Control: searched and read by this client within the day. Written with what it tried.
      const given = await tried(w, scout, message);
      expect(ok(await needsOwner(w, scout, message, given))).toEqual({ state: "needs_owner" });
      // Another state needs none and keeps none.
      ok(
        await w.work.writeBack(scout.token, {
          source: { kind: "message", id: message.id as never },
          state: "handled",
          tried: given,
          requestId: request(),
        }),
      );
      expect(await marks(w, scout)).toEqual([
        { state: "needs_owner", question_tools: ["find_messages"], question_sources: [message.evidence], paid: true },
        { state: "handled", question_tools: null, question_sources: null, paid: false },
      ]);

      // The measure: one question, paid, under the mark's label; none under a label it is not within.
      const since = new Date(Date.now() - 86_400_000).toISOString();
      const until = new Date(Date.now() + 60_000).toISOString();
      const share = (within: string[]) =>
        ownerQuestions(w.admin, since, until, within).then((all) =>
          all.find((one) => one.metric === "questions_paid_share"),
        );
      expect(await share(LABELS)).toMatchObject({ value: 1, sample: 1, parts: { asked: 1, paid: 1 } });
      expect(await share(["own"])).toMatchObject({ value: null, sample: 0 });
    }, LABELS));

  it("opens the agent's pack with its standing over seven days within its clearance, and gives the owner each agent's ISO weeks, the one under way first", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const scout = await agent(w, "scout");
      const wren = await agent(w, "wren");

      // One bet, one paid question, two calls refused for a fault of the call.
      const person = await w.seed.entity("person");
      await w.seed.account(["own"], person);
      const basis = await w.message(["own"]);
      await w.seed.pipelineItem(["own"], basis.evidence);
      await w.admin(
        "update vault.pipeline_items set waiting = false, withheld = false, screened = true where evidence_id = $1",
        [basis.evidence],
      );
      const bet = ok(
        await w.work.proposeTask(scout.token, {
          kind: "investigate",
          about: { kind: "entity", id: person as never },
          summary: "find who runs the clinic",
          basis: [{ kind: "message", id: basis.id as never }],
          bet: true,
          requestId: request(),
        }),
      );
      expect(bet).toMatchObject({ bet: true });
      const message = await w.message(["own"]);
      ok(await needsOwner(w, scout, message, await tried(w, scout, message)));
      await refusedCall(w, scout, "write_back", "question_unpaid", "tried");
      await refusedCall(w, scout, "propose_task", "bet_budget_spent", "bet");
      // Another agent's refusal moves nothing of scout's.
      await refusedCall(w, wren, "write_back", "question_unpaid", "tried");

      const pack = ContextPack.parse(ok(await w.reader.buildContextPack(scout.token, { purpose: "agent_bootstrap" })));
      expect(pack.template).toBe("agent_bootstrap@16");
      expect(pack.items.map((item) => item.section).slice(0, 2)).toEqual(["standing", "guide"]);
      expect(pack.items[0]).toMatchObject({
        id: "standing",
        kind: "standing",
        say: AGENT_STANDING_SAY,
        standing: {
          days: 7,
          bets: { placed: 1, used: 0, budget: 3, left: 2 },
          questions: { asked: 1, paid: 1, unpaid: 0, refused: 1 },
          refusals: [
            { code: "bet_budget_spent", count: 1 },
            { code: "question_unpaid", count: 1 },
          ],
        },
      });
      // An agent with nothing is still told its budget.
      const quiet = ContextPack.parse(ok(await w.reader.buildContextPack(wren.token, { purpose: "agent_bootstrap" })));
      expect(quiet.items[0]).toMatchObject({
        kind: "standing",
        standing: { bets: { placed: 0, budget: 3, left: 3 }, questions: { asked: 0, refused: 1 } },
      });

      // The owner's counts rest only on rows within what is read: scout's mark is under its own
      // compartment, so a reading of `own` alone counts no question.
      const within = await w.admin<{ asked: number }>(
        "select q.asked from ledger.agent_questions_within(now() - interval '1 day', now() + interval '1 minute', $1, $2) q",
        [["own"], scout.id],
      );
      expect(within).toEqual([{ asked: 0 }]);
      // No client reads the owner's weeks or another's questions.
      await expect(
        readAs(w.db, scout.token, (query) => query("select * from ledger.agent_weeks_within(now(), 4, '{own}', null)")),
      ).rejects.toThrow(/permission denied/);

      const admin = createAdmin({ url: w.db.urls.admin, keys: w.db.keys, log: w.log });
      try {
        const weeks = AgentWeeks.parse(await admin.agents.weeks(2));
        expect(weeks.weeks).toBe(2);
        expect(weeks.agents.map((one) => one.client)).toEqual(["scout", "wren"]);
        const mine = weeks.agents.find((one) => one.client === "scout")?.weeks ?? [];
        expect(mine).toHaveLength(2);
        expect(mine[0]).toMatchObject({
          bets: { placed: 1, used: 0, unused: 0, open: 1, budget: 3, left: 2 },
          questions: { asked: 1, paid: 1, refused: 1 },
          takenBack: 0,
        });
        expect(mine[1]).toMatchObject({ bets: { placed: 0 }, questions: { asked: 0, paid: 0, refused: 0 } });
        // Monday, newest first.
        expect(new Date(`${mine[0]?.week}T00:00:00Z`).getUTCDay()).toBe(1);
        expect(Date.parse(`${mine[0]?.week}T00:00:00Z`) - Date.parse(`${mine[1]?.week}T00:00:00Z`)).toBe(
          7 * 86_400_000,
        );
        await expect(admin.agents.weeks(0)).rejects.toThrow(/invalid_argument/);
        await expect(admin.agents.weeks(27)).rejects.toThrow(/invalid_argument/);

        // The System room: the record and its four weeks.
        const room = AgentRecords.parse(await admin.agents.records());
        const row = room.agents.find((one) => one.client === "scout");
        expect(row?.weeks).toHaveLength(4);
        expect(row?.weeks[0]).toMatchObject({ bets: { placed: 1 }, questions: { asked: 1, paid: 1 } });
      } finally {
        await admin.close();
      }
    }, LABELS));

  it("counts a paid hand-off to the owner as paid and an owner_question also handed off once; an erased source deletes the needs_owner mark naming it and leaves the work's other sources", () =>
    withWorkWorld(async (w) => {
      // With its agent compartment and source account, so its handoff note is taken in.
      const scout = await workAgent(w, "scout", ["own", "agent:scout"], { tools: TOOLS, account: true });
      const intent = await w.intent(["investigate"], [scout]);
      const message = await w.message(["own"]);
      const about = { kind: "message" as const, id: message.id as never };
      const work = ok(
        await w.work.proposeOpportunity(scout.token, {
          kind: "investigate",
          about,
          summary: "look into the delivery date",
          basis: [about],
          requestId: request(),
        }),
      ).opportunity;
      await w.decideGo(work, intent);
      ok(await w.work.claimOpportunity(scout.token, { id: work, requestId: request() }));
      const note = ok(
        await w.reader.record(scout.token, {
          kind: "handoff",
          body: "The supplier needs a signature.",
          requestId: request(),
        }),
      ).recordId;
      const writer = createWriter({ url: w.db.urls.writer, keys: w.db.keys, log: w.log });
      try {
        await writer.takeRecords();
      } finally {
        await writer.close();
      }
      const second = await w.message(["own"]);
      const given = await tried(w, scout, message);
      ok(await w.reader.readMessage(scout.token, { id: second.id as never }));
      ok(await w.reader.findMessages(scout.token, {}));
      const both = { ...given, sources: [message.id as never, second.id as never] };
      expect(
        ok(
          await w.work.handOff(scout.token, {
            id: work,
            role: "owner",
            reason: "blocked",
            record: note as never,
            tried: both,
            requestId: request(),
          }),
        ),
      ).toEqual({ handedOff: true });

      const questions = () =>
        w.admin<{ asked: number; paid: number }>(
          "select q.asked, q.paid from ledger.agent_questions_within(now() - interval '1 day', now() + interval '1 minute', $1, $2) q",
          [LABELS, scout.id],
        );
      // The hand-off's event is stamped by the clock, its mark at the transaction's start: still paid.
      expect(await questions()).toEqual([{ asked: 1, paid: 1 }]);

      // An owner_question an agent proposed and an agent handed to the owner is one question.
      const asked = await w.admin<{ id: string }>(
        "select id from ledger.opportunities where id <> $1 and created_by = $2 limit 1",
        [work, `client:${scout.id}`],
      );
      expect(asked).toEqual([]);
      const { hypothesis } = ok(
        await w.work.proposeHypothesis(scout.token, {
          kind: "open_loop",
          about,
          summary: "an open loop in the cited message",
          basis: [about],
          requestId: request(),
        }),
      );
      await owned(w, "update ledger.opportunities set kind = 'owner_question', hypothesis_id = $2 where id = $1", [
        work,
        hypothesis,
      ]);
      expect(await questions()).toEqual([{ asked: 1, paid: 1 }]);
      await owned(w, "update ledger.opportunities set kind = 'investigate' where id = $1", [work]);

      // A needs_owner mark on one message whose question names another: erasing the one it names
      // deletes the mark; erasing a source of the handed work takes it out of the work alone.
      const ref = await w.message(["own"]);
      const named = await w.message(["own"]);
      const markTried = await tried(w, scout, named);
      ok(await needsOwner(w, scout, ref, markTried));
      expect((await marks(w, scout)).map((one) => one.state)).toEqual(["needs_owner"]);
      await erase(w, named);
      expect(await marks(w, scout)).toEqual([]);
      await erase(w, second);
      expect(
        await w.admin(
          "select question_sources, question_paid_at is not null as paid from ledger.opportunities where id = $1",
          [work],
        ),
      ).toEqual([{ question_sources: [message.evidence], paid: true }]);
      await erase(w, message);
      expect(
        await w.admin(
          "select question_sources, question_paid_at is not null as paid from ledger.opportunities where id = $1",
          [work],
        ),
      ).toEqual([{ question_sources: [], paid: true }]);
    }, LABELS));
});

// One statement as pi_owner, past the table's forced row security and its triggers.
const owned = (w: WorkWorld, text: string, values: unknown[]): Promise<unknown> =>
  session(w.db.urls.bootstrap, async (query) => {
    const table = /^\s*update (\S+)/.exec(text)?.[1];
    await query("set role pi_owner");
    await query(`alter table ${table} no force row level security`);
    await query(`alter table ${table} disable trigger user`);
    try {
      await query(text, values);
    } finally {
      await query(`alter table ${table} enable trigger user`);
      await query(`alter table ${table} force row level security`);
    }
  });

// A message removed as the writer's removal path removes one, in one transaction: its row, the taint
// call (which leaves no question naming it), then its evidence.
async function erase(w: WorkWorld, message: Message): Promise<void> {
  await session(w.db.urls.writer, async (query) => {
    await query("begin");
    await query("delete from knowledge.messages where evidence_id = $1", [message.evidence]);
    await taintCiting(query, { evidenceIds: [message.evidence], refs: [{ kind: "message", id: message.id }] });
    await query("delete from vault.evidence_items where id = $1", [message.evidence]);
    await query("commit");
  });
}
