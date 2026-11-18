// The owner's live names for people, as every read that names a person reads them: a row names an entity when it holds the entity's id (the person the owner named, its anchor), when the entity holds an
// address of the anchor's identity group as the owner's rulings in force make it now (the group is resolved at read, so a split leaves the name with the anchor's half alone), or by the fingerprint of an
// account of theirs (a record that later holds the person's address). The group's addresses are the anchor's own and those the owner's live `same` rulings join to them, never through or to an address the
// owner marked shared, as read-groups.ts's groups are made. Each name row's are walked once, in a step of their own before any entity is joined: joined first, the walk ran again for every entity asked.
// `entities` is the condition on `e`, the entities asked; `more` adds terms on `n`. One row for each entity and name row, with the sealed name as `value_enc`, opened under knowledge.person_names' `name_enc`.
// Every caller reads it under its own row policy, the rulings and accounts included.
const SHARED =
  "exists (select 1 from knowledge.identity_rulings s where s.lifted_at is null and s.verdict = 'shared' and s.a_fp = l.fp)";
export const hisNames = (entities: string, more = ""): string => `
    with named as materialized (
      select n.id, n.compartments, n.name_enc, n.entity_ids, n.value_fps, grouped.fps
      from knowledge.person_names n
      cross join lateral (
        select (
          with recursive linked (fp) as (
            select a.value_fp from knowledge.accounts a where a.entity_id = any (n.entity_ids)
            union
            select case when g.a_fp = l.fp then g.b_fp else g.a_fp end
            from linked l
            join knowledge.identity_rulings g on g.lifted_at is null and g.verdict = 'same' and l.fp in (g.a_fp, g.b_fp)
            where not ${SHARED})
          select coalesce(array_agg(distinct l.fp order by l.fp), '{}') from linked l where not ${SHARED}) as fps
      ) grouped
      where n.lifted_at is null${more})
    select e.id as entity_id, n.id, n.compartments, n.name_enc as value_enc
    from named n
    join knowledge.entities e on (${entities})
      and (e.id = any (n.entity_ids)
        or exists (select 1 from knowledge.accounts a where a.entity_id = e.id and (a.value_fp = any (n.value_fps) or a.value_fp = any (n.fps))))`;
