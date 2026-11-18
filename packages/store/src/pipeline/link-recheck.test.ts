import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recheckDeviceAnchor } from "../admin/projects/admin-projects.ts";
import type { Query } from "../core/db.ts";
import { generateKeyFile, type Keys, loadKeys } from "../core/keys.ts";
import { LINK_TYPES, servedAsFact, TITLE_LINK_TYPE } from "../core/link-types.ts";
import { sealUnder } from "../core/seal.ts";
import { type StatusFacts, statusAt } from "../core/status-facts.ts";
import { regrouped } from "./pipeline-due-captures.ts";

// The anchor re-check over a query that answers as the database would, and the regrouping of due
// moments by their saved calls. The database's own tests are lens-link-anchors.db.test.ts. Ids that
// are valid but mean nothing.

let dir = "";
let keys: Keys;
const OWN = ["own"];
const id = (n: number) => n.toString(16).padStart(64, "0");
const [MATCHED, MEMBER, FAILED, CALLED_FAILED, OUTSIDE] = [1, 2, 3, 4, 5].map(id) as [
  string,
  string,
  string,
  string,
  string,
];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-link-recheck-"));
  await generateKeyFile(join(dir, "keys.json"), OWN);
  keys = await loadKeys(join(dir, "keys.json"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const facts = (status: StatusFacts["status"], code?: StatusFacts["code"]): StatusFacts =>
  ({
    lane: "moment",
    override: false,
    status,
    ...(code === undefined ? {} : { code }),
    attempts: 0,
    claims: 1,
    unmapped: 0,
    unresolved: 0,
  }) as StatusFacts;

// The database as the re-check reads it: MATCHED, FAILED and CALLED_FAILED meet the anchor;
// MEMBER shares MATCHED's saved call; OUTSIDE is another moment of their day that shares none.
function database(seen: { sql: string; values: unknown[] }[]): Query {
  const status = (evidenceId: string, one: StatusFacts) => ({
    evidence_id: evidenceId,
    compartments: OWN,
    facts_enc: sealUnder(keys, OWN, statusAt(evidenceId), JSON.stringify(one)),
  });
  return (async (sql: string, values: unknown[] = []) => {
    seen.push({ sql, values });
    if (sql.includes("from knowledge.captures c") && sql.includes("match_fps"))
      return [MATCHED, FAILED, CALLED_FAILED].map((one) => ({ evidence_id: one }));
    if (sql.includes("from vault.model_call_members m"))
      return [{ evidence_id: MATCHED }, { evidence_id: MEMBER }, { evidence_id: CALLED_FAILED }];
    if (sql.includes("from knowledge.claims where evidence_id = any")) return [{ id: "link-1" }];
    if (sql.includes("as called")) {
      return [
        { ...status(MATCHED, facts("done")), called: true },
        { ...status(MEMBER, facts("done")), called: true },
        { ...status(FAILED, facts("failed", "model_refused_item")), called: false },
        { ...status(CALLED_FAILED, facts("failed", "bad_output" as never)), called: true },
      ];
    }
    if (sql.includes("from vault.pipeline_items where evidence_id = any")) {
      const asked = (values[0] as string[]) ?? [];
      return asked.map((one) => ({ ...status(one, facts("done")), extractor_generation: 4, waiting: false }));
    }
    return [];
  }) as Query;
}

describe("the re-check of a device anchor", () => {
  it("removes the matched items' links alone, and sets waiting the widened set but a failed item with no saved call", async () => {
    const seen: { sql: string; values: unknown[] }[] = [];
    const waited = await recheckDeviceAnchor(
      { query: database(seen), keys },
      { anchorFp: "a".repeat(64), compartments: ["own"] as never },
    );
    // Restricted rows are left out of both capture reads.
    for (const read of seen.filter((one) => one.sql.includes("knowledge.captures c")))
      expect(read.sql).toContain("not policy.is_restricted(c.compartments)");
    // The links of the matched items only: never of MEMBER, which was only widened in.
    const links = seen.find((one) => one.sql.includes("from knowledge.claims where evidence_id = any"));
    expect(links?.values).toEqual([[MATCHED, FAILED, CALLED_FAILED], [...LINK_TYPES]]);
    // The evidence rows of the widened set are locked; OUTSIDE, in no saved call of theirs, is not.
    const locked = seen.find((one) => one.sql.includes("for no key update"));
    expect(locked?.values[0]).toEqual([MATCHED, MEMBER, FAILED, CALLED_FAILED].sort());
    // Waiting: MATCHED, MEMBER and CALLED_FAILED; never FAILED, which a run would only ask again.
    const replayed = seen.find((one) => one.sql.includes("extractor_generation, waiting from vault.pipeline_items"));
    expect(replayed?.values[0]).toEqual([MATCHED, MEMBER, CALLED_FAILED]);
    expect(waited).toBe(3);
    expect(JSON.stringify(seen)).not.toContain(OUTSIDE);
  });
});

describe("the re-check of a moment with no saved call", () => {
  it("widens to the moment's group, by local day, bundle, thread and label, and sets the group waiting", async () => {
    const [SOLO, NEIGHBOUR] = [6, 7].map(id) as [string, string];
    const seen: { sql: string; values: unknown[] }[] = [];
    const status = (evidenceId: string) => ({
      evidence_id: evidenceId,
      compartments: OWN,
      facts_enc: sealUnder(keys, OWN, statusAt(evidenceId), JSON.stringify(facts("skipped", "not_extracted"))),
      called: false,
    });
    const query = (async (sql: string, values: unknown[] = []) => {
      seen.push({ sql, values });
      if (sql.includes("from knowledge.captures c") && sql.includes("match_fps")) return [{ evidence_id: SOLO }];
      if (sql.includes("from vault.model_call_members m")) return [];
      if (sql.includes("join knowledge.captures o")) return [{ evidence_id: NEIGHBOUR }, { evidence_id: SOLO }];
      if (sql.includes("as called")) return [status(SOLO), status(NEIGHBOUR)];
      if (sql.includes("from vault.pipeline_items where evidence_id = any"))
        return ((values[0] as string[]) ?? []).map((one) => ({
          ...status(one),
          extractor_generation: 4,
          waiting: false,
        }));
      return [];
    }) as Query;
    expect(
      await recheckDeviceAnchor({ query, keys }, { anchorFp: "a".repeat(64), compartments: ["own"] as never }),
    ).toBe(2);
    // The group's read keys on the four columns, for the matched moments with no saved call.
    const group = seen.find((one) => one.sql.includes("join knowledge.captures o"));
    for (const column of ["local_day", "bundle_fp", "thread_fp", "compartments"])
      expect(group?.sql).toContain(`o.${column}`);
    expect(group?.sql).toContain("not exists (select 1 from vault.model_call_members");
    expect(group?.values).toEqual([[SOLO]]);
    // The link of the matched moment alone; the neighbour is only widened in.
    expect(seen.find((one) => one.sql.includes("from knowledge.claims where evidence_id = any"))?.values[0]).toEqual([
      SOLO,
    ]);
    expect(seen.find((one) => one.sql.includes("for no key update"))?.values[0]).toEqual([SOLO, NEIGHBOUR].sort());
  });
});

describe("due moments regrouped by their saved calls", () => {
  const due = (...ids: string[]) => ids.map((evidenceId) => ({ evidenceId }));

  it("the moments of one saved call are one group again; the rest are grouped as before", () => {
    const saved = new Map([
      ["a", ["a", "c"]],
      ["c", ["a", "c"]],
    ]);
    expect(regrouped(due("a", "b", "c", "d"), saved)).toEqual([due("a", "c"), due("b", "d")]);
  });

  it("with no saved call the key is one list, as before", () => {
    expect(regrouped(due("a", "b"), new Map())).toEqual([due("a", "b")]);
  });

  it("two saved sets that share a due moment merge into one group", () => {
    const saved = new Map([
      ["a", ["a", "b"]],
      ["b", ["b", "c"]],
      ["c", ["b", "c"]],
    ]);
    expect(regrouped(due("a", "b", "c", "d"), saved)).toEqual([due("a", "b", "c"), due("d")]);
  });

  it("a saved member not due now is left out of its group", () => {
    expect(regrouped(due("a", "c"), new Map([["a", ["a", "b"]]]))).toEqual([due("a"), due("c")]);
  });
});

describe("one source for what no fact read serves", () => {
  it("servedAsFact refuses the title link alone", () => {
    expect(servedAsFact(TITLE_LINK_TYPE)).toBe(false);
    expect(LINK_TYPES.filter(servedAsFact)).toEqual(["capture.anchor"]);
  });
});
