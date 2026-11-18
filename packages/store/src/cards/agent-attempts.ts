import {
  AGENT_ATTEMPT_GRACE_MINUTES,
  AGENT_ATTEMPT_HOURS,
  AGENT_HELD_KINDS,
  AGENT_SETTLED_CODES,
  type AutonomyRules,
} from "@intelligence/contracts/personal";
import { autonomyRules } from "@intelligence/personal-core/planner";
import { quoted } from "../core/statements.ts";

// An agent's attempt on a card before the owner sees it: when a
// card waits on its task, as a rule in SQL over the card's own rows. The lists
// and the hours are the contract's constants; the switch is `cardAttemptsOn` of the autonomy rules.
// Nothing here reads a row or writes one: the answer and a settle are ledger.answer_card's.

// The switch: on only when the rule data says so; absent is off.
export const attemptsOn = (rules: AutonomyRules = autonomyRules()): boolean => rules.cardAttemptsOn === true;

// A task an agent may still report on: one handed to the owner is the owner's, so its card is too.
export const TASK_OPEN = ["proposed", "later", "go", "claimed"] as const;

// Whether a waiting card is held back from the owner for an agent: of a kind held for one (every
// kind an agent is asked but a reminder, which is due when it is raised), younger than the wait, never touched by the owner, and either with a task still open or,
// while tasks are on, so new that the tick has not raised one yet. A task that ended, by a done
// report (its answer is then on the card), a failure, a release or an expiry, gives the card to the
// owner at once; so does the wait running out, and so does the owner's own reopen (invariant 11).
// With tasks off no task can be raised, and no card waits for one.
// The rule on a card's row (`id`, `kind`, `created_at`, `compartments`) aliased `card`, as of
// `now`, the expression that holds the reader's clock: a task and its events after `now` are not
// read, so a past day's count is that day's. Only a task within the card's own label holds it, so
// nothing under a wider label changes what a viewer of the card's label is shown (invariant 6).
// Whether tasks are on is read as it is now, as ledger.raise_gap_flag reads it: an intent for tasks
// the owner confirmed and has not revoked. It names only tables every deployed schema has.
const TASK = (now: string, card: string): string =>
  `from ledger.opportunities ao
   where ao.gap_trigger = 'card_question' and ao.gap_subject = ${card}.id and ao.created_at <= ${now}::timestamptz
     and ao.compartments <@ ${card}.compartments`;
export const HELD_FOR_AGENT = (now: string, card = "c"): string =>
  `(${card}.kind in (${quoted(AGENT_HELD_KINDS)})
    and ${card}.created_at > ${now}::timestamptz - make_interval(hours => ${AGENT_ATTEMPT_HOURS})
    and not exists (select 1 from ledger.record_events oe
                    where oe.row_kind = 'card' and oe.row_id = ${card}.id and oe.by = 'owner' and oe.at <= ${now}::timestamptz)
    and (exists (select 1 ${TASK(now, card)} and ao.tainted_at is null
                   and (select ar.event from ledger.record_events ar
                        where ar.row_kind = 'opportunity' and ar.row_id = ao.id and ar.at <= ${now}::timestamptz
                        order by ar.id desc limit 1) in (${quoted(TASK_OPEN)}))
      or (${card}.created_at > ${now}::timestamptz - make_interval(mins => ${AGENT_ATTEMPT_GRACE_MINUTES})
          and exists (select 1 from policy.intents ai where ai.for_tasks and ai.confirmed_at is not null and ai.revoked_at is null)
          and not exists (select 1 ${TASK(now, card)}))))`;

// The codes on the `withdrawn` event of a card an agent's answer settled, for SQL.
export const AGENT_SETTLED_CODES_SQL = quoted(AGENT_SETTLED_CODES);
