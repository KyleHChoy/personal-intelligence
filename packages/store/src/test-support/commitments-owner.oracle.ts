// Today's owner commitments read, kept verbatim as the oracle of the commitments parity test:
// admin-commitments.ts's ownerCommitments and admin-commitment-lapse.ts's
// lapsedNow before they were merged onto read-beliefs.ts. Deleted once the parity test passes on
// the box's shape of data.
import {
  type AgentRecordId,
  type CaptureId,
  ClaimRecord,
  type ClientName,
  type CommitmentEnding,
  CommitmentItem,
  dayIn,
  type FactSource,
  keyPhraseOf,
  type MessageId,
  OPEN_BELIEF_STATUS,
  type OwnerCommitment,
  type OwnerCommitments,
  type OwnerCommitmentsArgs,
  owedWords,
  type RulingId,
  startOfDay,
} from "@intelligence/contracts/personal";
import { DAY_MS } from "@intelligence/personal-core";
import type { WorkCommitment } from "@intelligence/personal-core/lens";
import { COURTESY_DAYS, dueLapsed, lapseDayOf, lastStood, remarkDays } from "@intelligence/personal-core/views";
import {
  comparePlaces,
  type OwnerBelief,
  type OwnerPlace,
  ownerBeliefs,
  ownerPage,
  ownerWho,
  ownerWithheld,
  pageOf,
} from "../admin/admin-owner.ts";
import { groupMembers } from "../admin/people/admin-people.ts";
import type { AdminContext } from "../core/admin-context.ts";
import { AdminError } from "../core/admin-error.ts";
import { ownerAudience } from "../core/audience.ts";
import { isChatRemark } from "../core/commitment-rules.ts";
import type { Query } from "../core/db.ts";
import { fingerprint } from "../core/fingerprint.ts";
import type { Keys } from "../core/keys.ts";
import { OWNER_ENTITY_ORDERED } from "../core/statements.ts";
import { openedUnder } from "../core/tx.ts";
import { RELEASE_IN_FORCE } from "../core/visibility.ts";
import { believedLinks, gather, linkOf, type Source, zoneOfSetting } from "../core/work-time-read.ts";
import { OWNER_TIME_ZONE } from "../core/zone.ts";
import { factSourceOf } from "../read/fact-source.ts";
import { itemClaims } from "../read/matcher-claims.ts";

const AGENT_CLOSES = "select evidence_id, close_id, client_name, ending from policy.commitment_closes($1::text[])";
const OWNER_CLOSES =
  "select fact_fp, decision_id, ending, at from policy.owner_commitment_closes($1::text[]) where ending <> 'reopened'";
const OWNER_REOPENS = "select fact_fp, at from policy.owner_commitment_closes($1::text[]) where ending = 'reopened'";
const reopenedAtOf = (rows: readonly { fact_fp: string; at: string }[]): Map<string, string> => {
  const newest = new Map<string, string>();
  for (const row of rows) if (!newest.has(row.fact_fp)) newest.set(row.fact_fp, row.at);
  return newest;
};

// The owner's own commands on commitments, as pi_admin. `ownerCommitments` serves the commitments of
// the owner's own audience to `pi commitments list` and the page; `closeCommitment` is the owner's
// close at the terminal, a retire of the commitment's fact key with their ending and time beside it,
// their word; `reopenCommitment` ends every close of a commitment in force, by any agent or by the
// owner, and binds agents until they cite something newer; `listCloses` lists the closes; `pia
// commitments agent-closes` gives or takes back the owner's standing release. Nothing here is served
// to a client.

const FINGERPRINT = /^[0-9a-f]{64}$/;

// Beliefs come through ownerBeliefs alone, the owner reads' one belief source.
//
// A released claim only while its release is in force, as get_commitments reads it. The closes come from
// the definers get_commitments calls, which answer the owner every close.
// ---------------------------------------------------------------------------------------------

// A dated commitment is stale this many days past its due day; an undated one COURTESY_DAYS after
// it was made, when its courtesy lapses.
const STALE_LATE_DAYS = 7;
// An undated commitment's place: after every due date.
const UNDATED = Number.MAX_SAFE_INTEGER;

// The fact keys of the owner's commitments, by the claims' clear type, so only their beliefs are
// opened.
const COMMITMENT_KEYS = `
  select distinct c.fact_key_fp from knowledge.claims c
  where c.type = 'commitment' and c.compartments <@ $1::text[]
  order by 1`;

// Every supporting claim of every commitment, latest first, in one statement, nothing sealed: each
// one's latest claim, its age and the matcher's times are read from these. A released claim only
// while its release is in force, as get_commitments reads them.
const CLAIMS = `
  select c.id, c.evidence_id, c.compartments, c.valid_from
  from knowledge.claims c
  where c.id = any ($1::text[]) and c.compartments <@ $2::text[] and ${RELEASE_IN_FORCE}
  order by c.valid_from desc, c.id`;

// The sealed records of the claims opened: the courtesy candidates' latest, then the page's.
const CONTENTS = "select c.id, c.content_enc from knowledge.claims c where c.id = any ($1::text[]) order by c.id";

const MESSAGES = `
  select m.id, m.evidence_id from knowledge.messages m
  where m.evidence_id = any ($1::text[]) and m.compartments <@ $2::text[] and not m.held and not m.restricting
  order by m.id`;

const CAPTURES = `
  select k.id, k.evidence_id, k.kind, k.source from knowledge.captures k
  where k.evidence_id = any ($1::text[]) and k.compartments <@ $2::text[]
  order by k.id`;

const ANSWERS = `
  select w.id, w.evidence_id from ledger.agent_writes w
  where w.evidence_id = any ($1::text[]) and w.kind = 'answer' and w.flagged_at is null and w.compartments <@ $2::text[]
  order by w.id`;

// Work time, as get_commitments gathers it: the projects bound to each claim, and those of the
// capture items they came from.
const TARGETS = `
  select c.id as claim_id, b.project_id from knowledge.claims c
    join knowledge.project_bindings b on b.claim_id = c.id and b.undone_at is null and b.compartments <@ $2::text[]
  where c.id = any ($1::text[]) and c.compartments <@ $2::text[] and ${RELEASE_IN_FORCE}
  union
  select c.id as claim_id, n.entity_id as project_id from knowledge.claims c
    join knowledge.captures k on k.evidence_id = c.evidence_id and k.compartments <@ $2::text[]
    join knowledge.claims l on l.evidence_id = k.evidence_id and l.compartments <@ $2::text[]
    join knowledge.claim_entities n on n.claim_id = l.id and n.compartments <@ $2::text[]
    join knowledge.projects p on p.id = n.entity_id and p.compartments <@ $2::text[]
  where c.id = any ($1::text[]) and c.compartments <@ $2::text[] and ${RELEASE_IN_FORCE} and ${linkOf("l", "$3")}
  order by claim_id, project_id`;
// The title links on those claims' capture items, which believedLinks keeps when a belief computed
// for the owner's audience counts them.
const TITLE_CANDIDATES = `
  select distinct l.id, l.type, l.fact_key_fp from knowledge.claims c
    join knowledge.captures k on k.evidence_id = c.evidence_id and k.compartments <@ $2::text[]
    join knowledge.claims l on l.evidence_id = k.evidence_id and l.compartments <@ $2::text[]
  where c.id = any ($1::text[]) and c.compartments <@ $2::text[] and ${RELEASE_IN_FORCE} and l.type = 'capture.project'
  order by l.id, l.type, l.fact_key_fp`;

type ClaimRow = { id: string; evidence_id: string; compartments: string[]; valid_from: Date };
type Found = { row: OwnerBelief; direction: CommitmentItem["direction"]; other: string | null; due: string | null };
type Done = Pick<CommitmentItem, "closedAt" | "doneAt" | "doneBy" | "workedOn" | "closedBy" | "ending">;
type Read = {
  query: Query;
  keys: Keys;
  audience: string[];
  owner: string;
  zone: string | null;
  now: Date;
  // A commitment's visible claims, latest first.
  claimsOf: (one: Found) => ClaimRow[];
  // A claim's record, opened once; only a claim whose content was read (CONTENTS).
  recordOf: (claim: ClaimRow) => ClaimRecord;
};

const segmentOf = (span: string | undefined): { from: number; to: number } | null => {
  const match = /^seg:(\d{1,9})-(\d{1,9})$/.exec(span ?? "");
  return match === null ? null : { from: Number(match[1]), to: Number(match[2]) };
};

// A due date as an instant to order by: a day is its first moment in the owner's zone.
// One that is no date sorts with the undated, so the order and the cursor stay numbers.
const dueAt = (due: string | null, zone: string | null): number => {
  const at = due === null ? UNDATED : due.length === 10 ? startOfDay(due, zone) : Date.parse(due);
  return Number.isFinite(at) ? at : UNDATED;
};
const dueDay = (due: string, zone: string | null): string => (due.length === 10 ? due : dayIn(new Date(due), zone));
const daysFrom = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / DAY_MS);

const fits = (place: OwnerPlace): boolean =>
  place.length === 2 && typeof place[0] === "number" && typeof place[1] === "string" && FINGERPRINT.test(place[1]);

// Open by default, as get_commitments; ordered by due date, undated last, then fact; paged, as
// every owner list read is. `whole`: every one in one answer and one snapshot, for the owner's terminal
// (`pi commitments list`).
export async function oracleOwnerCommitments(
  admin: AdminContext,
  args: OwnerCommitmentsArgs = {},
  // `within`: only those whose label lies in these compartments, for a count that leaves some out.
  options: { whole?: boolean; within?: readonly string[] } = {},
): Promise<OwnerCommitments> {
  const page = options.whole === true ? { limit: Number.MAX_SAFE_INTEGER, after: null } : ownerPage(args, fits);
  const now = admin.now();
  const state = args.state ?? "open";
  return admin.transaction(async (query) => {
    const [owner] = await query<{ id: string }>(OWNER_ENTITY_ORDERED);
    const audience = await ownerAudience(query);
    // No built audience is not an empty list: the page says rebuilding.
    if (audience.length === 0) throw new AdminError("rebuilding");
    if (owner === undefined) return { commitments: [], next: null };
    const zone = zoneOfSetting((await query<{ time_zone: string | null }>(OWNER_TIME_ZONE))[0]?.time_zone ?? null);
    const tx = { query, keys: admin.keys };
    // `party`: the person's whole group, as their panel counts them.
    const party = args.party === undefined ? null : new Set(await groupMembers(query, args.party));

    // Every commitment of the owner's audience with the owner on one side, but those with someone
    // withheld.
    const withheld = await ownerWithheld(query);
    const all: Found[] = [];
    const keys = (await query<{ fact_key_fp: string }>(COMMITMENT_KEYS, [audience])).map((row) => row.fact_key_fp);
    for (const row of await ownerBeliefs(tx, keys)) {
      const { belief } = row;
      if (belief.kind !== "commitment") continue;
      if (options.within !== undefined && !row.compartments.every((one) => options.within?.includes(one))) continue;
      const counterparty = typeof belief.values.counterparty === "string" ? belief.values.counterparty : null;
      const direction =
        belief.subject === owner.id ? "owed_by_owner" : counterparty === owner.id ? "owed_to_owner" : null;
      if (direction === null) continue;
      const other = direction === "owed_by_owner" ? counterparty : belief.subject;
      if (other !== null && withheld.has(other)) continue;
      all.push({ row, direction, other, due: belief.values.due === undefined ? null : String(belief.values.due) });
    }
    const claims = await query<ClaimRow>(CLAIMS, [[...new Set(all.flatMap((one) => one.row.support))], audience]);
    const place = new Map(claims.map((claim, index) => [claim.id, index]));
    const visibleOf = new Map<Found, ClaimRow[]>();
    const sealed = new Map<string, unknown>();
    const records = new Map<string, ClaimRecord>();
    // Each statement sent whatever the ids, so a page's statements do not depend on its size.
    const readContents = async (wanted: readonly ClaimRow[]): Promise<void> => {
      const ids = [...new Set(wanted.map((claim) => claim.id))].filter((id) => !sealed.has(id));
      for (const row of await query<{ id: string; content_enc: unknown }>(CONTENTS, [ids]))
        sealed.set(row.id, row.content_enc);
    };
    const read: Read = {
      query,
      keys: admin.keys,
      audience,
      owner: owner.id,
      zone,
      now,
      claimsOf: (one) => {
        let visible = visibleOf.get(one);
        if (visible === undefined) {
          visible = one.row.support
            .flatMap((id) => (place.has(id) ? [place.get(id) as number] : []))
            .sort((a, b) => a - b)
            .map((index) => claims[index] as ClaimRow);
          visibleOf.set(one, visible);
        }
        return visible;
      },
      recordOf: (claim) => {
        let record = records.get(claim.id);
        if (record === undefined) {
          record = ClaimRecord.parse(
            JSON.parse(
              openedUnder(
                admin.keys,
                claim.compartments,
                { table: "knowledge.claims", id: claim.id, column: "content_enc" },
                sealed.get(claim.id),
              ),
            ),
          );
          records.set(claim.id, record);
        }
        return record;
      },
    };

    // A dated one more than DUE_LAPSE_DAYS past its date has lapsed, an undated proposal last confirmed
    // more than COURTESY_DAYS ago, and an undated chat remark on no project past `remarkDays`.
    // Only these candidates' latest claims are opened before the page is known.
    // The owner's reopen outranks each, and starts the clock again.
    const reopened = reopenedAtOf(await query<{ fact_fp: string; at: string }>(OWNER_REOPENS, [keys]));
    const stood = (one: Found): string => lastStood(one.row.belief.lastConfirmedAt, reopened.get(one.row.factKey));
    const olderThan = (one: Found, days: number): boolean => Date.parse(stood(one)) < now.getTime() - days * DAY_MS;
    const candidate = (one: Found): boolean =>
      one.due === null && OPEN_BELIEF_STATUS.has(one.row.belief.status) && olderThan(one, remarkDays(one.direction));
    const candidates = all.filter(candidate);
    const remarks = await remarksAmong(
      query,
      candidates.map((one) => ({
        key: one.row.factKey,
        evidence: read.claimsOf(one)[0]?.evidence_id,
        support: one.row.support,
      })),
      audience,
    );
    const remark = (one: Found): boolean => remarks.has(one.row.factKey);
    await readContents(
      candidates
        .filter((one) => !remark(one) && olderThan(one, COURTESY_DAYS))
        .flatMap((one) => read.claimsOf(one).slice(0, 1)),
    );
    const lapsed = (one: Found): boolean => {
      if (OPEN_BELIEF_STATUS.has(one.row.belief.status) && dueLapsed(one.due, stood(one), now, zone)) return true;
      if (!candidate(one)) return false;
      if (remark(one)) return true;
      const [latest] = read.claimsOf(one);
      return (
        latest !== undefined &&
        olderThan(one, COURTESY_DAYS) &&
        read.recordOf(latest).claim.statementKind === "proposal"
      );
    };
    const lapsedOn = (one: Found): string | null =>
      lapsed(one)
        ? lapseDayOf(one.due, stood(one), zone, remark(one) ? remarkDays(one.direction) : COURTESY_DAYS)
        : null;
    const isOpen = (one: Found): boolean => OPEN_BELIEF_STATUS.has(one.row.belief.status) && !lapsed(one);
    const kept = all.filter(
      (one) =>
        (args.direction === undefined || one.direction === args.direction) &&
        (party === null || (one.other !== null && party.has(one.other))) &&
        isOpen(one) === (state === "open"),
    );
    const placeOf = (one: Found): OwnerPlace => [dueAt(one.due, zone), one.row.factKey];
    kept.sort((a, b) => comparePlaces(placeOf(a), placeOf(b)));
    const { rows: shown, next } = pageOf(kept, placeOf, page);
    await readContents(shown.flatMap((one) => read.claimsOf(one)));

    const evidence = [...new Set(shown.flatMap((one) => read.claimsOf(one).map((claim) => claim.evidence_id)))];
    const messageOf = new Map(
      (await query<{ id: MessageId; evidence_id: string }>(MESSAGES, [evidence, audience])).map((row) => [
        row.evidence_id,
        row.id,
      ]),
    );
    const captureOf = new Map(
      (
        await query<{ id: CaptureId; evidence_id: string; kind: string; source: string | null }>(CAPTURES, [
          evidence,
          audience,
        ])
      ).map((row) => [row.evidence_id, row]),
    );
    const who = await ownerWho(tx, [...new Set(shown.flatMap((one) => (one.other === null ? [] : [one.other])))]);
    const done = await doneOf(read, shown, all, evidence, messageOf, captureOf);

    const today = dayIn(now, zone);
    const commitments = shown.map((one): OwnerCommitment => {
      const visible = read.claimsOf(one);
      const [claim] = visible;
      const message = claim === undefined ? undefined : messageOf.get(claim.evidence_id);
      const captureRow = claim === undefined || message !== undefined ? undefined : captureOf.get(claim.evidence_id);
      const capture = captureRow?.id;
      let what: CommitmentItem["what"] = null;
      let segment: CommitmentItem["segment"] = null;
      let source: FactSource | undefined;
      // A claim is opened only when its message, not held, or its capture item is the owner's to see.
      if (claim !== undefined && (message !== undefined || capture !== undefined)) {
        const record = read.recordOf(claim);
        const text = keyPhraseOf(record.claim.content.type, record.claim.content.fields);
        if (text !== undefined) what = { untrusted: text };
        if (capture !== undefined) segment = segmentOf(record.claim.evidence[0]?.span);
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
      }
      const { belief } = one.row;
      const counterparty = one.other === null ? undefined : who.get(one.other);
      const item = CommitmentItem.parse({
        ...(lapsedOn(one) === null ? {} : { lapsed: lapsedOn(one) }),
        belief: {
          fact: one.row.factKey,
          state: one.row.state,
          kind: belief.kind,
          type: belief.type,
          status: belief.status,
          disputed: belief.disputed,
          provenance: one.row.provenance,
          tier: one.row.tier,
          ...(one.row.group === null ? {} : { group: one.row.group }),
          confirmedAt: belief.lastConfirmedAt,
          reviewAfter: belief.reviewAfter ?? null,
        },
        direction: one.direction,
        counterparty: counterparty === undefined ? null : { ...counterparty },
        due: one.due,
        what,
        message: message ?? null,
        capture: capture ?? null,
        segment,
        ...(source === undefined ? {} : { source }),
        ...(done.get(one.row.id) ?? { closedAt: null, doneAt: null, doneBy: null, workedOn: null }),
      });
      const made = visible.at(-1)?.valid_from ?? new Date(belief.lastConfirmedAt);
      const ageDays = Math.max(0, daysFrom(dayIn(made, zone), today));
      // Late and stale only while open, whole days in the owner's zone.
      const late = state === "open" && one.due !== null ? daysFrom(dueDay(one.due, zone), today) : 0;
      const stale = state === "open" && (one.due === null ? ageDays >= COURTESY_DAYS : late >= STALE_LATE_DAYS);
      return {
        item,
        lateDays: late > 0 ? late : null,
        ageDays,
        stale,
        ...(one.direction === "owed_by_owner" ? owedWords(what) : {}),
      };
    });
    return { commitments, next };
  });
}

// Work time and the closes of commitments, as get_commitments' doneTimes: for each closed commitment
// on the page, who closed it and when, the owner's done time where it was theirs, and the advisory
// minutes worked on its targets.
async function doneOf(
  read: Read,
  shown: readonly Found[],
  all: readonly Found[],
  evidence: string[],
  messageOf: ReadonlyMap<string, MessageId>,
  captureOf: ReadonlyMap<string, { id: CaptureId; kind: string }>,
): Promise<Map<string, Done>> {
  const { query, audience, claimsOf, recordOf } = read;
  const done = new Map<string, Done>();
  const closed = shown.filter((one) => one.row.belief.status === "closed");
  if (closed.length === 0) return done;
  const answerOf = new Map(
    (await query<{ id: AgentRecordId; evidence_id: string }>(ANSWERS, [evidence, audience])).map((row) => [
      row.evidence_id,
      row.id,
    ]),
  );
  const closes = new Map(
    (
      await query<{ evidence_id: string; close_id: string; client_name: string; ending: string }>(AGENT_CLOSES, [
        evidence,
      ])
    ).map((row) => [row.evidence_id, row]),
  );
  const owners = new Map<string, { decision_id: string; ending: string; at: string }>();
  for (const row of await query<{ fact_fp: string; decision_id: string; ending: string; at: string }>(OWNER_CLOSES, [
    closed.map((one) => one.row.factKey),
  ])) {
    if (!owners.has(row.fact_fp)) owners.set(row.fact_fp, row);
  }
  for (const one of closed) {
    done.set(one.row.id, { closedAt: null, doneAt: null, doneBy: null, workedOn: null, closedBy: null, ending: null });
    // The owner's own close in force decides who closed it.
    const owner = owners.get(one.row.factKey);
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
    // Latest first: the first reversal from a source the owner sees closed it.
    for (const claim of claimsOf(one)) {
      const agentClose = closes.get(claim.evidence_id);
      const message = messageOf.get(claim.evidence_id);
      const capture = captureOf.get(claim.evidence_id);
      const answer = answerOf.get(claim.evidence_id);
      if (agentClose === undefined && message === undefined && capture === undefined && answer === undefined) continue;
      const record = recordOf(claim);
      if (record.claim.statementKind !== "reversal") continue;
      const at = claim.valid_from.toISOString();
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
      const segment = segmentOf(record.claim.evidence[0]?.span);
      let doneBy: Done["doneBy"] = null;
      if (message !== undefined) doneBy = { message };
      else if (answer !== undefined) doneBy = { answer };
      else if (
        capture !== undefined &&
        capture.kind === "meeting" &&
        segment !== null &&
        record.claim.basis === "explicit_self" &&
        record.claim.assertedBy === read.owner
      )
        doneBy = { capture: capture.id, segment: segment.from };
      done.set(one.row.id, {
        closedAt: at,
        doneAt: doneBy === null ? null : at,
        doneBy,
        workedOn: null,
        closedBy: { source: true },
        ending: null,
      });
      break;
    }
  }

  const served = closed.filter((one) => done.get(one.row.id)?.closedAt !== null).map((one) => one.row.id);
  if (served.length === 0) return done;
  const supportOf = async (facts: readonly string[]) =>
    (await ownerBeliefs({ query, keys: read.keys }, facts)).map((one) => one.support);
  // Each commitment's claims for the matcher: its support and every other claim of its key.
  const keyed = await itemClaims(
    (text, values) => query(text, values),
    all.map((one) => ({ id: one.row.id, fact_key_fp: one.row.factKey, support: one.row.support })),
    audience,
  );
  const claimIds = [...new Set([...keyed.values()].flat())];
  const times = new Map(
    (
      await query<{ id: string; valid_from: Date }>(
        `select c.id, c.valid_from from knowledge.claims c where c.id = any ($1::text[]) and c.compartments <@ $2::text[] and ${RELEASE_IN_FORCE} order by c.id`,
        [claimIds, audience],
      )
    ).map((row) => [row.id, row.valid_from.getTime()]),
  );
  const believed = await believedLinks(
    await query<{ id: string; type: string; fact_key_fp: string }>(TITLE_CANDIDATES, [claimIds, audience]),
    supportOf,
  );
  const targetRows = await query<{ claim_id: string; project_id: string }>(TARGETS, [claimIds, audience, believed]);
  const items: WorkCommitment[] = all.flatMap((one) => {
    const visible = keyed.get(one.row.id) ?? [];
    const seen = visible.flatMap((id) => (times.has(id) ? [times.get(id) as number] : []));
    if (seen.length === 0) return [];
    const entry = done.get(one.row.id);
    const close =
      entry !== undefined
        ? entry.closedAt == null
          ? null
          : Date.parse(entry.closedAt)
        : one.row.belief.status === "closed"
          ? Math.max(...seen)
          : null;
    const ids = new Set(visible);
    const targets = [...new Set(targetRows.filter((row) => ids.has(row.claim_id)).map((row) => row.project_id))].sort();
    return [{ id: one.row.id, start: Math.min(...seen), close, targets }];
  });
  const source: Source = {
    run: (text, values) => query(text, values),
    open: (table, column, row) =>
      openedUnder(read.keys, row.compartments, { table, id: row.id, column }, row.value_enc),
    within: audience,
    clearance: async () => audience,
    anchorFp: (key) => fingerprint(read.keys, "anchor", key),
    supportOf,
  };
  const matched =
    (await gather(source, { view: "matches", commitments: served }, read.now, read.zone, items)).matches ?? {};
  for (const id of served) {
    const entry = done.get(id);
    if (entry !== undefined) entry.workedOn = matched[id] ?? null;
  }
  return done;
}

// What says an undated commitment is a chat remark: its latest claim's capture, and no project under it.
const CHAT_CAPTURES = `
  select k.evidence_id from knowledge.captures k
  where k.evidence_id = any ($1::text[]) and k.compartments <@ $2::text[] and k.source is not null
  order by k.evidence_id`;
const BOUND_CLAIMS = `
  select distinct b.claim_id from knowledge.project_bindings b
  where b.claim_id = any ($1::text[]) and b.undone_at is null and b.compartments <@ $2::text[]
  order by b.claim_id`;

// Of these, the keys that are chat remarks. `evidence`: the latest visible claim's, if any.
async function remarksAmong(
  query: Query,
  rows: readonly { key: string; evidence: string | undefined; support: readonly string[] }[],
  audience: readonly string[],
): Promise<Set<string>> {
  const evidence = [...new Set(rows.flatMap((one) => (one.evidence === undefined ? [] : [one.evidence])))];
  const chats = new Set(
    (await query<{ evidence_id: string }>(CHAT_CAPTURES, [evidence, [...audience]])).map((row) => row.evidence_id),
  );
  const support = [...new Set(rows.flatMap((one) => [...one.support]))];
  const bound = new Set(
    (await query<{ claim_id: string }>(BOUND_CLAIMS, [support, [...audience]])).map((row) => row.claim_id),
  );
  return new Set(rows.flatMap((one) => (isChatRemark(one.evidence, one.support, chats, bound) ? [one.key] : [])));
}

// Whether a commitment nobody closed has gone from what is open, so the owner's reopen has something
// to outrank: by the same rule the reads apply, counting an earlier reopen, or dormant with age. One
// that stands refuses, so no reopen row binds an agent's close for nothing.
export async function oracleLapsedNow(admin: AdminContext, query: Query, fact: string): Promise<boolean> {
  const zone = zoneOfSetting((await query<{ time_zone: string | null }>(OWNER_TIME_ZONE))[0]?.time_zone ?? null);
  const now = admin.now();
  const reopened = reopenedAtOf(await query<{ fact_fp: string; at: string }>(OWNER_REOPENS, [[fact]])).get(fact);
  for (const { belief, support } of await ownerBeliefs({ query, keys: admin.keys }, [fact])) {
    if (belief.kind !== "commitment") continue;
    if (belief.status === "dormant") return true;
    if (!OPEN_BELIEF_STATUS.has(belief.status)) continue;
    const stood = lastStood(belief.lastConfirmedAt, reopened);
    if (belief.values.due !== undefined) {
      if (dueLapsed(String(belief.values.due), stood, now, zone)) return true;
      continue;
    }
    const [owner] = await query<{ id: string }>(OWNER_ENTITY_ORDERED);
    const direction = belief.subject === owner?.id ? "owed_by_owner" : "owed_to_owner";
    if (Date.parse(stood) >= now.getTime() - remarkDays(direction) * DAY_MS) continue;
    const audience = await ownerAudience(query);
    const [latest] = await query<{ id: string; evidence_id: string; compartments: string[]; content_enc: unknown }>(
      `select c.id, c.evidence_id, c.compartments, c.content_enc from knowledge.claims c
       where c.id = any ($1::text[]) and c.compartments <@ $2::text[] order by c.valid_from desc, c.id limit 1`,
      [support, audience],
    );
    if (latest === undefined) continue;
    const remarks = await remarksAmong(query, [{ key: fact, evidence: latest.evidence_id, support }], audience);
    if (remarks.has(fact)) return true;
    if (Date.parse(stood) >= now.getTime() - COURTESY_DAYS * DAY_MS) continue;
    const record = ClaimRecord.parse(
      JSON.parse(
        openedUnder(
          admin.keys,
          latest.compartments,
          { table: "knowledge.claims", id: latest.id, column: "content_enc" },
          latest.content_enc,
        ),
      ),
    );
    if (record.claim.statementKind === "proposal") return true;
  }
  return false;
}
