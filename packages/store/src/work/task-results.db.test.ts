import type { AgentRecordId, CardAuthor, CardId, MoveId } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { createAdmin } from "../admin/admin.ts";
import { setTaskTier } from "../admin/admin-tasks.ts";
import { newId } from "../core/ids.ts";
import { raiseCard } from "../core/queue.ts";
import { asWords } from "../test-support/card-lines.ts";
import { request } from "../test-support/clients.ts";
import { session } from "../test-support/connections.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { TASK_AGENT_TOOLS, type WorkClient } from "../test-support/work-clients.ts";
import { ok, type WorkWorld, withWorkWorld } from "../test-support/work-test-world.ts";
import { createDispatch } from "./dispatch.ts";
import { reportOf } from "./dispatch-cards.ts";
import { authorOf } from "./dispatch-read.ts";

// A finished research task raises no card; its report is in the owner's Results feed, presented as its
// outcome card was (what was asked and by whom, what was found, its parts, its sources by name),
// newest first. The owner's Keep or Not useful is one `result_eval` decision under the report's label,
// changing nothing of the task and releasing nothing; erasing what the report cites removes it; a
// blocked task is not in it. The task-result cards raised before the feed are withdrawn quietly by
// the system. Synthetic rows only.

const AGENTS = ["agent:scout"];
const ASKED = "find who runs the canary clinic";
const FOUND = "canary-found the clinic is run by its two founders";
const FINDING = "canary-finding the founders met at the harbour";
const PAGE = "https://example.org/canary-clinic";

async function scout(w: WorkWorld): Promise<WorkClient> {
  const client = await w.client("scout", ["own", ...AGENTS], { tools: TASK_AGENT_TOOLS });
  await w.harness(client, "investigate", "investigate");
  return client;
}

// A task about a person, citing a message the pipeline screened and did not withhold.
async function task(
  w: WorkWorld,
  client: WorkClient,
): Promise<{ opportunity: string; message: { id: string; evidence: string } }> {
  const person = await w.seed.entity("person");
  await w.seed.account(["own"], person);
  const message = await w.message(["own"]);
  await w.seed.pipelineItem(["own"], message.evidence);
  await w.admin(
    "update vault.pipeline_items set waiting = false, withheld = false, screened = true where evidence_id = $1",
    [message.evidence],
  );
  const made = ok(
    await w.work.proposeTask(client.token, {
      kind: "investigate",
      about: { kind: "entity", id: person as never },
      summary: ASKED,
      basis: [{ kind: "message", id: message.id as never }],
      requestId: request(),
    }),
  );
  return { opportunity: made.opportunity, message };
}

async function worked(
  w: WorkWorld,
  client: WorkClient,
  opportunity: string,
  message: string,
  outcome: "done" | "blocked",
): Promise<{ move: MoveId; finding: string }> {
  ok(await w.work.claimOpportunity(client.token, { id: opportunity as never, requestId: request() }));
  const { move } = ok(
    await w.work.planMove(client.token, {
      opportunity: opportunity as never,
      stage: "investigate",
      requestId: request(),
    }),
  );
  const finding = ok(
    await w.reader.record(client.token, {
      kind: "finding",
      body: `${FINDING}\nmore lines after the first`,
      requestId: request(),
    }),
  ).recordId as AgentRecordId;
  const sources = [
    { kind: "agent_record" as const, id: finding },
    { kind: "message" as const, id: message as never },
    PAGE,
  ];
  const report =
    outcome === "done"
      ? {
          deliverable: "canary-deliverable two names",
          next: "canary-next confirm them",
          uncertain: "canary-unsure which is senior",
          sources,
        }
      : { reason: "canary-reason the site is down" };
  ok(await w.work.reportMove(client.token, { move, outcome, summary: FOUND, report, requestId: request() }));
  return { move: move as MoveId, finding };
}

const cardsOn = (w: WorkWorld, move: string) =>
  w.admin<{ id: CardId }>("select id from ledger.cards where target_kind = 'move' and target_id = $1", [move]);
const decisions = (w: WorkWorld) =>
  w.admin<{ id: string; kind: string; compartments: string[] }>(
    "select id, kind, compartments from knowledge.owner_decisions order by id",
  );

describe("a finished task's result is in the Results feed", { timeout: DB_TEST_TIMEOUT }, () => {
  it("raises no card, is shown as its card was, takes the owner's Keep and Not useful, and leaves when its record is erased", () =>
    withWorkWorld(
      async (w) => {
        await setTaskTier(w.admin, true, new Date());
        const agent = await scout(w);
        const { opportunity, message } = await task(w, agent);
        const { move, finding } = await worked(w, agent, opportunity, message.id, "done");
        expect(await w.latest("opportunity", opportunity)).toBe("done");

        const dispatch = createDispatch({ url: w.db.urls.work, log: w.log, journal: "" });
        const admin = createAdmin({ url: w.db.urls.admin, keys: w.db.keys, log: w.log });
        try {
          // No card: the tick finds none to raise, and a raise asked for anyway raises none.
          expect(await dispatch.reportsWithoutCard()).not.toContain(move);
          expect(await dispatch.raiseOutcomeCard({ kind: "move", id: move }, new Date())).toBeNull();
          expect(await cardsOn(w, move)).toEqual([]);

          // In the feed, with the lines its card had.
          const { results, next } = await admin.cards.results();
          expect(next).toBeNull();
          const shown = results.find((one) => one.move === move);
          expect(shown).toMatchObject({ move, judged: null });
          const lines = asWords(shown?.lines ?? []);
          const after = (heading: string) => lines[lines.findIndex((line) => line.text === heading) + 1];
          expect(lines).toContainEqual({ text: "asked by: agent scout", from: "code" });
          expect(lines).toContainEqual({ text: "task", from: "code" });
          // The agent that reported it, so the page can say whose words these are.
          expect(lines).toContainEqual({ text: "client: scout", from: "code" });
          expect(after("asked:")).toEqual({ text: ASKED, from: "agent" });
          expect(after("found:")).toEqual({ text: FOUND, from: "agent" });
          expect(after("deliverable:")).toEqual({ text: "canary-deliverable two names", from: "agent" });
          expect(after("next:")).toEqual({ text: "canary-next confirm them", from: "agent" });
          expect(after("uncertain:")).toEqual({ text: "canary-unsure which is senior", from: "agent" });
          expect(after(`source: agent_record ${finding}`)).toEqual({ text: FINDING, from: "agent" });
          expect(after("source: page")).toEqual({ text: PAGE, from: "agent" });
          expect(lines.some((line) => line.text === `source: message ${message.id}`)).toBe(true);

          // The owner's Keep: one result_eval decision under the report's label, nothing else written, the
          // task's status and the finding's label unchanged.
          const before = await decisions(w);
          const [recordBefore] = await w.admin<{ compartments: string[] }>(
            "select compartments from ledger.agent_writes where id = $1",
            [finding],
          );
          const keep = { move, answer: "keep" as const, requestId: request() };
          const ruling = await admin.cards.judgeResult(keep);
          expect(await admin.cards.judgeResult(keep)).toBe(ruling);
          // Keep again changes nothing and writes nothing.
          expect(await admin.cards.judgeResult({ move, answer: "keep", requestId: request() })).toBe(ruling);
          const written = (await decisions(w)).filter((one) => !before.some((was) => was.id === one.id));
          expect(written.map((one) => one.kind)).toEqual(["result_eval"]);
          const label = await session(w.db.urls.work, async (query) => (await reportOf(query, move))?.compartments);
          expect(written[0]?.compartments).toEqual(label);
          expect(await w.latest("opportunity", opportunity)).toBe("done");
          expect(await w.admin("select compartments from ledger.agent_writes where id = $1", [finding])).toEqual([
            recordBefore,
          ]);
          expect(await cardsOn(w, move)).toEqual([]);
          expect((await admin.cards.results()).results.find((one) => one.move === move)?.judged).toBe("keep");
          // Not useful supersedes it; `none` clears it.
          await admin.cards.judgeResult({ move, answer: "not_useful", requestId: request() });
          expect((await admin.cards.results()).results.find((one) => one.move === move)?.judged).toBe("not_useful");
          await admin.cards.judgeResult({ move, answer: "none", requestId: request() });
          expect((await admin.cards.results()).results.find((one) => one.move === move)?.judged).toBeNull();
          // Clearing it again is not a decision (the last in force is the owner's `none`): its ruling again.
          expect(await admin.cards.judgeResult({ move, answer: "none", requestId: request() })).toMatch(/^rul_/);

          // Erasing the task's record (`pia agent-records rm` of the finding its report cites) removes
          // the result.
          expect(await admin.agents.removeRecord(finding)).not.toBeNull();
          expect((await admin.cards.results()).results.map((one) => one.move)).not.toContain(move);
          await expect(admin.cards.judgeResult({ move, answer: "keep", requestId: request() })).rejects.toMatchObject({
            code: "not_found",
          });
        } finally {
          await dispatch.close();
          await admin.close();
        }
      },
      ["own", ...AGENTS],
    ));

  it("a blocked task, back on the board, is not a result", () =>
    withWorkWorld(
      async (w) => {
        await setTaskTier(w.admin, true, new Date());
        const agent = await scout(w);
        const { opportunity, message } = await task(w, agent);
        const { move } = await worked(w, agent, opportunity, message.id, "blocked");
        expect(await w.latest("opportunity", opportunity)).toBe("go");
        const admin = createAdmin({ url: w.db.urls.admin, keys: w.db.keys, log: w.log });
        try {
          expect((await admin.cards.results()).results.map((one) => one.move)).not.toContain(move);
          await expect(admin.cards.judgeResult({ move, answer: "keep", requestId: request() })).rejects.toMatchObject({
            code: "not_found",
          });
        } finally {
          await admin.close();
        }
      },
      ["own", ...AGENTS],
    ));

  it("a task-result card raised before the feed is withdrawn quietly by the system, and the result stays in the feed", () =>
    withWorkWorld(
      async (w) => {
        await setTaskTier(w.admin, true, new Date());
        const agent = await scout(w);
        const { opportunity, message } = await task(w, agent);
        const { move } = await worked(w, agent, opportunity, message.id, "done");
        // A task-result card as it was raised before the feed.
        const card = await session(w.db.urls.work, async (query) => {
          const report = await reportOf(query, move);
          if (report === null) throw new Error("no report");
          const raised = await raiseCard(
            query,
            {
              id: newId("crd") as CardId,
              requestId: newId("crd"),
              kind: "outcome",
              author: authorOf(report.by) as CardAuthor,
              options: ["acknowledge", "dismiss"],
              target: { kind: "move", id: move },
              refs: [],
              compartments: report.compartments as never,
              expiresAt: null,
              expiresAfterDays: 14,
              caseKey: `outcome:${move}`,
              run: null,
              body: null,
              bodyFrom: null,
            },
            { now: new Date() },
          );
          return raised.id;
        });
        expect(await w.latest("card", card)).toBe("pending");
        const dispatch = createDispatch({ url: w.db.urls.work, log: w.log, journal: "" });
        const admin = createAdmin({ url: w.db.urls.admin, keys: w.db.keys, log: w.log });
        try {
          expect(await dispatch.withdrawTaskResultCards(new Date())).toBe(1);
          // Withdrawn by the system, never as an answer from the owner, with no notice; a second pass finds none.
          const events = await w.admin<{ event: string; by: string }>(
            "select event, by from ledger.record_events where row_kind = 'card' and row_id = $1 order by id",
            [card],
          );
          expect(events.at(-1)).toEqual({ event: "withdrawn", by: "system:work" });
          expect(events.some((one) => one.by === "owner")).toBe(false);
          expect(await w.admin("select 1 from ledger.cards where kind = 'notice'")).toEqual([]);
          expect(await dispatch.withdrawTaskResultCards(new Date())).toBe(0);
          expect((await admin.cards.results()).results.map((one) => one.move)).toContain(move);
          // The owner's veto of the work's kind outranks it (invariant 11): it leaves the feed, as no card
          // was raised on vetoed work, and takes no judgment.
          await w.vetoKind("investigate");
          expect((await admin.cards.results()).results.map((one) => one.move)).not.toContain(move);
          await expect(admin.cards.judgeResult({ move, answer: "keep", requestId: request() })).rejects.toMatchObject({
            code: "not_found",
          });
        } finally {
          await dispatch.close();
          await admin.close();
        }
      },
      ["own", ...AGENTS],
    ));
});
