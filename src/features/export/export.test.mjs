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

test("statuses match the collection pages", () => {
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
  assert.equal(EXPORT_VERSION, 1);
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
