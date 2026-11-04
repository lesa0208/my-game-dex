-- M0: private.set_updated_at().
begin;
create extension if not exists pgtap with schema extensions;
select plan(7);

select is((select prosecdef from pg_proc where oid = 'private.set_updated_at()'::regprocedure), false, 'set_updated_at is not SECURITY DEFINER');
select is((select proconfig from pg_proc where oid = 'private.set_updated_at()'::regprocedure), array['search_path=""'], 'set_updated_at pins an empty search_path');
select is(has_function_privilege('authenticated', 'private.set_updated_at()', 'execute'), false, 'authenticated can not call set_updated_at directly');

create table public.__u (id int primary key, note text, updated_at timestamptz not null default '2000-01-01');
create trigger set_updated_at before update on public.__u
  for each row execute function private.set_updated_at();
insert into public.__u (id, note) values (1, 'a');
select is((select updated_at from public.__u where id = 1), '2000-01-01'::timestamptz, 'the trigger does not fire on insert');

update public.__u set note = 'b' where id = 1;
select is((select updated_at from public.__u where id = 1), now(), 'the trigger sets updated_at on update');

update public.__u set updated_at = '1999-01-01' where id = 1;
select is((select updated_at from public.__u where id = 1), now(), 'a client can not forge updated_at');

-- Firing the trigger needs no EXECUTE or USAGE for the acting role
grant update (note), select on public.__u to authenticated;
set local role authenticated;
select lives_ok($$update public.__u set note = 'c' where id = 1$$, 'the trigger fires for a role with no privileges on the function');
reset role;

select * from finish();
rollback;
