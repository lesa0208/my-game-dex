/**
 * Installs or removes the M5c catalog search fixture in the LOCAL database only.
 *
 *   node scripts/catalog-fixture.mjs install
 *   node scripts/catalog-fixture.mjs remove
 *
 * It runs psql inside this project's local Supabase database container, and first
 * checks that the stack's API is on a loopback address. It takes no connection
 * string, so it can't reach a hosted database. Every fixture title is fictional.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "node_modules", "supabase", "dist", "supabase.js");
const projectId = /project_id\s*=\s*"([^"]+)"/.exec(readFileSync(join(root, "supabase", "config.toml"), "utf8"))[1];
const container = `supabase_db_${projectId}`;
export const FIXTURE_EDITOR = "f1c5f1c5-0000-4000-8000-00000000c5c5";

function assertLocal() {
  let status;
  try {
    status = JSON.parse(execFileSync(process.execPath, [cli, "status", "-o", "json"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    throw new Error("The local stack isn't running. Try npm run db:start.");
  }
  const host = new URL(status.API_URL).hostname;
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) {
    throw new Error(`Refusing: the stack's API is on ${host}, not a loopback address.`);
  }
}

const psql = (sql) =>
  execFileSync("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-At"], {
    input: sql,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();

export function installFixture() {
  assertLocal();
  return psql(readFileSync(join(root, "scripts", "fixtures", "catalog-search-fixture.sql"), "utf8"));
}

/**
 * Removes everything the fixture made: its records, its audit rows and its editor.
 * Local copies of its fictional releases (M6) are removed first, because a copy keeps
 * its release from being deleted.
 */
export function removeFixture() {
  assertLocal();
  psql(`begin;
create temp table fx_games on commit drop as
  select distinct (metadata ->> 'id')::uuid as id from private.audit_events
  where actor_id = '${FIXTURE_EDITOR}' and action = 'catalog_record_created' and metadata ->> 'entity' = 'game';
delete from public.collection_items where release_id in (select r.id from public.releases r where r.game_id in (select id from fx_games));
delete from public.releases where game_id in (select id from fx_games) and merged_into_id is not null;
delete from public.releases where game_id in (select id from fx_games);
delete from public.games where id in (select id from fx_games) and merged_into_id is not null;
delete from public.games where id in (select id from fx_games);
delete from public.staff_roles where user_id = '${FIXTURE_EDITOR}';
delete from auth.users where id = '${FIXTURE_EDITOR}';
delete from private.handle_holds where kind = 'released' and handle = 'catalog_fixture';
set local session_replication_role = replica;
delete from private.audit_events where actor_id = '${FIXTURE_EDITOR}' or reason = 'Catalog search fixture';
commit;`);
  return "Catalog search fixture removed.";
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const command = process.argv[2];
  try {
    if (command === "install") console.log(installFixture());
    else if (command === "remove") console.log(removeFixture());
    else {
      console.error("Usage: node scripts/catalog-fixture.mjs install|remove");
      process.exit(2);
    }
  } catch (error) {
    console.error(error.stderr?.toString().trim().split("\n").find((line) => line.includes("ERROR")) ?? error.message);
    process.exit(1);
  }
}
