import {
  ANCHOR_VECTORS,
  AnchorId,
  AnchorRefusal,
  CaptureItem,
  CaptureWork,
  DeviceAnchorKind,
  DeviceAnchorView,
  GENERIC_APPS,
  GENERIC_HOSTS,
  GENERIC_SEGMENTS,
  GENERIC_TITLES,
  MIRROR_TEMPLATES,
  TITLE_PREFIXES_MOST,
  TITLE_VECTORS,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";

// The device anchors' lists and vectors. Core's tests run the vectors through deviceAnchorKey and
// captureMatchKeys.

const accepts = (schema: { safeParse(value: unknown): { success: boolean } }, value: unknown): boolean =>
  schema.safeParse(value).success;
const ULID = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const PREFIX: Record<string, string> = {
  app: "app:",
  host: "host:",
  url_prefix: "url:",
  repository: "repository:",
  document: "document:",
  meeting_series: "series:",
  window_title: "title:",
};

describe("device anchors", () => {
  it("GENERIC_HOSTS, GENERIC_APPS, GENERIC_SEGMENTS and ANCHOR_VECTORS are deep-frozen, and every vector parses", () => {
    for (const list of [GENERIC_HOSTS, GENERIC_APPS, GENERIC_SEGMENTS, ANCHOR_VECTORS])
      expect(Object.isFrozen(list)).toBe(true);
    for (const vector of ANCHOR_VECTORS) {
      expect(Object.isFrozen(vector)).toBe(true);
      if ("item" in vector) {
        expect(accepts(CaptureItem, vector.item), vector.item.key).toBe(true);
        expect(Object.isFrozen(vector.item)).toBe(true);
        expect(Object.isFrozen(vector.keys)).toBe(true);
        for (const key of vector.keys)
          expect(
            Object.values(PREFIX).some((prefix) => key.startsWith(prefix)),
            key,
          ).toBe(true);
      } else {
        expect(accepts(DeviceAnchorKind, vector.kind), vector.value).toBe(true);
        if ("key" in vector) expect(vector.key.startsWith(PREFIX[vector.kind] ?? "?"), vector.value).toBe(true);
        else expect(["bad_anchor", "generic_anchor"]).toContain(vector.refused);
      }
    }
    // Every kind has a kept vector and a refused one, and there are sample items.
    for (const kind of DeviceAnchorKind.options) {
      expect(
        ANCHOR_VECTORS.some((vector) => "key" in vector && vector.kind === kind),
        kind,
      ).toBe(true);
      expect(
        ANCHOR_VECTORS.some((vector) => "refused" in vector && vector.kind === kind),
        kind,
      ).toBe(true);
    }
    expect(ANCHOR_VECTORS.filter((vector) => "item" in vector).length).toBeGreaterThan(3);
    // The lists compare in lower case: GENERIC_SEGMENTS is written in it.
    for (const segment of GENERIC_SEGMENTS) expect(segment).toBe(segment.toLowerCase());
    expect(GENERIC_HOSTS).toContain("localhost");
  });

  it("an anchor's id is pan_ and a ULID, and its view is strict with the value untrusted", () => {
    expect(accepts(AnchorId, `pan_${ULID}`)).toBe(true);
    expect(accepts(AnchorId, `ent_${ULID}`)).toBe(false);
    const view = { id: `pan_${ULID}`, kind: "url_prefix", value: { untrusted: "wiki.example.org/teams" } };
    expect(accepts(DeviceAnchorView, view)).toBe(true);
    expect(accepts(DeviceAnchorView, { ...view, value: "wiki.example.org/teams" })).toBe(false);
    expect(accepts(DeviceAnchorView, { ...view, kind: "email_thread" })).toBe(false);
    expect(accepts(DeviceAnchorView, { ...view, project: `ent_${ULID}` })).toBe(false);
    expect(AnchorRefusal.options).toEqual(["bad_anchor", "generic_anchor", "anchor_taken", "no_series"]);
  });

  it("GENERIC_TITLES and TITLE_VECTORS are deep-frozen, the titles at their normal form", () => {
    for (const list of [GENERIC_TITLES, TITLE_VECTORS]) expect(Object.isFrozen(list)).toBe(true);
    for (const title of GENERIC_TITLES)
      expect(title).toBe(title.normalize("NFC").toLowerCase().replace(/\s+/gu, " ").trim());
    for (const vector of TITLE_VECTORS) {
      expect(Object.isFrozen(vector.keys)).toBe(true);
      for (const key of vector.keys) expect(key.startsWith("title:"), key).toBe(true);
    }
  });

  it("no window title anchor reaches the mirror, and work_enc holds a title's fingerprints, never the title", () => {
    for (const template of MIRROR_TEMPLATES) expect(template.members.anchorKinds).not.toContain("window_title");
    const fp = "a".repeat(64);
    const block = {
      start: "2026-10-01T09:00:00-05:00",
      end: "2026-10-01T09:30:00-05:00",
      minutes: 30,
      bundle: "test.example.reader",
      category: null,
    };
    const day = (extra: object) => ({
      kind: "block",
      blocks: [{ ...block, ...extra }],
      cut: { blocks: 0, minutes: 0 },
    });
    const titled = (extra: object) => ({ ...day({ titleAt: 0, ...extra }), titles: [[fp]] });
    expect(CaptureWork.safeParse(titled({ titleFps: [fp] })).success).toBe(true);
    expect(
      CaptureWork.safeParse(titled({ titleFps: Array.from({ length: TITLE_PREFIXES_MOST + 1 }, () => fp) })).success,
    ).toBe(true);
    expect(
      CaptureWork.safeParse(titled({ titleFps: Array.from({ length: TITLE_PREFIXES_MOST + 2 }, () => fp) })).success,
    ).toBe(false);
    for (const bad of [[], ["Alpha plan"], [fp.toUpperCase()]])
      expect(CaptureWork.safeParse(titled({ titleFps: bad })).success, JSON.stringify(bad)).toBe(false);
    // A title's fingerprints come with its name fingerprints' place in the day's titles, and
    // neither without the other.
    expect(CaptureWork.safeParse(day({ titleFps: [fp] })).success).toBe(false);
    expect(CaptureWork.safeParse(titled({})).success).toBe(false);
    expect(CaptureWork.safeParse(titled({ titleFps: [fp], titleAt: 1 })).success).toBe(false);
    expect(CaptureWork.safeParse({ ...titled({ titleFps: [fp] }), titles: [["Robin"]] }).success).toBe(false);
    expect(CaptureWork.safeParse({ ...day({}), titles: [[fp]] }).success).toBe(true);
    expect(CaptureWork.safeParse(day({ title: "Alpha plan" })).success).toBe(false);
    const moment = { kind: "moment", bundle: "test.example.chat", thread: "Alpha", lines: 1 };
    expect(CaptureWork.safeParse({ ...moment, threadFps: [fp] }).success).toBe(true);
    expect(CaptureWork.safeParse({ ...moment, threadFps: ["Alpha"] }).success).toBe(false);
  });
});
