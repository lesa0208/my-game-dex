/**
 * M12 W1 concurrency checks for the wishlist, against a local stack. Real database
 * sessions race an add against an exclusion, a status change and a merge of its target,
 * a retried add against itself, two adds of one target under different ids, two adds
 * at the limit, and edits of one entry against each other and against a removal.
 * pgTAP (52_wishlist.test.sql) covers the rules in one session; this covers what one
 * session can't: that the locks serialize them, in either order, with no deadlock, no
 * duplicate and no entry on a record that left the catalog.
 *
 *   MGD_STACK=test node scripts/db-wishlist-checks.mjs
 *
 * Synthetic records only, removed at the end. Refuses a protected development stack.
 */
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

import { dbContainer, guardDevStack } from "./lib/stack.mjs";

guardDevStack("db-wishlist-checks");

const tag = `zwl${randomBytes(3).toString("hex")}`;
const args = ["exec", "-i", dbContainer, "psql", "-U", "postgres", "-d", "postgres", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-At"];
const psql = (sql) => execFileSync("docker", args, { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
/** Runs SQL in its own session; resolves with its exit code, output and how long it took. */
const session = (sql) =>
  new Promise((resolve) => {
    const started = Date.now();
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.on("close", (code) => resolve({ code, out, ms: Date.now() - started }));
    child.stdin.end(sql);
  });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
function check(name, ok, detail = "") {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : ` (${detail})`}`);
}

/** Two sessions run `first` and `second`; the first holds its transaction for a moment. */
async function race(first, second) {
  const a = session(`begin;\n${first}\nselect pg_sleep(2);\ncommit;`);
  await pause(600);
  const b = session(`begin;\n${second}\ncommit;`);
  return Promise.all([a, b]);
}
const firstLine = (r) => r.out.trim().split("\n")[0];
const noDeadlock = (...results) => results.every((r) => !r.out.includes("deadlock"));

const before = psql(`select (select count(*) from public.wishlist_items) || ' ' || (select count(*) from public.games) || ' ' || (select count(*) from auth.users);`);

// People: two collectors, a catalog editor who excludes. The editor has the live aal2
// session with a verified TOTP factor that staff functions need.
const person = (suffix) =>
  psql(`insert into auth.users (id, aud, role, email, email_confirmed_at, instance_id)
  values (gen_random_uuid(), 'authenticated', 'authenticated', '${tag}${suffix}@example.test', now(), '00000000-0000-0000-0000-000000000000') returning id;`);
const collector = person("c");
const other = person("o");
const editor = person("e");
psql(`update public.profiles set handle = '${tag}_' || substr(md5(id::text), 1, 4), handle_changed_at = now() where id in ('${collector}', '${other}', '${editor}');
insert into public.staff_roles (user_id, role) values ('${editor}', 'catalog_editor');
insert into auth.sessions (id, user_id, aal, factor_id, created_at, updated_at)
  select u, u, 'aal2', u, now(), now() from unnest(array['${collector}', '${other}', '${editor}']::uuid[]) u;
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
  values ('${editor}', '${editor}', 'race checks', 'totp', 'verified', now(), now());
insert into auth.mfa_amr_claims (id, session_id, authentication_method, created_at, updated_at)
  values (gen_random_uuid(), '${editor}', 'totp', now(), now());`);
const as = (who) =>
  `select set_config('request.jwt.claims', '${JSON.stringify({ sub: who, role: "authenticated", aal: "aal2", session_id: who })}', true);\nset local role authenticated;`;

// A published game with one published release on SNES, so excluding the release
// excludes the game. A published game needs its pairing and release, checked at commit.
const gameWithRelease = (name) =>
  psql(`with g as (
    insert into public.games (slug, title, sort_title, kind, status, verified_at)
    values ('${tag}-${name}', '${tag} ${name}', '${tag} ${name}', 'game', 'published', now()) returning id
  ), gp as (
    insert into public.game_platforms (game_id, platform_id, status)
    select g.id, p.id, 'published' from g, public.platforms p where p.slug = 'snes' returning game_id
  ), r as (
    insert into public.releases (game_id, platform_id, media_format_code, region_code, edition_name, edition_kind, media_count, packaging_code, product_code, status, verified_at)
    select gp.game_id, p.id, 'snes-game-pak-na', 'ntsc-uc', 'Standard', 'standard', 1, 'cardboard-box', '${tag}-${name}', 'published', now() from gp, public.platforms p where p.slug = 'snes' returning id, game_id
  )
  select r.game_id || ' ' || r.id from r;`).split(" ");
/** Another published release of a game, with its pairing if it has none on the platform. */
const addRelease = (game, platform, format, name) =>
  psql(`with gp as (
    insert into public.game_platforms (game_id, platform_id, status)
    select '${game}', p.id, 'published' from public.platforms p where p.slug = '${platform}'
    on conflict do nothing returning game_id
  ), r as (
    insert into public.releases (game_id, platform_id, media_format_code, region_code, edition_name, edition_kind, media_count, packaging_code, product_code, status, verified_at)
    select '${game}', p.id, '${format}', 'ntsc-uc', 'Standard', 'standard', 1, 'cardboard-box', '${tag}-${name}', 'published', now() from public.platforms p where p.slug = '${platform}' returning id
  )
  select r.id from r;`);
const v7 = () => psql(`select private.uuid_v7();`);
const wantRelease = (item, release) => `select public.add_wishlist_item('${item}', '{"release_id": "${release}"}');`;
const wantGame = (item, game, extra = "") => `select public.add_wishlist_item('${item}', '{"game_id": "${game}"${extra}}');`;
const token = (release) => psql(`select private.exclusion_plan('${release}') ->> 'token';`);
const exclude = (release, tok) => `${as(editor)}\nselect public.exclude_release('${release}', '${tok}', 'no_game_data', 'Holds no game', 'Out of scope', true, true);`;
const entries = (where) => psql(`select count(*) from public.wishlist_items where ${where};`);
const stateOf = (who, item) => psql(`begin;\n${as(who)}\nselect public.get_my_wishlist_item('${item}') ->> 'state';\ncommit;`).split("\n").pop();

const games = [];
const releases = [];
try {
  console.log("\nAn add while its release is being excluded");
  {
    const [game, release] = gameWithRelease("one");
    games.push(game);
    releases.push(release);
    const [a, b] = await race(exclude(release, token(release)), `${as(collector)}\n${wantRelease(v7(), release)}`);
    check("the exclusion goes ahead", a.code === 0, a.out.trim());
    check("the add waits for it", b.ms >= 1000, `${b.ms} ms`);
    check("and is then refused: the release is no longer published", b.code !== 0 && b.out.includes("release unavailable"), firstLine(b));
    check("no entry names the excluded release", entries(`release_id = '${release}'`) === "0");
    check("no deadlock", noDeadlock(a, b));
  }

  console.log("\nAn exclusion while an add of its release is being made");
  {
    const [game, release] = gameWithRelease("two");
    games.push(game);
    releases.push(release);
    const item = v7();
    const tok = token(release);
    const [a, b] = await race(`${as(collector)}\n${wantRelease(item, release)}`, exclude(release, tok));
    check("the add is made", a.code === 0 && a.out.includes('"created": true'), a.out.trim());
    check("the exclusion waits for it", b.ms >= 1000, `${b.ms} ms`);
    check("and goes ahead: an entry never blocks the catalog", b.code === 0, firstLine(b));
    check("the entry is kept, unchanged", entries(`id = '${item}' and release_id = '${release}'`) === "1");
    check("and reads as unavailable", stateOf(collector, item) === "unavailable", stateOf(collector, item));
    check("no deadlock", noDeadlock(a, b));
  }

  // A plain status UPDATE takes FOR NO KEY UPDATE on the game row, which a FOR KEY SHARE
  // lock wouldn't wait for. The add's FOR SHARE must, whatever takes the game away.
  console.log("\nA game add while a plain update takes the game out of the catalog");
  {
    const [game, release] = gameWithRelease("three");
    games.push(game);
    releases.push(release);
    const [a, b] = await race(
      `update public.releases set status = 'excluded' where id = '${release}';
update public.game_platforms set status = 'excluded' where game_id = '${game}';
update public.games set status = 'excluded' where id = '${game}';`,
      `${as(collector)}\n${wantGame(v7(), game)}`,
    );
    check("the update goes ahead", a.code === 0, a.out.trim());
    check("the add waits for it (FOR SHARE conflicts with the update's lock)", b.ms >= 1000, `${b.ms} ms`);
    check("and is then refused", b.code !== 0 && b.out.includes("game unavailable"), firstLine(b));
    check("no entry names the game", entries(`game_id = '${game}'`) === "0");
  }

  console.log("\nA platform add while the game's pairing leaves the catalog");
  {
    // The game is also on NES, so it stays published when its NES release and pairing go.
    const [game, release] = gameWithRelease("four");
    games.push(game);
    releases.push(release);
    const nesRelease = addRelease(game, "nes", "nes-game-pak", "four-nes");
    releases.push(nesRelease);
    const nes = psql(`select id from public.platforms where slug = 'nes';`);
    const [a, b] = await race(
      `update public.releases set status = 'excluded' where id = '${nesRelease}';
update public.game_platforms set status = 'excluded' where game_id = '${game}' and platform_id = '${nes}';`,
      `${as(collector)}\n${wantGame(v7(), game, `, "platform_id": "${nes}"`)}`,
    );
    check("the update goes ahead", a.code === 0, a.out.trim());
    check("the add waits for it", b.ms >= 1000, `${b.ms} ms`);
    check("and is then refused", b.code !== 0 && b.out.includes("platform unavailable"), firstLine(b));
    check("no entry names the game on NES", entries(`game_id = '${game}' and platform_id = '${nes}'`) === "0");
  }

  console.log("\nA release add while the release is being merged away");
  {
    // Two SNES releases of one game: merging one into the other leaves the game and its
    // pairing published.
    const [game, target] = gameWithRelease("five");
    const release = addRelease(game, "snes", "snes-game-pak-na", "five-dup");
    games.push(game);
    releases.push(release, target);
    const [a, b] = await race(
      `update public.releases set status = 'merged', merged_into_id = '${target}', merged_publicly = true where id = '${release}';`,
      `${as(collector)}\n${wantRelease(v7(), release)}`,
    );
    check("the merge goes ahead", a.code === 0, a.out.trim());
    check("the add waits for it", b.ms >= 1000, `${b.ms} ms`);
    check("and is then refused: a merged release isn't added", b.code !== 0 && b.out.includes("release unavailable"), firstLine(b));
  }

  console.log("\nThe same add, retried at the same time");
  {
    const [game, release] = gameWithRelease("seven");
    games.push(game);
    releases.push(release);
    const item = v7();
    const [a, b] = await race(`${as(collector)}\n${wantRelease(item, release)}`, `${as(collector)}\n${wantRelease(item, release)}`);
    check("the first creates the entry", a.code === 0 && a.out.includes('"created": true'), a.out.trim());
    check("the retry waits, then returns the same entry", b.code === 0 && b.ms >= 1000 && b.out.includes('"created": false') && b.out.includes(item), b.out.trim());
    check("one entry exists", entries(`release_id = '${release}'`) === "1");

    console.log("\nThe same target under two ids at the same time");
    const first = v7();
    const second = v7();
    const [c, d] = await race(`${as(other)}\n${wantGame(first, game)}`, `${as(other)}\n${wantGame(second, game)}`);
    check("the first creates the entry", c.code === 0 && c.out.includes('"created": true'), c.out.trim());
    check("the second waits, then returns the first's entry", d.code === 0 && d.ms >= 1000 && d.out.includes(first) && d.out.includes('"created": false'), d.out.trim());
    check("one entry exists for the target", entries(`owner_id = '${other}' and game_id = '${game}'`) === "1");
    check("no deadlock", noDeadlock(a, b, c, d));

    console.log("\nTwo edits of one entry at the same time");
    const snes = psql(`select id from public.platforms where slug = 'snes';`);
    const [e, f] = await race(
      `${as(other)}\nselect public.update_wishlist_item('${first}', '{"target": {"game_id": "${game}", "platform_id": "${snes}"}}');`,
      `${as(other)}\nselect public.update_wishlist_item('${first}', '{"target": {"game_id": "${game}", "platform_id": "${snes}", "region_code": "pal"}}');`,
    );
    check("the first changes the target", e.code === 0 && e.out.includes('"changed": true'), e.out.trim());
    check("the second waits, then is told to retry: the target it started from changed", f.code !== 0 && f.ms >= 1000 && f.out.includes("request conflict"), firstLine(f));
    check("the first change stands", psql(`select region_code is null and platform_id = '${snes}' from public.wishlist_items where id = '${first}';`) === "t");
    const [g, h] = await race(
      `${as(other)}\nselect public.update_wishlist_item('${first}', '{"priority": 1}');`,
      `${as(other)}\nselect public.update_wishlist_item('${first}', '{"note": "Boxed"}');`,
    );
    check("detail edits don't conflict: both apply, one after the other", g.code === 0 && h.code === 0 && h.ms >= 1000, `${firstLine(g)} / ${firstLine(h)}`);
    check("both are kept", psql(`select priority || ' ' || note from public.wishlist_items where id = '${first}';`) === "1 Boxed");
    const [i, j] = await race(`${as(other)}\nselect public.remove_wishlist_item('${first}');`, `${as(other)}\nselect public.update_wishlist_item('${first}', '{"priority": 3}');`);
    check("a removal goes ahead", i.code === 0, i.out.trim());
    check("an edit made meanwhile waits, then finds nothing", j.code !== 0 && j.out.includes("item unavailable"), firstLine(j));
    check("no deadlock", noDeadlock(e, f, g, h, i, j));
  }

  console.log("\nAn edit to a target while that target is being excluded");
  {
    const [game, release] = gameWithRelease("eight");
    const [start] = gameWithRelease("nine");
    games.push(game, start);
    releases.push(release);
    const item = v7();
    psql(`begin;\n${as(collector)}\n${wantGame(item, start)}\ncommit;`);
    const [a, b] = await race(exclude(release, token(release)), `${as(collector)}\nselect public.update_wishlist_item('${item}', '{"target": {"release_id": "${release}"}}');`);
    check("the exclusion goes ahead", a.code === 0, a.out.trim());
    check("the edit waits for it", b.ms >= 1000, `${b.ms} ms`);
    check("and is then refused", b.code !== 0 && b.out.includes("release unavailable"), firstLine(b));
    check("the entry stays as it was", entries(`id = '${item}' and game_id = '${start}'`) === "1");
    check("no deadlock", noDeadlock(a, b));
  }

  console.log("\nTwo adds at the limit at the same time");
  {
    const [game, release] = gameWithRelease("ten");
    games.push(game);
    releases.push(release);
    // 9,999 entries; replica mode skips the checks and foreign keys for the filler.
    psql(`begin;
set local session_replication_role = replica;
insert into public.wishlist_items (id, owner_id, release_id) select private.uuid_v7(), '${other}', gen_random_uuid() from generate_series(1, 9999);
commit;`);
    const snes = psql(`select id from public.platforms where slug = 'snes';`);
    const [a, b] = await race(`${as(other)}\n${wantGame(v7(), game)}`, `${as(other)}\n${wantGame(v7(), game, `, "platform_id": "${snes}"`)}`);
    check("the first is the 10,000th", a.code === 0 && a.out.includes('"created": true'), a.out.trim());
    check("the second waits for it, then is refused", b.code !== 0 && b.ms >= 1000 && b.out.includes("wishlist limit reached"), firstLine(b));
    check("the collector has exactly 10,000 entries", entries(`owner_id = '${other}'`) === "10000");
    check("no deadlock", noDeadlock(a, b));
    psql(`delete from public.wishlist_items where owner_id = '${other}' and release_id is not null and not exists (select 1 from public.releases r where r.id = release_id);`);
  }
} catch (error) {
  failed += 1;
  console.error(`FAIL wishlist checks stopped early: ${error.message}`);
} finally {
  // People first: their entries, notifications and roles go with them. Then the
  // synthetic catalog and its exclusions and audit rows, which nothing else references.
  const list = (ids) => `array[${ids.map((g) => `'${g}'`).join(", ") || "null"}]::uuid[]`;
  psql(`begin;
delete from auth.users where id in ('${collector}', '${other}', '${editor}');
set local session_replication_role = replica;
delete from private.catalog_exclusion_copies where exclusion_id in (select id from private.catalog_exclusions where release_id = any (${list(releases)}));
delete from private.catalog_exclusions where release_id = any (${list(releases)});
delete from private.catalog_record_origins where game_id = any (${list(games)})
  or release_id in (select id from public.releases where game_id = any (${list(games)}));
delete from private.catalog_verifications where game_id = any (${list(games)})
  or release_id in (select id from public.releases where game_id = any (${list(games)}));
delete from public.releases where game_id = any (${list(games)});
delete from public.game_platforms where game_id = any (${list(games)});
delete from public.games where id = any (${list(games)});
delete from private.audit_events where actor_id = '${editor}' or target_profile_id in ('${collector}', '${other}', '${editor}');
delete from private.handle_holds where handle like '${tag}\\_%';
commit;`);
  const left = psql(`select (select count(*) from public.games where slug like '${tag}-%') + (select count(*) from auth.users where email like '${tag}%')
    + (select count(*) from public.wishlist_items w where not exists (select 1 from public.profiles p where p.id = w.owner_id))
    + (select count(*) from private.catalog_record_origins o where not exists (select 1 from public.games g where g.id = o.game_id) and not exists (select 1 from public.releases r where r.id = o.release_id))
    + (select count(*) from private.catalog_verifications v where not exists (select 1 from public.games g where g.id = v.game_id) and not exists (select 1 from public.releases r where r.id = v.release_id))
    + (select count(*) from private.handle_holds where handle like '${tag}\\_%');`);
  check("synthetic records removed", left === "0", left);
  const after = psql(`select (select count(*) from public.wishlist_items) || ' ' || (select count(*) from public.games) || ' ' || (select count(*) from auth.users);`);
  check("the stack holds what it held before (entries, games, users)", after === before, `${before} -> ${after}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
