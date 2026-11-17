// Run with: npm run imports:test. The import monitoring pages' filters and messages
// (M10d), and that their lists match the database. scripts/app-reference-checks.mjs
// tests the running app, and supabase/tests/database/38_imports_system.test.sql the
// database.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

import {
  QUEUE_ERRORS,
  RECORD_STATUSES,
  RUN_STATUSES,
  readId,
  readPosition,
  readProvider,
  readRecordStatus,
  readResolution,
  readRunStatus,
  reportKeyLabel,
  resolveErrorMessage,
  runTone,
  shortHash,
  statLabel,
} from "./form.ts";

const migrations = new URL("../../../supabase/migrations/", import.meta.url);
const sql = readdirSync(migrations)
  .sort()
  .map((f) => readFileSync(new URL(f, migrations), "utf8"))
  .join("\n");

test("the run statuses are the database's", () => {
  const check = /status text not null default 'running' check \(status in \(([^)]+)\)\)/.exec(sql);
  assert.ok(check);
  assert.deepEqual(RUN_STATUSES.map((s) => s.value).sort(), [...check[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort());
});

test("the staged entry statuses are the database's", () => {
  const type = /create type public\.provider_record_status as enum \(([^)]+)\)/.exec(sql);
  const added = [...sql.matchAll(/alter type public\.provider_record_status add value '([a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(type);
  const values = [...[...type[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]), ...added].sort();
  assert.deepEqual(RECORD_STATUSES.map((s) => s.value).sort(), values);
});

test("filters accept only what the database does", () => {
  assert.equal(readRunStatus("failed"), "failed");
  assert.equal(readRunStatus("deleted"), null);
  assert.equal(readRunStatus(null), null);
  assert.equal(readRecordStatus("needs_review"), "needs_review");
  assert.equal(readRecordStatus("x"), null);
  assert.equal(readProvider("no-intro"), "no-intro");
  assert.equal(readProvider("No Intro"), null);
  assert.equal(readProvider("a".repeat(41)), null);
  assert.equal(readProvider("-bad"), null);
  assert.equal(readId("01900000-0000-7000-8000-0000000000A1"), "01900000-0000-7000-8000-0000000000a1");
  assert.equal(readId("not-an-id"), null);
  assert.equal(readPosition("0"), 0);
  assert.equal(readPosition("42"), 42);
  assert.equal(readPosition("-1"), null);
  assert.equal(readPosition("1.5"), null);
  assert.equal(readPosition("9999999999"), null);
});

test("a resolution is 1 to 500 characters, spaces collapsed", () => {
  assert.deepEqual(readResolution("  Checked:   it stands "), { value: "Checked: it stands" });
  assert.ok("error" in readResolution("   "));
  assert.ok("error" in readResolution("x".repeat(501)));
  assert.deepEqual(readResolution("x".repeat(500)), { value: "x".repeat(500) });
});

test("the database's errors become fixed messages, and nothing else is shown", () => {
  assert.match(resolveErrorMessage("record unavailable"), /already resolved/);
  assert.match(resolveErrorMessage("not permitted"), /catalog editors/);
  assert.equal(resolveErrorMessage("ERROR: relation private.catalog_reclassifications"), resolveErrorMessage(null));
  assert.deepEqual(Object.keys(QUEUE_ERRORS).sort(), ["failed", "reason", "unavailable"]);
});

test("labels and tones", () => {
  assert.equal(statLabel("staged_new"), "New entries");
  assert.equal(statLabel("some_future_count"), "some future count");
  assert.equal(reportKeyLabel("release:needs_review"), "Release entries, needs review");
  assert.equal(reportKeyLabel("game:A"), "Game entries, tier A (exact)");
  assert.equal(shortHash("a".repeat(64)), `${"a".repeat(12)}…`);
  assert.equal(shortHash(null), null);
  assert.equal(runTone({ status: "completed", lease_live: false }), "good");
  assert.equal(runTone({ status: "failed", lease_live: false }), "problem");
  assert.equal(runTone({ status: "running", lease_live: true }), "neutral");
  assert.equal(runTone({ status: "running", lease_live: false }), "warning");
});
