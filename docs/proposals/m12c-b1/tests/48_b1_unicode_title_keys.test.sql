-- PROPOSAL (M12c-B1, B1-M0): title keys normalize Unicode compatibility characters (NFKC).
-- Runs after the B1-M0 migration. Expected values for unchanged titles were read from the
-- database at the M12c-A baseline (2026-11-20), so they prove nothing else moved.
begin;
create extension if not exists pgtap with schema extensions;
select plan(14);

-- The defect: single-character Roman numerals no longer vanish.
select is(private.catalog_search_key('Super Momotaro Dentetsu Ⅱ'), 'super momotaro dentetsu 2', 'search key: Ⅱ is 2');
select is(private.catalog_search_key('Super Momotaro Dentetsu Ⅲ'), 'super momotaro dentetsu 3', 'search key: Ⅲ is 3');
select isnt(private.catalog_search_key('Super Momotaro Dentetsu Ⅱ'), private.catalog_search_key('Super Momotaro Dentetsu Ⅲ'), 'so Ⅱ and Ⅲ are different games');
select is(private.import_title_key('Super Momotaro Dentetsu Ⅱ'), 'super-momotaro-dentetsu-2', 'import key: Ⅱ is 2');
select is(private.catalog_search_key('Albert Odyssey Ⅱ'), private.catalog_search_key('Albert Odyssey II'), 'and Ⅱ matches II');
select is(private.catalog_search_key('ＳＵＰＥＲ ＭＥＴＲＯＩＤ'), 'super metroid', 'fullwidth letters are letters');

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

select * from finish();
rollback;
