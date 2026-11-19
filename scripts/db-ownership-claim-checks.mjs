/**
 * M12a concurrency checks for unidentified copies (ownership claims), against the local
 * stack. Real database sessions race a claim against an exclusion of its game, an owner's
 * identity change against an exclusion and a restoration, and a retried add against
 * itself. pgTAP (46_flexible_ownership.test.sql) covers the rules in one session; this
 * covers what one session can't: that the locks serialize them, in either order, with no
 * deadlock and no lost or overwritten copy.
 *
 *   MGD_STACK=test node scripts/db-ownership-claim-checks.mjs
 *
 * Synthetic records only, removed at the end. Refuses a protected development stack.
 */
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

import { dbContainer, guardDevStack } from "./lib/stack.mjs";

guardDevStack("db-ownership-claim-checks");

const tag = `zoc${randomBytes(3).toString("hex")}`;
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

// People: a collector, a catalog editor who excludes, an administrator who restores. The
// staff have the live aal2 session with a verified TOTP factor that staff functions need.
const person = (suffix) =>
  psql(`insert into auth.users (id, aud, role, email, email_confirmed_at, instance_id)
  values (gen_random_uuid(), 'authenticated', 'authenticated', '${tag}${suffix}@example.test', now(), '00000000-0000-0000-0000-000000000000') returning id;`);
const collector = person("c");
const editor = person("e");
const admin = person("a");
psql(`update public.profiles set handle = '${tag}_' || substr(md5(id::text), 1, 4), handle_changed_at = now() where id in ('${collector}', '${editor}', '${admin}');
insert into public.staff_roles (user_id, role) values ('${editor}', 'catalog_editor'), ('${admin}', 'admin');
insert into auth.sessions (id, user_id, aal, factor_id, created_at, updated_at)
  select u, u, 'aal2', u, now(), now() from unnest(array['${collector}', '${editor}', '${admin}']::uuid[]) u;
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
  select u, u, 'race checks', 'totp', 'verified', now(), now() from unnest(array['${editor}', '${admin}']::uuid[]) u;
insert into auth.mfa_amr_claims (id, session_id, authentication_method, created_at, updated_at)
  select gen_random_uuid(), u, 'totp', now(), now() from unnest(array['${editor}', '${admin}']::uuid[]) u;`);
const as = (who) =>
  `select set_config('request.jwt.claims', '${JSON.stringify({ sub: who, role: "authenticated", aal: "aal2", session_id: who })}', true);\nset local role authenticated;`;

// A published game with one published release, so excluding the release excludes it. A
// published game needs its pairing and release, checked at commit: one statement.
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
const snes = psql(`select id from public.platforms where slug = 'snes';`);
const v7 = () => psql(`select private.uuid_v7();`);
const claim = (item, game) => `select public.add_unidentified_copy('${item}', '${game}', '${snes}', 'pal', 'reprint', 'Platinum');`;
const token = (release) => psql(`select private.exclusion_plan('${release}') ->> 'token';`);
const exclude = (release, tok) => `${as(editor)}\nselect public.exclude_release('${release}', '${tok}', 'no_game_data', 'Holds no game', 'Out of scope', true, true);`;
const exclusionOf = (release) => psql(`select id || ' ' || version from private.catalog_exclusions where release_id = '${release}' and restored_at is null;`).split(" ");
const restore = (release) => {
  const [id, version] = exclusionOf(release);
  return `${as(admin)}\nselect public.restore_exclusion('${id}', ${version}, 'Excluded by mistake');`;
};
const state = (item) => psql(`select coalesce(release_id::text, 'claim:' || claimed_game_id) || ' ' || record_status from public.collection_items where id = '${item}';`);
const noDeadlock = (...results) => results.every((r) => !r.out.includes("deadlock"));

const games = [];
const releases = [];
try {
  console.log("\nA claim made while its game is being excluded");
  {
    const [game, release] = gameWithRelease("one");
    games.push(game);
    releases.push(release);
    const item = v7();
    const [a, b] = await race(exclude(release, token(release)), `${as(collector)}\n${claim(item, game)}`);
    check("the exclusion goes ahead", a.code === 0, a.out.trim());
    check("the claim waits for it", b.ms >= 1000, `${b.ms} ms`);
    check("and is then refused: the game is no longer published", b.code !== 0 && b.out.includes("game unavailable"), b.out.trim().split("\n")[0]);
    check("no claim exists on the excluded game", psql(`select count(*) from public.collection_items where claimed_game_id = '${game}';`) === "0");
    check("no deadlock", noDeadlock(a, b));
  }

  console.log("\nAn exclusion while a claim on its game is being made");
  {
    const [game, release] = gameWithRelease("two");
    games.push(game);
    releases.push(release);
    const item = v7();
    const tok = token(release);
    const [a, b] = await race(`${as(collector)}\n${claim(item, game)}`, exclude(release, tok));
    check("the claim is made", a.code === 0, a.out.trim());
    check("the exclusion waits for it", b.ms >= 1000, `${b.ms} ms`);
    check("and goes ahead", b.code === 0, b.out.trim().split("\n")[0]);
    check("the claim made first is preserved by it, not missed", state(item) === `claim:${game} invalid_preserved`, state(item));
    check("and recorded as preserved for that game",
      psql(`select count(*) from private.catalog_exclusion_copies where item_id = '${item}' and claimed_game_id = '${game}';`) === "1");
    check("no deadlock", noDeadlock(a, b));

    console.log("\nThe owner moves a preserved claim while it's being restored");
    const [other, otherRelease] = gameWithRelease("three");
    games.push(other);
    releases.push(otherRelease);
    const [c, d] = await race(`${as(collector)}\nselect public.set_my_copy_identity('${item}', '{"release_id": "${otherRelease}"}');`, restore(release));
    check("the owner's change is made", c.code === 0, c.out.trim());
    check("the restoration waits for it", d.ms >= 1000, `${d.ms} ms`);
    check("and goes ahead", d.code === 0, d.out.trim().split("\n")[0]);
    check("restoring didn't overwrite the owner's change", state(item) === `${otherRelease} active`, state(item));
    check("and restored no copy: the only one had moved", psql(`select copies_restored from private.catalog_exclusions where release_id = '${release}';`) === "0");
    check("no deadlock", noDeadlock(c, d));
  }

  console.log("\nThe owner moves a claim onto a game while it's being excluded");
  {
    const [game, release] = gameWithRelease("four");
    const [start] = gameWithRelease("five");
    games.push(game, start);
    releases.push(release);
    const item = v7();
    psql(`begin;\n${as(collector)}\n${claim(item, start)}\ncommit;`);
    const [a, b] = await race(exclude(release, token(release)),
      `${as(collector)}\nselect public.set_my_copy_identity('${item}', '{"game_id": "${game}", "platform_id": "${snes}", "region_code": "pal"}');`);
    check("the exclusion goes ahead", a.code === 0, a.out.trim());
    check("the change waits for it", b.ms >= 1000, `${b.ms} ms`);
    check("and is then refused", b.code !== 0 && b.out.includes("game unavailable"), b.out.trim().split("\n")[0]);
    check("the claim stays where it was", state(item) === `claim:${start} active`, state(item));
    check("no deadlock", noDeadlock(a, b));
  }

  // A plain status UPDATE takes only FOR NO KEY UPDATE on the game row, which a FOR KEY
  // SHARE lock wouldn't wait for. The claim's FOR SHARE must, whatever excludes the game.
  console.log("\nA claim made while a plain update takes its game out of the catalog");
  {
    const [game, release] = gameWithRelease("seven");
    games.push(game);
    releases.push(release);
    const item = v7();
    const [a, b] = await race(
      `update public.releases set status = 'excluded' where id = '${release}';
update public.game_platforms set status = 'excluded' where game_id = '${game}';
update public.games set status = 'excluded' where id = '${game}';`,
      `${as(collector)}\n${claim(item, game)}`,
    );
    check("the update goes ahead", a.code === 0, a.out.trim());
    check("the claim waits for it (FOR SHARE conflicts with the update's lock)", b.ms >= 1000, `${b.ms} ms`);
    check("and is then refused", b.code !== 0 && b.out.includes("game unavailable"), b.out.trim().split("\n")[0]);
    check("no claim exists on the game", psql(`select count(*) from public.collection_items where claimed_game_id = '${game}';`) === "0");
  }

  console.log("\nThe same add, retried at the same time");
  {
    const [game, release] = gameWithRelease("six");
    games.push(game);
    releases.push(release);
    const item = v7();
    const [a, b] = await race(`${as(collector)}\n${claim(item, game)}`, `${as(collector)}\n${claim(item, game)}`);
    check("the first creates the copy", a.code === 0 && a.out.includes('"created": true'), a.out.trim());
    check("the retry waits, then returns the same copy", b.code === 0 && b.ms >= 1000 && b.out.includes('"created": false'), b.out.trim());
    check("one copy exists", psql(`select count(*) from public.collection_items where id = '${item}';`) === "1");
  }
} catch (error) {
  failed += 1;
  console.error(`FAIL ownership claim checks stopped early: ${error.message}`);
} finally {
  // People first: their copies, history, notifications and roles go with them. Then the
  // synthetic catalog and its exclusions and audit rows, which nothing else references.
  psql(`begin;
delete from auth.users where id in ('${collector}', '${editor}', '${admin}');
set local session_replication_role = replica;
delete from private.catalog_exclusion_copies where exclusion_id in (select id from private.catalog_exclusions where release_id = any (array[${releases.map((r) => `'${r}'`).join(", ") || "null"}]::uuid[]));
delete from private.catalog_exclusions where release_id = any (array[${releases.map((r) => `'${r}'`).join(", ") || "null"}]::uuid[]);
-- Provenance and verifications first, while every release of the synthetic games can still
-- be found by game. Replica mode runs no cascade, so each is deleted by name.
delete from private.catalog_record_origins where game_id = any (array[${games.map((g) => `'${g}'`).join(", ") || "null"}]::uuid[])
  or release_id in (select id from public.releases where game_id = any (array[${games.map((g) => `'${g}'`).join(", ") || "null"}]::uuid[]));
delete from private.catalog_verifications where game_id = any (array[${games.map((g) => `'${g}'`).join(", ") || "null"}]::uuid[])
  or release_id in (select id from public.releases where game_id = any (array[${games.map((g) => `'${g}'`).join(", ") || "null"}]::uuid[]));
delete from public.releases where game_id = any (array[${games.map((g) => `'${g}'`).join(", ") || "null"}]::uuid[]);
delete from public.game_platforms where game_id = any (array[${games.map((g) => `'${g}'`).join(", ") || "null"}]::uuid[]);
delete from public.games where id = any (array[${games.map((g) => `'${g}'`).join(", ") || "null"}]::uuid[]);
delete from private.audit_events where actor_id in ('${editor}', '${admin}') or target_profile_id in ('${collector}', '${editor}', '${admin}');
delete from private.handle_holds where handle like '${tag}\\_%';
commit;`);
  const left = psql(`select (select count(*) from public.games where slug like '${tag}-%') + (select count(*) from auth.users where email like '${tag}%')
    + (select count(*) from private.catalog_record_origins o where not exists (select 1 from public.games g where g.id = o.game_id) and not exists (select 1 from public.releases r where r.id = o.release_id))
    + (select count(*) from private.catalog_verifications v where not exists (select 1 from public.games g where g.id = v.game_id) and not exists (select 1 from public.releases r where r.id = v.release_id))
    + (select count(*) from private.handle_holds where handle like '${tag}\\_%');`);
  check("synthetic records removed", left === "0", left);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
