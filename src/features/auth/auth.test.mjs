// Run with: npm run auth:test. Pure rules only: redirects, protected paths and the
// account shape. scripts/app-auth-checks.mjs tests the running app.
import assert from "node:assert/strict";
import { test } from "node:test";

import { HANDLE_PATTERN, handleErrorFrom, nextHandleChange, parseAccount } from "./account.ts";
import { isProtectedPath, safeNextPath, signInHref, welcomeHref } from "./redirect.ts";

test("same-site paths are kept, with their query", () => {
  assert.equal(safeNextPath("/collection"), "/collection");
  assert.equal(safeNextPath("/games/starfall?release=abc"), "/games/starfall?release=abc");
  assert.equal(safeNextPath("/settings#handle"), "/settings");
});

test("anything that could leave the site falls back", () => {
  for (const value of [
    "https://evil.example/",
    "//evil.example",
    "/\\evil.example",
    "\\\\evil.example",
    "/\t/evil.example",
    "/\n/evil.example",
    "javascript:alert(1)",
    "evil.example",
    "",
    "/".padEnd(600, "a"),
    null,
    undefined,
    42,
    ["/collection"],
  ]) {
    assert.equal(safeNextPath(value), "/home", `refused ${JSON.stringify(value)}`);
  }
});

test("encoded slashes stay a path on this site", () => {
  const path = safeNextPath("/%2F%2Fevil.example");
  assert.ok(path.startsWith("/") && !path.startsWith("//"));
  assert.equal(new URL(path, "http://app.test").origin, "http://app.test");
});

test("sign-in never redirects back to itself", () => {
  assert.equal(safeNextPath("/sign-in"), "/home");
  assert.equal(safeNextPath("/sign-in?next=/collection"), "/home");
  assert.equal(safeNextPath("/sign-in", "/settings"), "/settings");
});

test("sign-in and welcome links carry a safe return path", () => {
  assert.equal(signInHref("/collection"), "/sign-in?next=%2Fcollection");
  assert.equal(signInHref("https://evil.example"), "/sign-in");
  assert.equal(welcomeHref("/settings"), "/welcome?next=%2Fsettings");
  assert.equal(welcomeHref("/welcome"), "/welcome");
});

test("protected paths match whole segments only", () => {
  assert.equal(isProtectedPath("/collection"), true);
  assert.equal(isProtectedPath("/settings/handle"), true);
  assert.equal(isProtectedPath("/collections"), false);
  assert.equal(isProtectedPath("/explore"), false);
  assert.equal(isProtectedPath("/sign-in"), false);
});

const row = {
  id: "u1",
  handle: "lucia",
  display_name: "Lucía",
  account_status: "active",
  is_active: true,
  handle_changed_at: "2026-11-01T00:00:00Z",
  handle_correction_until: null,
  bio: "private settings stay out",
  collection_visibility: "private",
};

test("an account keeps only the viewer's fields", () => {
  assert.deepEqual(parseAccount(row, "u1"), {
    id: "u1",
    handle: "lucia",
    displayName: "Lucía",
    accountStatus: "active",
    isActive: true,
    handleChangedAt: "2026-11-01T00:00:00Z",
    handleCorrectionUntil: null,
  });
});

test("an account must belong to the verified user and have a known status", () => {
  assert.equal(parseAccount(row, "someone-else"), null);
  assert.equal(parseAccount({ ...row, account_status: "admin" }, "u1"), null);
  assert.equal(parseAccount(null, "u1"), null);
  assert.equal(parseAccount([row], "u1"), null);
});

test("an account without a handle or name is still shown", () => {
  const parsed = parseAccount({ ...row, handle: null, display_name: null, is_active: false }, "u1");
  assert.equal(parsed.handle, null);
  assert.equal(parsed.displayName, "New collector");
  assert.equal(parsed.isActive, false);
});

test("handle rules and errors match claim_handle", () => {
  assert.ok(HANDLE_PATTERN.test("Lucia_88"));
  for (const bad of ["ab", "a".repeat(25), "lucía", "lu cia", "lu-cia", ""]) assert.ok(!HANDLE_PATTERN.test(bad), bad);
  assert.equal(handleErrorFrom("handle unavailable"), "unavailable");
  assert.equal(handleErrorFrom("handle change not available yet"), "too_soon");
  assert.equal(handleErrorFrom("account not eligible"), "not_eligible");
  assert.equal(handleErrorFrom("invalid handle"), "invalid");
  assert.equal(handleErrorFrom("relation \"profiles\" does not exist"), "failed");
});

test("the next handle change follows the correction window and the 30-day rule", () => {
  const now = Date.parse("2026-11-10T12:00:00Z");
  const changed = "2026-11-10T00:00:00Z";
  assert.equal(nextHandleChange({ handleChangedAt: changed, handleCorrectionUntil: "2026-11-11T00:00:00Z" }, now), null);
  assert.equal(
    nextHandleChange({ handleChangedAt: changed, handleCorrectionUntil: null }, now)?.toISOString(),
    "2026-12-10T00:00:00.000Z",
  );
  assert.equal(nextHandleChange({ handleChangedAt: "2026-10-01T00:00:00Z", handleCorrectionUntil: null }, now), null);
});
