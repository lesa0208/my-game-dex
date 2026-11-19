// Run with: npm run records:test. The catalog records' search parameters and how a
// record's history reads. scripts/app-admin-checks.mjs tests the running app, and
// supabase/tests/database/36_catalog_records.test.sql tests what the database returns.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { returnPath } from "../admin/form.ts";
import { FIELD_LABELS, actorLabel, creationNote, eventSummary, readSearchParams, recordStatusLabel, searchHref } from "./form.ts";

const migration = readFileSync(new URL("../../../supabase/migrations/20261120100000_m10b_catalog_records.sql", import.meta.url), "utf8");

test("every action history may show reads as a sentence of its own", () => {
  const body = /create function private\.history_actions\(\)[\s\S]*?\$\$;/.exec(migration)[0];
  const actions = [...body.matchAll(/'(catalog_[a-z_]+)'/g)].map((m) => m[1]);
  assert.equal(actions.length, 22);
  for (const action of actions) {
    const text = eventSummary({ action, details: {} });
    assert.notEqual(text, action.replaceAll("_", " "), `no wording for ${action}`);
  }
});

test("history details read without inventing values", () => {
  assert.equal(eventSummary({ action: "catalog_record_updated", details: { entity: "release", fields: ["edition_name", "barcode"], verification_cleared: true } }),
    "Changed the edition and barcode, which cleared its verification");
  assert.equal(eventSummary({ action: "catalog_record_updated", details: { entity: "game", fields: ["title"] } }), "Changed the title");
  assert.equal(eventSummary({ action: "catalog_record_updated", details: { entity: "game" } }), "Changed the game");
  assert.equal(eventSummary({ action: "catalog_record_verified", details: { entity: "release", revision: 4 } }), "Verified the release at revision 4");
  assert.equal(eventSummary({ action: "catalog_record_created", details: { entity: "game_platform" } }), "Added a platform pairing");
  assert.equal(eventSummary({ action: "catalog_field_locked", details: { field: "product_code" } }), "Locked the product code against imports");
  assert.equal(eventSummary({ action: "catalog_alias_added", details: { alias_title: "Aurora" } }), "Added the title “Aurora”");
  assert.equal(eventSummary({ action: "catalog_alias_added", details: {} }), "Added a title");
  assert.equal(eventSummary({ action: "something_new", details: {} }), "something new");
});

test("a merge reads from the side of the record whose history it is", () => {
  const merge = { action: "catalog_release_merged", details: { record_id: "source", target_id: "target" } };
  assert.equal(eventSummary(merge, "source"), "Merged this release into another");
  assert.equal(eventSummary(merge, "target"), "Merged another release into this one");
});

test("actors: staff by handle, never a submitter's name", () => {
  assert.equal(actorLabel({ kind: "staff", handle: "kim" }), "@kim");
  assert.equal(actorLabel({ kind: "staff", handle: null }), "A former staff member");
  assert.equal(actorLabel({ kind: "submitter", handle: "someone" }), "The submitter");
  assert.equal(actorLabel({ kind: "import" }), "An import");
  assert.equal(actorLabel({ kind: "system" }), "The system");
});

test("every field a lock or evidence can name has a label", () => {
  const lockable = /create function private\.lockable_field[\s\S]*?\$\$;/.exec(readFileSync(new URL("../../../supabase/migrations/20261108100500_m5_catalog_editor_functions.sql", import.meta.url), "utf8"))[0];
  const evidence = /field_name text not null check \(field_name in \(([\s\S]*?)\)\)/.exec(readFileSync(new URL("../../../supabase/migrations/20261108100400_m5_provenance_schema.sql", import.meta.url), "utf8"))[1];
  const fields = new Set([...lockable.matchAll(/'([a-z_]+)'/g), ...evidence.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).filter((f) => f !== "release"));
  assert.ok(fields.size >= 20, `found ${fields.size} fields`);
  for (const field of fields) assert.ok(Object.hasOwn(FIELD_LABELS, field), `no label for ${field}`);
});

test("search parameters: unknown values are dropped, not sent", () => {
  assert.deepEqual(readSearchParams({}), { kind: "games", query: "", platform: null, status: null, cursor: null });
  assert.deepEqual(readSearchParams({ kind: "releases", q: "  zelda  ", platform: "snes", status: "merged", cursor: "abc_-1" }),
    { kind: "releases", query: "zelda", platform: "snes", status: "merged", cursor: "abc_-1" });
  assert.deepEqual(readSearchParams({ kind: "accounts", platform: "SNES; drop", status: "deleted", cursor: "a b" }),
    { kind: "games", query: "", platform: null, status: null, cursor: null });
  assert.equal(readSearchParams({ q: "x".repeat(300) }).query.length, 100);
  assert.equal(readSearchParams({ q: ["first", "second"] }).query, "first");
});

test("search addresses keep only what's set", () => {
  assert.equal(searchHref({ kind: "games", query: "", platform: null, status: null }), "/admin/catalog/search");
  assert.equal(searchHref({ kind: "releases", query: "a&b", platform: "snes", status: "published", cursor: "c1" }),
    "/admin/catalog/search?q=a%26b&kind=releases&platform=snes&status=published&cursor=c1");
  // A valid return path after verifying (returnPath): no "+", no other characters it refuses.
  const href = searchHref({ kind: "games", query: "Zelda: a link + more", platform: null, status: null });
  assert.equal(href, "/admin/catalog/search?q=Zelda%3A%20a%20link%20%2B%20more");
  assert.equal(returnPath(href), href);
});

test("statuses read as editors know them", () => {
  assert.equal(recordStatusLabel("unverified"), "Pending");
  assert.equal(recordStatusLabel("under_review"), "In review");
  assert.equal(recordStatusLabel("excluded"), "Excluded");
});

test("the creating editor's reason is the record's evidence note, and only the record's own creation (M12c-A)", () => {
  const staff = { kind: "staff", handle: "editor_a" };
  const items = [
    { action: "catalog_record_updated", details: { entity: "release" }, reason: "Markets", actor: staff, occurred_at: "2026-11-19T19:46:02Z" },
    { action: "catalog_record_created", details: { entity: "game_platform" }, reason: "Pairing", actor: staff, occurred_at: "2026-11-19T19:46:01Z" },
    { action: "catalog_record_created", details: { entity: "release" }, reason: "M12c-A S9: SNES Central 0164", actor: staff, occurred_at: "2026-11-19T19:46:00Z" },
  ];
  // The note carries the reason and when, never who: the record names nobody above its history.
  assert.deepEqual(creationNote(items, "release"), { reason: "M12c-A S9: SNES Central 0164", occurred_at: "2026-11-19T19:46:00Z" });
  assert.equal(creationNote(items, "game"), null);
  assert.equal(creationNote(items.slice(0, 2), "release"), null);
  assert.equal(creationNote([{ ...items[2], reason: null }], "release"), null);
});
