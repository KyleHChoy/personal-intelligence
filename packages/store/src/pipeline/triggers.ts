import { BeliefStatus } from "@intelligence/contracts";
import {
  BELIEF_TYPES,
  type BeliefRecord,
  CodedError,
  isCoded,
  isRestricted,
  type PersonalLogger,
  type TriggerPassSummary,
} from "@intelligence/contracts/personal";
import { type BeliefInputs, beliefsFor } from "@intelligence/personal-beliefs";
import { byText, canonicalJson } from "@intelligence/personal-core";
import { type Query, sqlstateOf, stamp, type Transaction } from "../core/db.ts";
import { fingerprint } from "../core/fingerprint.ts";
import type { Keys } from "../core/keys.ts";
import { labelKey, within } from "../core/labels.ts";
import { TRIGGER_BUCKET_OF, triggerBucketHold } from "../core/locks.ts";
import { ownerZoneOf } from "../core/zone.ts";
import { readBeliefInputsUnder } from "./belief-inputs.ts";
import { dueInterval, sortedAudience } from "./pipeline-beliefs.ts";
import { beliefState } from "./pipeline-write.ts";

// The most anchors a `belief_changed` run carries, the newest changes' first.
export const MAX_CHANGE_ANCHORS = 20;

// The trigger diff, in shadow: the after-commit diff, run by `pi extract` as
// pi_pipeline after each run and on a wake, and the work tick's clock, as pi_work, ids only. Nothing
// reads the trigger log for a wake or a notice: the reasoner's wakes stay the rebuild's offers, and
// `pia work report` compares the two (`triggerShadow`) until the wakes switch to the log.
//
// The diff takes the rechecks every change wrote in its own transaction, oldest first, by fact key,
// each key under its own advisory lock. For each active audience whose clearance holds a recheck's
// label (a clock recheck or a retry names its one clearance), in a savepoint of its own, it reads
// what a reader of that clearance is given (policy.belief_inputs_under, through
// readBeliefInputsUnder) and computes the belief with personal-beliefs' beliefsFor, as of the
// database's clock. The trigger log is append-only: its latest row of a key under a clearance is the
// last state, every lookup that clearance's alone, by the labels in use within it. A change raises
// when the new state differs from that last state; when the rechecks are exact (a claim of the same
// item on the same key standing for the one it replaced), it must also differ from the "before" (the
// inputs less what they added), so a commit never fires a change it did not make. With no last state
// and rechecks that are not exact, the state is a baseline that raises nothing; a difference of
// status alone that no claim, ruling or decision made is time's, and raises nothing. Clearances
// given equal inputs are computed once, in memory. Known limit: a pass's time grows with the whole
// backlog; it is a background job, never in a reply's path.

// How many rechecks one pass takes, oldest first; the rest wait for the next pass.
const RECHECKS_PER_PASS = 2000;
// How long one pass takes keys for: past it, the
// pass takes no further key and the rest wait for the next run, so the extract lock is never held
// for minutes. One key is always taken, so a pass always moves.
const PASS_BUDGET_MS = 30_000;
// After this many counted failures a clearance's retry is deleted and counted as dropped.
const KEY_FAILURES_MAX = 3;
// How many fact keys one seed transaction takes.
const SEED_KEYS_PER_PAGE = 200;
// The database's codes a failure retries without counting: a serialization failure, a deadlock,
// a lock not granted in time, a statement cancelled.
const RETRY_CODES: ReadonlySet<string> = new Set(["40001", "40P01", "55P03", "57014"]);

type RecheckRow = {
  id: string;
  fact_key_fp: string;
  clearance_key: string | null;
  cause: TriggerCause;
  exact: boolean;
  added_claims: string[];
  removed_claims: string[];
  removed_items: string[];
  added_rulings: string[];
  removed_rulings: string[];
  decisions: string[];
  confirmed_claims: string[];
  window_from: Date | null;
  window_to: Date | null;
  failures: number;
  compartments: string[];
};
type TriggerCause = "claim" | "ruling" | "erasure" | "backfill" | "due";
type Raise = "changed" | "due" | "none";
type Written = {
  stateFp: string;
  raise: Raise;
  cause: TriggerCause | "dropped";
  ended: boolean;
  anchors: string[];
  compartments: string[];
};
type Db = { query: Query; transaction<T>(fn: (query: Query) => Promise<T>, statements?: Transaction): Promise<T> };

// The labels in use within a clearance, and its own key, as policy.clearance_keys() names them
// with no cap. Neither pi_pipeline nor pi_work reads policy.labels, so
// the labels in use are the claims' (every trigger row's label is a claim's, a ruling's or a
// recheck's, and those are added), read once per pass or tick by `labelsInUse`.
export function labelsWithin(inUse: readonly string[], clearance: readonly string[]): string[] {
  return [...new Set([...inUse.filter((key) => key !== "" && within(key.split("|"), clearance)), labelKey(clearance)])];
}
const LABELS_IN_USE = "select distinct policy.label_key(compartments) as key from knowledge.claims";
async function labelsInUse(query: Query): Promise<string[]> {
  return (await query<{ key: string | null }>(LABELS_IN_USE)).flatMap((row) => (row.key === null ? [] : [row.key]));
}

// What a change compares: kind, subject, values, status and the disputed mark; a change of support alone (a
// duplicate, a corroboration, an echo) is none. A fact no longer built is absent. A due row's state is the due
// value alone.
export function stateOf(keys: Keys, row: BeliefRecord, status: string = row.belief.status): string {
  return fingerprint(keys, "belief_state", beliefState({ ...row.belief, status }));
}
const stateFp = (keys: Keys, row: BeliefRecord | undefined): string =>
  row === undefined ? fingerprint(keys, "belief_state", "absent") : stateOf(keys, row);
// Whether a state is this belief's with another status.
const statusOnly = (keys: Keys, last: string, row: BeliefRecord | undefined): boolean =>
  row !== undefined &&
  BeliefStatus.options.some((status) => status !== row.belief.status && stateOf(keys, row, status) === last);
const dueFp = (keys: Keys, due: string): string => fingerprint(keys, "belief_state", canonicalJson({ due }));
const DUE_CHECKED = (keys: Keys): string => fingerprint(keys, "belief_state", "due checked");
const DROPPED = (keys: Keys): string => fingerprint(keys, "belief_state", "dropped");
const endedOf = (row: BeliefRecord | undefined): boolean =>
  row === undefined || row.belief.status === "closed" || row.belief.status === "expired";
const names = (row: RecheckRow): boolean =>
  row.added_claims.length +
    row.removed_claims.length +
    row.added_rulings.length +
    row.removed_rulings.length +
    row.decisions.length +
    row.confirmed_claims.length >
  0;

// The row a fact key's belief is, its own or the joined row it is a member of.
const rowOf = (rows: readonly BeliefRecord[], factKeyFp: string): BeliefRecord | undefined =>
  rows.find((row) => row.factKeyFp === factKeyFp) ?? rows.find((row) => (row.members ?? []).includes(factKeyFp));

// The inputs as they were before the rechecks' additions: the claims and rulings they added left
// out, and a confirm undone (an agent's claim it made count left out, the owner's question no
// longer confirmed).
function without(
  keys: Keys,
  inputs: BeliefInputs,
  claims: ReadonlySet<string>,
  rulings: ReadonlySet<string>,
  confirmed: ReadonlySet<string>,
): BeliefInputs {
  const kept = (id: string): boolean => !rulings.has(id);
  return {
    ...inputs,
    groups: inputs.groups.map((group) => ({
      ...group,
      claims: group.claims.flatMap((one) => {
        const id = fingerprint(keys, "claim", one.claim.id);
        if (claims.has(id) || (confirmed.has(id) && one.origin === "agent_record")) return [];
        const { ownerConfirmed: _confirmed, ...unconfirmed } = one;
        const base = confirmed.has(id) ? unconfirmed : one;
        return [base.carried === undefined ? base : { ...base, carried: base.carried.filter(kept) }];
      }),
    })),
    decisions: inputs.decisions.filter((one) => kept(one.id)),
    retirements: inputs.retirements.filter((one) => kept(one.id)),
    reclassifications: inputs.reclassifications.filter((one) => kept(one.id)),
    factRulings: (inputs.factRulings ?? []).filter((one) => kept(one.id)),
  };
}

// Whether a change raises. The recheck's cause decides liveness: a backfill change raises
// nothing whatever the provenance; an owner's ruling or card answer raises, even when
// the claim it moves came from backfill; a claim's change raises when its deciding claim
// is live, or re-derived and resting on the owner's word. A fact no longer built raises nothing.
export function raiseOf(row: BeliefRecord | undefined, cause: TriggerCause): Raise {
  if (row === undefined || cause === "backfill") return "none";
  if (cause === "ruling") return "changed";
  if (row.belief.changeKind === "live") return "changed";
  if (row.belief.changeKind === "backfill") return "none";
  return row.provenance === "owner" || row.provenance === "agent_reported" ? "changed" : "none";
}

// The strongest cause of a set: an owner's ruling, then a live one, over a backfill.
const causeOf = (rows: readonly RecheckRow[]): TriggerCause =>
  rows.find((row) => row.cause === "ruling")?.cause ??
  rows.find((row) => row.cause !== "backfill")?.cause ??
  "backfill";

// The last state of a key under one clearance: that clearance's latest row, a due row or a
// dropped retry's count aside.
export const LAST_STATE = `
  select state_fp from ledger.trigger_log
  where policy.label_key(compartments) = any ($1::text[]) and clearance_key = $3 and fact_key_fp = $2 and cause not in ('due', 'dropped')
  order by id desc limit 1`;
// Whether this due value was raised for the key under one clearance since its last ended state:
// a reopened commitment raises its due again.
const DUE_SEEN = `
  select 1 from ledger.trigger_log t
  where policy.label_key(t.compartments) = any ($1::text[]) and t.clearance_key = $3 and t.fact_key_fp = $2 and t.cause = 'due' and t.state_fp = $4
    and t.id > coalesce((select max(e.id) from ledger.trigger_log e
                         where policy.label_key(e.compartments) = any ($1::text[]) and e.clearance_key = $3 and e.fact_key_fp = $2 and e.ended and e.cause not in ('due', 'dropped')), 0)
  limit 1`;
// The anchors of a wake: the entities of the belief's own support, at most the fold's cap.
const ANCHORS = `
  select distinct entity_id from knowledge.claim_entities
  where policy.label_key(compartments) = any ($1::text[]) and claim_id = any ($2::text[])
  order by entity_id limit $3`;

const WRITE = `
  insert into ledger.trigger_log (fact_key_fp, clearance_key, state_fp, raise, cause, ended, anchors, compartments, raised_at)
  values ($1, $2, $3, $4::text, $5, $6, $7, $8, case when $4::text = 'none' then now() end) returning id`;

const RETRY = `
  insert into ledger.trigger_rechecks (fact_key_fp, clearance_key, cause, exact, added_claims, removed_claims, removed_items, added_rulings, removed_rulings, decisions,
    confirmed_claims, window_from, window_to, failures, compartments)
  values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
  on conflict do nothing`;

const union = (rows: readonly RecheckRow[], pick: (row: RecheckRow) => string[]): string[] =>
  [...new Set(rows.flatMap(pick))].sort();

type Context = {
  query: Query;
  keys: Keys;
  factKeyFp: string;
  at: string;
  inUse: readonly string[];
  compute: (inputs: BeliefInputs, clearance: readonly string[]) => BeliefRecord | undefined;
  zone: () => Promise<string | null>;
  // The seed writes the current state of every clearance as backfill, raising nothing.
  seed: boolean;
};

// What one clearance's diff reads under: the context's handles and ids, and the clearance's labels.
type Scope = Readonly<Context & { clearance: readonly string[]; clearanceKey: string; labels: readonly string[] }>;

// The last state this clearance recorded for the key: one query each call.
async function lastStateOf(scope: Scope): Promise<string | undefined> {
  const rows = await scope.query<{ state_fp: string }>(LAST_STATE, [scope.labels, scope.factKeyFp, scope.clearanceKey]);
  return rows[0]?.state_fp;
}

// One clearance's rows, in the caller's transaction: under the seed, the current state as
// backfill; otherwise the row a change raises and the row a clock recheck raises.
async function diffClearance(
  ctx: Context,
  clearance: readonly string[],
  relevant: readonly RecheckRow[],
): Promise<Written[]> {
  const labels = [
    ...new Set([...labelsWithin(ctx.inUse, clearance), ...relevant.map((row) => labelKey(row.compartments))]),
  ];
  const scope: Scope = { ...ctx, clearance, clearanceKey: labelKey(clearance), labels };
  // A key a backfill alone touched, of which this clearance has no state, has none to keep: a
  // re-derive's every key, a generation raise's (this clearance's rows decide it). The seed
  // writes it.
  if (!ctx.seed && relevant.every((row) => row.cause === "backfill") && (await lastStateOf(scope)) === undefined)
    return [];
  const inputs = await readBeliefInputsUnder(ctx.query, ctx.keys, clearance, [ctx.factKeyFp], ctx.at);
  const after = ctx.compute(inputs, clearance);
  if (ctx.seed) {
    const last = await lastStateOf(scope);
    const changed = after !== undefined && last !== stateFp(ctx.keys, after);
    return changed ? [stateRow(ctx.keys, after, [], { raise: "none", cause: "backfill", anchors: [] })] : [];
  }
  const out: Written[] = [];
  const changes = relevant.filter((row) => row.cause !== "due");
  if (changes.length > 0) {
    const raise = raiseForChange(scope, inputs, after, await lastStateOf(scope), changes);
    if (raise !== undefined) {
      // A change's anchors: the entities its belief's support names.
      const fps = after?.belief.support.map((claim) => fingerprint(ctx.keys, "claim", claim));
      const anchors =
        raise !== "changed" || fps === undefined
          ? []
          : (await ctx.query<{ entity_id: string }>(ANCHORS, [labels, fps, MAX_CHANGE_ANCHORS])).map(
              (r) => r.entity_id,
            );
      out.push(stateRow(ctx.keys, after, changes, { raise, cause: causeOf(changes), anchors }));
    }
  }
  const asked = relevant.filter((row) => row.cause === "due" && row.window_from !== null && row.window_to !== null);
  if (asked.length > 0) out.push(await dueRow(scope, after, asked));
  return out;
}

// The row recording a belief's state. Its compartments are the belief's or, with no belief, those
// of the rechecks that asked.
function stateRow(
  keys: Keys,
  after: BeliefRecord | undefined,
  rechecks: readonly RecheckRow[],
  row: Pick<Written, "raise" | "cause" | "anchors">,
): Written {
  const compartments = after?.compartments ?? sortedAudience([...new Set(rechecks.flatMap((row) => row.compartments))]);
  return { stateFp: stateFp(keys, after), ...row, ended: endedOf(after), compartments };
}

// What a change raises, if anything: against the state before it when the change is exact, else the last.
export function raiseForChange(
  rules: Pick<Scope, "keys" | "compute" | "clearance">,
  inputs: BeliefInputs,
  after: BeliefRecord | undefined,
  last: string | undefined,
  changes: readonly RecheckRow[],
): Raise | undefined {
  const { keys } = rules;
  const afterFp = stateFp(keys, after);
  const cause = causeOf(changes);
  const exact = exactness(keys, inputs, changes);
  if (exact !== undefined) {
    const rulings = new Set(changes.flatMap((one) => one.added_rulings));
    const confirmed = new Set(changes.flatMap((one) => one.confirmed_claims));
    const before = rules.compute(without(keys, inputs, exact.excluded, rulings, confirmed), rules.clearance);
    if (stateFp(keys, before) !== afterFp && afterFp !== last) return raiseOf(after, cause);
    // A replacement's own "before" is gone with the claim it replaced: its new state is recorded,
    // raising nothing, so the last state stays the current one. A known limit: a re-extraction
    // that reads the same item differently is not raised.
    return exact.replaced > 0 && afterFp !== last ? "none" : undefined;
  }
  // An unknown before is no change: the state is the baseline, and raises nothing.
  if (last === undefined) return after === undefined ? undefined : "none";
  if (last === afterFp) return undefined;
  // A difference of status alone that no claim, ruling or decision named is time's: backfill.
  return !changes.some(names) && statusOnly(keys, last, after) ? "none" : raiseOf(after, cause);
}

// Whether a change is exact and, if so, the added claims to leave out of the state before it: its
// recheck says so, or it only removed claims whose items were all re-extracted, with no ruling,
// decision or confirmation alongside. A claim of the same item on the same key, added in the same
// commit, stands for the one removed (a re-extraction), so it is not left out.
function exactness(keys: Keys, inputs: BeliefInputs, changes: readonly RecheckRow[]) {
  const removedItems = new Set(changes.flatMap((one) => one.removed_items));
  const added = new Set(changes.flatMap((one) => one.added_claims));
  const replacing = inputs.groups
    .flatMap((group) => group.claims)
    .filter(
      (one) => removedItems.has(one.claim.primaryEvidenceId) && added.has(fingerprint(keys, "claim", one.claim.id)),
    );
  const replacedItems = new Set(replacing.map((one) => one.claim.primaryEvidenceId as string));
  const replaced = new Set(replacing.map((one) => fingerprint(keys, "claim", one.claim.id)));
  const exact = changes.every(
    (one) =>
      one.exact ||
      (one.removed_claims.length > 0 &&
        one.removed_items.every((item) => replacedItems.has(item)) &&
        one.added_rulings.length + one.removed_rulings.length + one.decisions.length + one.confirmed_claims.length ===
          0),
  );
  if (!exact) return undefined;
  return { excluded: new Set([...added].filter((id) => !replaced.has(id))), replaced: replaced.size };
}

// A clock recheck. An open commitment, live, whose own due value read in the owner's zone falls in
// the window the tick asked about raises its due once since its last ended state. Otherwise its
// check is noted, so the clock asks about a key once a day at most.
async function dueRow(scope: Scope, after: BeliefRecord | undefined, asked: readonly RecheckRow[]): Promise<Written> {
  const belief = after?.belief;
  const due = belief?.values.due;
  const openLive =
    belief?.kind === "commitment" &&
    belief.changeKind === "live" &&
    (belief.status === "active" || belief.status === "stale");
  if (after !== undefined && openLive && typeof due === "string") {
    const interval = dueInterval(due, await scope.zone());
    const from = Math.min(...asked.map((row) => (row.window_from as Date).getTime()));
    const to = Math.max(...asked.map((row) => (row.window_to as Date).getTime()));
    const fp = dueFp(scope.keys, due);
    const overlaps = interval !== null && Date.parse(interval[1]) > from && Date.parse(interval[0]) < to;
    const seen =
      overlaps && (await scope.query(DUE_SEEN, [scope.labels, scope.factKeyFp, scope.clearanceKey, fp])).length > 0;
    if (overlaps && !seen)
      return {
        ...stateRow(scope.keys, after, asked, { raise: "due", cause: "due", anchors: [] }),
        stateFp: fp,
        ended: false,
      };
  }
  const checked = stateRow(scope.keys, after, asked, { raise: "none", cause: "due", anchors: [] });
  return { ...checked, stateFp: DUE_CHECKED(scope.keys), ended: false };
}

// The key locks: 256 buckets, a fact
// key's `hashtext(fact_key_fp) & 255`, under the two-key advisory lock of TRIGGER_KEY, taken by
// the pass, the claims' delete trigger, the deferred trigger and the erasure's hook alike, several
// always in ascending order. The pass holds one bucket at a time, as a session lock taken before
// its transaction begins, so its repeatable-read snapshot is taken only once the lock is granted
// and follows every deletion that held it (invariant 10).
const BUCKETS = `select k as fact_key_fp, ${TRIGGER_BUCKET_OF} as bucket from unnest($1::text[]) as k`;
async function bucketsOf(query: Query, factKeyFps: readonly string[]): Promise<Map<string, number>> {
  return new Map(
    (await query<{ fact_key_fp: string; bucket: number }>(BUCKETS, [[...factKeyFps]])).map((row) => [
      row.fact_key_fp,
      row.bucket,
    ]),
  );
}
const keyTransaction = (bucket: number | undefined): Transaction => {
  if (bucket === undefined || !Number.isInteger(bucket) || bucket < 0 || bucket > 255)
    throw new CodedError("unavailable");
  return {
    begin: "begin isolation level repeatable read",
    commit: "commit",
    rollback: "rollback",
    hold: triggerBucketHold(bucket),
  };
};
const codeOf = (error: unknown): string => {
  const code = isCoded(error) ? error.code : undefined;
  return typeof code === "string" ? code : "unavailable";
};

// One fact key's transaction, at repeatable read, begun under the key's bucket lock: each clearance
// in a savepoint of its own; its rows written; its rechecks deleted; a failed clearance's retry
// written.
async function passKey(
  query: Query,
  keys: Keys,
  log: PersonalLogger,
  factKeyFp: string,
  rechecks: readonly RecheckRow[],
  audiences: readonly string[][],
  inUse: readonly string[],
  options: { grouped: boolean; seed: boolean },
): Promise<{ n: number; raised: number; failed: number }> {
  // The database's clock, rounded up to the millisecond a Timestamp holds, so every claim
  // committed before this read is within the inputs (belief_inputs_under: first_known_at <= as_of,
  // and a claim's first_known_at is never later than its created_at).
  const [clock] = await query<{ at: Date }>(
    "select date_trunc('milliseconds', clock_timestamp()) + interval '1 millisecond' as at",
  );
  const at = stamp(clock?.at ?? new Date());
  const computed = new Map<string, BeliefRecord | undefined>();
  const compute = (inputs: BeliefInputs, clearance: readonly string[]): BeliefRecord | undefined => {
    const memo = options.grouped ? JSON.stringify(inputs) : undefined;
    if (memo !== undefined && computed.has(memo)) return computed.get(memo);
    const row = rowOf(beliefsFor(inputs, clearance, at, [factKeyFp]).rows, factKeyFp);
    if (memo !== undefined) computed.set(memo, row);
    return row;
  };
  let zone: string | null | undefined;
  const ctx: Context = {
    query,
    keys,
    factKeyFp,
    at,
    inUse,
    compute,
    zone: async () => (zone === undefined ? (zone = await ownerZoneOf(query)) : zone),
    seed: options.seed,
  };
  const counts = { n: 0, raised: 0, failed: 0 };
  const retries: unknown[][] = [];
  for (const clearance of audiences) {
    const clearanceKey = labelKey(clearance);
    const relevant = rechecks.filter((row) =>
      row.clearance_key === null ? within(row.compartments, clearance) : row.clearance_key === clearanceKey,
    );
    if (relevant.length === 0) continue;
    await query("savepoint clearance");
    try {
      for (const one of await diffClearance(ctx, clearance, relevant)) {
        await query(WRITE, [
          factKeyFp,
          clearanceKey,
          one.stateFp,
          one.raise,
          one.cause,
          one.ended,
          one.anchors,
          one.compartments,
        ]);
        counts.n += 1;
        if (one.raise !== "none") counts.raised += 1;
      }
      await query("release savepoint clearance");
    } catch (error) {
      await query("rollback to savepoint clearance");
      counts.failed += 1;
      const counted = !RETRY_CODES.has(sqlstateOf(error) ?? "");
      // One retry for this clearance alone, of its changes and of its clock rechecks apart.
      for (const part of [
        relevant.filter((row) => row.cause !== "due"),
        relevant.filter((row) => row.cause === "due"),
      ]) {
        if (part.length === 0 || options.seed) continue;
        const failures = Math.max(...part.map((row) => row.failures)) + (counted ? 1 : 0);
        const compartments = sortedAudience([...new Set(part.flatMap((row) => row.compartments))]);
        if (failures >= KEY_FAILURES_MAX) {
          await query(WRITE, [factKeyFp, clearanceKey, DROPPED(keys), "none", "dropped", false, [], compartments]);
          log.warn({ event: "trigger_recheck_dropped", code: "too_many_failures", counts: { failures } });
          continue;
        }
        const windows = part.flatMap((row) =>
          row.window_from === null || row.window_to === null
            ? []
            : [[row.window_from.getTime(), row.window_to.getTime()]],
        );
        retries.push([
          factKeyFp,
          clearanceKey,
          part[0]?.cause === "due" ? "due" : causeOf(part),
          part.every((row) => row.exact),
          union(part, (row) => row.added_claims),
          union(part, (row) => row.removed_claims),
          union(part, (row) => row.removed_items),
          union(part, (row) => row.added_rulings),
          union(part, (row) => row.removed_rulings),
          union(part, (row) => row.decisions),
          union(part, (row) => row.confirmed_claims),
          windows.length === 0 ? null : new Date(Math.min(...windows.map((one) => one[0] as number))),
          windows.length === 0 ? null : new Date(Math.max(...windows.map((one) => one[1] as number))),
          failures,
          compartments,
        ]);
        log.warn({ event: "trigger_key_failed", code: counted ? "unavailable" : "retry", counts: { failures } });
      }
    }
  }
  // The consumed rechecks first, so a retry of a clock recheck takes its day's place.
  await query("delete from ledger.trigger_rechecks where id = any ($1::bigint[])", [
    rechecks.flatMap((row) => (row.id === "" ? [] : [row.id])),
  ]);
  for (const values of retries) await query(RETRY, values);
  return counts;
}

const RECHECK_COLUMNS = `id::text as id, fact_key_fp, clearance_key, cause, exact, added_claims, removed_claims, removed_items, added_rulings, removed_rulings, decisions,
  confirmed_claims, window_from, window_to, failures, compartments`;

// The active audiences, in label key order, so the rows of one key are written in one order.
async function audiencesOf(db: Db): Promise<string[][]> {
  return (await db.query<{ audience: string[] }>("select a as audience from policy.audiences() a"))
    .map((row) => sortedAudience(row.audience))
    .sort((a, b) => byText(labelKey(a), labelKey(b)));
}

// One pass: the pending rechecks, oldest first, up to the cap, by fact key, each key in a
// transaction of its own. `ids` narrows the pass to those rechecks (the tests' way of taking a
// recheck read before another commit). A key whose transaction fails as a whole keeps its rechecks
// when the database asks for a retry, and otherwise each is written again with one more failure,
// deleted and counted as dropped after the third.
export async function triggerPass(
  db: Db,
  keys: Keys,
  log: PersonalLogger,
  options: { ids?: readonly string[]; grouped?: boolean; budgetMs?: number } = {},
): Promise<TriggerPassSummary> {
  const started = Date.now();
  const rows = await db.query<RecheckRow>(
    `select ${RECHECK_COLUMNS} from ledger.trigger_rechecks where ($2::bigint[] is null or id = any ($2::bigint[])) order by id limit $1`,
    [RECHECKS_PER_PASS, options.ids === undefined ? null : [...options.ids]],
  );
  const summary: TriggerPassSummary = { keys: 0, rechecks: rows.length, written: 0, raised: 0, failed: 0, ms: 0 };
  if (rows.length === 0) return summary;
  const audiences = await audiencesOf(db);
  const inUse = await labelsInUse(db.query);
  const byKey = new Map<string, RecheckRow[]>();
  for (const row of rows) byKey.set(row.fact_key_fp, [...(byKey.get(row.fact_key_fp) ?? []), row]);
  const buckets = await bucketsOf(db.query, [...byKey.keys()]);
  const budget = options.budgetMs ?? PASS_BUDGET_MS;
  let taken = 0;
  for (const [factKeyFp, rechecks] of byKey) {
    if (taken > 0 && Date.now() - started >= budget) {
      log.info({ event: "trigger_pass_cut", counts: { keys_left: byKey.size - taken } });
      break;
    }
    taken += 1;
    try {
      const written = await db.transaction(
        (query) =>
          passKey(query, keys, log, factKeyFp, rechecks, audiences, inUse, {
            grouped: options.grouped !== false,
            seed: false,
          }),
        keyTransaction(buckets.get(factKeyFp)),
      );
      summary.keys += 1;
      summary.written += written.n;
      summary.raised += written.raised;
      summary.failed += written.failed;
    } catch (error) {
      summary.failed += 1;
      if (RETRY_CODES.has(sqlstateOf(error) ?? "")) {
        log.warn({ event: "trigger_key_failed", code: "retry", counts: { rechecks: rechecks.length } });
        continue;
      }
      await db.transaction(async (query) => {
        const gone = await query<RecheckRow>(
          `delete from ledger.trigger_rechecks where id = any ($1::bigint[]) returning ${RECHECK_COLUMNS}`,
          [rechecks.map((row) => row.id)],
        );
        for (const one of gone) {
          if (one.failures + 1 >= KEY_FAILURES_MAX) {
            await query(WRITE, [
              one.fact_key_fp,
              one.clearance_key ?? "all",
              DROPPED(keys),
              "none",
              "dropped",
              false,
              [],
              one.compartments,
            ]);
            log.warn({
              event: "trigger_recheck_dropped",
              code: "too_many_failures",
              counts: { failures: one.failures + 1 },
            });
            continue;
          }
          await query(RETRY, [
            one.fact_key_fp,
            one.clearance_key,
            one.cause,
            one.exact,
            one.added_claims,
            one.removed_claims,
            one.removed_items,
            one.added_rulings,
            one.removed_rulings,
            one.decisions,
            one.confirmed_claims,
            one.window_from,
            one.window_to,
            one.failures + 1,
            one.compartments,
          ]);
        }
      });
      log.warn({ event: "trigger_key_failed", code: "unavailable", counts: { rechecks: rechecks.length } });
    }
  }
  summary.ms = Math.max(0, Date.now() - started);
  log.info({
    event: "trigger_pass",
    counts: {
      keys: summary.keys,
      rechecks: summary.rechecks,
      written: summary.written,
      raised: summary.raised,
      failed: summary.failed,
      ms: summary.ms,
    },
  });
  return summary;
}

// `pia triggers seed`: the current state of every fact key of a belief's type under every active
// clearance that holds one of its labels, written through the pass's own code as backfill: a
// baseline, raising nothing. Idempotent: a state equal to the last one writes nothing. Run once
// after a deploy and after a generation raise. Ids and counts only.
export type TriggerSeedSummary = { keys: number; written: number; failed: number; ms: number };
export async function triggerSeed(db: Db, keys: Keys, log: PersonalLogger): Promise<TriggerSeedSummary> {
  const started = Date.now();
  const audiences = await audiencesOf(db);
  const inUse = await labelsInUse(db.query);
  const summary: TriggerSeedSummary = { keys: 0, written: 0, failed: 0, ms: 0 };
  let after = "";
  for (;;) {
    const page = await db.query<{ fact_key_fp: string; labels: string[] }>(
      `select fact_key_fp, array_agg(distinct policy.label_key(compartments)) as labels from knowledge.claims
       where type = any ($1::text[]) and fact_key_fp > $2 and not policy.is_restricted(compartments)
       group by fact_key_fp order by fact_key_fp limit $3`,
      [[...BELIEF_TYPES], after, SEED_KEYS_PER_PAGE],
    );
    if (page.length === 0) break;
    const buckets = await bucketsOf(
      db.query,
      page.map((key) => key.fact_key_fp),
    );
    for (const key of page) {
      const rechecks: RecheckRow[] = key.labels.map((label) => ({
        id: "",
        fact_key_fp: key.fact_key_fp,
        clearance_key: null,
        cause: "backfill",
        exact: false,
        added_claims: [],
        removed_claims: [],
        removed_items: [],
        added_rulings: [],
        removed_rulings: [],
        decisions: [],
        confirmed_claims: [],
        window_from: null,
        window_to: null,
        failures: 0,
        compartments: label.split("|"),
      }));
      try {
        const written = await db.transaction(
          (query) =>
            passKey(query, keys, log, key.fact_key_fp, rechecks, audiences, inUse, { grouped: true, seed: true }),
          keyTransaction(buckets.get(key.fact_key_fp)),
        );
        summary.keys += 1;
        summary.written += written.n;
        summary.failed += written.failed;
      } catch (error) {
        summary.failed += 1;
        log.warn({ event: "trigger_seed_key_failed", code: codeOf(error) });
      }
    }
    after = page[page.length - 1]?.fact_key_fp ?? after;
  }
  summary.ms = Math.max(0, Date.now() - started);
  log.info({
    event: "trigger_seed",
    counts: { keys: summary.keys, written: summary.written, failed: summary.failed, ms: summary.ms },
  });
  return summary;
}

// The work tick's side, as pi_work, ids only.

// The clock: for each active client's clearance that holds no restricted compartment,
// every key of a commitment it can see whose claim's due date lies near the look-ahead (the diff reads
// the belief's own due value in the owner's zone and decides), as one recheck naming the clearance and
// the window, unless that clearance's last state of the key is closed or ended, its latest row is a
// due raise (raised for its current due value, nothing since), or a due row of today is logged since
// its last state (a raise or a check); one pending a key, clearance and UTC day at most (a unique
// index; the insert names no conflict target, which would need a select pi_work does not hold).
// Restricted-blind (pi_work's policies). pi_work inserts and never reads the rechecks (no grant).
export const DUE_RECHECKS = `
  insert into ledger.trigger_rechecks (fact_key_fp, clearance_key, cause, exact, window_from, window_to, compartments)
  select distinct on (c.fact_key_fp) c.fact_key_fp, $2, 'due', false, $3::timestamptz, $3::timestamptz + make_interval(hours => s.calendar_lead_hours), c.compartments
  from knowledge.claims c cross join policy.work_settings s
  where policy.label_key(c.compartments) = any ($1::text[]) and c.type = 'commitment'
    and c.due_at > $3::timestamptz - interval '2 days' and c.due_at < $3::timestamptz + make_interval(hours => s.calendar_lead_hours) + interval '1 day'
    and not coalesce((select t.ended from ledger.trigger_log t
                      where policy.label_key(t.compartments) = any ($1::text[]) and t.clearance_key = $2 and t.fact_key_fp = c.fact_key_fp and t.cause not in ('due', 'dropped')
                      order by t.id desc limit 1), false)
    and coalesce((select t.raise from ledger.trigger_log t
                  where policy.label_key(t.compartments) = any ($1::text[]) and t.clearance_key = $2 and t.fact_key_fp = c.fact_key_fp and t.cause <> 'dropped'
                  order by t.id desc limit 1), 'none') <> 'due'
    and not exists (select 1 from ledger.trigger_log t
                    where policy.label_key(t.compartments) = any ($1::text[]) and t.clearance_key = $2 and t.fact_key_fp = c.fact_key_fp and t.cause = 'due'
                      and t.written_at >= date_trunc('day', $3::timestamptz at time zone 'UTC') at time zone 'UTC'
                      and t.id > coalesce((select max(e.id) from ledger.trigger_log e
                                           where policy.label_key(e.compartments) = any ($1::text[]) and e.clearance_key = $2 and e.fact_key_fp = c.fact_key_fp
                                             and e.cause not in ('due', 'dropped')), 0))
  order by c.fact_key_fp, c.id
  on conflict do nothing`;

export async function clockRechecks(query: Query, now: Date): Promise<void> {
  const clients = await query<{ compartments: string[] }>(
    "select compartments from policy.clients where status = 'active' and kind in ('agent', 'reasoner') order by id",
  );
  const inUse = await labelsInUse(query);
  const seen = new Set<string>();
  for (const client of clients) {
    const key = labelKey(client.compartments);
    // Never a restricted clearance: there is no restricted pass.
    if (seen.has(key) || client.compartments.some(isRestricted)) continue;
    seen.add(key);
    await query(DUE_RECHECKS, [labelsWithin(inUse, client.compartments), key, stamp(now)]);
  }
}

// The rows not yet raised, oldest first, and their raised mark, counted by raise and cause: in
// shadow, nothing is raised from them; the counts are the shadow's. An outcome's row is not the
// shadow's: the tick's outcome step raises it (dispatch-outcomes.ts).
export const OUTCOME_RAISE = "outcome";
export type RaisedTriggers = { marked: number; byRaise: Record<string, number>; byCause: Record<string, number> };
export async function raiseTriggers(query: Query, now: Date): Promise<RaisedTriggers> {
  const rows = await query<{ id: string; raise: string; cause: string }>(
    `select id::text as id, raise, cause from ledger.trigger_log where raised_at is null and raise <> '${OUTCOME_RAISE}' order by id limit 1000`,
  );
  const counted: RaisedTriggers = { marked: 0, byRaise: {}, byCause: {} };
  if (rows.length === 0) return counted;
  for (const row of rows) {
    counted.byRaise[row.raise] = (counted.byRaise[row.raise] ?? 0) + 1;
    counted.byCause[row.cause] = (counted.byCause[row.cause] ?? 0) + 1;
  }
  counted.marked = (
    await query(
      "update ledger.trigger_log set raised_at = $2 where id = any ($1::bigint[]) and raised_at is null returning id",
      [rows.map((row) => row.id), stamp(now)],
    )
  ).length;
  return counted;
}

// `pia work report`'s counts: trigger rows written in the window, by cause and raise (a retry
// dropped after its third counted failure is `dropped_none`), and the rechecks still owed. Counts
// only. The shadow against the rebuild's wake offers went with the offers.
export type TriggerCounts = {
  written: Record<string, number>;
  pending: number;
  dropped: number;
};
export async function triggerCounts(query: Query, since: Date): Promise<TriggerCounts> {
  const rows = await query<{ cause: string; raise: string; n: number }>(
    "select cause, raise, count(*)::int as n from ledger.trigger_log where written_at >= $1 group by cause, raise order by 1, 2",
    [stamp(since)],
  );
  const [owed] = await query<{ n: number }>("select count(*)::int as n from ledger.trigger_rechecks");
  return {
    written: Object.fromEntries(rows.map((row) => [`${row.cause}_${row.raise}`, row.n])),
    pending: owed?.n ?? 0,
    dropped: rows.filter((row) => row.cause === "dropped").reduce((sum, row) => sum + row.n, 0),
  };
}
