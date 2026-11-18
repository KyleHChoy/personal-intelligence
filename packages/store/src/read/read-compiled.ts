// Compiled facts: beliefs with the claims that cite them, for get_entity, a project's page,
// get_self's sections, meeting_prep's attendees, get_beliefs and the mirror's beliefs.

import type { Belief } from "@intelligence/contracts";
import {
  type BeliefList,
  type BeliefTier,
  type ClaimRecord,
  CompiledBelief,
  type CompiledFacts,
  type CurrentStanding,
  dayIn,
  EntityId,
  type FactView,
  GetBeliefsArgs,
  OPEN_BELIEF_STATUS,
  type PersonalView,
  SELF_CHANGE_DAYS,
  SELF_CHANGES,
  type SelfChange,
  SubjectKind,
  VIEW_OF_SUBJECT,
  type Who,
} from "@intelligence/contracts/personal";
import { DAY_MS } from "@intelligence/personal-core";
import {
  attendeeFacts,
  type BeliefOrder,
  byBeliefOrder,
  capFacts,
  collapseGroup,
  compileFacts,
  currentOf,
  currentStanding,
  isAttendeeFact,
  thirdPartyLapsed,
} from "@intelligence/personal-core/views";
import { byText, stamp } from "../core/db.ts";
import { TITLE_LINK_TYPE } from "../core/link-types.ts";
import { agentRecordIds, type ClientGroups, type Ctx, type Found } from "../core/read-ctx.ts";
import { parsed, type ReadTool } from "../core/read-tool.ts";
import type { Sealed } from "../core/seal.ts";
import { parseOr } from "../core/served.ts";
import { OWN_CONTACT_CLAIM } from "../core/statements.ts";
import { CORRECTED, type NamedKind, namesShown, RECORD_SHOWN, RELEASE_IN_FORCE, recordOf } from "../core/visibility.ts";
import { asOfOf, keyedBeliefs, subjectBeliefs } from "./computed-beliefs.ts";
import { type AudienceBeliefs, type AudienceRead, audienceBeliefs, beliefsIn, OWNER_ENTITY } from "./read-beliefs.ts";
import { ENTITY, type FactRow, type FactsRead, PROJECTS } from "./read-fact-rows.ts";
import { factViewer, projectWhos } from "./read-facts.ts";
import { loadGroups } from "./read-groups.ts";
import { lapsedOwnerSide } from "./read-lapse.ts";

// get_entity's compiled facts. Four fixed
// statements and the viewer's five, whatever the entity holds: its beliefs, by the fact keys of
// the claims that name it; their supporting claims and the claims about it, with their messages
// where the token returns one; then the owner and the people they name.

// Known limit: the subject is sealed and claim_entities holds no role,
// so both scans cap rows that only name the entity (a speaker, a counterparty, an organization
// field) before code keeps those about it. An entity named in more rows than a cap can come back
// short, with `more` true. A role column on claim_entities lifts it; it needs a migration.
// The beliefs to compile at most, newest supporting claim first; past that, `more`.
const BELIEF_SCAN = 1000;
// The claims about the entity to read at most; past that, `more`.
const CLAIM_SCAN = 200;

// The kept beliefs' supporting claims, latest first, at most SUPPORT_READ of each fact key, each
// with its message when the token returns it: a held one's is not returned, so that claim is
// cited as held and never opened. `finding` is
// find_facts' rule (FIND_FACTS): a claim with no message
// whose evidence is an agent record's the token returns from ledger.agent_writes, never a
// missing message row alone. As in FIND_FACTS, a claim that names a person or an organization the token
// does not show is not returned, so whether a held claim is cited depends only on rows the token
// sees. Nor is a claim under an agent record's label (an `agent:` compartment) with neither a
// message nor a finding's row, which is cited nowhere (below). The window runs over the claims
// returned. `$3`, the kept beliefs' canonical claims, each read past
// the window too, so it is cited first however old.
// A confirmed title link's belief cites its capture.project claims, each
// with its item's knowledge.captures row as the token returns it; one whose row it does not return
// is cited nowhere, never as held. Any claim with no message reads its capture row
// (and its `agent_app`, as find_facts does) the same way, so a capture item's claim, a source
// moment's (iMessage) among them, is returned, opened, cited and bound when the token returns its
// row, as find_facts serves it; one whose row the token does not return is cited as held.
const CITED_CAPTURE_TYPE = TITLE_LINK_TYPE;
// `contact` is find_facts' rule, a claim code made from one of the
// owner's own (`own`) contacts the token returns; it is opened and cited, and binds its contact.
const supportOf = (kinds: readonly NamedKind[]): string => `
  select s.id, s.type, s.valid_from, s.fact_key_fp, s.content_enc, s.compartments, s.message_id, s.evidence_id, s.record_id is not null as finding, s.record_id, s.record_client, s.document, s.capture_id, s.capture_agent_app, s.capture_kind, s.capture_source, s.contact, s.from_page, s.released
  from (
    select c.id, c.type, c.valid_from, c.fact_key_fp, c.content_enc, c.compartments, m.id as message_id, c.evidence_id, c.released,
      ${recordOf("m.id is null")},
      (m.id is null and exists (select 1 from knowledge.documents d where d.evidence_id = c.evidence_id)) as document,
      (m.id is null and exists (select 1 from knowledge.pages g where g.evidence_id = c.evidence_id)) as from_page,
      (m.id is null and ${OWN_CONTACT_CLAIM}) as contact,
      cap.id as capture_id, cap.agent_app as capture_agent_app, cap.kind as capture_kind, cap.source as capture_source,
      row_number() over (partition by c.fact_key_fp order by c.valid_from desc, c.id) as n
    from knowledge.claims c
    left join knowledge.messages m on m.evidence_id = c.evidence_id and not m.held
    left join knowledge.captures cap on m.id is null and cap.evidence_id = c.evidence_id
    where c.id = any($1)
      and ${RELEASE_IN_FORCE}
      and ${namesShown(kinds)}
      and (m.id is not null or cap.id is not null or c.released
        or ${RECORD_SHOWN}
        or not exists (select 1 from unnest(c.compartments) k where starts_with(k, 'agent:')))
  ) s
  where s.n <= $2 or s.id = any($3)
  order by s.valid_from desc, s.id`;
const SUPPORT = supportOf(["person", "organization"]);
// A project's page: its own claims name it, so a project the token shows is one more kind.
const PROJECT_SUPPORT = supportOf(["person", "organization", "project"]);

// The claims naming the entity in no kept belief's support, newest first, never of a held
// message, as find_facts reads them.
const ABOUT = `
  select c.id, c.type, c.valid_from, c.fact_key_fp, c.content_enc, c.compartments, m.id as message_id, m.evidence_id
  from knowledge.claims c
  join knowledge.messages m on m.evidence_id = c.evidence_id
  where not m.held
    and exists (select 1 from knowledge.claim_entities n where n.claim_id = c.id and n.entity_id = $1)
    and not (c.id = any($2))
  order by c.valid_from desc, c.id, m.id
  limit $3`;

const PROJECT_ABOUT = `
  select c.id, c.type, c.valid_from, c.fact_key_fp, c.content_enc, c.compartments, m.id as message_id, c.evidence_id,
    ${recordOf("m.id is null")}
  from knowledge.claims c
  left join knowledge.messages m on m.evidence_id = c.evidence_id
  where (m.id is not null and not m.held
      or (m.id is null and exists (select 1 from ledger.agent_writes w where w.evidence_id = c.evidence_id and w.flagged_at is null
        and not ${CORRECTED})))
    and ${RELEASE_IN_FORCE}
    and exists (select 1 from knowledge.claim_entities n where n.claim_id = c.id and n.entity_id = $1)
    and not (c.id = any($2))
  order by c.valid_from desc, c.id, m.id
  limit $3`;

// A stored belief row, as the mirror still reads it (lens/mirror-facts.ts); every reader here takes
// computed beliefs (computed-beliefs.ts). `tier`: absent where a statement reads none (the mirror's).
// `phrase_claim`, the canonical claim's stored id, cited first;
// `group_fp`, the joined set's group. Absent, as `tier` is, where a statement reads none.
export type EntityBeliefRow = {
  id: string;
  fact_key_fp: string;
  state_fp: string;
  support: string[];
  compartments: string[];
  belief_enc: Sealed;
  provenance: CompiledBelief["provenance"];
  tier?: BeliefTier;
  phrase_claim?: string | null;
  group_fp?: string | null;
};
type SupportRow = Omit<FactRow, "document_id"> & { finding: boolean; document: boolean; released: boolean };
// A compiled fact cites a message's claims only: SUPPORT marks a document's claim, which is never
// cited, and ABOUT reads no document row (find_facts returns it).
const noDocument = <Row extends Omit<FactRow, "document_id">>(row: Row): Row & { document_id: null } => ({
  ...row,
  document_id: null,
});

const CITES = 3;
// The supporting claims read per fact key at most: the three cited, with room for those `shows()`
// hides. Known limit: revisit when a compiled read takes over 200 ms in a deployment.
const SUPPORT_READ = 6;

// A belief's value names an entity exactly when it is an entity id: a belief holds its declared
// typed fields only, and no enum, date or number is one.
const isEntity = (value: unknown): value is string => EntityId.safeParse(value).success;

// A belief as compiled() takes it: its row's clear fields, and the belief itself.
export type Opened = { row: Omit<EntityBeliefRow, "belief_enc">; belief: Belief };

// What a compiled read gives: the facts, the read set, and the evidence id of each cited or listed
// claim's message, by the message's id, which a pack logs for the items it shows. `boundOf` is the
// read set's bound evidence by the fact key of the belief whose cites bind it, for a caller that
// serves some of the beliefs (get_self's sections).
export type Compiled = {
  facts: CompiledFacts;
  read: FactsRead;
  evidenceOf: ReadonlyMap<string, string>;
  boundOf: ReadonlyMap<string, readonly string[]>;
};

type Subject = { id: string; kind: SubjectKind };
export type Order = (beliefs: CompiledBelief[], claims: FactView[], more: boolean) => CompiledFacts;
// Step 4 for one subject: compileFacts' order and cuts.
const orderFor =
  (subjectKind: SubjectKind): Order =>
  (beliefs, claims, more) =>
    compileFacts({ subjectKind, beliefs, claims, more });
export const noClaims = async () => ({ rows: [] as FactRow[], cut: false });

// The claims naming the members in no kept belief's support, newest first, at most CLAIM_SCAN of
// each, each once.
const aboutOf = (ctx: Ctx, members: readonly string[]) => async (ids: string[]) => {
  const abouts: FactRow[][] = [];
  for (const member of members)
    abouts.push((await ctx.run<Omit<FactRow, "document_id">>(ABOUT, [member, ids, CLAIM_SCAN + 1])).map(noDocument));
  const rows = abouts
    .flatMap((one) => one.slice(0, CLAIM_SCAN))
    .filter((row, index, all) => all.findIndex((other) => other.id === row.id) === index);
  return { rows, cut: abouts.some((one) => one.length > CLAIM_SCAN) };
};

// A project's page: the claims naming it in no kept belief's support, a message's as ABOUT reads
// them and a finding's, which the token returns only with its record's row, and which is in no
// belief, so a finding a live correction replaced is left out here (a timeline keeps its history).
const projectAboutOf = (ctx: Ctx, project: string) => async (ids: string[]) => {
  const rows = (await ctx.run<Omit<FactRow, "document_id">>(PROJECT_ABOUT, [project, ids, CLAIM_SCAN + 1])).map(
    noDocument,
  );
  return { rows: rows.slice(0, CLAIM_SCAN), cut: rows.length > CLAIM_SCAN };
};

// Lapses are read before the card's cut, so a lapsed line ranks with ended ones. `lapsed`, by belief
// row, is of every read belief the owner is on a side of, so a card reads it once.
async function lapsesOf(ctx: Ctx, opened: readonly Opened[], now: Date | undefined): Promise<Lapses> {
  if (
    now === undefined ||
    !opened.some((one) => one.belief.kind === "commitment" && OPEN_BELIEF_STATUS.has(one.belief.status))
  )
    return { owner: undefined, lapsed: new Map() };
  const [owner] = await ctx.run<{ id: string }>(OWNER_ENTITY, []);
  return { owner: owner?.id, lapsed: await lapsedOwnerSide(ctx, opened, owner?.id, now) };
}
type Lapses = { owner: string | undefined; lapsed: ReadonlyMap<string, string> };

// A belief as it reads at `now`: an open one whose owner side lapsed, or with the owner on neither
// side, whose third parties' time ran out, reads as dormant.
const lapsedAt = (belief: Belief, row: string, { owner, lapsed }: Lapses, now: Date | undefined): Belief =>
  now !== undefined &&
  owner !== undefined &&
  OPEN_BELIEF_STATUS.has(belief.status) &&
  (lapsed.has(row) || thirdPartyLapsed(belief, (id) => id === owner, now))
    ? { ...belief, status: "dormant" }
    : belief;

const withLapses = (beliefs: Opened[], lapses: Lapses, now: Date | undefined): Opened[] =>
  beliefs.map((one) => {
    const belief = lapsedAt(one.belief, one.row.id, lapses, now);
    return belief === one.belief ? one : { ...one, belief };
  });

// For a group (contacts and identity), `members` are its visible
// members, and each statement runs once per member. With `groups` the
// group's beliefs are one list: two members' copies of one fact, keyed with the subject taken away
// and every entity named by its group (core's groupFactKey), are served once; without, side by
// side. `claims: false` (person_brief) reads the entity's beliefs alone: no claim in none is read,
// so `more` says only that its beliefs were cut. `audience` (the owner's page) reads that
// audience's beliefs alone, for a caller whose policies return every audience's. `now`: a commitment
// with the owner on neither side reads as lapsed at that time, as find_facts and get_beliefs serve it. `card`
// (get_entity) picks the current role and affiliation from the whole list,
// then cuts it to the card's cap with those two kept, before the read set is taken, so it names
// only what was served.
export async function compiledFactsOf(
  ctx: Ctx,
  entity: Subject,
  members: readonly string[] = [entity.id],
  options: { claims: boolean; audience?: readonly string[]; groups?: ClientGroups; card?: boolean; now?: Date } = {
    claims: true,
  },
): Promise<
  Compiled & {
    current?: CurrentStanding;
    commitments: readonly Opened[];
    lapsed: Lapses["lapsed"];
  }
> {
  // Every belief of the fact keys of the claims naming a member, computed under the caller's
  // clearance, or the owner's audience for the owner's page (pi_admin's policies return every row).
  const found = await subjectBeliefs(ctx, members, await asOfOf(ctx), { audience: options.audience });
  const opened = found.slice(0, BELIEF_SCAN);
  // A belief this entity is only a speaker or a counterparty of is another's.
  const about = opened.filter(
    (one, index) =>
      members.includes(one.belief.subject) && opened.findIndex((other) => other.row.id === one.row.id) === index,
  );
  const lapses = await lapsesOf(ctx, opened, options.now);
  const kept = withLapses(about, lapses, options.now);
  const supportIds = [...new Set(kept.flatMap((one) => one.row.support))];
  const groups = options.groups;
  let current: CurrentStanding | undefined;
  const order: Order = (beliefs, claims, more) => {
    const one = members.length > 1 && groups !== undefined ? collapseGroup(beliefs, (id) => groups.idOf(id)) : beliefs;
    const facts = orderFor(entity.kind)(one, claims, more);
    if (options.card !== true) return facts;
    current = currentStanding(facts.beliefs);
    const picked = currentOf(facts.beliefs);
    return capFacts(
      facts,
      new Set([picked.role?.fact, picked.affiliation?.fact].filter((fact): fact is string => fact !== undefined)),
    );
  };
  const result = await compiled(ctx, {
    subject: entity,
    members,
    kept,
    supportIds,
    aboutRows: options.claims ? aboutOf(ctx, members) : noClaims,
    cut: found.length > BELIEF_SCAN,
    order,
    audience: options.audience,
  });
  const commitments = [...new Map(opened.map((one) => [one.row.id, one])).values()].filter(
    (one) => one.belief.kind === "commitment" && OPEN_BELIEF_STATUS.has(one.belief.status),
  );
  return { ...result, ...(current === undefined ? {} : { current }), commitments, lapsed: lapses.lapsed };
}

// The owner's own beliefs: the agent bootstrap
// pack's facts section, the planner's self block, get_self's sections and context's compile them
// here. knowledge.claim_entities leaves the owner out, so the audience's beliefs are read in pages
// as commitmentsOf reads them and kept by subject. A commitment, the owner's included, is left
// out: the Work view serves it, through get_commitments. No claim in no belief is read: no tool
// serves them here; agents reach others' claims about the owner through find_facts by type, and
// `pi self review` lists them for the owner.

export async function statedFactsOf(ctx: Ctx, read: AudienceRead): Promise<Compiled> {
  const { rows, beliefs, ceiling, owner } = await beliefsIn(ctx, read);
  const kept = rows.flatMap((row, index) => {
    const belief = beliefs[index] as Belief;
    return owner !== undefined && belief.subject === owner && belief.kind !== "commitment" ? [{ row, belief }] : [];
  });
  const supportIds = [...new Set(kept.flatMap((one) => one.row.support))];
  return compiled(ctx, {
    subject: { id: owner ?? "", kind: "owner" },
    members: owner === undefined ? [] : [owner],
    kept,
    supportIds,
    aboutRows: noClaims,
    cut: ceiling,
    order: orderFor("owner"),
  });
}

// get_self's `changes`: the owner's beliefs, their commitments left out as in
// `stated`, that closed or expired in the last SELF_CHANGE_DAYS, by when the store recorded that
// status (computed-beliefs.ts changed_at), newest first.
// At most CHANGE_SCAN are compiled, each with its latest cite, and the first SELF_CHANGES the
// token shows are listed, one line each; the read set is theirs.
// Nothing is superseded: the personal belief build never sets supersededBy.
const CHANGED: ReadonlySet<string> = new Set(["closed", "expired"]);
const CHANGE_SCAN = 50;

const NO_CHANGES = { changes: [], read: { bound: [], shown: [], factKeyFps: [] } };

export async function selfChangesOf(
  ctx: Ctx,
  read: AudienceBeliefs,
  now: Date,
  zone: string | null,
): Promise<{ changes: SelfChange[]; read: FactsRead }> {
  const { rows, beliefs, owner } = read;
  if (owner === undefined) return NO_CHANGES;
  const since = now.getTime() - SELF_CHANGE_DAYS * DAY_MS;
  const kept = rows
    .flatMap((row, index) => {
      const belief = beliefs[index] as Belief;
      return belief.subject === owner &&
        belief.kind !== "commitment" &&
        // An automated notice that lapsed is no change in the owner's life.
        row.tier !== "system_notice" &&
        CHANGED.has(belief.status) &&
        row.changed_at.getTime() >= since
        ? [{ row, belief }]
        : [];
    })
    .sort(
      (a, b) => b.row.changed_at.getTime() - a.row.changed_at.getTime() || byText(a.row.fact_key_fp, b.row.fact_key_fp),
    )
    .slice(0, CHANGE_SCAN);
  if (kept.length === 0) return NO_CHANGES;
  const recorded = new Map(kept.map((one) => [one.row.fact_key_fp, one.row.changed_at]));
  const supportIds = [...new Set(kept.flatMap((one) => one.row.support))];
  // compiled keeps the order given; the cut and the one cite are this order's.
  const inPlace: Order = (compiledBeliefs, _claims, more) => ({
    beliefs: compiledBeliefs
      .slice(0, SELF_CHANGES)
      .map((one) => ({ ...one, cites: one.cites.slice(0, 1) }) as CompiledBelief),
    claims: [],
    more,
  });
  const found = await compiled(ctx, {
    subject: { id: owner, kind: "owner" },
    members: [owner],
    kept,
    supportIds,
    aboutRows: noClaims,
    cut: false,
    order: inPlace,
  });
  const changes = found.facts.beliefs.map((one): SelfChange => {
    const [cite] = one.cites;
    const fields = cite === undefined || "held" in cite ? {} : (cite.fields as Record<string, unknown>);
    const what = fields.what ?? fields.title;
    return {
      kind: one.kind,
      status: one.status as SelfChange["status"],
      at: dayIn(recorded.get(one.fact) as Date, zone),
      what: typeof what === "object" && what !== null && "untrusted" in what ? (what as SelfChange["what"]) : null,
    };
  });
  return { changes, read: found.read };
}

// meeting_prep@4's facts: for each attendee, in the order
// given, their open beliefs of core's ATTENDEE_FACT_KINDS, five each, compiled as get_entity
// compiles them. The audience's beliefs are read in pages as commitmentsOf reads them, so a pack
// that needs both reads them once, and kept by subject and by core's isAttendeeFact before their
// claims are read. The statements sent depend only on how many pages the audience fills, not on
// how many attendees there are. `more` says the reading stopped at the audience's ceiling.

export async function attendeeFactsOf(ctx: Ctx, attendees: readonly Who[], read: AudienceRead): Promise<Compiled> {
  const { rows, beliefs, ceiling } = await beliefsIn(ctx, read);
  const ids = new Set(attendees.map((one) => one.id as string));
  const kept = rows.flatMap((row, index) => {
    const belief = beliefs[index] as Belief;
    return ids.has(belief.subject) && isAttendeeFact(belief) ? [{ row, belief }] : [];
  });
  const supportIds = [...new Set(kept.flatMap((one) => one.row.support))];
  // Cut by attendee, not by the compiled list's own cap: each attendee's five are their own.
  const order: Order = (cited, _claims, more) => ({ beliefs: attendeeFacts(attendees, cited), claims: [], more });
  return compiled(ctx, { subject: null, members: [], kept, supportIds, aboutRows: noClaims, cut: ceiling, order });
}

// Steps 2 to 4: the kept beliefs' supporting claims, the claims about the subject, the viewer,
// the cites, and `order`'s order and cut. `subject` is the one entity whose page this is, or null
// for beliefs of several (meeting_prep's attendees, get_beliefs), which read no claims about any
// one. `members` are the subjects whose claims are its own (a group's visible members, else the
// subject alone). `about` reads the claims about the subject that count in no kept belief, given
// the kept beliefs' support. `ownerId` is the owner's entity when the caller read it: the owner is
// then known even when none of the owner's accounts is visible.
export async function compiled(
  ctx: Ctx,
  {
    subject,
    members,
    kept,
    supportIds,
    aboutRows,
    cut,
    order,
    ownerId,
    projects,
    audience,
  }: {
    subject: Subject | null;
    members: readonly string[];
    kept: readonly Opened[];
    supportIds: string[];
    aboutRows: (supportIds: string[]) => Promise<{ rows: FactRow[]; cut: boolean }>;
    cut: boolean;
    order: Order;
    ownerId?: string | undefined;
    // The projects the beliefs are about, as their Whos; with them, the statement that cites
    // a project's claims too.
    projects?: ReadonlyMap<string, Who> | undefined;
    // The owner's audience, for a read as pi_admin (the owner's page).
    audience?: readonly string[] | undefined;
  },
): Promise<Compiled> {
  const phrases = [...new Set(kept.flatMap((one) => (one.row.phrase_claim == null ? [] : [one.row.phrase_claim])))];
  const support = (
    await ctx.run<SupportRow>(projects === undefined ? SUPPORT : PROJECT_SUPPORT, [supportIds, SUPPORT_READ, phrases])
  ).map(noDocument);
  const { rows: aboutPage, cut: aboutCut } = await aboutRows(supportIds);
  // A supporting claim whose message came back, a finding's, a capture item's whose row came back,
  // or an own contact's is opened and cited as a FactView.
  // One with neither under an agent record's label (its `agent:` compartment, which no message's
  // label holds) is a finding whose ledger.agent_writes row the token does not return: find_facts
  // returns no such claim, so it is not cited at all; nor is a document's. Any other is a held
  // message's, or a capture item's whose row the token does not return, cited as held and never
  // opened. The compartment only ever takes a row away.
  const captured = (row: SupportRow): boolean => (row.capture_id ?? null) !== null;
  // A released claim is opened and cited too, whether or not the token returns its record.
  const openable = support.filter(
    (row) => row.message_id !== null || row.finding || row.released || captured(row) || row.contact === true,
  );
  const held = (row: SupportRow): boolean =>
    row.type !== CITED_CAPTURE_TYPE &&
    row.message_id === null &&
    !row.finding &&
    !row.released &&
    !row.document &&
    row.contact !== true &&
    !row.compartments.some((one) => one.startsWith("agent:"));
  const extra = kept.flatMap((one) => [one.belief.subject, ...Object.values(one.belief.values).filter(isEntity)]);
  const { records, whoIs, shows, knows, view } = await factViewer(ctx, [...openable, ...aboutPage], {
    extra: extra,
    ownerId: ownerId ?? (subject?.kind === "owner" && subject.id !== "" ? subject.id : undefined),
    given: projects,
    computed: kept,
    audience,
  });
  const recordOf = new Map([...openable, ...aboutPage].map((row, index) => [row.id, records[index] as ClaimRecord]));

  const place = new Map(support.map((row, index) => [row.id, index]));
  const beliefs = kept
    .map((one) => {
      // The latest supporting claim first, then up to two more, of those the token returns; an
      // opened one only when the token shows every entity it names. The belief's canonical claim
      // first of all, when the token returns and shows it.
      const first = (id: string): number => (id === one.row.phrase_claim ? 0 : 1);
      const rows = one.row.support
        .filter((id) => place.has(id))
        .sort((a, b) => first(a) - first(b) || (place.get(a) as number) - (place.get(b) as number))
        .map((id) => support[place.get(id) as number] as (typeof support)[number])
        .filter((row) => {
          const record = recordOf.get(row.id);
          return record === undefined ? held(row) : shows(record);
        })
        .slice(0, CITES);
      // A belief none of whose claims the token returns is not shown, nor one whose subject or
      // value names an entity the token does not show. The owner is known by the owner's entity's id.
      if (rows.length === 0) return null;
      if (![one.belief.subject, ...Object.values(one.belief.values).filter(isEntity)].every(knows)) return null;
      const latest = rows.flatMap((row) => recordOf.get(row.id) ?? [])[0];
      // A belief holds no text: each typed value as it is, an entity as its Who.
      const values = Object.fromEntries(
        Object.entries(one.belief.values).map(([name, value]) => [
          name,
          isEntity(value) ? whoIs(value, latest) : value,
        ]),
      );
      const item = {
        fact: one.row.fact_key_fp,
        state: one.row.state_fp,
        kind: one.belief.kind,
        type: one.belief.type,
        status: one.belief.status,
        disputed: one.belief.disputed,
        // agent_reported when an owner-confirmed finding is in its support.
        provenance: one.row.provenance,
        // The tier the belief build wrote for the caller's own audience's row.
        ...(one.row.tier === undefined ? {} : { tier: one.row.tier }),
        // The joined set it belongs to, which a handle stands for.
        ...(one.row.group_fp == null ? {} : { group: one.row.group_fp }),
        confirmedAt: one.belief.lastConfirmedAt,
        // The stored belief's review date, null when it has none.
        reviewAfter: one.belief.reviewAfter ?? null,
        subject: whoIs(one.belief.subject, latest),
        values,
        cites: rows.map((row) => {
          const record = recordOf.get(row.id);
          return record === undefined
            ? { held: true, fact: row.id, type: row.type, at: stamp(row.valid_from) }
            : view(row, record, one.belief.status);
        }),
      };
      return { item, rows };
    })
    .filter((one) => one !== null);
  const parsedBeliefs = beliefs.map(({ item }) => parseOr(CompiledBelief.safeParse(item)));

  // Step 3: the claims about the entity itself, not those it only spoke or is a party in.
  const claims = aboutPage.flatMap((row) => {
    const record = recordOf.get(row.id) as ClaimRecord;
    return subject !== null && members.includes(record.claim.content.subject) && shows(record)
      ? [view(row, record)]
      : [];
  });

  const facts = order(parsedBeliefs, claims, cut || aboutCut);
  // The read set: each kept belief's fact key, and each cited or listed claim's message as bound,
  // since its text was opened, and each cited contact's claim's contact and capture item's claim's
  // item. A finding's words are an agent record's and a held claim's were
  // not opened: neither is ever a bound entry in the read log, as in find_facts. A cite the order
  // left out was not served, and binds nothing.
  const shownFacts = new Set(facts.beliefs.map((one) => one.fact));
  const cited = new Set(
    facts.beliefs.flatMap((one) => one.cites.map((cite) => ("held" in cite ? cite.fact : cite.id))),
  );
  const boundOf = new Map<string, string[]>();
  for (const { item, rows } of beliefs.filter(({ item }) => shownFacts.has(item.fact))) {
    const bound = rows
      .filter(
        (row) =>
          (row.message_id !== null || row.contact === true || (row.capture_id ?? null) !== null) && cited.has(row.id),
      )
      .map((row) => row.evidence_id);
    boundOf.set(item.fact, [...new Set([...(boundOf.get(item.fact) ?? []), ...bound])]);
  }
  // A finding's claim is shown by its record below, never bound: its evidence goes when the record is
  // removed, and a bound entry would then refuse the session's later records.
  const boundRows = aboutPage.filter((row) => row.message_id !== null && facts.claims.some((one) => one.id === row.id));
  const evidenceOf = new Map(
    [...openable, ...aboutPage].flatMap((row) => {
      const id = row.message_id ?? row.capture_id ?? null;
      return id === null ? [] : [[id as string, row.evidence_id] as const];
    }),
  );
  // A served finding's agent record is shown by its own id.
  const findings = [...facts.beliefs.flatMap((one) => one.cites), ...facts.claims].flatMap((one) =>
    "record" in one ? agentRecordIds(one.record) : [],
  );
  return {
    facts,
    read: {
      bound: [...new Set([...[...boundOf.values()].flat(), ...boundRows.map((row) => row.evidence_id)])],
      shown: [...new Set(findings)].sort(),
      factKeyFps: [...shownFacts],
    },
    evidenceOf,
    boundOf,
  };
}

// get_beliefs: the caller's audience's
// beliefs, read in pages as commitmentsOf reads them, opened, and kept by code: by the client's
// views of their subjects' kinds, then by kind, entity and state. Ordered by core's
// byBeliefOrder, the first `limit` compiled with their citing claims. Every statement is the same
// whatever the client's views and filters, which are applied in memory; an entity adds only its
// own check and its group's read.

const GET_BELIEFS_DEFAULT = 20;

// The kinds of the audience's beliefs' subjects, among the rows the token shows.
const SUBJECT_KINDS = `
  select e.id, e.kind from knowledge.entities e
  where e.id = any($1)
  order by e.id`;

// The kind of each subject the token shows, by its id; a kind the contracts do not name is left out.
export async function subjectKindsOf(ctx: Ctx, subjects: readonly string[]): Promise<Map<string, SubjectKind>> {
  const rows = await ctx.run<{ id: string; kind: string }>(SUBJECT_KINDS, [[...new Set(subjects)]]);
  return new Map(
    rows.flatMap((row) => {
      const kind = SubjectKind.safeParse(row.kind);
      return kind.success ? [[row.id, kind.data] as const] : [];
    }),
  );
}

// The Who of each project among the kept beliefs' subjects, as a project's beliefs cite its claims.
export const keptProjectWhos = (
  ctx: Ctx,
  kindOf: ReadonlyMap<string, SubjectKind>,
  kept: readonly { belief: Belief }[],
): Promise<Map<string, Who>> =>
  projectWhos(ctx, PROJECTS, [
    ...new Set(
      kept.flatMap((one) => (kindOf.get(one.belief.subject) === "project" ? [one.belief.subject as string] : [])),
    ),
  ]);

async function beliefsOf(
  ctx: Ctx,
  args: GetBeliefsArgs,
  views: readonly PersonalView[],
  now?: Date,
): Promise<(Found<BeliefList> & { read: FactsRead }) | null> {
  // The owner's id is not_found, as get_entity answers it; so is one the
  // token does not show.
  if (args.entity !== undefined && (await ctx.run(ENTITY, [args.entity])).length === 0) return null;
  // An entity stands for its group's visible members, each member's beliefs its own.
  const members = args.entity === undefined ? undefined : new Set((await loadGroups(ctx)).membersOf(args.entity));
  // Only the kind asked for is computed, when one is.
  const { rows, beliefs, ceiling, owner } = await audienceBeliefs(
    ctx,
    args.kind === undefined ? undefined : [args.kind],
  );
  const kindOf = await subjectKindsOf(
    ctx,
    beliefs.map((belief) => belief.subject),
  );
  const state = args.state ?? "open";
  // A commitment lapses at this read as get_commitments reads it, or, with the owner on neither side, as find_facts does.
  const lapsed =
    now === undefined || (args.kind !== undefined && args.kind !== "commitment")
      ? new Map<string, string>()
      : await lapsedOwnerSide(
          ctx,
          rows.map((row, index) => ({ row, belief: beliefs[index] as Belief })),
          owner,
          now,
        );
  const matched = rows.flatMap((row, index) => {
    const belief = lapsedAt(beliefs[index] as Belief, row.id, { owner, lapsed }, now);
    const subjectKind = kindOf.get(belief.subject);
    if (subjectKind === undefined || !views.includes(VIEW_OF_SUBJECT[subjectKind])) return [];
    if (args.kind !== undefined && belief.kind !== args.kind) return [];
    if (members !== undefined && !members.has(belief.subject)) return [];
    if (state !== "any" && OPEN_BELIEF_STATUS.has(belief.status) !== (state === "open")) return [];
    return [{ row, belief, subjectKind }];
  });
  // Every belief ranked by the People view's list of kinds, the widest, whatever its subject's
  // kind, so one kind's beliefs stand together; a kind the list lacks comes last.
  const orderOf = (one: (typeof matched)[number]): BeliefOrder => ({
    kind: one.belief.kind,
    status: one.belief.status,
    confirmedAt: one.belief.lastConfirmedAt,
    fact: one.row.fact_key_fp,
    subjectKind: "person",
  });
  matched.sort((a, b) => byBeliefOrder(orderOf(a), orderOf(b)));
  const limit = args.limit ?? GET_BELIEFS_DEFAULT;
  const kept = matched.slice(0, limit).map(({ row, belief }) => ({ row, belief }));
  const supportIds = [...new Set(kept.flatMap((one) => one.row.support))];
  // compiled() keeps the order it is given. Known limit: a belief none of whose claims the token
  // returns, or whose value names an entity it does not show, is left out after the cut, so fewer
  // than `limit` may come back with `more` true; get_commitments cuts the same way.
  const order: Order = (cited, _claims, more) => ({ beliefs: cited, claims: [], more });
  // A project's beliefs, to a client with work, cite the project's claims as its Who.
  const projects = await keptProjectWhos(ctx, kindOf, kept);
  const { facts, read } = await compiled(ctx, {
    subject: null,
    members: [],
    kept,
    supportIds,
    aboutRows: noClaims,
    cut: ceiling || matched.length > limit,
    order,
    ownerId: owner,
    projects,
  });
  return { value: { beliefs: facts.beliefs, more: facts.more }, rows: facts.beliefs.length, read };
}

// get_entity for a project: the caller's audience's beliefs of every fact key a claim bound to the project has, kept when
// their subject is the project (its status and decisions) or they are commitments (those of its
// anchored threads), then each served only when the client holds its subject's view; the
// claims naming it in none; all compiled as get_entity compiles a person's. The project is the
// caller's Who of it, read by the caller under the token.

// And its confirmed title links, whose capture.project claims name
// it as their subject and are bound to no thread.
const PROJECT_KEYS = `
  select c.fact_key_fp from knowledge.claims c join knowledge.project_bindings p on p.claim_id = c.id
  where p.project_id = $1 and p.undone_at is null
  union
  select c.fact_key_fp from knowledge.claims c join knowledge.claim_entities n on n.claim_id = c.id
  where n.entity_id = $1 and c.type in ('${CITED_CAPTURE_TYPE}', 'project.status', 'project.decision')
  order by fact_key_fp`;

export async function projectFactsOf(ctx: Ctx, project: Who, views: readonly PersonalView[]): Promise<Compiled> {
  // A next step's `who` may be the owner, known here even when none of the owner's accounts is visible.
  const [owner] = await ctx.run<{ id: string }>(OWNER_ENTITY, []);
  const found = await keyedBeliefs(ctx, PROJECT_KEYS, [project.id], await asOfOf(ctx));
  const kept = found
    .slice(0, BELIEF_SCAN)
    .filter((one) => (one.belief.subject as string) === project.id || one.belief.kind === "commitment");
  const supportIds = [...new Set(kept.flatMap((one) => one.row.support))];
  const order: Order = (beliefs, claims, more) => {
    const facts = compileFacts({
      subjectKind: "project",
      beliefs: beliefs.filter((one) => views.includes(VIEW_OF_SUBJECT[one.subject.kind])),
      claims,
      more,
    });
    return { ...facts, claims: facts.claims.filter((one) => views.includes(VIEW_OF_SUBJECT[one.subject.kind])) };
  };
  return compiled(ctx, {
    subject: { id: project.id, kind: "project" },
    members: [project.id],
    kept,
    supportIds,
    aboutRows: projectAboutOf(ctx, project.id),
    cut: found.length > BELIEF_SCAN,
    order,
    ownerId: owner?.id,
    projects: new Map([[project.id as string, project]]),
  });
}

// The caller's audience's beliefs: read and opened as
// get_commitments reads them, kept by the client's views of their subjects, then filtered,
// ordered and compiled with their citing claims.
export const GET_BELIEFS_TOOL: ReadTool<GetBeliefsArgs, BeliefList> = {
  tool: "get_beliefs",
  parse: (args) => parsed(GetBeliefsArgs.safeParse(args)),
  work: (ctx, valid, client, env) => beliefsOf(ctx, valid, client.views, env.now()),
};
