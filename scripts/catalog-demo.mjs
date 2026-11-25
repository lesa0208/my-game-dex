/**
 * M16: the local demo catalog. Real game identities from Wikidata (CC0), imported with the
 * existing acquisition tools into the demo stack only (MGD_STACK=demo, project "my-game-dex-demo"),
 * then published there by two demo-only staff accounts, so a collector can search, add physical
 * copies and see their shelves. Nothing here can write to development, the test stack, scratch,
 * B1 or the pilot: every command that writes checks the demo project and its own API port.
 *
 *   node scripts/catalog-demo.mjs fetch --out <dir> [--per-platform 120]
 *        One saved SPARQL snapshot per platform (video games stating it, with their Wikipedia
 *        sitelink count), and the selection: each platform's best-known games by sitelinks.
 *   node scripts/catalog-demo.mjs fetch-entities --dir <dir>
 *        The selected items' entity records (the M12c-B1 fetch: 50 a request, 1 s apart, maxlag).
 *   MGD_STACK=demo node scripts/catalog-demo.mjs clear --terms-file <saved Wikidata:Licensing page>
 *   MGD_STACK=demo node scripts/catalog-demo.mjs stage --dir <dir> --terms-file <same page>
 *        The M5b importer, as catalog_importer, one run per platform. A game on several platforms
 *        is one identity: a later platform's run finds its Wikidata id and adds the pairing.
 *   MGD_STACK=demo node scripts/catalog-demo.mjs publish --dir <dir>
 *        Demo publication through the real editor functions (verify_game, verify_game_platform,
 *        publish_game_identity), by two demo staff accounts that can't sign in.
 *   MGD_STACK=demo node scripts/catalog-demo.mjs report [--out <file.json>]
 *
 * What demo publication means, and doesn't:
 *   - It publishes the game identity and its platform pairings only. No release, barcode, edition,
 *     packaging or region is created: collectors add their copies as their own unidentified
 *     records (platform, region and edition as they know them, or "not sure").
 *   - Each pairing's verification basis says plainly that it is a demo, not physical evidence:
 *     no person checked a physical copy. The demo staff exist only in the demo database.
 *   - It never publishes what the importer held (possible duplicates, ambiguous titles), or a
 *     pairing the parser gives a critical signal (demoIneligibility): possibly digital-only on the
 *     platform, an unclassified format, another instance type, a date outside the platform's era.
 *     Two exceptions: several MobyGames ids, or IGDB slugs differing only by "--N", aren't an
 *     identity conflict (two differently named IGDB entries still are); and a game first published
 *     within the platform's era whose only digital statements name no platform is a later digital
 *     reissue (reissuedDigitally), not a digital-only game.
 *   - The real catalog's route is the batch review (docs/architecture/real-catalog-m16.md).
 * Snapshots and selections stay outside the repository. WIKIDATA_USER_AGENT is never printed.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { fetchEntities, validUserAgent } from "./catalog-b1.mjs";
import { outsideRepo } from "./catalog-import.mjs";
import { WIKIDATA_PLATFORMS } from "./catalog-import-sources.mjs";
import { CRITICAL_SIGNALS, DISTRIBUTION_FORMAT_TABLE, PLATFORM_ERAS, externalIdConflict, parseWikidataEntities } from "./wikidata-entities.mjs";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
const fail = (message) => {
  console.error(message);
  process.exit(2);
};
const lit = (value) => `'${String(value).replace(/'/g, "''")}'`;

/** The demo's platforms, in the order they are imported. */
export const DEMO_PLATFORMS = ["nes", "snes", "mega-drive", "nintendo-64", "game-boy", "game-boy-color", "game-boy-advance", "playstation", "playstation-2"];
export const DEMO_API_PORT = 54321 + 5000;
export const DEMO_REVIEWER = "de30de30-0000-4000-8000-0000000de301";
export const DEMO_PUBLISHER = "de30de30-0000-4000-8000-0000000de302";
/** Adds the source's other titles as aliases (below); never verifies or publishes. */
export const DEMO_EDITOR = "de30de30-0000-4000-8000-0000000de303";
/** Every demo pairing's basis says this, in place of physical evidence. */
export const DEMO_NOTE =
  "DEMO CATALOG ONLY, not physical evidence: published for the local demo from the Wikidata item's platform statement. No person checked a physical copy.";

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

/** The SPARQL query: video games stating this platform, with their sitelink count. */
export function sitelinkQuery(qid) {
  return `SELECT ?item ?links WHERE { ?item wdt:P31 wd:Q7889 ; wdt:P400 wd:${qid} ; wikibase:sitelinks ?links . }`;
}

/**
 * Each platform's best-known games: the most Wikipedia sitelinks first, then the lower Q-id, so
 * the same snapshot always gives the same selection. Pure.
 */
export function demoSelection(rows, perPlatform) {
  const items = new Map();
  for (const row of rows) {
    const id = String(row.item?.value ?? "").split("/").pop();
    const links = Number(row.links?.value);
    if (/^Q[0-9]+$/.test(id) && Number.isFinite(links)) items.set(id, Math.max(links, items.get(id) ?? 0));
  }
  return [...items].sort((a, b) => b[1] - a[1] || Number(a[0].slice(1)) - Number(b[0].slice(1))).slice(0, perPlatform).map(([id]) => id);
}

async function sparql(query, userAgent) {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch("https://query.wikidata.org/sparql", {
      method: "POST",
      headers: { "User-Agent": userAgent, Accept: "application/sparql-results+json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ query }),
    });
    if (response.ok) return response.text();
    if ((response.status !== 429 && response.status !== 503) || attempt >= 4) throw new Error(`Wikidata's query service answered ${response.status}; nothing was written.`);
    await new Promise((resolve) => setTimeout(resolve, 5000 * attempt));
  }
}

const userAgent = () => {
  const agent = process.env.WIKIDATA_USER_AGENT;
  if (!validUserAgent(agent)) fail('Set WIKIDATA_USER_AGENT to "<tool>/<version> (<project contact>) <library>/<version>", with the operator\'s own contact. It is never invented.');
  return agent;
};

async function cmdFetch(o) {
  if (!o.out || o.out === true) fail("--out is required.");
  if (!outsideRepo(o.out)) fail("Snapshots must be kept outside the repository.");
  const per = o["per-platform"] ? Number(o["per-platform"]) : 120;
  if (!Number.isInteger(per) || per < 1 || per > 500) fail("--per-platform is 1 to 500.");
  const agent = userAgent();
  mkdirSync(o.out, { recursive: true });
  const manifest = { format: "mgd-demo-catalog", version: 1, fetched_at: new Date().toISOString(), per_platform: per, platforms: {} };
  for (const platform of DEMO_PLATFORMS) {
    const qid = WIKIDATA_PLATFORMS[platform];
    const text = await sparql(sitelinkQuery(qid), agent);
    const rows = JSON.parse(text).results.bindings;
    const file = `sitelinks-${platform}.json`;
    writeFileSync(join(o.out, file), text);
    const ids = demoSelection(rows, per);
    const selection = { platform, ids, selector: `top ${per} by Wikipedia sitelinks, then lower Q-id`, source: { file, sha256: sha256(Buffer.from(text)) } };
    writeFileSync(join(o.out, `selection-${platform}.json`), `${JSON.stringify(selection, null, 2)}\n`);
    manifest.platforms[platform] = { qid, listed: new Set(rows.map((r) => r.item.value)).size, selected: ids.length, snapshot_sha256: selection.source.sha256 };
    console.log(`${platform}: ${manifest.platforms[platform].listed} games listed, ${ids.length} selected`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  writeFileSync(join(o.out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

const selections = (dir) => DEMO_PLATFORMS.map((platform) => ({ platform, file: join(dir, `selection-${platform}.json`), ...JSON.parse(readFileSync(join(dir, `selection-${platform}.json`), "utf8")) }));

async function cmdFetchEntities(o) {
  if (!o.dir || o.dir === true) fail("--dir is required.");
  if (!outsideRepo(o.dir)) fail("Snapshots must be kept outside the repository.");
  const ids = [...new Set(selections(o.dir).flatMap((s) => s.ids))];
  const snapshot = await fetchEntities(ids, { userAgent: userAgent() });
  const text = JSON.stringify(snapshot);
  writeFileSync(join(o.dir, "entities.json"), text);
  console.log(`entities.json: ${snapshot.ids.length} distinct items in ${snapshot.requests} requests, sha256 ${sha256(Buffer.from(text))}`);
}

/** The demo stack, and nothing else: its project, its container and its own API port. */
async function demoStack() {
  if (process.env.MGD_STACK !== "demo") fail("Refusing: this writes only to the demo stack. Set MGD_STACK=demo.");
  const stack = await import("./lib/stack.mjs");
  if (stack.projectId !== "my-game-dex-demo") fail(`Refusing: the stack's config names "${stack.projectId}", not my-game-dex-demo.`);
  const status = stack.stackStatus({ label: "the demo catalog" });
  if (Number(new URL(status.API_URL).port) !== DEMO_API_PORT) fail(`Refusing: the demo's API is on port ${DEMO_API_PORT}, not ${new URL(status.API_URL).port}.`);
  return { container: stack.dbContainer, dbPort: DEMO_API_PORT + 1 };
}

const psql = (container, sql, { quiet = false } = {}) =>
  execFileSync("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-At"], {
    input: sql,
    encoding: "utf8",
    stdio: ["pipe", "pipe", quiet ? "pipe" : "inherit"],
    env: { ...process.env, MSYS_NO_PATHCONV: "1" },
  }).trim();

async function cmdClear(o) {
  if (!o["terms-file"] || o["terms-file"] === true) fail("--terms-file is required: the saved Wikidata:Licensing page.");
  const { container } = await demoStack();
  const page = readFileSync(o["terms-file"]);
  const text = page.toString("utf8");
  if (!text.includes("released into the public domain under") || !text.includes("Creative Commons CC0")) fail("That file isn't the Wikidata:Licensing page stating the CC0 dedication.");
  const hash = sha256(page);
  psql(container, `select private.record_provider_clearance('wikidata', true, 'https://www.wikidata.org/wiki/Wikidata:Licensing', ${lit(hash)},
    'Demo stack (M16): Wikidata (CC0 structured data) for game identity in the local demo catalog. Game identity only: never evidence of a physical release.');
select private.record_provider_rights('wikidata', true, ${lit(hash)},
    'Demo stack (M16): Wikidata structured data under CC0 1.0, for the local demo catalog only. Not images, cover art, descriptions or other providers'' metadata.');`);
  console.log(`wikidata cleared on the demo stack against terms sha256 ${hash}`);
}

async function cmdStage(o) {
  for (const k of ["dir", "terms-file"]) if (!o[k] || o[k] === true) fail(`--${k} is required.`);
  const { dbPort } = await demoStack();
  const entities = join(o.dir, "entities.json");
  if (!existsSync(entities)) fail("Run fetch-entities first.");
  const fetchedAt = JSON.parse(readFileSync(entities, "utf8")).fetched_at;
  const password = randomBytes(24).toString("base64url");
  const env = { ...process.env, CATALOG_IMPORTER_PASSWORD: password, MSYS_NO_PATHCONV: "1" };
  const role = (command) => execFileSync(process.execPath, [join(ROOT, "scripts", "catalog-import-role.mjs"), command], { env, stdio: ["ignore", "ignore", "inherit"] });
  role("enable");
  try {
    for (const s of selections(o.dir)) {
      console.log(`\n== ${s.platform}: ${s.ids.length} selected`);
      execFileSync(process.execPath, [join(ROOT, "scripts", "catalog-import.mjs"), "import", "--provider", "wikidata", "--platform", s.platform, "--entities",
        "--file", entities, "--ids", s.file, "--terms-file", o["terms-file"], "--reason", `M16 demo catalog: ${s.platform}, ${s.selector}`, "--fetched-at", fetchedAt], {
        env: { ...process.env, CATALOG_IMPORTER_DATABASE_URL: `postgresql://catalog_importer:${encodeURIComponent(password)}@127.0.0.1:${dbPort}/postgres` },
        stdio: ["ignore", "inherit", "inherit"],
      });
    }
  } finally {
    role("disable");
  }
}

/** The two demo staff, made in SQL as the catalog fixture's are, with the Auth rows GoTrue writes. They have no password. */
export function demoStaffSql() {
  const person = (id, email, handle) => `
insert into auth.users (id, aud, role, email, email_confirmed_at, instance_id, confirmation_token, recovery_token, email_change_token_new, email_change, created_at, updated_at)
values ('${id}', 'authenticated', 'authenticated', '${email}', now(), '00000000-0000-0000-0000-000000000000', '', '', '', '', now(), now()) on conflict (id) do nothing;
update public.profiles set handle = '${handle}', handle_changed_at = now() where id = '${id}' and handle is null;
insert into public.staff_roles (user_id, role) values ('${id}', 'catalog_editor') on conflict do nothing;
insert into auth.sessions (id, user_id, aal, factor_id, created_at, updated_at) values ('${id}', '${id}', 'aal2', '${id}', now(), now()) on conflict (id) do nothing;
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret)
values ('${id}', '${id}', 'demo', 'totp', 'verified', now(), now(), '') on conflict (id) do nothing;
insert into auth.mfa_amr_claims (id, session_id, authentication_method, created_at, updated_at)
select gen_random_uuid(), '${id}', 'totp', now(), now() where not exists (select 1 from auth.mfa_amr_claims where session_id = '${id}');
update auth.mfa_amr_claims set created_at = now(), updated_at = now() where session_id = '${id}';`;
  return `begin;${person(DEMO_REVIEWER, "demo-reviewer@example.test", "demo_reviewer")}${person(DEMO_PUBLISHER, "demo-publisher@example.test", "demo_publisher")}${person(DEMO_EDITOR, "demo-editor@example.test", "demo_editor")}
commit;`;
}

/**
 * Publishes one game's identity for the demo, through the editor functions, as the two demo staff:
 * the reviewer verifies the game and each eligible pairing (with the demo basis), the publisher
 * publishes. Each call to it is its own transaction, so one refusal never undoes another game.
 */
export const PUBLISH_FUNCTION_SQL = `
create or replace function pg_temp.demo_as(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', pg_catalog.jsonb_build_object('sub', p_user, 'role', 'authenticated', 'aal', 'aal2', 'session_id', p_user)::text, true),
         set_config('role', 'authenticated', true)
$$;
create or replace function pg_temp.demo_publish(p_game uuid, p_platforms uuid[], p_reference text, p_snapshot text) returns text language plpgsql as $$
declare
  v_platform uuid;
  v_done uuid[] := '{}';
begin
  perform pg_temp.demo_as('${DEMO_REVIEWER}');
  if (select verified_at from public.games where id = p_game) is null then
    perform public.verify_game(p_game, 'M16 demo catalog: Wikidata identity, demo publication', (select revision from public.games where id = p_game));
  end if;
  foreach v_platform in array p_platforms loop
    perform public.verify_game_platform(p_game, v_platform,
      pg_catalog.jsonb_build_object('source', 'demo', 'reference', p_reference, 'physical_eligibility', 'confirmed', 'snapshot_sha256', p_snapshot, 'note', '${DEMO_NOTE.replace(/'/g, "''")}'),
      'M16 demo catalog: demo publication, not physical evidence', (select revision from public.games where id = p_game));
    v_done := v_done || v_platform;
  end loop;
  perform set_config('role', 'none', true);
  perform pg_temp.demo_as('${DEMO_PUBLISHER}');
  perform public.publish_game_identity(p_game, v_done, 'M16 demo catalog: demo publication', (select revision from public.games where id = p_game));
  perform set_config('role', 'none', true);
  return 'published';
exception when others then
  return 'refused: ' || sqlerrm;
end $$;`;

/**
 * Whether one game may be published on one platform in the demo, from the parser's flags (the
 * current classification of distribution formats, applied to the saved entity record). Every
 * critical signal blocks it, with one exception: several MobyGames ids (MobyGames keeps one entry
 * per platform) or IGDB slugs that differ only by a "--N" suffix aren't an identity conflict. Two
 * differently named IGDB entries still are. Pure. Returns null when eligible, or the reasons.
 */
export function demoIneligibility(entry, platformQid = null) {
  if (entry.ignore_reason) return [`ignored: ${entry.ignore_reason}`];
  const conflict = externalIdConflict(entry.payload?.source?.external_ids);
  const flags = entry.flags.filter((f) => !(f === "distribution_non_physical" && reissuedDigitally(entry, platformQid)));
  const reasons = [...new Set(flags.map((f) => CRITICAL_SIGNALS[f]).filter(Boolean))].filter(
    (signal) => !(signal === "conflicting_identifiers" && conflict && !conflict.hints.includes("igdb_distinct_slugs") && !flags.includes("external_id_shared_in_batch")),
  );
  return reasons.length ? reasons.sort() : null;
}

/**
 * The demo's one reading of "possibly digital-only": a game first published within the platform's
 * retail era, whose only digital statements name no platform, is taken as reissued digitally later
 * (Virtual Console, Switch Online, PlayStation Network re-releases state "digital download" with
 * no platform, and often no physical format at all). A digital statement qualified with this
 * platform, a date outside the era, or any other doubt about physical eligibility still blocks it.
 * The real catalog keeps the flag for a person. Pure.
 */
export function reissuedDigitally(entry, platformQid) {
  const era = PLATFORM_ERAS[platformQid];
  const source = entry.payload?.source ?? {};
  const date = source.platform_first_release?.value ?? entry.payload?.first_release_date ?? null;
  if (!era || !date || date < era.launch || date > era.lateAfter) return false;
  const digital = (source.distribution ?? []).filter((d) => DISTRIBUTION_FORMAT_TABLE[d.format]?.class === "non_physical");
  if (!digital.length || digital.some((d) => d.platforms?.includes(platformQid))) return false;
  const otherDoubts = entry.flags.filter((f) => f !== "distribution_non_physical" && CRITICAL_SIGNALS[f] === "physical_eligibility_unsupported");
  return otherDoubts.length === 0;
}

/** The Latin-script label languages the parser reads (wikidata-entities.mjs), each a regional title in that language. */
const ALIAS_LANGUAGES = ["de", "fr", "es", "it", "nl", "pt", "sv"];
/** At most this many other titles per game, in the order below. */
export const MAX_DEMO_ALIASES = 12;

/**
 * A game's other titles, exactly as its Wikidata item states them, as catalog aliases: English
 * aliases ("alternate"), labels in other languages ("regional", with the language), the Japanese
 * title and its aliases ("regional", "ja"), and the Revised Hepburn romanization (P2125,
 * "romanized", "ja-Latn"). The game's own title and repeats are left out. Pure.
 */
export function demoAliases(entity) {
  const title = entity.labels?.en?.value?.trim() || entity.labels?.mul?.value?.trim() || "";
  const out = [];
  const seen = new Set([title.toLowerCase()]);
  const add = (value, kind, language) => {
    const text = String(value ?? "").trim();
    if (!text || text.length > 200 || seen.has(text.toLowerCase())) return;
    seen.add(text.toLowerCase());
    out.push({ title: text, kind, language });
  };
  for (const a of entity.aliases?.en ?? []) add(a.value, "alternate", null);
  for (const l of ALIAS_LANGUAGES) add(entity.labels?.[l]?.value, "regional", l);
  add(entity.labels?.ja?.value, "regional", "ja");
  for (const a of entity.aliases?.ja ?? []) add(a.value, "regional", "ja");
  for (const s of entity.claims?.P2125 ?? []) if (s.rank !== "deprecated") add(s.mainsnak?.datavalue?.value, "romanized", "ja-Latn");
  return out.slice(0, MAX_DEMO_ALIASES);
}

/** Per platform slug, each selected entity's demo ineligibility (null: eligible). */
export function demoEligibility(entitiesText, selectionsList) {
  const out = {};
  for (const s of selectionsList) {
    const wanted = new Set(s.ids);
    const qid = WIKIDATA_PLATFORMS[s.platform];
    out[s.platform] = Object.fromEntries(parseWikidataEntities(entitiesText, qid).filter((e) => wanted.has(e.external_id)).map((e) => [e.external_id, demoIneligibility(e, qid)]));
  }
  return out;
}

/** Every imported game still unpublished, with its Wikidata id and its platforms awaiting publication. As postgres, read-only. */
const WORK_SQL = `select coalesce(json_agg(w), '[]') from (
  select g.id as game, x.external_id as qid, json_agg(json_build_object('id', gp.platform_id, 'slug', p.slug) order by p.slug) as platforms
  from public.games g
  join private.external_references x on x.game_id = g.id and x.provider_code = 'wikidata'
  join public.game_platforms gp on gp.game_id = g.id and gp.status in ('unverified', 'under_review')
  join public.platforms p on p.id = gp.platform_id
  where g.status in ('unverified', 'under_review', 'published')
  group by g.id, x.external_id
) w;`;

async function cmdPublish(o) {
  if (!o.dir || o.dir === true) fail("--dir is required.");
  const { container } = await demoStack();
  const entitiesText = readFileSync(join(o.dir, "entities.json"), "utf8");
  const snapshot = sha256(Buffer.from(entitiesText));
  const eligibility = demoEligibility(entitiesText, selections(o.dir));
  psql(container, demoStaffSql());

  // Every eligible listing should have its pairing from the importer: since migration
  // 20261220100000 a record unchanged between two platforms' runs pairs the second platform too.
  // (The demo built on 2026-11-25, before that fix, had 77 such pairings added by the demo editor.)
  // Any still missing is reported, never made here.
  const known = JSON.parse(psql(container, `select coalesce(json_object_agg(x.external_id, json_build_object('game', x.game_id,
      'platforms', (select coalesce(json_agg(p.slug), '[]') from public.game_platforms gp join public.platforms p on p.id = gp.platform_id where gp.game_id = x.game_id))), '{}')
    from private.external_references x where x.provider_code = 'wikidata';`));
  const missing = Object.entries(eligibility).flatMap(([platform, byId]) =>
    Object.entries(byId).filter(([qid, reasons]) => reasons === null && known[qid] && !known[qid].platforms.includes(platform)).map(([qid]) => `${qid} ${platform}`),
  );
  if (missing.length) console.log(`eligible listings without a pairing (the importer didn't pair them): ${missing.length}, e.g. ${missing.slice(0, 5).join(", ")}`);

  // The source's other titles, as catalog aliases (so search finds "Rockman X" or a Japanese
  // title), added by the demo editor through add_game_alias, for every game with an eligible pairing.
  const entities = {};
  for (const r of JSON.parse(entitiesText).responses) Object.assign(entities, r.entities);
  const eligibleIds = new Set(Object.values(eligibility).flatMap((m) => Object.entries(m).filter(([, r]) => r === null).map(([q]) => q)));
  const games = JSON.parse(psql(container, `select coalesce(json_object_agg(x.external_id, x.game_id), '{}') from private.external_references x
    where x.provider_code = 'wikidata' and not exists (select 1 from public.game_aliases a where a.game_id = x.game_id);`));
  const aliasCalls = Object.entries(games)
    .filter(([qid]) => eligibleIds.has(qid) && entities[qid])
    .flatMap(([qid, game]) => demoAliases(entities[qid]).map((a) => `select pg_temp.demo_alias(${lit(game)}, ${lit(a.title)}, ${lit(a.kind)}, ${a.language ? lit(a.language) : "null"});`));
  if (aliasCalls.length) {
    let added = 0;
    for (let i = 0; i < aliasCalls.length; i += 400) {
      const out = psql(container, `update auth.mfa_amr_claims set created_at = now(), updated_at = now() where session_id = '${DEMO_EDITOR}';
create or replace function pg_temp.demo_alias(p_game uuid, p_title text, p_kind public.game_alias_kind, p_language text) returns text language plpgsql as $$
begin
  perform set_config('request.jwt.claims', pg_catalog.jsonb_build_object('sub', '${DEMO_EDITOR}', 'role', 'authenticated', 'aal', 'aal2', 'session_id', '${DEMO_EDITOR}')::text, true);
  perform set_config('role', 'authenticated', true);
  perform public.add_game_alias(p_game, p_title, p_kind, p_language, null, 'M16 demo catalog: another title the Wikidata item states (CC0)');
  perform set_config('role', 'none', true);
  return 'added';
exception when others then
  return 'refused: ' || sqlerrm;
end $$;
${aliasCalls.slice(i, i + 400).join("\n")}`, { quiet: true });
      added += out.split("\n").filter((l) => l === "added").length;
    }
    console.log(`other titles from the source: ${aliasCalls.length} offered, ${added} added as aliases`);
  }

  const left = {};
  const work = JSON.parse(psql(container, WORK_SQL))
    .map((w) => {
      const ok = w.platforms.filter((p) => eligibility[p.slug]?.[w.qid] === null);
      for (const p of w.platforms.filter((x) => !ok.includes(x))) for (const r of eligibility[p.slug]?.[w.qid] ?? ["not in this platform's selection"]) left[r] = (left[r] ?? 0) + 1;
      return { ...w, platforms: ok.map((p) => p.id) };
    })
    .filter((w) => w.platforms.length);
  console.log(`${work.length} games to publish; pairings left unpublished, by reason: ${JSON.stringify(left)}`);
  writeFileSync(join(o.dir, "eligibility.json"), `${JSON.stringify(eligibility, null, 2)}\n`);
  const outcomes = {};
  const refused = [];
  for (let i = 0; i < work.length; i += 50) {
    const chunk = work.slice(i, i + 50);
    const calls = chunk.map((w) => `select ${lit(w.qid)} || ' ' || pg_temp.demo_publish(${lit(w.game)}, ${lit(`{${w.platforms.join(",")}}`)}::uuid[], ${lit(`Wikidata ${w.qid} (CC0): platform statement (P400)`)}, ${lit(snapshot)});`).join("\n");
    // The mfa claims are renewed, so the staff's sessions count as recently verified.
    const out = psql(container, `update auth.mfa_amr_claims set created_at = now(), updated_at = now() where session_id in ('${DEMO_REVIEWER}', '${DEMO_PUBLISHER}');\n${PUBLISH_FUNCTION_SQL}\n${calls}`, { quiet: true });
    for (const line of out.split("\n").filter((l) => /^Q[0-9]+ /.test(l))) {
      const [qid, ...rest] = line.split(" ");
      const outcome = rest.join(" ");
      const key = outcome.startsWith("refused") ? outcome : "published";
      outcomes[key] = (outcomes[key] ?? 0) + 1;
      if (key !== "published") refused.push(`${qid}: ${outcome}`);
    }
    process.stdout.write(`\r${Math.min(i + 50, work.length)} of ${work.length}`);
  }
  process.stdout.write("\n");
  console.log(JSON.stringify(outcomes, null, 2));
  for (const r of refused.slice(0, 20)) console.log(`  ${r}`);
}

export const REPORT_SQL = `select json_build_object(
  'games_published', (select count(*) from public.games where status = 'published'),
  'games_by_status', (select json_object_agg(s, n) from (select status::text s, count(*) n from public.games group by 1) x),
  'published_per_platform', (select json_object_agg(slug, n) from (select p.slug, count(*) n from public.game_platforms gp join public.platforms p on p.id = gp.platform_id join public.games g on g.id = gp.game_id
     where gp.status = 'published' and g.status = 'published' group by p.slug order by p.slug) x),
  'pairings_by_status', (select json_object_agg(s, n) from (select gp.status::text s, count(*) n from public.game_platforms gp group by 1) x),
  'multi_platform_games', (select count(*) from (select gp.game_id from public.game_platforms gp join public.games g on g.id = gp.game_id where g.status = 'published' and gp.status = 'published' group by 1 having count(*) > 1) x),
  'provider_records', (select json_object_agg(s, n) from (select status::text s, count(*) n from private.provider_records group by 1) x),
  'ignored_reasons', (select json_object_agg(s, n) from (select coalesce(match_notes ->> 'reason', review_reason, 'unspecified') s, count(*) n from private.provider_records where status = 'ignored' group by 1) x),
  'distinct_items_staged', (select count(distinct external_id) from private.provider_records),
  'distinct_items_ignored_everywhere', (select count(*) from (select external_id from private.provider_records group by 1 having bool_and(status = 'ignored')) x),
  'held_reasons', (select json_object_agg(s, n) from (select coalesce(match_notes ->> 'reason', review_reason, 'unspecified') s, count(*) n from private.provider_records where status = 'needs_review' group by 1) x),
  'releases', (select count(*) from public.releases),
  'runs', (select json_agg(json_build_object('platform', p.slug, 'status', r.status, 'stats', r.stats) order by r.started_at) from private.import_runs r join public.platforms p on p.id = r.platform_id)
);`;

async function cmdReport(o) {
  const { container } = await demoStack();
  const report = JSON.parse(psql(container, REPORT_SQL));
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (o.out && o.out !== true) {
    if (!outsideRepo(o.out)) fail("Reports stay outside the repository.");
    writeFileSync(o.out, text);
  }
  process.stdout.write(text);
}

async function main() {
  const o = args(process.argv.slice(2));
  const commands = { fetch: cmdFetch, "fetch-entities": cmdFetchEntities, clear: cmdClear, stage: cmdStage, publish: cmdPublish, report: cmdReport };
  const command = commands[o._[0]];
  if (!command) fail("Usage: node scripts/catalog-demo.mjs fetch|fetch-entities|clear|stage|publish|report [options]. See the header of this file.");
  try {
    await command(o);
  } catch (error) {
    fail(`Stopped: ${String(error.message).split("\n")[0]}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
