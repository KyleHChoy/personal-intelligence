// Every advisory lock the store takes by name, once, with what it is taken as.
//
// A lock that waits can deadlock. A try lock answers at once, so it may come anywhere; a path that
// holds more than one still states why where it takes them. Row locks come before these, and
// ledger.lock_rows after the beliefs and grants locks.

const key = (name: string): string => `hashtext('intelligence personal ${name}')`;

const SYNC_KEY = key("sync");
const EXTRACT_KEY = key("extract");
const WORK_KEY = key("work");
const TAINT_KEY = key("ledger taint");
const TRIGGER_KEY = key("trigger");

// Held for the transaction.
export const TRY_SYNC = `select pg_try_advisory_xact_lock(${SYNC_KEY}) as held`;
export const TRY_EXTRACT = `select pg_try_advisory_xact_lock(${EXTRACT_KEY}) as held`;
export const TAINT_SHARED = `select pg_advisory_xact_lock_shared(${TAINT_KEY})`;
export const TAINT_ALONE = `select pg_advisory_xact_lock(${TAINT_KEY})`;
export const BELIEFS_LOCK = `select pg_advisory_xact_lock(${key("beliefs")})`;
export const GRANTS_LOCK = `select pg_advisory_xact_lock(${key("release grants")})`;
export const REVIEW_LOCK = `select pg_advisory_xact_lock(${key("review")})`;
export const NAME_HOLDS_LOCK = `select pg_advisory_xact_lock(${key("name holds")})`;
export const CAPTURE_ACCOUNTS_LOCK = `select pg_advisory_xact_lock(${key("capture accounts")})`;
// One project's anchor by its fingerprint, $1.
export const ANCHOR_LOCK = "select pg_advisory_xact_lock(hashtext('intelligence personal anchor ' || $1))";
// The current client's own, as the row of its id and compartments: one sync of its memory, one of
// its mirror.
export const MEMORY_CLIENT =
  "select id, compartments, pg_advisory_xact_lock(hashtextextended('memory:' || id, 0)) from policy.current_client()";
export const MIRROR_CLIENT =
  "select id, compartments, pg_advisory_xact_lock(hashtextextended('mirror:' || id, 0)) from policy.current_client()";

// Held for a session, and given back.
const session = (lock: string): { try: string; give: string } => ({
  try: `select pg_try_advisory_lock(${lock}) as held`,
  give: `select pg_advisory_unlock(${lock})`,
});
export const SYNC_SESSION = session(SYNC_KEY);
export const EXTRACT_SESSION = session(EXTRACT_KEY);
export const WORK_SESSION = session(WORK_KEY);
// The dream pass's own: one pass at a time, whatever starts it.
export const DREAM_PASS_SESSION = session(key("dream pass"));
// One gap pass at a time, the tick's or the pipeline's warmth lanes': each reads a label's supply
// and raises against its daily cap, so two at once could both spend its last room. Waited for.
export const GAP_PASS_HOLD = {
  take: `select pg_advisory_lock(${key("gap pass")})`,
  give: `select pg_advisory_unlock(${key("gap pass")})`,
};
// A reader's whole call, under the shared taint lock.
export const TAINT_HOLD = {
  take: `select pg_advisory_lock_shared(${TAINT_KEY})`,
  give: `select pg_advisory_unlock_shared(${TAINT_KEY})`,
};
export const MIGRATE_LOCK = `select pg_advisory_lock(${key("migrate")})`;
export const ROLES_LOCK = `select pg_advisory_lock(${key("roles")})`;

// The trigger pass's buckets: which of 256 a fact key falls in, and the two-key lock on one. The
// pass and the erasure's `triggers` hook must agree on both, or the erasure's deadlock safety goes.
export const TRIGGER_BUCKET_OF = "hashtext(k) & 255";
export const triggerBucketHold = (bucket: number): { take: string; give: string } => ({
  take: `select pg_advisory_lock(${TRIGGER_KEY}, ${bucket})`,
  give: `select pg_advisory_unlock(${TRIGGER_KEY}, ${bucket})`,
});
export const TRIGGER_BUCKET_LOCK = `select pg_advisory_xact_lock(${TRIGGER_KEY}, $1::int)`;

// The order the locks that wait are taken in, in one transaction.
export const LOCK_ORDER = ["BELIEFS_LOCK", "GRANTS_LOCK", "NAME_HOLDS_LOCK", "TAINT_ALONE"] as const;

// The words ledger.lock_rows locks: an author's pending count and a case's one undecided card.
// Whoever locks before raising a card must lock what `raiseCard` needs.
export const authorWord = (author: string): string => `author:${author}`;
export const caseWord = (caseKey: string): string => `case:${caseKey}`;
// The case of an outcome card on one piece of work.
export const outcomeCase = (work: string): string => `outcome:${work}`;
// The owner's tier rulings, taken by `pia people tier`, its card and the tier proposer.
export const TIER_LOCK = "warmth:tier";

// The names database functions hold alone, which no TypeScript takes.
const LOCKS_IN_SQL_ONLY = ["changes", "typed claim", "oauth registrations"];

// Every name above, for the test that holds this file and the functions equal.
export const LOCK_NAMES = [
  "sync",
  "extract",
  "work",
  "ledger taint",
  "trigger",
  "beliefs",
  "release grants",
  "review",
  "name holds",
  "capture accounts",
  "migrate",
  "roles",
  "dream pass",
  "gap pass",
  ...LOCKS_IN_SQL_ONLY,
];
