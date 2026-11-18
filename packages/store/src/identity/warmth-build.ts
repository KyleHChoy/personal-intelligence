import { ClaimRecord, Closeness, OWNER_TIE_TYPE, type WarmthRules } from "@intelligence/contracts/personal";
import { isPhoneKey } from "@intelligence/personal-core";
import { addressKind } from "@intelligence/personal-core/items";
import {
  type RankInput,
  type RuledTier,
  rankAudience,
  type WarmthInput,
  warmthOf,
  warmthRules,
} from "@intelligence/personal-core/views";
import type { Query } from "../core/db.ts";
import { byText, stamp } from "../core/db.ts";
import { BELIEFS_LOCK } from "../core/locks.ts";
import type { ClientGroups } from "../core/read-ctx.ts";
import { open, type Sealed } from "../core/seal.ts";
import { OWNER_ENTITY_ALIASED } from "../core/statements.ts";
import type { Tx } from "../core/tx.ts";
import { ownerZoneOf } from "../core/zone.ts";
import { type GroupRulingRow, groupsFromRows } from "../read/read-groups.ts";

// What warmth reads of the sources, for the day build (warmth-days.ts), the ranking at read and the
// measurement's reference computation (computeWarmth), and the removal of days by containment when
// rows they rest on go. Every read below takes only rows whose label is within the clearance or label
// it is given, so nothing outside it changes what it answers (invariant 6). No per-audience row is
// written.

// The audience's visible rulings and the people behind each fingerprint, as the reader's row policy on
// knowledge.identity_rulings returns them to a client of exactly this clearance: unlifted, `same`, `shared`
// or `person`, each address a person's account within the audience.
const RULINGS = `
  select r.verdict, r.a_fp, r.b_fp,
    array(select distinct a.entity_id from knowledge.accounts a join knowledge.entities e on e.id = a.entity_id and e.kind = 'person'
          where a.value_fp = r.a_fp and a.compartments <@ $1::text[] order by a.entity_id) as a_people,
    array(select distinct a.entity_id from knowledge.accounts a join knowledge.entities e on e.id = a.entity_id and e.kind = 'person'
          where a.value_fp = r.b_fp and a.compartments <@ $1::text[] order by a.entity_id) as b_people
  from knowledge.identity_rulings r
  where r.lifted_at is null and r.verdict in ('same', 'shared', 'person')
    and exists (select 1 from knowledge.accounts x join knowledge.entities p on p.id = x.entity_id and p.kind = 'person'
                where x.value_fp = r.a_fp and x.compartments <@ $1::text[])
    and (r.b_fp is null or exists (select 1 from knowledge.accounts y join knowledge.entities q on q.id = y.entity_id and q.kind = 'person'
                where y.value_fp = r.b_fp and y.compartments <@ $1::text[]))
  order by r.a_fp, r.b_fp nulls first, r.verdict`;

// The inputs for the whole audience (`$1`), in one statement, each person's rows by group
// (`$2` the joined members, `$3` their groups' ids), as of `$6`:
// - direct mail each way, the TIES statement's rule (read-people.ts): a row of a message the owner
//   sent, or one the person sent the owner; never held, bulk or restricting (the reader's message
//   policy; a message read by its headers alone has no message row and is none of those); each
//   message once for a group, on a message with at most `$4` person recipients (`n`: the
//   message's outbound rows for one the owner sent, WROTE_TO_MAX_RECIPIENTS as get_self counts one
//   they wrote to; the owner and its other person recipients for one the owner received);
// - meetings, TIES' and SHARED_MEETINGS' rule: not cancelled, started, the owner's response
//   accepted, tentative or none, each event once for a group, with at most `$5` attendees (its
//   participants within the audience and the owner, who is no participant row);
// - chat lines, each line once for a group (a merged person's two handles in one chat), `n` its `others`, counted at most `$4` as a mail's recipients are, its
//   thread the chat's.
// Each row carries the labels it rests on, which make the person's row's compartments.
export const INPUTS = `
  with members as (
    select g.entity, g.grp from unnest($2::text[], $3::text[]) as g (entity, grp)
  ),
  logged as materialized (
    select i.evidence_id, i.entity_id, i.occurred_at, i.direction, i.entity_role, i.channel, i.compartments
    from knowledge.interaction_log i
    join knowledge.entities e on e.id = i.entity_id and e.kind = 'person'
    where i.compartments <@ $1::text[] and i.direction in ('inbound', 'outbound') and i.occurred_at <= $6
  ),
  counted as materialized (
    select l.evidence_id,
      count(*) filter (where l.direction = 'outbound')::int as sent_to,
      count(*) filter (where l.direction = 'inbound' and l.entity_role = 'recipient')::int as also_to
    from logged l
    group by l.evidence_id
  ),
  said as (
    select l.evidence_id, l.entity_id, l.direction, l.entity_role, l.channel, m.id, m.sent_at as at,
      coalesce(m.thread_fp, m.id) as thread, l.compartments || m.compartments as labels
    from logged l
    join knowledge.messages m on m.evidence_id = l.evidence_id
    where m.compartments <@ $1::text[] and not m.held and not m.bulk and not m.restricting and m.sent_at <= $6
    union all
    select l.evidence_id, l.entity_id, l.direction, l.entity_role, l.channel, e.id, l.occurred_at,
      coalesce(e.thread_fp, e.id), l.compartments || e.compartments
    from logged l
    join vault.evidence_items e on e.id = l.evidence_id
    where l.channel = 'mail_headers' and e.compartments <@ $1::text[]
  ),
  mail as (
    select distinct on (coalesce(g.grp, l.entity_id), l.id)
      coalesce(g.grp, l.entity_id) as grp, l.entity_id, l.id,
      case l.direction when 'outbound' then 'out' else 'in' end as kind,
      l.at, l.thread,
      case l.direction when 'outbound' then c.sent_to else c.also_to + 1 end as n,
      case l.channel when 'chat' then 'chat' else 'email' end as channel,
      l.labels
    from said l
    join counted c on c.evidence_id = l.evidence_id
    left join members g on g.entity = l.entity_id
    where l.direction = 'outbound' or l.entity_role = 'sender'
    order by coalesce(g.grp, l.entity_id), l.id, l.entity_id
  ),
  met as (
    select distinct on (coalesce(g.grp, p.entity_id), v.id)
      coalesce(g.grp, p.entity_id) as grp, p.entity_id, v.id, 'meet' as kind, d.starts_at as at, null::text as thread,
      (select count(*) from knowledge.event_participants q join knowledge.entities k on k.id = q.entity_id and k.kind = 'person'
       where q.event_id = v.id and q.compartments <@ $1::text[])::int + 1 as n,
      'calendar' as channel,
      p.compartments || v.compartments || d.compartments as labels
    from knowledge.event_participants p
    join knowledge.events v on v.id = p.event_id
    join knowledge.event_details d on d.event_id = v.id
    join knowledge.entities e on e.id = p.entity_id and e.kind = 'person'
    left join members g on g.entity = p.entity_id
    where p.compartments <@ $1::text[] and v.compartments <@ $1::text[] and d.compartments <@ $1::text[]
      and not d.cancelled and d.starts_at is not null and d.starts_at <= $6
      and coalesce(d.owner_response, 'accepted') in ('accepted', 'tentative')
    order by coalesce(g.grp, p.entity_id), v.id, p.entity_id
  ),
  chatted as (
    select distinct on (coalesce(g.grp, l.entity_id), l.evidence_id, l.line)
      coalesce(g.grp, l.entity_id) as grp, l.entity_id, l.id,
      case l.direction when 'outbound' then 'out' else 'in' end as kind,
      l.occurred_at as at, l.thread_fp as thread, l.others as n, 'chat' as channel, l.compartments as labels
    from knowledge.chat_lines l
    join knowledge.entities e on e.id = l.entity_id and e.kind = 'person'
    left join members g on g.entity = l.entity_id
    where l.compartments <@ $1::text[] and l.occurred_at <= $6
    order by coalesce(g.grp, l.entity_id), l.evidence_id, l.line, l.entity_id
  )
  select x.grp, x.entity_id, x.id, x.kind, x.at, x.thread, x.n, x.channel, x.labels from (
    select * from mail where n <= $4
    union all
    select * from met where n <= $5
    union all
    select * from chatted where n <= $4
  ) x
  order by x.grp, x.at, x.id`;

export type InputRow = {
  grp: string;
  entity_id: string;
  id: string;
  kind: "out" | "in" | "meet";
  at: Date;
  thread: string | null;
  n: number;
  channel: "email" | "chat" | "calendar";
  labels: string[];
};

// The accounts within the audience of the people named (`$1`): a machine's or a function's mailbox,
// or the owner's own address, keeps its person out (get_self's contacts rule: by the stored kind, or
// by addressKind's list unless the owner ruled the address a person's). And the owner's own
// addresses within the audience.
export const ACCOUNTS = `
  select a.id, a.entity_id, a.kind, a.value_fp, a.compartments, a.value_enc,
    exists (select 1 from knowledge.identity_rulings r where r.a_fp = a.value_fp and r.verdict = 'person' and r.lifted_at is null) as person
  from knowledge.accounts a
  where a.entity_id = any($1::text[]) and a.compartments <@ $2::text[]
  order by a.id`;
export const OWNER_FPS = `
  select a.value_fp from knowledge.accounts a
  where a.entity_id = (${OWNER_ENTITY_ALIASED}) and a.compartments <@ $1::text[]`;

// The owner's confirmed closeness within the audience: a released owner_tie claim whose release is in force, newest by the release's ruling (read-ties.ts's order). A released
// claim's label is exactly `{own}`, so only an audience holding `own` reads one.
const CLOSENESS = `
  select c.id, c.compartments, c.content_enc
  from knowledge.claims c
  join policy.released_records() r on r.evidence_id = c.evidence_id
  where c.type = $2 and c.released and c.compartments <@ $1::text[]
  order by r.ruling_id collate "C" desc, c.id`;

// One person's warmth row as the build writes it.
export type WarmthRow = {
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
  channels: string[];
  tier: string;
  tier_source: string;
  dormant: boolean;
  compartments: string[];
};

export const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort(byText);
// Each label once, sorted, in the order first given.
export const distinctLabels = (labels: readonly (readonly string[])[]): string[][] => [
  ...new Map(labels.map((one) => [JSON.stringify(sorted(one)), sorted(one)])).values(),
];
type GroupInputs = {
  input: { messages: WarmthInput["messages"][number][]; meetings: WarmthInput["meetings"][number][] };
  labels: Set<string>;
};
const noInputs = (): GroupInputs => ({ input: { messages: [], meetings: [] }, labels: new Set<string>() });

// Who the audience's groups are, by its own rulings.
export async function audienceGroups(query: Query, audience: readonly string[]): Promise<ClientGroups> {
  return groupsFromRows(await query<GroupRulingRow>(RULINGS, [audience]));
}

// The owner's confirmed closeness of each group within the audience, with the claim's label.
export async function closenessOf(
  tx: Tx,
  audience: readonly string[],
  groups: ClientGroups,
): Promise<Map<string, { closeness: Closeness; labels: string[] }>> {
  const out = new Map<string, { closeness: Closeness; labels: string[] }>();
  const rows = await tx.query<{ id: string; compartments: string[]; content_enc: Sealed }>(CLOSENESS, [
    audience,
    OWNER_TIE_TYPE,
  ]);
  for (const row of rows) {
    const record = ClaimRecord.parse(JSON.parse(open(tx.keys, row, "knowledge.claims.content_enc", "throw")));
    const subject = record.claim.content.subject;
    const closeness = Closeness.safeParse(record.claim.content.fields.closeness);
    if (typeof subject !== "string" || !closeness.success) continue;
    const group = groups.idOf(subject);
    if (!out.has(group)) out.set(group, { closeness: closeness.data, labels: row.compartments });
  }
  return out;
}

// The owner's tier rulings within the audience, by group: a group any member of which a ruling reaches takes the newest such ruling's tier. Through the
// definer function, which reads only accounts within the audience (invariant 6).
async function rulingsOf(
  query: Query,
  audience: readonly string[],
  groups: ClientGroups,
): Promise<Map<string, { tier: RuledTier; at: Date }>> {
  const out = new Map<string, { tier: RuledTier; at: Date }>();
  const rows = await query<{ entity_id: string; tier: RuledTier; ruled_at: Date }>(
    "select entity_id, tier, ruled_at from policy.tier_rulings_in($1::text[]) order by entity_id",
    [audience],
  );
  for (const row of rows) {
    const group = groups.idOf(row.entity_id);
    const held = out.get(group);
    if (held === undefined || row.ruled_at > held.at) out.set(group, { tier: row.tier, at: row.ruled_at });
  }
  return out;
}

// The whole ranking of one clearance, computed straight from the rows within it as of `today`, as
// the per-audience build computed it: the reference the measurement compares the days' ranking
// with (warmth-measure.db.test.ts). Reads only; `today` is the clock warmthOf reads.
export async function computeWarmth(
  tx: Tx,
  given: readonly string[],
  options: { today: Date; rules?: WarmthRules },
): Promise<WarmthRow[]> {
  const audience = sorted(given);
  const rules = options.rules ?? warmthRules();
  const timeZone = (await ownerZoneOf(tx.query)) ?? "UTC";
  const groups = await audienceGroups(tx.query, audience);
  const joined = groups.joined;
  const rows = await tx.query<InputRow>(INPUTS, [
    audience,
    joined.map(([member]) => member),
    joined.map(([, group]) => group),
    rules.directMaxRecipients,
    rules.meetingMaxAttendees,
    options.today.toISOString(),
  ]);

  // Each group's inputs, and the labels they rest on.
  const byGroup = new Map<string, GroupInputs>();
  for (const row of rows) {
    const one = byGroup.get(row.grp) ?? noInputs();
    byGroup.set(row.grp, one);
    for (const label of row.labels) one.labels.add(label);
    if (row.kind === "meet") one.input.meetings.push({ at: stamp(row.at), attendees: row.n });
    else
      one.input.messages.push({
        at: stamp(row.at),
        direction: row.kind,
        recipients: row.n,
        thread: row.thread ?? row.id,
        channel: row.channel === "chat" ? "chat" : "email",
      });
  }

  const closeness = await closenessOf(tx, audience, groups);
  const ruled = await rulingsOf(tx.query, audience, groups);
  // A person the owner labelled takes the label's tier whatever the score, so one with no mail or
  // meeting the audience reads (someone the owner mostly texts) still has a row, from no rows; and so
  // does a person the owner ruled a tier for.
  for (const group of [...closeness.keys(), ...ruled.keys()]) if (!byGroup.has(group)) byGroup.set(group, noInputs());

  // A group any member of which is a machine's, a function's or the owner's own is no person here.
  const named = [...byGroup.keys()].flatMap((group) => groups.membersOf(group));
  const ownFps = new Set((await tx.query<{ value_fp: string }>(OWNER_FPS, [audience])).map((row) => row.value_fp));
  const accounts = await tx.query<{
    id: string;
    entity_id: string;
    kind: string;
    value_fp: string;
    compartments: string[];
    value_enc: Sealed;
    person: boolean;
  }>(ACCOUNTS, [named, audience]);
  const excluded = new Set<string>();
  // A ruled group's row also rests on the accounts within the audience that tie the ruling to it.
  const ruledLabels = new Map<string, Set<string>>();
  for (const account of accounts) {
    const group = groups.idOf(account.entity_id);
    if (ruled.has(group)) {
      const held = ruledLabels.get(group) ?? new Set<string>();
      ruledLabels.set(group, held);
      for (const label of account.compartments) held.add(label);
    }
    const value = open(tx.keys, account, "knowledge.accounts.value_enc", "throw");
    // A person keyed by a `tel:` key (a phone-only saved contact) is a person, never a machine's address, whatever addressKind reads of the key's form.
    const machine =
      (account.kind !== "email" && account.kind !== "shared") ||
      (!isPhoneKey(value) && addressKind(value, account.person ? "person" : null) !== "email");
    if (machine || ownFps.has(account.value_fp)) excluded.add(account.entity_id);
  }

  // The owner's ignore list: an ignored person takes no row and no rank slot.
  const [ignored] = await tx.query<{ ids: string[] }>("select policy.ignored_people_in($1::text[]) as ids", [audience]);
  for (const id of ignored?.ids ?? []) excluded.add(id);
  const people: (RankInput & { labels: Set<string> })[] = [];
  for (const [group, { input, labels }] of [...byGroup].sort(([a], [b]) => byText(a, b))) {
    if (groups.membersOf(group).some((member) => excluded.has(member))) continue;
    const closed = closeness.get(group);
    if (closed !== undefined) for (const label of closed.labels) labels.add(label);
    for (const label of ruledLabels.get(group) ?? []) labels.add(label);
    people.push({
      id: group,
      fields: warmthOf(input, rules, options.today.toISOString(), timeZone),
      closeness: closed?.closeness,
      ruledTier: ruled.get(group)?.tier,
      labels,
    });
  }
  const ranked = rankAudience(people, rules);

  return people.map((person) => {
    const tier = ranked.get(person.id);
    if (tier === undefined) throw new Error("warmth: a person without a tier");
    const { fields } = person;
    return {
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
    };
  });
}

// Removal.

// What a removal takes from warmth, under the beliefs lock, so no day build in flight writes after
// it (a second take in one transaction is a no-op): the days of every label that contains every
// compartment of one of these labels (removeDays), each such label marked removed so the next run
// counts it again. Only the days are read: a label that could not see a removed row keeps its days
// (invariant 6). How many days went.
export async function removeWarmth(query: Query, labels: readonly (readonly string[])[]): Promise<number> {
  const given = distinctLabels(labels.filter((one) => one.length > 0));
  if (given.length === 0) return 0;
  await query(BELIEFS_LOCK);
  return removeDays(query, given);
}

// The days of every label that contains every compartment of one of these labels, and
// `removed_at` on each such label's build row, so the next run counts it again. How many days went.
export async function removeDays(query: Query, labels: readonly (readonly string[])[]): Promise<number> {
  const given = distinctLabels(labels.filter((one) => one.length > 0));
  if (given.length === 0) return 0;
  const [row] = await query<{ n: number }>(
    `with labels as (select array(select jsonb_array_elements_text(j)) as label from jsonb_array_elements($1::jsonb) as j),
     gone as (delete from projections.warmth_days w where exists (select 1 from labels l where w.compartments @> l.label) returning 1),
     marked as (update projections.warmth_day_builds b set removed_at = now() where exists (select 1 from labels l where b.compartments @> l.label) returning 1)
     select (select count(*) from gone)::int as n`,
    [JSON.stringify(given)],
  );
  return row?.n ?? 0;
}

// The same, for what a dry run counts.
export async function countDays(query: Query, labels: readonly (readonly string[])[]): Promise<number> {
  const given = distinctLabels(labels.filter((one) => one.length > 0));
  if (given.length === 0) return 0;
  const [row] = await query<{ n: number }>(
    `with labels as (select array(select jsonb_array_elements_text(j)) as label from jsonb_array_elements($1::jsonb) as j)
     select count(*)::int as n from projections.warmth_days w where exists (select 1 from labels l where w.compartments @> l.label)`,
    [JSON.stringify(given)],
  );
  return row?.n ?? 0;
}
