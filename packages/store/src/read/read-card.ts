import {
  type BeliefLine,
  type Cite,
  type CompiledBelief,
  compactResult,
  ENTITY_LINES,
  type EntityView,
  GetEntityArgs,
  LIFE_DOMAINS,
  type MeetingView,
  type PersonalView,
  type SectionDomain,
} from "@intelligence/contracts/personal";
import {
  collapseByGroup,
  currentOf,
  isLowUse,
  noticeCite,
  rankLines,
  renderLine,
  sectionOf,
} from "@intelligence/personal-core/views";
import { type Ctx, type Found, pointsOf } from "../core/read-ctx.ts";
import { parsed, type ReadTool } from "../core/read-tool.ts";
import { noticeLines } from "./read-self.ts";
import { entityOf } from "./read-tools-entity.ts";

// get_entity's card. A person's or an organization's head as entityOf reads it (names, addresses,
// organization, mail, last and next meeting, current role and affiliation, tie strength, knownVia),
// then its beliefs as lines, rendered by core's renderLine from each belief's one cite, at most
// ENTITY_LINES, `more` when cut. Every line is of a row the caller's token returned: nothing is
// read here that entityOf did not read under the same token. A project keeps its compiled facts.

// A line's words, at most this many code points: a long phrase is cut, never inside a character
// outside the basic plane, so a card is bounded however long a source's phrase is. The whole
// phrase is find_facts'.
export const LINE_CODE_POINTS = 240;

export function boundLine(line: BeliefLine): BeliefLine {
  const points = Array.from(line.line.untrusted);
  return points.length <= LINE_CODE_POINTS
    ? line
    : { ...line, line: { untrusted: points.slice(0, LINE_CODE_POINTS).join("") } };
}

// One belief as a line, with the section it goes in and the cite it was rendered from.
// `notice`, on a notice line only: the cite it names (noticeCite).
export type CardLine = { section: SectionDomain; line: BeliefLine; cite: Cite; notice?: Cite };

export function linesOf(beliefs: readonly CompiledBelief[]): CardLine[] {
  return collapseByGroup(beliefs).flatMap((belief): CardLine[] => {
    const [cite] = belief.cites;
    if (cite === undefined) return [];
    const line = boundLine(renderLine(belief, cite));
    const notice = line.notice === undefined ? undefined : noticeCite(belief);
    return [{ section: sectionOf(belief), line, cite, ...(notice === undefined ? {} : { notice }) }];
  });
}

// Each line of the `system_notice` tier with its notice's sender and subject line,
// read under the caller's token from its notice cite (read-self's noticeLines), for `context`, over
// the lines it serves only. get_entity needs none: a notice is about the owner, whose card it never
// serves.
export async function noticeCardLines(ctx: Ctx, lines: readonly CardLine[]): Promise<CardLine[]> {
  const citeOf = new Map(lines.map((one) => [one.line, one.notice]));
  const noticed = await noticeLines(
    ctx,
    lines.map((one) => one.line),
    (line) => citeOf.get(line),
  );
  return lines.map((one, index) => ({ ...one, line: noticed[index] as BeliefLine }));
}

const domainOrder = (domain: SectionDomain): number =>
  domain === "unsorted" ? LIFE_DOMAINS.length : LIFE_DOMAINS.indexOf(domain);

export function bySection(lines: readonly CardLine[], tie: ReadonlyMap<string, number> = new Map()): CardLine[] {
  const sections = new Map<SectionDomain, CardLine[]>();
  for (const one of lines) sections.set(one.section, [...(sections.get(one.section) ?? []), one]);
  const ranked = [...sections].map(([section, members]) => {
    const order = rankLines(
      members.map((one) => one.line),
      tie,
    );
    const sorted = order.map((line) => members.find((one) => one.line === line) as CardLine);
    return {
      section,
      sorted,
      newest: members
        .map((one) => one.line.at)
        .sort()
        .at(-1) as string,
    };
  });
  ranked.sort(
    (a, b) =>
      Number(a.section === "unsorted") - Number(b.section === "unsorted") ||
      (a.newest < b.newest ? 1 : a.newest > b.newest ? -1 : 0) ||
      domainOrder(a.section) - domainOrder(b.section),
  );
  return ranked.flatMap((one) => one.sorted);
}

// First the head's beliefs, kept past any cut: the current role and affiliation and a relationship
// to the owner; then the rest by section; then, by section, what is too thin to lead (one- and
// two-word objects, ended commitments), which go first when a card is cut and stay reachable
// through find_facts. At most `max`; `more` when the beliefs read were cut already or are cut here.
// `pinned` is how many lines lead.
export function cardLines(
  beliefs: readonly CompiledBelief[],
  more: boolean,
  max: number = ENTITY_LINES,
): { lines: CardLine[]; more: boolean; pinned: number } {
  const current = currentOf(beliefs);
  const head = [
    current.role?.fact,
    current.affiliation?.fact,
    ...beliefs
      .filter((one) => one.kind === "relationship" && one.values.counterparty.kind === "owner")
      .map((one) => one.fact),
  ];
  const all = linesOf(beliefs);
  const pinned = [...new Set(head.flatMap((fact) => all.filter((one) => one.line.fact === fact)))];
  const useful: CardLine[] = [];
  const low: CardLine[] = [];
  for (const one of all) if (!pinned.includes(one)) (isLowUse(one.line) ? low : useful).push(one);
  const rest = [...bySection(useful), ...bySection(low)];
  const lines = [...pinned, ...rest].slice(0, max);
  return { lines, more: more || lines.length < all.length, pinned: Math.min(pinned.length, max) };
}

// The head's names, addresses, people and meeting participants are cut to HEAD_LIST first, a
// meeting's as the packs cut it. Past the bound, the last lines go, then the head's lists one entry
// at a time (the longest first), then the leading lines, then the head's parts whole, until it
// fits, and `more` is set. Over the card's own rows alone. The bound holds however many names,
// addresses, people or participants the sources gave.
export const CARD_CODE_POINTS = 12_000;
export const HEAD_LIST = 25;
const wireSize = (view: EntityView): number => pointsOf(compactResult("get_entity", view));

type Head = Omit<EntityView, "lines" | "more" | "facts">;
const cutMeeting = (meeting: MeetingView | null, end: number): MeetingView | null =>
  meeting === null ? null : { ...meeting, participants: meeting.participants.slice(0, end) };

// Each head list's length, and the head with that list one shorter.
const headLists = (head: Head): [number, () => Head][] => [
  [head.names.length, () => ({ ...head, names: head.names.slice(0, -1) })],
  [head.addresses.length, () => ({ ...head, addresses: head.addresses.slice(0, -1) })],
  [head.people.length, () => ({ ...head, people: head.people.slice(0, -1) })],
  [head.details.length, () => ({ ...head, details: head.details.slice(0, -1) })],
  // A person's links and the owner's words about them, the last first.
  [head.links?.length ?? 0, () => ({ ...head, links: head.links?.slice(0, -1) ?? [] })],
  [head.ownerWords?.length ?? 0, () => ({ ...head, ownerWords: head.ownerWords?.slice(0, -1) ?? [] })],
  [head.lastMeeting?.participants.length ?? 0, () => ({ ...head, lastMeeting: cutMeeting(head.lastMeeting, -1) })],
  [head.nextMeeting?.participants.length ?? 0, () => ({ ...head, nextMeeting: cutMeeting(head.nextMeeting, -1) })],
  [
    head.knownVia?.coRecipients.length ?? 0,
    () =>
      head.knownVia === undefined
        ? head
        : { ...head, knownVia: { ...head.knownVia, coRecipients: head.knownVia.coRecipients.slice(0, -1) } },
  ],
];

// What a card keeps of a person's links and of the owner's words (their keys and values' code
// points) before it drops a belief line; past these, they are cut last.
export const LINKS_FLOOR = 5;
export const OWNER_WORDS_FLOOR = 1_500;
const wordPoints = (words: EntityView["ownerWords"]): number =>
  (words ?? []).reduce(
    (sum, one) =>
      sum + Array.from(one.value.untrusted).length + (one.key === null ? 0 : Array.from(one.key.untrusted).length),
    0,
  );

// The owner's words one step nearer the floor: the last entry dropped when the others reach it,
// else its value cut so the whole fits it (so one long note never takes every other word with
// it), and dropped only when not one code point of it fits.
function toFloor(words: NonNullable<EntityView["ownerWords"]>): NonNullable<EntityView["ownerWords"]> {
  const last = words.at(-1);
  if (last === undefined) return words;
  const rest = words.slice(0, -1);
  const room = OWNER_WORDS_FLOOR - wordPoints(rest) - (last.key === null ? 0 : Array.from(last.key.untrusted).length);
  const value = Array.from(last.value.untrusted);
  if (room <= 0) return rest;
  if (room >= value.length) return words;
  return [...rest, { ...last, value: { untrusted: value.slice(0, room).join("") }, cut: true }];
}

// The head with its next part left out whole, or undefined when none is left.
function headPart(head: Head): Head | undefined {
  const { knownVia, warmth, current, ...bare } = head;
  const keep = (parts: Partial<Head>): Head => ({ ...bare, ...parts });
  if (knownVia !== undefined)
    return keep({ ...(warmth === undefined ? {} : { warmth }), ...(current === undefined ? {} : { current }) });
  if (head.lastMeeting !== null) return { ...head, lastMeeting: null };
  if (head.nextMeeting !== null) return { ...head, nextMeeting: null };
  if (warmth !== undefined) return keep(current === undefined ? {} : { current });
  if (current !== undefined) return bare;
  if (head.organization !== null) return { ...head, organization: null };
  return undefined;
}

export function fitCard(
  head: Head,
  card: { lines: CardLine[]; more: boolean; pinned: number },
  max: number = CARD_CODE_POINTS,
): { view: EntityView; lines: CardLine[] } {
  let { lines, more } = card;
  let top: Head = {
    ...head,
    names: head.names.slice(0, HEAD_LIST),
    addresses: head.addresses.slice(0, HEAD_LIST),
    people: head.people.slice(0, HEAD_LIST),
    lastMeeting: cutMeeting(head.lastMeeting, HEAD_LIST),
    nextMeeting: cutMeeting(head.nextMeeting, HEAD_LIST),
  };
  const viewOf = (): EntityView => ({ ...top, lines: lines.map((one) => one.line), more });
  while (wireSize(viewOf()) > max) {
    const [longest, shorter] = headLists(top).reduce((a, b) => (b[0] > a[0] ? b : a));
    // The owner's words, then the links, are cut to their floors before any belief line goes,
    // so long notes never push the person's beliefs out.
    if (wordPoints(top.ownerWords) > OWNER_WORDS_FLOOR) top = { ...top, ownerWords: toFloor(top.ownerWords ?? []) };
    else if ((top.links?.length ?? 0) > LINKS_FLOOR) top = { ...top, links: top.links?.slice(0, -1) ?? [] };
    else if (lines.length > card.pinned) lines = lines.slice(0, -1);
    else if (longest > 0) top = shorter();
    else if (lines.length > 0) lines = lines.slice(0, -1);
    else {
      const less = headPart(top);
      if (less === undefined) break;
      top = less;
    }
    more = true;
  }
  return { view: viewOf(), lines };
}

// The evidence id of a message or a meeting by its id, as a read's evidenceOf maps it.
export const evidenceIn =
  (evidenceOf: ReadonlyMap<string, string>) =>
  (id: string | null | undefined): string[] =>
    id === null || id === undefined ? [] : [evidenceOf.get(id) ?? []].flat();

// A card, with its lines' cites, the fact keys of the current role and affiliation its head serves
// (`current`), and the evidence id of each message and meeting it read, for a caller that serves
// part of it (`context`). A project's has no lines.
export type Card = {
  found: Found<EntityView>;
  lines: CardLine[];
  current: string[];
  evidenceOf: ReadonlyMap<string, string>;
};

// The read set is entityOf's, narrowed to what the card serves: the fact keys of its lines, and no
// message bound only by a claim in no belief, which the card leaves out. Its statements are
// entityOf's, so a card sends no statement entityOf does not.
export async function readCard(
  ctx: Ctx,
  args: GetEntityArgs,
  now: Date,
  views: readonly PersonalView[],
  tools: readonly string[] = [],
): Promise<Card | null> {
  const found = await entityOf(ctx, args, now, { brief: false, views, card: true, tools });
  if (found === null) return null;
  const { evidenceOf, members: _members, ...rest } = found;
  if (rest.value.kind === "project") return { found: rest, lines: [], current: [], evidenceOf };
  const { facts, ...head } = rest.value;
  const { view, lines } = fitCard(head, cardLines(facts.beliefs, facts.more));
  // The head's role and affiliation are served beside the lines, whether or not their lines are.
  const picked = currentOf(facts.beliefs);
  // So are the lead's, which no cut leaves out.
  const current =
    view.current === undefined && view.lead === undefined
      ? []
      : [picked.role?.fact, picked.affiliation?.fact].filter((fact): fact is string => fact !== undefined);
  const served = new Set([...lines.map((one) => one.line.fact), ...current]);
  const evidence = evidenceIn(evidenceOf);
  const cited = new Set(lines.flatMap((one) => ("message" in one.cite ? evidence(one.cite.message) : [])));
  const unserved = new Set(facts.claims.flatMap((claim) => evidence(claim.message)).filter((one) => !cited.has(one)));
  return {
    found: {
      ...rest,
      value: view,
      read: {
        ...rest.read,
        bound: rest.read.bound.filter((one) => !unserved.has(one)),
        factKeyFps: rest.read.factKeyFps.filter((one) => served.has(one)),
      },
    },
    lines,
    current,
    evidenceOf,
  };
}

// get_entity: the card, or a project's page.
export async function getCard(
  ctx: Ctx,
  args: GetEntityArgs,
  now: Date,
  views: readonly PersonalView[],
  tools: readonly string[] = [],
): Promise<Found<EntityView> | null> {
  return (await readCard(ctx, args, now, views, tools))?.found ?? null;
}

export const GET_ENTITY_TOOL: ReadTool<GetEntityArgs, EntityView> = {
  tool: "get_entity",
  parse: (args) => parsed(GetEntityArgs.safeParse(args)),
  work: (ctx, valid, client, env) => getCard(ctx, valid, env.now(), client.views, client.tools),
};
