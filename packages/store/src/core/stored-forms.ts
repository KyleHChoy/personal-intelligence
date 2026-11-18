import type { Query } from "./db.ts";

// Forms one module writes into a column and another reads back by their shape, each stated once.
// Each is a stored value: it never changes, only where it is said.

// The judge of an owner's own check row in ledger.source_checks and of an owner's relation:
// `owner:<ruling>`.
export const ownerJudge = (ruling: string): string => `owner:${ruling}`;
export const IS_OWNER_JUDGE = "starts_with(judge, 'owner:')";

// A saved decision call's id: a point verdict's call_id holds one, or something else.
const DECISION_CALL_ID = "dcc";
export const DECISION_CALL_PREFIX = `${DECISION_CALL_ID}_`;

// The subject of a same-fact call: `facts:<a>:<b>`, two keyed fingerprints in the order given.
export const factsSubject = (a: string, b: string): string => `facts:${a}:${b}`;
// A where clause for a call whose subject names one of the fingerprints a subquery selects.
export const factsSubjectNames = (fps: string): string =>
  `starts_with(subject, 'facts:') and (split_part(subject, ':', 2) in (${fps}) or split_part(subject, ':', 3) in (${fps}))`;

// A Lens device's source accounts are labelled `device:<name>`.
export const deviceLabel = (name: string): string => `device:${name}`;
// The device's name in SQL, from an account row aliased `a`.
export const DEVICE_OF_ACCOUNT = "substr(a.label, 8)";

// Whose rechecks a statement's claim changes write: the triggers read this (ledger.trigger_cause), and
// raise nothing for a backfill. For the rest of the caller's transaction.
export const setTriggerCause = (query: Query, cause: "erasure" | "backfill"): Promise<unknown> =>
  query(`select set_config('pi.trigger_cause', '${cause}', true)`);

// Each goal's latest goal_target decision, whose `entity` and `named` say what it is after: what the
// goal state's rebuild reads, and what an erasure holds a goal state row to.
export const LATEST_GOAL_TARGET = `
    select distinct on (d.target_id) d.target_id, d.details ->> 'entity' as entity, d.details
    from knowledge.owner_decisions d
    where d.kind = 'goal_target' and d.target_kind = 'goal'
    order by d.target_id, d.decided_at desc, d.id collate "C" desc`;
