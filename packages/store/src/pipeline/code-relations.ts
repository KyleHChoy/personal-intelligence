import { Claim } from "@intelligence/contracts";
import { type ClaimRecord, isRestricted, isSystemNotice } from "@intelligence/contracts/personal";
import {
  type CodeRelation,
  claimTier,
  codeRelations,
  type EvidenceItem,
  type KeyedClaim,
} from "@intelligence/personal-beliefs";
import { relationRules } from "@intelligence/personal-core/views";
import { claimKeysOf, valueFpOf } from "../core/claim-columns.ts";
import type { Query } from "../core/db.ts";
import { byText } from "../core/db.ts";
import type { Keys } from "../core/keys.ts";
import { open, type Sealed } from "../core/seal.ts";
import { OWNER_ENTITY } from "../core/statements.ts";
import { claimRecordOf, type Tx } from "../core/tx.ts";

// Code's relations, written in the commit's own transaction for the fact keys its new claims hold.
// The rules are personal-beliefs' (`codeRelations`); this file reads what they compare from clear
// columns and the claims the Pipeline may open, and writes the relations. A relation's label is the
// union of both claims' labels (invariant 4), and one whose union is restricted is not the
// Pipeline's to write.

const RELATION_VERSION = relationRules().version;
export const labelOf = (a: readonly string[], b: readonly string[]): string[] =>
  [...new Set([...a, ...b])].sort(byText);
export const restricted = (compartments: readonly string[]): boolean => compartments.some(isRestricted);

type ClaimRow = {
  id: string;
  evidence_id: string;
  fact_key_fp: string;
  legacy_fact_key_fp: string | null;
  legacy_alt_fact_key_fp: string | null;
  compartments: string[];
  content_enc: Sealed;
};

// What the code relation check compares of one item, from clear columns: its sender's domain and thread, whether it
// is an agent's record, whether its mail authenticates, whether the triage screen withheld it or an
// agent record was flagged, and the organizations its sender's domain belongs to.
type ItemRow = {
  id: string;
  agent: boolean;
  domain: string | null;
  thread: string | null;
  auth: string | null;
  flagged: boolean;
  organizations: string[];
  agent_app: boolean;
};

export async function itemFacts(query: Query, evidenceIds: readonly string[]): Promise<Map<string, ItemRow>> {
  if (evidenceIds.length === 0) return new Map();
  const rows = await query<ItemRow>(
    `select e.id, exists (select 1 from knowledge.captures k where k.evidence_id = e.id and k.agent_app) as agent_app,
       e.source_kind = 'agent_record' as agent, m.sender_domain_fp as domain, coalesce(m.thread_fp, e.thread_fp) as thread, m.auth,
       coalesce(p.withheld, false) or exists (select 1 from ledger.agent_writes w where w.evidence_id = e.id and w.flagged_at is not null) as flagged,
       array(select distinct d.entity_id from knowledge.domains d where m.sender_domain_fp is not null and d.domain_fp = m.sender_domain_fp order by 1) as organizations
     from vault.evidence_items e
     left join knowledge.messages m on m.evidence_id = e.id
     left join vault.pipeline_items p on p.evidence_id = e.id
     where e.id = any ($1::text[])`,
    [[...new Set(evidenceIds)]],
  );
  return new Map(rows.map((row) => [row.id, row]));
}

// One claim as the code relation check sees it, with its own claim key.
export function keyedClaim(
  keys: Keys,
  row: ClaimRow,
  record: ClaimRecord,
  item: ItemRow | undefined,
  owner: string | undefined,
): KeyedClaim {
  const claim = Claim.parse(record.claim);
  const organization = record.claim.content.fields.organization;
  const evidence: EvidenceItem = {
    item: row.evidence_id,
    domain: item?.domain ?? null,
    thread: item?.thread ?? null,
    agent: item?.agent ?? false,
    firstHand: item?.agent_app !== true && claim.assertedBy !== undefined && claim.assertedBy === claim.content.subject,
    authenticated: item?.auth === "pass",
    domainMatches: typeof organization === "string" && (item?.organizations ?? []).includes(organization),
    at: claim.validFrom,
    flagged: item?.flagged ?? false,
  };
  const tier = claimTier(
    {
      claim,
      origin: record.origin,
      subjectKind: record.subjectKind,
      ownerSaid: owner !== undefined && claim.assertedBy === owner,
      ...(item?.agent_app === true ? { ownLine: true as const } : {}),
      ...(isSystemNotice(record) ? { notice: true as const } : {}),
    },
    true,
  );
  return {
    key: claimKeysOf({ keys }, row.evidence_id, [row.fact_key_fp])[0] as string,
    id: row.id,
    item: row.evidence_id,
    claim,
    subjectKind: record.subjectKind,
    tier,
    valueFp: valueFpOf(keys, record),
    evidence,
  };
}

// Every claim of the fact keys given that the Pipeline may open, each with its record: never a
// released claim or an agent's close (they have their own rules), never one whose label holds a
// compartment the keys lack.
export async function claimsOnKeys(
  query: Query,
  keys: Keys,
  factKeyFps: readonly string[],
): Promise<{ row: ClaimRow; record: ClaimRecord }[]> {
  if (factKeyFps.length === 0) return [];
  const rows = await query<ClaimRow>(
    `select id, evidence_id, fact_key_fp, legacy_fact_key_fp, legacy_alt_fact_key_fp, compartments, content_enc
     from knowledge.claims where fact_key_fp = any ($1::text[]) and not released and not closes order by fact_key_fp, id collate "C"`,
    [[...new Set(factKeyFps)]],
  );
  const out: { row: ClaimRow; record: ClaimRecord }[] = [];
  for (const row of rows) {
    // A claim that fails to open takes part in no relation, and never fails the commit (a
    // hidden-compartment claim whose key is gone).
    const record = claimRecordOf(open(keys, row, "knowledge.claims.content_enc", "null"));
    if (record !== null) out.push({ row, record });
  }
  return out;
}

// A relation needs both claims' value rows. Insert only, as every claim writer does.
export async function ensureValueRows(
  query: Query,
  keys: Keys,
  claims: readonly { row: ClaimRow; record: ClaimRecord }[],
): Promise<void> {
  for (const { row, record } of claims) {
    await query(
      `insert into knowledge.claim_values (claim_id, claim_key, value_fp, compartments)
       select $1, k.key, $3, $4 from unnest($2::text[]) as k (key) order by k.key collate "C" on conflict do nothing`,
      [
        row.id,
        claimKeysOf({ keys }, row.evidence_id, [row.fact_key_fp, row.legacy_fact_key_fp, row.legacy_alt_fact_key_fp]),
        valueFpOf(keys, record),
        row.compartments,
      ],
    );
  }
}

// One relation, unless its union label is restricted; a relation already there is kept.
export async function insertRelation(
  query: Query,
  relation: { from: string; to: string; kind: string; judge: string; version: number; compartments: readonly string[] },
): Promise<boolean> {
  if (restricted(relation.compartments) || relation.from === relation.to) return false;
  const rows = await query<{ id: string }>(
    `insert into knowledge.claim_relations (from_claim_key, to_claim_key, kind, judged_by, version, compartments)
     values ($1, $2, $3, $4, $5, $6::text[])
     on conflict (from_claim_key, to_claim_key, kind, judged_by) do nothing returning id::text`,
    [relation.from, relation.to, relation.kind, relation.judge, relation.version, [...relation.compartments]],
  );
  return rows.length > 0;
}

// At commit: the code relations of the fact keys the commit's new claims hold. Counts.
export async function writeCodeRelations(
  tx: Tx,
  added: readonly string[],
  factKeyFps: readonly string[],
): Promise<{ written: number }> {
  if (added.length === 0 || factKeyFps.length === 0) return { written: 0 };
  const claims = await claimsOnKeys(tx.query, tx.keys, factKeyFps);
  const items = await itemFacts(
    tx.query,
    claims.map((one) => one.row.evidence_id),
  );
  const [owner] = await tx.query<{ id: string }>(OWNER_ENTITY);
  const keyed = new Map<string, KeyedClaim[]>();
  const rowOf = new Map<string, { row: ClaimRow; record: ClaimRecord }>();
  for (const one of claims) {
    const claim = keyedClaim(tx.keys, one.row, one.record, items.get(one.row.evidence_id), owner?.id);
    keyed.set(one.row.fact_key_fp, [...(keyed.get(one.row.fact_key_fp) ?? []), claim]);
    rowOf.set(claim.key, one);
  }
  const fresh = new Set(added);
  const relations: CodeRelation[] = [...keyed.values()].flatMap((onKey) =>
    codeRelations(onKey, fresh, relationRules()),
  );
  if (relations.length === 0) return { written: 0 };
  const named = [...new Set(relations.flatMap((one) => [one.from, one.to]))]
    .map((key) => rowOf.get(key))
    .filter((one) => one !== undefined);
  await ensureValueRows(tx.query, tx.keys, named);
  let written = 0;
  for (const relation of relations) {
    const [from, to] = [rowOf.get(relation.from), rowOf.get(relation.to)];
    if (from === undefined || to === undefined) continue;
    if (
      await insertRelation(tx.query, {
        ...relation,
        version: RELATION_VERSION,
        compartments: labelOf(from.row.compartments, to.row.compartments),
      })
    )
      written += 1;
  }
  return { written };
}
