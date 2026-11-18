/**
 * Installs or removes the M5c catalog search fixture in the LOCAL database only.
 *
 *   node scripts/catalog-fixture.mjs install
 *   node scripts/catalog-fixture.mjs remove
 *
 * It runs psql inside the selected local stack's database container (the development
 * stack, or the test stack with MGD_STACK=test), and first checks that the stack's API
 * is on a loopback address and allowed (scripts/lib/stack.mjs). It takes no connection
 * string, so it can't reach a hosted database. Every fixture title is fictional.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stackConfigPath, stackStatus } from "./lib/stack.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const projectId = /project_id\s*=\s*"([^"]+)"/.exec(readFileSync(stackConfigPath, "utf8"))[1];
const container = `supabase_db_${projectId}`;
export const FIXTURE_EDITOR = "f1c5f1c5-0000-4000-8000-00000000c5c5";
/** Verifies and publishes what the fixture editor creates (M10c, D2). */
export const FIXTURE_REVIEWER = "f1c5f1c5-0000-4000-8000-00000000c5c6";

/** The selected stack (scripts/lib/stack.mjs) must be running, local and allowed; its error says why not. */
function assertLocal() {
  stackStatus({ label: "the catalog fixture" });
}

const psql = (sql) =>
  execFileSync("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-At"], {
    input: sql,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();

export function installFixture() {
  assertLocal();
  const out = psql(readFileSync(join(root, "scripts", "fixtures", "catalog-search-fixture.sql"), "utf8"));
  // M11a-5: an Auth row made in SQL without the fields GoTrue reads breaks Auth's user
  // listing for every account (and reading the account). Refuse to carry on with one.
  const malformed = psql(`select count(*) from auth.users u where u.id in ('${FIXTURE_EDITOR}', '${FIXTURE_REVIEWER}')
    and (u.confirmation_token is null or u.recovery_token is null or u.email_change_token_new is null or u.email_change is null
         or u.created_at is null or u.updated_at is null
         or exists (select 1 from auth.mfa_factors f where f.user_id = u.id and f.secret is null));`);
  if (malformed !== "0") throw new Error("The catalog fixture's Auth accounts are missing fields GoTrue needs (see scripts/fixtures/repair-fixture-auth-tokens.sql).");
  return out;
}

/**
 * Removes everything the fixture made: its records, its audit rows and its editors.
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
delete from public.staff_roles where user_id in ('${FIXTURE_EDITOR}', '${FIXTURE_REVIEWER}');
delete from auth.users where id in ('${FIXTURE_EDITOR}', '${FIXTURE_REVIEWER}');
delete from private.handle_holds where kind = 'released' and handle in ('catalog_fixture', 'catalog_fixture_rv');
set local session_replication_role = replica;
delete from private.audit_events where actor_id in ('${FIXTURE_EDITOR}', '${FIXTURE_REVIEWER}') or reason = 'Catalog search fixture';
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
