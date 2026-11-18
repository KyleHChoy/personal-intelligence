import {
  type FactView,
  type NetworkEdge,
  type NetworkNode,
  OBSERVED_TIES,
  type OwnerPaths,
} from "@intelligence/contracts/personal";
import { type PointerEvent as Pointer, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Loaded, read } from "../api.ts";
import { SUBJECT_WORDS } from "../enum-words.ts";
import { factSentence } from "../facts.ts";
import { useRead } from "../open-rows.tsx";
import {
  Empty,
  TextField as Field,
  initials,
  Label,
  OpenBody,
  OpenRow,
  Panel,
  TypedRow as Row,
  Seg,
  SegWrap,
} from "../parts.tsx";
import { capital, UNNAMED } from "../words.ts";
import {
  edgeKey,
  FRAME,
  fitView,
  type Graph,
  HIGH,
  type Hit,
  labelOf,
  linesOf,
  OUTERMOST,
  type Placed,
  pairOf,
  place,
  placeLabels,
  radiusOf,
  type View,
  WIDE,
} from "./people-map-layout.ts";
import {
  ItemBody,
  nameOf,
  type Picked,
  pathsOr,
  RANKED,
  refusal,
  Status,
  TIER_WORDS,
  useSearch,
} from "./people-parts.tsx";

// The Map, a view of People (the mockup's mapView and findPath): the owner's network from
// `network`, drawn as SVG here, the owner at the centre and each tier a ring; beside it "Find a
// path" to whoever the owner chooses on the map or names. A node chosen can be expanded to who it
// links to (`networkExpand`). The phone draws it too, pinched and dragged by touch.

const TIER_SETS = [
  ["regular", "Inner to Regular"],
  ["known", "Inner to Known"],
  ["all", "Every tier"],
] as const;
type TierSet = (typeof TIER_SETS)[number][0];
const TIERS_ASKED: Record<TierSet, string> = {
  regular: "inner,close,regular",
  known: "inner,close,regular,known",
  all: RANKED.join(","),
};
const SHOWN = [
  ["all", "Everyone"],
  ["awake", "Hide dormant"],
  ["people", "Hide organizations"],
] as const;
type Shown = (typeof SHOWN)[number][0];
const drawn = (node: NetworkNode, shown: Shown): boolean =>
  !(shown === "awake" && node.dormant) && !(shown === "people" && node.kind === "organization");
const rank = (node: NetworkNode): number =>
  node.kind === "owner" ? 0 : node.kind === "organization" ? 1 : 2 + RANKED.indexOf(node.tier ?? "one-way");
// Second-hand links: what someone else said, or research found.
const SECOND_HAND: ReadonlySet<NetworkEdge["kind"]> = new Set(["reported", "researched"]);
// Links nobody stated: code read them from mail, meetings and addresses.
const OBSERVED: ReadonlySet<string> = new Set(OBSERVED_TIES);

export function MapRoom({ focus, onOpenPerson }: { focus: Hit | null; onOpenPerson: (picked: Picked) => void }) {
  const [tierSet, setTierSet] = useState<TierSet>("regular");
  const [shown, setShown] = useState<Shown>("all");
  const { loaded, graph, selected, setSelected, expandNote, pick, load, expand } = useNetworkGraph(focus);
  useEffect(() => load(TIERS_ASKED[tierSet]), [tierSet, load]);
  useEffect(() => {
    if (focus !== null) pick(focus);
  }, [focus, pick]);
  const chosen = selected === null ? undefined : graph.nodes[selected];
  const path = usePath(selected, chosen?.kind === "owner");
  const best = path?.state === "ready" ? pathsOr(path.value.paths, graph, selected)[0] : undefined;
  const choose = (id: string): void => setSelected(id === selected ? null : id);
  const openOf = (node: NetworkNode) => () => onOpenPerson({ id: node.id, name: labelOf(node) });

  return (
    <div className="split map-split c12">
      <Panel title="Find a path">
        <ToField chosen={chosen} onPick={pick} />
        {chosen === undefined ? (
          <Empty>Type a name and press Return, or pick someone on the map.</Empty>
        ) : path !== null && path.state !== "ready" ? (
          <Status loaded={path} what="Paths" />
        ) : (
          <>
            {best === undefined ? <Empty>No path to them in what you know.</Empty> : null}
            {best?.nodes.map((node, index) => {
              const edge = best.edges[index - 1];
              return (
                <Row
                  key={node.id}
                  lead={{
                    av: node.kind === "owner" ? "Y" : initials(labelOf(node)),
                    avKind: node.kind === "organization" ? "org" : "person",
                  }}
                  what={labelOf(node)}
                  sub={edge === undefined ? null : linkWords(edge, best.nodes[index - 1], node)}
                  onOpen={node.kind === "person" ? openOf(node) : undefined}
                />
              );
            })}
            <div className="exp l-none">
              <OpenBody
                lead={[aboutOf(chosen), expandNote?.node === chosen.id ? expandNote.text : null]}
                actions={[
                  ...(chosen.kind === "person"
                    ? [{ label: `Open ${labelOf(chosen)}`, kind: "go" as const, onClick: openOf(chosen) }]
                    : []),
                  {
                    label: chosen.kind === "organization" ? "Show everyone there" : "Show who they know",
                    onClick: () => void expand(chosen.id),
                  },
                ]}
              />
            </div>
            <Links chosen={chosen} graph={graph} />
            {chosen.kind === "organization" ? (
              <Organization id={chosen.id} graph={graph} onChoose={choose} onOpen={onOpenPerson} />
            ) : null}
          </>
        )}
      </Panel>
      <Panel title="Map">
        {/* Which tiers and what to show, in their own strips under the head, as a room's views are. */}
        <SegWrap>
          <Seg label="Tiers" value={tierSet} options={TIER_SETS} onChange={setTierSet} />
        </SegWrap>
        <SegWrap>
          <Seg label="Show" value={shown} options={SHOWN} onChange={setShown} />
        </SegWrap>
        <Status loaded={loaded} what="The map" />
        <Drawing graph={graph} shown={shown} selected={selected} path={best} onChoose={choose} />
        <Empty>{legendWords(Object.values(graph.nodes), graph.edges)}</Empty>
      </Panel>
    </div>
  );
}

// ---------- The drawing ----------

// Lines, then nodes with their names, fitted to the frame. A name that fits nowhere is the node's
// title, and listed under the map. A node pressed is chosen as where Find a path goes.
function Drawing({
  graph,
  shown,
  selected,
  path,
  onChoose,
}: {
  graph: Graph;
  shown: Shown;
  selected: string | null;
  path: { nodes: readonly NetworkNode[]; edges: readonly NetworkEdge[] } | undefined;
  onChoose: (id: string) => void;
}) {
  const nodes = useMemo(() => Object.values(graph.nodes).filter((node) => drawn(node, shown)), [graph, shown]);
  const fit = useMemo(() => fitView(nodes), [nodes]);
  const { view, svg, zoom, refit, handlers, dragged } = usePanZoom(fit);
  const onPath = new Set<string>(path?.nodes.map((node) => node.id) ?? []);
  const lit = new Set((path?.edges ?? []).flatMap((edge) => [`${edge.from}|${edge.to}`, `${edge.to}|${edge.from}`]));
  const labels = useMemo(
    () =>
      placeLabels(
        nodes,
        [...nodes].sort((a, b) => rank(a) - rank(b)).map((node) => node.id),
        view,
        selected,
      ),
    [nodes, view, selected],
  );
  const unnamed = nodes.filter((node) => node.kind !== "owner" && !labels.has(node.id));
  const listed = unnamed.slice(0, UNNAMED_MOST);
  return (
    <div className="mapbox">
      <div className="zoom">
        <button type="button" className="btn sm" aria-label="Zoom out" onClick={() => zoom(1 / 1.3)}>
          −
        </button>
        <button type="button" className="btn sm" aria-label="Zoom in" onClick={() => zoom(1.3)}>
          +
        </button>
        <button type="button" className="btn sm" onClick={refit}>
          Fit
        </button>
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: an svg cannot be a fieldset; the group role names the map */}
      <svg
        ref={svg}
        className="map"
        viewBox={`${FRAME.x0} ${FRAME.y0} ${WIDE} ${HIGH}`}
        role="group"
        aria-label="Map of your people"
        {...handlers}
      >
        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          {graph.edges.map((edge) => {
            const [from, to] = [graph.nodes[edge.from], graph.nodes[edge.to]];
            if (from === undefined || to === undefined || !drawn(from, shown) || !drawn(to, shown)) return null;
            const kind = `edge ${edge.kind}${lit.has(`${edge.from}|${edge.to}`) ? " path" : ""}`;
            return <line key={edgeKey(edge)} className={kind} x1={from.x} y1={from.y} x2={to.x} y2={to.y} />;
          })}
          {nodes.map((node) => {
            const label = labelOf(node);
            const at = labels.get(node.id);
            const on = node.id === selected || onPath.has(node.id) ? "n on" : "n";
            return (
              // biome-ignore lint/a11y/useSemanticElements: an svg g cannot be a button; it takes focus and answers Enter and Space itself
              <g
                key={node.id}
                className={`node ${node.kind}${node.dormant ? " dormant" : ""}`}
                transform={`translate(${node.x} ${node.y})`}
                role="button"
                tabIndex={0}
                aria-label={label}
                aria-pressed={node.id === selected}
                onClick={() => {
                  if (!dragged()) onChoose(node.id);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  onChoose(node.id);
                }}
              >
                {/* A node and its name keep one size at any zoom. */}
                <g transform={view.k === 1 ? undefined : `scale(${1 / view.k})`}>
                  {node.kind === "owner" ? (
                    <circle className="me" r={9} />
                  ) : node.kind === "organization" ? (
                    <rect className={on} x={-6} y={-6} width={12} height={12} rx={2} />
                  ) : (
                    <circle className={on} r={6} />
                  )}
                  {at === undefined ? (
                    <title>{label}</title>
                  ) : (
                    <text x={at.x} y={at.y} textAnchor={at.anchor}>
                      {linesOf(label).map((line, index, lines) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: a name's lines keep their order and may repeat a word
                        <tspan key={index} x={at.x} dy={index === 0 ? 0 : 16}>
                          {index < lines.length - 1 ? `${line} ` : line}
                        </tspan>
                      ))}
                    </text>
                  )}
                </g>
              </g>
            );
          })}
        </g>
      </svg>
      {unnamed.length === 0 ? null : (
        <Empty>
          {unnamed.length === 1 ? "Not named at this size: " : `${unnamed.length} not named at this size: `}
          {listed.map((node, index) => (
            <span key={node.id}>
              <button type="button" className="inl" onClick={() => onChoose(node.id)}>
                {labelOf(node)}
              </button>
              {index < listed.length - 1 || unnamed.length > UNNAMED_MOST ? ", " : "."}
            </span>
          ))}
          {unnamed.length > UNNAMED_MOST ? ` and ${unnamed.length - UNNAMED_MOST} more. Zoom in to read them.` : null}
        </Empty>
      )}
    </div>
  );
}
const UNNAMED_MOST = 8;

// The owner's pan and zoom over the fitted view, null until they move it: a drag pans, the wheel
// and a two-finger pinch zoom, and Fit goes back. The wheel's listener cancels the page's scroll,
// so it is attached by hand, not passive. A press that travelled is a pan, not a choice of a node.
function usePanZoom(fit: View) {
  const [moved, setMoved] = useState<View | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const fitted = useRef(fit);
  fitted.current = fit;
  const down = useRef(new Map<number, { x: number; y: number }>());
  const travel = useRef(0);
  const move = (to: (was: View) => View): void => setMoved((now) => to(now ?? fitted.current));
  const zoom = (by: number): void =>
    move((was) => {
      const k = Math.min(6, Math.max(0.25, was.k * by));
      return { x: (was.x * k) / was.k, y: (was.y * k) / was.k, k };
    });
  // biome-ignore lint/correctness/useExhaustiveDependencies: `zoom` reads only refs and a state setter
  useEffect(() => {
    const element = svg.current;
    if (element === null) return;
    const wheel = (event: WheelEvent): void => {
      event.preventDefault();
      zoom(event.deltaY < 0 ? 1.15 : 1 / 1.15);
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, []);
  // Map units a screen pixel takes, as the view box is fitted into the element.
  const unit = (): number => {
    const box = svg.current?.getBoundingClientRect();
    return box === undefined || box.width === 0 || box.height === 0 ? 1 : Math.max(WIDE / box.width, HIGH / box.height);
  };
  const spread = (): number => {
    const [a, b] = [...down.current.values()];
    return a === undefined || b === undefined ? 0 : Math.hypot(a.x - b.x, a.y - b.y);
  };
  const up = (event: Pointer) => down.current.delete(event.pointerId);
  const handlers = {
    onPointerDown: (event: Pointer) => {
      if (down.current.size === 0) travel.current = 0;
      down.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      // Held until released, wherever the pointer goes, so a release off the map still ends the drag.
      (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
    },
    onPointerMove: (event: Pointer) => {
      const last = down.current.get(event.pointerId);
      if (last === undefined) return;
      const before = spread();
      down.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (down.current.size >= 2) {
        if (before > 0) zoom(spread() / before);
        travel.current += 10;
        return;
      }
      const [dx, dy] = [(event.clientX - last.x) * unit(), (event.clientY - last.y) * unit()];
      travel.current += Math.abs(dx) + Math.abs(dy);
      move((was) => ({ ...was, x: was.x + dx, y: was.y + dy }));
    },
    onPointerUp: up,
    onPointerCancel: up,
    onLostPointerCapture: up,
  };
  return { view: moved ?? fit, svg, zoom, refit: () => setMoved(null), handlers, dragged: () => travel.current > 6 };
}

// Find a path's To: Return picks the first match.
function ToField({ chosen, onPick }: { chosen: NetworkNode | undefined; onPick: (hit: Hit) => void }) {
  const [term, setTerm] = useState("");
  const hits = useSearch(term);
  const found = hits?.state === "ready" ? hits.value.filter((hit) => hit.who.name !== null).slice(0, 5) : [];
  const pick = (hit: Hit): void => {
    setTerm("");
    onPick(hit);
  };
  return (
    <div className="list">
      <Field
        label="Find a path to"
        hideLabel
        value={term}
        onChange={setTerm}
        maxLength={100}
        placeholder={chosen === undefined ? "To: a name" : `To: ${labelOf(chosen)}`}
        onEnter={() => {
          if (found[0] !== undefined) pick(found[0]);
        }}
      />
      {hits === null ? null : <Status loaded={hits} what="People" />}
      {hits?.state === "ready" && found.length === 0 ? <Empty>No one by that name.</Empty> : null}
      {found.map((hit) => (
        <Row
          key={hit.who.id}
          lead={{ av: initials(nameOf(hit.who)) }}
          what={nameOf(hit.who)}
          meta={hit.tier === null ? "" : TIER_WORDS[hit.tier]}
          onOpen={() => pick(hit)}
        />
      ))}
    </div>
  );
}

// ---------- What the Map says beside its drawing ----------

// Who the chosen node is: its name, its tier or that it is an organization, then what else marks it.
const aboutOf = (node: NetworkNode): string =>
  [
    labelOf(node),
    node.kind === "organization" ? SUBJECT_WORDS.organization : null,
    node.kind === "person" && node.tier != null ? `${TIER_WORDS[node.tier]} tier` : null,
    node.nameOnly === true ? "Known only by name" : null,
    node.goal === true ? "A goal of yours is after them" : null,
    node.dormant ? "Dormant" : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");

// How two neighbours are linked, in the owner's words: what was said firsthand, what someone else
// said or research found, and what only the mail, a meeting or an address shows, which nobody said.
const LINK_WORDS: Record<
  Exclude<NetworkEdge["kind"], "tie" | "intro_offer" | "affiliation" | "same_domain">,
  string
> = {
  relationship: "Know each other",
  acquaintance: "Have met",
  connection: "You confirmed they know each other",
  reported: "Someone else said they know each other",
  researched: "Found by research",
  shared_thread: "On the same email thread (nobody said they know each other)",
  met_together: "In the same meeting (nobody said they know each other)",
};
function linkWords(edge: NetworkEdge, from: NetworkNode | undefined, to: NetworkNode | undefined): string {
  const org = from?.kind === "organization" || to?.kind === "organization";
  const other = from?.kind === "owner" ? to : from;
  if (edge.kind === "tie")
    return other?.tier == null ? "In touch with you" : `In touch with you · ${TIER_WORDS[other.tier]}`;
  if (edge.kind === "intro_offer")
    return edge.offer === "suggested" ? "Suggested you meet" : "Offered to introduce you";
  if (edge.kind === "affiliation") return org ? "Works there" : "Work at the same place";
  if (edge.kind === "same_domain")
    return org
      ? "Has an address there (nobody said they work there)"
      : "Addresses at the same organization (nobody said they know each other)";
  return LINK_WORDS[edge.kind];
}

// The chosen node's links that rest on a claim, firsthand first, each opening the claim in place.
// The owner's own tie and an address's domain rest on none.
function Links({ chosen, graph }: { chosen: NetworkNode; graph: Graph }) {
  const links = graph.edges
    .filter(
      (edge): edge is NetworkEdge & { fact: string } =>
        edge.fact !== null && (edge.from === chosen.id || edge.to === chosen.id),
    )
    .sort((a, b) => Number(SECOND_HAND.has(a.kind)) - Number(SECOND_HAND.has(b.kind)) || b.weight - a.weight);
  if (links.length === 0) return null;
  return (
    <>
      <Label>How they are linked</Label>
      {links.map((edge) => {
        const other = graph.nodes[edge.from === chosen.id ? edge.to : edge.from];
        const what = other === undefined ? capital(UNNAMED) : labelOf(other);
        const sub = linkWords(edge, graph.nodes[edge.from], graph.nodes[edge.to]);
        return (
          <OpenRow key={edgeKey(edge)} id={`link-${edgeKey(edge)}`} row={{ what, sub }}>
            <ItemBody item={{ kind: "fact", id: edge.fact }} />
          </OpenRow>
        );
      })}
    </>
  );
}

// An organization chosen on the map: the people the map links to it, each opened or chosen on the
// map, and what is known about it.
function Organization({
  id,
  graph,
  onChoose,
  onOpen,
}: {
  id: string;
  graph: Graph;
  onChoose: (id: string) => void;
  onOpen: (picked: Picked) => void;
}) {
  const [page] = useRead("entityPage", { entity: id });
  const linked = graph.edges.flatMap((edge) =>
    edge.kind !== "affiliation" ? [] : edge.to === id ? [edge.from] : edge.from === id ? [edge.to] : [],
  );
  const people = [...new Set(linked)]
    .map((one) => graph.nodes[one])
    .filter((node): node is Placed => node !== undefined && node.kind === "person")
    .sort((a, b) => rank(a) - rank(b));
  const known =
    page.state === "ready" && page.value !== null
      ? page.value.facts.beliefs.flatMap((belief) =>
          belief.cites.slice(0, 1).flatMap((cite) => ("held" in cite ? [] : [factSentence(cite as FactView)])),
        )
      : [];
  return (
    <>
      <Label>People there</Label>
      {people.length === 0 ? (
        <Empty>No one on the map is linked to it. Show everyone there to look further.</Empty>
      ) : null}
      {people.map((person) => (
        <OpenRow
          key={person.id}
          id={`map-org-${person.id}`}
          row={{ what: labelOf(person), meta: person.tier == null ? "" : TIER_WORDS[person.tier] }}
        >
          <OpenBody
            actions={[
              { label: "Open", kind: "go", onClick: () => onOpen({ id: person.id, name: labelOf(person) }) },
              { label: "Show on the map", onClick: () => onChoose(person.id) },
            ]}
          />
        </OpenRow>
      ))}
      <Label>Known about it</Label>
      <Status loaded={page} what="What is known" />
      {page.state === "ready" && known.length === 0 ? <Empty>Nothing yet.</Empty> : null}
      {known.map((sentence, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the sentences are read whole and never reordered, and two may say the same thing
        <Row key={index} what={sentence} />
      ))}
    </>
  );
}

// The map's key in plain words, for every mark this map draws; a mark not drawn is not said.
function legendWords(nodes: readonly NetworkNode[], edges: readonly NetworkEdge[]): string | null {
  if (nodes.every((node) => node.kind === "owner")) return null;
  const firsthand = (edge: NetworkEdge) =>
    !SECOND_HAND.has(edge.kind) && !OBSERVED.has(edge.kind) && edge.kind !== "affiliation";
  return [
    nodes.some((node) => node.kind === "person" && node.nameOnly !== true) ? "○ a person" : null,
    nodes.some((node) => node.kind === "organization" && node.nameOnly !== true) ? "□ an organization" : null,
    edges.some(firsthand) ? "a line: known firsthand" : null,
    edges.some((edge) => edge.kind === "affiliation") ? "works there" : null,
    edges.some((edge) => SECOND_HAND.has(edge.kind)) ? "someone else said so, or research found it" : null,
    edges.some((edge) => OBSERVED.has(edge.kind)) ? "seen together, nobody said they know each other" : null,
    nodes.some((node) => node.nameOnly === true) ? "known only by name" : null,
    nodes.some((node) => node.goal === true) ? "a goal of yours is after them" : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

// ---------- The graph and the path ----------

// The node a search picked, added when the map does not hold it, so the owner can expand it.
function withHit(was: Graph, hit: Hit | null): Graph {
  const { who } = hit ?? {};
  if (hit === null || who === undefined || was.nodes[who.id] !== undefined) return was;
  if (who.kind !== "person" && who.kind !== "organization") return was;
  const node: Placed = {
    id: who.id as Placed["id"],
    kind: who.kind,
    name: who.name,
    ...(who.kind === "organization" && who.address != null ? { address: who.address } : {}),
    tier: hit.tier,
    dormant: false,
    warmth: null,
    x: 40 * (Object.keys(was.nodes).length % 10) - 180,
    y: -radiusOf(OUTERMOST),
  };
  return { ...was, nodes: { ...was.nodes, [node.id]: node } };
}

// The owner's network: read for a tier set (a new map, so what was chosen on the old one is
// dropped), with the node a search picked added, and expanded node by node (`networkExpand`). What
// came of expanding a node is shown only while that node is the one chosen.
function useNetworkGraph(focus: Hit | null) {
  const [loaded, setLoaded] = useState<Loaded<boolean>>({ state: "loading" });
  const [graph, setGraph] = useState<Graph>({ nodes: {}, edges: [] });
  const [selected, setSelected] = useState<string | null>(null);
  const [expandNote, setExpandNote] = useState<{ node: string; text: string } | null>(null);
  const focused = useRef(focus);
  focused.current = focus;
  // The returned cleanup drops an answer that comes after a newer read.
  const load = useCallback((tiers: string): (() => void) => {
    let live = true;
    setLoaded({ state: "loading" });
    setSelected(null);
    void read("network", { tiers }, true).then((answer) => {
      if (!live) return;
      if (answer.state !== "ready") return setLoaded(answer);
      const { nodes, edges, more } = answer.value;
      setGraph(withHit({ nodes: place(nodes, {}, undefined, edges), edges }, focused.current));
      setLoaded({ state: "ready", value: more });
    });
    return () => {
      live = false;
    };
  }, []);
  const pick = useCallback((hit: Hit): void => {
    setGraph((was) => withHit(was, hit));
    setSelected(hit.who.id);
  }, []);
  const expand = useCallback(async (id: string): Promise<void> => {
    const answer = await read("networkExpand", { node: id }, true);
    if (answer.state !== "ready") {
      const text = answer.state === "failed" ? refusal(answer.code) : "Rebuilding. Try again after the next build.";
      return setExpandNote({ node: id, text });
    }
    const { nodes, edges } = answer.value;
    // One line between two nodes: a pair the map already links keeps the line it has.
    setGraph((was) => {
      const known = new Set(was.edges.map(pairOf));
      const fresh = edges.filter((edge) => !known.has(pairOf(edge)));
      return { nodes: place(nodes, was.nodes, was.nodes[id]), edges: [...was.edges, ...fresh] };
    });
    setExpandNote({
      node: id,
      text: nodes.length === 0 ? "No one else is linked to them." : `${nodes.length} linked.`,
    });
  }, []);
  return { loaded, graph, selected, setSelected, expandNote, pick, load, expand };
}

// The paths from the owner to the chosen node, read when it is chosen; none for the owner. An answer
// for a node chosen before is never shown.
function usePath(selected: string | null, ownerChosen: boolean): Loaded<OwnerPaths> | null {
  const [path, setPath] = useState<{ to: string; loaded: Loaded<OwnerPaths> } | null>(null);
  useEffect(() => {
    setPath(null);
    if (selected === null || ownerChosen) return;
    let live = true;
    setPath({ to: selected, loaded: { state: "loading" } });
    void read("paths", { target: selected }, true).then((answer) => {
      if (live) setPath({ to: selected, loaded: answer });
    });
    return () => {
      live = false;
    };
  }, [selected, ownerChosen]);
  return path?.to === selected ? path.loaded : null;
}
