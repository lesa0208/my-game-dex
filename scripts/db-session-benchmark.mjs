/**
 * M11a session revocation: what the live-session check costs on realistic queries. Runs in
 * one transaction that rolls back, on the local test stack: a collector with N copies
 * (each with private details), an administrator with a verified session, and each query
 * timed as that user, first with the real private.session_is_live() and then with it
 * replaced by `true` inside the same transaction. The difference is the check's cost.
 *
 *   npm run test-stack:run -- db:session-benchmark [-- --copies 50000]
 *
 * Local only. Prints timings, nothing else.
 */
import { execFileSync } from "node:child_process";

import { installFixture, removeFixture } from "./catalog-fixture.mjs";
import { dbContainer, stackStatus } from "./lib/stack.mjs";

stackStatus({ label: "the session benchmark" });
const arg = (flag, fallback) => (process.argv.includes(flag) ? Number(process.argv[process.argv.indexOf(flag) + 1]) : fallback);
const COPIES = arg("--copies", 50_000);
const psql = (sql) => execFileSync("docker", ["exec", "-i", dbContainer, "psql", "-U", "postgres", "-d", "postgres", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-At"], { input: sql, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).trim();

// Each: a label, how many times to run it, and the SQL (run as the user, $1 a copy id).
const QUERIES = [
  ["collection page (newest first, 50)", 20, "select public.get_my_collection(null, null, null, null, 'added', 50, null)"],
  ["collection page (by title, 50)", 20, "select public.get_my_collection(null, null, null, null, 'title', 50, null)"],
  ["collection search ('starfall')", 10, "select public.get_my_collection('starfall', null, null, null, 'added', 50, null)"],
  ["one copy in full", 500, "select public.get_my_collection_item(%L)"],
  ["copies of one release", 200, "select public.get_my_release_copies((select release_id from public.collection_items where id = %L))"],
  ["collection summary (all copies)", 10, "select public.get_my_collection_summary()"],
  ["all private details (count)", 10, "select count(*) from public.collection_item_private"],
  ["export page (200 copies by id)", 200, "select count(*) from (select id from public.collection_items where owner_id = (select auth.uid()) order by id limit 200) x"],
  ["edit one copy's notes", 300, "select public.update_collection_item(%L, jsonb_build_object('notes', 'bench ' || clock_timestamp()::text))"],
  ["update preferences", 300, "with u as (update public.user_preferences set timezone = 'Europe/Paris' where user_id = (select auth.uid()) returning 1) select count(*) from u"],
  ["read own account", 500, "select count(*) from public.get_my_account()"],
  ["notifications", 300, "select public.get_my_notifications(20, null)"],
  ["ADMIN overview", 100, "select public.get_admin_overview()"],
  ["ADMIN account search", 100, "select public.search_accounts('bench', 20)"],
];

installFixture();
try {
  const release = psql("select id from public.releases where product_code = 'SNS-ZSFE-USA';");
  const release2 = psql("select id from public.releases where product_code = 'SNSP-ZSFP-EUR';");
  const timeFn = `
create function pg_temp.time_as(p_claims jsonb, p_sql text, p_n int) returns numeric language plpgsql as $t$
declare t0 timestamptz; v text;
begin
  perform set_config('request.jwt.claims', p_claims::text, true);
  perform set_config('role', 'authenticated', true);
  execute p_sql into v;                       -- warm up
  t0 := clock_timestamp();
  for i in 1..p_n loop execute p_sql into v; end loop;
  perform set_config('role', 'none', true);
  return round(extract(epoch from clock_timestamp() - t0) * 1000000 / p_n, 1);
end $t$;`;
  const users = `
insert into auth.users (id, aud, role, email, email_confirmed_at, instance_id) values
  ('00000000-0000-4000-8000-00000000be01', 'authenticated', 'authenticated', 'bench-c@example.test', now(), '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-4000-8000-00000000be02', 'authenticated', 'authenticated', 'bench-a@example.test', now(), '00000000-0000-0000-0000-000000000000');
update public.profiles set handle = 'bench_' || right(id::text, 2), handle_changed_at = now() where id in ('00000000-0000-4000-8000-00000000be01', '00000000-0000-4000-8000-00000000be02');
insert into public.staff_roles (user_id, role) values ('00000000-0000-4000-8000-00000000be02', 'admin');
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at) values ('00000000-0000-4000-8000-00000000bef2', '00000000-0000-4000-8000-00000000be02', 'bench', 'totp', 'verified', now() - interval '3 days', now());
insert into auth.sessions (id, user_id, aal, factor_id, created_at, updated_at) values
  ('00000000-0000-4000-8000-00000000be51', '00000000-0000-4000-8000-00000000be01', 'aal1', null, now(), now()),
  ('00000000-0000-4000-8000-00000000be52', '00000000-0000-4000-8000-00000000be02', 'aal2', '00000000-0000-4000-8000-00000000bef2', now(), now());
insert into auth.mfa_amr_claims (id, session_id, authentication_method, created_at, updated_at) values (gen_random_uuid(), '00000000-0000-4000-8000-00000000be52', 'totp', now(), now());
-- Other sessions, so auth.sessions isn't trivially small.
insert into auth.sessions (id, user_id, aal, created_at, updated_at) select gen_random_uuid(), '00000000-0000-4000-8000-00000000be01', 'aal1', now(), now() from generate_series(1, 2000);
select set_config('request.jwt.claims', '{"sub": "00000000-0000-4000-8000-00000000be01", "role": "authenticated", "session_id": "00000000-0000-4000-8000-00000000be51"}', true);
create temp table bench_ids on commit drop as select private.uuid_v7() as id, g from generate_series(1, ${COPIES}) g;
grant select on bench_ids to authenticated;
set local role authenticated;
insert into public.collection_items (id, owner_id, release_id, completeness) select id, '00000000-0000-4000-8000-00000000be01', case when g % 3 = 0 then '${release2}'::uuid else '${release}'::uuid end, 'complete' from bench_ids;
insert into public.collection_item_private (item_id, owner_id, notes, purchase_price, currency) select id, '00000000-0000-4000-8000-00000000be01', 'note ' || g, 10 + g % 50, 'EUR' from bench_ids;
reset role;
analyze public.collection_items; analyze public.collection_item_private; analyze auth.sessions;`;
  const collector = `'{"sub": "00000000-0000-4000-8000-00000000be01", "role": "authenticated", "aal": "aal1", "session_id": "00000000-0000-4000-8000-00000000be51"}'::jsonb`;
  const admin = `'{"sub": "00000000-0000-4000-8000-00000000be02", "role": "authenticated", "aal": "aal2", "session_id": "00000000-0000-4000-8000-00000000be52"}'::jsonb`;
  const runs = (phase) =>
    QUERIES.map(([label, n, q]) => {
      const who = label.startsWith("ADMIN") ? admin : collector;
      const body = q.includes("%L") ? `format(${psqlLiteral(q)}, (select id from bench_ids where g = 7))` : psqlLiteral(q);
      return `select ${psqlLiteral(`${phase}|${label}|`)} || pg_temp.time_as(${who}, ${body}, ${n});`;
    }).join("\n");
  const stub = `create or replace function private.session_is_live() returns boolean language sql stable security definer set search_path = '' as $s$ select true $s$;`;
  const keep = "create temp table bench_def on commit drop as select pg_get_functiondef('private.session_is_live()'::regprocedure) as def;";
  const restore = "do $r$ begin execute (select def from bench_def); end $r$;";
  // Alternating, so neither variant gains from running second: the best of two runs each.
  const out = psql(`begin;\n${timeFn}\n${users}\n${keep}\n${runs("check")}\n${stub}\n${runs("stub")}\n${restore}\n${runs("check2")}\n${stub}\n${runs("stub2")}\nrollback;`);
  const rows = new Map();
  for (const line of out.split("\n").filter((l) => l.includes("|"))) {
    const [phase, label, us] = line.split("|");
    rows.set(label, { ...(rows.get(label) ?? {}), [phase]: Number(us) });
  }
  console.log(`Copies: ${COPIES.toLocaleString("en")}, other sessions in auth.sessions: 2,000+. Microseconds per call, as the user.\n`);
  console.log(`${"query".padEnd(40)} ${"with check".padStart(11)} ${"without".padStart(9)} ${"difference".padStart(11)}`);
  for (const [label, r] of rows) {
    const without = Math.min(r.stub, r.stub2);
    const withCheck = Math.min(r.check, r.check2);
    const diff = withCheck - without;
    console.log(`${label.padEnd(40)} ${withCheck.toFixed(1).padStart(11)} ${without.toFixed(1).padStart(9)} ${`${diff >= 0 ? "+" : ""}${diff.toFixed(1)} (${((diff / without) * 100).toFixed(1)}%)`.padStart(11)}`);
  }
} finally {
  removeFixture();
}

function psqlLiteral(text) {
  return `'${text.replace(/'/g, "''")}'`;
}
