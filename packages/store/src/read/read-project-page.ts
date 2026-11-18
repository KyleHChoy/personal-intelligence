// What a project's card and timeline show beyond its facts: the messages and people its evidence
// holds. Computed at read from claims, never stored. The evidence of a project is what the owner's
// anchor put in it (its thread's messages and the claims bound to it) and every item with a project
// fact naming it, which code found by its own rule. Nothing is matched
// by a name here, so a read makes no link. Every row runs under the caller's token.
import { byText } from "../core/db.ts";
import type { Ctx } from "../core/read-ctx.ts";
import { groupWho } from "./read-group-who.ts";
import { loadGroups } from "./read-groups.ts";
import { mailOf } from "./read-tools.ts";

const PROJECT_FACT_TYPES = "('project.status', 'project.decision', 'project.next_step')";

// A message's or a chat's alone: an agent's finding is no evidence the project's people can be read
// from, and an item of either holds no released claim. A held message is no one's evidence.
const projectEvidence = (projects: string): string => `
  select e.evidence_id from (
    select c.evidence_id from knowledge.claims c join knowledge.claim_entities n on n.claim_id = c.id
      where n.entity_id = any(${projects}) and c.type in ${PROJECT_FACT_TYPES}
    union
    select c.evidence_id from knowledge.claims c join knowledge.project_bindings b on b.claim_id = c.id
      where b.project_id = any(${projects}) and b.undone_at is null
    union
    select m.evidence_id from knowledge.messages m join knowledge.project_anchors a
        on a.anchor_fp = m.thread_fp and a.compartments = m.compartments
      where a.project_id = any(${projects}) and a.kind = 'email_thread' and a.lifted_at is null
  ) e
  where exists (select 1 from knowledge.messages m where m.evidence_id = e.evidence_id and not m.held)
    or exists (select 1 from knowledge.captures k where k.evidence_id = e.evidence_id)`;

// A timeline's mail of a project, as a person's by the same columns and window.
export const projectTimelineMail = (at: string): string => `
  with mail as materialized (
    select m.id, m.sent_at from knowledge.messages m
    where m.evidence_id in (${projectEvidence("$1")})
      and not m.held and m.sent_at <= ${at}($3) and ($2::float8 is null or m.sent_at >= ${at}($2))
  )
  select m.id, m.sent_at, m.direction, m.subject_enc, m.thread_id_enc, m.compartments, m.evidence_id
  from knowledge.messages m
  where m.id in (select mail.id from mail order by mail.sent_at desc, mail.id limit $4)
  order by m.sent_at desc, m.id`;

const PROJECT_MAIL = `
  select count(*) filter (where m.direction = 'inbound')::int as inbound,
    count(*) filter (where m.direction = 'outbound')::int as outbound,
    min(m.sent_at) as first_at, max(m.sent_at) as last_at
  from knowledge.messages m
  where m.evidence_id in (${projectEvidence("$1")}) and not m.held`;

// The people of that evidence: who took part in its messages, whom a chat in it was with, and whom a
// project fact names. An item touching more than PROJECT_ITEM_PEOPLE people, a mailing, counts for none
// of them, so a status mail to sixty does not crowd out who works on it. The caller's own rows alone
// count them. Withheld people, the owner's other
// addresses among them, are left out by the rule every reader holds to.
const PROJECT_PEOPLE = `
  with evidence as materialized (${projectEvidence("$1")}),
  touched as (
    select i.evidence_id, i.entity_id from knowledge.interaction_log i
      where i.evidence_id in (select evidence_id from evidence)
    union
    select c.evidence_id, n.entity_id from knowledge.claims c join knowledge.claim_entities n on n.claim_id = c.id
      where c.evidence_id in (select evidence_id from evidence)
        and (c.type = 'activity.messaged' or c.type in ${PROJECT_FACT_TYPES})
  )
  select t.entity_id, count(*)::int as items
  from touched t join knowledge.entities e on e.id = t.entity_id
  where e.kind = 'person' and not policy.entity_withheld(t.entity_id)
    and t.evidence_id in (select x.evidence_id from touched x group by x.evidence_id having count(*) <= $2)
  group by t.entity_id
  order by t.entity_id collate "C"`;

const PAGE_PEOPLE = 50;
const PROJECT_ITEM_PEOPLE = 12;

// A person by their group, most items first, ties by id.
export async function projectPage(ctx: Ctx, project: string) {
  const [mail] = await ctx.run<{ inbound: number; outbound: number; first_at: Date | null; last_at: Date | null }>(
    PROJECT_MAIL,
    [[project]],
  );
  const rows = await ctx.run<{ entity_id: string; items: number }>(PROJECT_PEOPLE, [[project], PROJECT_ITEM_PEOPLE]);
  const groups = await loadGroups(ctx);
  const counts = new Map<string, number>();
  for (const row of rows) {
    const id = groups.idOf(row.entity_id);
    counts.set(id, (counts.get(id) ?? 0) + row.items);
  }
  const ids = [...counts]
    .sort((a, b) => b[1] - a[1] || byText(a[0], b[0]))
    .slice(0, PAGE_PEOPLE)
    .map(([id]) => id);
  const who = await groupWho(ctx, groups, ids);
  return {
    people: ids.flatMap((id) => who.get(id) ?? []),
    mail: mailOf(mail),
  };
}
