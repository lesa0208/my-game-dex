-- M11b-1b: release identity and packaging (MIG-2 and MIG-3).
-- The vocabulary, the comparison keys, both identity indexes with the unclassified
-- fallback, the submission duplicate check, and the publication rules: classified
-- packaging, an accepted shell for NES and SNES, Unknown only from an editor, no return
-- to unclassified, and grandfathered published releases left alone.
begin;
create extension if not exists pgtap with schema extensions;
select plan(84);

create function pg_temp.claims(p_user uuid) returns jsonb language plpgsql as $mfa$
begin
  if exists (select 1 from auth.users where id = p_user) then
    insert into auth.sessions (id, user_id, aal, factor_id, created_at, updated_at) values (p_user, p_user, 'aal2', p_user, now(), now()) on conflict (id) do nothing;
    insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
      select p_user, p_user, 'test session factor', 'totp', 'verified', now(), now()
      where not exists (select 1 from auth.mfa_factors where id = p_user);
    insert into auth.mfa_amr_claims (id, session_id, authentication_method, created_at, updated_at)
      values (gen_random_uuid(), p_user, 'totp', now(), now()) on conflict do nothing;
  end if;
  return jsonb_build_object('sub', p_user, 'role', 'authenticated', 'aal', 'aal2', 'session_id', p_user);
end $mfa$;
create function pg_temp.u(s text) returns uuid language sql immutable as $$ select ('00000000-0000-0000-0000-0000000000' || s)::uuid $$;
create function pg_temp.as_user(p_actor text, p_sql text) returns text language plpgsql as $t$
declare r text;
begin
  perform set_config('request.jwt.claims', pg_temp.claims(pg_temp.u(p_actor))::text, true);
  perform set_config('role', 'authenticated', true);
  execute p_sql into r;
  perform set_config('role', 'none', true);
  return coalesce(r, '');
exception when others then
  perform set_config('role', 'none', true);
  return 'error: ' || sqlerrm;
end $t$;
create function pg_temp.try(p_sql text) returns text language plpgsql as $t$
declare r text;
begin
  execute p_sql into r;
  return coalesce(r, '');
exception when others then
  return 'error: ' || sqlerrm;
end $t$;
create temp table ids (name text primary key, id uuid not null);
create function pg_temp.id(p text) returns uuid language sql volatile as $$ select id from ids where name = p $$;
create function pg_temp.platform(p text) returns uuid language sql stable as $$ select id from public.platforms where slug = p $$;
create function pg_temp.rev(p text) returns bigint language sql volatile as $$ select revision from public.releases where id = pg_temp.id(p) $$;
grant select on ids to authenticated;
grant execute on function pg_temp.id(text), pg_temp.rev(text), pg_temp.u(text) to authenticated;

-- e1 creates, e9 verifies and publishes (no self-review), c3 is a collector.
insert into auth.users (id, aud, role, email, email_confirmed_at, instance_id)
select pg_temp.u(s), 'authenticated', 'authenticated', s || '@example.test', now(), '00000000-0000-0000-0000-000000000000'
from unnest(array['e1', 'e9', 'c3']) as s;
update public.profiles set handle = 'pkg_' || right(id::text, 2), handle_changed_at = now() where id in (pg_temp.u('e1'), pg_temp.u('e9'), pg_temp.u('c3'));
insert into public.staff_roles (user_id, role) values (pg_temp.u('e1'), 'catalog_editor'), (pg_temp.u('e9'), 'catalog_editor');

-- A published game on each platform used, so publishing a release needs only the release.
insert into public.games (id, slug, title, sort_title, kind, status, verified_at) values
  (pg_temp.u('a1'), 'zqi-identity-quest', 'Zqi Identity Quest', 'Zqi Identity Quest', 'game', 'published', now());
insert into public.game_platforms (game_id, platform_id, status)
select pg_temp.u('a1'), pg_temp.platform(s), 'published' from unnest(array['nes', 'snes', 'playstation']) s;

-- An editor's release, kept by name; then verify and publish as the second editor.
create function pg_temp.rel(p_name text, p_platform text, p_format text, p_region text, p_details text) returns text language plpgsql as $$
declare r text := pg_temp.as_user('e1', format('select public.create_release(%L, %L, %L, %L, %L, %L)::text',
  pg_temp.u('a1'), pg_temp.platform(p_platform), p_format, p_region, p_details, 'Identity tests'));
begin
  if r not like 'error%' then insert into ids values (p_name, r::uuid); return 'created'; end if;
  return r;
end $$;
create function pg_temp.verify(p text) returns text language sql as $$
  select pg_temp.as_user('e9', format('select public.verify_release(%L, %L, %s)::text', pg_temp.id(p), 'Checked', pg_temp.rev(p))) $$;
create function pg_temp.publish(p text) returns text language sql as $$
  select pg_temp.as_user('e9', format('select public.publish_release(%L, %L, %s)::text', pg_temp.id(p), 'Publish', pg_temp.rev(p))) $$;
create function pg_temp.edit(p_actor text, p text, p_changes text) returns text language sql as $$
  select pg_temp.as_user(p_actor, format('select public.update_release(%L, %L, %L)::text', pg_temp.id(p), p_changes, 'Identity tests')) $$;
-- A published release inserted directly, as a maintenance session, to exercise the index.
create function pg_temp.pub(p_name text, p_platform text, p_format text, p_region text, p_edition text, p_variant text, p_code text, p_text text, p_product text, p_count int default 1) returns text language plpgsql as $$
declare r text := pg_temp.try(format($q$insert into public.releases (game_id, platform_id, media_format_code, region_code, edition_name, edition_kind, variant_name,
    packaging_code, packaging, product_code, media_count, status, verified_at)
  values (%L, %L, %L, %L, %L, 'standard', %L, %L, %L, %L, %s, 'published', now()) returning id::text$q$,
  pg_temp.u('a1'), pg_temp.platform(p_platform), p_format, p_region, p_edition, p_variant, p_code, p_text, p_product, p_count));
begin
  if r not like 'error%' then insert into ids values (p_name, r::uuid); return 'ok'; end if;
  return r;
end $$;
create function pg_temp.sub(p_details text, p_format text default 'rom-cartridge', p_region text default 'pal') returns text language sql as $$
  select pg_temp.as_user('c3', format('select public.submit_release(%L, %L, %L, %L, %L, %L, %L, %L)::text',
    pg_temp.u('a1'), 'snes', p_format, p_region, p_details, '[]', null, true)) $$;

-- ---------------------------------------------------------------------------
-- The vocabulary and the schema
-- ---------------------------------------------------------------------------
select is((select string_agg(code, ',' order by position) from public.packaging_types),
  'unclassified,unknown,cardboard-box,jewel-case,double-depth-jewel-case,plastic-case,paper-sleeve', 'the seven approved packaging codes, in order');
select is((select string_agg(code, ',' order by position) from public.packaging_types where not is_type), 'unclassified,unknown', 'unclassified and unknown are states, not types');
select is((select count(*)::int from public.packaging_types where code in ('multi-disc-jewel-case', 'big-box', 'double-jewel-case')), 0, 'no multi-disc, big-box or overlapping type');
select is((select count(*)::int from public.packaging_types where description ~* '(disc count|number of discs).*(defines|decides)'), 0, 'no type is defined by disc count');
select ok((select relrowsecurity from pg_class where oid = 'public.packaging_types'::regclass)
  and has_table_privilege('anon', 'public.packaging_types', 'select') and has_table_privilege('authenticated', 'public.packaging_types', 'select'),
  'the vocabulary is public and read-only, with RLS');
select is((select count(*)::int from unnest(array['anon', 'authenticated', 'service_role', 'catalog_importer']) r, unnest(array['insert', 'update', 'delete', 'truncate']) p
  where has_table_privilege(r, 'public.packaging_types', p)), 0, 'no client role or the importer can change it');
select is((select format('%s/%s/%s', is_nullable, column_default, data_type) from information_schema.columns where table_schema = 'public' and table_name = 'releases' and column_name = 'packaging_code'),
  'NO/''unclassified''::text/text', 'releases.packaging_code is required and defaults to unclassified');
select ok(exists (select 1 from pg_constraint where conrelid = 'public.releases'::regclass and contype = 'f' and confrelid = 'public.packaging_types'::regclass), 'and refers to the vocabulary');
select ok(has_column_privilege('anon', 'public.releases', 'packaging_code', 'select') and has_column_privilege('authenticated', 'public.releases', 'packaging_code', 'select')
  and not has_column_privilege('authenticated', 'public.releases', 'packaging_code', 'update'), 'clients can read it and can''t write it');
select is((select string_agg(p.slug || ':' || f.media_format_code, ',' order by p.slug) from public.platform_media_formats f join public.platforms p on p.id = f.platform_id where not f.accepts_new_publications),
  'nes:rom-cartridge,snes:rom-cartridge', 'only the generic cartridge on nes and snes is closed to new publications');
select is((select string_agg(p.proname || ':' || p.provolatile::text, ',' order by p.proname) from pg_proc p where p.oid in
  ('private.release_label_key(text)'::regprocedure, 'private.release_code_key(text)'::regprocedure, 'private.release_packaging_key(text,text)'::regprocedure)),
  'release_code_key:i,release_label_key:i,release_packaging_key:i', 'the key functions are immutable');
select is((select count(*)::int from unnest(array['anon', 'authenticated', 'service_role', 'catalog_importer']) r,
  unnest(array['private.release_label_key(text)', 'private.release_code_key(text)', 'private.release_packaging_key(text,text)', 'private.guard_release_packaging_and_format()']) f
  where has_function_privilege(r, f, 'execute')), 0, 'and private');
select is((select string_agg(indexname, ',' order by indexname) from pg_indexes where schemaname = 'public' and tablename = 'releases' and indexname like 'releases_p%_key%'),
  'releases_pending_submission_key,releases_published_identity_key', 'both identity indexes keep their names, with no leftover');
select ok((select bool_and(indexdef like '%media_format_code%' and indexdef like '%release_label_key(edition_name)%' and indexdef like '%release_label_key(variant_name)%'
    and indexdef like '%release_packaging_key(packaging_code, packaging)%' and indexdef like '%release_code_key(product_code)%' and indexdef like '%NULLS NOT DISTINCT%'
    and indexdef like 'CREATE UNIQUE INDEX%')
  from pg_indexes where schemaname = 'public' and indexname in ('releases_published_identity_key', 'releases_pending_submission_key')),
  'both use the same final key: format, normalized labels and code, and the packaging key');
select ok((select indexdef like '%(submitted_by, game_id%' and indexdef like '%WHERE ((status = ANY%' and indexdef like '%submitted_by IS NOT NULL%'
  from pg_indexes where indexname = 'releases_pending_submission_key'), 'the pending index keeps its submitter and partial condition');
select ok(exists (select 1 from pg_trigger where tgrelid = 'public.releases'::regclass and tgname = 'guard_release_packaging_and_format' and tgtype & 2 = 2 and tgtype & 4 = 4 and tgtype & 16 = 16),
  'a before insert or update trigger guards packaging and format');
select ok('packaging_code' = any (private.release_identity_fields()) and private.lockable_field('release', 'packaging_code'),
  'packaging_code is an identity field (an edit ends verification) and can be locked');

-- ---------------------------------------------------------------------------
-- Comparison keys
-- ---------------------------------------------------------------------------
select is(private.release_label_key(E'  Players’   Choice '), private.release_label_key('players'' choice'), 'labels ignore case, spacing and typographic apostrophes');
select isnt(private.release_label_key('Players'' Choice'), private.release_label_key('Players Choice'), 'but keep punctuation');
select isnt(private.release_label_key('Édition limitée'), private.release_label_key('Edition limitee'), 'and accents');
select is(private.release_label_key(E'Édition'), private.release_label_key('édition'), 'a decomposed accent equals the composed one (NFC)');
select is(private.release_label_key('プレイステーション・ザ・ベスト'), 'プレイステーション・ザ・ベスト', 'Japanese text is unchanged');
select is(private.release_label_key(E'Grand Prix') || '/' || coalesce(private.release_label_key('   '), 'null'), 'grand prix/null', 'other spaces count as spaces; blank is null');
select is(private.release_code_key('  sns-zl-usa '), 'SNS-ZL-USA', 'codes ignore case and surrounding space');
select isnt(private.release_code_key('SNS-ZL-USA'), private.release_code_key('SNS ZL USA'), 'hyphens and inner spaces stay significant');
select isnt(private.release_code_key('SNSP-ZL-NOE/SFRG'), private.release_code_key('SNSP-ZL-NOE'), 'a combined code is not split');
select isnt(private.release_code_key('SLUS.00594'), private.release_code_key('SLUS-00594'), 'dots are not hyphens');
select isnt(private.release_packaging_key('unclassified', 'Jewel case'), private.release_packaging_key('unclassified', 'jewel case'),
  'an unclassified release keeps its exact historical packaging text');
select is(private.release_packaging_key('jewel-case', 'Jewel case'), private.release_packaging_key('jewel-case', 'anything'), 'a classified release compares by type alone');
select isnt(private.release_packaging_key('unclassified', null), private.release_packaging_key('unknown', null), 'unknown and unclassified differ');

-- ---------------------------------------------------------------------------
-- The published identity index
-- ---------------------------------------------------------------------------
select is(pg_temp.pub('L1', 'snes', 'rom-cartridge', 'ntsc-uc', 'Standard', null, 'unclassified', 'Jewel case', 'IDT-1'), 'ok', 'a legacy unclassified release');
select is(pg_temp.pub('L2', 'snes', 'rom-cartridge', 'ntsc-uc', 'Standard', null, 'unclassified', 'Big box', 'IDT-1'), 'ok',
  'and one that differed only in its packaging text stay separate');
select matches(pg_temp.pub('L3', 'snes', 'rom-cartridge', 'ntsc-uc', 'Standard', null, 'unclassified', 'Jewel case', 'IDT-1'), 'releases_published_identity_key',
  'the same unclassified text is the same identity');
select is(pg_temp.pub('C1', 'snes', 'snes-game-pak-na', 'ntsc-uc', 'Standard', null, 'cardboard-box', 'Box', 'IDT-2'), 'ok', 'a classified release');
select matches(pg_temp.pub('C2', 'snes', 'snes-game-pak-na', 'ntsc-uc', 'Standard', null, 'cardboard-box', 'Other wording', 'IDT-2'), 'releases_published_identity_key',
  'two classified releases of one type collide whatever their recorded text');
select is(pg_temp.pub('F1', 'nes', 'famicom-cartridge', 'asia', 'Standard', null, 'cardboard-box', null, 'IDT-3')
  || '/' || pg_temp.pub('F2', 'nes', 'nes-game-pak', 'asia', 'Standard', null, 'cardboard-box', null, 'IDT-3'), 'ok/ok',
  'a Famicom cartridge and an NES Game Pak with otherwise equal fields are separate');
select matches(pg_temp.pub('F3', 'nes', 'famicom-cartridge', 'asia', 'Standard', null, 'cardboard-box', null, 'IDT-3'), 'releases_published_identity_key', 'the same shell twice collides');
select is(pg_temp.pub('S1', 'snes', 'snes-cartridge-jp-pal', 'asia', 'Standard', null, 'cardboard-box', null, 'IDT-4')
  || '/' || pg_temp.pub('S2', 'snes', 'snes-game-pak-na', 'asia', 'Standard', null, 'cardboard-box', null, 'IDT-4'), 'ok/ok',
  'the Super Famicom / PAL shell and the North American shell are separate');
select matches(pg_temp.pub('S3', 'snes', 'snes-game-pak-na', 'asia', 'Standard', null, 'cardboard-box', null, 'idt-4'), 'releases_published_identity_key',
  'a product code differing only in case collides');
select is(pg_temp.pub('S4', 'snes', 'snes-game-pak-na', 'asia', 'Standard', null, 'cardboard-box', null, 'IDT 4'), 'ok', 'one differing in a separator does not');
select matches(pg_temp.pub('S5', 'snes', 'snes-game-pak-na', 'asia', E'STANDARD ', null, 'cardboard-box', null, 'IDT-4'), 'releases_published_identity_key',
  'an edition differing only in case or spacing collides');
select is(pg_temp.pub('S6', 'snes', 'snes-game-pak-na', 'asia', 'Standard', 'Édition', 'cardboard-box', null, 'IDT-4')
  || '/' || pg_temp.pub('S7', 'snes', 'snes-game-pak-na', 'asia', 'Standard', 'Edition', 'cardboard-box', null, 'IDT-4'), 'ok/ok', 'variants differing in an accent are separate');
select is(pg_temp.pub('P1', 'playstation', 'cd-rom', 'ntsc-uc', 'Standard', null, 'jewel-case', null, 'SCUS-99001', 3)
  || '/' || pg_temp.pub('P2', 'playstation', 'cd-rom', 'ntsc-uc', 'Standard', null, 'double-depth-jewel-case', null, 'SCUS-99001', 3), 'ok/ok',
  'a three-disc release in a jewel case and in a double-depth jewel case are separate packages');

-- ---------------------------------------------------------------------------
-- Classifying a legacy release
-- ---------------------------------------------------------------------------
select is(pg_temp.pub('J1', 'snes', 'rom-cartridge', 'pal', 'Standard', null, 'unclassified', 'Jewel case', 'IDT-5')
  || '/' || pg_temp.pub('J2', 'snes', 'rom-cartridge', 'pal', 'Standard', null, 'unclassified', 'jewel case', 'IDT-5'), 'ok/ok',
  'two legacy releases whose texts differ only in case are still separate');
select is(pg_temp.edit('e9', 'J1', '{"packaging_code": "jewel-case"}'), 'true', 'an editor classifies the first, a published edit with recent MFA');
select matches(pg_temp.edit('e9', 'J2', '{"packaging_code": "jewel-case"}'), 'releases_published_identity_key',
  'classifying the second the same way collides, so a duplicate surfaces instead of merging silently');
select is((select packaging_code || '/' || packaging from public.releases where id = pg_temp.id('J2')), 'unclassified/jewel case', 'and the second is unchanged');
select is((select count(*)::int from private.audit_events where action = 'catalog_record_updated' and metadata ->> 'id' = pg_temp.id('J1')::text
  and metadata -> 'fields' ? 'packaging_code' and actor_id = pg_temp.u('e9') and reason = 'Identity tests'), 1,
  'the classification is audited, with its reason and the field');

-- ---------------------------------------------------------------------------
-- Pending submissions and the submission duplicate check
-- ---------------------------------------------------------------------------
select is(pg_temp.sub('{"edition_name": "Standard", "product_code": "PND-1"}')::jsonb ->> 'outcome', 'submitted', 'a collector submits a release');
select is(pg_temp.sub('{"edition_name": "Standard", "product_code": "PND-1"}'), 'error: already submitted', 'the same release twice is refused, with the friendly message');
select is(pg_temp.sub('{"edition_name": "standard", "product_code": "pnd-1"}'), 'error: already submitted', 'also when only case differs');
select is(pg_temp.sub('{"edition_name": "Standard", "product_code": "PND-1"}', 'snes-cartridge-jp-pal')::jsonb ->> 'outcome', 'submitted', 'a different shell is a different release');
select is(pg_temp.sub('{"edition_name": "Standard", "product_code": "PND-2", "packaging_code": "unknown"}'), 'error: invalid submission', 'only an editor records Unknown');
select is(pg_temp.sub('{"edition_name": "Standard", "product_code": "PND-2", "packaging_code": "steelbook"}'), 'error: invalid submission', 'a packaging code must be in the vocabulary');
select is(pg_temp.pub('D1', 'snes', 'snes-game-pak-na', 'ntsc-uc', 'Standard', null, 'cardboard-box', null, 'SUB-1'), 'ok', 'a published classified release');
select is(pg_temp.sub('{"edition_name": "standard", "product_code": "sub-1", "packaging_code": "cardboard-box"}', 'snes-game-pak-na', 'ntsc-uc')::jsonb,
  jsonb_build_object('outcome', 'published_duplicate', 'release_id', pg_temp.id('D1')), 'the same release is pointed to, compared as the index compares');
select is(pg_temp.sub('{"edition_name": "Standard", "product_code": "SUB-1", "packaging_code": "cardboard-box"}', 'snes-cartridge-jp-pal', 'ntsc-uc')::jsonb ->> 'outcome', 'submitted',
  'another shell is not that release');
select is(pg_temp.sub('{"edition_name": "Standard", "product_code": "SUB-1"}', 'snes-game-pak-na', 'ntsc-uc')::jsonb ->> 'outcome', 'submitted',
  'Not sure is not a classified type, so it goes to review instead of being matched');

-- ---------------------------------------------------------------------------
-- Publication rules
-- ---------------------------------------------------------------------------
select is(pg_temp.rel('R1', 'snes', 'rom-cartridge', 'ntsc-uc', '{"edition_name": "Standard", "edition_kind": "standard", "media_count": 1, "product_code": "PUB-1"}'), 'created', 'an editor''s release, unclassified, on the legacy shell');
select is(pg_temp.verify('R1'), 'true', 'verified by another editor');
select is(pg_temp.publish('R1'), 'error: packaging classification required', 'unclassified packaging can''t be newly published');
select is(pg_temp.edit('e1', 'R1', '{"packaging_code": "cardboard-box"}'), 'true', 'its creator classifies it');
select is((select verified_at is null from public.releases where id = pg_temp.id('R1')), true, 'which ends the verification: packaging is an identity field');
select is(pg_temp.verify('R1') || '/' || pg_temp.publish('R1'), 'true/error: physical format unverified', 'a new SNES release can''t be published on the generic cartridge');
select is(pg_temp.edit('e1', 'R1', '{"media_format_code": "snes-game-pak-na"}') || '/' || pg_temp.verify('R1') || '/' || pg_temp.publish('R1'), 'true/true/true',
  'with its shell recorded and verified again, it is published');
select is(pg_temp.as_user('e1', format('select public.publish_release(%L, %L, %s)::text', pg_temp.id('R1'), 'Publish', pg_temp.rev('R1'))), 'false', 'and stays published');
select is(pg_temp.rel('R2', 'playstation', 'cd-rom', 'pal', '{"edition_name": "Standard", "edition_kind": "standard", "media_count": 3, "product_code": "PUB-2"}'), 'created', 'a three-disc release');
select is((select packaging_code from public.releases where id = pg_temp.id('R2')), 'unclassified', 'gets no packaging from its disc count');
select is(pg_temp.edit('e1', 'R2', '{"packaging_code": "unknown"}') || '/' || pg_temp.verify('R2') || '/' || pg_temp.publish('R2'), 'true/true/true',
  'an editor may record Unknown, with a reason, and it can be published');
select is(pg_temp.rel('R3', 'nes', 'nes-game-pak', 'ntsc-uc', '{"edition_name": "Standard", "edition_kind": "standard", "media_count": 1, "packaging_code": "cardboard-box"}'), 'created',
  'an NES Game Pak, classified at creation');
select is(pg_temp.edit('e1', 'R3', '{"packaging_code": "unclassified"}'), 'error: packaging already classified', 'classified packaging never returns to unclassified');
select is(pg_temp.verify('R3') || '/' || pg_temp.publish('R3'), 'true/true', 'a new NES shell is published');
select is(pg_temp.as_user('e1', format('select public.publish_release(%L, %L, %s)::text', pg_temp.id('R3'), 'Self', pg_temp.rev('R3'))), 'false',
  'publishing it again changes nothing');
select is(pg_temp.rel('R4', 'nes', 'famicom-cartridge', 'ntsc-j', '{"edition_name": "Standard", "edition_kind": "standard", "media_count": 1, "packaging_code": "cardboard-box"}')
  || '/' || pg_temp.as_user('e1', format('select public.verify_release(%L, %L, %s)::text', pg_temp.id('R4'), 'Self', pg_temp.rev('R4'))), 'created/error: own record',
  'no self-review: the creator of a Famicom release can''t verify it');

-- Grandfathered releases
select is(pg_temp.pub('G1', 'snes', 'rom-cartridge', 'ntsc-uc', 'Standard', null, 'unclassified', 'Big box', 'OLD-1'), 'ok', 'a release published before M11b-1b');
select is(pg_temp.edit('e9', 'G1', '{"local_title": "Zqi Old Title"}'), 'true', 'is edited normally, though unclassified and on the generic cartridge');
select is((select format('%s/%s/%s/%s', status, packaging_code, packaging, media_format_code) from public.releases where id = pg_temp.id('G1')),
  'published/unclassified/Big box/rom-cartridge', 'and keeps everything else, including its recorded packaging');

-- Restoring an excluded legacy release returns a release that was already published, so
-- the new-publication rules don't apply. A definer function stands in for restore_exclusion.
create function pg_temp.set_status(p uuid, s public.catalog_status) returns text language sql security definer as $$
  update public.releases set status = s where id = p returning status::text $$;
grant execute on function pg_temp.set_status(uuid, public.catalog_status) to authenticated;
select is(pg_temp.pub('X1', 'snes', 'rom-cartridge', 'pal', 'Standard', null, 'unclassified', null, 'EXC-1')
  || '/' || pg_temp.try(format($$update public.releases set status = 'excluded' where id = %L returning status::text$$, pg_temp.id('X1'))), 'ok/excluded',
  'a legacy release, unclassified on the generic cartridge, is excluded');
select is(pg_temp.as_user('e9', format('select pg_temp.set_status(%L, %L)', pg_temp.id('X1'), 'published')), 'published',
  'and can be restored to published through an API session');

-- A collector's own submission
select is(pg_temp.sub('{"edition_name": "Limited", "edition_kind": "limited", "media_count": 1, "product_code": "OWN-1", "packaging_code": "cardboard-box"}')::jsonb ->> 'outcome', 'submitted', 'a collector chooses a type');
select is(pg_temp.as_user('c3', format('select public.update_my_submission(%L, %L)::text',
  (select s.id from public.catalog_change_requests s join public.releases r on r.id = s.release_id where r.product_code = 'OWN-1'),
  '{"details": {"edition_name": "Limited", "edition_kind": "limited", "media_count": 1, "product_code": "OWN-1"}}')), 'true', 'and may change it back to Not sure on their open submission');
select is((select packaging_code from public.releases where product_code = 'OWN-1'), 'unclassified', 'which is recorded');

-- Approval publishes through the same rules
select is(pg_temp.as_user('e9', format('select public.start_submission_review(%L, %L, %L)::text',
  (select s.id from public.catalog_change_requests s join public.releases r on r.id = s.release_id where r.product_code = 'OWN-1'),
  (select s.version from public.catalog_change_requests s join public.releases r on r.id = s.release_id where r.product_code = 'OWN-1'), 'Checking')) not like 'error%', true,
  'an editor reviews the submission');
select is(pg_temp.as_user('e9', format('select public.approve_submission(%L, %L, %L, %L, %L, %L)::text',
  (select s.id from public.catalog_change_requests s join public.releases r on r.id = s.release_id where r.product_code = 'OWN-1'),
  (select s.version from public.catalog_change_requests s join public.releases r on r.id = s.release_id where r.product_code = 'OWN-1'),
  (select r.revision from public.releases r where r.product_code = 'OWN-1'), null, 'Approve', null)), 'error: packaging classification required',
  'approval can''t publish an unclassified release either');

select * from finish();
rollback;
