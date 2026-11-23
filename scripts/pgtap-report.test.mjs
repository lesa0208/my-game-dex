// Unit tests for the pgTAP report check (M14b): node --test scripts/pgtap-report.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { checkPgtapReport, checkTestFileNames } from "./lib/pgtap-report.mjs";

const dir = "/home/runner/work/my-game-dex/.supabase-scratch/supabase/tests/database";
const files = ["01_a.test.sql", "02_b.test.sql"];
const baseline = { files: 2, assertions: 10 };
const line = (name, status) => `${dir}/${name} ${".".repeat(20)} ${status}`;
const report = (lines, summary = "Files=2, Tests=12,  1 wallclock secs\nResult: PASS") =>
  [`psql:${dir}/01_a.test.sql:3: NOTICE:  extension "pgtap" already exists, skipping`, ...lines, "All tests successful.", summary].join("\n");

test("a complete, passing run is accepted", () => {
  const r = checkPgtapReport(report([line("01_a.test.sql", "ok"), line("02_b.test.sql", "ok")]), files, baseline);
  assert.deepEqual(r, { errors: [], files: 2, assertions: 12 });
});

test("Windows paths and CRLF line endings are read the same way", () => {
  const out = report([line("01_a.test.sql", "ok"), line("02_b.test.sql", "ok")]).replaceAll("/", "\\").replaceAll("\n", "\r\n");
  assert.deepEqual(checkPgtapReport(out, files, baseline).errors, []);
});

test("a file aborted by a syntax error fails", () => {
  const out = report([line("01_a.test.sql", "ok"), `${line("02_b.test.sql", "")}`, "psql:...: ERROR:  syntax error at or near \"$\"", "# No tests run!", "Dubious, test returned 3 (wstat 768, 0x300)", "Failed 1/1 subtests"],
    "Files=2, Tests=8\nResult: FAIL");
  const { errors } = checkPgtapReport(out, files, baseline);
  assert.ok(errors.includes("02_b.test.sql: Dubious, test returned 3 (wstat 768, 0x300)"), errors.join("; "));
  assert.ok(errors.includes("pg_prove didn't report Result: PASS"));
});

test("a failed assertion fails", () => {
  const out = report([line("01_a.test.sql", "ok"), line("02_b.test.sql", ""), "# Failed test 3: \"x\"", "#         have: 1", "#         want: 2", "# Looks like you failed 1 test of 6", "Failed 1/6 subtests"],
    "Files=2, Tests=12\nResult: FAIL");
  assert.ok(checkPgtapReport(out, files, baseline).errors.includes("02_b.test.sql: Failed 1/6 subtests"));
});

test("a file that never ran fails, even when pg_prove passes", () => {
  const out = report([line("01_a.test.sql", "ok")], "Files=1, Tests=12\nResult: PASS");
  const { errors } = checkPgtapReport(out, files, baseline);
  assert.ok(errors.includes("02_b.test.sql wasn't run"));
  assert.ok(errors.includes("pg_prove ran 1 files, but there are 2"));
});

test("skipped or todo assertions fail", () => {
  assert.ok(checkPgtapReport(report([line("01_a.test.sql", "ok"), line("02_b.test.sql", "ok, 1/6 skipped: no reason")]), files, baseline).errors.length > 0);
  assert.ok(checkPgtapReport(report([line("01_a.test.sql", "ok"), line("02_b.test.sql", "ok"), "ok 3 - x # TODO later"]), files, baseline).errors.length > 0);
});

test("fewer files or assertions than the baseline fail", () => {
  const ok = [line("01_a.test.sql", "ok"), line("02_b.test.sql", "ok")];
  assert.ok(checkPgtapReport(report(ok, "Files=2, Tests=9\nResult: PASS"), files, baseline).errors.includes("9 assertions, fewer than the baseline 10"));
  assert.ok(checkPgtapReport(report(ok), files, { files: 3, assertions: 10 }).errors.includes("2 test files, fewer than the baseline 3"));
});

test("a file pg_prove would never pick up is refused", () => {
  assert.deepEqual(checkTestFileNames(["01_a.test.sql", "02_b.sql.bak", "03_c.test.SQL"]).length, 2);
});

test("a missing summary fails", () => {
  assert.ok(checkPgtapReport(`${line("01_a.test.sql", "ok")}\n${line("02_b.test.sql", "ok")}`, files, baseline).errors.includes("pg_prove printed no Files=/Tests= summary"));
});
