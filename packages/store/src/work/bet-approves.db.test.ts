import { DECISION_POINT_PINS, type DecisionPointCall, type OpportunityId } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { createAdmin } from "../admin/admin.ts";
import { setTaskTier } from "../admin/admin-tasks.ts";
import { request, sha256Hex, testId } from "../test-support/clients.ts";
import { ownerStatement, readAs, session } from "../test-support/connections.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { TASK_AGENT_TOOLS, type WorkClient } from "../test-support/work-clients.ts";
import { workSubject } from "../test-support/work-seeds.ts";
import { ok, type WorkWorld, withWorkWorld } from "../test-support/work-test-world.ts";
import { createDispatch } from "./dispatch.ts";

// An agent approves read-only work it proposed by spending one of its bets: propose_opportunity
// with `bet`, ledger.place_bet within the one weekly budget, and rung 0's go stored as the agent's
// (decided_by `agent`), never the owner's. The owner's no outranks it and ends the bet lost; the
// owner's Keep of its result ends it won. Synthetic rows only.

const LABELS = ["own", "agent:scout", "work"];
const TOOLS = [...TASK_AGENT_TOOLS, "build_context_pack"];

// The go rung 0 gives on a bet, as the tick records it (personal-ladder's opportunityGo).
const GO: DecisionPointCall = {
  point: "opportunity_go",
  version: 1,
  definitionHash: DECISION_POINT_PINS["opportunity_go@1"] ?? "",
  rung: 0,
  inputHash: sha256Hex("opportunity_go:go:agent_bet"),
  output: "go",
  effect: "go_internal",
  effectClass: "internal_reversible",
  escalated: false,
};

async function scoutOf(w: WorkWorld): Promise<{ scout: WorkClient; intent: string }> {
  const scout = await w.client("scout", ["own", "agent:scout"], { tools: TOOLS });
  for (const [kind, stage] of [
    ["investigate", "investigate"],
    ["follow_up", "investigate"],
    ["follow_up", "draft"],
  ] as const)
    await w.harness(scout, kind, stage);
  // The owner's confirmed intent for the kinds, in the mode every agent is registered with: it lets
  // the agent work them and leaves the go to the owner, but for a bet.
  const intent = await w.intent(["investigate", "follow_up"], [scout], "owner_decides");
  return { scout, intent };
}

const propose = async (
  w: WorkWorld,
  client: WorkClient,
  more: { kind?: "investigate" | "follow_up"; bet?: true; requestId?: string } = {},
) => {
  // Its message screened and not withheld, so no basis line flags it.
  const { person, message } = await workSubject(w);
  return w.work.proposeOpportunity(client.token, {
    kind: more.kind ?? "investigate",
    about: { kind: "entity", id: person as never },
    summary: "find who runs the harbour clinic",
    basis: [{ kind: "message", id: message as never }],
    requestId: more.requestId ?? request(),
    ...(more.bet === undefined ? {} : { bet: more.bet }),
  });
};

// The tick's decision step for one opportunity: rung 0's go on the bet, as the agent's.
async function decided(w: WorkWorld, id: string, intent: string): Promise<boolean> {
  const dispatch = createDispatch({ url: w.db.urls.work, log: w.log, journal: "" });
  try {
    const item = await dispatch.opportunityToDecide(id as OpportunityId, new Date());
    expect(item?.facts).toMatchObject({ proposedByClass: "client", bet: true });
    return await dispatch.decideOpportunity(
      id as OpportunityId,
      GO,
      { output: "go", reason: "agent_bet", intent: intent as never },
      new Date(),
    );
  } finally {
    await dispatch.close();
  }
}

const decisionsOf = (w: WorkWorld, id: string) =>
  w.admin<{ decision: string; decided_by: string; reason: string }>(
    "select decision, decided_by, reason from ledger.opportunity_decisions where opportunity_id = $1 order by id",
    [id],
  );
const cardsOn = (w: WorkWorld, id: string) =>
  w.admin("select id from ledger.cards where target_kind = 'opportunity' and target_id = $1", [id]);
const ownersAnswers = async (w: WorkWorld): Promise<number> =>
  (await w.admin<{ n: number }>("select count(*)::int as n from knowledge.owner_decisions"))[0]?.n ?? -1;
const betsOf = (w: WorkWorld, client: WorkClient, offsetMs = 0) =>
  w.admin<{ open: number; used: number; unused: number; placed: number }>(
    "select b.open, b.used, b.unused, b.placed from ledger.bets_within($1, $2, $3) b",
    [new Date(Date.now() + offsetMs).toISOString(), LABELS, client.id],
  );

// One statement as pi_owner, past the table's forced row security and its triggers.
const owned = (w: WorkWorld, text: string, values: unknown[]): Promise<unknown> =>
  ownerStatement(w.db.urls.bootstrap, text, values);

// An answer on a card of its own, decided now under `own`, its decision on the card's target. With
// `relay`, the answer is another agent's relay of the owner's word, applied as that decision.
async function answered(
  w: WorkWorld,
  target: { kind: string; id: string },
  answer: "confirm" | "reject",
  relay?: { client: WorkClient; opportunity: string },
): Promise<void> {
  const card = testId("crd");
  await session(w.db.urls.work, (query) =>
    query(
      "insert into ledger.cards (id, request_id, created_at, created_by, kind, target_kind, target_id, options, compartments) values ($1, $1, now(), 'system:extract', 'about_you', $2, $3, '{confirm,reject}', $4)",
      [card, target.kind, target.id, ["own"]],
    ),
  );
  const ruling = testId("rul");
  await w.admin(
    "insert into knowledge.owner_decisions (id, request_id, kind, answer, card_id, target_kind, target_id, queue_depth, labels, details, decided_at, compartments) values ($1, $2, 'answer', $3, $4, $5, $6, 0, '{}', '{}', now(), $7)",
    [ruling, testId("req"), answer, card, target.kind, target.id, ["own"]],
  );
  if (relay !== undefined)
    await owned(
      w,
      `insert into ledger.card_relays (id, request_id, card_id, opportunity_id, client_id, client_name, option, ruling_id, applied_at, created_at, compartments)
       values ($1, $2, $3, $4, $5, $6, $7, $8, now(), now(), $9)`,
      [testId("crl"), request(), card, relay.opportunity, relay.client.id, relay.client.name, answer, ruling, ["own"]],
    );
}

// A claim from the evidence of the finding a move cites: what a confirm of the work's own finding is on.
async function claimOfMove(w: WorkWorld, move: string): Promise<{ kind: string; id: string }> {
  const [cited] = await w.admin<{ evidence_id: string }>(
    `select a.evidence_id from ledger.basis b join ledger.agent_writes a on a.id = b.ref_id
     where b.row_kind = 'move' and b.row_id = $1 and b.ref_kind = 'agent_record'`,
    [move],
  );
  return { kind: "claim", id: await w.seed.claim(["own"], cited?.evidence_id ?? "") };
}

// Claimed, an investigate move cleared and reported done; the move's id.
async function finish(w: WorkWorld, client: WorkClient, id: string): Promise<string> {
  ok(await w.work.claimOpportunity(client.token, { id: id as never, requestId: request() }));
  const { move } = ok(
    await w.work.planMove(client.token, { opportunity: id as never, stage: "investigate", requestId: request() }),
  );
  const record = ok(
    await w.reader.record(client.token, { kind: "finding", body: "two founders run it", requestId: request() }),
  ).recordId;
  // A finding resting on a message, as one citing what it read does: a move's basis takes only such
  // a record (ledger.add_basis).
  const source = await w.message(["own"]);
  await owned(w, "update ledger.agent_writes set evidence_id = $2 where id = $1", [record, source.evidence]);
  ok(
    await w.work.reportMove(client.token, {
      move,
      outcome: "done",
      summary: "two founders run the clinic",
      basis: [{ kind: "agent_record", id: record as never }],
      report: { deliverable: "two names", next: "nothing", sources: [{ kind: "agent_record", id: record as never }] },
      requestId: request(),
    }),
  );
  return move;
}

describe("a bet approves read-only work", { timeout: DB_TEST_TIMEOUT }, () => {
  it("an agent with a bet approves its own internal-only work: it starts with no owner card, and the go is the agent's, never the owner's", () =>
    withWorkWorld(async (w) => {
      const { scout, intent } = await scoutOf(w);
      const answersBefore = await ownersAnswers(w);
      const first = request();
      const made = ok(await propose(w, scout, { bet: true, requestId: first }));
      expect(made).toMatchObject({ bet: true });
      // A retry of the request answers what the first call answered, and places no second bet.
      expect(ok(await propose(w, scout, { bet: true, requestId: first }))).toEqual(made);
      const id = made.opportunity;
      expect(await decided(w, id, intent)).toBe(true);
      expect(await decisionsOf(w, id)).toEqual([{ decision: "go", decided_by: "agent", reason: "agent_bet" }]);
      expect(await w.latest("opportunity", id)).toBe("go");
      // Not to be decided again, so no card is raised for it.
      const dispatch = createDispatch({ url: w.db.urls.work, log: w.log, journal: "" });
      try {
        expect(await dispatch.opportunityToDecide(id as OpportunityId, new Date())).toBeNull();
      } finally {
        await dispatch.close();
      }
      await finish(w, scout, id);
      expect(await w.latest("opportunity", id)).toBe("done");
      expect(await cardsOn(w, id)).toEqual([]);
      // Nothing here is an answer of the owner's: no owner decision, and the decision row is the agent's.
      expect(await ownersAnswers(w)).toBe(answersBefore);
      expect((await decisionsOf(w, id)).some((one) => one.decided_by === "owner")).toBe(false);
      expect(await betsOf(w, scout)).toEqual([{ open: 1, used: 0, unused: 0, placed: 1 }]);
    }, LABELS));

  it("an agent with no bet left is refused bet_budget_spent, and the call writes nothing", () =>
    withWorkWorld(async (w) => {
      const { scout } = await scoutOf(w);
      const first = request();
      const made = ok(await propose(w, scout, { bet: true, requestId: first }));
      for (let n = 0; n < 2; n += 1) expect(ok(await propose(w, scout, { bet: true }))).toMatchObject({ bet: true });
      // With the budget spent, a retry of a request that placed a bet still answers as it did.
      expect(ok(await propose(w, scout, { bet: true, requestId: first }))).toEqual(made);
      expect(made).toMatchObject({ bet: true });
      const requestId = request();
      expect(await propose(w, scout, { bet: true, requestId })).toEqual({
        ok: false,
        code: "invalid_request",
        refusal: "bet_budget_spent",
      });
      expect(await w.admin("select id from ledger.opportunities where request_id = $1", [requestId])).toEqual([]);
      // Without bet the same work is proposed, for the owner to decide.
      const plain = ok(await propose(w, scout));
      expect(plain).not.toHaveProperty("bet");
      expect(await w.admin("select bet_at from ledger.opportunities where id = $1", [plain.opportunity])).toEqual([
        { bet_at: null },
      ]);
    }, LABELS));

  it("work with an outside stage is never approved by a bet: refused bet_needs_owner, place_bet answers needs_owner, and no draft is cleared even under an agent's go", () =>
    withWorkWorld(async (w) => {
      const { scout, intent } = await scoutOf(w);
      const requestId = request();
      expect(await propose(w, scout, { kind: "follow_up", bet: true, requestId })).toEqual({
        ok: false,
        code: "invalid_request",
        refusal: "bet_needs_owner",
      });
      expect(await w.admin("select id from ledger.opportunities where request_id = $1", [requestId])).toEqual([]);
      // The database refuses it too, whatever code above it does.
      const id = ok(await propose(w, scout, { kind: "follow_up" })).opportunity;
      // In the session that proposed it, as the tool calls it.
      const [proposed] = await w.admin<{ session_id: string }>(
        "select session_id from ledger.opportunities where id = $1",
        [id],
      );
      const placed = await readAs(w.db, scout.token, (query) =>
        query<{ placed: string }>("select ledger.place_bet($1, $2) as placed", [proposed?.session_id, id]),
      );
      expect(placed).toEqual([{ placed: "needs_owner" }]);
      expect(await w.admin("select bet_at from ledger.opportunities where id = $1", [id])).toEqual([{ bet_at: null }]);
      // Even an agent's go written by hand clears no draft: plan_move clears internal stages alone,
      // and the outbound gate asks the owner's go of every draft and send.
      await w.admin(
        `insert into ledger.opportunity_decisions (request_id, created_by, compartments, opportunity_id, decision, decided_by, rung, reason, intent_id)
         select $1, 'system:work', o.compartments, o.id, 'go', 'agent', 0, 'agent_bet', $3 from ledger.opportunities o where o.id = $2`,
        [request(), id, intent],
      );
      await w.status("opportunity", id, "go");
      ok(await w.work.claimOpportunity(scout.token, { id: id as never, requestId: request() }));
      const drafted = await w.work.planMove(scout.token, {
        opportunity: id as never,
        stage: "draft",
        requestId: request(),
      });
      expect(drafted.ok).toBe(false);
      const go = await w.admin<{ owner_go: boolean }>(
        `select coalesce((select d.decision = 'go' and d.decided_by = 'owner' from ledger.opportunity_decisions d
                          where d.opportunity_id = $1 order by d.id desc limit 1), false) as owner_go`,
        [id],
      );
      expect(go).toEqual([{ owner_go: false }]);
    }, LABELS));

  it("a basis ref flagged after the agent's go stops the work: plan_move clears no move, as for a task", () =>
    withWorkWorld(async (w) => {
      const { scout, intent } = await scoutOf(w);
      const id = ok(await propose(w, scout, { bet: true })).opportunity;
      expect(await decided(w, id, intent)).toBe(true);
      ok(await w.work.claimOpportunity(scout.token, { id: id as never, requestId: request() }));
      // The message the work rests on is withheld after the go.
      await w.admin(
        `update vault.pipeline_items set withheld = true where evidence_id in (
           select m.evidence_id from ledger.basis b join knowledge.messages m on m.id = b.ref_id
           where b.row_kind = 'opportunity' and b.row_id = $1 and b.ref_kind = 'message')`,
        [id],
      );
      const planned = await w.work.planMove(scout.token, {
        opportunity: id as never,
        stage: "investigate",
        requestId: request(),
      });
      expect(planned.ok).toBe(false);
      expect(await w.admin("select id from ledger.moves where opportunity_id = $1", [id])).toEqual([]);
    }, LABELS));

  it("the owner's later no outranks the agent's go: the work stops and the bet ends lost", () =>
    withWorkWorld(async (w) => {
      const { scout, intent } = await scoutOf(w);
      const id = ok(await propose(w, scout, { bet: true })).opportunity;
      expect(await decided(w, id, intent)).toBe(true);
      const admin = createAdmin({ url: w.db.urls.admin, keys: w.db.keys, log: w.log });
      try {
        expect(await admin.work.cancelTask(id as OpportunityId)).toBe(true);
      } finally {
        await admin.close();
      }
      expect(await w.latest("opportunity", id)).toBe("no_go");
      expect((await decisionsOf(w, id)).map((one) => one.decided_by)).toEqual(["agent", "owner"]);
      const claimed = await w.work.claimOpportunity(scout.token, { id: id as never, requestId: request() });
      expect(claimed.ok).toBe(false);
      expect(await betsOf(w, scout)).toEqual([{ open: 0, used: 0, unused: 1, placed: 1 }]);
    }, LABELS));

  it("a bet ends won when the owner keeps the work's result, shown in their Results feed with no card", () =>
    withWorkWorld(async (w) => {
      const { scout, intent } = await scoutOf(w);
      const id = ok(await propose(w, scout, { bet: true })).opportunity;
      expect(await decided(w, id, intent)).toBe(true);
      const move = await finish(w, scout, id);
      const dispatch = createDispatch({ url: w.db.urls.work, log: w.log, journal: "" });
      try {
        expect(await dispatch.reportsWithoutCard()).not.toContain(move);
      } finally {
        await dispatch.close();
      }
      const admin = createAdmin({ url: w.db.urls.admin, keys: w.db.keys, log: w.log });
      try {
        expect((await admin.cards.results()).results.map((one) => one.move)).toContain(move);
        await admin.cards.judgeResult({ move: move as never, answer: "keep", requestId: request() });
      } finally {
        await admin.close();
      }
      // The keep is read a moment after it was written, inside the bet's week.
      expect(await betsOf(w, scout, 1000)).toEqual([{ open: 0, used: 1, unused: 0, placed: 1 }]);
      const [measure] = await w.admin<{ n: number }>(
        "select count(*)::int as n from ledger.opportunity_decisions where decided_by = 'agent' and decision = 'go'",
      );
      expect(measure?.n).toBe(1);
    }, LABELS));

  it("a confirm another agent relayed as the owner's settles no bet; the owner's own confirm settles it used", () =>
    withWorkWorld(async (w) => {
      const { scout, intent } = await scoutOf(w);
      const id = ok(await propose(w, scout, { bet: true })).opportunity;
      expect(await decided(w, id, intent)).toBe(true);
      const move = await finish(w, scout, id);
      const wren = await w.client("wren", ["own"], { tools: TOOLS });
      // A confirm of a claim from the bet's own evidence, relayed by another agent: no settling.
      await answered(w, await claimOfMove(w, move), "confirm", { client: wren, opportunity: id });
      expect(await betsOf(w, scout, 1000)).toEqual([{ open: 1, used: 0, unused: 0, placed: 1 }]);
      // The owner's own confirm.
      await answered(w, await claimOfMove(w, move), "confirm");
      expect(await betsOf(w, scout, 1000)).toEqual([{ open: 0, used: 1, unused: 0, placed: 1 }]);
    }, LABELS));

  it("task_value: a relayed answer neither confirms a task's finding nor acts on what it is about; the owner's own does both", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const { scout } = await scoutOf(w);
      const wren = await w.client("wren", ["own"], { tools: TOOLS });
      const { person, message } = await workSubject(w);
      const id = ok(
        await w.work.proposeTask(scout.token, {
          kind: "investigate",
          about: { kind: "entity", id: person as never },
          summary: "find who runs the harbour clinic",
          basis: [{ kind: "message", id: message as never }],
          requestId: request(),
          bet: true,
        }),
      ).opportunity;
      const move = await finish(w, scout, id);
      const value = async () =>
        (
          await w.admin<{ confirmed: boolean; acted: boolean; used: boolean }>(
            `select v.confirmed, v.acted, v.used
             from ledger.task_value(now() - interval '1 day', now() + interval '1 hour', $1) v where v.opportunity_id = $2`,
            [LABELS, id],
          )
        )[0];
      expect(await value()).toEqual({ confirmed: false, acted: false, used: false });
      const relay = { client: wren, opportunity: id };
      // Relayed: a confirm of the task's own finding, and an answer on the person it is about.
      await answered(w, await claimOfMove(w, move), "confirm", relay);
      await answered(w, { kind: "entity", id: person }, "confirm", relay);
      expect(await value()).toEqual({ confirmed: false, acted: false, used: false });
      // The owner's own answer on the person: acted on, so used.
      await answered(w, { kind: "entity", id: person }, "confirm");
      expect(await value()).toEqual({ confirmed: false, acted: true, used: true });
      // The owner's own confirm of its finding.
      await answered(w, await claimOfMove(w, move), "confirm");
      expect(await value()).toEqual({ confirmed: true, acted: true, used: true });
    }, LABELS));
});
