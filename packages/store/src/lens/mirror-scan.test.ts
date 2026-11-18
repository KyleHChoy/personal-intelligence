import { type ClientView, MIRROR_TEMPLATES, type MirrorTemplate } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import type { ClientGroups, Ctx } from "../core/read-ctx.ts";
import { SCAN_ROWS, SECTIONS, type SectionContext } from "./mirror-sections.ts";

// A scan says where it stopped apart from the rows it keeps, so a scan whose every row was left out
// is not read as the section's end. The sections' scans on a fake token: each statement answers
// from a table here, and nothing is opened. Made-up ids only.

const T1 = MIRROR_TEMPLATES.find((one) => one.name === "lens_mirror@1") as MirrorTemplate;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
// The n-th of a run of ids in key order.
const idOf = (prefix: string, n: number): string =>
  `${prefix}_${[...n.toString(32).padStart(26, "0")].map((digit) => CROCKFORD[Number.parseInt(digit, 32)]).join("")}`;
const hex = (n: number, seed: string): string => `${seed}${n.toString(16)}`.padStart(64, "0").slice(-64);

const client = {
  id: "cli_test",
  name: "mac",
  compartments: ["own"],
  views: ["self", "people", "work"],
  tools: ["sync_mirror"],
} as unknown as ClientView;

// A token whose statements answer by what they read: `answer` picks the rows for a statement.
const context = (answer: (text: string) => unknown[], groups: Partial<ClientGroups> = {}): SectionContext => {
  const ctx = {
    // The read time a computed belief takes (answer-time.ts): the transaction's own clock.
    run: (text: string) =>
      Promise.resolve(
        text.startsWith("select now() as at") ? [{ at: new Date("2026-09-01T12:00:00.000Z") }] : answer(text),
      ),
    keys: {},
    session: () => Promise.resolve("ses_test"),
    log: { info() {}, warn() {}, error() {} },
  } as unknown as Ctx;
  const all: ClientGroups = {
    empty: true,
    membersOf: (id) => [id],
    idOf: (id) => id,
    shared: () => false,
    joined: [],
    ...groups,
  };
  return { ctx, client, template: T1, now: new Date("2026-10-08T00:00:00Z"), groups: all };
};

describe("a scan's last key is the last row it covered", () => {
  it("entities: a scan of 2 000 people none of whom leads a group keeps no row, is not complete, and ends at the last person scanned", async () => {
    const people = Array.from({ length: SCAN_ROWS + 1 }, (_, n) => ({ id: idOf("ent", n + 10), kind: "person" }));
    // Every one of them is a group member whose lead (a lower id) the scan did not reach.
    const scan = await SECTIONS.entities.scan(
      context((text) => (text.includes("from knowledge.entities e") ? people : []), {
        idOf: () => idOf("ent", 1),
        membersOf: (id) => [idOf("ent", 1), id],
      }),
      null,
    );
    expect(scan.rows).toEqual([]);
    expect(scan.complete).toBe(false);
    expect(scan.last).toBe(people[SCAN_ROWS - 1]?.id);
  });

  it("entities: the control, a scan that reached the section's end, is complete", async () => {
    const people = [{ id: idOf("ent", 3), kind: "person" }];
    const scan = await SECTIONS.entities.scan(
      context((text) => (text.includes("from knowledge.entities e") ? people : [])),
      null,
    );
    expect(scan.rows.map((row) => row.key)).toEqual([people[0]?.id]);
    expect(scan.complete).toBe(true);
    expect(scan.last).toBe(people[0]?.id);
  });

  it("facts: a scan that cut a key's claims keeps the keys before it, and ends at the last key it keeps", async () => {
    const evidence = hex(7, "e");
    // Two keys: the first with 1 500 claims, the second with 501, of which the scan reads 500.
    const claims = Array.from({ length: SCAN_ROWS + 1 }, (_, n) => {
      const fact = hex(n < 1_500 ? 1 : 2, "f");
      return {
        id: hex(n, "c"),
        type: "commitment",
        fact_key_fp: fact,
        compartments: ["own"],
        evidence_id: evidence,
        key: `${evidence}:${fact}`,
      };
    });
    const scan = await SECTIONS.facts.scan(
      context((text) => (text.includes("from knowledge.claims c\n  left join knowledge.messages") ? claims : [])),
      null,
    );
    expect(scan.rows.map((row) => row.key)).toEqual([`${evidence}:${hex(1, "f")}`]);
    expect(scan.complete).toBe(false);
    expect(scan.last).toBe(`${evidence}:${hex(1, "f")}`);
  });
});
