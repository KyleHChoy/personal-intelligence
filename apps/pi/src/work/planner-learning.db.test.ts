import { ClosedCase } from "@intelligence/contracts/personal";
import { scanForPlaintext } from "@intelligence/personal-store/testing";
import { afterAll, describe, expect, it } from "vitest";
import {
  answer,
  COST,
  calls,
  type Harness,
  IGNORE,
  proposedBy,
  recorded,
  requested,
  workHarness,
} from "../test-support/work-harness.ts";

// The planner's learning loop, end to end: a run proposes; the tick raises the owner's card; the
// owner declines it with `pi decide --note`; the next run, a recorded model, is given the case in
// its request's closed block with the answer from the owner and note; and `pi work report` prints each run with
// its prompt, turns, tools, cost and outcome, the proposal with the answer and the note, and the
// proposals summed by prompt version and kind. The real `pi`, `pi mcp` and runOnce; no live model.

const LONG = 600_000;
const SUMMARY = "Build a scorecard for evaluating advisers CANARY-SUMMARY-L4P8";
const NOTE = "process, not progress CANARY-NOTE-Q7M2";

const unescapeEntities = (text: string): string =>
  text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

// The closed block of a run's first user message.
function closedBlock(text: string): unknown {
  const found = /<data slot="closed">\n(.*)\n<\/data>/.exec(text)?.[1];
  if (found === undefined) throw new Error("no closed block");
  return JSON.parse(unescapeEntities(found));
}

describe("the planner's learning loop, end to end", () => {
  let h: Harness | undefined;
  afterAll(async () => {
    await h?.cleanup();
  });

  it(
    "the owner's no with a note reaches the next run's closed cases, and pi work report shows the run and the proposal with the answer from the owner and note",
    async () => {
      // No worker and no intent, so the tick asks the owner; one run queued by `pi work run`.
      const harness = await workHarness({ worker: false, queue: "request" });
      h = harness;
      const { ids } = harness;
      const proposal = {
        do: "propose",
        kind: "goal_step",
        about: { kind: "message", id: ids.cited },
        summary: SUMMARY,
        basis: [{ kind: "message", id: ids.cited }],
      };
      const first = recorded([calls({ name: "get_self" }), answer({ actions: [proposal] })]);
      const ran = await harness.reason(first);
      expect(ran).toMatchObject({ exit: 0, run: ids.run });
      expect(first.overasked()).toBe(false);
      const [opportunity] = await proposedBy(harness, ids.run);
      if (opportunity === undefined) throw new Error("the run proposed nothing");

      // The tick raises the owner's card; the owner declines it with their note.
      expect((await harness.tickProcess()).exit).toBe(0);
      await harness.drain();
      const [card] = await harness.rows<{ id: string }>(
        "select id from ledger.cards where kind = 'opportunity_decision' and target_id = $1",
        [opportunity],
      );
      if (card === undefined) throw new Error("no card was raised");
      // With the owner's reason, a code from the list.
      const decided = await harness.owner([
        "decide",
        card.id,
        "--answer",
        "no_go",
        "--note",
        NOTE,
        "--reason",
        "not_worth_it",
      ]);
      expect(decided.exit, decided.stderr).toBe(0);
      expect(
        await harness.rows(
          "select event, by, code from ledger.record_events where row_kind = 'opportunity' and row_id = $1 order by id desc limit 1",
          [opportunity],
        ),
      ).toEqual([{ event: "no_go", by: "owner", code: "not_worth_it" }]);
      // Sealed with the decision and in the status event, in clear nowhere.
      expect(
        await harness.rows(
          "select (body_enc is not null) as sealed from knowledge.owner_decisions where card_id = $1",
          [card.id],
        ),
      ).toEqual([{ sealed: true }]);
      expect(await scanForPlaintext(harness.db.urls.admin, ["CANARY-NOTE-Q7M2"])).toEqual([]);

      // The next run sees the case, with the answer from the owner and note, in its closed block.
      const second = recorded([answer(IGNORE)]);
      const next = await requested(harness, second);
      expect(next.exit).toBe(0);
      const firstMessage = second.requests[0]?.messages[0];
      const closed = closedBlock(firstMessage?.role === "user" ? firstMessage.text : "") as unknown[];
      expect(closed.every((one) => ClosedCase.safeParse(one).success)).toBe(true);
      expect(closed).toEqual([
        expect.objectContaining({
          rowKind: "opportunity",
          kind: "goal_step",
          id: opportunity,
          status: "no_go",
          by: "owner",
          summary: { untrusted: SUMMARY },
          decision: "no_go",
          note: { untrusted: NOTE },
          outcome: { moves: { done: 0, failed: 0, blocked: 0 }, tests: { supports: 0, refutes: 0, inconclusive: 0 } },
          declineReason: "not_worth_it",
        }),
      ]);
      // The run was sent the current prompt, version 3.
      expect(second.requests[0]?.system).toContain("Learn from the closed block");

      // The report: each run of the day, newest first, its steps counted and its proposal answered.
      const report = await harness.terminal(["work", "report", "--days", "1"]);
      expect(report.exit, report.stderr).toBe(0);
      const shown = JSON.parse(report.stdout) as {
        days: number;
        runs: Record<string, unknown>[];
        summary: Record<string, unknown>[];
        declines: unknown;
      };
      expect(shown.days).toBe(1);
      // The owner's noes of the window by reason.
      expect(shown.declines).toEqual([{ rowKind: "opportunity", reason: "not_worth_it", n: 1 }]);
      const byId = new Map(shown.runs.map((run) => [run.id, run]));
      expect(byId.get(ids.run)).toEqual({
        id: ids.run,
        source: "owner_request",
        // personal_run 4 is the prompt a run is sent.
        prompt: { id: "personal_run", version: "4" },
        at: expect.any(String),
        outcome: "finished",
        code: null,
        attempts: 1,
        turns: 2,
        toolCalls: { get_self: 1 },
        refused: 0,
        failed: 0,
        tooLarge: 0,
        truncated: 0,
        outputChecks: 0,
        webSearches: 0,
        webFetches: 0,
        costMicroUsd: 2 * COST,
        proposals: [
          {
            rowKind: "opportunity",
            id: opportunity,
            kind: "goal_step",
            status: "no_go",
            summary: SUMMARY,
            decision: { answer: "no_go", by: "owner", at: expect.any(String), note: NOTE },
            // A no is answered but neither accepted nor used.
            accepted: false,
            used: false,
          },
        ],
        yield: { proposed: 1, answered: 1, accepted: 0, used: 0 },
      });
      expect(byId.get(next.run)).toMatchObject({ outcome: "finished", turns: 1, toolCalls: {}, proposals: [] });
      expect(shown.runs[0]?.id).not.toBe(ids.run);
      // The summary: the window's proposals by prompt version and kind, with the owner's answers.
      expect(shown.summary).toEqual([
        {
          prompt: { id: "personal_run", version: "4" },
          rowKind: "opportunity",
          kind: "goal_step",
          proposed: 1,
          answers: { no_go: 1 },
          statuses: { no_go: 1 },
          approved: 0,
          approvalRate: 0,
        },
      ]);
      // Off a terminal it prints nothing.
      const piped = await harness.owner(["work", "report"]);
      expect(piped.exit).toBe(1);
      expect(piped.stdout).toBe("");
      expect(piped.stderr).toContain("not_a_terminal");
    },
    LONG,
  );
});
