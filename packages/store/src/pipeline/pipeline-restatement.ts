import { AgentRecordItem, ClaimRecord, type RestatementCandidate } from "@intelligence/contracts/personal";
import { laterClaim } from "../core/claim-order.ts";
import { claimKey, fingerprint } from "../core/fingerprint.ts";
import { open, type Sealed } from "../core/seal.ts";
import type { Tx } from "../core/tx.ts";
import { computedBeliefs } from "./computed-beliefs.ts";
import { sortedAudience } from "./pipeline-beliefs.ts";
import { answeredEvidence, confirmedKeys } from "./pipeline-read.ts";

// The session's reads come through ledger.session_reads, with no grant on ledger.read_log; the
// claims by their stored fact key fingerprint and by their evidence id, never outside the record's
// label; each opened under its whole label. Nothing here writes. The extract package judges the
// statements.

type CandidateRow = {
  id: string;
  evidence_id: string;
  fact_key_fp: string;
  compartments: string[];
  content_enc: Sealed;
  rejected: boolean;
};

const CANDIDATES = `
  select c.id, c.evidence_id, c.fact_key_fp, c.compartments, c.content_enc,
    exists (select 1 from policy.rejected_claims() r
            where r.source_account_id = e.source_account_id and r.source_item_fp = e.source_item_fp
              and r.fact_key_fp in (c.fact_key_fp, c.legacy_fact_key_fp, c.legacy_alt_fact_key_fp)) as rejected
  from knowledge.claims c join vault.evidence_items e on e.id = c.evidence_id
  where c.type = $1 and c.compartments <@ $2::text[] and c.evidence_id <> $3
    and (c.fact_key_fp = any ($4::text[]) or c.evidence_id = any ($5::text[]))
  order by c.fact_key_fp, c.id collate "C"`;

const openClaim = (tx: Tx, row: { id: string; compartments: string[]; content_enc: Sealed }): ClaimRecord =>
  ClaimRecord.parse(JSON.parse(open(tx.keys, row, "knowledge.claims.content_enc", "throw")));

// No stored answer is read.
async function beliefOf(tx: Tx, factKeyFp: string, audience: string[]): Promise<RestatementCandidate["belief"]> {
  const [clock] = await tx.query<{ now: Date }>("select now() as now");
  const at = (clock?.now ?? new Date()).toISOString();
  const [record] = await computedBeliefs(tx.query, tx.keys, audience, [factKeyFp], at);
  if (record === undefined) return null;
  const support = await tx.query<{ id: string; compartments: string[]; content_enc: Sealed }>(
    "select id, compartments, content_enc from knowledge.claims where id = any ($1::text[])",
    [record.belief.support.map((claim) => fingerprint(tx.keys, "claim", claim))],
  );
  const latest = support
    .map((one) => openClaim(tx, one))
    .reduce<ClaimRecord | null>((found, one) => (found === null ? one : laterClaim(found, one)), null);
  return { status: record.belief.status, latest };
}

// None for an item that is no agent record with a body.
export async function restatementCandidates(
  tx: Tx,
  evidenceId: string,
  asked: { claim: ClaimRecord; heldKeys: string[] }[],
): Promise<RestatementCandidate[][]> {
  const none = asked.map(() => []);
  const [item] = await tx.query<{ source_kind: string; compartments: string[]; item_enc: Sealed }>(
    "select source_kind, compartments, item_enc from vault.evidence_items where id = $1",
    [evidenceId],
  );
  if (item === undefined || item.source_kind !== "agent_record") return none;
  const label = sortedAudience(item.compartments);
  const record = AgentRecordItem.parse(
    JSON.parse(
      open(
        tx.keys,
        { id: evidenceId, compartments: item.compartments, item_enc: item.item_enc },
        "vault.evidence_items.item_enc",
        "throw",
      ),
    ),
  );
  // No row for a record with no body.
  const [reads] = await tx.query<{ bound: string[]; fact_key_fps: string[] }>(
    "select bound, fact_key_fps from ledger.session_reads($1)",
    [evidenceId],
  );
  if (reads === undefined) return none;
  const readKeys = new Set(reads.fact_key_fps);
  const readItems = new Set([...reads.bound, ...record.cites]);

  const found = [];
  for (const one of asked) {
    const a = ClaimRecord.parse(one.claim);
    const held = one.heldKeys.map((key) => fingerprint(tx.keys, "fact", key));
    const rows = await tx.query<CandidateRow>(CANDIDATES, [
      a.claim.content.type,
      label,
      evidenceId,
      [...new Set([...readKeys, ...held])],
      [...readItems],
    ]);
    found.push(
      rows
        .map((row) => ({ row, record: openClaim(tx, row) }))
        .filter(({ record: candidate }) => candidate.claim.content.subject === a.claim.content.subject),
    );
  }
  // Mail the system sent has that origin and no card.
  const keyOf = (row: CandidateRow): string => claimKey(tx.keys, row.evidence_id, row.fact_key_fp);
  const confirmed = await confirmedKeys(
    tx.query,
    found
      .flat()
      .filter(({ record: candidate }) => candidate.origin === "agent_record")
      .map(({ row }) => keyOf(row)),
  );
  const answered = await answeredEvidence(
    tx.query,
    found
      .flat()
      .filter(({ record: candidate }) => candidate.origin === "agent_record")
      .map(({ row }) => row.evidence_id),
  );

  const beliefs = new Map<string, RestatementCandidate["belief"]>();
  const answers: RestatementCandidate[][] = [];
  for (const candidates of found) {
    const kept: RestatementCandidate[] = [];
    for (const { row, record: candidate } of candidates) {
      if (candidate.origin !== "source" && !confirmed.has(keyOf(row)) && !answered.has(row.evidence_id)) continue;
      if (!beliefs.has(row.fact_key_fp)) beliefs.set(row.fact_key_fp, await beliefOf(tx, row.fact_key_fp, label));
      kept.push({
        record: candidate,
        factKeyFp: row.fact_key_fp,
        reached: readKeys.has(row.fact_key_fp) || readItems.has(row.evidence_id) ? "read" : "held",
        belief: beliefs.get(row.fact_key_fp) ?? null,
        rejected: row.rejected,
      });
    }
    answers.push(kept);
  }
  return answers;
}
