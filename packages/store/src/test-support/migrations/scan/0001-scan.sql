-- A table of every type the plaintext scan reads, and one it does not, for the scan's own test.
grant usage on schema policy to pi_admin;
create schema scan;
grant usage on schema scan to pi_admin;
create table scan.things (
  id text primary key,
  plain text,
  short varchar(200),
  list text[],
  doc jsonb,
  encoded jsonb,
  clean text,
  number integer
);
alter table scan.things enable row level security;
alter table scan.things force row level security;
create policy pi_admin_all on scan.things for all to pi_admin using (true) with check (true);
grant select, insert, update, delete on scan.things to pi_admin;
