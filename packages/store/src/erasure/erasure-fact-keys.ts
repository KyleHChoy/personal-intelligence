import type { Query } from "../core/db.ts";
import { factsSubjectNames } from "../core/stored-forms.ts";
import { removeRecords } from "../write/writer-records.ts";
import { allEvidence, countOf as count, type Erased, type ErasureHook, peopleOf, removing } from "./erasure-hook.ts";
import { taintCiting } from "./taint.ts";

// Which of an erasure's fact keys are gone, and the hooks that take what holds one beside the
// belief rulings, the decisions and the trigger rows the hooks in erasure-hooks.ts take: an agent's
// close of the commitment, a join or a split, a `same_fact` card on the key and the owner's hide of
// a goal by it.

// Which of the erasure's fact keys are gone: the one rule,
// knowledge.gone_keys, given the evidence, the claims and the people that go, so its answer is the
// same before the removal, where a dry run asks, and after it.
export async function goneKeys(query: Query, erased: Erased): Promise<string[]> {
  if (erased.factKeyFps.length === 0) return [];
  const [row] = await query<{ gone: string[] }>(
    "select knowledge.gone_keys($1::text[], $2::text[], $3::text[], $4::text[]) as gone",
    [erased.factKeyFps, allEvidence(erased), erased.claimIds, peopleOf(erased)],
  );
  return row?.gone ?? [];
}

// The erasure's gone keys as it read them, or read now for a hook run on its own.
export const goneOf = async (query: Query, erased: Erased): Promise<string[]> =>
  erased.goneKeyFps ?? (await goneKeys(query, erased));

// An agent's close of a commitment whose key is gone is removed as every agent record of erased
// content is (writer-records.ts, removeRecords): its body, its evidence row and what was extracted
// from it go, and what cited that row is tainted. Its row stays, and keeps `close_fact_fp` until
// `subject_decisions` runs: ledger.taint_subject_decisions puts a random value in its place and
// deletes the reopen rows of the key (ledger.forget_commitment_keys). So no close of an erased
// commitment is in force again because the owner's reopen of it went: an emptied close is in force
// nowhere, and none is found by the key of a commitment stated again. A dry run counts the closes.
export const agentCloses: ErasureHook = {
  name: "agent_closes",
  taints: true,
  async run(query, erased, { dryRun }) {
    const gone = await goneOf(query, erased);
    if (gone.length === 0) return 0;
    const closes = await query<{ id: string }>(
      "select id from ledger.agent_writes where kind = 'close' and close_fact_fp = any ($1::text[]) order by id",
      [gone],
    );
    if (dryRun || closes.length === 0) return closes.length;
    const { evidenceIds } = await removeRecords(
      { query },
      closes.map((row) => row.id),
    );
    if (evidenceIds.length > 0) await taintCiting(query, { evidenceIds, refs: [] });
    return closes.length;
  },
};

// A `same_fact` card holds the second of its two fact keys as its case key, in clear, and cites
// nothing. One on a key that is gone is tainted, loses the key and is withdrawn
// (ledger.forget_fact_cards). A card whose target claim the erasure removed is tainted by that
// claim, with every other card about it (admin-erase.ts, claimRefs). A dry run counts the cards.
export const factCards: ErasureHook = {
  name: "fact_cards",
  async run(query, erased, { dryRun }) {
    const gone = await goneOf(query, erased);
    if (gone.length === 0) return 0;
    return count(query, "select ledger.forget_fact_cards($1::text[], $2) as n", [gone, dryRun]);
  },
};

// A same-fact judgment of such a key went with its claims (knowledge.same_fact_judgments, on delete cascade), so nothing here deletes it. The owner
// decisions behind the rulings stay, and lose the two keys their details held, so they hold ids only. A delete raises the rulings mark, so a rebuild
// that read the rulings before it is stale. A dry run counts the rulings and calls. Which keys are gone is one rule (erasure-hook.ts, `goneKeyFps`):
// no claim that stays holds the key, as its own or a version 1 key, and no ruling on it is still anchored on evidence that stays. So a join made on
// a key a generation moved since, awaiting its carry, goes with the fact it was made on when every item that stated it goes, and stays while one of
// them does.
const GONE = "select k.fp from unnest($1::text[]) as k (fp)";
export const factRulings: ErasureHook = {
  name: "fact_rulings",
  async run(query, erased, { dryRun }) {
    const values = [await goneOf(query, erased)];
    if (values[0]?.length === 0) return 0;
    const rulings = "a_fp = any ($1::text[]) or b_fp = any ($1::text[])";
    const calls = factsSubjectNames(GONE);
    if (dryRun) {
      return count(
        query,
        `select ((select count(*) from knowledge.fact_rulings where ${rulings}) + (select count(*) from vault.decision_calls where ${calls}))::int as n`,
        values,
      );
    }
    await query("select ledger.forget_fact_rulings($1::text[])", values);
    return count(
      query,
      `with gone as (delete from knowledge.fact_rulings where ${rulings} returning 1), calls as (delete from vault.decision_calls where ${calls} returning 1)
       select ((select count(*) from gone) + (select count(*) from calls))::int as n`,
      values,
    );
  },
};

// The owner's hide of a goal by a fact key that is gone, and that key's place, go with the
// key, as the owner's fact rulings do. An `adopt` row stays: it is the lineage an erasure reads
// (admin-erase-targets.ts withAdopted); a lifted one keeps an undone adoption's goal out of reads.
// A dry run counts them.
export const goalKeys: ErasureHook = {
  name: "goal_keys",
  async run(query, erased, { dryRun }) {
    const gone = await goneOf(query, erased);
    if (gone.length === 0) return 0;
    return (
      (await removing(
        query,
        dryRun,
        "knowledge.goal_key_rulings",
        "verdict = 'hide' and fact_key_fp = any ($1::text[])",
        [gone],
      )) + (await removing(query, dryRun, "projections.goal_key_ranks", "fact_key_fp = any ($1::text[])", [gone]))
    );
  },
};
