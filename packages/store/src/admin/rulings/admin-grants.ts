import {
  AboutYouKind,
  type ClientId,
  type ClientName,
  ownLabel,
  type ReleaseGrantView,
  type RulingId,
} from "@intelligence/contracts/personal";
import type { AdminContext } from "../../core/admin-context.ts";
import { AdminError } from "../../core/admin-error.ts";
import { type Query, stamp } from "../../core/db.ts";
import { appendJournal } from "../../core/journal.ts";
import { BELIEFS_LOCK, GRANTS_LOCK } from "../../core/locks.ts";
import { ownerDecision } from "../../core/owner-decision.ts";
import { lockRows } from "../../core/queue.ts";
import { removeReleased } from "../../write/writer-derived.ts";
import { syncLock } from "../admin-base.ts";
import { journalOf, nextSeq } from "../erasure/admin-erase.ts";

// The owner's standing release of
// one agent's quoted facts of one kind about the owner. `pia facts grant AGENT KIND` writes a
// `release_grant` decision, its details the client's id and the kind; from then on the pipeline
// releases each such proposal under it in place of a card (policy.grant_release), at the
// granted-release tier. `pia facts grant-lift AGENT KIND` supersedes it with
// a `release_grant_lift`, journals the lift (as `pi correct lift` journals a confirm's), lifts every
// release made under it and removes their released claims at once with what rests on them.
// As pi_admin, the owner's role; no agent API path reaches it. Ids and counts only.

// A grant is made for an active agent; it is lifted for any, a revoked one included.
const CLIENT = "select id from policy.clients where name = $1 and ($2 or status = 'active')";
// The grant in force for a client and a kind: untainted, unsuperseded, its lift not journalled.
const IN_FORCE = `
  select o.id from knowledge.owner_decisions o
  where o.kind = 'release_grant' and o.tainted_at is null
    and o.details ->> 'client' = $1 and o.details ->> 'kind' = $2
    and not exists (select 1 from knowledge.owner_decisions s where s.supersedes = o.id)
    and not exists (select 1 from knowledge.release_lifts l where l.ruling_id = o.id)
  order by o.decided_at, o.id collate "C"`;

const kindOf = (kind: string): AboutYouKind => {
  const parsed = AboutYouKind.safeParse(kind);
  if (!parsed.success) throw new AdminError("invalid_argument");
  return parsed.data;
};

async function clientOf(query: Query, name: string, revoked = false): Promise<string> {
  const [client] = await query<{ id: string }>(CLIENT, [name, revoked]);
  if (client === undefined) throw new AdminError("not_found");
  return client.id;
}

// The owner's grant: its ruling, or the one already in force for that agent and kind.
export function grantRelease(
  admin: AdminContext,
  client: string,
  kind: string,
  options: { requestId: string },
): Promise<RulingId> {
  const covered = kindOf(kind);
  return admin.transaction(async (query) => {
    await lockRows(query, []);
    const id = await clientOf(query, client);
    const [held] = await query<{ id: RulingId }>(IN_FORCE, [id, covered]);
    if (held !== undefined) return held.id;
    return ownerDecision(
      query,
      {
        requestId: options.requestId,
        kind: "release_grant",
        details: { client: id as ClientId, kind: covered },
        compartments: ownLabel(),
      },
      admin.now(),
    );
  });
}

// The owner's lift of a grant in force: false when none is. Every release made under it ends now, its
// released claims removed with every belief resting on them (invariant 10), and the lift is
// journalled, its line on disk before the transaction commits, so a restore that lost it reads
// behind until `pi erase replay`.
export function liftReleaseGrant(
  admin: AdminContext,
  client: string,
  kind: string,
  options: { requestId: string },
): Promise<boolean> {
  const covered = kindOf(kind);
  return admin.transaction(async (query) => {
    // As `pi correct lift` orders them (liftIn): the beliefs lock first, then the decisions' lock,
    // then the sync lock; and the release grants' lock before anything is read.
    await query(BELIEFS_LOCK);
    await query(GRANTS_LOCK);
    await lockRows(query, []);
    const id = await clientOf(query, client, true);
    const [grant] = await query<{ id: RulingId }>(IN_FORCE, [id, covered]);
    if (grant === undefined) return false;
    const now = admin.now();
    const lift = await ownerDecision(
      query,
      {
        requestId: options.requestId,
        kind: "release_grant_lift",
        supersedes: grant.id,
        compartments: ownLabel(),
      },
      now,
    );
    const journal = journalOf(admin);
    await syncLock(query);
    const seq = await nextSeq(query, journal);
    await query("insert into knowledge.release_lifts (seq, ruling_id, compartments) values ($1, $2, array['own'])", [
      seq,
      grant.id,
    ]);
    await appendJournal(journal, { seq, releaseLift: grant.id });
    const lifted = await query<{ evidence_id: string }>(
      "update knowledge.claim_releases set lifted_at = $2, lift_ruling_id = $3 where ruling_id = $1 and lifted_at is null returning evidence_id",
      [grant.id, stamp(now), lift],
    );
    for (const { evidence_id } of lifted) await removeReleased(query, evidence_id);
    return true;
  });
}

// Each grant the owner made, the latest for an agent and a kind, with its counts: a release is
// `notTrue` when their veto, retire or Not true is in force on a key of its record's claims, `kept`
// when it is in force and not so, and `ended` otherwise (lifted with its grant).
const GRANTS = `
  select distinct on (o.details ->> 'client', o.details ->> 'kind')
    o.id as ruling, k.name as client, o.details ->> 'kind' as kind, o.decided_at as since,
    (o.tainted_at is null
      and not exists (select 1 from knowledge.owner_decisions s where s.supersedes = o.id)
      and not exists (select 1 from knowledge.release_lifts l where l.ruling_id = o.id)) as in_force
  from knowledge.owner_decisions o join policy.clients k on k.id = o.details ->> 'client'
  where o.kind = 'release_grant'
  order by o.details ->> 'client', o.details ->> 'kind', o.decided_at desc, o.id collate "C" desc`;
const COUNTS = `
  select r.ruling_id,
    exists (select 1 from knowledge.claims c join knowledge.belief_rulings b on b.fact_key_fp in (c.fact_key_fp, c.legacy_fact_key_fp, c.legacy_alt_fact_key_fp)
            where c.evidence_id = r.evidence_id and b.verdict in ('veto', 'reject') and b.lifted_at is null) as not_true,
    exists (select 1 from policy.released_records() f where f.evidence_id = r.evidence_id and f.ruling_id = r.ruling_id) as in_force
  from knowledge.claim_releases r where r.via = 'grant' and r.ruling_id = any ($1::text[])`;

export function releaseGrants(admin: AdminContext): Promise<ReleaseGrantView[]> {
  return admin.transaction(async (query) => {
    const grants = await query<{ ruling: RulingId; client: ClientName; kind: string; since: Date; in_force: boolean }>(
      GRANTS,
    );
    const counts = await query<{ ruling_id: string; not_true: boolean; in_force: boolean }>(COUNTS, [
      grants.map((one) => one.ruling),
    ]);
    return grants
      .map((one) => {
        const mine = counts.filter((row) => row.ruling_id === one.ruling);
        return {
          ruling: one.ruling,
          client: one.client,
          kind: kindOf(one.kind),
          on: one.in_force,
          since: stamp(one.since),
          kept: mine.filter((row) => row.in_force && !row.not_true).length,
          notTrue: mine.filter((row) => row.not_true).length,
          ended: mine.filter((row) => !row.in_force && !row.not_true).length,
        };
      })
      .sort((a, b) => (a.client === b.client ? (a.kind < b.kind ? -1 : 1) : a.client < b.client ? -1 : 1));
  });
}
