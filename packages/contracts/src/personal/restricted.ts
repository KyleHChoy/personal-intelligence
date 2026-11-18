import { z } from "zod";
import { RestrictedCategory } from "./compartments.ts";

// Restricted compartments.

// What a row of vault.restriction_requests asks: a category added to an item, or the owner's lift
// of one.
export const RestrictionRequestKind = z.enum(["restrict", "lift"]);
export type RestrictionRequestKind = z.infer<typeof RestrictionRequestKind>;

const count = z.number().int().nonnegative();

// One line of `pi restricted list`: an on category and counts, never anything an item says.
export const RestrictedCount = z.strictObject({
  category: RestrictedCategory,
  items: count,
  pending: count,
  lifts: count,
});
export type RestrictedCount = z.infer<typeof RestrictedCount>;
