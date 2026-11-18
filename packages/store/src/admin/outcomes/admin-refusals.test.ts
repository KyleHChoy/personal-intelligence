import { REASK_WINDOW } from "@intelligence/personal-core/planner";
import { describe, expect, it } from "vitest";
import { reaskStops } from "./admin-refusals.ts";

// The stops `pi outcomes` reports are the run's own rule over the same counts: a full window with
// no rescue, under the wording its prompt used last.

const at = (day: number) => new Date(Date.UTC(2026, 0, day));
const OLD = "personal_correspondence_reask@3#aaaaaaaaaaaa";
const NEW = "personal_correspondence_reask@4#bbbbbbbbbbbb";
const FINDING = "personal_agent_record_reask@2#cccccccccccc";

describe("reaskStops", () => {
  it("reports a code whose last full window rescued nothing, by code and wording", () => {
    expect(
      reaskStops([
        { wording: NEW, code: "not_in_passage", asked: REASK_WINDOW, rescued: 0, last: at(2) },
        { wording: NEW, code: "part_of_line", asked: REASK_WINDOW, rescued: 1, last: at(2) },
        { wording: FINDING, code: "not_in_passage", asked: REASK_WINDOW - 1, rescued: 0, last: at(2) },
      ]),
    ).toEqual([{ reason: "not_in_passage", wording: NEW, code: "no_rescue", window: REASK_WINDOW }]);
  });

  it("lifts when the wording changes: an older wording of the same prompt is not in force", () => {
    const old = { wording: OLD, code: "not_in_passage", asked: REASK_WINDOW, rescued: 0, last: at(1) };
    expect(reaskStops([old])).toHaveLength(1);
    expect(reaskStops([old, { wording: NEW, code: "not_in_passage", asked: 3, rescued: 0, last: at(2) }])).toEqual([]);
  });
});
