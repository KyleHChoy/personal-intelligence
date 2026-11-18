import type { ClaimRelationKind, FactSettlementId } from "@intelligence/contracts/personal";
import {
  BELIEF_TYPES,
  FactId,
  type FactKeyFp,
  type FactRulingVerdict,
  type GroupingMode,
  type PersonalCompartment,
  type RulingId,
} from "@intelligence/contracts/personal";
import type { AdminContext } from "../../core/admin-context.ts";
import { AdminError, asRulingError } from "../../core/admin-error.ts";
import { type Query, stamp, stampOrNull } from "../../core/db.ts";
import type { Keys } from "../../core/keys.ts";
import { BELIEFS_LOCK } from "../../core/locks.ts";
import { ownerDecision } from "../../core/owner-decision.ts";
import { answerOfRulingRequest, cardRulingRequest, lockRows } from "../../core/queue.ts";
import type { Sealed } from "../../core/seal.ts";
import { openedUnder, type Tx } from "../../core/tx.ts";
import { reopenSettlement } from "../../pipeline/fact-settlements.ts";
import {
  type GroupingRelationCode,
  type GroupingRelationRow,
  groupingRelation,
} from "../../pipeline/grouping-relation.ts";
import { claimRecordUnder } from "../admin-owner.ts";
import { reopenAnswered } from "../cards/admin-reopen.ts";
import { liftRulings } from "./owner-ruling.ts";
import { anchorRuling, carryShown } from "./ruling-anchors.ts";

// A ruling names two fact keys by a claim of each; it is read at every rebuild (`policy.fact_rulings()`) and
// binds it (invariant 11). As a fact veto does, a ruling deletes the beliefs of its two keys that its audiences
// see, and the next `pi extract` rebuilds them under it.

// One ruling, lifted or not. `a` and `b` are its fact keys, sorted; `gone`, that a key it names has
// no claim left.
export type FactRulingView = {
  id: RulingId;
  verdict: FactRulingVerdict;
  a: FactKeyFp;
  b: FactKeyFp;
  at: string;
  liftedAt: string | null;
  gone: boolean;
};

const KIND = { join: "fact_join", split: "fact_split" } as const;

type Named = {
  id: string;
  type: string;
  fact_key_fp: FactKeyFp;
  compartments: PersonalCompartment[];
  content_enc: Sealed;
  key_compartments: PersonalCompartment[];
};
const NAMED = `
  select c.id, c.type, c.fact_key_fp, c.compartments, c.content_enc,
    ledger.label(array(select x from knowledge.claims k cross join unnest(k.compartments) as x where k.fact_key_fp = c.fact_key_fp)) as key_compartments
  from knowledge.claims c where c.id = $1`;

async function asRuled(
  query: Query,
  keys: Keys,
  claim: Named,
): Promise<{ subject: string; type: string; domain: string | null }> {
  const record = claimRecordUnder(keys, claim);
  const rulings = await query<{
    ruling_id: string;
    verdict: "domain" | "kind";
    compartments: string[];
    value_enc: Sealed;
  }>(
    "select ruling_id, verdict, compartments, value_enc from knowledge.belief_rulings where fact_key_fp = $1 and verdict in ('domain', 'kind') and lifted_at is null",
    [claim.fact_key_fp],
  );
  const ruled = (verdict: "domain" | "kind"): string | undefined => {
    const one = rulings.find((each) => each.verdict === verdict);
    return one === undefined
      ? undefined
      : openedUnder(
          keys,
          one.compartments,
          { table: "knowledge.belief_rulings", id: one.ruling_id, column: "value_enc" },
          one.value_enc,
        );
  };
  const own = record.claim.content.fields.domain;
  return {
    subject: record.claim.content.subject,
    type: ruled("kind") ?? claim.type,
    domain: ruled("domain") ?? (typeof own === "string" ? own : null),
  };
}

// One join or split of two fact keys, written by a command or a card's answer inside the caller's
// transaction, which holds the beliefs lock. `decision` is the owner decision it rests on: one this
// writes for a command, the card's answer for a card. Refuses `already_ruled` for the same ruling
// in force on the pair, and `conflicting_ruling` for the other one, which the owner lifts first.
// `via`: `cleanup` for a join `pia facts clean --apply` writes, in its details.
export async function writeFactRuling(
  query: Query,
  ruling: {
    verdict: FactRulingVerdict;
    a: FactKeyFp;
    b: FactKeyFp;
    compartments: PersonalCompartment[];
    requestId: string;
    now: Date;
    via?: "cleanup";
  },
): Promise<RulingId> {
  const [a, b] = ruling.a < ruling.b ? [ruling.a, ruling.b] : [ruling.b, ruling.a];
  if (a === b) throw new AdminError("invalid_argument");
  const [standing] = await query<{ verdict: FactRulingVerdict }>(
    "select verdict from knowledge.fact_rulings where a_fp = $1 and b_fp = $2 and lifted_at is null",
    [a, b],
  );
  if (standing !== undefined)
    throw new AdminError(standing.verdict === ruling.verdict ? "already_ruled" : "conflicting_ruling");
  const id = await ownerDecision(
    query,
    {
      requestId: ruling.requestId,
      kind: KIND[ruling.verdict],
      details: ruling.via === undefined ? { a, b } : { a, b, via: ruling.via },
      compartments: ruling.compartments,
    },
    ruling.now,
  );
  await query(
    "insert into knowledge.fact_rulings (ruling_id, verdict, a_fp, b_fp, created_at, compartments) values ($1, $2, $3, $4, $5, ledger.label($6))",
    [id, ruling.verdict, a, b, stamp(ruling.now), ruling.compartments],
  );
  // What the ruling was made on, beside its two keys: the clear anchors here, for every caller;
  // what was shown is sealed by a caller that holds the keys, or by the anchor sweep.
  await query("select knowledge.anchor_rulings($1::text[])", [[id]]);
  return id;
}

// A join or a split of the owner's re-attached by code to the two fact keys its sides now are, as
// `carryIn` (ruling-carry.ts) re-attaches a ruling on one key: a new ruling of the same verdict
// under a `ruling_carry` decision that names the carried ruling and `claim`, a claim of a key that
// moved, with the carried ruling's time. `already_ruled` when a join or a split is in force on the
// pair already, and nothing is written.
export async function carryPairIn(
  admin: AdminContext,
  query: Query,
  ruling: { id: RulingId; verdict: FactRulingVerdict; createdAt: Date },
  pair: { a: FactKeyFp; b: FactKeyFp; claim: FactId },
): Promise<"carried" | "already_ruled"> {
  const [a, b] = pair.a < pair.b ? [pair.a, pair.b] : [pair.b, pair.a];
  if (a === b) return "already_ruled";
  const [standing] = await query(
    "select 1 from knowledge.fact_rulings where a_fp = $1 and b_fp = $2 and lifted_at is null",
    [a, b],
  );
  if (standing !== undefined) return "already_ruled";
  const [label] = await query<{ compartments: PersonalCompartment[] }>(
    "select ledger.label(array(select x from knowledge.claims k cross join unnest(k.compartments) as x where k.fact_key_fp in ($1, $2))) as compartments",
    [a, b],
  );
  const compartments = label?.compartments ?? [];
  const carry = await ownerDecision(
    query,
    {
      requestId: `carry-${ruling.id}`,
      kind: "ruling_carry",
      details: { from: ruling.id, claim: pair.claim },
      compartments,
    },
    admin.now(),
  );
  await query(
    "insert into knowledge.fact_rulings (ruling_id, verdict, a_fp, b_fp, created_at, compartments) values ($1, $2, $3, $4, $5, ledger.label($6))",
    [carry, ruling.verdict, a, b, stamp(ruling.createdAt), compartments],
  );
  // What the owner was shown stays the first ruling's, its two claims in the new keys' order.
  await carryShown(admin, query, carry, ruling.id, pair.a > pair.b);
  return "carried";
}

// The ruling's compartments are those of every claim of both keys.
export async function namedPair(
  query: Query,
  keys: Keys,
  verdict: FactRulingVerdict,
  x: string,
  y: string,
): Promise<{ a: FactKeyFp; b: FactKeyFp; compartments: PersonalCompartment[] }> {
  const claims: Named[] = [];
  for (const id of [x, y]) {
    const [claim] = FactId.safeParse(id).success ? await query<Named>(NAMED, [id]) : [];
    if (claim === undefined) throw new AdminError("not_found");
    if (!(BELIEF_TYPES as readonly string[]).includes(claim.type)) throw new AdminError("no_belief");
    claims.push(claim);
  }
  const [one, two] = claims as [Named, Named];
  if (one.fact_key_fp === two.fact_key_fp) throw new AdminError("invalid_argument");
  if (verdict === "join") {
    const [p, q] = [await asRuled(query, keys, one), await asRuled(query, keys, two)];
    if (p.subject !== q.subject || p.type !== q.type || p.domain !== q.domain) throw new AdminError("not_one_fact");
  }
  const [label] = await query<{ compartments: PersonalCompartment[] }>(
    "select ledger.label($1::text[] || $2::text[]) as compartments",
    [one.key_compartments, two.key_compartments],
  );
  return { a: one.fact_key_fp, b: two.fact_key_fp, compartments: label?.compartments ?? [] };
}

async function rule(
  admin: AdminContext,
  verdict: FactRulingVerdict,
  x: FactId,
  y: FactId,
  requestId: string,
): Promise<RulingId> {
  const now = admin.now();
  try {
    return await admin.transaction(async (query) => {
      // The beliefs lock first, then the shared taint lock, as every ruling on beliefs takes them.
      await query(BELIEFS_LOCK);
      await lockRows(query, []);
      // A repeated request id returns the first ruling and writes nothing; one that made another
      // kind of decision is refused.
      const [repeat] = await query<{ id: RulingId; kind: string }>(
        "select id, kind from knowledge.owner_decisions where request_id = $1",
        [requestId],
      );
      if (repeat !== undefined) {
        if (repeat.kind !== KIND[verdict]) throw new AdminError("invalid_argument");
        return repeat.id;
      }
      const pair = await namedPair(query, admin.keys, verdict, x, y);
      const ruling = await writeFactRuling(query, { verdict, ...pair, requestId, now });
      await anchorRuling(admin, query, ruling);
      return ruling;
    });
  } catch (error) {
    throw asRulingError(error);
  }
}

// `pi facts join FACT FACT`: the two claims' fact keys are one fact, in every audience that sees
// both, whatever any model says. Refused unless they are of one subject, kind and domain (D17).
export const joinFacts = (
  admin: AdminContext,
  a: FactId,
  b: FactId,
  options: { requestId: string },
): Promise<RulingId> => rule(admin, "join", a, b, options.requestId);

// `pi facts split FACT FACT`: the two keys are never joined, and no model's pairing joins them.
export const splitFacts = (
  admin: AdminContext,
  a: FactId,
  b: FactId,
  options: { requestId: string },
): Promise<RulingId> => rule(admin, "split", a, b, options.requestId);

// `pi facts rulings`: every join and split, lifted or not, oldest first. A ruling whose key has no
// claim left is marked, never deleted here (the erasure hook deletes it).
export async function listFactRulings(admin: AdminContext): Promise<FactRulingView[]> {
  return admin.transaction(async (query) => {
    const rows = await query<{
      ruling_id: RulingId;
      verdict: FactRulingVerdict;
      a_fp: FactKeyFp;
      b_fp: FactKeyFp;
      created_at: Date;
      lifted_at: Date | null;
      gone: boolean;
    }>(
      `select r.ruling_id, r.verdict, r.a_fp, r.b_fp, r.created_at, r.lifted_at,
         not (exists (select 1 from knowledge.claims c where c.fact_key_fp = r.a_fp) and exists (select 1 from knowledge.claims c where c.fact_key_fp = r.b_fp)) as gone
       from knowledge.fact_rulings r
       order by r.created_at, r.ruling_id collate "C"`,
    );
    return rows.map((row) => ({
      id: row.ruling_id,
      verdict: row.verdict,
      a: row.a_fp,
      b: row.b_fp,
      at: stamp(row.created_at),
      liftedAt: stampOrNull(row.lifted_at),
      gone: row.gone,
    }));
  });
}

// For the page's Settings, which names each join or split by its facts: the latest claim of each
// fact key, by its id (the page opens it with `factShow`, which keeps its own audience). A key with
// no claim left is not in the map.
export async function latestClaims(admin: AdminContext, keys: readonly string[]): Promise<Map<string, FactId>> {
  if (keys.length === 0) return new Map();
  return admin.transaction(async (query) => {
    const rows = await query<{ fact_key_fp: string; id: FactId }>(
      `select distinct on (c.fact_key_fp) c.fact_key_fp, c.id from knowledge.claims c
       where c.fact_key_fp = any ($1::text[]) order by c.fact_key_fp, c.valid_from desc, c.id`,
      [[...new Set(keys)]],
    );
    return new Map(rows.map((row) => [row.fact_key_fp, row.id]));
  });
}

// `pi facts lift RULING`: a lift decision that supersedes the ruling's, the ruling's lift columns, and the drop
// of its keys' beliefs. False for an id that is no join or split in force. As `liftRuling` takes an about_you
// answer, an id that is the answer from the owner to a same_fact card lifts the join or split that answer made
// (sameFact's `card_<answer>` request id), and the card waits for the owner again: the page's Undo of that
// answer.
export async function liftFactRuling(
  admin: AdminContext,
  id: RulingId,
  options: { requestId: string },
): Promise<boolean> {
  const now = admin.now();
  try {
    return await admin.transaction(async (query) => {
      await query(BELIEFS_LOCK);
      await lockRows(query, []);
      // By its own id, else by the card answer that made it: two indexed lookups.
      const RULING = `select r.ruling_id, r.a_fp, r.b_fp, r.compartments, r.lifted_at is not null as lifted, d.request_id
         from knowledge.fact_rulings r join knowledge.owner_decisions d on d.id = r.ruling_id where r.ruling_id = $1`;
      type Found = {
        ruling_id: RulingId;
        a_fp: string;
        b_fp: string;
        compartments: PersonalCompartment[];
        lifted: boolean;
        request_id: string;
      };
      let [ruling] = await query<Found>(RULING, [id]);
      if (ruling === undefined) {
        const [made] = await query<{ id: string }>("select id from knowledge.owner_decisions where request_id = $1", [
          cardRulingRequest(id),
        ]);
        if (made !== undefined) [ruling] = await query<Found>(RULING, [made.id]);
      }
      const [repeat] = await query<{ supersedes: string | null }>(
        "select supersedes from knowledge.owner_decisions where request_id = $1",
        [options.requestId],
      );
      if (repeat !== undefined) {
        if (repeat.supersedes !== (ruling?.ruling_id ?? id)) throw new AdminError("invalid_argument");
        return true;
      }
      if (ruling === undefined || ruling.lifted) return false;
      const lift = await ownerDecision(
        query,
        {
          requestId: options.requestId,
          kind: "fact_ruling_lift",
          supersedes: ruling.ruling_id,
          compartments: ruling.compartments,
        },
        now,
      );
      await liftRulings(query, "knowledge.fact_rulings", [ruling.ruling_id], lift, now);
      // The card the answer was on waits for the owner again, however the ruling was named.
      const answer = answerOfRulingRequest(ruling.request_id);
      if (answer !== null) await reopenAnswered(query, answer as RulingId, now);
      return true;
    });
  } catch (error) {
    throw asRulingError(error);
  }
}

const GROUPING_ANSWERS = 30;
const GROUPING_AGREEMENT = 0.95;

// `pi facts grouping off|shadow|apply`: `policy.owner_settings.grouping`, under pi_admin's update
// of that column alone. `apply` is refused with `agreement_unmet` until the accept band's agreement
// with the owner meets D12's rule; `off` and `shadow` always set.
export async function setGroupingMode(admin: AdminContext, mode: GroupingMode): Promise<void> {
  await admin.transaction(async (query) => {
    if (mode === "apply") {
      const [answers] = await query<{ agreed: number; answered: number }>(
        `select count(*) filter (where r.verdict = 'join')::int as agreed, count(r.verdict)::int as answered
         from knowledge.same_fact_judgments g
         join knowledge.fact_rulings r on r.a_fp = g.a_fp and r.b_fp = g.b_fp and r.lifted_at is null
         where g.band = 'accept' and g.rung in (1, 2) and g.card_id is not null`,
      );
      const answered = answers?.answered ?? 0;
      if (answered < GROUPING_ANSWERS || (answers?.agreed ?? 0) < GROUPING_AGREEMENT * answered)
        throw new AdminError("agreement_unmet");
    }
    await query("update policy.owner_settings set grouping = $1", [mode]);
  });
}

// `pia facts groupings`, the shadow report: per band, the pairs, and those the owner joined or
// split since, by the rulings in force on their keys. Counts only. It reads
// `knowledge.same_fact_judgments`, with pi_admin's select of it.
type GroupingReport = { band: string; pairs: number; joined: number; split: number }[];
export async function groupingReport(admin: AdminContext): Promise<GroupingReport> {
  return admin.transaction(async (query) => {
    const rows = await query<{ band: string; pairs: number; joined: number; split: number }>(
      `select g.band, count(*)::int as pairs,
         count(*) filter (where r.verdict = 'join')::int as joined,
         count(*) filter (where r.verdict = 'split')::int as split
       from knowledge.same_fact_judgments g
       left join knowledge.fact_rulings r on r.a_fp = g.a_fp and r.b_fp = g.b_fp and r.lifted_at is null
       group by g.band
       order by g.band`,
    );
    return rows.map((row) => ({ ...row }));
  });
}

// The owner's reopen of a fact settlement.
export async function reopenFactSettlement(query: Query, id: FactSettlementId): Promise<void> {
  const outcome = await reopenSettlement(query, id);
  if (outcome === "not_found") throw new AdminError("not_found");
  if (outcome === "already_reopened") throw new AdminError("already_reopened");
}

// `pia relations on|off <kind>`, the owner's override of a model relation kind's switch for one
// judge, which the system's job then leaves alone. The owner's latest row decides the kind at read
// whatever the system's says (invariant 11): their `on` applies its model relations, and the dream
// pass audits them, and their `off` keeps them off.
export async function relationOverride(
  query: Query,
  options: { kind: ClaimRelationKind; on: boolean; judge: string },
): Promise<{ kind: ClaimRelationKind; on: boolean }> {
  await query(
    "insert into policy.relation_switches (kind, judge, switched_on, decided_by, measures) values ($1, $2, $3, 'owner', $4::jsonb)",
    [options.kind, options.judge, options.on, JSON.stringify({ code: "owner" })],
  );
  return { kind: options.kind, on: options.on };
}

// `pia relations convert-groupings`, once on the box: every same-fact judgment as a `same_fact`
// relation (grouping-relation.ts), its newest claims read within its label, one transaction for the
// whole, idempotent. Counts by what each judgment became.
export async function convertGroupings({ query, keys }: Tx): Promise<Record<GroupingRelationCode, number>> {
  const counts: Record<GroupingRelationCode, number> = {
    written: 0,
    kept: 0,
    not_same: 0,
    no_claim: 0,
    no_judge: 0,
    restricted: 0,
  };
  const rows = await query<GroupingRelationRow>(
    "select compartments as audience, a_fp, b_fp, band, rung, state, calls from knowledge.same_fact_judgments order by a_fp, b_fp, a_claim, b_claim",
  );
  for (const row of rows) counts[await groupingRelation(query, keys, row)] += 1;
  return counts;
}
