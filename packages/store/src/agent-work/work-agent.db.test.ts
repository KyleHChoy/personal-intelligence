import type { ProposableKind, ReadOutcome } from "@intelligence/contracts/personal";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { Admin } from "../admin/admin.ts";
import { openUnder, sealUnder } from "../core/seal.ts";
import { request, testId } from "../test-support/clients.ts";
import { one, readAs, session } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import { triedFor } from "../test-support/paid-questions.ts";
import { callLog } from "../test-support/store.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { interactionId } from "../test-support/values.ts";
import type { WorkClient } from "../test-support/work-clients.ts";
import { agentWithGrants as agent } from "../test-support/work-seeds.ts";
import { ok, type WorkWorld, withWorkWorld } from "../test-support/work-test-world.ts";

// An agent is briefed on what it claims; report_move checks what done means for
// the opportunity's kind, answering fixed codes and recording nothing; a report on people work
// that cites nobody the owner has a path to is marked web_only; and plan_move gives one move.

const BOTH = ["employer:example", "own"];
const code = (outcome: ReadOutcome<unknown>): string => (outcome.ok ? "ok" : outcome.code);
const REPORT = {
  deliverable: "three people, each with the thread that shows the tie",
  next: "ask the owner which one to approach",
};

// One committed statement as pi_owner, as the definer functions write.
const asOwner = (w: WorkWorld, text: string, values: unknown[]): Promise<unknown> =>
  session(w.db.urls.bootstrap, async (query) => {
    await query("begin");
    await query("set local role pi_owner");
    await query(text, values);
    await query("commit");
  });

const sealed = (
  w: WorkWorld,
  compartments: string[],
  at: { table: string; id: string; column: string },
  text: string,
): string => JSON.stringify(sealUnder(w.db.keys, [...new Set(compartments)].sort(), at, text));

// A hypothesis a run wrote, of the planner's kinds, with its own case.
async function plannerHypothesis(
  w: WorkWorld,
  kind: "idea" | "lesson",
  text: string,
  about: [string, string] | "owner",
  compartments = ["own"],
): Promise<string> {
  const label = [...new Set(compartments)].sort();
  const run = testId("run");
  const [aboutKind, aboutId] = about === "owner" ? ["owner", null] : about;
  // Two lessons about the owner under one label share their case, as the run's would.
  const [found] = await w.admin<{ id: string }>(
    "select id from ledger.cases where row_kind = 'hypothesis' and kind = $1 and about_kind = $2 and about_id is not distinct from $3 and author = 'run' and compartments = $4",
    [kind, aboutKind, aboutId, label],
  );
  const caseId = found?.id ?? testId("cas");
  if (found === undefined) {
    await asOwner(
      w,
      "insert into ledger.cases (id, request_id, created_by, run_id, compartments, row_kind, kind, about_kind, about_id, author) values ($1, $1, $2, $3, $4, 'hypothesis', $5, $6, $7, 'run')",
      [caseId, `run:${run}`, run, label, kind, aboutKind, aboutId],
    );
  }
  const id = testId("hyp");
  await asOwner(
    w,
    `insert into ledger.hypotheses (id, request_id, created_by, run_id, compartments, case_id, kind, about_kind, about_id, about_owner, body_enc)
     values ($1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
    [
      id,
      `run:${run}`,
      run,
      label,
      caseId,
      kind,
      aboutKind,
      aboutId,
      about === "owner",
      sealed(w, label, { table: "ledger.hypotheses", id, column: "body_enc" }, text),
    ],
  );
  await w.status("hypothesis", id, "open", `run:${run}`);
  return id;
}

// An opportunity a client proposed that serves a goal and rests on a hypothesis, as the
// planner's translate run writes one, decided go.
async function servingOpportunity(
  w: WorkWorld,
  client: WorkClient,
  intent: string,
  options: { goal: string; hypothesis: string; about: [string, string]; summary: string },
): Promise<string> {
  const author = `client:${client.id}`;
  const caseId = testId("cas");
  await asOwner(
    w,
    "insert into ledger.cases (id, request_id, created_by, compartments, row_kind, kind, about_kind, about_id, author, hypothesis_id) values ($1, $1, $2, '{own}', 'opportunity', 'investigate', $3, $4, $2, $5)",
    [caseId, author, options.about[0], options.about[1], options.hypothesis],
  );
  const id = testId("opp");
  await asOwner(
    w,
    `insert into ledger.opportunities (id, request_id, created_by, compartments, case_id, kind, hypothesis_id, about_kind, about_id, goal_id, proposed_by_class, body_enc)
     values ($1, $1, $2, '{own}', $3, 'investigate', $4, $5, $6, $7, 'client', $8::jsonb)`,
    [
      id,
      author,
      caseId,
      options.hypothesis,
      options.about[0],
      options.about[1],
      options.goal,
      sealed(w, ["own"], { table: "ledger.opportunities", id, column: "body_enc" }, options.summary),
    ],
  );
  await asOwner(w, "select ledger.add_basis('opportunity', $1, '{own}', $2, $3, null)", [
    id,
    [options.about[0]],
    [options.about[1]],
  ]);
  await w.status("opportunity", id, "proposed", author);
  await w.decideGo(id, intent);
  return id;
}

// An opportunity a client proposes about one ref, decided go, claimed and its first stage planned.
async function planned(
  w: WorkWorld,
  client: WorkClient,
  intent: string,
  kind: ProposableKind,
  about: { kind: "message" | "entity"; id: string },
  stage = "investigate",
): Promise<{ opportunity: string; move: string }> {
  const ref = about as never;
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
  ok(await w.work.claimOpportunity(client.token, { id: opportunity, requestId: request() }));
  const { move } = ok(
    await w.work.planMove(client.token, { opportunity, stage: stage as never, requestId: request() }),
  );
  return { opportunity, move };
}

const moveEvents = (w: WorkWorld, move: string) =>
  w
    .admin<{ event: string }>(
      "select event from ledger.record_events where row_kind = 'move' and row_id = $1 order by id",
      [move],
    )
    .then((rows) => rows.map((row) => row.event));

const openedBody = async (w: WorkWorld, move: string): Promise<unknown> => {
  const event = one(
    await w.admin<{ compartments: string[]; body_enc: unknown }>(
      "select compartments, body_enc from ledger.record_events where row_kind = 'move' and row_id = $1 and event = 'reported'",
      [move],
    ),
  );
  return JSON.parse(
    openUnder(
      w.db.keys,
      event.compartments,
      { table: "ledger.record_events", id: `${move}/reported`, column: "body_enc" },
      event.body_enc as never,
    ),
  );
};

describe("the brief, what done means, and one move", { timeout: DB_TEST_TIMEOUT }, () => {
  it("a claim and the caller's own list carry the brief: summary, goal, idea, the lessons the owner confirmed within the clearance, the answer from the owner and note on a related case, and what done needs", () =>
    withWorkWorld(async (w) => {
      const { client, intent } = await agent(w, "worker", [
        ["investigate", "investigate"],
        ["follow_up", "investigate"],
      ]);
      const goal = await w.goal(["own"], "meet more builders");
      const message = await w.message();
      const idea = await plannerHypothesis(
        w,
        "idea",
        "ask the introducer for a warm intro\nwhy: they share a thread\ntest: one intro in a week\nconfidence: 0.6",
        ["message", message.id],
      );
      const lesson = await plannerHypothesis(w, "lesson", "introductions through people he already knows", "owner");
      await w.status("hypothesis", lesson, "confirmed", "owner");
      // A lesson the owner confirmed under a compartment the agent lacks, and one they did not confirm.
      const wide = await plannerHypothesis(w, "lesson", "a lesson at work", "owner", BOTH);
      await w.status("hypothesis", wide, "confirmed", "owner");
      await plannerHypothesis(w, "lesson", "a lesson still on its card", "owner");
      // A related case the owner declined with a note, of the same kind; an unrelated one they declined.
      const earlier = await w.message();
      const declined = ok(
        await w.work.proposeOpportunity(client.token, {
          kind: "investigate",
          about: { kind: "message", id: earlier.id as never },
          summary: "an earlier search",
          basis: [{ kind: "message", id: earlier.id as never }],
          requestId: request(),
        }),
      ).opportunity;
      await queryAs(
        w.db.urls.work,
        "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments, body_enc) values ('opportunity', $1, 'no_go', clock_timestamp(), 'owner', '{own}', $2::jsonb)",
        [
          declined,
          sealed(
            w,
            ["own"],
            { table: "ledger.record_events", id: `${declined}/no_go`, column: "body_enc" },
            "no cold outreach",
          ),
        ],
      );
      const other = await w.message();
      const unrelated = ok(
        await w.work.proposeOpportunity(client.token, {
          kind: "follow_up",
          about: { kind: "message", id: other.id as never },
          summary: "follow up an unrelated message",
          basis: [{ kind: "message", id: other.id as never }],
          requestId: request(),
        }),
      ).opportunity;
      await w.status("opportunity", unrelated, "no_go", "owner");

      const opportunity = await servingOpportunity(w, client, intent, {
        goal,
        hypothesis: idea,
        about: ["message", message.id],
        summary: "find a warm intro",
      });
      // Before the claim the agent cannot read the goal; the reasoner alone could.
      expect(await readAs(w.db, client.token, (query) => query("select goal_id from projections.goal_state"))).toEqual(
        [],
      );
      const claimed = ok(
        await w.work.claimOpportunity(client.token, { id: opportunity as never, requestId: request() }),
      );
      const brief = {
        kind: "investigate",
        summary: { untrusted: "find a warm intro" },
        goal: { id: goal, statement: { untrusted: "meet more builders" } },
        hypothesis: {
          id: idea,
          kind: "idea",
          summary: { untrusted: "ask the introducer for a warm intro" },
          why: { untrusted: "they share a thread" },
          test: { untrusted: "one intro in a week" },
        },
        lessons: [{ id: lesson, lesson: { untrusted: "introductions through people he already knows" } }],
        preferences: [],
        cases: [
          expect.objectContaining({
            id: declined,
            rowKind: "opportunity",
            status: "no_go",
            decision: "no_go",
            note: { untrusted: "no cold outreach" },
          }),
        ],
        done: ["deliverable", "next"],
        // What done needs, in words.
        doneSays: [
          "report.deliverable: the answer, brief or result asked for, naming people and things, never ids.",
          "report.next: what should happen now, and who should do it.",
        ],
      };
      expect(claimed.brief).toEqual(brief);
      const mine = ok(await w.work.listOpportunities(client.token, { scope: "mine" })).opportunities;
      expect(mine.map((one) => [one.id, one.brief])).toEqual([[opportunity, brief]]);
      // The read log names the goal the claim and the list returned.
      expect(
        await w.admin(
          "select tool, goals from ledger.read_log where client_id = $1 and tool in ('claim_opportunity', 'list_opportunities') order by id",
          [client.id],
        ),
      ).toEqual([
        { tool: "claim_opportunity", goals: [goal] },
        { tool: "list_opportunities", goals: [goal] },
      ]);
      // The open list carries no brief.
      expect(
        ok(await w.work.listOpportunities(client.token, {})).opportunities.every((one) => one.brief === undefined),
      ).toBe(true);
      // The goal is the lease holder's to read while it holds the lease, and no one else's.
      expect(await readAs(w.db, client.token, (query) => query("select goal_id from projections.goal_state"))).toEqual([
        { goal_id: goal },
      ]);
      const outsider = await w.client("outsider", ["own"], {
        tools: ["get_self", "list_opportunities", "claim_opportunity"],
      });
      expect(
        await readAs(w.db, outsider.token, (query) => query("select goal_id from projections.goal_state")),
      ).toEqual([]);
      ok(await w.work.releaseOpportunity(client.token, { id: opportunity as never, requestId: request() }));
      expect(await readAs(w.db, client.token, (query) => query("select goal_id from projections.goal_state"))).toEqual(
        [],
      );
      // Its counts are logged, and no text.
      expect(w.log.events.filter((event) => event.event === "work_brief").at(-1)).toEqual({
        event: "work_brief",
        counts: { lessons: 1, preferences: 0, cases: 1 },
      });
    }));

  // The brief list reads every view's cases in one batch: each brief is the one its claim gave,
  // with its own related case and not the other's.
  it("the caller's own list gives each opportunity the brief its claim gave, its related cases its own", () =>
    withWorkWorld(async (w) => {
      const { client, intent } = await agent(w, "lister", [
        ["investigate", "investigate"],
        ["follow_up", "investigate"],
      ]);
      const held = async (
        kind: "investigate" | "follow_up",
        note: string,
      ): Promise<{ id: string; declined: string; brief: unknown }> => {
        const about = await w.message();
        const ref = { kind: "message" as const, id: about.id as never };
        const declined = ok(
          await w.work.proposeOpportunity(client.token, {
            kind,
            about: ref,
            summary: `declined ${kind} on the cited message`,
            basis: [ref],
            requestId: request(),
          }),
        ).opportunity;
        await queryAs(
          w.db.urls.work,
          "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments, body_enc) values ('opportunity', $1, 'no_go', clock_timestamp(), 'owner', '{own}', $2::jsonb)",
          [
            declined,
            sealed(w, ["own"], { table: "ledger.record_events", id: `${declined}/no_go`, column: "body_enc" }, note),
          ],
        );
        const id = ok(
          await w.work.proposeOpportunity(client.token, {
            kind,
            about: ref,
            summary: `open ${kind} on the cited message`,
            basis: [ref],
            requestId: request(),
          }),
        ).opportunity;
        await w.decideGo(id, intent);
        const claimed = ok(await w.work.claimOpportunity(client.token, { id: id as never, requestId: request() }));
        return { id, declined, brief: claimed.brief };
      };
      const first = await held("investigate", "not this way");
      const second = await held("follow_up", "too soon");
      for (const [one, other] of [
        [first, second],
        [second, first],
      ] as const) {
        expect((one.brief as { cases: { id: string }[] }).cases.map((found) => found.id)).toContain(one.declined);
        expect((one.brief as { cases: { id: string }[] }).cases.map((found) => found.id)).not.toContain(other.declined);
      }
      const mine = ok(await w.work.listOpportunities(client.token, { scope: "mine" })).opportunities;
      expect(new Map(mine.map((one) => [one.id, one.brief]))).toEqual(
        new Map([
          [first.id, first.brief],
          [second.id, second.brief],
        ]),
      );
    }));

  it("report_move answers fixed codes and records nothing for a report that lacks what done needs, and records one that has it", () =>
    withWorkWorld(async (w) => {
      const { client, intent } = await agent(w, "reporter", [
        ["investigate", "investigate"],
        ["follow_up", "investigate"],
        ["owner_question", "investigate"],
      ]);
      // investigate: a deliverable and a next step; failed and blocked, a reason.
      const work = await planned(w, client, intent, "investigate", { kind: "message", id: (await w.message()).id });
      expect(
        ok(
          await w.work.reportMove(client.token, {
            move: work.move as never,
            outcome: "done",
            summary: "done",
            requestId: request(),
          }),
        ),
      ).toEqual({ move: work.move, refused: ["needs_deliverable", "needs_next"] });
      expect(
        ok(
          await w.work.reportMove(client.token, {
            move: work.move as never,
            outcome: "done",
            report: { deliverable: " ", next: "x" },
            requestId: request(),
          }),
        ),
      ).toEqual({ move: work.move, refused: ["needs_deliverable"] });
      expect(
        ok(
          await w.work.reportMove(client.token, { move: work.move as never, outcome: "blocked", requestId: request() }),
        ),
      ).toEqual({ move: work.move, refused: ["needs_reason"] });
      expect(await moveEvents(w, work.move)).toEqual(["cleared"]);
      expect((await callLog(w.db.urls.admin)).at(-1)).toEqual({
        client: "reporter",
        tool: "report_move",
        rows: 0,
        outcome: "invalid_request",
      });
      expect(
        ok(
          await w.work.reportMove(client.token, {
            move: work.move as never,
            outcome: "done",
            report: REPORT,
            requestId: request(),
          }),
        ),
      ).toEqual({ move: work.move, opportunity: "done" });
      expect(await openedBody(w, work.move)).toEqual({ v: 1, report: REPORT, marks: [] });

      // follow_up: its investigate move is done with the draft, which pi work show shows.
      const follow = await planned(w, client, intent, "follow_up", { kind: "message", id: (await w.message()).id });
      expect(
        ok(
          await w.work.reportMove(client.token, {
            move: follow.move as never,
            outcome: "done",
            report: REPORT,
            requestId: request(),
          }),
        ),
      ).toEqual({ move: follow.move, refused: ["needs_draft"] });
      const draft = "Thanks for the call; here is the deck we discussed.";
      expect(
        ok(
          await w.work.reportMove(client.token, {
            move: follow.move as never,
            outcome: "done",
            report: { draft },
            requestId: request(),
          }),
        ),
      ).toEqual({ move: follow.move, opportunity: "handed_to_owner" });
      const pool = new pg.Pool({ connectionString: w.db.urls.admin, max: 2 });
      try {
        const shown = (await new Admin({ pool, keys: w.db.keys, log: w.log }).work.showWork(follow.move)) as {
          reports: unknown[];
        };
        expect(shown.reports).toEqual([{ at: expect.any(String), summary: null, report: { draft }, marks: [] }]);
      } finally {
        await pool.end();
      }

      // owner_question: never done here, in the store or in the function; blocked with a reason hands it back.
      const asked = await w.message();
      const about = { kind: "message" as const, id: asked.id as never };
      const { hypothesis } = ok(
        await w.work.proposeHypothesis(client.token, {
          kind: "open_loop",
          about,
          summary: "an open loop in the cited message",
          basis: [about],
          requestId: request(),
        }),
      );
      const { opportunity } = ok(
        await w.work.proposeOpportunity(client.token, {
          kind: "owner_question",
          about,
          summary: "what do you know of the cited message?",
          basis: [about],
          hypothesis,
          // A question to the owner pays up front.
          tried: await triedFor(w, client),
          requestId: request(),
        }),
      );
      await w.decideGo(opportunity, intent);
      ok(await w.work.claimOpportunity(client.token, { id: opportunity, requestId: request() }));
      const { move } = ok(
        await w.work.planMove(client.token, { opportunity, stage: "investigate", requestId: request() }),
      );
      expect(
        ok(await w.work.reportMove(client.token, { move, outcome: "done", report: REPORT, requestId: request() })),
      ).toEqual({ move, refused: ["ask_owner"] });
      const direct = await readAs(w.db, client.token, (query) =>
        query<{ status: string | null }>(
          "select ledger.report_move($1::text, 'done', $2::text, $3::text, null, '{}'::text[], '{}'::text[]) as status",
          [move, testId("req"), client.session],
        ),
      );
      expect(direct).toEqual([{ status: null }]);
      expect(await moveEvents(w, move)).toEqual(["cleared"]);
      expect(
        ok(
          await w.work.reportMove(client.token, {
            move,
            outcome: "blocked",
            report: { reason: "the owner did not answer" },
            requestId: request(),
          }),
        ),
      ).toEqual({ move, opportunity: "handed_to_owner" });
    }));

  it("a report on people work that cites nobody the owner has a path to is recorded and marked web_only; other work is not marked", () =>
    withWorkWorld(async (w) => {
      const { client, intent } = await agent(w, "finder", [["investigate", "investigate"]]);
      const account = await w.seed.account(["own"]);
      const person = one(
        await w.admin<{ entity_id: string }>("select entity_id from knowledge.accounts where id = $1", [account]),
      ).entity_id;
      const people = await planned(w, client, intent, "investigate", { kind: "entity", id: person });
      const report = { ...REPORT, candidates: ["a name from a web page"], sources: ["a web page's title"] };
      expect(
        ok(
          await w.work.reportMove(client.token, {
            move: people.move as never,
            outcome: "done",
            report,
            requestId: request(),
          }),
        ),
      ).toEqual({ move: people.move, opportunity: "done", marks: ["web_only"] });
      expect(await openedBody(w, people.move)).toEqual({ v: 1, report, marks: ["web_only"] });
      expect(w.log.events.filter((event) => event.event === "report_marked")).toEqual([
        { event: "report_marked", code: "web_only" },
      ]);
      // Work about a message, naming no candidate, is not people work.
      const other = await planned(w, client, intent, "investigate", { kind: "message", id: (await w.message()).id });
      expect(
        ok(
          await w.work.reportMove(client.token, {
            move: other.move as never,
            outcome: "done",
            report: REPORT,
            requestId: request(),
          }),
        ),
      ).toEqual({ move: other.move, opportunity: "done" });
      // Blocked people work delivers nothing to mark.
      const blocked = await planned(w, client, intent, "investigate", { kind: "entity", id: person });
      expect(
        ok(
          await w.work.reportMove(client.token, {
            move: blocked.move as never,
            outcome: "blocked",
            report: { ...report, reason: "no answer" },
            requestId: request(),
          }),
        ),
      ).toEqual({ move: blocked.move, opportunity: "handed_to_owner" });
      // find_paths routes to an organization through anyone at it, so one nobody the
      // owner knows is at is judged, and marked, as a person with no path is.
      const organization = await w.seed.entity("organization");
      await w.seed.domain(["own"], organization);
      const company = await planned(w, client, intent, "investigate", { kind: "entity", id: organization });
      expect(
        ok(
          await w.work.reportMove(client.token, {
            move: company.move as never,
            outcome: "done",
            report: REPORT,
            requestId: request(),
          }),
        ),
      ).toEqual({ move: company.move, opportunity: "done", marks: ["web_only"] });
      expect(w.log.events.filter((event) => event.event === "report_marked")).toHaveLength(2);
    }));

  // The pathed case: the owner wrote to the person and heard back within the year, an own tie,
  // so find_paths gives a path and the report is not marked; nor is one whose candidates name
  // such a person beside a name from a web page. A candidate the owner has no path to is marked.
  it("a report on people work about a person the owner has a path to, or naming one as a candidate, is not marked web_only", () =>
    withWorkWorld(async (w) => {
      const { client, intent } = await agent(w, "finder", [["investigate", "investigate"]]);
      const person = async (): Promise<string> =>
        one(
          await w.admin<{ entity_id: string }>("select entity_id from knowledge.accounts where id = $1", [
            await w.seed.account(["own"]),
          ]),
        ).entity_id;
      // Mail both ways in the last year, each in a message the token returns: an own tie.
      const tie = async (entity: string): Promise<void> => {
        for (const [direction, role] of [
          ["outbound", "recipient"],
          ["inbound", "sender"],
        ] as const) {
          const { evidence } = await w.message();
          await w.admin(
            `insert into knowledge.interaction_log (id, evidence_id, member_id, entity_id, direction, channel, occurred_at, entity_role, compartments, readers)
             values ($1, $2, 'm-owner', $3, $4, 'email', now() - interval '1 day', $5, '{own}', '{m-owner}')`,
            [interactionId(evidence, entity), evidence, entity, direction, role],
          );
        }
      };
      // The owner, with an address the token sees: a path starts from the owner (read-paths.ts), and
      // with none every report about a person would be marked.
      const ownerEntity = testId("ent");
      await w.admin("insert into knowledge.entities (id, kind) values ($1, 'owner')", [ownerEntity]);
      await w.seed.account(["own"], ownerEntity);
      const known = await person();
      await tie(known);
      const stranger = await person();

      const about = await planned(w, client, intent, "investigate", { kind: "entity", id: known });
      const sourced = { ...REPORT, sources: ["a web page's title"] };
      expect(
        ok(
          await w.work.reportMove(client.token, {
            move: about.move as never,
            outcome: "done",
            report: sourced,
            requestId: request(),
          }),
        ),
      ).toEqual({ move: about.move, opportunity: "done" });
      expect(await openedBody(w, about.move)).toEqual({ v: 1, report: sourced, marks: [] });

      const named = await planned(w, client, intent, "investigate", { kind: "entity", id: stranger });
      const withPath = {
        ...REPORT,
        candidates: ["a name from a web page", { kind: "entity" as const, id: known as never }],
      };
      expect(
        ok(
          await w.work.reportMove(client.token, {
            move: named.move as never,
            outcome: "done",
            report: withPath,
            requestId: request(),
          }),
        ),
      ).toEqual({ move: named.move, opportunity: "done" });
      expect(w.log.events.filter((event) => event.event === "report_marked")).toEqual([]);

      // The control: candidates that name only a person the owner has no path to are marked.
      const unknown = await planned(w, client, intent, "investigate", { kind: "entity", id: stranger });
      const noPath = { ...REPORT, candidates: [{ kind: "entity" as const, id: stranger as never }] };
      expect(
        ok(
          await w.work.reportMove(client.token, {
            move: unknown.move as never,
            outcome: "done",
            report: noPath,
            requestId: request(),
          }),
        ),
      ).toEqual({ move: unknown.move, opportunity: "done", marks: ["web_only"] });
    }));

  it("the owner adds a lesson in their own words, confirmed at once: it reaches the brief, a repeat adds none, and pi_admin inserts no other hypothesis", () =>
    withWorkWorld(async (w) => {
      const pool = new pg.Pool({ connectionString: w.db.urls.admin, max: 2 });
      try {
        const admin = new Admin({ pool, keys: w.db.keys, log: w.log });
        const text = "Introductions go through people the owner already knows.";
        const requestId = testId("req");
        const lesson = await admin.work.addLesson(text, { requestId });
        expect(await admin.work.addLesson(text, { requestId })).toBe(lesson);
        const events = await w.admin<{ event: string; by: string }>(
          "select event, by from ledger.record_events where row_kind = 'hypothesis' and row_id = $1 order by id",
          [lesson],
        );
        expect(events).toEqual([
          { event: "open", by: "owner" },
          { event: "confirmed", by: "owner" },
        ]);
        await expect(admin.work.addLesson(" ", { requestId: testId("req") })).rejects.toThrow();
        const { client, intent } = await agent(w, "learner", [["investigate", "investigate"]]);
        const work = await planned(w, client, intent, "investigate", { kind: "message", id: (await w.message()).id });
        const mine = ok(await w.work.listOpportunities(client.token, { scope: "mine" }));
        const brief = mine.opportunities.find((one) => one.id === work.opportunity)?.brief;
        expect(brief?.lessons).toEqual([{ id: lesson, lesson: { untrusted: text } }]);
        // The policy takes the owner's lesson and nothing else.
        await expect(
          queryAs(
            w.db.urls.admin,
            "insert into ledger.cases (id, request_id, created_by, compartments, row_kind, kind, about_kind, about_id, author) values ($1, $1, 'owner', '{own}', 'hypothesis', 'idea', 'owner', null, 'owner')",
            [testId("cas")],
          ),
        ).rejects.toThrow();
      } finally {
        await pool.end();
      }
    }));

  it("plan_move asked again while the caller's move of that stage is cleared and unreported answers that move and writes nothing", () =>
    withWorkWorld(async (w) => {
      const { client, intent } = await agent(w, "planner", [["investigate", "investigate"]]);
      const { opportunity, move } = await planned(w, client, intent, "investigate", {
        kind: "message",
        id: (await w.message()).id,
      });
      const again = request();
      expect(
        ok(
          await w.work.planMove(client.token, {
            opportunity: opportunity as never,
            stage: "investigate",
            requestId: again,
          }),
        ),
      ).toEqual({ move });
      expect(
        ok(
          await w.work.planMove(client.token, {
            opportunity: opportunity as never,
            stage: "investigate",
            requestId: again,
          }),
        ),
      ).toEqual({ move });
      expect(
        await w.admin("select count(*)::int as n from ledger.moves where opportunity_id = $1", [opportunity]),
      ).toEqual([{ n: 1 }]);
      expect(
        await w.admin(
          "select count(*)::int as n from ledger.decision_point_calls where point = 'move_clear' and subject_id = $1",
          [opportunity],
        ),
      ).toEqual([{ n: 1 }]);
      // Reported, the stage is done: a new plan is refused as before.
      ok(
        await w.work.reportMove(client.token, {
          move: move as never,
          outcome: "done",
          report: REPORT,
          requestId: request(),
        }),
      );
      expect(
        code(
          await w.work.planMove(client.token, {
            opportunity: opportunity as never,
            stage: "investigate",
            requestId: request(),
          }),
        ),
      ).toBe("not_permitted");
      // Another client's cleared move is never handed out: it holds no lease, so it is refused.
      const other = await w.client("other");
      expect(
        code(
          await w.work.planMove(other.token, {
            opportunity: opportunity as never,
            stage: "investigate",
            requestId: request(),
          }),
        ),
      ).toBe("not_permitted");
    }));
});
