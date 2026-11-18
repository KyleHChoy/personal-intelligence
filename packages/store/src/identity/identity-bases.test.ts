import { describe, expect, it } from "vitest";
import { compareCandidates, localPartNames, type OrderKey } from "./identity-bases.ts";

describe("the address basis's names", () => {
  it("first.last and first_last spell one name, normalized as a name fingerprint is", () => {
    expect(localPartNames("avery.lund@example.test")).toEqual(["avery lund"]);
    expect(localPartNames("Avery_Lund@example.test")).toEqual(["avery lund"]);
    expect(localPartNames("avery.lund+news@example.test")).toEqual(["avery lund"]);
  });

  it("firstlast spells every split with two letters or more on each side", () => {
    expect(localPartNames("averylund@example.test")).toEqual([
      "av erylund",
      "ave rylund",
      "aver ylund",
      "avery lund",
      "averyl und",
      "averylu nd",
    ]);
  });

  it("a local part with digits, one letter on a side, a third part or no @ spells nothing", () => {
    for (const address of [
      "avery.lund2@example.test",
      "a.lund@example.test",
      "avery.l@example.test",
      "avery.m.lund@example.test",
      "abc@example.test",
      "averylund",
      "@example.test",
      "j0hn@example.test",
    ]) {
      expect(localPartNames(address), address).toEqual([]);
    }
  });

  it("a very long joined local part is not read as a name", () => {
    expect(localPartNames(`${"a".repeat(41)}@example.test`)).toEqual([]);
  });
});

describe("the sweep's order", () => {
  const sorted = (keys: OrderKey[]): string[] => [...keys].sort(compareCandidates).map((one) => one.key);

  it("tier first, then newest evidence, then fingerprints; no evidence goes last in its tier", () => {
    expect(
      sorted([
        { rank: 2, latest: 500, key: "e" },
        { rank: 0, latest: 100, key: "b" },
        { rank: 0, latest: null, key: "a" },
        { rank: 0, latest: 300, key: "c" },
        { rank: 0, latest: 300, key: "d" },
        { rank: 1, latest: 50, key: "f" },
      ]),
    ).toEqual(["c", "d", "b", "a", "f", "e"]);
  });
});
