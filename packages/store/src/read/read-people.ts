import type { EventId, KnownVia, MessageId, WarmthLine } from "@intelligence/contracts/personal";
import { byText, stamp } from "../core/db.ts";
import type { ClientGroups, Ctx } from "../core/read-ctx.ts";
import { DIRECT_INTERACTION, OWNER_ENTITY_ALIASED } from "../core/statements.ts";
import { WROTE_TO_MAX_RECIPIENTS } from "./read-fragments.ts";
import { warmthOf } from "./read-warmth.ts";
import { whoOf } from "./read-who.ts";

// People reads: how the owner knows a person, read at each call from the rows the caller's token
// returns and nothing else, so a row it cannot see changes no count, ref or order; one statement per
// part, for one person.

// ---------------------------------------------------------------------------------------------
// How known
// ---------------------------------------------------------------------------------------------

// The group's (`$1`) first direct message the token returns, never a held one, found in full
// first by the members' rows and then cut: a cut beside the messages would let the planner walk
// every message in time order.
const FIRST_THREAD = `
  with mail as materialized (
    select m.id, m.sent_at, m.evidence_id
    from knowledge.messages m
    where m.evidence_id in (
      select i.evidence_id from knowledge.interaction_log i
      where i.entity_id = any($1) and ${DIRECT_INTERACTION})
      and not m.held
  )
  select mail.id, mail.sent_at, mail.evidence_id from mail
  order by mail.sent_at, mail.id
  limit 1`;

// The meetings a member of the group (`$1`) was at that started by `$2`, were not cancelled, and
// that the owner did not decline or leave unanswered: how many, and the first.
const SHARED_MEETINGS = `
  with met as materialized (
    select v.id, d.starts_at, v.evidence_id
    from knowledge.events v
    join knowledge.event_details d on d.event_id = v.id
    where v.id in (select p.event_id from knowledge.event_participants p where p.entity_id = any($1))
      and not d.cancelled and d.starts_at <= $2
      and coalesce(d.owner_response, 'accepted') in ('accepted', 'tentative')
  )
  select (select count(*) from met)::int as meetings, f.id, f.starts_at, f.evidence_id
  from (select met.id, met.starts_at, met.evidence_id from met order by met.starts_at, met.id limit 1) f
  order by f.id`;

// An organization with a domain that both an account of the owner's and one of a member's are on,
// the lowest by id: a shared mail domain, never a role.
const SHARED_ORGANIZATION = `
  select d.entity_id
  from knowledge.domains d
  where d.domain_fp in (select a.domain_fp from knowledge.accounts a where a.entity_id = any($1))
    and d.domain_fp in (
      select a.domain_fp from knowledge.accounts a
      where a.entity_id = (${OWNER_ENTITY_ALIASED}))
  order by d.entity_id, d.id
  limit 1`;

// The people on the same messages as a member of the group (`$1`), each person or group (`$2`
// members, `$3` their groups' ids) once: on messages that are neither held nor bulk and that
// name at most `$4` people, so a send to a list counts for none. The three most often there, then
// the latest, then by id; each with its latest such message.
const CO_RECIPIENTS = `
  with mine as materialized (
    select i.evidence_id
    from knowledge.interaction_log i
    join knowledge.messages m on m.evidence_id = i.evidence_id
    where i.entity_id = any($1) and not m.held and not m.bulk
    group by i.evidence_id
  ),
  small as materialized (
    select i.evidence_id from knowledge.interaction_log i
    where i.evidence_id in (select mine.evidence_id from mine)
    group by i.evidence_id
    having count(distinct i.entity_id) <= $4
  ),
  co as (
    select distinct k.entity_id, m.id, m.sent_at, m.evidence_id
    from knowledge.interaction_log i
    join knowledge.messages m on m.evidence_id = i.evidence_id
    left join unnest($2::text[], $3::text[]) as g (entity, grp) on g.entity = i.entity_id
    cross join lateral (select coalesce(g.grp, i.entity_id) as entity_id) as k
    where i.evidence_id in (select small.evidence_id from small)
      and not (i.entity_id = any($1))
      and (select e.kind from knowledge.entities e where e.id = i.entity_id) = 'person'
  )
  select t.entity_id, t.messages, t.last_at, t.id, t.evidence_id from (
    select co.entity_id, count(*)::int as messages, max(co.sent_at) as last_at,
      (array_agg(co.id order by co.sent_at desc, co.id))[1] as id,
      (array_agg(co.evidence_id order by co.sent_at desc, co.id))[1] as evidence_id
    from co
    group by co.entity_id
  ) t
  order by t.messages desc, t.last_at desc, t.entity_id
  limit 3`;

// How the owner knows the group whose visible members are `members`, and the evidence id of each
// message or meeting it names, which the read log records as shown.
async function knownViaOf(
  ctx: Ctx,
  groups: ClientGroups,
  members: readonly string[],
  now: Date,
): Promise<{ value: KnownVia; shown: string[] }> {
  const list = [...members];
  const [first] = await ctx.run<{ id: string; sent_at: Date; evidence_id: string }>(FIRST_THREAD, [list]);
  const [met] = await ctx.run<{ meetings: number; id: string; starts_at: Date; evidence_id: string }>(SHARED_MEETINGS, [
    list,
    now.toISOString(),
  ]);
  const [shared] = await ctx.run<{ entity_id: string }>(SHARED_ORGANIZATION, [list]);
  const joined = groups.joined;
  const co = await ctx.run<{ entity_id: string; messages: number; last_at: Date; id: string; evidence_id: string }>(
    CO_RECIPIENTS,
    [list, joined.map(([member]) => member), joined.map(([, group]) => group), WROTE_TO_MAX_RECIPIENTS + 1],
  );
  // One fixed read of who they are, whatever was found, so the statements sent never turn on it. A
  // co-recipient group is named as its id's member is.
  const who = await whoOf(
    ctx,
    [...(shared === undefined ? [] : [shared.entity_id]), ...co.map((row) => row.entity_id)],
    { fixed: true },
  );
  const organization = shared === undefined ? undefined : who.get(shared.entity_id);
  const coRecipients = co.flatMap((row) => {
    const one = who.get(row.entity_id);
    return one === undefined
      ? []
      : [
          {
            who: one,
            messages: row.messages,
            lastAt: stamp(row.last_at),
            message: row.id as MessageId,
            evidence: row.evidence_id,
          },
        ];
  });
  const value: KnownVia = {
    firstThread: first === undefined ? null : { at: stamp(first.sent_at), message: first.id as MessageId },
    meetings:
      met === undefined || met.starts_at === null
        ? null
        : { count: met.meetings, firstAt: stamp(met.starts_at), first: met.id as EventId },
    sharedMailDomain: organization ?? null,
    coRecipients: coRecipients.map(({ evidence: _evidence, ...one }) => one),
  };
  const shown = [
    first?.evidence_id,
    value.meetings === null ? undefined : met?.evidence_id,
    ...coRecipients.map((one) => one.evidence),
  ].filter((one): one is string => one !== undefined);
  return { value, shown: [...new Set(shown)].sort(byText) };
}

// get_entity's card parts for one group (`id`, its visible `members`): its warmth line, when its
// audience holds one, and how the owner knows it, and the evidence ids of
// what knownVia names.
export async function cardOf(
  ctx: Ctx,
  groups: ClientGroups,
  id: string,
  members: readonly string[],
  now: Date,
): Promise<{ warmth?: WarmthLine; knownVia: KnownVia; shown: string[] }> {
  const warmth = (await warmthOf(ctx, groups, [id])).get(id);
  const known = await knownViaOf(ctx, groups, members, now);
  return { ...(warmth === undefined ? {} : { warmth }), knownVia: known.value, shown: known.shown };
}
