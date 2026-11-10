-- M5c: a deterministic, verified test catalog for search and the release picker.
--
-- Local only: scripts/catalog-fixture.mjs runs this inside the local database
-- container, and refuses anything else. Every title is fictional. Records are made
-- through the real editor functions, as a fixture catalog editor, so they are
-- verified and published the way an editor's would be. Cases that need M7 functions
-- (merges, exclusions, a rejection) are then set directly.
--
-- Idempotent: if the fixture editor exists, nothing happens.

\set ON_ERROR_STOP on
begin;
\o /dev/null

select exists (select 1 from auth.users where id = 'f1c5f1c5-0000-4000-8000-00000000c5c5') as installed \gset
\if :installed
  \echo 'Catalog search fixture is already installed.'
  rollback;
  \quit
\endif

-- The fixture editor.
insert into auth.users (id, aud, role, email, email_confirmed_at, instance_id)
values ('f1c5f1c5-0000-4000-8000-00000000c5c5', 'authenticated', 'authenticated', 'catalog-fixture@example.test', now(), '00000000-0000-0000-0000-000000000000');
update public.profiles set handle = 'catalog_fixture', handle_changed_at = now() where id = 'f1c5f1c5-0000-4000-8000-00000000c5c5';
insert into public.staff_roles (user_id, role) values ('f1c5f1c5-0000-4000-8000-00000000c5c5', 'catalog_editor');

create temp table fx (name text primary key, id uuid not null);
grant all on fx to authenticated;

create function pg_temp.fx_id(p text) returns uuid language sql stable as $$ select id from fx where name = p $$;

-- A verified game, under review until a release is published.
create function pg_temp.fx_game(p_name text, p_title text, p_year date, p_precision public.date_precision, p_kind public.game_kind default 'game')
returns uuid language plpgsql as $$
declare v uuid;
begin
  v := public.create_game(p_title, p_kind, null, null, p_year, p_precision, 'Catalog search fixture');
  perform public.verify_game(v, 'Catalog search fixture', (select revision from public.games where id = v));
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
    '{"edition_name": "Standard", "edition_kind": "standard", "media_count": 1}'::jsonb || p_details, 'Catalog search fixture');
  if p_markets is not null then
    perform public.set_release_markets(v, p_markets, 'Catalog search fixture');
  end if;
  if p_components is not null then
    perform public.set_release_components(v, p_components, 'Catalog search fixture');
  end if;
  perform public.verify_release(v, 'Catalog search fixture', (select revision from public.releases where id = v));
  if p_publish then
    perform public.publish_release(v, 'Catalog search fixture', (select revision from public.releases where id = v));
  end if;
  insert into fx values (p_name, v);
  return v;
end $$;

grant execute on function pg_temp.fx_id(text), pg_temp.fx_game(text, text, date, public.date_precision, public.game_kind),
  pg_temp.fx_release(text, text, text, text, text, jsonb, text[], jsonb, boolean) to authenticated;

select set_config('request.jwt.claims', '{"sub": "f1c5f1c5-0000-4000-8000-00000000c5c5", "role": "authenticated"}', true);
set local role authenticated;

-- Published games -------------------------------------------------------------

-- Regional releases, an edition, identifiers, components, a Japanese local title,
-- and aliases.
select pg_temp.fx_game('starfall', 'Starfall Odyssey', '1993-11-19', 'day');
select pg_temp.fx_release('starfall-us', 'starfall', 'snes', 'rom-cartridge', 'ntsc-uc',
  '{"product_code": "SNS-ZSFE-USA", "barcode": "0451234500017", "publisher_name": "Lumen Works", "languages": ["en"],
    "release_date": "1993-11-19", "release_date_precision": "day", "media_count": 1}',
  array['US', 'CA'], '[{"kind": "insert", "label": "Instruction manual"}, {"kind": "map", "label": "World map poster"}]');
select pg_temp.fx_release('starfall-eu', 'starfall', 'snes', 'rom-cartridge', 'pal',
  '{"product_code": "SNSP-ZSFP-EUR", "publisher_name": "Lumen Works", "languages": ["en", "de", "fr"],
    "release_date": "1994-01-01", "release_date_precision": "year"}',
  array['GB', 'DE', 'FR']);
select pg_temp.fx_release('starfall-jp', 'starfall', 'snes', 'rom-cartridge', 'ntsc-j',
  '{"product_code": "SHVC-ZSFJ-JPN", "local_title": "スターフォール・オデッセイ", "languages": ["ja"],
    "release_date": "1993-08-01", "release_date_precision": "month"}',
  array['JP']);
select pg_temp.fx_release('starfall-ce', 'starfall', 'snes', 'rom-cartridge', 'ntsc-uc',
  '{"product_code": "SNS-ZSFE-USA-CE", "edition_name": "Collector''s Edition", "edition_kind": "collector", "packaging": "Big box",
    "publisher_name": "Lumen Works", "languages": ["en"], "release_date": "1993-11-19", "release_date_precision": "day", "media_count": 1}',
  array['US'], '[{"kind": "insert", "label": "Art book"}, {"kind": "map", "label": "Cloth map"}]');
select public.add_game_alias(pg_temp.fx_id('starfall'), 'Hoshifuru Odyssey', 'romanized', 'ja-Latn', 'ntsc-j', 'Catalog search fixture');
select public.add_game_alias(pg_temp.fx_id('starfall'), 'SFO', 'abbreviation', null, null, 'Catalog search fixture');

-- Verified but not published, on the published SNES pairing, so only the release's
-- own status keeps it out of search, the picker and the counts.
select pg_temp.fx_release('starfall-draft', 'starfall', 'snes', 'rom-cartridge', 'latam', '{"product_code": "SNS-ZSFE-DRAFT"}', null, null, false);

-- A numbered sequel: "Starfall Odyssey 2" finds it.
select pg_temp.fx_game('starfall2', 'Starfall Odyssey II', '1995-01-01', 'year');
select pg_temp.fx_release('starfall2-us', 'starfall2', 'snes', 'rom-cartridge', 'ntsc-uc',
  '{"product_code": "SNS-ZS2E-USA", "release_date": "1995-01-01", "release_date_precision": "year"}');

-- A leading article.
select pg_temp.fx_game('warden', 'The Crystal Warden', '1991-01-01', 'year');
select pg_temp.fx_release('warden-us', 'warden', 'mega-drive', 'rom-cartridge', 'ntsc-uc', '{"product_code": "MK-1701"}', array['US']);
select pg_temp.fx_release('warden-eu', 'warden', 'mega-drive', 'rom-cartridge', 'pal', '{"product_code": "MK-1701-50"}', array['GB']);
-- An unpublished release on a second platform, which stays hidden.
select pg_temp.fx_release('warden-sms', 'warden', 'master-system', 'rom-cartridge', 'pal', '{}', null, null, false);

-- Accents, on another platform.
select pg_temp.fx_game('poketrail', 'Pokétrail Rangers', '1998-01-01', 'year');
select pg_temp.fx_release('poketrail-us', 'poketrail', 'game-boy', 'game-boy-game-pak', 'ntsc-uc', '{"product_code": "DMG-APTE-USA"}', array['US']);
select pg_temp.fx_release('poketrail-jp', 'poketrail', 'game-boy', 'game-boy-game-pak', 'ntsc-j', '{"product_code": "DMG-APTJ-JPN", "local_title": "ポケトレイル レンジャーズ"}', array['JP']);

-- Word breaks: "Clay Boxer Turbo" finds it.
select pg_temp.fx_game('clayboxer', 'ClayBoxer Turbo', '1994-01-01', 'year');
select pg_temp.fx_release('clayboxer-us', 'clayboxer', 'snes', 'rom-cartridge', 'ntsc-uc', '{}');

-- Optical media, editions and a reprint, on two platforms.
select pg_temp.fx_game('neon', 'Neon Drift Racing', '1996-01-01', 'year');
select pg_temp.fx_release('neon-ps-us', 'neon', 'playstation', 'cd-rom', 'ntsc-uc',
  '{"product_code": "SLUS-00999", "edition_kind": "standard", "media_count": 1, "packaging": "Jewel case"}', array['US']);
select pg_temp.fx_release('neon-ps-us-gh', 'neon', 'playstation', 'cd-rom', 'ntsc-uc',
  '{"product_code": "SLUS-00999GH", "edition_name": "Greatest Hits", "edition_kind": "reprint", "media_count": 1, "packaging": "Jewel case"}', array['US']);
select pg_temp.fx_release('neon-saturn-jp', 'neon', 'sega-saturn', 'cd-rom', 'ntsc-j',
  '{"product_code": "T-99901G", "local_title": "ネオンドリフト レーシング", "media_count": 1}', array['JP']);

-- Several discs.
select pg_temp.fx_game('tessaly', 'Echoes of Tessaly', '1999-01-01', 'year');
select pg_temp.fx_release('tessaly-us', 'tessaly', 'playstation', 'cd-rom', 'ntsc-uc', '{"product_code": "SLUS-01234", "media_count": 3}', array['US']);
select pg_temp.fx_release('tessaly-eu', 'tessaly', 'playstation', 'cd-rom', 'pal', '{"product_code": "SLES-01234", "media_count": 3}', array['GB', 'DE']);

-- Platforms beyond the first import platforms.
select pg_temp.fx_game('lancer', 'Lynx Lancer', '1990-01-01', 'year');
select pg_temp.fx_release('lancer-r', 'lancer', 'atari-lynx', 'rom-cartridge', 'region-free', '{}');
select pg_temp.fx_game('garden', 'Wonder Garden', '2000-01-01', 'year');
select pg_temp.fx_release('garden-jp', 'garden', 'wonderswan-color', 'rom-cartridge', 'ntsc-j', '{"local_title": "ワンダーガーデン"}', array['JP']);

-- Two distinct games with the same title. They stay two results.
select pg_temp.fx_game('harbor-1991', 'Twin Harbor', '1991-01-01', 'year');
select pg_temp.fx_release('harbor-1991-r', 'harbor-1991', 'snes', 'rom-cartridge', 'ntsc-uc', '{}');
select pg_temp.fx_game('harbor-2004', 'Twin Harbor', '2004-01-01', 'year');
select pg_temp.fx_release('harbor-2004-r', 'harbor-2004', 'pc-engine', 'hucard', 'ntsc-j', '{}');

-- A compilation.
select pg_temp.fx_game('moonlit', 'Moonlit Arcade Collection', '1997-01-01', 'year', 'compilation');
select pg_temp.fx_release('moonlit-r', 'moonlit', 'neo-geo-aes', 'rom-cartridge', 'ntsc-j', '{}');

-- Unknown metadata stays unknown: no region, date, edition, codes or count.
select pg_temp.fx_game('meadow', 'Quiet Meadow', null, 'unknown');
select pg_temp.fx_release('meadow-r', 'meadow', 'snes', 'rom-cartridge', 'unknown', '{"region_unknown_confirmed": true}');

-- Records search must never show ------------------------------------------------

-- Verified, never published, with an alias.
select pg_temp.fx_game('hidden', 'Hidden Prototype Quest', '1995-01-01', 'year');
select pg_temp.fx_release('hidden-r', 'hidden', 'snes', 'rom-cartridge', 'ntsc-uc', '{"product_code": "SNS-HPQE-USA"}', null, null, false);
select public.add_game_alias(pg_temp.fx_id('hidden'), 'Secret Starfall Quest', 'alternate', null, null, 'Catalog search fixture');

-- Published, then rejected, excluded or merged (below). A published game always has
-- a published release: the database checks that at commit.
select pg_temp.fx_game('rejected', 'Rejected Racer', '1996-01-01', 'year');
select pg_temp.fx_release('rejected-r', 'rejected', 'snes', 'rom-cartridge', 'ntsc-uc', '{}', null, null, false);
select pg_temp.fx_game('orphan', 'Orphan Saga', '1992-01-01', 'year');
select pg_temp.fx_release('orphan-r', 'orphan', 'snes', 'rom-cartridge', 'ntsc-uc', '{"product_code": "SNS-ORSE-USA"}');
select pg_temp.fx_game('typo', 'Starfall Odysey', '1993-01-01', 'year');
select pg_temp.fx_release('typo-r', 'typo', 'snes', 'rom-cartridge', 'ntsc-uc', '{}');
select pg_temp.fx_game('shadow', 'Shadow Copy', '1993-01-01', 'year');
select pg_temp.fx_release('shadow-r', 'shadow', 'snes', 'rom-cartridge', 'ntsc-uc', '{}');

reset role;

-- What M7 functions will do: reject, exclude and merge.
update public.games set status = 'rejected', verified_at = null, verified_by = null where id = pg_temp.fx_id('rejected');
update public.releases set status = 'excluded' where id = pg_temp.fx_id('orphan-r');
update public.games set status = 'excluded' where id = pg_temp.fx_id('orphan');
update public.releases set status = 'merged', merged_into_id = pg_temp.fx_id('starfall-us') where id = pg_temp.fx_id('typo-r');
update public.games set status = 'merged', merged_into_id = pg_temp.fx_id('starfall') where id = pg_temp.fx_id('typo');
update public.releases set status = 'merged', merged_into_id = pg_temp.fx_id('hidden-r') where id = pg_temp.fx_id('shadow-r');
update public.games set status = 'merged', merged_into_id = pg_temp.fx_id('hidden') where id = pg_temp.fx_id('shadow');
-- A published pairing needs a published release, so these pairings go too.
update public.game_platforms set status = 'excluded'
  where game_id in (pg_temp.fx_id('orphan'), pg_temp.fx_id('typo'), pg_temp.fx_id('shadow'));

select count(*) as fixture_records from fx \gset
\echo 'Catalog search fixture installed:' :fixture_records 'records.'
commit;
