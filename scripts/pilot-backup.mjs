/**
 * Backups and cold snapshots of the M15 SNES pilot stack, at each checkpoint, as every persistent
 * database activation since M14a was protected. Pilot only (MGD_STACK is set here); never
 * development, the test stack, scratch or B1.
 *
 *   node scripts/pilot-backup.mjs dump --checkpoint <name>       a full pg_dump, with inventories
 *   node scripts/pilot-backup.mjs snapshot --checkpoint <name>   a cold copy of the database volume
 *   node scripts/pilot-backup.mjs verify --manifest <file.sha256> check a backup's checksums
 *
 * Checkpoints: empty (freshly migrated), staged, batch, reviewed, approved, published, and
 * audited. Each may be taken more than once: names carry the UTC time, and nothing is ever
 * overwritten (a name that exists is refused).
 *
 * dump writes to ~/.my-game-dex/backups/pilot/ (outside the repository, readable by the owner
 * only): the custom-format dump, the roles, its table of contents, the migration history with
 * each migration's checksum, and the data, security and schema inventories
 * (scripts/sql/integrity/), with a SHA-256 manifest.
 *
 * snapshot stops the pilot stack (only it), checks PostgreSQL shut down cleanly and left no lock
 * file, copies its volume into a new mgd_pilot_db_snapshot_<checkpoint>_<time> volume, checks
 * every file's checksum, owner, mode and time are identical, restarts the stack and checks the
 * migrations and data are unchanged.
 *
 * There is deliberately no restore command. Restoring the pilot replaces its editorial history:
 * it is a separately authorized procedure (docs/architecture/catalog-pilot-m15.md), never this
 * tool, and never pg_restore --clean over the running database.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export const CHECKPOINTS = Object.freeze(["empty", "staged", "batch", "reviewed", "approved", "published", "audited"]);
export const BACKUP_DIR = join(homedir(), ".my-game-dex", "backups", "pilot");
export const PILOT_VOLUME = "supabase_db_my-game-dex-pilot";
export const POSTGRES_IMAGE = "public.ecr.aws/supabase/postgres:17.11.0.011";

/** A checkpoint name from the allow-list, or an error. */
export function checkpointName(value) {
  if (typeof value !== "string" || !CHECKPOINTS.includes(value)) throw new Error(`--checkpoint must be one of ${CHECKPOINTS.join(", ")}.`);
  return value;
}

/** A UTC time for names: 20261123T201959Z. */
export const stamp = (date = new Date()) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

/** Where a dump goes, refused if anything with that name exists. `exists` is injectable for tests. */
export function dumpPlan(checkpoint, date = new Date(), exists = existsSync) {
  const base = join(BACKUP_DIR, `pilot-${checkpointName(checkpoint)}-${stamp(date)}`);
  if (exists(`${base}.dump`) || exists(`${base}.sha256`)) throw new Error(`Refusing: ${basename(base)} exists. Nothing is ever overwritten.`);
  return { base, dump: `${base}.dump` };
}

/** The snapshot volume's name, refused if that volume exists. `volumeExists` is injectable for tests. */
export function snapshotPlan(checkpoint, date = new Date(), volumeExists = () => false) {
  const name = `mgd_pilot_db_snapshot_${checkpointName(checkpoint)}_${stamp(date).toLowerCase()}`;
  if (volumeExists(name)) throw new Error(`Refusing: the volume ${name} exists. Nothing is ever overwritten.`);
  return { volume: name };
}

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    else out._.push(argv[i]);
  }
  return out;
}

async function pilot() {
  process.env.MGD_STACK = "pilot";
  const stack = await import("./lib/stack.mjs");
  const status = stack.stackStatus({ label: "the pilot backup", editorial: true });
  if (Number(new URL(status.API_URL).port) !== stack.EDITORIAL_STACKS.pilot.apiPort) throw new Error("Refusing: this is not the pilot stack.");
  if (stack.dbContainer !== PILOT_VOLUME) throw new Error("Refusing: unexpected pilot database container.");
  return stack;
}

const docker = (argv, input) => execFileSync("docker", argv, { input, encoding: input === undefined ? undefined : "utf8", maxBuffer: 1024 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
const psqlFile = (container, file) => docker(["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-X", "-q"], readFileSync(file, "utf8")).toString();
const sqlDir = join(import.meta.dirname, "sql", "integrity");

function inventories(container) {
  return {
    fingerprint: psqlFile(container, join(sqlDir, "fingerprint.sql")),
    security: psqlFile(container, join(sqlDir, "security.sql")),
    schemas: psqlFile(container, join(sqlDir, "schemas.sql")),
    migrations: docker(["exec", container, "psql", "-U", "postgres", "-X", "-At", "-c",
      "select version||' '||name||' '||md5(array_to_string(statements, E'\\n')) from supabase_migrations.schema_migrations order by version"]).toString(),
  };
}

async function cmdDump(o) {
  const stack = await pilot();
  const plan = dumpPlan(o.checkpoint);
  mkdirSync(BACKUP_DIR, { recursive: true });
  const container = stack.dbContainer;
  const files = {};
  const write = (suffix, content) => {
    const file = `${plan.base}.${suffix}`;
    writeFileSync(file, content, { flag: "wx", mode: 0o600 });
    chmodSync(file, 0o600);
    files[basename(file)] = sha256(readFileSync(file));
  };
  write("created.txt", `${new Date().toISOString()}\n`);
  write("dump", docker(["exec", container, "pg_dump", "-U", "supabase_admin", "-d", "postgres", "-Fc"]));
  write("roles.sql", docker(["exec", container, "pg_dumpall", "-U", "supabase_admin", "--roles-only", "--no-role-passwords"]));
  write("toc.txt", docker(["exec", "-i", container, "pg_restore", "-l"], readFileSync(`${plan.base}.dump`, "latin1")).toString());
  for (const [name, content] of Object.entries(inventories(container))) write(`${name}.txt`, content);
  write("sha256", `${Object.entries(files).map(([name, hash]) => `${hash} *${name}`).join("\n")}\n`);
  console.log(`Pilot backup ${basename(plan.base)}: ${Object.keys(files).length} files in ${BACKUP_DIR}, dump sha256 ${files[basename(plan.dump)]}`);
}

function volumeDigest(volume) {
  return docker(["run", "--rm", "-v", `${volume}:/d:ro`, "alpine", "sh", "-c",
    'cd /d && find . -type f | sort | xargs -r sha256sum | sha256sum; find . | sort | xargs -r stat -c "%n %F %u:%g %a %Y" | sha256sum; echo "entries $(find . | wc -l)"']).toString();
}

async function cmdSnapshot(o) {
  const stack = await pilot();
  const volumes = docker(["volume", "ls", "-q"]).toString().split(/\r?\n/);
  const plan = snapshotPlan(o.checkpoint, new Date(), (name) => volumes.includes(name));
  const before = inventories(stack.dbContainer);
  const cli = (command) => execFileSync(process.execPath, [stack.cli, command, ...stack.workdirArgs], { cwd: stack.root, stdio: ["ignore", "ignore", "inherit"] });
  cli("stop");
  try {
    const control = docker(["run", "--rm", "-v", `${PILOT_VOLUME}:/d:ro`, "--entrypoint", "pg_controldata", POSTGRES_IMAGE, "/d"]).toString();
    if (!/Database cluster state:\s+shut down\b/.test(control)) throw new Error("PostgreSQL didn't shut down cleanly. Nothing was copied.");
    if (docker(["run", "--rm", "-v", `${PILOT_VOLUME}:/d:ro`, "alpine", "sh", "-c", "test -e /d/postmaster.pid && echo present || echo absent"]).toString().trim() !== "absent") {
      throw new Error("A lock file remains. Nothing was copied.");
    }
    docker(["volume", "create", "--label", "mgd.purpose=pilot-" + o.checkpoint, "--label", `mgd.source=${PILOT_VOLUME}`, plan.volume]);
    docker(["run", "--rm", "-v", `${PILOT_VOLUME}:/from:ro`, "-v", `${plan.volume}:/to`, "alpine", "cp", "-a", "/from/.", "/to/"]);
    const source = volumeDigest(PILOT_VOLUME);
    const copy = volumeDigest(plan.volume);
    if (source !== copy) throw new Error(`The copy differs from the source. Keep both, and investigate: ${plan.volume}.`);
    mkdirSync(BACKUP_DIR, { recursive: true });
    writeFileSync(join(BACKUP_DIR, `${plan.volume}.txt`), `Volume ${plan.volume}, copied from ${PILOT_VOLUME} at ${new Date().toISOString()} with the pilot stopped.\n${control.split("\n").filter((l) => /cluster state|system identifier|REDO location/.test(l)).join("\n")}\n${copy}`, { flag: "wx", mode: 0o600 });
    console.log(`Snapshot ${plan.volume}: identical to the source (contents, owner, mode, time).`);
  } finally {
    cli("start");
  }
  const after = inventories(stack.dbContainer);
  if (after.fingerprint !== before.fingerprint || after.migrations !== before.migrations) throw new Error("After the restart the pilot's data or migrations differ. Stop, and investigate.");
  console.log("The pilot is running again, with the same migrations and data.");
}

function cmdVerify(o) {
  if (!o.manifest || o.manifest === true) throw new Error("--manifest <file.sha256> is required.");
  const dirName = join(o.manifest, "..");
  let bad = 0;
  for (const line of readFileSync(o.manifest, "utf8").split(/\r?\n/).filter(Boolean)) {
    const [hash, name] = line.split(" *");
    if (sha256(readFileSync(join(dirName, name))) !== hash) {
      bad += 1;
      console.log(`DIFFERS ${name}`);
    }
  }
  console.log(bad ? `${bad} file(s) differ.` : "Every file matches its checksum.");
  if (bad) process.exit(1);
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  const o = args(process.argv.slice(2));
  const commands = { dump: cmdDump, snapshot: cmdSnapshot, verify: cmdVerify };
  const command = commands[o._[0]];
  if (!command) {
    console.error("Usage: node scripts/pilot-backup.mjs dump|snapshot --checkpoint <name> | verify --manifest <file.sha256>");
    process.exit(2);
  }
  try {
    await command(o);
  } catch (error) {
    console.error(`Stopped: ${error.message}`);
    process.exit(1);
  }
}
