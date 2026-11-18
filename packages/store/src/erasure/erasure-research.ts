import { removeRecords } from "../write/writer-records.ts";
import { FILL_ROWS, fillTag } from "../write/writer-research.ts";
import { type ErasureHook, peopleOf } from "./erasure-hook.ts";
import { taintCiting } from "./taint.ts";

// So nothing a fill found about the erased stays, and a replay finds no fill to land again. A dry
// run counts.

export const researchFillsErasure: ErasureHook = {
  name: "research_fills",
  taints: true,
  async run(query, erased, { dryRun }) {
    const nodes = peopleOf(erased);
    if (nodes.length === 0) return 0;
    const fills = (
      await query<{ id: string }>(
        "select id from ledger.agent_writes where kind = 'fill' and fill_node = any($1::text[]) order by id",
        [nodes],
      )
    ).map((row) => row.id);
    if (fills.length === 0) return 0;
    const prefixes = FILL_ROWS.flatMap(([table, prefix]) =>
      fills.map((fill) => [table, `${prefix}_${fillTag(fill)}_`] as const),
    );
    if (dryRun) {
      let rows = 0;
      for (const [table, prefix] of prefixes)
        rows +=
          (await query<{ n: number }>(`select count(*)::int as n from ${table} where starts_with(id, $1)`, [prefix]))[0]
            ?.n ?? 0;
      const live =
        (
          await query<{ n: number }>(
            "select count(*)::int as n from ledger.agent_writes where id = any($1::text[]) and body_enc is not null",
            [fills],
          )
        )[0]?.n ?? 0;
      return live + rows;
    }
    let removed = 0;
    for (const [table, prefix] of prefixes)
      removed += (await query<{ id: string }>(`delete from ${table} where starts_with(id, $1) returning id`, [prefix]))
        .length;
    const records = await removeRecords({ query }, fills);
    if (records.evidenceIds.length > 0) await taintCiting(query, { evidenceIds: records.evidenceIds, refs: [] });
    return removed + records.removed;
  },
};
