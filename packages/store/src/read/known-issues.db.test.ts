import { ContextPack, KNOWN_ISSUE_SAY } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { setClientRoles } from "../admin/admin-tasks.ts";
import { request } from "../test-support/clients.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { TASK_AGENT_TOOLS, type WorkClient } from "../test-support/work-clients.ts";
import { ok, type WorkWorld, withWorkWorld } from "../test-support/work-test-world.ts";

// agent_bootstrap@14's known issues: the defects of the tools and the sources whose latest status
// the defect role wrote, by ledger.known_issues. Synthetic rows only.

const LABELS = ["own", "agent:scout", "work"];
const DEFECT_TOOLS = ["list_improvements", "submit_improvement", "update_improvement"];
const TOOLS = [...TASK_AGENT_TOOLS, "build_context_pack", ...DEFECT_TOOLS];

type Known = {
  id: string;
  asOf: string;
  area: string;
  status: string;
  severity: string;
  title: { untrusted: string } | null;
};

async function known(w: WorkWorld, client: WorkClient): Promise<{ pack: ContextPack; items: Known[] }> {
  const pack = ContextPack.parse(ok(await w.reader.buildContextPack(client.token, { purpose: "agent_bootstrap" })));
  const items = pack.items.flatMap((item) => (item.kind === "known_issue" ? [item as unknown as Known] : []));
  return { pack, items };
}

const file = async (
  w: WorkWorld,
  by: WorkClient,
  title: string,
  options: { area?: string; severity?: string } = {},
): Promise<string> =>
  ok(
    await w.work.submitImprovement(by.token, {
      kind: "bug",
      area: options.area ?? "mcp",
      severity: options.severity ?? "medium",
      title,
      detail: `the detail of ${title}`,
      requestId: request(),
    } as never),
  ).improvement;

const mark = async (
  w: WorkWorld,
  by: WorkClient,
  improvement: string,
  status: string,
  fixRef?: string,
): Promise<void> => {
  const answer = ok(
    await w.work.updateImprovement(by.token, {
      improvement,
      status,
      requestId: request(),
      ...(fixRef === undefined ? {} : { fixRef }),
    } as never),
  );
  expect(answer).toMatchObject({ status });
};

describe("known issues in an agent's pack", { timeout: DB_TEST_TIMEOUT }, () => {
  it("serves only the tools' and sources' defects whose latest status the defect role wrote, titles untrusted, at most five, dropped when done; nothing while no defect role is set", () =>
    withWorkWorld(async (w) => {
      const fixer = await w.client("fixer", ["own"], { tools: TOOLS });
      const peer = await w.client("peer", ["own"], { tools: TOOLS });
      await setClientRoles(w.admin, "fixer", ["fixer"], new Date());

      // An agent's own defect, marked by itself: never every agent's, with or without a role set.
      const selfMarked = await file(w, peer, "Search drops the last page");
      await mark(w, peer, selfMarked, "in_progress", "pr:12");
      // The defect role marks one while no role is set: still nothing, since none holds it yet.
      const early = await file(w, peer, "Find messages skips a thread");
      await mark(w, fixer, early, "triaged");
      expect((await known(w, peer)).items).toEqual([]);

      await w.admin("update policy.work_settings set defect_role = 'fixer'");
      const triaged = await file(w, peer, "Timeline misses a day", { severity: "low" });
      await mark(w, fixer, triaged, "triaged");
      const taken = await file(w, peer, "Gmail sync stops at a large label", { area: "sources", severity: "high" });
      await mark(w, fixer, taken, "in_progress", "pr:44");
      const owners = await file(w, peer, "Calendar needs a new grant", { area: "sources" });
      await mark(w, fixer, owners, "triaged", "none:owners_to_change");
      const notReproduced = await file(w, peer, "Search returns nothing once");
      await mark(w, fixer, notReproduced, "triaged", "none:not_reproducible");
      const elsewhere = await file(w, peer, "The planner repeats a task", { area: "planner" });
      await mark(w, fixer, elsewhere, "in_progress", "pr:45");
      const untouched = await file(w, peer, "Read item is slow");

      const first = await known(w, peer);
      expect(first.pack.template).toBe("agent_bootstrap@16");
      // Most severe first, then the latest change; the role's earlier mark counts now its role is set.
      expect(first.items.map((item) => item.id)).toEqual([taken, owners, early, triaged]);
      expect(first.items.map((item) => item.id)).not.toContain(selfMarked);
      expect(first.items.map((item) => item.id)).not.toContain(notReproduced);
      expect(first.items.map((item) => item.id)).not.toContain(elsewhere);
      expect(first.items.map((item) => item.id)).not.toContain(untouched);
      expect(first.items[0]).toMatchObject({
        section: "known_issues",
        required: false,
        provenance: "agent_reported",
        kind: "known_issue",
        area: "sources",
        status: "in_progress",
        severity: "high",
        title: { untrusted: "Gmail sync stops at a large label" },
        say: KNOWN_ISSUE_SAY,
      });
      // Right after the record and before the open items, as the template has it.
      const sections = first.pack.items.map((item) => item.section);
      expect(sections.indexOf("known_issues")).toBeGreaterThan(sections.indexOf("guide"));
      // The filer's own later mark replaces the role's: no longer the role's word.
      await mark(w, peer, triaged, "in_progress", "pr:46");
      // Done is no known issue.
      await mark(w, fixer, early, "done");
      expect((await known(w, peer)).items.map((item) => item.id)).toEqual([taken, owners]);

      // At most five.
      for (const n of [1, 2, 3, 4]) await mark(w, fixer, await file(w, peer, `Tool ${n} times out`), "triaged");
      expect((await known(w, fixer)).items).toHaveLength(5);

      // A client that may not list the defects is not asked, and its pack is served.
      const reader = await w.client("reader", ["own"], { tools: [...TASK_AGENT_TOOLS, "build_context_pack"] });
      expect((await known(w, reader)).items).toEqual([]);
      // A client without the work view is left the section, as any section of a view it lacks.
      const selfOnly = await w.client("self-only", ["own"], { tools: TOOLS, views: ["self", "people"] });
      const narrow = await known(w, selfOnly);
      expect(narrow.items).toEqual([]);
      expect(narrow.pack.withheld).toContain("known_issues");
    }, LABELS));

  it("a defect under a label the viewer is not cleared for moves nothing it is served (invariant 6)", () =>
    withWorkWorld(async (w) => {
      const fixer = await w.client("fixer", ["agent:scout", "own"], { tools: TOOLS });
      const scout = await w.client("scout", ["agent:scout", "own"], { tools: TOOLS });
      const viewer = await w.client("viewer", ["own"], { tools: TOOLS });
      await setClientRoles(w.admin, "fixer", ["fixer"], new Date());
      await w.admin("update policy.work_settings set defect_role = 'fixer'");
      const seen = await file(w, viewer, "Search times out");
      await mark(w, fixer, seen, "triaged");

      const before = await known(w, viewer);
      const hidden = await file(w, scout, "A hidden tool fails", { severity: "critical" });
      await mark(w, fixer, hidden, "in_progress", "pr:12");
      // The same items, each as it was but the pack's time.
      const after = await known(w, viewer);
      const timeless = (items: Known[]) => items.map(({ asOf: _asOf, ...rest }) => rest);
      expect(timeless(after.items)).toEqual(timeless(before.items));
      expect(after.items.map((item) => item.id)).toEqual([seen]);
      // The wider client sees both, the hidden one first by severity.
      expect((await known(w, fixer)).items.map((item) => item.id)).toEqual([hidden, seen]);
    }, LABELS));
});
