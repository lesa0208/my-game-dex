import assert from "node:assert/strict";
import { test } from "node:test";

import { isForbiddenPath, scanText } from "./check-secrets.mjs";
import { redact } from "./db.mjs";

// Fake values, assembled at runtime so this file holds nothing secret-shaped.
const fakeJwt = ["eyJ" + "a".repeat(20), "eyJ" + "b".repeat(20), "c".repeat(20)].join(".");
const fakeKey = "sb_" + "secret_" + "d".repeat(24);
const flagged = [
  ["Supabase secret key", `const key = "${fakeKey}"`],
  ["JSON Web Token", `token: ${fakeJwt}`],
  ["Secret key assignment", "SUPABASE_SERVICE_ROLE" + "_KEY=" + "e".repeat(24)],
  ["Secret exposed through NEXT_PUBLIC_", "process.env.NEXT_PUBLIC_" + "SERVICE_ROLE_KEY"],
  ["Remote database URL with a password", "postgresql://postgres:" + "hunter22" + "@db.example.supabase.co:5432/postgres"],
  ["Private key", "-----BEGIN " + "PRIVATE KEY-----"],
];

for (const [rule, line] of flagged) {
  test(`flags ${rule}`, () => {
    assert.deepEqual(scanText(line).map((finding) => finding.rule), [rule]);
  });
}

const allowed = [
  "NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321",
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  "SUPABASE_SERVICE_ROLE" + "_KEY=your-service-role-key",
  'secret = "env(SUPABASE_AUTH_EXTERNAL_APPLE_SECRET)"',
  "The secret key must never reach the browser.",
];

for (const line of allowed) {
  test(`allows: ${line}`, () => assert.deepEqual(scanText(line), []));
}

test("reports the line number", () => {
  assert.equal(scanText(`one\n${fakeKey}\nthree`)[0].line, 2);
});

test("flags env files, except the example", () => {
  assert.equal(isForbiddenPath(".env"), true);
  assert.equal(isForbiddenPath(".env.local"), true);
  assert.equal(isForbiddenPath("supabase/.env.production"), true);
  assert.equal(isForbiddenPath(".env.example"), false);
  assert.equal(isForbiddenPath("docs/env.md"), false);
});

test("redacts keys from CLI output", () => {
  const output = redact(`{"SECRET_KEY":"anything","DB_URL":"postgresql://postgres:postgres@127.0.0.1:54322/postgres"} ${fakeJwt} ${fakeKey}`);
  for (const leaked of ["anything", fakeJwt, fakeKey, ":postgres@"]) assert.equal(output.includes(leaked), false, leaked);
});
