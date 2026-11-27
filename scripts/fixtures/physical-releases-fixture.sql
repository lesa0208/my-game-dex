-- Physical Releases 2.0 (Phase 4A): a SYNTHETIC test catalog of physical releases, for the
-- release-card checks and screenshots on the isolated scratch stack only.
--
-- Every title says "Fixture" and every product code carries "ZZ"; barcodes use the 200
-- prefix, which is reserved for in-store use and never printed on a retail product. None of
-- this describes a real release. Never install it on the demo, development, pilot or a hosted
-- stack (the checks that install it refuse any stack but scratch).
--
-- Built the way the collector fast-add fixture is, with the same fixture editor and reviewer,
-- so scripts/catalog-fixture.mjs installs and removes it alike. Idempotent: if the fixture
-- editor exists, nothing happens.

\set ON_ERROR_STOP on
begin;
\o /dev/null
select exists (select 1 from auth.users where id = 'f1c5f1c5-0000-4000-8000-00000000c5c5') as installed \gset
\if :installed
  \echo 'A catalog fixture is already installed.'
  rollback;
  \quit
\endif

-- The fixture editor. Made in SQL (it needs a fixed id, and its Auth rows below in the
-- same transaction), so the row sets what GoTrue itself writes: v2.197 reads these four
-- token columns as strings and the two times as times, and none has a default. Without
-- them Auth can't list users at all (M11a-5).
insert into auth.users (id, aud, role, email, email_confirmed_at, instance_id,
                        confirmation_token, recovery_token, email_change_token_new, email_change, created_at, updated_at)
values ('f1c5f1c5-0000-4000-8000-00000000c5c5', 'authenticated', 'authenticated', 'catalog-fixture@example.test', now(), '00000000-0000-0000-0000-000000000000',
        '', '', '', '', now(), now());
update public.profiles set handle = 'catalog_fixture', handle_changed_at = now() where id = 'f1c5f1c5-0000-4000-8000-00000000c5c5';
insert into public.staff_roles (user_id, role) values ('f1c5f1c5-0000-4000-8000-00000000c5c5', 'catalog_editor');
-- M8b: staff need a live aal2 session with a verified TOTP factor. The fixture editor
-- is made in SQL, so it gets Auth rows of the shape GoTrue writes, removed with it. Its
-- factor's secret is '' (GoTrue reads it as a string; this factor never verifies a code).
insert into auth.sessions (id, user_id, aal, factor_id, created_at, updated_at)
values ('f1c5f1c5-0000-4000-8000-00000000c5c5', 'f1c5f1c5-0000-4000-8000-00000000c5c5', 'aal2', 'f1c5f1c5-0000-4000-8000-00000000c5c5', now(), now());
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret)
values ('f1c5f1c5-0000-4000-8000-00000000c5c5', 'f1c5f1c5-0000-4000-8000-00000000c5c5', 'fixture', 'totp', 'verified', now(), now(), '');
insert into auth.mfa_amr_claims (id, session_id, authentication_method, created_at, updated_at)
values (gen_random_uuid(), 'f1c5f1c5-0000-4000-8000-00000000c5c5', 'totp', now(), now());

-- The fixture reviewer, with the same Auth rows.
insert into auth.users (id, aud, role, email, email_confirmed_at, instance_id,
                        confirmation_token, recovery_token, email_change_token_new, email_change, created_at, updated_at)
values ('f1c5f1c5-0000-4000-8000-00000000c5c6', 'authenticated', 'authenticated', 'catalog-fixture-reviewer@example.test', now(), '00000000-0000-0000-0000-000000000000',
        '', '', '', '', now(), now());
update public.profiles set handle = 'catalog_fixture_rv', handle_changed_at = now() where id = 'f1c5f1c5-0000-4000-8000-00000000c5c6';
insert into public.staff_roles (user_id, role) values ('f1c5f1c5-0000-4000-8000-00000000c5c6', 'catalog_editor');
insert into auth.sessions (id, user_id, aal, factor_id, created_at, updated_at)
values ('f1c5f1c5-0000-4000-8000-00000000c5c6', 'f1c5f1c5-0000-4000-8000-00000000c5c6', 'aal2', 'f1c5f1c5-0000-4000-8000-00000000c5c6', now(), now());
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret)
values ('f1c5f1c5-0000-4000-8000-00000000c5c6', 'f1c5f1c5-0000-4000-8000-00000000c5c6', 'fixture', 'totp', 'verified', now(), now(), '');
insert into auth.mfa_amr_claims (id, session_id, authentication_method, created_at, updated_at)
values (gen_random_uuid(), 'f1c5f1c5-0000-4000-8000-00000000c5c6', 'totp', now(), now());

create temp table fx (name text primary key, id uuid not null);
grant all on fx to authenticated;

create function pg_temp.fx_id(p text) returns uuid language sql stable as $$ select id from fx where name = p $$;

-- Acts as the fixture editor ('editor') or the reviewer ('reviewer').
create function pg_temp.fx_as(p text) returns void language sql as $$
  select set_config('request.jwt.claims', pg_catalog.jsonb_build_object('sub', u, 'role', 'authenticated', 'aal', 'aal2', 'session_id', u)::text, true)
  from (select case p when 'reviewer' then 'f1c5f1c5-0000-4000-8000-00000000c5c6' else 'f1c5f1c5-0000-4000-8000-00000000c5c5' end as u) x
$$;

-- A verified game, under review until a release is published.
create function pg_temp.fx_game(p_name text, p_title text, p_year date, p_precision public.date_precision, p_kind public.game_kind default 'game')
returns uuid language plpgsql as $$
declare v uuid;
begin
  v := public.create_game(p_title, p_kind, null, null, p_year, p_precision, 'Physical releases fixture (synthetic)');
  perform pg_temp.fx_as('reviewer');
  perform public.verify_game(v, 'Physical releases fixture (synthetic)', (select revision from public.games where id = v));
  perform pg_temp.fx_as('editor');
  insert into fx values (p_name, v);
  return v;
end $$;

-- A release with its details. Verified and published unless p_publish is false.
-- Verification requires an edition and a media count, so a release that doesn't
-- give its own is the standard, single-medium edition. Nothing else is assumed.
create function pg_temp.fx_release(p_name text, p_game text, p_platform text, p_format text, p_region text, p_details jsonb,
  p_markets text[] default null, p_components jsonb default null, p_publish boolean default true, p_requirements jsonb default null)
returns uuid language plpgsql as $$
declare v uuid;
begin
  v := public.create_release(pg_temp.fx_id(p_game), (select id from public.platforms where slug = p_platform), p_format, p_region,
    -- M11b-1b: publication needs a packaging type; a disc is in a jewel case, anything else a box, unless the release says.
    jsonb_build_object('edition_name', 'Standard', 'edition_kind', 'standard', 'media_count', 1,
      'packaging_code', case when p_format = 'cd-rom' then 'jewel-case' else 'cardboard-box' end) || p_details, 'Physical releases fixture (synthetic)');
  if p_markets is not null then
    perform public.set_release_markets(v, p_markets, 'Physical releases fixture (synthetic)');
  end if;
  if p_components is not null then
    perform public.set_release_components(v, p_components, 'Physical releases fixture (synthetic)');
  end if;
  if p_requirements is not null then
    perform public.set_release_requirements(v, p_requirements, 'Physical releases fixture (synthetic)');
  end if;
  perform pg_temp.fx_as('reviewer');
  perform public.verify_release(v, 'Physical releases fixture (synthetic)', (select revision from public.releases where id = v));
  if p_publish then
    perform public.publish_release(v, 'Physical releases fixture (synthetic)', (select revision from public.releases where id = v));
  end if;
  perform pg_temp.fx_as('editor');
  insert into fx values (p_name, v);
  return v;
end $$;

grant execute on function pg_temp.fx_id(text), pg_temp.fx_as(text), pg_temp.fx_game(text, text, date, public.date_precision, public.game_kind),
  pg_temp.fx_release(text, text, text, text, text, jsonb, text[], jsonb, boolean, jsonb) to authenticated;

select set_config('request.jwt.claims', '{"sub": "f1c5f1c5-0000-4000-8000-00000000c5c5", "role": "authenticated", "aal": "aal2", "session_id": "f1c5f1c5-0000-4000-8000-00000000c5c5"}', true);
set local role authenticated;

-- SNES: three regions, editions and variants ------------------------------------
select pg_temp.fx_game('vale', 'Fixture Quest: Lantern Vale', '1994-11-18', 'day');
-- North America: the standard Game Pak, every detail recorded.
select pg_temp.fx_release('vale-us', 'vale', 'snes', 'snes-game-pak-na', 'ntsc-uc',
  '{"product_code": "SNS-ZZLV-USA", "barcode": "2000000000015", "publisher_name": "Placeholder Interactive", "languages": ["en"],
    "release_date": "1994-11-18", "release_date_precision": "day", "rating_labels": ["Fixture rating: All ages"]}',
  array['US', 'CA'], '[{"kind": "insert", "label": "Instruction manual"}, {"kind": "map", "label": "Fold-out world map"}]');
-- North America: a later reprint, and a not-for-resale variant of the standard edition.
select pg_temp.fx_release('vale-us-pc', 'vale', 'snes', 'snes-game-pak-na', 'ntsc-uc',
  '{"product_code": "SNS-ZZLV-USA-1", "edition_name": "Player''s Choice", "edition_kind": "reprint", "publisher_name": "Placeholder Interactive",
    "release_date": "1997-01-01", "release_date_precision": "year"}', array['US']);
select pg_temp.fx_release('vale-us-nfr', 'vale', 'snes', 'snes-game-pak-na', 'ntsc-uc',
  '{"product_code": "SNS-ZZLV-USA", "variant_name": "Not for Resale", "publisher_name": "Placeholder Interactive"}', array['US']);
-- North America: a collector's edition with extras.
select pg_temp.fx_release('vale-us-ce', 'vale', 'snes', 'snes-game-pak-na', 'ntsc-uc',
  '{"product_code": "SNS-ZZLV-USA-CE", "barcode": "2000000000022", "edition_name": "Collector''s Edition", "edition_kind": "collector",
    "publisher_name": "Placeholder Interactive", "release_date": "1994-12-01", "release_date_precision": "month", "languages": ["en"]}',
  array['US'], '[{"kind": "insert", "label": "Instruction manual"}, {"kind": "artwork", "label": "Art print"}, {"kind": "other", "label": "Cloth map"}]');
-- Europe: the PAL cartridge in three languages, and a UK variant.
select pg_temp.fx_release('vale-eu', 'vale', 'snes', 'snes-cartridge-jp-pal', 'pal',
  '{"product_code": "SNSP-ZZLV-EUR", "barcode": "2000000000039", "publisher_name": "Placeholder Interactive Europe", "languages": ["en", "de", "fr"],
    "release_date": "1995-03-23", "release_date_precision": "day"}', array['GB', 'DE', 'FR']);
select pg_temp.fx_release('vale-eu-ukv', 'vale', 'snes', 'snes-cartridge-jp-pal', 'pal',
  '{"product_code": "SNSP-ZZLV-UKV", "variant_name": "UKV", "publisher_name": "Placeholder Interactive Europe", "languages": ["en"]}', array['GB']);
-- Japan: the title on the box in Japanese, the date to the month.
select pg_temp.fx_release('vale-jp', 'vale', 'snes', 'snes-cartridge-jp-pal', 'ntsc-j',
  '{"product_code": "SHVC-ZZLV", "local_title": "フィクスチャー・クエスト", "publisher_name": "Placeholder Interactive", "languages": ["ja"],
    "release_date": "1994-08-01", "release_date_precision": "month"}', array['JP']);

-- NES and Famicom, Mega Drive and Genesis -----------------------------------------
select pg_temp.fx_game('turbo', 'Fixture Racer Turbo', '1990-01-01', 'year');
select pg_temp.fx_release('turbo-nes-us', 'turbo', 'nes', 'nes-game-pak', 'ntsc-uc',
  '{"product_code": "NES-ZZ-USA", "publisher_name": "Placeholder Interactive", "release_date": "1990-06-01", "release_date_precision": "month"}',
  array['US'], '[{"kind": "insert", "label": "Instruction manual"}]');
select pg_temp.fx_release('turbo-nes-eu', 'turbo', 'nes', 'nes-game-pak', 'pal', '{"product_code": "NES-ZZ-EEC"}', array['GB', 'DE']);
-- The Famicom cartridge: no drawn shell for it, so a neutral placeholder.
select pg_temp.fx_release('turbo-fc', 'turbo', 'nes', 'famicom-cartridge', 'ntsc-j',
  '{"product_code": "HVC-ZZ", "local_title": "フィクスチャー・レーサー", "release_date": "1989-12-01", "release_date_precision": "month"}', array['JP']);
select pg_temp.fx_release('turbo-gen', 'turbo', 'mega-drive', 'rom-cartridge', 'ntsc-uc',
  '{"product_code": "MK-ZZ01", "publisher_name": "Placeholder Interactive", "packaging_code": "plastic-case", "release_date": "1991-01-01", "release_date_precision": "year"}',
  array['US']);
select pg_temp.fx_release('turbo-md-eu', 'turbo', 'mega-drive', 'rom-cartridge', 'pal',
  '{"product_code": "MK-ZZ01-50", "packaging_code": "plastic-case", "languages": ["en", "fr"]}', array['GB', 'FR']);
-- The Japanese Mega Drive cartridge has another shell: a neutral placeholder.
select pg_temp.fx_release('turbo-md-jp', 'turbo', 'mega-drive', 'rom-cartridge', 'ntsc-j',
  '{"product_code": "G-ZZ01", "packaging_code": "plastic-case"}', array['JP']);

-- PlayStation, three discs; and Saturn -------------------------------------------
select pg_temp.fx_game('tower', 'Fixture Chronicle: Glass Tower', '1998-01-01', 'year');
select pg_temp.fx_release('tower-us', 'tower', 'playstation', 'cd-rom', 'ntsc-uc',
  '{"product_code": "SLUS-90001", "barcode": "2000000000046", "media_count": 3, "packaging_code": "double-depth-jewel-case",
    "publisher_name": "Placeholder Interactive", "languages": ["en"], "release_date": "1998-09-08", "release_date_precision": "day"}',
  array['US', 'CA'], '[{"kind": "insert", "label": "Instruction manual"}, {"kind": "insert", "label": "Disc booklet", "quantity": 3}]');
select pg_temp.fx_release('tower-us-gh', 'tower', 'playstation', 'cd-rom', 'ntsc-uc',
  '{"product_code": "SLUS-90001GH", "edition_name": "Greatest Hits", "edition_kind": "reprint", "media_count": 3, "packaging_code": "double-depth-jewel-case"}', array['US']);
select pg_temp.fx_release('tower-eu', 'tower', 'playstation', 'cd-rom', 'pal',
  '{"product_code": "SLES-90001", "media_count": 3, "packaging_code": "double-depth-jewel-case", "languages": ["en", "de", "fr", "es", "it"]}',
  array['GB', 'DE', 'FR', 'ES', 'IT']);
select pg_temp.fx_release('tower-jp', 'tower', 'playstation', 'cd-rom', 'ntsc-j',
  '{"product_code": "SLPS-90001", "media_count": 3, "local_title": "フィクスチャー・クロニクル", "languages": ["ja"]}', array['JP']);
select pg_temp.fx_release('tower-saturn', 'tower', 'sega-saturn', 'cd-rom', 'ntsc-j',
  '{"product_code": "T-ZZ001G", "media_count": 2, "packaging_code": "plastic-case", "languages": ["ja"]}',
  array['JP'], null, true, '[{"requirement_code": "saturn-4mb-ram", "level": "required", "note": null}]');

-- Unknown region, incomplete metadata and a format with no drawn shell ------------
select pg_temp.fx_game('loose', 'Fixture Loose Ends', '2001-01-01', 'year');
-- Only what's needed to verify: no code, date, publisher or languages; packaging unknown.
select pg_temp.fx_release('loose-ps2', 'loose', 'playstation-2', 'dvd-rom', 'unknown',
  '{"region_unknown_confirmed": true, "packaging_code": "unknown"}');
select pg_temp.fx_release('loose-gb', 'loose', 'game-boy', 'game-boy-game-pak', 'ntsc-uc', '{"product_code": "DMG-ZZ-USA"}');

reset role;

select count(*) as fixture_records from fx \gset
\echo 'Physical releases fixture (synthetic) installed:' :fixture_records 'records.'
commit;
