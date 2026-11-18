import { describe, expect, it } from "vitest";
import { RelationId, ReportWrongRelationArgs, ReportWrongRelationResult } from "./relation-reports.ts";
import { TOOL_VIEW } from "./tools.ts";
import { PersonalWorkArgs, PersonalWorkResults } from "./work.ts";

// Made-up values only.

const MSG = `msg_${"0".repeat(26)}`;
const DOC = `doc_${"1".repeat(26)}`;
const REQUEST = "request-0001";

describe("report_wrong_relation", () => {
  it("is a work tool with its own strict arguments and result", () => {
    expect(PersonalWorkArgs.report_wrong_relation).toBe(ReportWrongRelationArgs);
    expect(PersonalWorkResults.report_wrong_relation).toBe(ReportWrongRelationResult);
    expect(TOOL_VIEW).not.toHaveProperty("report_wrong_relation");
  });

  it("takes a relation id, a code from the closed list, messages and documents, and a request id", () => {
    const args = { relation: "42", because: "not_same_fact", cites: [MSG, DOC], requestId: REQUEST };
    expect(ReportWrongRelationArgs.parse(args)).toEqual(args);
    expect(ReportWrongRelationArgs.parse({ ...args, cites: [] }).cites).toEqual([]);
  });

  it("refuses a code of the agent's own, an id that is not a relation's, another cite, too many cites and an unknown field", () => {
    const args = { relation: "42", because: "not_same_fact", cites: [MSG], requestId: REQUEST };
    expect(ReportWrongRelationArgs.safeParse({ ...args, because: "looks_wrong" }).success).toBe(false);
    for (const relation of ["0", "-1", "4.2", "rel_42", "1".repeat(19)])
      expect(RelationId.safeParse(relation).success, relation).toBe(false);
    expect(ReportWrongRelationArgs.safeParse({ ...args, cites: [`ent_${"0".repeat(26)}`] }).success).toBe(false);
    expect(ReportWrongRelationArgs.safeParse({ ...args, cites: Array(21).fill(MSG) }).success).toBe(false);
    expect(ReportWrongRelationArgs.safeParse({ ...args, extra: true }).success).toBe(false);
  });

  it("answers a report and where it stands, or a refusal by its code", () => {
    const report = `rrp_${"0".repeat(26)}`;
    expect(ReportWrongRelationResult.parse({ report, state: "agreed" })).toEqual({ report, state: "agreed" });
    expect(ReportWrongRelationResult.parse({ refused: "owner_ruled" })).toEqual({ refused: "owner_ruled" });
    expect(ReportWrongRelationResult.safeParse({ refused: "not_found" }).success).toBe(false);
  });
});
