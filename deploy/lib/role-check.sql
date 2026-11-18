with s as (
  select current_setting('pi.role_prefix') as prefix, current_setting('pi.role_bootstrap') as bootstrap,
    current_setting('pi.role_prefix') || 'migrator' as migrator
),
logins as (
  select s.prefix || n as name
  from s, unnest(array['admin', 'writer', 'reader', 'pipeline', 'work', 'restricted', 'proxy', 'notify']) as n
),
known as (
  select name from logins
  union all
  select s.prefix || 'owner' from s
),
grants as (
  select r.rolname as role, m.rolname as member, a.admin_option as admin, a.inherit_option as inherit,
    a.set_option as set
  from pg_auth_members a
  join pg_roles r on r.oid = a.roleid
  join pg_roles m on m.oid = a.member
)
select count(*) from (
  select l.name from logins l
  where not exists (
    select from pg_roles r
    where r.rolname = l.name and r.rolcanlogin
      and not (r.rolsuper or r.rolcreaterole or r.rolcreatedb or r.rolreplication or r.rolbypassrls))
  union all
  select s.prefix || 'owner' from s
  where not exists (
    select from pg_roles r
    where r.rolname = s.prefix || 'owner' and not r.rolcanlogin
      and not (r.rolsuper or r.rolcreaterole or r.rolcreatedb or r.rolreplication or r.rolbypassrls))
  union all
  select s.bootstrap from s
  where not exists (
    select from pg_roles r
    where r.rolname = s.bootstrap and not r.rolcanlogin and not (r.rolsuper or r.rolreplication or r.rolbypassrls))
  union all
  select g.role from grants g, s
  where g.member = s.bootstrap and g.role not in (select name from known)
  union all
  select g.role from grants g, s
  where (g.role in (select name from known) or g.role = s.bootstrap or g.member in (select name from logins))
    and g.member <> s.migrator
    and not (
      (g.admin and not g.inherit and not g.set
        and ((g.member = s.bootstrap and g.role in (select name from known)) or g.role = s.bootstrap))
      or (g.member = s.bootstrap and g.role = s.prefix || 'owner' and g.set and not g.inherit and not g.admin))
  union all
  select s.migrator from s
  where exists (
    select from pg_roles r
    where r.rolname = s.migrator
      and (r.rolsuper or r.rolcreaterole or r.rolcreatedb or r.rolreplication or r.rolbypassrls))
  union all
  select g.role from grants g, s
  where (g.member = s.migrator or g.role = s.migrator)
    and not (g.member = s.migrator and g.role = s.prefix || 'owner' and g.set and not g.inherit and not g.admin)
    and not (g.role = s.migrator and g.admin and not g.inherit and not g.set
      and g.member <> s.bootstrap and g.member not in (select name from known))
) as unexpected;
