/**
 * M5c search benchmark, on the LOCAL database only, inside one transaction that is
 * always rolled back, so nothing it creates persists.
 *
 *   node supabase/benchmarks/m5c_catalog_search.mjs [--out <dir>] [--runs 25] [--games 50000] [--seqscan on|off]
 *
 * By default it generates a deterministic synthetic catalog of 50,000 published games, about
 * 150,000 published releases and about 75,000 aliases across every platform, plus
 * 5,000 unpublished games with 15,000 releases that search must skip. Then it times
 * each query shape (warm runs only) and records each one's plan with auto_explain.
 * Latency targets are goals, not pass/fail: p95 of 100 ms for search and 50 ms for
 * the picker, on a developer machine.
 *
 * Writes bench-results.json and bench-plans.txt to --out (default: the system temp
 * directory). Prints only timings.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = join(root, "node_modules", "supabase", "dist", "supabase.js");
const projectId = /project_id\s*=\s*"([^"]+)"/.exec(readFileSync(join(root, "supabase", "config.toml"), "utf8"))[1];
const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : fallback;
};
const out = arg("--out", join(tmpdir(), "my-game-dex-bench"));
const runs = Number(arg("--runs", "25"));
if (!Number.isInteger(runs) || runs < 1 || runs > 200) throw new Error("--runs must be 1 to 200");
// --games sets the published catalog size; a tenth as many unpublished games are added.
const games = Number(arg("--games", "50000"));
if (!Number.isInteger(games) || games < 100 || games > 200000) throw new Error("--games must be 100 to 200000");
const total = games + Math.floor(games / 10);
const probe = 3 * Math.floor(games / 6);
// --seqscan off sets enable_seqscan = off on the search function, inside the rolled-back
// transaction, to compare plans with the planner's default behaviour (the default, on).
const seqscan = arg("--seqscan", "on");
if (!["on", "off"].includes(seqscan)) throw new Error("--seqscan must be on or off");

const status = JSON.parse(execFileSync(process.execPath, [cli, "status", "-o", "json"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(new URL(status.API_URL).hostname)) {
  throw new Error("Refusing: the stack isn't local.");
}

const sql = String.raw`
\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on
begin;
set local statement_timeout = 0;
${seqscan === "off" ? "alter function public.search_catalog(text, text[], integer, text) set enable_seqscan = off;" : ""}

-- Words for fictional titles, and katakana syllables for local titles.
create temp table words as select
  array['Star','Crystal','Shadow','Dragon','Neon','Iron','Silver','Golden','Mystic','Thunder','Frozen','Burning','Hidden','Lost','Eternal','Cosmic','Wild','Royal','Ancient','Silent',
        'Crimson','Azure','Savage','Turbo','Mega','Super','Hyper','Ultra','Quantum','Pixel','Rocket','Ninja','Phantom','Storm','Solar','Lunar','Galactic','Final','Brave','Dark'] a,
  array['Quest','Legend','Saga','Warrior','Knight','Racer','Odyssey','Fighter','Hunter','Kingdom','Empire','Tales','Chronicles','Force','Strike','Blade','Heart','World','Island','Castle',
        'Dungeon','Frontier','Arena','League','Squad','Rally','Drift','Pilot','Commander','Wizard','Pirates','Mission','Escape','Fortress','Voyage','Horizon','Shrine','Temple','Tower','Valley'] b,
  array['','','','',' II',' III',' IV',' 2',' 3',' Deluxe',' Turbo',' Zero',' Origins',' Returns',' Advance'] s,
  array['ア','イ','カ','キ','サ','シ','タ','ナ','ハ','マ','ラ','ン','ト','ル','ド','ゴ','ス','ク','レ','ー'] k;

create temp table plats as
  select row_number() over (order by p.slug) as n, p.id, p.slug, (select min(m.media_format_code) from public.platform_media_formats m where m.platform_id = p.id) as format
  from public.platforms p;
create temp table top8 as select row_number() over (order by slug) as n, id, format from plats
  where slug in ('snes', 'nes', 'mega-drive', 'playstation', 'playstation-2', 'game-boy', 'nintendo-64', 'sega-saturn');

create temp table g_src as
  select i, a[1 + abs(hashtext('a' || i)) % 40] || ' ' || b[1 + abs(hashtext('b' || i)) % 40]
           || coalesce(case when i % 7 = 0 then ' ' || a[1 + abs(hashtext('c' || i)) % 40] end, '') || s[1 + abs(hashtext('s' || i)) % 15] as title,
    case when abs(hashtext('p' || i)) % 100 < 60 then (select id from top8 where n = 1 + abs(hashtext('p' || i)) % 8)
         else (select id from plats where n = 1 + abs(hashtext('q' || i)) % (select count(*) from plats)) end as p1,
    (select id from plats where n = 1 + abs(hashtext('r' || i)) % (select count(*) from plats)) as p2,
    1 + abs(hashtext('n' || i)) % 5 as releases
  from words, generate_series(1, ${total}) i;
update g_src set p2 = null where i % 3 <> 0 or p2 = p1;

insert into public.games (title, sort_title, kind, summary, status, slug, verified_at, first_release_date, first_release_precision)
select title, title, 'game', 'bench ' || i, case when i <= ${games} then 'published' else 'under_review' end::public.catalog_status,
  case when i <= ${games} then 'bench-' || i end, case when i <= ${games} then now() end, make_date(1977 + i % 45, 1, 1), 'year'
from g_src;
create temp table g_ids as select g.id, s.i, s.p1, s.p2, s.releases from public.games g
  join g_src s on g.summary = 'bench ' || s.i;
create unique index on g_ids (i);

insert into public.game_platforms (game_id, platform_id, status)
select distinct id, p, case when i <= ${games} then 'published' else 'under_review' end::public.catalog_status
from g_ids, lateral (values (p1), (p2)) v(p) where p is not null
on conflict do nothing;

insert into public.releases (game_id, platform_id, region_code, edition_name, edition_kind, variant_name, product_code, barcode, local_title,
  media_format_code, media_count, status, verified_at, release_date, release_date_precision)
select g.id, pl.id, (array['ntsc-uc', 'pal', 'ntsc-j', 'ntsc-uc', 'pal'])[r], 'Standard', 'standard', case when r > 3 then 'Variant ' || r end,
  'BEN-' || g.i || '-' || r, case when r = 1 and g.i % 3 = 0 then '9' || lpad(g.i::text, 10, '0') || lpad(r::text, 2, '0') end,
  case when r = 3 and g.i % 10 < 3 then (select string_agg(k[1 + abs(hashtext(g.i || 'k' || c)) % 20], '') from generate_series(1, 4 + g.i % 5) c) end,
  pl.format, 1, case when g.i <= ${games} then 'published' else 'under_review' end::public.catalog_status, case when g.i <= ${games} then now() end,
  make_date(1977 + g.i % 45, 1, 1), 'year'
from words, g_ids g, generate_series(1, 5) r, lateral (select p.id, p.format from plats p where p.id = case when g.p2 is not null and r % 2 = 0 then g.p2 else g.p1 end) pl
where r <= case when g.i <= ${games} then g.releases else 3 end;

insert into public.game_aliases (game_id, title, kind, language_code)
select g.id, a[1 + abs(hashtext('x' || g.i || n)) % 40] || ' ' || b[1 + abs(hashtext('y' || g.i || n)) % 40] || ' ' || (array['Gaiden', 'Densetsu', 'Monogatari', 'Story', 'Adventure'])[1 + n],
  case when n = 1 then 'romanized' else 'alternate' end::public.game_alias_kind, case when n = 1 then 'ja-Latn' end
from words, g_ids g, generate_series(1, 3) n
where n <= abs(hashtext('al' || g.i)) % 4
on conflict do nothing;

analyze public.games;
analyze public.releases;
analyze public.game_platforms;
analyze public.game_aliases;

select 'catalog', json_build_object(
  'published_games', (select count(*) from public.games where status = 'published'),
  'unpublished_games', (select count(*) from public.games where status <> 'published'),
  'published_releases', (select count(*) from public.releases where status = 'published'),
  'unpublished_releases', (select count(*) from public.releases where status <> 'published'),
  'aliases', (select count(*) from public.game_aliases),
  'platforms_with_releases', (select count(distinct platform_id) from public.releases where status = 'published'));

-- The query shapes.
create temp table bench_q (n int, name text, kind text, q text, platforms text[], cursor text);
insert into bench_q values
  (1, 'exact title', 'search', (select title from public.games where slug = 'bench-${probe}'), null, null),
  (2, 'two-letter prefix', 'search', 'st', null, null),
  (3, 'word prefix', 'search', 'star', null, null),
  (4, 'two words, any order', 'search', 'quest dragon', null, null),
  (5, 'typo', 'search', 'cristal odysey', null, null),
  (6, 'Japanese local title', 'search', (select left(local_title, 3) from public.releases where local_title is not null and status = 'published' order by id limit 1), null, null),
  (7, 'prefix, one platform', 'search', 'star', array['snes'], null),
  (8, 'browse a large platform', 'search', null, array['snes'], null),
  (9, 'browse a small platform', 'search', null, array['vectrex'], null),
  (10, 'no results', 'search', 'zzqqxx', null, null),
  (11, 'product code', 'search', 'BEN-${probe}-1', null, null),
  (12, 'barcode', 'search', '9' || lpad('${probe}', 10, '0') || '01', null, null),
  (13, 'fifth page of a prefix', 'search', 'star', null, null),
  (14, 'release picker', 'picker', (select slug from public.games g join g_ids i on i.id = g.id where i.i <= ${games} and i.releases = 5 order by i.i limit 1), null, null),
  (15, 'platform list', 'platforms', null, null, null);

-- The fifth page needs the cursor at the end of the fourth.
do $b$
declare c text;
begin
  for i in 1 .. 4 loop
    c := public.search_catalog('star', null, 20, c) ->> 'next_cursor';
  end loop;
  update bench_q set cursor = c where n = 13;
end $b$;

create temp table bench_times (n int, ms double precision, items int);
do $b$
declare
  r record;
  t0 timestamptz;
  v jsonb;
  i int;
begin
  for r in select * from bench_q order by n loop
    for i in 1 .. 3 + ${runs} loop
      t0 := clock_timestamp();
      v := case r.kind
        when 'search' then public.search_catalog(r.q, r.platforms, 20, r.cursor)
        when 'picker' then public.get_release_picker(r.q)
        else public.list_catalog_platforms() end;
      if i > 3 then
        insert into bench_times values (r.n, extract(epoch from clock_timestamp() - t0) * 1000,
          case r.kind when 'search' then jsonb_array_length(v -> 'items') when 'picker' then jsonb_array_length(v -> 'releases') else jsonb_array_length(v) end);
      end if;
    end loop;
  end loop;
end $b$;

select 'timing', json_build_object('n', q.n, 'name', q.name, 'query', q.q, 'platforms', q.platforms,
  'p50_ms', round(percentile_cont(0.5) within group (order by t.ms)::numeric, 2),
  'p95_ms', round(percentile_cont(0.95) within group (order by t.ms)::numeric, 2),
  'max_ms', round(max(t.ms)::numeric, 2), 'results', max(t.items))
from bench_q q join bench_times t on t.n = q.n group by q.n, q.name, q.q, q.platforms order by q.n;

-- One plan per query shape: auto_explain sends each nested statement's plan as a notice.
set local auto_explain.log_min_duration = 0;
set local auto_explain.log_nested_statements = on;
set local auto_explain.log_analyze = on;
set local auto_explain.log_buffers = on;
set local auto_explain.log_level = notice;
do $b$
declare r record;
begin
  for r in select * from bench_q order by n loop
    raise notice '=== % ===', r.name;
    perform case r.kind
      when 'search' then public.search_catalog(r.q, r.platforms, 20, r.cursor)
      when 'picker' then public.get_release_picker(r.q)
      else public.list_catalog_platforms() end;
  end loop;
end $b$;
set local auto_explain.log_min_duration = -1;
rollback;
`;

const run = spawnSync("docker", ["exec", "-i", `supabase_db_${projectId}`, "psql", "-U", "postgres", "-d", "postgres", "-X", "-q"], {
  input: sql,
  encoding: "utf8",
  maxBuffer: 256 * 1024 * 1024,
});
if (run.status !== 0) {
  console.error((run.stderr ?? "").split("\n").filter((line) => line.includes("ERROR")).slice(0, 5).join("\n") || `psql exited with ${run.status}`);
  process.exit(1);
}
const rows = run.stdout.split("\n").filter((line) => line.includes("|"));
const catalog = JSON.parse(rows.find((line) => line.startsWith("catalog|")).slice("catalog|".length));
const timings = rows.filter((line) => line.startsWith("timing|")).map((line) => JSON.parse(line.slice("timing|".length)));
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "bench-results.json"), `${JSON.stringify({ runs, catalog, timings }, null, 2)}\n`);
// Keep each shape's plans, but only statements that took at least 0.5 ms, so the
// tiny helper lookups don't bury the main query.
const plans = run.stderr
  .split(/\n(?=NOTICE: {2})/)
  .filter((block) => block.includes("=== ") || Number((/duration: ([\d.]+) ms/.exec(block) ?? [])[1] ?? 0) >= 0.5)
  .join("\n");
writeFileSync(join(out, "bench-plans.txt"), plans);

console.log(`Catalog: ${catalog.published_games} published games, ${catalog.published_releases} releases, ${catalog.aliases} aliases, ` +
  `${catalog.unpublished_games} unpublished games with ${catalog.unpublished_releases} releases, ${catalog.platforms_with_releases} platforms.`);
console.log(`Warm runs per shape: ${runs}. Sequential scans in search: ${seqscan}.`);
for (const t of timings) {
  const goal = t.name === "release picker" ? 50 : 100;
  console.log(`${t.p95_ms <= goal ? "     " : "OVER "} ${t.name.padEnd(26)} p50 ${String(t.p50_ms).padStart(7)} ms  p95 ${String(t.p95_ms).padStart(7)} ms  max ${String(t.max_ms).padStart(7)} ms  (${t.results} results)`);
}
console.log(`Results and plans: ${out}`);
