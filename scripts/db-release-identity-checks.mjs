/**
 * M11b-1b concurrency checks for release identity, against the local stack: two real
 * database sessions race on the same identity, and the unique index makes the second
 * wait for the first and then refuses it. pgTAP (45_release_identity.test.sql) covers
 * the rules in one session; this covers what one session can't.
 *
 *   MGD_STACK=test node scripts/db-release-identity-checks.mjs
 *
 * Synthetic records only, removed at the end. Refuses a protected development stack.
 */
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

import { dbContainer, guardDevStack } from "./lib/stack.mjs";

guardDevStack("db-release-identity-checks");

const tag = `Zqr${randomBytes(3).toString("hex")}`;
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

// A published game needs a published pairing and release, checked at commit, so all three
// are made in one statement.
const game = psql(`with g as (
    insert into public.games (slug, title, sort_title, kind, status, verified_at)
    values ('${tag.toLowerCase()}', '${tag} Race', '${tag} Race', 'game', 'published', now()) returning id
  ), gp as (
    insert into public.game_platforms (game_id, platform_id, status)
    select g.id, p.id, 'published' from g, public.platforms p where p.slug = 'snes' returning game_id
  ), r as (
    insert into public.releases (game_id, platform_id, media_format_code, region_code, edition_name, edition_kind, media_count, packaging_code, product_code, status, verified_at)
    select gp.game_id, p.id, 'snes-game-pak-na', 'ntsc-uc', 'Anchor', 'standard', 1, 'cardboard-box', '${tag}-0', 'published', now() from gp, public.platforms p where p.slug = 'snes' returning id
  )
  select g.id from g, r;`);
const user = psql(`insert into auth.users (id, aud, role, email, email_confirmed_at, instance_id)
  values (gen_random_uuid(), 'authenticated', 'authenticated', '${tag.toLowerCase()}@example.test', now(), '00000000-0000-0000-0000-000000000000') returning id;`);

const insert = (fields) => `insert into public.releases (game_id, platform_id, media_format_code, region_code, edition_name, edition_kind, media_count, ${Object.keys(fields).join(", ")})
  select '${game}', p.id, 'snes-game-pak-na', 'ntsc-uc', 'Standard', 'standard', 1, ${Object.values(fields).map((v) => (v === null ? "null" : `'${v}'`)).join(", ")}
  from public.platforms p where p.slug = 'snes';`;

try {
  console.log("\nConcurrent publication of one identity");
  {
    const [a, b] = await race(
      insert({ product_code: `${tag}-1`, packaging_code: "cardboard-box", status: "published", verified_at: new Date().toISOString() }),
      insert({ product_code: `${tag.toLowerCase()}-1`, packaging_code: "cardboard-box", status: "published", verified_at: new Date().toISOString() }),
    );
    check("the first session publishes", a.code === 0, a.out.trim());
    check("the second waits for it", b.ms >= 1000, `${b.ms} ms`);
    check("and is refused by releases_published_identity_key", b.code !== 0 && b.out.includes("releases_published_identity_key"), b.out.trim().split("\n")[0]);
    check("one release exists", psql(`select count(*) from public.releases where game_id = '${game}' and upper(product_code) = upper('${tag}-1');`) === "1");
  }

  console.log("\nConcurrent publication of two shells");
  {
    const other = insert({ product_code: `${tag}-2`, packaging_code: "cardboard-box", status: "published", verified_at: new Date().toISOString() });
    const [a, b] = await race(other, other.replace("'snes-game-pak-na'", "'snes-cartridge-jp-pal'"));
    check("different shells are both published", a.code === 0 && b.code === 0, `${a.out.trim()} ${b.out.trim()}`);
  }

  console.log("\nConcurrent identical submissions by one collector");
  {
    const pending = insert({ product_code: `${tag}-3`, status: "unverified", submitted_by: user });
    const [a, b] = await race(pending, pending.replace(`'${tag}-3'`, `'${tag.toUpperCase()}-3'`));
    check("the first submission is kept", a.code === 0, a.out.trim());
    check("the second waits, then is refused by releases_pending_submission_key", b.ms >= 1000 && b.code !== 0 && b.out.includes("releases_pending_submission_key"), b.out.trim().split("\n")[0]);
  }

  console.log("\nConcurrent classification of two legacy releases");
  {
    const ids = ["Jewel case", "jewel case"].map((text) =>
      psql(insert({ product_code: `${tag}-4`, packaging: text, status: "published", verified_at: new Date().toISOString() }).replace("'snes-game-pak-na'", "'rom-cartridge'").replace(";", " returning id;")),
    );
    check("two unclassified releases whose texts differ only in case coexist", ids.every((id) => /^[0-9a-f-]{36}$/.test(id)));
    const classify = (id) => `update public.releases set packaging_code = 'jewel-case' where id = '${id}';`;
    const [a, b] = await race(classify(ids[0]), classify(ids[1]));
    check("one classification succeeds", a.code === 0, a.out.trim());
    check("the other waits and is refused, so they never become silent duplicates", b.ms >= 1000 && b.code !== 0 && b.out.includes("releases_published_identity_key"), b.out.trim().split("\n")[0]);
    check("the refused one is unchanged", psql(`select packaging_code from public.releases where id = '${ids[1]}';`) === "unclassified");
  }
} catch (error) {
  failed += 1;
  console.error(`FAIL release identity checks stopped early: ${error.message}`);
} finally {
  psql(`begin;
delete from public.releases where game_id = '${game}';
delete from public.games where id = '${game}';
delete from auth.users where id = '${user}';
set local session_replication_role = replica;
delete from private.audit_events where metadata ->> 'game_id' = '${game}';
commit;`);
  const left = psql(`select count(*) from public.games where id = '${game}';`);
  check("nothing is left behind", left === "0", left);
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
