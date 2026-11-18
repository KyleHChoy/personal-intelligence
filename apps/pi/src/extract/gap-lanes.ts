import type { PersonalLogger } from "@intelligence/contracts/personal";
import type { GapLaneStore } from "@intelligence/personal-store";
import { closesAtOnce, gapPass } from "../work/gap-pass.ts";

// The pipeline's pass over the three warmth lanes, close_no_tie, close_no_role and explore, which
// rest on warmth ranked at read with the keys the tick does not hold: the tick's own gap pass, with the lanes' store as its dispatch, run by
// `pi extract` after each day build under the extract lock, and under the gap pass lock the tick's
// pass takes too, so the two never spend a label's daily cap at once. Close, then raise, each raise
// checked against rung 0 as the tick's is. One line of counts when anything moved.
export async function runGapLanes(
  store: Pick<
    GapLaneStore,
    "gapCandidates" | "gapFlags" | "gapSupply" | "raiseGapFlag" | "closeGapFlag" | "underGapPass"
  >,
  at: Date,
  log: PersonalLogger,
): Promise<void> {
  const { gaps, held } = await store.underGapPass(() =>
    gapPass(store, at, {
      raise: (gap, card) => store.raiseGapFlag(gap, card, { now: at, closesAtOnce }),
      close: (id) => store.closeGapFlag(id, at),
      log,
    }),
  );
  if (Object.values(gaps).some((n) => n > 0) || held.capped > 0)
    log.info({ event: "gap_lanes", counts: { ...gaps, capped: held.capped } });
}
