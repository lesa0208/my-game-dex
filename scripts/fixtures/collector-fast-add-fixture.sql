-- Collector fast add: a small, verified and published test catalog of fictional NES, SNES
-- and PlayStation games, for the fast-add browser checks.
--
-- Built the way the M5c search fixture is (scripts/fixtures/catalog-search-fixture.sql), with
-- the same fixture editor and reviewer, so scripts/catalog-fixture.mjs installs and removes
-- it alike. Install one fixture or the other, never both: each refuses when the fixture
-- editor exists. Local only. Every title is fictional.
--
-- Idempotent: if the fixture editor exists, nothing happens.

\set ON_ERROR_STOP on
begin;
\o /dev/null

-- M11b-1b: this fixture models the catalog as it was before cartridge shells were
-- recorded, so its NES and SNES releases keep the generic cartridge. That format is reopened for
-- new publication only inside this transaction, and closed again before it commits.
update public.platform_media_formats set accepts_new_publications = true where media_format_code = 'rom-cartridge';

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
  v := public.create_game(p_title, p_kind, null, null, p_year, p_precision, 'Catalog search fixture');
  perform pg_temp.fx_as('reviewer');
  perform public.verify_game(v, 'Catalog search fixture', (select revision from public.games where id = v));
  perform pg_temp.fx_as('editor');
  insert into fx values (p_name, v);
  return v;
end $$;

-- A release with its details. Verified and published unless p_publish is false.
-- Verification requires an edition and a media count, so a release that doesn't
-- give its own is the standard, single-medium edition. Nothing else is assumed.
create function pg_temp.fx_release(p_name text, p_game text, p_platform text, p_format text, p_region text, p_details jsonb,
  p_markets text[] default null, p_components jsonb default null, p_publish boolean default true)
returns uuid language plpgsql as $$
declare v uuid;
begin
  v := public.create_release(pg_temp.fx_id(p_game), (select id from public.platforms where slug = p_platform), p_format, p_region,
    -- M11b-1b: publication needs a packaging type; a disc is in a jewel case, anything else a box, unless the release says.
    jsonb_build_object('edition_name', 'Standard', 'edition_kind', 'standard', 'media_count', 1,
      'packaging_code', case when p_format = 'cd-rom' then 'jewel-case' else 'cardboard-box' end) || p_details, 'Catalog search fixture');
  if p_markets is not null then
    perform public.set_release_markets(v, p_markets, 'Catalog search fixture');
  end if;
  if p_components is not null then
    perform public.set_release_components(v, p_components, 'Catalog search fixture');
  end if;
  perform pg_temp.fx_as('reviewer');
  perform public.verify_release(v, 'Catalog search fixture', (select revision from public.releases where id = v));
  if p_publish then
    perform public.publish_release(v, 'Catalog search fixture', (select revision from public.releases where id = v));
  end if;
  perform pg_temp.fx_as('editor');
  insert into fx values (p_name, v);
  return v;
end $$;

grant execute on function pg_temp.fx_id(text), pg_temp.fx_as(text), pg_temp.fx_game(text, text, date, public.date_precision, public.game_kind),
  pg_temp.fx_release(text, text, text, text, text, jsonb, text[], jsonb, boolean) to authenticated;

select set_config('request.jwt.claims', '{"sub": "f1c5f1c5-0000-4000-8000-00000000c5c5", "role": "authenticated", "aal": "aal2", "session_id": "f1c5f1c5-0000-4000-8000-00000000c5c5"}', true);
set local role authenticated;

-- Published games ---------------------------------------------------------------
-- A collector's pile: fictional NES, SNES and PlayStation games, shaped like the
-- catalog's common cases.

-- NES, one release: nothing to choose, one click to add.
select pg_temp.fx_game('pixel', 'Pixel Knight Saga', '1988-06-01', 'month');
select pg_temp.fx_release('pixel-us', 'pixel', 'nes', 'rom-cartridge', 'ntsc-uc',
  '{"product_code": "NES-PK-USA", "barcode": "0451234599908", "publisher_name": "Lumen Works", "languages": ["en"]}',
  array['US'], '[{"kind": "insert", "label": "Instruction manual"}]');

-- NES, two regions with one edition each: the region is the collector's to pick, then nothing else.
select pg_temp.fx_game('bandit', 'Turbo Bandit', '1990-01-01', 'year');
select pg_temp.fx_release('bandit-us', 'bandit', 'nes', 'rom-cartridge', 'ntsc-uc', '{"product_code": "NES-TB-USA"}', array['US']);
select pg_temp.fx_release('bandit-eu', 'bandit', 'nes', 'rom-cartridge', 'pal', '{"product_code": "NES-TB-EEC"}', array['GB', 'DE', 'FR']);

-- SNES, three regions, and a reprint in North America; a Japanese title and an alias.
select pg_temp.fx_game('aurora', 'Aurora Circuit', '1994-03-01', 'month');
select pg_temp.fx_release('aurora-us', 'aurora', 'snes', 'rom-cartridge', 'ntsc-uc', '{"product_code": "SNS-AC-USA"}', array['US', 'CA']);
select pg_temp.fx_release('aurora-us-pc', 'aurora', 'snes', 'rom-cartridge', 'ntsc-uc',
  '{"product_code": "SNS-AC-USA-PC", "edition_name": "Player''s Choice", "edition_kind": "reprint"}', array['US']);
select pg_temp.fx_release('aurora-eu', 'aurora', 'snes', 'rom-cartridge', 'pal', '{"product_code": "SNSP-AC-EUR"}', array['GB', 'DE']);
select pg_temp.fx_release('aurora-jp', 'aurora', 'snes', 'rom-cartridge', 'ntsc-j', '{"product_code": "SHVC-AC", "local_title": "オーロラサーキット"}', array['JP']);
select public.add_game_alias(pg_temp.fx_id('aurora'), 'Aurora GP', 'alternate', null, 'pal', 'Catalog search fixture');

-- On SNES and PlayStation, North America only: the platform is the one choice.
select pg_temp.fx_game('comet', 'Comet Rally', '1995-01-01', 'year');
select pg_temp.fx_release('comet-snes', 'comet', 'snes', 'rom-cartridge', 'ntsc-uc', '{"product_code": "SNS-CR-USA"}', array['US']);
select pg_temp.fx_release('comet-ps', 'comet', 'playstation', 'cd-rom', 'ntsc-uc', '{"product_code": "SLUS-01888"}', array['US']);

-- PlayStation, two discs: standard and Greatest Hits in North America, standard and
-- Platinum in Europe.
select pg_temp.fx_game('spire', 'Hollow Spire', '1998-01-01', 'year');
select pg_temp.fx_release('spire-us', 'spire', 'playstation', 'cd-rom', 'ntsc-uc', '{"product_code": "SLUS-01999", "barcode": "0711719999901", "media_count": 2}', array['US']);
select pg_temp.fx_release('spire-us-gh', 'spire', 'playstation', 'cd-rom', 'ntsc-uc',
  '{"product_code": "SLUS-01999GH", "edition_name": "Greatest Hits", "edition_kind": "reprint", "media_count": 2}', array['US']);
select pg_temp.fx_release('spire-eu', 'spire', 'playstation', 'cd-rom', 'pal', '{"product_code": "SLES-01999", "media_count": 2}', array['GB', 'DE', 'FR']);
select pg_temp.fx_release('spire-eu-pl', 'spire', 'playstation', 'cd-rom', 'pal',
  '{"product_code": "SLES-01999P", "edition_name": "Platinum", "edition_kind": "reprint", "media_count": 2}', array['GB']);

reset role;

-- The generic cartridge is closed to new NES and SNES publications again (M11b-1b).
update public.platform_media_formats f set accepts_new_publications = false
from public.platforms p where p.id = f.platform_id and p.slug in ('nes', 'snes') and f.media_format_code = 'rom-cartridge';

select count(*) as fixture_records from fx \gset
\echo 'Collector fast-add fixture installed:' :fixture_records 'records.'
commit;
