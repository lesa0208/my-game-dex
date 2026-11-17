// Run with: npm run invitations:test. The invitation pages' input rules, statuses and
// messages (M11a-1), and that they match the database. scripts/app-invitation-checks.mjs
// tests the running app; scripts/db-invitation-checks.mjs and
// supabase/tests/database/40_account_invitations.test.sql the database and Auth.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

import {
  INVITATION_STATUSES,
  invitationActions,
  invitationError,
  invitationErrorCode,
  invitationNotice,
  invitationRefusal,
  isInvitationStatus,
  passwordProblem,
  readInvitationEmail,
} from "./form.ts";

const migration = readdirSync("supabase/migrations")
  .filter((f) => f.includes("m11a1_invitations"))
  .map((f) => readFileSync(`supabase/migrations/${f}`, "utf8"))
  .join("\n");

test("addresses are trimmed, lowercased and checked like the database does", () => {
  assert.equal(readInvitationEmail("  Jane.Doe@Example.COM "), "jane.doe@example.com");
  for (const bad of ["", "jane", "jane@", "@example.com", "jane@example", "ja ne@example.com", `${"a".repeat(250)}@x.co`, null, 42]) {
    assert.equal(readInvitationEmail(bad), null, String(bad));
  }
});

test("every status the database can report has a label, a tone and a hint", () => {
  // The statuses get_account_invitations derives (its "then '<status>'" branches), plus the ledger states it passes through.
  const derived = new Set([...migration.matchAll(/then '(\w+)'/g)].map((m) => m[1]));
  for (const s of [...derived].filter((x) => !["recorded", "unchanged"].includes(x)).concat(["revoke_pending", "send_failed"])) {
    if (!/^(sending|sent|expired|accepted|password_set|active|revoked|revoked_after_acceptance|revoke_pending|send_failed)$/.test(s)) continue;
    assert.ok(isInvitationStatus(s), s);
    assert.ok(INVITATION_STATUSES[s].label && INVITATION_STATUSES[s].hint, s);
  }
  assert.ok(derived.has("expired") && derived.has("password_set") && derived.has("active"));
  assert.equal(isInvitationStatus("anything else"), false);
});

test("the page offers resending, revoking and retrying only where the database would allow them", () => {
  assert.deepEqual(invitationActions("sent"), { resend: true, revoke: true, retry: false });
  assert.deepEqual(invitationActions("active"), { resend: false, revoke: false, retry: false });
  assert.deepEqual(invitationActions("revoke_pending"), { resend: false, revoke: false, retry: true });
  assert.deepEqual(invitationActions("revoked"), { resend: false, revoke: false, retry: false });
  assert.deepEqual(invitationActions("accepted"), { resend: false, revoke: true, retry: false });
});

test("every refusal the database returns has a fixed message; unknown codes say nothing specific", () => {
  const refusals = [...new Set([...migration.matchAll(/'refusal', '(\w+)'/g)].map((m) => m[1]))];
  assert.ok(refusals.length >= 8);
  for (const code of refusals) {
    if (code === "not_invited" || code === "password_not_set" || code === "not_accepted" || code === "invitation_revoked") continue; // the invitee's, not the page's
    assert.equal(invitationRefusal(code), code, code);
    assert.ok(invitationError(code), code);
  }
  assert.equal(invitationRefusal("something new"), "failed");
  assert.equal(invitationError("<script>"), null);
  assert.equal(invitationNotice("anything"), null);
  assert.equal(invitationErrorCode("raw database text"), "failed");
  assert.equal(invitationErrorCode("invalid email"), "invalid_email");
});

test("the creation and resend notices never say whether an address has an account", () => {
  assert.match(invitationNotice("invited"), /^If this address has no account/);
  assert.match(invitationNotice("resent"), /^If the address has no account/);
});

test("a new password needs 12 characters, at most 72 bytes, typed twice the same", () => {
  assert.match(passwordProblem("short", "short"), /12/);
  assert.match(passwordProblem("a".repeat(73), "a".repeat(73)), /72/);
  assert.match(passwordProblem("é".repeat(40), "é".repeat(40)), /72/);
  assert.match(passwordProblem("long enough password", "long enough passwrod"), /match/);
  assert.equal(passwordProblem("long enough password", "long enough password"), null);
  assert.ok(passwordProblem(null, null));
});
