import {
  AGENT_WEEKS_DEFAULT,
  AGENT_WEEKS_MOST,
  type AgentRecordCounts,
  type AgentRecords,
  type AgentWeek,
  type AgentWeeks,
  agentRecordEmpty,
  agentRecordOf,
  type ClientName,
} from "@intelligence/contracts/personal";
import type { AdminContext } from "../../core/admin-context.ts";
import { AdminError } from "../../core/admin-error.ts";
import { stamp } from "../../core/db.ts";
import { notCanaryClient } from "../../core/statements.ts";
import { BET_COLUMNS, RECORD_COLUMNS } from "../../read/read-agent-record.ts";
import { unrestrictedOf } from "../admin-time-base.ts";

// The System room's agents, as pi_admin: each registered agent's own record over 28 days, counted by
// ledger.agent_records_within, and its bets, by ledger.bets_within, over the key file's compartments
// but the restricted ones, as the owner's other counts are. Each active agent, and a revoked one
// whose record holds anything, by name. Names, counts and decline codes only.
const RECORDS = `
  select k.name, k.status, ${RECORD_COLUMNS}, ${BET_COLUMNS}
  from ledger.agent_records_within($1, $2::text[], null) r
  join ledger.bets_within($1, $2::text[], null) b on b.client_id = r.client_id
  join policy.clients k on k.id = r.client_id
  where ${notCanaryClient("k.name")}
  order by k.name`;

export function agentRecords(admin: AdminContext): Promise<AgentRecords> {
  const now = admin.now();
  return admin.transaction(async (query) => {
    const within = unrestrictedOf(admin.keys);
    const rows = await query<AgentRecordCounts & { name: ClientName; status: string }>(RECORDS, [stamp(now), within]);
    const weeks = weeksByName(await query<WeekRow>(WEEKS, [stamp(now), AGENT_WEEKS_DEFAULT, within]));
    const agents = rows.flatMap(({ name, status, ...counts }) => {
      const record = agentRecordOf(counts);
      return status === "active" || !agentRecordEmpty(record)
        ? [{ client: name, record, weeks: weeks.get(name) ?? [] }]
        : [];
    });
    return { at: stamp(now), agents };
  });
}

// each registered agent's last `weeks` ISO weeks, counted by
// ledger.agent_weeks_within over the same compartments as the record, the one under way first. Each
// active agent, and a revoked one with anything in a week, by name. Names, counts and dates only.
const WEEKS = `
  select k.name, k.status, to_char(w.week, 'YYYY-MM-DD') as week, w.placed, w.used, w.unused, w.open, w.budget,
    w.bets_left, w.asked, w.paid, w.refused, w.taken_back
  from ledger.agent_weeks_within($1, $2, $3::text[], null) w
  join policy.clients k on k.id = w.client_id
  where ${notCanaryClient("k.name")}
  order by k.name, w.week desc`;

type WeekRow = {
  name: ClientName;
  status: string;
  week: string;
  placed: number;
  used: number;
  unused: number;
  open: number;
  budget: number;
  bets_left: number;
  asked: number;
  paid: number;
  refused: number;
  taken_back: number;
};

const weekOf = (row: WeekRow): AgentWeek => ({
  week: row.week,
  bets: {
    placed: row.placed,
    used: row.used,
    unused: row.unused,
    open: row.open,
    budget: row.budget,
    left: row.bets_left,
  },
  questions: { asked: row.asked, paid: row.paid, refused: row.refused },
  takenBack: row.taken_back,
});

// A week with anything in it: a bet, a question, a refusal or an answer taken back.
const weekActive = (week: AgentWeek): boolean =>
  week.bets.placed + week.questions.asked + week.questions.refused + week.takenBack > 0;

function weeksByName(rows: readonly WeekRow[]): Map<ClientName, AgentWeek[]> {
  const byName = new Map<ClientName, AgentWeek[]>();
  for (const row of rows) byName.set(row.name, [...(byName.get(row.name) ?? []), weekOf(row)]);
  return byName;
}

export async function agentWeeks(admin: AdminContext, weeks: number = AGENT_WEEKS_DEFAULT): Promise<AgentWeeks> {
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > AGENT_WEEKS_MOST) throw new AdminError("invalid_argument");
  const now = admin.now();
  return admin.transaction(async (query) => {
    const rows = await query<WeekRow>(WEEKS, [stamp(now), weeks, unrestrictedOf(admin.keys)]);
    const active = new Map(rows.map((row) => [row.name, row.status === "active"]));
    const agents = [...weeksByName(rows)].flatMap(([client, list]) =>
      active.get(client) === true || list.some(weekActive) ? [{ client, weeks: list }] : [],
    );
    return { at: stamp(now), weeks, agents };
  });
}
