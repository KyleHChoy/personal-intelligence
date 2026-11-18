import { CARD_OPTIONS, type CardLine, partsAt, ULID_PATTERN } from "@intelligence/contracts/personal";
import type { CardKindRow, StoredCard } from "../../cards/card-kind-row.ts";
import { codeLine, headLines, part } from "../../cards/card-line.ts";
import type { Query } from "../../core/db.ts";
import { RATES, type RateRow } from "./admin-confirm-rates.ts";

const CASE = new RegExp(`^(grant|lift):(cli_${ULID_PATTERN}):([a-z_]+)$`);

// Its agent and kind from its case key, and its counts as the pass that raised it read them, at
// its clock: a card whose reason is gone is withdrawn, not reworded. The terminal command is the
// whole answer: confirming or rejecting changes nothing else.
async function suggestionLines(card: StoredCard, query: Query): Promise<CardLine[]> {
  const head = headLines(card);
  const [, which, client = "", kind = ""] = CASE.exec(card.caseKey ?? "") ?? [];
  const [agent] = await query<{ name: string }>("select name from policy.clients where id = $1", [client]);
  if (which === undefined || agent === undefined) return [...head, codeLine("proposal_none")];
  const [rate] = await query<RateRow>(`select * from (${RATES}) r where r.client_id = $2 and r.kind = $3`, [
    card.createdAt,
    client,
    kind,
  ]);
  const notTrue =
    which === "lift" && rate !== undefined && rate.notTrue > 0
      ? [codeLine("not_true", partsAt("not_true", { marked: part.count(rate.notTrue), kept: part.count(rate.kept) }))]
      : [];
  return [
    ...head,
    codeLine("client", [part.text(agent.name)]),
    codeLine("fact_kind", [part.code(kind)]),
    codeLine(
      "confirmed",
      rate === undefined
        ? []
        : partsAt("confirmed", { confirmed: part.count(rate.confirmed), answers: part.count(rate.answers) }),
    ),
    ...notTrue,
    codeLine(
      "grant_command",
      partsAt("grant_command", { which: part.code(which), agent: part.text(agent.name), kind: part.code(kind) }),
    ),
    codeLine("answer_note"),
  ];
}

// Both kinds, a standing release proposed and its lift proposed, by one row.
export const rateSuggestion: CardKindRow = {
  options: CARD_OPTIONS.grant_suggestion,
  render: (card, _open, { query }) => suggestionLines(card, query),
  effect: async () => {},
};
