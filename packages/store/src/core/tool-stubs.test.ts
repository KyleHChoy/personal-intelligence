import type { PersonalLogEvent, PersonalLogger } from "@intelligence/contracts/personal";
import type pg from "pg";
import { describe, expect, it } from "vitest";
import { Reader } from "../read/read.ts";
import type { Keys } from "./keys.ts";

// The port stub of the one read tool not built. It answers unavailable with one failure event and
// reaches no database: no statement, so no policy.calls row, until the step that builds its tool.

const keys: Keys = { compartments: new Map(), fingerprintKey: Buffer.alloc(32) };

function harness() {
  const events: PersonalLogEvent[] = [];
  const log: PersonalLogger = {
    info: (e) => void events.push(e),
    warn: (e) => void events.push(e),
    error: (e) => void events.push(e),
  };
  let connects = 0;
  const pool = {
    connect: () => {
      connects += 1;
      return Promise.reject(new Error("no statement may be sent"));
    },
    query: () => Promise.reject(new Error("no statement may be sent")),
  } as unknown as pg.Pool;
  const reader = new Reader({ pool, keys, log });
  return { reader, events, connects: () => connects };
}

const UNAVAILABLE = { ok: false, code: "unavailable" };

describe("the stub", () => {
  it("get_decision_history answers unavailable and writes no call row", async () => {
    const { reader, events, connects } = harness();
    // get_suggestions is served, so it is not here.
    expect(await reader.getDecisionHistory("pit_token", {})).toEqual(UNAVAILABLE);
    expect(events).toEqual([{ event: "read_failed", code: "unavailable" }]);
    expect(connects()).toBe(0);
  });
});
