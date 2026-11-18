import type { MirrorEntry } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import type { Built, ScanRow } from "./mirror-sections.ts";
import { type FillOptions, fill } from "./mirror-sync.ts";

// What a call keeps of its scan, on rows and builds made here. An entry larger than the page's
// whole budget is dropped, never sent, so it cannot stall the mirror; a scan that kept nothing ends
// its range where the scan stopped. Made-up keys only.

const BUDGET = 1_000;
const rowOf = (key: string): ScanRow => ({ key, token: key.padEnd(64, "0") });
const built: Built = {
  section: "captures",
  value: null,
  fact: null,
  evidence: [],
  entities: [],
  anchors: [],
  compartments: ["own"],
};
// An entry of about `bytes` bytes of JSON.
const entryOf = (key: string, bytes: number): MirrorEntry =>
  ({
    section: "captures",
    stamp: { projection: `mir_${key}`, fact: null, state: "0".repeat(64) },
    capture: { pad: "x".repeat(bytes) },
  }) as unknown as MirrorEntry;

const options = (sizes: Record<string, number>, over: Partial<FillOptions> = {}): FillOptions => ({
  needs: () => true,
  build: (rows) => Promise.resolve(new Map(rows.map((row) => [row.key, built]))),
  stamp: (_built, key) => entryOf(key, sizes[key] ?? 10),
  limit: 500,
  budget: BUDGET,
  late: () => false,
  ...over,
});

describe("one entry over the page budget does not stall the mirror", () => {
  it("an entry no page can hold is dropped, its key found, and the entries after it are sent", async () => {
    const rows = ["k1", "k2", "k3"].map(rowOf);
    const filled = await fill(rows, null, options({ k1: 10, k2: BUDGET * 2, k3: 10 }));
    expect(filled.accepted.map((one) => one.row.key)).toEqual(["k1", "k3"]);
    expect(filled.dropped.map((one) => one.row.key)).toEqual(["k2"]);
    expect(filled.found).toEqual(["k1", "k2", "k3"]);
    expect(filled.last).toBeNull();
  });

  it("a page whose only entry is too large still moves: the range covers it", async () => {
    const filled = await fill([rowOf("k1")], "k1", options({ k1: BUDGET * 2 }));
    expect(filled.accepted).toEqual([]);
    expect(filled.dropped.map((one) => one.row.key)).toEqual(["k1"]);
    expect(filled.last).toBe("k1");
  });

  it("the control: an entry that fits the budget alone but not beside the others ends the page before it", async () => {
    const rows = ["k1", "k2", "k3"].map(rowOf);
    const filled = await fill(rows, "k3", options({ k1: 600, k2: 600, k3: 10 }));
    expect(filled.accepted.map((one) => one.row.key)).toEqual(["k1"]);
    expect(filled.dropped).toEqual([]);
    expect(filled.found).toEqual(["k1"]);
    expect(filled.last).toBe("k1");
  });
});

describe("a scan that kept no row ends where it stopped", () => {
  it("no rows kept and a scan not complete: the range runs to the last key scanned, not to the section's end", async () => {
    const filled = await fill([], "ent_01JZZZZZZZZZZZZZZZZZZZZZZZ", options({}));
    expect(filled.found).toEqual([]);
    expect(filled.last).toBe("ent_01JZZZZZZZZZZZZZZZZZZZZZZZ");
  });

  it("rows whose builds show nothing: the range still runs to the last key scanned", async () => {
    const filled = await fill(["k1", "k2"].map(rowOf), "k9", options({}, { build: () => Promise.resolve(new Map()) }));
    expect(filled.accepted).toEqual([]);
    expect(filled.last).toBe("k9");
  });
});
