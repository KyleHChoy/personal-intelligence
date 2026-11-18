import type { PersonalLogger } from "@intelligence/contracts/personal";
import { pinnedClock } from "../core/answer-time.ts";
import type { Query } from "../core/db.ts";
import type { Keys } from "../core/keys.ts";
import type { Ctx } from "../read/read-ctx.ts";

// A reader's context for an owner read that reuses a reader's function: the owner's own query and
// keys, and the clock a test pinned on the transaction (answer-time.ts). Those functions take the
// whole context, and the owner has no session to give them.
export const ownerCtx = (query: Query, keys: Keys, log: PersonalLogger): Ctx => {
  const now = pinnedClock(query);
  return {
    run: (text, values) => query(text, values),
    keys,
    session: () => Promise.reject(new Error("the owner has no session")),
    log,
    ...(now === undefined ? {} : { now }),
  };
};
