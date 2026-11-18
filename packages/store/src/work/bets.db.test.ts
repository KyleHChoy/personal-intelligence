import { AgentRecords, ContextPack } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { createAdmin } from "../admin/admin.ts";
import { setTaskTier } from "../admin/admin-tasks.ts";
import { ownerQuestions } from "../admin/outcomes/admin-outcomes-questions.ts";
import { request, testId } from "../test-support/clients.ts";
import { readAs, session } from "../test-support/connections.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { TASK_AGENT_TOOLS, type WorkClient } from "../test-support/work-clients.ts";
import { workSubject } from "../test-support/work-seeds.ts";
import { ok, type WorkWorld, withWorkWorld } from "../test-support/work-test-world.ts";

// Bets: a task an agent proposes for itself with `bet`, taken within its weekly budget
// (ledger.place_bet), settled on the owner's own signals alone and counted at read (ledger.bets_within,
// ledger.my_bets), in the agent's record and the System room. Synthetic rows only.

const LABELS = ["own", "agent:scout", "agent:wren", "work"];
const TOOLS = [...TASK_AGENT_TOOLS, "build_context_pack"];
const SPENT = { ok: false, code: "invalid_request", refusal: "bet_budget_spent" };
const DAY = 86_400_000;

const agent = async (w: WorkWorld, name: string): Promise<WorkClient> => {
  const client = await w.client(name, ["own", `agent:${name}`], { tools: TOOLS });
  await w.harness(client, "investigate", "investigate");
  return client;
};

const propose = async (w: WorkWorld, client: WorkClient, more: { bet?: true; role?: string } = { bet: true }) => {
  const { person, message } = await workSubject(w);
  return w.work.proposeTask(client.token, {
    kind: "investigate",
    about: { kind: "entity", id: person as never },
    summary: "find who runs the clinic",
    basis: [{ kind: "message", id: message as never }],
    requestId: request(),
    ...more,
  });
};

// The bet worked and reported done now, resting on a finding of the bettor's; the finding's id.
async function finish(
  w: WorkWorld,
  client: WorkClient,
  opportunity: string,
  alsoCites: string[] = [],
): Promise<string> {
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
  ).recordId;
  // A finding resting on a message, so the move's basis can cite it.
  const source = await w.message(["own"]);
  await owned(w, "update ledger.agent_writes set evidence_id = $2 where id = $1", [record, source.evidence]);
  ok(
    await w.work.reportMove(client.token, {
      move,
      outcome: "done",
      summary: "two founders",
      // Cited in the move's basis too: that is how a bet's own work is known.
      basis: [record, ...alsoCites].map((id) => ({ kind: "agent_record" as const, id: id as never })),
      report: { deliverable: "two names", next: "nothing", sources: [{ kind: "agent_record", id: record as never }] },
      requestId: request(),
    }),
  );
  return record;
}

// One statement as pi_owner, past the table's forced row security and its triggers.
const owned = (w: WorkWorld, text: string, values: unknown[]): Promise<unknown> =>
  session(w.db.urls.bootstrap, async (query) => {
    const table = /^\s*(?:insert into|update) (\S+)/.exec(text)?.[1];
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

// A claim from the evidence the record names, and the owner's confirm of it on a card,
// `days` from now, under a label.
async function confirmed(w: WorkWorld, record: string, days = 0, compartments = ["own"]): Promise<void> {
  const message = await w.message(compartments);
  await owned(w, "update ledger.agent_writes set evidence_id = $2 where id = $1", [record, message.evidence]);
  const claim = await w.seed.claim(compartments, message.evidence);
  const card = testId("crd");
  await session(w.db.urls.work, (query) =>
    query(
      "insert into ledger.cards (id, request_id, created_at, created_by, kind, target_kind, target_id, options, compartments) values ($1, $1, now(), 'system:extract', 'about_you', 'claim', $2, '{confirm,reject}', $3)",
      [card, claim, compartments],
    ),
  );
  await w.admin(
    "insert into knowledge.owner_decisions (id, request_id, kind, answer, card_id, queue_depth, labels, details, decided_at, compartments) values ($1, $2, 'answer', 'confirm', $3, 0, '{}', '{}', now() + make_interval(days => $4), $5)",
    [testId("rul"), testId("req"), card, days, compartments],
  );
}

const at = (offset: number) => new Date(Date.now() + offset).toISOString();
const ownersBets = (w: WorkWorld, when: string, client: WorkClient) =>
  w.admin<Record<string, number>>(
    "select b.open, b.used, b.unused, b.placed, b.budget from ledger.bets_within($1, $2, $3) b",
    [when, LABELS, client.id],
  );
const myBets = (w: WorkWorld, client: WorkClient, when: string) =>
  readAs(w.db, client.token, (query) =>
    query("select b.open, b.used, b.unused, b.placed, b.budget from ledger.my_bets($1) b", [when]),
  );

describe("bets", { timeout: DB_TEST_TIMEOUT }, () => {
  it("takes a bet routed to its proposer within the budget, refuses one past it writing nothing, and refuses a bet routed to another or asked for by the owner", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const scout = await agent(w, "scout");
      await agent(w, "wren");
      const first = ok(await propose(w, scout));
      expect(first).toMatchObject({ status: "go", bet: true });
      const [row] = await w.admin<{ role: string; bet: boolean }>(
        "select role, bet_at is not null as bet from ledger.opportunities where id = $1",
        [first.opportunity],
      );
      expect(row).toEqual({ role: "scout", bet: true });
      // A repeat of a plain task's request with bet marks nothing, though places are left.
      const { person: again, message } = await workSubject(w);
      const plainArgs = {
        kind: "investigate" as const,
        about: { kind: "entity" as const, id: again as never },
        summary: "find who runs the clinic",
        basis: [{ kind: "message" as const, id: message as never }],
        requestId: request(),
      };
      const firstPlain = ok(await w.work.proposeTask(scout.token, plainArgs));
      const repeated = ok(await w.work.proposeTask(scout.token, { ...plainArgs, bet: true }));
      expect(repeated.opportunity).toBe(firstPlain.opportunity);
      expect(repeated.bet).toBeUndefined();
      expect(await w.admin("select bet_at from ledger.opportunities where id = $1", [firstPlain.opportunity])).toEqual([
        { bet_at: null },
      ]);
      ok(await propose(w, scout));
      ok(await propose(w, scout));
      const count = async () =>
        (
          await w.admin<{ n: number }>("select count(*)::int as n from ledger.opportunities where created_by = $1", [
            `client:${scout.id}`,
          ])
        )[0]?.n;
      const before = await count();
      // The fourth in seven days: refused, and the task is not written.
      expect(await propose(w, scout)).toEqual(SPENT);
      expect(await count()).toBe(before);
      // The same work as no bet is taken, and carries no mark.
      const plain = ok(await propose(w, scout, {}));
      expect(plain.bet).toBeUndefined();
      // A bet is routed to its proposer, and is never the owner's request.
      expect(await propose(w, scout, { bet: true, role: "wren" })).toEqual({ ok: false, code: "invalid_request" });
      const { person } = await workSubject(w);
      expect(
        await w.work.proposeTask(scout.token, {
          kind: "investigate",
          about: { kind: "entity", id: person as never },
          summary: "find who runs the clinic",
          basis: [{ kind: "owner_request", quote: "find out who runs it" }],
          bet: true,
          requestId: request(),
        }),
      ).toEqual({ ok: false, code: "invalid_request" });
      // Placed a week ago, the bets free their places.
      await owned(w, "update ledger.opportunities set bet_at = bet_at - interval '8 days' where created_by = $1", [
        `client:${scout.id}`,
      ]);
      expect(ok(await propose(w, scout))).toMatchObject({ bet: true });
    }, LABELS));

  it("settles a bet on the owner's keep or confirm of its own work alone, never another agent's read, an unrelated write, a reply to its subject or a late confirm; the week's used bets grow the budget and taken-back answers cost two; an agent reads its own within its clearance", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const scout = await agent(w, "scout");
      const wren = await agent(w, "wren");
      const cited = ok(await propose(w, scout)).opportunity;
      const citedRecord = await finish(w, scout, cited);
      // Wren reads scout's finding a minute after the work: ledger.task_value counts it used.
      await owned(
        w,
        `insert into ledger.read_log (session_id, client_id, tool, read_at, compartments, bound, shown, fact_key_fps)
         values ($1, $2, 'read_record', now() + interval '1 minute', '{own}', '{}', $3, '{}')`,
        [wren.session, wren.id, [citedRecord]],
      );
      const soon = at(10 * 60_000);
      const [value] = await w.admin<{ used: boolean }>(
        "select v.used from ledger.task_value(now() - interval '1 hour', $1, $2) v where v.opportunity_id = $3",
        [soon, LABELS, cited],
      );
      expect(value?.used).toBe(true);
      // As a bet it is open: another agent's read is no act of the owner's.
      expect(await ownersBets(w, soon, scout)).toEqual([{ open: 1, used: 0, unused: 0, placed: 1, budget: 3 }]);
      // Eight days on with no act of the owner's, it settled unused.
      expect(await ownersBets(w, at(8 * DAY), scout)).toEqual([{ open: 0, used: 0, unused: 1, placed: 0, budget: 3 }]);

      // A bet never done within its seven days settles unused too.
      ok(await propose(w, scout));
      expect(await ownersBets(w, at(8 * DAY), scout)).toMatchObject([{ unused: 2 }]);

      // A third bet, done. Scout's other finding in the same hours, which the bet's work never cites,
      // confirmed by the owner, and the owner writing to the bet's person: neither makes the bet used.
      const bystander = ok(await propose(w, scout)).opportunity;
      const bystanderRecord = await finish(w, scout, bystander);
      const stray = ok(
        await w.reader.record(scout.token, { kind: "finding", body: "the clinic moved", requestId: request() }),
      ).recordId;
      await confirmed(w, stray);
      const [about] = await w.admin<{ about_id: string }>("select about_id from ledger.opportunities where id = $1", [
        bystander,
      ]);
      await w.admin(
        `insert into knowledge.interaction_log (id, evidence_id, member_id, entity_id, direction, channel, occurred_at, entity_role, compartments, readers)
         values ($1, (select id from vault.evidence_items limit 1), 'owner', $2, 'outbound', 'email', now(), 'recipient', '{own}', '{}')`,
        [testId("itr"), about?.about_id],
      );
      expect(await myBets(w, scout, soon)).toEqual([{ open: 3, used: 0, unused: 0, placed: 3, budget: 3 }]);
      expect(await propose(w, scout)).toEqual(SPENT);

      // The owner confirms a fact from the bet's own finding: used, and this week's budget grows.
      await confirmed(w, bystanderRecord);
      expect(await myBets(w, scout, soon)).toEqual([{ open: 2, used: 1, unused: 0, placed: 3, budget: 4 }]);

      // A fourth bet, confirmed under a label beyond scout's clearance: the owner's count sees it
      // used, scout's own does not (invariant 6).
      const hidden = ok(await propose(w, scout)).opportunity;
      await confirmed(w, await finish(w, scout, hidden), 0, ["own", "work"]);
      expect(await ownersBets(w, soon, scout)).toEqual([{ open: 2, used: 2, unused: 0, placed: 4, budget: 5 }]);
      expect(await myBets(w, scout, soon)).toEqual([{ open: 3, used: 1, unused: 0, placed: 4, budget: 4 }]);
      expect(await propose(w, scout)).toEqual(SPENT);

      // An answer scout relayed that the owner took back this week costs two.
      const card = testId("crd");
      await session(w.db.urls.work, (query) =>
        query(
          `insert into ledger.cards (id, request_id, created_at, created_by, kind, target_kind, target_id, options, compartments)
           values ($1, $1, now() - interval '1 hour', 'system:work', 'opportunity_decision', 'opportunity', $2, '{go,no_go,later}', '{own}')`,
          [card, cited],
        ),
      );
      await owned(
        w,
        `insert into ledger.card_relays (id, request_id, card_id, opportunity_id, client_id, client_name, option, ruling_id, applied_at, reopened_at, created_at, compartments)
         values ($1, $2, $3, $4, $5, 'scout', 'go', $6, now() - interval '2 hours', now() - interval '1 hour', now() - interval '3 hours', '{own}')`,
        [testId("crl"), testId("req"), card, cited, scout.id, testId("rul")],
      );
      expect(await myBets(w, scout, soon)).toMatchObject([{ placed: 4, budget: 2 }]);
      // A week on, both the used bet and the taken-back answer have left the budget's week.
      expect(await myBets(w, scout, at(8 * DAY))).toMatchObject([{ placed: 0, budget: 3 }]);

      // Each reads its own alone: wren has none, and no reader holds the owner's read.
      expect(await myBets(w, wren, soon)).toEqual([{ open: 0, used: 0, unused: 0, placed: 0, budget: 3 }]);
      await expect(
        readAs(w.db, scout.token, (query) => query("select * from ledger.bets_within(now(), '{own}', null)")),
      ).rejects.toThrow(/permission denied/);

      // The pack's record and the System room carry the bets.
      const pack = ContextPack.parse(ok(await w.reader.buildContextPack(scout.token, { purpose: "agent_bootstrap" })));
      expect(pack.items.find((item) => item.section === "record")).toMatchObject({
        record: { bets: { open: 3, used: 1, unused: 0, budget: 2, left: 0 } },
      });
      const admin = createAdmin({ url: w.db.urls.admin, keys: w.db.keys, log: w.log });
      try {
        const room = AgentRecords.parse(await admin.agents.records());
        expect(room.agents.find((one) => one.client === "scout")?.record.bets).toEqual({
          open: 2,
          used: 2,
          unused: 0,
          budget: 3,
          left: 0,
        });
      } finally {
        await admin.close();
      }
      // The measure: of the bets settled, the share used, within the reading's label alone.
      const share = (within: string[]) =>
        ownerQuestions(w.admin, at(-DAY), soon, within).then((all) =>
          all.find((one) => one.metric === "bets_used_share"),
        );
      expect(await share(LABELS)).toMatchObject({ value: 1, sample: 2, parts: { used: 2, unused: 0 } });
      expect(await share(["own", "agent:scout"])).toMatchObject({ value: 1, sample: 1, parts: { used: 1, unused: 0 } });

      // A confirm eight days after the work, past its week, never turns a settled bet used.
      await confirmed(w, citedRecord, 8);
      expect(await ownersBets(w, at(9 * DAY), scout)).toMatchObject([{ open: 0, used: 2, unused: 2 }]);
    }, LABELS));

  it("credits no record written before the bet, though its moves cite it; a later event on the task does not unsettle a used bet", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const scout = await agent(w, "scout");
      // A finding of scout's from before the bet, resting on a message.
      const older = ok(
        await w.reader.record(scout.token, {
          kind: "finding",
          body: "the clinic has two founders",
          requestId: request(),
        }),
      ).recordId;
      const source = await w.message(["own"]);
      await owned(w, "update ledger.agent_writes set evidence_id = $2 where id = $1", [older, source.evidence]);
      await owned(w, "update ledger.agent_writes set created_at = now() - interval '1 hour' where id = $1", [older]);
      const bet = ok(await propose(w, scout)).opportunity;
      const own = await finish(w, scout, bet, [older]);
      const soon = at(10 * 60_000);
      // The owner confirms a fact from the older finding: the bet's move cites it, but it is not the bet's work.
      await confirmed(w, older);
      expect(await ownersBets(w, soon, scout)).toMatchObject([{ open: 1, used: 0 }]);
      // A fact from the bet's own finding: used.
      await confirmed(w, own);
      expect(await ownersBets(w, soon, scout)).toMatchObject([{ open: 0, used: 1 }]);
      // The task is reopened after: its first done stands, and the bet stays used.
      await owned(
        w,
        `insert into ledger.record_events (row_kind, row_id, event, at, by, compartments)
         select 'opportunity', o.id, 'go', now(), 'owner', o.compartments from ledger.opportunities o where o.id = $1`,
        [bet],
      );
      expect(await ownersBets(w, soon, scout)).toMatchObject([{ open: 0, used: 1 }]);
    }, LABELS));
});
