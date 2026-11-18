import type { Envelope } from "@intelligence/contracts";
// find_facts' reads: the viewer that turns claim rows into FactViews, find_facts and its belief
// mode, the declassified copies, search's match mode and the mirror's fact views.

import type { Belief, BeliefStatus } from "@intelligence/contracts";
import {
  type ClaimRecord,
  channelled,
  claimTierOf,
  type EntityId,
  type FactList,
  FactView,
  FindFactsArgs,
  isSystemNotice,
  keyPhraseOf,
  PERSON_PROPOSAL_TYPES,
  type PersonalView,
  type SearchArgs,
  type SearchResult,
  VIEW_OF_SUBJECT,
  type Who,
} from "@intelligence/contracts/personal";
import {
  byMatch,
  isMatchSide,
  MATCH_SIDES,
  type MatchMode,
  matchScore,
  matchWords,
  type StoredCommitment,
  thirdPartyLapsed,
} from "@intelligence/personal-core/views";
import { stamp } from "../core/db.ts";
import { claimKey } from "../core/fingerprint.ts";
import { asItemSays } from "../core/item-origin.ts";
import { LINK_TYPES } from "../core/link-types.ts";
import type { Found } from "../core/read-ctx.ts";
import { agentRecordIds, type Ctx, type Sealed, Unavailable } from "../core/read-ctx.ts";
import { parsed, type ReadTool, timed } from "../core/read-tool.ts";
import { type AccountRow, parseOr, served, servedJson } from "../core/served.ts";
import { zonedBounds } from "../core/zone.ts";
import { asOfOf, beliefsAt, type ComputedRow } from "./computed-beliefs.ts";
import { AGENT_ORIGINS, factSourceOf } from "./fact-source.ts";
import { OWNER_ENTITY, segmentOf } from "./read-beliefs.ts";
import {
  BELIEF_FACTS,
  binds,
  type CopyRow,
  claimRecordOf,
  DECLASSIFIED_FACTS,
  FACT_ENTITY,
  type FactRow,
  type FactsRead,
  FIND_FACTS,
  FIND_FACTS_UNRECORDED,
  OWNER,
  PROJECTS_NAMED,
  passageOf,
  projectRowWho,
  seconds,
  servedField,
  servedText,
  VALID_TO_TYPES,
} from "./read-fact-rows.ts";
import { loadGroups } from "./read-groups.ts";
import { lapsedOwnerSide } from "./read-lapse.ts";
import { whoOf } from "./read-who.ts";

const FACTS_DEFAULT = 20;

export const projectWhos = async (ctx: Ctx, statement: string, ids: string[]): Promise<Map<string, Who>> =>
  new Map(
    (await ctx.run<Sealed & { name_enc: Envelope }>(statement, [ids])).map((row) => [row.id, projectRowWho(ctx, row)]),
  );

// A belief as the viewer reads it: its row's id, fact key and support, and the belief.
type Known = { row: Pick<ComputedRow, "id" | "fact_key_fp" | "support">; belief: Belief };

// The claims of these rows, opened, and what turns each into its FactView: the owner's account
// and every person or organization they or `extra` name, each one fixed statement.
export async function factViewer(
  ctx: Ctx,
  page: FactRow[],
  {
    extra = [],
    ownerId,
    given = new Map(),
    computed = [],
    tierOnly = false,
    audience,
  }: {
    extra?: string[];
    // The owner's entity when the caller found it, as get_self does: known even when none of the
    // owner's accounts is visible.
    ownerId?: string | undefined;
    // Who the caller already read, a project: whoOf reads people and organizations alone.
    given?: ReadonlyMap<string, Who> | undefined;
    // The beliefs the caller already computed, which are not computed again.
    computed?: readonly Known[];
    // Only the beliefs a claim's tier reads (an agent record's or the owner's question), for a
    // caller that serves no status.
    tierOnly?: boolean;
    // The owner's audience, for a read as pi_admin (the owner's page); a client's is its token's.
    audience?: readonly string[] | undefined;
  } = {},
): Promise<{
  records: ClaimRecord[];
  whoIs: (id: unknown, record?: ClaimRecord) => Who;
  shows: (record: ClaimRecord) => boolean;
  knows: (id: string) => boolean;
  view: (row: FactRow, record: ClaimRecord, status?: BeliefStatus) => FactView;
  beliefs: ReadonlyMap<string, Known>;
  statusNow: (own: Known, at: Date | undefined, lapsed: ReadonlyMap<string, string>) => BeliefStatus;
  lapsedAt: (at: Date | undefined) => Promise<ReadonlyMap<string, string>>;
}> {
  const records = page.map((row) => claimRecordOf(ctx, row));
  const [ownerRow] = await ctx.run<AccountRow & { entity_id: string }>(OWNER, []);
  // The belief of each claim's fact key under the caller's clearance, computed here so that every
  // tool decides a claim's tier from the same beliefs: find_facts' status reads it too.
  const beliefs = new Map(computed.map((one) => [one.row.fact_key_fp, one]));
  const asked = page.filter((_row, index) => !tierOnly || readsSupport(records[index] as ClaimRecord));
  const missing = [...new Set(asked.map((row) => row.fact_key_fp))].filter((key) => !beliefs.has(key));
  for (const one of await beliefsAt(ctx, missing, await asOfOf(ctx), { audience }))
    beliefs.set(one.row.fact_key_fp, one);
  const confirmedPeople = await confirmedPeopleOf(ctx, page, records);
  const named = records.flatMap(namesOf);
  const who = await whoOf(ctx, [...new Set([...named, ...extra])], { fixed: true });
  const ownerAddress = ownerRow === undefined ? null : served(ctx, ownerRow, "knowledge.accounts.value_enc");

  // The owner is known by the owner's account, or as a subject the record says is the owner.
  const isOwner = (id: string): boolean => id === ownerRow?.entity_id || (ownerId !== undefined && id === ownerId);
  const whoIs = (id: unknown, record?: ClaimRecord): Who => {
    if (typeof id !== "string") throw new Unavailable();
    if (isOwner(id) || (record?.subjectKind === "owner" && id === record.claim.content.subject)) {
      return { id: id as EntityId, kind: "owner", name: null, address: ownerAddress };
    }
    const one = who.get(id) ?? given.get(id);
    if (one === undefined) throw new Unavailable();
    return { ...one };
  };
  // Whether the token shows this entity, the owner by the owner's account.
  const knows = (id: string): boolean => isOwner(id) || who.has(id) || given.has(id);
  const known = (id: string, record: ClaimRecord): boolean =>
    knows(id) || (record.subjectKind === "owner" && id === record.claim.content.subject);
  // Whether every entity a record names is one the token shows (find_facts' FIND_FACTS asks the same
  // of the database).
  const shows = (record: ClaimRecord): boolean => namesOf(record).every((id) => known(id, record));
  const view = (row: FactRow, record: ClaimRecord, status?: BeliefStatus): FactView => {
    const { claim } = record;
    // A claim of an agent app's moment is agent output, unconfirmed: served as agent-reported at
    // `agent_inferred`, whatever its basis says. Its project link is code's, and a claim code
    // credited to the owner is the owner's own prompt line, served as their word, with a mark of
    // its own so it never reads as any chat's.
    const agentAppClaim = row.capture_agent_app === true && !LINK_TYPES.includes(row.type);
    const ownersWord = claim.assertedBy !== undefined && isOwner(claim.assertedBy);
    const agentOutput = agentAppClaim && !ownersWord;
    const ownersChatLine = agentAppClaim && ownersWord;
    const tier = agentOutput
      ? "agent_inferred"
      : tierOf(row, record, {
          inSupport: beliefs.get(row.fact_key_fp)?.row.support.includes(row.id) === true,
          ownerSaid: ownersWord,
          ownLine: ownersChatLine,
          confirmedPerson: confirmedPeople.has(row.id),
        });
    const channel = record.origin === "agent_record" && channelled(claim) ? (row.record_client ?? null) : null;
    return {
      id: row.id,
      type: row.type,
      subject: whoIs(claim.content.subject, record),
      statedBy: claim.assertedBy === undefined ? null : whoIs(claim.assertedBy, record),
      basis: claim.basis,
      statementKind: claim.statementKind,
      at: stamp(row.valid_from),
      message: row.document_id === null ? row.message_id : null,
      ...(row.message_id === null && row.document_id === null && (row.record_id ?? null) !== null
        ? { record: row.record_id }
        : {}),
      document: row.document_id,
      passage: row.document_id === null ? null : passageOf(claim.evidence[0]?.span),
      page: pageOf(ctx, row),
      capture: row.capture_id ?? null,
      segment: (row.capture_id ?? null) === null ? null : segmentOf(claim.evidence[0]?.span),
      thirdParty: record.disclosure.includes("third_party"),
      // An agent's close is the agent's word too.
      agentReported: AGENT_ORIGINS.has(record.origin) || agentOutput,
      provenance: AGENT_ORIGINS.has(record.origin) || agentOutput ? "agent_reported" : "source",
      tier,
      source: factSourceOf(row, record.origin),
      ...(channel === null ? {} : { channel }),
      ...(ownersChatLine ? { sourceMark: "agent_chat" as const } : {}),
      ...(status === undefined ? {} : { status }),
      // A type with an `until` serves it also as its validTo.
      ...(claim.validTo !== undefined && VALID_TO_TYPES.has(row.type) ? { validTo: claim.validTo } : {}),
      fields: servedFields(row, record, whoIs),
    } as FactView;
  };
  // A belief's status as served: a commitment with the owner on neither side lapses at this read, since
  // nobody closes it and it is on no list of what is owed.
  const statusNow = (own: Known, at: Date | undefined, lapsed: ReadonlyMap<string, string>): BeliefStatus => {
    const stored = own.belief as unknown as StoredCommitment;
    const { status } = own.belief;
    const ownerKnown = ownerRow !== undefined || ownerId !== undefined;
    return at !== undefined &&
      ownerKnown &&
      status !== "closed" &&
      status !== "expired" &&
      (lapsed.has(own.row.id) || thirdPartyLapsed(stored, isOwner, at))
      ? "dormant"
      : status;
  };
  // Those of these beliefs with the owner on one side that have lapsed, by get_commitments' rule.
  const lapsedAt = async (at: Date | undefined): Promise<ReadonlyMap<string, string>> =>
    at === undefined ? new Map() : lapsedOwnerSide(ctx, [...beliefs.values()], ownerId ?? ownerRow?.entity_id, at);
  return { records, whoIs, shows, knows, view, beliefs, statusNow, lapsedAt };
}

// Whether a claim's tier reads the caller's belief of its fact key (tierOf's `inSupport`).
const readsSupport = (record: ClaimRecord): boolean =>
  record.origin === "agent_record" || (record.subjectKind === "owner" && record.claim.statementKind === "question");

// Every entity a record names.
const namesOf = (record: ClaimRecord): string[] => [
  record.claim.content.subject,
  ...(record.claim.assertedBy === undefined ? [] : [record.claim.assertedBy]),
  ...Object.entries(record.claim.content.fields).flatMap(([field, value]) =>
    record.fieldKinds[field] === "entity" && typeof value === "string" ? [value] : [],
  ),
];

// The page's claims built from a propose_person record that the owner confirmed. Such a claim
// builds no belief, so its confirm is asked by its claim key (its card's request id) of
// policy.confirmed_claims, for the page's own rows alone and only when it holds one; a released
// one is confirmed by its release in force, the only way it is served.
async function confirmedPeopleOf(ctx: Ctx, page: FactRow[], records: ClaimRecord[]): Promise<Set<string>> {
  const asked = page.flatMap((row, i) => {
    const record = records[i];
    return PERSON_PROPOSAL_TYPES.includes(row.type) &&
      record?.origin === "agent_record" &&
      record.released === undefined
      ? [[row.id, claimKey(ctx.keys, row.evidence_id, row.fact_key_fp)] as const]
      : [];
  });
  const confirmedKeys =
    asked.length === 0
      ? new Set<string>()
      : new Set(
          (
            await ctx.run<{ key: string }>("select k as key from policy.confirmed_claims($1) as k", [
              asked.map(([, key]) => key),
            ])
          ).map((row) => row.key),
        );
  return new Set(asked.filter(([, key]) => confirmedKeys.has(key)).map(([id]) => id));
}

// Each field by the kind the commit wrote beside it: text from evidence is untrusted, an entity is
// a Who, and a number, a date or a code is as it was written. An owner-side kind's key phrase is
// served as its `what`.
function servedFields(
  row: FactRow,
  record: ClaimRecord,
  whoIs: (id: unknown, record?: ClaimRecord) => Who,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record.claim.content.fields).flatMap(([field, value]) => {
      if (value === undefined || value === null) return [];
      const kind = record.fieldKinds[field];
      if (kind === undefined) throw new Unavailable();
      if (kind === "entity") return [[field, whoIs(value, record)]];
      if (kind === "text") {
        if (typeof value !== "string") throw new Unavailable();
        return [[servedField(row.type, field), { untrusted: servedText(value) }]];
      }
      return [[field, value]];
    }),
  );
}

// A claim's tier from what code set on it. An agent record's claim, or the owner's question, is
// confirmed when it is in the support of the caller's own belief (`inSupport`), which the belief
// build gives it only then (pipeline.ts beliefClaims: the owner's card or question; a flagged record
// has no claim); the owner's word by the owner's entity as its speaker. Read from the belief rows,
// never from `status`, which a tool may leave out. A type that builds no belief is confirmed by its
// release in force, the only way a released claim is served (RELEASE_IN_FORCE).
function tierOf(
  row: FactRow,
  record: ClaimRecord,
  at: { inSupport: boolean; ownerSaid: boolean; ownLine: boolean; confirmedPerson: boolean },
): ReturnType<typeof claimTierOf> {
  const { claim } = record;
  // A finding's claim is an agent's, whatever its sealed origin says.
  const fromAgent = row.message_id === null && row.document_id === null && (row.record_id ?? null) !== null;
  return claimTierOf({
    origin: asItemSays(record, { agent_item: fromAgent, typed: false }).origin,
    pipelineVersion: claim.pipelineVersion,
    basis: claim.basis,
    ownerSaid: at.ownerSaid,
    ownLine: at.ownLine,
    // A system notice's claim, by its record's mark.
    notice: isSystemNotice(record),
    confirmed:
      (at.inSupport &&
        (record.origin === "agent_record" || (record.subjectKind === "owner" && claim.statementKind === "question"))) ||
      (record.released !== undefined && PERSON_PROPOSAL_TYPES.includes(row.type)) ||
      at.confirmedPerson,
    // A released claim the owner's standing release made.
    granted: record.released?.grant === true,
  });
}

// The page's FactViews, each with the status of the caller's own belief when the fact is in its
// support, the projects its claims name read first.
async function statusedViews(
  ctx: Ctx,
  page: FactRow[],
  now: Date | undefined,
  ownerId?: string,
  known: readonly Known[] = [],
): Promise<FactView[]> {
  const projects = await projectWhos(
    ctx,
    PROJECTS_NAMED,
    page.map((row) => row.id),
  );
  const { records, view, beliefs, statusNow, lapsedAt } = await factViewer(ctx, page, {
    ownerId,
    given: projects,
    computed: known,
  });
  const lapsed = await lapsedAt(now);
  return page.map((row, index): FactView => {
    const own = beliefs.get(row.fact_key_fp);
    const status = own?.row.support.includes(row.id) === true ? statusNow(own, now, lapsed) : undefined;
    return view(row, records[index] as ClaimRecord, status);
  });
}

// A page fact's page, its URL opened under the call's keys and served
// as untrusted text.
function pageOf(ctx: Ctx, row: FactRow): FactView["page"] {
  if (row.page_id === undefined || row.page_id === null || row.fetched_at === undefined || row.fetched_at === null)
    return null;
  const { url } = servedJson(
    ctx,
    { id: row.page_id, compartments: row.page_compartments ?? [], page_enc: row.page_enc },
    "knowledge.pages.page_enc",
  ) as { url?: unknown };
  if (typeof url !== "string") throw new Unavailable();
  return { id: row.page_id, url: { untrusted: url }, fetchedAt: stamp(row.fetched_at) };
}

// The later of two facts in find_facts' order: newest first, then by the fact's id.
const before = (a: { at: number; id: string }, b: { at: number; id: string }): boolean =>
  a.at > b.at || (a.at === b.at && a.id < b.id);

export async function findFacts(
  ctx: Ctx,
  args: FindFactsArgs,
  now?: Date,
  unrecorded = false,
): Promise<(Found<FactList> & { read: FactsRead }) | null> {
  if (args.entity !== undefined && (await ctx.run(FACT_ENTITY, [args.entity])).length === 0) return null;
  const { rowOf: _rowOf, ...found } = await factsOf(ctx, args, { ...(now === undefined ? {} : { now }), unrecorded });
  return found;
}

// find_facts' `belief`, a line's fact. The
// belief of that fact key computed under the caller's clearance; then each claim of its support
// that FIND_FACTS would return, by the same terms, read by id, newest first, one more than
// `limit`. Null when the caller's clearance builds no such belief.

async function beliefFactsOf(
  ctx: Ctx,
  belief: string,
  limit = FACTS_DEFAULT,
  now?: Date,
): Promise<(Found<FactList> & { read: FactsRead }) | null> {
  const computed = await beliefsAt(ctx, [belief], await asOfOf(ctx));
  const own = computed.find((one) => one.row.fact_key_fp === belief);
  if (own === undefined) return null;
  const page = await ctx.run<FactRow>(BELIEF_FACTS, [own.row.support, limit + 1]);
  const kept = page.slice(0, limit);
  const facts = await statusedViews(ctx, kept, now, undefined, computed);
  return {
    value: { facts, more: page.length > limit },
    rows: facts.length,
    // As find_facts logs its facts: a message's, a page's, a capture item's and a contact's evidence
    // bound, a finding's record shown by its own id, and each fact's fact key.
    read: {
      bound: [...new Set(kept.filter(binds).map((one) => one.evidence_id))],
      shown: [...new Set(facts.flatMap((fact) => agentRecordIds(fact.record)))],
      factKeyFps: [...new Set(kept.map((one) => one.fact_key_fp))],
    },
  };
}

// find_facts after its entity check: the facts of the window, newest first, at most `limit`.
// get_timeline reads an entity's facts by it, after its own check, with the owner's entity
// it read, so a fact naming the owner opens even when none of the owner's accounts is visible, and the
// entity's group's members it read, so the rulings are read once.
export async function factsOf(
  ctx: Ctx,
  args: FindFactsArgs,
  // `unrecorded`: only the claims no agent record carries.
  options: { ownerId?: string; members?: readonly string[]; now?: Date; unrecorded?: boolean } = {},
): Promise<
  Found<FactList> & { read: FactsRead; rowOf: ReadonlyMap<string, { evidenceId: string | null; factKeyFp: string }> }
> {
  const limit = args.limit ?? FACTS_DEFAULT;
  const members =
    args.entity === undefined ? null : (options.members ?? (await loadGroups(ctx)).membersOf(args.entity));
  const rows = await ctx.run<FactRow>(options.unrecorded === true ? FIND_FACTS_UNRECORDED : FIND_FACTS, [
    args.type ?? null,
    members,
    seconds(args.from),
    seconds(args.to),
    limit + 1,
  ]);
  // The declassified copies, only for a call whose keys hold
  // `declassified` (a client's keys are those of its clearance) and that names no entity.
  const found = new Set(rows.map((row) => row.id));
  const copies = (
    args.entity === undefined && ctx.keys.compartments.has("declassified")
      ? await ctx.run<CopyRow>(DECLASSIFIED_FACTS, [args.type ?? null, seconds(args.from), seconds(args.to), limit + 1])
      : []
  ).filter((copy) => !found.has(copy.claim_fp));

  const merged: ({ claim: FactRow } | { copy: CopyRow })[] = [];
  let c = 0;
  let d = 0;
  while (merged.length < limit && (c < rows.length || d < copies.length)) {
    const claim = rows[c];
    const copy = copies[d];
    if (
      copy === undefined ||
      (claim !== undefined &&
        before({ at: claim.valid_from.getTime(), id: claim.id }, { at: copy.valid_from.getTime(), id: copy.claim_fp }))
    ) {
      merged.push({ claim: claim as FactRow });
      c += 1;
    } else {
      merged.push({ copy });
      d += 1;
    }
  }
  const page = merged.flatMap((one) => ("claim" in one ? [one.claim] : []));
  const views = await statusedViews(ctx, page, options.now, options.ownerId);

  // Each copy, opened under the call's keys: the fact it holds is its claim's.
  const opened = new Map(
    merged.flatMap((one) => {
      if (!("copy" in one)) return [];
      const fact = parseOr(
        FactView.safeParse(
          servedJson(
            ctx,
            { id: one.copy.id, compartments: one.copy.compartments, fact_enc: one.copy.fact_enc },
            "projections.declassified_facts.fact_enc",
          ),
        ),
      );
      if (fact.id !== one.copy.claim_fp) throw new Unavailable();
      return [[one.copy.id, fact] as const];
    }),
  );
  let v = 0;
  const facts = merged.map((one) =>
    "claim" in one ? (views[v++] as FactView) : (opened.get(one.copy.id) as FactView),
  );
  // A page's fact binds its page as a message's does (a request filed after it is tainted when the
  // page is deleted), a capture item's its item, and a contact's its contact.
  const bound = merged.flatMap((one) =>
    "claim" in one ? (binds(one.claim) ? [one.claim.evidence_id] : []) : [one.copy.evidence_id],
  );

  return {
    value: { facts, more: rows.length + copies.length > limit },
    rows: facts.length,
    // A finding's words are an agent record's: no `bound` entry is ever one (the read log table),
    // so its fact adds its fact key, and its record is shown by its own id. A declassified copy's
    // claim is never a finding's.
    read: {
      bound: [...new Set(bound)],
      shown: [...new Set(facts.flatMap((fact) => agentRecordIds(fact.record)))],
      factKeyFps: [...new Set(page.map((row) => row.fact_key_fp))],
    },
    // Each fact's evidence id where it binds one, as find_facts binds it, else null, and its fact
    // key: what a caller that keeps some of the facts logs of them. A copy is not here: a call
    // that names an entity reads none.
    rowOf: new Map(
      page.map((row) => [row.id, { evidenceId: binds(row) ? row.evidence_id : null, factKeyFp: row.fact_key_fp }]),
    ),
  };
}

// search's match mode: the newest 2 000 claims of the mode's side the token returns, by
// find_facts' own statement, each opened; a reversal or a system message's claim left out (core's
// isMatchSide), and one whose subject's view the client lacks. Each is scored by its own
// `what` slice against the query, in core, and the scored ordered by score, then newest, then id.
// No count across rows: a claim the caller cannot see changes no score, order or `more`.

const MATCH_SCAN = 2000;
const MATCH_DEFAULT = 25;

export async function matchesOf(
  ctx: Ctx,
  args: SearchArgs & { mode: MatchMode },
  views: readonly PersonalView[],
): Promise<Found<SearchResult> & { read: FactsRead }> {
  const [owner] = await ctx.run<{ id: string }>(OWNER_ENTITY, []);
  const rows = await ctx.run<FactRow>(FIND_FACTS, [MATCH_SIDES[args.mode], null, null, null, MATCH_SCAN + 1]);
  const query = matchWords(args.query);
  const hits = rows.slice(0, MATCH_SCAN).flatMap((row) => {
    const record = claimRecordOf(ctx, row);
    if (!isMatchSide(record.claim)) return [];
    const what = keyPhraseOf(record.claim.content.type, record.claim.content.fields);
    const score = what === undefined ? 0 : matchScore(query, servedText(what));
    return score === 0 ? [] : [{ row, score }];
  });
  const { records, view } = await factViewer(
    ctx,
    hits.map(({ row }) => row),
    { ownerId: owner?.id, tierOnly: true },
  );
  const scored = hits.flatMap(({ row, score }, index) => {
    const fact = view(row, records[index] as ClaimRecord);
    if (!views.includes(VIEW_OF_SUBJECT[fact.subject.kind])) return [];
    return [{ id: row.id, at: fact.at, score, fact, row }];
  });
  scored.sort(byMatch);
  const limit = args.limit ?? MATCH_DEFAULT;
  const kept = scored.slice(0, limit);
  return {
    value: {
      results: [],
      matches: kept.map(({ fact, score }) => ({ fact, score })),
      more: scored.length > limit || rows.length > MATCH_SCAN,
    },
    rows: kept.length,
    // Each match's message was opened, as find_facts opens it: bound, with its fact key.
    read: {
      bound: [...new Set(kept.flatMap(({ row }) => (row.message_id === null ? [] : [row.evidence_id])))],
      shown: [],
      factKeyFps: [...new Set(kept.map(({ row }) => row.fact_key_fp))],
    },
  };
}

// find_facts' `belief` takes `limit` alone; with any other filter the call is refused
// as any other bad argument.
const believed = (args: FindFactsArgs | null): FindFactsArgs | null =>
  args === null ||
  args.belief === undefined ||
  (args.type === undefined && args.entity === undefined && args.from === undefined && args.to === undefined)
    ? args
    : null;

export const FIND_FACTS_TOOL: ReadTool<FindFactsArgs, FactList> = {
  tool: "find_facts",
  parse: (args) => believed(timed(parsed(FindFactsArgs.safeParse(args)))),
  // With `belief`, every claim behind a line's belief the token returns.
  work: async (ctx, valid, _client, env) =>
    valid.belief === undefined
      ? findFacts(ctx, await zonedBounds(ctx, valid), env.now())
      : beliefFactsOf(ctx, valid.belief, valid.limit, env.now()),
};
