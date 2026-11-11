/**
 * M6b collection benchmark, on the LOCAL database only, inside one transaction that is
 * always rolled back, so nothing it creates persists.
 *
 *   node supabase/benchmarks/m6_collection.mjs [--out <dir>] [--runs 25] [--copies 50000]
 *
 * Generates a synthetic published catalog of 20,000 games and about 60,000 releases,
 * then about 1,000,000 copies: one collector with --copies of them (default 50,000,
 * half the per-owner limit), one with 1,000, and 199 others sharing the rest. About
 * half of the large collection has owner-only details. Then it times each read and
 * write shape for the large and the typical collector, as the signed-in user, so RLS
 * applies exactly as in the app, and records each one's plan with auto_explain.
 * The goal is p95 under 100 ms on a developer machine; it's a goal, not a pass/fail.
 *
 * The bulk load bypasses the per-row insert trigger (the id and limit checks), which
 * would make loading a million rows very slow; the "add a copy" shape measures that
 * trigger at full size.
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
const out = arg("--out", join(tmpdir(), "my-game-dex-bench-m6"));
const runs = Number(arg("--runs", "25"));
if (!Number.isInteger(runs) || runs < 1 || runs > 200) throw new Error("--runs must be 1 to 200");
const copies = Number(arg("--copies", "50000"));
if (!Number.isInteger(copies) || copies < 1000 || copies > 100000) throw new Error("--copies must be 1000 to 100000");
const others = 1000000 - copies - 1000;

const status = JSON.parse(execFileSync(process.execPath, [cli, "status", "-o", "json"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(new URL(status.API_URL).hostname)) {
  throw new Error("Refusing: the stack isn't local.");
}

const BIG = "b0000000-0000-4000-8000-000000000001";
const SMALL = "b0000000-0000-4000-8000-000000000002";

const sql = String.raw`
\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on
begin;
set local statement_timeout = 0;

create function pg_temp.v7_at(p_at timestamptz) returns uuid language sql volatile as $$
  select encode(set_bit(set_bit(overlay(uuid_send(gen_random_uuid()) placing substring(int8send((extract(epoch from p_at) * 1000)::bigint) from 3) from 1 for 6), 52, 1), 53, 1), 'hex')::uuid
$$;

-- The catalog: 20,000 published games on the eight largest platforms and the rest.
create temp table words as select
  array['Star','Crystal','Shadow','Dragon','Neon','Iron','Silver','Golden','Mystic','Thunder','Frozen','Burning','Hidden','Lost','Eternal','Cosmic','Wild','Royal','Ancient','Silent'] a,
  array['Quest','Legend','Saga','Warrior','Knight','Racer','Odyssey','Fighter','Hunter','Kingdom','Empire','Tales','Chronicles','Force','Strike','Blade','Heart','World','Island','Castle'] b;
create temp table plats as
  select row_number() over (order by p.slug) as n, p.id, p.slug, (select min(m.media_format_code) from public.platform_media_formats m where m.platform_id = p.id) as format
  from public.platforms p;
insert into public.games (title, sort_title, kind, summary, status, slug, verified_at)
select a[1 + abs(hashtext('a' || i)) % 20] || ' ' || b[1 + abs(hashtext('b' || i)) % 20] || ' ' || i, a[1 + abs(hashtext('a' || i)) % 20] || ' ' || b[1 + abs(hashtext('b' || i)) % 20] || ' ' || i,
  'game', 'bench6 ' || i, 'published', 'bench6-' || i, now()
from words, generate_series(1, 20000) i;
create temp table g_ids as select g.id, substr(g.summary, 8)::int as i,
  (select id from plats where n = 1 + abs(hashtext('p' || substr(g.summary, 8))) % (select count(*) from plats)) as platform
  from public.games g where g.summary like 'bench6 %';
insert into public.game_platforms (game_id, platform_id, status) select id, platform, 'published' from g_ids;
insert into public.releases (game_id, platform_id, region_code, edition_name, edition_kind, media_format_code, media_count, status, verified_at)
select g.id, g.platform, (array['ntsc-uc', 'pal', 'ntsc-j'])[r], 'Standard', 'standard', p.format, 1, 'published', now()
from g_ids g join plats p on p.id = g.platform, generate_series(1, 3) r;
create temp table r_ids as select row_number() over (order by id) as n, id from public.releases where edition_name = 'Standard' and game_id in (select id from g_ids);
create unique index on r_ids (n);

-- Collectors: one large, one typical, and 199 others.
insert into auth.users (id, aud, role, email, email_confirmed_at, instance_id)
select ('b0000000-0000-4000-8000-' || lpad(to_hex(i), 12, '0'))::uuid, 'authenticated', 'authenticated', 'bench6-' || i || '@example.test', now(), '00000000-0000-0000-0000-000000000000'
from generate_series(1, 201) i;
update public.profiles set handle = 'bench6_' || right(id::text, 4), handle_changed_at = now() where id::text like 'b0000000-0000-4000-8000-%';

-- The copies, newest last: one every few seconds over the last years.
alter table public.collection_items disable trigger check_new_collection_item;
create temp table load as
  select i, case when i <= ${copies} then '${BIG}'::uuid when i <= ${copies} + 1000 then '${SMALL}'::uuid
                 else ('b0000000-0000-4000-8000-' || lpad(to_hex(3 + i % 199), 12, '0'))::uuid end as owner,
    1 + abs(hashtext('r' || i)) % (select count(*) from r_ids) as r,
    now() - make_interval(secs => (1000000 - i) * 3) as at
  from generate_series(1, ${copies + 1000 + others}) i;
insert into public.collection_items (id, owner_id, release_id, completeness, media_condition, created_at, updated_at)
select pg_temp.v7_at(l.at), l.owner, r.id, (array['loose', 'complete', 'incomplete', 'sealed', null])[1 + l.i % 5]::public.completeness,
  case when l.i % 5 <> 3 then 'good' end::public.condition_grade, l.at, l.at
from load l join r_ids r on r.n = l.r;
alter table public.collection_items enable trigger check_new_collection_item;
insert into public.collection_item_private (item_id, owner_id, acquired_on, purchase_price, currency, notes)
select c.id, c.owner_id, (c.created_at)::date, case when abs(hashtext(c.id::text)) % 3 = 0 then 10 + abs(hashtext(c.id::text)) % 90 end,
  case when abs(hashtext(c.id::text)) % 3 = 0 then 'EUR' end, case when abs(hashtext(c.id::text)) % 10 = 0 then 'Bench note' end
from public.collection_items c where c.owner_id in ('${BIG}', '${SMALL}') and abs(hashtext('d' || c.id::text)) % 2 = 0;
analyze public.games;
analyze public.releases;
analyze public.collection_items;
analyze public.collection_item_private;

select 'data', json_build_object(
  'games', (select count(*) from g_ids), 'releases', (select count(*) from r_ids),
  'copies', (select count(*) from public.collection_items), 'large_collection', (select count(*) from public.collection_items where owner_id = '${BIG}'),
  'typical_collection', (select count(*) from public.collection_items where owner_id = '${SMALL}'),
  'large_with_details', (select count(*) from public.collection_item_private where owner_id = '${BIG}'));

-- The shapes. Each runs as the collector, so RLS applies as in the app.
create temp table bench_q (n int, name text, who uuid, kind text, args jsonb);
insert into bench_q values
  (1, 'newest first', '${BIG}', 'list', '{}'),
  (2, 'newest first, page 5', '${BIG}', 'list', '{"page": 5}'),
  (3, 'by title', '${BIG}', 'list', '{"sort": "title"}'),
  (4, 'by title, page 5', '${BIG}', 'list', '{"sort": "title", "page": 5}'),
  (5, 'by platform', '${BIG}', 'list', '{"sort": "platform"}'),
  (6, 'by acquisition date', '${BIG}', 'list', '{"sort": "acquired"}'),
  (7, 'one platform', '${BIG}', 'list', '{"platform": "snes"}'),
  (8, 'completeness not recorded', '${BIG}', 'list', '{"completeness": "not_recorded"}'),
  (9, 'title search', '${BIG}', 'list', '{"query": "dragon quest"}'),
  (10, 'title search, no match', '${BIG}', 'list', '{"query": "zzqqxx"}'),
  (11, 'one copy', '${BIG}', 'item', '{}'),
  (12, 'copies of a release', '${BIG}', 'copies', '{}'),
  (13, 'summary', '${BIG}', 'summary', '{}'),
  (14, 'add a copy', '${BIG}', 'add', '{}'),
  (15, 'edit a copy', '${BIG}', 'edit', '{}'),
  (16, 'typical: by title', '${SMALL}', 'list', '{"sort": "title"}'),
  (17, 'typical: summary', '${SMALL}', 'summary', '{}');

create temp table bench_times (n int, ms double precision, items int);
create temp table bench_ctx (n int primary key, item uuid, release uuid, cursor text);
grant all on bench_q, bench_times, bench_ctx to authenticated;
insert into bench_ctx select 11, (select id from public.collection_items where owner_id = '${BIG}' order by id limit 1 offset 1234), null, null;
insert into bench_ctx select 12, null, (select release_id from public.collection_items where owner_id = '${BIG}' group by release_id order by count(*) desc limit 1), null;
insert into bench_ctx select 15, (select id from public.collection_items where owner_id = '${BIG}' order by id limit 1 offset 4321), null, null;

create function pg_temp.list(p jsonb, p_cursor text) returns jsonb language sql as $$
  select public.get_my_collection(p ->> 'query', p ->> 'platform', p ->> 'completeness', null, coalesce(p ->> 'sort', 'added'), 50, p_cursor)
$$;
grant execute on function pg_temp.list(jsonb, text) to authenticated;
create function pg_temp.act(p_who uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_who, 'role', 'authenticated')::text, true), set_config('role', 'authenticated', true)
$$;

-- Cursors for the later pages, found as the collector.
do $b$
declare r record; c text;
begin
  for r in select * from bench_q where args ? 'page' loop
    perform pg_temp.act(r.who);
    c := null;
    for i in 1 .. (r.args ->> 'page')::int - 1 loop
      c := pg_temp.list(r.args, c) ->> 'next_cursor';
    end loop;
    perform set_config('role', 'none', true);
    insert into bench_ctx values (r.n, null, null, c);
  end loop;
end $b$;

do $b$
declare
  r record;
  x record;
  t0 timestamptz;
  v jsonb;
  i int;
  ids uuid[];
begin
  for r in select * from bench_q order by n loop
    select * into x from bench_ctx where n = r.n;
    -- Ids for the additions, made before acting as the collector.
    ids := array(select pg_temp.v7_at(clock_timestamp()) from generate_series(1, 3 + ${runs}));
    perform pg_temp.act(r.who);
    for i in 1 .. 3 + ${runs} loop
      t0 := clock_timestamp();
      v := case r.kind
        when 'list' then pg_temp.list(r.args, x.cursor)
        when 'item' then public.get_my_collection_item(x.item)
        when 'copies' then public.get_my_release_copies(x.release)
        when 'summary' then public.get_my_collection_summary()
        when 'add' then public.add_collection_item(ids[i], (select release_id from public.collection_items where owner_id = r.who limit 1), '{"completeness": "loose"}')
        else to_jsonb(public.update_collection_item(x.item, jsonb_build_object('notes', 'Edited ' || i, 'completeness', 'complete')))
      end;
      if i > 3 then
        insert into bench_times values (r.n, extract(epoch from clock_timestamp() - t0) * 1000,
          case when r.kind = 'list' then jsonb_array_length(v -> 'items') when r.kind = 'copies' then (v ->> 'count')::int else 1 end);
      end if;
    end loop;
    perform set_config('role', 'none', true);
  end loop;
end $b$;

select 'timing', json_build_object('n', q.n, 'name', q.name,
  'p50_ms', round(percentile_cont(0.5) within group (order by t.ms)::numeric, 2),
  'p95_ms', round(percentile_cont(0.95) within group (order by t.ms)::numeric, 2),
  'max_ms', round(max(t.ms)::numeric, 2), 'results', max(t.items))
from bench_q q join bench_times t on t.n = q.n group by q.n, q.name order by q.n;

-- One plan per read shape.
set local auto_explain.log_min_duration = 0;
set local auto_explain.log_nested_statements = on;
set local auto_explain.log_analyze = on;
set local auto_explain.log_buffers = on;
set local auto_explain.log_level = notice;
do $b$
declare r record; x record;
begin
  for r in select * from bench_q where kind in ('list', 'item', 'copies', 'summary') order by n loop
    select * into x from bench_ctx where n = r.n;
    raise notice '=== % ===', r.name;
    perform pg_temp.act(r.who);
    perform case r.kind
      when 'list' then pg_temp.list(r.args, x.cursor)
      when 'item' then public.get_my_collection_item(x.item)
      when 'copies' then public.get_my_release_copies(x.release)
      else public.get_my_collection_summary() end;
    perform set_config('role', 'none', true);
  end loop;
end $b$;
set local auto_explain.log_min_duration = -1;
rollback;
`;

const run = spawnSync("docker", ["exec", "-i", `supabase_db_${projectId}`, "psql", "-U", "postgres", "-d", "postgres", "-X", "-q"], {
  input: sql,
  encoding: "utf8",
  maxBuffer: 512 * 1024 * 1024,
});
if (run.status !== 0) {
  console.error((run.stderr ?? "").split("\n").filter((line) => line.includes("ERROR")).slice(0, 5).join("\n") || `psql exited with ${run.status}`);
  process.exit(1);
}
const rows = run.stdout.split("\n").filter((line) => line.includes("|"));
const data = JSON.parse(rows.find((line) => line.startsWith("data|")).slice("data|".length));
const timings = rows.filter((line) => line.startsWith("timing|")).map((line) => JSON.parse(line.slice("timing|".length)));
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "bench-results.json"), `${JSON.stringify({ runs, data, timings }, null, 2)}\n`);
const plans = run.stderr
  .split(/\n(?=NOTICE: {2})/)
  .filter((block) => block.includes("=== ") || Number((/duration: ([\d.]+) ms/.exec(block) ?? [])[1] ?? 0) >= 0.5)
  .join("\n");
writeFileSync(join(out, "bench-plans.txt"), plans);

console.log(`Data: ${data.games} games, ${data.releases} releases, ${data.copies} copies. Large collection ${data.large_collection} ` +
  `(${data.large_with_details} with details), typical ${data.typical_collection}.`);
console.log(`Warm runs per shape: ${runs}.`);
for (const t of timings) {
  console.log(`${t.p95_ms <= 100 ? "     " : "OVER "} ${t.name.padEnd(28)} p50 ${String(t.p50_ms).padStart(8)} ms  p95 ${String(t.p95_ms).padStart(8)} ms  max ${String(t.max_ms).padStart(8)} ms  (${t.results})`);
}
console.log(`Results and plans: ${out}`);
