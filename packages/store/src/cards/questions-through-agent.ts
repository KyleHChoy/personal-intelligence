import {
  AGENT_ATTEMPT_GRACE_MINUTES,
  AGENT_ATTEMPT_HOURS,
  CARD_RELAY_AFTER_ATTEMPT,
  CARD_RELAY_GRACE_MINUTES,
  CARD_RELAY_HOURS,
  CARD_RELAY_KINDS,
  CARD_RELAY_UNCLAIMED_HOURS,
  type CardLine,
  type CardRelayState,
  isCardRelayKind,
} from "@intelligence/contracts/personal";
import { sha256 } from "@intelligence/personal-core";
import type { Query } from "../core/db.ts";
import { quoted } from "../core/statements.ts";
import { attemptLines } from "./agent-attempt-lines.ts";
import { TASK_OPEN } from "./agent-attempts.ts";
import type { StoredCard } from "./card-kind-row.ts";
import { codeLine, part } from "./card-line.ts";

// A card asked through an agent: when a card is held out of the
// owner's queue for the agent of the question role, as a rule in SQL over the card's own rows; the
// line a relayed answer leaves on the card; what became of a relay; and the
// week's sample the owner is shown. The lists and the hours are the contract's constants. Nothing
// here writes: the relay is ledger.relay_card_answer's, and its answer `decide`'s (admin-relays.ts).

// Whether a waiting card is held out of the owner's queue: of a kind asked through an agent, younger
// than the wait, not expiring before the wait would end, never touched by the owner, and either
// with its task still open or, while a question role is set, so new that the tick has not raised
// one yet. A relay ends the task, so a relayed card is the owner's at once; so is one whose task
// was released past its lease, failed or was withdrawn, and one the owner touched (invariant 11).
// A decision on work that is not a read-only task an agent or the owner proposed is never asked
// so: a gap flag's own card, a card's task among them, is the owner's; so is a decision on a task
// due before the wait would end, which cannot wait for a conversation.
// A kind an agent is asked first is asked so only once that attempt is over (ledger.card_relayable):
// its wait runs the attempt's hours longer, and "so new" is counted from when the attempt ended:
// its task's last event, the attempt's grace with no task raised, or the attempt's wait running
// out. A reminder is never asked so: it is due when it is raised, so the owner sees it at once.
// `unclaimedSince`: when the open task was raised, while no agent has claimed it: past
// CARD_RELAY_UNCLAIMED_HOURS nobody is asking, and the card is the owner's.
const AFTER_HOURS = AGENT_ATTEMPT_HOURS + CARD_RELAY_HOURS;

// The same rule on a card's row (`id`, `kind`, `created_at`, `expires_at`, `expires_after_days`,
// `target_kind`, `target_id`, `compartments`) aliased `card`, as of `now`. Only a task within the
// card's own label holds it (invariant 6).
const TASK = (now: string, card: string): string =>
  `from ledger.opportunities ro
   where ro.gap_trigger = 'card_relay' and ro.gap_subject = ${card}.id and ro.created_at <= ${now}::timestamptz
     and ro.compartments <@ ${card}.compartments`;
const ATTEMPT = (now: string, card: string): string =>
  `from ledger.opportunities qa
   where qa.gap_trigger = 'card_question' and qa.gap_subject = ${card}.id and qa.created_at <= ${now}::timestamptz
     and qa.compartments <@ ${card}.compartments`;
const EXPIRES = (card: string, hours: number): string =>
  `(${card}.expires_at is null or ${card}.expires_at >= ${card}.created_at + make_interval(hours => ${hours}))
    and (${card}.expires_after_days is null or ${card}.expires_after_days * 24 >= ${hours})`;
export const HELD_FOR_RELAY = (now: string, card = "c"): string =>
  `(((${card}.kind in (${quoted(CARD_RELAY_KINDS)})
      and ${card}.created_at > ${now}::timestamptz - make_interval(hours => ${CARD_RELAY_HOURS})
      and ${EXPIRES(card, CARD_RELAY_HOURS)}
      and (${card}.kind <> 'opportunity_decision'
           or (${card}.target_kind = 'opportunity'
               and exists (select 1 from ledger.opportunities rt
                           where rt.id = ${card}.target_id and rt.tier = 'task' and rt.tainted_at is null and rt.gap_trigger is null
                             and (rt.due_at is null or rt.due_at >= ${card}.created_at + make_interval(hours => ${CARD_RELAY_HOURS}))))))
     or (${card}.kind in (${quoted(CARD_RELAY_AFTER_ATTEMPT)})
         and ${card}.created_at > ${now}::timestamptz - make_interval(hours => ${AFTER_HOURS})
         and ${EXPIRES(card, AFTER_HOURS)}
         and not (${card}.target_kind = 'opportunity'
                  and exists (select 1 from ledger.opportunities rt where rt.id = ${card}.target_id and rt.gap_trigger is not null))))
    and not exists (select 1 from ledger.record_events re
                    where re.row_kind = 'card' and re.row_id = ${card}.id and re.by = 'owner' and re.at <= ${now}::timestamptz)
    and (exists (select 1 ${TASK(now, card)} and ro.tainted_at is null
                   and (select rr.event from ledger.record_events rr
                        where rr.row_kind = 'opportunity' and rr.row_id = ro.id and rr.at <= ${now}::timestamptz
                        order by rr.id desc limit 1) in (${quoted(TASK_OPEN)})
                   and (ro.created_at > ${now}::timestamptz - make_interval(hours => ${CARD_RELAY_UNCLAIMED_HOURS})
                        or (select rr.event from ledger.record_events rr
                            where rr.row_kind = 'opportunity' and rr.row_id = ro.id and rr.at <= ${now}::timestamptz
                            order by rr.id desc limit 1) = 'claimed'))
      or (exists (select 1 from policy.work_settings rs where rs.question_role is not null)
          and not exists (select 1 ${TASK(now, card)})
          and ((${card}.kind in (${quoted(CARD_RELAY_KINDS)})
                and ${card}.created_at > ${now}::timestamptz - make_interval(mins => ${CARD_RELAY_GRACE_MINUTES}))
            or (${card}.kind in (${quoted(CARD_RELAY_AFTER_ATTEMPT)})
                and (exists (select 1 ${ATTEMPT(now, card)}
                               and (select qr.at from ledger.record_events qr
                                    where qr.row_kind = 'opportunity' and qr.row_id = qa.id and qr.at <= ${now}::timestamptz
                                    order by qr.id desc limit 1) > ${now}::timestamptz - make_interval(mins => ${CARD_RELAY_GRACE_MINUTES})
                               and (select qr.event from ledger.record_events qr
                                    where qr.row_kind = 'opportunity' and qr.row_id = qa.id and qr.at <= ${now}::timestamptz
                                    order by qr.id desc limit 1) not in (${quoted(TASK_OPEN)}))
                  or (not exists (select 1 ${ATTEMPT(now, card)})
                      and ${card}.created_at <= ${now}::timestamptz - make_interval(mins => ${AGENT_ATTEMPT_GRACE_MINUTES})
                      and ${card}.created_at > ${now}::timestamptz - make_interval(mins => ${AGENT_ATTEMPT_GRACE_MINUTES + CARD_RELAY_GRACE_MINUTES}))
                  or (${card}.created_at <= ${now}::timestamptz - make_interval(hours => ${AGENT_ATTEMPT_HOURS})
                      and ${card}.created_at > ${now}::timestamptz - make_interval(hours => ${AGENT_ATTEMPT_HOURS}) - make_interval(mins => ${CARD_RELAY_GRACE_MINUTES}))))))))`;

// What became of a relay, from its own row.
export const relayState = (row: {
  ruling_id: string | null;
  failed_code: string | null;
  reopened_at: Date | null;
}): CardRelayState =>
  row.reopened_at !== null
    ? "reopened"
    : row.ruling_id !== null
      ? "applied"
      : row.failed_code !== null
        ? "failed"
        : "taken";

export function relaySample(ids: readonly string[], week: string, most: number): string[] {
  const rank = (id: string): string => sha256(`${id}\n${week}`);
  return [...new Set(ids)]
    .map((id) => [rank(id), id] as const)
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : 1))
    .slice(0, most)
    .map(([, id]) => id);
}

// A card whose relay was applied is answered and shows no line here; one whose relay is not applied
// yet, could not be, or was taken back shows it, and the owner's own answer outranks it. Nothing
// the agent wrote is shown.
async function relayLines(query: Query, card: StoredCard): Promise<CardLine[]> {
  if (!isCardRelayKind(card.kind)) return [];
  const rows = await query<{ client_name: string; option: string }>(
    "select y.client_name, y.option from ledger.card_relays y where y.card_id = $1",
    [card.id],
  );
  return rows.map((row) => codeLine("relayed_answer", [part.text(row.client_name), part.code(row.option)]));
}

// What agents left on a card, for the owner's page: an agent's own answer, then a relayed one.
export const agentLines = async (query: Query, card: StoredCard): Promise<CardLine[]> => [
  ...(await attemptLines(query, card)),
  ...(await relayLines(query, card)),
];
