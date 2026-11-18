import {
  ClientKind,
  ClientQuota,
  ClientRegistration,
  PersonalReadTool,
  PersonalToolArgs,
  QUOTA_DEFAULTS,
  READ_BUDGET,
  ReadBudget,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";

// The read budgets.

const REGISTRATION = {
  name: "quota-client",
  runtime: "local",
  vendorRetention: "none",
  compartments: ["own"],
  views: ["people"],
  tools: ["read_message"],
} as const;
const AGENT = { maxItemsDay: 300, maxCharsDay: 3_000_000, maxRowsDay: 5_000, maxCallsMinute: 60 };

describe("read budgets", () => {
  it("READ_BUDGET names every read tool, and only the listed text tools are text", () => {
    expect(Object.keys(READ_BUDGET).sort()).toEqual([...PersonalReadTool.options].sort());
    for (const budget of Object.values(READ_BUDGET)) expect(ReadBudget.safeParse(budget).success).toBe(true);
    // get_document is a text tool whenever it is a read tool.
    const text = Object.entries(READ_BUDGET).flatMap(([tool, budget]) => (budget === "text" ? [tool] : []));
    expect(
      text.every((tool) =>
        ["read_message", "get_document", "get_evidence_span", "read_item", "fetch_template"].includes(tool),
      ),
    ).toBe(true);
    expect(text).toContain("read_message");
    // The positive control: a list tool is listed as one.
    expect(READ_BUDGET.find_messages).toBe("list");
    expect(Object.isFrozen(READ_BUDGET)).toBe(true);
  });

  it("no list tool's argument schema has a key for a cursor or an offset", () => {
    // The exemptions: sync_mirror's cursor is an opaque pass cursor the server issued, never a client's
    // offset into rows. list_people's `after` is likewise an opaque cursor the server issued (the last row's
    // place in its order), over the caller's own audience's rows, each page counted. about's `after` too, the
    // next page of supporting claims a page answered, over the caller's own clearance's rows, each page
    // counted.
    const EXEMPT: Partial<Record<PersonalReadTool, string>> = {
      sync_mirror: "cursor",
      list_people: "after",
      about: "after",
    };
    expect(Object.keys(PersonalToolArgs.sync_mirror.shape)).toContain("cursor");
    const listTools = PersonalReadTool.options.filter((tool) => READ_BUDGET[tool] === "list");
    expect(listTools.length).toBeGreaterThan(0);
    const paging = /^(cursor|offset|page|after|before|skip|start|next|token)$/i;
    for (const tool of listTools) {
      const keys = Object.keys((PersonalToolArgs[tool] as unknown as { shape: Record<string, unknown> }).shape);
      expect(
        keys.filter((key) => paging.test(key) && key !== EXEMPT[tool]),
        tool,
      ).toEqual([]);
    }
    // The positive control: the text tool read_message does take an offset, inside one item.
    expect(Object.keys(PersonalToolArgs.read_message.shape)).toContain("offset");
  });

  it("a quota of 0 calls a minute, and of 601, is refused", () => {
    expect(ClientQuota.safeParse({ ...AGENT, maxCallsMinute: 0 }).success).toBe(false);
    expect(ClientQuota.safeParse({ ...AGENT, maxCallsMinute: 601 }).success).toBe(false);
    // The controls: the bounds themselves are taken.
    expect(ClientQuota.safeParse({ ...AGENT, maxCallsMinute: 1 }).success).toBe(true);
    expect(ClientQuota.safeParse({ ...AGENT, maxCallsMinute: 600 }).success).toBe(true);
    // Each other bound, at its edge and past it.
    const edges: [keyof ClientQuota, number, number][] = [
      ["maxItemsDay", 100_000, 100_001],
      ["maxCharsDay", 100_000_000, 100_000_001],
      ["maxRowsDay", 1_000_000, 1_000_001],
    ];
    for (const [key, top, past] of edges) {
      expect(ClientQuota.safeParse({ ...AGENT, [key]: 0 }).success, key).toBe(true);
      expect(ClientQuota.safeParse({ ...AGENT, [key]: top }).success, key).toBe(true);
      expect(ClientQuota.safeParse({ ...AGENT, [key]: past }).success, key).toBe(false);
      expect(ClientQuota.safeParse({ ...AGENT, [key]: -1 }).success, key).toBe(false);
      expect(ClientQuota.safeParse({ ...AGENT, [key]: 1.5 }).success, key).toBe(false);
    }
    // Strict: a key it does not know is refused.
    expect(ClientQuota.safeParse({ ...AGENT, maxReadsDay: 1 }).success).toBe(false);
  });

  it("QUOTA_DEFAULTS has a row for each client kind", () => {
    expect(Object.keys(QUOTA_DEFAULTS).sort()).toEqual([...ClientKind.options].sort());
    expect(QUOTA_DEFAULTS.agent).toEqual(AGENT);
    expect(QUOTA_DEFAULTS.reasoner).toEqual({
      maxItemsDay: 600,
      maxCharsDay: 6_000_000,
      maxRowsDay: 20_000,
      maxCallsMinute: 240,
    });
    expect(QUOTA_DEFAULTS.device).toEqual({ maxItemsDay: 0, maxCharsDay: 0, maxRowsDay: 0, maxCallsMinute: 120 });
    for (const quota of Object.values(QUOTA_DEFAULTS)) expect(ClientQuota.safeParse(quota).success).toBe(true);
    expect(Object.isFrozen(QUOTA_DEFAULTS)).toBe(true);
  });

  it("a registration takes an optional quota, and refuses one outside the bounds", () => {
    expect(ClientRegistration.safeParse(REGISTRATION).success).toBe(true);
    expect(ClientRegistration.safeParse({ ...REGISTRATION, quota: AGENT }).success).toBe(true);
    expect(ClientRegistration.safeParse({ ...REGISTRATION, quota: { ...AGENT, maxCallsMinute: 0 } }).success).toBe(
      false,
    );
  });
});
