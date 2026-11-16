// Run with: npm run editing:test. The catalog editing forms' rules (M10c), and that
// their lists match the database. scripts/app-editing-checks.mjs tests the running app,
// and supabase/tests/database/37_catalog_provenance.test.sql tests the database.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

import { EDITION_KIND_VALUES, GAME_KIND_VALUES } from "../review/form.ts";
import {
  ALIAS_KINDS,
  GAME_KINDS,
  LOCKABLE_FIELDS,
  RELATIONS,
  REQUIREMENT_LEVELS,
  draftKey,
  editErrorMessage,
  needsRecentVerification,
  readAlias,
  readGameFields,
  readLock,
  readMarkets,
  readRelation,
  readRequirements,
} from "./form.ts";

const migrations = new URL("../../../supabase/migrations/", import.meta.url);
const sql = readdirSync(migrations).sort().map((f) => readFileSync(new URL(f, migrations), "utf8")).join("\n");
const m10c = readFileSync(new URL("20261121100000_m10c_catalog_editing.sql", migrations), "utf8");

const form = (values) => (name) => values[name] ?? "";
const enumValues = (name) =>
  [...new RegExp(`create type public\\.${name} as enum \\(([^;]*)\\);`).exec(sql)[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
const values = (list) => list.map((x) => x.value);

test("the lists match the database's enums and review's lists", () => {
  assert.deepEqual(values(GAME_KINDS), enumValues("game_kind"));
  assert.deepEqual(values(GAME_KINDS), [...GAME_KIND_VALUES]);
  assert.deepEqual(values(ALIAS_KINDS), enumValues("game_alias_kind"));
  assert.deepEqual(values(RELATIONS), enumValues("game_relation_type"));
  assert.deepEqual([...values(REQUIREMENT_LEVELS)].sort(), [...enumValues("requirement_level")].sort());
  assert.ok(EDITION_KIND_VALUES.length > 0);
});

test("the lockable fields are the database's", () => {
  const body = /create function private\.lockable_field[\s\S]*?\$\$;/.exec(sql)[0];
  const game = [.../when 'game' then p_field = any \(array\[([^\]]*)\]/.exec(body)[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  const release = [.../when 'release' then p_field = any \(array\[([^\]]*)\]/.exec(body)[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...LOCKABLE_FIELDS.game], game);
  assert.deepEqual([...LOCKABLE_FIELDS.release], release);
});

test("a new game needs a title and a type; the sort title defaults to the title", () => {
  assert.equal(readGameFields(form({ kind: "game" }), null, 2026).error, "Enter the game's title.");
  assert.equal(readGameFields(form({ title: "Starfall", kind: "board" }), null, 2026).error, "Choose game, compilation or expansion.");
  assert.deepEqual(readGameFields(form({ title: "  The   Starfall ", kind: "game" }), null, 2026).value, { title: "The Starfall", sort_title: "The Starfall", kind: "game" });
  assert.deepEqual(readGameFields(form({ title: "The Starfall", sort_title: "Starfall, The", kind: "game", summary: "A quest.", first_release_year: "1993" }), null, 2026).value, {
    title: "The Starfall",
    sort_title: "Starfall, The",
    kind: "game",
    summary: "A quest.",
    first_release_date: "1993-01-01",
    first_release_precision: "year",
  });
  assert.match(readGameFields(form({ title: "X", kind: "game", first_release_year: "1949" }), null, 2026).error, /1950 to 2027/);
  assert.equal(readGameFields(form({ title: "x".repeat(201), kind: "game" }), null, 2026).error, "The title can be up to 200 characters.");
  assert.equal(readGameFields(form({ title: "X", kind: "game", summary: "y".repeat(2001) }), null, 2026).error, "The summary can be up to 2,000 characters.");
});

test("an edit sends only what changed, and keeps a precise date unless the year changes", () => {
  const current = { title: "Starfall", sort_title: "Starfall", kind: "game", summary: null, first_release_year: 1993 };
  assert.deepEqual(readGameFields(form({ title: "Starfall", kind: "game", first_release_year: "1993" }), current, 2026).value, {});
  assert.deepEqual(readGameFields(form({ title: "Starfall", kind: "game", first_release_year: "" }), current, 2026).value, { first_release_date: null, first_release_precision: "unknown" });
  assert.deepEqual(readGameFields(form({ title: "Starfall II", kind: "compilation", first_release_year: "1993", summary: "New." }), current, 2026).value, {
    title: "Starfall II",
    sort_title: "Starfall II",
    kind: "compilation",
    summary: "New.",
  });
});

test("markets are known two-letter codes, each once; an unchanged list sends nothing", () => {
  const known = ["CA", "JP", "US"];
  assert.deepEqual(readMarkets("us, ca us", known, []).value, ["CA", "US"]);
  assert.equal(readMarkets("CA US", known, ["US", "CA"]).value, null);
  assert.deepEqual(readMarkets("", known, ["US"]).value, []);
  assert.match(readMarkets("US, XX", known, []).error, /XX isn't a market code/);
});

test("hardware comes from the platform's list, once each, with a level", () => {
  const allowed = ["mvs-cart-board", "memory-card"];
  const rows = form({ requirement_0: "memory-card", requirement_level_0: "required", requirement_note_0: "  Saves  " });
  assert.deepEqual(readRequirements(rows, 3, allowed, []).value, [{ requirement_code: "memory-card", level: "required", note: "Saves" }]);
  assert.equal(readRequirements(rows, 3, allowed, [{ requirement_code: "memory-card", level: "required", note: "Saves" }]).value, null);
  assert.equal(readRequirements(form({ requirement_0: "light-gun", requirement_level_0: "required" }), 1, allowed, []).error, "Choose hardware from the list for this release's platform.");
  assert.equal(readRequirements(form({ requirement_0: "memory-card", requirement_level_0: "needed" }), 1, allowed, []).error, "Choose how each piece of hardware is needed.");
  assert.equal(
    readRequirements(form({ requirement_0: "memory-card", requirement_level_0: "required", requirement_1: "memory-card", requirement_level_1: "partial" }), 2, allowed, []).error,
    "Each piece of hardware is listed once.",
  );
  assert.deepEqual(readRequirements(form({}), 3, allowed, [{ requirement_code: "memory-card", level: "required", note: null }]).value, []);
});

test("an alias has a title, a kind, an optional language code and a known region", () => {
  assert.deepEqual(readAlias(form({ alias_title: " Hoshi ", alias_kind: "romanized", alias_language: "JA" }), ["ntsc-j"]).value, {
    title: "Hoshi",
    kind: "romanized",
    language: "ja",
    region: null,
  });
  assert.equal(readAlias(form({ alias_title: "Hoshi", alias_kind: "nickname" }), []).error, "Choose what kind of title it is.");
  assert.match(readAlias(form({ alias_title: "Hoshi", alias_kind: "alternate", alias_language: "japanese!" }), []).error, /language as a code/);
  assert.match(readAlias(form({ alias_title: "Hoshi", alias_kind: "alternate", alias_region: "unknown" }), ["unknown"]).error, /region from the list/);
});

test("a relation names another game's record and a known relation", () => {
  const self = "11111111-1111-4111-8111-111111111111";
  const other = "22222222-2222-4222-8222-222222222222";
  assert.deepEqual(readRelation(form({ target_id: other.toUpperCase(), relation: "remake_of" }), self).value, { target: other, relation: "remake_of", position: null, note: null });
  assert.equal(readRelation(form({ target_id: self, relation: "remake_of" }), self).error, "A game can't be related to itself.");
  assert.equal(readRelation(form({ target_id: "not-an-id", relation: "remake_of" }), self).error, "Enter the other game's record id, as shown on its record.");
  assert.equal(readRelation(form({ target_id: other, relation: "remake_of", position: "2" }), self).error, "Only a compilation's contents have a position.");
  assert.equal(readRelation(form({ target_id: other, relation: "contains", position: "1000" }), self).error, "The position is a number from 1 to 999.");
  assert.equal(readRelation(form({ target_id: other, relation: "contains", position: "3" }), self).value.position, 3);
});

test("only lockable fields can be locked", () => {
  assert.deepEqual(readLock(form({ entity: "game", field: "title", locked: "yes" })).value, { entity: "game", field: "title", locked: true });
  assert.deepEqual(readLock(form({ entity: "release", field: "markets", locked: "no" })).value, { entity: "release", field: "markets", locked: false });
  assert.equal(readLock(form({ entity: "release", field: "status", locked: "yes" })).error, "This field can't be locked.");
  assert.equal(readLock(form({ entity: "profile", field: "title" })).error, "This field can't be locked.");
});

test("verifying and publishing always need a recent verification; editing only a published record", () => {
  assert.equal(needsRecentVerification("verify", "under_review"), true);
  assert.equal(needsRecentVerification("publish", "under_review"), true);
  assert.equal(needsRecentVerification("edit", "published"), true);
  assert.equal(needsRecentVerification("edit", "under_review"), false);
  assert.equal(needsRecentVerification("edit", "unverified"), false);
});

test("a draft is kept per form and record", () => {
  assert.equal(draftKey("verify-game", "abc"), "catalog-draft:verify-game:abc");
  assert.notEqual(draftKey("verify-game", "abc"), draftKey("publish-release", "abc"));
});

test("every error an editing action can meet has its own message", () => {
  // The guard and helpers M10c adds (before its replaced functions, whose merge,
  // exclusion and review errors their own features show), and the editor functions'.
  const added = m10c.slice(0, m10c.indexOf("-- 4. Functions"));
  const raised = [...new Set([...added.matchAll(/raise exception '([^'%]+)'/g)].map((m) => m[1]))].filter((m) => m !== "provenance is permanent");
  assert.ok(raised.includes("own record") && raised.includes("verification stale") && raised.includes("reauthentication required"));
  const editor = ["not permitted", "reason required", "invalid changes", "record changed", "record unavailable", "release incomplete", "release not verified", "game not verified",
    "alias repeats the title", "a game that contains others must stay a compilation", "only a compilation can contain other games", "already published"];
  const fallback = editErrorMessage("something else");
  for (const message of [...raised, ...editor]) assert.notEqual(editErrorMessage(message), fallback, message);
  assert.equal(editErrorMessage(undefined), fallback);
});
