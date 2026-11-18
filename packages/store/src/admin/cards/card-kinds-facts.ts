import { CARD_OPTIONS, type CardLine, FactKeyFp, keyPhraseOf } from "@intelligence/contracts/personal";
import type { CardKindRow, StoredCard } from "../../cards/card-kind-row.ts";
import { codeLine, headLines, part } from "../../cards/card-line.ts";
import { AdminError } from "../../core/admin-error.ts";
import type { Query } from "../../core/db.ts";
import type { Keys } from "../../core/keys.ts";
import { BELIEFS_LOCK } from "../../core/locks.ts";
import { cardRulingRequest } from "../../core/queue.ts";
import type { Sealed } from "../../core/seal.ts";
import { open } from "../../core/seal.ts";
import { claimRecordOf } from "../../core/tx.ts";
import { namedPair, writeFactRuling } from "../rulings/admin-fact-rulings.ts";

// `same` writes a `join` ruling and `different` a `split` one, each binding every rebuild; `skip`
// writes none. The card names its pair by its target, a `claim` ref to a claim of one fact key, and
// its case key, the other fact key's fingerprint: a card's refs take no claim, and a case key holds
// 64 characters, one fingerprint. That is the contract the sweep raises it by.

// The pair a card names, or null when it names none: its target claim's fact key and its case key.
async function pairOf(query: Query, card: StoredCard): Promise<{ a: string; b: string } | null> {
  if (card.target?.kind !== "claim" || !FactKeyFp.safeParse(card.caseKey).success) return null;
  const [claim] = await query<{ fact_key_fp: string }>("select fact_key_fp from knowledge.claims where id = $1", [
    card.target.id,
  ]);
  return claim === undefined ? null : { a: claim.fact_key_fp, b: card.caseKey as string };
}

// A claim by its id and type.
const claimLine = (claim: { id: string; type: string }): CardLine =>
  codeLine("claim", [part.id("fact", claim.id), part.code(claim.type)], [{ kind: "fact", id: claim.id }]);

// The newest claim of a fact key, its words as its source gave them (a `source` line), or none
// when the key file lacks its compartment.
async function phraseOf(query: Query, keys: Keys, factKeyFp: string): Promise<CardLine[]> {
  const [claim] = await query<{ id: string; type: string; compartments: string[]; content_enc: Sealed }>(
    "select id, type, compartments, content_enc from knowledge.claims where fact_key_fp = $1 order by valid_from desc, id limit 1",
    [factKeyFp],
  );
  if (claim === undefined) return [codeLine("gone", [part.code("claim")])];
  const record = claimRecordOf(open(keys, claim, "knowledge.claims.content_enc", "null"));
  const phrase = record === null ? undefined : keyPhraseOf(record.claim.content.type, record.claim.content.fields);
  return [
    claimLine(claim),
    ...(phrase === undefined ? [] : [{ text: JSON.stringify(phrase), from: "source" as const }]),
  ];
}

export const sameFact: CardKindRow = {
  options: CARD_OPTIONS.same_fact,
  // The beliefs lock first, as every ruling on beliefs takes it, before decide's row locks: an
  // answer given during a rebuild waits for it, and the rebuild's write is then stale.
  lockIds: async (query) => {
    await query(BELIEFS_LOCK);
    return [];
  },
  async render(card, _open, { query, keys }) {
    const pair = await pairOf(query, card);
    if (pair === null) return [codeLine("kind", [part.code(card.kind)]), codeLine("pair_none")];
    return [
      ...headLines(card),
      codeLine("fact_a", [part.id("fact", pair.a)], [{ kind: "fact", id: pair.a }]),
      ...(await phraseOf(query, keys, pair.a)),
      codeLine("fact_b", [part.id("fact", pair.b)], [{ kind: "fact", id: pair.b }]),
      ...(await phraseOf(query, keys, pair.b)),
    ];
  },
  effect: async ({ query, card, answer, ruling, now, keys }) => {
    if (answer === "skip") return;
    const verdict = answer === "same" ? "join" : answer === "different" ? "split" : undefined;
    if (verdict === undefined) return;
    const pair = await pairOf(query, card);
    if (pair === null || card.target?.kind !== "claim") throw new AdminError("not_found");
    // The other key is named by its newest claim. The ruling's compartments are those of every
    // claim of both keys, as a command's.
    const [other] = await query<{ id: string }>(
      "select id from knowledge.claims where fact_key_fp = $1 order by valid_from desc, id limit 1",
      [pair.b],
    );
    if (other === undefined) throw new AdminError("not_found");
    const named = await namedPair(query, keys, verdict, card.target.id, other.id);
    try {
      await writeFactRuling(query, { verdict, ...named, requestId: cardRulingRequest(ruling), now });
    } catch (error) {
      // The owner ruled the pair the same way since the card was raised: nothing more to write.
      if (error instanceof AdminError && error.code === "already_ruled") return;
      throw error;
    }
  },
};
