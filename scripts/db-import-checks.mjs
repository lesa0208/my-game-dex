/**
 * M5b catalog import checks against the running local stack. They log in as the real
 * catalog_importer role, run the import tool on small synthetic snapshots kept in a
 * temporary directory outside the repository, and hold transactions open to force
 * each race. pgTAP covers the rules; this covers the role, the tool and concurrency.
 *
 * Local only. The importer's password is generated here, never printed, and login is
 * disabled again at the end. Synthetic data only: no real source is fetched.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { scramVerifier } from "./catalog-import-role.mjs";
import { parseWikidata } from "./catalog-import-sources.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const config = readFileSync(join(root, "supabase", "config.toml"), "utf8");
const projectId = /project_id\s*=\s*"([^"]+)"/.exec(config)[1];
const dbPort = /\[db\][\s\S]*?\nport\s*=\s*(\d+)/.exec(config)[1];
const psqlArgs = ["exec", "-i", `supabase_db_${projectId}`, "psql", "-U", "postgres", "-d", "postgres", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-At"];
const psql = (sql) => execFileSync("docker", psqlArgs, { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const q = (value) => `'${String(value).replace(/'/g, "''")}'`;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Runs SQL as postgres in a session with its own application name, without blocking. */
const psqlAsync = (sql, appName) => new Promise((resolve, reject) => {
  const args = [...psqlArgs];
  args.splice(2, 0, "-e", `PGAPPNAME=${appName}`);
  const child = spawn("docker", args, { stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c));
  child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(stderr.trim().split("\n")[0]))));
  child.stdin.end(sql);
});

let passed = 0;
let failed = 0;
function check(name, ok, detail = "") {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail !== "" ? ` (${detail})` : ""}`);
}
const section = (title) => console.log(`\n${title}`);

const password = randomBytes(24).toString("base64url");
const importerUrl = `postgresql://catalog_importer:${encodeURIComponent(password)}@127.0.0.1:${dbPort}/postgres`;
const dir = mkdtempSync(join(tmpdir(), "mgd-import-checks-"));
const REASON = "Import checks";
const createdRuns = () => psql(`select coalesce(string_agg(quote_literal(id), ','), 'null') from private.import_runs where reason like 'Import checks%';`);

async function importer() {
  const client = new pg.Client({ connectionString: importerUrl, application_name: "import-checks" });
  await client.connect();
  return client;
}
/** A query's error message, or null when it succeeds. */
async function refused(client, sql, params = []) {
  try {
    await client.query(sql, params);
    return null;
  } catch (error) {
    return error.message;
  }
}
/** Runs the import tool and returns its exit status and output, without the URL. */
function tool(argv, env = {}) {
  const result = spawnSync(process.execPath, [join(root, "scripts", "catalog-import.mjs"), ...argv], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CATALOG_IMPORTER_DATABASE_URL: importerUrl, ...env },
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}`.replaceAll(password, "<password>") };
}
/** Waits until another session is blocked on a lock, then returns. */
async function untilWaiting(appName) {
  for (let i = 0; i < 100; i += 1) {
    if (psql(`select count(*) from pg_stat_activity where application_name = ${q(appName)} and wait_event_type in ('Lock', 'LWLock');`) !== "0") return true;
    await pause(50);
  }
  return false;
}
async function held(holder, blocked, blockedName) {
  const started = Date.now();
  const pending = blocked().then((v) => ({ ok: true, v }), (e) => ({ ok: false, message: e.message, code: e.code }));
  const waiting = await untilWaiting(blockedName);
  await pause(600);
  await holder.query("commit");
  const result = await pending;
  return { ...result, waited: Date.now() - started, waiting };
}

// Synthetic snapshots
function wikidataSnapshot(items) {
  return JSON.stringify({
    head: { vars: ["item", "itemLabel", "date", "precision", "aliases"] },
    results: {
      bindings: items.map(([qid, label, date, aliases = ""]) => ({
        item: { type: "uri", value: `http://www.wikidata.org/entity/${qid}` },
        itemLabel: { type: "literal", value: label },
        ...(date ? { date: { type: "literal", value: `${date}T00:00:00Z` }, precision: { type: "literal", value: "11" } } : {}),
        aliases: { type: "literal", value: aliases },
      })),
    },
  });
}
const dat = (games) => `<?xml version="1.0"?>\n<datafile>\n<header><name>Nintendo - Super Nintendo Entertainment System</name></header>\n${games
  .map(([name, serial]) => `<game name="${name}"><description>${name}</description><rom name="${name}.sfc" size="1048576" crc="${randomBytes(4).toString("hex")}" sha1="${randomBytes(20).toString("hex")}"${serial ? ` serial="${serial}"` : ""}/></game>`)
  .join("\n")}\n</datafile>\n`;
const write = (name, text) => {
  const file = join(dir, name);
  writeFileSync(file, text);
  return file;
};
const tag = randomBytes(3).toString("hex");
const T = (title) => `Zz ${title} ${tag}`;

async function role() {
  section("The importer role");
  const client = await importer();
  const who = await client.query("select current_user as u, (select rolsuper from pg_roles where rolname = current_user) as s");
  check("the tool's role can log in, as itself, without superuser", who.rows[0].u === "catalog_importer" && who.rows[0].s === false);
  const denied = (message) => message !== null && /permission denied/.test(message);
  check("it can't read the catalog", denied(await refused(client, "select count(*) from public.games")));
  check("or write it", denied(await refused(client, "insert into public.games (title, sort_title) values ('x', 'x')")));
  check("or call an editor function", denied(await refused(client, "select public.create_game('x', 'game', p_reason => 'x')")));
  check("or verify or publish", denied(await refused(client, "select public.publish_release(gen_random_uuid(), 'x', 1)")));
  check("or read provenance directly", denied(await refused(client, "select count(*) from private.provider_records")));
  check("or clear a provider", denied(await refused(client, "select private.record_provider_clearance('wikidata', true, null, null, 'x')")));
  check("or read the audit log", denied(await refused(client, "select count(*) from private.audit_events")));
  check("or create objects", denied(await refused(client, "create table public.x (id int)")));
  check("or become another role", (await refused(client, "set role postgres")) !== null);
  check("or reach Auth data", denied(await refused(client, "select count(*) from auth.users")));
  await client.end();

  const asPostgres = tool(["report", "--run", randomUUID()], { CATALOG_IMPORTER_DATABASE_URL: `postgresql://postgres:x@127.0.0.1:${dbPort}/postgres` });
  check("the tool refuses postgres credentials before connecting", asPostgres.status === 2 && /only as catalog_importer/.test(asPostgres.out), asPostgres.out.trim());
  const inRepo = tool(["import", "--provider", "wikidata", "--platform", "snes", "--file", join(root, "package.json"), "--terms-file", join(root, "package.json"), "--reason", REASON]);
  check("and snapshots inside the repository", inRepo.status === 2 && /outside the repository/.test(inRepo.out), inRepo.out.trim());
}

async function flow() {
  section("Importing through the tool");
  const terms = write("terms.txt", `Synthetic terms ${tag}\n`);
  const termsHash = createHash("sha256").update(readFileSync(terms)).digest("hex");
  const games = write("wikidata.json", wikidataSnapshot([
    ["Q900000001", T("Metroid"), "1994-03-19", T("Metroid III")],
    ["Q900000002", T("Pilot"), "1990-12-21"],
    ["Q900000003", T("Twin"), null],
    ["Q900000004", T("Twin"), null],
  ]));
  const releases = write("snes.dat", dat([
    [`${T("Metroid")} (USA)`, "SNS-ZZ-USA"],
    [`${T("Metroid")} (USA) (Rev 1)`, null],
    [`${T("Metroid")} (Japan)`, null],
    [`${T("Metroid III")} (Europe) (En,Fr,De)`, null],
    [`${T("Twin")} (USA)`, null],
    [`${T("Nobody")} (USA)`, null],
    [`${T("Pilot")} (USA) (Proto)`, null],
    [`${T("Pilot")} (USA) [b]`, null],
  ]));
  const run = (provider, file, extra = []) => tool(["import", "--provider", provider, "--platform", "snes", "--file", file, "--terms-file", terms, "--reason", `${REASON} ${tag}`, ...extra]);

  let result = run("wikidata", games);
  check("an uncleared source is refused by the database", result.status === 2 && /provider not cleared/.test(result.out), result.out.trim().split("\n").pop());
  psql(`select private.record_provider_clearance('wikidata', true, 'https://example.test/terms', ${q(termsHash)}, 'Import checks: synthetic terms');
select private.record_provider_clearance('no-intro', true, 'https://example.test/terms', ${q(termsHash)}, 'Import checks: synthetic terms');`);

  result = run("wikidata", games);
  check("a cleared source imports", result.status === 0, result.out.trim().split("\n").pop());
  const g = psql(`select count(*) || '/' || count(*) filter (where g.status = 'under_review' and g.verified_at is null) from public.games g join private.external_references x on x.game_id = g.id where x.external_id like 'Q90000000%';`);
  check("four game candidates, all under review and unverified", g === "4/4", g);

  result = run("no-intro", releases);
  check("the release snapshot imports", result.status === 0, result.out.trim().split("\n").pop());
  const report = JSON.parse(result.out.slice(result.out.indexOf("{"))).report;
  check("revisions are grouped, and a prototype and a bad dump are ignored", report.source_records === 7 && report.ignored_reasons.prototype === 1 && report.ignored_reasons["bad dump"] === 1, JSON.stringify(report.by_status));
  check("three releases created, one ambiguous and one unmatched", report.releases_created === 3 && report.by_tier["release:B"] === 1 && report.by_tier["release:C"] === 1, JSON.stringify(report.by_tier));
  check("no edition, kind, medium count or packaging is invented", report.releases_missing.edition === 3 && report.releases_missing.media_count === 3 && report.releases_missing.packaging === 3);
  check("nothing is verified or published", report.published_or_verified === 0);

  const before = psql("select count(*) from public.releases;");
  result = run("no-intro", releases);
  const again = result.status === 0 ? JSON.parse(result.out.slice(result.out.indexOf("{"))).report : null;
  check("importing the same snapshot again adds nothing", result.status === 0 && psql("select count(*) from public.releases;") === before && again.run.stats.staged_unchanged === 7, result.out.trim().split("\n").pop());

  const audits = psql(`select count(*) || '/' || count(*) filter (where actor_id is null and reason = ${q(`${REASON} ${tag}`)}) from private.audit_events
    where action in ('catalog_record_created', 'catalog_record_updated') and metadata ->> 'import_run_id' in (select id::text from private.import_runs where reason = ${q(`${REASON} ${tag}`)});`);
  check("every catalog change is audited with the run's reason and no actor", audits === "7/7", audits);
  return { terms, termsHash };
}

async function concurrency({ termsHash }) {
  section("Concurrency and recovery");
  const reason = `${REASON} ${tag} races`;
  const sha = createHash("sha256").update(`race ${tag}`).digest("hex");
  const start = (client, lease, hash = sha) => client.query("select catalog_import.start_run('wikidata', 'snes', 'race.json', $1, now(), $2, $3, $4) as id", [hash, termsHash, reason, lease]);

  // Two runs of one snapshot.
  const a = await importer();
  const b = new pg.Client({ connectionString: importerUrl, application_name: "import-race-b" });
  await b.connect();
  await a.query("begin");
  const leaseA = randomUUID();
  const runA = (await start(a, leaseA)).rows[0].id;
  let r = await held(a, () => start(b, randomUUID()), "import-race-b");
  check("a second run of a snapshot that is starting waits for it", r.waiting && r.waited > 500, `${r.waited} ms`);
  check("then is refused", !r.ok && r.code === "23505", r.message);
  check("and a later attempt is refused outright", (await refused(b, "select catalog_import.start_run('wikidata', 'snes', 'race.json', $1, now(), $2, $3, $4)", [sha, termsHash, reason, randomUUID()])) === "snapshot already running");

  // One process per run.
  check("another process can't work on a run held by a live lease", (await refused(b, "select catalog_import.claim_run($1, $2, $3)", [runA, randomUUID(), sha])) === "run in use");
  check("or send it entries without holding the lease", (await refused(b, "select catalog_import.stage_records($1, $2, '[]', null)", [runA, randomUUID()])) === "run in use");

  // An interrupted run resumes from its checkpoint, through the tool.
  const file = write("race.json", wikidataSnapshot([["Q900000011", T("Resume One"), null], ["Q900000012", T("Resume Two"), null], ["Q900000013", T("Resume Three"), null]]));
  const fileSha = createHash("sha256").update(readFileSync(file)).digest("hex");
  const leaseC = randomUUID();
  const runC = (await start(a, leaseC, fileSha)).rows[0].id;
  const entries = parseWikidata(readFileSync(file, "utf8"));
  await a.query("select catalog_import.stage_records($1, $2, $3, $4)", [runC, leaseC, JSON.stringify(entries.slice(0, 2)), JSON.stringify({ phase: "stage", staged: 2, slice: null })]);
  // The process stops here. Its lease is left to expire.
  let resumed = tool(["resume", "--run", runC, "--provider", "wikidata", "--file", file]);
  check("a stopped run can't be resumed while its lease is live", resumed.status === 2 && /run in use/.test(resumed.out), resumed.out.trim().split("\n").pop());
  psql(`update private.import_runs set lease_expires_at = now() - interval '1 second' where id = ${q(runC)};`);
  resumed = tool(["resume", "--run", runC, "--provider", "wikidata", "--file", file]);
  const resumedState = psql(`select status || '/' || (select count(*) from private.import_run_records where import_run_id = r.id) from private.import_runs r where id = ${q(runC)};`);
  check("after it expires, the tool resumes and completes the run", resumed.status === 0 && resumedState === "completed/3", `${resumedState} ${resumed.out.trim().split("\n").pop()}`);
  check("each entry once, each game once", psql("select count(*) from private.external_references where external_id in ('Q900000011', 'Q900000012', 'Q900000013');") === "3");

  // Two runs apply the same new source id at once.
  const leaseD = randomUUID();
  const leaseE = randomUUID();
  const runD = (await start(a, leaseD, createHash("sha256").update(`d ${tag}`).digest("hex"))).rows[0].id;
  const runE = (await start(b, leaseE, createHash("sha256").update(`e ${tag}`).digest("hex"))).rows[0].id;
  const entry = (title) => JSON.stringify([{ entity_type: "game", external_id: "Q900000021", payload: { title } }]);
  await a.query("select catalog_import.stage_records($1, $2, $3, null)", [runD, leaseD, entry(T("Same Id"))]);
  await b.query("select catalog_import.stage_records($1, $2, $3, null)", [runE, leaseE, entry(T("Same Id renamed"))]);
  const recordOf = (run) => psql(`select provider_record_id from private.import_run_records where import_run_id = ${q(run)};`);
  await a.query("begin");
  await a.query("select catalog_import.apply_record($1, $2, $3, null)", [runD, leaseD, recordOf(runD)]);
  r = await held(a, () => b.query("select catalog_import.apply_record($1, $2, $3, null) as r", [runE, leaseE, recordOf(runE)]), "import-race-b");
  check("applying a source id another run is creating waits for it", r.waiting && r.waited > 500, `${r.waited} ms`);
  check("then resolves to the same game instead of creating one", r.ok && r.v.rows[0].r.outcome === "matched" && psql("select count(*) from private.external_references where external_id = 'Q900000021';") === "1", r.message ?? JSON.stringify(r.v?.rows?.[0]?.r));

  // Withdrawing clearance waits for a batch in progress, then stops the run.
  await a.query("begin");
  await a.query("select catalog_import.stage_records($1, $2, '[]', null)", [runD, leaseD]);
  r = await held(a, () => psqlAsync(`select private.record_provider_clearance('wikidata', false, 'https://example.test/terms', ${q(termsHash)}, 'Import checks: withdrawn');`, "import-race-w"), "import-race-w");
  check("withdrawing clearance waits for a batch in progress", r.waiting && r.waited > 500 && r.ok, `${r.waited} ms ${r.message ?? ""}`);
  check("then the run is stopped", (await refused(b, "select catalog_import.stage_records($1, $2, '[]', null)", [runE, leaseE])) === "provider not cleared");
  check("and no new run can start", (await refused(b, "select catalog_import.start_run('wikidata', 'snes', 'x.json', $1, now(), $2, $3, $4)", [createHash("sha256").update(`x ${tag}`).digest("hex"), termsHash, reason, randomUUID()])) === "provider not cleared");
  for (const [client, run, lease] of [[a, runA, leaseA], [a, runD, leaseD], [b, runE, leaseE]]) await client.query("select catalog_import.finish_run($1, $2, 'abandoned')", [run, lease]);
  await a.end();
  await b.end();
}

async function api() {
  section("No API path");
  const status = JSON.parse(execFileSync(process.execPath, [join(root, "node_modules", "supabase", "dist", "supabase.js"), "status", "-o", "json"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  const key = status.SERVICE_ROLE_KEY ?? status.SECRET_KEY;
  for (const [label, headers] of [["service_role", { apikey: key, Authorization: `Bearer ${key}` }], ["anon", { apikey: status.ANON_KEY ?? status.PUBLISHABLE_KEY }]]) {
    const response = await fetch(`${status.API_URL}/rest/v1/rpc/start_run`, { method: "POST", headers: { ...headers, "Content-Type": "application/json", "Content-Profile": "catalog_import" }, body: "{}" });
    check(`${label} can't reach the import functions through the API`, !response.ok, `status ${response.status}`);
  }
}

function cleanup() {
  const runs = createdRuns();
  psql(`begin;
create temp table t_records on commit drop as
  select distinct x.provider_record_id as id from private.import_run_records x where x.import_run_id in (${runs})
  union select pr.id from private.provider_records pr where pr.import_run_id in (${runs});
create temp table t_games on commit drop as select matched_game_id as id from private.provider_records where id in (select id from t_records) and matched_game_id is not null
  union select game_id from private.external_references where game_id is not null and external_id like 'Q9000000%';
delete from private.release_evidence where provider_record_id in (select id from t_records);
delete from public.releases where game_id in (select id from t_games);
delete from public.games where id in (select id from t_games);
delete from private.external_references where external_id like 'Q9000000%' or external_id like '%${tag}%';
delete from private.import_run_records where import_run_id in (${runs});
delete from private.provider_records where id in (select id from t_records);
delete from private.import_runs where id in (${runs});
update private.external_providers set commercial_use_cleared = false, terms_url = null, terms_sha256 = null, terms_reviewed_at = null, cleared_note = null
  where code in ('wikidata', 'no-intro');
set local session_replication_role = replica;
delete from private.audit_events where reason like 'Import checks%';
commit;
alter role catalog_importer nologin password null;`);
  rmSync(dir, { recursive: true, force: true });
  const left = psql(`select (select count(*) from private.import_runs) + (select count(*) from private.provider_records) + (select count(*) from public.games) + (select count(*) from private.audit_events where reason like 'Import checks%')
    || '/' || (select rolcanlogin from pg_roles where rolname = 'catalog_importer');`);
  check("nothing is left behind, and the importer can't log in", left === "0/false", left);
}

try {
  psql(`alter role catalog_importer login password ${q(scramVerifier(password))};`);
  await role();
  const ctx = await flow();
  await concurrency(ctx);
  await api();
} catch (error) {
  failed += 1;
  console.error(`FAIL import checks stopped early: ${error.message.replaceAll(password, "<password>")}`);
} finally {
  cleanup();
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
