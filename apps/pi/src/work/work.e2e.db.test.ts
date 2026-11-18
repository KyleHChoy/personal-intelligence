import { scanForPlaintext } from "@intelligence/personal-store/testing";
import { afterAll, describe, expect, it } from "vitest";
import {
  type Harness,
  latest,
  proposedBy,
  recorded,
  requestId,
  runMeeting,
  sequenceReplies,
  value,
  workHarness,
} from "../test-support/work-harness.ts";

// Durable work, end to end: the sequence a goal, an intent and a harness mode set with `pi`; a
// tick; a run that proposes a meeting_prep for the world's next accepted meeting; rung 0's go; a
// client that lists, claims, plans and reports; the owner's review and ruling. Each step is
// asserted before the next, and every link of the chain has its ledger row. The real `pi` process,
// the real `pi mcp` behind each client's wrapper, and the reasoner's runOnce with a recorded model:
// nothing calls a live model or Google.

const LONG = 600_000;
const REPORT = "Agenda drafted from the last three threads CANARY-REPORT-M3J6P4";
// A meeting_prep's done report carries its next step too.
const NEXT = "Send the agenda the day before CANARY-NEXT-Q7W2K9";

describe("durable work, end to end", () => {
  let h: Harness | undefined;
  afterAll(async () => {
    await h?.cleanup();
  });

  it(
    "W9 a goal, an intent and a harness mode; a tick; a run's proposal; rung 0's go; a client's move and report; the owner's ruling, each with its row",
    async () => {
      // 1 to 4: the key file, the database, one sync, the empty journal (the tick refused before
      // it), the two clients, the goal, the intent, the harness mode, and the tick's run.
      const harness = await workHarness();
      h = harness;
      const { ids } = harness;
      const rows = harness.rows;
      expect(await rows("select wake_source, decision_point from ledger.runs where id = $1", [ids.run])).toEqual([
        { wake_source: "calendar", decision_point: "run_outcome" },
      ]);
      expect(
        await rows("select ref_kind, ref_id from ledger.basis where row_kind = 'run' and row_id = $1", [ids.run]),
      ).toEqual([{ ref_kind: "event", ref_id: ids.event }]);
      expect(await latest(harness, "run", ids.run)).toMatchObject({ event: "queued" });

      const replies = sequenceReplies(harness);
      const model = recorded(replies);
      const ran = await runMeeting(harness, model);
      expect(ran.exit).toBe(0);
      expect(Object.keys(ran.env).sort()).toEqual([
        "PI_AGENT_API_COMMAND",
        "PI_REASONER_MODEL",
        "PI_REASONER_MODEL_KEY",
      ]);
      expect(model.overasked()).toBe(false);
      expect(model.requests).toHaveLength(3);
      expect(model.requests[1]?.messages.at(-1)).toMatchObject({ role: "tool" });
      expect(model.requests[2]?.messages.at(-1)).toMatchObject({ role: "tool" });
      expect(await latest(harness, "run", ids.run)).toMatchObject({ event: "finished" });
      expect(
        await rows(
          "select attempt, client_id = (select id from policy.clients where name = 'reasoner') as reasoner, compartments from ledger.run_attempts where run_id = $1",
          [ids.run],
        ),
      ).toEqual([{ attempt: 1, reasoner: true, compartments: ["own"] }]);
      expect(
        await rows("select ordinal, kind, status, tool from ledger.run_steps where run_id = $1 order by ordinal", [
          ids.run,
        ]),
      ).toEqual([
        { ordinal: 0, kind: "model_call", status: null, tool: null },
        { ordinal: 1, kind: "tool_call", status: "ok", tool: "get_self" },
        { ordinal: 2, kind: "model_call", status: null, tool: null },
        { ordinal: 3, kind: "tool_call", status: "ok", tool: "get_timeline" },
        { ordinal: 4, kind: "model_call", status: null, tool: null },
      ]);
      const [opportunity, ...more] = await proposedBy(harness, ids.run);
      expect(more).toEqual([]);
      if (opportunity === undefined) throw new Error("the run proposed nothing");
      expect(
        await rows(
          "select kind, about_kind, about_id, proposed_by_class, compartments from ledger.opportunities where id = $1",
          [opportunity],
        ),
      ).toEqual([
        {
          kind: "meeting_prep",
          about_kind: "event",
          about_id: ids.event,
          proposed_by_class: "run",
          compartments: ["own"],
        },
      ]);
      expect(
        await rows(
          "select k.row_kind, k.kind, k.author from ledger.cases k join ledger.opportunities o on o.case_id = k.id where o.id = $1",
          [opportunity],
        ),
      ).toEqual([{ row_kind: "opportunity", kind: "meeting_prep", author: "run" }]);
      expect(
        await rows(
          "select ref_kind, ref_id, source_class, owner_backed from ledger.basis where row_kind = 'opportunity' and row_id = $1 order by id",
          [opportunity],
        ),
      ).toEqual([
        { ref_kind: "event", ref_id: ids.event, source_class: "source", owner_backed: true },
        { ref_kind: "message", ref_id: ids.cited, source_class: "source", owner_backed: true },
      ]);
      expect(
        await rows(
          "select point, rung, output, effect, run_id from ledger.decision_point_calls where subject_kind = 'opportunity' and subject_id = $1",
          [opportunity],
        ),
      ).toEqual([{ point: "run_outcome", rung: 3, output: "propose", effect: "propose_opportunity", run_id: ids.run }]);

      // 6. The tick: rung 0 decides go under the intent.
      expect(await harness.tickProcess()).toMatchObject({ exit: 0 });
      expect(await latest(harness, "opportunity", opportunity)).toMatchObject({ event: "go" });
      expect(
        await rows(
          "select decision, decided_by, rung, reason, intent_id from ledger.opportunity_decisions where opportunity_id = $1",
          [opportunity],
        ),
      ).toEqual([{ decision: "go", decided_by: "policy", rung: 0, reason: "intent", intent_id: ids.intent }]);
      expect(
        await rows(
          "select rung, output, effect, escalated from ledger.decision_point_calls where point = 'opportunity_go' and subject_id = $1",
          [opportunity],
        ),
      ).toEqual([{ rung: 0, output: "go", effect: "go_internal", escalated: false }]);
      expect(
        await rows(
          "select 1 from ledger.cards where case_key = (select case_id from ledger.opportunities where id = $1)",
          [opportunity],
        ),
      ).toEqual([]);

      // 7. The worker lists it, claims it, plans the prepare move, reads the cited message and
      // reports the move done with a summary.
      const worker = await harness.client("worker");
      const listed = value(await worker.tool("list_opportunities")) as {
        opportunities: { id: string; stage: string | null; leaseUntil: string | null }[];
      };
      expect(listed.opportunities).toEqual([
        expect.objectContaining({ id: opportunity, stage: "prepare", leaseUntil: null }),
      ]);
      const claimed = value(await worker.tool("claim_opportunity", { id: opportunity, requestId: requestId() }));
      expect(claimed).toMatchObject({ opportunity: { id: opportunity }, leaseUntil: expect.any(String) });
      const planned = value(
        await worker.tool("plan_move", { opportunity, stage: "prepare", requestId: requestId() }),
      ) as { move: string };
      expect(planned.move).toMatch(/^mov_/);
      expect((await worker.tool("read_message", { id: ids.cited })).ok).toBe(true);
      expect(
        value(
          await worker.tool("report_move", {
            move: planned.move,
            outcome: "done",
            report: { deliverable: REPORT, next: NEXT },
            requestId: requestId(),
          }),
        ),
      ).toEqual({ move: planned.move, opportunity: "done" });
      const [workerId] = await rows<{ id: string }>("select id from policy.clients where name = 'worker'");
      expect(
        await rows("select client_id, intent_id from ledger.assignments where opportunity_id = $1", [opportunity]),
      ).toEqual([{ client_id: workerId?.id, intent_id: ids.intent }]);
      expect(
        await rows(
          "select output, effect from ledger.decision_point_calls where point = 'move_clear' and subject_id = $1",
          [opportunity],
        ),
      ).toEqual([{ output: "clear", effect: "clear_internal_move" }]);
      expect(
        await rows(
          "select stage, intent_id, harness_mode_id, effect_class from ledger.moves where opportunity_id = $1",
          [opportunity],
        ),
      ).toEqual([
        {
          stage: "prepare",
          intent_id: ids.intent,
          harness_mode_id: ids.harnessModes[0],
          effect_class: "internal_reversible",
        },
      ]);
      expect(
        await rows(
          "select event, body_enc is not null as body from ledger.record_events where row_kind = 'move' and row_id = $1 order by id",
          [planned.move],
        ),
      ).toEqual([
        { event: "cleared", body: false },
        { event: "done", body: false },
        { event: "reported", body: true },
      ]);
      expect(await latest(harness, "opportunity", opportunity)).toMatchObject({ event: "done" });

      // 8. The tick raises an outcome card on the move, with the worker as its author.
      expect(await harness.tickProcess()).toMatchObject({ exit: 0 });
      const cards = await rows<{
        id: string;
        kind: string;
        created_by: string;
        target_kind: string;
        target_id: string;
      }>("select id, kind, created_by, target_kind, target_id from ledger.cards where target_id = $1", [planned.move]);
      expect(cards).toEqual([
        {
          id: expect.stringMatching(/^crd_/),
          kind: "outcome",
          created_by: `client:${workerId?.id}`,
          target_kind: "move",
          target_id: planned.move,
        },
      ]);
      const card = cards[0]?.id ?? "";

      // 9. The owner's review lists it, show prints the report as the agent's line, and decide
      // records the answer and its labels. An outcome outside the week's sample is settled by code
      // and reaches the owner only when reopened, which is how the owner takes one back.
      if (!(JSON.parse((await harness.terminal(["review"])).stdout) as { id: string }[]).some((one) => one.id === card))
        expect((await harness.terminal(["cards", "reopen", card])).exit).toBe(0);
      const reviewed = await harness.terminal(["review"]);
      expect(reviewed.exit).toBe(0);
      expect((JSON.parse(reviewed.stdout) as { id: string; kind: string }[]).filter((one) => one.id === card)).toEqual([
        expect.objectContaining({ id: card, kind: "outcome" }),
      ]);
      const shown = await harness.terminal(["show", card]);
      expect(shown.exit).toBe(0);
      // Each part of the report under its heading.
      expect(shown.stdout.split("\n")).toEqual(
        expect.arrayContaining(["deliverable:", `agent: ${REPORT}`, "next:", `agent: ${NEXT}`]),
      );
      const decided = await harness.owner(["decide", card, "--answer", "acknowledge", "--labels", "correct,would_act"]);
      expect(decided).toMatchObject({ exit: 0, stderr: "" });
      const [ruling] = JSON.parse(decided.stdout) as { card: string; ruling: string }[];
      expect(ruling?.card).toBe(card);
      expect(
        await rows("select kind, answer, labels, card_id from knowledge.owner_decisions where id = $1", [
          ruling?.ruling,
        ]),
      ).toEqual([{ kind: "answer", answer: "acknowledge", labels: ["correct", "would_act"], card_id: card }]);
      expect(await latest(harness, "card", card)).toMatchObject({ event: "decided" });
      await worker.end();

      // No goal, summary or model answer is in any column, and a step has no sealed column and no
      // hash, read from the catalogue; a model call's token counts are counts in clear.
      const summary =
        (JSON.parse(replies[2]?.text ?? "{}") as { actions: { summary: string }[] }).actions[0]?.summary ?? "";
      expect(summary).not.toBe("");
      expect(
        await scanForPlaintext(harness.db.urls.admin, [
          harness.statement,
          summary,
          REPORT,
          NEXT,
          ...replies.flatMap((one) => (one.text === null ? [] : [one.text])),
        ]),
      ).toEqual([]);
      const columns = await rows<{ name: string; type: string }>(
        `select a.attname as name, t.typname as type from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
         join pg_type t on t.oid = a.atttypid where n.nspname = 'ledger' and c.relname = 'run_steps' and a.attnum > 0 and not a.attisdropped`,
      );
      expect(columns.length).toBeGreaterThan(0);
      // A web step's query or URL, sealed (`detail_enc`), the one sealed column.
      expect(columns.filter((one) => one.type === "jsonb" || /enc|hash|token/.test(one.name))).toEqual([
        { name: "input_tokens", type: "int4" },
        { name: "output_tokens", type: "int4" },
        { name: "detail_enc", type: "jsonb" },
      ]);
    },
    LONG,
  );
});
