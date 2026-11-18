import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { repoRoot } from "@intelligence/personal-core";
import { describe, expect, it } from "vitest";
import { storeFiles, storeText } from "../test-support/sources.ts";

// Read from the source of the processes that decide, wake, rank, label, gate, send or serve: the
// dispatcher, the reader, Work, the sender and its gate, the pipeline store, and the reasoner's
// request. None names a learning table or the reverse dependency index, and every statement of
// theirs that reads knowledge.owner_decisions names the kinds it reads, so a decision of the
// learning item's kinds (a harm mark, a label) is never "the latest".
const REASONER = join(repoRoot(), "apps/reasoner/src");

const LEARNING =
  /\b(?:ledger\.(?:move_result_links|outcome_assessments|silence_samples|owner_views|forecasts|move_lessons)|projections\.reverse_dependency_index)\b/;
// A string literal of the source: a template (its ${} parts included), or a quoted string.
const LITERAL = /`(?:[^`\\]|\\.)*`|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g;
// A read of knowledge.owner_decisions: the table after `from` or `join`, with its alias if any.
const READ =
  /\b(?:from|join)\s+knowledge\.owner_decisions\b(?:\s+(?:as\s+)?(?!where\b|join\b|on\b|order\b|group\b|limit\b|left\b|inner\b|cross\b|union\b)([a-z_]\w*))?/gi;
// The read's own `kind = ...`, `kind in (...)` or `kind = any (...)`: on its alias when it has
// one, else bare; never `target_kind`, and never another table's kind.
const kindOf = (alias: string | undefined): RegExp =>
  alias === undefined ? /(?:^|[^\w.])kind\s*(?:=|in\s*\()/i : new RegExp(`\\b${alias}\\.kind\\s*(?:=|in\\s*\\()`, "i");

const isInScope = (file: string): boolean =>
  /^(?:dispatch|read|work|sender|pipeline)[\w-]*\.ts$/.test(file) &&
  !file.includes(".test.") &&
  !file.includes("fixtures") &&
  !file.includes("test-world");

function inertFaults(file: string, text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(LITERAL)) {
    const literal = match[0];
    if (LEARNING.test(literal)) found.push(`${file}@${match.index}: names a learning table`);
    for (const read of literal.matchAll(READ)) {
      if (!kindOf(read[1]).test(literal))
        found.push(`${file}@${match.index}: reads knowledge.owner_decisions without a kind condition`);
    }
  }
  return found;
}

async function sources(): Promise<{ file: string; text: string }[]> {
  const store = storeFiles().filter(isInScope);
  const reasoner = (await readdir(REASONER)).filter((file) => file.endsWith(".ts") && !file.includes(".test.")).sort();
  return Promise.all([
    ...store.map(async (file) => ({ file, text: storeText(file) })),
    ...reasoner.map(async (file) => ({ file: `reasoner/${file}`, text: await readFile(join(REASONER, file), "utf8") })),
  ]);
}

describe("learning rows are inert", () => {
  it("no statement of the dispatcher, reader, Work, sender, pipeline or gate names a learning table", async () => {
    const files = await sources();
    // The scope is what it says: each process has its files here.
    for (const head of ["dispatch", "read", "work", "sender", "pipeline", "reasoner/"])
      expect(
        files.some((one) => one.file.startsWith(head)),
        head,
      ).toBe(true);
    expect(
      files.flatMap(({ file, text }) => inertFaults(file, text)).filter((fault) => fault.endsWith("learning table")),
    ).toEqual([]);
  });

  it("none reads knowledge.owner_decisions without a kind condition", async () => {
    const files = await sources();
    const reads = files.filter(({ text }) =>
      [...text.matchAll(LITERAL)].some((match) => [...match[0].matchAll(READ)].length > 0),
    );
    // The reads that exist, the goal wakes and case closings, are found and pass.
    expect(reads.map(({ file }) => file)).toContain("dispatch-read.ts");
    expect(reads.map(({ file }) => file)).toContain("dispatch-wakes.ts");
    expect(
      files.flatMap(({ file, text }) => inertFaults(file, text)).filter((fault) => fault.endsWith("kind condition")),
    ).toEqual([]);
  });

  it("fails on a planted statement", () => {
    const planted = [
      'const a = await query("select count(*) from ledger.outcome_assessments");',
      'const m = await query("select lesson_id from ledger.move_lessons where move_id = $1");',
      "const b = await query(`select * from projections.reverse_dependency_index where fact_key_fp = $1`);",
      "const c = await query(`select d.answer from knowledge.owner_decisions d where d.target_kind = 'opportunity' and d.target_id = $1`);",
      'const d = "select id from knowledge.owner_decisions where card_id = $1";',
      "const e = await query(`select d.answer from knowledge.owner_decisions d join ledger.cards c on c.id = d.card_id where c.kind = 'outcome'`);",
      "const f = await query(`insert into knowledge.owner_decisions (id) select id from knowledge.owner_decisions where target_id = $1`);",
    ].join("\n");
    expect(inertFaults("planted.ts", planted)).toEqual([
      expect.stringMatching(/names a learning table$/),
      expect.stringMatching(/names a learning table$/),
      expect.stringMatching(/names a learning table$/),
      expect.stringMatching(/without a kind condition$/),
      expect.stringMatching(/without a kind condition$/),
      expect.stringMatching(/without a kind condition$/),
      expect.stringMatching(/without a kind condition$/),
    ]);
    // The controls: a kind condition, a kind list, and a write.
    const kept = [
      "const e = await query(`select id from knowledge.owner_decisions d where d.kind in ('goal_set', 'goal_status')`);",
      "const f = await query(`select id from knowledge.owner_decisions where kind = 'answer' and card_id = $1`);",
      'const g = await query("insert into knowledge.owner_decisions (id) values ($1)");',
    ].join("\n");
    expect(inertFaults("kept.ts", kept)).toEqual([]);
  });
});
