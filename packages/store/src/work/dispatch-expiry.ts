// The tick's step 3 and the check-backs: cards, opportunities and run leases past their time,
// a claimed opportunity returned to `go` with its unreported moves abandoned (but one its holder
// reported progress on in the last 24 hours), a lapsed lease kept for its holder's 24 hours, a
// check-back's 24-hour preference and its lapse, and runs ended or stopped. Each write is one transaction, as
// dispatch-write.ts describes.

import type {
  CardAuthor,
  CardId,
  ClientId,
  IntentionId,
  MoveId,
  OpportunityId,
  RunId,
} from "@intelligence/contracts/personal";
import { LIVE_HYPOTHESIS_STATES } from "@intelligence/contracts/personal";
import { DAY_MS } from "@intelligence/personal-core";
import { autonomyWindows } from "@intelligence/personal-core/planner";
import { type Query, stamp } from "../core/db.ts";
import { authorWord } from "../core/locks.ts";
import { CARD_EXPIRY, cardExpiry, latestOf, lockRows } from "../core/queue.ts";
import { latestEvent, latestRow, moveStatus } from "../core/statements.ts";
import { type Expired, OPEN_EXPIRY_DAYS, openSince, recentProgress, unreportedMoves } from "./dispatch-read.ts";
import {
  BY,
  cancelIntentionsOf,
  closeWork,
  hypothesisOf,
  opportunityOf,
  recordEvent,
  undecidedAbout,
  withdraw,
} from "./dispatch-write.ts";

// The card kinds a point escalates to, and the effect the tick gives a card of that kind that
// nobody answered. A card of any other kind expires with no effect.
const NO_ANSWER: Readonly<Record<string, "opportunity" | "hypothesis">> = {
  opportunity_decision: "opportunity",
  owner_question: "hypothesis",
  idea: "hypothesis",
  lesson: "hypothesis",
};

// A claimed opportunity back to `go`. For a lapsed lease, the lease row stays its holder's, with
// the 24 hours from its lapse in which the holder alone may claim the work again. For a check-back,
// it is held for the client that set it for 24 hours before any other, and the check-back `fired`.
// False when it is not `claimed`, for a lapsed lease, when the lease has been taken again, or for a
// check-back, when the lease row is not its client's.
export async function returnToGo(
  query: Query,
  id: OpportunityId,
  now: Date,
  preferred?: { client: ClientId; intention: IntentionId },
): Promise<boolean> {
  await lockRows(query, preferred === undefined ? [id] : [id, preferred.intention]);
  const opportunity = await opportunityOf(query, id);
  if (opportunity === null || (await latestOf(query, "opportunity", id)) !== "claimed") return false;
  if (preferred === undefined) {
    const [lease] = await query<{ lapsed: boolean }>(
      "select lease_until < $2 as lapsed from queue.leases where resource_kind = 'opportunity' and resource_id = $1",
      [id, stamp(now)],
    );
    if (lease !== undefined && !lease.lapsed) return false;
  } else {
    // A check-back returns only work its own client holds: one set by an earlier holder never
    // takes the work, or its moves, from the client that holds it now.
    const [lease] = await query<{ holder: string }>(
      "select holder from queue.leases where resource_kind = 'opportunity' and resource_id = $1",
      [id],
    );
    if (lease?.holder !== preferred.client) return false;
  }
  await recordEvent(query, {
    kind: "opportunity",
    id,
    event: "go",
    at: now,
    compartments: opportunity.compartments,
    code: preferred === undefined ? "lease_expired" : null,
  });
  if (preferred === undefined)
    await query(
      `update queue.leases set preferred_until = lease_until + interval '24 hours'
       where resource_kind = 'opportunity' and resource_id = $1`,
      [id],
    );
  else await prefer(query, id, opportunity.compartments, preferred, now);
  // Either way the claim ended with the move unreported (review: a check-back's return too).
  await abandonMoves(query, id, now);
  return true;
}

// A lapsed lease, or a check-back's return, ends each move on its opportunity that was planned and
// never reported: one `failed` event with the code `abandoned`, in the move's own label, so no move
// stays open after its holder let the work go. A move its holder reported progress on in the last
// 24 hours stays open: the holder has the work's next 24 hours, and the sweep (failUnreported)
// closes the move once they pass with no word. The one place this event is written; the agent API
// only lists such moves and points to report or release.
const ABANDONED = "abandoned";
async function abandonMoves(query: Query, opportunity: OpportunityId, now: Date): Promise<number> {
  const open = await query<{ id: string; compartments: string[] }>(
    `select m.id, m.compartments from ledger.moves m
     where m.opportunity_id = $1
       and (${moveStatus()}) = 'cleared'
       and not ${recentProgress("m.id", "$2")}
     order by m.id collate "C"`,
    [opportunity, stamp(now)],
  );
  for (const move of open)
    await recordEvent(query, {
      kind: "move",
      id: move.id,
      event: "failed",
      at: now,
      compartments: move.compartments,
      code: ABANDONED,
    });
  return open.length;
}

// The 24-hour preference: a lapsed lease row held by the client, which `ledger.claim` reads.
async function prefer(
  query: Query,
  id: OpportunityId,
  compartments: string[],
  preferred: { client: ClientId; intention: IntentionId },
  now: Date,
): Promise<void> {
  await query(
    `insert into queue.leases (resource_kind, resource_id, holder, lease_until, first_taken_at, preferred_until)
     values ('opportunity', $1, $2, $3, $3, $4)
     on conflict (resource_kind, resource_id) do update set holder = excluded.holder, lease_until = excluded.lease_until,
       first_taken_at = excluded.first_taken_at, preferred_until = excluded.preferred_until`,
    [id, preferred.client, stamp(now), stamp(new Date(now.getTime() + DAY_MS))],
  );
  const [intention] = await query<{ compartments: string[] }>(
    "select compartments from ledger.intentions where id = $1",
    [preferred.intention],
  );
  await recordEvent(query, {
    kind: "intention",
    id: preferred.intention,
    event: "fired",
    at: now,
    compartments: intention?.compartments ?? compartments,
  });
}

// A due check-back on an opportunity that is `go`: the 24-hour preference alone. Never against the
// work's last holder: where the lease row is another active client's and that client's hold still
// runs (its lease lapsed under 24 hours ago, a check-back's return still prefers it, or a
// check-back of its own holds the work), the check-back is an earlier holder's and is cancelled, as
// it is on claimed work, so it never takes the work, or its moves, from the client that has it.
export async function preferClient(
  query: Query,
  id: OpportunityId,
  preferred: { client: ClientId; intention: IntentionId },
  now: Date,
): Promise<boolean> {
  await lockRows(query, [id, preferred.intention]);
  const opportunity = await opportunityOf(query, id);
  if (
    opportunity === null ||
    (await latestOf(query, "opportunity", id)) !== "go" ||
    (await latestOf(query, "intention", preferred.intention)) !== "set"
  )
    return false;
  const [other] = await query(
    `select 1 from queue.leases l join policy.clients h on h.id = l.holder and h.status = 'active'
     where l.resource_kind = 'opportunity' and l.resource_id = $1 and l.holder <> $2
       and ledger.work_held(l.resource_id, $3)`,
    [id, preferred.client, stamp(now)],
  );
  if (other !== undefined) {
    const [intention] = await query<{ compartments: string[] }>(
      "select compartments from ledger.intentions where id = $1",
      [preferred.intention],
    );
    await recordEvent(query, {
      kind: "intention",
      id: preferred.intention,
      event: "cancelled",
      at: now,
      compartments: intention?.compartments ?? opportunity.compartments,
    });
    return false;
  }
  await prefer(query, id, opportunity.compartments, preferred, now);
  return true;
}

// A check-back hold that lapsed with the item unclaimed. One `go` event with the code
// `preference_lapsed`, which the notice function takes as `returned`, and the hold cleared, in one
// transaction; nothing when the item moved or the hold is gone. The event is a `go`, so the item's
// status stays `go` for every reader of the latest event.
// Nothing either while a waiting check-back of the lease's holder still holds the work: it has not
// come back to the board, so nothing says it has; the lapse is written once that check-back is gone.
export async function lapseHold(query: Query, id: OpportunityId, now: Date): Promise<boolean> {
  await lockRows(query, [id]);
  const opportunity = await opportunityOf(query, id);
  if (opportunity === null || (await latestOf(query, "opportunity", id)) !== "go") return false;
  const cleared = await query(
    `update queue.leases l set preferred_until = null
     where l.resource_kind = 'opportunity' and l.resource_id = $1 and l.preferred_until is not null and l.preferred_until <= $2 and l.lease_until < $2
       and not ledger.check_back_holds(l.resource_id, l.holder)
     returning l.resource_id`,
    [id, stamp(now)],
  );
  if (cleared.length === 0) return false;
  await recordEvent(query, {
    kind: "opportunity",
    id,
    event: "go",
    at: now,
    compartments: opportunity.compartments,
    code: "preference_lapsed",
  });
  return true;
}

export async function cancelIntention(query: Query, id: IntentionId, now: Date): Promise<boolean> {
  await lockRows(query, [id]);
  const [intention] = await query<{ compartments: string[] }>(
    "select compartments from ledger.intentions where id = $1",
    [id],
  );
  if (intention === undefined || (await latestOf(query, "intention", id)) !== "set") return false;
  await recordEvent(query, {
    kind: "intention",
    id,
    event: "cancelled",
    at: now,
    compartments: intention.compartments,
  });
  return true;
}

// A card past its expiry: its `expired` event, its point's no-answer effect on its target, and its
// author's oldest deferred card admitted. With `deferredBefore`, a card deferred at or before it,
// expired by the policy (CARD_EXPIRY, code `card_expiry` on every event it writes); a pending card
// is never one.
async function expireCard(query: Query, id: CardId, now: Date, deferredBefore: Date | null = null): Promise<boolean> {
  const [card] = await query<{
    kind: string;
    author: CardAuthor;
    target_kind: string | null;
    target_id: string | null;
    compartments: string[];
    expires_at: Date | null;
    days: number | null;
  }>(
    "select kind, created_by as author, target_kind, target_id, compartments, expires_at, expires_after_days as days from ledger.cards where id = $1",
    [id],
  );
  if (card === undefined) return false;
  const effect = NO_ANSWER[card.kind];
  const target = effect !== undefined && card.target_id !== null && effect === card.target_kind ? card.target_id : null;
  await lockRows(query, [id, authorWord(card.author), ...(target === null ? [] : [target])]);
  const [state] = await query<{ event: string; at: Date }>(`${latestRow("event, at", "card", "$1", { alias: "" })}`, [
    id,
  ]);
  if (state === undefined || (state.event !== "pending" && state.event !== "deferred")) return false;
  if (deferredBefore === null) {
    const expiry = cardExpiry(card.expires_at, card.days, state.event === "pending" ? state.at : null);
    if (expiry === null || expiry.getTime() > now.getTime()) return false;
  } else if (state.event !== "deferred" || state.at.getTime() > deferredBefore.getTime()) return false;
  const [code, by] = deferredBefore === null ? [null, BY] : ["card_expiry", CARD_EXPIRY];
  await recordEvent(query, { kind: "card", id, event: "expired", at: now, compartments: card.compartments, code, by });
  if (target !== null && effect === "opportunity") {
    const opportunity = await opportunityOf(query, target);
    const status = await latestOf(query, "opportunity", target);
    if (opportunity !== null && (status === "proposed" || status === "later")) {
      await recordEvent(query, {
        kind: "opportunity",
        id: target,
        event: "expired",
        at: now,
        compartments: opportunity.compartments,
        code,
        by,
      });
      await cancelIntentionsOf(query, target, now, by);
    }
  }
  if (target !== null && effect === "hypothesis") {
    const hypothesis = await hypothesisOf(query, target);
    const status = await latestOf(query, "hypothesis", target);
    if (hypothesis !== null && status !== null && LIVE_HYPOTHESIS_STATES.includes(status))
      await recordEvent(query, {
        kind: "hypothesis",
        id: target,
        event: "expired",
        at: now,
        compartments: hypothesis.compartments,
        code,
        by,
      });
  }
  await query("select ledger.admit_deferred($1)", [card.author]);
  return true;
}

// An opportunity 14 days after its `go` decision and not done, or 14 days after it was handed to
// the owner: `expired`, its lease dropped, its intentions cancelled, and its waiting outcome card
// withdrawn. Work that is `go` or `claimed` counts its days from the latest of its go, its latest
// progress and its latest check-back's due time (openSince).
async function expireOpportunity(query: Query, id: OpportunityId, now: Date): Promise<boolean> {
  const cards = await undecidedAbout(query, "opportunity", id);
  await lockRows(query, [id, ...cards.map((card) => card.id), ...cards.map((card) => authorWord(card.author))]);
  const opportunity = await opportunityOf(query, id);
  const state = await latestOf(query, "opportunity", id);
  if (opportunity === null || (state !== "go" && state !== "claimed" && state !== "handed_to_owner")) return false;
  const [since] = await query<{ at: Date | null }>(
    state === "handed_to_owner"
      ? "select max(at) as at from ledger.record_events where row_kind = 'opportunity' and row_id = $1 and event = 'handed_to_owner'"
      : `select ${openSince("$1")} as at`,
    [id],
  );
  if (since?.at == null || since.at.getTime() + OPEN_EXPIRY_DAYS * DAY_MS > now.getTime()) return false;
  await recordEvent(query, {
    kind: "opportunity",
    id,
    event: "expired",
    at: now,
    compartments: opportunity.compartments,
  });
  await closeWork(query, id, now);
  await withdraw(query, await undecidedAbout(query, "opportunity", id), now);
  return true;
}

// A run's lease past its time: back to the queue for its second attempt, or `failed` with
// `timeout` after it. False when the lease was renewed or the run ended meanwhile.
async function expireRunLease(query: Query, run: RunId, now: Date): Promise<boolean> {
  await lockRows(query, [run]);
  const [lease] = await query<{ lapsed: boolean; attempts: number }>(
    `select l.lease_until < $2 as lapsed, (select count(*)::int from ledger.run_attempts a where a.run_id = $1) as attempts
     from queue.leases l where l.resource_kind = 'run' and l.resource_id = $1`,
    [run, stamp(now)],
  );
  if (lease === undefined || !lease.lapsed) return false;
  const [ended] = await query<{ ok: boolean }>(
    "select ledger.end_run($1, $2, $3) as ok",
    lease.attempts < 2 ? [run, "queued", null] : [run, "failed", "timeout"],
  );
  return ended?.ok === true;
}

export async function endRun(query: Query, run: RunId, outcome: "failed" | "stopped", code: string): Promise<boolean> {
  await lockRows(query, [run]);
  const [ended] = await query<{ ok: boolean }>("select ledger.end_run($1, $2, $3) as ok", [run, outcome, code]);
  return ended?.ok === true;
}

// One item of tick step 3, written as its kind says.
export function expire(query: Query, item: Expired, now: Date): Promise<boolean> {
  switch (item.kind) {
    case "run_erasure":
      return endRun(query, item.run, "stopped", "erasure");
    case "run_lease":
      return expireRunLease(query, item.run, now);
    case "opportunity_lease":
      return returnToGo(query, item.opportunity, now);
    case "card":
      return expireCard(query, item.card, now);
    case "deferred_card":
      return expireCard(query, item.card, now, autonomyWindows(now).deferredBefore);
    case "opportunity":
      return expireOpportunity(query, item.opportunity, now);
    case "move_unreported":
      return failUnreported(query, item.move, now);
  }
}

// An unreported move whose planner's lease ended, closed `failed` with the code `abandoned` (the
// one code for it, as abandonMoves writes at a lease's lapse; this sweep catches a move whose lease
// was released or taken over), under the move's own label. False when it was reported, or its
// planner holds a live lease again, since it was read.
async function failUnreported(query: Query, move: MoveId, now: Date): Promise<boolean> {
  await lockRows(query, [move]);
  const [row] = await query<{ compartments: string[] }>(unreportedMoves(true), [stamp(now), move]);
  if (row === undefined) return false;
  await recordEvent(query, {
    kind: "move",
    id: move,
    event: "failed",
    at: now,
    compartments: row.compartments,
    code: ABANDONED,
  });
  return true;
}

export async function stopRuns(query: Query): Promise<number> {
  const runs = await query<{ id: RunId }>(
    `select x.id from ledger.runs x
     where (${latestEvent("run", "x.id")}) in ('queued', 'running')
     order by x.id collate "C"`,
  );
  await lockRows(
    query,
    runs.map((run) => run.id),
  );
  let stopped = 0;
  for (const run of runs) {
    const [ended] = await query<{ ok: boolean }>("select ledger.end_run($1, 'stopped', 'kill_switch') as ok", [run.id]);
    if (ended?.ok === true) stopped += 1;
  }
  return stopped;
}
