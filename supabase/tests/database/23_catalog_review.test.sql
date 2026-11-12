-- M7b-1: catalog review. Editors start a review, correct, approve, request changes or
-- reject; submitters answer and resubmit. Nobody reviews their own submission, nothing
-- is published without a review, and a deleted submitter is handled. Builds a
-- fictional catalog through the editor functions. Races and the API boundary are in
-- db-review-checks.mjs.
begin;
create extension if not exists pgtap with schema extensions;
select plan(140);

create function pg_temp.u(s text) returns uuid language sql immutable as $$ select ('00000000-0000-0000-0000-0000000000' || s)::uuid $$;
grant execute on function pg_temp.u(text) to authenticated, anon;
create temp table ids (name text primary key, id uuid not null);
grant all on ids to authenticated, anon;
create function pg_temp.id(p text) returns uuid language sql stable as $$ select id from ids where name = p $$;
grant execute on function pg_temp.id(text) to authenticated, anon;

-- Runs a statement as a signed-in user, or as anon when p_actor is null, and returns
-- its result or the error as text.
create function pg_temp.as_user(p_actor text, p_sql text) returns text language plpgsql as $t$
declare r text;
begin
  if p_actor is null then
    perform set_config('request.jwt.claims', '{"role": "anon"}', true);
    perform set_config('role', 'anon', true);
  else
    perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.u(p_actor), 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);
  end if;
  execute p_sql into r;
  perform set_config('role', 'none', true);
  return coalesce(r, '');
exception when others then
  perform set_config('role', 'none', true);
  return 'error: ' || sqlerrm;
end $t$;

-- Submitting, naming the submission and its release.
create function pg_temp.sub(p_name text, p_actor text, p_game uuid, p_platform text, p_region text, p_details text default '{}') returns text language plpgsql as $$
declare r text := pg_temp.as_user(p_actor, format('select public.submit_release(%L, %L, %L, %L, %L, %L, %L, %L)::text',
  p_game, p_platform, 'rom-cartridge', p_region, p_details, '[]', null, true));
begin
  if r like '{%' and (r::jsonb ->> 'outcome') = 'submitted' then
    insert into ids values (p_name, (r::jsonb ->> 'submission_id')::uuid), (p_name || '-r', (r::jsonb ->> 'release_id')::uuid);
    return 'submitted';
  end if;
  return r;
end $$;
create function pg_temp.subgame(p_name text, p_actor text, p_title text, p_region text default 'pal') returns text language plpgsql as $$
declare r text := pg_temp.as_user(p_actor, format('select public.submit_game(%L, %L, %L, %L, %L, %L, %L, %L, %L, %L)::text',
  p_title, 'game', null, 'snes', 'rom-cartridge', p_region, '{}', '[]', null, true));
begin
  if r like '{%' and (r::jsonb ->> 'outcome') = 'submitted' then
    insert into ids values (p_name, (r::jsonb ->> 'submission_id')::uuid), (p_name || '-r', (r::jsonb ->> 'release_id')::uuid),
      (p_name || '-g', (r::jsonb ->> 'game_id')::uuid);
    return 'submitted';
  end if;
  return r;
end $$;

-- Current versions and revisions, as a review page would read them.
create function pg_temp.ver(p text) returns integer language sql as $$ select version from public.catalog_change_requests where id = pg_temp.id(p) $$;
create function pg_temp.rrev(p text) returns bigint language sql as $$ select revision from public.releases where id = pg_temp.id(p || '-r') $$;
create function pg_temp.grev(p text) returns bigint language sql as $$
  select g.revision from public.games g join public.releases r on r.game_id = g.id where r.id = pg_temp.id(p || '-r') $$;
create function pg_temp.st(p text) returns text language sql as $$ select status::text from public.catalog_change_requests where id = pg_temp.id(p) $$;
create function pg_temp.rst(p text) returns text language sql as $$ select status::text from public.releases where id = pg_temp.id(p || '-r') $$;

-- The review actions, with the current version and revisions unless given.
create function pg_temp.start(p_actor text, p text, p_version integer default null) returns text language sql as $$
  select pg_temp.as_user(p_actor, format('select public.start_submission_review(%L, %L, %L)::text', pg_temp.id(p), coalesce(p_version, pg_temp.ver(p)), 'Checking the evidence'))
$$;
create function pg_temp.approve(p_actor text, p text, p_release_rev bigint default null, p_game_rev bigint default null, p_note text default null) returns text language sql as $$
  select pg_temp.as_user(p_actor, format('select public.approve_submission(%L, %L, %L, %L, %L, %L)::text',
    pg_temp.id(p), pg_temp.ver(p), coalesce(p_release_rev, pg_temp.rrev(p)), p_game_rev, 'Matches the box and cartridge', p_note))
$$;
create function pg_temp.changes(p_actor text, p text, p_note text) returns text language sql as $$
  select pg_temp.as_user(p_actor, format('select public.request_submission_changes(%L, %L, %L, %L)::text', pg_temp.id(p), pg_temp.ver(p), p_note, 'Needs the edition'))
$$;
create function pg_temp.reject(p_actor text, p text, p_note text default null) returns text language sql as $$
  select pg_temp.as_user(p_actor, format('select public.reject_submission(%L, %L, %L, %L)::text', pg_temp.id(p), pg_temp.ver(p), 'No evidence it exists', p_note))
$$;
-- An editor's correction: completes the edition so the release can be verified.
create function pg_temp.fix(p_actor text, p text, p_changes text default '{"edition_name": "Standard", "edition_kind": "standard", "media_count": 1}') returns text language sql as $$
  select pg_temp.as_user(p_actor, format('select public.update_release(%L, %L, %L)::text', pg_temp.id(p || '-r'), p_changes, 'Completing from the photos'))
$$;
create function pg_temp.mine(p_actor text, p text) returns jsonb language sql as $$
  select nullif(pg_temp.as_user(p_actor, format('select public.get_my_submission(%L)::text', pg_temp.id(p))), '')::jsonb
$$;
create function pg_temp.resubmit(p_actor text, p text) returns text language sql as $$
  select pg_temp.as_user(p_actor, format('select public.resubmit_my_submission(%L)::text', pg_temp.id(p)))
$$;
create function pg_temp.detail(p_actor text, p text) returns jsonb language sql as $$
  select nullif(pg_temp.as_user(p_actor, format('select public.get_submission_review(%L)::text', pg_temp.id(p))), '')::jsonb
$$;

-- a1: submitter. b2: collector. c3: suspended editor. d4: moderator. e5: editor.
-- e6: an editor who also submits. f7: administrator. a8: an account deleted later.
-- b9: rate limit.
insert into auth.users (id, aud, role, email, email_confirmed_at, instance_id)
select pg_temp.u(s), 'authenticated', 'authenticated', s || '@example.test', now(), '00000000-0000-0000-0000-000000000000'
from unnest(array['a1', 'b2', 'c3', 'd4', 'e5', 'e6', 'f7', 'a8', 'b9']) as s;
update public.profiles set handle = 'rev_' || right(id::text, 2), handle_changed_at = now()
where id in (select pg_temp.u(s) from unnest(array['a1', 'b2', 'c3', 'd4', 'e5', 'e6', 'f7', 'a8', 'b9']) as s);
insert into public.staff_roles (user_id, role) values
  (pg_temp.u('c3'), 'catalog_editor'), (pg_temp.u('d4'), 'moderator'), (pg_temp.u('e5'), 'catalog_editor'),
  (pg_temp.u('e6'), 'catalog_editor'), (pg_temp.u('f7'), 'admin');
update public.profiles set account_status = 'suspended' where id = pg_temp.u('c3');

-- A published game with a published release on SNES.
select set_config('request.jwt.claims', json_build_object('sub', pg_temp.u('e5'), 'role', 'authenticated')::text, true);
select set_config('role', 'authenticated', true);
insert into ids select 'g', public.create_game('Qzs Lantern Keep', 'game', null, null, null, 'unknown', 'Review tests');
select public.verify_game(pg_temp.id('g'), 'Review tests', (select revision from public.games where id = pg_temp.id('g')));
insert into ids select 'pub', public.create_release(pg_temp.id('g'), (select id from public.platforms where slug = 'snes'), 'rom-cartridge', 'ntsc-uc',
  '{"edition_name": "Standard", "edition_kind": "standard", "media_count": 1, "product_code": "QZS-REV-1"}', 'Review tests');
select public.verify_release(pg_temp.id('pub'), 'Review tests', (select revision from public.releases where id = pg_temp.id('pub')));
select public.publish_release(pg_temp.id('pub'), 'Review tests', (select revision from public.releases where id = pg_temp.id('pub')));
select set_config('role', 'none', true);

select is(pg_temp.sub('r1', 'a1', pg_temp.id('g'), 'snes', 'pal', '{"product_code": "QZS-REV-P"}'), 'submitted', 'a collector submits a missing release');
select is(pg_temp.subgame('ng', 'a1', 'Qzs Lantern Keep'), 'submitted', 'and a new game with the same title as a published one');
select is(pg_temp.as_user('a1', format('select public.add_collection_item(%L, %L, ''{}'') ->> ''created''', (select private.uuid_v7()), pg_temp.id('r1-r'))), 'true',
          'and adds their copy of the pending release');

-- ---------------------------------------------------------------------------
-- Who may review
-- ---------------------------------------------------------------------------
select ok(pg_temp.start(null, 'r1') like 'error: permission denied%', 'a visitor can''t review');
select is(pg_temp.start('b2', 'r1'), 'error: not permitted', 'nor a collector');
select is(pg_temp.start('d4', 'r1'), 'error: not permitted', 'nor a moderator');
select is(pg_temp.start('c3', 'r1'), 'error: not permitted', 'nor a suspended editor');
select is(pg_temp.as_user('b2', 'select public.get_submission_queue()::text'), 'error: not permitted', 'collectors can''t read the queue');
select is(pg_temp.as_user('d4', format('select public.get_submission_review(%L)::text', pg_temp.id('r1'))), 'error: not permitted', 'or a submission under review');
select is(pg_temp.as_user('b2', 'select public.can_review_submissions()::text'), 'false', 'a collector is told they can''t review');
select is(pg_temp.as_user('d4', 'select public.can_review_submissions()::text') || pg_temp.as_user('c3', 'select public.can_review_submissions()::text'),
          'falsefalse', 'and so are a moderator and a suspended editor');
select is(pg_temp.as_user('e5', 'select public.can_review_submissions()::text') || pg_temp.as_user('f7', 'select public.can_review_submissions()::text'),
          'truetrue', 'catalog editors and administrators can');
select ok(not has_table_privilege('authenticated', 'public.catalog_change_requests', 'select,insert,update,delete')
          and not has_table_privilege('anon', 'public.catalog_change_requests', 'select,insert,update,delete'), 'the review record still has no client grant');

-- ---------------------------------------------------------------------------
-- The queue and a submission's review page
-- ---------------------------------------------------------------------------
select is((select count(*)::int from jsonb_array_elements(pg_temp.as_user('e5', 'select public.get_submission_queue()::text')::jsonb -> 'items') i
           where (i ->> 'id')::uuid in (pg_temp.id('r1'), pg_temp.id('ng'))), 2, 'the queue lists open submissions');
select is((select i -> 'submitter' from jsonb_array_elements(pg_temp.as_user('e5', 'select public.get_submission_queue()::text')::jsonb -> 'items') i
           where (i ->> 'id')::uuid = pg_temp.id('r1')), '{"handle": "rev_a1", "deleted": false, "account_status": "active"}'::jsonb,
          'with the submitter''s handle and account status');
select ok(pg_temp.as_user('e5', 'select public.get_submission_queue(''all'')::text') not like '%@%', 'and never an email address');
select is(pg_temp.detail('e5', 'r1') -> 'release' ->> 'revision', pg_temp.rrev('r1')::text, 'the review page has the revision approval needs');
select ok(pg_temp.detail('e5', 'r1')::text not like '%@%' and pg_temp.detail('e5', 'r1')::text not like '%price%', 'and no email or collection details');
select ok(exists (select 1 from jsonb_array_elements(pg_temp.detail('e5', 'r1') -> 'duplicates') d where (d ->> 'id')::uuid = pg_temp.id('pub')),
          'it lists releases of the same game and platform as possible duplicates');
select ok(exists (select 1 from jsonb_array_elements(pg_temp.detail('e5', 'ng') -> 'similar_games') d where (d ->> 'id')::uuid = pg_temp.id('g')),
          'and for a new game, games with the same title');
select is(pg_temp.as_user('e5', format('select public.get_submission_review(%L)::text', private.uuid_v7())), '', 'an unknown submission reads as nothing');

-- ---------------------------------------------------------------------------
-- Starting a review
-- ---------------------------------------------------------------------------
select is(pg_temp.start('e5', 'r1', pg_temp.ver('r1') - 1 + 2), 'error: request conflict', 'a stale page can''t start a review');
select is(pg_temp.as_user('e5', format('select public.start_submission_review(%L, %L, %L)::text', pg_temp.id('r1'), pg_temp.ver('r1'), ' ')), 'error: reason required',
          'starting needs a reason');
select is(pg_temp.start('e5', 'r1')::int, pg_temp.ver('r1'), 'an editor starts the review and gets the new version');
select is(pg_temp.st('r1') || '/' || pg_temp.rst('r1'), 'in_review/under_review', 'the request and its release are in review');
select is(pg_temp.as_user('a1', format('select public.update_my_submission(%L, %L)::text', pg_temp.id('r1'), '{"note": "Late"}')), 'error: submission locked',
          'the submitter can''t change it any more');
select is(pg_temp.as_user('a1', format('select public.withdraw_my_submission(%L)::text', pg_temp.id('r1'))), 'error: submission locked', 'or withdraw it');
select is(pg_temp.mine('a1', 'r1') ->> 'status', 'in_review', 'and sees it in review');
select is(pg_temp.start('e5', 'r1'), 'error: submission unavailable', 'a review can''t start twice');
select is((select reason from private.audit_events where action = 'catalog_submission_review_started' and metadata ->> 'request_id' = pg_temp.id('r1')::text),
          'Checking the evidence', 'starting is audited with the editor''s reason');

-- ---------------------------------------------------------------------------
-- Nothing is verified or published without a review
-- ---------------------------------------------------------------------------
select is(pg_temp.as_user('e6', format('select public.verify_release(%L, %L, %L)::text', pg_temp.id('r1-r'), 'Bypass', pg_temp.rrev('r1'))), 'error: release incomplete',
          'verifying an incomplete submission fails as before');
select is(pg_temp.fix('e6', 'r1'), 'true', 'an editor corrects a submission in review with the M5 functions');
select is(pg_temp.as_user('e6', format('select public.verify_release(%L, %L, %L)::text', pg_temp.id('r1-r'), 'Bypass', pg_temp.rrev('r1'))), 'error: review required',
          'but can''t verify it outside the review');
select is(pg_temp.as_user('e5', format('select public.verify_game(%L, %L, %L)::text', pg_temp.id('ng-g'), 'Bypass', pg_temp.grev('ng'))), 'error: review required',
          'nor verify a submitted game');
select is(pg_temp.fix('e5', 'ng'), 'error: submission not in review', 'and an editor can''t change a submission before its review starts');
select is((select status::text from public.releases where id = pg_temp.id('r1-r')), 'under_review', 'so nothing was published');

-- ---------------------------------------------------------------------------
-- Approving
-- ---------------------------------------------------------------------------
select is(pg_temp.approve('e5', 'r1', pg_temp.rrev('r1') - 1), 'error: record changed', 'approval needs the revision the editor reviewed');
select is(pg_temp.st('r1'), 'in_review', 'and a refused approval changes nothing');
select is(pg_temp.as_user('e5', format('select public.approve_submission(%L, %L, %L, %L, %L, %L)::text', pg_temp.id('r1'), pg_temp.ver('r1'), pg_temp.rrev('r1'), null, '', null)),
          'error: reason required', 'approval needs a reason');
select ok(pg_temp.approve('e5', 'r1', null, null, 'Thanks, the photos helped') like '{%', 'the editor approves it');
select is((select row(status, submitted_by is null, verified_at is not null, verified_by = pg_temp.u('e5'))::text from public.releases where id = pg_temp.id('r1-r')),
          '(published,t,t,t)', 'the release is verified and published, and its submitter cleared');
select is((select row(status, reviewed_by = pg_temp.u('e5'), reviewer_note, submitted_by = pg_temp.u('a1'))::text from public.catalog_change_requests where id = pg_temp.id('r1')),
          '(approved,t,"Thanks, the photos helped",t)', 'the request keeps who submitted and who reviewed it');
select is((pg_temp.as_user('a1', 'select public.get_my_collection_summary()::text')::jsonb ->> 'owned')::int, 1, 'the submitter''s copy now counts as owned');
select is(pg_temp.mine('a1', 'r1') ->> 'status', 'published', 'they see it published');
select is(pg_temp.mine('a1', 'r1') ->> 'reviewer_note', 'Thanks, the photos helped', 'with the editor''s note');
select ok(not (pg_temp.mine('a1', 'r1') ? 'reviewer') and not (pg_temp.mine('a1', 'r1') ? 'reviewed_by'), 'but never the reviewer');
select is((select row(actor_id is null, data)::text from public.notifications where recipient_id = pg_temp.u('a1') and type = 'catalog_submission'),
          row(true, jsonb_build_object('status', 'published', 'submission_id', pg_temp.id('r1')))::text, 'they''re notified, with no actor and only the status');
select is(pg_temp.as_user('a1', 'select count(*)::text from public.get_my_notifications() where type = ''catalog_submission'''), '1', 'and read it through M4''s functions');
select is((select count(*)::int from private.audit_events where action = 'catalog_submission_approved' and metadata ->> 'request_id' = pg_temp.id('r1')::text
           and actor_id = pg_temp.u('e5') and reason = 'Matches the box and cartridge'), 1, 'approval is audited');
select is((select count(*)::int from private.audit_events where action in ('catalog_record_verified', 'catalog_record_published') and metadata ->> 'id' = pg_temp.id('r1-r')::text), 2,
          'with the M5 verification and publication records');
select is(pg_temp.approve('e5', 'r1'), 'error: submission unavailable', 'it can''t be approved twice');

-- A new game, which needs its own revision too.
select is(pg_temp.start('e5', 'ng')::int, pg_temp.ver('ng'), 'reviewing a new game');
select is(pg_temp.fix('e5', 'ng'), 'true', 'its release is completed');
select is(pg_temp.approve('e5', 'ng'), 'error: invalid changes', 'approving a new game needs the game''s revision');
select ok(pg_temp.approve('e5', 'ng', null, pg_temp.grev('ng')) like '{"game_slug": "qzs-lantern-keep-2"%', 'with it, the game is published with a free slug');
select is((select row(status, submitted_by is null)::text from public.games where id = pg_temp.id('ng-g')), '(published,t)', 'and is public');

-- An unknown region needs the editor's confirmation, which a submitter can never give.
select is(pg_temp.sub('unk', 'a1', pg_temp.id('g'), 'snes', 'unknown'), 'submitted', 'a submission with an unknown region');
select is(pg_temp.start('e5', 'unk')::int, pg_temp.ver('unk'), 'is reviewed');
select is(pg_temp.fix('e5', 'unk'), 'true', 'and completed');
select is(pg_temp.approve('e5', 'unk'), 'error: release incomplete', 'but isn''t approved while the region is unconfirmed');
select is(pg_temp.fix('e5', 'unk', '{"region_unknown_confirmed": true}'), 'true', 'the editor confirms it');
select ok(pg_temp.approve('e5', 'unk') like '{%', 'and then approves it');

-- An identical release already published.
select is(pg_temp.sub('dup', 'b2', pg_temp.id('g'), 'snes', 'ntsc-uc', '{"product_code": "QZS-REV-2"}'), 'submitted', 'a submission that turns out to be published already');
select is(pg_temp.start('e5', 'dup')::int, pg_temp.ver('dup'), 'is reviewed');
select is(pg_temp.fix('e5', 'dup', '{"edition_name": "Standard", "edition_kind": "standard", "media_count": 1, "product_code": "QZS-REV-1"}'), 'true',
          'and corrected to the published release''s identity');
select is(pg_temp.approve('e5', 'dup'), 'error: already published', 'so it can''t be published as a second copy');
select is(pg_temp.st('dup'), 'in_review', 'and stays in review');

-- ---------------------------------------------------------------------------
-- Requesting changes, and answering them
-- ---------------------------------------------------------------------------
select is(pg_temp.sub('r2', 'a1', pg_temp.id('g'), 'snes', 'ntsc-j'), 'submitted', 'another submission');
select is(pg_temp.start('e5', 'r2')::int, pg_temp.ver('r2'), 'is reviewed');
select is(pg_temp.fix('e5', 'r2', '{"edition_kind": "standard", "media_count": 1}'), 'true', 'an editor corrects part of it first');
select is(pg_temp.changes('e5', 'r2', ' '), 'error: invalid review', 'asking for changes needs a note for the submitter');
select is(pg_temp.changes('e5', 'r2', 'Which edition is it? A photo of the spine would help.')::int, pg_temp.ver('r2'), 'the editor asks for changes');
select is(pg_temp.st('r2') || '/' || pg_temp.rst('r2'), 'changes_requested/unverified', 'it goes back to the submitter, unverified');
select is(pg_temp.mine('a1', 'r2') ->> 'reviewer_note', 'Which edition is it? A photo of the spine would help.', 'who reads the note');
select is((pg_temp.mine('a1', 'r2') ->> 'editable') || (pg_temp.mine('a1', 'r2') ->> 'resubmittable'), 'truetrue', 'and can change it and send it back');
select is(pg_temp.mine('a1', 'r2') -> 'details' ->> 'media_count', '1', 'starting from the record with the editor''s corrections, so saving keeps them');
select is((select data ->> 'status' from public.notifications where recipient_id = pg_temp.u('a1') and data ->> 'submission_id' = pg_temp.id('r2')::text),
          'changes_requested', 'and is notified');
select is(pg_temp.fix('e5', 'r2'), 'error: submission not in review', 'editors can''t change it meanwhile');
select is(pg_temp.approve('e5', 'r2'), 'error: submission unavailable', 'or approve it');
select is(pg_temp.as_user('a1', format('select public.update_my_submission(%L, %L)::text', pg_temp.id('r2'), '{"details": {"edition_name": "Standard"}}')), 'true',
          'the submitter changes it');
select is(pg_temp.as_user('a1', format('select public.update_release(%L, %L, %L)::text', pg_temp.id('r2-r'), '{"edition_name": "X"}', 'Mine')), 'error: not permitted',
          'but only through their own functions');
select is(pg_temp.as_user('a1', 'select public.my_catalog_submissions()::text')::jsonb -> 'allowance' ->> 'used', '4', 'before sending it back');
select is(pg_temp.resubmit('a1', 'r2'), jsonb_build_object('submission_id', pg_temp.id('r2'))::text, 'they send it back as the same request');
select is(pg_temp.st('r2'), 'open', 'which is open again');
select is(pg_temp.as_user('a1', 'select public.my_catalog_submissions()::text')::jsonb -> 'allowance' ->> 'used', '4', 'and isn''t counted again');
select is(pg_temp.resubmit('a1', 'r2'), 'error: submission unavailable', 'an open submission can''t be resubmitted');

-- ---------------------------------------------------------------------------
-- Rejecting, and resubmitting as a new request
-- ---------------------------------------------------------------------------
select is(pg_temp.as_user('a1', format('select public.add_collection_item(%L, %L, ''{}'') ->> ''created''', (select private.uuid_v7()), pg_temp.id('r2-r'))), 'true',
          'the submitter adds a copy of it');
select is(pg_temp.start('e5', 'r2')::int, pg_temp.ver('r2'), 'it''s reviewed again');
select is(pg_temp.reject('e5', 'r2', 'We couldn''t confirm this edition exists.')::int, pg_temp.ver('r2'), 'and rejected');
select is(pg_temp.st('r2') || '/' || pg_temp.rst('r2'), 'rejected/rejected', 'the request and release are rejected');
select is((pg_temp.as_user('a1', 'select public.get_my_collection_summary()::text')::jsonb ->> 'not_approved')::int, 1, 'the copy is kept, as not approved');
select is((select data ->> 'status' from public.notifications where recipient_id = pg_temp.u('a1') and type = 'catalog_submission' and data ->> 'submission_id' = pg_temp.id('r2')::text
           order by id desc limit 1), 'rejected', 'the submitter is notified');
select is((pg_temp.mine('a1', 'r2') ->> 'editable') || (pg_temp.mine('a1', 'r2') ->> 'resubmittable'), 'falsetrue', 'it''s read-only, but can be resubmitted');
insert into ids select 'r2b', (pg_temp.resubmit('a1', 'r2')::jsonb ->> 'submission_id')::uuid;
insert into ids values ('r2b-r', pg_temp.id('r2-r'));
select isnt(pg_temp.id('r2b'), pg_temp.id('r2'), 'resubmitting makes a new request');
select is((select row(status, previous_request_id = pg_temp.id('r2'), release_id = pg_temp.id('r2-r'))::text from public.catalog_change_requests where id = pg_temp.id('r2b')),
          '(open,t,t)', 'linked to the rejected one, for the same release');
select is(pg_temp.st('r2') || '/' || pg_temp.rst('r2'), 'rejected/unverified', 'the rejected request stays as history, and the release is pending again');
select is(pg_temp.as_user('a1', 'select public.my_catalog_submissions()::text')::jsonb -> 'allowance' ->> 'used', '5', 'a resubmission counts toward the limit');
select is(pg_temp.resubmit('a1', 'r2'), 'error: submission unavailable', 'the rejected request can''t be resubmitted twice');
select is(pg_temp.mine('a1', 'r2') ->> 'next_id', pg_temp.id('r2b')::text, 'the submitter can follow the chain');
select is(jsonb_array_length(pg_temp.detail('e5', 'r2b') -> 'history'), 2, 'and editors see both rounds');

-- A rejected new game, unless another release of it is pending.
select is(pg_temp.subgame('ng2', 'a1', 'Qzs Copper Sails'), 'submitted', 'a new game');
select is(pg_temp.sub('ng2b', 'a1', pg_temp.id('ng2-g'), 'snes', 'ntsc-j'), 'submitted', 'with a second pending release');
select is(pg_temp.start('e5', 'ng2')::int, pg_temp.ver('ng2'), 'is reviewed');
select is(pg_temp.reject('e5', 'ng2')::int, pg_temp.ver('ng2'), 'and rejected');
select is((select status::text from public.games where id = pg_temp.id('ng2-g')), 'unverified', 'the game stays, because another release of it is pending');

-- The rate limit applies to resubmissions.
do $$ begin perform pg_temp.sub('rl' || i, 'b9', pg_temp.id('g'), 'snes', 'pal', format('{"edition_name": "Run %s"}', i)) from generate_series(1, 10) i; end $$;
select is(pg_temp.start('e5', 'rl1')::int, pg_temp.ver('rl1'), 'with ten submissions in a day');
select is(pg_temp.reject('e5', 'rl1')::int, pg_temp.ver('rl1'), 'one rejected');
select is(pg_temp.resubmit('b9', 'rl1'), 'error: submission limit reached', 'can''t be resubmitted until the limit allows');

-- ---------------------------------------------------------------------------
-- No self-review
-- ---------------------------------------------------------------------------
select is(pg_temp.sub('own', 'e6', pg_temp.id('g'), 'snes', 'pal', '{"product_code": "QZS-OWN"}'), 'submitted', 'an editor submits a release as a collector');
select is(pg_temp.as_user('e6', format('select public.update_release(%L, %L, %L)::text', pg_temp.id('own-r'), '{"region_unknown_confirmed": true, "region_code": "unknown"}', 'Mine')),
          'error: not permitted', 'and can''t confirm an unknown region on it with their editor role');
select is(pg_temp.start('e6', 'own'), 'error: own submission', 'or start its review');
select is(pg_temp.start('e5', 'own')::int, pg_temp.ver('own'), 'another editor starts it');
select is(pg_temp.fix('e6', 'own'), 'error: submission locked', 'its submitter can''t correct it in review');
select is(pg_temp.fix('e5', 'own'), 'true', 'the reviewer can');
select is(pg_temp.approve('e6', 'own'), 'error: own submission', 'and its submitter can''t approve it');
select is(pg_temp.as_user('e6', format('select public.verify_release(%L, %L, %L)::text', pg_temp.id('own-r'), 'Mine', pg_temp.rrev('own'))), 'error: review required',
          'or verify it directly');
select is(pg_temp.reject('e6', 'own'), 'error: own submission', 'or reject it');
select ok(pg_temp.approve('e5', 'own') like '{%', 'the other editor approves it');
select is((select data ->> 'status' from public.notifications where recipient_id = pg_temp.u('e6') and type = 'catalog_submission'), 'published', 'and the editor is notified like anyone');
-- The permanent history: a withdrawn submission's game, kept by an editor's release,
-- can't be verified by the person who submitted it.
select is(pg_temp.subgame('og', 'e6', 'Qzs Harbor Lights'), 'submitted', 'the editor submits a new game');
select set_config('request.jwt.claims', json_build_object('sub', pg_temp.u('e5'), 'role', 'authenticated')::text, true);
select set_config('role', 'authenticated', true);
select ok(public.create_release(pg_temp.id('og-g'), (select id from public.platforms where slug = 'snes'), 'rom-cartridge', 'pal', '{}', 'Found a second release') is not null,
          'another editor adds a release to that game');
select set_config('role', 'none', true);
select is(pg_temp.as_user('e6', format('select public.withdraw_my_submission(%L)::text', pg_temp.id('og'))), 'true', 'the submitter withdraws theirs; the game stays');
select is(pg_temp.as_user('e6', format('select public.verify_game(%L, %L, %L)::text', pg_temp.id('og-g'), 'Mine',
          (select revision from public.games where id = pg_temp.id('og-g')))), 'error: own submission', 'the submitter can never verify the game they submitted');
select is(pg_temp.as_user('e5', format('select public.verify_game(%L, %L, %L)::text', pg_temp.id('og-g'), 'Checked',
          (select revision from public.games where id = pg_temp.id('og-g')))), 'true', 'another editor can');

-- ---------------------------------------------------------------------------
-- A submitter whose account is deleted
-- ---------------------------------------------------------------------------
select is(pg_temp.sub('del', 'a8', pg_temp.id('g'), 'snes', 'pal', '{"product_code": "QZS-DEL"}'), 'submitted', 'a collector submits');
select is(pg_temp.sub('del2', 'a8', pg_temp.id('g'), 'snes', 'ntsc-j', '{"product_code": "QZS-DEL2"}'), 'submitted', 'twice');
create temp table before_delete as select pg_temp.ver('del') as v;
delete from auth.users where id = pg_temp.u('a8');
select is((select row(submitted_by is null, version > (select v from before_delete))::text from public.catalog_change_requests where id = pg_temp.id('del')),
          '(t,t)', 'deleting their account clears the submitter and raises the version');
select is(pg_temp.start('e5', 'del', (select v from before_delete)), 'error: request conflict', 'so a page read before the deletion is stale');
select is(pg_temp.detail('e5', 'del') -> 'submitter', '{"deleted": true}'::jsonb, 'editors see it''s from a deleted account');
select is(pg_temp.detail('e5', 'del') -> 'request' ->> 'own', 'false', 'which is nobody''s own submission');
select is(pg_temp.start('e5', 'del')::int, pg_temp.ver('del'), 'it can be reviewed');
select is(pg_temp.changes('e5', 'del', 'Which edition?'), 'error: submitter unavailable', 'but changes can''t be requested: nobody could answer');
select is(pg_temp.fix('e5', 'del'), 'true', 'an editor completes it instead');
select ok(pg_temp.approve('e5', 'del') like '{%', 'and approves it');
select is(pg_temp.start('e5', 'del2')::int, pg_temp.ver('del2'), 'the other is reviewed');
select is(pg_temp.reject('e5', 'del2')::int, pg_temp.ver('del2'), 'and rejected');
select is((select count(*)::int from public.notifications where data ->> 'submission_id' in (pg_temp.id('del')::text, pg_temp.id('del2')::text)), 0,
          'with no notification to anyone');

-- ---------------------------------------------------------------------------
-- The notification shape
-- ---------------------------------------------------------------------------
select throws_ok(format($$insert into public.notifications (recipient_id, actor_id, type, data) values (%L, %L, 'catalog_submission', '{"status": "published", "submission_id": "x"}')$$,
                 pg_temp.u('a1'), pg_temp.u('e5')), '23514', null, 'a submission notice can''t name an actor');
select throws_ok(format($$insert into public.notifications (recipient_id, type, data) values (%L, 'catalog_submission', '{"status": "published", "submission_id": "x", "reason": "y"}')$$,
                 pg_temp.u('a1')), '23514', null, 'or carry the editor''s reason');
select throws_ok(format($$insert into public.notifications (recipient_id, type, data) values (%L, 'catalog_submission', '{"status": "in_review", "submission_id": "x"}')$$,
                 pg_temp.u('a1')), '23514', null, 'and only outcomes notify');

select * from finish();
rollback;
