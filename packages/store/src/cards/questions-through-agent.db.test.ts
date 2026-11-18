import {
  AGENT_ATTEMPT_GRACE_MINUTES,
  CARD_RELAY_GRACE_MINUTES,
  CARD_RELAY_HOURS,
  CARD_RELAY_UNCLAIMED_HOURS,
  type CardId,
  type OpportunityId,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { setQuestionRole } from "../admin/admin-tasks.ts";
import { ownerActions } from "../admin/outcomes/admin-outcomes-goal.ts";
import { ownerQuestions } from "../admin/outcomes/admin-outcomes-questions.ts";
import { openUnder, sealUnder } from "../core/seal.ts";
import {
  aged,
  asWork,
  cardFlag,
  cardGaps,
  type OwnerWorld,
  raiseCardFlag,
  waitingCard,
  withOwnerWorld,
} from "../test-support/card-task-world.ts";
import { ALL_TOOLS, request, testId } from "../test-support/clients.ts";
import { asOwner } from "../test-support/pipeline-fixtures.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { AGENT_WORK_TOOLS, type WorkClient } from "../test-support/work-clients.ts";
import { workAgent } from "../test-support/work-test-tasks.ts";
import { ok, type WorkWorld } from "../test-support/work-test-world.ts";
import { closeGapFlag } from "../work/dispatch-gaps.ts";

// With no question role nothing is routed and nothing is relayed. Made-up values on reserved
// domains only.

const OWN = ["own"];
const SIDE = ["agent:chief", "own"];
const KEYS = ["own", "agent:chief", "agent:far"];
const ROLE = "chief-of-staff";

type World = OwnerWorld & { chief: WorkClient; far: WorkClient };

async function agent(w: WorkWorld, name: string, compartments: string[], role: string): Promise<WorkClient> {
  const client = await workAgent(w, name, compartments, {
    tools: [...ALL_TOOLS, ...AGENT_WORK_TOOLS, "record", "relay_card_answer"],
    kinds: ["research"],
  });
  await w.admin("update policy.clients set roles = array[$2] where name = $1", [name, role]);
  return client;
}

// `role`: whether the owner has named the question role. Off is how it ships.
const inWorld = (fn: (w: World) => Promise<void>, role = true): Promise<void> =>
  withOwnerWorld(KEYS, "questions-through-agent", async (base) => {
    const chief = await agent(base, "chief", ["own", "agent:chief"], ROLE);
    // Holds the role and the tool, and is cleared for nothing a card here is under.
    const far = await agent(base, "far", ["agent:far"], ROLE);
    if (role) await setQuestionRole(base.admin, ROLE, new Date());
    await fn({ ...base, chief, far });
  });

// A waiting card as the tick writes one. `days`: its expiry.
const card = (
  w: WorkWorld,
  kind: string,
  options: string[],
  label: string[] = OWN,
  days = 30,
  target: { kind: string; id: string } | null = null,
): Promise<CardId> => waitingCard(w, kind, options, { label, days, target });
const gaps = (w: WorkWorld, at = new Date()) => cardGaps(w, "card_relay_gaps", CARD_RELAY_HOURS, at);
const raised = (w: WorkWorld, id: CardId) => raiseCardFlag(w, "card_relay", id);
// The card's task, raised as the tick raises it.
const flagOf = (w: WorkWorld, id: CardId): Promise<OpportunityId> => cardFlag(w, "card_relay", id);

// A question asked through an agent: a read-only task waiting on the owner's decision, and the
// decision's card, the one kind a relay answers. `about`: the person the task is about.
async function question(w: WorkWorld, label: string[] = OWN, days = 30): Promise<CardId> {
  const task = (await w.seed.into("ledger.opportunities")(label)) as string;
  await asOwner(w.db, "update ledger.opportunities set tier = 'task', kind = 'investigate' where id = $1", [task]);
  await w.status("opportunity", task, "proposed", "system:work");
  return card(w, "opportunity_decision", ["go", "no_go"], label, days, { kind: "opportunity", id: task });
}
const taskOf = async (w: WorkWorld, id: CardId): Promise<string> =>
  (await w.admin<{ target_id: string }>("select target_id from ledger.cards where id = $1", [id]))[0]?.target_id ?? "";

const cardEvents = (w: WorkWorld, id: string) =>
  w.admin<{ event: string; by: string }>(
    "select event, by from ledger.record_events where row_kind = 'card' and row_id = $1 order by id",
    [id],
  );
const taskEvents = (w: WorkWorld, id: string) =>
  w.admin<{ event: string; by: string; code: string | null }>(
    "select event, by, code from ledger.record_events where row_kind = 'opportunity' and row_id = $1 order by id",
    [id],
  );
const queue = async (w: World): Promise<string[]> =>
  (await w.owner.cards.listPending({ limit: 50 })).map((one) => one.id);

const window = (): [string, string] => [
  new Date(Date.now() - 86_400_000).toISOString(),
  new Date(Date.now() + 60_000).toISOString(),
];
async function measures(w: World) {
  const [since, until] = window();
  const metrics = await ownerQuestions(w.admin, since, until, OWN);
  const asked = metrics.find((row) => row.metric === "owner_questions_per_week");
  const over = metrics.find((row) => row.metric === "settled_without_owner_overturned");
  const acts = await ownerActions(w.admin, since, until, OWN);
  return {
    asked: asked?.sample,
    waiting: asked?.parts?.waiting_on_agent,
    relayed: asked?.parts?.relayed,
    relayedActs: acts.parts?.relayed ?? 0,
    answerActs: acts.parts?.card_answers ?? 0,
    relayedApplied: over?.parts?.relayed_applied,
    relayedOverturned: over?.parts?.relayed_overturned,
  };
}
const NONE = { relayedActs: 0, answerActs: 0, relayedApplied: 0, relayedOverturned: 0 };

const QUOTE = "Yes, keep that one.";
const relay = (w: World, client: WorkClient, id: CardId, option: string, requestId = request(), quote = QUOTE) =>
  w.work.relayCardAnswer(client.token, { card: id, option, quote, requestId });

// A card's task raised and claimed by the chief, ready for a relay.
async function asked(w: World, id: CardId): Promise<OpportunityId> {
  const flag = await flagOf(w, id);
  ok(await w.work.claimOpportunity(w.chief.token, { id: flag, requestId: request() }));
  return flag;
}

const relays = (w: WorkWorld, id: CardId) =>
  w.admin<{
    id: string;
    client_name: string;
    option: string;
    ruling_id: string | null;
    failed_code: string | null;
    reopened: boolean;
    compartments: string[];
    quote_enc: unknown;
  }>(
    "select id, client_name, option, ruling_id, failed_code, reopened_at is not null as reopened, compartments, quote_enc from ledger.card_relays where card_id = $1",
    [id],
  );
const decisions = (w: WorkWorld, id: CardId) =>
  w.admin<{ id: string; kind: string; answer: string | null }>(
    "select id, kind, answer from knowledge.owner_decisions where card_id = $1 order by decided_at, id",
    [id],
  );

describe("a card asked through an agent", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("off with no question role: no gap, no task, the card is in the owner's queue at once, and a relay is refused", () =>
    inWorld(async (w) => {
      const id = await question(w);
      expect(await gaps(w)).toEqual([]);
      expect(await raised(w, id)).toEqual([{ id: null }]);
      expect(await queue(w)).toContain(id);
      expect(await measures(w)).toEqual({ asked: 1, waiting: 0, relayed: 0, ...NONE });
      // The agent holds the tool and sees the card, and the owner named no role.
      expect(await relay(w, w.chief, id, "go")).toMatchObject({ ok: false, refusal: "not_question_role" });
      expect(await relays(w, id)).toEqual([]);
      expect(await w.owner.cards.applyRelays()).toEqual({ applied: 0, failed: 0 });
    }, false));

  it("raises one task for the question role under the card's label, and holds the card out of the owner's queue", () =>
    inWorld(async (w) => {
      const id = await question(w, SIDE);
      // Its own words, sealed under its label as a card's body is.
      await asOwner(w.db, "update ledger.cards set body_enc = $2::jsonb, body_from = 'agent' where id = $1", [
        id,
        JSON.stringify(
          sealUnder(w.db.keys, SIDE, { table: "ledger.cards", id, column: "body_enc" }, "A made-up lesson."),
        ),
      ]);
      expect(await gaps(w)).toEqual([{ subject: id, label: SIDE, about_kind: "owner", source_kind: "card" }]);
      // New, with the role named: it waits for its task.
      expect(await queue(w)).not.toContain(id);
      const flag = await flagOf(w, id);
      const [task] = await w.admin<{ compartments: string[]; tier: string; role: string; gap_source: string }>(
        "select compartments, tier, role, gap_source from ledger.opportunities where id = $1",
        [flag],
      );
      expect(task).toEqual({ compartments: SIDE, tier: "task", role: ROLE, gap_source: id });
      // One task for a card: a second raise answers the open one.
      expect(await flagOf(w, id)).toBe(flag);
      expect(await queue(w)).not.toContain(id);
      const claimed = ok(await w.work.claimOpportunity(w.chief.token, { id: flag, requestId: request() }));
      expect((claimed as { brief?: { relay?: unknown } }).brief?.relay).toEqual({
        id,
        kind: "opportunity_decision",
        options: ["go", "no_go"],
        target: { kind: "opportunity", id: await taskOf(w, id) },
        refs: [],
        words: { untrusted: "A made-up lesson." },
        attempt: null,
      });
    }));

  it("a client outside the card's label sees no task: its board is byte-identical, and its relay reads as no card (invariant 6)", () =>
    inWorld(async (w) => {
      const board = async () =>
        JSON.stringify(ok(await w.work.listOpportunities(w.far.token, { scope: "board", tier: "task" })));
      const before = await board();
      const id = await question(w);
      const flag = await flagOf(w, id);
      expect(await board()).toBe(before);
      expect(await w.work.claimOpportunity(w.far.token, { id: flag, requestId: request() })).toMatchObject({
        ok: false,
      });
      // The same answer as for a card that is not there.
      const absent = await relay(w, w.far, testId("crd") as CardId, "go");
      expect(await relay(w, w.far, id, "go")).toEqual(absent);
      expect(absent).toMatchObject({ ok: false, code: "not_found" });
      ok(await w.work.claimOpportunity(w.chief.token, { id: flag, requestId: request() }));
      ok(await relay(w, w.chief, id, "go"));
      expect(await board()).toBe(before);
      // A card under a label no agent of the role is cleared for raises no task and is not held past the grace.
      const theirs = await question(w, ["agent:far", "own"]);
      expect((await gaps(w)).map((gap) => gap.subject)).not.toContain(theirs);
    }));

  it("a relayed answer is taken with the owner's words kept sealed, ends the task, and is applied as the owner's", () =>
    inWorld(async (w) => {
      const id = await question(w);
      const flag = await flagOf(w, id);
      // Not the holder of the task yet: no relay.
      expect(await relay(w, w.chief, id, "go")).toMatchObject({ ok: false, refusal: "work_not_held" });
      ok(await w.work.claimOpportunity(w.chief.token, { id: flag, requestId: request() }));
      expect(await queue(w)).not.toContain(id);
      expect(await measures(w)).toEqual({ asked: 0, waiting: 1, relayed: 0, ...NONE });
      const requestId = request();
      expect(ok(await relay(w, w.chief, id, "go", requestId))).toEqual({ card: id, applied: false });
      // A repeat of the request answers as the first did, and writes nothing more.
      expect(ok(await relay(w, w.chief, id, "go", requestId))).toEqual({ card: id, applied: false });
      const [taken] = await relays(w, id);
      expect(taken).toMatchObject({
        client_name: "chief",
        option: "go",
        ruling_id: null,
        failed_code: null,
        reopened: false,
        compartments: OWN,
      });
      // The quote is kept, sealed under the card's label and bound to its row.
      expect(
        openUnder(
          w.db.keys,
          OWN,
          { table: "ledger.card_relays", id: taken?.id ?? "", column: "quote_enc" },
          taken?.quote_enc as never,
        ),
      ).toBe(QUOTE);
      // Taken, not applied yet: nothing on the card but the event it was raised with.
      expect(await cardEvents(w, id)).toEqual([{ event: "pending", by: "system:work" }]);
      expect(await decisions(w, id)).toEqual([]);
      expect((await taskEvents(w, flag)).at(-1)).toEqual({
        event: "withdrawn",
        by: "system:gaps",
        code: "relayed",
      });
      expect(
        await w.admin("select 1 as held from queue.leases where resource_kind = 'opportunity' and resource_id = $1", [
          flag,
        ]),
      ).toEqual([]);
      // Until the owner's process applies it the card waits on the owner's page, the relay beside it.
      expect(await queue(w)).toContain(id);
      const shown = await w.owner.cards.card(id);
      expect(shown?.lines.filter((line) => line.key === "relayed_answer")).toHaveLength(1);
      expect(await gaps(w)).toEqual([]);
      expect(await raised(w, id)).toEqual([{ id: null }]);

      // The owner's process applies it through the page's answer path: one decision of the owner's,
      // the card decided by the owner, and the relay linked to its decision.
      expect(await w.owner.cards.applyRelays()).toEqual({ applied: 1, failed: 0 });
      expect(await w.owner.cards.applyRelays()).toEqual({ applied: 0, failed: 0 });
      const made = await decisions(w, id);
      expect(made).toMatchObject([{ kind: "answer", answer: "go" }]);
      expect((await relays(w, id))[0]).toMatchObject({ ruling_id: made[0]?.id, failed_code: null });
      expect((await cardEvents(w, id)).at(-1)).toEqual({ event: "decided", by: "owner" });
      expect(await queue(w)).not.toContain(id);
      // The retry of the agent's request now says so.
      expect(ok(await relay(w, w.chief, id, "go", requestId))).toEqual({ card: id, applied: true });
      // It reached the owner, in conversation: asked, under its own part, and one act of the
      // owner's, not two: the decision the relay made is that act.
      expect(await measures(w)).toEqual({
        asked: 1,
        waiting: 0,
        relayed: 1,
        relayedActs: 1,
        answerActs: 0,
        relayedApplied: 1,
        relayedOverturned: 0,
      });
      // The owner's list names the card, the agent, the option and what became of it; no quote.
      expect(await w.owner.cards.listRelays()).toMatchObject([
        { card: id, kind: "opportunity_decision", agent: "chief", option: "go", state: "applied", ruling: made[0]?.id },
      ]);
      expect((await w.owner.cards.listRelays())[0]).not.toHaveProperty("quote");
      // The week's sample shows the owner's words as quoted.
      expect(await w.owner.cards.listRelays({ sample: true })).toMatchObject([{ card: id, quote: QUOTE }]);
      // Once for a card.
      expect(await relay(w, w.chief, id, "no_go")).toMatchObject({ ok: false, refusal: "already_relayed" });
    }));

  it("each rule refuses by name, and a refused relay writes nothing", () =>
    inWorld(async (w) => {
      const id = await question(w);
      // The card's own words, which a quote may not be.
      const words = "Keep the lesson: send short summaries after every call";
      await asOwner(w.db, "update ledger.cards set body_enc = $2::jsonb, body_from = 'agent' where id = $1", [
        id,
        JSON.stringify(sealUnder(w.db.keys, OWN, { table: "ledger.cards", id, column: "body_enc" }, words)),
      ]);
      await asked(w, id);
      // The quote is what the card says, or holds it whole: not the owner's words.
      for (const quote of [words, `They said: ${words}. Yes.`])
        expect(await relay(w, w.chief, id, "go", request(), quote)).toMatchObject({
          ok: false,
          code: "invalid_request",
          refusal: "not_owner_words",
        });
      // Not one of the card's options.
      expect(await relay(w, w.chief, id, "maybe")).toMatchObject({
        ok: false,
        code: "invalid_request",
        refusal: "not_an_option",
      });
      // Too long, or empty: the arguments' own bound.
      expect(await relay(w, w.chief, id, "go", request(), "y".repeat(2001))).toMatchObject({
        ok: false,
        code: "invalid_request",
      });
      expect(await relay(w, w.chief, id, "go", request(), "  ")).toMatchObject({
        ok: false,
        code: "invalid_request",
      });
      // An agent that holds the tool and sees the card, without the question role.
      await w.admin("update policy.clients set roles = array['research'] where name = 'chief'");
      expect(await relay(w, w.chief, id, "go")).toMatchObject({ ok: false, refusal: "not_question_role" });
      await w.admin("update policy.clients set roles = array[$1] where name = 'chief'", [ROLE]);
      // A card the relaying agent raised itself: never through the owner's mouth.
      const own = await question(w);
      await asked(w, own);
      await asOwner(w.db, "update ledger.cards set created_by = 'client:' || $2 where id = $1", [own, w.chief.id]);
      expect(await relay(w, w.chief, own, "go")).toMatchObject({ ok: false, refusal: "own_card" });
      // A card of a kind that is never asked through an agent, though the agent sees it.
      const fact = await card(w, "goal_proposal", ["accept", "reject"]);
      expect(await relay(w, w.chief, fact, "accept")).toMatchObject({ ok: false, refusal: "card_not_routed" });
      for (const one of [id, own, fact]) expect(await relays(w, one)).toEqual([]);
      expect(await decisions(w, id)).toEqual([]);
    }));

  it("the owner's own answer on the page before the relay is applied stands, and the relay is marked not applied", () =>
    inWorld(async (w) => {
      const id = await question(w);
      await asked(w, id);
      ok(await relay(w, w.chief, id, "go"));
      // The owner answers on the page first, the other way.
      await w.owner.cards.decide({ cards: [id], answer: "no_go", requestId: request() });
      expect(await w.owner.cards.applyRelays()).toEqual({ applied: 0, failed: 1 });
      expect((await relays(w, id))[0]).toMatchObject({ ruling_id: null, failed_code: "not_pending" });
      expect(await decisions(w, id)).toMatchObject([{ kind: "answer", answer: "no_go" }]);
      // Never tried again.
      expect(await w.owner.cards.applyRelays()).toEqual({ applied: 0, failed: 0 });
      expect(await w.owner.cards.listRelays()).toMatchObject([{ card: id, state: "failed", code: "not_pending" }]);
    }));

  it("a repeat of a relay's request answers as the first did only to a caller still cleared for the card's label", () =>
    inWorld(async (w) => {
      const id = await question(w);
      await asked(w, id);
      const requestId = request();
      const first = await relay(w, w.chief, id, "go", requestId);
      ok(first);
      expect(await relay(w, w.chief, id, "go", requestId)).toEqual(first);
      // The caller's clearance narrows: the relay is on a card it can no longer see.
      await w.admin("update policy.clients set compartments = '{agent:far}' where id = $1", [w.chief.id]);
      expect(await relay(w, w.chief, id, "go", requestId)).toMatchObject({ ok: false, code: "not_found" });
    }));

  it("a card the owner deferred after the relay was taken is not answered by it: the relay is marked owner_answered and the card waits", () =>
    inWorld(async (w) => {
      const id = await question(w);
      await asked(w, id);
      ok(await relay(w, w.chief, id, "go"));
      // The owner's own act on the card, after the relay and before it is applied.
      await w.admin(
        "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) select 'card', c.id, 'deferred', now(), 'owner', c.compartments from ledger.cards c where c.id = $1",
        [id],
      );
      expect(await w.owner.cards.applyRelays()).toEqual({ applied: 0, failed: 1 });
      expect((await relays(w, id))[0]).toMatchObject({ ruling_id: null, failed_code: "owner_answered" });
      // Nothing of the refused answer is left: no decision, and the card still waits for the owner.
      expect(await decisions(w, id)).toEqual([]);
      expect(
        await w.admin(
          "select event, by from ledger.record_events where row_kind = 'card' and row_id = $1 order by id desc limit 1",
          [id],
        ),
      ).toEqual([{ event: "deferred", by: "owner" }]);
      expect(await w.owner.cards.applyRelays()).toEqual({ applied: 0, failed: 0 });
      // The owner's own answer, after.
      await w.owner.cards.decide({ cards: [id], answer: "no_go", requestId: request() });
      expect(await decisions(w, id)).toMatchObject([{ kind: "answer", answer: "no_go" }]);
    }));

  it("an erasure that taints the card takes the relayed quote with it, and a relay left unapplied an hour is counted", () =>
    inWorld(async (w) => {
      const id = await question(w);
      const about = await taskOf(w, id);
      await asked(w, id);
      ok(await relay(w, w.chief, id, "go"));
      expect((await relays(w, id))[0]?.quote_enc).not.toBeNull();
      // Taken and not applied: nothing within the hour, one after it (`pi web` is down or stuck).
      const unapplied = async (until: Date) =>
        (await ownerQuestions(w.admin, window()[0], until.toISOString(), OWN)).find(
          (row) => row.metric === "owner_questions_per_week",
        )?.parts?.relayed_unapplied;
      expect(await unapplied(new Date())).toBe(0);
      expect(await unapplied(new Date(Date.now() + 2 * 3_600_000))).toBe(1);
      // The deletion's own function, for the work the card decides: the card's body and the
      // owner's words go in one statement, and the relay is listed nowhere.
      await w.admin("select ledger.taint_citing('{}', array['opportunity'], array[$1])", [about]);
      expect(await w.admin("select tainted_at is not null as tainted from ledger.cards where id = $1", [id])).toEqual([
        { tainted: true },
      ]);
      expect(await relays(w, id)).toMatchObject([{ quote_enc: null }]);
      expect(await w.owner.cards.listRelays()).toEqual([]);
    }));

  it("the owner reopens a relayed answer: the card waits again, the relayed decision is superseded, and the owner's own answer stands", () =>
    inWorld(async (w) => {
      const id = await question(w);
      await asked(w, id);
      ok(await relay(w, w.chief, id, "go"));
      expect(await w.owner.cards.applyRelays()).toEqual({ applied: 1, failed: 0 });
      const [first] = await decisions(w, id);
      // Nothing the answer changed is left in place here: no lesson retired, no work taken up.
      expect(await w.owner.cards.reopenExpiredCard(id)).toEqual({ left: [] });
      expect(await queue(w)).toContain(id);
      expect((await relays(w, id))[0]).toMatchObject({ ruling_id: first?.id, reopened: true });
      expect(await w.admin("select kind from knowledge.owner_decisions where supersedes = $1", [first?.id])).toEqual([
        { kind: "relay_lift" },
      ]);
      expect(await w.owner.cards.listRelays()).toMatchObject([{ card: id, state: "reopened" }]);
      expect(await measures(w)).toMatchObject({ relayedApplied: 1, relayedOverturned: 1 });
      // No second relay, and no second task: the card is the owner's.
      expect(await gaps(w)).toEqual([]);
      expect(await relay(w, w.chief, id, "go")).toMatchObject({ ok: false });
      // The owner's own answer, after.
      await w.owner.cards.decide({ cards: [id], answer: "no_go", requestId: request() });
      expect((await decisions(w, id)).at(-1)).toMatchObject({ kind: "answer", answer: "no_go" });
      // A second reopen finds nothing relayed to take back.
      await expect(w.owner.cards.reopenExpiredCard(id)).rejects.toMatchObject({ code: "not_found" });
    }));

  it("the owner's stop refuses a relay and holds the apply pass; the page's list carries each quote, and its undo takes back a relayed answer alone", () =>
    inWorld(async (w) => {
      const id = await question(w);
      await asked(w, id);
      // Stopped: no relay is taken, said by name, and nothing is written.
      await w.killSwitch("on");
      expect(await relay(w, w.chief, id, "go")).toEqual({ ok: false, code: "not_found", refusal: "kill_switch" });
      expect(await relays(w, id)).toEqual([]);
      await w.killSwitch("off");
      ok(await relay(w, w.chief, id, "go"));
      // A relay taken before a stop waits through it, and is applied once work starts again.
      await w.killSwitch("on");
      expect(await w.owner.cards.applyRelays()).toEqual({ applied: 0, failed: 0 });
      expect(await decisions(w, id)).toEqual([]);
      await w.killSwitch("off");
      expect(await w.owner.cards.applyRelays()).toEqual({ applied: 1, failed: 0 });
      // The page's list: every relay with the owner's words as the agent quoted them.
      expect(await w.owner.cards.listRelays({ quotes: true })).toMatchObject([
        { card: id, agent: "chief", option: "go", state: "applied", quote: QUOTE },
      ]);
      // Its undo reopens a card a relay decided, and no other: one never relayed is not found.
      const plain = await question(w);
      await expect(w.owner.cards.reopenRelayed(plain, { requestId: request() })).rejects.toMatchObject({
        code: "not_found",
      });
      const undo = { requestId: request() };
      expect(await w.owner.cards.reopenRelayed(id, undo)).toEqual({ left: [] });
      expect(await queue(w)).toContain(id);
      expect(await w.owner.cards.listRelays({ quotes: true })).toMatchObject([{ card: id, state: "reopened" }]);
      // A repeat of the request answers as the first did and writes nothing; another request finds
      // nothing left to take back.
      const written = await cardEvents(w, id);
      expect(await w.owner.cards.reopenRelayed(id, undo)).toEqual({ left: [] });
      expect(await cardEvents(w, id)).toEqual(written);
      await expect(w.owner.cards.reopenRelayed(id, { requestId: request() })).rejects.toMatchObject({
        code: "not_found",
      });
    }));

  it("a relay taken on a card whose kind is no longer asked through an agent is never applied", () =>
    inWorld(async (w) => {
      // A relay on a card of a kind never asked through an agent, as one taken while its kind was
      // would be left: written as the owner's role, since no call takes one now.
      const fact = await card(w, "goal_proposal", ["accept", "reject"]);
      const task = await asked(w, await question(w));
      await asOwner(
        w.db,
        `insert into ledger.card_relays (id, request_id, card_id, opportunity_id, client_id, client_name, option, created_at, compartments)
           values ($1, $2, $3, $4, $5, 'chief', 'confirm', now(), '{own}')`,
        [testId("crl"), request(), fact, task, w.chief.id],
      );
      expect(await w.owner.cards.applyRelays()).toEqual({ applied: 0, failed: 1 });
      expect(await relays(w, fact)).toMatchObject([{ ruling_id: null, failed_code: "kind_not_relayed" }]);
      expect(await decisions(w, fact)).toEqual([]);
      expect(await queue(w)).toContain(fact);
      // Marked once, and never tried again.
      expect(await w.owner.cards.applyRelays()).toEqual({ applied: 0, failed: 0 });
    }));

  it("the owner's reopen of a relayed go always stops the work, and the owner's own no then takes effect", () =>
    inWorld(async (w) => {
      // A read-only task waiting on the owner's decision, and its card.
      const task = (await w.seed.into("ledger.opportunities")(OWN)) as string;
      await asOwner(w.db, "update ledger.opportunities set tier = 'task', kind = 'investigate' where id = $1", [task]);
      await w.status("opportunity", task, "proposed", "system:work");
      const id = await card(w, "opportunity_decision", ["go", "no_go"], OWN, 30, { kind: "opportunity", id: task });
      await asked(w, id);
      ok(await relay(w, w.chief, id, "go"));
      expect(await w.owner.cards.applyRelays()).toEqual({ applied: 1, failed: 0 });
      expect(["go", "handed_to_owner"]).toContain(await w.latest("opportunity", task));
      // An agent takes the work up: the relayed answer's event is no longer its latest.
      await w.status("opportunity", task, "claimed", "client:chief");
      expect(await w.owner.cards.reopenExpiredCard(id)).toEqual({ left: [] });
      expect(await w.latest("opportunity", task)).toBe("proposed");
      expect(
        await w.admin("select 1 as held from queue.leases where resource_kind = 'opportunity' and resource_id = $1", [
          task,
        ]),
      ).toEqual([]);
      await w.owner.cards.decide({ cards: [id], answer: "no_go", requestId: request() });
      expect(await w.latest("opportunity", task)).toBe("no_go");
    }));

  it("an agent that does not hold the tool is refused, whatever it holds", () =>
    inWorld(async (w) => {
      const id = await question(w);
      const flag = await flagOf(w, id);
      ok(await w.work.claimOpportunity(w.chief.token, { id: flag, requestId: request() }));
      await w.admin("update policy.clients set tools = array_remove(tools, 'relay_card_answer') where name = 'chief'");
      expect(await relay(w, w.chief, id, "go")).toMatchObject({ ok: false, code: "not_permitted" });
      expect(await w.admin("select id from ledger.card_relays where card_id = $1", [id])).toEqual([]);
    }));

  it("the owner answering the card ends its gap and closes the task, and a relay after it is refused", () =>
    inWorld(async (w) => {
      const id = await question(w);
      const flag = await flagOf(w, id);
      await w.admin(
        "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('card', $1, 'decided', now(), 'owner', $2)",
        [id, OWN],
      );
      expect(await gaps(w)).toEqual([]);
      // As the tick closes a flag whose gap no longer holds.
      expect(await asWork(w, (query) => closeGapFlag(query, flag, new Date()))).toBe(true);
      expect((await taskEvents(w, flag)).at(-1)).toMatchObject({ event: "withdrawn", by: "system:gaps" });
      expect(await relay(w, w.chief, id, "go")).toMatchObject({ ok: false, refusal: "owner_answered" });
      expect(await w.admin("select id from ledger.card_relays where card_id = $1", [id])).toEqual([]);
    }));

  it("a card the owner touched is the owner's at once (invariant 11)", () =>
    inWorld(async (w) => {
      const id = await question(w);
      await flagOf(w, id);
      expect(await queue(w)).not.toContain(id);
      await w.admin(
        "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('card', $1, 'pending', now(), 'owner', $2)",
        [id, OWN],
      );
      expect(await queue(w)).toContain(id);
      expect(await gaps(w)).toEqual([]);
    }));

  it("a card is held for the grace with no task, while its task is open, and never past the wait", () =>
    inWorld(async (w) => {
      const none = await question(w);
      await aged(w, none, CARD_RELAY_GRACE_MINUTES + 1);
      expect(await queue(w)).toContain(none);
      const open = await question(w);
      await flagOf(w, open);
      await aged(w, open, CARD_RELAY_GRACE_MINUTES + 1);
      expect(await queue(w)).not.toContain(open);
      // A task nobody has claimed for the hours no longer holds its card; a claimed one does.
      const stale = (id: string) =>
        asOwner(
          w.db,
          "update ledger.opportunities set created_at = now() - make_interval(hours => $2) where gap_trigger = 'card_relay' and gap_subject = $1",
          [id, CARD_RELAY_UNCLAIMED_HOURS],
        );
      await stale(open);
      expect(await queue(w)).toContain(open);
      const taken = await question(w);
      await asked(w, taken);
      await stale(taken);
      expect(await queue(w)).not.toContain(taken);
      await aged(w, open, CARD_RELAY_HOURS * 60 + 1);
      expect(await queue(w)).toContain(open);
      expect((await gaps(w)).map((gap) => gap.subject)).not.toContain(open);
    }));

  it("a card that releases, sends or grants is never routed, nor one that expires sooner than the wait", () =>
    inWorld(async (w) => {
      const never: CardId[] = [];
      for (const [kind, options] of [
        ["draft_waiting", ["acknowledge", "reject"]],
        ["grant_suggestion", ["confirm", "decline"]],
        ["grant_lift_suggestion", ["confirm", "decline"]],
        ["research_request", ["approve", "reject"]],
        // A standing rule, which only the owner's own reads show.
        ["question_rule", ["confirm", "decline"]],
        // Its accept writes an agent's words as the owner's own goal.
        ["goal_proposal", ["accept", "reject"]],
        // An agent is asked it first, and never through one after: its answer is an identity ruling.
        ["shared_address", ["shared", "one_person"]],
      ] as const)
        never.push(await card(w, kind, [...options]));
      // A routed kind that expires in a day: asking through an agent could outlast it.
      never.push(await question(w, OWN, 1));
      // A decision on work that is not a read-only task an agent or the owner proposed.
      never.push(
        await card(w, "opportunity_decision", ["go", "no_go"], OWN, 30, { kind: "opportunity", id: testId("opp") }),
      );
      expect(await gaps(w)).toEqual([]);
      // A kind an agent is asked first waits out that attempt's grace, with no task raised here; then
      // it is the owner's, never routed through an agent.
      for (const id of never) await aged(w, id, AGENT_ATTEMPT_GRACE_MINUTES + 1);
      for (const id of never) {
        expect(await raised(w, id)).toEqual([{ id: null }]);
        expect(await queue(w)).toContain(id);
      }
    }));

  it("a lesson is asked through an agent and its relayed confirm is applied as the owner's; a preference is never relayed by the agent that wrote it", () =>
    inWorld(async (w) => {
      const lesson = await card(w, "lesson", ["confirm", "reject"]);
      expect((await gaps(w)).map((gap) => gap.subject)).toContain(lesson);
      await asked(w, lesson);
      ok(await relay(w, w.chief, lesson, "confirm"));
      expect(await w.owner.cards.applyRelays()).toEqual({ applied: 1, failed: 0 });
      expect(await decisions(w, lesson)).toMatchObject([{ kind: "answer", answer: "confirm" }]);
      // A preference the chief's own record proposed: the chief is the only agent of the role
      // cleared for it, so nobody is asked.
      const record = ok(
        await w.reader.record(w.chief.token, { kind: "finding", body: "A made-up preference.", requestId: request() }),
      ).recordId;
      const preference = await card(w, "client_preference", ["confirm", "reject"], OWN, 30, {
        kind: "agent_record",
        id: record,
      });
      expect((await gaps(w)).map((gap) => gap.subject)).not.toContain(preference);
      // A task raised for it all the same: the author's relay is refused by name.
      await asked(w, preference);
      expect(await relay(w, w.chief, preference, "confirm")).toMatchObject({ ok: false, refusal: "own_card" });
      expect(await relays(w, preference)).toEqual([]);
    }));

  it("a kind an agent is asked first is asked through an agent once that attempt is over, with what the first agent answered", () =>
    inWorld(async (w) => {
      // The attempt goes to the question role's agent too, as card questions do on the box.
      await w.admin("update policy.work_settings set default_task_role = $1", [ROLE]);
      const id = await card(w, "same_fact", ["same", "different", "skip"]);
      const attempt = await cardFlag(w, "card_question", id);
      // While its attempt is open it is not asked through an agent.
      expect((await gaps(w)).map((gap) => gap.subject)).not.toContain(id);
      expect(await raised(w, id)).toEqual([{ id: null }]);
      // The first agent cannot tell.
      ok(await w.work.claimOpportunity(w.chief.token, { id: attempt, requestId: request() }));
      const { move } = ok(
        await w.work.planMove(w.chief.token, { opportunity: attempt, stage: "investigate", requestId: request() }),
      );
      const finding = ok(
        await w.reader.record(w.chief.token, {
          kind: "finding",
          body: "What the cited records show, read whole.",
          requestId: request(),
        }),
      ).recordId;
      ok(
        await w.work.reportMove(w.chief.token, {
          move,
          outcome: "done",
          report: {
            deliverable: "Read what the card names.",
            next: "Nothing more is needed.",
            sources: [{ kind: "agent_record", id: finding }],
            card: { answer: "cant_tell" },
          } as never,
          requestId: request(),
        }),
      );
      // Now it is: one task for the question role, holding the card, its brief carrying the answer.
      expect((await gaps(w)).map((gap) => gap.subject)).toContain(id);
      const flag = await flagOf(w, id);
      expect(await queue(w)).not.toContain(id);
      const claimed = ok(await w.work.claimOpportunity(w.chief.token, { id: flag, requestId: request() }));
      expect((claimed as { brief?: { relay?: { attempt?: unknown } } }).brief?.relay?.attempt).toMatchObject({
        agent: "chief",
        answer: "cant_tell",
      });
      ok(await relay(w, w.chief, id, "skip"));
      expect(await w.owner.cards.applyRelays()).toEqual({ applied: 1, failed: 0 });
      expect(await decisions(w, id)).toMatchObject([{ kind: "answer", answer: "skip" }]);
      expect(await measures(w)).toMatchObject({ relayed: 1 });
    }));

  it("a kind an agent is asked first is asked through an agent when no attempt was raised and its grace passed; a reminder goes to the owner alone", () =>
    inWorld(async (w) => {
      const id = await card(w, "tier_proposal", ["confirm", "reject"]);
      expect((await gaps(w)).map((gap) => gap.subject)).not.toContain(id);
      await aged(w, id, AGENT_ATTEMPT_GRACE_MINUTES + 1);
      expect((await gaps(w)).map((gap) => gap.subject)).toContain(id);
      // Held for the relay's grace from the attempt's end, then by its task.
      expect(await queue(w)).not.toContain(id);
      await flagOf(w, id);
      expect(await queue(w)).not.toContain(id);
      const due = await card(w, "reminder", ["done", "snooze", "dismiss"]);
      await aged(w, due, AGENT_ATTEMPT_GRACE_MINUTES + 1);
      expect((await gaps(w)).map((gap) => gap.subject)).not.toContain(due);
      expect(await raised(w, due)).toEqual([{ id: null }]);
      expect(await queue(w)).toContain(due);
    }));

  it("a relayed confirm of a statement about the owner is read at its own tier: no release, never the owner's own confirmation, lifted by the reopen", () =>
    inWorld(async (w) => {
      const fact = await claimCard(w, "about_you", w.far);
      await asked(w, fact);
      ok(await relay(w, w.chief, fact, "confirm"));
      expect(await w.owner.cards.applyRelays()).toEqual({ applied: 1, failed: 0 });
      expect(await decisions(w, fact)).toMatchObject([{ kind: "answer", answer: "confirm" }]);
      const key = await keyOf(w, fact);
      expect(await claimsBy(w, "confirmed_claims", key)).toEqual([]);
      expect(await claimsBy(w, "relayed_claims", key)).toEqual([key]);
      // Nothing released into the owner's own label.
      expect(
        await w.admin(
          "select 1 from knowledge.claim_releases r join ledger.card_relays y on y.ruling_id = r.ruling_id where y.card_id = $1",
          [fact],
        ),
      ).toEqual([]);
      // The owner's reopen lifts it, and leaves nothing in place.
      expect(await w.owner.cards.reopenExpiredCard(fact)).toEqual({ left: [] });
      expect(await claimsBy(w, "relayed_claims", key)).toEqual([]);
    }));

  it("an agent's claim is asked through an agent after its attempt, and never relayed by the agent whose record it came from", () =>
    inWorld(async (w) => {
      await w.admin("update policy.work_settings set default_task_role = $1", [ROLE]);
      // From another agent's record: past the attempt's grace with no attempt raised, it is routed.
      const theirs = await claimCard(w, "agent_claim", w.far);
      await aged(w, theirs, AGENT_ATTEMPT_GRACE_MINUTES + 1);
      expect((await gaps(w)).map((gap) => gap.subject)).toContain(theirs);
      await asked(w, theirs);
      ok(await relay(w, w.chief, theirs, "reject"));
      expect(await w.owner.cards.applyRelays()).toEqual({ applied: 1, failed: 0 });
      // A relayed reject confirms nothing.
      const key = await keyOf(w, theirs);
      for (const fn of ["confirmed_claims", "relayed_claims"] as const) expect(await claimsBy(w, fn, key)).toEqual([]);
      // From the chief's own record: the only agent of the role cleared for it wrote it.
      const own = await claimCard(w, "agent_claim", w.chief);
      await aged(w, own, AGENT_ATTEMPT_GRACE_MINUTES + 1);
      expect((await gaps(w)).map((gap) => gap.subject)).not.toContain(own);
      await asked(w, own);
      expect(await relay(w, w.chief, own, "confirm")).toMatchObject({ ok: false, refusal: "own_card" });
    }));

  it("the reopen of a relayed answer whose effect stays names it", () =>
    inWorld(async (w) => {
      const id = await card(w, "tier_proposal", ["confirm", "reject"]);
      await aged(w, id, AGENT_ATTEMPT_GRACE_MINUTES + 1);
      await asked(w, id);
      ok(await relay(w, w.chief, id, "reject"));
      expect(await w.owner.cards.applyRelays()).toEqual({ applied: 1, failed: 0 });
      // A tier proposal's reject writes no ruling: nothing is left.
      expect(await w.owner.cards.reopenExpiredCard(id)).toEqual({ left: [] });
      const idea = await card(w, "idea", ["pursue", "not_now", "no"]);
      await asked(w, idea);
      ok(await relay(w, w.chief, idea, "pursue"));
      expect(await w.owner.cards.applyRelays()).toEqual({ applied: 1, failed: 0 });
      expect(await w.owner.cards.reopenExpiredCard(idea)).toEqual({ left: ["effect_kept"] });
    }));
});

describe("a release resting on a relayed confirm", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("is refused by the database itself, and the same release on the owner's own confirm is not", () =>
    inWorld(async (w) => {
      // A statement's record, its card and the owner's confirm with its release, as the owner's
      // confirm writes them.
      await w.seed.into("knowledge.claim_releases")(OWN);
      const [release] = await w.admin<{
        ruling_id: string;
        evidence_id: string;
        card_id: string;
        compartments: string[];
      }>(
        `select r.ruling_id, r.evidence_id, o.card_id, o.compartments from knowledge.claim_releases r
         join knowledge.owner_decisions o on o.id = r.ruling_id order by r.created_at desc, r.ruling_id desc limit 1`,
      );
      const again = (): Promise<string> =>
        asOwner(
          w.db,
          "insert into knowledge.claim_releases (ruling_id, evidence_id, via, created_at, compartments) values ($1, $2, 'card', now(), '{own}')",
          [release?.ruling_id, release?.evidence_id],
        ).then(
          () => "ok",
          (error: { code?: string }) => error.code ?? "error",
        );
      // The decision named by a relay: the check refuses the release, whatever the code above it does.
      const task = await asked(w, await question(w));
      await asOwner(
        w.db,
        `insert into ledger.card_relays (id, request_id, card_id, opportunity_id, client_id, client_name, option, created_at, compartments, ruling_id, applied_at)
           values ($1, $2, $3, $4, $5, 'chief', 'confirm', now(), $6, $7, now())`,
        [testId("crl"), request(), release?.card_id, task, w.chief.id, release?.compartments, release?.ruling_id],
      );
      expect(await again()).toBe("23514");
      // With no relay naming it, the check passes (a second release of the record is refused only as a duplicate, if at all).
      await asOwner(w.db, "delete from ledger.card_relays where card_id = $1", [release?.card_id]);
      expect(await again()).not.toBe("23514");
    }));
});

describe("a relayed answer on the planner's question", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("writes the owner's status marked relayed, which no count reads as a confirm of their own", () =>
    inWorld(async (w) => {
      const hypothesis = await plannerHypothesis(w);
      const id = await card(w, "owner_question", ["confirm", "reject", "skip"], OWN, 30, {
        kind: "hypothesis",
        id: hypothesis,
      });
      await asked(w, id);
      ok(await relay(w, w.chief, id, "confirm"));
      expect(await w.owner.cards.applyRelays()).toEqual({ applied: 1, failed: 0 });
      expect(
        await w.admin<{ event: string; by: string; code: string | null }>(
          "select event, by, code from ledger.record_events where row_kind = 'hypothesis' and row_id = $1 order by id desc limit 1",
          [hypothesis],
        ),
      ).toEqual([{ event: "confirmed", by: "owner", code: "relayed" }]);
    }));
});

// A planner's hypothesis about the owner, open, as a run's finish writes one, as pi_owner.
async function plannerHypothesis(w: WorkWorld): Promise<string> {
  const id = testId("hyp");
  const caseId = `cas_${id.slice(4)}`;
  const run = `run:${testId("run")}`;
  await asOwner(
    w.db,
    `insert into ledger.cases (id, request_id, created_by, compartments, row_kind, kind, about_kind, about_id, author)
     values ($1, $1, $2, $3, 'hypothesis', 'preference', 'owner', null, 'run')`,
    [caseId, run, OWN],
  );
  await asOwner(
    w.db,
    `insert into ledger.hypotheses (id, request_id, created_by, compartments, case_id, kind, about_kind, about_id, about_owner)
     values ($1, $1, $2, $3, $4, 'preference', 'owner', null, true)`,
    [id, run, OWN, caseId],
  );
  await asOwner(
    w.db,
    "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('hypothesis', $1, 'open', now(), $2, $3)",
    [id, run, OWN],
  );
  return id;
}

// A claim's card as the pipeline raises one, by `system:extract`: its target a claim whose evidence
// is the record this agent wrote, under the owner's own label.
async function claimCard(w: World, kind: "about_you" | "agent_claim", author: WorkClient): Promise<CardId> {
  const record = ok(
    await w.reader.record(author.token, { kind: "finding", body: "A made-up statement.", requestId: request() }),
  ).recordId;
  const evidence = await w.seed.evidence(OWN, await w.seed.sourceAccount(OWN));
  await w.admin("update ledger.agent_writes set evidence_id = $2 where id = $1", [record, evidence]);
  const claim = await w.seed.claim(OWN, evidence);
  return waitingCard(w, kind, ["confirm", "reject"], {
    label: OWN,
    author: "system:extract",
    target: { kind: "claim", id: claim },
  });
}
const keyOf = async (w: WorkWorld, id: CardId): Promise<string> =>
  (await w.admin<{ request_id: string }>("select request_id from ledger.cards where id = $1", [id]))[0]?.request_id ??
  "";
const claimsBy = async (w: WorkWorld, fn: "confirmed_claims" | "relayed_claims", key: string): Promise<string[]> =>
  (await w.admin<{ k: string }>(`select k from policy.${fn}($1) as k`, [[key]])).map((row) => row.k);
