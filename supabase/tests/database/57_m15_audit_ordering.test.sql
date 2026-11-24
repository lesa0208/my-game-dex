-- M15: audit events keep the order they were recorded in (20261214100000_m15_audit_ordering).
-- The seq column, its sequence, trigger and constraints; that no API role or the importer can use
-- them; that the append-only rules still hold; and that every reader that lists audit events (the
-- audit log, account and staff histories, a record's history; the batch trail is in 55) lists
-- events recorded together in the order they were written, whatever their ids, places rows from
-- before the migration (seq null) by their old order, and pages without repeats or gaps.
--
-- Deterministic by construction: events recorded together are given ids in the reverse of their
-- insertion order, so an order by id would put every pair the wrong way round. Rows from before
-- the migration are simulated by inserting them with the trigger off and the NOT VALID check
-- briefly dropped, then both are put back and checked. One rolled-back transaction, synthetic
-- accounts and records only.
begin;
create extension if not exists pgtap with schema extensions;
select plan(44);

create function pg_temp.session(p_user uuid, p_verified timestamptz) returns jsonb language plpgsql as $mfa$
begin
  insert into auth.sessions (id, user_id, aal, factor_id, created_at, updated_at) values (p_user, p_user, 'aal2', p_user, now(), now()) on conflict (id) do nothing;
  insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
    select p_user, p_user, 'Ordering factor', 'totp', 'verified', now() - interval '3 days', now()
    where not exists (select 1 from auth.mfa_factors where id = p_user);
  if not exists (select 1 from auth.mfa_amr_claims where session_id = p_user) then
    insert into auth.mfa_amr_claims (id, session_id, authentication_method, created_at, updated_at)
    values (gen_random_uuid(), p_user, 'totp', p_verified, p_verified);
  end if;
  return jsonb_build_object('sub', p_user, 'role', 'authenticated', 'aal', 'aal2', 'session_id', p_user);
end $mfa$;
create function pg_temp.u(s text) returns uuid language sql immutable as $$ select ('00000000-0000-0000-0000-0000000000' || s)::uuid $$;
-- An event id whose order is chosen by the test: larger n, larger id.
create function pg_temp.eid(n int) returns uuid language sql immutable as $$ select ('01900000-0000-7000-8000-' || lpad(to_hex(n), 12, '0'))::uuid $$;
create function pg_temp.as_user(p_actor text, p_sql text) returns text language plpgsql as $t$
declare r text;
begin
  perform set_config('request.jwt.claims', pg_temp.session(pg_temp.u(p_actor), now())::text, true);
  perform set_config('role', 'authenticated', true);
  execute p_sql into r;
  perform set_config('role', 'none', true);
  return coalesce(r, '');
exception when others then
  perform set_config('role', 'none', true);
  return 'error: ' || sqlerrm;
end $t$;
create function pg_temp.as_role(p_role text, p_sql text) returns text language plpgsql as $t$
begin
  perform set_config('role', p_role, true);
  execute p_sql;
  perform set_config('role', 'none', true);
  return 'ok';
exception when others then
  perform set_config('role', 'none', true);
  return 'error: ' || sqlerrm;
end $t$;

-- a1: administrator. e1: catalog editor. f1: the actor of the audit-log events. c1, c2: their targets.
insert into auth.users (id, aud, role, email, email_confirmed_at, instance_id)
select pg_temp.u(s), 'authenticated', 'authenticated', s || '-ord@example.test', now(), '00000000-0000-0000-0000-000000000000'
from unnest(array['a1', 'e1', 'f1', 'c1', 'c2']) as s;
update public.profiles set handle = 'ord_' || right(id::text, 2), handle_changed_at = now()
where id in (select pg_temp.u(s) from unnest(array['a1', 'e1', 'f1', 'c1', 'c2']) s);
insert into public.staff_roles (user_id, role) values (pg_temp.u('a1'), 'admin'), (pg_temp.u('e1'), 'catalog_editor');

create function pg_temp.log(p_args text) returns jsonb language sql as $$
  select pg_temp.as_user('a1', format('select public.get_audit_log(%s)::text', p_args))::jsonb $$;
create function pg_temp.reasons(p jsonb) returns text language sql immutable as $$
  select string_agg(e ->> 'reason', ',' order by n) from jsonb_array_elements(p) with ordinality x(e, n) $$;
-- f1's audit log walked in pages of p_size, each page after the last event of the one before.
create function pg_temp.walk(p_size int) returns text language plpgsql as $w$
declare v_page jsonb; v_before uuid; v_all text[] := '{}'; v_pages int := 0;
begin
  loop
    v_page := pg_temp.log(format('%s, %L, null, null, null, %L', p_size, v_before, 'ord_f1'));
    exit when jsonb_array_length(v_page) = 0;
    v_pages := v_pages + 1;
    v_all := v_all || array(select e ->> 'reason' from jsonb_array_elements(v_page) with ordinality x(e, n) order by n);
    v_before := (v_page -> -1 ->> 'id')::uuid;
    exit when v_pages > 50;
  end loop;
  return array_to_string(v_all, ',');
end $w$;

-- ---------------------------------------------------------------------------
-- 1. The column, its sequence, trigger and constraints
-- ---------------------------------------------------------------------------
select is((select format_type(atttypid, atttypmod) || ' notnull=' || attnotnull || ' default=' || atthasdef from pg_attribute
           where attrelid = 'private.audit_events'::regclass and attname = 'seq'), 'bigint notnull=false default=false',
  'seq is a nullable bigint with no default: older rows keep null, new ones get theirs from the trigger');
select is((select pg_get_userbyid(c.relowner) || ' ' || s.seqtypid::regtype || ' min=' || s.seqmin || ' cycle=' || s.seqcycle
           from pg_sequence s join pg_class c on c.oid = s.seqrelid where s.seqrelid = 'private.audit_events_seq'::regclass),
  'postgres bigint min=1 cycle=false', 'the sequence is postgres''s, a bigint from 1 that never cycles');
select is((select d.refobjid::regclass || '.' || a.attname from pg_depend d join pg_attribute a on a.attrelid = d.refobjid and a.attnum = d.refobjsubid
           where d.objid = 'private.audit_events_seq'::regclass and d.deptype = 'a'), 'private.audit_events.seq', 'and is owned by the column');
select is((select string_agg(tgname || '=' || tgenabled::text, ',' order by tgname) from pg_trigger where tgrelid = 'private.audit_events'::regclass and not tgisinternal),
  'audit_events_assign_seq=O,audit_events_no_truncate=O,audit_events_no_update_or_delete=O', 'the seq trigger and both append-only triggers are enabled');
select is((select string_agg(conname || ':' || convalidated, ',' order by conname) from pg_constraint
           where conrelid = 'private.audit_events'::regclass and conname like 'audit_events_seq%'),
  'audit_events_seq_positive:true,audit_events_seq_recorded:false', 'seq is positive, and required of new rows without being checked against older ones');
select is((select indisunique from pg_index where indexrelid = 'private.audit_events_seq_key'::regclass), true, 'seq is unique');

-- No API role, the importer or PUBLIC can use the sequence or the trigger function.
select is((select count(*)::int from unnest(array['anon', 'authenticated', 'service_role', 'catalog_importer', 'public']) r,
           unnest(array['usage', 'select', 'update']) p
           where r <> 'public' and has_sequence_privilege(r, 'private.audit_events_seq', p)), 0, 'no API role or the importer has any privilege on the sequence');
select is((select relacl::text from pg_class where oid = 'private.audit_events_seq'::regclass), '{postgres=rwU/postgres}', 'only its owner has any');
select is((select count(*)::int from unnest(array['anon', 'authenticated', 'service_role', 'catalog_importer']) r
           where has_function_privilege(r, 'private.audit_events_assign_seq()', 'execute')), 0, 'or may execute the trigger function');
select is(pg_temp.as_role('authenticated', $$select nextval('private.audit_events_seq')$$), 'error: permission denied for schema private', 'a signed-in user can''t draw a number');
select is(pg_temp.as_role('service_role', $$select setval('private.audit_events_seq', 1)$$), 'error: permission denied for schema private', 'or the service role reset the sequence');
select is((select count(*)::int from unnest(array['anon', 'authenticated', 'service_role', 'catalog_importer']) r,
           unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']) p
           where has_table_privilege(r, 'private.audit_events', p)), 0, 'and none has any privilege on the table, as before');
select is((select relrowsecurity from pg_class where oid = 'private.audit_events'::regclass), true, 'row-level security stays enabled');

-- ---------------------------------------------------------------------------
-- 2. Assignment, and the append-only rules
-- ---------------------------------------------------------------------------
create temp table w as select i, private.record_audit(pg_temp.u('f1'), 'operator_action', null, 'w' || i) as id from generate_series(1, 3) i;
select is((select string_agg(e.seq::text, ',' order by w.i) = string_agg(e.seq::text, ',' order by e.seq) from w join private.audit_events e using (id)), true,
  'three events written by one statement through record_audit get increasing numbers in the order they were written');
select is((select count(distinct e.occurred_at)::int from w join private.audit_events e using (id)), 1, 'and share their time, as every event of a transaction does');
insert into private.audit_events (actor_id, action, reason, seq) values (null, 'operator_action', 'ord supplied seq', 999999);
select is((select seq < 999999 and seq > (select max(e.seq) from w join private.audit_events e using (id)) from private.audit_events where reason = 'ord supplied seq'), true,
  'a number the writer supplies is replaced by the next one');
select throws_ok($$update private.audit_events set seq = 1 where reason = 'w1'$$, 'P0001', 'audit events are append-only', 'a number can''t be changed afterwards');
select throws_ok($$delete from private.audit_events where reason = 'w1'$$, 'P0001', 'audit events are append-only', 'nor an event deleted');
select throws_ok('truncate private.audit_events', 'P0001', 'audit events are append-only', 'nor the table truncated');
select throws_ok($$set local session_replication_role = replica; insert into private.audit_events (actor_id, action, reason) values (null, 'operator_action', 'ord no trigger')$$,
  '23514', null, 'a new row without a number is refused, even with triggers off');
reset session_replication_role;
create function pg_temp.fail_audit() returns trigger language plpgsql as $$ begin raise exception 'audit storage failed'; end $$;
create trigger zz_fail_audit after insert on private.audit_events for each row execute function pg_temp.fail_audit();
select throws_ok($$select private.record_audit(pg_temp.u('f1'), 'operator_action', null, 'ord fails')$$, 'P0001', 'audit storage failed', 'a failed audit write still fails its caller');
drop trigger zz_fail_audit on private.audit_events;

-- ---------------------------------------------------------------------------
-- 3. The audit log: recorded together, in different transactions, and from before the migration
-- ---------------------------------------------------------------------------
-- Rows from before the migration: no number. h0 shares the current transaction's time, h1 and h2
-- an hour earlier (h1 with the smaller id). The trigger and the check are put back straight after.
alter table private.audit_events disable trigger audit_events_assign_seq;
alter table private.audit_events drop constraint audit_events_seq_recorded;
insert into private.audit_events (id, occurred_at, actor_id, action, reason) values
  (pg_temp.eid(1), now() - interval '1 hour', pg_temp.u('f1'), 'operator_action', 'h1'),
  (pg_temp.eid(2), now() - interval '1 hour', pg_temp.u('f1'), 'operator_action', 'h2'),
  (pg_temp.eid(3), now(), pg_temp.u('f1'), 'operator_action', 'h0');
alter table private.audit_events add constraint audit_events_seq_recorded check (seq is not null) not valid;
alter table private.audit_events enable trigger audit_events_assign_seq;
select is((select string_agg(reason || '=' || coalesce(seq::text, 'null'), ',' order by reason) from private.audit_events where reason in ('h0', 'h1', 'h2')),
  'h0=null,h1=null,h2=null', 'setup: three events from before the migration, without a number');
select is((select string_agg(tgname || '=' || tgenabled::text, ',' order by tgname) from pg_trigger where tgrelid = 'private.audit_events'::regclass and not tgisinternal)
          || ' ' || (select convalidated::text from pg_constraint where conname = 'audit_events_seq_recorded'),
  'audit_events_assign_seq=O,audit_events_no_truncate=O,audit_events_no_update_or_delete=O false', 'setup: the trigger and the check are back as the migration left them');
-- Two other transactions, as their times: d2 (30 minutes ago) written before d1 (45 minutes ago).
insert into private.audit_events (id, occurred_at, actor_id, action, reason) values (pg_temp.eid(20), now() - interval '30 minutes', pg_temp.u('f1'), 'operator_action', 'd2');
insert into private.audit_events (id, occurred_at, actor_id, action, reason) values (pg_temp.eid(21), now() - interval '45 minutes', pg_temp.u('f1'), 'operator_action', 'd1');
-- Five recorded together, after w1 to w3, each with a smaller id than the one before.
insert into private.audit_events (id, actor_id, action, reason) values
  (pg_temp.eid(105), pg_temp.u('f1'), 'operator_action', 't1'), (pg_temp.eid(104), pg_temp.u('f1'), 'operator_action', 't2'),
  (pg_temp.eid(103), pg_temp.u('f1'), 'operator_action', 't3'), (pg_temp.eid(102), pg_temp.u('f1'), 'operator_action', 't4'),
  (pg_temp.eid(101), pg_temp.u('f1'), 'operator_action', 't5');

create temp table expected as select 't5,t4,t3,t2,t1,w3,w2,w1,h0,d2,d1,h2,h1'::text as x1;
select is(pg_temp.reasons(pg_temp.log(format('100, null, null, null, null, %L', 'ord_f1'))), (select x1 from expected),
  'newest first: events recorded together in reverse order of writing, whatever their ids; others by time; older rows by time, then id');
select is((select string_agg(reason, ',' order by id desc) from private.audit_events where reason in ('t1', 't2', 't3', 't4', 't5')), 't1,t2,t3,t4,t5',
  'the ids alone would have put the five the wrong way round');
select is(pg_temp.reasons(pg_temp.log(format('100, null, null, null, null, %L', 'ord_f1'))) like '%h0,d2%', true,
  'an older row at the same time as new ones comes after them, newest first (no number: before them)');
select is(pg_temp.walk(1), (select x1 from expected), 'paged one at a time: every event once, in the same order');
select is(pg_temp.walk(2), (select x1 from expected), 'two at a time: the same');
select is(pg_temp.walk(5), (select x1 from expected), 'five at a time: the same, across older rows and new ones');
select is(pg_temp.reasons(pg_temp.log(format('3, %L, null, null, null, %L', (select id from private.audit_events where reason = 't3'), 'ord_f1'))), 't2,t1,w3',
  'a page after an event recorded with others starts with the next one written before it');
select is(pg_temp.reasons(pg_temp.log(format('3, %L, null, null, null, %L', pg_temp.eid(3), 'ord_f1'))), 'd2,d1,h2', 'after an older row, the rows before it by time');
select is(pg_temp.reasons(pg_temp.log(format('2, %L, null, null, null, %L', pg_temp.eid(2), 'ord_f1'))), 'h1', 'and among older rows, by id');
select is(pg_temp.log(format('10, %L', gen_random_uuid()))::text, '[]', 'a cursor that names no event gives an empty page');
select is(pg_temp.reasons(pg_temp.log(format('2, %L, null, null, null, %L', (select id from private.audit_events where reason = 'ord supplied seq'), 'ord_f1'))), 'w3,w2',
  'a cursor from outside the filter still places the page by its own position');

-- ---------------------------------------------------------------------------
-- 4. Account and staff histories
-- ---------------------------------------------------------------------------
insert into private.audit_events (id, actor_id, action, target_profile_id, reason, metadata) values
  (pg_temp.eid(202), pg_temp.u('a1'), 'account_suspended', pg_temp.u('c1'), 'ord suspended', '{"from": "active", "to": "suspended"}'),
  (pg_temp.eid(201), pg_temp.u('a1'), 'account_reinstated', pg_temp.u('c1'), 'ord reinstated', '{"from": "suspended", "to": "active"}'),
  (pg_temp.eid(302), pg_temp.u('a1'), 'staff_role_granted', pg_temp.u('c2'), 'ord granted', '{"role": "moderator"}'),
  (pg_temp.eid(301), pg_temp.u('a1'), 'staff_role_revoked', pg_temp.u('c2'), 'ord revoked', '{"role": "moderator"}');
select is(pg_temp.as_user('a1', $$select public.get_account_summary('ord_c1') -> 'moderation' -> 'last_status_change' ->> 'action'$$), 'account_reinstated',
  'an account''s last status change is the one written last, though both were recorded together');
select is(pg_temp.as_user('a1', $$select string_agg(e ->> 'action', ',' order by n) from jsonb_array_elements(public.get_account_summary('ord_c1') -> 'history') with ordinality x(e, n)$$),
  'account_reinstated,account_suspended', 'and its history is newest first');
select is(pg_temp.as_user('a1', $$select string_agg(e ->> 'reason', ',' order by n) from jsonb_array_elements(public.get_staff_overview() -> 'recent') with ordinality x(e, n) where n <= 2$$),
  'ord revoked,ord granted', 'recent staff changes are newest first, by when they were written');

-- ---------------------------------------------------------------------------
-- 5. A record's history, as a batch approval writes it
-- ---------------------------------------------------------------------------
insert into public.games (title, sort_title) values ('Ordfix Game', 'Ordfix Game');
create temp table gid as select id from public.games where title = 'Ordfix Game';
-- approve_review_batch's three events for one member, through the same writer.
select private.record_catalog_audit(pg_temp.u('e1'), 'catalog_record_verified', 'game', (select id from gid), 'ord approval', '{}');
select private.record_catalog_audit(pg_temp.u('e1'), 'catalog_record_verified', 'game_platform', (select id from gid), 'ord approval', '{"basis": "batch"}');
select private.record_catalog_audit(pg_temp.u('e1'), 'catalog_record_published', 'game', (select id from gid), 'ord approval', '{}');
-- And three more, recorded together with ids in reverse order, and one an hour earlier.
insert into private.audit_events (id, occurred_at, actor_id, action, reason, metadata) values
  (pg_temp.eid(403), now(), pg_temp.u('e1'), 'catalog_record_updated', 'u1', jsonb_build_object('entity', 'game', 'id', (select id from gid), 'fields', array['title'])),
  (pg_temp.eid(402), now(), pg_temp.u('e1'), 'catalog_record_updated', 'u2', jsonb_build_object('entity', 'game', 'id', (select id from gid), 'fields', array['title'])),
  (pg_temp.eid(401), now(), pg_temp.u('e1'), 'catalog_record_updated', 'u3', jsonb_build_object('entity', 'game', 'id', (select id from gid), 'fields', array['title'])),
  (pg_temp.eid(400), now() - interval '1 hour', pg_temp.u('e1'), 'catalog_record_created', 'c0', jsonb_build_object('entity', 'game', 'id', (select id from gid)));
create function pg_temp.history(p_limit int, p_before uuid) returns jsonb language sql as $$
  select pg_temp.as_user('e1', format('select public.get_catalog_record_history(''game'', %L, %s, %L)::text', (select id from gid), p_limit, p_before))::jsonb $$;
create function pg_temp.labels(p jsonb) returns text language sql as $$
  select string_agg(coalesce(nullif(e ->> 'reason', 'ord approval'), '') || (e ->> 'action') || ':' || (e -> 'details' ->> 'entity'), ',' order by n)
  from jsonb_array_elements(p -> 'items') with ordinality x(e, n) $$;
select is(pg_temp.labels(pg_temp.history(50, null)),
  'u3catalog_record_updated:game,u2catalog_record_updated:game,u1catalog_record_updated:game,catalog_record_published:game,catalog_record_verified:game_platform,catalog_record_verified:game,c0catalog_record_created:game',
  'a game''s history is newest first: the approval''s publication after its pairing and identity checks, all recorded together');
-- Walked one event at a time, following next_before.
create function pg_temp.history_walk() returns text language plpgsql as $w$
declare v_page jsonb; v_before uuid; v_all text := ''; v_n int := 0;
begin
  loop
    v_page := pg_temp.history(1, v_before);
    v_all := v_all || coalesce(pg_temp.labels(v_page), '') || ';';
    v_before := (v_page ->> 'next_before')::uuid;
    v_n := v_n + 1;
    exit when v_before is null or v_n > 20;
  end loop;
  return v_all;
end $w$;
select is(pg_temp.history_walk(), replace(pg_temp.labels(pg_temp.history(50, null)), ',', ';') || ';', 'paged one at a time with its cursor: every event once, in the same order');
select is(pg_temp.labels(pg_temp.history(2, (select id from private.audit_events where reason = 'u2'))),
  'u1catalog_record_updated:game,catalog_record_published:game', 'a page after an event starts with the next one recorded before it');
select is(pg_temp.history(2, gen_random_uuid())::text, '{"items": [], "next_before": null}', 'a cursor that names no event gives an empty page');
select is(pg_temp.history(2, (select id from private.audit_events where reason = 'u2')) ->> 'next_before',
  (select id::text from private.audit_events where action = 'catalog_record_published' and metadata ->> 'id' = (select id::text from gid)), 'its cursor is still the id of the last event shown');

-- ---------------------------------------------------------------------------
-- 6. Nothing older changed
-- ---------------------------------------------------------------------------
select is((select count(*)::int from private.audit_events where seq is null and reason in ('h0', 'h1', 'h2')), 3, 'rows without a number keep none');
select is((select count(*)::int from private.audit_events
           where seq is null and (reason ~ '^[wtdu][0-9]$' or reason in ('c0', 'ord approval', 'ord supplied seq') or reason like 'ord %ed')), 0,
  'every event written since has one, through record_audit, record_catalog_audit or a direct insert');

select * from finish();
rollback;
