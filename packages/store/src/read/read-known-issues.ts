import type { Timestamp } from "@intelligence/contracts";
import {
  type ClientView,
  KNOWN_ISSUE_SAY,
  type KnownIssueArea,
  type KnownIssueStatus,
  type PackItem,
} from "@intelligence/contracts/personal";
import { type Ctx, servedOrNull, Unavailable } from "../core/read-ctx.ts";

// agent_bootstrap@14's known issues: the defects in area mcp or
// sources that the defect role is working on, by ledger.known_issues, which gates the caller as
// list_improvements does and reads only rows within its clearance and keys (invariant 6). Each is
// its id, its area, its status, its severity and its title, opened under its own label and served
// as untrusted; never its detail. The function refuses a client without list_improvements, so a
// client without it is not asked at all, as a section whose view it lacks is not.
type KnownIssueItem = Extract<PackItem, { kind: "known_issue" }>;

const KNOWN = "select id, area, status, severity, by_system, compartments, title_enc from ledger.known_issues($1)";

type Row = {
  id: KnownIssueItem["id"];
  area: KnownIssueArea;
  status: KnownIssueStatus;
  severity: KnownIssueItem["severity"];
  by_system: boolean;
  compartments: string[];
  title_enc: unknown;
};

export const knownIssuesServed = (client: ClientView): boolean => client.tools.includes("list_improvements");

export async function knownIssuesOf(
  ctx: Ctx,
  client: ClientView,
  cap: number,
  asOf: Timestamp,
): Promise<KnownIssueItem[]> {
  const rows = await ctx.run<Row>(KNOWN, [cap]);
  return rows.map((row): KnownIssueItem => {
    // A row whose label is outside the clearance reached this process through a function written
    // wrongly: the second barrier, as for a pack's records.
    if (!row.compartments.every((compartment) => client.compartments.includes(compartment))) throw new Unavailable();
    return {
      id: row.id,
      section: "known_issues",
      required: false,
      provenance: row.by_system ? "source" : "agent_reported",
      asOf,
      kind: "known_issue",
      area: row.area,
      status: row.status,
      severity: row.severity,
      title: servedOrNull(
        ctx.keys,
        row.compartments,
        { table: "ledger.improvements", id: row.id, column: "title_enc" },
        row.title_enc,
      ),
      say: KNOWN_ISSUE_SAY,
    };
  });
}
