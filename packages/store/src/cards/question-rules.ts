import { CARD_OPTIONS, type CardId, dayIn, hourIn, type PersonalCompartment } from "@intelligence/contracts/personal";
import { ruleKey, rulesDue } from "@intelligence/personal-core/planner";
import { type Query, stamp } from "../core/db.ts";
import { newId, ruleId } from "../core/ids.ts";
import { raiseCard } from "../core/queue.ts";
import { latestEvent } from "../core/statements.ts";
import { ownerZoneOf } from "../core/zone.ts";

// A pattern the owner answered alike becomes a rule the owner is asked to confirm: code finds it from the
// owner's own decisions, by clear columns alone, and no model writes or judges it. Run by the tick as
// pi_work. In force only once the owner confirms; a declined or lifted one is the owner's no and is never
// proposed again.

const RULE_AUTHOR = "system:rules";

const ANSWERS = "select kind, pattern, answer, at, compartments from ledger.rule_answers()";

export async function proposeQuestionRules(query: Query, now: Date): Promise<number> {
  const rows = await query<{ kind: string; pattern: string | null; answer: string; at: Date; compartments: string[] }>(
    ANSWERS,
  );
  const answers = rows.flatMap((row) =>
    row.pattern === null ? [] : [{ kind: row.kind, pattern: row.pattern, answer: row.answer, at: stamp(row.at) }],
  );
  // A proposal whose card ended unanswered is not an answer: it may be asked again. A no or a lift holds.
  const held = new Set(
    (
      await query<{ kind: string; pattern: string; answer: string }>(
        `select r.kind, r.pattern, r.answer from ledger.question_rules r
         where r.status <> 'proposed' or r.card_id is null
           or (${latestEvent("card", "r.card_id", "e")}) in ('pending', 'deferred')`,
      )
    ).map(ruleKey),
  );
  let proposed = 0;
  for (const due of rulesDue(answers, held)) {
    const compartments = [
      ...new Set(rows.filter((row) => row.pattern === due.pattern).flatMap((row) => row.compartments)),
    ].sort() as PersonalCompartment[];
    const id = ruleId();
    const card = {
      id: newId("crd") as CardId,
      requestId: id,
      kind: "question_rule",
      author: RULE_AUTHOR,
      options: [...CARD_OPTIONS.question_rule],
      target: null,
      refs: [],
      compartments,
      expiresAt: null,
      expiresAfterDays: 30,
      caseKey: `rule:${id}`,
      run: null,
      body: null,
      bodyFrom: null,
    };
    await raiseCard(query, card, { now });
    await query("select ledger.propose_question_rule($1, $2, $3, $4, $5, $6, $7, $8)", [
      id,
      due.kind,
      due.pattern,
      due.answer,
      due.answers,
      card.id,
      stamp(now),
      compartments,
    ]);
    proposed += 1;
  }
  return proposed;
}

// Once a day of the owner's: reading every decided card is not worth doing each tick, and a pattern a
// day late costs nothing. The day is due on the first tick at or after the sweep hour, in the owner's
// zone (UTC's while unset), as the daily sweep and the night's pass read it, whatever hour that tick
// comes: a tick held behind a long job still finds it. `lastDay`: the day the tick last proposed for.
export function ruleDayDue(now: Date, zone: string | null, sweepHour: number, lastDay: string | null): string | null {
  const day = dayIn(now, zone);
  return hourIn(now, zone) >= sweepHour && day !== lastDay ? day : null;
}

// The rules proposed when the owner's day is due: the day proposed for, or null when none was due.
export async function proposeDueRules(
  query: Query,
  now: Date,
  lastDay: string | null,
): Promise<{ day: string; proposed: number } | null> {
  const [settings] = await query<{ hour: number }>("select sweep_hour_utc as hour from policy.work_settings");
  if (settings === undefined) return null;
  const day = ruleDayDue(now, await ownerZoneOf(query), settings.hour, lastDay);
  return day === null ? null : { day, proposed: await proposeQuestionRules(query, now) };
}
