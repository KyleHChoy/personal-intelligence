import {
  AGENT_ATTEMPT_BY,
  AGENT_SETTLED_SAMPLE,
  type AgentSettlementMark,
  type AgentSettlementView,
  type CardDetail,
  type CardId,
} from "@intelligence/contracts/personal";
import { DAY_MS } from "@intelligence/personal-core";
import { isoWeek } from "@intelligence/personal-core/planner";
import { AGENT_SETTLED_CODES_SQL } from "../../cards/agent-attempts.ts";
import { weekStartOf } from "../../cards/asked-less.ts";
import { relaySample } from "../../cards/questions-through-agent.ts";
import type { AdminContext, TxAt } from "../../core/admin-context.ts";
import { AdminError } from "../../core/admin-error.ts";
import { stamp } from "../../core/db.ts";
import { lockRows } from "../../core/queue.ts";
import { unrestrictedOf } from "../admin-time-base.ts";
import { cardsShown } from "./admin-queue.ts";

// The owner's check of what agents settled: every card an agent's answer settled, newest first, and the
// sample of at most AGENT_SETTLED_SAMPLE from the last whole ISO week, chosen by a hash of the card's
// id and that week as the relay sample is: the week is over, so the five never change once shown, and
// no agent steers them. The owner marks each right or wrong; the mark is an evaluation label on the
// agent's answer, never an answer of the owner's and never learned from. To take a settlement back the
// owner reopens its card. Ids, codes and times only.

const LISTED = 200;

type SettledRow = {
  card: CardId;
  kind: string;
  agent: string;
  answer: string;
  at: Date;
  cited_kinds: string[] | null;
  cited_ids: string[] | null;
  mark: AgentSettlementMark | null;
  reopened: boolean;
};

// Each answer that settled its card: the card's `withdrawn` event by the agent attempt, with the code
// of that answer. `$1`, `$2`: only those answered from and before then, when given.
const SETTLED = `
  select a.card_id as card, c.kind, a.client_name as agent, a.answer, a.created_at as at,
    g.cited_kinds, g.cited_ids, a.owner_mark as mark,
    exists (select 1 from ledger.record_events o
            where o.row_kind = 'card' and o.row_id = c.id and o.by = 'owner' and o.id > w.id) as reopened
  from ledger.card_answers a
  join ledger.cards c on c.id = a.card_id and c.tainted_at is null
  join lateral (select e.id from ledger.record_events e
                where e.row_kind = 'card' and e.row_id = c.id and e.event = 'withdrawn' and e.by = '${AGENT_ATTEMPT_BY}'
                  and e.code in (${AGENT_SETTLED_CODES_SQL}) and e.code = 'agent_' || a.answer
                order by e.id limit 1) w on true
  left join ledger.agent_rulings g on g.answer_id = a.id
  where ($1::timestamptz is null or a.created_at >= $1::timestamptz) and ($2::timestamptz is null or a.created_at < $2::timestamptz)
  order by a.created_at desc, a.card_id collate "C" desc
  limit ${LISTED}`;

const viewOf = (row: SettledRow): AgentSettlementView => ({
  card: row.card,
  kind: row.kind,
  agent: row.agent,
  answer: row.answer,
  at: stamp(row.at),
  cited: (row.cited_ids ?? []).map((id, at) => ({ kind: row.cited_kinds?.[at] ?? "unknown", id })),
  mark: row.mark,
  reopened: row.reopened,
});

// `pia cards settled [--sample]` and the Work room's panel. With `sample`, the last whole ISO week's
// sample alone, each with its card as the cards list shows one (`question`), within the key file's
// compartments but the restricted ones, so the owner reads what the agent confirmed or rejected.
export async function listSettled(
  admin: AdminContext,
  options: { sample?: boolean } = {},
): Promise<{ week: string; settlements: AgentSettlementView[] }> {
  const end = weekStartOf(admin.now());
  const start = new Date(end.getTime() - 7 * DAY_MS);
  const week = isoWeek(start, "-W");
  return admin.transaction(async (query) => {
    if (options.sample !== true) {
      const rows = await query<SettledRow>(SETTLED, [null, null]);
      return { week, settlements: rows.map(viewOf) };
    }
    const rows = await query<SettledRow>(SETTLED, [stamp(start), stamp(end)]);
    const chosen = new Set(
      relaySample(
        rows.map((row) => row.card),
        week,
        AGENT_SETTLED_SAMPLE,
      ),
    );
    const sampled = rows.filter((row) => chosen.has(row.card));
    // Each card read by itself: one whose lines cannot be read is shown without them, never the
    // whole sample lost.
    const questions = new Map<string, CardDetail>();
    for (const row of sampled) {
      try {
        const [shown] = await cardsShown(admin, query, [row.card], unrestrictedOf(admin.keys));
        if (shown !== undefined) questions.set(row.card, shown);
      } catch {
        admin.log.info({ event: "settled_card_unread", ids: { card: row.card } });
      }
    }
    return {
      week,
      settlements: sampled.map((row) => ({ ...viewOf(row), question: questions.get(row.card) ?? null })),
    };
  });
}

// `pia cards mark CARD right|wrong` and the panel's buttons: the owner's mark on a card an agent's
// answer settled, replacing any earlier mark, so a repeat writes the same. Any other card is `not_found`.
export async function markSettled(tx: TxAt, card: CardId, mark: AgentSettlementMark): Promise<void> {
  await lockRows(tx.query, [card]);
  const marked = await tx.query(
    `update ledger.card_answers a set owner_mark = $2, marked_at = $3
     where a.card_id = $1
       and exists (select 1 from ledger.cards c where c.id = a.card_id and c.tainted_at is null)
       and exists (select 1 from ledger.record_events e
                   where e.row_kind = 'card' and e.row_id = a.card_id and e.event = 'withdrawn' and e.by = '${AGENT_ATTEMPT_BY}'
                     and e.code = 'agent_' || a.answer)
     returning a.id`,
    [card, mark, stamp(tx.now)],
  );
  if (marked.length === 0) throw new AdminError("not_found");
}
