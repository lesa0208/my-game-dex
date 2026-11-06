/**
 * Fails if a secret appears in files that could be committed or shipped.
 *
 *   node scripts/check-secrets.mjs            every tracked and untracked file
 *   node scripts/check-secrets.mjs --staged   staged content, used by the hook
 *   node scripts/check-secrets.mjs --bundle   browser bundles in .next/static
 *
 * Reports the file, line and rule. It never prints the matched value.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const RULES = [
  { name: "Supabase secret key", pattern: /sb_secret_[A-Za-z0-9_-]{16,}/ },
  { name: "JSON Web Token", pattern: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: "Secret key assignment", pattern: /\b(SUPABASE_SERVICE_ROLE_KEY|SUPABASE_SECRET_KEY|SUPABASE_DB_PASSWORD|DATABASE_URL)\s*[=:]\s*['"]?(?!your-|<|\$|\[|placeholder|env\()[^\s'"]{8,}/ },
  { name: "Secret exposed through NEXT_PUBLIC_", pattern: /\bNEXT_PUBLIC_[A-Z0-9_]*(SERVICE_ROLE|SECRET|PASSWORD|PRIVATE)[A-Z0-9_]*\b/ },
  { name: "Remote database URL with a password", pattern: /postgres(?:ql)?:\/\/[^:\s"'/]+:[^@\s"']{3,}@(?!127\.0\.0\.1|localhost|db:)[^\s"']+/ },
  { name: "Private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

const BUNDLE_RULES = [
  ...RULES,
  { name: "Secret variable name in a browser bundle", pattern: /\b(SUPABASE_SERVICE_ROLE_KEY|SUPABASE_SECRET_KEY|SUPABASE_DB_PASSWORD)\b/ },
];

const SKIPPED_EXTENSIONS = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|eot|pdf|zip|gz|map)$/i;
// These files define the rules and fake values to test them.
const SKIPPED_FILES = new Set(["scripts/check-secrets.mjs", "scripts/check-secrets.test.mjs"]);

/** A tracked env file is a finding on its own, whatever it contains. */
export function isForbiddenPath(path) {
  const name = path.split("/").pop();
  return /^\.env(\.|$)/.test(name) && name !== ".env.example";
}

export function scanText(text, rules = RULES) {
  const findings = [];
  text.split(/\r?\n/).forEach((line, index) => {
    for (const rule of rules) {
      if (rule.pattern.test(line)) findings.push({ line: index + 1, rule: rule.name });
    }
  });
  return findings;
}

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 1024 * 1024 * 64, stdio: ["ignore", "pipe", "pipe"] });
}

function collectRepositoryFindings(staged) {
  const paths = staged
    ? git(["diff", "--cached", "--name-only", "--diff-filter=ACMR"])
    : git(["ls-files", "--cached", "--others", "--exclude-standard"]);
  const findings = [];
  let scanned = 0;
  for (const path of paths.split("\n").filter(Boolean)) {
    if (isForbiddenPath(path)) findings.push({ path, line: 0, rule: "Environment file must not be committed" });
    if (SKIPPED_EXTENSIONS.test(path) || SKIPPED_FILES.has(path)) continue;
    let text;
    try {
      text = staged ? git(["show", `:${path}`]) : readFileSync(join(root, path), "utf8");
    } catch {
      continue; // Deleted from the working tree, or a directory entry.
    }
    scanned += 1;
    for (const finding of scanText(text)) findings.push({ path, ...finding });
  }
  return { findings, scanned };
}

function walk(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function collectBundleFindings() {
  const directory = join(root, ".next", "static");
  if (!existsSync(directory)) {
    console.error("No build found at .next/static. Run npm run build first.");
    process.exit(1);
  }
  const findings = [];
  let scanned = 0;
  for (const file of walk(directory)) {
    if (SKIPPED_EXTENSIONS.test(file)) continue;
    scanned += 1;
    for (const finding of scanText(readFileSync(file, "utf8"), BUNDLE_RULES)) {
      findings.push({ path: relative(root, file).replaceAll("\\", "/"), ...finding });
    }
  }
  return { findings, scanned };
}

function main() {
  const mode = process.argv[2];
  const { findings, scanned } = mode === "--bundle" ? collectBundleFindings() : collectRepositoryFindings(mode === "--staged");
  if (findings.length > 0) {
    console.error(`Possible secrets found (${findings.length}):`);
    for (const finding of findings) console.error(`  ${finding.path}:${finding.line}  ${finding.rule}`);
    console.error("Remove them, and rotate any real credential that was exposed.");
    process.exit(1);
  }
  console.log(`No secrets found in ${scanned} files.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
