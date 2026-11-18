import { describe, expect, it } from "vitest";
import { one } from "../test-support/connections.ts";
import {
  type AssessmentRow,
  accountOf,
  addressFp,
  assessmentOf,
  assessments,
  assessOutcomes,
  DAY,
  daysAfter,
  links,
  matchOutcomes,
  meeting,
  reply,
  send,
  threadFp,
} from "../test-support/learning-fixtures.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { type WorkWorld, withWorkWorld } from "../test-support/work-fixtures.ts";

// Written without reading the migration. Each test that refuses a link or an assessment has its
// positive control beside it. Made-up values only.

// A time some days back, on a whole second, so every time a test derives from it is in range
// of the functions' windows and compares exactly with what the database returns.
const base = (daysBack: number): Date => new Date(Math.floor(Date.now() / 1000) * 1000 - daysBack * DAY);
const hours = (at: Date, count: number): Date => new Date(at.getTime() + count * 3_600_000);

async function setup(world: WorkWorld) {
  return {
    drafter: await world.agent(),
    account: await accountOf(world),
    recipient: addressFp(world, "quill.keeper@send-example.test"),
  };
}

const eventId = async (world: WorkWorld, rowKind: string, row: string, event: string): Promise<string> =>
  one(
    await world.admin<{ id: string }>(
      "select id::text as id from ledger.record_events where row_kind = $1 and row_id = $2 and event = $3",
      [rowKind, row, event],
    ),
  ).id;

describe("ledger.match_outcomes", { timeout: DB_TEST_TIMEOUT }, () => {
  it("a reply from a recipient in the send's thread is linked to the latest earlier send", () =>
    withWorkWorld(async (world) => {
      const { drafter, account, recipient } = await setup(world);
      const at = base(20);
      const first = await send(world, {
        drafter,
        account,
        recipients: [recipient],
        thread: "lamp-oil",
        begunAt: at,
        state: "sent",
      });
      // The latest earlier send: its own thread fingerprint, finish_send's, and none on its draft.
      const latest = await send(world, {
        drafter,
        account,
        recipients: [recipient],
        thread: null,
        sendThread: "lamp-oil",
        begunAt: daysAfter(at, 2),
        state: "sent",
      });
      const answer = await reply(world, account, { thread: "lamp-oil", from: recipient, at: daysAfter(at, 5) });
      // A send begun after the reply was observed is never its cause.
      const later = await send(world, {
        drafter,
        account,
        recipients: [recipient],
        thread: "lamp-oil",
        begunAt: daysAfter(at, 8),
        state: "sent",
      });

      expect(await matchOutcomes(world, daysAfter(at, 10))).toBe(1);
      const [link] = await links(world);
      expect(await links(world)).toHaveLength(1);
      expect(link).toMatchObject({
        send_id: latest.id,
        result_kind: "reply",
        ref_kind: "message",
        ref_id: answer.id,
        evidence_id: answer.evidence,
        observed_at: daysAfter(at, 5),
        tainted_at: null,
        created_by: "system:outcomes",
      });
      expect(link?.id).toMatch(/^mrl_[0-9A-HJKMNP-TV-Z]{26}$/);
      expect([first.id, later.id]).not.toContain(link?.send_id);
    }));

  it("a reply observed before the send, from a non-recipient, from the owner, or on a failed send is not linked", () =>
    withWorkWorld(async (world) => {
      const { drafter, account, recipient } = await setup(world);
      const at = base(20);
      await send(world, { drafter, account, recipients: [recipient], thread: "quay", begunAt: at, state: "sent" });
      await reply(world, account, { thread: "quay", from: recipient, at: daysAfter(at, -1) });
      await reply(world, account, {
        thread: "quay",
        from: addressFp(world, "stranger@send-example.test"),
        at: daysAfter(at, 1),
      });
      await reply(world, account, {
        thread: "quay",
        from: recipient,
        at: daysAfter(at, 1),
        direction: "outbound",
        answersSystem: false,
      });
      // A message the system sent, and one not marked as answering the system.
      await reply(world, account, {
        thread: "quay",
        from: recipient,
        at: daysAfter(at, 1),
        answersSystem: false,
        systemOriginated: true,
      });
      await reply(world, account, { thread: "quay", from: recipient, at: daysAfter(at, 1), answersSystem: false });
      await send(world, {
        drafter,
        account,
        recipients: [recipient],
        thread: "quay-failed",
        begunAt: at,
        state: "failed",
      });
      await reply(world, account, { thread: "quay-failed", from: recipient, at: daysAfter(at, 1) });
      expect(await matchOutcomes(world, daysAfter(at, 3))).toBe(0);
      expect(await links(world)).toEqual([]);

      // The positive control: a reply of the recipient's in the thread, after the send.
      const answer = await reply(world, account, { thread: "quay", from: recipient, at: daysAfter(at, 2) });
      expect(await matchOutcomes(world, daysAfter(at, 3))).toBe(1);
      expect((await links(world)).map((link) => link.ref_id)).toEqual([answer.id]);
    }));

  it("a meeting the owner accepted with a recipient within 30 days is linked; one they did not answer is not", () =>
    withWorkWorld(async (world) => {
      const { drafter, account } = await setup(world);
      const guest = await world.person();
      const at = base(20);
      const sent = await send(world, {
        drafter,
        account,
        recipients: [guest.fp],
        thread: "harbour",
        begunAt: at,
        state: "sent",
      });
      const accepted = await meeting(world, {
        participant: guest.id,
        startsAt: daysAfter(at, 7),
        observedAt: daysAfter(at, 1),
      });
      await meeting(world, {
        participant: guest.id,
        startsAt: daysAfter(at, 8),
        observedAt: daysAfter(at, 1),
        response: "needsAction",
      });
      // Starting more than 30 days after the send.
      await meeting(world, { participant: guest.id, startsAt: daysAfter(at, 31), observedAt: daysAfter(at, 2) });
      // Observed before the send.
      await meeting(world, { participant: guest.id, startsAt: daysAfter(at, 9), observedAt: daysAfter(at, -1) });
      // With someone the send did not go to.
      const other = await world.person();
      await meeting(world, { participant: other.id, startsAt: daysAfter(at, 9), observedAt: daysAfter(at, 1) });
      // Accepted, then cancelled.
      const cancelled = await meeting(world, {
        participant: guest.id,
        startsAt: daysAfter(at, 10),
        observedAt: daysAfter(at, 1),
      });
      await world.admin("update knowledge.event_details set cancelled = true where event_id = $1", [cancelled.id]);

      expect(await matchOutcomes(world, daysAfter(at, 3))).toBe(1);
      expect(await links(world)).toEqual([
        expect.objectContaining({
          send_id: sent.id,
          result_kind: "meeting",
          ref_kind: "event",
          ref_id: accepted.id,
          evidence_id: accepted.evidence,
          observed_at: daysAfter(at, 1),
        }),
      ]);
    }));

  it("a meeting link's label also holds the compartments of the participant and the account it matched", () =>
    withWorkWorld(async (world) => {
      const { drafter, account } = await setup(world);
      // The address is known under the employer's compartment; the event and the send are own.
      const guest = await world.person(["employer:example"]);
      const at = base(20);
      await send(world, { drafter, account, recipients: [guest.fp], thread: "label", begunAt: at, state: "sent" });
      await meeting(world, { participant: guest.id, startsAt: daysAfter(at, 7), observedAt: daysAfter(at, 1) });
      expect(await matchOutcomes(world, daysAfter(at, 3))).toBe(1);
      expect((await links(world)).map((link) => link.compartments)).toEqual([["employer:example", "own"]]);
    }));

  it("a send whose draft is tainted is no cause, and is not assessed", () =>
    withWorkWorld(async (world) => {
      const { drafter, account, recipient } = await setup(world);
      const at = base(20);
      const withdrawn = await send(world, {
        drafter,
        account,
        recipients: [recipient],
        thread: "withdrawn",
        begunAt: at,
        state: "sent",
      });
      await world.owner("update ledger.drafts set tainted_at = now() where id = $1", [withdrawn.draft]);
      await reply(world, account, { thread: "withdrawn", from: recipient, at: daysAfter(at, 1) });
      // The control: the same in another thread, its draft whole.
      const whole = await send(world, {
        drafter,
        account,
        recipients: [recipient],
        thread: "whole",
        begunAt: at,
        state: "sent",
      });
      await reply(world, account, { thread: "whole", from: recipient, at: daysAfter(at, 1) });
      expect(await matchOutcomes(world, daysAfter(at, 2))).toBe(1);
      expect((await links(world)).map((link) => link.send_id)).toEqual([whole.id]);
      expect(await assessOutcomes(world, daysAfter(at, 18))).toBe(1);
      expect((await assessments(world)).map((row) => row.subject_id)).toEqual([whole.id]);
    }));

  it("a bulk reply and a message in no thread are not linked", () =>
    withWorkWorld(async (world) => {
      const { drafter, account, recipient } = await setup(world);
      const at = base(20);
      await send(world, { drafter, account, recipients: [recipient], thread: "rota", begunAt: at, state: "sent" });
      await reply(world, account, { thread: "rota", from: recipient, at: daysAfter(at, 1), bulk: true });
      // A send that starts a thread Gmail has not named yet, and a reply in no thread.
      await send(world, { drafter, account, recipients: [recipient], thread: null, begunAt: at, state: "sent" });
      await reply(world, account, { thread: null, from: recipient, at: daysAfter(at, 1) });
      expect(await matchOutcomes(world, daysAfter(at, 3))).toBe(0);
      // The positive control: the same reply, not bulk.
      const answer = await reply(world, account, { thread: "rota", from: recipient, at: daysAfter(at, 2) });
      expect(await matchOutcomes(world, daysAfter(at, 3))).toBe(1);
      expect((await links(world)).map((link) => link.ref_id)).toEqual([answer.id]);
    }));

  it("a reply first observed 31 days after the send is not linked", () =>
    withWorkWorld(async (world) => {
      const { drafter, account, recipient } = await setup(world);
      const at = base(40);
      await send(world, { drafter, account, recipients: [recipient], thread: "late", begunAt: at, state: "sent" });
      // Its own time is within the window; the box first stored it 31 days after the send.
      await reply(world, account, {
        thread: "late",
        from: recipient,
        at: daysAfter(at, 2),
        observedAt: daysAfter(at, 31),
      });
      expect(await matchOutcomes(world, daysAfter(at, 32))).toBe(0);
      expect(await links(world)).toEqual([]);
      // The positive control: first observed 29 days after its send.
      const control = await send(world, {
        drafter,
        account,
        recipients: [recipient],
        thread: "in-time",
        begunAt: at,
        state: "sent",
      });
      await reply(world, account, {
        thread: "in-time",
        from: recipient,
        at: daysAfter(at, 2),
        observedAt: daysAfter(at, 29),
      });
      expect(await matchOutcomes(world, daysAfter(at, 29.5))).toBe(1);
      expect((await links(world)).map((link) => link.send_id)).toEqual([control.id]);
    }));

  it("a second call writes nothing", () =>
    withWorkWorld(async (world) => {
      const { drafter, account, recipient } = await setup(world);
      const guest = await world.person();
      const at = base(20);
      await send(world, {
        drafter,
        account,
        recipients: [recipient, guest.fp],
        thread: "twice",
        begunAt: at,
        state: "sent",
      });
      await reply(world, account, { thread: "twice", from: recipient, at: daysAfter(at, 1) });
      await meeting(world, { participant: guest.id, startsAt: daysAfter(at, 4), observedAt: daysAfter(at, 1) });
      expect(await matchOutcomes(world, daysAfter(at, 2))).toBe(2);
      const first = await links(world);
      expect(await matchOutcomes(world, daysAfter(at, 2))).toBe(0);
      expect(await matchOutcomes(world, daysAfter(at, 3))).toBe(0);
      expect(await links(world)).toEqual(first);
    }));

  it("a link's compartments are the union of its send's and its reply's, and so are its assessment's", () =>
    withWorkWorld(async (world) => {
      const { drafter, account, recipient } = await setup(world);
      const at = base(20);
      const sent = await send(world, {
        drafter,
        account,
        recipients: [recipient],
        thread: "union",
        begunAt: at,
        state: "sent",
        compartments: ["employer:example"],
      });
      await reply(world, account, { thread: "union", from: recipient, at: daysAfter(at, 1) });
      expect(await matchOutcomes(world, daysAfter(at, 2))).toBe(1);
      expect((await links(world)).map((link) => link.compartments)).toEqual([["employer:example", "own"]]);
      expect(await assessOutcomes(world, daysAfter(at, 2))).toBe(1);
      expect((await assessmentOf(world, sent.id))?.compartments).toEqual(["employer:example", "own"]);
    }));
});

describe("ledger.assess_outcomes", { timeout: DB_TEST_TIMEOUT }, () => {
  it("each OUTCOME_CHECKS row: met, not met at the horizon, and none for an opportunity never decided go", () =>
    withWorkWorld(async (world) => {
      const { drafter, account, recipient } = await setup(world);
      const at = base(45);
      const expected: Record<string, Partial<AssessmentRow>> = {};
      const answered = (result: string, extra: Partial<AssessmentRow> = {}): Partial<AssessmentRow> => ({
        check: "answered",
        horizon_days: 14,
        result,
        decided_by: "code",
        status_event_id: null,
        ...extra,
      });
      const done = (result: string, extra: Partial<AssessmentRow> = {}): Partial<AssessmentRow> => ({
        check: "done",
        result,
        decided_by: "code",
        link_ids: [],
        ...extra,
      });

      // A send whose draft names no opportunity: answered within 14 days, or not.
      const sendMet = await send(world, {
        drafter,
        account,
        recipients: [recipient],
        thread: "s-met",
        begunAt: at,
        state: "sent",
      });
      await reply(world, account, { thread: "s-met", from: recipient, at: daysAfter(at, 3) });
      const sendNot = await send(world, {
        drafter,
        account,
        recipients: [recipient],
        thread: "s-not",
        begunAt: at,
        state: "sent",
      });
      const sendFailed = await send(world, {
        drafter,
        account,
        recipients: [recipient],
        thread: "s-failed",
        begunAt: at,
        state: "failed",
      });

      // follow_up and reply: a reply to a send of a draft that names it, within 14 days.
      const followMet = (await world.opportunity({ kind: "follow_up" })).id;
      await world.decision(followMet, "go", { at: daysAfter(at, -1) });
      await send(world, {
        drafter,
        account,
        recipients: [recipient],
        thread: "o-met",
        begunAt: at,
        state: "sent",
        opportunity: followMet,
      });
      await reply(world, account, { thread: "o-met", from: recipient, at: daysAfter(at, 2) });
      const followNot = (await world.opportunity({ kind: "follow_up" })).id;
      await world.decision(followNot, "go", { at: daysAfter(at, -1) });
      await send(world, {
        drafter,
        account,
        recipients: [recipient],
        thread: "o-not",
        begunAt: at,
        state: "sent",
        opportunity: followNot,
      });
      const replyClosed = (await world.opportunity({ kind: "reply" })).id;
      await world.decision(replyClosed, "go", { at: daysAfter(at, -1) });
      await world.status("opportunity", replyClosed, "no_go", { at: daysAfter(at, 1), by: "owner" });
      // Never decided go and never sent for: nothing to assess.
      const neverGo = (await world.opportunity({ kind: "follow_up" })).id;
      await world.status("opportunity", neverGo, "no_go", { at: daysAfter(at, 1), by: "owner" });

      // meeting_prep: done before its event starts.
      const prepMetEvent = await world.event({ startsAt: daysAfter(at, 5) });
      const prepMet = (await world.opportunity({ kind: "meeting_prep", about: ["event", prepMetEvent] })).id;
      await world.decision(prepMet, "go", { at });
      await world.status("opportunity", prepMet, "done", { at: daysAfter(at, 4), by: "owner" });
      const prepNotEvent = await world.event({ startsAt: daysAfter(at, 5) });
      const prepNot = (await world.opportunity({ kind: "meeting_prep", about: ["event", prepNotEvent] })).id;
      await world.decision(prepNot, "go", { at });

      // investigate, goal_step, life_admin: done by the due time, else within 30 days of the go.
      const dueMet = (await world.opportunity({ kind: "investigate" })).id;
      await world.owner("update ledger.opportunities set due_at = $2 where id = $1", [dueMet, daysAfter(at, 10)]);
      await world.decision(dueMet, "go", { at });
      await world.status("opportunity", dueMet, "done", { at: daysAfter(at, 8), by: `client:${drafter.id}` });
      const goalNot = (await world.opportunity({ kind: "goal_step" })).id;
      await world.decision(goalNot, "go", { at });
      // Sent for and never decided go: it has no horizon but its done.
      const sentFor = (await world.opportunity({ kind: "life_admin" })).id;
      await send(world, {
        drafter,
        account,
        recipients: [recipient],
        thread: "o-sent-for",
        begunAt: at,
        state: "sent",
        opportunity: sentFor,
      });
      await world.status("opportunity", sentFor, "done", { at: daysAfter(at, 3), by: "owner" });
      const adminExpired = (await world.opportunity({ kind: "life_admin" })).id;
      await world.decision(adminExpired, "go", { at });
      await world.status("opportunity", adminExpired, "expired", { at: daysAfter(at, 2), by: "system:work" });

      await matchOutcomes(world, daysAfter(at, 5));
      const linkOf = async (thread: string): Promise<string[]> => {
        const sendId = one(
          await world.admin<{ id: string }>(
            "select s.id from ledger.sent_messages s join ledger.drafts d on d.id = s.draft_id where d.thread_fp = $1",
            [threadFp(world, thread)],
          ),
        ).id;
        return (await links(world)).filter((link) => link.send_id === sendId).map((link) => link.id);
      };
      expected[sendMet.id] = answered("met", { subject_kind: "send", link_ids: await linkOf("s-met") });
      expected[sendNot.id] = answered("not_met", { subject_kind: "send", link_ids: [] });
      expected[followMet] = answered("met", { subject_kind: "opportunity", link_ids: await linkOf("o-met") });
      expected[followNot] = answered("not_met", { subject_kind: "opportunity", link_ids: [] });
      expected[replyClosed] = answered("not_met", {
        subject_kind: "opportunity",
        link_ids: [],
        decided_by: "owner",
        status_event_id: await eventId(world, "opportunity", replyClosed, "no_go"),
      });
      expected[prepMet] = done("met", {
        subject_kind: "opportunity",
        horizon_days: null,
        decided_by: "owner",
        status_event_id: await eventId(world, "opportunity", prepMet, "done"),
      });
      expected[prepNot] = done("not_met", { subject_kind: "opportunity", horizon_days: null, status_event_id: null });
      // The due time decided it, not a number of days.
      expected[dueMet] = done("met", {
        subject_kind: "opportunity",
        horizon_days: null,
        status_event_id: await eventId(world, "opportunity", dueMet, "done"),
      });
      expected[sentFor] = done("met", {
        subject_kind: "opportunity",
        horizon_days: null,
        decided_by: "owner",
        status_event_id: await eventId(world, "opportunity", sentFor, "done"),
      });
      expected[goalNot] = done("not_met", { subject_kind: "opportunity", horizon_days: 30, status_event_id: null });
      expected[adminExpired] = done("not_met", {
        subject_kind: "opportunity",
        horizon_days: 30,
        status_event_id: await eventId(world, "opportunity", adminExpired, "expired"),
      });

      expect(await assessOutcomes(world, daysAfter(at, 40))).toBe(Object.keys(expected).length);
      const rows = await assessments(world);
      expect(rows.map((row) => row.subject_id).sort()).toEqual(Object.keys(expected).sort());
      for (const row of rows) {
        expect(row, row.subject_id).toMatchObject({
          ...expected[row.subject_id],
          created_by: "system:outcomes",
          tainted_at: null,
          compartments: ["own"],
        });
        expect(row.id).toMatch(/^oas_[0-9A-HJKMNP-TV-Z]{26}$/);
      }
      for (const none of [sendFailed.id, neverGo]) expect(rows.map((row) => row.subject_id)).not.toContain(none);
    }));

  it("a reply dated within the horizon but observed after it is met", () =>
    withWorkWorld(async (world) => {
      const { drafter, account, recipient } = await setup(world);
      const at = base(25);
      const late = await send(world, {
        drafter,
        account,
        recipients: [recipient],
        thread: "dated",
        begunAt: at,
        state: "sent",
      });
      await reply(world, account, {
        thread: "dated",
        from: recipient,
        at: daysAfter(at, 13),
        observedAt: daysAfter(at, 16),
      });
      // The control: a reply dated after the horizon is not.
      const after = await send(world, {
        drafter,
        account,
        recipients: [recipient],
        thread: "after",
        begunAt: at,
        state: "sent",
      });
      await reply(world, account, {
        thread: "after",
        from: recipient,
        at: daysAfter(at, 15),
        observedAt: daysAfter(at, 15.5),
      });
      expect(await matchOutcomes(world, daysAfter(at, 16.5))).toBe(2);
      expect(await assessOutcomes(world, daysAfter(at, 16.5))).toBe(1);
      expect((await assessmentOf(world, late.id))?.result).toBe("met");
      expect(await assessmentOf(world, after.id)).toBeUndefined();
      expect(await assessOutcomes(world, daysAfter(at, 17.5))).toBe(1);
      expect(await assessmentOf(world, after.id)).toMatchObject({ result: "not_met", link_ids: [] });
    }));

  it("a follow_up sent twice waits for its last send's horizon, so a reply to the second counts whenever the tick runs", () =>
    withWorkWorld(async (world) => {
      const { drafter, account, recipient } = await setup(world);
      const at = base(40);
      const twice = (await world.opportunity({ kind: "follow_up" })).id;
      await world.decision(twice, "go", { at });
      await send(world, {
        drafter,
        account,
        recipients: [recipient],
        thread: "first-try",
        begunAt: at,
        state: "sent",
        opportunity: twice,
      });
      await send(world, {
        drafter,
        account,
        recipients: [recipient],
        thread: "second-try",
        begunAt: daysAfter(at, 10),
        state: "sent",
        opportunity: twice,
      });
      // 17 days after the first send, the second's window is still open: nothing is written.
      expect(await assessOutcomes(world, daysAfter(at, 17.5))).toBe(0);
      await reply(world, account, { thread: "second-try", from: recipient, at: daysAfter(at, 18) });
      expect(await matchOutcomes(world, daysAfter(at, 18.5))).toBe(1);
      expect(await assessOutcomes(world, daysAfter(at, 18.5))).toBe(1);
      expect(await assessmentOf(world, twice)).toMatchObject({ result: "met", check: "answered" });
      // The control: with no reply, not_met 17 days after the last send.
      const unanswered = (await world.opportunity({ kind: "reply" })).id;
      await world.decision(unanswered, "go", { at });
      await send(world, {
        drafter,
        account,
        recipients: [recipient],
        thread: "third-try",
        begunAt: at,
        state: "sent",
        opportunity: unanswered,
      });
      await send(world, {
        drafter,
        account,
        recipients: [recipient],
        thread: "fourth-try",
        begunAt: daysAfter(at, 10),
        state: "sent",
        opportunity: unanswered,
      });
      expect(await assessOutcomes(world, daysAfter(at, 26.9))).toBe(0);
      expect(await assessOutcomes(world, daysAfter(at, 27.1))).toBe(1);
      expect(await assessmentOf(world, unanswered)).toMatchObject({ result: "not_met", link_ids: [] });
    }));

  it("not_met is not written until the settle days have passed", () =>
    withWorkWorld(async (world) => {
      const { drafter, account, recipient } = await setup(world);
      const at = base(40);
      const silent = await send(world, {
        drafter,
        account,
        recipients: [recipient],
        thread: "silent",
        begunAt: at,
        state: "sent",
      });
      const step = (await world.opportunity({ kind: "goal_step" })).id;
      await world.decision(step, "go", { at });
      for (const days of [14.1, 16.9]) {
        expect(await assessOutcomes(world, daysAfter(at, days)), String(days)).toBe(0);
      }
      expect(await assessOutcomes(world, hours(daysAfter(at, 17), 1))).toBe(1);
      expect(await assessmentOf(world, silent.id)).toMatchObject({ result: "not_met" });
      // 30 days after the go, then 3 more.
      for (const days of [30.5, 32.9]) {
        expect(await assessOutcomes(world, daysAfter(at, days)), String(days)).toBe(0);
      }
      expect(await assessOutcomes(world, hours(daysAfter(at, 33), 1))).toBe(1);
      expect(await assessmentOf(world, step)).toMatchObject({ result: "not_met", horizon_days: 30 });
    }));

  it("an assessment is written once and never changed by a later call", () =>
    withWorkWorld(async (world) => {
      const { drafter, account, recipient } = await setup(world);
      const at = base(25);
      const sent = await send(world, {
        drafter,
        account,
        recipients: [recipient],
        thread: "once",
        begunAt: at,
        state: "sent",
      });
      expect(await assessOutcomes(world, daysAfter(at, 18))).toBe(1);
      const first = await assessments(world);
      expect(first.map((row) => row.result)).toEqual(["not_met"]);
      // A reply dated within the horizon reaches the box after the settle days: it is linked,
      // and the assessment stands.
      await reply(world, account, {
        thread: "once",
        from: recipient,
        at: daysAfter(at, 12),
        observedAt: daysAfter(at, 19),
      });
      expect(await matchOutcomes(world, daysAfter(at, 20))).toBe(1);
      expect(await assessOutcomes(world, daysAfter(at, 20))).toBe(0);
      expect(await assessOutcomes(world, daysAfter(at, 21))).toBe(0);
      expect(await assessments(world)).toEqual(first);
      expect(first[0]?.subject_id).toBe(sent.id);
    }));
});
