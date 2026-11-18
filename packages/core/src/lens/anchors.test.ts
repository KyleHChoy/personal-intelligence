import {
  ANCHOR_VECTORS,
  BROWSER_BUNDLES,
  GENERIC_TITLES,
  TITLE_PREFIXES_MOST,
  TITLE_VECTORS,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { captureMatchKeys, deviceAnchorKey, normalTitle, titleMatchKeys, titleTooDeep } from "./anchors.ts";

// The device anchors' normal forms and an item's match keys, run on contracts' ANCHOR_VECTORS.

describe("device anchors", () => {
  it("deviceAnchorKey gives every kept vector of ANCHOR_VECTORS its key and every refused one its code", () => {
    let kept = 0;
    let refused = 0;
    for (const vector of ANCHOR_VECTORS) {
      if ("item" in vector) continue;
      if ("key" in vector) {
        kept += 1;
        expect(deviceAnchorKey(vector.kind, vector.value), `${vector.kind} ${vector.value}`).toEqual({
          key: vector.key,
        });
      } else {
        refused += 1;
        expect(deviceAnchorKey(vector.kind, vector.value), `${vector.kind} ${vector.value}`).toEqual({
          refused: vector.refused,
        });
      }
    }
    expect([kept > 5, refused > 5]).toEqual([true, true]);
  });

  it("every BROWSER_BUNDLES bundle, Aside's among them, is too generic to anchor as an app, in any case", () => {
    expect(BROWSER_BUNDLES).toContain("at.studio.AsideBrowser");
    for (const bundle of BROWSER_BUNDLES) {
      expect(deviceAnchorKey("app", bundle), bundle).toEqual({ refused: "generic_anchor" });
      const mixed = [...bundle].map((one, i) => (i % 2 === 0 ? one.toUpperCase() : one.toLowerCase())).join("");
      expect(deviceAnchorKey("app", mixed), mixed).toEqual({ refused: "generic_anchor" });
    }
    // The control: an app that is no browser is kept.
    expect(deviceAnchorKey("app", "test.lens.notes")).toHaveProperty("key");
  });

  it("captureMatchKeys gives each sample item of ANCHOR_VECTORS its keys: a URL's prefixes up to eight segments, a forge page's repository, a document's enclosing folders, a meeting's series, and none for a block day", () => {
    const items = ANCHOR_VECTORS.flatMap((vector) => ("item" in vector ? [vector] : []));
    expect(items.length).toBeGreaterThan(3);
    for (const { item, keys } of items) expect(captureMatchKeys(item), item.key).toEqual(keys);
    // An anchor's key and an item's key agree: the anchor of a URL prefix is one of the item's keys.
    const first = items[0];
    const anchored = deviceAnchorKey("url_prefix", "https://wiki.example.org/teams/alpha");
    expect("key" in anchored && first !== undefined && captureMatchKeys(first.item).includes(anchored.key)).toBe(true);
    // ... and not one inside a segment.
    const inside = deviceAnchorKey("url_prefix", "https://wiki.example.org/teams/alp");
    expect("key" in inside && first !== undefined && captureMatchKeys(first.item).includes(inside.key)).toBe(false);
  });

  it("titleMatchKeys gives each title of TITLE_VECTORS its keys", () => {
    for (const vector of TITLE_VECTORS)
      expect(titleMatchKeys(vector.title, vector.app), vector.title).toEqual(vector.keys);
    expect(titleMatchKeys(null, "Reader")).toEqual([]);
    expect(titleMatchKeys(undefined, undefined)).toEqual([]);
  });

  it("a title anchor past the kept prefixes is refused; one at the last kept prefix meets a longer title", () => {
    const words = (count: number): string => Array.from({ length: count }, (_, n) => `w${n + 1}xxx`).join(" ");
    const last = deviceAnchorKey("window_title", words(12));
    expect("key" in last && titleMatchKeys(`${words(12)} - Notes`, "Reader").includes(last.key)).toBe(true);
    expect(deviceAnchorKey("window_title", words(13))).toEqual({ refused: "bad_anchor" });
    expect(titleTooDeep(words(13))).toBe(true);
    expect(titleTooDeep(words(12))).toBe(false);
    expect(deviceAnchorKey("window_title", `a b ${words(12)}`)).toEqual({ key: `title:a b ${words(12)}` });
  });

  it("a title anchor meets a title exactly or at a word's end, never inside a word, never fuzzily", () => {
    const keys = titleMatchKeys("Lantern Survey \u2014 Q4 plan", "Reader");
    const meets = (value: string): boolean => {
      const answer = deviceAnchorKey("window_title", value);
      return "key" in answer && keys.includes(answer.key);
    };
    expect(
      ["lantern survey", "LANTERN  SURVEY", "Lantern", "lantern survey \u2014 q4", "Lantern Survey \u2014 Q4 plan"].map(
        meets,
      ),
    ).toEqual([true, true, true, true, true]);
    // Inside a word, a different word, a typo, a suffix alone, punctuation dropped: none meet.
    expect(["lantern surv", "lantern surveys", "lantern survy", "survey", "lantern survey q4"].map(meets)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
    // Unicode: NFC and lower case on both sides.
    expect(deviceAnchorKey("window_title", "CAF\u00c9 plans")).toEqual({ key: "title:caf\u00e9 plans" });
    expect(titleMatchKeys("Cafe\u0301 Plans", "Reader")).toContain("title:caf\u00e9 plans");
  });

  it("a title anchor ending in punctuation is cut at its last word's end, so it meets a longer title as well as itself", () => {
    const meets = (value: string, title: string): boolean => {
      const answer = deviceAnchorKey("window_title", value);
      return "key" in answer && titleMatchKeys(title, "Reader").includes(answer.key);
    };
    expect(meets("Q3 Report:", "Q3 Report: budget")).toBe(true);
    expect(meets("Q3 Report:", "Q3 Report:")).toBe(true);
    expect(meets("Alpha (draft)", "Alpha (draft) notes")).toBe(true);
    expect(meets("Alpha (draft)", "Alpha (draft)")).toBe(true);
    // Still at a word's end: the cut never reaches inside a word.
    expect(meets("Q3 Report:", "Q3 Reports")).toBe(false);
  });

  it("a title anchor too short, generic or bare is refused, and no title gives such a key", () => {
    for (const title of GENERIC_TITLES) {
      expect(deviceAnchorKey("window_title", title), title).toEqual({ refused: "generic_anchor" });
      expect(deviceAnchorKey("window_title", ` ${title.toUpperCase()} `), title).toEqual({ refused: "generic_anchor" });
      expect(titleMatchKeys(title, "Reader"), title).not.toContain(`title:${title}`);
    }
    expect(deviceAnchorKey("window_title", "")).toEqual({ refused: "bad_anchor" });
    expect(deviceAnchorKey("window_title", "a\tb\nc")).toEqual({ refused: "generic_anchor" });
    // A window that shows only its app's name gives no key, whatever the app.
    expect(titleMatchKeys("Example Writer", "Example Writer")).toEqual(["title:example"]);
    expect(normalTitle(" A\u00a0\u2003b\u0007c ")).toBe("a b c");
  });

  it("a long title gives at most TITLE_PREFIXES_MOST prefixes and no key past TITLE_ANCHOR_MOST", () => {
    const words = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
    const keys = titleMatchKeys(words, "Reader");
    expect(keys.length).toBeLessThanOrEqual(TITLE_PREFIXES_MOST + 1);
    for (const key of keys) expect([...key.slice("title:".length)].length).toBeLessThanOrEqual(200);
    expect(keys).not.toContain(`title:${words}`);
  });

  it("a prefix left out does not use the budget, and the keys run shortest first", () => {
    // "a", "a b" and "a b c" hold too few letters: TITLE_PREFIXES_MOST prefixes are kept past them.
    const words = Array.from({ length: TITLE_PREFIXES_MOST + 2 }, (_, i) => `word${i}`);
    const keys = titleMatchKeys(`a b c ${words.join(" ")}`, "Reader");
    expect(keys).toContain(`title:a b c ${words.slice(0, TITLE_PREFIXES_MOST).join(" ")}`);
    expect(keys).not.toContain(`title:a b c ${words.slice(0, TITLE_PREFIXES_MOST + 1).join(" ")}`);
    expect(keys).toHaveLength(TITLE_PREFIXES_MOST + 1);
    const ordered = titleMatchKeys("Alpha Plan \u2014 Notes draft", "Reader");
    expect(ordered).toEqual([
      "title:alpha",
      "title:alpha plan",
      "title:alpha plan \u2014 notes",
      "title:alpha plan \u2014 notes draft",
    ]);
  });
});
