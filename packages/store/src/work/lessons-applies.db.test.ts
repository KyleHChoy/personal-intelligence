import {
  currentDefinition,
  DECISION_POINT_PINS,
  type HypothesisId,
  OpportunityKind,
  type ProposableKind,
  type RequestId,
  type WorkBrief,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { sealUnder } from "../core/seal.ts";
import { request, testId } from "../test-support/clients.ts";
import { one, readAs, session, sqlState } from "../test-support/connections.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import type { WorkClient } from "../test-support/work-clients.ts";
import { withWorkAdmin as withAdmin } from "../test-support/work-seeds.ts";
import { ok, type WorkWorld, withWorkWorld } from "../test-support/work-test-world.ts";
import { raisePlannerCard } from "./dispatch-cards.ts";

// A lesson says which opportunity kinds and roles it is for, and a brief carries only the lessons
// that fit; the owner retires and lifts a lesson; a lessons run may propose one that supersedes a
// lesson it was given, and the owner's confirm of it retires the one it names. Made-up values only.

const OWN = ["own"];
const PIN = DECISION_POINT_PINS["run_outcome@4"] ?? "";

const envelope = (w: WorkWorld, table: string, id: string, text: string) =>
  sealUnder(w.db.keys, OWN, { table, id, column: "body_enc" }, text);
const sealed = (w: WorkWorld, table: string, id: string, text: string): string =>
  JSON.stringify(envelope(w, table, id, text));

// An owner's lesson, confirmed as the owner adds it, through ledger.add_owner_lesson as pi_admin, with
// its selectors; none given is null, which means for all, as on a lesson stored with none.
async function ownerLesson(
  w: WorkWorld,
  text: string,
  selectors: { kinds?: readonly string[] | null; roles?: readonly string[] | null } = {},
): Promise<HypothesisId> {
  const id = testId("hyp");
  await w.admin("select ledger.add_owner_lesson($1, $2, $3::jsonb, $4::text[], $5::text[])", [
    id,
    testId("req"),
    sealed(w, "ledger.hypotheses", id, text),
    selectors.kinds ?? null,
    selectors.roles ?? null,
  ]);
  return id as HypothesisId;
}

// An agent with the given grants and roles, under one intent.
async function agent(
  w: WorkWorld,
  name: string,
  kinds: ProposableKind[],
  roles: string[] = [],
): Promise<{ client: WorkClient; intent: string }> {
  const client = await w.client(name, OWN);
  if (roles.length > 0) await w.admin("update policy.clients set roles = $2 where id = $1", [client.id, roles]);
  const intent = await w.intent(kinds, [client]);
  for (const kind of kinds) await w.harness(client, kind, "investigate");
  return { client, intent };
}

// An opportunity of one kind the agent proposes about a message, decided go and claimed: its brief.
async function claimed(
  w: WorkWorld,
  client: WorkClient,
  intent: string,
  kind: ProposableKind,
): Promise<{ opportunity: string; brief: WorkBrief | undefined }> {
  const about = await w.message();
  const ref = { kind: "message" as const, id: about.id as never };
  const { opportunity } = ok(
    await w.work.proposeOpportunity(client.token, {
      kind,
      about: ref,
      summary: `a ${kind} on the cited message`,
      basis: [ref],
      requestId: request(),
    }),
  );
  await w.decideGo(opportunity, intent);
  const value = ok(await w.work.claimOpportunity(client.token, { id: opportunity, requestId: request() }));
  return { opportunity, brief: value.brief };
}

// The ids of a brief's lessons, of those given, sorted: other lessons of the world are not asked about.
const servedOf = (brief: WorkBrief | undefined, among: readonly string[]): string[] =>
  (brief?.lessons ?? [])
    .map((lesson) => lesson.id as string)
    .filter((id) => among.includes(id))
    .sort();

// A run of one prompt queued as pi_work, as the tick queues one, with the lessons it was given.
async function queue(
  w: WorkWorld,
  prompt: string,
  options: { lessons?: readonly string[] | null; version?: number; promptVersion?: string } = {},
): Promise<string> {
  const id = testId("run");
  const requestId = testId("req");
  await session(w.db.urls.work, async (query) => {
    await query("begin");
    await query(
      `insert into ledger.runs (id, request_id, created_by, compartments, wake_source, wake_key, decision_point, definition_version, prompt_id, prompt_version, lessons)
       values ($1, $2, 'system:work', $3, 'owner_request', $4, 'run_outcome', $5, $6, $7, $8)`,
      [
        id,
        requestId,
        OWN,
        `owner:${requestId}`,
        options.version ?? 4,
        prompt,
        options.promptVersion ?? "1",
        options.lessons ?? null,
      ],
    );
    await query(
      "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('run', $1, 'queued', now(), 'system:work', $2)",
      [id, OWN],
    );
    await query("commit");
  });
  return id;
}

// The current lessons stage, as a new run is queued under it, with the lessons it was given.
async function currentLessonsRun(w: WorkWorld, lessons: readonly string[] | null = null): Promise<string> {
  const point = currentDefinition("run_outcome");
  const prompt = point.prompts?.find((one) => one.id === "personal_lessons");
  if (prompt === undefined) throw new Error("run_outcome names no lessons prompt");
  return queue(w, prompt.id, { version: point.version, promptVersion: prompt.version, lessons });
}

// A queued run taken by the reasoner through ledger.next_run.
async function taken(
  w: WorkWorld,
  reasoner: WorkClient,
  prompt: string,
  lessons: readonly string[] | null,
): Promise<string> {
  const id = await queue(w, prompt, { lessons });
  const [run] = await readAs(w.db, reasoner.token, (query) =>
    query<{ run_id: string }>("select run_id from ledger.next_run($1, $2)", [testId("req"), reasoner.session]),
  );
  if (run?.run_id !== id) throw new Error("next_run took another run");
  return id;
}

// finish_run as the reasoner: its one row, or the code it raised.
async function finish(
  w: WorkWorld,
  reasoner: WorkClient,
  run: string,
  actions: unknown[],
): Promise<{ recorded: number; outcome: string } | string | null> {
  try {
    const rows = await readAs(w.db, reasoner.token, (query) =>
      query<{ recorded: number; outcome: string }>(
        "select * from ledger.finish_run($1, $2, $3, 'finished', null, 4, $4, $5::jsonb)",
        [run, testId("req"), reasoner.session, PIN, JSON.stringify(actions)],
      ),
    );
    return rows[0] ?? null;
  } catch (error) {
    return (error as { code?: string }).code ?? "error";
  }
}

// A lessons run's lesson, citing one hypothesis, with the given selectors or supersedes.
const lessonAction = (w: WorkWorld, cites: string, extra: Record<string, unknown> = {}) => {
  const id = testId("hyp");
  return {
    do: "lesson",
    id,
    about_kind: "owner",
    about_id: null,
    ref_kinds: ["hypothesis"],
    ref_ids: [cites],
    body_enc: envelope(w, "ledger.hypotheses", id, `made-up lesson ${id}`),
    ...extra,
  };
};

const latestOf = async (
  w: WorkWorld,
  rowKind: string,
  id: string,
): Promise<{ event: string; by: string; code: string | null } | undefined> =>
  (
    await w.admin<{ event: string; by: string; code: string | null }>(
      "select event, by, code from ledger.record_events where row_kind = $1 and row_id = $2 and event <> 'reported' order by id desc limit 1",
      [rowKind, id],
    )
  )[0];

describe("lessons apply where they fit, and can be retired", { timeout: DB_TEST_TIMEOUT }, () => {
  it("the columns refuse a kind not in opportunities_kind and a role not of the role form", () =>
    withWorkWorld(async (w) => {
      const lesson = (kinds: readonly string[] | null, roles: readonly string[] | null) =>
        sqlState(() => ownerLesson(w, "a made-up lesson", { kinds, roles }));
      // The controls: every opportunity kind, roles of the form, and empty lists, are taken.
      expect(await lesson([...OpportunityKind.options], ["scout", "a-1", "closer"])).toBeNull();
      expect(await lesson([], [])).toBeNull();
      expect(await lesson(["follow_up", "nonsense"], null)).toBe("23514");
      expect(await lesson(["Follow_up"], null)).toBe("23514");
      for (const role of ["Scout", "x", "1scout", "a".repeat(33), "scout "])
        expect(await lesson(null, [role]), role).toBe("23514");
      expect(
        await lesson(
          null,
          Array.from({ length: 17 }, (_, n) => `role-${n}`),
        ),
      ).toBe("23514");
      expect(
        await lesson(
          null,
          Array.from({ length: 16 }, (_, n) => `role-${n}`),
        ),
      ).toBeNull();
      // None of them is any other kind's: on an agent's hypothesis a selector or a supersedes is
      // refused, and a lesson may not supersede itself or name what is not an id; the same updates
      // without them are taken. Updates as pi_owner, the definer functions' role.
      const set = (id: string, column: "applies_kinds" | "applies_roles" | "supersedes", value: unknown) =>
        sqlState(() =>
          session(w.db.urls.bootstrap, async (query) => {
            await query("begin");
            await query("set local role pi_owner");
            await query(`update ledger.hypotheses set ${column} = $2 where id = $1`, [id, value]);
            await query("commit");
          }),
        );
      const proposer = await w.client("proposer", OWN);
      const about = await w.message();
      const ref = { kind: "message" as const, id: about.id as never };
      const { hypothesis } = ok(
        await w.work.proposeHypothesis(proposer.token, {
          kind: "open_loop",
          about: ref,
          summary: "an open loop in the cited message",
          basis: [ref],
          requestId: request(),
        }),
      );
      const target = await ownerLesson(w, "a lesson that supersedes");
      const other = await ownerLesson(w, "the one superseded");
      expect(await set(hypothesis, "applies_kinds", null)).toBeNull();
      expect(await set(hypothesis, "applies_kinds", ["reply"])).toBe("23514");
      expect(await set(hypothesis, "applies_roles", ["scout"])).toBe("23514");
      expect(await set(hypothesis, "supersedes", other)).toBe("23514");
      expect(await set(target, "supersedes", other)).toBeNull();
      expect(await set(target, "supersedes", target)).toBe("23514");
      expect(await set(target, "supersedes", "not-an-id")).toBe("23514");
      // Each element is held to the form, not the list joined by commas: one role that holds a comma
      // is two roles to a check of the joined text.
      expect(await lesson(null, ["scout,closer"])).toBe("23514");
    }));

  it("a brief carries a lesson whose kinds hold the opportunity's kind or are empty and whose roles meet the client's or are empty, and no other", () =>
    withWorkWorld(async (w) => {
      const lessons = {
        all: await ownerLesson(w, "for all, by null"),
        empty: await ownerLesson(w, "for all, by empty lists", { kinds: [], roles: [] }),
        followUp: await ownerLesson(w, "for follow-ups", { kinds: ["follow_up"] }),
        reply: await ownerLesson(w, "for replies", { kinds: ["reply"] }),
        scout: await ownerLesson(w, "for scouts", { roles: ["scout"] }),
        closer: await ownerLesson(w, "for closers", { roles: ["closer"] }),
        both: await ownerLesson(w, "for a scout's investigations", {
          kinds: ["investigate"],
          roles: ["closer", "scout"],
        }),
        neither: await ownerLesson(w, "for a closer's replies", { kinds: ["reply"], roles: ["closer"] }),
      };
      const mine = Object.values(lessons);
      const scout = await agent(w, "scout", ["investigate", "follow_up"], ["researcher", "scout"]);
      const plain = await agent(w, "plain", ["investigate", "follow_up"]);

      const investigate = await claimed(w, scout.client, scout.intent, "investigate");
      expect(servedOf(investigate.brief, mine)).toEqual(
        [lessons.all, lessons.empty, lessons.scout, lessons.both].sort(),
      );
      const followUp = await claimed(w, scout.client, scout.intent, "follow_up");
      expect(servedOf(followUp.brief, mine)).toEqual(
        [lessons.all, lessons.empty, lessons.followUp, lessons.scout].sort(),
      );
      // A client with no roles is given only the lessons with no roles named.
      const unroled = await claimed(w, plain.client, plain.intent, "investigate");
      expect(servedOf(unroled.brief, mine)).toEqual([lessons.all, lessons.empty].sort());
      const unroledFollowUp = await claimed(w, plain.client, plain.intent, "follow_up");
      expect(servedOf(unroledFollowUp.brief, mine)).toEqual([lessons.all, lessons.empty, lessons.followUp].sort());
      // The caller's own list gives each opportunity the same lessons its claim gave.
      const listed = ok(await w.work.listOpportunities(scout.client.token, { scope: "mine" })).opportunities;
      expect(new Map(listed.map((view) => [view.id, servedOf(view.brief, mine)]))).toEqual(
        new Map([
          [investigate.opportunity, servedOf(investigate.brief, mine)],
          [followUp.opportunity, servedOf(followUp.brief, mine)],
        ]),
      );
      // Its counts are logged, and the counts are of the lessons given. (Its cases count the owner's
      // go on this world's other opportunities, which is not what this test is about.)
      expect(w.log.events.filter((event) => event.event === "work_brief").at(-1)).toMatchObject({
        event: "work_brief",
        counts: { lessons: 4, preferences: 0 },
      });
    }));

  it("a retired lesson is in no brief and no run, and a lifted one is again", () =>
    withWorkWorld(async (w) => {
      const reasoner = await w.client("thinker", OWN, { kind: "reasoner" });
      const retired = await ownerLesson(w, "a lesson the owner retires");
      const kept = await ownerLesson(w, "a lesson the owner keeps");
      const mine: string[] = [retired, kept];
      const { client, intent } = await agent(w, "worker", ["investigate"]);
      // A lessons run is shown the lessons the tick gave it that are still in force.
      const runLessons = async (): Promise<string[]> => {
        const run = await currentLessonsRun(w, mine);
        const request = ok(await w.work.nextRun(reasoner.token, { requestId: testId("req") as RequestId })).run;
        expect(request?.id).toBe(run);
        return (request?.lessons ?? [])
          .map((lesson) => lesson.id as string)
          .filter((id) => mine.includes(id))
          .sort();
      };
      expect(servedOf((await claimed(w, client, intent, "investigate")).brief, mine)).toEqual([...mine].sort());

      await withAdmin(w, (admin) => admin.work.retireLesson(retired, { note: "no longer how he works" }));
      // The owner's retired, with the owner's note sealed on it, and nothing on the other.
      expect(await latestOf(w, "hypothesis", retired)).toEqual({ event: "retired", by: "owner", code: null });
      const [noted] = await w.admin<{ noted: boolean }>(
        "select body_enc is not null as noted from ledger.record_events where row_kind = 'hypothesis' and row_id = $1 and event = 'retired'",
        [retired],
      );
      expect(noted).toEqual({ noted: true });
      expect(await latestOf(w, "hypothesis", kept)).toEqual({ event: "confirmed", by: "owner", code: null });
      expect(servedOf((await claimed(w, client, intent, "investigate")).brief, mine)).toEqual([kept]);
      expect(await runLessons()).toEqual([kept]);

      await withAdmin(w, (admin) => admin.work.retireLesson(retired, { lift: true }));
      expect(await latestOf(w, "hypothesis", retired)).toEqual({ event: "confirmed", by: "owner", code: null });
      expect(servedOf((await claimed(w, client, intent, "investigate")).brief, mine)).toEqual([...mine].sort());
      expect(await runLessons()).toEqual([...mine].sort());

      // Retiring a retired lesson, or lifting one in force, records nothing and says so.
      await withAdmin(w, (admin) => admin.work.retireLesson(retired));
      const events = await w.admin<{ n: number }>(
        "select count(*)::int as n from ledger.record_events where row_kind = 'hypothesis' and row_id = $1",
        [retired],
      );
      await expect(withAdmin(w, (admin) => admin.work.retireLesson(retired, { note: "again" }))).rejects.toMatchObject({
        code: "unchanged",
      });
      await expect(withAdmin(w, (admin) => admin.work.retireLesson(kept, { lift: true }))).rejects.toMatchObject({
        code: "unchanged",
      });
      expect(
        await w.admin<{ n: number }>(
          "select count(*)::int as n from ledger.record_events where row_kind = 'hypothesis' and row_id = $1",
          [retired],
        ),
      ).toEqual(events);
      // A hypothesis that is no lesson, and an id that names nothing, are not found.
      const idea = testId("hyp");
      await expect(withAdmin(w, (admin) => admin.work.retireLesson(idea as HypothesisId))).rejects.toMatchObject({
        code: "not_found",
      });
    }));

  // A lesson is not among the cases that read gives (it reads every hypothesis but a lesson), so
  // this pins that a retired lesson is never given back as a case that is still open.
  it("a retired lesson's case stays closed in the closed-case read", () =>
    withWorkWorld(async (w) => {
      const reasoner = await w.client("thinker", OWN, { kind: "reasoner" });
      const lesson = await ownerLesson(w, "a lesson the owner retires with a note");
      await withAdmin(w, (admin) => admin.work.retireLesson(lesson, { note: "too broad" }));
      const run = await currentLessonsRun(w);
      const request = ok(await w.work.nextRun(reasoner.token, { requestId: testId("req") as RequestId })).run;
      expect(request?.id).toBe(run);
      for (const found of (request?.closed ?? []).filter((one) => one.id === lesson))
        expect(found.status).toBe("retired");
      expect((request?.open ?? []).map((one) => one.id as string)).not.toContain(lesson);
      expect((request?.lessons ?? []).map((one) => one.id as string)).not.toContain(lesson);
    }));

  // The lessons block a lessons run is shown is the set finish_run accepts a
  // supersedes from: the lessons its row was given, still in force, and none confirmed since.
  it("a lessons run is shown exactly the lessons in its row that are still in force", () =>
    withWorkWorld(async (w) => {
      const reasoner = await w.client("thinker", OWN, { kind: "reasoner" });
      const given = await ownerLesson(w, "given to the run");
      const retiredSince = await ownerLesson(w, "given, then retired");
      const run = await currentLessonsRun(w, [given, retiredSince]);
      const later = await ownerLesson(w, "confirmed after the run was queued");
      await withAdmin(w, (admin) => admin.work.retireLesson(retiredSince));
      const request = ok(await w.work.nextRun(reasoner.token, { requestId: testId("req") as RequestId })).run;
      expect(request?.id).toBe(run);
      const shown = (request?.lessons ?? []).map((one) => one.id as string);
      expect(shown).toEqual([given]);
      expect(shown).not.toContain(later);
    }));

  it("an existing lesson with null selectors reaches every brief", () =>
    withWorkWorld(async (w) => {
      const id = testId("hyp");
      await w.admin("select ledger.add_owner_lesson($1, $2, $3::jsonb)", [
        id,
        testId("req"),
        sealed(w, "ledger.hypotheses", id, "a lesson from before 0141"),
      ]);
      expect(
        await w.admin("select applies_kinds, applies_roles, supersedes from ledger.hypotheses where id = $1", [id]),
      ).toEqual([{ applies_kinds: null, applies_roles: null, supersedes: null }]);
      const scout = await agent(w, "scout", ["investigate", "follow_up"], ["scout"]);
      const plain = await agent(w, "plain", ["investigate", "follow_up"]);
      for (const { client, intent } of [scout, plain]) {
        for (const kind of ["investigate", "follow_up"] as const) {
          expect(servedOf((await claimed(w, client, intent, kind)).brief, [id]), `${client.name} ${kind}`).toEqual([
            id,
          ]);
        }
      }
    }));

  it("finish_run answers bad_output for a supersedes id not in the run's lessons, and writes none of its rows", () =>
    withWorkWorld(async (w) => {
      const reasoner = await w.client("thinker", OWN, { kind: "reasoner" });
      const given = await ownerLesson(w, "a lesson the run was given");
      const notGiven = await ownerLesson(w, "a lesson in force the run was not given");
      const run = await taken(w, reasoner, "personal_lessons", [given]);
      // One well-formed lesson beside the bad one: neither is written.
      expect(
        await finish(w, reasoner, run, [lessonAction(w, given), lessonAction(w, given, { supersedes: notGiven })]),
      ).toEqual({ recorded: 0, outcome: "failed" });
      expect(await latestOf(w, "run", run)).toEqual({ event: "failed", by: `run:${run}`, code: "bad_output" });
      expect(await w.admin("select id from ledger.hypotheses where run_id = $1", [run])).toEqual([]);
      expect(await w.admin("select id from ledger.cases where run_id = $1", [run])).toEqual([]);
      expect(await w.admin("select id from ledger.decision_point_calls where run_id = $1", [run])).toEqual([]);
      expect(
        await w.admin(
          "select event from ledger.record_events where row_kind = 'run' and row_id = $1 and event = 'finished'",
          [run],
        ),
      ).toEqual([]);
      expect(await latestOf(w, "hypothesis", notGiven)).toEqual({ event: "confirmed", by: "owner", code: null });

      // A run given no lessons supersedes none, and an id that names nothing is no better.
      const bare = await taken(w, reasoner, "personal_lessons", null);
      expect(await finish(w, reasoner, bare, [lessonAction(w, given, { supersedes: given })])).toEqual({
        recorded: 0,
        outcome: "failed",
      });
      const ghost = await taken(w, reasoner, "personal_lessons", [given]);
      expect(await finish(w, reasoner, ghost, [lessonAction(w, given, { supersedes: testId("hyp") })])).toEqual({
        recorded: 0,
        outcome: "failed",
      });

      // Selectors and supersedes are a lesson's alone: on an idea they are refused, and nothing is written.
      const message = await w.message();
      const ideas = await taken(w, reasoner, "personal_ideas", null);
      const idea = (extra: Record<string, unknown>) => {
        const id = testId("hyp");
        return {
          do: "idea",
          id,
          about_kind: "message",
          about_id: message.id,
          ref_kinds: ["message"],
          ref_ids: [message.id],
          body_enc: envelope(w, "ledger.hypotheses", id, "a made-up idea"),
          ...extra,
        };
      };
      expect(await finish(w, reasoner, ideas, [idea({ applies_kinds: ["reply"] })])).toBe("22023");
      expect(await finish(w, reasoner, ideas, [idea({ applies_roles: ["scout"] })])).toBe("22023");
      expect(await w.admin("select id from ledger.hypotheses where run_id = $1", [ideas])).toEqual([]);

      // The control: the id the run was given is taken, with the lesson's selectors.
      const good = await taken(w, reasoner, "personal_lessons", [given]);
      const action = lessonAction(w, given, {
        supersedes: given,
        applies_kinds: ["follow_up", "reply"],
        applies_roles: ["scout"],
      });
      expect(await finish(w, reasoner, good, [action])).toEqual({ recorded: 1, outcome: "finished" });
      expect(
        await w.admin(
          "select id, kind, applies_kinds, applies_roles, supersedes from ledger.hypotheses where run_id = $1",
          [good],
        ),
      ).toEqual([
        {
          id: action.id,
          kind: "lesson",
          applies_kinds: ["follow_up", "reply"],
          applies_roles: ["scout"],
          supersedes: given,
        },
      ]);
    }));

  it("the owner's confirm of a superseding lesson writes retired on the one it names", () =>
    withWorkWorld(async (w) => {
      const reasoner = await w.client("thinker", OWN, { kind: "reasoner" });
      const old = await ownerLesson(w, "the lesson in force");
      const bystander = await ownerLesson(w, "another lesson in force");
      const run = await taken(w, reasoner, "personal_lessons", [old, bystander]);
      const replacing = lessonAction(w, old, { supersedes: old, applies_kinds: ["follow_up"] });
      const plain = lessonAction(w, old);
      expect(await finish(w, reasoner, run, [replacing, plain])).toEqual({ recorded: 2, outcome: "finished" });
      // Each new lesson's card, raised as the tick raises one.
      const cards = await session(w.db.urls.work, async (query) => {
        await query("begin");
        const raised = [
          await raisePlannerCard(query, replacing.id as HypothesisId, "lesson", new Date()),
          await raisePlannerCard(query, plain.id as HypothesisId, "lesson", new Date()),
        ];
        await query("commit");
        return raised;
      });
      expect(cards.every((card) => card !== null)).toBe(true);
      await withAdmin(w, async (admin) => {
        // A lesson with no supersedes, confirmed, retires nothing.
        await admin.cards.decide({ cards: [cards[1] as never], answer: "confirm", requestId: testId("req") });
        expect(await latestOf(w, "hypothesis", plain.id)).toEqual({ event: "confirmed", by: "owner", code: null });
        expect(await latestOf(w, "hypothesis", old)).toEqual({ event: "confirmed", by: "owner", code: null });
        // The superseding one's confirm retires the one it names, and no other.
        await admin.cards.decide({ cards: [cards[0] as never], answer: "confirm", requestId: testId("req") });
      });
      expect(await latestOf(w, "hypothesis", replacing.id)).toEqual({ event: "confirmed", by: "owner", code: null });
      expect(await latestOf(w, "hypothesis", old)).toEqual({ event: "retired", by: "owner", code: null });
      expect(await latestOf(w, "hypothesis", bystander)).toEqual({ event: "confirmed", by: "owner", code: null });
      expect(
        one(
          await w.admin<{ n: number }>(
            "select count(*)::int as n from ledger.record_events where row_kind = 'hypothesis' and event = 'retired'",
          ),
        ),
      ).toEqual({ n: 1 });
      // The retired one is in no brief; the one that replaced it is, for its kind.
      const { client, intent } = await agent(w, "worker", ["follow_up", "investigate"]);
      const mine = [old, bystander, replacing.id, plain.id];
      expect(servedOf((await claimed(w, client, intent, "follow_up")).brief, mine)).toEqual(
        [bystander, replacing.id, plain.id].sort(),
      );
      expect(servedOf((await claimed(w, client, intent, "investigate")).brief, mine)).toEqual(
        [bystander, plain.id].sort(),
      );
    }));
});
