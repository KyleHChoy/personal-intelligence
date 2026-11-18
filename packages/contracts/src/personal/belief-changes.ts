import { z } from "zod";
import { ChangeKind } from "../evidence.ts";
import { BeliefKind } from "../ontology.ts";
import { PersonalCompartment } from "./compartments.ts";
import { Hex64 } from "./primitives.ts";

// What a belief rebuild reports for each fact whose state changed. The shared BeliefChange
// (../belief.ts) in the personal store's names: the stored fact key fingerprint, the audience the
// belief was built for, the shared kind, and the change kind of the claim that decides it. No
// label, value or date: a report says that a fact moved, never what it says. A removal is not
// reported: it wakes nothing. One entry for one fact and audience: a state change is reported as
// such even when a review also fell due.

const sortedOnce = (list: readonly string[]): boolean =>
  list.every((one, index) => index === 0 || (list[index - 1] as string) < one);

export const PersonalBeliefChange = z.strictObject({
  factKeyFp: Hex64,
  audience: z.array(PersonalCompartment).min(1).refine(sortedOnce, { message: "audience not sorted, or repeated" }),
  kind: BeliefKind,
  event: z.enum(["state_changed", "review_due"]),
  changeKind: ChangeKind,
});
export type PersonalBeliefChange = z.infer<typeof PersonalBeliefChange>;

export const BeliefChangeReport = z
  .array(PersonalBeliefChange)
  .refine(
    (changes) => new Set(changes.map((one) => `${one.factKeyFp}\n${one.audience.join(",")}`)).size === changes.length,
    { message: "a fact and audience reported twice" },
  );
export type BeliefChangeReport = z.infer<typeof BeliefChangeReport>;
