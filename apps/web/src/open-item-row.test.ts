import { OpenItem } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { dueFigure, fromWords } from "./open-item-row.tsx";

// Where an open item says it came from, and its row's meta.
const OWNER = { id: `ent_${"0".repeat(26)}`, kind: "owner", name: null, address: null };
const raw = (source: object, over: object = {}) =>
  OpenItem.parse({
    what: { untrusted: "Grant application" },
    due: "2026-11-08",
    source: { kind: "plan", id: "a".repeat(64), ...source },
    whoActs: OWNER,
    project: null,
    overdue: false,
    lateDays: null,
    ...over,
  });
const NOW = new Date(2026, 10, 4, 12);

describe("where an open item says it came from", () => {
  it("an agent's report names the agent and says it is unconfirmed, never your mail", () => {
    expect(fromWords(raw({ record: `rec_${"1".repeat(26)}`, agent: "writer" }).source)).toBe(
      "writer reported this, unconfirmed",
    );
    expect(fromWords(raw({ record: `rec_${"1".repeat(26)}` }).source)).toBe("An agent reported this, unconfirmed");
  });
  it("a plan in mail says so; an agent's next step names the agent", () => {
    expect(fromWords(raw({ message: `msg_${"2".repeat(26)}` }).source)).toBe("A plan in your mail");
    expect(fromWords(raw({ kind: "next_step", record: `rec_${"1".repeat(26)}`, agent: "writer" }).source)).toBe(
      "A next step from writer",
    );
  });
});

describe("its meta", () => {
  it("says how late, or when it is due, or nothing undated", () => {
    expect(dueFigure(raw({}, { overdue: true, lateDays: 2 }), NOW)).toBe("2 days late");
    expect(dueFigure(raw({}), NOW)).toMatch(/^due /);
    expect(dueFigure(raw({}, { due: null }), NOW)).toBeUndefined();
  });
});
