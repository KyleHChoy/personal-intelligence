import { describe, expect, it } from "vitest";
import {
  ActivityCategory,
  ActivityDay,
  ActivityRule,
  ActivityTable,
  BlockAttribute,
  BlockAttributeMethod,
  BlockItem,
  MomentItem,
  PAGE_MAX_TEXT,
  PushCaptureAck,
  STRONG_ATTRIBUTE_METHODS,
} from "./index.ts";

// Lens's kinds: where a block was worked, the page moment, the activity table and the push ack's
// erased keys.

const ULID = "01J9ZK5V3W8Q2R4T6Y8A0C2E4G";
const accepts = (schema: { safeParse(value: unknown): { success: boolean } }, value: unknown): boolean =>
  schema.safeParse(value).success;
const at = (time: string): string => `2026-10-01T${time}-05:00`;

const page = {
  kind: "moment",
  key: `moment:${ULID}`,
  revision: 0,
  observedAt: at("09:00:00"),
  endedAt: at("09:05:00"),
  app: { bundle: "test.example.browser", name: "Browser" },
  url: "https://news.example.org/articles/alpha",
  entity: "page",
  participants: [],
  text: "Alpha launches | News Example",
  read: "ax",
};
const one = {
  start: at("09:00:00"),
  end: at("09:30:00"),
  minutes: 30,
  app: { bundle: "test.example.term", name: "Terminal" },
};
const block = { kind: "block", key: `block:${ULID}`, revision: 0, day: "2026-10-01", blocks: [one] };

describe("a page moment", () => {
  it("is a moment of entity page with a url, no participant and its title alone, at most PAGE_MAX_TEXT code points", () => {
    expect(PAGE_MAX_TEXT).toBe(300);
    expect(accepts(MomentItem, page)).toBe(true);
    expect(accepts(MomentItem, { ...page, text: "é".repeat(300) })).toBe(true);
    expect(accepts(MomentItem, { ...page, text: "é".repeat(301) })).toBe(false);
    const { url: _url, ...noUrl } = page;
    expect(accepts(MomentItem, noUrl)).toBe(false);
    expect(accepts(MomentItem, { ...page, participants: [{ name: "Lee Example" }] })).toBe(false);
    // The bounds are a page's alone: a doc moment keeps its 4 000 and needs no url.
    expect(accepts(MomentItem, { ...noUrl, entity: "doc", text: "a".repeat(4000) })).toBe(true);
    // A page's url is a moment's: no query or fragment.
    expect(accepts(MomentItem, { ...page, url: "https://news.example.org/a?id=1" })).toBe(false);
  });
});

describe("a block's repository, document and folder, in BlockAttribute form", () => {
  const by = (value: string, method: BlockAttributeMethod = "git_remote") => ({ value, method, v: 1 });

  it("are optional, each its value in a moment's form, its method, its derivation's version and maybe the moment it came from", () => {
    expect(BlockAttributeMethod.options).toEqual(["git_remote", "ax_document", "window_title_path", "prompt_mention"]);
    expect(STRONG_ATTRIBUTE_METHODS).toEqual(["git_remote", "ax_document"]);
    expect(Object.isFrozen(STRONG_ATTRIBUTE_METHODS)).toBe(true);
    expect(accepts(BlockItem, block)).toBe(true);
    const where = {
      ...one,
      repository: by("forge.example.com/owner/alpha"),
      document: { ...by("~/Code/alpha/README.md", "ax_document"), ref: `moment:${ULID}` },
      folder: by("~/Code/alpha", "prompt_mention"),
    };
    expect(accepts(BlockItem, { ...block, blocks: [where] })).toBe(true);
    expect(
      accepts(BlockItem, { ...block, blocks: [{ ...one, folder: by("/srv/work/alpha", "window_title_path") }] }),
    ).toBe(true);
    expect(accepts(BlockAttribute, by("~/Code/alpha"))).toBe(true);
  });

  it("refuse a bare value, an unknown method, a missing or bad version, a ref that is no moment's, raw text beside them, and what a moment's refuse", () => {
    expect(accepts(BlockItem, { ...block, blocks: [{ ...one, repository: "forge.example.com/owner/alpha" }] })).toBe(
      false,
    );
    expect(
      accepts(BlockItem, {
        ...block,
        blocks: [{ ...one, folder: by("~/Code/alpha", "prompt_line" as BlockAttributeMethod) }],
      }),
    ).toBe(false);
    const { v: _v, ...noVersion } = by("~/Code/alpha");
    expect(accepts(BlockItem, { ...block, blocks: [{ ...one, folder: noVersion }] })).toBe(false);
    expect(accepts(BlockItem, { ...block, blocks: [{ ...one, folder: { ...by("~/Code/alpha"), v: 0 } }] })).toBe(false);
    expect(
      accepts(BlockItem, { ...block, blocks: [{ ...one, folder: { ...by("~/Code/alpha"), ref: `meeting:${ULID}` } }] }),
    ).toBe(false);
    expect(
      accepts(BlockItem, {
        ...block,
        blocks: [{ ...one, folder: { ...by("~/Code/alpha", "prompt_mention"), prompt: "quinn@mac ~/Code/alpha %" } }],
      }),
    ).toBe(false);
    for (const repository of [
      "Forge.example.com/owner/alpha",
      "forge.example.com/owner",
      "https://forge.example.com/owner/alpha",
    ]) {
      expect(accepts(BlockItem, { ...block, blocks: [{ ...one, repository: by(repository) }] })).toBe(false);
    }
    for (const path of [
      "Code/alpha",
      "~/Code/../alpha",
      "~/Code/./alpha",
      `~/${"a".repeat(1024)}`,
      "~/Code/al\u0007pha",
    ]) {
      expect(accepts(BlockItem, { ...block, blocks: [{ ...one, folder: by(path) }] })).toBe(false);
      expect(accepts(BlockItem, { ...block, blocks: [{ ...one, document: by(path) }] })).toBe(false);
    }
  });

  it("a day may be sent part-way, as one revision, and the whole day as the next: no field marks it", () => {
    const noon = { ...block, revision: 0, blocks: [one] };
    const whole = {
      ...block,
      revision: 1,
      blocks: [one, { ...one, start: at("14:00:00"), end: at("15:00:00"), minutes: 60 }],
    };
    expect([accepts(BlockItem, noon), accepts(BlockItem, whole)]).toEqual([true, true]);
  });
});

describe("the push ack's erased keys", () => {
  const ack = { items: [{ key: `moment:${ULID}`, outcome: "accepted" }] };
  it("are optional, 1 to 500 item keys, never a forget's", () => {
    expect(accepts(PushCaptureAck, ack)).toBe(true);
    expect(accepts(PushCaptureAck, { ...ack, erased: [`meeting:${ULID}`, `block:${ULID}`] })).toBe(true);
    expect(accepts(PushCaptureAck, { ...ack, erased: [] })).toBe(false);
    expect(accepts(PushCaptureAck, { ...ack, erased: Array.from({ length: 501 }, () => `moment:${ULID}`) })).toBe(
      false,
    );
    expect(accepts(PushCaptureAck, { ...ack, erased: [`forget:${ULID}`] })).toBe(false);
  });
});

describe("the activity table", () => {
  it("has nine categories", () => {
    expect(ActivityCategory.options).toEqual([
      "coding",
      "writing",
      "communication",
      "meetings",
      "research",
      "design",
      "media",
      "admin",
      "other",
    ]);
  });

  it("a row is a bundle or a host, a prefix only with a host, and a category of the nine", () => {
    expect(accepts(ActivityRule, { bundle: "test.example.term", category: "coding" })).toBe(true);
    expect(accepts(ActivityRule, { host: "forge.example.com", category: "coding" })).toBe(true);
    expect(accepts(ActivityRule, { host: "docs.example.com", prefix: "/sheets", category: "admin" })).toBe(true);
    expect(accepts(ActivityRule, { bundle: "test.example.term", host: "forge.example.com", category: "coding" })).toBe(
      false,
    );
    expect(accepts(ActivityRule, { category: "coding" })).toBe(false);
    expect(accepts(ActivityRule, { bundle: "test.example.term", prefix: "/a", category: "coding" })).toBe(false);
    expect(accepts(ActivityRule, { host: "Forge.example.com", category: "coding" })).toBe(false);
    expect(accepts(ActivityRule, { host: "docs.example.com", prefix: "/a?b", category: "admin" })).toBe(false);
    expect(accepts(ActivityRule, { host: "forge.example.com", category: "gaming" })).toBe(false);
  });

  it("a table holds no row twice", () => {
    const rule = { host: "forge.example.com", category: "coding" };
    expect(accepts(ActivityTable, { version: 1, rules: [rule] })).toBe(true);
    expect(accepts(ActivityTable, { version: 1, rules: [rule, { ...rule, category: "research" }] })).toBe(false);
  });

  it("a day's view names every category", () => {
    const minutes = Object.fromEntries(ActivityCategory.options.map((category) => [category, 0]));
    expect(accepts(ActivityDay, { day: "2026-10-01", version: 1, minutes, total: 0 })).toBe(true);
    const { other: _other, ...missing } = minutes;
    expect(accepts(ActivityDay, { day: "2026-10-01", version: 1, minutes: missing, total: 0 })).toBe(false);
  });
});
