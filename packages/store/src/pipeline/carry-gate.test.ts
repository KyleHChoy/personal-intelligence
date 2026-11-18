import { describe, expect, it } from "vitest";
import { replayedCall } from "./call-key.ts";
import { gateOf } from "./carry-gate.ts";

const row = (n: number, state: string) => ({ ruling_id: `rul_${n}`, state });

describe("gateOf", () => {
  it("counts a ruling with no anchor and a detached one, and nothing else", () => {
    const gate = gateOf(
      6,
      [
        row(1, "unanchored"),
        row(2, "detached"),
        row(3, "pending"),
        row(4, "lost"),
        row(5, "gone"),
        row(6, "carries"),
        row(7, "carries"),
      ],
      1,
    );
    expect(gate).toEqual({
      generation: 6,
      max: 1,
      refused: true,
      unanchored: ["rul_1"],
      detached: ["rul_2"],
      pending: 1,
      lost: 1,
      gone: 1,
      carries: 2,
    });
  });

  it("is open at the line and refused one over it", () => {
    const rows = [row(1, "detached"), row(2, "unanchored")];
    expect(gateOf(6, rows, 2).refused).toBe(false);
    expect(gateOf(6, rows, 1).refused).toBe(true);
    expect(gateOf(6, [], 0).refused).toBe(false);
    expect(gateOf(6, [row(1, "detached")], 0).refused).toBe(true);
  });

  it("is never refused by what it cannot yet tell, what code carries, or what went before", () => {
    const rows = [row(1, "pending"), row(2, "carries"), row(3, "lost"), row(4, "gone")];
    expect(gateOf(6, rows, 0)).toMatchObject({ refused: false, unanchored: [], detached: [] });
  });

  it("reads a state it does not know as detached", () => {
    expect(gateOf(6, [row(1, "something_new")], 0)).toMatchObject({ refused: true, detached: ["rul_1"] });
  });
});

describe("replayedCall", () => {
  const call = (id: string, key_version: number, model_id: string) => ({ id, key_version, model_id });

  it("replays the model's own version 2 call, never another model's", () => {
    const rows = [call("a", 2, "model-one"), call("b", 2, "model-two")];
    expect(replayedCall(rows, "model-two")?.id).toBe("b");
    expect(replayedCall(rows, "model-three")).toBeUndefined();
  });

  it("reads a version 1 call by its own key, whatever model asks", () => {
    const rows = [call("old", 1, "model-one")];
    expect(replayedCall(rows, "model-one")?.id).toBe("old");
    expect(replayedCall(rows, "model-two")?.id).toBe("old");
  });

  it("prefers the model's own call to a version 1 call, and falls back to it beside another model's", () => {
    const rows = [call("old", 1, "model-one"), call("new", 2, "model-two")];
    expect(replayedCall(rows, "model-two")?.id).toBe("new");
    expect(replayedCall(rows, "model-three")?.id).toBe("old");
  });

  it("finds nothing among no calls", () => {
    expect(replayedCall([], "model-one")).toBeUndefined();
  });
});
