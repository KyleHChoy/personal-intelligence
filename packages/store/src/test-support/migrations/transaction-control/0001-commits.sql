-- A file that commits in the middle.
create schema fixture_transaction_control;
commit;
create table fixture_transaction_control.t (id int);
