import { promptTextHash } from "@intelligence/personal-models";
import { describe, expect, it } from "vitest";
import { RECALL_AUDIT_PROMPT } from "./question-prompts.ts";
import { auditRecall, type RecallAsk, type RecallCase, recallJudge, recallSlot } from "./recall-audit.ts";

// The recall audit's pure part: a blind question, a found cite checked against what was sent, and counts.
const one = (over: Partial<RecallCase> = {}): RecallCase => ({
  filter: "mail_no_deadline_word",
  targetKey: "a".repeat(64),
  evidenceId: "e".repeat(64),
  question: "owed",
  line: "Tuition balance must be settled",
  passages: [{ text: "Your tuition balance must be settled before Friday.", at: "2026-11-01T00:00:00.000Z" }],
  population: 7,
  subject: `facts:${"a".repeat(64)}:${"b".repeat(64)}`,
  compartments: ["own"],
  ...over,
});
const found = (text: string, passage = 1): Awaited<ReturnType<RecallAsk>> => ({
  output: { verdict: "found", cites: [{ passage, text }] },
});
const none: Awaited<ReturnType<RecallAsk>> = { output: { verdict: "none", cites: [] } };

describe("the recall audit", () => {
  it("names no filter to the model", () => {
    const slot = recallSlot(one());
    expect(slot).not.toContain("mail_no_deadline_word");
    expect(JSON.parse(slot)).toEqual({
      question: "owed",
      line: "Tuition balance must be settled",
      passages: [{ n: 1, text: "Your tuition balance must be settled before Friday.", said: "2026-11-01" }],
    });
  });

  it("counts a found line with a real cite as missed, and a none as rightly dropped", async () => {
    const answers = [found("must be settled before Friday"), none];
    const run = await auditRecall(
      [one(), one({ targetKey: "c".repeat(64) })],
      async () => answers.shift() as Awaited<ReturnType<RecallAsk>>,
      { calls: 5 },
    );
    expect(run.counts).toMatchObject({ cases: 2, calls: 2, missed: 1, rightlyDropped: 1 });
    expect(run.rows.map((row) => [row.verdict, row.code, row.cited])).toEqual([
      ["missed", null, 1],
      ["rightly_dropped", null, null],
    ]);
    // A row is ids, codes and counts: no word of a passage or a line.
    expect(JSON.stringify(run.rows)).not.toContain("settled");
    expect(run.rows[0]).toMatchObject({ population: 7, compartments: ["own"] });
  });

  it("records a found line whose cite is not in the passage as uncited, never as missed", async () => {
    const run = await auditRecall([one()], async () => found("the quarterly board minutes are overdue"), { calls: 1 });
    expect(run.rows[0]).toMatchObject({ verdict: null, code: "uncited" });
    expect(run.counts.missed).toBe(0);
  });

  it("makes no call for a case with no passage, and stops at the budget and at an outage", async () => {
    let asked = 0;
    const ask: RecallAsk = async () => {
      asked += 1;
      return none;
    };
    const empty = await auditRecall([one({ passages: [{ text: null, at: "2026-11-01T00:00:00.000Z" }] })], ask, {
      calls: 1,
    });
    expect(empty.rows[0]).toMatchObject({ code: "no_passage" });
    expect(asked).toBe(0);
    const budget = await auditRecall([one(), one()], ask, { calls: 1 });
    expect([budget.stopped, budget.rows.length]).toEqual(["budget", 1]);
    const out = await auditRecall([one()], async () => "unavailable", { calls: 1 });
    expect([out.stopped, out.rows.length]).toEqual(["unavailable", 0]);
    const rejected = await auditRecall([one()], async () => ({ rejected: "cal_x" }), { calls: 1 });
    expect(rejected.rows[0]).toMatchObject({ code: "rejected" });
  });

  it("pins its prompt's text", () => {
    const { textHash, ...rest } = RECALL_AUDIT_PROMPT;
    expect(promptTextHash(rest)).toBe(textHash);
  });

  it("judges under the model and the prompt's version", () => {
    expect(recallJudge("test/opus")).toBe("model:test/opus@personal_recall_audit@1");
  });
});
