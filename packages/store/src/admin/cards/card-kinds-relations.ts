import { CARD_OPTIONS, type CardLine, keyPhraseOf } from "@intelligence/contracts/personal";
import type { CardKindRow, StoredCard } from "../../cards/card-kind-row.ts";
import { codeLine, headLines, part } from "../../cards/card-line.ts";
import type { Query } from "../../core/db.ts";
import { fingerprint } from "../../core/fingerprint.ts";
import type { Keys } from "../../core/keys.ts";
import type { Sealed } from "../../core/seal.ts";
import { open } from "../../core/seal.ts";
import { ownerJudge } from "../../core/stored-forms.ts";
import { claimRecordOf } from "../../core/tx.ts";

// The `relation_audit` card. The dream pass
// raises one for a random tenth of a switched-on model relation kind's relations, at most five a
// day, as system:extract. It names the relation by its case key (`relation_audit:<row id>`) and
// targets its `from` claim. The owner answers `right`, `wrong` or `skip`; `right` and `wrong` are
// recorded as the owner's own check row in ledger.source_checks (judge `owner:<ruling>`), which the
// switching job reads: the owner's `wrong` counts as an overturn of the kind. Nothing else is written: a
// relation, a claim and a belief are left as they are.

type RelationRow = {
  id: string;
  from_claim_key: string;
  to_claim_key: string;
  kind: string;
  judged_by: string;
  compartments: string[];
};

const CASE = /^relation_audit:([1-9][0-9]{0,18})$/;

async function relationOf(query: Query, card: StoredCard): Promise<RelationRow | null> {
  const id = CASE.exec(card.caseKey ?? "")?.[1];
  if (id === undefined) return null;
  const [row] = await query<RelationRow>(
    "select id::text as id, from_claim_key, to_claim_key, kind, judged_by, compartments from knowledge.claim_relations where id = $1::bigint",
    [id],
  );
  return row ?? null;
}

// A side's claim by its id and type.
const sideLine = (side: "from" | "to", claim: { id: string; type: string }): CardLine =>
  codeLine(side, [part.id("fact", claim.id), part.code(claim.type)], [{ kind: "fact", id: claim.id }]);

// A claim of the relation by its key, its words as its source gave them (a `source` line), or
// none when the key file lacks its compartment.
async function claimLines(query: Query, keys: Keys, claimKey: string, side: "from" | "to"): Promise<CardLine[]> {
  const [claim] = await query<{ id: string; type: string; compartments: string[]; content_enc: Sealed }>(
    "select c.id, c.type, c.compartments, c.content_enc from knowledge.claim_values v join knowledge.claims c on c.id = v.claim_id where v.claim_key = $1 order by c.valid_from desc, c.id limit 1",
    [claimKey],
  );
  if (claim === undefined) return [codeLine("gone", [part.code(side)])];
  const record = claimRecordOf(open(keys, claim, "knowledge.claims.content_enc", "null"));
  const phrase = record === null ? undefined : keyPhraseOf(record.claim.content.type, record.claim.content.fields);
  return [
    sideLine(side, claim),
    ...(phrase === undefined ? [] : [{ text: JSON.stringify(phrase), from: "source" as const }]),
  ];
}

export const relationAudit: CardKindRow = {
  options: CARD_OPTIONS.relation_audit,
  async render(card, _open, { query, keys }) {
    const relation = await relationOf(query, card);
    if (relation === null) return [codeLine("kind", [part.code(card.kind)]), codeLine("gone", [part.code("relation")])];
    return [
      ...headLines(card),
      codeLine("relation", [part.code(relation.kind)]),
      codeLine("judge", [part.code(relation.judged_by)]),
      codeLine("relation_question"),
      ...(await claimLines(query, keys, relation.from_claim_key, "from")),
      ...(await claimLines(query, keys, relation.to_claim_key, "to")),
    ];
  },
  effect: async ({ query, card, answer, ruling, keys }) => {
    if (answer !== "right" && answer !== "wrong") return;
    const relation = await relationOf(query, card);
    // A relation gone since the card was raised has nothing left to measure.
    if (relation === null || !relation.judged_by.startsWith("model:")) return;
    await query(
      `insert into ledger.source_checks (target, kind, target_key, relation_id, relation_judge, judge, verdict, claim_keys, compartments, live)
       values ('relation', $1, $2, $3::bigint, $4, $5, $6, $7::text[], $8::text[], true)`,
      [
        relation.kind,
        fingerprint(keys, "check_target", `relation\n${relation.id}`),
        relation.id,
        relation.judged_by,
        ownerJudge(ruling),
        answer === "right" ? "supported" : "wrong",
        [relation.from_claim_key, relation.to_claim_key],
        relation.compartments,
      ],
    );
  },
};
