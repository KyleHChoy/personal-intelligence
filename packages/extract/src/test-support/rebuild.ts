import type { BeliefChangeReport } from "@intelligence/contracts/personal";
import { type BeliefInputs, beliefsFor, needQuestions } from "@intelligence/personal-beliefs";
import type { ExtractDeps } from "../config.ts";
import type { MemoryPipelineStore } from "./memory-store.ts";

// The unit tests' belief build, over the in-memory store alone: no stored belief exists outside it, and a read computes each belief with the same `beliefsFor`. For each audience,
// the active clients' and the owner's, and each stored fact key, the claims within the audience's clearance that the kind's rule counts go to buildBelief, with the kind's
// conflict rule. The owner's rulings reach it as inputs it already takes, for every kind: a rejected claim is one the store's beliefClaims leaves out, and a fact veto is a
// decision on the belief, given to every audience that holds its compartments.

// `changes` is the durable work's report, one entry by fact key and audience. Its `changeKind` is
// backfill for every change of a run that took an item due by a generation change. `refused` counts the
// joined sets an audience did not join (more than FACT_GROUP_MAX keys, a pair the owner split inside
// their own joins, or keys no longer of one kind and one subject).
type RebuildSummary = {
  beliefs: number;
  changed: number;
  mixed: number;
  refused: number;
  failed: number;
  removed: number;
  ms: number;
  changes: BeliefChangeReport;
};

// An audience as the store keeps it: its compartments sorted.
const audienceKey = (audience: readonly string[]): string => JSON.stringify([...audience].sort());

// `regenerated` reports every change as backfill: a run that took an item due by a generation
// change, whose changes are by generation alone.
export async function rebuildBeliefs(
  given: Pick<ExtractDeps, "store" | "now">,
  options: { regenerated?: boolean } = {},
): Promise<RebuildSummary> {
  // A unit test's store is always the in-memory one, which alone keeps belief rows.
  const deps = { now: given.now, store: given.store as MemoryPipelineStore };
  const started = deps.now().getTime();
  const asOf = deps.now().toISOString();
  // And the owner's joins and splits, the accepted grouping rows and grouping's mode (D12, `shadow` when the
  // store gives none). And the claim relations and their switch rows, which a read applies: without them a stored
  // belief still counts a claim a later one superseded.
  const {
    mark,
    decisions,
    retirements,
    reclassifications,
    goAt,
    reopens,
    factRulings = [],
    groupings = [],
    groupingMode = "shadow",
    relations,
    switches,
  } = await deps.store.beliefDecisions();
  // The active clients' audiences and the owner's: every compartment of the stored claims, so the
  // owner's reads see each fact once whatever clients are registered. It is built as any other, once
  // when a client already has it, and kept by the prune.
  const audiences = await deps.store.audiences();
  // Only a client's audience reports its changes: the owner's alone is read by the owner, and it
  // moves whenever a compartment gets its first claim, which would report every one of its beliefs as
  // new.
  const reporting = new Set(audiences.map(audienceKey));
  const owner = await deps.store.ownerAudience();
  if (owner.length > 0 && !reporting.has(audienceKey(owner))) audiences.push(owner);
  const groups = await deps.store.beliefClaims();
  const inputs: BeliefInputs = {
    groups,
    decisions,
    retirements,
    reclassifications,
    goAt,
    ...(reopens === undefined ? {} : { reopens }),
    factRulings,
    groupings,
    groupingMode,
    ...(relations === undefined ? {} : { relations }),
    ...(switches === undefined ? {} : { switches }),
  };
  const summary: RebuildSummary = {
    beliefs: 0,
    changed: 0,
    mixed: 0,
    refused: 0,
    failed: 0,
    removed: 0,
    ms: 0,
    changes: [],
  };
  // A store step whose failure is counted, the rebuild going on.
  const counted = async (step: () => Promise<unknown>): Promise<void> => {
    try {
      await step();
    } catch {
      summary.failed += 1;
    }
  };

  for (const audience of audiences) {
    const built = beliefsFor(inputs, audience, asOf);
    const rows = built.rows;
    summary.refused += built.refused;
    summary.mixed += built.mixed;
    summary.failed += built.failed;
    try {
      const { changed, changes, stale } = await deps.store.replaceBeliefs(audience, rows, mark);
      if (stale) {
        summary.failed += 1;
        continue;
      }
      summary.beliefs += rows.length;
      summary.changed += changed;
      if (reporting.has(audienceKey(audience)))
        for (const change of changes)
          summary.changes.push(options.regenerated === true ? { ...change, changeKind: "backfill" } : change);
    } catch {
      // The next run repairs this audience; the others are written.
      summary.failed += 1;
    }
  }

  // The owner's needs asked as questions, each an about_you card the owner may confirm,
  // the latest first, up to the store's daily cap. A failure raises none; the next run asks again.
  await counted(() => deps.store.raiseNeedQuestions(needQuestions(groups, asOf)));

  // The cards of reopened settlements, and of claims a card that ended unanswered held back. A
  // failure raises none; the next run raises them.
  await counted(() => deps.store.raiseSettledClaims());
  // On a failure the next run prunes; what was written is still counted.
  await counted(async () => {
    summary.removed = (await deps.store.pruneAudiences(audiences)).removed;
  });
  summary.ms = Math.max(0, Math.round(deps.now().getTime() - started));
  return summary;
}
