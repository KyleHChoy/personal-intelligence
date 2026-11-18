import { CARD_LINE_REFS_MOST, type CardLine, isAgentAttemptKind } from "@intelligence/contracts/personal";
import type { Query } from "../core/db.ts";
import type { StoredCard } from "./card-kind-row.ts";
import { codeLine, part } from "./card-line.ts";

// A code line: the answer is one of the card's own options or cant_tell, and nothing the agent
// wrote is shown here. None for a kind no agent is asked, or when the report it rests on is
// tainted.
export async function attemptLines(query: Query, card: StoredCard): Promise<CardLine[]> {
  if (!isAgentAttemptKind(card.kind)) return [];
  const rows = await query<{
    client_name: string;
    answer: string;
    cites: number;
    ref_kinds: string[];
    ref_ids: string[];
  }>(
    `select a.client_name, a.answer,
       (select count(*)::int from ledger.basis b where b.row_kind = 'move' and b.row_id = a.move_id and b.tainted_at is null) as cites,
       array(select b.ref_kind from ledger.basis b where b.row_kind = 'move' and b.row_id = a.move_id and b.tainted_at is null
               and b.ref_kind in ('message', 'entity', 'goal') order by b.id limit ${CARD_LINE_REFS_MOST}) as ref_kinds,
       array(select b.ref_id from ledger.basis b where b.row_kind = 'move' and b.row_id = a.move_id and b.tainted_at is null
               and b.ref_kind in ('message', 'entity', 'goal') order by b.id limit ${CARD_LINE_REFS_MOST}) as ref_ids
     from ledger.card_answers a join ledger.moves m on m.id = a.move_id and m.tainted_at is null
     where a.card_id = $1 order by a.created_at, a.id`,
    [card.id],
  );
  return rows.map((row) =>
    codeLine(
      "agent_answer",
      [part.text(row.client_name), part.code(row.answer), part.count(row.cites)],
      row.ref_kinds.flatMap((kind, at) => {
        const id = row.ref_ids[at];
        return id === undefined ? [] : [{ kind, id }];
      }),
    ),
  );
}
