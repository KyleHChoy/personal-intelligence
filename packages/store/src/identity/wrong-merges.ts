import type { PersonalLogger } from "@intelligence/contracts/personal";
import { WRONG_MERGE_WAIT_DAYS } from "@intelligence/personal-core/planner";
import type { Query } from "../core/db.ts";
import { requestIdOf } from "../core/ids.ts";

// Wrong merges at the sweep: the open reports a
// second agent agreed with become splits, each in a transaction of its own whose one lock call is
// the function's; then what disagrees or waited too long closes for the owner. Holds no rule: the
// database decides who agrees and what may be lifted.

type WrongMergeCounts = { open: number; toOwner: number } & Record<string, number>;

type Transactions = {
  transaction<T>(work: (query: Query) => Promise<T>): Promise<T>;
  log?: Pick<PersonalLogger, "info">;
};

// One request for each report a split is tried from, so a retry of the sweep repeats nothing.
const requestOf = (report: string): string => requestIdOf(`wrong-merge:${report}`);

export async function settleWrongMerges(admin: Transactions): Promise<WrongMergeCounts> {
  const open = await admin.transaction((query) =>
    query<{ id: string }>("select id from ledger.wrong_merge_reports where state = 'open' order by created_at, id"),
  );
  const counts: WrongMergeCounts = { open: open.length, toOwner: 0 };
  const made = new Set<string>();
  for (const report of open) {
    const row = await admin.transaction(async (query) => {
      const [one] = await query<{ code: string; rulings: string[] | null }>(
        "select code, rulings from ledger.split_wrong_merge($1, $2)",
        [report.id, requestOf(report.id)],
      );
      return one ?? { code: "not_found", rulings: null };
    });
    // The oldest report of a split settles it and closes the rest with it. A refused one's others
    // answer `closed`; a made one's answer `split` again with the same rulings, counted once.
    if (row.code === "closed") continue;
    const split = row.code === "split" ? (row.rulings ?? []).join(",") : null;
    if (split !== null && made.has(split)) continue;
    if (split !== null) made.add(split);
    counts[row.code] = (counts[row.code] ?? 0) + 1;
  }
  counts.toOwner = await admin.transaction(async (query) => {
    const [row] = await query<{ n: number }>("select ledger.wrong_merges_to_owner($1::integer) as n", [
      WRONG_MERGE_WAIT_DAYS,
    ]);
    return row?.n ?? 0;
  });
  // WM13: counts by code, and no id.
  if (counts.open > 0) admin.log?.info({ event: "wrong_merges", counts });
  return counts;
}

// WM12: a report rests on the messages and the addresses it cites. When one is erased the split made
// from the report is lifted first, as a deletion's lift, which excepts nothing: the merges it lifted
// are marked the same way, so the standing rule may read the pair again. Then the report goes. A
// report that only names an erased person cites nothing that went: its split stands between the
// people left, and the person leaves the report. ledger.forget_wrong_merges holds that rule. Run
// before the erasure deletes the rulings of the erased addresses. A dry run counts the reports the
// real run finds: a report holds ids, so the count is the same before the person is removed and
// after.
export async function eraseFromWrongMerges(
  query: Query,
  erased: { addressFps: string[]; evidenceIds: string[]; people: string[] },
  dryRun: boolean,
): Promise<number> {
  const [row] = await query<{ n: number }>(
    "select ledger.forget_wrong_merges($1::text[], $2::text[], $3::text[], $4) as n",
    [erased.evidenceIds, erased.addressFps, erased.people, dryRun],
  );
  return row?.n ?? 0;
}
