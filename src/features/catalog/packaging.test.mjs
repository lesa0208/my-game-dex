// M11b-1b: the packaging vocabulary in the app matches public.packaging_types, and the
// labels never present an unclassified release as classified.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { PACKAGING_CODE_VALUES } from "../review/form.ts";
import { SUBMITTER_PACKAGING_VALUES } from "../submissions/form.ts";
import { EDITOR_PACKAGING_CHOICES, PACKAGING_TYPES, SUBMITTER_PACKAGING_CHOICES, packagingLabel, packagingName, packagingStaffLabel } from "./packaging.ts";

const migration = readFileSync(new URL("../../../supabase/migrations/20261201100000_m11b1b_release_identity.sql", import.meta.url), "utf8");
const seed = /insert into public\.packaging_types \(code, name, description, is_type, position\) values([\s\S]*?);\n/.exec(migration)[1];
const rows = [...seed.matchAll(/\('([a-z-]+)', '((?:[^']|'')+)',\s*'(?:[^']|'')+', (true|false), (\d+)\)/g)].map((m) => ({
  code: m[1],
  name: m[2].replace(/''/g, "'"),
  isType: m[3] === "true",
}));

test("the app's vocabulary is the database's, in the same order", () => {
  assert.equal(rows.length, 7);
  assert.deepEqual(PACKAGING_TYPES.map((t) => ({ code: t.code, name: t.name, isType: t.isType })), rows);
  assert.deepEqual([...PACKAGING_CODE_VALUES], rows.map((r) => r.code));
  assert.deepEqual(EDITOR_PACKAGING_CHOICES.map((c) => c.value), rows.map((r) => r.code));
});

test("the approved codes only: no multi-disc or big-box type", () => {
  assert.deepEqual(rows.map((r) => r.code), ["unclassified", "unknown", "cardboard-box", "jewel-case", "double-depth-jewel-case", "plastic-case", "paper-sleeve"]);
  assert.equal(rows.filter((r) => !r.isType).map((r) => r.code).join(","), "unclassified,unknown", "only these two are states, not types");
});

test("a collector chooses a type or Not sure, never Unknown", () => {
  assert.deepEqual(SUBMITTER_PACKAGING_CHOICES.map((c) => c.value), SUBMITTER_PACKAGING_VALUES.map((c) => c.value));
  assert.equal(SUBMITTER_PACKAGING_CHOICES[0].value, "unclassified");
  assert.equal(SUBMITTER_PACKAGING_CHOICES[0].label, "Not sure");
  assert.ok(!SUBMITTER_PACKAGING_CHOICES.some((c) => c.value === "unknown"));
});

test("public labels show a type, Unknown, or only the recorded text of an unclassified release", () => {
  assert.equal(packagingLabel("jewel-case", "Jewel Case"), "Jewel case");
  assert.equal(packagingLabel("unknown", null), "Unknown");
  assert.equal(packagingLabel("unclassified", "Big box"), "Big box", "legacy text is shown as recorded, not as a type");
  assert.equal(packagingLabel("unclassified", null), null);
  assert.equal(packagingLabel(undefined, "Jewel case"), "Jewel case");
  assert.equal(packagingName("steelbook"), "steelbook", "a code this build doesn't know is shown as itself");
});

test("staff labels always say whether the packaging is classified", () => {
  assert.equal(packagingStaffLabel("unclassified", "Big box"), "Not yet classified (recorded as “Big box”)");
  assert.equal(packagingStaffLabel("cardboard-box", null), "Cardboard box");
  assert.equal(packagingStaffLabel(undefined, null), "Not yet classified");
});
