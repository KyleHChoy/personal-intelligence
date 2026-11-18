import { createHash } from "node:crypto";
import { claimKey } from "../core/fingerprint.ts";
import type { Ctx } from "../core/read-ctx.ts";
import { asOfOf } from "../read/computed-beliefs.ts";

// The mirror's beliefs scan token of each fact key: the ids, times, labels and marks
// policy.belief_inputs gives of its claims and of the rulings, groupings, relations and settlements
// on it, clear columns alone, so a quiet pass compares tokens, computes nothing and opens no sealed
// column.

const sha = (parts: readonly unknown[]): string =>
  createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex");

// The clear columns of what a belief of these keys is computed from (no sealed body).
const BELIEF_INPUT_MARKS = `
  select i.part, i.id, i.evidence_id, i.fact_key_fp, i.other_fp, i.legacy, i.word, i.at, i.compartments, i.flags
  from policy.belief_inputs($1::text[], $2::timestamptz) as i
  order by i.part, i.id, i.fact_key_fp, i.other_fp`;
// policy.belief_inputs takes at most this many fact keys a call.
const INPUT_KEYS = 1000;
type Mark = {
  part: string;
  id: string | null;
  evidence_id: string | null;
  fact_key_fp: string | null;
  other_fp: string | null;
  legacy: string[] | null;
  word: string | null;
  at: Date | null;
  compartments: string[] | null;
  flags: string[] | null;
};
// Each fact key's token from the marks: its claims' rows, the rows naming it (rulings, groupings,
// settlements), the relations naming one of its claims by claim key, and the settings every key
// reads.
function beliefTokens(ctx: Ctx, facts: readonly string[], marks: readonly Mark[]): Map<string, string> {
  const factOfClaimKey = new Map<string, string>();
  for (const mark of marks)
    if (mark.part === "claim" && mark.evidence_id !== null && mark.fact_key_fp !== null)
      for (const fp of [mark.fact_key_fp, ...(mark.legacy ?? [])])
        factOfClaimKey.set(claimKey(ctx.keys, mark.evidence_id, fp), mark.fact_key_fp);
  const shown = (mark: Mark) => [
    mark.part,
    mark.id,
    mark.evidence_id,
    mark.fact_key_fp,
    mark.other_fp,
    mark.legacy,
    mark.word,
    mark.at === null ? null : mark.at.toISOString(),
    mark.compartments,
    mark.flags,
  ];
  const byFact = new Map<string, unknown[]>(facts.map((fact) => [fact, []]));
  const add = (fact: string | undefined | null, mark: Mark) => {
    if (fact !== undefined && fact !== null) byFact.get(fact)?.push(shown(mark));
  };
  const settings = marks.filter((mark) => mark.part === "settings").map(shown);
  for (const mark of marks) {
    if (mark.part === "settings") continue;
    if (mark.part === "relation") {
      add(factOfClaimKey.get(mark.fact_key_fp ?? ""), mark);
      add(factOfClaimKey.get(mark.other_fp ?? ""), mark);
      continue;
    }
    add(mark.fact_key_fp, mark);
    if (mark.other_fp !== mark.fact_key_fp) add(mark.other_fp, mark);
  }
  return new Map([...byFact].map(([fact, rows]) => [fact, sha(["beliefs", settings, rows])]));
}

// The token of each of these fact keys, as of the read time.
export async function beliefMarkTokens(ctx: Ctx, facts: readonly string[]): Promise<Map<string, string>> {
  const asOf = (await asOfOf(ctx)).toISOString();
  const marks: Mark[] = [];
  for (let start = 0; start === 0 || start < facts.length; start += INPUT_KEYS)
    marks.push(...(await ctx.run<Mark>(BELIEF_INPUT_MARKS, [facts.slice(start, start + INPUT_KEYS), asOf])));
  return beliefTokens(ctx, facts, marks);
}
