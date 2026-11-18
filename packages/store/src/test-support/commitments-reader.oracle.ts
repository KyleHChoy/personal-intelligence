// Today's get_commitments read, kept verbatim as the oracle of the commitments parity test:
// read-beliefs.ts's commitmentsOf and what it calls, before the owner's
// read was merged onto it. Deleted once the parity test passes on the box's shape of data.
import type { Belief } from "@intelligence/contracts";
import {
  type AgentRecordId,
  type CaptureId,
  type ClientName,
  type CommitmentEnding,
  CommitmentItem,
  dayIn,
  type FactSource,
  type GetCommitmentsArgs,
  keyPhraseOf,
  type MessageId,
  OPEN_BELIEF_STATUS,
  type RulingId,
  startOfDay,
} from "@intelligence/contracts/personal";
import { DAY_MS } from "@intelligence/personal-core";
import type { WorkCommitment } from "@intelligence/personal-core/lens";
import { COURTESY_DAYS, dueLapsed, lapseDayOf, lastStood, remarkDays } from "@intelligence/personal-core/views";
import { directionOf, dueOf, isChatRemark } from "../core/commitment-rules.ts";
import { byText } from "../core/db.ts";
import type { Sealed } from "../core/seal.ts";
import { parseOr } from "../core/served.ts";
import { RELEASE_IN_FORCE } from "../core/visibility.ts";
import { believedLinks, linkOf, workViews } from "../core/work-time-read.ts";
import { ownerTimeZone } from "../core/zone.ts";
import { asOfOf, type ComputedRow, everyBelief, supportsOf } from "../read/computed-beliefs.ts";
import { factSourceOf } from "../read/fact-source.ts";
import { itemClaims } from "../read/matcher-claims.ts";
import type { Ctx, ReadSet } from "../read/read-ctx.ts";
import { claimRecordOf, servedText } from "../read/read-fact-rows.ts";
import { whoOf } from "../read/read-who.ts";

// get_commitments' work, and a version 2 pack's commitments. Every statement runs under the
// caller's token: the beliefs are the caller's audience's alone, and the claims and messages those
// its clearance covers. Due dates and parties are sealed inside each belief, so every belief of the
// audience is read and opened, and the filters and the order are made in memory, over all of them.
// The statements sent depend only on how many pages the audience fills.

// The ceiling of beliefs read: 5 000. Every belief is computed when asked, under the caller's
// clearance, newest supporting claim first (computed-beliefs.ts everyBelief).
const CEILING = 5000;
const _DEFAULT_LIMIT = 20;

// The ids among $1 that the caller sees through a row, but that every reader
// withholds: a person with no person's account it sees, or one holding an address of the owner's,
// or one the owner's ignore list covers (policy.entity_withheld). The answer only takes away.
const WITHHELD = `
  select k.id from unnest($1::text[]) as k (id)
  where policy.entity_withheld(k.id)
  order by k.id`;

// The owner's entity, among the rows the token shows.
const OWNER_ENTITY = `
  select e.id from knowledge.entities e
  where e.kind = 'owner'
  order by e.id`;

// The kept beliefs' supporting claims, latest first: each belief's first is its latest. A released
// claim only while its release is in force: its row stays under `own` until the next rebuild, and
// its statement kind and time would otherwise still move a commitment to closed, or date its close.
const CLAIMS = `
  select c.id, c.evidence_id, c.compartments, c.content_enc, c.valid_from
  from knowledge.claims c
  where c.id = any($1) and ${RELEASE_IN_FORCE}
  order by c.valid_from desc, c.id`;

// The messages of the latest claims. The reader's row policy returns no held one.
const MESSAGES = `
  select m.id, m.evidence_id
  from knowledge.messages m
  where m.evidence_id = any($1)
  order by m.id`;

const CAPTURES = `
  select k.id, k.evidence_id, k.kind, k.source
  from knowledge.captures k
  where k.evidence_id = any($1)
  order by k.id`;

type BeliefRow = ComputedRow;
type ClaimRow = { id: string; evidence_id: string; compartments: string[]; content_enc: Sealed; valid_from: Date };

type CommitmentQuery = {
  direction?: GetCommitmentsArgs["direction"];
  // The other party is one of these.
  with?: readonly string[];
  state: NonNullable<GetCommitmentsArgs["state"]>;
  limit: number;
  // Every source belief before every agent-reported one, each then in step 5's order,
  // before the limit. A pack's commitments section asks for it (its template's `source_first`);
  // get_commitments does not.
  sourceFirst?: boolean;
  // Work time: the read's clock, for a closed commitment's worked-on minutes; without it none is
  // computed.
  now?: Date;
  // The moment a lapse is read against (lapsedCommitments): a commitment past it is not open: `open`
  // leaves it out and `closed` holds it, its status as its belief says. get_commitments, open items and context
  // pass it, and a commitments section of a pack or of the memory sync does when its template says `lapse: courtesy`.
  lapseAt?: Date;
};

// The items, whether more matched than were kept or the ceiling stopped the reading, and the
// read set: each kept belief's fact, and each message whose text gave a `what`, as bound.
// `evidenceOf` maps each message, and each capture item, that gave a `what` to its
// evidence id.
type Commitments = {
  commitments: CommitmentItem[];
  more: boolean;
  evidenceOf: ReadonlyMap<string, string>;
  read: ReadSet;
};

const SEGMENT = /^seg:(\d{1,9})-(\d{1,9})$/;
const segmentOf = (span: string | undefined): { from: number; to: number } | null => {
  const match = SEGMENT.exec(span ?? "");
  return match === null ? null : { from: Number(match[1]), to: Number(match[2]) };
};

// A due date as an instant to order by: a day is its first moment in the owner's zone, UTC's while
// the owner has set none.
const dueAt = (due: string | null, zone: string | null): number =>
  due === null ? Number.POSITIVE_INFINITY : due.length === 10 ? startOfDay(due, zone) : new Date(due).getTime();

// One commitment with the owner on one side: its row, its opened belief, its direction, the other
// party and its due date.
type OpenCommitment = {
  row: BeliefRow;
  belief: Belief;
  direction: CommitmentItem["direction"];
  other: string | null;
  due: string | null;
  // The first day it was no longer open, when it lapsed.
  lapsed?: string;
};

// Every belief of the caller's audience, page by page in one snapshot, each opened, whether the
// ceiling stopped the reading (at most PAGES pages), whether it took more than one page (under
// read committed it may then not be one snapshot), and the owner's entity: what commitmentsOf,
// get_self's stated facts and find_paths read (steps 2 and 3). A pack that
// needs both commitments and facts reads them once.
type AudienceBeliefs = {
  rows: BeliefRow[];
  beliefs: Belief[];
  ceiling: boolean;
  partial: boolean;
  owner: string | undefined;
};

// What a read that needs the audience's beliefs is handed: the reading a call already made, or
// "fresh", said at the call, for a read of its own of up to BELIEF_SCAN rows.
type AudienceRead = AudienceBeliefs | "fresh";
const beliefsIn = async (ctx: Ctx, read: AudienceRead): Promise<AudienceBeliefs> =>
  read === "fresh" ? audienceBeliefs(ctx) : read;

async function audienceBeliefs(ctx: Ctx): Promise<AudienceBeliefs> {
  const { beliefs: kept, cut } = await everyBelief(ctx, await asOfOf(ctx), CEILING);
  const [owner] = await ctx.run<{ id: string }>(OWNER_ENTITY, []);
  return {
    rows: kept.map((one) => one.row),
    beliefs: kept.map((one) => one.belief),
    ceiling: cut,
    partial: false,
    owner: owner?.id,
  };
}

// Steps 2 to 5 of commitmentsOf, which the memory sync calls too: every commitment of the
// caller's audience that matches, in step 5's order, with no limit. `ceiling` says the reading
// stopped at 5 000 beliefs; `partial` that it took more than one page.
async function openCommitments(
  ctx: Ctx,
  query: Omit<CommitmentQuery, "limit">,
  read: AudienceRead,
): Promise<{ matched: OpenCommitment[]; ceiling: boolean; partial: boolean }> {
  // Steps 2 and 3: every belief of the audience, and the owner.
  const { rows, beliefs, ceiling, partial, owner: ownerId } = await beliefsIn(ctx, read);
  const owner = ownerId === undefined ? undefined : { id: ownerId };

  // Step 4: commitments with the owner on one side, then the filters.
  const matched: OpenCommitment[] = [];
  beliefs.forEach((belief, index) => {
    if (owner === undefined || belief.kind !== "commitment") return;
    const counterparty = typeof belief.values.counterparty === "string" ? belief.values.counterparty : null;
    const direction = directionOf(belief.subject, counterparty, owner.id);
    if (direction === null) return;
    const other = direction === "owed_by_owner" ? counterparty : belief.subject;
    if (query.direction !== undefined && query.direction !== direction) return;
    if (query.with !== undefined && (other === null || !query.with.includes(other))) return;
    const due = dueOf(belief.values);
    matched.push({ row: rows[index] as BeliefRow, belief, direction, other, due });
  });
  // One with someone the caller cannot see at all is served, with no counterparty. Before the state
  // filter below, which copies the list, so every state leaves them out.
  const others = [...new Set(matched.flatMap((one) => (one.other === null ? [] : [one.other])))];
  const withheld = new Set(
    others.length === 0 ? [] : (await ctx.run<{ id: string }>(WITHHELD, [others])).map((row) => row.id),
  );
  if (withheld.size > 0)
    matched.splice(0, matched.length, ...matched.filter((one) => one.other === null || !withheld.has(one.other)));

  const zone = await ownerTimeZone(ctx);
  const lapsed =
    query.lapseAt === undefined
      ? new Map<string, string>()
      : await lapsedCommitments(ctx, matched, query.lapseAt, zone);
  for (const one of matched) {
    const day = lapsed.get(one.row.id);
    if (day !== undefined) one.lapsed = day;
  }
  const kept =
    query.state === "any"
      ? matched
      : matched.filter(
          (one) => (OPEN_BELIEF_STATUS.has(one.belief.status) && !lapsed.has(one.row.id)) === (query.state === "open"),
        );

  // Step 5: by due date, undated last, then by fact, a day the owner's.
  const agentLast = (one: OpenCommitment): number =>
    query.sourceFirst === true && one.row.provenance === "agent_reported" ? 1 : 0;
  kept.sort(
    (a, b) =>
      agentLast(a) - agentLast(b) ||
      dueAt(a.due, zone) - dueAt(b.due, zone) ||
      byText(a.row.fact_key_fp, b.row.fact_key_fp),
  );
  return { matched: kept, ceiling, partial };
}

// The rows given whose latest supporting claim the token returns came from a chat and sits on no project:
// an undated remark's mark. A capture or a binding under a label the caller cannot see moves nothing here.
type RemarkInput = { row: Pick<BeliefRow, "id" | "support" | "fact_key_fp"> };
const CHAT_CAPTURES = `
  select k.evidence_id from knowledge.captures k
  where k.evidence_id = any($1) and k.source is not null
  order by k.evidence_id`;
const BOUND_CLAIMS = `
  select distinct b.claim_id from knowledge.project_bindings b
  where b.claim_id = any($1::text[]) and b.undone_at is null
  order by b.claim_id`;

function latestClaims(found: readonly RemarkInput[], claims: readonly ClaimRow[]): Map<string, ClaimRow> {
  const place = new Map(claims.map((claim, index) => [claim.id, index]));
  return new Map(
    found.flatMap((one) => {
      const [first] = one.row.support
        .filter((id) => place.has(id))
        .sort((a, b) => (place.get(a) as number) - (place.get(b) as number));
      return first === undefined ? [] : [[one.row.id, claims[place.get(first) as number] as ClaimRow] as const];
    }),
  );
}

async function remarksAmong(
  ctx: Ctx,
  found: readonly RemarkInput[],
  latest: ReadonlyMap<string, ClaimRow>,
): Promise<Set<string>> {
  const evidence = [...new Set([...latest.values()].map((claim) => claim.evidence_id))];
  const chats = new Set(
    (await ctx.run<{ evidence_id: string }>(CHAT_CAPTURES, [evidence])).map((row) => row.evidence_id),
  );
  const bound = new Set(
    (await ctx.run<{ claim_id: string }>(BOUND_CLAIMS, [[...new Set(found.flatMap((one) => one.row.support))]])).map(
      (row) => row.claim_id,
    ),
  );
  return new Set(
    found.flatMap((one) => {
      const claim = latest.get(one.row.id);
      return isChatRemark(claim?.evidence_id, one.row.support, chats, bound) ? [one.row.id] : [];
    }),
  );
}

// The open commitments of `found` that have lapsed at `at`. A dated one, more than DUE_LAPSE_DAYS past
// its date, its last confirming or the owner's reopen in the owner's zone, whatever kind of statement.
// An undated courtesy: last confirmed more than COURTESY_DAYS before, and a latest supporting claim, of
// those the token returns, whose statement kind is a proposal. An undated chat remark: past `remarkDays`
// of its direction, unless it sits on a project. One statement reads the candidates' supporting claims,
// newest first; only each candidate's latest is opened. A candidate none of whose claims the token
// returns stays open.
async function lapsedCommitments(
  ctx: Ctx,
  found: readonly (Pick<OpenCommitment, "belief" | "due" | "direction"> & {
    row: Pick<BeliefRow, "id" | "support" | "fact_key_fp">;
  })[],
  at: Date,
  zone: string | null,
): Promise<Map<string, string>> {
  const olderThan = (stood: string, days: number): boolean => Date.parse(stood) < at.getTime() - days * DAY_MS;
  const open = found.filter(
    (one) =>
      OPEN_BELIEF_STATUS.has(one.belief.status) &&
      (one.due === null
        ? olderThan(one.belief.lastConfirmedAt, remarkDays(one.direction))
        : dueLapsed(one.due, one.belief.lastConfirmedAt, at, zone)),
  );
  if (open.length === 0) return new Map();
  // The owner's reopen outranks a lapse: it starts the clock again.
  const reopened = reopenedAtOf(
    await ctx.run<{ fact_fp: string; at: string }>(OWNER_REOPENS, [open.map((one) => one.row.fact_key_fp)]),
  );
  const stood = (one: (typeof open)[number]): string =>
    lastStood(one.belief.lastConfirmedAt, reopened.get(one.row.fact_key_fp));
  const lapsed = new Map(
    open
      .filter((one) => one.due !== null && dueLapsed(one.due, stood(one), at, zone))
      .map((one) => [one.row.id, lapseDayOf(one.due, stood(one), zone) as string]),
  );
  const candidates = open.filter((one) => one.due === null && olderThan(stood(one), remarkDays(one.direction)));
  if (candidates.length === 0) return lapsed;
  const claims = await ctx.run<ClaimRow>(CLAIMS, [[...new Set(candidates.flatMap((one) => one.row.support))]]);
  const latest = latestClaims(candidates, claims);
  const remarks = await remarksAmong(ctx, candidates, latest);
  for (const one of candidates) {
    if (remarks.has(one.row.id)) {
      const day = lapseDayOf(null, stood(one), zone, remarkDays(one.direction)) as string;
      const today = dayIn(at, zone);
      lapsed.set(one.row.id, day > today ? today : day);
      continue;
    }
    const claim = latest.get(one.row.id);
    if (claim === undefined || !olderThan(stood(one), COURTESY_DAYS)) continue;
    const record = claimRecordOf(ctx, claim);
    if (record.claim.statementKind === "proposal") lapsed.set(one.row.id, lapseDayOf(null, stood(one), zone) as string);
  }
  return lapsed;
}

export async function oracleCommitmentsOf(ctx: Ctx, query: CommitmentQuery, given: AudienceRead): Promise<Commitments> {
  // The audience's beliefs, read once: work time's matcher reads every commitment of them.
  const read = await beliefsIn(ctx, given);
  // Steps 2 to 5, then the first `limit` kept.
  const { matched, ceiling } = await openCommitments(ctx, query, read);
  const kept = matched.slice(0, query.limit);
  const more = matched.length > query.limit || ceiling;

  // Step 6: the kept beliefs' latest claims, their messages, and their counterparties.
  const claims = await ctx.run<ClaimRow>(CLAIMS, [[...new Set(kept.flatMap((one) => one.row.support))]]);
  const place = new Map(claims.map((claim, index) => [claim.id, index]));
  const latest = kept.map((one) => {
    const supporting = one.row.support
      .filter((id) => place.has(id))
      .sort((a, b) => (place.get(a) as number) - (place.get(b) as number));
    return supporting[0] === undefined ? undefined : claims[place.get(supporting[0]) as number];
  });
  const evidenceIds = [...new Set(latest.flatMap((claim) => (claim === undefined ? [] : [claim.evidence_id])))];
  const messages = await ctx.run<{ id: MessageId; evidence_id: string }>(MESSAGES, [evidenceIds]);
  const messageOf = new Map(messages.map((message) => [message.evidence_id, message.id]));
  const captures = await ctx.run<{ id: CaptureId; evidence_id: string; kind: string; source: string | null }>(
    CAPTURES,
    [evidenceIds],
  );
  const captureOf = new Map(captures.map((capture) => [capture.evidence_id, capture]));
  const who = await whoOf(ctx, [...new Set(kept.flatMap((one) => (one.other === null ? [] : [one.other])))], {
    fixed: true,
  });
  const { done, bound } = await doneTimes(ctx, kept, read, query.now);

  const evidenceOf = new Map<string, string>();
  const commitments = kept.map((one, index): CommitmentItem => {
    const claim = latest[index];
    const message = claim === undefined ? undefined : messageOf.get(claim.evidence_id);
    const captureRow = claim === undefined || message !== undefined ? undefined : captureOf.get(claim.evidence_id);
    const capture = captureRow?.id;
    let what: CommitmentItem["what"] = null;
    let segment: CommitmentItem["segment"] = null;
    let source: FactSource | undefined;
    // A claim is opened only when its message, or its capture item, came back: a held message's is
    // not.
    if (claim !== undefined && (message !== undefined || capture !== undefined)) {
      const record = claimRecordOf(ctx, claim);
      const text = keyPhraseOf(record.claim.content.type, record.claim.content.fields);
      if (text !== undefined) what = { untrusted: servedText(text) };
      if (capture !== undefined) segment = segmentOf(record.claim.evidence[0]?.span);
      // Only from the rows this token got back.
      source = factSourceOf(
        {
          message_id: message ?? null,
          document_id: null,
          capture_id: capture ?? null,
          capture_kind: captureRow?.kind ?? null,
          capture_source: captureRow?.source ?? null,
        },
        record.origin,
      );
      evidenceOf.set(message ?? (capture as string), claim.evidence_id);
    }
    const counterparty = one.other === null ? undefined : who.get(one.other);
    return parseOr(
      CommitmentItem.safeParse({
        ...(one.lapsed === undefined ? {} : { lapsed: one.lapsed }),
        belief: {
          fact: one.row.fact_key_fp,
          state: one.row.state_fp,
          kind: one.belief.kind,
          type: one.belief.type,
          status: one.belief.status,
          disputed: one.belief.disputed,
          provenance: one.row.provenance,
          tier: one.row.tier,
          ...(one.row.group_fp === null ? {} : { group: one.row.group_fp }),
          confirmedAt: one.belief.lastConfirmedAt,
          reviewAfter: one.belief.reviewAfter ?? null,
        },
        direction: one.direction,
        counterparty: counterparty === undefined ? null : { ...counterparty },
        due: one.due,
        what,
        message: message ?? null,
        capture: capture ?? null,
        segment,
        ...(source === undefined ? {} : { source }),
        // Work time: a closed commitment's done fields; null for any other.
        ...(done.get(one.row.id) ?? { closedAt: null, doneAt: null, doneBy: null, workedOn: null }),
      }),
    );
  });

  // Work time: a served doneBy id is bound as its commitment's message or capture item is.
  for (const [id, evidence] of bound) evidenceOf.set(id, evidence);
  // Step 7: the read set. A message, or a capture item, whose text gave a `what` is bound.
  return {
    commitments,
    more,
    evidenceOf,
    read: {
      bound: [...new Set(evidenceOf.values())],
      shown: [],
      factKeyFps: commitments.map((one) => one.belief.fact),
    },
  };
}

// Work time. For a closed commitment: `closedAt`, the time of the latest supporting claim the token returns
// whose statement kind is a reversal, the claim that closed it; null when none is visible, and for one not
// closed (a lapsed courtesy, an expired one). `doneAt` and `doneBy` only when that claim came from a message
// (its sent time), the owner's answer to a system question, or a meeting line credited to the owner
// (explicit_self, which a meeting makes only under consent): never from a moment. Said closed, not kept.
// `workedOn`, the advisory matcher's minutes on its targets (the projects bound to its supporting claims and
// those of the capture items they came from), gathered once for every commitment the call serves. And who
// closed it, `closedBy`, with the close's `ending`: an agent by its close claim (policy.commitment_closes
// gives the close's id, its writer and its ending; doneAt and doneBy stay null, since an agent's word is
// never the owner's), the owner by their own close in force (policy.owner_commitment_closes: the owner's
// time, so doneAt and doneBy are theirs), which comes first, or a source's reversal.
type Done = Pick<CommitmentItem, "closedAt" | "doneAt" | "doneBy" | "workedOn" | "closedBy" | "ending">;
const AGENT_CLOSES = "select evidence_id, close_id, client_name, ending from policy.commitment_closes($1::text[])";
const OWNER_CLOSES =
  "select fact_fp, decision_id, ending, at from policy.owner_commitment_closes($1::text[]) where ending <> 'reopened'";
// The owner's reopens of the facts given, newest first for each.
const OWNER_REOPENS = "select fact_fp, at from policy.owner_commitment_closes($1::text[]) where ending = 'reopened'";
const reopenedAtOf = (rows: readonly { fact_fp: string; at: string }[]): Map<string, string> => {
  const newest = new Map<string, string>();
  for (const row of rows) if (!newest.has(row.fact_fp)) newest.set(row.fact_fp, row.at);
  return newest;
};
const DONE_EVIDENCE = `
  select e.id, (select m.id from knowledge.messages m where m.evidence_id = e.id) as message_id,
    (select k.id from knowledge.captures k where k.evidence_id = e.id) as capture_id,
    (select k.kind from knowledge.captures k where k.evidence_id = e.id) as capture_kind,
    (select w.id from ledger.agent_writes w where w.evidence_id = e.id and w.kind = 'answer') as answer_id
  from unnest($1::text[]) as e (id)
  order by e.id`;
const TARGETS = `
  select c.id as claim_id, b.project_id from knowledge.claims c join knowledge.project_bindings b on b.claim_id = c.id and b.undone_at is null where c.id = any($1) and ${RELEASE_IN_FORCE}
  union
  select c.id as claim_id, n.entity_id as project_id from knowledge.claims c
    join knowledge.captures k on k.evidence_id = c.evidence_id
    join knowledge.claims l on l.evidence_id = k.evidence_id
    join knowledge.claim_entities n on n.claim_id = l.id
    join knowledge.projects p on p.id = n.entity_id
  where c.id = any($1) and ${RELEASE_IN_FORCE} and ${linkOf("l", "$2")}
  order by claim_id, project_id`;
const TITLE_CANDIDATES = `
  select distinct l.id, l.type, l.fact_key_fp from knowledge.claims c
    join knowledge.captures k on k.evidence_id = c.evidence_id
    join knowledge.claims l on l.evidence_id = k.evidence_id
  where c.id = any($1) and ${RELEASE_IN_FORCE} and l.type = 'capture.project'
  order by l.id, l.type, l.fact_key_fp`;
const CLAIM_TIMES = `select c.id, c.valid_from from knowledge.claims c where c.id = any($1) and ${RELEASE_IN_FORCE} order by c.id`;

// `bound`: each served doneBy id's evidence, bound in the call's read set as a commitment's `message`
// or `capture` is.
async function doneTimes(
  ctx: Ctx,
  kept: readonly OpenCommitment[],
  read: AudienceBeliefs,
  now: Date | undefined,
): Promise<{ done: Map<string, Done>; bound: Map<string, string> }> {
  const done = new Map<string, Done>();
  const bound = new Map<string, string>();
  const closed = kept.filter((one) => one.belief.status === "closed");
  if (closed.length === 0) return { done, bound };
  const claims = await ctx.run<ClaimRow>(CLAIMS, [[...new Set(closed.flatMap((one) => one.row.support))]]);
  const evidence = [...new Set(claims.map((claim) => claim.evidence_id))];
  const sources = new Map(
    (
      await ctx.run<{
        id: string;
        message_id: string | null;
        capture_id: string | null;
        capture_kind: string | null;
        answer_id: string | null;
      }>(DONE_EVIDENCE, [evidence])
    ).map((row) => [row.id, row]),
  );
  const closes = new Map(
    (
      await ctx.run<{ evidence_id: string; close_id: string; client_name: string; ending: string }>(AGENT_CLOSES, [
        evidence,
      ])
    ).map((row) => [row.evidence_id, row]),
  );
  const owners = new Map<string, { decision_id: string; ending: string; at: string }>();
  for (const row of await ctx.run<{ fact_fp: string; decision_id: string; ending: string; at: string }>(OWNER_CLOSES, [
    closed.map((one) => one.row.fact_key_fp),
  ])) {
    if (!owners.has(row.fact_fp)) owners.set(row.fact_fp, row);
  }
  const shown = (claim: ClaimRow): boolean => {
    const source = sources.get(claim.evidence_id);
    return (
      closes.has(claim.evidence_id) ||
      (source !== undefined && (source.message_id !== null || source.capture_id !== null || source.answer_id !== null))
    );
  };
  for (const one of closed) {
    done.set(one.row.id, { closedAt: null, doneAt: null, doneBy: null, workedOn: null, closedBy: null, ending: null });
    // The owner's own close in force decides who closed it.
    const owner = owners.get(one.row.fact_key_fp);
    if (owner !== undefined) {
      const at = new Date(owner.at).toISOString();
      done.set(one.row.id, {
        closedAt: at,
        doneAt: at,
        doneBy: { close: owner.decision_id as RulingId },
        workedOn: null,
        closedBy: { owner: true, close: owner.decision_id as RulingId },
        ending: owner.ending as CommitmentEnding,
      });
      continue;
    }
    // Claims arrive latest first: the first visible reversal closed it.
    for (const claim of claims) {
      if (!one.row.support.includes(claim.id) || !shown(claim)) continue;
      const record = claimRecordOf(ctx, claim);
      if (record.claim.statementKind !== "reversal") continue;
      const at = claim.valid_from.toISOString();
      // An agent's close: who and how, never the owner's done time.
      const agentClose = closes.get(claim.evidence_id);
      if (agentClose !== undefined) {
        done.set(one.row.id, {
          closedAt: at,
          doneAt: null,
          doneBy: null,
          workedOn: null,
          closedBy: { agent: agentClose.client_name as ClientName, close: agentClose.close_id as AgentRecordId },
          ending: agentClose.ending as CommitmentEnding,
        });
        break;
      }
      const source = sources.get(claim.evidence_id);
      const segment = segmentOf(record.claim.evidence[0]?.span);
      let doneBy: Done["doneBy"] = null;
      if (source?.message_id != null) doneBy = { message: source.message_id as MessageId };
      else if (source?.answer_id != null) doneBy = { answer: source.answer_id as AgentRecordId };
      else if (
        source?.capture_id != null &&
        source.capture_kind === "meeting" &&
        segment !== null &&
        record.claim.basis === "explicit_self" &&
        read.owner !== undefined &&
        record.claim.assertedBy === read.owner
      )
        doneBy = { capture: source.capture_id as CaptureId, segment: segment.from };
      done.set(one.row.id, {
        closedAt: at,
        doneAt: doneBy === null ? null : at,
        doneBy,
        workedOn: null,
        closedBy: { source: true },
        ending: null,
      });
      const named =
        doneBy === null
          ? null
          : "message" in doneBy
            ? doneBy.message
            : "answer" in doneBy
              ? doneBy.answer
              : "capture" in doneBy
                ? doneBy.capture
                : null;
      if (named !== null) bound.set(String(named), claim.evidence_id);
      break;
    }
  }
  if (now === undefined) return { done, bound };

  // Their targets in one statement.
  const all = (await openCommitments(ctx, { state: "any" }, read)).matched;
  const claimsOf = await itemClaims(
    (text, values) => ctx.run(text, values),
    all.map((one) => one.row),
    null,
  );
  const support = [...new Set([...claimsOf.values()].flat())];
  const times = new Map(
    (await ctx.run<{ id: string; valid_from: Date }>(CLAIM_TIMES, [support])).map((row) => [
      row.id,
      row.valid_from.getTime(),
    ]),
  );
  const supportOf = supportsOf(ctx);
  const believed = await believedLinks(
    await ctx.run<{ id: string; type: string; fact_key_fp: string }>(TITLE_CANDIDATES, [support]),
    supportOf,
  );
  const targetRows = await ctx.run<{ claim_id: string; project_id: string }>(TARGETS, [support, believed]);
  const items: WorkCommitment[] = all.flatMap((one) => {
    const claims = claimsOf.get(one.row.id) ?? one.row.support;
    const seen = claims.flatMap((id) => (times.has(id) ? [times.get(id) as number] : []));
    if (seen.length === 0) return [];
    const served = done.get(one.row.id);
    const close =
      served !== undefined
        ? served.closedAt === null || served.closedAt === undefined
          ? null
          : Date.parse(served.closedAt)
        : one.belief.status === "closed"
          ? Math.max(...seen)
          : null;
    const targets = [
      ...new Set(targetRows.filter((row) => claims.includes(row.claim_id)).map((row) => row.project_id)),
    ].sort();
    return [{ id: one.row.id, start: Math.min(...seen), close, targets }];
  });
  const servedIds = closed.filter((one) => done.get(one.row.id)?.closedAt !== null).map((one) => one.row.id);
  if (servedIds.length === 0) return { done, bound };
  const matched =
    (await workViews(ctx, { view: "matches", commitments: servedIds }, now, items, undefined, supportOf)).matches ?? {};
  for (const id of servedIds) {
    const entry = done.get(id);
    if (entry !== undefined) entry.workedOn = matched[id] ?? null;
  }
  return { done, bound };
}
