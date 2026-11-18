import {
  CARD_RELAY_REFUSALS,
  type CardRelayBrief,
  type CardRelayRefusal,
  isCoded,
  type RelayCardAnswerArgs,
  type RelayCardAnswerResult,
} from "@intelligence/contracts/personal";
import { passedOffAsOwners } from "@intelligence/personal-core/checks";
import { cardRelayId } from "../core/ids.ts";
import { open, type Sealed, sealUnder } from "../core/seal.ts";
import { answered, type Done, invalidAs, isRefused, refused, refusedAs, type WorkCall } from "../core/work-refs.ts";
import type { Ctx } from "../read/read-ctx.ts";
import { cardFields } from "./card-attempt-report.ts";

// A card asked through an agent, as pi_reader: the card in its task's brief, and the one write of a
// relayed answer. Code checks; the agent only says, and the definer decides whether the relay is taken. A
// relay taken is applied as an answer of the owner's by the owner's process (admin-relays.ts), through
// the page's one answer path: nothing here runs a card's effect.

type CardRow = {
  card_id: string;
  kind: string;
  options: string[];
  target_kind: string | null;
  target_id: string | null;
  ref_kinds: string[];
  ref_ids: string[];
  compartments: string[];
  body_enc: Sealed | null;
  attempt_agent: string | null;
  attempt_answer: string | null;
  attempt_ref_kinds: string[] | null;
  attempt_ref_ids: string[] | null;
};

const QUESTION =
  "select card_id, kind, options, target_kind, target_id, ref_kinds, ref_ids, compartments, body_enc, attempt_agent, attempt_answer, attempt_ref_kinds, attempt_ref_ids from ledger.card_relay_question($1)";

// A card about a lesson, an idea or a question of the planner's may have no words of its own: what
// the owner's page shows is that row's, read as every brief reads a hypothesis, under the caller's
// token, and only within the card's own label.
const HYPOTHESIS =
  "select id, compartments, body_enc from ledger.hypotheses where id = $1 and tainted_at is null and compartments <@ $2::text[]";

// The caller's latest card_relay task for a card, by its own rows; none when it sees none.
const TASK = `
  select o.id from ledger.opportunities o
  where o.gap_trigger = 'card_relay' and o.gap_subject = $1 and o.tainted_at is null
  order by o.created_at desc, o.id collate "C" desc limit 1`;

const untrustedOf = (text: string | null) => (text === null ? null : { untrusted: text });

// What the card says, opened under the caller's keys, or null: it has none, or the caller's keys
// do not open them.
async function wordsOf(ctx: Ctx, row: CardRow): Promise<{ untrusted: string } | null> {
  if (row.body_enc !== null)
    return untrustedOf(
      open(ctx.keys, { ...row, id: row.card_id, body_enc: row.body_enc }, "ledger.cards.body_enc", "null"),
    );
  if (row.target_kind !== "hypothesis" || row.target_id === null) return null;
  const [hypothesis] = await ctx.run<{ id: string; compartments: string[]; body_enc: Sealed | null }>(HYPOTHESIS, [
    row.target_id,
    row.compartments,
  ]);
  if (hypothesis?.body_enc == null) return null;
  return untrustedOf(
    open(ctx.keys, { ...hypothesis, body_enc: hypothesis.body_enc }, "ledger.hypotheses.body_enc", "null"),
  );
}

// What the agent asked first answered, and the refs its report cited, or null when none answered.
const attemptOf = (row: CardRow): CardRelayBrief["attempt"] =>
  row.attempt_agent === null || row.attempt_answer === null
    ? null
    : {
        agent: row.attempt_agent,
        answer: row.attempt_answer,
        refs: (row.attempt_ref_kinds ?? []).flatMap((kind, at) => {
          const id = row.attempt_ref_ids?.[at];
          return id === undefined ? [] : [{ kind, id }];
        }),
      };

const questionOf = async (ctx: Ctx, opportunity: string): Promise<CardRow | undefined> =>
  (await ctx.run<CardRow>(QUESTION, [opportunity]))[0];

// The task's card under the caller's token, or null when the caller can't see it or it is gone.
export async function relayBrief(ctx: Ctx, opportunity: string): Promise<CardRelayBrief | null> {
  const row = await questionOf(ctx, opportunity);
  if (row === undefined) return null;
  return { ...cardFields(row), words: await wordsOf(ctx, row), attempt: attemptOf(row) };
}

const isRelayRefusal = (code: string | undefined): code is CardRelayRefusal =>
  (CARD_RELAY_REFUSALS as readonly string[]).includes(code ?? "");

// relay_card_answer. The quote is the owner's words as the agent gives them. Code checks what it can: the quote is
// not what the card says, nor holds it whole (`not_owner_words`, the claim intake's one check); then the quote is
// sealed under the card's label, as the answer's basis, and the definer applies the other rules and takes the relay
// or names its refusal. A card the caller cannot see is `not_found`, the same answer as for one that is not there
// (invariant 6). `applied` is true only on a repeat of a request whose relay the owner's process has applied.
export async function relayCardAnswer(
  call: WorkCall,
  valid: RelayCardAnswerArgs,
): Promise<Done<RelayCardAnswerResult>> {
  const [task] = await call.ctx.run<{ id: string }>(TASK, [valid.card]);
  const row = task === undefined ? undefined : await questionOf(call.ctx, task.id);
  const id = cardRelayId();
  let sealed: string | null = null;
  if (row !== undefined && row.card_id === valid.card) {
    const words = await wordsOf(call.ctx, row);
    if (passedOffAsOwners(words?.untrusted ?? "", [valid.quote]))
      return { outcome: { ok: false, code: "invalid_request", refusal: "not_owner_words" }, rows: 0 };
    try {
      sealed = JSON.stringify(
        sealUnder(
          call.ctx.keys,
          row.compartments,
          { table: "ledger.card_relays", id, column: "quote_enc" },
          valid.quote,
        ),
      );
    } catch (error) {
      // A key the caller lacks is the one failure meant: the function then keeps nothing.
      if (!isCoded(error, "unknown_compartment")) throw error;
    }
  }
  const rows = await call.fn<{ code: string }>("select ledger.relay_card_answer($1, $2, $3, $4, $5, $6) as code", [
    id,
    valid.requestId,
    valid.card,
    valid.option,
    sealed,
    await call.session(),
  ]);
  if (isRefused(rows)) return refused(rows);
  const code = rows[0]?.code;
  if (code === "ok" || code === "applied") return answered({ card: valid.card, applied: code === "applied" });
  // Each of the function's refusals by name: an option the card does not take is the argument's
  // fault, the rest the state's.
  if (isRelayRefusal(code)) return code === "not_an_option" ? invalidAs(code) : refusedAs(code);
  return refused("not_found");
}
