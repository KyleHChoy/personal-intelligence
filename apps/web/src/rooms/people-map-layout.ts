// The map's geometry, with no React: each node's ring and place, the view that fits them, and where
// each name goes so that none overlaps another, a node, the zoom buttons or the frame's edge.
import type { NetworkEdge, NetworkNode, OwnerSearchResult } from "@intelligence/contracts/personal";
import { capital, UNNAMED, UNNAMED_ORGANIZATION } from "../words.ts";
import { RANKED } from "./people-parts.tsx";

export type Hit = OwnerSearchResult["hits"][number];
export type Placed = NetworkNode & { x: number; y: number };
export type Graph = { nodes: Readonly<Record<string, Placed>>; edges: readonly NetworkEdge[] };
export type View = { x: number; y: number; k: number };

// The design's frame, 840 wide, the owner a little above its middle, tall enough for the outermost
// ring (150 + 6 * 30 = 330 out) and a label above and below it.
export const WIDE = 840;
export const HIGH = 720;
export const FRAME = { x0: -WIDE / 2, x1: WIDE / 2, y0: -360, y1: 360 };
// The zoom buttons' left edge and foot, a corner no name may sit under.
const BUTTONS = { x: FRAME.x1 - 150, y: FRAME.y0 + 50 };
const FIRST_RING = 150;
const RING_STEP = 30;
// How far out an expanded node's neighbours sit, and how far apart.
const OUTWARD = 110;
const SPREAD = 0.42;
export const OUTERMOST = RANKED.length;

// The owner at the centre, a person on their tier's ring, an organization or an untiered person outside.
const ringOf = (node: NetworkNode): number =>
  node.kind === "owner"
    ? -1
    : node.kind === "organization" || node.tier === null
      ? OUTERMOST
      : RANKED.indexOf(node.tier);
export const radiusOf = (ring: number): number => (ring < 0 ? 0 : FIRST_RING + ring * RING_STEP);

// Fans `fresh` out from `around`, along its own direction from the owner, `far` out and `spread` apart.
function fanOut(
  next: Record<string, Placed>,
  fresh: readonly NetworkNode[],
  around: Placed,
  far: number,
  spread: number,
) {
  const away = around.x === 0 && around.y === 0 ? -Math.PI / 2 : Math.atan2(around.y, around.x);
  fresh.forEach((node, index) => {
    const angle = away + (index - (fresh.length - 1) / 2) * spread;
    next[node.id] = { ...node, x: far * Math.cos(angle), y: far * Math.sin(angle) };
  });
}
// Someone known by a name alone sits toward the person who named them, just outside every ring, so
// the first-hand network stays whole inside.
const NAMED_OUT = 44;
const NAMED_GAP = 30;

// Places the nodes not yet placed: on their rings, spread evenly from the top, or outward from
// `around` when expanding.
export function place(
  nodes: readonly NetworkNode[],
  placed: Readonly<Record<string, Placed>>,
  around?: Placed,
  edges: readonly NetworkEdge[] = [],
): Record<string, Placed> {
  const next = { ...placed };
  const fresh = nodes.filter((node) => next[node.id] === undefined);
  if (around !== undefined) {
    fanOut(next, fresh, around, Math.hypot(around.x, around.y) + OUTWARD, SPREAD);
    return next;
  }
  // A namer is never the owner, nor someone else known only by name.
  const notNamer = new Set<string>(
    nodes.filter((node) => node.nameOnly === true || node.kind === "owner").map((node) => node.id),
  );
  const namer = (node: NetworkNode): string | undefined =>
    node.nameOnly !== true
      ? undefined
      : edges
          .map((edge): string | null => (edge.to === node.id ? edge.from : edge.from === node.id ? edge.to : null))
          .find((id): id is string => id !== null && !notNamer.has(id));
  const ringed = new Set<string>([
    ...Object.keys(next),
    ...fresh.filter((node) => node.nameOnly !== true).map((node) => node.id),
  ]);
  const outside = new Map<string, NetworkNode[]>();
  for (const node of fresh) {
    const by = namer(node);
    if (by !== undefined && ringed.has(by)) outside.set(by, [...(outside.get(by) ?? []), node]);
  }
  const later = new Set([...outside.values()].flat().map((node) => node.id));
  const rings = new Map<number, NetworkNode[]>();
  for (const node of fresh.filter((one) => !later.has(one.id)))
    rings.set(ringOf(node), [...(rings.get(ringOf(node)) ?? []), node]);
  for (const [ring, members] of rings)
    members.forEach((node, index) => {
      const angle = -Math.PI / 2 + (2 * Math.PI * index) / members.length + Math.max(0, ring) * 0.5;
      next[node.id] = { ...node, x: radiusOf(ring) * Math.cos(angle), y: radiusOf(ring) * Math.sin(angle) };
    });
  const edge = Math.max(0, ...Object.values(next).map((one) => Math.hypot(one.x, one.y)));
  for (const [by, group] of outside) {
    const namedBy = next[by] as Placed;
    const far = Math.max(Math.hypot(namedBy.x, namedBy.y), edge) + NAMED_OUT;
    fanOut(next, group, namedBy, far, NAMED_GAP / far);
  }
  return next;
}

export const edgeKey = (edge: NetworkEdge): string => `${edge.from}|${edge.to}|${edge.kind}`;
export const pairOf = (edge: NetworkEdge): string =>
  edge.from < edge.to ? `${edge.from}|${edge.to}` : `${edge.to}|${edge.from}`;
// An organization by its name, else its domain; "no name" only with neither.
export const labelOf = (node: NetworkNode): string =>
  node.kind === "owner"
    ? "You"
    : node.kind === "organization"
      ? (node.name?.untrusted ?? node.address?.untrusted ?? UNNAMED_ORGANIZATION)
      : (node.name?.untrusted ?? capital(UNNAMED));

// ---------- Labels that never overlap or leave the frame ----------

type At = { x: number; y: number; anchor: "start" | "end" | "middle"; lead?: boolean };
type Box = { x0: number; y0: number; x1: number; y1: number };
// A lead line, from its node to a name set off from it.
type Lead = [number, number, number, number];

// The stylesheet's 13px Hanken Grotesk is about 7.4 units a character. A line with the label's 4px
// halo takes 15 above the baseline and 5 below; the next line is 16 lower. A name is never cut.
const CHAR = 7.4;
const LINE = { above: 15, below: 5, side: 3, next: 16 };
// The least room between two names, so they never crowd one another.
const LABEL_GAP = 6;
const LINE_MOST = 22;
export function linesOf(label: string): string[] {
  const lines: string[] = [];
  for (const word of label.split(/\s+/).filter((one) => one !== "")) {
    const last = lines.at(-1);
    if (last !== undefined && last.length + 1 + word.length <= LINE_MOST) lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(word);
  }
  return lines.length === 0 ? [label] : lines;
}

// A name beside its node, away from the owner: right on the right, left on the left, above or below
// at the top and bottom; then further out along eight directions, where a thin line leads back.
function labelAt(node: Placed): At {
  if (node.kind === "owner") return { x: 0, y: 28, anchor: "middle" };
  const angle = Math.atan2(node.y, node.x);
  const cos = Math.cos(angle);
  if (cos > 0.35) return { x: 12, y: 4, anchor: "start" };
  if (cos < -0.35) return { x: -12, y: 4, anchor: "end" };
  return { x: 0, y: Math.sin(angle) < 0 ? -13 : 22, anchor: "middle" };
}
const REACH = [0, 16, 32, 52, 76, 104, 136, 172, 212];
const sidesOf = (node: Placed): At[] => [
  labelAt(node),
  ...REACH.flatMap((d): At[] => [
    { x: 12 + d, y: 4, anchor: "start" },
    { x: -12 - d, y: 4, anchor: "end" },
    { x: 0, y: -13 - d, anchor: "middle" },
    { x: 0, y: 22 + d, anchor: "middle" },
    { x: 10 + d * 0.7, y: -8 - d * 0.7, anchor: "start" },
    { x: -10 - d * 0.7, y: -8 - d * 0.7, anchor: "end" },
    { x: 10 + d * 0.7, y: 18 + d * 0.7, anchor: "start" },
    { x: -10 - d * 0.7, y: 18 + d * 0.7, anchor: "end" },
  ]).map((side) => ({ ...side, lead: Math.hypot(side.x, side.y) > 24 })),
];

const meets = (a: Box, b: Box): boolean => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
const crosses = (lead: Lead, box: Box): boolean =>
  [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9].some((t) => {
    const x = lead[0] + (lead[2] - lead[0]) * t;
    const y = lead[1] + (lead[3] - lead[1]) * t;
    return x > box.x0 && x < box.x1 && y > box.y0 && y < box.y1;
  });
// Two leads cross when each one's ends lie on either side of the other.
const turn = (a: number, b: number, c: number, d: number, e: number, f: number): number =>
  Math.sign((c - a) * (f - b) - (d - b) * (e - a));
const cut = (p: Lead, q: Lead): boolean =>
  turn(p[0], p[1], p[2], p[3], q[0], q[1]) * turn(p[0], p[1], p[2], p[3], q[2], q[3]) < 0 &&
  turn(q[0], q[1], q[2], q[3], p[0], p[1]) * turn(q[0], q[1], q[2], q[3], p[2], p[3]) < 0;
const inFrame = (box: Box, margin = 0): boolean =>
  box.x0 >= FRAME.x0 + margin &&
  box.x1 <= FRAME.x1 - margin &&
  box.y0 >= FRAME.y0 + margin &&
  box.y1 <= FRAME.y1 - margin;

// Where each label goes, `wanted` first: its own side, else the nearest free place around it. A
// label never covers another, a node, a lead, the buttons or the frame's edge; one that fits nowhere
// is left off, and the node's title names it. The chosen node (`must`) is always named. Nodes and
// names are drawn at one size whatever the zoom, so only their places scale.
export function placeLabels(
  nodes: readonly Placed[],
  wanted: readonly string[],
  view: View,
  must: string | null,
): Map<string, At> {
  const byId = new Map(nodes.map((node) => [node.id as string, node]));
  const screen = (node: Placed) => ({ x: node.x * view.k + view.x, y: node.y * view.k + view.y });
  const taken: Box[] = nodes.map((node) => {
    const at = screen(node);
    const r = node.kind === "owner" ? 10 : 7;
    return { x0: at.x - r, y0: at.y - r, x1: at.x + r, y1: at.y + r };
  });
  const leads: Lead[] = [];
  const fits = (box: Box): boolean =>
    inFrame(box, 4) &&
    !(box.x1 > BUTTONS.x && box.y0 < BUTTONS.y) &&
    !taken.some((one) => meets(one, box)) &&
    !leads.some((lead) => crosses(lead, box));
  const placed = new Map<string, At>();
  for (const id of wanted) {
    const node = byId.get(id);
    if (node === undefined || placed.has(id)) continue;
    const lines = linesOf(labelOf(node));
    const width = Math.max(...lines.map((line) => line.length)) * CHAR;
    const more = (lines.length - 1) * LINE.next;
    const at = screen(node);
    const boxOf = (side: At): Box => {
      const left = at.x + side.x - (side.anchor === "start" ? 0 : side.anchor === "end" ? width : width / 2);
      const base = at.y + side.y;
      return {
        x0: left - LINE.side,
        y0: base - LINE.above,
        x1: left + width + LINE.side,
        y1: base + more + LINE.below,
      };
    };
    // A label set above its node grows upward: its first line moves up by the lines under it.
    const sides = sidesOf(node).map((side) => (side.y < 0 && more > 0 ? { ...side, y: side.y - more } : side));
    const own = taken[nodes.indexOf(node)];
    const leadOf = (side: At): Lead => [at.x, at.y, at.x + side.x, at.y + side.y - 4];
    const free = (side: At): boolean =>
      fits(boxOf(side)) &&
      (side.lead !== true ||
        !(
          taken.some((one) => one !== own && crosses(leadOf(side), one)) || leads.some((one) => cut(leadOf(side), one))
        ));
    // The chosen node with no free place is named beside it, with no lead, where one fits the frame.
    const side =
      sides.find(free) ??
      (id === must
        ? (sides.find((one) => one.lead !== true && inFrame(boxOf(one))) ??
          sides.find((one) => inFrame(boxOf(one))) ??
          sides[0])
        : undefined);
    if (side === undefined) continue;
    const box = boxOf(side);
    taken.push({ x0: box.x0 - LABEL_GAP, y0: box.y0 - LABEL_GAP, x1: box.x1 + LABEL_GAP, y1: box.y1 + LABEL_GAP });
    if (side.lead === true) leads.push(leadOf(side));
    placed.set(id, side);
  }
  return placed;
}

// The view that shows every node drawn, with room beside each for its name, in the frame: never
// closer than zoom 1, and a few units kept under the zoom buttons.
export function fitView(nodes: readonly Placed[]): View {
  if (nodes.length === 0) return { x: 0, y: 0, k: 1 };
  const xs = nodes.map((node) => node.x);
  const ys = nodes.map((node) => node.y);
  const [x0, x1] = [Math.min(...xs) - 60, Math.max(...xs) + 60];
  const [y0, y1] = [Math.min(...ys) - LINE.above - LINE.next, Math.max(...ys) + 22 + LINE.below];
  const top = FRAME.y0 + 8;
  const k = Math.min(1, (FRAME.x1 - FRAME.x0) / (x1 - x0), (FRAME.y1 - top) / (y1 - y0));
  return { x: (FRAME.x0 + FRAME.x1) / 2 - ((x0 + x1) / 2) * k, y: (top + FRAME.y1) / 2 - ((y0 + y1) / 2) * k, k };
}
