import type { ContextView, EntityView, NextMoves, SelfView } from "@intelligence/contracts/personal";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { sealUnder } from "../core/seal.ts";
import { ALL_TOOLS } from "../test-support/clients.ts";
import { recordingPool } from "../test-support/recording.ts";
import { callLog } from "../test-support/store.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { interaction } from "../test-support/work-seeds.ts";
import { ok, type WorkWorld, withWorkWorld } from "../test-support/work-test-world.ts";
import { Reader } from "./read.ts";

// Synthetic rows only.

const OWN = ["own"];
const WORK = ["employer:example"];
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const VIEWS = ["self", "people", "work"];
const TOOLS = [...ALL_TOOLS, "context", "list_goals", "read_message", "list_opportunities"];
const at = (ms: number): Date => new Date(Date.now() + ms);

async function sent(
  w: WorkWorld,
  compartments: string[],
  direction: "inbound" | "outbound",
  when: Date,
  thread?: string,
): Promise<{ id: string; evidence: string; thread: string }> {
  const message = await w.message(compartments);
  await w.admin(
    "update knowledge.messages set direction = $2, sent_at = $3, bulk = false, thread_fp = coalesce($4, thread_fp) where id = $1",
    [message.id, direction, when.toISOString(), thread ?? null],
  );
  const [row] = await w.admin<{ thread_fp: string }>("select thread_fp from knowledge.messages where id = $1", [
    message.id,
  ]);
  return { ...message, thread: row?.thread_fp as string };
}

// A person the reader can see: an entity shows only with a row under the caller's clearance.
async function personUnder(w: WorkWorld, compartments: string[]): Promise<string> {
  const person = await w.seed.entity("person");
  await w.seed.account(compartments, person);
  return person;
}

// A conversation the owner is in: mail to the person, then theirs, an hour ago unless given.
async function conversation(
  w: WorkWorld,
  compartments: string[],
  when: Date = at(-HOUR),
): Promise<{ id: string; evidence: string; thread: string; person: string }> {
  const person = await personUnder(w, compartments);
  const inbound = await sent(w, compartments, "inbound", when);
  await interaction(w, inbound.evidence, person, "inbound", compartments);
  const mine = await sent(w, compartments, "outbound", at(-30 * DAY), inbound.thread);
  await interaction(w, mine.evidence, person, "outbound", compartments);
  return { ...inbound, person };
}

const selfOf = async (w: WorkWorld, token: string): Promise<SelfView> => ok(await w.reader.getSelf(token));
const nextOf = async (w: WorkWorld, token: string): Promise<NextMoves> => (await selfOf(w, token)).next as NextMoves;
const ids = (next: NextMoves, kind: string): string[] =>
  next.moves.filter((one) => one.kind === kind).map((one) => one.source.id as string);

describe("what next", { timeout: DB_TEST_TIMEOUT }, () => {
  it("a reply owed appears the day it arrives, and leaves when the owner answers", () =>
    withWorkWorld(async (w) => {
      const client = await w.client("reader", OWN, { tools: TOOLS, views: VIEWS });
      const owed = await conversation(w, OWN);
      const first = await nextOf(w, client.token);
      expect(ids(first, "reply")).toEqual([owed.id]);
      const move = first.moves.find((one) => one.kind === "reply");
      expect(move?.why).toContain("today");
      expect(move?.who?.id).toBe(owed.person);

      await sent(w, OWN, "outbound", at(-1000), owed.thread);
      expect(ids(await nextOf(w, client.token), "reply")).toEqual([]);
    }));

  it("what makes a thread no reply owed: nothing from the owner on it, or mail to the person since", () =>
    withWorkWorld(async (w) => {
      const client = await w.client("reader", OWN, { tools: TOOLS, views: VIEWS });
      // A thread the owner never wrote in, from someone the owner has mailed elsewhere.
      const person = await personUnder(w, OWN);
      const broadcast = await sent(w, OWN, "inbound", at(-HOUR));
      await interaction(w, broadcast.evidence, person, "inbound", OWN);
      const elsewhere = await sent(w, OWN, "outbound", at(-30 * DAY));
      await interaction(w, elsewhere.evidence, person, "outbound", OWN);
      // A thread the owner wrote in, from someone never mailed.
      const stranger = await personUnder(w, OWN);
      const list = await sent(w, OWN, "inbound", at(-HOUR));
      await interaction(w, list.evidence, stranger, "inbound", OWN);
      await sent(w, OWN, "outbound", at(-30 * DAY), list.thread);
      // Answered on another thread since.
      const answered = await conversation(w, OWN);
      const later = await sent(w, OWN, "outbound", at(-60_000));
      await interaction(w, later.evidence, answered.person, "outbound", OWN);
      // Past the window: older than replyOwedWithinDays.
      await conversation(w, OWN, at(-20 * DAY));
      // Bulk.
      const bulk = await conversation(w, OWN);
      await w.admin("update knowledge.messages set bulk = true where id = $1", [bulk.id]);

      expect(ids(await nextOf(w, client.token), "reply")).toEqual([]);
    }));

  it("an automated message later on a thread does not hide what a person is owed", () =>
    withWorkWorld(async (w) => {
      const client = await w.client("reader", OWN, { tools: TOOLS, views: VIEWS });
      const owed = await conversation(w, OWN, at(-2 * HOUR));
      const notice = await sent(w, OWN, "inbound", at(-HOUR), owed.thread);
      await w.admin("update knowledge.messages set bulk = true where id = $1", [notice.id]);
      expect(ids(await nextOf(w, client.token), "reply")).toEqual([owed.id]);
    }));

  it("the newest first when none asks anything, two of them, and more says the rest wait", () =>
    withWorkWorld(async (w) => {
      const client = await w.client("reader", OWN, { tools: TOOLS, views: VIEWS });
      const newest = await conversation(w, OWN, at(-HOUR));
      const oldest = await conversation(w, OWN, at(-5 * DAY));
      const middle = await conversation(w, OWN, at(-2 * DAY));
      const next = await nextOf(w, client.token);
      expect(ids(next, "reply")).toEqual([newest.id, middle.id]);
      expect(ids(next, "reply")).not.toContain(oldest.id);
      expect(next.more).toBe(true);
    }));

  it("a client shown no mail gets no reply, and that is its registration's doing", () =>
    withWorkWorld(async (w) => {
      await conversation(w, OWN);
      const client = await w.client("selfish", OWN, { tools: TOOLS, views: ["self"] });
      expect(ids(await nextOf(w, client.token), "reply")).toEqual([]);
    }));

  it("what a caller cannot see changes nothing it is served", () =>
    withWorkWorld(async (w) => {
      const own = await w.client("own", OWN, { tools: TOOLS, views: VIEWS });
      const wide = await w.client("wide", [...WORK, ...OWN], { tools: TOOLS, views: VIEWS });
      const visible = await conversation(w, OWN);
      const before = await nextOf(w, own.token);
      // The moves count toward the call's logged rows, so those and the statements sent must hold too.
      const pool = new pg.Pool({ connectionString: w.db.urls.reader });
      const recorded = recordingPool(pool);
      const recording = new Reader({ pool: recorded.pool, keys: w.db.keys, log: w.log });
      const observed = async (token: string) => {
        recorded.statements.length = 0;
        await recording.getSelf(token);
        const statements = recorded.statements.filter((text) => !/policy\.open_session/.test(text));
        return { statements, rows: (await callLog(w.db.urls.admin)).at(-1)?.rows };
      };
      const sees = await observed(own.token);

      const hidden = await conversation(w, WORK);
      const event = await w.seed.event(WORK);
      await w.seed.eventDetails(WORK, event);
      await w.admin(
        "update knowledge.event_details set starts_at = $2, ends_at = $3, all_day = false, cancelled = false where event_id = $1",
        [event, at(HOUR).toISOString(), at(2 * HOUR).toISOString()],
      );
      await w.admin(
        "insert into knowledge.event_participants (event_id, entity_id, participant_role, compartments) values ($1, $2, 'participant', $3)",
        [event, hidden.person, WORK],
      );
      await w.goal(WORK, "A goal under another compartment.");

      expect(await observed(own.token)).toEqual(sees);
      // The control: the client cleared for it logs the moves it was served.
      expect((await observed(wide.token)).rows).toBeGreaterThan(sees.rows ?? 0);
      await pool.end();
      expect(await nextOf(w, own.token)).toEqual(before);
      const seen = await nextOf(w, wide.token);
      expect(ids(seen, "reply").sort()).toEqual([visible.id, hidden.id].sort());
      expect(ids(seen, "meeting")).toEqual([event]);
      // A goal is no signal: agents decide what serves one.
      expect(ids(seen, "goal")).toEqual([]);
    }));

  it("the next meeting has a person at it, in the block's fixed place", () =>
    withWorkWorld(async (w) => {
      const client = await w.client("reader", OWN, { tools: TOOLS, views: VIEWS });
      const person = await personUnder(w, OWN);
      const meeting = async (starts: Date, withPerson: boolean): Promise<string> => {
        const event = await w.seed.event(OWN);
        await w.seed.eventDetails(OWN, event);
        await w.admin(
          "update knowledge.event_details set starts_at = $2, ends_at = $3, all_day = false, cancelled = false where event_id = $1",
          [event, starts.toISOString(), new Date(starts.getTime() + HOUR).toISOString()],
        );
        if (withPerson)
          await w.admin(
            "insert into knowledge.event_participants (event_id, entity_id, participant_role, compartments) values ($1, $2, 'participant', $3)",
            [event, person, OWN],
          );
        return event;
      };
      await meeting(at(HOUR), false);
      const next = await meeting(at(5 * HOUR), true);
      await meeting(at(9 * HOUR), true);
      await conversation(w, OWN);
      const moves = await nextOf(w, client.token);
      expect(moves.moves.find((one) => one.kind === "meeting")).toMatchObject({ source: { kind: "event", id: next } });
    }));

  it("context leads with the block, the same one get_self serves, and the read log holds what it showed", () =>
    withWorkWorld(async (w) => {
      const client = await w.client("reader", OWN, { tools: TOOLS, views: VIEWS });
      const owed = await conversation(w, OWN);
      await w.goal(OWN, "Raise the seed round by spring.");
      const value = ok(await w.reader.context(client.token, { task: "an unrelated errand" })) as ContextView;
      expect(Object.keys(value)[0]).toBe("next");
      expect(value.next).toEqual(await nextOf(w, client.token));
      expect(ids(value.next as NextMoves, "reply")).toEqual([owed.id]);
      expect(ids(value.next as NextMoves, "goal")).toEqual([]);
      const [row] = await w.admin<{ shown: string[] }>(
        "select shown from ledger.read_log where client_id = $1 and tool = 'context' order by id desc limit 1",
        [client.id],
      );
      expect(row?.shown).toContain(owed.evidence);
    }));

  describe("what it holds up to", () => {
    // A reply whose words are given: an old mail from the owner on its thread, then theirs.
    const worded = async (w: WorkWorld, when: Date, words: { subject?: string; text?: string }) => {
      const person = await personUnder(w, OWN);
      const evidence = await w.seed.evidence(OWN, await w.seed.sourceAccount(OWN));
      const id = await w.seed.message(OWN, evidence, words.text === undefined ? {} : { text: words.text });
      await w.admin("update knowledge.messages set direction = 'inbound', sent_at = $2, bulk = false where id = $1", [
        id,
        when.toISOString(),
      ]);
      if (words.subject !== undefined)
        await w.admin("update knowledge.messages set subject_enc = $2 where id = $1", [
          id,
          JSON.stringify(
            sealUnder(w.keys, OWN, { table: "knowledge.messages", id, column: "subject_enc" }, words.subject),
          ),
        ]);
      await interaction(w, evidence, person, "inbound", OWN);
      const [row] = await w.admin<{ thread_fp: string }>("select thread_fp from knowledge.messages where id = $1", [
        id,
      ]);
      const mine = await sent(w, OWN, "outbound", at(-30 * DAY), row?.thread_fp);
      await interaction(w, mine.evidence, person, "outbound", OWN);
      return { id, evidence };
    };
    const task = async (w: WorkWorld, message: string, event: string, tainted = false): Promise<string> => {
      const opportunity = await w.seed.opportunity(OWN);
      await w.claims(
        `update ledger.opportunities set kind = 'research', gap_trigger = 'reply_owed', gap_subject = 'ent', gap_source = $2,
           proposed_by_class = 'system', tainted_at = $3 where id = $1`,
        [opportunity, message, tainted ? new Date().toISOString() : null],
      );
      await w.status("opportunity", opportunity, event, "client:agent");
      return opportunity;
    };
    const meetingTitled = async (w: WorkWorld, title: string, person: string, hours = 5): Promise<string> => {
      const event = await w.seed.event(OWN);
      await w.seed.eventDetails(OWN, event);
      await w.admin("update knowledge.event_details set title_enc = $2 where event_id = $1", [
        event,
        JSON.stringify(
          sealUnder(w.keys, OWN, { table: "knowledge.event_details", id: event, column: "title_enc" }, title),
        ),
      ]);
      const starts = at(hours * HOUR);
      await w.admin(
        "update knowledge.event_details set starts_at = $2, ends_at = $3, all_day = false, cancelled = false where event_id = $1",
        [event, starts.toISOString(), new Date(starts.getTime() + HOUR).toISOString()],
      );
      await w.admin(
        "insert into knowledge.event_participants (event_id, entity_id, participant_role, compartments) values ($1, $2, 'participant', $3)",
        [event, person, OWN],
      );
      return event;
    };

    it("what asks comes first, from the body for a client that may read one, with no body served or bound", () =>
      withWorkWorld(async (w) => {
        const asks = await worded(w, at(-5 * DAY), { text: "Please let me know if any of these times will work." });
        await worded(w, at(-3 * HOUR), { text: "Thanks. Worth keeping a spare for the final." });
        await worded(w, at(-2 * HOUR), { text: "Good work.\n\nOn Monday Rhea wrote:\n> Are you free?" });
        const reader = await w.client("reader", OWN, { tools: TOOLS, views: VIEWS });
        const next = await nextOf(w, reader.token);
        expect(ids(next, "reply")[0]).toBe(asks.id);
        expect(next.moves.find((one) => one.kind === "reply")?.asks).toBe(true);
        expect(JSON.stringify(next)).not.toContain("these times");
        const [row] = await w.admin<{ bound: string[]; shown: string[] }>(
          "select bound, shown from ledger.read_log where client_id = $1 and tool = 'get_self' order by id desc limit 1",
          [reader.id],
        );
        expect(row?.shown).toContain(asks.evidence);
        expect(row?.bound).not.toContain(asks.evidence);

        // Without read_message only the subject is read, and the reply says so.
        const blind = await w.client("blind", OWN, {
          tools: TOOLS.filter((one) => one !== "read_message"),
          views: VIEWS,
        });
        const unread = await nextOf(w, blind.token);
        expect(ids(unread, "reply")).not.toContain(asks.id);
        expect(unread.moves.find((one) => one.kind === "reply")?.why).toContain("read only its subject");
      }));

    it("a subject that asks counts for a client with no body to read", () =>
      withWorkWorld(async (w) => {
        const asks = await worded(w, at(-5 * DAY), { subject: "Are you around on Friday?" });
        await worded(w, at(-HOUR), { subject: "Weekly note" });
        const blind = await w.client("blind", OWN, {
          tools: TOOLS.filter((one) => one !== "read_message"),
          views: VIEWS,
        });
        expect(ids(await nextOf(w, blind.token), "reply")[0]).toBe(asks.id);
      }));

    it("a done reply task on that message keeps the line below the others and points at it; failed or tainted does not", () =>
      withWorkWorld(async (w) => {
        const reader = await w.client("reader", OWN, { tools: TOOLS, views: VIEWS });
        const done = await conversation(w, OWN, at(-HOUR));
        const withdrawn = await conversation(w, OWN, at(-2 * HOUR));
        const opportunity = await task(w, done.id, "done");
        await task(w, withdrawn.id, "withdrawn");
        const next = await nextOf(w, reader.token);
        expect(ids(next, "reply")).toEqual([withdrawn.id, done.id]);
        const line = next.moves.find((one) => one.source.id === done.id);
        expect(line?.task).toBe(opportunity);
        expect(line?.why).toContain("list_opportunities, scope closed");
        expect(next.moves.find((one) => one.source.id === withdrawn.id)?.task).toBeUndefined();
        const tainted = await conversation(w, OWN, at(-3 * HOUR));
        await task(w, tainted.id, "done", true);
        expect(ids(await nextOf(w, reader.token), "reply")).toEqual([withdrawn.id, tainted.id]);
        // A later message on the thread is another message, and the line comes back.
        const later = await sent(w, OWN, "inbound", at(-1000), done.thread);
        await interaction(w, later.evidence, done.person, "inbound", OWN);
        expect(ids(await nextOf(w, reader.token), "reply")).toContain(later.id);
      }));

    it("a task under a label the caller cannot see moves nothing", () =>
      withWorkWorld(async (w) => {
        const both = await w.client("both", [...OWN, ...WORK], { tools: TOOLS, views: VIEWS });
        const owed = await conversation(w, OWN);
        const opportunity = await w.seed.opportunity(WORK);
        await w.claims(
          `update ledger.opportunities set kind = 'research', gap_trigger = 'reply_owed', gap_subject = 'ent', gap_source = $2,
             proposed_by_class = 'system' where id = $1`,
          [opportunity, owed.id],
        );
        await w.status("opportunity", opportunity, "done", "client:agent");
        const own = await w.client("own-only", OWN, { tools: TOOLS, views: VIEWS });
        const seen = await nextOf(w, own.token);
        expect(ids(seen, "reply")).toContain(owed.id);
        expect(seen.moves.find((one) => one.source.id === owed.id)?.task).toBeUndefined();
        const shown = await nextOf(w, both.token);
        expect(shown.moves.find((one) => one.source.id === owed.id)?.task).toBe(opportunity);
      }));

    it("a client that cannot list the task sees the reply as if no task looked", () =>
      withWorkWorld(async (w) => {
        const done = await conversation(w, OWN, at(-HOUR));
        const other = await conversation(w, OWN, at(-2 * HOUR));
        await task(w, done.id, "done");
        const lister = await w.client("lister", OWN, {
          tools: [...new Set([...TOOLS, "list_opportunities"])],
          views: VIEWS,
        });
        expect(ids(await nextOf(w, lister.token), "reply")).toEqual([other.id, done.id]);
        const noTool = await w.client("no-tool", OWN, {
          tools: TOOLS.filter((one) => one !== "list_opportunities"),
          views: VIEWS,
        });
        const noView = await w.client("no-view", OWN, {
          tools: [...new Set([...TOOLS, "list_opportunities"])],
          views: VIEWS.filter((one) => one !== "work"),
        });
        for (const client of [noTool, noView]) {
          const next = await nextOf(w, client.token);
          expect(ids(next, "reply")).toEqual([done.id, other.id]);
          const line = next.moves.find((one) => one.source.id === done.id);
          expect(line?.task).toBeUndefined();
          expect(line?.why).not.toContain("task");
        }
      }));

    it("a moving meeting does not push a firm one out: both show, the firm one first", () =>
      withWorkWorld(async (w) => {
        const client = await w.client("reader", OWN, { tools: TOOLS, views: VIEWS });
        const person = await personUnder(w, OWN);
        const moving = await meetingTitled(w, "Canceled: Standup with Rhea", person, 5);
        const firm = await meetingTitled(w, "Call with Rhea", person, 9);
        expect(ids(await nextOf(w, client.token), "meeting")).toEqual([firm, moving]);
      }));

    it("a recurring slot is no next meeting past a one-off one, and says what it is when alone", () =>
      withWorkWorld(async (w) => {
        const client = await w.client("reader", OWN, { tools: TOOLS, views: VIEWS });
        const person = await personUnder(w, OWN);
        const slot = await meetingTitled(w, "The Weekly Hour", person, 2);
        await w.admin("update knowledge.event_details set recurring = true where event_id = $1", [slot]);
        const alone = (await nextOf(w, client.token)).moves.find((one) => one.kind === "meeting");
        expect(alone?.source.id).toBe(slot);
        expect(alone?.recurring).toBe(true);
        expect(alone?.why).not.toContain("Your next meeting");
        const oneOff = await meetingTitled(w, "A call with someone", person, 72);
        const moves = (await nextOf(w, client.token)).moves.filter((one) => one.kind === "meeting");
        expect(moves.map((one) => one.source.id)).toEqual([oneOff]);
        expect(moves[0]?.recurring).toBeUndefined();
        expect(moves[0]?.why).toContain("Your next one-off meeting");
        const whole = ok(await w.reader.getSelf(client.token, { moves: true })).next as NextMoves;
        expect(ids(whole, "meeting")).toEqual([oneOff, slot]);
      }));

    it("a meeting whose title says it is moving says so in next and in a person's next step", () =>
      withWorkWorld(async (w) => {
        const client = await w.client("reader", OWN, { tools: TOOLS, views: VIEWS });
        const person = await personUnder(w, OWN);
        const event = await meetingTitled(w, "[rescheduling]Call with Rhea", person);
        const moves = await nextOf(w, client.token);
        const move = moves.moves.find((one) => one.kind === "meeting");
        expect(move).toMatchObject({ moving: true, source: { kind: "event", id: event } });
        expect(move?.why).toContain("title says it is being moved");
        const card = ok(await w.reader.getEntity(client.token, { id: person as never })) as EntityView;
        expect(card.lead?.nextStep).toMatchObject({ kind: "meeting", meeting: event, moving: true });
      }));

    it("moves serves every move, alone, and more clears", () =>
      withWorkWorld(async (w) => {
        const client = await w.client("reader", OWN, { tools: TOOLS, views: VIEWS });
        const owed = [
          await conversation(w, OWN, at(-HOUR)),
          await conversation(w, OWN, at(-2 * HOUR)),
          await conversation(w, OWN, at(-3 * HOUR)),
        ];
        const first = await nextOf(w, client.token);
        expect(first.more).toBe(true);
        expect(ids(first, "reply")).toHaveLength(2);
        const whole = ok(await w.reader.getSelf(client.token, { moves: true })) as SelfView;
        expect(ids(whole.next as NextMoves, "reply")).toEqual(owed.map((one) => one.id));
        expect(whole.next?.more).toBe(false);
        expect(whole.sections).toEqual([]);
        expect(whole.contacts).toEqual([]);
      }));

    it("next names no goal, and context's goals say which comes first", () =>
      withWorkWorld(async (w) => {
        const client = await w.client("reader", OWN, { tools: TOOLS, views: VIEWS });
        await w.goal(OWN, "Find a full time role, my number one goal.");
        await w.goal(OWN, "Find a full time flat.");
        const stepless = await nextOf(w, client.token);
        expect(stepless.moves.filter((one) => one.kind === "goal")).toEqual([]);
        const value = ok(await w.reader.context(client.token, { task: "find full time role" })) as ContextView;
        expect(value.goals[0]?.top).toBe(true);
        expect(value.goals[0]?.statement.untrusted).toContain("number one");
      }));
  });
});
