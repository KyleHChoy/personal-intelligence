import type { Belief, Envelope } from "@intelligence/contracts";
import {
  AboutArgs,
  type AboutCandidate,
  type AboutCommitment,
  type AboutView,
  type Area,
  AreaTable,
  type BeliefAt,
  type BeliefClaim,
  type BeliefRecord,
  type CitedClaim,
  ClaimRecord,
  claimTierOf,
  EntityId,
  isSystemNotice,
  OPEN_BELIEF_STATUS,
  SUPPORT_INLINE,
  type SubjectKind,
  type SubjectRef,
  type TierSignals,
  type UnbelievedClaim,
} from "@intelligence/contracts/personal";
import { beliefAt, PERSONAL_ONTOLOGY, type ReadRelation, readRelations } from "@intelligence/personal-beliefs";
import { normalizeAddress, repoFile } from "@intelligence/personal-core";
import { thirdPartyLapsed } from "@intelligence/personal-core/views";
import { directionOf } from "../core/commitment-rules.ts";
import { byText, stamp } from "../core/db.ts";
import { fingerprint } from "../core/fingerprint.ts";
import { asItemSays } from "../core/item-origin.ts";
import { TITLE_LINK_TYPE } from "../core/link-types.ts";
import {
  type ClientGroups,
  type Ctx,
  type Found,
  mergeReads,
  pageToken,
  pageTokenValue,
  type ReadSet,
} from "../core/read-ctx.ts";
import { parsed, type ReadTool } from "../core/read-tool.ts";
import { type AliasRow, served, servedJson } from "../core/served.ts";
import { NAMES_SHOWN, PERSON_OR_ORG, RECORD_ID, RELEASE_IN_FORCE, sourceProbed } from "../core/visibility.ts";
import { readBeliefInputs } from "../pipeline/belief-inputs.ts";
import { beliefRelations } from "./about-relations.ts";
import { OWNER_ENTITY } from "./read-beliefs.ts";
import { passageOf, servedField, servedText } from "./read-fact-rows.ts";
import { groupWho } from "./read-group-who.ts";
import { loadGroups } from "./read-groups.ts";
import { lapsedOwnerSide } from "./read-lapse.ts";
import { normalized } from "./read-search.ts";
import { mailOf } from "./read-tools.ts";
import { personHead } from "./read-tools-entity.ts";

// `about`, one call for the whole picture of a person or an organization, in the call's one
// repeatable-read snapshot, as of `asOf`. The subject is
// resolved within the caller's clearance; every fact key of its identity group's claims is
// computed by `beliefAt` from the rows the token returns; the claims in no belief, the
// open commitments both ways and a person's head parts follow. Every statement reads only rows the
// token returns, so nothing a viewer cannot see changes a count, an order or a word of the answer
// (invariant 6). No name, address or value is logged.

const areas = repoFile("ontology/areas.json", (text) => AreaTable.parse(JSON.parse(text)));

// policy.belief_inputs takes at most this many fact keys a call.
const INPUTS_MAX = 1000;
// The claims about the subject read for those in no belief, newest first (a known limit: a
// subject named in more is served the newest this many give).
const UNBELIEVED_SCAN = 2000;
const CANDIDATES_MAX = 20;
// The areas of get_entity's card: its head's current role and affiliation and the tie to the
// owner, few enough for the card to render within get_entity's deadline (800 ms, mcp/deadlines.ts). Measured by `measure-about`;
// provisional.
export const GET_ENTITY_AREAS: readonly Area[] = Object.freeze(["work", "ties"]);

// The people an address names, by its keyed fingerprint.
const BY_ADDRESS = `
  select distinct a.entity_id from knowledge.accounts a
  where a.value_fp = $1
  order by a.entity_id`;

// Every visible alias, to match a name in memory, as search's CANDIDATE_NAMES reads them.
const NAME_ROWS = `
  with names as materialized (
    select s.entity_id, s.value_fp, s.id, s.compartments, s.value_enc
    from knowledge.aliases s
  )
  select distinct on (names.entity_id, names.value_fp) names.entity_id, names.id, names.compartments, names.value_enc
  from names
  order by names.entity_id, names.value_fp, names.id`;

// Which of these are people the token shows.
const PEOPLE = `
  select e.id from knowledge.entities e
  where e.id = any($1) and e.kind = 'person'
  order by e.id`;

// Which of these entities the token shows, the owner's among them.
const VISIBLE = `
  select e.id from knowledge.entities e
  where e.id = any($1)
  order by e.id`;

// The fact keys of the claims naming the subject's members, first known by `asOf`.
const SUBJECT_KEYS = `
  select distinct c.fact_key_fp from knowledge.claims c
  where c.id in (select n.claim_id from knowledge.claim_entities n where n.entity_id = any($1))
    and c.first_known_at <= $2::timestamptz
  order by c.fact_key_fp`;

// find_facts' source rule (read-facts.ts, FIND_FACTS): a claim is
// cited or listed only when the token returns its source, a message that is not held, a document
// that is not held, a page or a capture item, or, from none of those, when it is released, is an
// unflagged agent record's the token returns, or is a claim of one of the owner's own saved
// contacts. pi_reader's row policies hide held and restricting rows, so a held item's claim fails.
const SOURCE_VISIBLE = sourceProbed(["message", "document", "page", "capture"], ["released", "record", "contact"]);

// Where a claim's source stands for the caller: a message it may read, a held one, an agent record
// it may read. A claim find_facts would not return (its source not one the token returns, its
// release not in force, or naming someone the token does not show) finds no row.
const SOURCE_COLUMNS = `
    exists (select 1 from knowledge.messages m where m.evidence_id = c.evidence_id and not m.held) as message,
    exists (select 1 from knowledge.messages m where m.evidence_id = c.evidence_id and m.held) as held,
    ${RECORD_ID} as record_id`;

const SUPPORT_ROWS = `
  select c.id, c.evidence_id, c.fact_key_fp, ${SOURCE_COLUMNS}
  from knowledge.claims c
  where c.id = any($1) and ${SOURCE_VISIBLE} and ${RELEASE_IN_FORCE} and ${NAMES_SHOWN}
  order by c.id`;

// The claims naming the subject's members, first known by `asOf`, newest first,
// for those in no belief.
const SUBJECT_CLAIMS = `
  select c.id, c.evidence_id, c.fact_key_fp, c.type, c.valid_from, c.compartments, c.content_enc, ${SOURCE_COLUMNS},
    exists (select 1 from knowledge.captures k where k.evidence_id = c.evidence_id and k.agent_app) as agent_app
  from knowledge.claims c
  where c.id in (select n.claim_id from knowledge.claim_entities n where n.entity_id = any($1))
    and c.first_known_at <= $2::timestamptz and ${SOURCE_VISIBLE} and ${RELEASE_IN_FORCE} and ${NAMES_SHOWN}
    and c.type <> '${TITLE_LINK_TYPE}' and not (c.id = any($3::text[]))
  order by c.valid_from desc, c.id
  limit ${UNBELIEVED_SCAN}`;

type Source = { message: boolean; held: boolean; record_id: string | null };
type SupportRow = Source & { id: string; evidence_id: string; fact_key_fp: string };
type ClaimRow = SupportRow & {
  type: string;
  valid_from: Date;
  compartments: string[];
  content_enc: Envelope;
  agent_app: boolean;
};

// `next`: the time the first page was computed as of, and the page asked. Issued by the server and
// opaque; read back, it pages the same snapshot time, never another subject's rows.
const tokenOf = (asOf: string, page: number): string => pageToken([asOf, page]);

function pageOf(text: string): { asOf: string; page: number } | null {
  const value = pageTokenValue(text);
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [asOf, page] = value as unknown[];
  if (typeof asOf !== "string" || Number.isNaN(Date.parse(asOf)) || new Date(asOf).toISOString() !== asOf) return null;
  if (!Number.isInteger(page) || (page as number) < 1 || (page as number) > 10_000) return null;
  return { asOf, page: page as number };
}

type Resolved =
  | { kind: "subject"; id: string; subjectKind: SubjectKind; members: string[] }
  | { kind: "candidates"; candidates: AboutCandidate[] }
  | { kind: "unknown" };

// An id or an exact address resolves with certainty; a name to the one person, by identity group,
// whose visible alias it is, or to the candidates when several. Within the caller's clearance:
// every row read is one the token returns.
export async function resolveSubject(ctx: Ctx, groups: ClientGroups, subject: SubjectRef): Promise<Resolved> {
  if ("id" in subject) {
    const [entity] = await ctx.run<{ id: string; kind: SubjectKind }>(PERSON_OR_ORG, [subject.id]);
    if (entity === undefined) return { kind: "unknown" };
    if (entity.kind === "organization")
      return { kind: "subject", id: entity.id, subjectKind: "organization", members: [entity.id] };
    return { kind: "subject", id: groups.idOf(entity.id), subjectKind: "person", members: groups.membersOf(entity.id) };
  }
  if ("address" in subject) {
    const address = normalizeAddress(subject.address);
    if (address === null) return { kind: "unknown" };
    const named = (await ctx.run<{ entity_id: string }>(BY_ADDRESS, [fingerprint(ctx.keys, "address", address)])).map(
      (row) => row.entity_id,
    );
    return pick(ctx, groups, await peopleIn(ctx, named), () => "address");
  }
  const query = normalized(subject.name);
  const rows = await ctx.run<AliasRow & { entity_id: string }>(NAME_ROWS, []);
  const matches = (row: AliasRow): boolean =>
    normalized(served(ctx, row, "knowledge.aliases.value_enc").untrusted) === query;
  const named = [...new Set(rows.filter(matches).map((row) => row.entity_id))];
  return pick(ctx, groups, await peopleIn(ctx, named), (name) =>
    name !== null && normalized(name) === query ? "name" : "alias",
  );
}

const peopleIn = async (ctx: Ctx, ids: string[]): Promise<string[]> =>
  (await ctx.run<{ id: string }>(PEOPLE, [ids])).map((row) => row.id);

// The people matched, one per identity group: none is unknown, one is the subject, several are
// the candidates, by id, at most CANDIDATES_MAX, each with its name and why it matched.
async function pick(
  ctx: Ctx,
  groups: ClientGroups,
  people: readonly string[],
  matched: (name: string | null) => AboutCandidate["matched"],
): Promise<Resolved> {
  const ids = [...new Set(people.map((one) => groups.idOf(one)))].sort();
  const [only] = ids;
  if (only === undefined) return { kind: "unknown" };
  if (ids.length === 1) return { kind: "subject", id: only, subjectKind: "person", members: groups.membersOf(only) };
  const listed = ids.slice(0, CANDIDATES_MAX);
  const who = await groupWho(ctx, groups, listed);
  const candidates = listed.map((id): AboutCandidate => {
    const name = who.get(id)?.name ?? null;
    return { id: id as EntityId, kind: "person", name, matched: matched(name?.untrusted ?? null) };
  });
  return { kind: "candidates", candidates };
}

// The areas asked, as the kinds and domains they keep; null for all (the default).
function areaFilter(asked: readonly Area[] | undefined): { kinds: Set<string>; domains: Set<string> | null } | null {
  if (asked === undefined) return null;
  const table = areas();
  const kinds = new Set(asked.flatMap((area) => table.areas[area].kinds));
  const scoped = asked.map((area) => table.areas[area].domains);
  // A domain bound holds only when every area asked has one: an area without one keeps any domain.
  const domains = scoped.every((one) => one !== undefined) ? new Set(scoped.flatMap((one) => one ?? [])) : null;
  return { kinds, domains };
}

const keeps = (filter: ReturnType<typeof areaFilter>, kind: string | undefined, domain: unknown): boolean =>
  filter === null ||
  (kind !== undefined &&
    filter.kinds.has(kind) &&
    (filter.domains === null || typeof domain !== "string" || filter.domains.has(domain)));

const byNewest = <T extends { at: string; fact: string }>(a: T, b: T): number =>
  byText(b.at, a.at) || byText(a.fact, b.fact);

// A claim's place in its source, as get_evidence_span reads it: a span of its own evidence's text,
// for a message the caller may read or an agent record. Any other source has none here.
function spanOf(claim: { evidence: { evidenceId: string; span: string }[] }, row: SupportRow): CitedClaim["span"] {
  if (!row.message && row.record_id === null) return null;
  return passageOf(claim.evidence.find((passage) => passage.evidenceId === row.evidence_id)?.span);
}

// What a cited claim showed: its message's evidence id, or a finding's agent record by its id
// (no `bound` entry of the read log is ever an agent record's). `opened`: its text was served.
const servedBy = (row: SupportRow, read: { bound: Set<string>; shown: Set<string> }, opened: boolean): void => {
  if (!row.message && row.record_id !== null) read.shown.add(row.record_id);
  else (opened ? read.bound : read.shown).add(row.evidence_id);
};

// Every belief of the subject's members' fact keys, computed by `beliefAt` under the clearance, and
// each input claim by its id.
// With them, the relations each read applied, as the build applies them (readRelations).
async function beliefRecordsOf(ctx: Ctx, members: string[], clearance: readonly string[], asOf: string) {
  const keys = (await ctx.run<{ fact_key_fp: string }>(SUBJECT_KEYS, [members, asOf])).map((row) => row.fact_key_fp);
  const records: BeliefRecord[] = [];
  const claimsById = new Map<string, BeliefClaim>();
  const applied: ReadRelation[] = [];
  for (let start = 0; start < keys.length; start += INPUTS_MAX) {
    const some = keys.slice(start, start + INPUTS_MAX);
    const inputs = await readBeliefInputs((text, values = []) => ctx.run(text, values), ctx.keys, some, asOf);
    const claims = inputs.groups.flatMap((group) => group.claims);
    for (const one of claims) claimsById.set(one.claim.id, one);
    records.push(...beliefAt(inputs, clearance, some, asOf));
    applied.push(...readRelations(claims, inputs.relations ?? [], inputs.switches ?? [], clearance, asOf));
  }
  return { records, claimsById, applied };
}

// A supporting claim as it is cited, by find_facts' rules. In the support of a belief the caller's
// clearance builds, an agent record's claim, or the owner's question, counts as confirmed only when
// the owner confirmed it (beliefGroupsOf); one kept by the owner's standing release takes the
// granted-release tier.
function citedOf(one: BeliefClaim, row: SupportRow, knows: (entity: string) => boolean): CitedClaim {
  const { claim } = one;
  const tier = claimTierOf({
    origin: one.origin as TierSignals["origin"],
    pipelineVersion: claim.pipelineVersion,
    basis: claim.basis,
    ownerSaid: one.ownerSaid === true,
    ownLine: one.ownLine === true,
    confirmed: one.origin === "agent_record" || one.ownerConfirmed === true,
    notice: one.notice === true,
    granted: one.granted === true,
  });
  const speaker = claim.assertedBy !== undefined && knows(claim.assertedBy) ? EntityId.parse(claim.assertedBy) : null;
  return { fact: row.id, speaker, at: claim.validFrom, span: spanOf(claim, row), tier };
}

type Cited = { cited: CitedClaim; row: SupportRow };

const counterpartyOf = (record: BeliefRecord): unknown => record.belief.values.counterparty;

// What a call reads the subject's claims for: its members, the snapshot time, the areas asked, the
// owner's entity and who the token shows.
type AboutScope = Readonly<{
  members: readonly string[];
  asOf: string;
  filter: ReturnType<typeof areaFilter>;
  ownerId: string | undefined;
  knows: (entity: string) => boolean;
}>;

// One belief as `about` serves it: its slice of support, and as canonical the claim that phrases it,
// else its newest cite.
function beliefAtOf(
  record: BeliefRecord,
  cited: readonly Cited[],
  served: readonly Cited[],
  at: { dormant: boolean; phraseFact: string | undefined; asOf: string; relations: BeliefAt["relations"] },
): BeliefAt {
  const { belief } = record;
  const phrase = at.phraseFact === undefined ? undefined : cited.find((one) => one.row.id === at.phraseFact);
  return {
    kind: belief.kind,
    factKey: record.factKeyFp,
    value: belief.values,
    status: at.dormant ? "dormant" : belief.status,
    tier: record.tier ?? "source",
    provenance: record.provenance,
    disputed: belief.disputed,
    // How the value was chosen: an applied `prevails`, or an agent's settlement.
    settledBy: record.settled?.by ?? null,
    ...(record.unsupported === true ? { unsupported: true } : {}),
    independentSources: new Set(cited.map((one) => one.row.evidence_id)).size,
    canonical: (phrase ?? (cited[0] as Cited)).cited.fact,
    support: served.map((one) => one.cited),
    supportCount: cited.length,
    relations: at.relations,
    asOf: at.asOf,
  };
}

// The claims about the subject in no belief the clearance builds, newest first, each with its own type
// and fields, each field by the kind the commit wrote beside it (text from evidence is untrusted).
// Those in a belief are left out in the statement, so the scan's bound holds claims in no belief
// alone. A claim of an agent record the token returns is an agent's, whatever its sealed origin
// says, and an agent app's moment is agent output, unconfirmed (`agent_inferred`), whatever its basis
// says.
async function unbelievedOf(ctx: Ctx, scope: AboutScope, supported: ReadonlySet<string>) {
  const unbelieved: { claim: UnbelievedClaim; row: ClaimRow }[] = [];
  for (const row of await ctx.run<ClaimRow>(SUBJECT_CLAIMS, [scope.members, scope.asOf, [...supported]])) {
    if (supported.has(row.id) || row.held) continue;
    const parsed = ClaimRecord.safeParse(servedJson(ctx, row, "knowledge.claims.content_enc"));
    if (!parsed.success) continue;
    const record = asItemSays(parsed.data, { agent_item: !row.message && row.record_id !== null, typed: false });
    const { claim } = record;
    if (!scope.members.includes(claim.content.subject)) continue;
    if (!keeps(scope.filter, PERSONAL_ONTOLOGY.get(claim.content.type)?.beliefKind, claim.content.fields.domain))
      continue;
    const ownerSaid = claim.assertedBy !== undefined && claim.assertedBy === scope.ownerId;
    const tier =
      row.agent_app && !ownerSaid
        ? "agent_inferred"
        : claimTierOf({
            origin: record.origin as TierSignals["origin"],
            pipelineVersion: claim.pipelineVersion,
            basis: claim.basis,
            ownerSaid,
            ownLine: row.agent_app && ownerSaid,
            confirmed: false,
            notice: isSystemNotice(record),
          });
    const fields = Object.fromEntries(
      Object.entries(claim.content.fields).flatMap(([field, value]): [string, unknown][] => {
        if (value === undefined || value === null) return [];
        if (record.fieldKinds[field] === "text")
          return [[servedField(row.type, field), { untrusted: servedText(String(value)) }]];
        return [[field, value]];
      }),
    );
    const speaker =
      claim.assertedBy !== undefined && (scope.knows(claim.assertedBy) || scope.members.includes(claim.assertedBy))
        ? EntityId.parse(claim.assertedBy)
        : null;
    const at = stamp(row.valid_from);
    unbelieved.push({
      claim: { fact: row.id, speaker, at, span: spanOf(claim, row), tier, type: row.type, fields },
      row,
    });
  }
  return unbelieved;
}

const emptyAbout = (asOf: string): Omit<AboutView, "subject" | "candidates"> => ({
  beliefs: [],
  claims: [],
  claimCount: 0,
  commitments: [],
  toOwner: null,
  connections: [],
  links: [],
  knownVia: null,
  mail: mailOf(undefined),
  lastMeeting: null,
  nextMeeting: null,
  warmth: null,
  asOf,
  next: null,
});

export async function readAbout(
  ctx: Ctx,
  args: AboutArgs,
  clearance: readonly string[],
  now: Date,
): Promise<Found<AboutView> | "invalid_request" | "subject_unknown"> {
  // The snapshot time and the slice of support and claims served, from the page token and `asOf`.
  const token = args.after === undefined ? null : pageOf(args.after);
  if (args.after !== undefined && token === null) return "invalid_request";
  const given = args.asOf === undefined ? undefined : new Date(args.asOf).toISOString();
  if (token !== null && given !== undefined && given !== token.asOf) return "invalid_request";
  const asOf = token?.asOf ?? given ?? now.toISOString();
  if (Date.parse(asOf) > now.getTime()) return "invalid_request";
  const page = token?.page ?? 0;
  const [from, to] = [page * SUPPORT_INLINE, (page + 1) * SUPPORT_INLINE];

  const groups = await loadGroups(ctx);
  const resolved = await resolveSubject(ctx, groups, args.subject);
  if (resolved.kind === "unknown") return "subject_unknown";
  if (resolved.kind === "candidates") {
    return {
      value: { subject: null, candidates: resolved.candidates, ...emptyAbout(asOf) },
      rows: resolved.candidates.length,
      read: { bound: [], shown: [], factKeyFps: [] },
    };
  }
  const { id, subjectKind, members } = resolved;
  const ownerId = (await ctx.run<{ id: string }>(OWNER_ENTITY, []))[0]?.id;
  const found = await beliefRecordsOf(ctx, members, clearance, asOf);
  const { records, claimsById } = found;
  const applied = [...new Map(found.applied.map((one) => [one.id, one])).values()];
  const isMember = (value: unknown): boolean => typeof value === "string" && members.includes(value);
  const about = records.filter(
    (record) =>
      isMember(record.belief.subject) ||
      (record.belief.kind === "commitment" && record.belief.subject === ownerId && isMember(counterpartyOf(record))),
  );

  // Each supporting claim the caller may be cited: by its stored id, find_facts' rules.
  const rowId = (claimId: string): string => fingerprint(ctx.keys, "claim", claimId);
  // A relation's other claim may be in no served belief's support: one a `supersedes` took out.
  const relationEnds = applied.flatMap((one) => [...one.fromIds, ...one.toIds]);
  const supportIds = [...new Set([...about.flatMap((record) => record.belief.support), ...relationEnds].map(rowId))];
  const sources = new Map((await ctx.run<SupportRow>(SUPPORT_ROWS, [supportIds])).map((row) => [row.id, row]));
  const entityValues = (record: BeliefRecord): string[] => [
    record.belief.subject,
    ...Object.values(record.belief.values).filter((value): value is string => EntityId.safeParse(value).success),
  ];
  const speakers = [...claimsById.values()].flatMap((one) =>
    one.claim.assertedBy === undefined ? [] : [one.claim.assertedBy],
  );
  const named = [...new Set([...about.flatMap(entityValues), ...speakers])];
  const known = new Set((await ctx.run<{ id: string }>(VISIBLE, [named])).map((row) => row.id));
  const knows = (entity: string): boolean => known.has(entity) || entity === ownerId;
  const scope: AboutScope = { members, asOf, filter: areaFilter(args.areas), ownerId, knows };
  const cite = (claimId: string): Cited | null => {
    const row = sources.get(rowId(claimId));
    const one = claimsById.get(claimId);
    if (row === undefined || one === undefined || row.held) return null;
    return { cited: citedOf(one, row, knows), row };
  };

  const read = { bound: new Set<string>(), shown: new Set<string>(), factKeyFps: new Set<string>() };
  const beliefs: BeliefAt[] = [];
  const commitments: AboutCommitment[] = [];
  const until = new Date(asOf);
  // The one rule, as get_commitments reads it.
  const lapsed = await lapsedOwnerSide(
    ctx,
    about.map(({ belief, factKeyFp }) => ({
      row: { id: factKeyFp, fact_key_fp: factKeyFp, support: belief.support.map(rowId) },
      belief: belief as unknown as Belief,
    })),
    ownerId,
    until,
  );
  let more = false;
  for (const record of [...about].sort((a, b) => byText(a.factKeyFp, b.factKeyFp))) {
    const { belief } = record;
    if (!keeps(scope.filter, belief.kind, belief.values.domain)) continue;
    // A belief whose subject or value names someone the token does not show is not served, nor one
    // none of whose claims the caller may be cited (get_entity's rule).
    if (!entityValues(record).every(knows)) continue;
    const cited = belief.support.flatMap((claimId) => cite(claimId) ?? []).sort((a, b) => byNewest(a.cited, b.cited));
    if (cited.length === 0) continue;
    const served = cited.slice(from, to);
    for (const one of served) servedBy(one.row, read, false);
    read.factKeyFps.add(record.factKeyFp);
    if (cited.length > to) more = true;
    const dormant =
      OPEN_BELIEF_STATUS.has(belief.status) &&
      (lapsed.has(record.factKeyFp) ||
        (ownerId !== undefined && thirdPartyLapsed(belief, (one) => one === ownerId, until)));
    const phraseFact = record.phraseClaim === undefined ? undefined : rowId(record.phraseClaim);
    const relations = beliefRelations(applied, belief.support, (claimId) => cite(claimId)?.cited.fact ?? null);
    beliefs.push(beliefAtOf(record, cited, served, { dormant, phraseFact, asOf, relations }));
    if (belief.kind === "commitment" && OPEN_BELIEF_STATUS.has(belief.status) && !lapsed.has(record.factKeyFp)) {
      const direction = directionOf(belief.subject, counterpartyOf(record), ownerId);
      if (direction !== null) commitments.push({ factKey: record.factKeyFp, direction });
    }
  }

  // The claims about the subject in no belief, cited the same way, `agent_inferred` among them.
  const unbelieved = await unbelievedOf(ctx, scope, new Set(records.flatMap((one) => one.belief.support.map(rowId))));
  const claims = unbelieved.slice(from, to);
  for (const one of claims) {
    servedBy(one.row, read, true);
    read.factKeyFps.add(one.row.fact_key_fp);
  }
  if (unbelieved.length > to) more = true;

  // A person's head: the parts get_entity reads for them, as of `asOf`. Areas narrow the beliefs
  // and the claims; the head is served whole.
  const head = subjectKind === "person" ? await personHead(ctx, groups, id, members, new Date(asOf)) : null;
  const [who] = [...(await groupWho(ctx, groups, [id])).values()];
  const headRead: ReadSet = head === null ? { bound: [], shown: [], factKeyFps: [] } : head.read;
  const view: AboutView = {
    subject: { id: id as EntityId, kind: subjectKind, name: who?.name ?? null },
    candidates: [],
    beliefs,
    claims: claims.map((one) => one.claim),
    claimCount: unbelieved.length,
    commitments,
    toOwner: head?.toOwner ?? null,
    connections: head?.connections ?? [],
    links: head?.links ?? [],
    knownVia: head?.knownVia ?? null,
    mail: head?.mail ?? mailOf(undefined),
    lastMeeting: head?.lastMeeting ?? null,
    nextMeeting: head?.nextMeeting ?? null,
    warmth: head?.warmth ?? null,
    asOf,
    next: more ? tokenOf(asOf, page + 1) : null,
  };
  return {
    value: view,
    rows: beliefs.length + claims.length,
    read: mergeReads({ bound: [...read.bound], shown: [...read.shown], factKeyFps: [...read.factKeyFps] }, headRead),
  };
}

// One person or organization, every belief computed as of `asOf` under the caller's clearance,
// view `people`: a list tool.
export const ABOUT_TOOL: ReadTool<AboutArgs, AboutView> = {
  tool: "about",
  parse: (args) => parsed(AboutArgs.safeParse(args)),
  work: (ctx, valid, client, env) => readAbout(ctx, valid, client.compartments, env.now()),
};
