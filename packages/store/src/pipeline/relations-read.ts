import {
  type BeliefCheckMark,
  type BeliefRelation,
  type BeliefSettlement,
  ClaimRelationKind,
  type RelationSwitchRow,
  SourceCheckVerdict,
} from "@intelligence/contracts/personal";
import { type Query, stamp } from "../core/db.ts";

// The relations and the switch rows the belief build applies, as the Pipeline reads them for its
// rebuild (every relation it may see, blind to restricted rows) and as the reader's statements give
// them (policy.belief_inputs_under's `relation` and `relation_switch` parts). Ids, claim keys,
// kinds, judges and times only.

type RelationRow = {
  id: string;
  from_claim_key: string;
  to_claim_key: string;
  kind: string;
  judged_by: string;
  judged_at: Date;
  compartments: string[];
};
type SwitchRow = { kind: string; judge: string; switched_on: boolean; decided_by: string; decided_at: Date };

export const relationOf = (row: RelationRow): BeliefRelation => ({
  id: row.id,
  from: row.from_claim_key,
  to: row.to_claim_key,
  kind: ClaimRelationKind.parse(row.kind),
  judge: row.judged_by,
  judgedAt: stamp(row.judged_at),
  compartments: [...row.compartments],
});

export const switchOf = (row: SwitchRow): RelationSwitchRow => ({
  kind: ClaimRelationKind.parse(row.kind),
  judge: row.judge,
  on: row.switched_on,
  at: stamp(row.decided_at),
  by: row.decided_by === "owner" ? "owner" : "system",
});

// The Pipeline's: every relation and every relation kind's switch row, oldest first, as a read gives
// them: a model relation only when it may take effect (policy.relation_effective), the agents'
// settlements in force, and every model check of a belief, of which the build takes the newest within
// each audience's label, as a reader's statements give them.
export async function pipelineRelations(query: Query): Promise<{
  relations: BeliefRelation[];
  switches: RelationSwitchRow[];
  settlements: BeliefSettlement[];
  beliefChecks: BeliefCheckMark[];
}> {
  const relations = await query<RelationRow>(
    `select id::text as id, from_claim_key, to_claim_key, kind, judged_by, judged_at, compartments from knowledge.claim_relations
     where policy.relation_effective(id, judged_by, kind, judged_at, now()) order by judged_at, id`,
  );
  const switches = await query<SwitchRow>(
    "select kind, judge, switched_on, decided_by, decided_at from policy.relation_switches where kind <> 'same_person' order by decided_at, id",
  );
  const settlements = await query<SettlementRow>(
    "select id, a_key, b_key, holds_key, created_at, compartments from ledger.belief_settlements where lifted_at is null order by created_at, id",
  );
  const checks = await query<CheckRow>(
    `select claim_keys, verdict, created_at, compartments from ledger.source_checks
     where target = 'belief' and starts_with(judge, 'model:') and verdict is not null and on_cited and live
     order by created_at, id`,
  );
  return {
    relations: relations.map(relationOf),
    switches: switches.map(switchOf),
    settlements: settlements.map(settlementOf),
    beliefChecks: checks.map(checkOf),
  };
}

type SettlementRow = {
  id: string;
  a_key: string;
  b_key: string;
  holds_key: string;
  created_at: Date;
  compartments: string[];
};
type CheckRow = { claim_keys: string[]; verdict: string; created_at: Date; compartments: string[] };

export const settlementOf = (row: SettlementRow): BeliefSettlement => ({
  id: row.id,
  a: row.a_key,
  b: row.b_key,
  holds: row.holds_key,
  at: stamp(row.created_at),
  compartments: [...row.compartments],
});

export const checkOf = (row: CheckRow): BeliefCheckMark => ({
  claimKeys: [...row.claim_keys],
  verdict: SourceCheckVerdict.parse(row.verdict),
  at: stamp(row.created_at),
  compartments: [...row.compartments],
});
