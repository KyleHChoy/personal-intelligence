import type { CSSProperties } from "react";

// The sky behind the page, from the owner's local time: a three-stop vertical gradient read off a
// palette of keyframes across the day and blended in OKLab between the two either side of the
// minute, so the sky moves every minute and never jumps. The ink and glass follow the sky's
// lightness: the light set by day, the night set by night, and the glass as opaque as the sky needs
// for text and controls to read on it (skyStyle). Pure: a time in, the app root's custom properties
// out, set through React's style prop (no markup, the policy holds).

type Rgba = readonly [number, number, number, number];
type Lab = readonly [number, number, number, number];

const hex = (value: string): Rgba => [
  parseInt(value.slice(1, 3), 16),
  parseInt(value.slice(3, 5), 16),
  parseInt(value.slice(5, 7), 16),
  1,
];

// sRGB (0-255) and OKLab (Björn Ottosson's matrices), alpha carried alongside.
const linear = (c: number): number => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const gamma = (v: number): number => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
function toLab([r8, g8, b8, a]: Rgba): Lab {
  const [r, g, b] = [linear(r8), linear(g8), linear(b8)];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    a,
  ];
}
function toRgba([L, A, B, a]: Lab): Rgba {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const clamp = (v: number): number => Math.min(255, Math.max(0, Math.round(gamma(v))));
  return [
    clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    a,
  ];
}
const mix = (from: Lab, to: Lab, t: number): Lab =>
  [0, 1, 2, 3].map((i) => (from[i] ?? 0) + ((to[i] ?? 0) - (from[i] ?? 0)) * t) as unknown as Lab;
const css = ([r, g, b, a]: Rgba): string =>
  a >= 1 ? `rgb(${r} ${g} ${b})` : `rgb(${r} ${g} ${b} / ${Math.round(a * 1000) / 1000})`;

// The keyframes: minute of the day, then the gradient's top, middle (at 45%) and bottom. The
// design's three skies are anchors: its morning at 11:00, its dusk at 18:40, its night at 21:00.
const KEYFRAMES: readonly (readonly [number, string, string, string])[] = [
  [0, "#0b111d", "#0f1726", "#141e30"], // deep night
  [4 * 60 + 30, "#0c1322", "#121b2e", "#19233b"], // deep night, the first blue
  [5 * 60 + 30, "#1d2a4a", "#2e3d63", "#4a5578"], // pre-dawn blue
  [6 * 60 + 15, "#45507e", "#9a8aa6", "#dcae9f"], // dawn rose
  [6 * 60 + 50, "#8496bd", "#dcbfb0", "#f0cfa8"], // dawn amber
  [8 * 60, "#aec2db", "#dcdee4", "#f4e5d6"], // morning
  [11 * 60, "#c5d3e2", "#dbe3ec", "#eceff2"], // mid-morning: the design's day sky
  [13 * 60, "#a8c3e2", "#d0dfee", "#eef3f8"], // midday
  [15 * 60 + 45, "#b6c8dc", "#dbe0e6", "#f1eae0"], // afternoon
  [17 * 60 + 45, "#c8c3cc", "#e8d3bd", "#f4e1c6"], // golden hour
  [18 * 60 + 40, "#b9b8c9", "#d9cdcb", "#ece4de"], // sunset: the design's dusk sky
  [19 * 60 + 20, "#4f5583", "#7d7399", "#a88f9f"], // dusk violet
  [20 * 60, "#23304f", "#2f3a5a", "#3e4563"], // blue hour
  [21 * 60, "#0f1726", "#131d2e", "#172235"], // night: the design's night sky
  [24 * 60, "#0b111d", "#0f1726", "#141e30"], // deep night again
];
const LABS = KEYFRAMES.map(([minute, ...stops]) => ({ minute, stops: stops.map((stop) => toLab(hex(stop))) }));

// The design's two token sets: its light set by day and its night set.
const rgba = (r: number, g: number, b: number, a: number): Rgba => [r, g, b, a];
const LIGHT: Record<string, Rgba> = {
  "--p1": hex("#3552b8"),
  "--p2": hex("#2a8a7b"),
  "--p3": hex("#b8751c"),
  "--p4": hex("#a3abb4"),
  "--ink": hex("#1a2330"),
  "--mute": hex("#66707c"),
  "--faint": hex("#a3abb4"),
  "--steel": hex("#3552b8"),
  "--warn": hex("#9a5a1c"),
  "--danger": hex("#b3402f"),
  "--glass": rgba(255, 255, 255, 0.6),
  "--solid": hex("#fafbfc"),
  "--tint": rgba(255, 255, 255, 0.6),
  "--line": rgba(26, 35, 48, 0.16),
  "--rule": rgba(26, 35, 48, 0.07),
};
const NIGHT: Record<string, Rgba> = {
  "--p1": hex("#a3b5f2"),
  "--p2": hex("#6cc8b8"),
  "--p3": hex("#e0a466"),
  "--p4": hex("#5d6878"),
  "--ink": hex("#e6ebf2"),
  "--mute": hex("#97a2b0"),
  "--faint": hex("#5d6878"),
  "--steel": hex("#a3b5f2"),
  "--warn": hex("#e0a466"),
  "--danger": hex("#f08a78"),
  "--glass": rgba(30, 40, 58, 0.6),
  "--solid": hex("#172133"),
  "--tint": rgba(255, 255, 255, 0.05),
  "--line": rgba(255, 255, 255, 0.16),
  "--rule": rgba(255, 255, 255, 0.07),
};

// The lightness (OKLab L) of the upper sky, where the time and the figures sit on it with no panel
// behind them (its top stop weighed 0.6, its middle 0.4), over which the ink crosses from the light
// set to the night set: about a quarter of an hour of real time, at dawn and at dusk.
const LIGHT_ABOVE = 0.7;
const NIGHT_BELOW = 0.6;

export type Sky = { minute: number; stops: [string, string, string]; night: number };

// The sky's three stops at a minute of the day, and how far into night it is.
function skyOf(minute: number): { at: number; stops: Rgba[]; night: number } {
  const at = ((minute % 1440) + 1440) % 1440;
  const after = LABS.findIndex((frame) => frame.minute > at);
  const to = LABS[after] ?? LABS[LABS.length - 1];
  const from = LABS[after - 1] ?? LABS[0];
  if (to === undefined || from === undefined) throw new Error("the sky has no keyframes");
  const t = to.minute === from.minute ? 0 : (at - from.minute) / (to.minute - from.minute);
  const stops = from.stops.map((stop, i) => mix(stop, to.stops[i] ?? stop, t));
  const lightness = 0.6 * (stops[0]?.[0] ?? 1) + 0.4 * (stops[1]?.[0] ?? 1);
  const night = Math.min(1, Math.max(0, (LIGHT_ABOVE - lightness) / (LIGHT_ABOVE - NIGHT_BELOW)));
  return { at, stops: stops.map(toRgba), night };
}

// The sky at a minute of the day (0 to 1440, fractions allowed).
export function skyAt(minute: number): Sky {
  const sky = skyOf(minute);
  return { minute: sky.at, stops: sky.stops.map(css) as [string, string, string], night: sky.night };
}

// WCAG's contrast of two opaque colours, and a colour laid over another.
const luminance = ([r, g, b]: Rgba): number => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
const contrast = (a: Rgba, b: Rgba): number => {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
const over = (top: Rgba, under: Rgba): Rgba =>
  [0, 1, 2].map((i) => (top[i] ?? 0) * top[3] + (under[i] ?? 0) * (1 - top[3])).concat(1) as unknown as Rgba;

// What text and controls keep against what is behind them at every minute:
// on a panel, the ink, the muted ink, the check ring (`--faint`) and the agent's colour, each about
// as the design's day set holds it at its lowest; on the bar, its tabs and its search. Where the sky
// is mid-grey, at dawn and at dusk, a panel or the bar is made more opaque until each holds; the
// design's own opacity is the least.
// On the sky itself, with no panel: a room's title, Today's time and figures,
// the Ledger's "Over time" and the controls beside them, the ink and the muted ink as the design's
// dusk holds them. They may sit anywhere down the sky, so a veil (`--sky-veil`) behind them is as
// opaque as every stop needs: none at all wherever the sky already holds them, the design's skies
// among those hours.
const FLOORS = {
  panel: { "--ink": 7, "--mute": 3.5, "--faint": 1.8, "--steel": 3 },
  bar: { "--ink": 6, "--mute": 3.2 },
  sky: { "--ink": 4.5, "--mute": 2.5 },
} as const;
const LEAST_ALPHA = { panel: 0.6, bar: 0.35, sky: 0, tabbar: 0.84 } as const;
const MOST_ALPHA = 0.95;
// The least opacity of `fill` over each of `stops` at which every floor holds, or the most.
function veil(
  fill: Rgba,
  from: number,
  set: Record<string, Rgba>,
  floors: Readonly<Record<string, number>>,
  stops: readonly Rgba[],
): number {
  for (let step = Math.round(from * 100); step < MOST_ALPHA * 100; step += 1) {
    const alpha = step / 100;
    const holds = stops.every((stop) => {
      const behind = over([fill[0], fill[1], fill[2], alpha], stop);
      return Object.entries(floors).every(
        ([token, floor]) => contrast(over(set[token] ?? fill, behind), behind) >= floor,
      );
    });
    if (holds) return alpha;
  }
  return MOST_ALPHA;
}

// The app root's custom properties for a time on the owner's device. The page takes the light set or the
// night set whole, by the sky's lightness, switching in the minute the sky passes its middle: a
// blend of the two is a mid-grey ink on a mid-grey glass, which no one can read. A panel's glass
// and the bar are then as opaque as each floor needs.
export function skyStyle(now: Date): CSSProperties {
  const sky = skyOf(now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60);
  const set = sky.night < 0.5 ? LIGHT : NIGHT;
  const [glass, solid] = [set["--glass"] ?? hex("#ffffff"), set["--solid"] ?? hex("#ffffff")];
  const [top, middle, bottom] = sky.stops.map(css);
  const style: Record<string, string> = {
    "--sky": `linear-gradient(180deg, ${top} 0%, ${middle} 45%, ${bottom} 100%)`,
    // The sky's top colour, for the bar's band over it.
    "--sky-top": top ?? "transparent",
    "--sky-mid": middle ?? "transparent",
    colorScheme: sky.night < 0.5 ? "light" : "dark",
  };
  for (const [name, value] of Object.entries(set)) style[name] = css(value);
  style["--glass"] = css([glass[0], glass[1], glass[2], veil(glass, LEAST_ALPHA.panel, set, FLOORS.panel, sky.stops)]);
  // The bar lies over the top of the sky.
  style["--bar"] = css([
    solid[0],
    solid[1],
    solid[2],
    veil(solid, LEAST_ALPHA.bar, set, FLOORS.bar, sky.stops.slice(0, 1)),
  ]);
  // The phone's bars: its tab bar floats at the foot of the screen, over whichever stop is
  // there, and its navigation bar over the rooms' rows once the owner scrolls; each a material, at least
  // as opaque as a row passing under it needs to stay out of its words.
  style["--tabbar"] = css([solid[0], solid[1], solid[2], veil(solid, LEAST_ALPHA.tabbar, set, FLOORS.bar, sky.stops)]);
  // Text and controls on the sky may sit over any of its stops.
  style["--sky-veil"] = css([solid[0], solid[1], solid[2], veil(solid, LEAST_ALPHA.sky, set, FLOORS.sky, sky.stops)]);
  return style as CSSProperties;
}
