/**
 * M12 W1 benchmark: the wishlist reads for a collector at the limit, 10,000 entries over
 * 2,000 published games (each wanted as any version, on SNES, SNES PAL, SNES NTSC-U and
 * as its one release), with 2,000 copies, on the local stack. Reports how long each read
 * takes, measured in the database: the first page in each sort, a later page, filters,
 * a search, a game's entries and one entry. Every record made here is removed after.
 *
 *   MGD_STACK=scratch node scripts/db-wishlist-benchmark.mjs
 *
 * Local only. Writes test accounts and catalog rows directly, and prints only timings.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

import { dbContainer, guardDevStack } from "./lib/stack.mjs";

guardDevStack("the wishlist benchmark");
const psql = (sql) =>
  execFileSync("docker", ["exec", "-i", dbContainer, "psql", "-U", "postgres", "-d", "postgres", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-At"], { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).trim();
const GAMES = Number(process.env.GAMES ?? 2000);
const tag = `zwb${randomBytes(3).toString("hex")}`;
const before = psql(`select (select count(*) from public.wishlist_items) || ' ' || (select count(*) from public.games) || ' ' || (select count(*) from auth.users);`);

const user = psql(`insert into auth.users (id, aud, role, email, email_confirmed_at, instance_id)
  values (gen_random_uuid(), 'authenticated', 'authenticated', '${tag}@example.test', now(), '00000000-0000-0000-0000-000000000000') returning id;`);
psql(`update public.profiles set handle = '${tag}_c', handle_changed_at = now() where id = '${user}';
insert into auth.sessions (id, user_id, aal, factor_id, created_at, updated_at) values ('${user}', '${user}', 'aal2', '${user}', now(), now());`);
const as = `select set_config('request.jwt.claims', '{"sub": "${user}", "role": "authenticated", "aal": "aal2", "session_id": "${user}"}', true); set local role authenticated;`;

let failed = false;
try {
  // Games with a pairing and a release each, published together (checked at commit).
  psql(`begin;
create temp table bench_games on commit drop as
  select gen_random_uuid() as id, n from generate_series(1, ${GAMES}) n;
insert into public.games (id, slug, title, sort_title, kind, status, verified_at)
  select id, '${tag}-' || n, '${tag} Game ' || lpad(n::text, 5, '0'), '${tag} game ' || lpad(n::text, 5, '0'), 'game', 'published', now() from bench_games;
insert into public.game_platforms (game_id, platform_id, status)
  select b.id, p.id, 'published' from bench_games b, public.platforms p where p.slug = 'snes';
insert into public.releases (game_id, platform_id, media_format_code, region_code, edition_name, edition_kind, media_count, packaging_code, product_code, status, verified_at)
  select b.id, p.id, 'snes-game-pak-na', 'ntsc-uc', 'Standard', 'standard', 1, 'cardboard-box', '${tag}-' || b.n, 'published', now() from bench_games b, public.platforms p where p.slug = 'snes';
commit;`);
  // The entries and copies, made as postgres in one go: the functions' rules are covered
  // by the checks; this measures reading. Ids are UUIDv7s, as the trigger requires.
  const started = Date.now();
  psql(`begin;
insert into public.wishlist_items (id, owner_id, game_id, platform_id, region_code, priority, completeness)
  select private.uuid_v7(), '${user}', g.id, case when k.k = 1 then null else p.id end, case k.k when 3 then 'pal' when 4 then 'ntsc-uc' end,
    1 + (pg_catalog.hashtext(g.slug) & 1023 + k.k) % 3, case when k.k = 2 then 'complete'::public.completeness end
  from public.games g cross join (values (1), (2), (3), (4)) k(k), public.platforms p
  where g.slug like '${tag}-%' and p.slug = 'snes';
insert into public.wishlist_items (id, owner_id, release_id, priority)
  select private.uuid_v7(), '${user}', r.id, 2 from public.releases r join public.games g on g.id = r.game_id where g.slug like '${tag}-%';
insert into public.collection_items (id, owner_id, release_id, completeness)
  select private.uuid_v7(), '${user}', r.id, 'complete' from public.releases r join public.games g on g.id = r.game_id where g.slug like '${tag}-%';
commit;`);
  // As autovacuum would soon after a bulk load; without statistics the planner guesses badly (see the report).
  if (process.env.NO_ANALYZE !== "1") psql(`analyze public.wishlist_items; analyze public.collection_items; analyze public.games; analyze public.releases; analyze public.game_platforms;`);
  const entries = psql(`select count(*) from public.wishlist_items where owner_id = '${user}';`);
  console.log(`${entries} entries and ${GAMES} copies made in ${Date.now() - started} ms\n`);

  /** Runs a read as the collector 5 times; reports the median, as psql times it in the container. */
  const time = (label, call) => {
    const out = psql(`begin;\n${as}\n\\timing on\n` + `select (${call}) is not null;\n`.repeat(5) + `\\timing off\ncommit;`);
    const runs = [...out.matchAll(/^Time: ([\d.]+) ms/gm)].map((m) => Number(m[1])).sort((a, b) => a - b);
    console.log(`${label.padEnd(44)} median ${runs[2]} ms   (${runs.join(", ")})`);
    return runs[2];
  };
  const cursorOf = (args) => psql(`begin;\n${as}\nselect public.get_my_wishlist(${args}) ->> 'next_cursor';\ncommit;`).split("\n").pop();
  const game = psql(`select id from public.games where slug = '${tag}-1000';`);
  const item = psql(`select id from public.wishlist_items where owner_id = '${user}' order by created_at, id limit 1 offset 5000;`);
  const medians = [
    time("first page, by priority (50)", "public.get_my_wishlist()"),
    time("first page, newest first (50)", "public.get_my_wishlist(p_sort => 'added')"),
    time("first page, by title (50)", "public.get_my_wishlist(p_sort => 'title')"),
    time("second page, by priority", `public.get_my_wishlist(p_cursor => '${cursorOf("")}')`),
    time("first page of 100", "public.get_my_wishlist(p_limit => 100)"),
    time("region filter (PAL)", "public.get_my_wishlist(p_region => 'pal')"),
    time("search (one game)", `public.get_my_wishlist(p_query => '${tag} game 01000')`),
    time("a game's entries (5)", `public.get_my_wishlist_for_game('${game}')`),
    time("one entry", `public.get_my_wishlist_item('${item}')`),
  ];
  console.log(`\nslowest median: ${Math.max(...medians)} ms`);
} catch (error) {
  failed = true;
  console.error(`benchmark stopped: ${error.message}`);
} finally {

  psql(`begin;
delete from auth.users where id = '${user}';
set local session_replication_role = replica;
delete from private.catalog_record_origins where game_id in (select id from public.games where slug like '${tag}-%')
  or release_id in (select r.id from public.releases r join public.games g on g.id = r.game_id where g.slug like '${tag}-%');
delete from private.catalog_verifications where game_id in (select id from public.games where slug like '${tag}-%')
  or release_id in (select r.id from public.releases r join public.games g on g.id = r.game_id where g.slug like '${tag}-%');
delete from public.releases where game_id in (select id from public.games where slug like '${tag}-%');
delete from public.game_platforms where game_id in (select id from public.games where slug like '${tag}-%');
delete from public.games where slug like '${tag}-%';
delete from private.handle_holds where handle like '${tag}\\_%';
commit;`);
  const after = psql(`select (select count(*) from public.wishlist_items) || ' ' || (select count(*) from public.games) || ' ' || (select count(*) from auth.users);`);
  console.log(after === before ? "\nok   every benchmark record removed" : `\nFAIL records left behind (${before} -> ${after})`);
  if (after !== before) failed = true;
}
process.exit(failed ? 1 : 0);
