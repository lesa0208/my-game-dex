// Run with: npm run admin:test. The pure rules behind /admin and Settings → Security
// (M8d): return paths, inputs, messages, the audit details shown and TOTP inputs.
// scripts/app-admin-checks.mjs tests the running app; the database decides every rule.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  adminErrorMessage,
  auditDetails,
  errorCode,
  ownerAuthorityBlocked,
  pageError,
  pageNotice,
  readDay,
  readFingerprint,
  readHandle,
  readReason,
  refusalMessage,
  returnPath,
  stepUpHref,
  withParam,
} from "./form.ts";
import { authErrorCode, maturityText, readCode, readFactorName, securityError } from "../security/form.ts";

test("return paths stay under /admin or /settings on this site", () => {
  assert.equal(returnPath("/admin/staff"), "/admin/staff");
  assert.equal(returnPath("/admin/catalog/merge/0192f0c5-7c1a-7000-8000-000000000001?into=0192f0c5-7c1a-7000-8000-000000000002"), "/admin/catalog/merge/0192f0c5-7c1a-7000-8000-000000000001?into=0192f0c5-7c1a-7000-8000-000000000002");
  assert.equal(returnPath("/settings/security"), "/settings/security");
  for (const bad of ["https://evil.example/admin", "//evil.example/admin", "/\\evil.example", "/admin/../home", "/administrator", "/home", "/admin\n", "/admin/x y", "", null, 42, `/admin/${"a".repeat(600)}`]) {
    assert.equal(returnPath(bad), "/admin", String(bad));
  }
  assert.equal(returnPath("/home", "/settings/security"), "/settings/security");
});

test("step-up goes to verification and back, never replaying anything", () => {
  assert.equal(stepUpHref("/admin/staff"), "/settings/security/verify?next=%2Fadmin%2Fstaff");
  assert.equal(stepUpHref("https://evil.example"), "/settings/security/verify?next=%2Fadmin");
});

test("withParam replaces an earlier notice or error and keeps the rest", () => {
  assert.equal(withParam("/admin/accounts?handle=abc&error=failed", "notice", "suspended"), "/admin/accounts?handle=abc&notice=suspended");
  assert.equal(withParam("/admin/staff?notice=granted", "error", "owner_only"), "/admin/staff?error=owner_only");
});

test("inputs are read strictly", () => {
  assert.equal(readHandle(" @Some_User "), "some_user");
  assert.equal(readHandle("a@b.test"), null);
  assert.equal(readHandle("ab"), null);
  assert.equal(readReason("  spaced    out  "), "spaced out");
  assert.equal(readReason("   "), null);
  assert.equal(readReason("x".repeat(501)), null);
  assert.equal(readFingerprint(` ${"AB".repeat(32)} `), "ab".repeat(32));
  assert.equal(readFingerprint("ab".repeat(31)), null);
  assert.equal(readDay("2026-11-15")?.toISOString(), "2026-11-15T00:00:00.000Z");
  assert.equal(readDay("2026-02-30"), null);
  assert.equal(readDay("15/11/2026"), null);
});

test("refusals and errors have fixed messages; unknown codes say nothing specific", () => {
  for (const code of ["owner_protected", "owner_only", "owner_ineligible", "self_change", "admin_required", "target_ineligible", "transfer_pending", "transfer_expired", "recovery_pending", "recovery_disputed"]) {
    assert.ok(refusalMessage(code).length > 10, code);
    assert.equal(pageError(code), refusalMessage(code));
  }
  assert.equal(refusalMessage("<script>"), "Nothing changed: this isn't allowed.");
  assert.equal(pageError("<script>alert(1)</script>"), null);
  assert.equal(pageNotice("constructor"), null);
  assert.equal(pageError("__proto__"), null);
  assert.equal(errorCode("permission denied for table x"), "failed");
  assert.equal(errorCode("not permitted"), "not_permitted");
  assert.equal(adminErrorMessage("column secret does not exist"), "It couldn't be saved. Try again.");
});

test("an old verification is a step-up, not a block on Owner actions", () => {
  assert.equal(ownerAuthorityBlocked(null), false);
  assert.equal(ownerAuthorityBlocked("reauthentication_required"), false);
  assert.equal(ownerAuthorityBlocked("owner_ineligible"), true);
  assert.equal(ownerAuthorityBlocked("recovery_pending"), true);
});

test("audit details show an allow-list of plain values, never ids or fingerprints", () => {
  const shown = auditDetails({ code: "owner_only", role: "admin", operation: "grant_staff_role", transfer_id: "0192f0c5-7c1a-7000-8000-000000000001", fingerprint: "ab".repeat(32), copies: 3, nested: { a: 1 } });
  assert.deepEqual(shown, [
    { label: "Refusal", value: "owner_only" },
    { label: "Attempted", value: "grant_staff_role" },
    { label: "Role", value: "Administrator" },
    { label: "Copies", value: "3" },
  ]);
  assert.deepEqual(auditDetails(null), []);
  assert.deepEqual(auditDetails(["code"]), []);
  assert.equal(JSON.stringify(auditDetails({ previous_owner_id: "x", successor_id: "y", recovery_id: "z" })), "[]");
});

test("TOTP inputs and Auth's outcomes", () => {
  assert.equal(readCode("123 456"), "123456");
  assert.equal(readCode("12345"), null);
  assert.equal(readCode("12345a"), null);
  assert.equal(readFactorName("  Phone  "), "Phone");
  assert.equal(readFactorName(""), null);
  assert.equal(readFactorName("x".repeat(41)), null);
  assert.equal(authErrorCode({ code: "mfa_verification_failed" }), "invalid_code");
  assert.equal(authErrorCode({ code: "insufficient_aal" }), "verify_first");
  assert.equal(authErrorCode({ code: "mfa_factor_name_conflict" }), "name_taken");
  assert.equal(authErrorCode({ status: 429 }), "unavailable");
  assert.equal(authErrorCode({ code: "something_new", status: 500 }), "failed");
  assert.equal(securityError("invalid_code")?.startsWith("That code didn't match"), true);
  assert.equal(securityError("totp_secret"), null);
});

test("maturity is described from the database's answer", () => {
  const now = Date.parse("2026-11-15T12:00:00Z");
  assert.equal(maturityText({ status: "unverified", registered_at: null, matures_at: null, mature: false }, now), "Not verified yet");
  assert.equal(maturityText({ status: "verified", registered_at: null, matures_at: null, mature: false }, now), "Verified, not yet registered for Owner authority");
  assert.equal(maturityText({ status: "verified", registered_at: "2026-11-14T00:00:00Z", matures_at: "2026-11-15T00:00:00Z", mature: true }, now), "Verified and registered more than 24 hours ago");
  assert.equal(maturityText({ status: "verified", registered_at: "2026-11-15T10:30:00Z", matures_at: "2026-11-16T10:30:00Z", mature: false }, now), "Verified; counts for Owner authority in about 23 hours");
});
