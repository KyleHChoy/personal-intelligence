import {
  type Cite,
  type ClientView,
  CONTEXT_CODE_POINTS,
  CONTEXT_COMMITMENTS,
  CONTEXT_DOMAINS,
  CONTEXT_EVIDENCE,
  CONTEXT_GOALS,
  CONTEXT_PASSAGE,
  CONTEXT_PEOPLE,
  CONTEXT_PERSON_LINES,
  ContextArgs,
  type ContextEvidence,
  type ContextPerson,
  type ContextView,
  compactResult,
  type EntityId,
  LIFE_DOMAINS,
  type LifeDomain,
  OPEN_BELIEF_STATUS,
  OPEN_ITEMS_SHOWN,
  type SectionDomain,
  type SectionPerson,
  type SelfSection,
  type Who,
} from "@intelligence/contracts/personal";
import { keyWords, maskedField } from "@intelligence/personal-core";
import { buildSections, DOMAIN_KEYWORDS, noticeLapsed, rankGoals, rankLines } from "@intelligence/personal-core/views";
import { byText } from "../core/db.ts";
import { agentRecordIds, type ClientGroups, type Ctx, type Found, pointsOf, type ReadSet } from "../core/read-ctx.ts";
import { parsed, type ReadTool } from "../core/read-tool.ts";
import { ownerTimeZone } from "../core/zone.ts";
import { audienceBeliefs, commitmentsOf } from "./read-beliefs.ts";
import { type CardLine, evidenceIn, linesOf, noticeCardLines, readCard } from "./read-card.ts";
import { statedFactsOf } from "./read-compiled.ts";
import { evidenceSpanOf } from "./read-evidence.ts";
import { nextAccess, readsFindings, recentFindings } from "./read-findings.ts";
import { goalRanks, listGoals } from "./read-goals.ts";
import { groupWho } from "./read-group-who.ts";
import { loadGroups } from "./read-groups.ts";
import { nextMovesOf } from "./read-next.ts";
import { openItemsOf, servedOpenItems } from "./read-open-items.ts";
import { markedLine, withStaleLeftOff } from "./read-self.ts";
import { warmthOf, warmthOrder } from "./read-warmth.ts";
import { EVENT, type MeetingRow, meetingsOf } from "./read-who.ts";

// `context`, version 1. One task-shaped read: the owner's sections the task touches, read as get_self
// reads their beliefs and built by core's buildSections; cards of the named person or organization,
// of a meeting's people, or of the people closest to the owner among those the sections name; the
// open commitments with them and the goals the owner set that share the task's words (each only with
// its own view); and the passages the served lines' first cites rest on. No new search: every part is
// a read an existing tool makes, under the caller's token, so everything comes from rows the token
// returns, and every rank, count and cut is over those rows alone (invariant 6). Every line is
// rendered by code Bounded for every client: each part by count (context.ts), the whole by
// CONTEXT_CODE_POINTS.

const withheldOf = (people: boolean, work: boolean, goals: boolean): Pick<ContextView, "withheld"> => {
  const parts = [
    ...(people ? [] : (["people", "evidence"] as const)),
    ...(work ? [] : (["commitments"] as const)),
    ...(goals ? (["goals"] as const) : []),
  ];
  return parts.length === 0 ? {} : { withheld: parts };
};

// The life domains a task's words pick, by core's pinned DOMAIN_KEYWORDS,
// most words first, then in LIFE_DOMAINS' order, at most CONTEXT_DOMAINS. Pure.
export function domainsOf(task: string): LifeDomain[] {
  const words = new Set(keyWords(task));
  return LIFE_DOMAINS.map((domain) => ({
    domain,
    hits: DOMAIN_KEYWORDS[domain].filter((word) => words.has(word)).length,
  }))
    .filter((one) => one.hits > 0)
    .sort((a, b) => b.hits - a.hits || LIFE_DOMAINS.indexOf(a.domain) - LIFE_DOMAINS.indexOf(b.domain))
    .slice(0, CONTEXT_DOMAINS)
    .map((one) => one.domain);
}

// What to read for a person or a meeting whose task's words pick no domain.
// Sections that name one of those people first, then these domains: what recency alone serves
// (the newest admin rule or bank statement) says nothing about the person across the table. Pure.
const PERSON_TASK_DOMAINS: readonly SectionDomain[] = Object.freeze(["career", "ventures", "education"]);
export function sectionsForPeople(
  built: readonly SelfSection[],
  namedIn: ReadonlyMap<SectionDomain, readonly SectionPerson[]>,
  people: ReadonlySet<string>,
): SelfSection[] {
  const named = built.filter((one) => namedIn.get(one.domain)?.some((person) => people.has(person.who.id)) === true);
  const usual = PERSON_TASK_DOMAINS.flatMap((domain) => built.filter((one) => one.domain === domain));
  return [...new Set([...named, ...usual])].slice(0, CONTEXT_DOMAINS);
}

// The people a section's beliefs name in their cites (a cite's speaker and
// every person in its fields or the belief's values), each with how many of those cites name them.
// Over the cites the token returned alone. Pure.
const isPerson = (value: unknown): value is Who =>
  typeof value === "object" &&
  value !== null &&
  (value as { kind?: unknown }).kind === "person" &&
  typeof (value as { id?: unknown }).id === "string";
export function sectionPeople(
  lines: readonly CardLine[],
  valuesOf: ReadonlyMap<string, readonly unknown[]>,
): Map<SectionDomain, SectionPerson[]> {
  const counts = new Map<SectionDomain, Map<string, { who: Who; cites: Set<string> }>>();
  for (const { section, line, cite } of lines) {
    const named = [
      ...(valuesOf.get(line.fact) ?? []),
      ...("fields" in cite ? [cite.statedBy, ...Object.values(cite.fields)] : []),
    ].filter(isPerson);
    const people = counts.get(section) ?? new Map<string, { who: Who; cites: Set<string> }>();
    for (const who of named) {
      const one = people.get(who.id) ?? { who, cites: new Set<string>() };
      one.cites.add("held" in cite ? cite.fact : cite.id);
      people.set(who.id, one);
    }
    counts.set(section, people);
  }
  return new Map(
    [...counts].map(([section, people]) => [
      section,
      [...people.values()].map((one) => ({ who: one.who, claims: one.cites.size })),
    ]),
  );
}

// The shortest task word a goal is matched by.
const GOAL_WORD = 4;

// The wire form's size (compactResult): what a client is sent.
const size = (view: ContextView): number => pointsOf(compactResult("context", view));

// The parts cut, last first, until the wire form fits CONTEXT_CODE_POINTS (about 8 000 tokens): a
// passage, a goal, a commitment, a person's last line, a section's last line, then the head lists
// (a person's next meeting's last participant, a section's last person), then a whole person, then
// a whole section. With every part gone only the domains are left, so the bound holds for every
// client. Pure; `more` set when anything went.
export function fit(view: ContextView, max: number = CONTEXT_CODE_POINTS): ContextView {
  let out = view;
  const person = (i: number, change: (one: ContextPerson) => ContextPerson) => ({
    ...out,
    people: out.people.map((one, j) => (j === i ? { ...change(one), more: true } : one)),
  });
  const section = (i: number, change: (one: SelfSection) => SelfSection) => ({
    ...out,
    sections: out.sections.map((one, j) => {
      if (j !== i) return one;
      const changed = change(one);
      const left =
        one.lines.filter((line) => line.stale === true).length -
        changed.lines.filter((line) => line.stale === true).length;
      return { ...changed, more: true, ...(left > 0 ? { staleLeftOff: (one.staleLeftOff ?? 0) + left } : {}) };
    }),
  });
  while (size(out) > max) {
    const lined = out.people.findLastIndex((one) => one.lines.length > 0);
    const sectionLined = out.sections.findLastIndex((one) => one.lines.length > 0);
    const met = out.people.findLastIndex((one) => (one.nextMeeting?.participants.length ?? 0) > 0);
    const named = out.sections.findLastIndex((one) => one.people.length > 0);
    if (out.evidence.length > 0) out = { ...out, evidence: out.evidence.slice(0, -1) };
    else if (out.goals.length > 0) out = { ...out, goals: out.goals.slice(0, -1) };
    else if (out.commitments.length > 0) out = { ...out, commitments: out.commitments.slice(0, -1) };
    else if (lined >= 0) out = person(lined, (one) => ({ ...one, lines: one.lines.slice(0, -1) }));
    else if (sectionLined >= 0) out = section(sectionLined, (one) => ({ ...one, lines: one.lines.slice(0, -1) }));
    else if (met >= 0)
      out = person(met, (one) => ({
        ...one,
        nextMeeting:
          one.nextMeeting === null
            ? null
            : { ...one.nextMeeting, participants: one.nextMeeting.participants.slice(0, -1) },
      }));
    else if (named >= 0) out = section(named, (one) => ({ ...one, people: one.people.slice(0, -1) }));
    else if (out.people.length > 0) out = { ...out, people: out.people.slice(0, -1) };
    else if (out.sections.length > 0) out = { ...out, sections: out.sections.slice(0, -1) };
    else if (out.openItems !== undefined && out.openItems.items.length > 0)
      out = { ...out, openItems: { items: out.openItems.items.slice(0, -1), more: true } };
    else if (out.next !== undefined && out.next.moves.length > 0)
      out = { ...out, next: { moves: out.next.moves.slice(0, -1), more: true } };
    else break;
    out = { ...out, more: true };
  }
  return out;
}

// `current`: the fact keys of the role and affiliation its head serves (readCard's).
type Person = {
  person: ContextPerson;
  cites: Map<string, Cite>;
  evidence: (id: string | null | undefined) => string[];
  bound: string[];
  current: string[];
};
type Passage = { item: ContextEvidence; bound: string[]; shown: string[] };

// A finding's agent record, shown by its own id.
const recordOf = (cite: Cite): string[] => ("record" in cite ? agentRecordIds(cite.record) : []);

// The read set, of what is served after the fit: each line's fact key; for a section's line, every
// cite its words, `since`, `at` and `cites` drew on, a message's or an own contact's as bound
// (`ownBound`) and a finding's record as shown (`ownShown`), since its words were served; a card's
// whole bound set for each person, the fact keys of the role and affiliation its head shows whether
// or not their lines were kept, and its lines' findings' records; each passage's; each
// commitment's; each next meeting shown by id; the goals. Pure.
export function readOf(
  value: ContextView,
  parts: {
    ownBound: ReadonlyMap<string, readonly string[]>;
    ownShown: ReadonlyMap<string, readonly string[]>;
    citeOf: ReadonlyMap<string, Cite>;
    served: readonly Person[];
    commitmentsBound: readonly string[];
    passages: readonly Passage[];
    owed?: ReadSet;
  },
): ReadSet {
  const kept = [...value.sections.flatMap((one) => one.lines), ...value.people.flatMap((one) => one.lines)];
  const sectionLines = value.sections.flatMap((one) => one.lines);
  const keptCites = value.people.flatMap((one) => one.lines).flatMap((line) => parts.citeOf.get(line.fact) ?? []);
  const passages = parts.passages.slice(0, value.evidence.length);
  const keptPeople = parts.served.filter((one) => value.people.some((person) => person.who.id === one.person.who.id));
  return {
    bound: [
      ...new Set([
        ...sectionLines.flatMap((line) => parts.ownBound.get(line.fact) ?? []),
        ...keptPeople.flatMap((one) => one.bound),
        ...parts.commitmentsBound,
        ...(parts.owed?.bound ?? []),
        ...passages.flatMap((one) => one.bound),
      ]),
    ],
    shown: [
      ...new Set([
        ...sectionLines.flatMap((line) => parts.ownShown.get(line.fact) ?? []),
        ...(parts.owed?.shown ?? []),
        ...keptCites.flatMap(recordOf),
        ...keptPeople.flatMap((one) => [
          ...one.evidence(one.person.nextMeeting?.id),
          ...one.evidence(one.person.nextStep?.message),
        ]),
        ...passages.flatMap((one) => one.shown),
      ]),
    ],
    factKeyFps: [
      ...new Set([
        ...kept.map((line) => line.fact),
        ...keptPeople.flatMap((one) => one.current),
        ...value.commitments.map((one) => one.belief.fact),
        ...(parts.owed?.factKeyFps ?? []),
      ]),
    ],
    goals: [...new Set([...value.goals.map((goal) => goal.id as string), ...(parts.owed?.goals ?? [])])].sort(byText),
  };
}

// A person's card as context serves it: its head, its first CONTEXT_PERSON_LINES lines and what
// they cite. A project is not a person; null for an id the caller cannot see.
async function personCardOf(ctx: Ctx, groups: ClientGroups | undefined, client: ClientView, id: string, now: Date) {
  const card = await readCard(ctx, { id: id as EntityId }, now, client.views);
  if (card === null) return null;
  const view = card.found.value;
  if (view.kind === "project") return "project" as const;
  const [who] = (await groupWho(ctx, groups!, [view.id])).values();
  if (who === undefined) return null;
  const lines = card.lines.slice(0, CONTEXT_PERSON_LINES);
  const person: Person = {
    person: {
      who,
      ...(view.current === undefined ? {} : { current: view.current }),
      ...(view.warmth === undefined ? {} : { warmth: view.warmth }),
      lastAt: view.mail.lastAt,
      nextMeeting: view.nextMeeting,
      ...(view.lead?.nextStep === undefined ? {} : { nextStep: view.lead.nextStep }),
      lines: lines.map((one) => one.line),
      more: view.more === true || lines.length < card.lines.length,
    },
    cites: new Map(lines.map((one) => [one.line.fact, one.cite])),
    evidence: evidenceIn(card.evidenceOf),
    bound: card.found.read.bound,
    current: [...card.current, ...(view.lead?.nextStep?.fact === undefined ? [] : [view.lead.nextStep.fact])],
  };
  return person;
}

// The owner's open beliefs, as get_self reads them, each a line from its first cite, a lapsed notice
// left out (it says nothing of today) and marked as get_self marks them, so a reader of either can
// tell a line gone stale; then the sections of the domains picked, or, for a named person or a
// meeting's people (`subjects`) when the task's words pick no domain, the sections for them, or the
// most recently active ones. A system notice's line names its sender and subject line, as
// get_self's does, read for the chosen sections' lines only, after the cut.
async function sectionsOf(ctx: Ctx, args: ContextArgs, now: Date, subjects: readonly string[]) {
  const domains = args.domain === undefined ? domainsOf(args.task) : [args.domain];
  const read = await audienceBeliefs(ctx);
  const stated = await statedFactsOf(ctx, read);
  const open = stated.facts.beliefs.filter((one) => OPEN_BELIEF_STATUS.has(one.status));
  const lines = linesOf(open)
    .filter((one) => !noticeLapsed(one.line, now))
    .map((one) => ({ ...one, line: markedLine(one.line, now) }));
  const valuesOf = new Map(open.map((one) => [one.fact, Object.values(one.values)]));
  const cardLineOf = new Map(lines.map((one) => [one.line, one]));
  const shown = lines.map((one) => one.line);
  const ranked = rankLines(shown, new Map(), now).map((line) => cardLineOf.get(line) as CardLine);
  const namedIn = sectionPeople(lines, valuesOf);
  const built = withStaleLeftOff(buildSections({ lines: ranked, people: namedIn, now }), lines);
  const forPeople = domains.length === 0 && subjects.length > 0 ? new Set(subjects) : undefined;
  const chosen = (
    forPeople !== undefined
      ? sectionsForPeople(built, namedIn, forPeople)
      : domains.length === 0
        ? built
        : built.filter((one) => (domains as SectionDomain[]).includes(one.domain))
  ).slice(0, CONTEXT_DOMAINS);
  const noticed = await noticeCardLines(
    ctx,
    chosen.flatMap((one) => one.lines.map((line) => cardLineOf.get(line) as CardLine)),
  );
  let next = 0;
  const sections = chosen.map((one) => ({
    ...one,
    lines: noticed.slice(next, (next += one.lines.length)).map((card) => card.line),
  }));
  return { domains, read, stated, open, lines, built, forPeople, sections };
}

// The people past the named one: the meeting's, else those the sections name, by tier, then warmth
// (the caller's audience's rows), then by id, each added to `served` until it holds CONTEXT_PEOPLE.
// True when some were left out.
type Nearby = { client: ClientView; now: Date; served: Person[]; candidates: readonly Who[] };
async function morePeople(ctx: Ctx, groups: ClientGroups | undefined, at: Nearby): Promise<boolean> {
  const served = at.served;
  const candidates = [...new Set(at.candidates.map((one) => one.id))].filter(
    (id) => !served.some((one) => one.person.who.id === id),
  );
  const warmth = await warmthOf(ctx, groups!, candidates);
  const order = candidates.sort((a, b) => warmthOrder(warmth.get(b)) - warmthOrder(warmth.get(a)) || byText(a, b));
  for (const id of order) {
    if (served.length >= CONTEXT_PEOPLE) return true;
    const card = await personCardOf(ctx, groups, at.client, id, at.now);
    if (card !== null && card !== "project") served.push(card);
  }
  return false;
}

// The passages the served lines' first cites rest on: a message's or an agent record's, in the
// lines' order, at most CONTEXT_EVIDENCE, each cut at CONTEXT_PASSAGE code points, with the masked
// values the passage served holds.
async function passagesOf(ctx: Ctx, servedLines: readonly { fact: string }[], citeOf: ReadonlyMap<string, Cite>) {
  const evidence: Passage[] = [];
  for (const line of servedLines) {
    if (evidence.length >= CONTEXT_EVIDENCE) break;
    const cite = citeOf.get(line.fact);
    if (cite === undefined || !("fields" in cite) || (cite.message === null && cite.record === undefined)) continue;
    const spanned = await evidenceSpanOf(ctx, { fact: cite.id });
    if (spanned === null) continue;
    const span = spanned.found;
    if (span.value.passage === null) continue;
    const points = Array.from(span.value.passage.untrusted);
    const served = points.slice(0, CONTEXT_PASSAGE);
    evidence.push({
      item: {
        fact: line.fact,
        claim: span.value.fact,
        source: span.value.source,
        passage: { untrusted: served.join("") },
        cut: span.value.cut || points.length > CONTEXT_PASSAGE,
        ...maskedField(spanned.maskedWithin(served.length)),
      },
      bound: span.read.bound,
      shown: span.read.shown,
    });
  }
  return evidence;
}

// The rows a call served: every line, person, commitment, goal and passage, the open items kept and
// the next moves.
const rowsOf = (value: ContextView, openItems: number): number =>
  [...value.sections, ...value.people].reduce((sum, one) => sum + one.lines.length, 0) +
  value.people.length +
  value.commitments.length +
  value.goals.length +
  value.evidence.length +
  openItems +
  (value.next?.moves.length ?? 0);

async function contextOf(
  ctx: Ctx,
  client: ClientView,
  args: ContextArgs,
  now: Date,
): Promise<Found<ContextView> | "invalid_request" | null> {
  const people = client.views.includes("people");
  const work = client.views.includes("work");
  const groups = people ? await loadGroups(ctx) : undefined;

  // The named person or organization and the meeting first: an id the caller cannot see answers
  // not_found before anything else is read. Each needs the people view; without it, left out.
  const named =
    people && args.entity !== undefined ? await personCardOf(ctx, groups, client, args.entity, now) : undefined;
  if (named === null) return null;
  if (named === "project") return "invalid_request";
  let attendees: Who[] = [];
  if (people && args.event !== undefined) {
    const [row] = await ctx.run<MeetingRow>(EVENT, [args.event]);
    const meeting = row === undefined ? undefined : (await meetingsOf(ctx, [row], groups)).get(row.id);
    if (meeting === undefined) return null;
    attendees = meeting.participants.filter((one) => one.kind === "person" || one.kind === "organization");
  }

  // An organization is named in no section, so it reads as a task with neither.
  const members = [...attendees, ...(named === undefined ? [] : [named.person.who])].flatMap((one) =>
    one.kind === "person" ? groups!.membersOf(one.id) : [],
  );
  const { domains, read, stated, open, lines, built, forPeople, sections } = await sectionsOf(ctx, args, now, members);
  const ownCites = new Map(lines.map((one) => [one.line.fact, one.cite]));

  const served: Person[] = named === undefined ? [] : [named];
  const candidates =
    args.event !== undefined
      ? attendees
      : args.entity !== undefined
        ? []
        : sections.flatMap((one) => one.people.map((person) => person.who));
  const peopleCut = people && (await morePeople(ctx, groups, { client, now, served, candidates }));

  // With the work view alone, whether or not people are served:
  // the open commitments with the people served or named in the chosen domains' sections (a
  // commitment has no domain of its own), and the goals the owner set that share a word with the task (of
  // four letters or more, so "for" or "the" matches nothing) or with its domains' pinned words.
  const others = [
    ...new Set([
      ...served.map((one) => one.person.who.id),
      ...sections.flatMap((one) => one.people.map((person) => person.who.id)),
    ]),
  ];
  const withIds = [...new Set(others.flatMap((id) => groups?.membersOf(id) ?? [id]))];
  const asked = { with: withIds, state: "open" as const, limit: CONTEXT_COMMITMENTS, lapseAt: now };
  const commitments = work && others.length > 0 ? await commitmentsOf(ctx, asked, read) : undefined;
  const words = new Set([
    ...keyWords(args.task).filter((word) => Array.from(word).length >= GOAL_WORD),
    ...(forPeople === undefined ? domains : sections.map((one) => one.domain)).flatMap((one) =>
      one === "unsorted" ? [] : DOMAIN_KEYWORDS[one],
    ),
  ]);
  const goalsRead = work ? await listGoals(ctx, { status: "active" }, now, "set") : undefined;
  const listed = goalsRead?.value.goals ?? [];
  const rankedGoals = rankGoals(listed, await goalRanks(ctx, listed));
  const matching = rankedGoals.filter((goal) => keyWords(goal.statement.untrusted).some((word) => words.has(word)));

  // The passages need the people view, which get_evidence_span needs.
  const citeOf = new Map([...ownCites, ...served.flatMap((one) => [...one.cites])]);
  const servedLines = people
    ? [...sections.flatMap((one) => one.lines), ...served.flatMap((one) => one.person.lines)]
    : [];
  const evidence = await passagesOf(ctx, servedLines, citeOf);

  // First, what the owner owes and what is overdue, from this call's reading of beliefs; then,
  // first of all the next moves, whatever the task's words picked.
  const owing = await openItemsOf(ctx, client.views, now, read);
  const owed = servedOpenItems(owing, OPEN_ITEMS_SHOWN);
  const nextRead = await nextMovesOf(ctx, now, {
    ...nextAccess(client.views, client.tools),
    open: owing,
    findings: readsFindings(client.views, client.tools) ? await recentFindings(ctx, now) : [],
    zone: await ownerTimeZone(ctx),
    marks: true,
  });
  const value = fit({
    next: nextRead.value,
    openItems: owed.value,
    domains,
    sections,
    people: served.map((one) => one.person),
    commitments: commitments?.commitments ?? [],
    goals: matching.slice(0, CONTEXT_GOALS),
    evidence: evidence.map((one) => one.item),
    more:
      stated.facts.more ||
      (domains.length === 0 && built.length > sections.length) ||
      sections.some((one) => one.more) ||
      peopleCut ||
      served.some((one) => one.person.more) ||
      commitments?.more === true ||
      matching.length > CONTEXT_GOALS,
    // What the registration leaves out, from the registration alone: never from what the owner has.
    ...withheldOf(people, work, goalsRead?.withheld !== false),
  });

  // What `fit` kept, which is what the read log and the rows count.
  const kept = servedOpenItems({ ...owing, items: value.openItems?.items ?? [] }, OPEN_ITEMS_SHOWN);
  const keptNext = nextRead.readOf(value.next?.moves ?? []);
  return {
    value,
    rows: rowsOf(value, kept.rows),
    read: readOf(value, {
      ownBound: stated.boundOf,
      ownShown: new Map(open.map((one) => [one.fact, one.cites.flatMap(recordOf)])),
      citeOf,
      served,
      commitmentsBound: commitments?.read.bound ?? [],
      passages: evidence,
      owed: {
        bound: [
          ...kept.read.bound,
          ...keptNext.bound,
          // A goal's step that stands on a stated line outside the sections chosen.
          ...keptNext.factKeyFps.flatMap((fact) => stated.boundOf.get(fact) ?? []),
        ],
        shown: [...kept.read.shown, ...keptNext.shown],
        factKeyFps: [...kept.read.factKeyFps, ...keptNext.factKeyFps],
        goals: keptNext.goals ?? [],
      },
    }),
  };
}

// The owner's sections, cards, open work and evidence a task touches, view `self`: a list tool.
// Each part beyond the sections needs its own view, and one the client lacks is left out.
export const CONTEXT_TOOL: ReadTool<ContextArgs, ContextView> = {
  tool: "context",
  parse: (args) => parsed(ContextArgs.safeParse(args)),
  work: (ctx, valid, client, env) => contextOf(ctx, client, valid, env.now()),
};
