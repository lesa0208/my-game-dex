// Run with: npm run wishlist:test. M12 W2: how wishes are worded and how the forms and
// URLs are read. scripts/app-wishlist-checks.mjs tests the running app against the database.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { levelOf, minimumLabel, MINIMUMS, ownedLine, readDetails, readTarget, sameTarget, stateNotice, targetLine, tidyNote, wishErrorMessage } from "./format.ts";
import { DEFAULT_WISHLIST_PARAMS, readWishlistParams, wishHref, wishlistHref } from "./params.ts";

const G = "0190a0b0-0000-7000-8000-000000000001";
const P = "0190a0b0-0000-7000-8000-000000000002";
const R = "0190a0b0-0000-7000-8000-000000000003";
const snes = { slug: "snes", name: "Super Nintendo Entertainment System", short_name: "SNES" };
const pal = { code: "pal", label: "PAL" };
const item = (extra = {}) => ({ kind: "game", platform: null, region: null, release: null, state: "available", merged: false, duplicate: false, completeness: null, owned: { copies: 0, meeting_completeness: 0 }, ...extra });
const form = (fields) => (name) => fields[name] ?? "";

test("the four levels are told apart, and a preference never reads as a known release", () => {
  assert.equal(levelOf(item()), "game");
  assert.equal(targetLine(item()), "Any physical version");
  assert.equal(levelOf(item({ platform: snes })), "platform");
  assert.equal(targetLine(item({ platform: snes })), "SNES · any region");
  assert.equal(levelOf(item({ platform: snes, region: pal })), "region");
  assert.equal(targetLine(item({ platform: snes, region: pal })), "SNES · PAL · any edition");
  const exact = item({ kind: "release", platform: snes, region: pal, release: { edition_kind: "collector", edition_name: "Collector's Edition", variant_name: "Red" } });
  assert.equal(levelOf(exact), "release");
  assert.equal(targetLine(exact), "SNES · PAL · Collector's Edition · Red");
});

test("completeness is a minimum, ranked as the database ranks it", () => {
  assert.deepEqual(MINIMUMS.map((m) => m.value), ["loose", "incomplete", "complete", "sealed"]);
  assert.equal(minimumLabel(null), "Any completeness");
  assert.equal(minimumLabel("complete"), "Complete in box or better");
  assert.equal(minimumLabel("sealed"), "Sealed only");
  const sql = readFileSync(join(import.meta.dirname, "..", "..", "..", "supabase", "migrations", "20261207100000_m12w1_wishlist.sql"), "utf8");
  assert.match(sql, /when 'loose' then 1 when 'incomplete' then 2 when 'complete' then 3 when 'sealed' then 4/);
});

test("ownership: copies of the exact release, or matching ones; unknown completeness doesn't meet a minimum", () => {
  assert.equal(ownedLine(item()).headline, "You don't own a matching copy yet");
  assert.equal(ownedLine(item({ kind: "release" })).headline, "You don't own this release yet");
  assert.equal(ownedLine(item({ kind: "release", owned: { copies: 2, meeting_completeness: 2 } })).headline, "You own 2 copies of this release");
  const partial = ownedLine(item({ completeness: "complete", owned: { copies: 3, meeting_completeness: 1 } }));
  assert.equal(partial.headline, "You own 3 copies that match");
  assert.match(partial.detail, /^1 of them meets your minimum \(Complete in box\)\. Copies with no completeness recorded don't count\.$/);
  assert.match(ownedLine(item({ completeness: "loose", owned: { copies: 1, meeting_completeness: 1 } })).detail, /^It meets your minimum/);
  assert.equal(ownedLine(item({ owned: { copies: 4, meeting_completeness: 4 } })).detail, null, "no minimum, nothing to meet");
});

test("catalog changes are said, and the original wish is kept", () => {
  assert.equal(stateNotice(item()), null);
  assert.match(stateNotice(item({ kind: "release", state: "unavailable" })).text, /no longer in the catalog.*kept as you made it/);
  assert.match(stateNotice(item({ state: "platform_unavailable", platform: snes })).text, /no longer lists this game on Super Nintendo/);
  assert.match(stateNotice(item({ merged: true })).text, /merged/);
  assert.match(stateNotice(item({ duplicate: true, merged: true })).text, /another of your wishes/);
});

test("a form's target is read by its level; other levels' fields are ignored", () => {
  assert.deepEqual(readTarget(form({ level: "game", game_id: G, platform_id: P, region_code: "pal", release_id: R })), { target: { game_id: G } });
  assert.deepEqual(readTarget(form({ level: "platform", game_id: G, platform_id: P, region_code: "pal" })), { target: { game_id: G, platform_id: P } });
  assert.deepEqual(readTarget(form({ level: "region", game_id: G, platform_id: P, region_code: "pal" })), { target: { game_id: G, platform_id: P, region_code: "pal" } });
  assert.deepEqual(readTarget(form({ level: "release", game_id: G, release_id: R })), { target: { release_id: R } });
  assert.ok("error" in readTarget(form({ level: "region", game_id: G, platform_id: P })), "a region level needs a region");
  assert.ok("error" in readTarget(form({ level: "region", game_id: G, platform_id: P, region_code: "unknown" })), "never the unknown region");
  assert.ok("error" in readTarget(form({ level: "platform", game_id: G })), "a platform level needs a platform");
  assert.ok("error" in readTarget(form({ level: "release", release_id: "not-an-id" })));
  assert.ok("error" in readTarget(form({ level: "owner", game_id: G })));
  assert.ok(sameTarget({ game_id: G, platform_id: P }, { platform_id: P, game_id: G }));
  assert.ok(!sameTarget({ game_id: G }, { game_id: G, platform_id: P }));
});

test("details: priority 1 to 3, a known minimum, a tidy note up to 500 characters", () => {
  assert.deepEqual(readDetails(form({})), { details: { priority: 2, completeness: null, note: null } });
  assert.deepEqual(readDetails(form({ priority: "1", completeness: "sealed", note: "  Only\r\nboxed \n" })), { details: { priority: 1, completeness: "sealed", note: "Only\nboxed" } });
  assert.ok("error" in readDetails(form({ priority: "4" })));
  assert.ok("error" in readDetails(form({ completeness: "mint" })));
  assert.ok("error" in readDetails(form({ note: "x".repeat(501) })));
  assert.ok(!("error" in readDetails(form({ note: "é".repeat(500) }))));
  assert.ok("error" in readDetails(form({ note: "a\u0007b" })));
  assert.equal(tidyNote("   \n "), null, "an empty note clears it");
});

test("refusals get fixed messages, never the database's text", () => {
  assert.equal(wishErrorMessage("not permitted").signedOut, true);
  assert.equal(wishErrorMessage("request conflict").renewId, true);
  assert.match(wishErrorMessage("already on wishlist").text, /already wants exactly that/);
  assert.match(wishErrorMessage("platform unavailable").text, /doesn't list this game on that platform/);
  assert.equal(wishErrorMessage('duplicate key value violates unique constraint "x"').text, "Your wishlist couldn't be changed. Try again.");
});

test("the list's URL: checked values only, defaults left out", () => {
  assert.deepEqual(readWishlistParams({}), DEFAULT_WISHLIST_PARAMS);
  const params = readWishlistParams({ q: " Star ", platform: "snes", region: "pal", priority: "1", sort: "title", after: "abc_-1" });
  assert.deepEqual(params, { query: "Star", platform: "snes", region: "pal", priority: 1, sort: "title", cursor: "abc_-1" });
  assert.deepEqual(readWishlistParams({ platform: "SNES;drop", region: "unknown", priority: "9", sort: "price", after: "a b" }), DEFAULT_WISHLIST_PARAMS);
  assert.equal(wishlistHref(DEFAULT_WISHLIST_PARAMS), "/collection/wishlist");
  assert.equal(wishlistHref({ ...DEFAULT_WISHLIST_PARAMS, sort: "added" }, "removed"), "/collection/wishlist?sort=added&notice=removed");
  assert.equal(wishHref(G, { ...DEFAULT_WISHLIST_PARAMS, priority: 2 }), `/collection/wishlist/${G}?priority=2`);
});

test("writes go only through W1's functions: no table writes, no owner from a form", () => {
  const actions = readFileSync(join(import.meta.dirname, "actions.ts"), "utf8");
  assert.ok(!/\.from\("wishlist_items"\)/.test(actions), "no direct table access");
  for (const fn of ["add_wishlist_item", "update_wishlist_item", "remove_wishlist_item"]) assert.ok(actions.includes(`"${fn}"`));
  assert.ok(!/owner_id|p_owner/.test(actions), "the owner is never sent");
  const queries = readFileSync(join(import.meta.dirname, "queries.ts"), "utf8");
  assert.ok(!/SECRET_KEY|service_role/i.test(actions + queries), "no secret key");
});
