/**
 * M12c-B1 checkpoint one: acquisition tooling for the SNES identity pilot. Nothing here
 * writes to any database, and nothing is imported or published.
 *
 *   node scripts/catalog-b1.mjs select --wikidata <query snapshot> --out <selection.json>
 *        [--platform snes] [--seed mgd-m12c-b1-snes-1] [--size 150] [--fixed Q853143,Q370055]
 *   MGD_STACK=<stack> node scripts/catalog-b1.mjs export-catalog --out <catalog.json>
 *   node scripts/catalog-b1.mjs dry-run --selection <selection.json> --wikidata <query snapshot>
 *        [--entities <entity snapshot>] [--catalog <catalog.json>] [--review <notes.json>] [--platform snes] --out <dir>
 *   WIKIDATA_USER_AGENT=... node scripts/catalog-b1.mjs fetch-formats --entities <entity snapshot> --out <dir>
 *   WIKIDATA_USER_AGENT="<tool>/<version> (<project contact>) <library>/<version>" \
 *     node scripts/catalog-b1.mjs fetch-entities --selection <selection.json> --out <dir>
 *
 * - select: the deterministic 150-game selection from a saved query snapshot (the one the
 *   importer fetched), written outside the repository with the snapshot's hash.
 * - export-catalog: the selected stack's game identifiers (titles, aliases, platforms,
 *   Wikidata ids), read only. Refuses the development stack while it's protected.
 * - dry-run: what an import of the selection would do (create, match, hold as a possible
 *   duplicate, or ignore) with every flag, as JSON and Markdown. Uses the entity snapshot
 *   when given; without it, the query snapshot's fields, flagged "entity_detail_pending".
 * - fetch-entities: the live Wikimedia request for the selection's entity records, 50 ids per
 *   request (wbgetentities: labels, aliases and claims only, in the languages the parser reads). It refuses to run unless
 *   WIKIDATA_USER_AGENT names a tool and a project contact (an email address or a URL), as
 *   the Wikimedia User-Agent policy requires. Nobody invents that contact (M12c-B1, D-7).
 *   Rate limits: one request at a time, at least 1 s apart, maxlag=5; on HTTP 429 or 503, or a
 *   maxlag error, it waits for Retry-After (or 2, 4, 8, 16 s), up to 5 attempts, then stops
 *   without writing a partial snapshot.
 *
 * Snapshots, selections and reports stay outside the repository.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { WIKIDATA_PLATFORMS, parseWikidata } from "./catalog-import-sources.mjs";
import { FLAGS, b1Selection, distributionFormatIds, dryRun, parseWikidataEntities } from "./wikidata-entities.mjs";

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
const fail = (message) => {
  console.error(message);
  process.exit(2);
};

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    else out._.push(argv[i]);
  }
  return out;
}

async function outsideRepo(path) {
  const { outsideRepo: check } = await import("./catalog-import.mjs");
  return check(path);
}

function platformQid(slug = "snes") {
  const qid = WIKIDATA_PLATFORMS[slug];
  if (!qid) fail(`No Wikidata item for platform ${slug}. Known: ${Object.keys(WIKIDATA_PLATFORMS).join(", ")}`);
  return qid;
}

// ---------------------------------------------------------------------------
// select
// ---------------------------------------------------------------------------

async function select(o) {
  for (const k of ["wikidata", "out"]) if (!o[k] || o[k] === true) fail(`--${k} is required.`);
  if (!(await outsideRepo(o.out))) fail("Selections must be kept outside the repository.");
  const raw = readFileSync(o.wikidata);
  const selection = b1Selection(parseWikidata(raw.toString("utf8")), {
    seed: typeof o.seed === "string" ? o.seed : undefined,
    size: o.size ? Number(o.size) : undefined,
    fixed: typeof o.fixed === "string" ? o.fixed.split(",").map((s) => s.trim()).filter(Boolean) : [],
  });
  const out = { ...selection, platform: o.platform ?? "snes", snapshot: { file: o.wikidata.split(/[\\/]/).pop(), sha256: sha256(raw) } };
  mkdirSync(dirname(o.out), { recursive: true });
  writeFileSync(o.out, `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify({ out: o.out, ids: out.ids.length, strata: Object.fromEntries(Object.entries(out.strata).map(([k, v]) => [k, v.length])), sha256: sha256(readFileSync(o.out)) }));
}

// ---------------------------------------------------------------------------
// export-catalog (read only)
// ---------------------------------------------------------------------------

async function exportCatalog(o) {
  if (!o.out || o.out === true) fail("--out is required.");
  if (!(await outsideRepo(o.out))) fail("Exports must be kept outside the repository.");
  const { dbContainer, stackName, stackStatus } = await import("./lib/stack.mjs");
  stackStatus({ label: "the catalog identifier export" });
  const sql = `select coalesce(json_agg(json_build_object(
      'id', g.id, 'title', g.title, 'status', g.status,
      'platforms', coalesce((select json_agg(p.slug order by p.slug) from public.game_platforms gp join public.platforms p on p.id = gp.platform_id where gp.game_id = g.id), '[]'),
      'titles', coalesce((select json_agg(a.title order by a.title) from public.game_aliases a where a.game_id = g.id), '[]'),
      'wikidata', coalesce((select json_agg(x.external_id order by x.external_id) from private.external_references x where x.game_id = g.id and x.provider_code = 'wikidata'), '[]')
    ) order by g.id), '[]') from public.games g where g.merged_into_id is null;`;
  // A read-only transaction: the export can't change anything.
  const out = execFileSync("docker", ["exec", "-i", dbContainer, "psql", "-U", "postgres", "-d", "postgres", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1"], {
    input: `begin transaction read only;\n${sql}\nrollback;\n`,
    encoding: "utf8",
    env: { ...process.env, MSYS_NO_PATHCONV: "1" },
  }).trim();
  const games = JSON.parse(out.split("\n").filter((l) => l.startsWith("[")).pop() ?? "[]");
  const file = { format: "mgd-catalog-identifiers", stack: stackName, exported_at: new Date().toISOString(), games };
  mkdirSync(dirname(o.out), { recursive: true });
  writeFileSync(o.out, `${JSON.stringify(file, null, 2)}\n`);
  console.log(JSON.stringify({ out: o.out, stack: stackName, games: games.length, sha256: sha256(readFileSync(o.out)) }));
}

// ---------------------------------------------------------------------------
// dry-run
// ---------------------------------------------------------------------------

export function dryRunFiles({ selectionText, wikidataText, entitiesText = null, catalogText = null, reviewText = null, platform = "snes" }) {
  const qid = WIKIDATA_PLATFORMS[platform];
  const selection = JSON.parse(selectionText);
  const fromQuery = new Map(parseWikidata(wikidataText).map((e) => [e.external_id, e]));
  const fromEntities = entitiesText ? new Map(parseWikidataEntities(entitiesText, qid).map((e) => [e.external_id, e])) : new Map();
  const entries = selection.ids.map((id) => fromEntities.get(id) ?? fromQuery.get(id)).filter(Boolean);
  const catalog = catalogText ? JSON.parse(catalogText) : { games: [] };
  const review = reviewText ? JSON.parse(reviewText) : null;
  return dryRun({ selection, platformQid: qid, entries, catalog, review });
}

export function reportMarkdown(report, sources) {
  const t = report.totals;
  const lines = [
    `# M12c-B1 dry run: ${report.selection.selector}`,
    "",
    `Platform ${report.platform.slug} (${report.platform.qid}), seed \`${report.selection.seed}\`, ${t.items} items. Nothing was imported.`,
    "",
    "| Source | File | SHA-256 |",
    "| --- | --- | --- |",
    ...sources.map((s) => `| ${s.kind} | ${s.file} | \`${s.sha256}\` |`),
    "",
    "| Outcome | Count |",
    "| --- | --- |",
    `| Create (new, unpublished candidate) | ${t.create} |`,
    `| Matched (Wikidata id already linked) | ${t.matched} |`,
    `| Possible duplicate (held for an editor) | ${t.duplicate} |`,
    `| Held (ignored) | ${t.held} |`,
    `| Needs exception review | ${t.exception_review} |`,
    `| Clean (no exception flag) | ${t.clean} |`,
    `| Releases created / published | ${t.releases_created} / ${t.published} |`,
    "",
    "| Readiness | Count |",
    "| --- | --- |",
    ...Object.entries(t.readiness ?? {}).map(([k, n]) => `| ${k.replace(/_/g, " ")} | ${n} |`),
    `| possible critical error (unresolved) | ${t.possible_critical ?? 0} |`,
    "",
    "## Title collisions",
    "",
    ...(report.collision_groups ?? []).map((g) => `- **${g.verdict.replace(/_/g, " ")}** (key ${g.key}): ${g.members.map((m) => `${m.id} "${m.title}" (${m.first_release ?? "no date"})`).join("; ")}`),
    "",
    "## Distribution formats (P437), to classify once each",
    "",
    ...(Object.keys(report.distribution_formats ?? {}).length
      ? [
          "| Format | Label | Class | Medium | Items |",
          "| --- | --- | --- | --- | --- |",
          ...Object.entries(report.distribution_formats).map(([q, f]) => `| ${q} | ${f.label ?? "?"} | ${f.class} | ${f.media ?? "?"} | ${f.items} |`),
          "",
          "A physical class only clears the unclassified flag. It never establishes that a game had a physical release on this platform.",
        ]
      : ["- None stated."]),
    "",
    "## Multiple external ids (possible identity conflicts)",
    "",
    ...((report.external_id_conflicts ?? []).length
      ? report.external_id_conflicts.map((c) => `- ${c.id} "${c.title}" (${c.readiness.replace(/_/g, " ")}): IGDB ${c.igdb.join(", ") || "none"}; MobyGames ${c.mobygames.join(", ") || "none"}; hints ${c.hints.join(", ")}${c.editorial ? `; editorial: ${c.editorial}` : ""}`)
      : ["- None."]),
    "",
    ...((report.editorial_groups ?? []).length
      ? ["## Editorial groups (recommendations only; nothing is merged or split)", "", ...report.editorial_groups.map((g) => `- **${g.name}** (${g.members.join(", ")}): ${g.recommendation}`), ""]
      : []),
    "| Flag | Kind | Count |",
    "| --- | --- | --- |",
    ...Object.entries(report.flags).map(([f, n]) => `| ${f} | ${FLAGS[f] ?? "?"} | ${n} |`),
    "",
    "| Id | Title | First release | Outcome | Readiness | Flags |",
    "| --- | --- | --- | --- | --- | --- |",
    ...report.items.map((it) => `| ${it.id} | ${(it.title ?? "").replace(/\|/g, "\\|")} | ${it.first_release ?? ""} | ${it.outcome}${it.reason ? ` (${it.reason})` : ""}${it.catalog && !Array.isArray(it.catalog) ? ` → ${it.catalog.title}` : ""} | ${it.readiness} | ${it.flags.join(", ")} |`),
    "",
    "## Why each record isn't ready",
    "",
    ...report.items.filter((it) => it.reasons?.length).map((it) => `- **${it.id} ${it.title ?? ""}** (${it.readiness.replace(/_/g, " ")}): ${it.reasons.join(" ")}`),
    "",
    "Every record, ready or not, still needs independent human evidence of its specific physical release.",
    "",
  ];
  return lines.join("\n");
}

async function cmdDryRun(o) {
  for (const k of ["selection", "wikidata", "out"]) if (!o[k] || o[k] === true) fail(`--${k} is required.`);
  if (!(await outsideRepo(o.out))) fail("Reports must be kept outside the repository.");
  const read = (path) => (path && path !== true ? readFileSync(path) : null);
  const files = { selection: read(o.selection), wikidata: read(o.wikidata), entities: read(o.entities), catalog: read(o.catalog), review: read(o.review) };
  const report = dryRunFiles({
    selectionText: files.selection.toString("utf8"),
    wikidataText: files.wikidata.toString("utf8"),
    entitiesText: files.entities?.toString("utf8") ?? null,
    catalogText: files.catalog?.toString("utf8") ?? null,
    reviewText: files.review?.toString("utf8") ?? null,
    platform: o.platform ?? "snes",
  });
  const sources = Object.entries(files)
    .filter(([, buf]) => buf)
    .map(([kind, buf]) => ({ kind, file: o[kind].split(/[\\/]/).pop(), sha256: sha256(buf) }));
  mkdirSync(o.out, { recursive: true });
  writeFileSync(join(o.out, "dry-run.json"), `${JSON.stringify({ sources, ...report }, null, 2)}\n`);
  writeFileSync(join(o.out, "dry-run.md"), reportMarkdown(report, sources));
  console.log(JSON.stringify({ out: o.out, totals: report.totals, flags: report.flags }, null, 2));
}

// ---------------------------------------------------------------------------
// fetch-entities (live, rate-limited, refuses without a project contact)
// ---------------------------------------------------------------------------

/** A User-Agent that names a tool and version and a contact (an email address or a URL). */
export function validUserAgent(agent) {
  return typeof agent === "string" && /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+ \([^)]*(@|https?:\/\/)[^)]*\)/.test(agent.trim());
}

/** Only the label languages the parser reads (en, mul, ja and the Latin-script alternates). */
export const FETCH_LANGUAGES = "en|mul|ja|de|fr|es|it|nl|pt|sv";

export const FETCH_POLICY = { batch: 50, minIntervalMs: 1000, maxAttempts: 5, maxlag: 5, backoffMs: [2000, 4000, 8000, 16000] };

/**
 * Fetches entity records for ids, 50 at a time, one request at a time. `fetchImpl`, `sleep`
 * and `now` are injectable for tests. Returns the snapshot object; throws on failure, so a
 * partial snapshot is never written.
 */
export async function fetchEntities(ids, { userAgent, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now(), policy = FETCH_POLICY, props = "labels|aliases|claims", languages = FETCH_LANGUAGES } = {}) {
  if (!validUserAgent(userAgent)) throw new Error("WIKIDATA_USER_AGENT must name a tool, a version and a project contact (an email address or a URL) chosen by the operator.");
  const unique = [...new Set(ids)].filter((id) => /^Q[0-9]+$/.test(id));
  const responses = [];
  let last = -Infinity;
  for (let i = 0; i < unique.length; i += policy.batch) {
    const batch = unique.slice(i, i + policy.batch);
    const url = new URL("https://www.wikidata.org/w/api.php");
    for (const [k, v] of Object.entries({ action: "wbgetentities", format: "json", ids: batch.join("|"), props, languages, maxlag: String(policy.maxlag) })) url.searchParams.set(k, v);
    for (let attempt = 1; ; attempt++) {
      const wait = last + policy.minIntervalMs - now();
      if (wait > 0) await sleep(wait);
      last = now();
      const response = await fetchImpl(url.toString(), { headers: { "User-Agent": userAgent, Accept: "application/json" } });
      const body = response.ok ? await response.json() : null;
      const lagged = body?.error?.code === "maxlag";
      if (response.ok && !lagged && !body?.error) {
        responses.push(body);
        break;
      }
      const retryable = response.status === 429 || response.status === 503 || lagged;
      if (!retryable || attempt >= policy.maxAttempts) throw new Error(`Wikidata answered ${response.status}${body?.error ? ` (${body.error.code})` : ""} after ${attempt} attempt(s); nothing was written.`);
      const retryAfter = Number(response.headers?.get?.("retry-after"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : policy.backoffMs[Math.min(attempt - 1, policy.backoffMs.length - 1)]);
    }
  }
  return { format: "mgd-wikidata-entities", version: 1, endpoint: "wbgetentities", props, languages, fetched_at: new Date(now()).toISOString(), ids: unique, requests: responses.length, responses };
}

async function cmdFetch(o) {
  for (const k of ["selection", "out"]) if (!o[k] || o[k] === true) fail(`--${k} is required.`);
  if (!(await outsideRepo(o.out))) fail("Snapshots must be kept outside the repository.");
  const userAgent = process.env.WIKIDATA_USER_AGENT;
  if (!validUserAgent(userAgent)) fail("Set WIKIDATA_USER_AGENT to \"<tool>/<version> (<project contact>) <library>/<version>\", with a project contact the operator chose (an email address or a URL). It is never invented.");
  const selection = JSON.parse(readFileSync(o.selection, "utf8"));
  const snapshot = await fetchEntities(selection.ids, { userAgent });
  mkdirSync(o.out, { recursive: true });
  const file = join(o.out, `wikidata-entities-${selection.platform ?? "snes"}-${snapshot.fetched_at.replace(/[:.]/g, "-")}.json`);
  const text = JSON.stringify(snapshot);
  writeFileSync(file, text);
  console.log(`${file}: ${snapshot.ids.length} ids in ${snapshot.requests} requests, sha256 ${sha256(Buffer.from(text))}`);
}

/**
 * fetch-formats: the labels and descriptions (en and mul only) of the distinct distribution
 * formats (P437) the saved entity snapshot states, and nothing else, so each can be classified
 * by a person. Same User-Agent rule, rate limits and retries as fetch-entities.
 */
async function cmdFetchFormats(o) {
  for (const k of ["entities", "out"]) if (!o[k] || o[k] === true) fail(`--${k} is required.`);
  if (!(await outsideRepo(o.out))) fail("Snapshots must be kept outside the repository.");
  const userAgent = process.env.WIKIDATA_USER_AGENT;
  if (!validUserAgent(userAgent)) fail("Set WIKIDATA_USER_AGENT to \"<tool>/<version> (<project contact>) <library>/<version>\", with a project contact the operator chose (an email address or a URL). It is never invented.");
  const source = readFileSync(o.entities);
  const ids = distributionFormatIds(source.toString("utf8"));
  if (!ids.length) fail("The entity snapshot states no distribution formats.");
  const snapshot = await fetchEntities(ids, { userAgent, props: "labels|descriptions", languages: "en|mul" });
  snapshot.purpose = "distribution formats (P437) stated by the entity snapshot";
  snapshot.source_snapshot = { file: o.entities.split(/[\\/]/).pop(), sha256: sha256(source) };
  mkdirSync(o.out, { recursive: true });
  const file = join(o.out, `wikidata-formats-${snapshot.fetched_at.replace(/[:.]/g, "-")}.json`);
  const text = JSON.stringify(snapshot);
  writeFileSync(file, text);
  console.log(`${file}: ${snapshot.ids.length} ids in ${snapshot.requests} request(s), sha256 ${sha256(Buffer.from(text))}`);
}

async function main() {
  const o = args(process.argv.slice(2));
  const commands = { select, "export-catalog": exportCatalog, "dry-run": cmdDryRun, "fetch-entities": cmdFetch, "fetch-formats": cmdFetchFormats };
  const command = commands[o._[0]];
  if (!command) fail("Usage: node scripts/catalog-b1.mjs select|export-catalog|dry-run|fetch-entities [options]. See the header of this file.");
  if (o.platform) platformQid(o.platform);
  try {
    await command(o);
  } catch (error) {
    fail(`Stopped: ${error.message}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
