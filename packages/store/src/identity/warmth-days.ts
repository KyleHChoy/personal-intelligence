import type { PersonalLogger, Tier, TierSource, WarmthChannel, WarmthRules } from "@intelligence/contracts/personal";
import { isPhoneKey } from "@intelligence/personal-core";
import { addressKind } from "@intelligence/personal-core/items";
import {
  mergeDays,
  type RankInput,
  type RuledTier,
  rankAudience,
  type WarmthDay,
  type WarmthFields,
  type WarmthInput,
  warmthDays,
  warmthOfDays,
  warmthRules,
} from "@intelligence/personal-core/views";
import { byText, type Query, stamp } from "../core/db.ts";
import { BELIEFS_LOCK } from "../core/locks.ts";
import type { ClientGroups } from "../core/read-ctx.ts";
import { open, type Sealed } from "../core/seal.ts";
import type { Tx } from "../core/tx.ts";
import { ownerZoneOf } from "../core/zone.ts";
import { ACCOUNTS, closenessOf, distinctLabels, INPUTS, type InputRow, OWNER_FPS, sorted } from "./warmth-build.ts";

// Warmth kept per label, never per audience. The pipeline counts each label's
// rows into days (projections.warmth_days), from the rows of exactly that label; a read sums the
// days of every label within the caller's clearance, person by person and over each group's
// members, and ranks the whole clearance in TypeScript (rankWarmth). Nothing stored names an
// audience, and nothing outside a reader's clearance reaches a sum it reads (invariant 6). Logs
// carry counts and durations alone.

// The labels a build may cover: every label of a contact row, and every label built before.
export const LABELS = `
  select distinct x.compartments from (
    select i.compartments from knowledge.interaction_log i where i.direction in ('inbound', 'outbound')
    union all select p.compartments from knowledge.event_participants p
    union all select l.compartments from knowledge.chat_lines l
    union all select b.compartments from projections.warmth_day_builds b
  ) x`;

// Each label's build state against the database's clock: never built, emptied by a removal, built
// by another rule table or in another zone, built within ten minutes, or with inputs changed since
// (an evidence row ingested with a contact row within the label, or a chat line made within it).
const STATE = `
  select a.label, b.days, b.built_at,
    b.compartments is null as missing,
    b.removed_at is not null as removed,
    (b.rule_version <> $2 or b.time_zone <> $3) as rules,
    b.built_at > now() - interval '10 minutes' as recent,
    (exists (select 1 from vault.evidence_items e
             where e.ingested_at > b.built_at
               and (exists (select 1 from knowledge.interaction_log i where i.evidence_id = e.id and i.compartments <@ a.label)
                    or exists (select 1 from knowledge.events v where v.evidence_id = e.id and v.compartments <@ a.label)))
     or exists (select 1 from knowledge.chat_lines l where l.created_at > b.built_at and l.compartments <@ a.label)) as changed
  from (select array(select jsonb_array_elements_text(j)) as label from jsonb_array_elements($1::jsonb) as j) a
  left join projections.warmth_day_builds b on b.compartments = a.label`;

type State = {
  label: string[];
  days: number | null;
  missing: boolean;
  removed: boolean;
  rules: boolean | null;
  recent: boolean | null;
  changed: boolean | null;
};

const INSERT = `
  insert into projections.warmth_days (entity_id, day, compartments, out_w, in_w, meet_w, email_out, email_in, chat_out, chat_in,
    meet_n, started, runs, answered, answer_hours, mutual, theirs, first_out_at, last_out_at, first_in_at, last_in_at, first_meet_at, last_meet_at)
  select r.entity_id, r.day, $1::text[], r.out_w, r.in_w, r.meet_w, r.email_out, r.email_in, r.chat_out, r.chat_in,
    r.meet_n, r.started, r.runs, r.answered, r.answer_hours, r.mutual, r.theirs, r.first_out_at, r.last_out_at, r.first_in_at, r.last_in_at,
    r.first_meet_at, r.last_meet_at
  from jsonb_to_recordset($2::jsonb) as r (entity_id text, day date, out_w float8, in_w float8, meet_w float8, email_out int, email_in int,
    chat_out int, chat_in int, meet_n int, started int, runs int, answered int, answer_hours float8, mutual int, theirs int,
    first_out_at timestamptz, last_out_at timestamptz, first_in_at timestamptz, last_in_at timestamptz, first_meet_at timestamptz,
    last_meet_at timestamptz)`;

const UPSERT_BUILD = `
  insert into projections.warmth_day_builds (compartments, built_at, rule_version, time_zone, days, removed_at)
  values ($1::text[], now(), $2, $3, $4, null)
  on conflict (compartments) do update set built_at = excluded.built_at, rule_version = excluded.rule_version,
    time_zone = excluded.time_zone, days = excluded.days, removed_at = null`;

const DAY_MS = 86_400_000;
const dayText = (day: number): string => new Date(day * DAY_MS).toISOString().slice(0, 10);
const isoOrNull = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

// One label's days, in the caller's transaction, under the beliefs lock: the contact rows whose
// labels make exactly this label, each person alone (groups are the reader's), counted into days in
// the owner's zone.
export async function buildLabelDays(
  tx: Tx,
  given: readonly string[],
  options: { rules?: WarmthRules } = {},
): Promise<{ days: number }> {
  const label = sorted(given);
  const key = JSON.stringify(label);
  const rules = options.rules ?? warmthRules();
  // Taken first and held while the build reads and writes, so a removal never interleaves: the
  // build sees what a removal left, or the removal deletes what the build wrote.
  await tx.query(BELIEFS_LOCK);
  const timeZone = (await ownerZoneOf(tx.query)) ?? "UTC";
  const rows = await tx.query<InputRow>(INPUTS, [
    label,
    [],
    [],
    rules.directMaxRecipients,
    rules.meetingMaxAttendees,
    "infinity",
  ]);
  const byEntity = new Map<
    string,
    WarmthInput & { messages: WarmthInput["messages"][number][] } & {
      meetings: WarmthInput["meetings"][number][];
    }
  >();
  for (const row of rows) {
    if (JSON.stringify(sorted(row.labels)) !== key) continue;
    const one = byEntity.get(row.entity_id) ?? { messages: [], meetings: [] };
    byEntity.set(row.entity_id, one);
    if (row.kind === "meet") one.meetings.push({ at: stamp(row.at), attendees: row.n });
    else
      one.messages.push({
        at: stamp(row.at),
        direction: row.kind,
        recipients: row.n,
        thread: row.thread ?? row.id,
        channel: row.channel === "chat" ? "chat" : "email",
      });
  }
  const out = [...byEntity]
    .sort(([a], [b]) => byText(a, b))
    .flatMap(([entity, input]) =>
      warmthDays(input, rules, timeZone).map((one) => ({
        entity_id: entity,
        day: dayText(one.day),
        out_w: one.outW,
        in_w: one.inW,
        meet_w: one.meetW,
        email_out: one.emailOut,
        email_in: one.emailIn,
        chat_out: one.chatOut,
        chat_in: one.chatIn,
        meet_n: one.meetN,
        started: one.started,
        runs: one.runs,
        answered: one.answered,
        answer_hours: one.answerHours,
        mutual: one.mutual,
        theirs: one.theirs,
        first_out_at: isoOrNull(one.firstOutAt),
        last_out_at: isoOrNull(one.lastOutAt),
        first_in_at: isoOrNull(one.firstInAt),
        last_in_at: isoOrNull(one.lastInAt),
        first_meet_at: isoOrNull(one.firstMeetAt),
        last_meet_at: isoOrNull(one.lastMeetAt),
      })),
    );
  await tx.query("delete from projections.warmth_days where compartments = $1::text[]", [label]);
  if (out.length > 0) await tx.query(INSERT, [label, JSON.stringify(out)]);
  await tx.query(UPSERT_BUILD, [label, rules.version, timeZone, out.length]);
  return { days: out.length };
}

// Which labels a run builds: one never built or emptied by a removal, or counted by another rule
// table or zone, at once; one whose inputs changed since, at most once every ten minutes when it
// has days.
export async function labelsDue(query: Query, options: { rules?: WarmthRules } = {}): Promise<string[][]> {
  const labels = distinctLabels((await query<{ compartments: string[] }>(LABELS, [])).map((row) => row.compartments));
  if (labels.length === 0) return [];
  const timeZone = (await ownerZoneOf(query)) ?? "UTC";
  const states = await query<State>(STATE, [
    JSON.stringify(labels),
    (options.rules ?? warmthRules()).version,
    timeZone,
  ]);
  return states
    .filter(
      (state) =>
        state.missing ||
        state.removed ||
        state.rules === true ||
        (state.changed === true && !(state.recent === true && (state.days ?? 0) > 0)),
    )
    .map((state) => state.label)
    .sort((a, b) => byText(JSON.stringify(a), JSON.stringify(b)));
}

type DaysRun = { built: number; failed: number; days: number; ms: number };

// Each due label built in a transaction of its own; a build that throws rolls back alone and is
// counted. One log line per label, counts and a duration alone.
export async function buildDueDays(
  db: { transaction<T>(fn: (query: Query) => Promise<T>): Promise<T> },
  keys: Tx["keys"],
  log: PersonalLogger,
  options: { rules?: WarmthRules } = {},
): Promise<DaysRun> {
  const started = Date.now();
  const due = await db.transaction((query) => labelsDue(query, options));
  const run: DaysRun = { built: 0, failed: 0, days: 0, ms: 0 };
  for (const label of due) {
    const at = Date.now();
    try {
      const built = await db.transaction((query) => buildLabelDays({ query, keys }, label, options));
      run.built += 1;
      run.days += built.days;
      log.info({
        event: "warmth_days_built",
        counts: { days: built.days, compartments: label.length },
        durationMs: Date.now() - at,
      });
    } catch {
      run.failed += 1;
      log.error({
        event: "warmth_days_failed",
        counts: { compartments: label.length },
        durationMs: Date.now() - at,
        code: "unavailable",
      });
    }
  }
  run.ms = Date.now() - started;
  return run;
}

// The read.

// The days within a clearance (`$1`), every label's, as the reader's row policy also bounds them.
const DAYS = `
  select w.entity_id, (w.day - date '1970-01-01')::int as day, w.out_w, w.in_w, w.meet_w, w.email_out, w.email_in, w.chat_out, w.chat_in,
    w.meet_n, w.started, w.runs, w.answered, w.answer_hours, w.mutual, w.theirs,
    w.first_out_at, w.last_out_at, w.first_in_at, w.last_in_at, w.first_meet_at, w.last_meet_at, w.compartments
  from projections.warmth_days w
  where w.compartments <@ $1::text[]
  order by w.compartments, w.entity_id, w.day`;

// The newest build within the clearance and how many labels, the memo's key.
const NEWEST = `
  select max(b.built_at) as built_at, count(*)::int as labels, bool_or(b.removed_at is not null) as removed
  from projections.warmth_day_builds b where b.compartments <@ $1::text[]`;

// Whether rankWarmth would answer `rebuilding` for the clearance, without ranking it: no label
// within it built, or a removal has emptied one.
export async function warmthRebuilding(query: Query, clearance: readonly string[]): Promise<boolean> {
  const [newest] = await query<{ built_at: Date | null; removed: boolean | null }>(NEWEST, [sorted(clearance)]);
  return newest === undefined || newest.built_at === null || newest.removed === true;
}

type DayRow = {
  entity_id: string;
  day: number;
  out_w: number;
  in_w: number;
  meet_w: number;
  email_out: number;
  email_in: number;
  chat_out: number;
  chat_in: number;
  meet_n: number;
  started: number;
  runs: number;
  answered: number;
  answer_hours: number;
  mutual: number;
  theirs: number;
  first_out_at: Date | null;
  last_out_at: Date | null;
  first_in_at: Date | null;
  last_in_at: Date | null;
  first_meet_at: Date | null;
  last_meet_at: Date | null;
  compartments: string[];
};

const ms = (at: Date | null): number | null => (at === null ? null : at.getTime());
const dayOf = (row: DayRow): WarmthDay => ({
  day: row.day,
  outW: Number(row.out_w),
  inW: Number(row.in_w),
  meetW: Number(row.meet_w),
  emailOut: row.email_out,
  emailIn: row.email_in,
  chatOut: row.chat_out,
  chatIn: row.chat_in,
  meetN: row.meet_n,
  started: row.started,
  runs: row.runs,
  answered: row.answered,
  answerHours: Number(row.answer_hours),
  mutual: row.mutual,
  theirs: row.theirs,
  firstOutAt: ms(row.first_out_at),
  lastOutAt: ms(row.last_out_at),
  firstInAt: ms(row.first_in_at),
  lastInAt: ms(row.last_in_at),
  firstMeetAt: ms(row.first_meet_at),
  lastMeetAt: ms(row.last_meet_at),
});

// One person's computed line in a clearance.
export type RankedWarmth = {
  entity_id: string;
  members: string[];
  active: number;
  depth: number;
  warmth: number;
  two_way: boolean;
  first_two_way_at: string | null;
  last_two_way_at: string | null;
  reply_rate: number | null;
  reply_hours: number | null;
  they_start: number | null;
  channels: WarmthChannel[];
  tier: Tier;
  tier_source: TierSource;
  dormant: boolean;
  compartments: string[];
};

// Who reads: a client under its token's clearance, through the reader's definers, or the owner's
// own reads (pi_admin) of a clearance they name.
export type WarmthReader = { kind: "client" } | { kind: "owner" };

type Scored = { fields: Map<string, WarmthFields>; labels: Map<string, Set<string>>; excluded: Set<string> };
type Memo = { key: string; scored: Scored };
// The last scored clearance of each reader and clearance, while its key holds: the clearance, the
// owner's day, the newest build within it, the rule version and the groups. Never shared across a
// key that differs, so a new day, a new build, a new rule table or a ruling made since is computed
// afresh.
const memos = new Map<string, Memo>();
const MEMOS_MAX = 32;

// Every memo dropped: a measurement's cold read.
export const clearWarmthMemo = (): void => memos.clear();

// The whole ranking of a clearance, from the days within it: each group's days summed over its
// members and labels, scored by warmthOfDays as of `today`, less machines, the owner's own and the
// ignored, ranked with the owner's closeness and tier rulings within it. Returns no map while no
// label within it is built, or while a removal has emptied one (`rebuilding`).
export async function rankWarmth(
  tx: Tx,
  reader: WarmthReader,
  given: readonly string[],
  groups: ClientGroups,
  options: { today: Date; rules?: WarmthRules },
): Promise<Map<string, RankedWarmth> | "rebuilding"> {
  const clearance = sorted(given);
  const rules = options.rules ?? warmthRules();
  const [newest] = await tx.query<{ built_at: Date | null; labels: number; removed: boolean | null }>(NEWEST, [
    clearance,
  ]);
  if (newest === undefined || newest.built_at === null || newest.removed === true) return "rebuilding";
  const timeZone = (await ownerZoneOf(tx.query)) ?? "UTC";
  const today = options.today.toISOString();
  const key = JSON.stringify([
    reader.kind,
    clearance,
    today.slice(0, 10),
    timeZone,
    newest.built_at.toISOString(),
    newest.labels,
    rules.version,
    groups.joined,
  ]);
  const memoKey = JSON.stringify([reader.kind, clearance]);
  let scored = memos.get(memoKey)?.key === key ? memos.get(memoKey)?.scored : undefined;
  if (scored === undefined) {
    scored = await score(tx, clearance, groups, rules, today, timeZone);
    if (memos.size >= MEMOS_MAX && !memos.has(memoKey)) memos.delete(memos.keys().next().value as string);
    memos.set(memoKey, { key, scored });
  }

  const closeness = await closenessOf(tx, clearance, groups);
  const ruled = new Map<string, { tier: RuledTier; at: Date }>();
  for (const row of await tx.query<{ entity_id: string; tier: RuledTier; ruled_at: Date }>(
    reader.kind === "client"
      ? "select entity_id, tier, ruled_at from policy.warmth_rulings() order by entity_id"
      : "select entity_id, tier, ruled_at from policy.tier_rulings_in($1::text[]) order by entity_id",
    reader.kind === "client" ? [] : [clearance],
  )) {
    const group = groups.idOf(row.entity_id);
    const held = ruled.get(group);
    if (held === undefined || row.ruled_at > held.at) ruled.set(group, { tier: row.tier, at: row.ruled_at });
  }
  const [ignoredRow] = await tx.query<{ ids: string[] | null }>(
    reader.kind === "client"
      ? "select policy.warmth_ignored() as ids"
      : "select policy.ignored_people_in($1::text[]) as ids",
    reader.kind === "client" ? [] : [clearance],
  );
  const ignored = new Set(ignoredRow?.ids ?? []);
  // A ruled group's line also rests on the accounts within the clearance that tie the ruling to it,
  // and a ruled group no day names is no person here when one of them is a machine's or the owner's,
  // as the per-audience build had it.
  const ruledAccounts = await accountsOf(
    tx,
    [...ruled.keys()].flatMap((group) => groups.membersOf(group)),
    clearance,
  );

  // A person the owner labelled or ruled takes the owner's tier whatever the score, so one with no
  // day within the clearance still has a line.
  const empty = warmthOfDays([], rules, today, timeZone);
  const people: (RankInput & { labels: Set<string> })[] = [];
  const ids = new Set([...scored.fields.keys(), ...closeness.keys(), ...ruled.keys()]);
  for (const group of [...ids].sort(byText)) {
    const members = groups.membersOf(group);
    if (
      members.some((member) => scored.excluded.has(member) || ruledAccounts.excluded.has(member) || ignored.has(member))
    )
      continue;
    const labels = new Set(scored.labels.get(group) ?? []);
    const closed = closeness.get(group);
    for (const label of closed?.labels ?? []) labels.add(label);
    if (ruled.has(group))
      for (const member of members) for (const label of ruledAccounts.labels.get(member) ?? []) labels.add(label);
    people.push({
      id: group,
      fields: scored.fields.get(group) ?? empty,
      closeness: closed?.closeness,
      ruledTier: ruled.get(group)?.tier,
      labels,
    });
  }
  const ranked = rankAudience(people, rules);
  const out = new Map<string, RankedWarmth>();
  for (const person of people) {
    const tier = ranked.get(person.id);
    if (tier === undefined) continue;
    const { fields } = person;
    out.set(person.id, {
      entity_id: person.id,
      members: groups.membersOf(person.id),
      active: fields.active,
      depth: fields.depth,
      warmth: fields.warmth,
      two_way: fields.twoWay,
      first_two_way_at: fields.firstTwoWayAt,
      last_two_way_at: fields.lastTwoWayAt,
      reply_rate: fields.replyRate,
      reply_hours: fields.replyHours,
      they_start: fields.theyStart,
      channels: fields.channels,
      tier: tier.tier,
      tier_source: tier.tierSource,
      dormant: tier.dormant,
      compartments: sorted(person.labels),
    });
  }
  return out;
}

// Each group's fields from the days within the clearance, and the people that are no person here:
// a machine's or a function's address, or the owner's own.
async function score(
  tx: Tx,
  clearance: string[],
  groups: ClientGroups,
  rules: WarmthRules,
  today: string,
  timeZone: string,
): Promise<Scored> {
  const byGroup = new Map<string, WarmthDay[][]>();
  const labels = new Map<string, Set<string>>();
  for (const row of await tx.query<DayRow>(DAYS, [clearance])) {
    const group = groups.idOf(row.entity_id);
    const held = byGroup.get(group) ?? [[]];
    byGroup.set(group, held);
    held[0]?.push(dayOf(row));
    const set = labels.get(group) ?? new Set<string>();
    labels.set(group, set);
    for (const label of row.compartments) set.add(label);
  }
  const fields = new Map<string, WarmthFields>();
  for (const [group, lists] of byGroup) fields.set(group, warmthOfDays(mergeDays(lists), rules, today, timeZone));

  const named = [...byGroup.keys()].flatMap((group) => groups.membersOf(group));
  return { fields, labels, excluded: (await accountsOf(tx, named, clearance)).excluded };
}

// The accounts within the clearance of the people named: the people that are no person here (a
// machine's or a function's address, or the owner's own), and each person's accounts' labels.
async function accountsOf(
  tx: Tx,
  named: readonly string[],
  clearance: readonly string[],
): Promise<{ excluded: Set<string>; labels: Map<string, Set<string>> }> {
  const excluded = new Set<string>();
  const labels = new Map<string, Set<string>>();
  if (named.length === 0) return { excluded, labels };
  const ownFps = new Set((await tx.query<{ value_fp: string }>(OWNER_FPS, [clearance])).map((row) => row.value_fp));
  for (const account of await tx.query<{
    id: string;
    entity_id: string;
    kind: string;
    value_fp: string;
    compartments: string[];
    value_enc: Sealed;
    person: boolean;
  }>(ACCOUNTS, [named, clearance])) {
    const held = labels.get(account.entity_id) ?? new Set<string>();
    labels.set(account.entity_id, held);
    for (const label of account.compartments) held.add(label);
    const value = open(tx.keys, account, "knowledge.accounts.value_enc", "throw");
    const machine =
      (account.kind !== "email" && account.kind !== "shared") ||
      (!isPhoneKey(value) && addressKind(value, account.person ? "person" : null) !== "email");
    if (machine || ownFps.has(account.value_fp)) excluded.add(account.entity_id);
  }
  return { excluded, labels };
}
