import {
  EntityId,
  IGNORED_WHO_MOST,
  type IgnoreRulingView,
  type IgnoreSubject,
  type IgnoreTarget,
  type PersonalCompartment,
  type RulingId,
  type Who,
} from "@intelligence/contracts/personal";
import { foldDomain, normalizeAddress } from "@intelligence/personal-core";
import type { AdminContext } from "../../core/admin-context.ts";
import { AdminError } from "../../core/admin-error.ts";
import { type Query, stamp } from "../../core/db.ts";
import { fingerprint } from "../../core/fingerprint.ts";
import { ownerDecision } from "../../core/owner-decision.ts";
import { lockRows } from "../../core/queue.ts";
import { notOwnerAddress } from "../../core/statements.ts";
import { ownerWho } from "../admin-owner.ts";
import { groupMembers } from "../people/admin-people.ts";
import { heldLabel, liftRulings, lockedRepeat, ownerHolds, RULING_LOCKS } from "./owner-ruling.ts";

// The owner's ignore list: an account, a person or an organization, or a domain, that every reader
// withholds and the identity sweep raises no card about, with no evidence deleted. A ruling is
// stored as the keyed fingerprints of the addresses or domains it covers, so it outlives a
// re-derive's new ids and holds no value. Each write is one transaction with its owner decision.

// A domain as an address holds it: lower case, at least one dot, no "@".
const DOMAIN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

type Covered = { subject: IgnoreSubject; fps: string[]; compartments: string[] };

// What the target covers. An address the owner holds is refused: the owner cannot ignore themselves.
async function covered(admin: AdminContext, query: Query, target: IgnoreTarget, value: string): Promise<Covered> {
  if (target === "account") {
    const address = normalizeAddress(value);
    if (address === null) throw new AdminError("invalid_address");
    const fp = fingerprint(admin.keys, "address", address);
    if (await ownerHolds(query, fp)) throw new AdminError("not_a_person");
    return { subject: "address", fps: [fp], compartments: await heldLabel(query, "account", [fp]) };
  }
  if (target === "domain") {
    const domain = value.trim().toLowerCase();
    if (!DOMAIN.test(domain)) throw new AdminError("invalid_argument");
    // Under its registrable domain, the key every account and domain row is stored under: a
    // subdomain names its organization's whole domain.
    const fp = fingerprint(admin.keys, "domain", foldDomain(domain));
    return { subject: "domain", fps: [fp], compartments: await heldLabel(query, "domain", [fp]) };
  }
  const id = EntityId.safeParse(value);
  if (!id.success) throw new AdminError("invalid_argument");
  const [entity] = await query<{ kind: string }>("select kind from knowledge.entities where id = $1", [id.data]);
  if (entity === undefined) throw new AdminError("not_found");
  // A person never reaches here: `addIgnore` removes one (`hide`).
  if (entity.kind === "organization") {
    const fps = (
      await query<{ domain_fp: string }>(
        "select distinct domain_fp from knowledge.domains where entity_id = $1 order by domain_fp",
        [id.data],
      )
    ).map((row) => row.domain_fp);
    if (fps.length === 0) throw new AdminError("not_found");
    return { subject: "domain", fps, compartments: await heldLabel(query, "domain", fps) };
  }
  // The owner and a project are never ignored.
  throw new AdminError("invalid_argument");
}

// `pi ignore add`: one ignore ruling. A live ruling that covers the same fingerprints
// already is `already_settled` with its id, and writes nothing; a repeated request id returns the
// first ruling.
export async function addIgnore(
  admin: AdminContext,
  target: IgnoreTarget,
  value: string,
  options: { requestId: string },
): Promise<RulingId> {
  const now = admin.now();
  return admin.transaction(async (query) => {
    const repeat = await lockedRepeat(query, RULING_LOCKS.ignore, options.requestId);
    if (repeat !== undefined) return repeat;
    // A person is removed: their group hidden, their addresses ignored.
    if (target === "entity" && EntityId.safeParse(value).success) {
      const [entity] = await query<{ kind: string }>("select kind from knowledge.entities where id = $1", [value]);
      if (entity?.kind === "person") return hide(query, value, options.requestId, now);
    }
    const { subject, fps, compartments } = await covered(admin, query, target, value);
    const [live] = await query<{ ruling_id: string }>(
      "select ruling_id from knowledge.ignore_rulings where lifted_at is null and subject = $1 and value_fps @> $2::text[] order by ruling_id limit 1",
      [subject, fps],
    );
    if (live !== undefined) throw new AdminError("already_settled", undefined, [live.ruling_id]);
    const ruling = await ownerDecision(
      query,
      {
        requestId: options.requestId,
        kind: "ignore",
        answer: target,
        compartments: compartments,
      },
      now,
    );
    await query(
      "insert into knowledge.ignore_rulings (ruling_id, target, subject, value_fps, created_at) values ($1, $2, $3, $4, $5)",
      [ruling, target, subject, fps, stamp(now)],
    );
    return ruling;
  });
}

// The owner's Remove of a person. One ruling, an `ignore` of
// target `entity`, that hides the person's identity group by its members' entity ids
// (knowledge.person_hides: every owner read withholds a group with a member a hide holds, so one
// who merges later stays removed) and, when the group holds addresses, ignores them as `addIgnore`
// does (every reader withholds them). A person known by name alone is removed by the hide alone.
// `liftIgnore` lifts both. A person a hide in force already holds is `already_settled`. Written by
// `addIgnore` for an entity that is a person: `pi ignore add entity <person>` and the page's Remove.
async function hide(query: Query, person: string, requestId: string, now: Date): Promise<RulingId> {
  const members = (await groupMembers(query, person)).slice(0, 100);
  const [live] = await query<{ ruling_id: string }>(
    "select ruling_id from knowledge.person_hides where lifted_at is null and entity_ids && $1::text[] order by ruling_id limit 1",
    [members],
  );
  if (live !== undefined) throw new AdminError("already_settled", undefined, [live.ruling_id]);
  const fps = (
    await query<{ value_fp: string }>(
      `select distinct a.value_fp from knowledge.accounts a where a.entity_id = any ($1::text[])
           and ${notOwnerAddress("a.value_fp", "w")}
         order by a.value_fp limit 100`,
      [members],
    )
  ).map((row) => row.value_fp);
  // A person every address of whom is the owner's own is the owner: the owner cannot remove
  // themselves.
  if (fps.length === 0) {
    const [held] = await query<{ yes: boolean }>(
      "select exists (select 1 from knowledge.accounts a where a.entity_id = any ($1::text[])) as yes",
      [members],
    );
    if (held?.yes === true) throw new AdminError("not_a_person");
  }
  const ruling = await ownerDecision(
    query,
    {
      requestId,
      kind: "ignore",
      answer: "entity",
      compartments: fps.length === 0 ? ["own"] : await heldLabel(query, "account", fps),
    },
    now,
  );
  if (fps.length > 0)
    await query(
      "insert into knowledge.ignore_rulings (ruling_id, target, subject, value_fps, created_at) values ($1, 'entity', 'address', $2, $3)",
      [ruling, fps, stamp(now)],
    );
  await query("insert into knowledge.person_hides (ruling_id, entity_ids, created_at) values ($1, $2, $3)", [
    ruling,
    members,
    stamp(now),
  ]);
  return ruling;
}

// Every ignore ruling, oldest first: ids, counts and times. A Remove of a person known by name
// alone holds no address: it is listed as its entity's, counting the people it hides.
export async function listIgnore(admin: AdminContext): Promise<IgnoreRulingView[]> {
  return admin.transaction(async (query) => {
    const rows = await query<{
      ruling_id: RulingId;
      target: IgnoreTarget;
      subject: IgnoreSubject;
      values: number;
      created_at: Date;
      lifted_at: Date | null;
    }>(
      `select t.* from (
         select ruling_id, target, subject, cardinality(value_fps) as values, created_at, lifted_at from knowledge.ignore_rulings
         union all
         select h.ruling_id, 'entity', 'address', cardinality(h.entity_ids), h.created_at, h.lifted_at from knowledge.person_hides h
         where not exists (select 1 from knowledge.ignore_rulings r where r.ruling_id = h.ruling_id)
       ) t
       order by t.created_at, t.ruling_id collate "C"`,
    );
    return rows.map((row) => ({
      id: row.ruling_id,
      target: row.target,
      subject: row.subject,
      values: row.values,
      at: stamp(row.created_at),
      liftedAt: row.lifted_at === null ? null : stamp(row.lifted_at),
    }));
  });
}

// Whom each ignore ruling covers, for the page's Settings: the people whose addresses, or the
// organizations whose domains, its fingerprints match, named as ownerWho names them; at most
// IGNORED_WHO_MOST each, a ruling nothing known matches with none.
export async function ignoredWho(admin: AdminContext): Promise<Map<RulingId, Who[]>> {
  return admin.transaction(async (query) => {
    const rows = await query<{ ruling_id: RulingId; entity_id: string }>(
      `select distinct r.ruling_id, a.entity_id from knowledge.ignore_rulings r
         join knowledge.accounts a on r.subject = 'address' and a.value_fp = any(r.value_fps)
       union
       select distinct r.ruling_id, d.entity_id from knowledge.ignore_rulings r
         join knowledge.domains d on r.subject = 'domain' and d.domain_fp = any(r.value_fps)
       union
       select distinct h.ruling_id, e.id from knowledge.person_hides h cross join unnest(h.entity_ids) as m (id)
         join knowledge.entities e on e.id = m.id
       order by 1, 2`,
    );
    const who = await ownerWho({ query, keys: admin.keys }, [...new Set(rows.map((row) => row.entity_id))]);
    const out = new Map<RulingId, Who[]>();
    for (const row of rows) {
      const one = who.get(row.entity_id);
      const had = out.get(row.ruling_id) ?? [];
      if (one !== undefined && had.length < IGNORED_WHO_MOST) out.set(row.ruling_id, [...had, one]);
    }
    return out;
  });
}

// The ruling's lift: false for an id that is no ignore ruling in force. A repeated request id
// that lifted this ruling answers true again and writes nothing.
export async function liftIgnore(admin: AdminContext, id: RulingId, options: { requestId: string }): Promise<boolean> {
  const now = admin.now();
  return admin.transaction(async (query) => {
    await lockRows(query, [RULING_LOCKS.ignore]);
    const [repeat] = await query<{ supersedes: string | null }>(
      "select supersedes from knowledge.owner_decisions where request_id = $1",
      [options.requestId],
    );
    if (repeat !== undefined) {
      if (repeat.supersedes !== id) throw new AdminError("invalid_argument");
      return true;
    }
    // An ignore in force, or a Remove's hide in force, which it lifts whole.
    const [row] = await query<{ compartments: PersonalCompartment[] }>(
      `select d.compartments from knowledge.owner_decisions d where d.id = $1
         and (exists (select 1 from knowledge.ignore_rulings r where r.ruling_id = d.id and r.lifted_at is null)
           or exists (select 1 from knowledge.person_hides h where h.ruling_id = d.id and h.lifted_at is null))`,
      [id],
    );
    if (row === undefined) return false;
    const lift = await ownerDecision(
      query,
      { requestId: options.requestId, kind: "ignore_lift", supersedes: id, compartments: row.compartments },
      now,
    );
    await liftRulings(query, "knowledge.ignore_rulings", [id], lift, now);
    await liftRulings(query, "knowledge.person_hides", [id], lift, now);
    return true;
  });
}
