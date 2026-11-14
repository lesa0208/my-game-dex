/**
 * M8b: staff privileges need a live aal2 session with a verified TOTP factor, which
 * the database checks against Auth's own session, factor and claim rows. The check
 * scripts give each test user one: elevate() enrolls and verifies a TOTP factor
 * through the local Auth server, and claimsFor() returns that real session's claims
 * for SQL run as the user. Nothing here prints; tokens and TOTP secrets stay in memory.
 */
import { createHmac } from "node:crypto";

/** The current TOTP code for a base32 secret (RFC 6238: SHA-1, 30 seconds, 6 digits). */
export function totp(secret, at = Date.now()) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of secret.replace(/=+$/, "")) bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g).map((byte) => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30000)));
  const mac = createHmac("sha1", key).update(counter).digest();
  const offset = mac[mac.length - 1] & 0xf;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1e6).padStart(6, "0");
}

/** A JWT's claims, decoded without verifying it (the server verifies it). */
export function decodeClaims(token) {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
}

const claimsBySub = new Map();

/** Remembers a session's real claims, for claimsFor(). */
export function remember(session) {
  const claims = decodeClaims(session.access_token);
  claimsBySub.set(claims.sub, JSON.stringify({ sub: claims.sub, role: "authenticated", aal: claims.aal, session_id: claims.session_id }));
  return session;
}

/** The claims SQL should run with for this user: their aal2 session's, once elevated. */
export function claimsFor(userId) {
  return claimsBySub.get(String(userId)) ?? JSON.stringify({ sub: String(userId), role: "authenticated" });
}

async function call(api, anonKey, token, path, body) {
  const response = await fetch(`${api}/auth/v1${path}`, {
    method: "POST",
    headers: { apikey: anonKey, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`MFA setup failed at ${path.replace(/[0-9a-f-]{36}/g, ":id")}: status ${response.status}`);
  return json;
}

/**
 * Enrolls and verifies a TOTP factor for this signed-in session, and returns the
 * resulting aal2 session, with the factor's id and secret for later challenges.
 */
export async function elevate(api, anonKey, session, name = "Test factor") {
  const enrolled = await call(api, anonKey, session.access_token, "/factors", { factor_type: "totp", friendly_name: name });
  const challenge = await call(api, anonKey, session.access_token, `/factors/${enrolled.id}/challenge`, {});
  const verified = await call(api, anonKey, session.access_token, `/factors/${enrolled.id}/verify`, { challenge_id: challenge.id, code: totp(enrolled.totp.secret) });
  remember(verified);
  return Object.assign(verified, { factorId: enrolled.id, totpSecret: enrolled.totp.secret });
}

/** A fresh TOTP verification for an aal2 session, as a sensitive action needs (M8c). */
export async function reverify(api, anonKey, session) {
  const challenge = await call(api, anonKey, session.access_token, `/factors/${session.factorId}/challenge`, {});
  const verified = await call(api, anonKey, session.access_token, `/factors/${session.factorId}/verify`, { challenge_id: challenge.id, code: totp(session.totpSecret) });
  remember(verified);
  return Object.assign(verified, { factorId: session.factorId, totpSecret: session.totpSecret });
}
