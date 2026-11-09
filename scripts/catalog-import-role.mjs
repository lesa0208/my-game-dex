/**
 * Enables or disables login for the catalog_importer role on the LOCAL database
 * (M5b). The password comes from CATALOG_IMPORTER_PASSWORD and never reaches the
 * database or any log: only its SCRAM-SHA-256 verifier is sent, because the
 * database logs DDL statements. Nothing secret is printed.
 *
 *   CATALOG_IMPORTER_PASSWORD=... node scripts/catalog-import-role.mjs enable
 *   node scripts/catalog-import-role.mjs disable
 *
 * The role's privileges come from the migrations, not from this script. Hosted
 * databases follow the runbook in docs/architecture/security-rls.md#catalog-import.
 */
import { execFileSync } from "node:child_process";
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const CONTAINER = "supabase_db_my-game-dex";

/** A SCRAM-SHA-256 verifier, in the form PostgreSQL stores. */
export function scramVerifier(password, salt = randomBytes(16), iterations = 4096) {
  const salted = pbkdf2Sync(Buffer.from(password, "utf8"), salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

function psql(sql) {
  execFileSync("docker", ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-X", "-q", "-v", "ON_ERROR_STOP=1"], {
    input: sql,
    stdio: ["pipe", "ignore", "pipe"],
    env: { ...process.env, MSYS_NO_PATHCONV: "1" },
  });
}

function main() {
  const command = process.argv[2];
  if (command === "enable") {
    const password = process.env.CATALOG_IMPORTER_PASSWORD ?? "";
    if (password.length < 24 || !/^[\x21-\x7e]+$/.test(password)) {
      console.error("Set CATALOG_IMPORTER_PASSWORD to at least 24 printable ASCII characters, without spaces.");
      process.exit(2);
    }
    psql(`alter role catalog_importer login password '${scramVerifier(password)}';`);
    console.log("catalog_importer can log in. Connect with CATALOG_IMPORTER_DATABASE_URL=postgresql://catalog_importer:<password>@127.0.0.1:54322/postgres");
  } else if (command === "disable") {
    psql("alter role catalog_importer nologin password null;");
    console.log("catalog_importer can't log in.");
  } else {
    console.error("Usage: node scripts/catalog-import-role.mjs enable|disable");
    process.exit(2);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
