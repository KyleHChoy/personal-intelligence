import type { EntityId, RunId } from "@intelligence/contracts/personal";
import { startAgentApi } from "@intelligence/personal-reasoner";
import { newId } from "@intelligence/personal-store";
import { describe, expect, it } from "vitest";
import {
  answersAbout,
  cardsOn,
  caseOf,
  count,
  decisionsOf,
  evt,
  HANDED_LINE,
  isRecipe,
  LONG,
  listed,
  mail,
  msg,
  NOT_FOUND,
  NOT_PERMITTED,
  ok,
  otherEvents,
  ownerSent,
  propose,
  type Ref,
  ruleOf,
  withHarness,
} from "../test-support/work-gate-fixtures.ts";
import {
  answer,
  calls,
  DAY,
  type Harness,
  HOUR,
  IGNORE,
  latest,
  MINUTE,
  proposedAbout,
  proposedBy,
  READ_TOOLS,
  recorded,
  requested,
  requestId,
  runMeeting,
  sequenceReplies,
  TOP_CONTACT,
  takeOlder,
  untilClaim,
  value,
} from "../test-support/work-harness.ts";

// Durable work's gate tests W8 and W10 to W15. Shared setup is in work-gate-fixtures.ts.

describe("durable work: the owner's answers, vetoes, erasures and expiry", () => {
  it(
    "W8 under an owner intent a decision card left 14 days expires the opportunity, nothing is go, and the next tick raises no card for the case",
    () =>
      withHarness({ mode: "owner" }, async (h) => {
        const ran = await runMeeting(h, recorded(sequenceReplies(h)));
        const [opportunity] = await proposedBy(h, ran.run);
        if (opportunity === undefined) throw new Error("the run proposed nothing");
        ok(await h.tickProcess(), "work tick");
        const [card] = await cardsOn(h, opportunity);
        expect(card).toMatchObject({ kind: "opportunity_decision", state: "pending" });
        await h.tick(h.at(14 * DAY + HOUR));
        expect(await latest(h, "opportunity", opportunity)).toMatchObject({ event: "expired" });
        expect(await latest(h, "card", card?.id ?? "")).toMatchObject({ event: "expired" });
        expect(await count(h, "ledger.opportunity_decisions", "decision = 'go'")).toBe(0);
        await h.tick(h.at(14 * DAY + 2 * HOUR));
        expect(await count(h, "ledger.cards", "case_key = $1", [await caseOf(h, opportunity)])).toBe(1);
      }),
    LONG,
  );

  it(
    "W10 a run is labelled with the clearance of the reasoner that took it: a replaced reasoner writes nothing more, and a wider one's rows carry the wider label and are listed to no narrower client",
    () =>
      withHarness({}, async (h) => {
        // The meeting's run is taken by the first reasoner, which is replaced before its first
        // step: its next append_step is unauthorized, and nothing of the run is written.
        await takeOlder(h);
        const replaced = recorded(sequenceReplies(h), {
          0: async () => {
            ok(await h.owner(["clients", "revoke", "reasoner"]), "clients revoke");
            await h.register("wider", [
              "--kind",
              "reasoner",
              "--compartments",
              "own,employer:example",
              "--views",
              "self,people,work",
              "--tools",
              [...READ_TOOLS, "next_run", "append_step", "finish_run"].join(","),
            ]);
          },
        });
        const first = await h.reason(replaced);
        expect(first.run).toBe(h.ids.run);
        expect(first.exit).toBe(1);
        expect(first.logged).toContainEqual(
          expect.objectContaining({ event: "reasoner_failed", code: "unauthorized" }),
        );
        expect(await count(h, "ledger.run_steps", "run_id = $1", [h.ids.run])).toBe(0);
        for (const table of [
          "ledger.opportunities",
          "ledger.hypotheses",
          "ledger.intentions",
          "ledger.decision_point_calls",
        ])
          expect(await count(h, table, "run_id = $1", [h.ids.run]), table).toBe(0);

        // A run queued under the first reasoner (the goal's wake, at step 4), taken by the wider
        // one: the attempt and every row it writes carry both compartments.
        const [queued] = await h.rows<{ id: RunId; compartments: string[] }>(
          "select id, compartments from ledger.runs where wake_source = 'goal_changed'",
        );
        expect(queued?.compartments).toEqual(["own"]);
        const wider = await h.reason(recorded(sequenceReplies(h)), "wider");
        expect(wider).toMatchObject({ exit: 0, run: queued?.id });
        const both = ["employer:example", "own"];
        expect(await h.rows("select compartments from ledger.run_attempts where run_id = $1", [queued?.id])).toEqual([
          { compartments: both },
        ]);
        const [opportunity] = await proposedBy(h, queued?.id as RunId);
        if (opportunity === undefined) throw new Error("the wider run proposed nothing");
        expect(await h.rows("select compartments from ledger.opportunities where id = $1", [opportunity])).toEqual([
          { compartments: both },
        ]);
        expect(
          (
            await h.rows<{ compartments: string[] }>(
              "select compartments from ledger.basis where row_kind = 'opportunity' and row_id = $1",
              [opportunity],
            )
          ).map((one) => one.compartments),
        ).toEqual([both, both]);
        expect(
          await h.rows("select compartments from ledger.decision_point_calls where run_id = $1", [queued?.id]),
        ).toEqual([{ compartments: both }]);
        ok(await h.tickProcess(), "work tick");
        const worker = await h.client("worker");
        expect(await listed(worker)).not.toContain(opportunity);
        expect(await listed(worker, "mine")).toEqual([]);
        expect(await worker.tool("claim_opportunity", { id: opportunity, requestId: requestId() })).toEqual(NOT_FOUND);
        await worker.end();
      }),
    LONG,
  );

  it(
    "W11 the owner's no holds: the same proposal is closed no_go by code with no card; with a new message from a source and 7 days it raises a card and is not decided at rung 0",
    () =>
      withHarness({}, async (h) => {
        await h.drain();
        const stranger = await h.messageOf(h.gmail(isRecipe).id);
        await h.screen(stranger);
        const [about] = await otherEvents(h);
        if (about === undefined) throw new Error("the world has another accepted event");
        const proposal = (basis: Ref[]) =>
          recorded([answer({ actions: [propose("meeting_prep", evt(about), basis)] })]);

        // The first proposal goes to the owner, who answers no_go.
        const first = await requested(h, proposal([msg(stranger)]));
        const [firstId] = await proposedBy(h, first.run);
        ok(await h.tickProcess(), "work tick");
        const [card] = await cardsOn(h, firstId ?? "");
        await ruleOf(h, card?.id ?? "", "no_go");
        expect(await decisionsOf(h, firstId ?? "")).toEqual([
          { decision: "no_go", decided_by: "owner", reason: "owner_answer" },
        ]);
        expect(await latest(h, "opportunity", firstId ?? "")).toMatchObject({ event: "no_go", by: "owner" });

        // The second: the run is told the case is closed by the owner, and the tick closes it.
        const secondModel = proposal([msg(stranger)]);
        const second = await requested(h, secondModel);
        const text = secondModel.requests[0]?.messages[0];
        const closedBlock =
          /<data slot="closed">\n(.*)\n<\/data>/.exec(text?.role === "user" ? text.text : "")?.[1] ?? "[]";
        expect(JSON.parse(closedBlock)).toContainEqual(
          expect.objectContaining({ rowKind: "opportunity", kind: "meeting_prep", about: evt(about), by: "owner" }),
        );
        const [secondId] = await proposedBy(h, second.run);
        expect(secondId).not.toBe(firstId);
        ok(await h.tickProcess(), "work tick");
        expect(await latest(h, "opportunity", secondId ?? "")).toMatchObject({ event: "no_go" });
        expect(await decisionsOf(h, secondId ?? "")).toEqual([
          { decision: "no_go", decided_by: "policy", reason: "owner_declined" },
        ]);
        expect(await cardsOn(h, secondId ?? "")).toEqual([]);

        // A new message from a source joins the basis, and 7 days pass: a card, and no go.
        h.sources[0]?.gmail.add(
          mail(h, "19d0000000000011", {
            from: "Lark Fenn <lark.fenn@example.org>",
            to: h.w.accounts[0]?.address ?? "",
            subject: "About the plans",
            hoursAgo: 2,
          }),
        );
        await h.sync();
        const news = await h.messageOf("19d0000000000011");
        await h.screen(news);
        const third = await requested(h, proposal([msg(stranger), msg(news)]));
        const [thirdId] = await proposedBy(h, third.run);
        await h.tick(h.at(7 * DAY + HOUR));
        expect(await latest(h, "opportunity", thirdId ?? "")).toMatchObject({ event: "proposed" });
        expect(await decisionsOf(h, thirdId ?? "")).toEqual([]);
        expect((await cardsOn(h, thirdId ?? "")).map((one) => one.kind)).toEqual(["opportunity_decision"]);
        expect(
          await count(h, "ledger.opportunity_decisions", "decision = 'go' and opportunity_id = any($1)", [
            [firstId, secondId, thirdId],
          ]),
        ).toBe(0);
      }),
    LONG,
  );

  const removals: [name: string, remove: (h: Harness) => Promise<void>][] = [
    [
      "deleted at the source, in the sync that deletes it",
      async (h) => {
        h.sources[0]?.gmail.deletePermanently(h.ids.citedGmail);
        await h.sync();
      },
    ],
    ["erased with pi erase item", async (h) => void ok(await h.owner(["erase", "item", h.ids.cited]), "erase item")],
  ];
  for (const [name, remove] of removals) {
    it(
      `W12 a message ${name}: what cites it, and what a session read it before, is withdrawn with its summaries; what only saw it in a timeline is not`,
      () =>
        withHarness(
          {
            kinds: ["goal_step"],
            stages: [
              ["goal_step", "investigate"],
              ["goal_step", "prepare"],
            ],
          },
          async (h) => {
            // The cited message read by the worker, a move done and reported, the work still claimed.
            const { opportunity, worker } = await untilClaim(h, { kind: "goal_step" });
            expect((await worker.tool("read_message", { id: h.ids.cited })).ok).toBe(true);
            const move = (
              value(await worker.tool("plan_move", { opportunity, stage: "investigate", requestId: requestId() })) as {
                move: string;
              }
            ).move;
            expect(
              value(
                await worker.tool("report_move", {
                  move,
                  outcome: "done",
                  summary: "Looked into the trip dates",
                  report: { deliverable: "Looked into the trip dates", next: "Prepare the step" },
                  requestId: requestId(),
                }),
              ),
            ).toMatchObject({ opportunity: "claimed" });

            // A run that read the message and cites something else; a run that only saw it in a timeline.
            const [one, two] = await otherEvents(h);
            if (one === undefined || two === undefined) throw new Error("the world has two other accepted events");
            const readIt = await requested(
              h,
              recorded([
                calls({ name: "read_message", arguments: { id: h.ids.cited } }),
                answer({ actions: [propose("goal_step", evt(one), [evt(one)])] }),
              ]),
            );
            const top = await h.entityOf(TOP_CONTACT);
            const sawIt = await requested(
              h,
              recorded([
                calls({ name: "get_timeline", arguments: { id: top } }),
                answer({ actions: [propose("goal_step", evt(two), [evt(two)])] }),
              ]),
            );
            const [boundRow] = await proposedBy(h, readIt.run);
            const [shownRow] = await proposedBy(h, sawIt.run);

            await remove(h);

            for (const id of [opportunity, boundRow ?? ""]) {
              expect(await latest(h, "opportunity", id), id).toMatchObject({ event: "withdrawn" });
              expect(
                await h.rows(
                  "select body_enc is null as gone, tainted_at is not null as tainted from ledger.opportunities where id = $1",
                  [id],
                ),
              ).toEqual([{ gone: true, tainted: true }]);
            }
            expect(
              await h.rows(
                "select body_enc is null as gone from ledger.record_events where row_kind = 'move' and row_id = $1 and event = 'reported'",
                [move],
              ),
            ).toEqual([{ gone: true }]);
            expect(
              await h.rows(
                "select evidence_id from ledger.basis where row_kind = 'opportunity' and row_id = $1 and ref_id = $2",
                [opportunity, h.ids.cited],
              ),
            ).toEqual([{ evidence_id: null }]);
            expect(await count(h, "queue.leases", "resource_id = $1", [opportunity])).toBe(0);
            expect(await listed(worker)).not.toContain(opportunity);
            expect(await listed(worker, "mine")).not.toContain(opportunity);
            expect(await latest(h, "opportunity", shownRow ?? "")).toMatchObject({ event: "proposed" });
            expect(
              await h.rows(
                "select body_enc is not null as kept, tainted_at is null as clean from ledger.opportunities where id = $1",
                [shownRow],
              ),
            ).toEqual([{ kept: true, clean: true }]);
            await worker.end();
          },
        ),
      LONG,
    );
  }

  it(
    "W13 a veto leaves no work standing: no move at once, no_go at the next tick, and nothing a check-back set before it reopens",
    () =>
      withHarness({}, async (h) => {
        const { opportunity, worker } = await untilClaim(h);
        const dueAt = new Date(Date.now() + HOUR + 5 * MINUTE).toISOString();
        const intention = (
          value(
            await worker.tool("set_intention", { opportunity, kind: "check_back", dueAt, requestId: requestId() }),
          ) as { intention: string }
        ).intention;

        // A reply on the owner's message to the same person, handed to the owner by their go.
        const handedRun = await requested(
          h,
          recorded([answer({ actions: [propose("reply", msg(h.ids.cited), [msg(h.ids.cited)])] })]),
        );
        const [handed] = await proposedBy(h, handedRun.run);
        ok(await h.tickProcess(), "work tick");
        const [card] = await cardsOn(h, handed ?? "");
        await ruleOf(h, card?.id ?? "", "go");
        expect(await latest(h, "opportunity", handed ?? "")).toMatchObject({ event: "handed_to_owner" });

        // The veto on the person the cited message was sent to.
        const person: EntityId = await h.entityOf(TOP_CONTACT);
        ok(await h.owner(["veto", "add", "--entity", person]), "veto add");
        expect(await worker.tool("plan_move", { opportunity, stage: "prepare", requestId: requestId() })).toEqual(
          NOT_PERMITTED,
        );
        ok(await h.tickProcess(), "work tick");
        for (const id of [opportunity, handed ?? ""])
          expect(await latest(h, "opportunity", id), id).toMatchObject({ event: "no_go" });
        expect(await count(h, "queue.leases", "resource_id = $1", [opportunity])).toBe(0);
        expect(await listed(worker)).not.toContain(opportunity);
        expect(await listed(worker, "mine")).toEqual([]);
        expect(await latest(h, "intention", intention)).toMatchObject({ event: "cancelled" });

        // The check-back falls due: nothing reopens.
        await h.tick(new Date(Date.parse(dueAt) + MINUTE));
        expect(await latest(h, "opportunity", opportunity)).toMatchObject({ event: "no_go" });
        expect(await latest(h, "intention", intention)).toMatchObject({ event: "cancelled" });

        // The worker's answers about it are those it gets for an opportunity never there.
        expect(await answersAbout(worker, opportunity, dueAt, "vetoed-one")).toEqual(
          await answersAbout(worker, newId("opp"), dueAt, "never-there"),
        );
        await worker.end();
      }),
    LONG,
  );

  it(
    "W14 an erasure stops a run in flight: its next step gets go false, a finish sent anyway is stopped and writes nothing, and the run ends stopped with erasure",
    () =>
      withHarness({}, async (h) => {
        await takeOlder(h);
        const twin = await h.messageOf(h.w.handles.twinMessageId);
        const [, , output] = sequenceReplies(h);
        const model = recorded([calls({ name: "get_self" }), output ?? answer(IGNORE)], {
          1: async () => void ok(await h.owner(["erase", "item", twin]), "erase item"),
        });
        const taken = await h.reason(model);
        expect(taken).toMatchObject({ exit: 0, run: h.ids.run });
        expect(
          await h.rows("select ordinal, kind from ledger.run_steps where run_id = $1 order by ordinal", [h.ids.run]),
        ).toEqual([
          { ordinal: 0, kind: "model_call" },
          { ordinal: 1, kind: "tool_call" },
        ]);

        // A finish_run sent anyway, on a session of the same reasoner.
        const api = await startAgentApi([h.wrappers.reasoner ?? ""], { path: "" });
        try {
          const finished = await api.call("finish_run", {
            run: h.ids.run,
            outcome: "finished",
            output: JSON.parse(output?.text ?? "{}"),
            requestId: requestId(),
          });
          expect(finished).toEqual({ ok: true, value: { recorded: 0, outcome: "stopped" } });
        } finally {
          await api.close();
        }
        for (const table of [
          "ledger.opportunities",
          "ledger.hypotheses",
          "ledger.intentions",
          "ledger.decision_point_calls",
        ])
          expect(await count(h, table, "run_id = $1", [h.ids.run]), table).toBe(0);
        ok(await h.tickProcess(), "work tick");
        expect(await latest(h, "run", h.ids.run)).toMatchObject({ event: "stopped", code: "erasure" });
      }),
    LONG,
  );

  it(
    "W15 handed work ends: the owner's go hands a reply to the owner with the line that says so, acknowledge ends it done, 14 days alone expire another, and three failed runs raise one notice",
    () =>
      withHarness({}, async (h) => {
        await h.drain();
        const [other] = ownerSent(h);
        if (other === undefined) throw new Error("the world has the owner's sent messages");
        const second = await h.messageOf(other.id);
        const replies = await requested(
          h,
          recorded([
            answer({
              actions: [
                propose("reply", msg(h.ids.cited), [msg(h.ids.cited)]),
                propose("reply", msg(second), [msg(second)]),
              ],
            }),
          ]),
        );
        const kept = await proposedAbout(h, replies.run, h.ids.cited);
        const left = await proposedAbout(h, replies.run, second);
        ok(await h.tickProcess(), "work tick");
        const lines = async (card: string): Promise<string[]> =>
          ok(await h.terminal(["show", card]), "show").stdout.split("\n");
        for (const id of [kept, left]) {
          const [card] = await cardsOn(h, id);
          expect(card?.kind).toBe("opportunity_decision");
          expect(await lines(card?.id ?? "")).toContain(HANDED_LINE);
          await ruleOf(h, card?.id ?? "", "go");
          expect(await latest(h, "opportunity", id)).toMatchObject({ event: "handed_to_owner", by: "owner" });
        }
        ok(await h.tickProcess(), "work tick");
        const outcome = (await cardsOn(h, kept)).find((one) => one.kind === "outcome");
        expect(outcome).toMatchObject({ state: "pending" });
        expect(await lines(outcome?.id ?? "")).toContain(HANDED_LINE);
        await ruleOf(h, outcome?.id ?? "", "acknowledge");
        expect(await latest(h, "opportunity", kept)).toMatchObject({ event: "done", by: "owner" });
        await h.tick(h.at(14 * DAY + HOUR));
        expect(await latest(h, "opportunity", left)).toMatchObject({ event: "expired" });

        // Three runs that fail, one after another: one notice, from system:work. A fourth: none.
        const fail = async (): Promise<RunId> => {
          // Twice: the first malformed answer gets one more turn.
          const failed = await requested(
            h,
            recorded([answer("this is not the output"), answer("this is not the output")]),
          );
          expect(failed.exit).toBe(1);
          return failed.run;
        };
        const notices = () =>
          h.rows<{ id: string; author: string; target_id: string }>(
            "select id, created_by as author, target_id from ledger.cards where case_key = 'run_failures' order by created_at",
          );
        await fail();
        await fail();
        const third = await fail();
        ok(await h.tickProcess(), "work tick");
        const [notice, ...others] = await notices();
        expect(others).toEqual([]);
        expect(notice).toMatchObject({ author: "system:work", target_id: third });
        expect(await lines(notice?.id ?? "")).toContain("run failed: bad_output");
        await fail();
        ok(await h.tickProcess(), "work tick");
        expect(await notices()).toHaveLength(1);
      }),
    LONG,
  );
});
