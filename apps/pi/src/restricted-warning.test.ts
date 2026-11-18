import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "./logger.ts";
import { ISOLATED_NOTE, ownFlag, RESTRICTED_OFF_HINT, warnRestrictedOff } from "./restricted-warning.ts";

// `pia clients add`, `oauth approve` and `clients set-compartments` warn while no restricted
// category is on that a client cleared for `own` reads the owner's health, money and legal facts.

function context() {
  const stderr = new PassThrough();
  let text = "";
  stderr.on("data", (chunk: Buffer) => {
    text += chunk.toString("utf8");
  });
  const io = { stderr } as unknown as Parameters<typeof warnRestrictedOff>[0]["io"];
  const log = createLogger(stderr, () => new Date(0));
  return { context: { io, log }, written: () => text };
}

describe("the warning while no restricted category is on", () => {
  it("names health, money and legal facts under own, on stderr, for a client cleared for own", () => {
    const { context: made, written } = context();
    warnRestrictedOff(made, ["own", "agent:scout"], 0);
    const lines = written().trimEnd().split("\n");
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      event: "client_restricted_off",
      level: "warn",
      code: "no_restricted_category",
    });
    expect(lines[1]).toBe(RESTRICTED_OFF_HINT);
    expect(RESTRICTED_OFF_HINT).toMatch(/health, money and legal facts under own/);
    // It tells the owner nothing to run that the box would refuse.
    expect(RESTRICTED_OFF_HINT).toContain("not yet available on the box");
    expect(RESTRICTED_OFF_HINT).not.toContain("pia ");
  });

  it("says nothing once a category is on, or for a client not cleared for own", () => {
    for (const [compartments, on] of [
      [["own"], 1],
      [["agent:scout"], 0],
    ] as const) {
      const { context: made, written } = context();
      warnRestrictedOff(made, compartments, on);
      expect(written(), JSON.stringify(compartments)).toBe("");
    }
  });
});

describe("--own and its old name --isolated", () => {
  it("each clears for own; --isolated also says, on stderr, that it is --own", () => {
    for (const [values, own, note] of [
      [{ own: true }, true, ""],
      [{ isolated: true }, true, `${ISOLATED_NOTE}\n`],
      [{}, false, ""],
    ] as const) {
      const { context: made, written } = context();
      expect(ownFlag({ io: made.io, values }), JSON.stringify(values)).toBe(own);
      expect(written(), JSON.stringify(values)).toBe(note);
    }
    expect(ISOLATED_NOTE).toContain("--own");
  });
});
