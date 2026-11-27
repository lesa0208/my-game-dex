// M18a: the IGDB client, credentials and matcher. Synthetic test data only: no network, no
// database, no real credentials (the strings below are made up for these tests).
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { apicalypseString, createIgdbClient, IgdbError } from "./lib/igdb-client.mjs";
import { describeIgdbConfig, loadIgdbCredentials, parseEnvFile } from "./lib/igdb-config.mjs";
import { checkCandidate, decide, gameType, normalizeTitle, toPayload } from "./lib/igdb-match.mjs";

const ID = "abcdefghijklmnopqrstuvwxyz0123";
const SECRET = "ZYXWVUTSRQPONMLKJIHGFEDCBA9876";

/** A fake clock whose sleep advances time, and a scripted fetch recording every call. */
function harness(script) {
  let t = 0;
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init, at: t });
    const step = script(String(url), init, calls);
    if (step instanceof Error) throw step;
    const { status = 200, body = [], headers = {} } = step;
    return { ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, json: async () => body, text: async () => JSON.stringify(body) };
  };
  return { fetchImpl, calls, now: () => t, sleep: async (ms) => (t += ms), advance: (ms) => (t += ms), random: () => 0 };
}
const token = (value = "tok-1", expires = 3600) => ({ status: 200, body: { access_token: value, expires_in: expires, token_type: "bearer" } });
const isToken = (url) => url.includes("oauth2/token");

test("a token is fetched once, cached, and renewed a minute before it expires", async () => {
  let n = 0;
  const h = harness((url) => (isToken(url) ? token(`tok-${++n}`, 3600) : { body: [{ id: 1 }] }));
  const igdb = createIgdbClient({ clientId: ID, clientSecret: SECRET, ...h });
  await igdb.query("games", "fields id;");
  await igdb.query("games", "fields id;");
  assert.equal(h.calls.filter((c) => isToken(c.url)).length, 1);
  h.advance(3600_000 - 59_000);
  await igdb.query("games", "fields id;");
  assert.equal(h.calls.filter((c) => isToken(c.url)).length, 2);
  const last = h.calls.at(-1);
  assert.equal(last.init.headers.Authorization, "Bearer tok-2");
  assert.equal(last.init.headers["Client-ID"], ID);
});

test("the credentials go in the token request's body, never its URL", async () => {
  const h = harness((url) => (isToken(url) ? token() : { body: [] }));
  await createIgdbClient({ clientId: ID, clientSecret: SECRET, ...h }).query("games", "fields id;");
  const call = h.calls.find((c) => isToken(c.url));
  assert.ok(!call.url.includes(SECRET) && !call.url.includes(ID));
  assert.ok(String(call.init.body).includes("grant_type=client_credentials"));
});

test("a 401 renews the token once and repeats the query; a second 401 is an auth error", async () => {
  let n = 0;
  let api = 0;
  const h = harness((url) => (isToken(url) ? token(`tok-${++n}`) : ++api === 1 ? { status: 401 } : { body: [{ id: 7 }] }));
  const igdb = createIgdbClient({ clientId: ID, clientSecret: SECRET, ...h });
  assert.deepEqual(await igdb.query("games", "fields id;"), [{ id: 7 }]);
  assert.equal(n, 2);
  const always = harness((url) => (isToken(url) ? token() : { status: 401 }));
  await assert.rejects(createIgdbClient({ clientId: ID, clientSecret: SECRET, ...always }).query("games", "fields id;"), (e) => e instanceof IgdbError && e.kind === "auth");
});

test("Twitch refusing the credentials is an auth error that quotes neither credential", async () => {
  const h = harness((url) => (isToken(url) ? { status: 403, body: { message: "invalid client secret" } } : { body: [] }));
  await assert.rejects(createIgdbClient({ clientId: ID, clientSecret: SECRET, ...h }).query("games", "fields id;"), (e) => {
    assert.equal(e.kind, "auth");
    assert.ok(!e.message.includes(SECRET) && !e.message.includes(ID));
    return true;
  });
});

test("429 waits as Retry-After says, then succeeds", async () => {
  let api = 0;
  const h = harness((url) => (isToken(url) ? token() : ++api === 1 ? { status: 429, headers: { "retry-after": "3" } } : { body: [{ id: 2 }] }));
  const igdb = createIgdbClient({ clientId: ID, clientSecret: SECRET, ...h });
  assert.deepEqual(await igdb.query("games", "fields id;"), [{ id: 2 }]);
  const apiCalls = h.calls.filter((c) => !isToken(c.url));
  assert.ok(apiCalls[1].at - apiCalls[0].at >= 3000);
  assert.equal(igdb.stats.retries, 1);
});

test("5xx, timeouts and network failures are retried with back-off, then reported as unavailable", async () => {
  let api = 0;
  const flaky = harness((url) => (isToken(url) ? token() : ++api === 1 ? { status: 503 } : api === 2 ? new Error("socket hang up") : { body: [{ id: 3 }] }));
  assert.deepEqual(await createIgdbClient({ clientId: ID, clientSecret: SECRET, ...flaky }).query("games", "fields id;"), [{ id: 3 }]);
  const down = harness((url) => (isToken(url) ? token() : { status: 502 }));
  await assert.rejects(createIgdbClient({ clientId: ID, clientSecret: SECRET, maxAttempts: 3, ...down }).query("games", "fields id;"), (e) => e.kind === "unavailable" && e.status === 502);
  assert.equal(down.calls.filter((c) => !isToken(c.url)).length, 3);
});

test("a refused query (400) isn't retried", async () => {
  const h = harness((url) => (isToken(url) ? token() : { status: 400, body: [{ title: "Syntax Error" }] }));
  await assert.rejects(createIgdbClient({ clientId: ID, clientSecret: SECRET, ...h }).query("games", "fields id"), (e) => e.kind === "query");
  assert.equal(h.calls.filter((c) => !isToken(c.url)).length, 1);
});

test("never more than the per-second limit started in any second, and never above IGDB's 4", async () => {
  const h = harness((url) => (isToken(url) ? token() : { body: [] }));
  const igdb = createIgdbClient({ clientId: ID, clientSecret: SECRET, perSecond: 4, maxOpen: 8, ...h });
  await Promise.all(Array.from({ length: 25 }, () => igdb.query("games", "fields id;")));
  const starts = h.calls.map((c) => c.at);
  for (const s of starts) assert.ok(starts.filter((x) => x >= s && x < s + 1000).length <= 4, `more than 4 requests began within a second of ${s}`);
  assert.ok(igdb.stats.maxPerSecondSeen <= 4);
  assert.throws(() => createIgdbClient({ clientId: ID, clientSecret: SECRET, perSecond: 5 }), /perSecond/);
  assert.throws(() => createIgdbClient({ clientId: ID, clientSecret: SECRET, maxOpen: 9 }), /maxOpen/);
});

test("never more open requests than allowed", async () => {
  let open = 0;
  let peak = 0;
  let t = 0;
  const fetchImpl = async (url) => {
    if (isToken(url)) return { ok: true, status: 200, headers: { get: () => null }, json: async () => token().body };
    open++;
    peak = Math.max(peak, open);
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    open--;
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => [] };
  };
  const igdb = createIgdbClient({ clientId: ID, clientSecret: SECRET, perSecond: 4, maxOpen: 2, fetchImpl, now: () => t, sleep: async (ms) => (t += ms) });
  await Promise.all(Array.from({ length: 12 }, () => igdb.query("games", "fields id;")));
  assert.ok(peak <= 2, `peak ${peak}`);
});

test("another API address is accepted only on loopback, and credentials are required", () => {
  assert.throws(() => createIgdbClient({ clientId: ID, clientSecret: SECRET, apiUrl: "https://example.com/v4" }), /loopback/);
  assert.doesNotThrow(() => createIgdbClient({ clientId: ID, clientSecret: SECRET, apiUrl: "http://127.0.0.1:9999/v4" }));
  assert.throws(() => createIgdbClient({ clientId: "", clientSecret: SECRET }), (e) => e.kind === "config");
});

test("Apicalypse strings are quoted safely", () => {
  assert.equal(apicalypseString('Say "hi" \\ bye'), '"Say \\"hi\\" \\\\ bye"');
});

// ---- credentials ------------------------------------------------------------------

test("credentials: environment first, then a file outside the repository; values never described", () => {
  const dir = mkdtempSync(join(tmpdir(), "mgd-igdb-"));
  const file = join(dir, "igdb.env");
  writeFileSync(file, `# synthetic\nIGDB_CLIENT_ID=${ID}\nIGDB_CLIENT_SECRET="${SECRET}"\n`);
  const fromFile = loadIgdbCredentials({ env: {}, file });
  assert.equal(fromFile.ok, true);
  assert.equal(fromFile.source, "file");
  const text = describeIgdbConfig(fromFile);
  assert.ok(!text.includes(ID) && !text.includes(SECRET));
  const fromEnv = loadIgdbCredentials({ env: { IGDB_CLIENT_ID: ID, IGDB_CLIENT_SECRET: SECRET }, file: join(dir, "absent.env") });
  assert.equal(fromEnv.source, "environment");
  assert.deepEqual(parseEnvFile("A=1\nexport B='2'\n#C=3"), { A: "1", B: "2" });
});

test("credentials: a file inside the repository is refused, and missing or malformed ones are explained without values", () => {
  const inside = loadIgdbCredentials({ env: {}, file: join(process.cwd(), "igdb.env") });
  assert.equal(inside.ok, false);
  assert.ok(inside.problems.some((p) => p.includes("inside the repository")));
  const bad = loadIgdbCredentials({ env: { IGDB_CLIENT_ID: "short", IGDB_CLIENT_SECRET: "has spaces in it!" }, file: null });
  assert.equal(bad.ok, false);
  const text = describeIgdbConfig(bad);
  assert.ok(!text.includes("short") && !text.includes("has spaces"));
  assert.match(text, /check --live/);
});

// ---- matching -----------------------------------------------------------------------

const game = (over = {}) => ({
  id: "g1",
  slug: "space-quest-zero",
  title: "Space Quest Zero",
  aliases: ["Uchuu Kuesuto Zero"],
  platforms: ["snes"],
  first_release_date: "1992-04-01",
  wikidata_igdb: ["space-quest-zero"],
  linked: null,
  ...over,
});
const record = (over = {}) => ({
  id: 100,
  slug: "space-quest-zero",
  name: "Space Quest Zero",
  game_type: { type: "Main Game" },
  platforms: [{ id: 19, name: "Super Nintendo Entertainment System" }],
  first_release_date: Date.UTC(1992, 3, 1) / 1000,
  alternative_names: [],
  ...over,
});

test("matched (tier A) only when anchored by Wikidata and title, platform, date and type agree", () => {
  const d = decide(game(), [record()]);
  assert.equal(d.decision, "matched");
  assert.equal(d.tier, "A");
  assert.equal(d.igdb_id, "100");
  assert.equal(d.confidence, "high");
  assert.deepEqual(d.notes.checks, { anchor: true, title: true, platforms: true, date: true, type: true });
});

test("never matched on title, platform and date alone: no Wikidata anchor stays for review", () => {
  const d = decide(game({ wikidata_igdb: [] }), [record()]);
  assert.equal(d.decision, "review");
  assert.equal(d.confidence, "probable");
  assert.equal(d.suggestion, "100");
  assert.equal(decide(game({ wikidata_igdb: [] }), []).decision, "none");
});

test("a remake, remaster, port or bundle under the anchored slug isn't matched", () => {
  for (const type of ["Remake", "Remaster", "Port", "Bundle"]) {
    const d = decide(game(), [record({ game_type: { type } })]);
    assert.equal(d.decision, "review", type);
    assert.ok(d.reasons.some((r) => r.includes("type")), type);
  }
  assert.equal(gameType({ category: 8 }), "remake");
});

test("no platform in common, or first releases years apart, stays for review", () => {
  assert.equal(decide(game(), [record({ platforms: [{ id: 7 }] })]).decision, "review");
  const late = decide(game(), [record({ first_release_date: Date.UTC(1999, 0, 1) / 1000 })]);
  assert.equal(late.decision, "review");
  assert.ok(late.reasons.some((r) => r.includes("first release")));
  assert.equal(decide(game(), [record({ first_release_date: Date.UTC(1993, 5, 1) / 1000 })]).decision, "matched", "a year apart is the same release window");
});

test("a different title under the anchored slug stays for review; an alternative or localized name matches", () => {
  assert.equal(decide(game(), [record({ name: "Space Quest Zero: Director's Cut" })]).decision, "review");
  const alt = decide(game(), [record({ name: "Space Quest Zero Version", alternative_names: [{ name: "Space Quest Zero" }] })]);
  assert.equal(alt.decision, "matched");
  assert.equal(decide(game({ title: "Uchuu Kuesuto Zero", aliases: ["Space Quest Zero"] }), [record()]).decision, "matched", "an alias matches IGDB's name");
  assert.equal(normalizeTitle("The Legend of Zélda: Link’s Awakening"), "legend of zelda links awakening");
});

test("two anchors: matched when the other is a remake on other platforms, with a note; ambiguous when both pass or one is missing", () => {
  const remake = record({ id: 200, slug: "space-quest-zero--1", game_type: { type: "Remake" }, platforms: [{ id: 167 }] });
  const d = decide(game({ wikidata_igdb: ["space-quest-zero", "space-quest-zero--1"] }), [record(), remake]);
  assert.equal(d.decision, "matched");
  assert.equal(d.notes.other_anchors[0].slug, "space-quest-zero--1");
  const twin = record({ id: 201, slug: "space-quest-zero--2" });
  assert.equal(decide(game({ wikidata_igdb: ["space-quest-zero", "space-quest-zero--2"] }), [record(), twin]).confidence, "ambiguous");
  const gone = decide(game({ wikidata_igdb: ["space-quest-zero", "space-quest-zero--9"] }), [record()]);
  assert.equal(gone.decision, "review");
  assert.equal(gone.confidence, "ambiguous");
});

test("an anchor IGDB doesn't know, or a game already linked to another id, stays for review", () => {
  assert.equal(decide(game(), []).decision, "review");
  const linked = decide(game({ linked: "999" }), [record()]);
  assert.equal(linked.decision, "review");
  assert.equal(decide(game({ linked: "100" }), [record()]).decision, "matched", "already linked to the same id");
});

test("platforms the catalog lists but IGDB doesn't are noted, not hidden", () => {
  const c = checkCandidate(game({ platforms: ["nes", "snes"] }), record());
  assert.deepEqual(c.platforms_not_on_igdb, ["nes"]);
  assert.equal(decide(game({ platforms: ["nes", "snes"] }), [record()]).notes.platforms_not_on_igdb[0], "nes");
});

test("the stored payload: bounded, dated, companies split by role, only valid image ids", () => {
  const p = toPayload(
    record({
      summary: "x".repeat(5000),
      genres: [{ name: "Platform" }, { name: "Platform" }],
      involved_companies: [
        { developer: true, publisher: false, company: { name: "Studio A" } },
        { developer: false, publisher: true, company: { name: "Publisher B" } },
      ],
      cover: { image_id: "co1abc", width: 264, height: 374 },
      screenshots: [{ image_id: "sc1" }, { image_id: "../bad" }],
    }),
    "2026-11-26T00:00:00.000Z",
  );
  assert.equal(p.id, "100");
  assert.equal(p.summary.length, 4000);
  assert.deepEqual(p.genres, ["Platform"]);
  assert.deepEqual(p.developers, ["Studio A"]);
  assert.deepEqual(p.publishers, ["Publisher B"]);
  assert.equal(p.first_release_date, "1992-04-01");
  assert.deepEqual(p.cover, { image_id: "co1abc", width: 264, height: 374 });
  assert.equal(p.screenshots.length, 1);
  assert.equal(p.url, "https://www.igdb.com/games/space-quest-zero");
  assert.ok(JSON.stringify(p).length < 32768);
});

// ---- the app's platform rule (src/features/catalog/provider-images.ts) -----------------

test("the app's platform map is the matcher's", async () => {
  const { IGDB_PLATFORM_IDS } = await import("../src/features/catalog/provider-images.ts");
  const { PLATFORM_IDS } = await import("./lib/igdb-match.mjs");
  assert.deepEqual({ ...IGDB_PLATFORM_IDS }, PLATFORM_IDS);
});

test("a game-level cover stands only on a platform IGDB lists for the game", async () => {
  const { coverFitsPlatform } = await import("../src/features/catalog/provider-images.ts");
  // Listed on the SNES (19) only, like a game Wikidata also pairs with a later GBA port.
  assert.equal(coverFitsPlatform([19], "snes"), true);
  assert.equal(coverFitsPlatform([19], "game-boy-advance"), false, "never the SNES cover on the GBA page");
  assert.equal(coverFitsPlatform([19], "atari-lynx"), false, "a platform outside the map: the fallback");
  assert.equal(coverFitsPlatform([19], null), false);
  assert.equal(coverFitsPlatform([], "snes"), false);
});
