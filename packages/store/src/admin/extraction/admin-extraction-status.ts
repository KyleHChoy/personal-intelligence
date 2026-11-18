import { BeliefStatus, type Timestamp } from "@intelligence/contracts";
import type {
  DocumentId,
  MessageId,
  PipelineStatus,
  RunCode,
  RunCounts,
  TriageLane,
} from "@intelligence/contracts/personal";
import { byText, stamp } from "../../core/db.ts";
import { EXTRACTION_LANES } from "../../core/lanes.ts";
import { open, type Sealed } from "../../core/seal.ts";
import type { Tx } from "../../core/tx.ts";
import { ownerDayOf } from "../../core/zone.ts";
import { ownerBeliefs } from "../admin-owner.ts";
import { type SpendBasis, spendBasis, usageBasis } from "../work/cost-basis.ts";
import { statusRows } from "./admin-extraction.ts";
import type { Verdict } from "./admin-extraction-review.ts";

// `pi extract status`, run as pi_admin: counts, codes, ids and times over items, claims, beliefs,
// reviews, spend, runs, withheld items and grouping, never content.

export type ExtractionStatusView = {
  items: { lane: TriageLane; status: PipelineStatus; code: string | null; count: number }[];
  due: number;
  claims: Record<string, number>;
  unmapped: { reason: string; proposedType: string; count: number }[];
  unresolved: number;
  // The owner's audience's beliefs: each fact once, by kind and disputed by kind, counts only,
  // whatever clients are registered; and the same facts by status, every status named.
  beliefs: {
    total: number;
    multiMessage: number;
    byKind: Record<string, number>;
    disputedByKind: Record<string, number>;
    byStatus: Record<BeliefStatus, number>;
  };
  reviews: { type: string; verdict: Verdict; generation: number; model: string | null; count: number }[];
  // `today`, `todayByPrompt`, `todayBasis` and `lastAnswered` read the extract lane of
  // vault.model_usage alone, the lane extraction's budget compares; `dreamToday` is the dream lane's
  // live calls and micro-dollars on the owner's day in their zone, which `pi dream`'s night compares.
  spend: {
    today: { liveCalls: number; microUsd: number };
    thirtyDays: { liveCalls: number; microUsd: number };
    todayByPrompt: Record<string, { liveCalls: number; microUsd: number }>;
    todayBasis: SpendBasis;
    dreamToday: { liveCalls: number; microUsd: number };
  };
  runs: { day: string; code: RunCode; counts: RunCounts }[];
  lastAnswered: string | null;
  withheld: {
    count: number;
    messages: { id: MessageId; at: Timestamp; code: string }[];
    documents: { id: DocumentId; at: Timestamp; code: string }[];
  };
  // Documents not held with no status row, one waiting, or one of another generation that is not
  // withheld, as `dueDocuments` selects them. Not whether a run takes them: that is
  // PI_EXTRACT_DOCUMENTS and the settle time, the run's.
  documentsDue: number;
  // The same-fact sweep. The owner's mode; the pairs asked, each counted once whatever audiences
  // asked it, by band and by state; and the same_fact cards raised.
  grouping: {
    mode: string;
    pairs: number;
    byBand: Record<string, number>;
    byState: Record<string, number>;
    cards: number;
  };
};

// The newest withheld items listed.
const WITHHELD_LISTED = 50;
// Every outcome under which the vendor answered.
const ANSWERED = ["ok", "rejected", "cost_missing", "check"];

const tally = <K>(keys: K[]): { key: K; count: number }[] => {
  const counts = new Map<string, { key: K; count: number }>();
  for (const key of keys) {
    const name = JSON.stringify(key);
    counts.set(name, { key, count: (counts.get(name)?.count ?? 0) + 1 });
  }
  return [...counts.entries()].sort(([a], [b]) => byText(a, b)).map(([, value]) => value);
};

const COUNTS: [keyof RunCounts, string][] = [
  ["done", "done"],
  ["skipped", "skipped"],
  ["withheld", "withheld"],
  ["failed", "failed"],
  ["waiting", "waiting"],
  ["claims", "claims"],
  ["unmapped", "unmapped"],
  ["unresolved", "unresolved"],
  ["liveCalls", "live_calls"],
  ["beliefs", "beliefs"],
  ["beliefsChanged", "beliefs_changed"],
  ["beliefsMixed", "beliefs_mixed"],
  ["beliefsFailed", "beliefs_failed"],
  ["beliefsRemoved", "beliefs_removed"],
  ["rebuildMs", "rebuild_ms"],
];

// A `date` column is read as its text: the driver would make a Date at local midnight, a day
// early east of UTC.
const day = (at: string): string => at.slice(0, 10);

// The owner's audience alone: each fact once, with no client registered and with several, computed
// when asked. A belief whose support spans more than one message: its claims come from more than
// one item.
async function ownerBeliefCounts(tx: Tx) {
  const owned = await ownerBeliefs(tx, "all");
  const support = [...new Set(owned.flatMap((one) => one.support))];
  const itemOf = new Map(
    (support.length === 0
      ? []
      : await tx.query<{ id: string; evidence_id: string }>(
          "select id, evidence_id from knowledge.claims where id = any ($1::text[])",
          [support],
        )
    ).map((row) => [row.id, row.evidence_id]),
  );
  const multi = owned.filter((one) => new Set(one.support.flatMap((id) => itemOf.get(id) ?? [])).size > 1).length;
  const kinds = owned.map(({ belief }) => ({
    kind: belief.kind,
    disputed: belief.disputed === true,
    status: belief.status,
  }));
  const byKind: Record<string, number> = {};
  const disputedByKind: Record<string, number> = {};
  const byStatus = Object.fromEntries(BeliefStatus.options.map((status) => [status, 0])) as Record<
    BeliefStatus,
    number
  >;
  for (const { kind, disputed, status } of kinds.sort((a, b) => byText(a.kind, b.kind))) {
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    if (disputed) disputedByKind[kind] = (disputedByKind[kind] ?? 0) + 1;
    byStatus[status] += 1;
  }
  return { total: owned.length, multiMessage: multi, byKind, disputedByKind, byStatus };
}

// The extraction reviews, opened, counted by type, verdict, generation and model.
async function reviewCounts(tx: Tx) {
  const reviewRows = await tx.query<{
    id: string;
    compartments: string[];
    facts_enc: Sealed;
    extractor_generation: number;
  }>("select id, compartments, facts_enc, extractor_generation from vault.extraction_reviews");
  return tally(
    reviewRows.map((row) => {
      const facts = JSON.parse(open(tx.keys, row, "vault.extraction_reviews.facts_enc", "throw")) as {
        type: string;
        verdict: Verdict;
        modelId: string | null;
      };
      return [facts.type, facts.verdict, row.extractor_generation, facts.modelId] as const;
    }),
  ).map(({ key: [type, verdict, gen, model], count }) => ({ type, verdict, generation: gen, model, count }));
}

// Calls and spend over `days`; `lane` null: every lane's. Each lane's rows by its own day: extraction's
// UTC's, the night's the owner's in their zone (`ownerDay`, recordUsageRow).
async function spentOf(tx: Tx, ownerDay: string, days: number, lane: "extract" | "dream" | null) {
  const [row] = await tx.query<{ calls: number; micro: string | null }>(
    `select count(*) filter (where outcome <> 'check')::int as calls, sum(cost_microusd)::text as micro from vault.model_usage
       where day > (case when lane = 'dream' then $3::date else (now() at time zone 'utc')::date end) - $1::int
         and ($2::text is null or lane = $2)`,
    [days, lane, ownerDay],
  );
  return { liveCalls: row?.calls ?? 0, microUsd: Number(row?.micro ?? 0) };
}

const spentByPrompt = async (tx: Tx): Promise<Record<string, { liveCalls: number; microUsd: number }>> =>
  Object.fromEntries(
    (
      await tx.query<{ prompt_id: string; calls: number; micro: string | null }>(
        `select prompt_id, count(*) filter (where outcome <> 'check')::int as calls, sum(cost_microusd)::text as micro from vault.model_usage
           where day = (now() at time zone 'utc')::date and lane = 'extract' group by prompt_id order by prompt_id collate "C"`,
      )
    ).map((row) => [row.prompt_id, { liveCalls: row.calls, microUsd: Number(row.micro ?? 0) }]),
  );

const spentByBasis = async (tx: Tx): Promise<SpendBasis> =>
  spendBasis(
    await tx.query<{ basis: string | null; micro: string | null }>(
      `select ${usageBasis("u")} as basis, sum(u.cost_microusd)::text as micro from vault.model_usage u
         where u.day = (now() at time zone 'utc')::date and u.lane = 'extract' group by 1`,
    ),
  );

export async function extractionStatus(tx: Tx, { generation }: { generation: number }): Promise<ExtractionStatusView> {
  const status = await statusRows(tx);
  const items = tally(status.map(({ facts }) => [facts.lane, facts.status, facts.code ?? null] as const)).map(
    ({ key: [lane, state, code], count }) => ({ lane, status: state, code, count }),
  );
  // Messages and agent records: an agent record's status row is counted in `items`
  // under the lane `agent`, and it is due as a message is.
  const [due] = await tx.query<{ n: number }>(
    `select (${EXTRACTION_LANES.mail.due})::int + (${EXTRACTION_LANES.agent.due})::int as n`,
    [generation],
  );
  const claims = Object.fromEntries(
    (
      await tx.query<{ type: string; n: number }>(
        "select type, count(*)::int as n from knowledge.claims group by type order by type",
      )
    ).map((row) => [row.type, row.n]),
  );

  const unmappedRows = await tx.query<{ id: string; compartments: string[]; facts_enc: Sealed }>(
    "select id, compartments, facts_enc from vault.unmapped_claims where compartments <@ $1::text[]",
    [[...tx.keys.compartments.keys()]],
  );
  const unmapped = tally(
    unmappedRows.map((row) => {
      // Under the row's whole label: an agent record's is sealed under several compartments.
      const facts = JSON.parse(open(tx.keys, row, "vault.unmapped_claims.facts_enc", "throw")) as {
        reason: string;
        proposedType: string;
      };
      return [facts.reason, facts.proposedType] as const;
    }),
  ).map(({ key: [reason, proposedType], count }) => ({ reason, proposedType, count }));

  const beliefs = await ownerBeliefCounts(tx);
  const reviews = await reviewCounts(tx);

  const ownerDay = await ownerDayOf(tx.query);
  const runs = (
    await tx.query<Record<string, unknown> & { day: string; code: RunCode }>(
      "select *, day::text as day from vault.extraction_runs order by seq desc limit 10",
    )
  ).map((row) => ({
    day: day(row.day),
    code: row.code,
    counts: Object.fromEntries(COUNTS.map(([key, column]) => [key, Number(row[column])])) as RunCounts,
  }));
  const [answered] = await tx.query<{ day: string | null }>(
    "select max(day)::text as day from vault.model_usage where outcome = any ($1) and lane = 'extract'",
    [ANSWERED],
  );

  // The newest withheld items by their message's sent time, each as its message's id and time
  // and the code: an id and a time are not content.
  // Messages only: a withheld finding is counted in `items`, under the lane `agent`.
  const withheldIds = status
    .filter(({ facts }) => facts.status === "withheld" && facts.lane !== "agent")
    .map(({ row, facts }) => [row.evidence_id, facts.code ?? ""] as const);
  const codes = new Map(withheldIds);
  const listed = await tx.query<{ id: string; evidence_id: string; sent_at: Date }>(
    `select id, evidence_id, sent_at from knowledge.messages where evidence_id = any ($1) order by sent_at desc, id collate "C" limit $2`,
    [[...codes.keys()], WITHHELD_LISTED],
  );

  // The newest withheld documents by modified time, as the messages above.
  const listedDocuments = await tx.query<{ id: string; evidence_id: string; modified_at: Date }>(
    `select id, evidence_id, modified_at from knowledge.documents where evidence_id = any ($1) order by modified_at desc, id collate "C" limit $2`,
    [[...codes.keys()], WITHHELD_LISTED],
  );
  const [documentsDue] = await tx.query<{ n: number }>(`select (${EXTRACTION_LANES.document.due})::int as n`, [
    generation,
  ]);

  const [mode] = await tx.query<{ grouping: string }>("select grouping from policy.owner_settings");
  const pairs = await tx.query<{ band: string; state: string; n: number }>(
    "select band, state, count(distinct (a_fp, b_fp))::int as n from knowledge.same_fact_judgments group by band, state order by band, state",
  );
  const [groupingTotals] = await tx.query<{ pairs: number; cards: number }>(
    "select count(distinct (a_fp, b_fp))::int as pairs, count(distinct card_id)::int as cards from knowledge.same_fact_judgments",
  );
  const sumBy = (field: "band" | "state"): Record<string, number> => {
    const counts: Record<string, number> = {};
    for (const row of pairs) counts[row[field]] = (counts[row[field]] ?? 0) + row.n;
    return counts;
  };

  return {
    items,
    due: due?.n ?? 0,
    claims,
    unmapped,
    unresolved: status.reduce((sum, { facts }) => sum + (facts.unresolved ?? 0), 0),
    beliefs,
    reviews,
    spend: {
      today: await spentOf(tx, ownerDay, 1, "extract"),
      thirtyDays: await spentOf(tx, ownerDay, 30, null),
      todayByPrompt: await spentByPrompt(tx),
      todayBasis: await spentByBasis(tx),
      dreamToday: await spentOf(tx, ownerDay, 1, "dream"),
    },
    runs,
    lastAnswered: answered?.day === null || answered?.day === undefined ? null : day(answered.day),
    withheld: {
      count: withheldIds.length,
      messages: listed.map((row) => ({
        id: row.id as MessageId,
        at: stamp(row.sent_at),
        code: codes.get(row.evidence_id) ?? "",
      })),
      documents: listedDocuments.map((row) => ({
        id: row.id as DocumentId,
        at: stamp(row.modified_at),
        code: codes.get(row.evidence_id) ?? "",
      })),
    },
    documentsDue: documentsDue?.n ?? 0,
    grouping: {
      mode: mode?.grouping ?? "shadow",
      pairs: groupingTotals?.pairs ?? 0,
      byBand: sumBy("band"),
      byState: sumBy("state"),
      cards: groupingTotals?.cards ?? 0,
    },
  };
}
