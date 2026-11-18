// Run with: npm run profile:test. Profile editing and avatars (M11a-3): the rules the page
// applies before the database does, which must be the database's own. scripts/app-profile-checks.mjs
// tests the running app against the database and Storage.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { avatarPublicUrl } from "../avatars/url.ts";
import {
  BIO_MAX,
  characterCount,
  collectionVisibilityText,
  DISPLAY_NAME_MAX,
  normalizeBio,
  normalizeDisplayName,
  profileError,
  profileErrorField,
  profileErrorFrom,
  profileNotice,
  profileProblem,
} from "./form.ts";

const schema = readFileSync(join(import.meta.dirname, "..", "..", "..", "supabase", "migrations", "20261106100000_m2_identity_schema.sql"), "utf8");

test("the limits are the database's", () => {
  assert.match(schema, new RegExp(`char_length\\(display_name\\) between 1 and ${DISPLAY_NAME_MAX}\\b`));
  assert.match(schema, new RegExp(`char_length\\(bio\\) <= ${BIO_MAX}\\b`));
  // Both columns refuse the same invisible characters, and the page checks exactly those.
  const ranges = [...schema.matchAll(/!~ E'\[(\\\\u200B[^\]]+)\]'/g)].map((m) => m[1]);
  assert.equal(ranges.length, 2);
  assert.ok(ranges.every((r) => r === "\\\\u200B-\\\\u200F\\\\u202A-\\\\u202E\\\\u2066-\\\\u2069\\\\uFEFF"), ranges.join(" | "));
  for (const c of ["​", "‍", "‏", "‪", "‮", "⁦", "⁩", "﻿"]) {
    assert.equal(profileProblem(`a${c}b`, null), "display_name_invisible");
    assert.equal(profileProblem(null, `a${c}b`), "bio_invisible");
  }
  assert.equal(profileProblem("⁰", null), null, "a character next to a range is allowed");
});

test("characters are counted as Postgres counts them", () => {
  assert.equal(characterCount("🎮".repeat(50)), 50);
  assert.equal(profileProblem("🎮".repeat(50), null), null);
  assert.equal(profileProblem("🎮".repeat(51), null), "display_name_too_long");
  assert.equal(profileProblem("x".repeat(DISPLAY_NAME_MAX), null), null);
  assert.equal(profileProblem("x".repeat(DISPLAY_NAME_MAX + 1), null), "display_name_too_long");
  assert.equal(profileProblem(null, "y".repeat(BIO_MAX)), null);
  assert.equal(profileProblem(null, "y".repeat(BIO_MAX + 1)), "bio_too_long");
});

test("values are saved as the database requires, and empty means none", () => {
  assert.equal(normalizeDisplayName("  Mike  "), "Mike");
  assert.equal(normalizeDisplayName("   "), null);
  assert.equal(normalizeDisplayName(""), null);
  assert.equal(normalizeDisplayName("ﬁsh"), "fish", "NFKC, which the CHECK requires");
  assert.equal(normalizeBio("  \r\n "), null);
  assert.equal(normalizeBio("one\r\ntwo\rthree\n"), "one\ntwo\nthree");
  // A browser sends 500 characters with line breaks as more: they count once, as typed.
  const typed = `${"a".repeat(249)}\r\n${"b".repeat(250)}`;
  assert.equal(profileProblem(null, normalizeBio(typed)), null);
});

test("control characters: refused in a display name, line breaks allowed in a bio", () => {
  assert.equal(profileProblem("a\nb", null), "display_name_characters");
  assert.equal(profileProblem("a\u0007b", null), "display_name_characters");
  assert.equal(profileProblem("a\u0085b", null), "display_name_characters");
  assert.equal(profileProblem(null, "line one\nline two\ttab"), null);
});

test("database refusals become fixed codes, and everything else a generic failure", () => {
  assert.equal(profileErrorFrom({ code: "23514", message: "display name not allowed" }), "display_name_reserved");
  assert.equal(profileErrorFrom({ code: "23514", message: 'new row for relation "profiles" violates check constraint "profiles_display_name_check"' }), "display_name_invalid");
  assert.equal(profileErrorFrom({ code: "23514", message: 'new row for relation "profiles" violates check constraint "profiles_bio_check"' }), "bio_invalid");
  assert.equal(profileErrorFrom({ code: "42501", message: "permission denied for table profiles" }), "failed");
  assert.equal(profileErrorFrom(null), "failed");
  assert.equal(profileErrorField("display_name_reserved"), "display_name");
  assert.equal(profileErrorField("bio_too_long"), "bio");
  assert.equal(profileErrorField("failed"), null);
});

test("only known codes show a message", () => {
  assert.match(profileError("display_name_reserved"), /My Game Dex/);
  assert.equal(profileError("<script>"), null);
  assert.equal(profileError("toString"), null);
  assert.equal(profileError(null), null);
  assert.equal(profileNotice("profile_saved"), "Your profile is saved.");
  assert.equal(profileNotice("constructor"), null);
});

test("the collection's privacy is described as it is", () => {
  assert.match(collectionVisibilityText("private"), /^Private\. Only you/);
  assert.match(collectionVisibilityText("followers"), /^Followers/);
  assert.match(collectionVisibilityText("public"), /^Public/);
  assert.match(collectionVisibilityText(null), /^Unknown/);
});

test("an avatar URL is only made for a path in the owner's folder", () => {
  const owner = "11111111-2222-4333-8444-555555555555";
  const file = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const base = "http://127.0.0.1:54321/";
  assert.equal(avatarPublicUrl(`${owner}/${file}.webp`, owner, base), `http://127.0.0.1:54321/storage/v1/object/public/avatars/${owner}/${file}.webp`);
  assert.equal(avatarPublicUrl(`${file}/${file}.webp`, owner, base), null, "someone else's folder");
  assert.equal(avatarPublicUrl(`${owner}/../${file}.webp`, owner, base), null);
  assert.equal(avatarPublicUrl(`${owner}/${file}.png`, owner, base), null);
  assert.equal(avatarPublicUrl(`https://evil.example/${owner}/${file}.webp`, owner, base), null);
  assert.equal(avatarPublicUrl(null, owner, base), null);
  assert.equal(avatarPublicUrl(`${owner}/${file}.webp`, owner, undefined), null);
});
