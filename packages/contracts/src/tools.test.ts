import { describe, expect, it } from "vitest";
import { ProviderTool, ToolResult } from "./index.ts";
import { needsEvery } from "./test-checks.ts";
import { entityPage, label, optionalItemFields, toolItems } from "./test-samples.ts";

describe("tool envelopes", () => {
  it("a tool result holds that tool's own items", () => {
    for (const tool of ProviderTool.options) {
      const result = { store: "people", tool, label, items: [toolItems[tool]], nextPage: "cursor-1" };
      needsEvery(ToolResult, result, ["nextPage", ...optionalItemFields[tool].map((path) => `items.${path}`)], tool);
    }
    // Another tool's items do not pass under a tool's name.
    expect(
      ToolResult.safeParse({ store: "people", tool: "search", label, items: [toolItems.check_conflicts] }).success,
    ).toBe(false);
    expect(
      ToolResult.safeParse({ store: "people", tool: "get_entity", label, items: [toolItems.find_matches] }).success,
    ).toBe(false);
    expect(ToolResult.safeParse({ store: "warehouse", tool: "search", label, items: [] }).success).toBe(false);
  });

  it("a result carries no label exactly when the plan read no row", () => {
    for (const tool of ProviderTool.options) {
      // Nothing read: no label, since a label names at least one compartment.
      expect(ToolResult.safeParse({ store: "people", tool, items: [] }).success, tool).toBe(true);
      // Rows read: the label is required.
      expect(ToolResult.safeParse({ store: "people", tool, items: [toolItems[tool]] }).success, tool).toBe(false);
    }
    // A label beside no items is still taken: the plan may read rows the viewer is not given.
    expect(ToolResult.safeParse({ store: "people", tool: "search", label, items: [] }).success).toBe(true);
    // An empty label is never the stand-in for none.
    expect(
      ToolResult.safeParse({ store: "people", tool: "search", label: { compartments: [], readers: [] }, items: [] })
        .success,
    ).toBe(false);
  });
});

describe("get_entity", () => {
  it("a tool result is labelled and names its tool", () => {
    const result = { store: "people", tool: "get_entity", label, items: [entityPage] };
    expect(ToolResult.safeParse(result).success).toBe(true);
    expect(ToolResult.safeParse({ ...result, nextPage: "cursor-1" }).success).toBe(true);
    const { label: _label, ...unlabelled } = result;
    expect(ToolResult.safeParse(unlabelled).success).toBe(false);
    expect(ToolResult.safeParse({ ...result, tool: "export_all" }).success).toBe(false);
  });
});
