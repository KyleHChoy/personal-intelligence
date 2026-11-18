import type { AutonomyRules, CardId, OpportunityId, OpportunityView } from "@intelligence/contracts/personal";
import { autonomyRules, planGapFlags } from "@intelligence/personal-core/planner";
import { describe, expect, it } from "vitest";
import { setTaskTier } from "../admin/admin-tasks.ts";
import { reopenExpiredCard } from "../admin/cards/admin-reopen.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { READING_AGENT_TOOLS, type WorkClient } from "../test-support/work-clients.ts";
import { withWorkWorld as withCardWorld } from "../test-support/work-fixtures.ts";
import { interaction } from "../test-support/work-seeds.ts";
import { workAgent } from "../test-support/work-test-tasks.ts";
import { ok, type WorkWorld, withWorkWorld } from "../test-support/work-test-world.ts";
import { createDispatch } from "../work/dispatch.ts";

// The three gap triggers code raises every day and the expiry of cards deferred past their days,
// through the store's dispatch as pi_work, the tick's role. Synthetic rows only. The windows are
// `ontology/autonomy.json`'s: 36 hours, 48 hours, 3 days unanswered within 14, and 14 days
// deferred. reply_owed reads only a conversation the owner took part in and has not answered
// elsewhere. The scans turn it on explicitly, since the rule data can switch it off, and one shows
// that off raises none.

const OWN = ["own"];
const WORK = ["employer:example"];
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NEW_TRIGGERS = ["meeting_soon", "commitment_due", "reply_owed"];
const at = (base: Date, ms: number): Date => new Date(base.getTime() + ms);
const REPLY_ON = { ...autonomyRules(), replyOwedOn: true };

type Flag = {
  id: string;
  gap_trigger: string;
  gap_subject: string;
  compartments: string[];
  about_kind: string;
  about_id: string;
  tier: string;
};

// The tick's step 3b, as gap-flags.db.test.ts runs it: close, then raise.
async function scan(
  w: WorkWorld,
  now: Date,
  rules: AutonomyRules = REPLY_ON,
): Promise<{ raised: number; closed: number; waiting: number }> {
  const dispatch = createDispatch({ url: w.db.urls.work, log: w.log, journal: "" });
  try {
    const flags = await dispatch.gapFlags(now);
    const plan = planGapFlags({
      candidates: await dispatch.gapCandidates(now, rules),
      open: flags.open,
      history: flags.history,
    });
    const counts = { raised: 0, closed: 0, waiting: 0 };
    for (const id of plan.close) if (await dispatch.closeGapFlag(id, now)) counts.closed += 1;
    for (const { gap, card } of plan.raise) {
      if ((await dispatch.raiseGapFlag(gap, !card)) !== null) counts.raised += 1;
      else counts.waiting += 1;
    }
    return counts;
  } finally {
    await dispatch.close();
  }
}

// The flags of the three triggers, by trigger and subject.
const flags = (w: WorkWorld): Promise<Flag[]> =>
  w.admin<Flag>(
    "select id, gap_trigger, gap_subject, compartments, about_kind, about_id, tier from ledger.opportunities where gap_trigger = any ($1) order by gap_trigger, gap_subject",
    [NEW_TRIGGERS],
  );

const agent = (w: WorkWorld, name: string, compartments: string[]): Promise<WorkClient> =>
  workAgent(w, name, compartments, { tools: READING_AGENT_TOOLS, kinds: ["research"] });

const board = async (w: WorkWorld, client: WorkClient): Promise<OpportunityView[]> =>
  ok(await w.work.listOpportunities(client.token, { scope: "board" })).opportunities;

// A timed meeting starting at `starts`, under the label, with a person at it unless `alone`.
async function meeting(
  w: WorkWorld,
  compartments: string[],
  starts: Date,
  options: { alone?: boolean } = {},
): Promise<string> {
  const event = await w.seed.event(compartments);
  await w.seed.eventDetails(compartments, event);
  await w.admin(
    "update knowledge.event_details set starts_at = $2, ends_at = $2::timestamptz + interval '1 hour' where event_id = $1",
    [event, starts.toISOString()],
  );
  if (options.alone !== true) {
    const person = await w.seed.entity("person");
    await w.admin(
      "insert into knowledge.event_participants (event_id, entity_id, participant_role, compartments) values ($1, $2, 'participant', $3)",
      [event, person, compartments],
    );
  }
  return event;
}

// A commitment claim read from a message under the label, due at `due`; its fact key.
async function commitment(
  w: WorkWorld,
  compartments: string[],
  due: Date,
): Promise<{ claim: string; fact: string; message: string }> {
  const message = await w.message(compartments);
  const claim = await w.seed.claim(compartments, message.evidence, "commitment");
  await w.claims("update knowledge.claims set due_at = $2 where id = $1", [claim, due.toISOString()]);
  const [row] = await w.admin<{ fact_key_fp: string }>("select fact_key_fp from knowledge.claims where id = $1", [
    claim,
  ]);
  return { claim, fact: row?.fact_key_fp as string, message: message.id };
}

// Inbound mail under the label sent at `sent`, its thread and sender's address fingerprints.
async function inbound(
  w: WorkWorld,
  compartments: string[],
  sent: Date,
  options: { bulk?: boolean } = {},
): Promise<{ id: string; evidence: string; thread: string; sender: string }> {
  const message = await w.message(compartments);
  await w.admin("update knowledge.messages set sent_at = $2, bulk = $3 where id = $1", [
    message.id,
    sent.toISOString(),
    options.bulk ?? false,
  ]);
  const [row] = await w.admin<{ thread_fp: string; sender_fp: string }>(
    "select thread_fp, sender_fp from knowledge.messages where id = $1",
    [message.id],
  );
  return { ...message, thread: row?.thread_fp as string, sender: row?.sender_fp as string };
}

// The sender's address on a saved contact under the label: a known correspondent.
async function saved(w: WorkWorld, compartments: string[], senderFp: string): Promise<void> {
  const contact = (await w.seed.into("knowledge.contacts")(compartments)) as string;
  const person = await w.seed.entity("person");
  await w.admin(
    "insert into knowledge.contact_addresses (contact_id, value_fp, entity_id, compartments) values ($1, $2, $3, $4)",
    [contact, senderFp, person, compartments],
  );
}

// The owner's mail on a thread at `sent`, under the label.
async function outbound(
  w: WorkWorld,
  compartments: string[],
  sent: Date,
  thread?: string,
): Promise<{ id: string; evidence: string }> {
  const message = await w.message(compartments);
  await w.admin(
    "update knowledge.messages set direction = 'outbound', sent_at = $2, thread_fp = coalesce($3, thread_fp) where id = $1",
    [message.id, sent.toISOString(), thread ?? null],
  );
  return message;
}

const utcDay = (when: Date): string => when.toISOString().slice(0, 10).replaceAll("-", "");

describe("three triggers code raises every day", { timeout: DB_TEST_TIMEOUT }, () => {
  it("each raises one read-only task once, at the edge of its window and not past it, labelled from what it read", () =>
    withWorkWorld(
      async (w) => {
        const now = new Date();
        const scout = await agent(w, "scout", OWN);
        await setTaskTier(w.admin, true, now);

        // meeting_soon: a meeting 36 hours ahead raises; one a second later, one with no one at it,
        // a cancelled one and an all-day one do not.
        const soon = await meeting(w, OWN, at(now, 36 * HOUR));
        await meeting(w, OWN, at(now, 36 * HOUR + 1000));
        await meeting(w, OWN, at(now, 2 * HOUR), { alone: true });
        const cancelled = await meeting(w, OWN, at(now, 3 * HOUR));
        await w.admin("update knowledge.event_details set cancelled = true where event_id = $1", [cancelled]);
        const allDay = await meeting(w, OWN, at(now, 4 * HOUR));
        await w.admin("update knowledge.event_details set all_day = true where event_id = $1", [allDay]);

        // commitment_due: due 48 hours ahead raises; a second later does not; one past due does not;
        // one a newer statement of its fact decided instead (here, with no due) does not.
        const due = await commitment(w, OWN, at(now, 48 * HOUR));
        await commitment(w, OWN, at(now, 48 * HOUR + 1000));
        await commitment(w, OWN, at(now, -HOUR));
        const restated = await commitment(w, OWN, at(now, 24 * HOUR));
        const newer = await w.seed.claim(OWN, (await w.message(OWN)).evidence, "commitment");
        await w.claims("update knowledge.claims set fact_key_fp = $2, valid_from = now() where id = $1", [
          newer,
          restated.fact,
        ]);

        // reply_owed: on a thread the owner wrote in earlier, from a saved contact, unanswered
        // exactly 3 days, raises; from someone the owner has mailed, 5 days, raises. Too recent, too
        // old, answered, bulk or from a stranger: none, though each thread has the owner's earlier message.
        const owed = await inbound(w, OWN, at(now, -3 * DAY));
        await saved(w, OWN, owed.sender);
        await outbound(w, OWN, at(now, -10 * DAY), owed.thread);
        const recent = await inbound(w, OWN, at(now, -3 * DAY + 1000));
        await saved(w, OWN, recent.sender);
        await outbound(w, OWN, at(now, -10 * DAY), recent.thread);
        const stale = await inbound(w, OWN, at(now, -14 * DAY - 1000));
        await saved(w, OWN, stale.sender);
        await outbound(w, OWN, at(now, -20 * DAY), stale.thread);
        const answered = await inbound(w, OWN, at(now, -5 * DAY));
        await saved(w, OWN, answered.sender);
        await outbound(w, OWN, at(now, -4 * DAY), answered.thread);
        const bulk = await inbound(w, OWN, at(now, -5 * DAY), { bulk: true });
        await saved(w, OWN, bulk.sender);
        await outbound(w, OWN, at(now, -10 * DAY), bulk.thread);
        const stranger = await inbound(w, OWN, at(now, -5 * DAY));
        await outbound(w, OWN, at(now, -10 * DAY), stranger.thread);
        const mailed = await inbound(w, OWN, at(now, -5 * DAY));
        await outbound(w, OWN, at(now, -10 * DAY), mailed.thread);
        const correspondent = await w.seed.entity("person");
        await interaction(w, mailed.evidence, correspondent, "inbound", OWN);
        const sent = await outbound(w, OWN, at(now, -30 * DAY));
        await interaction(w, sent.evidence, correspondent, "outbound", OWN);

        // A thread the owner never wrote in (an invite, a newsletter, a broadcast), from a saved
        // contact and 5 days old, raises none.
        const neverWrote = await inbound(w, OWN, at(now, -5 * DAY));
        await saved(w, OWN, neverWrote.sender);
        // A thread the owner wrote in, whose sender's person they have since mailed on another thread, raises
        // none: answered elsewhere.
        const elsewhere = await inbound(w, OWN, at(now, -5 * DAY));
        await saved(w, OWN, elsewhere.sender);
        await outbound(w, OWN, at(now, -10 * DAY), elsewhere.thread);
        const colleague = await w.seed.entity("person");
        await interaction(w, elsewhere.evidence, colleague, "inbound", OWN);
        const since = await outbound(w, OWN, at(now, -2 * DAY));
        await interaction(w, since.evidence, colleague, "outbound", OWN);

        // A saved contact lists the sender's person under another address: known too.
        const listed = await inbound(w, OWN, at(now, -6 * DAY));
        const contact = (await w.seed.into("knowledge.contacts")(OWN)) as string;
        const friend = await w.seed.entity("person");
        await w.admin(
          "insert into knowledge.contact_addresses (contact_id, value_fp, entity_id, compartments) values ($1, $2, $3, $4)",
          [contact, "f".repeat(64), friend, OWN],
        );
        await interaction(w, listed.evidence, friend, "inbound", OWN);
        await outbound(w, OWN, at(now, -10 * DAY), listed.thread);

        // Off: reply_owed raises nothing, the others as before.
        await scan(w, now, { ...autonomyRules(), replyOwedOn: false });
        expect((await flags(w)).map((one) => one.gap_trigger).sort()).toEqual(["commitment_due", "meeting_soon"]);

        await scan(w, now);
        const raised = await flags(w);
        expect(raised.map((one) => [one.gap_trigger, one.gap_subject, one.about_kind, one.about_id])).toEqual(
          [
            ["commitment_due", `${due.fact}_${utcDay(at(now, 48 * HOUR))}`, "message", due.message],
            ["meeting_soon", soon, "event", soon],
            ["reply_owed", listed.id, "message", listed.id],
            ["reply_owed", mailed.id, "message", mailed.id],
            ["reply_owed", owed.id, "message", owed.id],
          ].sort((a, b) => (a.join() < b.join() ? -1 : 1)),
        );
        // Labelled from what each read, tasks, decided go by code with no card.
        for (const one of raised) {
          expect(one.compartments, one.gap_trigger).toEqual(OWN);
          expect(one.tier, one.gap_trigger).toBe("task");
          expect(await w.latest("opportunity", one.id), one.gap_trigger).toBe("go");
        }
        expect(
          await w.admin("select count(*)::int as n from ledger.cards where target_id = any ($1)", [
            raised.map((one) => one.id),
          ]),
        ).toEqual([{ n: 0 }]);
        // Once: a second tick raises nothing more.
        expect((await scan(w, now)).raised).toBe(0);
        expect(await flags(w)).toHaveLength(5);

        // The agent's brief names the item by id and says what to do, with no message text.
        const seen = (await board(w, scout)).filter(
          (one) => one.gap !== undefined && NEW_TRIGGERS.includes(one.gap.trigger),
        );
        expect(seen.map((one) => [one.gap?.trigger, one.gap?.missing, one.summary]).sort()).toEqual([
          ["commitment_due", "follow_up", null],
          ["meeting_soon", "brief", null],
          ["reply_owed", "reply", null],
          ["reply_owed", "reply", null],
          ["reply_owed", "reply", null],
        ]);
        expect(seen.find((one) => one.gap?.trigger === "commitment_due")).toMatchObject({
          kind: "research",
          tier: "task",
          about: { kind: "message", id: due.message },
          gap: { fact: due.fact },
        });
        expect(seen.find((one) => one.gap?.trigger === "meeting_soon")?.dueAt).toBe(at(now, 36 * HOUR).toISOString());

        // The owner replies: the task closes, as a gap flag whose gap filled does.
        await outbound(w, OWN, at(now, -HOUR), owed.thread);
        expect((await scan(w, now)).closed).toBeGreaterThanOrEqual(1);
        expect(await w.latest("opportunity", raised.find((one) => one.gap_subject === owed.id)?.id as string)).toBe(
          "withdrawn",
        );
      },
      ["own", "employer:example"],
    ));

  it("a reply_owed flag's expectation is met by the rule: the owner answers on the thread, then the sender replies", () =>
    withWorkWorld(
      async (w) => {
        const now = new Date();
        await agent(w, "own-only", OWN);
        await setTaskTier(w.admin, true, now);
        const owed = await inbound(w, OWN, at(now, -4 * DAY));
        await saved(w, OWN, owed.sender);
        await outbound(w, OWN, at(now, -10 * DAY), owed.thread);
        await scan(w, now);
        const [flag] = (await flags(w)).filter((one) => one.gap_subject === owed.id);
        if (flag === undefined) throw new Error("no reply_owed flag");
        expect(
          await w.admin("select subject_kind, outcome_type from ledger.expected_outcomes where opportunity_id = $1", [
            flag.id,
          ]),
        ).toEqual([{ subject_kind: "counterpart", outcome_type: "answered" }]);
        const [watch] = await w.admin<{ kind: string; watch_key: string; account_id: string }>(
          "select kind, watch_key, account_id from ledger.work_watches where opportunity_id = $1",
          [flag.id],
        );
        expect(watch).toMatchObject({ kind: "thread", watch_key: owed.thread });
        // The items on the thread, in the watch's account, first stored in this order.
        const onThread = async (evidence: string, seen: Date): Promise<void> => {
          await w.admin(
            "update vault.evidence_items set thread_fp = $2, source_account_id = $3, observed_at = $4 where id = $1",
            [evidence, owed.thread, watch?.account_id, seen.toISOString()],
          );
        };
        await onThread(owed.evidence, at(now, -4 * DAY));
        const answer = await outbound(w, OWN, now, owed.thread);
        await onThread(answer.evidence, at(now, HOUR));
        const dispatch = createDispatch({ url: w.db.urls.work, log: w.log, journal: "" });
        try {
          await dispatch.matchOutcomes(at(now, 2 * HOUR));
          expect(
            await w.admin("select kind, created_by from ledger.work_watches where opportunity_id = $1 order by id", [
              flag.id,
            ]),
          ).toEqual([
            { kind: "thread", created_by: "system:gaps" },
            { kind: "thread", created_by: "system:owner_output" },
          ]);
          // The owner's own mail is no reply to the owner.
          expect(
            await w.admin("select count(*)::int as n from ledger.outcome_links where opportunity_id = $1", [flag.id]),
          ).toEqual([{ n: 0 }]);
          const reply = await inbound(w, OWN, at(now, 3 * HOUR));
          await w.admin("update knowledge.messages set thread_fp = $2, sender_fp = $3 where id = $1", [
            reply.id,
            owed.thread,
            owed.sender,
          ]);
          await onThread(reply.evidence, at(now, 3 * HOUR));
          await dispatch.matchOutcomes(at(now, 4 * HOUR));
          expect(
            await w.admin("select kind, path, judge from ledger.outcome_links where opportunity_id = $1", [flag.id]),
          ).toEqual([{ kind: "met", path: "watched", judge: "rule" }]);
        } finally {
          await dispatch.close();
        }
      },
      ["own"],
    ));

  it("invariant 6: a hidden compartment's meeting, commitment or mail raises nothing a clearance without it sees, and changes nothing it does see", () =>
    withWorkWorld(
      async (w) => {
        const now = new Date();
        const own = await agent(w, "own-only", OWN);
        const both = await agent(w, "both", [...OWN, ...WORK]);
        await setTaskTier(w.admin, true, now);

        const event = await meeting(w, WORK, at(now, 10 * HOUR));
        const due = await commitment(w, WORK, at(now, 10 * HOUR));
        const hidden = await inbound(w, WORK, at(now, -4 * DAY));
        await saved(w, WORK, hidden.sender);
        await outbound(w, WORK, at(now, -10 * DAY), hidden.thread);
        // An own message whose thread has a reply under the hidden label is still owed, for own; so is
        // one whose sender's person the owner mailed since only under the hidden label.
        const visible = await inbound(w, OWN, at(now, -4 * DAY));
        await saved(w, OWN, visible.sender);
        await outbound(w, OWN, at(now, -10 * DAY), visible.thread);
        await outbound(w, WORK, at(now, -3 * DAY), visible.thread);
        const person = await w.seed.entity("person");
        await interaction(w, visible.evidence, person, "inbound", OWN);
        const since = await outbound(w, WORK, at(now, -2 * DAY));
        await interaction(w, since.evidence, person, "outbound", WORK);
        // An own message on a thread the owner wrote in only under the hidden label is no ongoing
        // conversation for its own label.
        const notOngoing = await inbound(w, OWN, at(now, -4 * DAY));
        await saved(w, OWN, notOngoing.sender);
        await outbound(w, WORK, at(now, -10 * DAY), notOngoing.thread);
        // An own message whose sender is saved only under the hidden label is no known correspondent.
        const unknown = await inbound(w, OWN, at(now, -4 * DAY));
        await saved(w, WORK, unknown.sender);

        await scan(w, now);
        const raised = await flags(w);
        expect(raised.map((one) => [one.gap_trigger, one.about_id, one.compartments.join(",")]).sort()).toEqual(
          [
            ["commitment_due", due.message, "employer:example"],
            ["meeting_soon", event, "employer:example"],
            ["reply_owed", hidden.id, "employer:example"],
            ["reply_owed", visible.id, "own"],
          ].sort(),
        );
        const ids = (views: OpportunityView[]): string[] =>
          views
            .filter((one) => one.gap !== undefined && NEW_TRIGGERS.includes(one.gap.trigger))
            .map((one) => (one.about.kind === "owner" ? "" : one.about.id))
            .sort();
        expect(ids(await board(w, own))).toEqual([visible.id]);
        expect(ids(await board(w, both))).toEqual([due.message, event, hidden.id, visible.id].sort());
      },
      ["own", "employer:example"],
    ));
});

describe("a card deferred past its days expires by the policy", { timeout: DB_TEST_TIMEOUT }, () => {
  it("closes its case expired by system:card_expiry, counts as no answer of the owner's, leaves pending cards, and reopens", () =>
    withCardWorld(async (world) => {
      const dispatch = world.dispatch();
      const now = new Date();
      const { id, caseId } = await world.opportunity({});
      const old = (await world.card({
        target: ["opportunity", id],
        caseKey: caseId,
        state: "deferred",
        at: at(now, -14 * DAY),
      })) as CardId;
      // Another author's, so the expiry's admission of the reasoner's oldest deferred card leaves it.
      const young = await world.card({
        kind: "notice",
        author: "system:identity",
        state: "deferred",
        at: at(now, -14 * DAY + 1000),
        expiresAfterDays: null,
      });
      const pending = await world.card({
        kind: "notice",
        state: "pending",
        at: at(now, -60 * DAY),
        expiresAfterDays: null,
      });
      const ownerEvents = async (): Promise<number> =>
        (await world.admin<{ n: number }>("select count(*)::int as n from ledger.record_events where by = 'owner'"))[0]
          ?.n ?? 0;
      const before = await ownerEvents();

      // Only the card deferred 14 days ago, at the edge; one a second younger and a pending card
      // of 60 days are not.
      const items = (await dispatch.expired(now)).filter((one) => one.kind === "deferred_card");
      expect(items).toEqual([{ kind: "deferred_card", card: old }]);
      expect(await dispatch.expire({ kind: "deferred_card", card: old }, now)).toBe(true);
      expect(await dispatch.expire({ kind: "deferred_card", card: old }, now)).toBe(false);
      expect(await dispatch.expire({ kind: "deferred_card", card: young as CardId }, now)).toBe(false);
      expect(await world.latest("card", young)).toBe("deferred");
      expect(await world.latest("card", pending)).toBe("pending");

      // Append-only: new events, by the policy, with its code; the opportunity it decided closes expired.
      expect(
        await world.admin(
          "select event, by, code from ledger.record_events where row_kind = 'card' and row_id = $1 order by id",
          [old],
        ),
      ).toEqual([
        { event: "deferred", by: "reasoner", code: null },
        { event: "expired", by: "system:card_expiry", code: "card_expiry" },
      ]);
      expect(
        await world.admin(
          "select event, by, code from ledger.record_events where row_kind = 'opportunity' and row_id = $1 order by id desc limit 1",
          [id],
        ),
      ).toEqual([{ event: "expired", by: "system:card_expiry", code: "card_expiry" }]);
      // Never counted as the owner's: no decision of theirs, no event by them, no go.
      expect(
        await world.admin("select count(*)::int as n from knowledge.owner_decisions where card_id = $1", [old]),
      ).toEqual([{ n: 0 }]);
      expect(
        await world.admin("select count(*)::int as n from ledger.opportunity_decisions where opportunity_id = $1", [
          id,
        ]),
      ).toEqual([{ n: 0 }]);
      expect(await ownerEvents()).toBe(before);
      // The case reads as closed by an expiry, not by the owner (rung 0's expired_no_news, not owner_declined).
      const again = await world.opportunity({});
      expect(again.caseId).toBe(caseId);
      expect((await dispatch.opportunityToDecide(again.id as OpportunityId, now))?.facts.caseClosed).toMatchObject({
        by: "expiry",
      });

      // The owner reopens it: the card is theirs to answer again, the opportunity proposed again by the reopen,
      // and its days start again. Only a card the policy expired reopens, once.
      expect(await reopenExpiredCard(world.admin, young as CardId, now)).toBe("not_found");
      expect(await reopenExpiredCard(world.admin, pending as CardId, now)).toBe("not_found");
      // Reopened, with nothing left for the owner to undo by hand (no relayed answer was taken back).
      expect(await reopenExpiredCard(world.admin, old, now)).toEqual({ left: [] });
      expect(await reopenExpiredCard(world.admin, old, now)).toBe("not_found");
      expect(["deferred", "pending"]).toContain(await world.latest("card", old));
      expect(
        await world.admin(
          "select event, by from ledger.record_events where row_kind = 'opportunity' and row_id = $1 order by id desc limit 1",
          [id],
        ),
      ).toEqual([{ event: "proposed", by: "system:card_reopen" }]);
      expect((await dispatch.expired(now)).filter((one) => one.kind === "deferred_card")).toEqual([]);
    }));
});
