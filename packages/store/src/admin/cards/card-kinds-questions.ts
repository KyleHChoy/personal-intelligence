import type { CardLine } from "@intelligence/contracts/personal";
import { CARD_OPTIONS } from "@intelligence/contracts/personal";
import type { CardKindRow, StoredCard } from "../../cards/card-kind-row.ts";
import { codeLine, part } from "../../cards/card-line.ts";
import { AdminError } from "../../core/admin-error.ts";
import { type Query, stamp } from "../../core/db.ts";
import { requestIdOf } from "../../core/ids.ts";
import { ownerDecision } from "../../core/owner-decision.ts";
import { writeRuling } from "../rulings/admin-identity.ts";
import { RULING_LOCKS } from "../rulings/owner-ruling.ts";
import { personLines } from "./card-kinds-identity.ts";

// What reaches the owner about people once code and agents tried, on one card, and a rule proposed
// from the owner's own answers. Lines are built by code from current
// rows: what was tried and why it did not settle, in a line a pair.

type Pair = {
  id: string;
  a_entity: string;
  b_entity: string;
  a_fp: string;
  b_fp: string;
  basis: string;
  exception: string | null;
  evidence_fp: string;
  compartments: string[];
};

const PAIRS = `
  select q.id, q.a_entity, q.b_entity, q.a_fp, q.b_fp, q.basis, q.exception, q.evidence_fp, q.compartments
  from ledger.identity_questions q where q.card_id = $1 and q.state = 'owner' order by q.id`;

// Why agents did not settle it, from their own answers, under whatever print they gave them: each can't-tell's
// reason, or a refusal. An answer that stopped counting was still tried.
async function triedOf(query: Query, question: string): Promise<string> {
  const rows = await query<{ verdict: string; because: string | null; refused_code: string | null }>(
    "select verdict, because, refused_code from ledger.identity_answers where question_id = $1 order by created_at",
    [question],
  );
  if (rows.length === 0) return "not_answered";
  return rows.map((row) => row.refused_code ?? row.because ?? row.verdict).join("+");
}

const PASSED_OVER: readonly string[] = ["already_settled", "conflicting_ruling", "shared_address", "not_a_person"];

export const samePersonBatch: CardKindRow = {
  options: CARD_OPTIONS.same_person_batch,
  lockIds: async () => [RULING_LOCKS.identity],
  async render(card, _open, { query, keys }) {
    const lines: CardLine[] = [];
    const pairs = await query<Pair>(PAIRS, [card.id]);
    for (const [index, pair] of pairs.entries()) {
      lines.push(
        ...(await personLines(query, keys, pair.a_entity, index * 2 + 1)).lines,
        ...(await personLines(query, keys, pair.b_entity, index * 2 + 2)).lines,
        codeLine("identity_tried", [
          part.count(index + 1),
          part.code(pair.exception ?? pair.basis),
          part.code(await triedOf(query, pair.id)),
        ]),
      );
    }
    return lines;
  },
  // Each pair's ruling is a decision of the owner's own, with no card to reopen, so a lift of one leaves the
  // rest. `leave` rests them until their people's names or addresses change, and it writes no ruling:
  // the owner did not say they differ. A pair settled since by `pi identity link` or `differ` is passed over.
  effect: async ({ query, card, answer, now }) => {
    const pairs = await query<Pair>(PAIRS, [card.id]);
    for (const pair of pairs) {
      if (answer !== "leave") {
        const verdict = answer === "all_same" ? "same" : "different";
        const ruling = await ownerDecision(
          query,
          {
            requestId: requestIdOf(`${card.id}:${pair.id}`),
            kind: "identity",
            answer: verdict,
            batch: true,
            compartments: pair.compartments,
          },
          now,
        );
        try {
          await writeRuling(query, ruling, verdict, pair.a_fp, pair.b_fp, now);
        } catch (error) {
          if (!(error instanceof AdminError) || !PASSED_OVER.includes(error.code)) throw error;
          // Something else settled it or forbids it: this pair rests, and the rest of the answer stands.
          // The code is kept, and `decide` tells the owner: their word did not land on this pair.
          await query(
            "update ledger.identity_questions set state = 'resting', passed_code = $3, batch = null, updated_at = $2 where id = $1",
            [pair.id, stamp(now), error.code === "already_settled" ? null : error.code],
          );
          continue;
        }
        await query("update ledger.identity_questions set settled_by = 'ruling' where id = $1", [pair.id]);
      }
      await query("update ledger.identity_questions set state = $2, batch = null, updated_at = $3 where id = $1", [
        pair.id,
        answer === "leave" ? "resting" : "settled",
        stamp(now),
      ]);
    }
  },
};

const ruleOf = async (query: Query, card: StoredCard) =>
  (
    await query<{ id: string; pattern: string; answer: string; answers: number }>(
      "select id, pattern, answer, answers from ledger.question_rules where card_id = $1",
      [card.id],
    )
  )[0];

export const questionRule: CardKindRow = {
  options: CARD_OPTIONS.question_rule,
  async render(card, _open, { query }) {
    const rule = await ruleOf(query, card);
    if (rule === undefined) return [];
    return [codeLine("question_rule", [part.count(rule.answers), part.code(rule.pattern), part.code(rule.answer)])];
  },
  // The owner's word alone puts a rule in force; a no stays a no. `pi rules lift` ends one.
  effect: async ({ query, card, answer, now }) => {
    await query(
      "update ledger.question_rules set status = $2, decided_at = $3 where card_id = $1 and status = 'proposed'",
      [card.id, answer === "confirm" ? "confirmed" : "declined", stamp(now)],
    );
  },
};
