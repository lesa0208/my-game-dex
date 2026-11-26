/**
 * Matching IGDB games to existing catalog identities (M18a). Pure: no network, no database.
 *
 * A match is accepted (tier A) only when it is anchored and every check agrees:
 *   - anchor: the IGDB game is one Wikidata states for this identity (P5794, IGDB game ID);
 *   - title: IGDB's name, or one of its alternative or localized names, is the game's title or
 *     one of its aliases (normalized: case, accents, punctuation, a leading "The");
 *   - platforms: at least one of the game's platforms is one of IGDB's for it;
 *   - date: the first release years differ by at most one, when both are known;
 *   - type: IGDB calls it a main game (or an expanded game), not a remake, remaster, port,
 *     bundle, expansion, DLC, mod, episode, season, pack, update or fork.
 * Anything else stays unresolved, for review, with its reasons: no anchor (never matched on
 * title, platform and date alone), an anchor IGDB doesn't know, several anchors that all pass,
 * a failed check, or a game already linked to another IGDB id. Nothing is merged or created.
 */

/** Our platform slugs to IGDB platform ids. Checked against IGDB by `node scripts/igdb.mjs platforms`. */
export const PLATFORM_IDS = {
  nes: 18,
  snes: 19,
  "mega-drive": 29,
  "game-boy": 33,
  "game-boy-color": 22,
  "game-boy-advance": 24,
  "nintendo-64": 4,
  playstation: 7,
  "playstation-2": 8,
  "sega-saturn": 32,
};
/** IGDB's names for them, as the platforms check expects. */
export const PLATFORM_NAMES = {
  18: "Nintendo Entertainment System",
  19: "Super Nintendo Entertainment System",
  29: "Sega Mega Drive/Genesis",
  33: "Game Boy",
  22: "Game Boy Color",
  24: "Game Boy Advance",
  4: "Nintendo 64",
  7: "PlayStation",
  8: "PlayStation 2",
  32: "Sega Saturn",
};

// IGDB's deprecated numeric category, for records without game_type.
const CATEGORY = ["main_game", "dlc_addon", "expansion", "bundle", "standalone_expansion", "mod", "episode", "season", "remake", "remaster", "expanded_game", "port", "fork", "pack", "update"];
const ACCEPTED_TYPES = new Set(["main_game", "expanded_game"]);

/** "Main Game" / "main_game" / 0 → "main_game". */
export function gameType(record) {
  const named = record?.game_type?.type ?? (typeof record?.game_type === "string" ? record.game_type : null);
  if (named) return String(named).trim().toLowerCase().replace(/[^a-z]+/g, "_").replace(/^_|_$/g, "");
  if (Number.isInteger(record?.category)) return CATEGORY[record.category] ?? `category_${record.category}`;
  return null;
}

/** For comparing titles: case, accents, "&", punctuation, spacing and a leading "The" don't count. */
export function normalizeTitle(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/^the /, "");
}

/** IGDB first_release_date is Unix seconds (UTC). */
export function igdbDate(seconds) {
  if (!Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

function yearOf(date) {
  const m = /^(\d{4})/.exec(String(date ?? ""));
  return m ? Number(m[1]) : null;
}

/** The checks for one candidate against one game. */
export function checkCandidate(game, record) {
  const ours = new Set([game.title, ...(game.aliases ?? [])].map(normalizeTitle).filter(Boolean));
  const theirs = [record.name, ...(record.alternative_names ?? []).map((a) => a?.name ?? a), ...(record.game_localizations ?? []).map((l) => l?.name ?? l)]
    .map(normalizeTitle)
    .filter(Boolean);
  const titleHit = theirs.find((t) => ours.has(t));
  const ourPlatforms = (game.platforms ?? []).map((slug) => ({ slug, id: PLATFORM_IDS[slug] ?? null }));
  const theirPlatforms = new Set((record.platforms ?? []).map((p) => (typeof p === "object" ? p.id : p)));
  const shared = ourPlatforms.filter((p) => p.id && theirPlatforms.has(p.id)).map((p) => p.slug);
  const notOnIgdb = ourPlatforms.filter((p) => !p.id || !theirPlatforms.has(p.id)).map((p) => p.slug);
  const ourYear = yearOf(game.first_release_date);
  const theirDate = igdbDate(record.first_release_date);
  const theirYear = yearOf(theirDate);
  const type = gameType(record);
  const anchored = (game.wikidata_igdb ?? []).includes(record.slug);
  const checks = {
    anchor: anchored,
    title: Boolean(titleHit),
    platforms: shared.length > 0,
    date: ourYear == null || theirYear == null ? null : Math.abs(ourYear - theirYear) <= 1,
    type: type == null ? null : ACCEPTED_TYPES.has(type),
  };
  return {
    igdb_id: String(record.id),
    slug: record.slug,
    name: record.name,
    type,
    checks,
    shared_platforms: shared,
    platforms_not_on_igdb: notOnIgdb,
    our_year: ourYear,
    igdb_date: theirDate,
    passes: checks.anchor && checks.title && checks.platforms && checks.date !== false && checks.type !== false,
  };
}

function failures(c) {
  const out = [];
  if (!c.checks.title) out.push(`title differs ("${c.name}")`);
  if (!c.checks.platforms) out.push("no platform in common");
  if (c.checks.date === false) out.push(`first release ${c.igdb_date} vs ${c.our_year}`);
  if (c.checks.type === false) out.push(`IGDB type is ${c.type}`);
  return out;
}

/**
 * The decision for one game. records: IGDB games fetched for it (its anchors' slugs, and any
 * search results). Returns { decision: "matched" | "review" | "none", tier, igdb_id, confidence,
 * reasons, candidates, notes }.
 */
export function decide(game, records) {
  const anchors = [...new Set(game.wikidata_igdb ?? [])];
  const unique = [...new Map((records ?? []).map((r) => [String(r.id), r])).values()];
  const candidates = unique.map((r) => checkCandidate(game, r));
  const anchored = candidates.filter((c) => c.checks.anchor);
  const missing = anchors.filter((slug) => !anchored.some((c) => c.slug === slug));
  const base = { game: game.slug, title: game.title, anchors, candidates, notes: {} };

  if (game.linked) {
    const same = anchored.find((c) => c.igdb_id === game.linked);
    if (!same) return { ...base, decision: "review", tier: null, igdb_id: null, confidence: "none", reasons: [`already linked to IGDB ${game.linked}, which isn't a passing anchor`] };
  }
  if (!anchors.length) {
    const plausible = candidates.filter((c) => c.checks.title && c.checks.platforms && c.checks.date !== false && c.checks.type !== false);
    return {
      ...base,
      decision: candidates.length ? "review" : "none",
      tier: null,
      igdb_id: null,
      confidence: plausible.length === 1 ? "probable" : "low",
      suggestion: plausible.length === 1 ? plausible[0].igdb_id : null,
      reasons: ["Wikidata states no IGDB id: never matched on title, platform and date alone"],
    };
  }
  if (!anchored.length) {
    return { ...base, decision: "review", tier: null, igdb_id: null, confidence: "none", reasons: [`IGDB has no game with the slug Wikidata states (${anchors.join(", ")})`] };
  }
  const passing = anchored.filter((c) => c.passes);
  if (passing.length === 1) {
    const chosen = passing[0];
    const others = anchored.filter((c) => c !== chosen);
    // Another anchor that fails only on type (a remake or a port of the same title) or platform is
    // a different game; one that fails only on date, or isn't fetched, leaves it ambiguous.
    const ambiguous = others.filter((c) => c.checks.platforms && c.checks.type !== false).concat(missing.length ? [{ missing }] : []);
    if (ambiguous.length) {
      return {
        ...base,
        decision: "review",
        tier: null,
        igdb_id: null,
        confidence: "ambiguous",
        suggestion: chosen.igdb_id,
        reasons: [`Wikidata states ${anchors.length} IGDB ids and they can't be told apart: ${anchors.join(", ")}`],
      };
    }
    const notes = {
      anchors,
      checks: chosen.checks,
      shared_platforms: chosen.shared_platforms,
      ...(chosen.platforms_not_on_igdb.length ? { platforms_not_on_igdb: chosen.platforms_not_on_igdb } : {}),
      ...(others.length ? { other_anchors: others.map((c) => ({ igdb_id: c.igdb_id, slug: c.slug, why_not: failures(c) })) } : {}),
      igdb_first_release: chosen.igdb_date,
      matcher: "m18a-1",
    };
    return { ...base, decision: "matched", tier: "A", igdb_id: chosen.igdb_id, confidence: "high", reasons: [], notes };
  }
  if (passing.length > 1) {
    return { ...base, decision: "review", tier: null, igdb_id: null, confidence: "ambiguous", reasons: [`${passing.length} IGDB games pass every check: ${passing.map((c) => c.slug).join(", ")}`] };
  }
  return { ...base, decision: "review", tier: null, igdb_id: null, confidence: "low", reasons: anchored.flatMap((c) => failures(c).map((f) => `${c.slug}: ${f}`)) };
}

/** IGDB's record as the catalog keeps it: the fields M18a uses, bounded, with the time it was fetched. */
export function toPayload(record, fetchedAt) {
  const names = (list, limit) => [...new Set((list ?? []).map((x) => (typeof x === "object" ? x?.name : x)).filter((x) => typeof x === "string" && x.trim()))].slice(0, limit);
  const image = (i) => (i && /^[a-z0-9]{1,40}$/.test(i.image_id ?? "") ? { image_id: i.image_id, width: i.width ?? null, height: i.height ?? null } : null);
  const companies = (flag) => names((record.involved_companies ?? []).filter((c) => c?.[flag]).map((c) => c.company?.name), 8);
  const payload = {
    id: String(record.id),
    slug: record.slug ?? null,
    name: record.name ?? null,
    url: record.url ?? (record.slug ? `https://www.igdb.com/games/${record.slug}` : null),
    summary: typeof record.summary === "string" ? record.summary.slice(0, 4000) : null,
    game_type: gameType(record),
    first_release_date: igdbDate(record.first_release_date),
    platforms: names(record.platforms, 30),
    platform_ids: (record.platforms ?? []).map((p) => (typeof p === "object" ? p.id : p)).filter(Number.isInteger).slice(0, 30),
    genres: names(record.genres, 12),
    themes: names(record.themes, 12),
    developers: companies("developer"),
    publishers: companies("publisher"),
    alternative_names: names(record.alternative_names, 30),
    cover: image(record.cover),
    screenshots: (record.screenshots ?? []).map(image).filter(Boolean).slice(0, 8),
    artworks: (record.artworks ?? []).map(image).filter(Boolean).slice(0, 4),
    fetched_at: fetchedAt,
    source: "IGDB API v4",
  };
  return payload;
}

/** The fields one query asks for, every game. */
export const GAME_FIELDS = [
  "id", "slug", "name", "url", "summary", "first_release_date", "category", "game_type.type",
  "platforms.id", "platforms.name", "genres.name", "themes.name",
  "involved_companies.developer", "involved_companies.publisher", "involved_companies.company.name",
  "alternative_names.name", "game_localizations.name",
  "cover.image_id", "cover.width", "cover.height",
  "screenshots.image_id", "screenshots.width", "screenshots.height",
  "artworks.image_id", "artworks.width", "artworks.height",
].join(",");
