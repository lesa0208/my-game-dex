/**
 * Checks a pg_prove report from `supabase test db` (M14b). pg_prove exits non-zero when an
 * assertion fails or a file aborts, but it can't know about a file that never ran: one deleted,
 * misnamed or skipped. So this also requires that
 *
 *   - every file in supabase/tests/database is named *.test.sql (anything else is never run),
 *   - every one of them is reported, and reported plainly "ok" (no skips, no todo),
 *   - the summary says "Result: PASS" with as many files as there are on disk, and
 *   - the file and assertion counts are at least the recorded baseline, so removing a file or
 *     shrinking a plan has to be a visible change to PGTAP_BASELINE.
 *
 * Pure, so scripts/pgtap-report.test.mjs can test it without a database.
 */

/** Raise these when tests are added; lowering them is a reviewed decision, never a fix. */
export const PGTAP_BASELINE = { files: 55, assertions: 4326 };

const TEST_FILE = /^\d{2}_[a-z0-9_]+\.test\.sql$/;

/** Problems with the names of the files in supabase/tests/database. */
export function checkTestFileNames(names) {
  return names.filter((name) => !TEST_FILE.test(name)).map((name) => `${name} isn't named NN_name.test.sql, so pg_prove would never run it`);
}

/**
 * @param {string} output   everything `supabase test db` printed
 * @param {string[]} files  the *.test.sql names on disk
 * @returns {{ errors: string[], files: number, assertions: number }}
 */
export function checkPgtapReport(output, files, baseline = PGTAP_BASELINE) {
  const errors = [...checkTestFileNames(files)];
  const reported = new Map();
  let pending = null;
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trimEnd();
    // ".../01_foundation.test.sql ......... ok" (pg_prove's per-file result line). A failing
    // file's line ends empty; its result ("Failed 1/28 subtests", "Dubious, test returned 3")
    // follows the "#" diagnostics.
    const m = /(?:^|[\\/])([^\\/\s]+\.sql) \.+ ?(.*)$/.exec(line);
    if (m) {
      reported.set(m[1], m[2].trim());
      pending = m[2].trim() ? null : m[1];
    } else if (pending && line && !line.startsWith("#") && !line.startsWith("psql:")) {
      reported.set(pending, line.trim());
      pending = null;
    }
  }
  for (const name of files) {
    const status = reported.get(name);
    if (status === undefined) errors.push(`${name} wasn't run`);
    else if (status !== "ok") errors.push(`${name}: ${status || "no result"}`);
  }
  for (const name of reported.keys()) if (!files.includes(name)) errors.push(`${name} ran but isn't in supabase/tests/database`);
  if (/#\s*(skip|todo)\b/i.test(output) || /\bskipped\b/.test(output.replace(/NOTICE: .*skipping/g, ""))) {
    errors.push("some assertions were skipped or marked todo");
  }

  const summary = /^Files=(\d+), Tests=(\d+)/m.exec(output);
  const fileCount = summary ? Number(summary[1]) : 0;
  const assertions = summary ? Number(summary[2]) : 0;
  if (!summary) errors.push("pg_prove printed no Files=/Tests= summary");
  if (!/^Result: PASS\s*$/m.test(output)) errors.push("pg_prove didn't report Result: PASS");
  if (summary && fileCount !== files.length) errors.push(`pg_prove ran ${fileCount} files, but there are ${files.length}`);
  if (files.length < baseline.files) errors.push(`${files.length} test files, fewer than the baseline ${baseline.files}`);
  if (summary && assertions < baseline.assertions) errors.push(`${assertions} assertions, fewer than the baseline ${baseline.assertions}`);
  return { errors, files: fileCount, assertions };
}
