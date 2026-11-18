import { expect, it } from "vitest";
import { skyAt, skyStyle } from "./sky.ts";

// The sky follows the hour: keyframes across the day, blended minute by minute, the design's three
// skies among them, and the ink set by the sky's lightness.

const channels = (rgb: string): number[] => (/rgb\((\d+) (\d+) (\d+)/.exec(rgb) ?? []).slice(1).map(Number);
const distance = (a: string, b: string): number =>
  Math.max(...channels(a).map((value, i) => Math.abs(value - (channels(b)[i] ?? 0))));
const minute = (h: number, m = 0): number => h * 60 + m;

it("holds the design's three skies at their hours", () => {
  expect(skyAt(minute(11)).stops).toEqual(["rgb(197 211 226)", "rgb(219 227 236)", "rgb(236 239 242)"]);
  expect(skyAt(minute(18, 40)).stops).toEqual(["rgb(185 184 201)", "rgb(217 205 203)", "rgb(236 228 222)"]);
  expect(skyAt(minute(21)).stops).toEqual(["rgb(15 23 38)", "rgb(19 29 46)", "rgb(23 34 53)"]);
});

it("moves every quarter hour from first light to night, every hour of the night, and never jumps between two minutes", () => {
  const moves = (at: number, by: number): boolean =>
    skyAt(at).stops.some((stop, i) => stop !== skyAt(at + by).stops[i]);
  for (let at = minute(4, 30); at < minute(23); at += 15) expect(moves(at, 15), `the sky at minute ${at}`).toBe(true);
  for (let at = minute(23); at < minute(28, 30); at += 60) expect(moves(at, 60), `the sky at minute ${at}`).toBe(true);
  for (let at = 0; at < 1440; at += 1) {
    const [now, next] = [skyAt(at), skyAt(at + 1)];
    for (const [i, stop] of now.stops.entries())
      expect(distance(stop, next.stops[i] ?? ""), `minute ${at}`).toBeLessThanOrEqual(6);
  }
  // Late morning differs visibly over a quarter hour.
  expect(skyAt(minute(11, 13)).stops.some((stop, i) => distance(stop, skyAt(minute(10, 58)).stops[i] ?? "") >= 2)).toBe(
    true,
  );
  // Midnight meets itself.
  expect(skyAt(1440).stops).toEqual(skyAt(0).stops);
});

it("uses the light ink by day and the night ink by night, crossing over a short while at dawn and dusk", () => {
  expect(skyAt(minute(11)).night).toBe(0);
  expect(skyAt(minute(18, 40)).night).toBe(0);
  expect(skyAt(minute(0)).night).toBe(1);
  expect(skyAt(minute(21)).night).toBe(1);
  const between = (from: number, to: number): number =>
    Array.from({ length: to - from }, (_, n) => skyAt(from + n).night).filter((night) => night > 0 && night < 1).length;
  expect(between(minute(5), minute(8))).toBeGreaterThan(5);
  expect(between(minute(5), minute(8))).toBeLessThan(40);
  expect(between(minute(18), minute(21))).toBeGreaterThan(5);
  expect(between(minute(18), minute(21))).toBeLessThan(40);
});

it("gives the app root its sky and every ink and glass token", () => {
  const style = skyStyle(new Date(2026, 9, 29, 23, 10)) as Record<string, string>;
  expect(style["--sky"]).toMatch(
    /^linear-gradient\(180deg, rgb\(\d+ \d+ \d+\) 0%, rgb\(\d+ \d+ \d+\) 45%, rgb\(\d+ \d+ \d+\) 100%\)$/,
  );
  expect(style["--ink"]).toBe("rgb(230 235 242)");
  expect(style["--glass"]).toBe("rgb(30 40 58 / 0.6)");
  expect(style.colorScheme).toBe("dark");
  for (const token of [
    "--p1",
    "--p2",
    "--p3",
    "--p4",
    "--mute",
    "--faint",
    "--steel",
    "--warn",
    "--danger",
    "--solid",
    "--tint",
    "--line",
    "--rule",
    "--bar",
  ])
    expect(style[token]).toMatch(/^rgb\(/);
});

// At dawn a mid-grey panel can swallow the check rings. Every half hour, on a
// panel over each stop of the sky, the ink, the muted ink, the check ring and the agent's colour
// read at least as the design's day set holds them; on the bar, its tabs and search; the ink on the
// bare top of the sky, where the time and figures sit, reads too. Computed here, apart from sky.ts.
const rgbaOf = (value: string): number[] => {
  const found = /rgb\((\d+) (\d+) (\d+)(?: \/ ([\d.]+))?\)/.exec(value);
  if (found === null) throw new Error(`not a colour: ${value}`);
  return [Number(found[1]), Number(found[2]), Number(found[3]), found[4] === undefined ? 1 : Number(found[4])];
};
const laid = (top: number[], under: number[]): number[] =>
  [0, 1, 2].map((i) => (top[i] ?? 0) * (top[3] ?? 1) + (under[i] ?? 0) * (1 - (top[3] ?? 1)));
const relative = (rgb: number[]): number => {
  const channel = (c: number): number => (c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channel(rgb[0] ?? 0) + 0.7152 * channel(rgb[1] ?? 0) + 0.0722 * channel(rgb[2] ?? 0);
};
const ratio = (a: number[], b: number[]): number =>
  (Math.max(relative(a), relative(b)) + 0.05) / (Math.min(relative(a), relative(b)) + 0.05);

it("keeps every control and its text readable against the sky at every half hour of the day", () => {
  const short: string[] = [];
  for (let at = 0; at < 1440; at += 30) {
    const style = skyStyle(new Date(2026, 9, 29, Math.floor(at / 60), at % 60)) as Record<string, string>;
    const token = (name: string): number[] => rgbaOf(style[name] ?? "");
    const stops = skyAt(at).stops.map(rgbaOf);
    const check = (where: string, behind: number[], floors: Record<string, number>): void => {
      for (const [name, floor] of Object.entries(floors)) {
        const seen = ratio(laid(token(name), behind), behind);
        if (seen < floor)
          short.push(
            `${Math.floor(at / 60)}:${String(at % 60).padStart(2, "0")} ${name} on ${where}: ${seen.toFixed(2)} < ${floor}`,
          );
      }
    };
    for (const [i, stop] of stops.entries())
      check(`a panel over stop ${i}`, laid(token("--glass"), stop), {
        "--ink": 7,
        "--mute": 3.5,
        "--faint": 1.8,
        "--steel": 3,
      });
    check("the bar", laid(token("--bar"), stops[0] ?? []), { "--ink": 6, "--mute": 3.2 });
    // Step PH: the phone's tab bar, its labels and icons, over every stop of the sky.
    for (const [i, stop] of stops.entries())
      check(`the tab bar over stop ${i}`, laid(token("--tabbar"), stop), { "--ink": 6, "--mute": 3.2 });
    check("the top of the sky", stops[0] ?? [], { "--ink": 4 });
    // A title, the time, "Over time" and its control sit on the sky itself,
    // over any stop, behind its veil; at 6:30 they read at 1.7 and 1.3 to 1 before it.
    for (const [i, stop] of stops.entries())
      check(`the sky's veil over stop ${i}`, laid(token("--sky-veil"), stop), { "--ink": 4.5, "--mute": 2.5 });
  }
  expect(short).toEqual([]);
});

it("veils the sky only where it must: never at the design's three skies, and at dawn and dusk", () => {
  const alpha = (h: number, m: number): number =>
    rgbaOf((skyStyle(new Date(2026, 9, 29, h, m)) as Record<string, string>)["--sky-veil"] ?? "")[3] ?? 1;
  expect([alpha(11, 0), alpha(18, 40), alpha(21, 0)]).toEqual([0, 0, 0]);
  expect(alpha(6, 30)).toBeGreaterThan(0);
  expect(alpha(19, 0)).toBeGreaterThan(0);
});
