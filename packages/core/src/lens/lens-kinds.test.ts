import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ActivityCategory, ActivityRule, type ActivityTable, type BlockItem } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../repo-root.ts";
import { activityDay, activityTable, categoryOf, parseActivityTable } from "./activity.ts";
import { blockMatchKeys, captureMatchKeys, deviceAnchorKey } from "./anchors.ts";
import { momentBatchCutoff } from "./moment-batch.ts";
import {
  creditBlock,
  WORK_TIME_RULE,
  type WorkCredit,
  type CreditBlockInput as WorkTimeInput,
} from "./work-time-credit.ts";

// A block's match keys and workTime@1 over them, the activity table
// and its view, and the batched moment lane's cutoff.

type Block = BlockItem["blocks"][number];
const at = (time: string): string => `2026-10-01T${time}-05:00`;
const git = (value: string) => ({ value, method: "git_remote" as const, v: 1 });
const ax = (value: string) => ({ value, method: "ax_document" as const, v: 1 });
const block = (over: Partial<Block> = {}): Block => ({
  start: at("09:00:00"),
  end: at("09:30:00"),
  minutes: 30,
  app: { bundle: "test.example.term", name: "Terminal" },
  ...over,
});
const keyOf = (kind: Parameters<typeof deviceAnchorKey>[0], value: string): string => {
  const answer = deviceAnchorKey(kind, value);
  if (!("key" in answer)) throw new Error(`refused: ${value}`);
  return answer.key;
};
// A block's strong keys, and its weak ones.
const strongOf = (one: Block): string[] =>
  blockMatchKeys(one)
    .filter((key) => key.strong)
    .map((key) => key.key);
const weakOf = (one: Block): string[] =>
  blockMatchKeys(one)
    .filter((key) => !key.strong)
    .map((key) => key.key);

describe("a block's match keys", () => {
  it("a repository anchor meets a block's repository, at the anchor's normal form", () => {
    const keys = strongOf(block({ repository: git("forge.example.com/owner/alpha.git") }));
    expect(keys).toContain(keyOf("repository", "https://forge.example.com/owner/alpha"));
    expect(keys).not.toContain(keyOf("repository", "forge.example.com/owner/beta"));
  });

  it("a document anchor meets a block's document and, by prefix, its folder", () => {
    const anchor = keyOf("document", "~/Code/alpha");
    expect(strongOf(block({ document: ax("~/Code/alpha/notes/plan.md") }))).toContain(anchor);
    expect(strongOf(block({ folder: ax("~/Code/alpha") }))).toContain(anchor);
    expect(strongOf(block({ folder: ax("~/Code/alpha/src/lib") }))).toContain(anchor);
    // Not a folder beside it, nor one whose name only begins the same.
    expect(strongOf(block({ folder: ax("~/Code/alphabet") }))).not.toContain(anchor);
    expect(strongOf(block({ folder: ax("~/Code") }))).not.toContain(anchor);
  });

  it("a value from a window title or a prompt gives a weak key, which credits nothing; the app and host are strong", () => {
    const anchor = keyOf("document", "~/Code/alpha");
    const prompt = block({ folder: { value: "~/Code/alpha", method: "prompt_mention", v: 1 } });
    expect(strongOf(prompt)).not.toContain(anchor);
    expect(weakOf(prompt)).toContain(anchor);
    expect(
      strongOf(block({ repository: { value: "forge.example.com/owner/alpha", method: "window_title_path", v: 1 } })),
    ).toEqual(["app:test.example.term"]);
    // A key both strong and weak is strong.
    expect(
      strongOf(
        block({
          folder: { value: "~/Code/alpha", method: "prompt_mention", v: 1 },
          document: ax("~/Code/alpha/plan.md"),
        }),
      ),
    ).toContain(anchor);
  });

  it("a block keeps its app and host keys, as a moment's, and has no url key", () => {
    const keys = blockMatchKeys(block({ host: "Wiki.Example.org.", folder: ax("~/Code/alpha") })).map((key) => key.key);
    expect(keys.slice(0, 2)).toEqual(["app:test.example.term", "host:wiki.example.org"]);
    expect(keys.some((key) => key.startsWith("url:"))).toBe(false);
  });

  it("a block day stores no match key: its blocks' keys are computed at read", () => {
    const day: BlockItem = {
      kind: "block",
      key: "block:01JAAAAAAAAAAAAAAAAAAAAAA8",
      revision: 0,
      day: "2026-10-01",
      blocks: [
        block({ folder: ax("~/Code/alpha") }),
        block({ folder: { value: "~/Code/alpha/src", method: "prompt_mention", v: 1 } }),
      ],
    };
    expect(captureMatchKeys(day)).toEqual([]);
    expect(day.blocks.flatMap((one) => blockMatchKeys(one).map((key) => key.key))).toEqual([
      "app:test.example.term",
      "document:~/Code/alpha",
      "app:test.example.term",
      "document:~/Code/alpha/src",
      "document:~/Code/alpha",
    ]);
  });
});

const H = 3_600_000;
const T0 = Date.parse("2026-10-01T14:00:00Z");
const span = (from: number, to: number) => ({ from: T0 + from * H, to: T0 + to * H });
const KEYS = [
  { key: "repository:forge.example.com/owner/alpha", strong: true },
  { key: "document:~/Code/alpha", strong: false },
];
const input = (over: Partial<WorkTimeInput> = {}): WorkTimeInput => ({
  block: { start: T0, end: T0 + 4 * H, minutes: 240, bundle: "test.example.term", keys: KEYS },
  rulings: [],
  meetings: [],
  moments: [],
  anchors: [],
  ...over,
});
const summary = (credits: WorkCredit[]) =>
  credits.map((one) => [(one.from - T0) / H, (one.to - T0) / H, Math.round(one.minutes), one.project, one.basis]);

describe("workTime@1, who gets each instant of a block", () => {
  it("is named, and a ruling, then a linked meeting, then the block's strong anchor, then a linked moment of its app decide, in that order", () => {
    expect(WORK_TIME_RULE).toBe("workTime@1");
    const credits = creditBlock(
      input({
        rulings: [{ ...span(0, 1), project: "ruled" }],
        meetings: [{ ...span(0.5, 2), project: "met" }],
        anchors: [{ key: "repository:forge.example.com/owner/alpha", project: "anchored" }],
        moments: [{ ...span(1.5, 4), bundle: "TEST.example.term", project: "seen" }],
      }),
    );
    expect(summary(credits)).toEqual([
      [0, 1, 60, "ruled", "ruling"],
      [1, 2, 60, "met", "meeting"],
      [2, 4, 120, "anchored", "anchor"],
    ]);
  });

  it("a moment credits only where no anchor does, and only for its own app; with nothing, the time is no project's", () => {
    const moments = [
      { ...span(1, 2), bundle: "test.example.term", project: "seen" },
      { ...span(2, 3), bundle: "test.example.other", project: "elsewhere" },
    ];
    expect(summary(creditBlock(input({ moments })))).toEqual([
      [0, 1, 60, null, "none"],
      [1, 2, 60, "seen", "moment"],
      [2, 4, 120, null, "none"],
    ]);
  });

  it("a weak key credits nothing: an anchor on it gives no project", () => {
    expect(summary(creditBlock(input({ anchors: [{ key: "document:~/Code/alpha", project: "weak" }] })))).toEqual([
      [0, 4, 240, null, "none"],
    ]);
  });

  it("two projects at one step give none there and the next step is tried; a ruling of none decides none", () => {
    const anchors = [{ key: "repository:forge.example.com/owner/alpha", project: "anchored" }];
    const meetings = [
      { ...span(0, 2), project: "one" },
      { ...span(1, 2), project: "two" },
    ];
    expect(summary(creditBlock(input({ meetings, anchors })))).toEqual([
      [0, 1, 60, "one", "meeting"],
      [1, 4, 180, "anchored", "anchor"],
    ]);
    // Two projects' anchors met by the block: the anchor step gives none.
    expect(
      summary(
        creditBlock(
          input({ anchors: [...anchors, { key: "repository:forge.example.com/owner/alpha", project: "other" }] }),
        ),
      ),
    ).toEqual([[0, 4, 240, null, "none"]]);
    expect(summary(creditBlock(input({ rulings: [{ ...span(0, 4), project: null }], anchors })))).toEqual([
      [0, 4, 240, null, "ruling"],
    ]);
    // Two rulings that disagree are still the owner's: they decide none, and no inference fills it.
    expect(
      summary(
        creditBlock(
          input({
            rulings: [
              { ...span(0, 2), project: "a" },
              { ...span(1, 4), project: "b" },
            ],
            anchors,
          }),
        ),
      ),
    ).toEqual([
      [0, 1, 60, "a", "ruling"],
      [1, 2, 60, null, "ruling"],
      [2, 4, 120, "b", "ruling"],
    ]);
    // An unlinked meeting is passed over.
    expect(summary(creditBlock(input({ meetings: [{ ...span(0, 4), project: null }], anchors })))).toEqual([
      [0, 4, 240, "anchored", "anchor"],
    ]);
  });

  it("is a partition: the credits' minutes sum to the block's, and a block of no length gives none", () => {
    const credits = creditBlock(
      input({ block: { ...input().block, minutes: 37.3 }, meetings: [{ ...span(0.3, 1.7), project: "met" }] }),
    );
    expect(credits.reduce((total, one) => total + one.minutes, 0)).toBeCloseTo(37.3, 9);
    expect(credits[0]?.from).toBe(T0);
    expect(credits.at(-1)?.to).toBe(T0 + 4 * H);
    expect(creditBlock(input({ block: { ...input().block, end: T0 } }))).toEqual([]);
  });
});

const table = (rules: unknown[]): ActivityTable => parseActivityTable(JSON.stringify({ version: 1, rules }));

describe("the activity table", () => {
  it("the repository's table parses, every row's category is one of the nine, and it is seeded across them", () => {
    const text = readFileSync(join(repoRoot(), "ontology", "activity-categories.json"), "utf8");
    const raw = JSON.parse(text) as { rules: unknown[] };
    for (const row of raw.rules) expect(ActivityRule.safeParse(row).success, JSON.stringify(row)).toBe(true);
    const seeded = activityTable();
    for (const category of ActivityCategory.options.filter((one) => one !== "other"))
      expect(
        seeded.rules.some((rule) => rule.category === category),
        category,
      ).toBe(true);
  });

  // A block carries a host and no URL, so a host named only by prefix rows gives its blocks no
  // category of its own: a browser block there would read `other`, whatever the table says.
  it("every host a prefix row names has a row a block can match", () => {
    const seeded = activityTable();
    for (const rule of seeded.rules) {
      if (rule.host === undefined || rule.prefix === undefined) continue;
      expect(
        seeded.rules.some((other) => other.host === rule.host && other.prefix === undefined),
        rule.host,
      ).toBe(true);
    }
  });

  it("version 3: a block on Google's documents host is writing, and a URL, once one is passed, picks its row", () => {
    const seeded = activityTable();
    expect(seeded.version).toBeGreaterThanOrEqual(3);
    const browser = "test.example.browser";
    expect(categoryOf({ bundle: browser, host: "docs.google.com" }, seeded)).toBe("writing");
    for (const [path, category] of [
      ["/document/d/x/edit", "writing"],
      ["/presentation/d/x/edit", "writing"],
      ["/spreadsheets/d/x/edit", "admin"],
      ["/forms/d/x/edit", "admin"],
    ] as const)
      expect(
        categoryOf({ bundle: browser, host: "docs.google.com", url: `https://docs.google.com${path}` }, seeded),
        path,
      ).toBe(category);
    // The meeting hosts have no prefix, so a block there is a meeting once Lens sends it.
    expect(categoryOf({ bundle: browser, host: "meet.google.com" }, seeded)).toBe("meetings");
    expect(categoryOf({ bundle: browser, host: "app.zoom.us" }, seeded)).toBe("meetings");
    expect(categoryOf({ bundle: "us.zoom.xos" }, seeded)).toBe("meetings");
  });

  it("version 2: the owner put Claude desktop under coding, claude.ai stays research, and the rows added with it", () => {
    const seeded = activityTable();
    expect(seeded.version).toBeGreaterThanOrEqual(2);
    expect(categoryOf({ bundle: "com.anthropic.claudefordesktop" }, seeded)).toBe("coding");
    expect(categoryOf({ bundle: "test.example.browser", host: "claude.ai" }, seeded)).toBe("research");
    const bundles = {
      "com.meta.endo": "research",
      "com.granola.app": "meetings",
      "org.blenderfoundation.blender": "design",
      "com.t3tools.t3code": "coding",
      "com.apple.journal": "writing",
      "com.apple.ActivityMonitor": "admin",
    };
    for (const [bundle, category] of Object.entries(bundles))
      expect(categoryOf({ bundle }, seeded), bundle).toBe(category);
    const hosts = {
      "hark.com": "research",
      "muse.ai": "research",
      "granola.ai": "meetings",
      "cad.onshape.com": "design",
      "openrouter.ai": "coding",
      "sentry.io": "coding",
      "platform.claude.com": "coding",
      "ramp.com": "admin",
      "dashboard.stripe.com": "admin",
      "delta.com": "admin",
      "alaskaair.com": "admin",
      "aircanada.com": "admin",
      "united.com": "admin",
      "seats.aero": "admin",
      "luma.com": "admin",
    };
    for (const [host, category] of Object.entries(hosts))
      expect(categoryOf({ bundle: "test.example.browser", host }, seeded), host).toBe(category);
  });

  it("the most specific row wins: a host's prefix, then the longest host, then the bundle, else other", () => {
    const rules = table([
      { bundle: "test.example.browser", category: "research" },
      { host: "example.com", category: "media" },
      { host: "docs.example.com", category: "writing" },
      { host: "docs.example.com", prefix: "/sheets", category: "admin" },
    ]);
    expect(
      categoryOf(
        { bundle: "test.example.browser", host: "docs.example.com", url: "https://docs.example.com/sheets/1" },
        rules,
      ),
    ).toBe("admin");
    expect(
      categoryOf(
        { bundle: "test.example.browser", host: "docs.example.com", url: "https://docs.example.com/sheetsx" },
        rules,
      ),
    ).toBe("writing");
    // A block has no url, so a prefix row never matches one.
    expect(categoryOf({ bundle: "test.example.browser", host: "docs.example.com" }, rules)).toBe("writing");
    expect(categoryOf({ bundle: "test.example.browser", host: "video.example.com" }, rules)).toBe("media");
    expect(categoryOf({ bundle: "test.example.browser", host: "notexample.com" }, rules)).toBe("research");
    expect(categoryOf({ bundle: "TEST.example.browser" }, rules)).toBe("research");
    expect(categoryOf({ bundle: "test.example.other" }, rules)).toBe("other");
  });

  it("a day's view sums each block's minutes into its category, every category present", () => {
    const rules = table([
      { bundle: "test.example.term", category: "coding" },
      { host: "video.example.com", category: "media" },
    ]);
    const view = activityDay(
      "2026-10-01",
      [
        block({ minutes: 30.5 }),
        block({ minutes: 12.2, app: { bundle: "test.example.browser", name: "Browser" }, host: "video.example.com" }),
        block({ minutes: 5, app: { bundle: "test.example.mystery", name: "Mystery" } }),
      ],
      rules,
    );
    expect(view.minutes).toEqual({
      coding: 30.5,
      writing: 0,
      communication: 0,
      meetings: 0,
      research: 0,
      design: 0,
      media: 12.2,
      admin: 0,
      other: 5,
    });
    expect(view.total).toBe(47.7);
    expect(view.version).toBe(1);
  });

  it("a change to the table changes the view: the view is rebuilt from the table, never kept", () => {
    const blocks = [block({ minutes: 30 })];
    expect(
      activityDay("2026-10-01", blocks, table([{ bundle: "test.example.term", category: "coding" }])).minutes.coding,
    ).toBe(30);
    const changed = activityDay("2026-10-01", blocks, table([{ bundle: "test.example.term", category: "admin" }]));
    expect([changed.minutes.coding, changed.minutes.admin]).toEqual([0, 30]);
  });

  it("a table that does not parse throws", () => {
    expect(() => table([{ bundle: "test.example.term", category: "gaming" }])).toThrow();
    expect(() => table([])).toThrow();
  });
});

describe("the batched moment lane's cutoff", () => {
  const CHICAGO = "America/Chicago";
  const cutoff = (now: string, zone: string | null = CHICAGO): string =>
    momentBatchCutoff(new Date(now), zone).toISOString();

  it("is the latest 00:00 or 12:00 on the owner's clock at or before the run", () => {
    // These days are in daylight time in Chicago, UTC-5.
    expect(cutoff("2026-10-14T16:59:59Z")).toBe("2026-10-14T05:00:00.000Z");
    expect(cutoff("2026-10-14T17:00:00Z")).toBe("2026-10-14T17:00:00.000Z");
    expect(cutoff("2026-10-15T04:59:00Z")).toBe("2026-10-14T17:00:00.000Z");
    expect(cutoff("2026-10-15T05:00:00Z")).toBe("2026-10-15T05:00:00.000Z");
  });

  it("follows the clock across a change: on 2026-11-01 Chicago's midnight is UTC-5 and its noon UTC-6", () => {
    expect(cutoff("2026-11-01T12:00:00Z")).toBe("2026-11-01T05:00:00.000Z");
    expect(cutoff("2026-11-01T18:30:00Z")).toBe("2026-11-01T18:00:00.000Z");
  });

  it("is UTC's with no zone set", () => {
    expect(cutoff("2026-10-14T16:59:59Z", null)).toBe("2026-10-14T12:00:00.000Z");
    expect(cutoff("2026-10-14T11:00:00Z", null)).toBe("2026-10-14T00:00:00.000Z");
  });
});
