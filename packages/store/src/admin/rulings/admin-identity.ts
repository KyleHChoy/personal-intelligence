import {
  ADDRESS_MARKS,
  type AddressMark,
  type EntityId,
  type IdentityAnswerView,
  type IdentityBasis,
  type IdentityRulingView,
  type IdentityVerdict,
  type PersonalCompartment,
  type QuestionRuleView,
  type ReclassifyCounts,
  type RulingId,
} from "@intelligence/contracts/personal";
import { normalizeAddress } from "@intelligence/personal-core";
import { markAccounts, reclassify } from "../../core/account-kinds.ts";
import type { AdminContext } from "../../core/admin-context.ts";
import { AdminError } from "../../core/admin-error.ts";
import { type Query, stamp } from "../../core/db.ts";
import { fingerprint } from "../../core/fingerprint.ts";
import { allRulings, ownerFps, type RulingRow } from "../../core/identity-rulings.ts";
import { authorWord } from "../../core/locks.ts";
import { ownerDecision } from "../../core/owner-decision.ts";
import { lockRows } from "../../core/queue.ts";
import { CARD_STATE, IDENTITY_AUTHOR, latestRow, notOwnerAddress } from "../../core/statements.ts";
import { conflict, eligible, groupOf, groupsOf, pathBetween, settles } from "../../identity/groups.ts";
import { thinMerges } from "../../identity/thin-merges.ts";
import { removeSourceItem } from "../../write/writer-item-removal.ts";
import { googleSecretName, repeatedRuling, syncLock } from "../admin-base.ts";
import { reopenAnswered } from "../cards/admin-reopen.ts";
import { CARD_WITHDRAWN, recordEvent } from "../record-event.ts";
import { heldLabel, liftRulings, ownerHolds, RULING_LOCKS } from "./owner-ruling.ts";

// The owner's rulings on who is the same person: each in one transaction with its owner decision,
// under the admin's keys and clock. A ruling is by address fingerprint and moves no row. The two
// card kinds call `writeRuling` from `decide`.

// A person's one address fingerprint and the compartments of its account rows, read after the
// transaction's lock call. The owner, an organization, a person whose address is the owner's and a
// suppressed address are `not_a_person`; an id that does not exist is `not_found`.
export async function personOf(query: Query, entity: string): Promise<{ fp: string; compartments: string[] }> {
  const [row] = await query<{ kind: string }>("select kind from knowledge.entities where id = $1", [entity]);
  if (row === undefined) throw new AdminError("not_found");
  if (row.kind !== "person") throw new AdminError("not_a_person");
  const held = await query<{ value_fp: string; compartments: string[] }>(
    `select a.value_fp, a.compartments from knowledge.accounts a where a.entity_id = $1
       and ${notOwnerAddress("a.value_fp")}
     order by a.value_fp, a.id`,
    [entity],
  );
  const [first] = held;
  if (first === undefined) throw new AdminError("not_a_person");
  const [suppressed] = await query<{ yes: boolean }>(
    "select exists (select 1 from knowledge.suppressions where kind = 'address' and value_fp = $1) as yes",
    [first.value_fp],
  );
  if (suppressed?.yes === true) throw new AdminError("not_a_person");
  return { fp: first.value_fp, compartments: [...new Set(held.flatMap((one) => one.compartments))].sort() };
}

// The undecided same_person and shared_address cards of system:identity, with their refs.
async function openCards(query: Query): Promise<{ id: string; kind: string; refs: string[] }[]> {
  const rows = await query<{ id: string; kind: string; refs: string[] }>(
    `select c.id, c.kind, coalesce(array_agg(b.ref_id order by b.id) filter (where b.ref_id is not null), '{}') as refs
     from ledger.cards c left join ledger.basis b on b.row_kind = 'card' and b.row_id = c.id
     where c.created_by = $1 and c.kind in ('same_person', 'shared_address') and ${CARD_STATE} in ('pending', 'deferred')
     group by c.id, c.kind order by c.id`,
    [IDENTITY_AUTHOR],
  );
  return rows;
}

// The open identity cards whose refs hold any of these people, read before the lock call:
// their ids and refs never change.
async function cardsNaming(query: Query, entities: string[]): Promise<string[]> {
  return (await openCards(query))
    .filter((card) => card.refs.some((ref) => entities.includes(ref)))
    .map((card) => card.id);
}

// A card whose people no longer have an address is left to the ledger's taint.
async function withdrawSettled(query: Query, now: Date): Promise<number> {
  const rulings = await allRulings(query);
  const groups = groupsOf(rulings, await ownerFps(query));
  let withdrawn = 0;
  const marked = new Set(
    rulings
      .filter((one) => one.liftedAt === null && one.verdict !== "different")
      .flatMap((one) => [one.aFp, ...(one.bFp === null ? [] : [one.bFp])]),
  );
  const withdraw = async (id: string): Promise<void> => {
    const [compartments] = await query<{ compartments: string[] }>(
      "select compartments from ledger.cards where id = $1",
      [id],
    );
    const label = compartments?.compartments ?? ["own"];
    await recordEvent(query, CARD_WITHDRAWN, id, stamp(now), label, { by: IDENTITY_AUTHOR });
    withdrawn += 1;
  };
  // A shared_address card whose address a ruling in force now names is settled too.
  for (const card of (await openCards(query)).filter((one) => one.kind === "shared_address")) {
    const [ref] = card.refs;
    const fps =
      ref === undefined
        ? []
        : (
            await query<{ value_fp: string }>("select value_fp from knowledge.accounts where entity_id = $1", [ref])
          ).map((row) => row.value_fp);
    if (fps.some((fp) => marked.has(fp))) await withdraw(card.id);
  }
  for (const card of (await openCards(query)).filter((one) => one.kind === "same_person")) {
    const fps: string[] = [];
    for (const ref of card.refs) {
      const [row] = await query<{ value_fp: string }>(
        "select min(value_fp) as value_fp from knowledge.accounts where entity_id = $1",
        [ref],
      );
      if (row?.value_fp !== null && row?.value_fp !== undefined) fps.push(row.value_fp);
    }
    const [a, b] = fps;
    if (a === undefined || b === undefined || eligible(groups, rulings, a, b)) continue;
    await withdraw(card.id);
  }
  await query("select ledger.admit_deferred($1)", [IDENTITY_AUTHOR]);
  return withdrawn;
}

// The one write of a ruling: its checks, its row and the withdrawals, in the caller's transaction,
// after its lock call and its owner decision. `ruling` is that decision's id. A refusal throws, and
// the caller's transaction rolls back. `affirming`: the owner's `same` on two addresses that
// rulings of the system's or agents join already, which is written all the same, where a `same` on
// a pair already joined is refused.
export async function writeRuling(
  query: Query,
  ruling: RulingId,
  verdict: IdentityVerdict,
  a: string,
  b: string | null,
  now: Date,
  affirming = false,
): Promise<void> {
  const rulings = await allRulings(query);
  const groups = groupsOf(rulings, await ownerFps(query));
  const live = rulings.filter((one) => one.liftedAt === null);
  const sharedFps = new Set(live.filter((one) => one.verdict === "shared").map((one) => one.aFp));
  // A role address is no person's, so it is joined to nobody.
  const roleFps = new Set(live.filter((one) => one.verdict === "role").map((one) => one.aFp));
  if (b !== null) {
    if (verdict === "same" && (sharedFps.has(a) || sharedFps.has(b))) throw new AdminError("shared_address");
    if (verdict === "same" && (roleFps.has(a) || roleFps.has(b))) throw new AdminError("not_a_person");
    if (verdict === "same" && !affirming) {
      const settled = settles(groups, rulings, a, b);
      if (settled.by === "same") throw new AdminError("already_settled", undefined, settled.rulings);
    }
    if (conflict(groups, rulings, a, b, verdict === "same" ? "same" : "different")) {
      // The owner's word outranks every ruling the system made, on any basis: what stands in its way
      // is lifted, and only that.
      await liftPolicyInTheWay(query, ruling, verdict === "same" ? "same" : "different", a, b, now);
      const after = await allRulings(query);
      if (conflict(groupsOf(after, await ownerFps(query)), after, a, b, verdict === "same" ? "same" : "different"))
        throw new AdminError("conflicting_ruling");
    }
  } else {
    if (
      (verdict === "shared" || verdict === "role") &&
      live.some((one) => one.verdict === "same" && (one.aFp === a || one.bFp === a))
    )
      throw new AdminError("conflicting_ruling");
    // One live mark on one address: shared, a one_person answer, role and person exclude each
    // other, and a repeat of one writes nothing.
    const marked = live.find((one) => isMark(one.verdict) && one.aFp === a);
    if (marked !== undefined)
      throw new AdminError(marked.verdict === verdict ? "already_settled" : "conflicting_ruling", undefined, [
        marked.id,
      ]);
  }
  const [first, second] = b === null ? [a, null] : [a, b].sort();
  await query(
    "insert into knowledge.identity_rulings (ruling_id, verdict, a_fp, b_fp, created_at) values ($1, $2, $3, $4, $5)",
    [ruling, verdict, first, second, stamp(now)],
  );
  // A mark sets its kind on the address's account rows in the same transaction.
  if (b === null && isMark(verdict)) await markAccounts(query, a, verdict);
  await withdrawSettled(query, now);
}

// The rulings the system made, on any basis (a contact, a name, a local part, a research identifier,
// an agent, a rule, the dream pass), that keep the owner's new ruling from standing: lifted, newest
// first, one at a time, until it can. Its lift names the owner's ruling. One of the owner's own is never lifted here.
async function liftPolicyInTheWay(
  query: Query,
  ruling: RulingId,
  verdict: "same" | "different",
  a: string,
  b: string,
  now: Date,
): Promise<void> {
  const made = await query<{ ruling_id: string }>(
    `select r.ruling_id from knowledge.identity_rulings r join knowledge.owner_decisions d on d.id = r.ruling_id
     where r.lifted_at is null and r.verdict = $1 and d.kind = 'identity_policy'
     order by r.created_at desc, r.ruling_id desc`,
    [verdict === "same" ? "different" : "same"],
  );
  const owner = await ownerFps(query);
  for (const { ruling_id } of made) {
    const rulings = await allRulings(query);
    const groups = groupsOf(rulings, owner);
    if (!conflict(groups, rulings, a, b, verdict)) return;
    const theRuling = rulings.find((one) => one.id === ruling_id);
    const together = new Set([...groupOf(groups, a), ...groupOf(groups, b)]);
    // A same only if the two come apart without it; a different only if it lies between them.
    const inTheWay =
      verdict === "different"
        ? (() => {
            const apart = groupsOf(
              rulings.filter((one) => one.id !== ruling_id),
              owner,
            );
            return !(apart.keyOf.has(a) && apart.keyOf.get(a) === apart.keyOf.get(b));
          })()
        : together.has(theRuling?.aFp ?? "") && together.has(theRuling?.bFp ?? "");
    if (!inTheWay) continue;
    await liftRulings(query, "knowledge.identity_rulings", [ruling_id], ruling, now);
  }
}

const isMark = (verdict: IdentityVerdict): verdict is AddressMark => ADDRESS_MARKS.some((mark) => mark === verdict);

// The owner's `same` on two addresses that rulings join already: the rulings of the system's or
// agents on the chain between the two that the owner has not affirmed before, whatever else the
// group holds. Undefined when the two are not joined or the chain holds none, and the ruling takes
// its usual path. Setting the two apart means lifting a ruling of the chain, and each is then the
// owner's own or affirmed, which no agents' split lifts. The owner's own `same` between the two is
// written beside the affirmation (`rule`, below), so the chain it then returns is that one ruling,
// which is no `identity_policy`: a second link finds nothing to affirm and is `already_settled`.
async function policyJoin(query: Query, a: string, b: string): Promise<RulingId[] | undefined> {
  const rulings = await allRulings(query);
  const path = pathBetween(groupsOf(rulings, await ownerFps(query)), rulings, a, b);
  if (path === undefined || path.length === 0) return undefined;
  const unaffirmed = await query<{ id: RulingId }>(
    `select d.id from knowledge.owner_decisions d
     where d.id = any ($1::text[]) and d.kind = 'identity_policy'
       and not exists (select 1 from knowledge.owner_decisions o
                       where o.kind = 'identity' and o.answer = 'same' and o.details -> 'affirms' ? d.id)
     order by d.id collate "C"`,
    [path],
  );
  return unaffirmed.length === 0 ? undefined : unaffirmed.map((row) => row.id);
}

// The ruling in force that sits on exactly these two addresses, if one does.
async function pairRuling(query: Query, a: string, b: string): Promise<RulingId | undefined> {
  const [first, second] = [a, b].sort();
  const [row] = await query<{ ruling_id: RulingId }>(
    "select ruling_id from knowledge.identity_rulings where lifted_at is null and a_fp = $1 and b_fp = $2",
    [first, second],
  );
  return row?.ruling_id;
}

async function rule(
  admin: AdminContext,
  entities: EntityId[],
  verdict: IdentityVerdict,
  requestId: string,
): Promise<RulingId> {
  const now = admin.now();
  return admin.transaction(async (query) => {
    const cards = await cardsNaming(query, entities);
    await lockRows(query, [RULING_LOCKS.identity, authorWord(IDENTITY_AUTHOR), ...cards]);
    const repeat = await repeatedRuling(query, requestId);
    if (repeat !== undefined) return repeat.id;
    const people = [];
    for (const entity of entities) people.push(await personOf(query, entity));
    const [a, b] = people;
    if (a === undefined) throw new AdminError("invalid_argument");
    if (b !== undefined && a.fp === b.fp) throw new AdminError("invalid_argument");
    // The owner's `same` on two people that rulings of the system's or agents join already: the
    // owner's word is recorded on the decision, naming the rulings between the two it affirms, so
    // no two agents split what the owner said is one. And the owner's own `same` between the two
    // addresses is written under that decision, so their word stands on its own: an affirmed ruling
    // is an agent's or the rule's, and is lifted when a message its answer cited is erased, after
    // which nothing of the owner's would hold the two together and agents could rule them different
    // (invariant 11). One ruling in force is all two addresses can hold, so where the affirmed
    // ruling sits on these same two, the decision names it (`inPlaceOf`) and the owner's is written
    // when a deletion lifts that one (ledger.forget_identity_answers). Only then: a link over a
    // chain names no ruling so, and lifting a ruling of the chain writes nothing on two addresses
    // the owner never named.
    const affirms = verdict === "same" && b !== undefined ? await policyJoin(query, a.fp, b.fp) : undefined;
    const inPlaceOf = affirms === undefined || b === undefined ? undefined : await pairRuling(query, a.fp, b.fp);
    const ruling = await ownerDecision(
      query,
      {
        requestId,
        kind: "identity",
        answer: verdict,
        details: affirms === undefined ? {} : inPlaceOf === undefined ? { affirms } : { affirms, inPlaceOf },
        compartments: [...new Set(people.flatMap((one) => one.compartments))].sort(),
      },
      now,
    );
    if (affirms === undefined) await writeRuling(query, ruling, verdict, a.fp, b?.fp ?? null, now);
    else if (b !== undefined && inPlaceOf === undefined)
      await writeRuling(query, ruling, verdict, a.fp, b.fp, now, true);
    return ruling;
  });
}

export function linkPeople(
  admin: AdminContext,
  a: EntityId,
  b: EntityId,
  verdict: "same" | "different",
  options: { requestId: string },
): Promise<RulingId> {
  if (a === b) return Promise.reject(new AdminError("invalid_argument"));
  return rule(admin, [a, b], verdict, options.requestId);
}

export function markShared(admin: AdminContext, entity: EntityId, options: { requestId: string }): Promise<RulingId> {
  return rule(admin, [entity], "shared", options.requestId);
}

// An owner address, and one that does not normalize, is refused. The decision takes the
// compartments of the address's account rows, or `own` when none holds it.
export async function markAddress(
  admin: AdminContext,
  target: { entity: EntityId } | { address: string },
  verdict: "role" | "person",
  options: { requestId: string },
): Promise<RulingId> {
  const now = admin.now();
  const address = "address" in target ? normalizeAddress(target.address) : null;
  if ("address" in target && address === null) throw new AdminError("invalid_address");
  return admin.transaction(async (query) => {
    const entities = "entity" in target ? [target.entity] : [];
    const cards = await cardsNaming(query, entities);
    await lockRows(query, [RULING_LOCKS.identity, authorWord(IDENTITY_AUTHOR), ...cards]);
    const repeat = await repeatedRuling(query, options.requestId);
    if (repeat !== undefined) return repeat.id;
    let fp: string;
    let compartments: string[];
    if ("entity" in target) {
      ({ fp, compartments } = await personOf(query, target.entity));
    } else {
      fp = fingerprint(admin.keys, "address", address ?? "");
      if (await ownerHolds(query, fp)) throw new AdminError("not_a_person");
      compartments = await heldLabel(query, "account", [fp]);
    }
    const ruling = await ownerDecision(
      query,
      {
        requestId: options.requestId,
        kind: "identity",
        answer: verdict,
        compartments: compartments,
      },
      now,
    );
    await writeRuling(query, ruling, verdict, fp, null, now);
    return ruling;
  });
}

// A dry run counts and writes nothing.
export async function reclassifyAccounts(admin: AdminContext, options: { dryRun: boolean }): Promise<ReclassifyCounts> {
  return admin.transaction(async (query) => {
    await syncLock(query);
    await lockRows(query, [RULING_LOCKS.identity]);
    return reclassify({ query, keys: admin.keys }, { commit: !options.dryRun });
  });
}

// False for an id that is no identity ruling, or one already lifted. A lift only joins fewer
// people, so it withdraws nothing. A lifted mark leaves its address to the list again, in the same
// transaction.
export async function liftIdentity(
  admin: AdminContext,
  id: RulingId,
  options: { requestId: string },
): Promise<boolean> {
  const now = admin.now();
  return admin.transaction(async (query) => {
    await lockRows(query, [RULING_LOCKS.identity, authorWord(IDENTITY_AUTHOR)]);
    const repeat = await repeatedRuling(query, options.requestId);
    if (repeat !== undefined) {
      if (repeat.supersedes !== id) throw new AdminError("invalid_argument");
      return true;
    }
    const [row] = await query<{ compartments: PersonalCompartment[]; verdict: IdentityVerdict; a_fp: string }>(
      "select d.compartments, r.verdict, r.a_fp from knowledge.identity_rulings r join knowledge.owner_decisions d on d.id = r.ruling_id where r.ruling_id = $1 and r.lifted_at is null",
      [id],
    );
    if (row === undefined) return false;
    const lift = await ownerDecision(
      query,
      { requestId: options.requestId, kind: "identity_lift", supersedes: id, compartments: row.compartments },
      now,
    );
    await liftRulings(query, "knowledge.identity_rulings", [id], lift, now);
    // The card the owner answered waits for them again.
    await reopenAnswered(query, id, now);
    if (isMark(row.verdict)) await reclassify({ query, keys: admin.keys }, { fps: [row.a_fp], commit: true });
    return true;
  });
}

// Every ruling, oldest first, with the people that hold its addresses now, or null.
// `policy` alone lists the policy's merges (`pi identity merges --auto`),
// in force, or with `lifted` lifted ones too.
export async function listIdentity(
  admin: AdminContext,
  options: { policy?: { lifted: boolean } } = {},
): Promise<IdentityRulingView[]> {
  return admin.transaction(async (query) => {
    const rows = await query<
      Omit<RulingRow, "ruling_id"> & {
        ruling_id: RulingId;
        a: EntityId | null;
        b: EntityId | null;
        kind: string;
        basis: IdentityBasis | null;
      }
    >(
      `select r.ruling_id, r.verdict, r.a_fp, r.b_fp, r.created_at, r.lifted_at, d.kind, d.details ->> 'basis' as basis,
         (select min(a.entity_id) from knowledge.accounts a join knowledge.entities e on e.id = a.entity_id where e.kind = 'person' and a.value_fp = r.a_fp) as a,
         (select min(a.entity_id) from knowledge.accounts a join knowledge.entities e on e.id = a.entity_id where e.kind = 'person' and a.value_fp = r.b_fp) as b
       from knowledge.identity_rulings r join knowledge.owner_decisions d on d.id = r.ruling_id
       where ($1::boolean is null or (d.kind = 'identity_policy' and ($1 or r.lifted_at is null)))
       order by r.created_at, r.ruling_id collate "C"`,
      [options.policy === undefined ? null : options.policy.lifted],
    );
    return rows.map((row) => ({
      id: row.ruling_id,
      verdict: row.verdict,
      a: row.a,
      b: row.b_fp === null ? null : row.b,
      at: stamp(row.created_at),
      liftedAt: row.lifted_at === null ? null : stamp(row.lifted_at),
      ...(row.kind === "identity_policy" && row.basis !== null
        ? { by: "policy" as const, basis: row.basis }
        : { by: "owner" as const }),
    }));
  });
}

// `pia identity thin`: the live joins that rest on little (thin-merges.ts).
export async function listThinMerges(admin: AdminContext): Promise<
  {
    ruling: RulingId;
    a: EntityId | null;
    b: EntityId | null;
    by: "policy" | "owner";
    basis: string | null;
    reason: string;
    at: string;
  }[]
> {
  return admin.transaction(async (query) =>
    (await thinMerges(query, admin.keys)).map((row) => ({
      ...row,
      ruling: row.ruling as RulingId,
      a: row.a as EntityId | null,
      b: row.b as EntityId | null,
      at: stamp(row.at),
    })),
  );
}

// The owner's switch for agents answering same-person pairs, `pia identity agents on|off`. Turning it
// off stops new answers and lifts none.
export async function setIdentityAgents(admin: AdminContext, value: "on" | "off"): Promise<void> {
  await admin.transaction(async (query) => {
    await query("update policy.work_settings set identity_agents = $1", [value]);
  });
}

// `pi identity agents`: every answer an agent gave on a pair, for the owner's audit. Lifting one is
// `pi identity lift RULING`.
export async function listIdentityAnswers(admin: AdminContext): Promise<IdentityAnswerView[]> {
  return admin.transaction(async (query) => {
    const rows = await query<{
      question_id: string;
      a_entity: string;
      b_entity: string;
      client_name: string;
      verdict: IdentityAnswerView["verdict"];
      because: string | null;
      cites: string[];
      created_at: Date;
      ruling_id: string | null;
      lifted: boolean;
      refused_code: string | null;
    }>(
      `select a.question_id, q.a_entity, q.b_entity, a.client_name, a.verdict, a.because, a.cites, a.created_at, a.ruling_id, a.refused_code,
         coalesce((select r.lifted_at is not null from knowledge.identity_rulings r where r.ruling_id = a.ruling_id), false) as lifted
       from ledger.identity_answers a join ledger.identity_questions q on q.id = a.question_id
       order by a.created_at desc, a.id desc`,
    );
    return rows.map((row) => ({
      question: row.question_id,
      a: row.a_entity,
      b: row.b_entity,
      client: row.client_name,
      verdict: row.verdict,
      because: row.because,
      cites: row.cites,
      at: stamp(row.created_at),
      ruling: row.ruling_id,
      lifted: row.lifted,
      refused: row.refused_code,
    }));
  });
}

export async function listQuestionRules(admin: AdminContext): Promise<QuestionRuleView[]> {
  return admin.transaction(async (query) => {
    const rows = await query<{
      id: string;
      kind: string;
      pattern: string;
      answer: string;
      answers: number;
      status: QuestionRuleView["status"];
      proposed_at: Date;
      decided_at: Date | null;
      lifted_at: Date | null;
    }>(
      "select id, kind, pattern, answer, answers, status, proposed_at, decided_at, lifted_at from ledger.question_rules order by proposed_at desc, id",
    );
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      pattern: row.pattern,
      answer: row.answer,
      answers: row.answers,
      status: row.status,
      proposedAt: stamp(row.proposed_at),
      decidedAt: row.decided_at === null ? null : stamp(row.decided_at),
      liftedAt: row.lifted_at === null ? null : stamp(row.lifted_at),
    }));
  });
}

// One confirmed rule lifted: it holds nothing from now on and is never proposed again, a lift being the
// owner's no on it. What it stopped stays on record and is not raised again by itself, since that would
// ask the owner everything at once: the answer names those cards, and `pi cards reopen` gives any one back.
// A pair a rule ruled keeps its ruling, which `pi identity lift` undoes.
export async function liftQuestionRule(
  admin: AdminContext,
  id: string,
): Promise<{ lifted: boolean; stopped: string[] }> {
  const now = admin.now();
  return admin.transaction(async (query) => {
    const [rule] = await query<{ kind: string; pattern: string }>(
      "update ledger.question_rules set status = 'lifted', lifted_at = $2 where id = $1 and status = 'confirmed' returning kind, pattern",
      [id, stamp(now)],
    );
    if (rule === undefined) return { lifted: false, stopped: [] };
    const stopped = await query<{ id: string }>(
      `select c.id from ledger.cards c
       where c.kind = $1 and ledger.card_pattern(c.id) = $2 and c.tainted_at is null
         and (${latestRow("r.code", "card", "c.id")}) = 'rule_stopped'
       order by c.id`,
      [rule.kind, rule.pattern],
    );
    return { lifted: true, stopped: stopped.map((one) => one.id) };
  });
}

// The owner's switch for automatic merges, `pia identity merges on|off`.
// Turning it off stops new merges and lifts none.
export async function setIdentityMerges(admin: AdminContext, value: "on" | "off"): Promise<void> {
  await admin.transaction(async (query) => {
    await query("update policy.work_settings set identity_merges = $1", [value]);
  });
}

// Refused while the label's contacts token exists. It leaves every ruling and writes no suppression
// and no removed evidence. A repeat removes nothing.
export async function removeContacts(
  admin: AdminContext,
  label: string,
  _options: { requestId: string },
): Promise<{ items: number }> {
  return admin.transaction(async (query) => {
    await syncLock(query);
    const [token] = await query<{ yes: boolean }>(
      "select exists (select 1 from policy.secrets where name = $1) as yes",
      [googleSecretName(label, "contacts_refresh_token")],
    );
    if (token?.yes === true) throw new AdminError("contacts_connected");
    const [account] = await query<{ id: string; compartments: string[] }>(
      "select id, compartments from vault.source_accounts where label = $1 and connector = 'google_contacts'",
      [label],
    );
    if (account === undefined) return { items: 0 };
    const items = await query<{ source_item_fp: string }>(
      "select distinct source_item_fp from vault.evidence_items where source_account_id = $1 order by 1",
      [account.id],
    );
    // The next listing starts again from nothing, so a reconnect stores every contact again.
    await query("update vault.source_accounts set cursor_enc = null, cursor_updated_at = now() where id = $1", [
      account.id,
    ]);
    let removed = 0;
    for (const item of items) {
      const gone = await removeSourceItem(
        { query, keys: admin.keys },
        { id: account.id, compartment: account.compartments[0] ?? "" },
        item.source_item_fp,
        // The owner removed the account that held it; only a reconnect stores it again.
        "dropped",
      );
      if (gone.removed) removed += 1;
    }
    return { items: removed };
  });
}
