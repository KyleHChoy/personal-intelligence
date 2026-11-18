import { isCoded } from "@intelligence/contracts/personal";
import type { Keys } from "./keys.ts";
import { openUnder, type RowRef, type Sealed } from "./seal.ts";

/** @deprecated Use `open(keys, row, column, "withheld")`. */
export type RowOpener = (at: RowRef, compartments: string[], envelope: unknown) => string | null;

/** @deprecated Use `open(keys, row, column, "withheld")`; a locked compartment throws `restricted_locked` here. */
export const openWith =
  (keys: Keys): RowOpener =>
  (at, compartments, envelope) => {
    try {
      return openUnder(keys, compartments, at, envelope as Sealed);
    } catch (error) {
      if (isCoded(error, "unknown_compartment")) return null;
      throw error;
    }
  };
