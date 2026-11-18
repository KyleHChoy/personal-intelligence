import type { Belief } from "@intelligence/contracts";
import {
  type BeliefLine,
  type Cite,
  type CompiledBelief,
  dayIn,
  type LifeDomain,
  type LineNotice,
  type MeetingView,
  OPEN_BELIEF_STATUS,
  SELF_HOUSEKEEPING_LINES,
  SELF_SECTION_PEOPLE,
  type SectionDomain,
  type SectionPerson,
  type SelfChange,
  type SelfHousekeeping,
  type SelfSection,
  type UntrustedString,
  type Who,
} from "@intelligence/contracts/personal";
import { datedTitle } from "@intelligence/personal-core";
import {
  buildSections,
  collapseByGroup,
  isAdminNotice,
  isApplicationLine,
  isStale,
  isThin,
  noticeCite,
  noticeLapsed,
  pastOnOf,
  rankLines,
  renderLine,
  sectionOf,
} from "@intelligence/personal-core/views";
import { byText } from "../core/db.ts";
import { agentRecordIds, type Ctx, type ReadSet } from "../core/read-ctx.ts";
import type { Sealed } from "../core/seal.ts";
import { servedOrNone } from "../core/served.ts";
import { NAMES_SHOWN } from "../core/visibility.ts";
import { type AudienceBeliefs, WITHHELD } from "./read-beliefs.ts";
import { statedFactsOf } from "./read-compiled.ts";
import { groupWho } from "./read-group-who.ts";
import { loadGroups } from "./read-groups.ts";

// The owner's beliefs the caller's audience holds, open ones (every one with `history`), compiled under the caller's token as `stated` compiled them, each rendered as one
// line by core's renderLine from its first cite, collapsed by group, ranked and cut into one section per life domain. Per section, the people named in its beliefs'
// supporting claims, counted over the rows the token returns. Every count, order and cut is over those rows alone (invariant 6); no model wrote a word of a line.

// The people the supporting claims `$1` name, as the token returns them: a claim whose message the
// token returns and is not held (a held message's words name no one to the caller, and a finding's
// or a contact's claim names no one here), that names no person or organization the token does not
// show (find_facts' rule), and an entity that is a person the token shows.
const NAMED = `
  select p.claim_id, p.entity_id
  from knowledge.claim_entities p
  join knowledge.claims c on c.id = p.claim_id
  join knowledge.messages m on m.evidence_id = c.evidence_id
  where p.claim_id = any($1)
    and not m.held
    and (select e.kind from knowledge.entities e where e.id = p.entity_id) = 'person'
    and ${NAMES_SHOWN}
  order by p.claim_id, p.entity_id, c.id, m.id`;

export type Named = { claim_id: string; entity_id: string };
type Counted = { id: string; claims: number };

// A stored belief's section, before it is compiled: sectionOf reads only its kind and its typed
// values' domain and relation, which a stored belief holds as a compiled one does.
const storedSection = (belief: Belief): SectionDomain =>
  sectionOf({ kind: belief.kind, values: belief.values } as unknown as CompiledBelief);

// Per section, the people its claims name, by the id of each one's group (`idOf`), with the count
// of distinct claims naming them; most claims first, then by id, as buildSections orders them. A
// claim supporting beliefs in several sections counts in each. A withheld person is left out.
export function countPeople(
  named: readonly Named[],
  sectionsOfClaim: ReadonlyMap<string, ReadonlySet<SectionDomain>>,
  withheld: ReadonlySet<string>,
  idOf: (id: string) => string,
): Map<SectionDomain, Counted[]> {
  const claims = new Map<SectionDomain, Map<string, Set<string>>>();
  for (const row of named) {
    if (withheld.has(row.entity_id)) continue;
    const id = idOf(row.entity_id);
    for (const section of sectionsOfClaim.get(row.claim_id) ?? []) {
      const inSection = claims.get(section) ?? new Map<string, Set<string>>();
      inSection.set(id, (inSection.get(id) ?? new Set<string>()).add(row.claim_id));
      claims.set(section, inSection);
    }
  }
  return new Map(
    [...claims].map(([section, people]) => [
      section,
      [...people]
        .map(([id, ids]) => ({ id, claims: ids.size }))
        .sort((a, b) => b.claims - a.claims || byText(a.id, b.id)),
    ]),
  );
}

// Per section, the first people of `counted` that `lookup` names, one more than a section shows,
// so its `more` is known after a person the token cannot name is left out. Each round asks only for
// the people each section may still serve, so a page whose people are all named asks once.
export async function knownPeople(
  counted: ReadonlyMap<SectionDomain, readonly Counted[]>,
  lookup: (ids: string[]) => Promise<ReadonlyMap<string, Who>>,
): Promise<Map<SectionDomain, SectionPerson[]>> {
  const who = new Map<string, Who>();
  const asked = new Set<string>();
  for (;;) {
    const picked = [...counted].map(
      ([section, list]) =>
        [
          section,
          list.filter((one) => !asked.has(one.id) || who.has(one.id)).slice(0, SELF_SECTION_PEOPLE + 1),
        ] as const,
    );
    const ask = [...new Set(picked.flatMap(([, list]) => list.map((one) => one.id)))].filter((id) => !asked.has(id));
    if (ask.length === 0)
      return new Map(
        picked.map(([section, list]) => [
          section,
          list.map((one) => ({ who: who.get(one.id) as Who, claims: one.claims })),
        ]),
      );
    for (const [id, one] of await lookup(ask)) who.set(id, one);
    for (const id of ask) asked.add(id);
  }
}

// Without `domain`, the page's lines take at most this many code points of their JSON: enough for
// ten plain lines in each of thirteen sections, which a count of lines that assumed every line the
// longest left at three. Long lines fill it sooner, and each section keeps its best: one round takes
// each section's next line, in the sections' order, until the page is full. A cut section says
// `more`, and get_self with its `domain` serves it whole. A whole page can pass the reasoner's 40 000
// code points a result, and its fit (fit.ts) cuts the lines ranked last; an agent is sent it whole
// (self-sizes.test.ts).
export const SELF_PAGE_CODE_POINTS = 40_000;
// With `domain`, at most this many lines in all (D20's ten of each kind would allow a
// hundred), the best first; and a line's text at most SELF_LINE_CODE_POINTS code points, a longer
// one cut and ended with TEXT_CUT, since a phrase is a source's words and has no length of its own
// (find_facts' `belief` serves it whole). So one domain fits the reasoner's 40 000 code points a
// result on the worst-case profile.
export const SELF_DOMAIN_LINES = 50;
export const SELF_LINE_CODE_POINTS = 120;
export const TEXT_CUT = "…";

// `text`, at most `max` code points: a longer one keeps its first `max` less one and TEXT_CUT.
export function capText(text: string, max: number = SELF_LINE_CODE_POINTS): string {
  const points = [...text];
  return points.length <= max ? text : `${points.slice(0, max - 1).join("")}${TEXT_CUT}`;
}

// get_self's head is bounded as its lines are. A meeting's title and a change's
// words are cut as a line's (capText), and a meeting names at most SELF_PARTICIPANTS people (the
// owner is never one), in the order served; meeting_prep serves a meeting's people whole.
export const SELF_PARTICIPANTS = 4;
// A title's relative word reads as the date it stands for (`datedTitle`).
export function boundHead<Head extends { upcoming: MeetingView[]; changes: SelfChange[]; timeZone: string | null }>(
  head: Head,
): Head {
  const dayOfMeeting = (meeting: MeetingView): string | null =>
    meeting.date ?? (meeting.startsAt === null ? null : dayIn(new Date(meeting.startsAt), head.timeZone));
  return {
    ...head,
    upcoming: head.upcoming.map((meeting) => {
      const day = dayOfMeeting(meeting);
      return {
        ...meeting,
        title:
          meeting.title === null
            ? null
            : {
                untrusted: capText(day === null ? meeting.title.untrusted : datedTitle(meeting.title.untrusted, day)),
              },
        participants: meeting.participants.slice(0, SELF_PARTICIPANTS),
      };
    }),
    changes: head.changes.map((change) =>
      change.what === null ? change : { ...change, what: { untrusted: capText(change.what.untrusted) } },
    ),
  };
}

const capLine = (line: BeliefLine): BeliefLine => ({ ...line, line: { untrusted: capText(line.line.untrusted) } });

// What a line costs of the page, its JSON and a separator, over the line alone.
const costOf = (line: BeliefLine): number => [...JSON.stringify(line)].length + 1;
// A system notice's line carries its sender and subject line as well as its words, so it counts as
// this many rows.
const NOTICE_LINE_COST = 3;

// Each section's best lines, one round taking each section's next line in the sections' order,
// until `budget` is spent; a section whose next line costs more than is left stops.
export function fitPage(
  sections: readonly SelfSection[],
  budget: number = SELF_PAGE_CODE_POINTS,
  cost: (line: BeliefLine) => number = costOf,
  firstLineAlways = false,
): SelfSection[] {
  const kept = sections.map(() => 0);
  let left = budget;
  for (
    let round = 0;
    (left > 0 || (firstLineAlways && round === 0)) &&
    sections.some((section, index) => kept[index] === round && round < section.lines.length);
    round += 1
  ) {
    sections.forEach((section, index) => {
      const line = section.lines[round];
      if (line !== undefined && kept[index] === round && (cost(line) <= left || (firstLineAlways && round === 0))) {
        kept[index] = round + 1;
        left -= cost(line);
      }
    });
  }
  return sections.map((section, index) => {
    const count = kept[index] as number;
    return count === section.lines.length ? section : { ...section, lines: section.lines.slice(0, count), more: true };
  });
}

const fitDomain = (section: SelfSection): SelfSection =>
  section.lines.length <= SELF_DOMAIN_LINES
    ? section
    : { ...section, lines: section.lines.slice(0, SELF_DOMAIN_LINES), more: true };

// Undefined when none is current.
function housekeepingOf(
  notices: readonly BeliefLine[],
  now: Date,
  history: boolean,
  cut: boolean,
): SelfHousekeeping | undefined {
  const current = history ? notices : notices.filter((line) => !noticeLapsed(line, now));
  if (current.length === 0) return undefined;
  const lines = current.slice(0, SELF_HOUSEKEEPING_LINES);
  return { lines, more: cut || lines.length < notices.length };
}

// Only the sender's address, the subject line and the sent time are read, never the body.
const NOTICES = `
  select m.id, m.sent_at, m.subject_enc, m.sender_enc, m.compartments
  from knowledge.messages m
  where m.id = any($1) and not m.held
  order by m.id`;

// A notice's sender address and subject line, each cut as a line's words
// (capText), since a header has no length of its own.
export const boundNotice = (
  notice: LineNotice,
  from: UntrustedString | null,
  subject: UntrustedString | null,
): LineNotice => ({
  ...notice,
  from: from === null ? null : { untrusted: capText(from.untrusted) },
  subject: subject === null ? null : { untrusted: capText(subject.untrusted) },
});

// Each line of the `system_notice` tier with its notice's sender and subject line, read from the
// message its notice cite (`citeOf`: the belief's noticeCite, never merely its first cite) names,
// under the caller's token, in one query for all the lines; `sentAt` stays the cite's, the
// message's sent time. A message the token does not return (held, or a cite with no message)
// leaves both null. Every other line is as given. The message is the cite's own, which the read set already binds.
export async function noticeLines(
  ctx: Ctx,
  lines: readonly BeliefLine[],
  citeOf: (line: BeliefLine) => Cite | undefined,
): Promise<BeliefLine[]> {
  const messageOf = (line: BeliefLine): string | undefined => {
    const cite = line.notice === undefined ? undefined : citeOf(line);
    return cite !== undefined && "message" in cite && typeof cite.message === "string" ? cite.message : undefined;
  };
  const ids = [...new Set(lines.flatMap((line) => messageOf(line) ?? []))].sort(byText);
  if (ids.length === 0) return [...lines];
  const rows = new Map(
    (
      await ctx.run<{
        id: string;
        sent_at: Date;
        subject_enc: Sealed | null;
        sender_enc: Sealed | null;
        compartments: string[];
      }>(NOTICES, [ids])
    ).map((row) => [row.id, row]),
  );
  return lines.map((line) => {
    const id = messageOf(line);
    const row = id === undefined ? undefined : rows.get(id);
    if (line.notice === undefined || row === undefined) return line;
    return {
      ...line,
      notice: boundNotice(
        line.notice,
        servedOrNone(ctx, row, "knowledge.messages.sender_enc"),
        servedOrNone(ctx, row, "knowledge.messages.subject_enc"),
      ),
    };
  });
}

// `context` serves the same marks.
export function markedLine(line: BeliefLine, now: Date): BeliefLine {
  const pastOn = pastOnOf(line, now);
  return {
    ...line,
    ...(isStale(line, now) ? { stale: true as const } : {}),
    ...(pastOn === undefined ? {} : { pastOn: pastOn as NonNullable<BeliefLine["pastOn"]> }),
    ...(isThin(line) ? { thin: true as const } : {}),
  };
}

// Over the lines just built for this caller alone.
export function withStaleLeftOff<Section extends SelfSection>(
  built: readonly Section[],
  lines: readonly { section: SectionDomain; line: BeliefLine }[],
): Section[] {
  return built.map((section) => {
    const all = lines.filter((one) => one.section === section.domain && one.line.stale === true).length;
    const staleLeftOff = all - section.lines.filter((line) => line.stale === true).length;
    return staleLeftOff > 0 ? { ...section, staleLeftOff } : section;
  });
}

// Pure: the sections of compiled beliefs, each rendered from its first cite, the notices apart in
// `housekeeping`, and each served line's belief by its fact. `more` (the compiled read was cut)
// marks every section. Over the given beliefs alone, so what the caller cannot see moves nothing.
export function sectionsOf(input: {
  beliefs: readonly CompiledBelief[];
  people: ReadonlyMap<SectionDomain, readonly SectionPerson[]>;
  domain?: LifeDomain;
  more: boolean;
  now: Date;
  history?: boolean;
}): {
  sections: SelfSection[];
  housekeeping?: SelfHousekeeping;
  beliefOf: ReadonlyMap<string, CompiledBelief>;
  open: BeliefLine[];
} {
  const beliefs = collapseByGroup(input.beliefs);
  const sectionOfFact = new Map(beliefs.map((belief) => [belief.fact, sectionOf(belief)]));
  const ranked = rankLines(
    beliefs.map((belief) => capLine(renderLine(belief, belief.cites[0] as Cite))),
    new Map(),
    input.now,
  ).map((line): BeliefLine => {
    if (isAdminNotice(line))
      return { ...line, tier: "system_notice", notice: { from: null, subject: null, sentAt: line.at } };
    return markedLine(line, input.now);
  });
  // By the belief's tier: one whose every cite is held renders with no `notice`, and is a notice all
  // the same. Its words cannot be read, so it is served in neither part; find_facts holds it.
  const noticeFacts = new Set([
    ...beliefs.filter((one) => one.tier === "system_notice").map((one) => one.fact),
    ...ranked.filter((line) => line.notice !== undefined).map((line) => line.fact),
  ]);
  const lines = ranked
    .filter((line) => !noticeFacts.has(line.fact))
    .map((line) => ({ section: sectionOfFact.get(line.fact) as SectionDomain, line }));
  const housekeeping = housekeepingOf(
    ranked
      .filter(
        (line) =>
          line.notice !== undefined && (input.domain === undefined || sectionOfFact.get(line.fact) === input.domain),
      )
      .sort((a, b) => byText(b.at, a.at)),
    input.now,
    input.history === true,
    input.more,
  );
  const built =
    input.domain === undefined
      ? fitPage(buildSections({ lines, people: input.people, now: input.now }))
      : buildSections({ lines, people: input.people, domain: input.domain, now: input.now }).map(fitDomain);
  return {
    sections: withStaleLeftOff(built, lines).map((section) => ({ ...section, more: section.more || input.more })),
    ...(housekeeping === undefined ? {} : { housekeeping }),
    beliefOf: new Map(beliefs.map((belief) => [belief.fact, belief])),
    open: lines.flatMap(({ line }) => (OPEN_BELIEF_STATUS.has(line.status) ? [line] : [])),
  };
}

// The sections of the caller's audience's beliefs `read` (one reading, shared with `changes`).
// With `domain`, only that domain's beliefs are compiled. The read set names each served line's
// fact and every cite its words, `since`, `at` and `cites` drew on: a message's or an own
// contact's as bound, an agent record as shown. The claims behind `people` are counted, not
// served, and are not logged, as get_self's contact counts are not; a person's name logs what it
// rests on (`Ctx.served`).
export async function selfSectionsOf(
  ctx: Ctx,
  read: AudienceBeliefs,
  options: { history: boolean; domain?: LifeDomain; now: Date },
): Promise<{
  sections: SelfSection[];
  housekeeping?: SelfHousekeeping;
  applicationLines: BeliefLine[];
  rows: number;
  read: ReadSet;
  // `rows` and `read` for what a later cut kept (read-self-fit.ts).
  accountFor: (kept: { sections: readonly SelfSection[]; notices: readonly BeliefLine[] }) => {
    rows: number;
    read: ReadSet;
  };
}> {
  const kept = read.rows.flatMap((row, index) => {
    const belief = read.beliefs[index] as Belief;
    const current = options.history || OPEN_BELIEF_STATUS.has(belief.status);
    return current && (options.domain === undefined || storedSection(belief) === options.domain)
      ? [{ row, belief }]
      : [];
  });
  const compiled = await statedFactsOf(ctx, {
    ...read,
    rows: kept.map((one) => one.row),
    beliefs: kept.map((one) => one.belief),
  });
  const served = compiled.facts.beliefs;

  // The people: every supporting claim of a served belief, in each of its beliefs' sections. A
  // notice is in no section.
  const supportOf = new Map(kept.map((one) => [one.row.fact_key_fp, one.row.support]));
  const sectionsOfClaim = new Map<string, Set<SectionDomain>>();
  for (const belief of served) {
    if (belief.tier === "system_notice") continue;
    for (const id of supportOf.get(belief.fact) ?? [])
      sectionsOfClaim.set(id, (sectionsOfClaim.get(id) ?? new Set<SectionDomain>()).add(sectionOf(belief)));
  }
  const named = await ctx.run<Named>(NAMED, [[...sectionsOfClaim.keys()]]);
  const ids = [...new Set(named.map((row) => row.entity_id))].sort(byText);
  const withheld = new Set((await ctx.run<{ id: string }>(WITHHELD, [ids])).map((row) => row.id));
  const groups = await loadGroups(ctx);
  const counted = countPeople(named, sectionsOfClaim, withheld, (id) => groups.idOf(id));
  const people = await knownPeople(counted, (asked) => groupWho(ctx, groups, asked));

  const sectioned = sectionsOf({
    beliefs: served,
    people,
    ...(options.domain === undefined ? {} : { domain: options.domain }),
    more: compiled.facts.more,
    now: options.now,
    history: options.history,
  });
  const { beliefOf, sections } = sectioned;
  // A system notice's line names its sender and subject line.
  const citeOf = (line: BeliefLine): Cite | undefined => {
    const belief = beliefOf.get(line.fact);
    return belief === undefined ? undefined : noticeCite(belief);
  };
  const housekeeping =
    sectioned.housekeeping === undefined
      ? undefined
      : { ...sectioned.housekeeping, lines: await noticeLines(ctx, sectioned.housekeeping.lines, citeOf) };
  const applicationLines = sectioned.open.filter(isApplicationLine);
  const accountFor = (kept: { sections: readonly SelfSection[]; notices: readonly BeliefLine[] }) => {
    const lines = [
      ...new Set([...kept.sections.flatMap((section) => section.lines), ...kept.notices, ...applicationLines]),
    ];
    const cites = lines.flatMap((line) => beliefOf.get(line.fact)?.cites ?? []);
    return {
      rows:
        lines.length -
        kept.notices.length +
        kept.notices.length * NOTICE_LINE_COST +
        kept.sections.reduce((sum, section) => sum + section.people.length, 0),
      read: {
        bound: [...new Set(lines.flatMap((line) => compiled.boundOf.get(line.fact) ?? []))],
        shown: [...new Set(cites.flatMap((cite) => ("record" in cite ? agentRecordIds(cite.record) : [])))].sort(
          byText,
        ),
        factKeyFps: [...new Set(lines.map((line) => line.fact))],
      },
    };
  };
  return {
    sections,
    ...(housekeeping === undefined ? {} : { housekeeping }),
    applicationLines,
    ...accountFor({ sections, notices: housekeeping?.lines ?? [] }),
    accountFor,
  };
}
