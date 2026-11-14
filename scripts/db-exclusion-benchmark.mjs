/**
 * M7b-2b benchmark (D11): excluding and restoring a release with 2,000 copies across
 * 500 owners on the local stack. Reports how long each call takes, and so holds its
 * locks, how long the commit-time checks take, and what waits meanwhile: a copy added
 * to the same release, to another release of the same game, and to another game.
 * Every record made here is removed after.
 *
 * Local only. Writes test accounts directly, so it needs no keys, and prints only timings.
 */
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const projectId = /project_id\s*=\s*"([^"]+)"/.exec(readFileSync(join(root, "supabase", "config.toml"), "utf8"))[1];
const container = `supabase_db_${projectId}`;
const psql = (sql) =>
  execFileSync("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-At"], { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const OWNERS = Number(process.env.OWNERS ?? 500);
const COPIES = Number(process.env.COPIES ?? 2000);
const tag = randomBytes(3).toString("hex");
const PREFIX = `Exb ${tag}`;
const as = (user) => `select set_config('request.jwt.claims', '{"sub": "${user}", "role": "authenticated"}', true); set local role authenticated;`;
const lastLine = (out) => out.split("\n").filter((l) => l && !l.startsWith('{"sub"') && l !== "authenticated").at(-1);

/** A session whose statements report their own duration, measured in the database. */
class Session {
  constructor(name) {
    this.name = name;
    this.out = "";
    this.serial = 0;
    this.child = spawn("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=0"], { stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.on("data", (chunk) => (this.out += chunk.toString()));
    this.child.stderr.on("data", (chunk) => (this.out += chunk.toString()));
    this.child.stdin.write(`set application_name = '${name}';\n`);
  }
  run(sql) {
    this.serial += 1;
    const marker = `__done_${this.name}_${this.serial}__`;
    const start = this.out.length;
    const began = Date.now();
    this.child.stdin.write(`${sql}\n\\echo ${marker}\n`);
    return new Promise((resolve) => {
      const poll = setInterval(() => {
        const at = this.out.indexOf(marker, start);
        if (at !== -1) {
          clearInterval(poll);
          resolve({ out: this.out.slice(start, at).trim(), ms: Date.now() - began });
        }
      }, 5);
    });
  }
  close() {
    this.child.stdin.end();
  }
}

function uuidv7() {
  const bytes = randomBytes(16);
  const ms = BigInt(Date.now());
  for (let i = 0; i < 6; i += 1) bytes[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const ids = { users: [] };
try {
  console.log(`Setting up ${COPIES} copies across ${OWNERS} owners...`);
  // Accounts, written directly: profiles come from the M2 trigger.
  ids.editor = psql("select gen_random_uuid();");
  ids.admin = psql("select gen_random_uuid();");
  psql(`insert into auth.users (id, aud, role, email, email_confirmed_at, instance_id)
    select u, 'authenticated', 'authenticated', 'exb-' || u || '@example.test', now(), '00000000-0000-0000-0000-000000000000'
    from unnest(array['${ids.editor}', '${ids.admin}']::uuid[] || array(select gen_random_uuid() from generate_series(1, ${OWNERS}))) u;
    update public.profiles p set handle = 'xb_' || substr(replace(p.id::text, '-', ''), 1, 12), handle_changed_at = now()
    where p.id in (select id from auth.users where email like 'exb-%@example.test');
    insert into public.staff_roles (user_id, role) values ('${ids.editor}', 'catalog_editor'), ('${ids.admin}', 'admin');`);
  ids.users = psql(`select string_agg(id::text, ',') from auth.users where email like 'exb-%@example.test' and id not in ('${ids.editor}', '${ids.admin}');`).split(",");

  // A game with three releases, and another game.
  const out = psql(`begin; ${as(ids.editor)}
    create temp table made (name text, id uuid);
    insert into made select 'g', public.create_game('${PREFIX} Busy', 'game', null, null, null, 'unknown', 'Benchmark');
    insert into made select 'h', public.create_game('${PREFIX} Quiet', 'game', null, null, null, 'unknown', 'Benchmark');
    select public.verify_game(g.id, 'Benchmark', g.revision) from public.games g where g.id in (select id from made);
    insert into made select 'r' || n, public.create_release((select id from made where name = case when n = 4 then 'h' else 'g' end),
      (select id from public.platforms where slug = 'snes'), 'rom-cartridge', case n when 1 then 'ntsc-uc' when 2 then 'pal' else 'ntsc-j' end,
      json_build_object('edition_name', 'Bench ' || n, 'edition_kind', 'standard', 'media_count', 1, 'product_code', 'EXB-${tag}-' || n)::jsonb, 'Benchmark')
    from generate_series(1, 4) n;
    select public.set_release_components(id, '[{"kind": "insert", "label": "Manual"}, {"kind": "map", "label": "Map"}]', 'Benchmark') from made where name like 'r%';
    select public.verify_release(r.id, 'Benchmark', r.revision) from public.releases r where r.id in (select id from made where name like 'r%');
    select public.publish_release(r.id, 'Benchmark', r.revision) from public.releases r where r.id in (select id from made where name like 'r%');
    reset role;
    select string_agg(name || '=' || id, ',' order by name) from made;
    commit;`);
  for (const pair of lastLine(out).split(",")) {
    const [name, id] = pair.split("=");
    ids[name] = id;
  }

  // Copies, with private details and piece records on half of them.
  psql(`begin;
    create temp table owners on commit drop as select id, row_number() over (order by id) - 1 as n from auth.users where id = any (string_to_array('${ids.users.join(",")}', ',')::uuid[]);
    create temp table copies on commit drop as
      select private.uuid_v7() as id, (select id from owners where n = (i % ${OWNERS})) as owner_id, i from generate_series(0, ${COPIES - 1}) i;
    insert into public.collection_items (id, owner_id, release_id, completeness, overall_condition) select id, owner_id, '${ids.r1}', 'complete', 'good' from copies;
    insert into public.collection_item_private (item_id, owner_id, notes, storage_location) select id, owner_id, 'Copy ' || i, 'Shelf ' || (i % 20) from copies where i % 2 = 0;
    insert into public.collection_item_components (item_id, owner_id, kind, label, condition) select id, owner_id, 'insert', 'Manual', 'good' from copies where i % 2 = 0;
    commit;`);
  console.log(`  ${psql(`select count(*) from public.collection_items where release_id = '${ids.r1}';`)} copies of ${psql(`select count(distinct owner_id) from public.collection_items where release_id = '${ids.r1}';`)} owners`);
  const before = psql(`select md5(string_agg(concat_ws('|', (to_jsonb(c) - array['record_status', 'invalidated_at'])::text, (select to_jsonb(p)::text from public.collection_item_private p where p.item_id = c.id),
    (select string_agg(to_jsonb(x)::text, ',') from public.collection_item_components x where x.item_id = c.id)), ',' order by c.id)) from public.collection_items c where c.release_id = '${ids.r1}';`);

  const a = new Session("exb_a");
  const b = new Session("exb_b");
  const timed = async (session, sql) => {
    const r = await session.run(`select extract(epoch from clock_timestamp()) * 1000; ${sql} select extract(epoch from clock_timestamp()) * 1000;`);
    const nums = r.out.split("\n").filter((l) => /^\d+(\.\d+)?$/.test(l)).map(Number);
    return { ms: nums.length >= 2 ? Math.round(nums.at(-1) - nums[0]) : null, out: r.out };
  };
  const tokenOut = psql(`begin; ${as(ids.editor)} select public.get_exclusion_preview('${ids.r1}') ->> 'token'; commit;`);
  const token = lastLine(tokenOut);
  const preview = await timed(a, `begin; ${as(ids.editor)} select public.get_exclusion_preview('${ids.r1}') ->> 'copies'; reset role; commit;`);
  console.log(`\nPreview: ${preview.ms} ms`);

  // The exclusion, with three copies being added meanwhile from other sessions.
  await a.run("begin;");
  const excluding = timed(a, `${as(ids.editor)} select public.exclude_release('${ids.r1}', '${token}', 'no_game_data', 'Benchmark', null, true, true) ->> 'copies'; reset role;`);
  await new Promise((r) => setTimeout(r, 30));
  const addTo = (release) => timed(b, `begin; ${as(ids.users[0])} select public.add_collection_item('${uuidv7()}', '${release}', '{}'); reset role; rollback;`);
  const sameGame = await addTo(ids.r2);
  const otherGame = await addTo(ids.r4);
  const excl = await excluding;
  const sameReleasePromise = addTo(ids.r1);
  await new Promise((r) => setTimeout(r, 200));
  const commitA = await timed(a, "commit;");
  const sameRelease = await sameReleasePromise;
  console.log(`Exclusion of ${COPIES} copies, ${OWNERS} owners: ${excl.ms} ms in the function, ${commitA.ms} ms to commit (deferred publication checks)`);
  console.log(`  meanwhile, adding a copy to another release of the same game: ${sameGame.ms} ms; to another game: ${otherGame.ms} ms`);
  console.log(`  adding a copy to the release being excluded waited until commit (${sameRelease.ms} ms, refused: ${/release unavailable/.test(sameRelease.out)})`);
  const after = psql(`select md5(string_agg(concat_ws('|', (to_jsonb(c) - array['record_status', 'invalidated_at'])::text, (select to_jsonb(p)::text from public.collection_item_private p where p.item_id = c.id),
    (select string_agg(to_jsonb(x)::text, ',') from public.collection_item_components x where x.item_id = c.id)), ',' order by c.id)) from public.collection_items c where c.release_id = '${ids.r1}';`);
  console.log(`  copies preserved: ${psql(`select count(*) from public.collection_items where release_id = '${ids.r1}' and record_status = 'invalid_preserved';`)}, notifications: ${psql(`select count(*) from public.notifications where type = 'catalog_exclusion' and data ->> 'exclusion_id' = (select id::text from private.catalog_exclusions where release_id = '${ids.r1}');`)}, every copy otherwise unchanged: ${before === after}`);

  const x = psql(`select id from private.catalog_exclusions where release_id = '${ids.r1}';`);
  const restore = await timed(a, `begin; ${as(ids.admin)} select public.restore_exclusion('${x}', 1, 'Benchmark') ->> 'copies'; reset role; commit;`);
  console.log(`Restoration: ${restore.ms} ms including commit; copies active again: ${psql(`select count(*) from public.collection_items where release_id = '${ids.r1}' and record_status = 'active';`)}, unchanged: ${before === psql(`select md5(string_agg(concat_ws('|', (to_jsonb(c) - array['record_status', 'invalidated_at'])::text, (select to_jsonb(p)::text from public.collection_item_private p where p.item_id = c.id),
    (select string_agg(to_jsonb(x)::text, ',') from public.collection_item_components x where x.item_id = c.id)), ',' order by c.id)) from public.collection_items c where c.release_id = '${ids.r1}';`)}`);
  a.close();
  b.close();
} finally {
  // Not in replica mode, so foreign-key cascades run; only the audit rows need it.
  psql(`begin;
    create temp table our_games on commit drop as select id from public.games where title like '${PREFIX}%';
    delete from private.catalog_exclusions where release_id in (select id from public.releases where game_id in (select id from our_games));
    delete from public.collection_items where release_id in (select id from public.releases where game_id in (select id from our_games));
    delete from public.release_components where release_id in (select id from public.releases where game_id in (select id from our_games));
    delete from public.releases where game_id in (select id from our_games);
    delete from public.games where id in (select id from our_games);
    commit;
    begin; set local session_replication_role = replica;
    delete from private.audit_events where actor_id in (select id from auth.users where email like 'exb-%@example.test');
    commit;
    delete from auth.users where email like 'exb-%@example.test';
    delete from private.handle_holds where kind = 'released' and handle like 'xb\\_%';`);
  console.log(`\nCleaned up: ${psql(`select count(*) from auth.users where email like 'exb-%';`)} accounts and ${psql(`select count(*) from public.games where title like '${PREFIX}%';`)} games left`);
}
