-- PROPOSAL (M12c-B1, B1-M0): title keys normalize Unicode compatibility characters (NFKC).
-- Runs after the B1-M0 migration. Expected values for unchanged titles were read from the
-- database at the M12c-A baseline (2026-11-20), so they prove nothing else moved.
begin;
create extension if not exists pgtap with schema extensions;
select plan(25);

-- The defect: single-character Roman numerals no longer vanish.
select is(private.catalog_search_key('Super Momotaro Dentetsu Ⅱ'), 'super momotaro dentetsu 2', 'search key: Ⅱ is 2');
select is(private.catalog_search_key('Super Momotaro Dentetsu Ⅲ'), 'super momotaro dentetsu 3', 'search key: Ⅲ is 3');
select isnt(private.catalog_search_key('Super Momotaro Dentetsu Ⅱ'), private.catalog_search_key('Super Momotaro Dentetsu Ⅲ'), 'so Ⅱ and Ⅲ are different games');
select is(private.import_title_key('Super Momotaro Dentetsu Ⅱ'), 'super-momotaro-dentetsu-2', 'import key: Ⅱ is 2');
select is(private.catalog_search_key('Albert Odyssey Ⅱ'), private.catalog_search_key('Albert Odyssey II'), 'and Ⅱ matches II');
select is(private.catalog_search_key('ＳＵＰＥＲ ＭＥＴＲＯＩＤ'), 'super metroid', 'fullwidth letters are letters');

-- Distinct numerals stay distinct, in every form.
select isnt(private.catalog_search_key('Breath of Fire II'), private.catalog_search_key('Breath of Fire III'), 'II and III stay distinct');
select isnt(private.catalog_search_key('Breath of Fire Ⅱ'), private.catalog_search_key('Breath of Fire III'), 'Ⅱ and III stay distinct');
select is(private.catalog_search_key('Breath of Fire ⅱ'), private.catalog_search_key('Breath of Fire II'), 'the small numeral ⅱ is II');
select isnt(private.import_title_key('Super Momotaro Dentetsu Ⅱ'), private.import_title_key('Super Momotaro Dentetsu Ⅲ'), 'import keys: Ⅱ and Ⅲ stay distinct');
select isnt(private.catalog_search_key('ドラゴンクエストⅡ'), private.catalog_search_key('ドラゴンクエストⅢ'), 'a numeral attached to Japanese text stays distinct');

-- A trademark sign adds nothing, as before (NFKC alone would make it "TM").
select is(private.catalog_search_key('Tetris™'), 'tetris', 'search key: ™ adds nothing');
select is(private.import_title_key('Tetris™ & Dr. Mario'), 'tetris-and-dr-mario', 'import key: ™ adds nothing');

-- Unchanged for every title without compatibility characters (baseline values).
select is(private.catalog_search_key('Breath of Fire II'), 'breath of fire 2', 'Roman numeral words as before');
select is(private.catalog_search_key('Mask, The'), 'mask', 'trailing articles as before');
select is(private.catalog_search_key('Jurassic Park Part 2'), 'jurassic park 2', '"Part N" as before');
select is(private.catalog_search_key('スーパーメトロイド'), 'スーパーメトロイド', 'Japanese titles keep their letters');
select is(private.import_title_key('スーパーメトロイド'), null, 'and still have no import key');
select is(private.import_title_key('Pokémon Stadium'), 'pokemon-stadium', 'accents as before');

-- Stored keys follow the functions: existing rows were recomputed by the migration, and new
-- rows get the new key through the generated columns.
select is((select count(*)::integer from public.games g where g.search_key is distinct from private.catalog_search_key(g.title)), 0,
  'every stored game key equals the function');
insert into public.games (title, sort_title, kind, status) values ('Zqx Rail Baron Ⅱ', 'Zqx Rail Baron Ⅱ', 'game', 'under_review');
select is((select search_key from public.games where title = 'Zqx Rail Baron Ⅱ'), 'zqx rail baron 2', 'a new game gets the normalized key');
select is((select title from public.games where search_key = 'zqx rail baron 2'), 'Zqx Rail Baron Ⅱ', 'and keeps its title exactly as written');
insert into public.game_aliases (game_id, title, kind)
select id, 'Zqx Rail Baron Ⅱ Deluxe', 'alternate' from public.games where title = 'Zqx Rail Baron Ⅱ';
select is((select title || ' | ' || search_key from public.game_aliases where title like 'Zqx Rail Baron%'), 'Zqx Rail Baron Ⅱ Deluxe | zqx rail baron 2 deluxe',
  'an alias keeps its title and gets the normalized key');

-- Matching never merges: the importer links only by external id. A title candidate is held for
-- review as a possible duplicate (import_apply_game), so the key only decides what is held.
insert into public.game_platforms (game_id, platform_id, status)
select id, (select id from public.platforms where slug = 'snes'), 'under_review' from public.games where title = 'Zqx Rail Baron Ⅱ';
select is(private.import_games_titled((select id from public.platforms where slug = 'snes'), 'Zqx Rail Baron II'),
  array[(select id from public.games where title = 'Zqx Rail Baron Ⅱ')], 'a source titled "II" finds the "Ⅱ" game as a candidate');
select is(private.import_games_titled((select id from public.platforms where slug = 'snes'), 'Zqx Rail Baron Ⅲ'), '{}'::uuid[],
  'a source titled "Ⅲ" finds no candidate: it would be a new game, not the "Ⅱ" one');

select * from finish();
rollback;
