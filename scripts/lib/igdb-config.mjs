/**
 * IGDB credentials (M18a): a Twitch application's Client ID and Client Secret, for the
 * server-side import tool only. They are read from the environment (IGDB_CLIENT_ID,
 * IGDB_CLIENT_SECRET) or from a file outside the repository, by default
 * ~/.my-game-dex/secrets/igdb.env (MGD_IGDB_ENV_FILE to choose another):
 *
 *   IGDB_CLIENT_ID=...
 *   IGDB_CLIENT_SECRET=...
 *
 * Nothing here returns a credential in a message: describeIgdbConfig says only whether each is
 * set, where from, and what is wrong with it. The app never reads these; no browser code can.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DEFAULT_IGDB_ENV_FILE = join(homedir(), ".my-game-dex", "secrets", "igdb.env");

/** KEY=VALUE lines; # comments, blank lines and surrounding quotes are ignored. */
export function parseEnvFile(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const at = line.indexOf("=");
    if (at <= 0) continue;
    const key = line.slice(0, at).trim().replace(/^export\s+/, "");
    let value = line.slice(at + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

function insideRepo(path, repo) {
  let real;
  try {
    real = realpathSync(path);
  } catch {
    real = resolve(path);
  }
  let base;
  try {
    base = realpathSync(repo);
  } catch {
    base = resolve(repo);
  }
  const rel = relative(base, real);
  return !(rel.startsWith("..") || isAbsolute(rel));
}

// Twitch's ids and secrets are 30 lowercase letters and digits today; a little latitude, no more.
const ID_SHAPE = /^[a-z0-9]{20,64}$/;
const SECRET_SHAPE = /^[A-Za-z0-9]{20,64}$/;

/**
 * The credentials, from the environment first, then the file. Returns { ok, clientId, clientSecret,
 * source, file, problems }; problems never quote a value.
 */
export function loadIgdbCredentials({ env = process.env, file = env.MGD_IGDB_ENV_FILE || DEFAULT_IGDB_ENV_FILE, repo = REPO } = {}) {
  const problems = [];
  let clientId = env.IGDB_CLIENT_ID?.trim() || "";
  let clientSecret = env.IGDB_CLIENT_SECRET?.trim() || "";
  let source = clientId || clientSecret ? "environment" : null;
  if ((!clientId || !clientSecret) && file) {
    if (insideRepo(file, repo)) {
      problems.push(`The credentials file is inside the repository (${relative(repo, resolve(file))}). Keep it outside, e.g. ${DEFAULT_IGDB_ENV_FILE}.`);
    } else if (existsSync(file)) {
      const values = parseEnvFile(readFileSync(file, "utf8"));
      if (!clientId && values.IGDB_CLIENT_ID) clientId = values.IGDB_CLIENT_ID.trim();
      if (!clientSecret && values.IGDB_CLIENT_SECRET) clientSecret = values.IGDB_CLIENT_SECRET.trim();
      if (values.IGDB_CLIENT_ID || values.IGDB_CLIENT_SECRET) source = source ? "environment and file" : "file";
    }
  }
  if (!clientId) problems.push("IGDB_CLIENT_ID isn't set.");
  else if (!ID_SHAPE.test(clientId)) problems.push("IGDB_CLIENT_ID doesn't look like a Twitch Client ID (letters and digits, about 30).");
  if (!clientSecret) problems.push("IGDB_CLIENT_SECRET isn't set.");
  else if (!SECRET_SHAPE.test(clientSecret)) problems.push("IGDB_CLIENT_SECRET doesn't look like a Twitch Client Secret (letters and digits, about 30).");
  if (clientId && clientSecret && clientId === clientSecret) problems.push("IGDB_CLIENT_ID and IGDB_CLIENT_SECRET are the same value.");
  return { ok: problems.length === 0, clientId, clientSecret, source, file, problems };
}

/** What a person needs to know, without any value. */
export function describeIgdbConfig(result) {
  const lines = [
    `IGDB_CLIENT_ID: ${result.clientId ? "set" : "not set"}`,
    `IGDB_CLIENT_SECRET: ${result.clientSecret ? "set" : "not set"}`,
    `read from: ${result.source ?? "nowhere yet"}${result.file ? ` (file checked: ${result.file})` : ""}`,
  ];
  if (result.problems.length) lines.push(...result.problems.map((p) => `problem: ${p}`));
  if (!result.ok) {
    lines.push(
      "",
      "To configure (in your own terminal, never in a chat or a commit):",
      `  1. Create ${DEFAULT_IGDB_ENV_FILE} with two lines, IGDB_CLIENT_ID=<your Client ID> and IGDB_CLIENT_SECRET=<your Client Secret>,`,
      "     from your Twitch developer console application (https://dev.twitch.tv/console/apps, client type Confidential).",
      "  2. Restrict it to your account (Windows: icacls <file> /inheritance:r /grant:r \"%USERNAME%:R\").",
      "  3. Run: node scripts/igdb.mjs check --live",
    );
  }
  return lines.join("\n");
}
