-- M1: reference seed integrity and structure.
begin;
create extension if not exists pgtap with schema extensions;
select plan(48);

-- Region codes: exactly the 11 approved values, in order
select results_eq(
  'select code from public.region_codes order by position',
  array['ntsc-uc', 'ntsc-j', 'ntsc-k', 'ntsc-c', 'pal', 'asia', 'latam', 'pal-m', 'pal-n', 'region-free', 'unknown'],
  'exactly the 11 approved region codes, in order'
);

-- Markets: official ISO alpha-2 only
select is((select count(*)::int from public.markets), 249, '249 officially assigned ISO 3166-1 alpha-2 markets');
select is((select count(*)::int from public.markets where code !~ '^[A-Z]{2}$'), 0, 'every market code is two capital letters');
select is((select count(*)::int from public.markets where code in ('EU', 'XK', 'UK', 'SU', 'YU', 'AN')), 0, 'no groupings, user-assigned or withdrawn codes');
select is((select name from public.markets where code = 'US'), 'United States', 'US name is correct');
select is((select name from public.markets where code = 'GB'), 'United Kingdom', 'GB name is correct');
select is((select count(*)::int from public.markets where code in ('US', 'CA', 'MX', 'JP', 'KR', 'CN', 'HK', 'TW', 'SG', 'DE', 'AT', 'FR', 'AU', 'NZ', 'BR', 'AR', 'PY', 'UY')), 18, 'markets used in the approved examples exist');

-- Regions and markets stay separate
select is(
  (select count(*)::int from information_schema.columns where table_schema = 'public' and table_name = 'markets' and column_name ~ 'region'),
  0, 'markets has no region column'
);
select is(
  (select count(*)::int from information_schema.columns where table_schema = 'public' and table_name = 'region_codes' and column_name ~ '(market|country)'),
  0, 'region_codes has no market or country column'
);
select is(
  (select count(*)::int from pg_constraint c join pg_class f on f.oid = c.confrelid join pg_class t on t.oid = c.conrelid
    where c.contype = 'f' and ((f.relname = 'region_codes' and t.relname = 'markets') or (f.relname = 'markets' and t.relname = 'region_codes'))),
  0, 'no foreign key links regions and markets'
);
select is(
  (select count(*)::int from pg_tables where schemaname = 'public' and tablename ~ '(region.*market|market.*region|region.*countr)'),
  0, 'no region-to-market mapping table exists'
);

-- Platforms
select is((select count(*)::int from public.platforms), 58, '58 platforms seeded');
select is((select count(*)::int from public.platforms where base_platform_id is not null), 6, 'six add-on platforms');
select is((select count(distinct slug)::int from public.platforms), 58, 'every slug is unique');
select is((select count(*)::int from public.platforms where manufacturer is null), 0, 'every seeded platform records a manufacturer');
select is((select manufacturer from public.platforms where slug = 'nintendo-64dd'), 'Nintendo', 'manufacturer is the owner, not a contract assembler');
select is((select count(*)::int from public.platforms where manufacturer ~* '(foxconn|hosiden|alps|flextronics|wistron)'), 0, 'no contract assembler is recorded as manufacturer');

-- Physical-only scope, and no generation column
select is(
  (select count(*)::int from public.platforms where slug ~* '(stadia|ouya|zeebo|playdate|steam|mvs|arcade|game-watch|classic|mini)' or name ~* '(stadia|ouya|zeebo|playdate|steam deck)'),
  0, 'no digital-only, arcade or built-in-game system is a platform'
);
select is((select count(*)::int from public.platforms where slug ~ '(pocket-|dsi|new-3ds|slim|lite|oled|-pro$|series-s)' and slug not in ('neo-geo-pocket-color')), 0, 'hardware revisions are not platforms');
select hasnt_column('public', 'platforms', 'generation', 'generation was removed');
select hasnt_column('public', 'platforms', 'media_formats', 'platform media is normalized, not an array');

-- Add-on relationships
select is((select b.slug from public.platforms a join public.platforms b on b.id = a.base_platform_id where a.slug = 'mega-cd'), 'mega-drive', 'Mega-CD attaches to Mega Drive');
select is((select b.slug from public.platforms a join public.platforms b on b.id = a.base_platform_id where a.slug = 'sega-32x'), 'mega-drive', '32X attaches to Mega Drive');
select is((select b.slug from public.platforms a join public.platforms b on b.id = a.base_platform_id where a.slug = 'nintendo-64dd'), 'nintendo-64', '64DD attaches to Nintendo 64');
select is((select b.slug from public.platforms a join public.platforms b on b.id = a.base_platform_id where a.slug = 'atari-jaguar-cd'), 'atari-jaguar', 'Jaguar CD attaches to Jaguar');
select is((select b.slug from public.platforms a join public.platforms b on b.id = a.base_platform_id where a.slug = 'famicom-disk-system'), 'nes', 'Disk System attaches to NES');
select throws_ok(
  $$update public.platforms set base_platform_id = id where slug = 'nes'$$,
  '23514', null, 'a platform can''t be its own base'
);
select throws_ok(
  $$update public.platforms set base_platform_id = (select id from public.platforms where slug = 'mega-cd') where slug = 'dreamcast'$$,
  '23514', 'a base platform can''t itself be an add-on', 'an add-on can''t be a base'
);
select throws_ok(
  $$update public.platforms set base_platform_id = (select id from public.platforms where slug = 'snes') where slug = 'mega-drive'$$,
  '23514', 'a platform with add-ons can''t itself be an add-on', 'a platform with add-ons can''t become an add-on'
);

-- Stable slugs
select throws_ok(
  $$update public.platforms set slug = 'sega-genesis' where slug = 'mega-drive'$$,
  '23514', 'platform slugs are stable and can''t be changed', 'a slug can''t change'
);
select lives_ok($$update public.platforms set name = 'Sega Mega Drive' where slug = 'mega-drive'$$, 'the display name can change');
select is((select slug from public.platforms where name = 'Sega Mega Drive'), 'mega-drive', 'the identity survives a rename');

-- Aliases
select is((select p.slug from public.platform_names n join public.platforms p on p.id = n.platform_id where n.name = 'Genesis'), 'mega-drive', 'Genesis resolves to Mega Drive');
select is((select p.slug from public.platform_names n join public.platforms p on p.id = n.platform_id where n.name = 'Famicom'), 'nes', 'Famicom resolves to NES');
select is((select p.slug from public.platform_names n join public.platforms p on p.id = n.platform_id where n.name = 'TurboGrafx-16'), 'pc-engine', 'TurboGrafx-16 resolves to PC Engine');
select is((select count(*)::int from public.platform_names where name = 'Sega CD'), 2, 'one name can apply in two regions');
select is((select count(*)::int from public.platform_names where name ~* '(dendy|pegasus|hi-saturn|v-saturn|coregrafx|wondermega|project reality|dolphin|revolution|project caf)'), 0, 'clones, hardware models and codenames are not aliases');
select is((select count(*)::int from information_schema.columns where table_schema = 'public' and table_name = 'platform_names' and column_name ~ 'compat'), 0, 'aliases carry no compatibility meaning');

-- Media model
select is((select count(*)::int from public.media_formats), 24, '24 media formats seeded');
select enum_has_labels('public', 'media_category', array['cartridge', 'optical_disc', 'solid_state_card', 'magnetic_disk', 'magnetic_tape'], 'categories cover home-computer and PC media');
select is((select count(*)::int from public.media_formats where code ~* '(^other$|digital|download|stream|cloud|entitlement)'), 0, 'no generic other or digital format exists');
select throws_ok(
  $$insert into public.media_formats (code, category, name, position) values ('game-key-card', 'solid_state_card', 'Game-Key Card', 999)$$,
  '23514', null, 'a key-card format is rejected'
);
select lives_ok(
  $$insert into public.media_formats (code, category, name, position) values ('compact-cassette', 'magnetic_tape', 'Compact cassette', 510), ('floppy-3-5', 'magnetic_disk', '3.5-inch floppy disk', 430)$$,
  'later computer media fits without a schema change'
);

-- Valid platform and format pairs
select is((select count(*)::int from public.platforms p where not exists (select 1 from public.platform_media_formats m where m.platform_id = p.id)), 0, 'every platform has at least one format');
select is((select array_agg(media_format_code order by media_format_code) from public.platform_media_formats m join public.platforms p on p.id = m.platform_id where p.slug = 'playstation-2'), array['cd-rom', 'dvd-rom'], 'PlayStation 2 has both its real formats');
select is((select media_format_code from public.platform_media_formats m join public.platforms p on p.id = m.platform_id where p.slug = 'wii'), 'wii-optical-disc', 'Wii uses its proprietary disc, not standard DVD');
select is((select media_format_code from public.platform_media_formats m join public.platforms p on p.id = m.platform_id where p.slug = 'pc-engine'), 'hucard', 'PC Engine uses HuCard');

-- Hardware requirements are definitions, not ownable hardware
select is((select count(*)::int from public.hardware_requirements), 11, '11 hardware requirement definitions');

select * from finish();
rollback;
