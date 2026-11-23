-- CI proof (M14b): deliberately malformed SQL. Never merge.
begin;
select plan(1);
select ok(true;
select * from finish();
rollback;
