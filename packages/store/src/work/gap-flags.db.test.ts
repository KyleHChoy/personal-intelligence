import type { AgentRecordId, OpportunityId, OpportunityView } from "@intelligence/contracts/personal";
import { GAP_WITHDRAWN_REST_DAYS } from "@intelligence/personal-core/planner";
import { describe, expect, it } from "vitest";
import { setTaskTier } from "../admin/admin-tasks.ts";
import { fingerprint } from "../core/fingerprint.ts";
import { sealUnder } from "../core/seal.ts";
import { request, testId } from "../test-support/clients.ts";
import { one, session } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { interactionId } from "../test-support/values.ts";
import { READING_AGENT_TOOLS, type WorkClient } from "../test-support/work-clients.ts";
import { personUnder as person, scanGapFlags as scan } from "../test-support/work-seeds.ts";
import { ok, type WorkWorld, withWorkWorld } from "../test-support/work-test-world.ts";
import { removeOne } from "../write/writer-records.ts";
import { createDispatch } from "./dispatch.ts";

// Gap flags raised by the tick's step (dispatch reads, core decides, dispatch
// writes), claimed and reported by an agent, closed when their gap fills; the work board; the
// owner's request as a basis; and invariant 6 for a client without `own`. Synthetic rows only.

const OWN = ["own"];
const WORK = ["employer:example"];
const DAY = 86_400_000;

type Flag = {
  id: string;
  gap_trigger: string;
  gap_subject: string;
  compartments: string[];
  about_kind: string;
  about_id: string;
  goal_id: string | null;
};

const flags = (w: WorkWorld): Promise<Flag[]> =>
  w.admin<Flag>(
    "select id, gap_trigger, gap_subject, compartments, about_kind, about_id, goal_id from ledger.opportunities where gap_trigger is not null order by gap_trigger, gap_subject",
  );

// A meeting `days` from now under the label, with these people at it.
async function meeting(w: WorkWorld, compartments: string[], days: number, people: string[]): Promise<string> {
  const event = await w.seed.event(compartments);
  await w.seed.eventDetails(compartments, event);
  await w.admin(
    "update knowledge.event_details set starts_at = $2, ends_at = $2::timestamptz + interval '1 hour' where event_id = $1",
    [event, new Date(Date.now() + days * DAY).toISOString()],
  );
  for (const one of people)
    await w.admin(
      "insert into knowledge.event_participants (event_id, entity_id, participant_role, compartments) values ($1, $2, 'participant', $3)",
      [event, one, compartments],
    );
  return event;
}

// A name no one resolved, in a message under the label.
async function mention(
  w: WorkWorld,
  message: { id: string; evidence: string },
  name: string,
  compartments = OWN,
): Promise<string> {
  const id = testId("umn");
  const nameFp = fingerprint(w.db.keys, "name", name);
  await w.admin(
    "insert into vault.unresolved_mentions (id, evidence_id, extractor_generation, name_fp, facts_enc, compartments) values ($1, $2, 1, $3, $4, $5)",
    [
      id,
      message.evidence,
      nameFp,
      JSON.stringify(
        sealUnder(
          w.db.keys,
          compartments,
          { table: "vault.unresolved_mentions", id, column: "facts_enc" },
          JSON.stringify({ name, type: "person", field: "subject" }),
        ),
      ),
      compartments,
    ],
  );
  return nameFp;
}

// Mail both ways with a person, n messages each way, under the label.
async function mail(w: WorkWorld, entity: string, n: number, compartments = OWN): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    for (const direction of ["inbound", "outbound"] as const) {
      const message = await w.message(compartments);
      await w.admin(
        `insert into knowledge.interaction_log (id, evidence_id, member_id, entity_id, direction, channel, occurred_at, compartments, readers, entity_role)
         values ($1, $2, 'm-owner', $3, $4, 'email', now() - interval '10 days', $5, '{m-owner}', $6)`,
        [
          interactionId(message.evidence, entity),
          message.evidence,
          entity,
          direction,
          compartments,
          direction === "inbound" ? "sender" : "recipient",
        ],
      );
    }
  }
}

async function researcher(w: WorkWorld, name: string, compartments = OWN): Promise<WorkClient> {
  // The record tool too: an owner_request's quote is kept as the caller's note.
  const client = await w.client(name, compartments, { tools: READING_AGENT_TOOLS });
  // The owner's intent for research that code may decide: what authorizes a gap flag.
  await w.intent(["research"], [client], "policy_decides");
  await w.intent(["investigate"], [client]);
  await w.harness(client, "research", "investigate");
  await w.harness(client, "investigate", "investigate");
  return client;
}

const board = async (w: WorkWorld, client: WorkClient): Promise<OpportunityView[]> =>
  ok(await w.work.listOpportunities(client.token, { scope: "board" })).opportunities;

describe("gap flags", { timeout: DB_TEST_TIMEOUT }, () => {
  it("each trigger raises exactly one flag; an agent claims and reports one; each closes when its gap fills", () =>
    withWorkWorld(
      async (w) => {
        // A name in two messages, unresolved.
        const named = await mention(w, await w.message(OWN), "Sam Example");
        await mention(w, await w.message(OWN), "Sam Example");
        // A meeting in two days with two people the system barely knows, and one it knows well: past
        // the meeting_soon window (36 hours), so it raises attendees' flags alone.
        const [stranger, other, friend] = [await person(w), await person(w), await person(w)];
        await mail(w, friend, 3);
        const event = await meeting(w, OWN, 2, [stranger, other, friend]);
        // An active goal after an organization nobody the owner knows is at.
        const lab = await w.seed.entity("organization");
        await w.seed.domain(OWN, lab);
        const goal = await w.goal(OWN, "meet the lab");
        await w.admin("update projections.goal_state set target_entity_id = $2 where goal_id = $1", [goal, lab]);
        // A goal with no target, and a paused one with a target, raise nothing.
        await w.goal(OWN, "a goal with no target");
        const paused = await w.goal(OWN, "a paused goal");
        await w.admin("update projections.goal_state set target_entity_id = $2, status = 'paused' where goal_id = $1", [
          paused,
          lab,
        ]);

        // Until the owner turns the task tier on, the gaps wait, and nothing is raised.
        const scout = await researcher(w, "scout", ["own", "agent:scout"]);
        const peer = await researcher(w, "peer");
        expect(await scan(w)).toEqual({ raised: 0, closed: 0, waiting: 4 });
        expect(await flags(w)).toEqual([]);
        await setTaskTier(w.admin, true, new Date());
        expect(await scan(w)).toEqual({ raised: 4, closed: 0, waiting: 0 });
        const raised = await flags(w);
        expect(raised.map((one) => [one.gap_trigger, one.gap_subject, one.about_kind])).toEqual(
          [
            ["no_warm_path", lab, "entity"],
            ["unknown_attendee", stranger, "entity"],
            ["unknown_attendee", other, "entity"],
            ["unresolved_mention", named, "message"],
          ].sort((a, b) => (a.join() < b.join() ? -1 : 1)),
        );
        expect(raised.every((one) => one.compartments.join() === "own")).toBe(true);
        expect(raised.find((one) => one.gap_trigger === "no_warm_path")?.goal_id).toBe(goal);
        // Decided go by code at once, with no card: rung 0, gap_flag.
        for (const one of raised) expect(await w.latest("opportunity", one.id)).toBe("go");
        // Under the owner's task intent, which lists no client.
        expect(
          await w.admin(
            "select decided_by, rung, reason, i.client_ids from ledger.opportunity_decisions d join policy.intents i on i.id = d.intent_id where d.opportunity_id = any ($1) group by 1, 2, 3, 4",
            [raised.map((one) => one.id)],
          ),
        ).toEqual([{ decided_by: "policy", rung: 0, reason: "gap_flag", client_ids: [] }]);
        expect(
          await w.admin("select count(*)::int as n from ledger.cards where target_id = any ($1)", [
            raised.map((one) => one.id),
          ]),
        ).toEqual([{ n: 0 }]);
        // Scanning again raises nothing more: one open flag per trigger, subject and label.
        expect(await scan(w)).toEqual({ raised: 0, closed: 0, waiting: 0 });

        // An agent sees them on the board with what is missing, claims one, plans and reports it.
        const seen = await board(w, scout);
        expect(seen.map((one) => one.gap?.missing).sort()).toEqual(["identity", "path", "profile", "profile"]);
        const strangerFlag = raised.find((one) => one.gap_subject === stranger)?.id as OpportunityId;
        expect(seen.find((one) => one.id === strangerFlag)).toMatchObject({
          kind: "research",
          status: "go",
          stage: "investigate",
          about: { kind: "entity", id: stranger },
        });
        ok(await w.work.claimOpportunity(scout.token, { id: strangerFlag, requestId: request() }));
        // The board shows every agent who holds what.
        expect((await board(w, peer)).find((one) => one.id === strangerFlag)).toMatchObject({
          status: "claimed",
          holder: "scout",
        });
        expect((await board(w, peer)).filter((one) => one.holder !== undefined)).toHaveLength(1);
        const { move } = ok(
          await w.work.planMove(scout.token, { opportunity: strangerFlag, stage: "investigate", requestId: request() }),
        );
        // A flag is a task, done with a source and a finding written while held.
        const found = ok(
          await w.reader.record(scout.token, {
            kind: "finding",
            body: "the attendee leads the lab's outreach",
            requestId: request(),
          }),
        ).recordId as AgentRecordId;
        const reported = ok(
          await w.work.reportMove(scout.token, {
            move,
            outcome: "done",
            report: {
              deliverable: "role and focus found in two threads",
              next: "propose the role for the owner to confirm",
              sources: [{ kind: "agent_record", id: found }],
            },
            requestId: request(),
          }),
        );
        expect(reported).toMatchObject({ opportunity: "done" });

        // Gaps fill. The name now resolves; the meeting passes; someone at the lab is a saved contact.
        await w.admin("delete from vault.unresolved_mentions where name_fp = $1", [named]);
        await w.admin(
          "update knowledge.event_details set starts_at = now() - interval '2 hours', ends_at = now() - interval '1 hour' where event_id = $1",
          [event],
        );
        const insider = await person(w);
        const contact = (await w.seed.into("knowledge.contacts")(OWN)) as string;
        await w.admin(
          "insert into knowledge.contact_addresses (contact_id, value_fp, entity_id, compartments) values ($1, $2, $3, $4)",
          [contact, fingerprint(w.db.keys, "address", "insider@example.test"), insider, OWN],
        );
        const claim = await w.seed.claim(OWN);
        await w.claims("update knowledge.claims set type = 'affiliation' where id = $1", [claim]);
        await w.seed.claimEntity(OWN, claim, insider);
        await w.seed.claimEntity(OWN, claim, lab);
        // Three close; the reported one stays done and is not raised again. The meeting that just
        // ended, with a person on it, raises its follow-up, and nothing else is raised.
        expect(await scan(w)).toEqual({ raised: 1, closed: 3, waiting: 0 });
        for (const one of raised)
          expect(await w.latest("opportunity", one.id), one.gap_trigger).toBe(
            one.id === strangerFlag ? "done" : "withdrawn",
          );
        expect((await board(w, scout)).map((one) => [one.gap?.trigger, one.about])).toEqual([
          ["meeting_followup", { kind: "event", id: event }],
        ]);
        // A new meeting with the stranger, whose flag was just done, raises nothing in its quiet days.
        await meeting(w, OWN, 2, [stranger]);
        expect(await scan(w)).toEqual({ raised: 0, closed: 0, waiting: 0 });
      },
      ["own", "employer:example", "agent:scout"],
    ));

  it("code-raised work writes its default expectation and what it watches, in the raise", () =>
    withWorkWorld(
      async (w) => {
        await researcher(w, "scout");
        await setTaskTier(w.admin, true, new Date());
        const attendee = await person(w);
        const event = await meeting(w, OWN, 1, [attendee]);
        // A name no one resolved: its work comes back as knowledge, so it expects nothing.
        await mention(w, await w.message(OWN), "Sam Example");
        await scan(w);
        const rows = await w.admin<{
          trigger: string;
          kind: string;
          subject: string | null;
          type: string;
          days: number;
        }>(
          `select o.gap_trigger as trigger, x.subject_kind as kind, x.subject_id as subject, x.outcome_type as type, x.horizon_days as days
           from ledger.expected_outcomes x join ledger.opportunities o on o.id = x.opportunity_id
           where x.origin = 'default' and x.created_by = 'system:gaps' order by 1`,
        );
        expect(rows).toEqual([
          { trigger: "meeting_soon", kind: "event", subject: event, type: "meeting_held", days: 14 },
          { trigger: "unknown_attendee", kind: "entity", subject: attendee, type: "meeting_held", days: 14 },
        ]);
        expect(
          await w.admin("select kind, watch_key from ledger.work_watches where created_by = 'system:gaps'"),
        ).toEqual([{ kind: "entity", watch_key: attendee }]);
        // Every flag was raised; the one with no default holds none.
        expect((await flags(w)).map((one) => one.gap_trigger).sort()).toEqual([
          "meeting_soon",
          "unknown_attendee",
          "unresolved_mention",
        ]);
      },
      ["own", "agent:scout"],
    ));

  it("work about a message expects its counterpart and watches its thread; once; a goal_claim needs a goal", () =>
    withWorkWorld(
      async (w) => {
        await researcher(w, "scout");
        await setTaskTier(w.admin, true, new Date());
        const message = await w.message(OWN);
        const thread = "a".repeat(64);
        await w.admin("update knowledge.messages set thread_fp = $2 where id = $1", [message.id, thread]);
        await mention(w, message, "Sam Example");
        await scan(w);
        const [flag] = await flags(w);
        if (flag === undefined) throw new Error("no flag");
        const expect_ = async (type: string): Promise<number | undefined> =>
          (
            await queryAs<{ n: number }>(w.db.urls.work, "select ledger.expect_gap_flag($1, $2, 14) as n", [
              flag.id,
              type,
            ])
          )[0]?.n;
        expect(await expect_("goal_claim")).toBe(0);
        expect(await expect_("answered")).toBe(1);
        expect(await expect_("answered")).toBe(0);
        expect(
          await w.admin(
            "select subject_kind, subject_id, outcome_type from ledger.expected_outcomes where opportunity_id = $1",
            [flag.id],
          ),
        ).toEqual([{ subject_kind: "counterpart", subject_id: null, outcome_type: "answered" }]);
        expect(
          await w.admin("select kind, watch_key from ledger.work_watches where opportunity_id = $1", [flag.id]),
        ).toEqual([{ kind: "thread", watch_key: thread }]);
      },
      ["own", "agent:scout"],
    ));

  it("a flag code withdrew rests, so a candidate that flickers is not raised again", () =>
    withWorkWorld(
      async (w) => {
        await researcher(w, "scout");
        await setTaskTier(w.admin, true, new Date());
        const lab = await w.seed.entity("organization");
        await w.seed.domain(OWN, lab);
        const goal = await w.goal(OWN, "meet the lab");
        const target = (id: string | null) =>
          w.admin("update projections.goal_state set target_entity_id = $2 where goal_id = $1", [goal, id]);
        await target(lab);
        expect((await scan(w)).raised).toBe(1);
        // The gap goes, so the flag is withdrawn by code; and it comes back. Before the rest this
        // raised a new row each time.
        await target(null);
        expect((await scan(w)).closed).toBe(1);
        await target(lab);
        const before = (await flags(w)).length;
        expect((await scan(w)).raised).toBe(0);
        expect((await flags(w)).length).toBe(before);
        // Past the rest it may be raised again.
        const later = new Date(Date.now() + GAP_WITHDRAWN_REST_DAYS * DAY + 60_000);
        expect((await scan(w, later)).raised).toBe(1);
      },
      ["own", "agent:scout"],
    ));

  it("a dated gap does not rest: a meeting moved out of its window and back gets its task", () =>
    withWorkWorld(
      async (w) => {
        await researcher(w, "scout");
        await setTaskTier(w.admin, true, new Date());
        const attendee = await person(w);
        const event = await meeting(w, OWN, 1, [attendee]);
        const moved = (days: number) =>
          w.admin(
            "update knowledge.event_details set starts_at = $2, ends_at = $2::timestamptz + interval '1 hour' where event_id = $1",
            [event, new Date(Date.now() + days * DAY).toISOString()],
          );
        const soon = async () =>
          (await flags(w)).filter((one) => one.gap_trigger === "meeting_soon" && one.gap_subject === event);
        expect((await scan(w)).raised).toBeGreaterThan(0);
        expect(await soon()).toHaveLength(1);
        await moved(20);
        expect((await scan(w)).closed).toBeGreaterThan(0);
        await moved(1);
        await scan(w);
        expect(await soon()).toHaveLength(2);
      },
      ["own", "agent:scout"],
    ));

  it("the day's count leaves out what the cap does not cover", () =>
    withWorkWorld(
      async (w) => {
        await researcher(w, "scout");
        await setTaskTier(w.admin, true, new Date());
        const dispatch = createDispatch({ url: w.db.urls.work, log: w.log, journal: "" });
        try {
          // A meeting's two flags are dated, so neither takes the day's room.
          await meeting(w, OWN, 1, [await person(w)]);
          expect((await scan(w)).raised).toBeGreaterThan(0);
          expect((await dispatch.gapSupply(new Date())).get("own")?.raisedToday ?? 0).toBe(0);
          // A name no one resolved has no date, and does.
          await mention(w, await w.message(OWN), "Sam Example");
          await scan(w);
          expect((await dispatch.gapSupply(new Date())).get("own")?.raisedToday).toBe(1);
        } finally {
          await dispatch.close();
        }
      },
      ["own", "agent:scout"],
    ));

  it("the supply the cap reads: what code raised today and what finished lately, by label", () =>
    withWorkWorld(
      async (w) => {
        const scout = await researcher(w, "scout");
        await setTaskTier(w.admin, true, new Date());
        const attendee = await person(w);
        await mention(w, await w.message(OWN), attendee);
        const { raised } = await scan(w);
        expect(raised).toBeGreaterThan(0);
        const dispatch = createDispatch({ url: w.db.urls.work, log: w.log, journal: "" });
        try {
          const before = await dispatch.gapSupply(new Date());
          // Nothing finished yet, so no used work, and the raises sit under the trigger that raised them: the
          // numbers a trigger's share of the room reads.
          const noneUsed = { scored: 0, used: 0, kept: 0, dropped: 0 };
          const triggers = { unresolved_mention: { ...noneUsed, raisedToday: raised } };
          expect(before.get("own")).toEqual({ raisedToday: raised, claimed: 0, done: 0, used: 0, triggers });
          const [task] = await board(w, scout);
          if (task === undefined) throw new Error("no task on the board");
          ok(await w.work.claimOpportunity(scout.token, { id: task.id, requestId: "supply-claim-0001" }));
          const after = await dispatch.gapSupply(new Date());
          expect(after.get("own")).toEqual({ raisedToday: raised, claimed: 1, done: 0, used: 0, triggers });
          // Invariant 6: no other label's numbers are in this label's.
          expect([...after.keys()]).toEqual(["own"]);
        } finally {
          await dispatch.close();
        }
      },
      ["own", "agent:scout"],
    ));

  it("invariant 11: a flag the owner declined is not raised again from its source, and from a new one only as the owner's card", () =>
    withWorkWorld(async (w) => {
      await researcher(w, "scout");
      await setTaskTier(w.admin, true, new Date());
      const named = await mention(w, await w.message(OWN), "Ada Example");
      expect((await scan(w)).raised).toBe(1);
      const [first] = await flags(w);
      await w.status("opportunity", first?.id as string, "no_go", "owner");
      expect(await scan(w)).toEqual({ raised: 0, closed: 0, waiting: 0 });
      // The same name in a new message: proposed alone, for the owner's card; no decision by code.
      const later = await w.message(OWN);
      await w.admin("update knowledge.messages set sent_at = now() where id = $1", [later.id]);
      await mention(w, later, "Ada Example");
      expect((await scan(w)).raised).toBe(1);
      const again = (await flags(w)).find((one) => one.id !== first?.id && one.gap_subject === named);
      expect(await w.latest("opportunity", again?.id as string)).toBe("proposed");
      expect(
        await w.admin("select count(*)::int as n from ledger.opportunity_decisions where opportunity_id = $1", [
          again?.id,
        ]),
      ).toEqual([{ n: 0 }]);
      // A research row is always a gap flag: the constraint refuses one without its trigger.
      await expect(
        w.admin(
          "update ledger.opportunities set gap_trigger = null, gap_subject = null, gap_source = null where id = $1",
          [again?.id],
        ),
      ).rejects.toThrow();
    }));

  it("the board: another client's work only once go or claimed, with no summary; the caller's own in full", () =>
    withWorkWorld(async (w) => {
      const [mine, theirs] = [await researcher(w, "mine"), await researcher(w, "theirs")];
      const subject = await person(w);
      const about = { kind: "entity" as const, id: subject as never };
      const { opportunity } = ok(
        await w.work.proposeOpportunity(theirs.token, {
          kind: "investigate",
          about,
          summary: "their private plan",
          basis: [about],
          requestId: request(),
        }),
      );
      // Proposed, undecided: its author alone sees it, with its summary.
      expect((await board(w, theirs)).map((one) => [one.id, one.summary])).toEqual([
        [opportunity, { untrusted: "their private plan" }],
      ]);
      expect(await board(w, mine)).toEqual([]);
      // Decided go: on every board, its summary on its author's alone.
      const [intent] = await w.admin<{ id: string }>(
        "select id from policy.intents where $1 = any (client_ids) and mode = 'owner_decides'",
        [theirs.id],
      );
      await w.decideGo(opportunity, intent?.id as string);
      expect((await board(w, mine)).map((one) => [one.id, one.status, one.summary])).toEqual([
        [opportunity, "go", null],
      ]);
    }));

  it("an agent may cite the owner's request by a short quote, kept as its own note", () =>
    withWorkWorld(
      async (w) => {
        // An agent's clearance holds its own compartment, where its records are written.
        const agent = await researcher(w, "aide", ["own", "agent:aide"]);
        const subject = await person(w);
        const proposed = await w.work.proposeOpportunity(agent.token, {
          kind: "investigate",
          about: { kind: "entity", id: subject as never },
          summary: "find who runs the lab",
          basis: [{ kind: "owner_request", quote: "find out who runs the lab before Friday" }],
          requestId: request(),
        });
        expect(proposed.ok, JSON.stringify(w.log.events)).toBe(true);
        const { opportunity } = ok(proposed);
        const [basis] = await w.admin<{
          ref_kind: string;
          ref_id: string;
          owner_backed: boolean;
          source_class: string;
        }>("select ref_kind, ref_id, owner_backed, source_class from ledger.basis where row_id = $1", [opportunity]);
        expect(basis).toMatchObject({ ref_kind: "owner_request", owner_backed: false, source_class: "agent" });
        const [note] = await w.admin<{ kind: string; client_id: string }>(
          "select kind, client_id from ledger.agent_writes where id = $1",
          [basis?.ref_id],
        );
        expect(note).toEqual({ kind: "note", client_id: agent.id });
        // It goes to the owner as any proposal does, and its view names the note.
        expect(await w.latest("opportunity", opportunity)).toBe("proposed");
        const [view] = (await board(w, agent)).filter((one) => one.id === opportunity);
        expect(view?.basis).toEqual([{ kind: "owner_request", id: basis?.ref_id }]);
        // No tool takes an owner_request by id: a note is cited only by the call that writes it.
        const other = await researcher(w, "other", ["own", "agent:aide", "agent:other"]);
        const byId = await w.work.proposeOpportunity(other.token, {
          kind: "investigate",
          about: { kind: "entity", id: subject as never },
          summary: "investigate the cited person",
          basis: [{ kind: "owner_request", id: basis?.ref_id } as never],
          requestId: request(),
        });
        expect(byId).toEqual({ ok: false, code: "invalid_request" });
        // A proposal refused keeps no note: about an entity the caller cannot see.
        const notes = async (): Promise<number> =>
          one(
            await w.admin<{ n: number }>("select count(*)::int as n from ledger.agent_writes where client_id = $1", [
              other.id,
            ]),
          ).n;
        const unseen = await w.seed.entity("person");
        const refused = await w.work.proposeOpportunity(other.token, {
          kind: "investigate",
          about: { kind: "entity", id: unseen as never },
          summary: "investigate the cited person",
          basis: [{ kind: "owner_request", quote: "look into them" }],
          requestId: request(),
        });
        expect(refused).toEqual({ ok: false, code: "not_found" });
        expect(await notes()).toBe(0);
        // Invariant 10: removing the note before it is taken in taints what cites it.
        await session(w.db.urls.admin, (query) => removeOne({ query }, basis?.ref_id as string));
        expect(
          one(
            await w.admin<{ tainted: boolean }>(
              "select tainted_at is not null as tainted from ledger.basis where row_id = $1",
              [opportunity],
            ),
          ).tainted,
        ).toBe(true);
        expect(
          one(
            await w.admin<{ tainted: boolean }>(
              "select tainted_at is not null as tainted from ledger.opportunities where id = $1",
              [opportunity],
            ),
          ).tainted,
        ).toBe(true);
      },
      ["own", "employer:example", "agent:aide", "agent:other"],
    ));

  it("invariant 6: a client without own sees no own flag, holder or count, and an employer flag counts only the employer's rows", () =>
    withWorkWorld(async (w) => {
      // Rowan is well known under `own` and unknown under the employer's label.
      const rowan = await person(w, OWN);
      await w.seed.account(WORK, rowan);
      await mail(w, rowan, 3, OWN);
      // In two days: past the meeting_soon window, so only attendees' flags are raised.
      await meeting(w, WORK, 2, [rowan]);
      await meeting(w, OWN, 2, [rowan]);
      const stranger = await person(w, OWN);
      await meeting(w, OWN, 2, [stranger]);
      const narrow = await researcher(w, "narrow", WORK);
      const wide = await researcher(w, "wide", OWN);
      await setTaskTier(w.admin, true, new Date());
      expect(await scan(w)).toEqual({ raised: 2, closed: 0, waiting: 0 });
      const raised = await flags(w);
      // The employer's meeting flags Rowan under the employer's label alone; the owner's knows Rowan.
      expect(raised.map((one) => [one.gap_subject, one.compartments.join()])).toEqual(
        [
          [rowan, "employer:example"],
          [stranger, "own"],
        ].sort((a, b) => (a.join() < b.join() ? -1 : 1)),
      );
      const before = JSON.stringify(await board(w, narrow));
      expect((await board(w, narrow)).map((one) => one.about)).toEqual([{ kind: "entity", id: rowan }]);
      expect((await board(w, wide)).map((one) => one.about)).toEqual([{ kind: "entity", id: stranger }]);
      // The wide client claims its own flag: nothing the narrow client sees changes.
      const ownFlag = raised.find((one) => one.gap_subject === stranger)?.id as OpportunityId;
      ok(await w.work.claimOpportunity(wide.token, { id: ownFlag, requestId: request() }));
      expect(JSON.stringify(await board(w, narrow))).toBe(before);
      // Nor does a flag of the owner's closing.
      await w.admin(
        "update knowledge.event_details set starts_at = now() - interval '1 hour' where event_id in (select event_id from knowledge.event_participants where entity_id = $1)",
        [stranger],
      );
      await w.work.releaseOpportunity(wide.token, { id: ownFlag, reason: "other", requestId: request() });
      expect((await scan(w)).closed).toBe(1);
      expect(JSON.stringify(await board(w, narrow))).toBe(before);
    }));
});
