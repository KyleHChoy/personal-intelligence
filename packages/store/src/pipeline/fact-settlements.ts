import type {
  FactSettlementAnswer,
  FactSettlementId,
  SettledFactCounts,
  SettledReport,
} from "@intelligence/contracts/personal";
import { type Query, stamp } from "../core/db.ts";
import { settlementId } from "../core/ids.ts";
import { authorWord } from "../core/locks.ts";
import { EXTRACT_AUTHOR, lockRows } from "../core/queue.ts";
import { CARD_STATE, latestRow } from "../core/statements.ts";

// A fact the owner already answered raises no card, and a second card on an open fact waits on the
// first, so the owner is never asked the same thing twice. Every row of ledger.fact_settlements is ids,
// codes and times; the settlement in force for a claim key is its latest row. pi_pipeline writes
// and reads its own rows (`pipeline`), pi_admin's `decide` writes the rows its answer settles
// (`decide`) and `pi cards reopen` sets `reopened_at`.

const FACT_KINDS = ["about_you", "agent_claim"] as const;
type FactKind = (typeof FACT_KINDS)[number];

export type SettlementRow = {
  id: string;
  claim_key: string;
  card_id: string;
  answer: FactSettlementAnswer;
  kind: FactKind;
  claim_id: string | null;
  evidence_id: string | null;
  match_fp: string;
  withdrawn_card_id: string | null;
  written_by: "pipeline" | "decide";
  created_at: Date;
  reopened_at: Date | null;
  compartments: string[];
};

// Of a settlement `s`: no later row of its claim key that the caller reads, so `s` is in force.
// A filter that keeps the indexes on card_id and claim_key usable.
export const IN_FORCE =
  "not exists (select 1 from ledger.fact_settlements t where t.claim_key = s.claim_key and (t.created_at, t.id) > (s.created_at, s.id))";

// What the owner answered, in force on a match key within the label guard, or the card it waits on.
export async function factAnswer(
  query: Query,
  matchFp: string,
  compartments: readonly string[],
): Promise<{ card: string; answer: FactSettlementAnswer } | undefined> {
  const [row] = await query<{ settling_card: string; settled_answer: FactSettlementAnswer }>(
    "select settling_card, settled_answer from policy.fact_answer($1, $2)",
    [matchFp, [...compartments]],
  );
  return row === undefined ? undefined : { card: row.settling_card, answer: row.settled_answer };
}

export async function writeSettlement(
  query: Query,
  row: Pick<
    SettlementRow,
    | "claim_key"
    | "card_id"
    | "answer"
    | "kind"
    | "claim_id"
    | "evidence_id"
    | "match_fp"
    | "withdrawn_card_id"
    | "written_by"
    | "compartments"
  >,
): Promise<string> {
  const id = settlementId();
  await query(
    `insert into ledger.fact_settlements (id, claim_key, card_id, answer, kind, claim_id, evidence_id, match_fp, withdrawn_card_id, written_by, created_at, compartments)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), ledger.label($11))`,
    [
      id,
      row.claim_key,
      row.card_id,
      row.answer,
      row.kind,
      row.claim_id,
      row.evidence_id,
      row.match_fp,
      row.withdrawn_card_id,
      row.written_by,
      row.compartments,
    ],
  );
  return id;
}

// The settlement in force for one claim key, among the rows the caller reads.
export async function settlementOf(query: Query, claimKey: string): Promise<SettlementRow | undefined> {
  const [row] = await query<SettlementRow>(
    "select s.* from ledger.fact_settlements s where s.claim_key = $1 order by s.created_at desc, s.id desc limit 1",
    [claimKey],
  );
  return row;
}

// Item 4, `decide`'s half. Before its lock call: the other cards on each answered card's match key,
// which it adds to that one call (match_fp never changes once set, and `pi extract match-backfill`
// takes the author word `decide` holds).
export async function duplicatesOf(
  query: Query,
  cards: readonly { id: string; kind: string; created_by: string }[],
): Promise<string[]> {
  const ids = cards
    .filter((card) => card.created_by === EXTRACT_AUTHOR && (FACT_KINDS as readonly string[]).includes(card.kind))
    .map((card) => card.id);
  if (ids.length === 0) return [];
  const rows = await query<{ id: string }>(
    `select d.id from ledger.cards c join ledger.cards d on d.match_fp = c.match_fp and d.id <> c.id
     where c.id = any ($1) and c.match_fp is not null and d.created_by = 'system:extract' and d.kind = any ($2) and not (d.id = any ($1))
     order by d.id`,
    [ids, [...FACT_KINDS]],
  );
  return [...new Set(rows.map((row) => row.id))];
}

// After the answer's effect, in its transaction: the claims waiting on the card take the answer from the owner;
// every other undecided or deferred card on its match key whose label contains the card's, but the
// cards named in the call, is withdrawn with a settlement, and the claims waiting on it take the owner's
// answer too; then one admit_deferred. Only the owner's own `confirm` and `reject` settle.
export async function settleOnDecide(
  query: Query,
  card: { id: string; kind: string; created_by: string; compartments: string[] },
  answer: string,
  named: readonly string[],
): Promise<void> {
  if (card.created_by !== EXTRACT_AUTHOR || !(FACT_KINDS as readonly string[]).includes(card.kind)) return;
  const settled: FactSettlementAnswer | undefined =
    answer === "confirm" ? "confirmed" : answer === "reject" ? "rejected" : undefined;
  if (settled === undefined) return;
  const [own] = await query<{ match_fp: string | null }>("select match_fp from ledger.cards where id = $1", [card.id]);
  if (own?.match_fp === null || own?.match_fp === undefined) return;
  const matchFp = own.match_fp;
  const duplicates = await query<{
    id: string;
    kind: FactKind;
    request_id: string;
    compartments: string[];
    evidence_id: string | null;
  }>(
    `select c.id, c.kind, c.request_id, c.compartments, (select k.evidence_id from knowledge.claims k where k.id = c.target_id) as evidence_id from ledger.cards c
     where c.match_fp = $1 and c.created_by = 'system:extract' and c.kind = any ($2) and c.id <> $3 and not (c.id = any ($4))
       and ${CARD_STATE} in ('pending', 'deferred') and c.compartments @> $5::text[]
     order by c.id`,
    [matchFp, [...FACT_KINDS], card.id, [...named], card.compartments],
  );
  for (const duplicate of duplicates) {
    await query(
      "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('card', $1, 'withdrawn', now(), 'owner', $2)",
      [duplicate.id, duplicate.compartments],
    );
    await writeSettlement(query, {
      claim_key: duplicate.request_id,
      card_id: card.id,
      answer: settled,
      kind: duplicate.kind,
      claim_id: null,
      // Its record's evidence, so get_suggestions can tell the agent that wrote it.
      evidence_id: duplicate.evidence_id,
      match_fp: matchFp,
      withdrawn_card_id: duplicate.id,
      written_by: "decide",
      compartments: duplicate.compartments,
    });
  }
  const waiting = await query<SettlementRow>(
    `select s.* from ledger.fact_settlements s where s.answer = 'waiting' and s.card_id = any ($1) and ${IN_FORCE} order by s.created_at, s.id`,
    [[card.id, ...duplicates.map((one) => one.id)]],
  );
  for (const row of waiting) {
    await writeSettlement(query, {
      ...row,
      card_id: card.id,
      answer: settled,
      withdrawn_card_id: null,
      written_by: "decide",
    });
  }
  if (duplicates.length > 0) await query("select ledger.admit_deferred('system:extract')");
}

// Item 6: `pi cards reopen <settlement>`, as pi_admin, under the author word. Every row of its claim
// key is marked reopened, so the pipeline's next run raises the held-back card without asking
// policy.fact_answer; a withdrawn duplicate's card is itself made undecided again (deferred, then
// admitted as the cap allows). False for an id that is no settlement; `already_reopened` throws.
export async function reopenSettlement(
  query: Query,
  id: FactSettlementId,
): Promise<"reopened" | "already_reopened" | "not_found"> {
  await lockRows(query, [authorWord(EXTRACT_AUTHOR)]);
  const [row] = await query<SettlementRow>("select * from ledger.fact_settlements where id = $1", [id]);
  if (row === undefined) return "not_found";
  if (row.reopened_at !== null) return "already_reopened";
  await query("update ledger.fact_settlements set reopened_at = now() where claim_key = $1 and reopened_at is null", [
    row.claim_key,
  ]);
  if (row.withdrawn_card_id !== null) {
    const [state] = await query<{ event: string }>(`${latestRow("event", "card", "$1", { alias: "" })}`, [
      row.withdrawn_card_id,
    ]);
    if (state?.event === "withdrawn") {
      await query(
        "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('card', $1, 'deferred', now(), 'owner', $2)",
        [row.withdrawn_card_id, row.compartments],
      );
      await query("select ledger.admit_deferred('system:extract')");
    }
  }
  return "reopened";
}

// Items 8 and 13: the report's `settled` block, within the window. A claim counts once, in the
// window of its first settlement, by the answer in force for it now; a withdrawal by its row; a
// reopen by its claim key. The identity side: merges by basis, and same_person cards raised.
export async function settledReport(query: Query, since: Date): Promise<SettledReport> {
  const zero = (): SettledFactCounts => ({
    confirmed: 0,
    rejected: 0,
    vetoed: 0,
    waiting: 0,
    withdrawn: 0,
    reopened: 0,
  });
  const facts: SettledReport["facts"] = { about_you: zero(), agent_claim: zero() };
  const add = (kind: string, field: keyof SettledFactCounts, n: number) => {
    if (kind === "about_you" || kind === "agent_claim") facts[kind][field] += n;
  };
  const held = await query<{ kind: string; answer: FactSettlementAnswer; n: number }>(
    `with first as (select claim_key, min(created_at) as at from ledger.fact_settlements where written_by = 'pipeline' group by claim_key)
     select s.kind, s.answer, count(*)::int as n from ledger.fact_settlements s join first f on f.claim_key = s.claim_key
     where f.at >= $1 and s.withdrawn_card_id is null and ${IN_FORCE} group by s.kind, s.answer`,
    [stamp(since)],
  );
  for (const row of held) add(row.kind, row.answer, row.n);
  for (const row of await query<{ kind: string; n: number }>(
    "select kind, count(*)::int as n from ledger.fact_settlements where withdrawn_card_id is not null and created_at >= $1 group by kind",
    [stamp(since)],
  )) {
    add(row.kind, "withdrawn", row.n);
  }
  for (const row of await query<{ kind: string; n: number }>(
    "select kind, count(distinct claim_key)::int as n from ledger.fact_settlements where reopened_at >= $1 group by kind",
    [stamp(since)],
  )) {
    add(row.kind, "reopened", row.n);
  }
  const merged = { contact: 0, phone: 0, name: 0, local_part: 0 };
  for (const row of await query<{ basis: string; n: number }>(
    "select details ->> 'basis' as basis, count(*)::int as n from knowledge.owner_decisions where kind = 'identity_policy' and decided_at >= $1 group by 1",
    [stamp(since)],
  )) {
    if (row.basis === "contact" || row.basis === "phone" || row.basis === "name" || row.basis === "local_part")
      merged[row.basis] += row.n;
  }
  const [carded] = await query<{ n: number }>(
    "select count(*)::int as n from ledger.cards where kind = 'same_person' and created_by = 'system:identity' and created_at >= $1",
    [stamp(since)],
  );
  return { facts, identity: { merged, carded: carded?.n ?? 0 } };
}
