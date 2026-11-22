// Run with: npm run export:test. The personal data export (M11a-4a): how each record is
// shaped, what is never in it, and that it reads only as the person.
// scripts/app-export-checks.mjs tests the running app against the database.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  copyStatus,
  EXPORT_FORMAT,
  EXPORT_NOTICE,
  EXPORT_VERSION,
  exportError,
  exportFilename,
  NOT_INCLUDED,
  shapeCopy,
  shapeFactors,
  shapePreferences,
  shapeProfile,
  shapeSubmission,
  shapeWish,
} from "./format.ts";

const src = join(import.meta.dirname, "..", "..");
const read = (...parts) => readFileSync(join(src, ...parts), "utf8");

const lookups = () => ({
  releases: new Map([["r1", { id: "r1", game_id: "g1", platform_id: "p1", region_code: "PAL", media_format_code: "dvd", status: "published", product_code: "SLES-1", barcode: "5012345678900", edition_name: "Platinum", packaging: "Keep case" }]]),
  games: new Map([["g1", { id: "g1", slug: "a-game", title: "A Game", kind: "main_game", status: "published" }]]),
  platforms: new Map([["p1", { id: "p1", slug: "ps2", name: "PlayStation 2", short_name: "PS2" }]]),
  regions: new Map([["PAL", { code: "PAL", label: "PAL" }]]),
  formats: new Map([["dvd", { code: "dvd", name: "DVD" }]]),
  preserved: new Map([["c3", { title: "Gone Game", platform: { slug: "ps2" }, region: { code: "PAL" }, edition_name: null, variant_name: null, local_title: null }]]),
});
const item = (id, extra = {}) => ({ id, release_id: "r1", record_status: "active", visibility: "private", created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-02T00:00:00Z", completeness: "complete", overall_condition: "good", box_condition: "good", media_condition: "very_good", manual_condition: null, ...extra });

test("a copy carries its release, game, platform, region, edition, identifiers, pieces and private details", () => {
  const copy = shapeCopy(item("c1"), { item_id: "c1", acquired_on: "2020-05-01", purchase_price: "19.9900", currency: "EUR", notes: "From a fair", storage_location: "Shelf 2" }, [
    { kind: "manual", label: "Manual", condition: "good" },
    { kind: "insert", label: "Poster", condition: null },
  ], lookups());
  assert.equal(copy.status, "owned");
  assert.deepEqual(copy.game, { id: "g1", slug: "a-game", title: "A Game", kind: "main_game" });
  assert.equal(copy.release.platform.name, "PlayStation 2");
  assert.deepEqual(copy.release.region, { code: "PAL", label: "PAL" });
  assert.equal(copy.release.edition_name, "Platinum");
  assert.deepEqual(copy.release.identifiers, { product_code: "SLES-1", barcode: "5012345678900" });
  assert.deepEqual(copy.private, { acquired_on: "2020-05-01", price: { amount: "19.9900", currency: "EUR" }, storage_location: "Shelf 2", notes: "From a fair" });
  assert.deepEqual(copy.components.map((c) => c.kind), ["insert", "manual"], "in a stable order");
  assert.deepEqual(copy.conditions, { overall: "good", box: "good", media: "very_good", manual: null });
});

test("two copies of one release are two entries; a copy without private details says so", () => {
  const l = lookups();
  const a = shapeCopy(item("c1"), undefined, [], l);
  const b = shapeCopy(item("c2"), undefined, [], l);
  assert.notEqual(a.id, b.id);
  assert.equal(a.release.id, b.release.id);
  assert.equal(a.private, null);
});

test("copies on releases the catalog no longer shows keep what the person may still see", () => {
  const l = lookups();
  const preserved = shapeCopy(item("c3", { release_id: "gone", record_status: "invalid_preserved", invalidated_at: "2026-11-10T00:00:00Z" }), undefined, [], l);
  assert.equal(preserved.status, "invalid");
  assert.equal(preserved.release.status, "excluded");
  assert.equal(preserved.game.title, "Gone Game");
  const unknown = shapeCopy(item("c4", { release_id: "hidden" }), undefined, [], l);
  assert.deepEqual(unknown.release, { id: "hidden", status: "unavailable" });
  assert.equal(unknown.game, null);
});

test("an unidentified copy carries its claim, its game and no release (M12a)", () => {
  const l = lookups();
  const claim = shapeCopy(item("c5", { release_id: null, claimed_game_id: "g1", claimed_platform_id: "p1", claimed_region_code: "PAL", claimed_edition_kind: "reprint", claimed_edition_name: "Platinum" }), undefined, [], l);
  assert.equal(claim.status, "unidentified");
  assert.equal(claim.release, null);
  assert.equal(claim.game.title, "A Game");
  assert.deepEqual(claim.claim, { platform: { slug: "ps2", name: "PlayStation 2", short_name: "PS2" }, region: { code: "PAL", label: "PAL" }, edition_kind: "reprint", edition_name: "Platinum" });
  const unsure = shapeCopy(item("c6", { release_id: null, claimed_game_id: "g1", claimed_platform_id: "p1" }), undefined, [], l);
  assert.equal(unsure.claim.region, null, "an unknown region stays unknown");
  assert.equal(unsure.claim.edition_name, null, "and so does an unknown edition");
  l.preserved.set("c7", { title: "Gone Game", platform: { slug: "ps2" }, region: null, edition_name: "Platinum" });
  const preserved = shapeCopy(item("c7", { release_id: null, claimed_game_id: "gone", claimed_platform_id: "p1", record_status: "invalid_preserved" }), undefined, [], l);
  assert.equal(preserved.status, "invalid");
  assert.equal(preserved.game.title, "Gone Game", "a preserved claim keeps its game's title");
  assert.equal(shapeCopy(item("c1"), undefined, [], l).claim, null, "an identified copy has no claim");
});

test("a wish keeps what was wanted, its priority, minimum, note and dates, and how the catalog shows it (M12 W2)", () => {
  const l = lookups();
  const row = { id: "w1", release_id: null, game_id: "g1", platform_id: "p1", region_code: "PAL", completeness: "complete", priority: 1, note: "Boxed only", created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-03T00:00:00Z", owner_id: "u" };
  const shown = { id: "w1", state: "platform_unavailable", merged: false, duplicate: false, game: { id: "g1", title: "A Game", slug: "a-game" }, platform: { slug: "ps2" }, region: { code: "PAL", label: "PAL" }, release: null, owned: { copies: 2, meeting_completeness: 1 } };
  const wish = shapeWish(row, shown, l);
  assert.equal(wish.level, "region");
  assert.deepEqual(wish.wanted, { release_id: null, game_id: "g1", platform: { id: "p1", slug: "ps2", name: "PlayStation 2", short_name: "PS2" }, region: { code: "PAL", label: "PAL" } });
  assert.deepEqual(wish.priority, { value: 1, label: "high" });
  assert.equal(wish.minimum_completeness, "complete");
  assert.equal(wish.note, "Boxed only");
  assert.equal(wish.created_at, "2026-11-01T00:00:00Z");
  assert.equal(wish.updated_at, "2026-11-03T00:00:00Z");
  assert.equal(wish.catalog.state, "platform_unavailable");
  assert.ok(!("owner_id" in wish) && !("owned" in wish.catalog), "no owner id, and nothing derived from the collection");
  assert.equal(shapeWish({ ...row, platform_id: null, region_code: null }, undefined, l).level, "game");
  assert.equal(shapeWish({ ...row, region_code: null }, undefined, l).level, "platform");
  const exact = shapeWish({ ...row, release_id: "gone", game_id: null, platform_id: null, region_code: null }, { state: "unavailable", merged: false, release: { id: "gone" } }, l);
  assert.equal(exact.level, "release");
  assert.equal(exact.wanted.release_id, "gone", "an excluded release is still named as wanted");
  assert.equal(exact.catalog.state, "unavailable");
  assert.equal(shapeWish(row, undefined, l).catalog, null, "not matched to the catalog read: said, not guessed");
});

test("statuses match the collection pages", () => {
  assert.equal(copyStatus("active", undefined, true), "unidentified");
  assert.equal(copyStatus("invalid_preserved", undefined, true), "invalid");
  assert.equal(copyStatus("active", "published"), "owned");
  assert.equal(copyStatus("active", "unverified"), "pending");
  assert.equal(copyStatus("active", "rejected"), "not_approved");
  assert.equal(copyStatus("active", undefined), "invalid");
  assert.equal(copyStatus("invalid_preserved", "published"), "invalid");
});

test("an unpublished game's address isn't given out", () => {
  const l = lookups();
  l.games.set("g1", { ...l.games.get("g1"), status: "unverified" });
  assert.equal(shapeCopy(item("c1"), undefined, [], l).game.slug, null);
});

test("never a secret, a token, another account or an internal field", () => {
  const factors = shapeFactors([{ id: "f1", factor_type: "totp", status: "verified", friendly_name: "Phone", created_at: "2026-11-01", secret: "JBSWY3DPEHPK3PXP", totp: { qr_code: "data:...", secret: "X", uri: "otpauth://..." } }]);
  assert.deepEqual(factors, [{ type: "totp", status: "verified", name: "Phone", created_at: "2026-11-01" }]);
  assert.doesNotMatch(JSON.stringify(factors), /secret|otpauth|qr_code|f1/);
  assert.deepEqual(Object.keys(shapePreferences({ user_id: "u", locale: "en", theme: "dark" })), ["locale", "theme"]);
  assert.equal(shapePreferences(null), null);
  const profile = shapeProfile({ id: "u", handle: "mike", is_active: true, handle_correction_until: "x", display_name: "Mike" });
  assert.equal(profile.handle, "mike");
  assert.ok(!("is_active" in profile) && !("id" in profile));
  const sub = shapeSubmission({ id: "s1", kind: "new_release", status: "approved", reviewer_note: "Thanks", reviewed_by: "staff-id", editable: false, my_copies: 2, details: { title: "T" } });
  assert.ok(!("reviewed_by" in sub) && !("editable" in sub) && !("my_copies" in sub));
  assert.equal(sub.reviewer_note, "Thanks");
});

test("the file names the format, says what it isn't, and is named safely", () => {
  assert.equal(EXPORT_FORMAT, "my-game-dex-export");
  // M12a: version 2, as a copy may now be unidentified. M12 W2: version 3, with the wishlist.
  assert.equal(EXPORT_VERSION, 3);
  assert.match(EXPORT_NOTICE, /not a complete answer to a legal request/);
  assert.ok(NOT_INCLUDED.some((x) => /Notifications/.test(x)) && NOT_INCLUDED.some((x) => /never exported/.test(x)));
  const now = new Date("2026-11-18T23:59:00Z");
  assert.equal(exportFilename("mike_1985", now), "my-game-dex-mike_1985-2026-11-18.json");
  assert.equal(exportFilename('x"; evil', now), "my-game-dex-account-2026-11-18.json");
  assert.equal(exportFilename(null, now), "my-game-dex-account-2026-11-18.json");
  assert.match(exportError("export_too_many"), /three times/);
  assert.equal(exportError("toString"), null);
  assert.equal(exportError(null), null);
});

test("the export reads only as the person: no secret key, no Auth Admin, no id from the request", () => {
  const server = read("features", "export", "server.ts");
  const route = read("app", "(app)", "settings", "account", "export", "route.ts");
  for (const [name, text] of [["server.ts", server], ["route.ts", route]]) {
    assert.doesNotMatch(text, /SECRET_KEY|secretKey|service_role|auth\.admin|auth\/v1\/admin|createClient\(/, name);
  }
  assert.match(server, /^import "server-only";/);
  // The account is the verified token's subject; the request's body and query are never read.
  assert.match(route, /const userId = auth\?\.claims\?\.sub;/);
  assert.doesNotMatch(route, /request\.(formData|json|text)\(|searchParams\.get|nextUrl\.searchParams/);
  // Every collection read names the owner, on top of RLS.
  for (const table of ["collection_items", "collection_item_private", "collection_item_components"]) {
    assert.match(server, new RegExp(`from\\("${table}"\\)[^;]*\\.eq\\("owner_id", me\\)`), table);
  }
  assert.match(route, /"Cache-Control": "private, no-store, max-age=0"/);
  assert.match(route, /"X-Robots-Tag": "noindex/);
  assert.match(route, /take_request_slot", \{ p_kind: "data_export" \}/);
});
