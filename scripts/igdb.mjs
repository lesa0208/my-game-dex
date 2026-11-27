/**
 * IGDB enrichment (M18a): IGDB metadata and artwork for existing game identities, through the
 * catalog's import system. It never creates, merges, verifies or publishes a game, and never
 * writes a game's own fields: IGDB's answers are source claims attached to an identity.
 *
 *   node scripts/igdb.mjs check [--live]
 *        Whether the credentials are configured (never their values); --live also gets a token
 *        and asks IGDB one question.
 *   node scripts/igdb.mjs platforms
 *        Checks the platform map (scripts/lib/igdb-match.mjs) against IGDB's own names.
 *   MGD_STACK=demo node scripts/igdb.mjs clear --basis-file <file> --note "<basis>" [--media --media-note "<scope>"]
 *        Operator step: records IGDB's clearance against the saved basis (its hash), and, with
 *        --media, that its images may be shown. Local demo, scratch or test stacks only.
 *   MGD_STACK=demo node scripts/igdb.mjs withdraw --note "<why>" [--media-only]
 *        Operator step: withdraws IGDB's media (and, without --media-only, its clearance), then
 *        removes the image optimizer's stored copies (.next/cache/images, .next-demo/cache/images).
 *        The app stops showing IGDB data and images from the next request: its read and its image
 *        route ask the database every time. Also: purge-image-cache, the second step alone.
 *   MGD_STACK=demo node scripts/igdb.mjs enrich --batch m18a-first-20 | --games <slug,slug>
 *        --basis-file <same file> --reason "<why>" [--out <dir>] [--snapshot <igdb.json>] [--dry-run]
 *        Reads the games (catalog_importer), fetches their IGDB candidates (or reuses a snapshot),
 *        decides each match, writes the report, then stages every record and attaches the matched.
 *   MGD_STACK=demo node scripts/igdb.mjs resume --run <id> --out <dir> --basis-file <same file>
 *   MGD_STACK=demo node scripts/igdb.mjs report --run <id>
 *
 * The database: CATALOG_IMPORTER_DATABASE_URL (as catalog_importer only), or on a local demo,
 * scratch or test stack a one-off catalog_importer password enabled for the command and
 * disabled after it. Never the pilot, B1, rehearsal or development stack.
 * Credentials: scripts/lib/igdb-config.mjs (outside the repository; never printed).
 * IGDB's answers stay outside the repository (default ~/.my-game-dex/igdb/<date>-<batch>/): the
 * repository is public, and IGDB content isn't ours to publish there.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { outsideRepo } from "./catalog-import.mjs";
import { apicalypseString, createIgdbClient, IgdbError } from "./lib/igdb-client.mjs";
import { describeIgdbConfig, loadIgdbCredentials } from "./lib/igdb-config.mjs";
import { decide, GAME_FIELDS, PLATFORM_IDS, PLATFORM_NAMES, toPayload } from "./lib/igdb-match.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROVIDER = "igdb";
const TERMS_URL = "https://api-docs.igdb.com/";
const LOCAL_STACKS = new Set(["demo", "scratch", "test"]);

/** The first batch (M18a): the ten the product owner named, then ten across the other platforms. */
export const BATCHES = {
  "m18a-first-20": [
    "super-mario-world", "chrono-trigger", "sonic-the-hedgehog", "crash-bandicoot", "the-legend-of-zelda-ocarina-of-time",
    "super-mario-bros-3", "pokemon-emerald", "mega-man-x", "castlevania-symphony-of-the-night", "donkey-kong-country",
    "the-legend-of-zelda", "super-metroid", "streets-of-rage-2", "tetris", "kirby-s-dream-land",
    "metroid-fusion", "super-mario-64", "final-fantasy-vii", "shadow-of-the-colossus", "final-fantasy-x",
  ],
};

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
const fail = (message, code = 2) => {
  console.error(message);
  process.exit(code);
};
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const need = (o, keys) => keys.forEach((k) => (!o[k] || o[k] === true) && fail(`--${k} is required.`));

function credentialsOrFail() {
  const config = loadIgdbCredentials();
  if (!config.ok) fail(describeIgdbConfig(config));
  return config;
}

function client(config) {
  return createIgdbClient({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    apiUrl: process.env.MGD_IGDB_API_URL || undefined,
    tokenUrl: process.env.MGD_IGDB_TOKEN_URL || undefined,
  });
}

// ---- the database --------------------------------------------------------------

async function localStack() {
  const name = process.env.MGD_STACK ?? "dev";
  if (!LOCAL_STACKS.has(name)) fail(`Refusing: without CATALOG_IMPORTER_DATABASE_URL this runs only on a local demo, scratch or test stack (MGD_STACK is ${name}).`);
  const stack = await import("./lib/stack.mjs");
  const status = stack.stackStatus({ label: "IGDB enrichment" });
  return { name, container: stack.dbContainer, dbPort: Number(new URL(status.API_URL).port) + 1, projectId: stack.projectId };
}

const psql = (container, sql) =>
  execFileSync("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-At"], {
    input: sql,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, MSYS_NO_PATHCONV: "1" },
  }).trim();
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** Runs fn with a catalog_importer client: the given URL, or a one-off password on a local stack. */
async function withImporter(fn) {
  let url = process.env.CATALOG_IMPORTER_DATABASE_URL;
  let disable = null;
  if (!url) {
    const { dbPort } = await localStack();
    const password = randomBytes(24).toString("base64url");
    const env = { ...process.env, CATALOG_IMPORTER_PASSWORD: password, MSYS_NO_PATHCONV: "1" };
    const role = (command) => execFileSync(process.execPath, [join(ROOT, "scripts", "catalog-import-role.mjs"), command], { env, stdio: ["ignore", "ignore", "inherit"] });
    role("enable");
    disable = () => role("disable");
    url = `postgresql://catalog_importer:${encodeURIComponent(password)}@127.0.0.1:${dbPort}/postgres`;
  }
  try {
    if (decodeURIComponent(new URL(url).username) !== "catalog_importer") fail("The IGDB tool connects only as catalog_importer.");
    const db = new pg.Client({ connectionString: url, application_name: "igdb-enrich" });
    await db.connect();
    try {
      const { rows } = await db.query("select current_user as name, r.rolsuper, r.rolbypassrls from pg_roles r where r.rolname = current_user");
      if (rows[0]?.name !== "catalog_importer" || rows[0].rolsuper || rows[0].rolbypassrls) fail("Refusing: the connection isn't the restricted catalog_importer role.");
      return await fn(db);
    } finally {
      await db.end();
    }
  } finally {
    disable?.();
  }
}

// ---- IGDB ------------------------------------------------------------------------

/** IGDB's games for these slugs, 20 slugs a request. */
async function gamesBySlug(igdb, slugs) {
  const out = [];
  const unique = [...new Set(slugs)];
  for (let i = 0; i < unique.length; i += 20) {
    const part = unique.slice(i, i + 20);
    out.push(...(await igdb.query("games", `fields ${GAME_FIELDS}; where slug = (${part.map(apicalypseString).join(",")}); limit 50;`)));
  }
  return out;
}

/** For a game Wikidata gives no IGDB id: IGDB's search, on its platforms, for the review list only. */
async function searchFor(igdb, game) {
  const ids = (game.platforms ?? []).map((s) => PLATFORM_IDS[s]).filter(Boolean);
  const where = ids.length ? ` where platforms = (${ids.join(",")});` : "";
  return igdb.query("games", `search ${apicalypseString(game.title)}; fields ${GAME_FIELDS};${where} limit 10;`);
}

async function checkPlatforms(igdb) {
  const ids = Object.values(PLATFORM_IDS);
  const rows = await igdb.query("platforms", `fields id,name,slug,abbreviation; where id = (${ids.join(",")}); limit 50;`);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return Object.entries(PLATFORM_IDS).map(([slug, id]) => ({ slug, id, expected: PLATFORM_NAMES[id], igdb: byId.get(id)?.name ?? null, ok: byId.get(id)?.name === PLATFORM_NAMES[id] }));
}

// ---- commands --------------------------------------------------------------------

async function cmdCheck(o) {
  const config = loadIgdbCredentials();
  console.log(describeIgdbConfig(config));
  if (!config.ok) process.exit(1);
  if (o.live) {
    const igdb = client(config);
    await igdb.accessToken();
    const count = await igdb.query("platforms/count", "where id = (19);");
    console.log(`live: a token was issued, and IGDB answered (${JSON.stringify(count)}). Requests: ${igdb.stats.requests}.`);
  }
}

async function cmdPlatforms() {
  const igdb = client(credentialsOrFail());
  const rows = await checkPlatforms(igdb);
  for (const r of rows) console.log(`${r.ok ? "ok  " : "DIFF"} ${r.slug.padEnd(18)} IGDB ${String(r.id).padEnd(3)} ${r.igdb ?? "(not found)"}${r.ok ? "" : ` (expected ${r.expected})`}`);
  if (rows.some((r) => !r.ok)) process.exit(1);
}

/**
 * The image optimizer's stored copies, in every build folder of this checkout. Before the M18a
 * security fix the optimizer fetched IGDB images and kept them for hours; it may no longer fetch
 * them, and this removes what it kept. Its other entries (the app's own images) are rebuilt on use.
 */
function purgeImageCaches() {
  const removed = [];
  for (const dist of [".next", ".next-demo", ".next-pilot"]) {
    const dir = join(ROOT, dist, "cache", "images");
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    }
  }
  return removed;
}

async function cmdPurgeImageCache() {
  const removed = purgeImageCaches();
  console.log(removed.length ? `removed: ${removed.join(", ")}` : "no stored optimizer images to remove");
}

async function cmdWithdraw(o) {
  need(o, ["note"]);
  if (process.env.CATALOG_IMPORTER_DATABASE_URL) fail("withdraw is an operator step on a local stack, in SQL; it doesn't use the importer.");
  const { container, name } = await localStack();
  const note = lit(`${name} stack (M18a): ${o.note}`);
  psql(container, `select private.record_provider_media(${lit(PROVIDER)}, false, ${note});`);
  console.log(`igdb media withdrawn on the ${name} stack`);
  if (!o["media-only"]) {
    psql(container, `select private.record_provider_clearance(p.code, false, p.terms_url, p.terms_sha256, ${note}) from private.external_providers p where p.code = ${lit(PROVIDER)};`);
    console.log(`igdb clearance withdrawn on the ${name} stack`);
  }
  await cmdPurgeImageCache();
}

async function cmdClear(o) {
  need(o, ["basis-file", "note"]);
  if (process.env.CATALOG_IMPORTER_DATABASE_URL) fail("clear is an operator step on a local stack, in SQL; it doesn't use the importer.");
  const { container, name } = await localStack();
  if (!outsideRepo(o["basis-file"])) fail("The basis file stays outside the repository.");
  const hash = sha256(readFileSync(o["basis-file"]));
  psql(container, `select private.record_provider_clearance(${lit(PROVIDER)}, true, ${lit(TERMS_URL)}, ${lit(hash)}, ${lit(`${name} stack (M18a): ${o.note}`)});`);
  console.log(`igdb cleared on the ${name} stack against basis sha256 ${hash}`);
  if (o.media) {
    need(o, ["media-note"]);
    psql(container, `select private.record_provider_media(${lit(PROVIDER)}, true, ${lit(`${name} stack (M18a): ${o["media-note"]}`)});`);
    console.log("igdb media may be shown on this stack");
  }
}

function outDir(o, batch) {
  const dir = o.out && o.out !== true ? resolve(o.out) : join(homedir(), ".my-game-dex", "igdb", `${new Date().toISOString().slice(0, 10)}-${batch}`);
  if (!outsideRepo(dir)) fail("IGDB's answers stay outside the repository.");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function chosenSlugs(o) {
  if (o.batch && o.batch !== true) {
    const slugs = BATCHES[o.batch];
    if (!slugs) fail(`Unknown batch. Known: ${Object.keys(BATCHES).join(", ")}`);
    return { batch: o.batch, slugs };
  }
  if (o.games && o.games !== true) return { batch: "selection", slugs: String(o.games).split(",").map((s) => s.trim()).filter(Boolean) };
  return fail("--batch or --games is required.");
}

/** Our games, the IGDB snapshot, and each decision. Writes candidates.json, igdb.json, decisions.json and report.md. */
async function prepare(db, o, dir, slugs) {
  const { rows } = await db.query("select catalog_import.enrichment_candidates($1, $2) as c", [PROVIDER, slugs]);
  const games = rows[0].c;
  writeFileSync(join(dir, "candidates.json"), JSON.stringify({ read_at: new Date().toISOString(), requested: slugs, games }, null, 2));
  const missing = slugs.filter((s) => !games.some((g) => g.slug === s));

  let snapshot;
  const snapshotFile = o.snapshot && o.snapshot !== true ? resolve(o.snapshot) : join(dir, "igdb.json");
  if (existsSync(snapshotFile) && (o.snapshot || o.resume)) {
    snapshot = JSON.parse(readFileSync(snapshotFile, "utf8"));
    console.log(`IGDB snapshot reused: ${snapshotFile}`);
  } else {
    const igdb = client(credentialsOrFail());
    const platforms = await checkPlatforms(igdb);
    if (platforms.some((p) => !p.ok)) fail(`The platform map doesn't match IGDB: ${JSON.stringify(platforms.filter((p) => !p.ok))}`);
    const anchored = await gamesBySlug(igdb, games.flatMap((g) => g.wikidata_igdb ?? []));
    const searched = {};
    for (const g of games.filter((g) => !(g.wikidata_igdb ?? []).length)) searched[g.slug] = await searchFor(igdb, g);
    snapshot = { fetched_at: new Date().toISOString(), source: "IGDB API v4", platforms, anchored, searched, stats: igdb.stats };
    writeFileSync(snapshotFile, JSON.stringify(snapshot, null, 2));
  }
  const decisions = games.map((g) => {
    const records = [...snapshot.anchored.filter((r) => (g.wikidata_igdb ?? []).includes(r.slug)), ...(snapshot.searched?.[g.slug] ?? [])];
    return { ...decide(g, records), game_id: g.id };
  });
  writeFileSync(join(dir, "decisions.json"), JSON.stringify({ decided_at: new Date().toISOString(), missing, decisions }, null, 2));
  writeFileSync(join(dir, "report.md"), reportMarkdown(snapshot, games, decisions, missing));
  return { snapshot, snapshotFile, games, decisions, missing };
}

/** What the run stages: the matched record plainly; every other anchored candidate held, with why. */
function stagingEntries(snapshot, decisions) {
  const byId = new Map([...snapshot.anchored, ...Object.values(snapshot.searched ?? {}).flat()].map((r) => [String(r.id), r]));
  const entries = [];
  for (const d of decisions) {
    for (const c of d.candidates) {
      const record = byId.get(c.igdb_id);
      if (!record) continue;
      const payload = toPayload(record, snapshot.fetched_at);
      if (d.decision === "matched" && c.igdb_id === d.igdb_id) entries.push({ entity_type: "game", external_id: c.igdb_id, payload });
      else if (c.checks.anchor || d.suggestion === c.igdb_id) {
        const why = d.decision === "matched" ? `another anchor of ${d.game}` : `${d.game}: ${d.reasons.join("; ")}`;
        entries.push({ entity_type: "game", external_id: c.igdb_id, payload, review_reason: `IGDB match needs review: ${why}`.slice(0, 200) });
      }
    }
  }
  return entries;
}

async function stageAndAttach(db, run, lease, snapshot, decisions) {
  const entries = stagingEntries(snapshot, decisions);
  for (let i = 0; i < entries.length; i += 100) {
    await db.query("select catalog_import.stage_records($1, $2, $3, $4)", [run, lease, JSON.stringify(entries.slice(i, i + 100)), JSON.stringify({ phase: "stage", staged: Math.min(i + 100, entries.length) })]);
  }
  console.log(`staged ${entries.length} IGDB records (${entries.filter((e) => e.review_reason).length} held for review)`);
  const outcomes = {};
  for (const d of decisions.filter((d) => d.decision === "matched")) {
    try {
      const { rows } = await db.query("select catalog_import.attach_game_record($1, $2, $3, $4, $5, $6, $7) as r", [
        run, lease, d.igdb_id, d.game_id, d.tier, JSON.stringify(d.notes), JSON.stringify({ phase: "attach", game: d.game }),
      ]);
      const outcome = rows[0].r.outcome;
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
      d.outcome = outcome;
    } catch (error) {
      if (["run in use", "run unavailable", "provider not cleared", "terms not cleared"].includes(error.message)) throw error;
      outcomes.refused = (outcomes.refused ?? 0) + 1;
      d.outcome = `refused: ${error.message}`;
    }
  }
  return outcomes;
}

async function cmdEnrich(o) {
  const { batch, slugs } = chosenSlugs(o);
  if (!o["dry-run"]) need(o, ["basis-file", "reason"]);
  const dir = outDir(o, batch);
  await withImporter(async (db) => {
    const { snapshot, snapshotFile, decisions, missing } = await prepare(db, o, dir, slugs);
    summarize(decisions, missing);
    console.log(`report: ${join(dir, "report.md")}`);
    if (o["dry-run"]) return;
    const terms = sha256(readFileSync(o["basis-file"]));
    const lease = randomUUID();
    const source = readFileSync(snapshotFile);
    const { rows } = await db.query("select catalog_import.start_enrichment_run($1, $2, $3, $4, $5, $6, $7) as id", [
      PROVIDER, `IGDB API v4 · ${batch}`, sha256(source), new Date(snapshot.fetched_at), terms, o.reason, lease,
    ]);
    const run = rows[0].id;
    console.log(`run ${run} started. If it stops: node scripts/igdb.mjs resume --run ${run} --out ${dir} --basis-file <same file>`);
    const outcomes = await stageAndAttach(db, run, lease, snapshot, decisions);
    await db.query("select catalog_import.finish_run($1, $2, 'completed')", [run, lease]);
    writeFileSync(join(dir, "decisions.json"), JSON.stringify({ run, decided_at: new Date().toISOString(), missing, decisions }, null, 2));
    writeFileSync(join(dir, "report.md"), reportMarkdown(snapshot, null, decisions, missing, run));
    console.log(JSON.stringify({ run, outcomes }, null, 2));
  });
}

async function cmdResume(o) {
  need(o, ["run", "out"]);
  const dir = resolve(o.out);
  const snapshotFile = join(dir, "igdb.json");
  if (!existsSync(snapshotFile)) fail("No igdb.json in --out.");
  const source = readFileSync(snapshotFile);
  const snapshot = JSON.parse(source);
  const { decisions } = JSON.parse(readFileSync(join(dir, "decisions.json"), "utf8"));
  await withImporter(async (db) => {
    const lease = randomUUID();
    const { rows } = await db.query("select catalog_import.claim_run($1, $2, $3) as c", [o.run, lease, sha256(source)]);
    console.log(`run ${o.run} resumed at ${JSON.stringify(rows[0].c ?? {})}`);
    // Staging again is idempotent (the same records are "unchanged"); attached ones are skipped.
    const outcomes = await stageAndAttach(db, o.run, lease, snapshot, decisions);
    await db.query("select catalog_import.finish_run($1, $2, 'completed')", [o.run, lease]);
    console.log(JSON.stringify({ run: o.run, outcomes }, null, 2));
  });
}

async function cmdReport(o) {
  need(o, ["run"]);
  await withImporter(async (db) => {
    const { rows } = await db.query("select catalog_import.run_report($1) as r", [o.run]);
    console.log(JSON.stringify(rows[0].r, null, 2));
  });
}

// ---- reporting -------------------------------------------------------------------

function summarize(decisions, missing) {
  const count = (d) => decisions.filter((x) => x.decision === d).length;
  console.log(`decisions: ${count("matched")} matched, ${count("review")} for review, ${count("none")} without a candidate; ${missing.length} not in the catalog`);
}

function coverage(payload) {
  if (!payload) return "";
  const has = (k) => (Array.isArray(payload[k]) ? payload[k].length > 0 : Boolean(payload[k]));
  return ["summary", "genres", "themes", "developers", "publishers", "first_release_date", "cover"].filter(has).join(", ") || "nothing";
}

export function reportMarkdown(snapshot, _games, decisions, missing, run = null) {
  const byId = new Map([...snapshot.anchored, ...Object.values(snapshot.searched ?? {}).flat()].map((r) => [String(r.id), r]));
  const lines = [
    `# IGDB enrichment report${run ? ` (run ${run})` : " (dry run)"}`,
    "",
    `IGDB answers fetched ${snapshot.fetched_at} (${snapshot.source}). Kept outside the repository.`,
    "",
    "| Game | Decision | IGDB match | Confidence | Coverage | Images | Notes |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const d of decisions) {
    const id = d.igdb_id ?? d.suggestion ?? null;
    const record = id ? byId.get(id) : null;
    const payload = record ? toPayload(record, snapshot.fetched_at) : null;
    const images = payload ? `${payload.cover ? "cover" : "no cover"}, ${payload.screenshots.length} screenshots, ${payload.artworks.length} artworks` : "";
    const notes = [
      ...d.reasons,
      ...(d.notes?.platforms_not_on_igdb ? [`our platforms IGDB doesn't list: ${d.notes.platforms_not_on_igdb.join(", ")}`] : []),
      ...(d.notes?.other_anchors ? d.notes.other_anchors.map((a) => `other anchor ${a.slug}: ${a.why_not.join(", ")}`) : []),
      ...(d.notes?.igdb_first_release ? [`IGDB first release ${d.notes.igdb_first_release}`] : []),
      ...(d.outcome ? [`outcome: ${d.outcome}`] : []),
    ].join("; ");
    lines.push(`| ${d.title} | ${d.decision} | ${record ? `[${record.name}](https://www.igdb.com/games/${record.slug}) (${id}, ${d.candidates.find((c) => c.igdb_id === id)?.type ?? "?"})` : "-"} | ${d.confidence} | ${coverage(payload)} | ${images} | ${notes.replace(/\|/g, "/")} |`);
  }
  if (missing.length) lines.push("", `Not in the catalog (not created): ${missing.join(", ")}`);
  return `${lines.join("\n")}\n`;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const o = args(rest);
  const commands = { check: cmdCheck, platforms: cmdPlatforms, clear: cmdClear, withdraw: cmdWithdraw, "purge-image-cache": cmdPurgeImageCache, enrich: cmdEnrich, resume: cmdResume, report: cmdReport };
  if (!commands[command]) fail("Usage: node scripts/igdb.mjs check|platforms|clear|withdraw|purge-image-cache|enrich|resume|report [options]. See the header of this file.");
  try {
    await commands[command](o);
  } catch (error) {
    if (error instanceof IgdbError) fail(`IGDB: ${error.message}`, 1);
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
