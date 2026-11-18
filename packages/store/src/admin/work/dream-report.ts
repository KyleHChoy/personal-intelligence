import { wilsonLow } from "@intelligence/personal-beliefs";
import { type Query, stamp } from "../../core/db.ts";
import { relationCheckScore } from "../../pipeline/relation-store.ts";

type DreamSweepCount = {
  judge: string;
  pairs: number;
  agreed: number;
  disagreed: number;
  written: Record<string, number>;
};
type DreamSwitch = { kind: string; judge: string; on: boolean; by: string; code: string | null; at: string };
type SourceCheckCount = {
  target: string;
  kind: string;
  judge: string;
  checks: number;
  scored: number;
  supported: number;
  unsupported: number;
  wrong: number;
  uncited: number;
  rejected: number;
  wilsonLow: number;
};
type HotCheckCount = {
  hot: string;
  kind: string;
  checks: number;
  supported: number;
  unsupported: number;
  wrong: number;
  uncited: number;
  rejected: number;
  noPassage: number;
};
export type DreamReport = {
  sweep: DreamSweepCount[];
  switches: DreamSwitch[];
  sourceChecks: SourceCheckCount[];
  hotChecks: HotCheckCount[];
  audits: { raised: number; answered: number; wrong: number };
};

export async function dreamReport(query: Query, since: Date): Promise<DreamReport> {
  const pairs = await query<{ judge: string; pairs: number; agreed: number; disagreed: number }>(
    `select judge, count(*)::int as pairs, count(*) filter (where agreed)::int as agreed, count(*) filter (where agreed = false)::int as disagreed
     from ledger.relation_checks where dream and other_key is not null and created_at >= $1 group by judge order by judge`,
    [stamp(since)],
  );
  const written = await query<{ judge: string; written: string; n: number }>(
    `select judge, written, count(*)::int as n from ledger.relation_checks
     where dream and other_key is not null and written is not null and created_at >= $1 group by judge, written order by judge, written`,
    [stamp(since)],
  );
  const switches = await query<{
    kind: string;
    judge: string;
    switched_on: boolean;
    decided_by: string;
    code: string | null;
    decided_at: Date;
  }>(
    "select kind, judge, switched_on, decided_by, measures ->> 'code' as code, decided_at from policy.relation_switches where decided_at >= $1 order by decided_at, id",
    [stamp(since)],
  );
  const checks = await query<Omit<SourceCheckCount, "wilsonLow">>(
    `select target, kind, coalesce(relation_judge, judge) as judge, count(*)::int as checks,
       count(*) filter (where on_cited and (verdict is not null or code in ('uncited', 'rejected')))::int as scored,
       count(*) filter (where on_cited and verdict = 'supported')::int as supported,
       count(*) filter (where on_cited and verdict = 'unsupported')::int as unsupported,
       count(*) filter (where on_cited and verdict = 'wrong')::int as wrong,
       count(*) filter (where on_cited and code = 'uncited')::int as uncited,
       count(*) filter (where on_cited and code = 'rejected')::int as rejected
     from ledger.source_checks where starts_with(judge, 'model:') and hot is null group by 1, 2, 3 order by 1, 2, 3`,
  );
  const hotChecks = await query<HotCheckCount>(
    `select hot, kind, count(*)::int as checks,
       count(*) filter (where verdict = 'supported')::int as supported,
       count(*) filter (where verdict = 'unsupported')::int as unsupported,
       count(*) filter (where verdict = 'wrong')::int as wrong,
       count(*) filter (where code = 'uncited')::int as uncited,
       count(*) filter (where code = 'rejected')::int as rejected,
       count(*) filter (where code = 'no_passage')::int as "noPassage"
     from ledger.source_checks where hot is not null and created_at >= $1 group by 1, 2 order by 1, 2`,
    [stamp(since)],
  );
  const [audits] = await query<{ raised: number; answered: number; wrong: number }>(
    `select (select count(*) from ledger.cards where kind = 'relation_audit' and created_at >= $1)::int as raised,
       (select count(*) from ledger.source_checks where starts_with(judge, 'owner:') and created_at >= $1)::int as answered,
       (select count(*) from ledger.source_checks where starts_with(judge, 'owner:') and verdict = 'wrong' and created_at >= $1)::int as wrong`,
    [stamp(since)],
  );
  const sourceChecks: SourceCheckCount[] = [];
  for (const row of checks) {
    const score = row.target === "relation" ? await relationCheckScore(query, row.kind, row.judge) : row;
    sourceChecks.push({ ...row, wilsonLow: Number(wilsonLow(score.supported, score.scored).toFixed(4)) });
  }
  return {
    sweep: pairs.map((row) => ({
      ...row,
      written: Object.fromEntries(written.filter((one) => one.judge === row.judge).map((one) => [one.written, one.n])),
    })),
    switches: switches.map((row) => ({
      kind: row.kind,
      judge: row.judge,
      on: row.switched_on,
      by: row.decided_by,
      code: row.code,
      at: stamp(row.decided_at),
    })),
    sourceChecks,
    hotChecks,
    audits: audits ?? { raised: 0, answered: 0, wrong: 0 },
  };
}
