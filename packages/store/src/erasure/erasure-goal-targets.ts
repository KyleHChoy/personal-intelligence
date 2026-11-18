import { LATEST_GOAL_TARGET } from "../core/stored-forms.ts";
import { countOf as count, type ErasureHook, peopleOf } from "./erasure-hook.ts";

// Invariant 10: a goal that targets an erased person targets no one. Every goal_target decision
// naming the person, or a pending target on an erased item, is tainted by ledger.taint_goal_targets,
// its `entity` made null and its `named` removed; then every goal state row that targets the person,
// or whose latest goal_target decision now names no one and waits on no name, loses its target, as
// projections.goal_state's rebuild would set it. A restore's replay repeats both. A dry run counts the
// decisions and the rows targeting the person. A pending target's item is the owner's own, never an
// agent record's, so its evidence is the revisions'.
export const goalTargets: ErasureHook = {
  name: "goal_targets",
  taints: true,
  async run(query, erased, { dryRun }) {
    const people = peopleOf(erased);
    const decisions = await count(query, "select ledger.taint_goal_targets($1::text[], $2::text[], $3) as n", [
      people,
      erased.evidenceIds,
      dryRun,
    ]);
    if (dryRun)
      return (
        decisions +
        (await count(
          query,
          "select count(*)::int as n from projections.goal_state where target_entity_id = any ($1::text[])",
          [people],
        ))
      );
    if (decisions === 0 && people.length === 0) return 0;
    const states = await count(
      query,
      `with gone as (update projections.goal_state g set target_entity_id = null
         where g.target_entity_id is not null
           and (g.target_entity_id = any ($1::text[])
             or exists (select 1 from (${LATEST_GOAL_TARGET}) t where t.target_id = g.goal_id and t.details ->> 'entity' is null and not t.details ? 'named'))
         returning 1)
       select count(*)::int as n from gone`,
      [people],
    );
    return decisions + states;
  },
};

// At a replay the journal's suppressed fingerprints, names among them, are the addresses, so both are
// read. A dry run counts the proposals.
export const goalTargetNames: ErasureHook = {
  name: "goal_target_names",
  taints: true,
  async run(query, erased, { dryRun }) {
    const names = [...new Set([...erased.addressFps, ...erased.nameFps])];
    if (names.length === 0) return 0;
    const reached = await count(
      query,
      "select count(distinct row_id)::int as n from ledger.basis where row_kind = 'goal_proposal' and ref_kind = 'target_name' and ref_id = any ($1::text[]) and tainted_at is null",
      [names],
    );
    if (!dryRun && reached > 0)
      await query(
        "select ledger.taint_citing('{}'::text[], array_fill('target_name'::text, array[$1::int]), $2::text[])",
        [names.length, names],
      );
    return reached;
  },
};
