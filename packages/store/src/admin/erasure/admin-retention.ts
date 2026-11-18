import type {
  EventId,
  MessageId,
  RetentionClass,
  RetentionPlanView,
  RetentionRuleId,
  RetentionRuleView,
  SourceAccountId,
} from "@intelligence/contracts/personal";
import type { AdminContext } from "../../core/admin-context.ts";
import { AdminError } from "../../core/admin-error.ts";
import { type Query, stamp } from "../../core/db.ts";
import { newId } from "../../core/ids.ts";
import { appendJournal, type JournalEntry } from "../../core/journal.ts";
import { CAPTURE_LANES, captureKindOf, isBuiltClass } from "../../core/lanes.ts";
import { ownerDecision } from "../../core/owner-decision.ts";
import {
  countsOf,
  dueExpiries,
  EXPIRE_LIMIT,
  expireOne,
  RETENTION_DEFAULTS,
  type RuleInForce,
  rulesInForce,
} from "../../lens/capture-retention.ts";
import { syncLock } from "../admin-base.ts";
import { journalOf, nextSeq } from "./admin-erase.ts";

// Retention, as pi_admin, built for Lens's three capture classes: `pi retain set`, `adopt`, `list`,
// `plan` and `run`, and the journal's retention entries. Every other class is refused
// `not_supported` until its expiry is built; `pi retain forget` and the read logs' pruning wait
// with them.

type RuleInput = { class: RetentionClass; days: number | null; account: SourceAccountId | null };

export async function writeRule(
  admin: AdminContext,
  query: Query,
  rule: RuleInput,
  options: { requestId: string; replay?: { seq: number; id: RetentionRuleId } },
): Promise<RetentionRuleId> {
  if (!isBuiltClass(rule.class)) throw new AdminError("not_supported");
  if (rule.days !== null && !(Number.isInteger(rule.days) && rule.days >= 1)) throw new AdminError("invalid_argument");
  if (rule.account !== null) {
    const [account] = await query<{ id: string }>(
      "select id from vault.source_accounts where id = $1 and connector = $2",
      // The source account a capture class may name: a Lens device's own account of it.
      [rule.account, CAPTURE_LANES[captureKindOf(rule.class)].connector],
    );
    if (account === undefined) throw new AdminError("not_found");
  }
  const now = admin.now();
  const seq = options.replay?.seq ?? (await nextSeq(query, journalOf(admin)));
  const id = options.replay?.id ?? (newId("rtr") as RetentionRuleId);
  const ruling = await ownerDecision(
    query,
    { requestId: options.requestId, kind: "retention_rule", details: { class: rule.class, days: rule.days } },
    now,
  );
  await query(
    "insert into policy.retention_rules (id, class, account_id, days, ruling_id, journal_seq, created_at, compartments) values ($1, $2, $3, $4, $5, $6, $7, '{own}')",
    [id, rule.class, rule.account, rule.days, ruling, seq, stamp(now)],
  );
  if (options.replay === undefined)
    await appendJournal(journalOf(admin), {
      seq,
      retention: id,
      class: rule.class,
      account: rule.account,
      days: rule.days,
    } as JournalEntry);
  return id;
}

// Refused `not_supported` for a class whose expiry is not built, `not_found` for an account that is
// no Lens device's account of the class, `sync_running` while a sync holds the lock.
export function setRetention(
  admin: AdminContext,
  rule: RuleInput,
  options: { requestId: string },
): Promise<RetentionRuleId> {
  journalOf(admin);
  return admin.transaction(async (query) => {
    await syncLock(query);
    return writeRule(admin, query, rule, options);
  });
}

// Returns the ids it wrote.
export async function adoptRetention(admin: AdminContext, options: { requestId: string }): Promise<RetentionRuleId[]> {
  journalOf(admin);
  const ids: RetentionRuleId[] = [];
  for (const one of RETENTION_DEFAULTS) {
    const made = await admin.transaction(async (query) => {
      await syncLock(query);
      const [ruled] = await query<{ id: string }>("select id from policy.retention_rules where class = $1 limit 1", [
        one.class,
      ]);
      return ruled === undefined
        ? writeRule(
            admin,
            query,
            { class: one.class, days: one.days, account: null },
            { requestId: `${options.requestId}-${one.class}` },
          )
        : null;
    });
    if (made !== null) ids.push(made);
  }
  return ids;
}

// `pi retain list`: the rules in force.
export async function listRetention(admin: AdminContext): Promise<RetentionRuleView[]> {
  const rules = await admin.transaction((query) => rulesInForce(query));
  return rules.map((rule) => ({
    id: rule.id as RetentionRuleId,
    class: rule.class,
    account: rule.account,
    days: rule.days,
    at: stamp(rule.at),
  }));
}

export async function retentionPlan(admin: AdminContext): Promise<RetentionPlanView> {
  return admin.transaction(async (query) => {
    const rules = await rulesInForce(query);
    const against = rules.length === 0 ? "defaults" : "rules";
    const used: RuleInForce[] =
      rules.length === 0 ? RETENTION_DEFAULTS.map((one) => ({ ...one, account: null })) : rules;
    return {
      against,
      counts: countsOf(await dueExpiries(query, used, admin.now(), 1_000_000, [...admin.keys.compartments.keys()])),
    };
  });
}

// Nothing is due before the owner writes a rule.
export async function runRetention(admin: AdminContext): Promise<RetentionPlanView> {
  const now = admin.now();
  const due = await admin.transaction(async (query) => {
    const rules = await rulesInForce(query);
    return rules.length === 0 ? [] : dueExpiries(query, rules, now, EXPIRE_LIMIT, [...admin.keys.compartments.keys()]);
  });
  const gone = [];
  for (const item of due) {
    const expired = await admin.transaction(async (query) => {
      await syncLock(query);
      return expireOne({ query, keys: admin.keys }, item, now);
    });
    if (expired) gone.push(item);
  }
  return { against: "rules", counts: countsOf(gone) };
}

export function forgetExpired(
  _admin: AdminContext,
  _item: { kind: "message"; id: MessageId } | { kind: "event"; id: EventId },
  _options: { requestId: string },
): Promise<boolean> {
  return Promise.reject(new AdminError("not_supported"));
}
