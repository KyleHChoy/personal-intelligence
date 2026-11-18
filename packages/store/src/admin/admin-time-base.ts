import { RESTRICTED_PREFIX } from "@intelligence/contracts/personal";
import type { Keys } from "../core/keys.ts";

// Before the transaction's first statement, so its snapshot is one for every statement.
export const REPEATABLE = "set transaction isolation level repeatable read";

// Every compartment the key file holds but a restricted one.
export const unrestrictedOf = (keys: Keys): string[] =>
  [...keys.compartments.keys()].filter((compartment) => !compartment.startsWith(RESTRICTED_PREFIX)).sort();
