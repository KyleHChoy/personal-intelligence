import type { Query } from "../core/db.ts";
import type { Keys } from "../core/keys.ts";

// What one erasure erased, read after its locks and before anything is removed, the same for every hook.
export type Erased = {
  evidenceIds: string[];
  // Counted before entity deletion cascades the same-person questions and their answers.
  identityQuestions?: number;
  // The belief rulings anchored on the erased evidence or people, read before the removal empties
  // their anchors. Absent on a dry run, which reads them itself.
  anchoredRulings?: string[];
  // Everything a ref can name of what went: its messages, events, documents, pages and captures, its
  // people and its goals.
  refs: { kind: string; id: string }[];
  addressFps: string[];
  nameFps: string[];
  sources: { accountId: string; sourceItemFp: string }[];
  // The agent records removed with the items, and their evidence rows.
  records: string[];
  recordEvidenceIds: string[];
  // The erasure's id, null on a dry run.
  erasureId: string | null;
  // The fact key fingerprints of every claim of the erased revisions and their agent records and,
  // for a person, of every claim naming the person: each claim's own key and its version 1 keys.
  // And the keys of the rulings anchored on what is erased, which may be keys a generation moved
  // since (taint.ts, anchoredKeys), and of every belief ruling the scrub reaches (admin-erase.ts,
  // factKeys).
  factKeyFps: string[];
  // Those of them that are gone: no claim that stays holds the key, and no ruling on it is still
  // anchored on evidence that stays. What an erasure removes by a fact key, it removes by these.
  // Read once by the erasure; a hook run without them reads them itself (erasure-fact-keys.ts,
  // goneOf).
  goneKeyFps?: string[];
  // Every claim key of those claims, own and version 1, and their ids.
  claimKeys: string[];
  claimIds: string[];
};

// `keys`: the admin's, for a hook that opens a sealed value.
type ErasureRun = { dryRun: boolean; now: Date; keys: Keys };

// One table's part in an erasure: what the hooks in erasure-hooks.ts and the modules beside it each are.
// A lower snake case name. Its count goes into ErasureReport.more under that name, and a dry run
// counts what the real run would change, changing nothing: running the real statement and rolling it
// back would fire its triggers and take its row locks.
// `taints`: it taints rows in this transaction, which what links the taints must follow. `after`:
// the hooks it must run after, by name (and with `taints`, every hook that taints), and why.
export type ErasureHook = {
  name: string;
  taints?: true;
  after?: { hooks: readonly string[]; taints?: true; why: string };
  run(query: Query, erased: Erased, options: ErasureRun): Promise<number>;
};

// Every evidence row that goes: the revisions, and the evidence rows of the agent records resting on them.
export const allEvidence = (erased: Erased): string[] => [...erased.evidenceIds, ...erased.recordEvidenceIds];

export const idsOf = (erased: Erased, kind: string): string[] =>
  erased.refs.filter((ref) => ref.kind === kind).map((ref) => ref.id);
export const peopleOf = (erased: Erased): string[] => idsOf(erased, "entity");

export const countOf = async (query: Query, text: string, values: unknown[] = []): Promise<number> =>
  (await query<{ n: number }>(text, values))[0]?.n ?? 0;

// One table's rows by one where clause: what a dry run counts is what the real run deletes.
export const removing = (
  query: Query,
  dryRun: boolean,
  table: string,
  where: string,
  values: unknown[],
): Promise<number> =>
  countOf(
    query,
    dryRun
      ? `select count(*)::int as n from ${table} where ${where}`
      : `with gone as (delete from ${table} where ${where} returning 1) select count(*)::int as n from gone`,
    values,
  );

export type Removal = { table: string; where: string; values(erased: Erased): unknown[] };

// A hook that only deletes, stated as its rows: each table in the order given, a table that names
// another first. `when`: whether this erasure can reach anything of it at all.
export const removes = (name: string, rows: readonly Removal[], when?: (erased: Erased) => boolean): ErasureHook => ({
  name,
  async run(query, erased, { dryRun }) {
    if (when !== undefined && !when(erased)) return 0;
    let n = 0;
    for (const { table, where, values } of rows) n += await removing(query, dryRun, table, where, values(erased));
    return n;
  },
});
