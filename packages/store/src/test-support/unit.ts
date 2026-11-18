// What the store's tests without a database share: a logger that drops every event, keys that
// hold no compartment, and the error a call throws.

import type { PersonalLogger } from "@intelligence/contracts/personal";
import type { Keys } from "../core/keys.ts";

export const log: PersonalLogger = { info: () => {}, warn: () => {}, error: () => {} };

export const keys: Keys = { compartments: new Map(), fingerprintKey: Buffer.alloc(32) };

// The error `fn` throws, or undefined when it returns.
export const thrown = (fn: () => unknown): (Error & { code?: string }) | undefined => {
  try {
    fn();
  } catch (error) {
    return error as Error & { code?: string };
  }
  return undefined;
};
