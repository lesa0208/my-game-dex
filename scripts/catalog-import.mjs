/**
 * The catalog import tool (M5b). An operator runs it locally against a snapshot
 * file kept outside the repository. It connects only as catalog_importer, which can
 * call nothing but the catalog_import functions, so every rule is enforced by the
 * database: clearance, audit, one run per snapshot, field locks, evidence and
 * resolving source ids. It never verifies or publishes anything.
 *
 *   node scripts/catalog-import.mjs fetch-wikidata --platform snes --out <dir>
 *   node scripts/catalog-import.mjs import --provider wikidata|no-intro --platform snes
 *        --file <snapshot> --terms-file <saved terms> --reason "<why>"
 *        [--letters S | --ids <selection.json>] [--fetched-at <ISO time>] [--dry-run]
 *   node scripts/catalog-import.mjs select-pilot --wikidata <snapshot> --no-intro <snapshot> --out <selection.json>
 *        [--games 50] [--releases 100] [--seed mgd-snes-pilot-1] [--selector-version 2] [--reuse <earlier selection.json>]
 *   node scripts/catalog-import.mjs resume --run <id> --provider <p> --file <snapshot> [--letters S]
 *   node scripts/catalog-import.mjs report --run <id>
 *
 * Environment: CATALOG_IMPORTER_DATABASE_URL (as catalog_importer, never postgres),
 * and WIKIDATA_USER_AGENT for fetch-wikidata (a tool name and operator contact, as
 * Wikimedia requires). Neither is printed.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { extendSelection, parseNoIntro, parseWikidata, pilotSelection, pilotSlice, wikidataQuery } from "./catalog-import-sources.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STAGE_BATCH = 200;
const PARSERS = { wikidata: parseWikidata, "no-intro": parseNoIntro };

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      out[key] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    } else out._.push(a);
  }
  return out;
}
const fail = (message) => {
  console.error(message);
  process.exit(2);
};
const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

/** Source data stays outside the repository. */
export function outsideRepo(path) {
  let real;
  try {
    real = realpathSync(path);
  } catch {
    real = resolve(path);
  }
  const rel = relative(realpathSync(REPO), real);
  return rel.startsWith("..") || isAbsolute(rel);
}

/** Reads a snapshot and returns its entries, hash and size, limited to a pilot slice or selection. */
export function readSnapshot(provider, file, letters, idsFile) {
  if (!PARSERS[provider]) fail(`Unknown provider ${provider}. Known: ${Object.keys(PARSERS).join(", ")}`);
  if (!outsideRepo(file)) fail("Snapshots must be kept outside the repository.");
  const buffer = readFileSync(file);
  let entries = PARSERS[provider](buffer.toString("utf8"));
  const total = entries.length;
  if (letters) entries = pilotSlice(entries, letters);
  let slice = letters ? `letters:${letters}` : null;
  if (idsFile) {
    if (!outsideRepo(idsFile)) fail("Pilot selections must be kept outside the repository.");
    const raw = readFileSync(idsFile);
    const selection = JSON.parse(raw.toString("utf8"));
    const wanted = new Set(provider === "wikidata" ? selection.games : selection.releases);
    entries = entries.filter((e) => wanted.has(e.external_id));
    slice = `ids:${sha256(raw)}`;
  }
  return { entries, total, slice, sha256: sha256(buffer), name: file.split(/[\\/]/).pop(), mtime: statSync(file).mtime };
}

/** Connects as catalog_importer, and refuses any other or more powerful role. */
export async function connect() {
  const url = process.env.CATALOG_IMPORTER_DATABASE_URL;
  if (!url) fail("Set CATALOG_IMPORTER_DATABASE_URL to a catalog_importer connection.");
  let user;
  try {
    user = decodeURIComponent(new URL(url).username);
  } catch {
    fail("CATALOG_IMPORTER_DATABASE_URL isn't a valid URL.");
  }
  if (user !== "catalog_importer") fail("The import tool connects only as catalog_importer, never as postgres or another role.");
  const client = new pg.Client({ connectionString: url, application_name: "catalog-import" });
  try {
    await client.connect();
  } catch (error) {
    fail(`Could not connect as catalog_importer: ${error.code ?? error.message}`);
  }
  const { rows } = await client.query(`select current_user as name, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolinherit,
      (select count(*) from pg_auth_members m where m.member = r.oid)::int as memberships
    from pg_roles r where r.rolname = current_user`);
  const role = rows[0];
  if (!role || role.name !== "catalog_importer" || role.rolsuper || role.rolbypassrls || role.rolcreaterole || role.rolinherit || role.memberships) {
    await client.end();
    fail("Refusing to run: the connection isn't the restricted catalog_importer role.");
  }
  return client;
}

async function stageAll(client, run, lease, entries, from, slice) {
  for (let i = from; i < entries.length; i += STAGE_BATCH) {
    const batch = entries.slice(i, i + STAGE_BATCH);
    const next = Math.min(i + STAGE_BATCH, entries.length);
    await client.query("select catalog_import.stage_records($1, $2, $3, $4)", [run, lease, JSON.stringify(batch), JSON.stringify({ phase: "stage", staged: next, slice })]);
    process.stdout.write(`\rstaged ${next} of ${entries.length}`);
  }
  process.stdout.write("\n");
}

async function applyAll(client, run, lease, after, slice) {
  const outcomes = {};
  let position = after;
  for (;;) {
    const { rows } = await client.query("select record_position, provider_record_id from catalog_import.pending_records($1, $2, $3, 200)", [run, lease, position]);
    if (!rows.length) break;
    for (const row of rows) {
      const checkpoint = JSON.stringify({ phase: "apply", position: row.record_position, slice });
      let outcome;
      try {
        const result = await client.query("select catalog_import.apply_record($1, $2, $3, $4) as r", [run, lease, row.provider_record_id, checkpoint]);
        outcome = result.rows[0].r.outcome;
      } catch (error) {
        if (["run in use", "run unavailable", "provider not cleared", "terms not cleared"].includes(error.message)) throw error;
        await client.query("select catalog_import.mark_record_failed($1, $2, $3, $4)", [run, lease, row.provider_record_id, error.message]);
        outcome = "failed";
      }
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
      position = row.record_position;
    }
    process.stdout.write(`\rapplied through entry ${position + 1}`);
  }
  process.stdout.write("\n");
  return outcomes;
}

async function report(client, run) {
  const { rows } = await client.query("select catalog_import.run_report($1) as r", [run]);
  if (!rows[0].r) fail("No such run.");
  return rows[0].r;
}

async function cmdImport(o) {
  for (const k of ["provider", "platform", "file", "terms-file", "reason"]) if (!o[k] || o[k] === true) fail(`--${k} is required.`);
  const snap = readSnapshot(o.provider, o.file, o.letters, o.ids);
  console.log(`${snap.name}: ${snap.total} entries, ${snap.entries.length} in this import, sha256 ${snap.sha256}`);
  if (o["dry-run"]) {
    const ignored = snap.entries.filter((e) => e.ignore_reason).length;
    console.log(JSON.stringify({ entries: snap.entries.length, ignored, sample: snap.entries.slice(0, 3) }, null, 2));
    return;
  }
  const terms = sha256(readFileSync(o["terms-file"]));
  const client = await connect();
  const lease = randomUUID();
  try {
    const fetchedAt = o["fetched-at"] && o["fetched-at"] !== true ? new Date(o["fetched-at"]) : snap.mtime;
    const { rows } = await client.query("select catalog_import.start_run($1, $2, $3, $4, $5, $6, $7, $8) as id",
      [o.provider, o.platform, snap.name, snap.sha256, fetchedAt, terms, o.reason, lease]);
    const run = rows[0].id;
    console.log(`run ${run} started. If it stops, resume it with: resume --run ${run}`);
    await stageAll(client, run, lease, snap.entries, 0, snap.slice);
    const outcomes = await applyAll(client, run, lease, -1, snap.slice);
    await client.query("select catalog_import.finish_run($1, $2, 'completed')", [run, lease]);
    console.log(JSON.stringify({ outcomes, report: await report(client, run) }, null, 2));
  } finally {
    await client.end();
  }
}

async function cmdResume(o) {
  for (const k of ["run", "provider", "file"]) if (!o[k] || o[k] === true) fail(`--${k} is required.`);
  const snap = readSnapshot(o.provider, o.file, o.letters, o.ids);
  const client = await connect();
  const lease = randomUUID();
  try {
    const { rows } = await client.query("select catalog_import.claim_run($1, $2, $3) as c", [o.run, lease, snap.sha256]);
    const checkpoint = rows[0].c ?? {};
    if (checkpoint.phase && (checkpoint.slice ?? null) !== snap.slice) fail(`This run imports the slice ${checkpoint.slice ?? "(all)"}. Resume it with the same --letters or --ids.`);
    console.log(`run ${o.run} resumed at ${JSON.stringify(checkpoint)}`);
    if (checkpoint.phase !== "apply") await stageAll(client, o.run, lease, snap.entries, Number(checkpoint.staged ?? 0), snap.slice);
    const outcomes = await applyAll(client, o.run, lease, checkpoint.phase === "apply" ? Number(checkpoint.position) : -1, snap.slice);
    await client.query("select catalog_import.finish_run($1, $2, 'completed')", [o.run, lease]);
    console.log(JSON.stringify({ outcomes, report: await report(client, o.run) }, null, 2));
  } finally {
    await client.end();
  }
}

async function cmdReport(o) {
  if (!o.run || o.run === true) fail("--run is required.");
  const client = await connect();
  try {
    console.log(JSON.stringify(await report(client, o.run), null, 2));
  } finally {
    await client.end();
  }
}

async function cmdSelectPilot(o) {
  for (const k of ["wikidata", "no-intro", "out"]) if (!o[k] || o[k] === true) fail(`--${k} is required.`);
  if (!outsideRepo(o.out)) fail("Pilot selections must be kept outside the repository.");
  const games = readSnapshot("wikidata", o.wikidata);
  const releases = readSnapshot("no-intro", o["no-intro"]);
  if (o.reuse && o.reuse !== true) {
    // The same release entries as an earlier selection, which is left unchanged.
    const raw = readFileSync(o.reuse);
    const extended = extendSelection(JSON.parse(raw.toString("utf8")), games.entries, releases.entries);
    const out = { ...extended, derived_from: { file: o.reuse.split(/[\\/]/).pop(), sha256: sha256(raw) },
      sources: { wikidata: { file: games.name, sha256: games.sha256 }, "no-intro": { file: releases.name, sha256: releases.sha256 } } };
    writeFileSync(o.out, `${JSON.stringify(out, null, 2)}
`);
    console.log(JSON.stringify({ out: o.out, games: extended.games.length, releases: extended.releases.length, added: { matched: extended.added.matched.length, suggested: extended.added.suggested.length }, sha256: sha256(readFileSync(o.out)) }));
    return;
  }
  const selection = pilotSelection(games.entries, releases.entries, {
    seed: typeof o.seed === "string" ? o.seed : undefined,
    maxGames: o.games ? Number(o.games) : undefined,
    maxReleases: o.releases ? Number(o.releases) : undefined,
    selectorVersion: o["selector-version"] ? Number(o["selector-version"]) : undefined,
  });
  const out = { ...selection, sources: { wikidata: { file: games.name, sha256: games.sha256 }, "no-intro": { file: releases.name, sha256: releases.sha256 } } };
  writeFileSync(o.out, `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify({ out: o.out, ...selection.stats, sha256: sha256(readFileSync(o.out)) }));
}

async function cmdFetchWikidata(o) {
  if (!o.platform || !o.out || o.out === true) fail("--platform and --out are required.");
  const agent = process.env.WIKIDATA_USER_AGENT;
  if (!agent) fail("Set WIKIDATA_USER_AGENT to a tool name and operator contact, as Wikimedia's policy requires.");
  if (!outsideRepo(o.out)) fail("Snapshots must be kept outside the repository.");
  const response = await fetch("https://query.wikidata.org/sparql", {
    method: "POST",
    headers: { "User-Agent": agent, Accept: "application/sparql-results+json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ query: wikidataQuery(o.platform) }),
  });
  if (!response.ok) fail(`Wikidata answered ${response.status}.`);
  const text = await response.text();
  const entries = parseWikidata(text);
  mkdirSync(o.out, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(o.out, `wikidata-${o.platform}-${stamp}.json`);
  writeFileSync(file, text);
  console.log(`${file}: ${entries.length} items, sha256 ${sha256(Buffer.from(text))}`);
}

async function main() {
  const o = args(process.argv.slice(2));
  const commands = { import: cmdImport, resume: cmdResume, report: cmdReport, "fetch-wikidata": cmdFetchWikidata, "select-pilot": cmdSelectPilot };
  const command = commands[o._[0]];
  if (!command) fail("Usage: node scripts/catalog-import.mjs fetch-wikidata|select-pilot|import|resume|report [options]. See the header of this file.");
  try {
    await command(o);
  } catch (error) {
    fail(`Stopped: ${error.message}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
