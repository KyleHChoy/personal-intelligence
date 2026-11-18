import { FiledMention } from "@intelligence/contracts/personal";
import { namedKey } from "@intelligence/personal-core";
import { secondDegreeRules } from "@intelligence/personal-core/views";
import { allRulings, ownerFps } from "../core/identity-rulings.ts";
import { labelJoined } from "../core/labels.ts";
import { TRY_EXTRACT } from "../core/locks.ts";
import { GOAL_TARGET_ORG_FIELD } from "../core/org-names.ts";
import { open, type Sealed } from "../core/seal.ts";
import { sql } from "../core/sql.ts";
import { openStatus } from "../core/status-facts.ts";
import { eachInOwnTransaction, type Tx } from "../core/tx.ts";
import { holders } from "../core/vocabulary.ts";
import { type Groups, groupOf, groupsOf } from "../identity/groups.ts";
import { identityPort } from "../identity/identity-port.ts";
import { bindName, type NameCounts, type NameRules } from "../identity/name-binding.ts";
import type { DrainContext } from "../lens/capture-drain.ts";
import { bindNamedOrgs, MADE_TODAY, type OrgCounts, settleCommandedOrg } from "./named-orgs.ts";
import { DUE_WITH_CALL_MATES, revisionsOf } from "./participant-binding.ts";

// The named binding step: at each full `pi sync`, after the participant step and before the
// identity sweep, the writer binds each name a relation filed (a `relationship` side or an
// `intro_offer` person, said by a speaker) to a person, or makes a named person keyed
// `profile:named/`, by code alone (invariant 5); then removes the named people nothing names any
// more. Every signal is read under the item's label alone (invariant 6); the owner's binding and
// lift outrank it (invariant 11); an erasure's suppression makes nobody again (invariant 10).

// `opened`, the filed rows whose sealed facts were opened; `waiting`, rows whose speaker resolves to
// nobody under the label, or whose item is not human-written, left for a later sync; `tied`, full names
// a person the owner has an own tie with holds, left filed for the owner's bind; `self`, names the
// speaker or the owner is known by; `removed`, named people removed; `commanded`, the owner's
// goal-target names opened; the named organizations' counts too.
export type NamedCounts = NameCounts &
  OrgCounts & {
    opened: number;
    waiting: number;
    tied: number;
    self: number;
    failed: number;
    removed: number;
    commanded: number;
  };

// Condition 3 in clear: a present item the screen did not withhold, no held or bulk message and no held
// document.
const FILED = `
  select u.id, u.evidence_id, u.name_fp, u.compartments, u.facts_enc, e.source_item_fp, e.source_account_id
  from vault.unresolved_mentions u
  join vault.evidence_items e on e.id = u.evidence_id
  join vault.pipeline_items p on p.evidence_id = u.evidence_id
  where u.relation and u.has_speaker and e.payload_state = 'present' and not p.withheld
    and not exists (select 1 from knowledge.mention_bindings b where b.evidence_id = u.evidence_id and b.mention_fp = u.name_fp and (b.lifted_at is null or b.origin = 'owner'))
    and not exists (select 1 from knowledge.messages m where m.evidence_id = u.evidence_id and (m.held or m.bulk))
    and not exists (select 1 from knowledge.documents d where d.evidence_id = u.evidence_id and d.held)
  order by u.evidence_id collate "C", u.id collate "C"`;

type Filed = {
  id: string;
  evidence_id: string;
  name_fp: string;
  compartments: string[];
  facts_enc: Sealed;
  source_item_fp: string;
  source_account_id: string;
};

// The lanes triage gives human-written items: correspondence, and the capture lanes.
const HUMAN_LANES: ReadonlySet<string> = new Set(["correspondence", "meeting", "moment"]);

// A full name is two words or more; one word is keyed by its speaker too.
export const oneWord = (name: string): boolean => !/\s/u.test(name.trim());

export function namedScope(nameFp: string, label: readonly string[], speaker: string | null): string {
  return speaker === null
    ? `named person\n${nameFp}\n${labelJoined(label)}`
    : `named person\n${nameFp}\n${speaker}\n${labelJoined(label)}`;
}

// The people a fingerprint names under the label: by an account (an address or a phone key), else
// by an alias (a name); one person by alias, or none.
const BY_ACCOUNT = sql`select distinct a.entity_id from ${holders("$1", "$2::text[]")} order by 1`;
const BY_ALIAS = `
  select distinct s.entity_id from knowledge.aliases s join knowledge.entities e on e.id = s.entity_id and e.kind = 'person'
  where s.value_fp = $1 and s.compartments <@ $2::text[] order by 1`;
const ACCOUNT_FPS =
  "select distinct value_fp from knowledge.accounts where entity_id = $1 and compartments <@ $2::text[]";
const HOLDERS = sql`select min(a.entity_id) as id from ${holders("any($1::text[])", "$2::text[]")}`;

// The speaker's entity: the lowest entity id of their identity group under the label, so two
// addresses or two records of one speaker key one "Theo". Null when nobody, or several by name
// alone.
async function speakerOf(tx: Tx, groups: Groups, speakerFp: string, label: string[]): Promise<string | null> {
  const byAccount = await tx.query<{ entity_id: string }>(BY_ACCOUNT, [speakerFp, label]);
  const byAlias = byAccount.length > 0 ? [] : await tx.query<{ entity_id: string }>(BY_ALIAS, [speakerFp, label]);
  const found = byAccount[0]?.entity_id ?? (byAlias.length === 1 ? byAlias[0]?.entity_id : undefined);
  if (found === undefined) return null;
  const fps = (await tx.query<{ value_fp: string }>(ACCOUNT_FPS, [found, label])).flatMap((row) => [
    ...groupOf(groups, row.value_fp),
  ]);
  const [lowest] = fps.length === 0 ? [] : await tx.query<{ id: string | null }>(HOLDERS, [[...new Set(fps)], label]);
  return lowest?.id ?? found;
}

// The name is the speaker's own alias (a speaker writing of themselves by name) or the owner's.
const SELF_NAME = `
  select exists (
    select 1 from knowledge.aliases s join knowledge.entities e on e.id = s.entity_id
    where s.value_fp = $1 and s.compartments <@ $2::text[] and (s.entity_id = $3 or e.kind = 'owner')) as yes`;

const TIED = `
  select exists (
    select 1 from knowledge.aliases s join knowledge.entities e on e.id = s.entity_id and e.kind = 'person'
    where s.value_fp = $1 and s.compartments <@ $2::text[] and (
      exists (
        select 1 from knowledge.interaction_log i left join knowledge.messages m on m.evidence_id = i.evidence_id and not m.held
        where i.entity_id = s.entity_id and i.compartments <@ $2::text[] and i.occurred_at <= $3 and (m.id is not null or i.channel = 'mail_headers')
        having bool_or(i.direction = 'outbound') and bool_or(i.direction = 'inbound' and i.entity_role = 'sender'))
      or exists (
        select 1 from knowledge.event_participants p join knowledge.event_details d on d.event_id = p.event_id
        where p.entity_id = s.entity_id and p.compartments <@ $2::text[] and not d.cancelled and d.starts_at <= $3
          and coalesce(d.owner_response, 'accepted') in ('accepted', 'tentative'))
      or exists (select 1 from knowledge.contact_addresses k where k.entity_id = s.entity_id and k.compartments <@ $2::text[]))) as yes`;

// Their accounts and aliases go, so their entity holds no account and is withheld everywhere. A goal
// target the owner named is named by its owner_command item's live binding, so it stays while that item is
// present; the writer reads nothing of goal_state, so a named person the owner targeted by `--entity`
// alone is not protected here (a known limit).
const UNNAMED = `
  select e.id from knowledge.entities e
  where e.named and exists (select 1 from knowledge.accounts a where a.entity_id = e.id)
    and not exists (select 1 from knowledge.claim_entities n where n.entity_id = e.id)
    and not exists (
      select 1 from knowledge.mention_bindings b join knowledge.accounts a on a.value_fp = b.address_fp and a.entity_id = e.id
      join vault.evidence_items v on v.id = b.evidence_id and v.payload_state = 'present'
      where b.lifted_at is null)
    -- A goal's target is never removed.
    and not exists (select 1 from knowledge.goal_target_ids() t where t = e.id)
  order by e.id collate "C"`;

// The day's cap on people made by name under one label, for one transaction: full once the people
// and organizations made by name today under the label reach the limit. The count is read once,
// at the first ask, and counted on as people are made.
export function namedTodayCap(tx: Tx, label: readonly string[]): NameRules["cap"] {
  let madeToday: number | undefined;
  return {
    full: async () =>
      (madeToday ??= (await tx.query<{ n: number }>(MADE_TODAY, [label]))[0]?.n ?? 0) >=
      secondDegreeRules().namedPerLabelPerDay,
    made: async (entity) => {
      await tx.query("update knowledge.entities set named = true where id = $1", [entity]);
      if (madeToday !== undefined) madeToday += 1;
    },
  };
}

async function settleItem(tx: Tx, rows: Filed[], groups: Groups, now: Date, counts: NamedCounts): Promise<void> {
  const [lock] = await tx.query<{ held: boolean }>(TRY_EXTRACT);
  if (lock?.held !== true) {
    counts.skipped += rows.length;
    return;
  }
  const first = rows[0] as Filed;
  const label = first.compartments;
  // Condition 3: triage's lane, from the item's status, is a human-written one.
  const [status] = await tx.query<{ compartments: string[]; facts_enc: Sealed }>(
    "select compartments, facts_enc from vault.pipeline_items where evidence_id = $1",
    [first.evidence_id],
  );
  if (
    status === undefined ||
    !HUMAN_LANES.has(openStatus(tx, status.compartments, first.evidence_id, status.facts_enc).lane)
  ) {
    counts.waiting += rows.length;
    return;
  }
  const port = identityPort(tx);
  const requestId = `named:${first.evidence_id}`;
  const revisions = await revisionsOf(tx, first.source_account_id, first.source_item_fp);
  const item = { evidenceId: first.evidence_id, sourceItemFp: first.source_item_fp, revisions, label };
  const cap = namedTodayCap(tx, label);
  const settled = new Set<string>();
  let bound = false;
  for (const row of rows) {
    if (settled.has(row.name_fp)) continue;
    counts.opened += 1;
    const filed = FiledMention.parse(JSON.parse(open(tx.keys, row, "vault.unresolved_mentions.facts_enc", "throw")));
    const speaker = filed.speakerFp === undefined ? null : await speakerOf(tx, groups, filed.speakerFp, label);
    if (speaker === null) {
      counts.waiting += 1;
      continue;
    }
    // Read again under the lock: a binding of the name made since the selection settles it.
    const [live] = await tx.query<{ id: string }>(
      "select id from knowledge.mention_bindings where evidence_id = $1 and mention_fp = $2 and (lifted_at is null or origin = 'owner') limit 1",
      [row.evidence_id, row.name_fp],
    );
    if (live !== undefined) {
      settled.add(row.name_fp);
      counts.skipped += 1;
      continue;
    }
    if ((await tx.query<{ yes: boolean }>(SELF_NAME, [row.name_fp, label, speaker]))[0]?.yes === true) {
      counts.self += 1;
      continue;
    }
    const single = oneWord(filed.name);
    if (!single && (await tx.query<{ yes: boolean }>(TIED, [row.name_fp, label, now.toISOString()]))[0]?.yes === true) {
      settled.add(row.name_fp);
      counts.tied += 1;
      continue;
    }
    const rules: NameRules = {
      scope: namedScope(row.name_fp, label, single ? speaker : null),
      requestId,
      key: namedKey,
      eventId: null,
      cap,
      ...(single ? { keyOnly: true as const } : {}),
    };
    settled.add(row.name_fp);
    if (await bindName(tx, port, item, filed.name, rules, now, counts)) bound = true;
  }
  await port.write(label);
  // Due again with its saved calls kept (and its calls' other items), so the next run replays it.
  if (bound) await tx.query(DUE_WITH_CALL_MATES, [first.evidence_id]);
}

// The names the owner gave a goal's target by (`pia goal target --name`), each filed on its owner_command
// item (goal-target-names.ts), with no live binding and no binding of the owner's. No item is set due: a
// command item is never extracted. The goal's target follows the binding.
const COMMANDED = `
  select u.id, u.evidence_id, u.name_fp, u.compartments, u.facts_enc, e.source_item_fp, e.source_account_id
  from vault.unresolved_mentions u
  join vault.evidence_items e on e.id = u.evidence_id
  where e.source_kind = 'owner_command' and e.payload_state = 'present'
    and not exists (select 1 from knowledge.mention_bindings b where b.evidence_id = u.evidence_id and b.mention_fp = u.name_fp and (b.lifted_at is null or b.origin = 'owner'))
    and not exists (select 1 from knowledge.org_names o where o.evidence_id = u.evidence_id and o.name_fp = u.name_fp)
  order by u.evidence_id collate "C", u.id collate "C"`;

async function settleCommanded(tx: Tx, row: Filed, now: Date, counts: NamedCounts): Promise<void> {
  counts.commanded += 1;
  const filed = FiledMention.parse(JSON.parse(open(tx.keys, row, "vault.unresolved_mentions.facts_enc", "throw")));
  const label = row.compartments;
  if (filed.field === GOAL_TARGET_ORG_FIELD) {
    await settleCommandedOrg(tx, { nameFp: row.name_fp, name: filed.name, evidence: row.evidence_id, label }, counts);
    return;
  }
  if (oneWord(filed.name)) return;
  const port = identityPort(tx);
  const item = { evidenceId: row.evidence_id, sourceItemFp: row.source_item_fp, revisions: [row.evidence_id], label };
  const cap: NameRules["cap"] = {
    full: () => Promise.resolve(false),
    made: async (entity) => {
      await tx.query("update knowledge.entities set named = true where id = $1", [entity]);
    },
  };
  await bindName(
    tx,
    port,
    item,
    filed.name,
    {
      scope: namedScope(row.name_fp, label, null),
      requestId: `named:${row.evidence_id}`,
      key: namedKey,
      eventId: null,
      cap,
    },
    now,
    counts,
  );
  await port.write(label);
}

export function bindNamed(writer: DrainContext, now: Date): Promise<NamedCounts> {
  return writer.write(async () => {
    const counts: NamedCounts = {
      bound: 0,
      ambiguous: 0,
      created: 0,
      skipped: 0,
      capped: 0,
      opened: 0,
      waiting: 0,
      tied: 0,
      self: 0,
      failed: 0,
      removed: 0,
      commanded: 0,
      orgBound: 0,
      orgMade: 0,
      orgCapped: 0,
      orgSuppressed: 0,
      orgFailed: 0,
      orgRemoved: 0,
    };
    const commandedFailed = await eachInOwnTransaction(await writer.direct.query<Filed>(COMMANDED), (row) =>
      writer.transaction((tx) => settleCommanded(tx, row, now, counts)),
    );
    counts.failed += commandedFailed;
    const rows = await writer.direct.query<Filed>(FILED);
    const byItem = new Map<string, Filed[]>();
    for (const row of rows) byItem.set(row.evidence_id, [...(byItem.get(row.evidence_id) ?? []), row]);
    const groups =
      byItem.size === 0
        ? groupsOf([], [])
        : groupsOf(await allRulings(writer.direct.query), await ownerFps(writer.direct.query));
    const itemsFailed = await eachInOwnTransaction(byItem.values(), (items) =>
      writer.transaction((tx) => settleItem(tx, items, groups, now, counts)),
    );
    counts.failed += itemsFailed;
    counts.removed = await writer.transaction(async (tx) => {
      const gone = (await tx.query<{ id: string }>(UNNAMED)).map((row) => row.id);
      if (gone.length === 0) return 0;
      await tx.query("delete from knowledge.aliases where entity_id = any($1::text[])", [gone]);
      await tx.query("delete from knowledge.accounts where entity_id = any($1::text[])", [gone]);
      return gone.length;
    });
    await bindNamedOrgs(writer.direct, (fn) => writer.transaction(fn), counts);
    return counts;
  });
}
