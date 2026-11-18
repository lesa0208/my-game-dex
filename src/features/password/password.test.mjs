// Run with: npm run password:test. Password recovery and account security (M11a-2): the
// rules the pages and actions apply before Auth does. scripts/app-password-checks.mjs tests
// the running app with Auth and Mailpit; scripts/db-password-checks.mjs Auth itself.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  newPasswordProblem,
  PASSWORD_MAX_BYTES,
  PASSWORD_MIN,
  passwordError,
  passwordErrorCode,
  passwordNotice,
  readEmail,
  RECOVERY_WINDOW_SECONDS,
  recoveryState,
  RESET_REQUESTED,
  TOKEN_HASH,
} from "./form.ts";

const SESSION = "11111111-2222-4333-8444-555555555555";
const NOW = 2_000_000_000;
const claims = (amr, session_id = SESSION) => ({ session_id, amr });

test("only the session a reset link created in this browser may reset, within the hour", () => {
  assert.equal(recoveryState(claims([{ method: "otp", timestamp: NOW - 10 }]), SESSION, NOW), "ok");
  // After verifying an authenticator, the session keeps its one-time-code method.
  assert.equal(recoveryState(claims([{ method: "otp", timestamp: NOW - 10 }, { method: "totp", timestamp: NOW }]), SESSION, NOW), "ok");
  assert.equal(recoveryState(claims([{ method: "otp", timestamp: NOW - RECOVERY_WINDOW_SECONDS }]), SESSION, NOW), "ok");
  assert.equal(recoveryState(claims([{ method: "otp", timestamp: NOW - RECOVERY_WINDOW_SECONDS - 1 }]), SESSION, NOW), "expired");
});

test("anything else can't reset without the current password", () => {
  const otp = [{ method: "otp", timestamp: NOW - 10 }];
  assert.equal(recoveryState(null, SESSION, NOW), "none");
  assert.equal(recoveryState(claims(otp), null, NOW), "none", "no cookie: the link was opened elsewhere");
  assert.equal(recoveryState(claims(otp), "99999999-2222-4333-8444-555555555555", NOW), "none", "another session's cookie");
  assert.equal(recoveryState(claims([{ method: "password", timestamp: NOW - 10 }]), SESSION, NOW), "none", "a password sign-in");
  assert.equal(recoveryState(claims([{ method: "otp", timestamp: "soon" }]), SESSION, NOW), "none");
  assert.equal(recoveryState(claims("otp"), SESSION, NOW), "none");
  assert.equal(recoveryState({ amr: otp }, SESSION, NOW), "none", "no session id");
  assert.equal(recoveryState(claims([{ method: "otp", timestamp: NOW + 3600 }]), SESSION, NOW), "expired", "a timestamp from the future");
});

test("addresses are read without saying anything about accounts", () => {
  assert.equal(readEmail("  Someone@Example.TEST "), "someone@example.test");
  for (const bad of ["", "no-at-sign", "a@b", "two words@example.test", 42, null, `${"a".repeat(250)}@example.test`]) assert.equal(readEmail(bad), null);
  assert.ok(!/no account|not found|unknown/i.test(RESET_REQUESTED));
  assert.ok(RESET_REQUESTED.startsWith("If an account uses this address"));
});

test("a new password follows the invitee's rules, as a fixed code", async () => {
  const invitations = await import("../invitations/form.ts");
  assert.equal(PASSWORD_MIN, invitations.PASSWORD_MIN);
  assert.equal(PASSWORD_MAX_BYTES, invitations.PASSWORD_MAX_BYTES);
  const good = "a-good-long-password";
  assert.equal(newPasswordProblem(good, good), null);
  assert.equal(newPasswordProblem("", ""), "enter_twice");
  assert.equal(newPasswordProblem(null, good), "enter_twice");
  assert.equal(newPasswordProblem("short", "short"), "too_short");
  assert.equal(newPasswordProblem("é".repeat(40), "é".repeat(40)), "too_long", "80 bytes");
  assert.equal(newPasswordProblem(good, `${good}x`), "mismatch");
  for (const [a, b] of [[good, good], ["short", "short"], [good, "other-long-password"], ["é".repeat(40), "é".repeat(40)]]) {
    assert.equal(newPasswordProblem(a, b) === null, invitations.passwordProblem(a, b) === null, "the same verdict as the invitee's form");
  }
  for (const code of ["enter_twice", "too_short", "too_long", "mismatch"]) assert.ok(passwordError(code), code);
});

test("recovery tokens are a URL-safe hash, nothing else", () => {
  assert.ok(TOKEN_HASH.test("a".repeat(56)));
  for (const bad of ["short", "a".repeat(201), "abc def ghij k", "abcdefghijk&type=invite", "../../etc/passwd/xx"]) assert.ok(!TOKEN_HASH.test(bad), bad);
});

test("Auth's errors become fixed messages", () => {
  assert.equal(passwordErrorCode({ code: "weak_password" }), "weak_password");
  assert.equal(passwordErrorCode({ code: "same_password" }), "same_password");
  assert.equal(passwordErrorCode({ code: "reauthentication_needed" }), "reauthenticate");
  assert.equal(passwordErrorCode({ code: "insufficient_aal" }), "verify_first");
  assert.equal(passwordErrorCode({ status: 429 }), "too_many");
  assert.equal(passwordErrorCode({ code: "something_new", status: 500 }), "failed");
  assert.equal(passwordErrorCode(null), "failed");
  for (const code of ["weak_password", "same_password", "reauthenticate", "verify_first", "too_many", "failed", "wrong_password", "current_required", "invalid_email", "unavailable"]) assert.ok(passwordError(code), code);
  assert.equal(passwordError("<script>"), null);
  assert.equal(passwordError("toString"), null);
  assert.equal(passwordNotice("constructor"), null);
  for (const code of ["password_changed", "password_reset", "signed_out_everywhere"]) assert.match(passwordNotice(code), /up to an hour/, "no claim that other devices stop at once");
});

test("password operations never use the secret key or the Auth Admin API", () => {
  const dirs = ["src/features/password", "src/app/(app)/forgot-password", "src/app/(app)/reset-password", "src/app/(app)/settings/account"];
  const files = dirs.flatMap((dir) => readdirSync(dir).filter((name) => /\.(ts|tsx)$/.test(name)).map((name) => join(dir, name)));
  assert.ok(files.length >= 6);
  for (const file of [...files, "src/components/auth/change-password-form.tsx", "src/components/auth/reset-password-form.tsx", "src/components/auth/password-fields.tsx"]) {
    const source = readFileSync(file, "utf8");
    assert.ok(!/SECRET_KEY|SERVICE_ROLE|auth-admin|\.admin\b|auth\.admin/.test(source), file);
  }
  const server = readFileSync("src/features/password/server.ts", "utf8");
  assert.match(server, /supabaseConfig\(\)/, "the publishable key's config");
});

test("the reset email links to the confirmation page with the token's hash only", () => {
  const template = readFileSync("supabase/templates/recovery.html", "utf8");
  assert.match(template, /\{\{ \.SiteURL \}\}\/auth\/confirm\?token_hash=\{\{ \.TokenHash \}\}&amp;type=recovery/);
  assert.ok(!/ConfirmationURL|\.Token \}\}|RedirectTo/.test(template), "no link that spends the token on a GET");
});
