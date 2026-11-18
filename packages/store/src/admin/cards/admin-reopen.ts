import { AGENT_SETTLED_CODES, type CardId, type RulingId } from "@intelligence/contracts/personal";
import { SETTLED_CODES } from "../../cards/asked-less.ts";
import type { TxAt } from "../../core/admin-context.ts";
import { AdminError } from "../../core/admin-error.ts";
import { type Query, stamp } from "../../core/db.ts";
import { requestIdOf } from "../../core/ids.ts";
import { authorWord } from "../../core/locks.ts";
import { ownerDecision } from "../../core/owner-decision.ts";
import { CARD_EXPIRY, CARD_REOPEN, lockRows } from "../../core/queue.ts";
import { LATEST_CARD_EVENT, latestRow } from "../../core/statements.ts";
import { CARD_PENDING, CARD_REOPENED, recordEvent } from "../record-event.ts";

// The owner's reopen of a card the policy expired (`pi cards reopen CARD`): the card deferred
// again, by the owner, so it waits its turn and its days as any deferred card. A card a rule stopped comes
// back pending instead. Either way the opportunity or hypothesis that closed given back the status it had before, by CARD_REOPEN, never as an
// answer of the owner's. Cancelled intentions stay cancelled. `not_found` for a card that is not, as its
// latest event, expired by the policy; nothing is written then. Append-only: each change is a new
// event.
//
// A card an agent's relay answered comes back pending too: the relay is marked taken back, the
// decision it made is superseded by a `relay_lift` of the owner's, so nothing that reads the
// owner's standing answers reads it, and the work or lesson it decided is given back the status it
// had, where the relayed answer's own event is still its latest. What else that answer changed (a
// lesson it retired, a lesson that changed again since) stays, is the owner's to change by its own
// command, and is named in `left`, a code for each, so the owner is told what the reopen did not
// undo. Work a relayed go started is always stopped. An answer whose effect is a ruling, a project
// or a queued run (EFFECT_KEPT) leaves that effect: `effect_kept`.
export type ReopenLeft = "lesson_retired" | "changed_since" | "effect_kept";

// The relayed answers of each kind whose effect a reopen does not take back: a fact's join or
// split, a project or its time rulings, a tier ruling, and an idea's queued translation.
export const EFFECT_KEPT: Readonly<Record<string, readonly string[]>> = Object.freeze({
  same_fact: ["same", "different"],
  time_effort: ["confirm", "reject"],
  tier_proposal: ["confirm"],
  idea: ["pursue"],
});
export async function reopenExpiredCard(
  query: Query,
  id: CardId,
  now: Date,
): Promise<{ left: ReopenLeft[] } | "not_found"> {
  const left: ReopenLeft[] = [];
  const [card] = await query<{
    author: string;
    kind: string;
    target_kind: string | null;
    target_id: string | null;
    compartments: string[];
  }>(
    "select created_by as author, kind, target_kind, target_id, compartments from ledger.cards where id = $1 and tainted_at is null",
    [id],
  );
  if (card === undefined) return "not_found";
  await lockRows(query, [id, authorWord(card.author), ...(card.target_id === null ? [] : [card.target_id])]);
  const [state] = await query<{ event: string; by: string; code: string | null }>(
    `${latestRow("event, by, code", "card", "$1", { alias: "" })}`,
    [id],
  );
  // A rule's stop gives the card back to the owner at once: they asked for this one. So does an
  // outcome code settled without the owner, and a card an agent's answer settled: the owner's word
  // outranks both.
  const stopped =
    state?.event === "withdrawn" &&
    (state.code === "rule_stopped" ||
      (SETTLED_CODES as readonly string[]).includes(state.code ?? "") ||
      AGENT_SETTLED_CODES.includes(state.code ?? ""));
  // Decided by a relayed answer that still stands: the owner cannot have answered it since, as a
  // decided card takes no answer until it is reopened.
  const relay =
    state?.event === "decided" && state.by === "owner" ? await takeBackRelay(query, id, card.compartments, now) : null;
  const relayed = relay !== null;
  if (!stopped && !relayed && (state?.event !== "expired" || state.by !== CARD_EXPIRY)) return "not_found";
  const event = stopped || relayed ? "pending" : "deferred";
  await recordEvent(query, CARD_REOPENED, id, stamp(now), card.compartments, { event });
  if (card.target_id !== null && (card.target_kind === "opportunity" || card.target_kind === "hypothesis")) {
    const [last, before] = await query<{
      event: string;
      by: string;
      code: string | null;
      compartments: string[];
      at: Date;
    }>(
      "select event, by, code, compartments, at from ledger.record_events where row_kind = $1 and row_id = $2 order by id desc limit 2",
      [card.target_kind, card.target_id],
    );
    if (
      ((last?.event === "expired" && last.by === CARD_EXPIRY) ||
        last?.code === "rule_stopped" ||
        // The relayed answer's own event, written at the answer's instant, and nothing since.
        (relay !== null && last?.by === "owner" && last.at.getTime() === relay.getTime())) &&
      before !== undefined
    ) {
      const extra = { kind: card.target_kind, event: before.event, code: "card_reopen" };
      await recordEvent(query, { by: CARD_REOPEN }, card.target_id, stamp(now), last.compartments, extra);
    } else if (relay !== null && card.target_kind === "opportunity") {
      // The relayed answer let work start and something has happened to it since (an agent took it
      // up). The owner's reopen always stops it: any claim on it ends, and it is given back the
      // status it had before that answer, so the owner's own answer on the card, a no among them,
      // takes effect as on a card never answered.
      const [prior] = await query<{ event: string; compartments: string[] }>(
        `select b.event, b.compartments from ledger.record_events a
         join lateral (select e.event, e.compartments from ledger.record_events e
                       where e.row_kind = 'opportunity' and e.row_id = a.row_id and e.id < a.id order by e.id desc limit 1) b on true
         where a.row_kind = 'opportunity' and a.row_id = $1 and a.by = 'owner' and a.at = $2
         order by a.id limit 1`,
        [card.target_id, stamp(relay)],
      );
      if (prior !== undefined) {
        await query("delete from queue.leases where resource_kind = 'opportunity' and resource_id = $1", [
          card.target_id,
        ]);
        const extra = { kind: "opportunity", event: prior.event, code: "card_reopen" };
        await recordEvent(query, { by: CARD_REOPEN }, card.target_id, stamp(now), prior.compartments, extra);
      } else left.push("changed_since");
    } else if (relay !== null) left.push("changed_since"); // a lesson changed again since the answer
  }
  if (relay !== null && card.target_kind === "hypothesis" && card.target_id !== null) {
    // A confirmed lesson retired the one it replaces at the answer's instant, by the owner.
    const [retired] = await query(
      `select 1 from ledger.hypotheses h join ledger.record_events e on e.row_kind = 'hypothesis' and e.row_id = h.supersedes
       where h.id = $1 and e.event = 'retired' and e.by = 'owner' and e.at = $2`,
      [card.target_id, stamp(relay)],
    );
    if (retired !== undefined) left.push("lesson_retired");
  }
  if (relay !== null) {
    const [taken] = await query<{ option: string }>("select option from ledger.card_relays where card_id = $1", [id]);
    if (taken !== undefined && (EFFECT_KEPT[card.kind] ?? []).includes(taken.option)) left.push("effect_kept");
  }
  await query("select ledger.admit_deferred($1)", [card.author]);
  return { left };
}

// A relayed answer taken back, under the card's lock: the relay marked, and the decision it made
// superseded by the owner's lift. The instant the answer was applied, or null when the card has no
// applied relay that still stands.
async function takeBackRelay(query: Query, card: CardId, compartments: string[], now: Date): Promise<Date | null> {
  const [relay] = await query<{ id: string; ruling_id: RulingId; applied_at: Date }>(
    "update ledger.card_relays set reopened_at = $2 where card_id = $1 and ruling_id is not null and reopened_at is null returning id, ruling_id, applied_at",
    [card, stamp(now)],
  );
  if (relay === undefined) return null;
  await ownerDecision(
    query,
    {
      requestId: requestIdOf(`relay_lift:${relay.id}`),
      kind: "relay_lift",
      supersedes: relay.ruling_id,
      compartments: compartments,
    },
    now,
  );
  return relay.applied_at;
}

// The owner's reopen: an id with nothing to reopen is refused.
export async function ownerReopenCard({ query, now }: TxAt, id: CardId): Promise<{ left: ReopenLeft[] }> {
  const reopened = await reopenExpiredCard(query, id, now);
  if (reopened === "not_found") throw new AdminError("not_found");
  return reopened;
}

// The answer from the owner on a card lifted (the toast's Undo, `pi correct lift`, `pi identity lift`),
// the card it answered waits for the owner again, pending, by the owner, so they can answer it
// anew. Only a card whose latest event is still that decision; nothing for a lift of a ruling no
// card made. In the lift's transaction.
export async function reopenAnswered(query: Query, ruling: RulingId, now: Date): Promise<void> {
  const [card] = await query<{ id: string; compartments: string[] }>(
    `select c.id, c.compartments from knowledge.owner_decisions d join ledger.cards c on c.id = d.card_id
     where d.id = $1 and c.tainted_at is null
       and (${LATEST_CARD_EVENT}) = 'decided'`,
    [ruling],
  );
  if (card === undefined) return;
  await recordEvent(query, CARD_PENDING, card.id, stamp(now), card.compartments);
}

// The request id of an Edit's correction, from its answer's: the lift of the answer finds the
// correction by it.
export const editRequestId = (answerRequestId: string): string => requestIdOf(`${answerRequestId}:correct`);
