import type {
  HypothesisId,
  MoveId,
  OpportunityId,
  ProposableKind,
  ReadOutcome,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { openUnder } from "../core/seal.ts";
import { request } from "../test-support/clients.ts";
import { one, session } from "../test-support/connections.ts";
import { queryAs, scanForPlaintext } from "../test-support/database.ts";
import { callLog } from "../test-support/store.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import type { WorkClient } from "../test-support/work-clients.ts";
import { agentWithGrants as agent } from "../test-support/work-seeds.ts";
import { type Message, ok, type WorkWorld, withWorkWorld } from "../test-support/work-test-world.ts";

// Work for clients, through the reader's call path, on a real database. Clients, intents, harness
// modes and the owner's decisions are written in SQL as pi_admin and pi_work; every work call is
// made through Work with a token. Every refusal has its positive control.

const BOTH = ["own", "employer:example"];
const code = (outcome: ReadOutcome<unknown>): string => (outcome.ok ? "ok" : outcome.code);
const missing = (prefix: string): string => `${prefix}_${"0".repeat(26)}`;
// A done report of an investigate, goal_step, life_admin or meeting_prep move
// carries a deliverable and a next step.
const REPORT = { deliverable: "what was found", next: "what comes next" };
// A recorded report's status, or the codes of a refused one.
const statusOf = (reported: { opportunity: string } | { refused: string[] }): string =>
  "opportunity" in reported ? reported.opportunity : `refused ${reported.refused.join(",")}`;

type Proposed = { id: OpportunityId; message: Message };

// An opportunity a client proposes about a fresh message of its own label, citing it.
async function propose(
  w: WorkWorld,
  client: WorkClient,
  kind: ProposableKind = "investigate",
  summary = "look into the delivery date",
): Promise<Proposed> {
  const message = await w.message(client.compartments);
  const ref = { kind: "message" as const, id: message.id as never };
  const value = ok(
    await w.work.proposeOpportunity(client.token, { kind, about: ref, summary, basis: [ref], requestId: request() }),
  );
  return { id: value.opportunity as OpportunityId, message };
}

async function goFor(
  w: WorkWorld,
  client: WorkClient,
  intent: string,
  kind: ProposableKind = "investigate",
): Promise<Proposed> {
  const proposed = await propose(w, client, kind);
  await w.decideGo(proposed.id, intent);
  return proposed;
}

async function claimedFor(
  w: WorkWorld,
  client: WorkClient,
  intent: string,
  kind: ProposableKind = "investigate",
): Promise<Proposed> {
  const proposed = await goFor(w, client, intent, kind);
  ok(await w.work.claimOpportunity(client.token, { id: proposed.id, requestId: request() }));
  return proposed;
}

type Logged = { session_id: string; tool: string; bound: string[]; shown: string[] };
const readLog = (w: WorkWorld, client: WorkClient): Promise<Logged[]> =>
  w.admin<Logged>("select session_id, tool, bound, shown from ledger.read_log where client_id = $1 order by id", [
    client.id,
  ]);

describe("Work, for clients", { timeout: DB_TEST_TIMEOUT }, () => {
  it("a claimed opportunity is listed under mine with its lease", () =>
    withWorkWorld(async (w) => {
      const { client, intent } = await agent(w, "lister", [["investigate", "investigate"]]);
      const { id } = await goFor(w, client, intent);
      const open = ok(await w.work.listOpportunities(client.token, {}));
      expect(open.opportunities.map((view) => [view.id, view.status, view.stage, view.leaseUntil])).toEqual([
        [id, "go", "investigate", null],
      ]);
      expect(ok(await w.work.listOpportunities(client.token, { scope: "mine" })).opportunities).toEqual([]);

      const claimed = ok(await w.work.claimOpportunity(client.token, { id, requestId: request() }));
      const mine = ok(await w.work.listOpportunities(client.token, { scope: "mine" }));
      expect(mine.opportunities).toHaveLength(1);
      expect(mine.opportunities[0]).toMatchObject({
        id,
        status: "claimed",
        stage: "investigate",
        leaseUntil: claimed.leaseUntil,
        summary: { untrusted: "look into the delivery date" },
      });
      // mine carries the brief a claim answers beside the view, and how the caller has the work.
      expect({ ...claimed.opportunity, brief: claimed.brief, held: "held" }).toEqual(mine.opportunities[0]);
      expect(ok(await w.work.listOpportunities(client.token, {})).opportunities).toEqual([]);
    }));

  it("list_opportunities opens no summary the caller's clearance lacks a key for", () =>
    withWorkWorld(async (w) => {
      const { client, intent } = await agent(w, "both", [["investigate", "investigate"]], BOTH);
      const { id } = await goFor(w, client, intent);
      expect(ok(await w.work.listOpportunities(client.token, {})).opportunities.map((view) => view.summary)).toEqual([
        { untrusted: "look into the delivery date" },
      ]);
      const keys = {
        compartments: new Map(
          [...w.db.keys.compartments].filter(([compartment]) => compartment !== "employer:example"),
        ),
        fingerprintKey: w.db.keys.fingerprintKey,
      };
      const short = w.workWith(keys).work;
      const views = ok(await short.listOpportunities(client.token, {})).opportunities;
      expect(views.map((view) => [view.id, view.summary])).toEqual([[id, null]]);
    }));

  it("a second proposal by one client for one case adds its basis and makes no second row, and a proposal on a run's case returns a new id", () =>
    withWorkWorld(async (w) => {
      const client = await w.client("proposer");
      const first = await propose(w, client);
      const second = await w.message();
      const about = { kind: "message" as const, id: first.message.id as never };
      const again = ok(
        await w.work.proposeOpportunity(client.token, {
          kind: "investigate",
          about,
          summary: "a second summary",
          basis: [{ kind: "message", id: second.id as never }],
          requestId: request(),
        }),
      );
      expect(again.opportunity).toBe(first.id);
      expect(await w.admin("select id from ledger.opportunities")).toEqual([{ id: first.id }]);
      expect(
        await w.admin("select ref_id from ledger.basis where row_kind = 'opportunity' and row_id = $1 order by id", [
          first.id,
        ]),
      ).toEqual([{ ref_id: first.message.id }, { ref_id: second.id }]);

      // The run proposes on the same message: its case is the run's, so the client's next
      // proposal is in the client's own case, and the run's row is never answered.
      const reasoner = await w.client("reasoner", ["own"], { kind: "reasoner" });
      const other = await w.message();
      const otherAbout = { kind: "message" as const, id: other.id as never };
      const run = await w.queuedRun(["own"], [["message", other.id]]);
      expect(ok(await w.work.nextRun(reasoner.token, { requestId: request() })).run?.id).toBe(run);
      const finished = ok(
        await w.work.finishRun(reasoner.token, {
          run: run as never,
          outcome: "finished",
          output: {
            actions: [
              { do: "propose", kind: "investigate", about: otherAbout, summary: "the run's own", basis: [otherAbout] },
            ],
          },
          requestId: request(),
        }),
      );
      expect(finished).toEqual({ recorded: 1, outcome: "finished" });
      const runs = await w.admin<{ id: string }>("select id from ledger.opportunities where created_by = $1", [
        `run:${run}`,
      ]);
      expect(runs).toHaveLength(1);
      const mine = ok(
        await w.work.proposeOpportunity(client.token, {
          kind: "investigate",
          about: otherAbout,
          summary: "investigate the other message",
          basis: [otherAbout],
          requestId: request(),
        }),
      );
      expect(mine.opportunity).not.toBe(one(runs).id);
      expect(mine.opportunity).not.toBe(first.id);
    }));

  it("a client that is not eligible gets the list of an empty ledger", () =>
    withWorkWorld(async (w) => {
      const outsider = await w.client("outsider");
      const empty = await w.work.listOpportunities(outsider.token, {});
      const { client, intent } = await agent(w, "insider", [["investigate", "investigate"]]);
      await goFor(w, client, intent);
      await goFor(w, client, intent);
      expect(ok(await w.work.listOpportunities(client.token, {})).opportunities).toHaveLength(2);
      const full = await w.work.listOpportunities(outsider.token, {});
      expect(full).toEqual(empty);
      expect(full).toEqual({ ok: true, value: { opportunities: [] } });
      const calls = (await callLog(w.db.urls.admin)).filter((row) => row.client === "outsider");
      expect(calls).toEqual([
        { client: "outsider", tool: "list_opportunities", rows: 0, outcome: "ok" },
        { client: "outsider", tool: "list_opportunities", rows: 0, outcome: "ok" },
      ]);
      expect((await readLog(w, outsider)).map((row) => [row.bound, row.shown])).toEqual([
        [[], []],
        [[], []],
      ]);
    }));

  it("claim, release and set_intention answer not_found alike for an id that is missing, hidden, vetoed or another's", () =>
    withWorkWorld(async (w) => {
      const caller = await w.client("caller");
      const other = await w.client("other");
      const wide = await w.client("wide", BOTH);
      const intent = await w.intent(["investigate", "follow_up"], [caller, other, wide]);
      for (const client of [caller, other, wide]) {
        await w.harness(client, "investigate", "investigate");
        await w.harness(client, "follow_up", "investigate");
      }
      const hidden = await goFor(w, wide, intent);
      const vetoed = await goFor(w, caller, intent, "follow_up");
      await w.vetoKind("follow_up");
      const anothers = await claimedFor(w, other, intent);
      const ids = { missing: missing("opp"), hidden: hidden.id, vetoed: vetoed.id, anothers: anothers.id };
      const later = new Date(Date.now() + 2 * 3_600_000).toISOString();
      for (const [name, id] of Object.entries(ids)) {
        expect(
          code(await w.work.claimOpportunity(caller.token, { id: id as OpportunityId, requestId: request() })),
          name,
        ).toBe("not_found");
        expect(
          code(await w.work.releaseOpportunity(caller.token, { id: id as OpportunityId, requestId: request() })),
          name,
        ).toBe("not_found");
        expect(
          code(
            await w.work.setIntention(caller.token, {
              opportunity: id as OpportunityId,
              kind: "check_back",
              dueAt: later,
              requestId: request(),
            }),
          ),
          name,
        ).toBe("not_found");
      }
      // The positive control: the caller's own claim, check-back and release.
      const mine = await goFor(w, caller, intent);
      expect(code(await w.work.claimOpportunity(caller.token, { id: mine.id, requestId: request() }))).toBe("ok");
      expect(
        code(
          await w.work.setIntention(caller.token, {
            opportunity: mine.id,
            kind: "check_back",
            dueAt: later,
            requestId: request(),
          }),
        ),
      ).toBe("ok");
      expect(code(await w.work.releaseOpportunity(caller.token, { id: mine.id, requestId: request() }))).toBe("ok");
    }));

  it("propose_opportunity on a hidden hypothesis about the owner is not_found, and on a visible one invalid_request", () =>
    withWorkWorld(async (w) => {
      const caller = await w.client("caller");
      const wide = await w.client("wide", BOTH);
      const aboutOwner = async (client: WorkClient): Promise<HypothesisId> => {
        const message = await w.message(client.compartments);
        return ok(
          await w.work.proposeHypothesis(client.token, {
            kind: "preference",
            about: { kind: "owner" },
            summary: "the owner prefers mornings",
            basis: [{ kind: "message", id: message.id as never }],
            requestId: request(),
          }),
        ).hypothesis as HypothesisId;
      };
      const hidden = await aboutOwner(wide);
      const visible = await aboutOwner(caller);
      const args = async (hypothesis: HypothesisId) => {
        const message = await w.message();
        const ref = { kind: "message" as const, id: message.id as never };
        return {
          kind: "investigate" as const,
          about: ref,
          summary: "a step on the cited message",
          basis: [ref],
          hypothesis,
          requestId: request(),
        };
      };
      expect(code(await w.work.proposeOpportunity(caller.token, await args(hidden)))).toBe("not_found");
      expect(code(await w.work.proposeOpportunity(caller.token, await args(visible)))).toBe("invalid_request");
      // The positive control: on a hypothesis that is not about the owner.
      const message = await w.message();
      const about = { kind: "message" as const, id: message.id as never };
      const plain = ok(
        await w.work.proposeHypothesis(caller.token, {
          kind: "open_loop",
          about,
          summary: "an open loop",
          basis: [about],
          requestId: request(),
        }),
      ).hypothesis as HypothesisId;
      expect(code(await w.work.proposeOpportunity(caller.token, await args(plain)))).toBe("ok");
      expect(
        (await callLog(w.db.urls.admin))
          .filter((row) => row.client === "caller" && row.tool === "propose_opportunity")
          .map((row) => row.outcome),
      ).toEqual(["not_found", "invalid_request", "ok"]);
    }));

  it("plan_move for draft, send and pay is not_permitted", () =>
    withWorkWorld(async (w) => {
      const { client, intent } = await agent(w, "mover", [
        ["follow_up", "investigate"],
        ["follow_up", "draft"],
        ["follow_up", "send"],
      ]);
      await w.harness(client, "follow_up", "pay", "propose");
      const { id } = await claimedFor(w, client, intent, "follow_up");
      for (const stage of ["draft", "send", "pay"] as const) {
        expect(code(await w.work.planMove(client.token, { opportunity: id, stage, requestId: request() })), stage).toBe(
          "not_permitted",
        );
      }
      expect(
        code(await w.work.planMove(client.token, { opportunity: id, stage: "investigate", requestId: request() })),
      ).toBe("ok");
    }));

  it("report_move seals its summary under the reporter's clearance and moves the opportunity on: done on the last internal stage hands a follow_up to the owner and finishes a meeting_prep", () =>
    withWorkWorld(async (w) => {
      const proposer = await w.client("proposer");
      const reporter = await w.client("reporter", BOTH);
      const intent = await w.intent(["follow_up", "meeting_prep"], [reporter]);
      await w.harness(reporter, "follow_up", "investigate");
      await w.harness(reporter, "meeting_prep", "prepare");

      const outcomes: Record<string, string> = {};
      for (const [kind, stage] of [
        ["follow_up", "investigate"],
        ["meeting_prep", "prepare"],
      ] as const) {
        const { id } = await propose(w, proposer, kind);
        await w.decideGo(id, intent);
        ok(await w.work.claimOpportunity(reporter.token, { id, requestId: request() }));
        const { move } = ok(await w.work.planMove(reporter.token, { opportunity: id, stage, requestId: request() }));
        const summary = `what came of the ${kind}`;
        // A follow_up's investigate move is done with its draft, a meeting_prep's with a
        // deliverable and a next step.
        const report = kind === "follow_up" ? { draft: "a draft reply" } : REPORT;
        const reported = ok(
          await w.work.reportMove(reporter.token, { move, outcome: "done", summary, report, requestId: request() }),
        );
        outcomes[kind] = statusOf(reported);
        expect(await w.latest("opportunity", id)).toBe(statusOf(reported));
        const event = one(
          await w.admin<{ compartments: string[]; body_enc: unknown }>(
            "select compartments, body_enc from ledger.record_events where row_kind = 'move' and row_id = $1 and event = 'reported'",
            [move],
          ),
        );
        expect(event.compartments).toEqual(["employer:example", "own"]);
        const opened = openUnder(
          w.db.keys,
          event.compartments,
          { table: "ledger.record_events", id: `${move}/reported`, column: "body_enc" },
          event.body_enc as never,
        );
        expect(JSON.parse(opened)).toEqual({ v: 1, summary, report, marks: [] });
        // The status events carry the opportunity's own label.
        expect(
          await w.admin(
            "select distinct compartments from ledger.record_events where row_kind = 'opportunity' and row_id = $1",
            [id],
          ),
        ).toEqual([{ compartments: ["own"] }]);
      }
      expect(outcomes).toEqual({ follow_up: "handed_to_owner", meeting_prep: "done" });
    }));

  it("inside the 24 hours a check-back gives its setter, the open list of another client leaves the opportunity out, and the setter's lists it", () =>
    withWorkWorld(async (w) => {
      const a = await w.client("setter");
      const b = await w.client("other");
      const intent = await w.intent(["investigate"], [a, b]);
      for (const client of [a, b]) await w.harness(client, "investigate", "investigate");
      const held = await claimedFor(w, a, intent);
      const free = await goFor(w, a, intent);
      // The setter's check-back: only an intention of a label the other client is cleared for holds
      // it off.
      expect(
        code(
          await w.work.setIntention(a.token, {
            opportunity: held.id,
            kind: "check_back",
            dueAt: new Date(Date.now() + 2 * 3_600_000).toISOString(),
            requestId: request(),
          }),
        ),
      ).toBe("ok");
      // The check-back falls due: the tick returns the opportunity to go and keeps the setter's
      // preference for 24 hours on the lease row.
      await queryAs(
        w.db.urls.work,
        "update queue.leases set lease_until = now() - interval '1 minute', preferred_until = now() + interval '24 hours' where resource_kind = 'opportunity' and resource_id = $1",
        [held.id],
      );
      await w.status("opportunity", held.id, "go", "system:work");
      // Fired, as the tick leaves it: a check-back still waiting would hold the work itself.
      const [set] = await queryAs<{ id: string }>(
        w.db.urls.admin,
        "select id from ledger.intentions where opportunity_id = $1",
        [held.id],
      );
      await w.status("intention", set?.id ?? "", "fired", "system:work");
      const open = async (client: WorkClient): Promise<string[]> =>
        ok(await w.work.listOpportunities(client.token, {}))
          .opportunities.map((view) => view.id)
          .sort();
      expect(await open(b)).toEqual([free.id]);
      expect(await open(a)).toEqual([held.id, free.id].sort());
      // What the list leaves out is what the claim refuses.
      expect(code(await w.work.claimOpportunity(b.token, { id: held.id, requestId: request() }))).toBe("not_found");
      // The 24 hours over, the other client is offered it too.
      await queryAs(
        w.db.urls.work,
        "update queue.leases set preferred_until = now() - interval '1 second' where resource_kind = 'opportunity' and resource_id = $1",
        [held.id],
      );
      expect(await open(b)).toEqual([held.id, free.id].sort());
    }));

  it("a second client computes the next stage from the first client's move", () =>
    withWorkWorld(async (w) => {
      const a = await w.client("first");
      const b = await w.client("second");
      const intent = await w.intent(["goal_step"], [a, b]);
      for (const client of [a, b])
        for (const stage of ["investigate", "prepare"]) await w.harness(client, "goal_step", stage);
      const { id } = await claimedFor(w, a, intent, "goal_step");
      const { move } = ok(
        await w.work.planMove(a.token, { opportunity: id, stage: "investigate", requestId: request() }),
      );
      expect(
        statusOf(ok(await w.work.reportMove(a.token, { move, outcome: "done", report: REPORT, requestId: request() }))),
      ).toBe("claimed");
      ok(await w.work.releaseOpportunity(a.token, { id, requestId: request() }));
      const seen = ok(await w.work.listOpportunities(b.token, {})).opportunities;
      expect(seen.map((view) => [view.id, view.stage])).toEqual([[id, "prepare"]]);
      ok(await w.work.claimOpportunity(b.token, { id, requestId: request() }));
      expect(
        code(await w.work.planMove(b.token, { opportunity: id, stage: "investigate", requestId: request() })),
      ).toBe("not_permitted");
      expect(code(await w.work.planMove(b.token, { opportunity: id, stage: "prepare", requestId: request() }))).toBe(
        "ok",
      );
    }));

  it("with the kill switch on, the open list is empty, a claim is not_found and a move is not_permitted, and a report is still taken", () =>
    withWorkWorld(async (w) => {
      const { client, intent } = await agent(w, "worker", [["investigate", "investigate"]]);
      const waiting = await goFor(w, client, intent);
      const planned = await claimedFor(w, client, intent);
      const { move } = ok(
        await w.work.planMove(client.token, { opportunity: planned.id, stage: "investigate", requestId: request() }),
      );
      const held = await claimedFor(w, client, intent);
      expect(ok(await w.work.listOpportunities(client.token, {})).opportunities.map((view) => view.id)).toEqual([
        waiting.id,
      ]);
      expect(ok(await w.work.listOpportunities(client.token, { scope: "mine" })).opportunities).toHaveLength(2);

      await w.killSwitch("on");
      expect(ok(await w.work.listOpportunities(client.token, {})).opportunities).toEqual([]);
      expect(ok(await w.work.listOpportunities(client.token, { scope: "mine" })).opportunities).toEqual([]);
      expect(code(await w.work.claimOpportunity(client.token, { id: waiting.id, requestId: request() }))).toBe(
        "not_found",
      );
      expect(
        code(await w.work.planMove(client.token, { opportunity: held.id, stage: "investigate", requestId: request() })),
      ).toBe("not_permitted");
      expect(
        statusOf(
          ok(await w.work.reportMove(client.token, { move, outcome: "done", report: REPORT, requestId: request() })),
        ),
      ).toBe("done");

      await w.killSwitch("off");
      expect(code(await w.work.claimOpportunity(client.token, { id: waiting.id, requestId: request() }))).toBe("ok");
    }));

  it("a summary is in no column in plaintext", () =>
    withWorkWorld(async (w) => {
      const { client, intent } = await agent(w, "sealer", [["investigate", "investigate"]]);
      const message = await w.message();
      const about = { kind: "message" as const, id: message.id as never };
      const needles = ["hypothesis canary quokka", "opportunity canary wombat", "report canary numbat"];
      const hypothesis = ok(
        await w.work.proposeHypothesis(client.token, {
          kind: "open_loop",
          about,
          summary: needles[0] as string,
          basis: [about],
          requestId: request(),
        }),
      ).hypothesis;
      const { opportunity } = ok(
        await w.work.proposeOpportunity(client.token, {
          kind: "investigate",
          about,
          summary: needles[1] as string,
          basis: [about],
          hypothesis,
          requestId: request(),
        }),
      );
      await w.decideGo(opportunity, intent);
      ok(await w.work.claimOpportunity(client.token, { id: opportunity, requestId: request() }));
      const { move } = ok(
        await w.work.planMove(client.token, { opportunity, stage: "investigate", requestId: request() }),
      );
      ok(
        await w.work.reportMove(client.token, {
          move,
          outcome: "done",
          summary: needles[2] as string,
          report: { deliverable: needles[2] as string, next: needles[2] as string },
          requestId: request(),
        }),
      );
      expect(await w.admin("select count(*)::int as n from ledger.record_events where body_enc is not null")).toEqual([
        { n: 1 },
      ]);
      expect(await scanForPlaintext(w.db.urls.admin, needles)).toEqual([]);
    }));

  it("each tool call writes one calls row and one read log row with no bound items, and the returned refs' evidence ids under shown where the tool returns refs", () =>
    withWorkWorld(async (w) => {
      const { client, intent } = await agent(w, "logger", [["investigate", "investigate"]]);
      const proposed = await goFor(w, client, intent);
      const step = async (
        tool: string,
        run: () => Promise<ReadOutcome<unknown>>,
        shown: string[],
      ): Promise<unknown> => {
        const calls = (await callLog(w.db.urls.admin)).length;
        const logged = (await readLog(w, client)).length;
        const outcome = await run();
        expect(code(outcome), tool).toBe("ok");
        const newCalls = (await callLog(w.db.urls.admin)).slice(calls);
        expect(
          newCalls.map((row) => [row.tool, row.outcome]),
          tool,
        ).toEqual([[tool, "ok"]]);
        const newLog = (await readLog(w, client)).slice(logged);
        expect(
          newLog.map((row) => [row.tool, row.bound, [...row.shown].sort()]),
          tool,
        ).toEqual([[tool, [], [...shown].sort()]]);
        return outcome.ok ? outcome.value : null;
      };
      await step("list_opportunities", () => w.work.listOpportunities(client.token, {}), [proposed.message.evidence]);
      await step(
        "claim_opportunity",
        () => w.work.claimOpportunity(client.token, { id: proposed.id, requestId: request() }),
        [proposed.message.evidence],
      );
      const { move } = (await step(
        "plan_move",
        () => w.work.planMove(client.token, { opportunity: proposed.id, stage: "investigate", requestId: request() }),
        [],
      )) as { move: MoveId };
      await step(
        "set_intention",
        () =>
          w.work.setIntention(client.token, {
            opportunity: proposed.id,
            kind: "check_back",
            dueAt: new Date(Date.now() + 7_200_000).toISOString(),
            requestId: request(),
          }),
        [],
      );
      await step(
        "report_move",
        () => w.work.reportMove(client.token, { move, outcome: "done", report: REPORT, requestId: request() }),
        [],
      );
      const message = await w.message();
      const about = { kind: "message" as const, id: message.id as never };
      const other = await w.client("other");
      const { hypothesis } = (await step(
        "propose_hypothesis",
        () =>
          w.work.proposeHypothesis(client.token, {
            kind: "open_loop",
            about,
            summary: "an open loop in the cited message",
            basis: [about],
            requestId: request(),
          }),
        [],
      )) as { hypothesis: HypothesisId };
      await step(
        "propose_opportunity",
        () =>
          w.work.proposeOpportunity(client.token, {
            kind: "investigate",
            about,
            summary: "a step on the cited message",
            basis: [about],
            requestId: request(),
          }),
        [],
      );
      await step(
        "record_test",
        () => w.work.recordTest(client.token, { hypothesis, result: "supports", basis: [about], requestId: request() }),
        [],
      );
      const second = await goFor(w, client, intent);
      ok(await w.work.claimOpportunity(client.token, { id: second.id, requestId: request() }));
      await step(
        "release_opportunity",
        () => w.work.releaseOpportunity(client.token, { id: second.id, requestId: request() }),
        [],
      );
      // A refusal writes its calls row and no read log row.
      const logged = (await readLog(w, client)).length;
      expect(
        code(
          await w.work.recordTest(other.token, {
            hypothesis: missing("hyp") as HypothesisId,
            result: "supports",
            basis: [about],
            requestId: request(),
          }),
        ),
      ).toBe("not_found");
      expect((await callLog(w.db.urls.admin)).at(-1)).toEqual({
        client: "other",
        tool: "record_test",
        rows: 0,
        outcome: "not_found",
      });
      expect(await readLog(w, client)).toHaveLength(logged);
      expect(await readLog(w, other)).toEqual([]);
    }));

  it("a row a work call wrote carries the session of its pi mcp process, the same one a read in that process logged under", () =>
    withWorkWorld(async (w) => {
      const readFirst = await w.client("read-first");
      expect(code(await w.reader.getSelf(readFirst.token))).toBe("ok");
      const proposed = await propose(w, readFirst);
      const workFirst = await w.client("work-first");
      const later = await propose(w, workFirst);
      expect(code(await w.reader.getSelf(workFirst.token))).toBe("ok");
      for (const [client, id] of [
        [readFirst, proposed.id],
        [workFirst, later.id],
      ] as const) {
        const sessions = (await readLog(w, client)).map((row) => row.session_id);
        const session = w.reader.sessions.of(client.id as never);
        expect(session).toBeDefined();
        expect(new Set(sessions)).toEqual(new Set([session]));
        expect(
          one(await w.admin<{ session_id: string }>("select session_id from ledger.opportunities where id = $1", [id]))
            .session_id,
        ).toBe(session);
        expect(
          await w.admin(
            "select distinct session_id from ledger.record_events where row_kind = 'opportunity' and row_id = $1",
            [id],
          ),
        ).toEqual([{ session_id: session }]);
        // The fixture's own session, opened in SQL, is another; the process opened one.
        expect(
          await w.admin("select count(*)::int as n from ledger.sessions where client_id = $1 and id <> $2", [
            client.id,
            client.session,
          ]),
        ).toEqual([{ n: 1 }]);
      }
    }));

  it("a repeated request id returns the first result", () =>
    withWorkWorld(async (w) => {
      const { client, intent } = await agent(w, "repeater", [["investigate", "investigate"]]);
      const message = await w.message();
      const about = { kind: "message" as const, id: message.id as never };
      const requestId = request();
      const first = ok(
        await w.work.proposeOpportunity(client.token, {
          kind: "investigate",
          about,
          summary: "the first proposal of the case",
          basis: [about],
          requestId,
        }),
      );
      const again = ok(
        await w.work.proposeOpportunity(client.token, {
          kind: "investigate",
          about,
          summary: "the second proposal of the case",
          basis: [about],
          requestId,
        }),
      );
      expect(again).toEqual(first);
      await w.decideGo(first.opportunity, intent);
      const claimId = request();
      const claimed = ok(await w.work.claimOpportunity(client.token, { id: first.opportunity, requestId: claimId }));
      expect(ok(await w.work.claimOpportunity(client.token, { id: first.opportunity, requestId: claimId }))).toEqual(
        claimed,
      );
      const planId = request();
      const planned = ok(
        await w.work.planMove(client.token, {
          opportunity: first.opportunity,
          stage: "investigate",
          requestId: planId,
        }),
      );
      expect(
        ok(
          await w.work.planMove(client.token, {
            opportunity: first.opportunity,
            stage: "investigate",
            requestId: planId,
          }),
        ),
      ).toEqual(planned);
      const reportId = request();
      const reported = ok(
        await w.work.reportMove(client.token, {
          move: planned.move,
          outcome: "done",
          report: REPORT,
          requestId: reportId,
        }),
      );
      expect(
        ok(
          await w.work.reportMove(client.token, {
            move: planned.move,
            outcome: "done",
            report: REPORT,
            requestId: reportId,
          }),
        ),
      ).toEqual(reported);
      expect(await w.admin("select count(*)::int as n from ledger.opportunities")).toEqual([{ n: 1 }]);
      expect(await w.admin("select count(*)::int as n from ledger.moves")).toEqual([{ n: 1 }]);
      expect(await w.admin("select count(*)::int as n from ledger.assignments")).toEqual([{ n: 1 }]);
    }));

  it("a refusal the server makes itself, not a work function, answers unavailable and logs work_failed", () =>
    withWorkWorld(async (w) => {
      const { client, intent } = await agent(w, "faulted", [["investigate", "investigate"]]);
      const { id } = await goFor(w, client, intent);
      await session(w.db.urls.bootstrap, async (query) => {
        await query("set role pi_owner");
        await query("revoke execute on function ledger.claim(text, text, text, text) from pi_reader");
      });
      expect(code(await w.work.claimOpportunity(client.token, { id, requestId: request() }))).toBe("unavailable");
      expect(w.log.events.filter((event) => event.event === "work_failed")).toEqual([
        { event: "work_failed", code: "unavailable" },
      ]);
      // A function's own refusal is still an answer. A release of the go item itself would decline
      // it, so the refusal asked for is of an item that does not exist.
      expect(
        code(
          await w.work.releaseOpportunity(client.token, { id: missing("opp") as OpportunityId, requestId: request() }),
        ),
      ).toBe("not_found");
    }));

  it("two claims at once give one lease and no unavailable", () =>
    withWorkWorld(async (w) => {
      const a = await w.client("racer-a");
      const b = await w.client("racer-b");
      const intent = await w.intent(["investigate"], [a, b]);
      for (const client of [a, b]) await w.harness(client, "investigate", "investigate");
      for (let round = 0; round < 3; round += 1) {
        const { id } = await goFor(w, a, intent);
        const outcomes = await Promise.all(
          [a, b].map((client) => w.work.claimOpportunity(client.token, { id, requestId: request() })),
        );
        expect(outcomes.map(code).sort(), `round ${round}`).toEqual(["not_found", "ok"]);
        expect(await w.admin("select count(*)::int as n from queue.leases where resource_id = $1", [id])).toEqual([
          { n: 1 },
        ]);
      }
    }));
});
