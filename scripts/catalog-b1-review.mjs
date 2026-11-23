/**
 * M12c-B1: the editorial review of the first SNES staging, on the ISOLATED B1 STACK only
 * (MGD_STACK=b1). The batch functions are B1-M2's; this tool only calls them, as the editor
 * whose session it holds, so MFA, RLS, the review guard and every batch safeguard apply.
 *
 * Operator (setup and read-only):
 *   MGD_STACK=b1 node scripts/catalog-b1-review.mjs editor-a
 *   MGD_STACK=b1 node scripts/catalog-b1-review.mjs create-batch
 *   MGD_STACK=b1 node scripts/catalog-b1-review.mjs status
 *   MGD_STACK=b1 node scripts/catalog-b1-review.mjs packet --out <review-packet.md>
 *
 * - editor-a: one disposable catalog editor (editor A), as on the M12c-A stack: a confirmed
 *   @example.test account with a handle, its own TOTP authenticator (enrolled and verified
 *   through the local Auth server, never bypassed) and the catalog_editor role only. Its
 *   sign-in details are kept outside the repository, in
 *   ~/.my-game-dex/catalog-pilot/m12c-b1/editors.local.json, and never printed.
 * - create-batch: editor A, with a fresh second factor, creates the review batch of the staged
 *   run (create_review_batch). The database freezes the members, checks every risk assessment
 *   and the right to publish, computes the flags and draws the sample. The 13 held source
 *   records have no game, so they are never members. Then it shows that editor A can neither
 *   record an outcome nor approve (no self-review) and can't read import runs (admin only).
 * - status: the batch and its outcomes, read only.
 * - packet: what the reviewer needs per member, as Markdown: the source record, flags and
 *   their reasons, critical signals, the editorial notes, and links to Wikidata. Read only;
 *   no local paths.
 *
 * Owner (editor B). The product owner runs these themselves, in their own interactive terminal;
 * nothing runs them automatically, and no agent acts as editor B:
 *   MGD_STACK=b1 node scripts/catalog-b1-review.mjs reviewer-account --email <name>@example.test
 *   MGD_STACK=b1 node scripts/catalog-b1-review.mjs reviewer-password --email <name>@example.test
 *   MGD_STACK=b1 node scripts/catalog-b1-review.mjs grant-reviewer --email <name>@example.test
 *   MGD_STACK=b1 node scripts/catalog-b1-review.mjs review --email <name>@example.test
 *   MGD_STACK=b1 node scripts/catalog-b1-review.mjs approve --email <name>@example.test
 *   MGD_STACK=b1 node scripts/catalog-b1-review.mjs reject --email <name>@example.test
 *   MGD_STACK=b1 node scripts/catalog-b1-review.mjs publish --email <name>@example.test --game <game id>
 *   MGD_STACK=b1 node scripts/catalog-b1-review.mjs revoke-reviewer --email <name>@example.test
 *
 * - reviewer-account / reviewer-password: the reviewer's own B1 account; the password is typed
 *   at a hidden prompt, sent only to the local Auth server, never stored or printed. No staff
 *   role and no authenticator: the reviewer signs in on the B1 preview, chooses a handle and
 *   enrolls their own authenticator under Settings → Security.
 * - grant-reviewer: the catalog_editor role, only for an account that isn't editor A, created no
 *   catalog record, has a handle and a verified authenticator of its own.
 * - review: signs in as the reviewer (password and a code from their authenticator, both typed
 *   by them), then walks the members that need an individual outcome: every flagged member and
 *   every sampled one. Each outcome, critical error and note is typed by the reviewer and
 *   confirmed before it is sent (record_batch_outcome). Nothing has a default. A "correct"
 *   outcome needs the reviewer's own evidence of physical existence, 20 to 500 characters
 *   (M14c-1), which approval carries into the pairing's verification basis.
 * - approve / reject: the reviewer's decision on the whole batch, with their reason, confirmed
 *   by typing the batch's first 8 characters. First it shows what approving would do, as the
 *   database predicts it (get_batch_approval_preview, M14c-3): approval (M14a, M14c-1) verifies
 *   the identities, confirms physical existence only for members found correct with evidence,
 *   publishes those unless the final approver reviewed them (they then wait for another editor),
 *   and leaves unsampled members verified as identities only, unpublished. Never a release.
 * - publish (M14c-3): a second, independent editor publishes a game's confirmed platform
 *   identities (publish_game_identity). It signs in as that editor, shows each platform's
 *   evidence and whether they may publish it (get_game_pairing_evidence), and publishes only
 *   the platforms they type, with their reason, confirmed by typing the game's first 8
 *   characters, at the revision they were shown. Whoever confirmed a platform's evidence, or
 *   created the record, is refused by the database. It reports the database's answer as given.
 *   One game at a time, never a batch's whole list; never run against B1 by an agent.
 * - revoke-reviewer: removes the role when the review is over.
 *
 * Nothing here writes a catalog row as postgres. postgres only gives the disposable editor A
 * and the reviewer their staff role (as the M12c-A pilot and the review checks do) and reads.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import { elevate, totp } from "./lib/mfa-session.mjs";
import { choosePlatforms, confirmsGame, describePairings, printable, reportPublish, verifiedAt } from "./lib/publish-plan.mjs";
import { dbContainer, stackName, stackStatus } from "./lib/stack.mjs";
import { DISTRIBUTION_FORMAT_TABLE, FLAG_REASONS } from "./wikidata-entities.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const fail = (message) => {
  console.error(message);
  process.exit(2);
};
if (stackName !== "b1") fail("Refusing: the B1 review runs only on the B1 stack (MGD_STACK=b1).");

export const PREVIEW = "http://127.0.0.4:3004";
const WORK = join(homedir(), ".my-game-dex", "catalog-pilot", "m12c-b1");
const EDITORS = join(WORK, "editors.local.json");
const NOTES = join(ROOT, "docs", "proposals", "m12c-b1", "editorial-review-snes-150.json");
const CRITICAL_ERRORS = ["wrong_identity_or_type", "wrong_platform", "physical_eligibility_unsupported", "distinct_games_merged",
  "conflicting_duplicate_identities", "conflicting_identifiers", "missing_provenance"];

/**
 * private.evidence_note_ok's rule (M14c-1), checked here only to explain a refusal before it is
 * sent; the database decides. With surrounding and repeated whitespace collapsed, at least 20
 * characters, at least 10 of them letters or digits, and at most 500.
 */
function evidenceNoteOk(note) {
  if (typeof note !== "string" || note.length > 500) return false;
  const collapsed = note.replace(/^\s+|\s+$/g, "").replace(/\s+/g, " ");
  return collapsed.length >= 20 && note.replace(/[^\p{L}\p{N}]/gu, "").length >= 10;
}

const status = stackStatus({ label: "the B1 review" });
const api = status.API_URL;
const publishable = status.PUBLISHABLE_KEY ?? status.ANON_KEY;
const serviceKey = status.SECRET_KEY ?? status.SERVICE_ROLE_KEY;
if (new URL(api).port !== "57321") fail("Refusing: that isn't the B1 stack's API (port 57321).");

const psql = (sql) =>
  execFileSync("docker", ["exec", "-i", dbContainer, "psql", "-U", "postgres", "-d", "postgres", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-At"], {
    input: sql,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, MSYS_NO_PATHCONV: "1" },
  }).trim();
const lit = (value) => `'${String(value).replace(/'/g, "''")}'`;
const readJson = (sql) => JSON.parse(psql(`begin transaction read only;\n${sql}\nrollback;`).split("\n").find((l) => l.startsWith("{") || l.startsWith("[")) ?? "null");

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    else out._.push(argv[i]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Auth and RPC
// ---------------------------------------------------------------------------

async function auth(path, { token, body, method = "POST" } = {}) {
  const response = await fetch(`${api}/auth/v1${path}`, {
    method,
    headers: { apikey: publishable, Authorization: `Bearer ${token ?? publishable}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, json };
}

async function rpc(session, fn, body = {}) {
  const response = await fetch(`${api}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: publishable, Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => null);
  if (!response.ok) return { ok: false, error: json?.message ?? `status ${response.status}`, detail: json?.details ?? null };
  return { ok: true, data: json };
}

async function signIn(email, password) {
  const result = await auth("/token?grant_type=password", { body: { email, password } });
  if (!result.ok) fail(`Sign-in refused (status ${result.status}).`);
  return result.json;
}

/** A fresh second-factor verification for a session, with a code from `code()`. */
async function verifyFactor(session, factorId, code) {
  const challenge = await auth(`/factors/${factorId}/challenge`, { token: session.access_token, body: {} });
  if (!challenge.ok) fail(`The authenticator challenge was refused (status ${challenge.status}).`);
  const verified = await auth(`/factors/${factorId}/verify`, { token: session.access_token, body: { challenge_id: challenge.json.id, code: await code() } });
  if (!verified.ok) return null;
  return Object.assign(verified.json, { factorId });
}

// ---------------------------------------------------------------------------
// Editor A (disposable, its own authenticator)
// ---------------------------------------------------------------------------

function editorA() {
  if (!existsSync(EDITORS)) return null;
  return JSON.parse(readFileSync(EDITORS, "utf8")).find((e) => e.label === "a") ?? null;
}

async function cmdEditorA() {
  if (editorA()) fail(`Editor A already exists (${EDITORS}). Nothing was created.`);
  const email = `b1-editor-a-${randomUUID()}@example.test`;
  const password = `pw-${randomBytes(18).toString("base64url")}`;
  const created = await fetch(`${api}/auth/v1/admin/users`, {
    method: "POST",
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (!created.ok) fail(`Could not create editor A (status ${created.status}).`);
  const user = await created.json();
  const session = await elevate(api, publishable, await signIn(email, password), "Editor A (B1)");
  const handle = `b1_ed_a_${randomBytes(3).toString("hex")}`;
  const claimed = await rpc(session, "claim_handle", { p_handle: handle });
  if (!claimed.ok) fail(`claim_handle refused: ${claimed.error}`);
  // Test-stack account setup, as on the M12c-A stack: the catalog_editor role only.
  psql(`insert into public.staff_roles (user_id, role) values (${lit(user.id)}, 'catalog_editor');`);
  mkdirSync(WORK, { recursive: true });
  writeFileSync(EDITORS, `${JSON.stringify([{ label: "a", id: user.id, email, handle, password, factorId: session.factorId, totpSecret: session.totpSecret }], null, 2)}\n`, { mode: 0o600 });
  console.log(`Editor A created on B1 (handle ${handle}, catalog_editor only, its own verified authenticator). Sign-in details in ${EDITORS}, not printed.`);
}

async function editorASession() {
  const a = editorA();
  if (!a) fail("No editor A yet. Run: MGD_STACK=b1 node scripts/catalog-b1-review.mjs editor-a");
  const session = await verifyFactor(await signIn(a.email, a.password), a.factorId, async () => totp(a.totpSecret));
  if (!session) fail("Editor A's second factor was refused.");
  return { a, session };
}

// ---------------------------------------------------------------------------
// The batch
// ---------------------------------------------------------------------------

function stagedRun() {
  const runs = readJson(`select coalesce(json_agg(json_build_object('id', r.id, 'platform_id', r.platform_id, 'sha', r.source_sha256) order by r.started_at), '[]')
    from private.import_runs r join public.platforms p on p.id = r.platform_id where r.provider_code = 'wikidata' and p.slug = 'snes' and r.status = 'completed';`);
  if (runs.length !== 1) fail(`Expected exactly one completed SNES Wikidata run on B1, found ${runs.length}.`);
  return runs[0];
}

function openBatch(o = {}) {
  const batches = readJson(`select coalesce(json_agg(json_build_object('id', id, 'status', status) order by created_at), '[]') from private.catalog_review_batches;`);
  if (o.batch && o.batch !== true) {
    const b = batches.find((x) => x.id === o.batch);
    if (!b) fail("No such batch on B1.");
    return b;
  }
  const open = batches.filter((b) => b.status === "open");
  if (open.length !== 1) fail(open.length ? "More than one open batch: pass --batch <id>." : "No open batch on B1.");
  return open[0];
}

function batchSummary(id) {
  return readJson(`select json_build_object(
      'id', b.id, 'status', b.status, 'created_at', b.created_at, 'items', b.item_count, 'flagged', b.flagged_count,
      'sample_size', b.sample_size, 'acceptance_number', b.acceptance_number, 'tolerable_error', b.tolerable_error,
      'confidence', b.confidence, 'required_approvals', b.required_approvals, 'content_sha256', b.content_sha256,
      'creator_handle', (select handle from public.profiles where id = b.created_by),
      'need_outcome', (select count(*) from private.catalog_review_batch_items i where i.batch_id = b.id and (i.sampled or cardinality(i.flags) > 0)),
      'pending', (select count(*) from private.catalog_review_batch_items i where i.batch_id = b.id and (i.sampled or cardinality(i.flags) > 0) and i.outcome is null),
      'outcomes', (select coalesce(json_object_agg(k, n), '{}') from (select coalesce(i.outcome, 'pending') || case when i.sampled then ' (sampled)' when cardinality(i.flags) > 0 then ' (flagged)' else ' (batch accepted on approval)' end k, count(*) n
                   from private.catalog_review_batch_items i where i.batch_id = b.id group by 1) s),
      'critical_errors_recorded', (select count(*) from private.catalog_review_batch_items i where i.batch_id = b.id and i.critical_error is not null),
      'approvals', (select count(*) from private.catalog_review_batch_approvals a where a.batch_id = b.id),
      'decision_reason', b.decision_reason)
    from private.catalog_review_batches b where b.id = ${lit(id)};`);
}

async function cmdCreateBatch(o) {
  const run = stagedRun();
  if (readJson(`select json_build_object('n', count(*)) from private.catalog_review_batches where status = 'open';`).n > 0) fail("An open batch already exists. Nothing was created.");
  const pre = readJson(`select json_build_object(
      'candidates', (select count(*) from private.provider_records pr join public.games g on g.id = pr.matched_game_id where pr.import_run_id = ${lit(run.id)} and g.status = 'under_review' and g.verified_at is null),
      'held', (select count(*) from private.provider_records where import_run_id = ${lit(run.id)} and status = 'needs_review'),
      'held_with_game', (select count(*) from private.provider_records where import_run_id = ${lit(run.id)} and status = 'needs_review' and matched_game_id is not null),
      'invalid_assessments', (select count(*) from private.provider_records pr where pr.import_run_id = ${lit(run.id)} and pr.status <> 'ignored' and cardinality(private.review_risk_problems(pr)) > 0));`);
  console.log(`Before: ${pre.candidates} candidates, ${pre.held} held source records (${pre.held_with_game} with a game), ${pre.invalid_assessments} invalid risk assessments.`);
  if (pre.held_with_game > 0) fail("Stopping: a held record has a game, so it could become a member.");
  const { session } = await editorASession();
  const reason = typeof o.reason === "string" ? o.reason
    : "M12c-B1: review batch of the first controlled SNES staging (150-item selection, 137 candidates; the 13 held records stay out until resolved)";
  const created = await rpc(session, "create_review_batch", { p_run: run.id, p_platform: run.platform_id, p_reason: reason });
  if (!created.ok) fail(`create_review_batch refused: ${created.error}${created.detail ? ` (${created.detail})` : ""}. Nothing was created.`);
  const id = created.data;
  console.log(`Batch ${id} created by editor A.`);
  console.log(JSON.stringify(batchSummary(id), null, 2));

  console.log("\nNo self-review, and no admin data for editor A (each attempt is refused and changes nothing):");
  const flagged = readJson(`select json_build_object('g', game_id) from private.catalog_review_batch_items where batch_id = ${lit(id)} and cardinality(flags) > 0 order by game_id limit 1;`);
  const checks = [
    ["record_batch_outcome by the batch's creator", await rpc(session, "record_batch_outcome", { p_batch: id, p_game: flagged.g, p_outcome: "correct", p_critical_error: null, p_note: "Editor A trying to review its own batch" })],
    ["approve_review_batch by the batch's creator", await rpc(session, "approve_review_batch", { p_batch: id, p_reason: "Editor A trying to approve its own batch" })],
    ["get_import_runs (admin only) as editor A", await rpc(session, "get_import_runs", {})],
    ["get_import_run (admin only) as editor A", await rpc(session, "get_import_run", { p_run: run.id })],
  ];
  for (const [label, r] of checks) console.log(`  ${label}: ${r.ok ? "ALLOWED (unexpected)" : `refused (${r.error})`}`);
  const history = await rpc(session, "get_catalog_record_history", { p_entity: "game", p_id: flagged.g });
  const leaks = JSON.stringify(history.data ?? "").match(/[A-Za-z]:\\\\|\\\\Users\\\\|\/Users\//g);
  console.log(`  get_catalog_record_history for a member, as editor A: ${history.ok ? `returned; ${leaks ? "CONTAINS A LOCAL PATH (unexpected)" : "no local path"}` : `refused (${history.error})`}`);
  if (checks.some(([, r]) => r.ok) || leaks) fail("Stopping: a safeguard didn't hold. Investigate before any review.");
}

function cmdStatus(o) {
  const b = openBatch({ ...o, batch: o.batch ?? readJson(`select json_build_object('id', id) from private.catalog_review_batches order by created_at desc limit 1;`)?.id });
  console.log(JSON.stringify(batchSummary(b.id), null, 2));
}

// ---------------------------------------------------------------------------
// The review packet (read only)
// ---------------------------------------------------------------------------

function members(batchId) {
  return readJson(`select coalesce(json_agg(json_build_object(
      'game_id', i.game_id, 'title', g.title, 'qid', pr.external_id, 'revision', pr.payload #> '{source,revision}',
      'first_release', coalesce(g.first_release_date::text, 'none') || ' (' || g.first_release_precision || ')',
      'flags', i.flags, 'info_flags', i.info_flags, 'critical_flags', i.critical_flags, 'sampled', i.sampled,
      'outcome', i.outcome, 'critical_error', i.critical_error, 'note', i.note,
      'titles', pr.payload -> 'titles', 'ja_titles', pr.payload -> 'ja_titles', 'source', pr.payload -> 'source')
      order by (cardinality(i.flags) > 0) desc, i.sampled desc, g.title, i.game_id), '[]')
    from private.catalog_review_batch_items i join public.games g on g.id = i.game_id
    join private.provider_records pr on pr.id = i.provider_record_id where i.batch_id = ${lit(batchId)};`);
}

function held() {
  return readJson(`select coalesce(json_agg(json_build_object('qid', external_id, 'title', payload ->> 'title', 'reason', review_reason,
      'flags', payload #> '{risk_assessment,flags}', 'critical', payload #> '{risk_assessment,critical}') order by payload ->> 'title'), '[]')
    from private.provider_records where status = 'needs_review';`);
}

const notes = () => JSON.parse(readFileSync(NOTES, "utf8")).records ?? {};
const reason = (f) => FLAG_REASONS[f] ?? f.replace(/_/g, " ");
const list = (xs) => (xs?.length ? xs.join(", ") : "none");

export function memberMarkdown(m, note) {
  const s = m.source ?? {};
  const x = s.external_ids ?? {};
  return [
    `### ${m.title} (${m.qid})`,
    "",
    `- **Needs:** ${m.flags.length ? "an individual outcome (flagged)" : m.sampled ? "an individual outcome (sampled)" : "nothing: accepted with the batch on approval"}${m.outcome ? `; recorded **${m.outcome}**${m.critical_error ? ` (${m.critical_error})` : ""}` : ""}`,
    `- **Flags:** ${m.flags.length ? m.flags.map((f) => `\`${f}\`: ${reason(f)}`).join("; ") : "none"}`,
    ...(m.info_flags.length ? [`- **Info:** ${m.info_flags.map((f) => `\`${f}\`: ${reason(f)}`).join("; ")}`] : []),
    `- **Critical signals:** ${list(m.critical_flags)}${m.critical_flags.length ? " (marking it correct needs evidence: a note of 20+ characters)" : ""}`,
    `- **In the B1 preview:** ${PREVIEW}/admin/catalog/games/${m.game_id}`,
    `- **Wikidata:** https://www.wikidata.org/wiki/${m.qid} (staged revision ${m.revision}: https://www.wikidata.org/w/index.php?oldid=${m.revision})`,
    `- **Titles:** ${list(m.titles)}${m.ja_titles ? `; Japanese: ${list(m.ja_titles)}` : ""}`,
    `- **First release (any platform):** ${m.first_release}; SNES: ${s.platform_first_release ? `${s.platform_first_release.value} (${s.platform_first_release.precision})` : "not stated"}`,
    `- **Platforms stated:** ${s.platforms?.length ?? 0}; **distribution formats:** ${list(s.distribution_formats?.map((q) => (DISTRIBUTION_FORMAT_TABLE[q] ? `${DISTRIBUTION_FORMAT_TABLE[q].label} (${DISTRIBUTION_FORMAT_TABLE[q].class.replace("_", "-")})` : q)))}`,
    `- **IGDB:** ${list(x.igdb)}; **MobyGames:** ${list(x.mobygames)}`,
    ...(note ? [`- **Editorial note (a recommendation, not a decision):** ${note.category}: ${note.reason}`] : []),
    "",
  ].join("\n");
}

async function cmdPacket(o) {
  if (!o.out || o.out === true) fail("--out is required.");
  const { outsideRepo } = await import("./catalog-import.mjs");
  if (!outsideRepo(o.out)) fail("The packet is kept outside the repository.");
  const b = openBatch(o);
  const summary = batchSummary(b.id);
  const all = members(b.id);
  const n = notes();
  const need = all.filter((m) => m.flags.length || m.sampled);
  const rest = all.filter((m) => !m.flags.length && !m.sampled);
  const md = [
    `# B1 review packet: batch ${b.id.slice(0, 8)}`,
    "",
    `Batch \`${b.id}\`, ${summary.status}. ${summary.items} members: ${summary.flagged} flagged and ${summary.sample_size} sampled need your outcome (${summary.pending} still pending); the other ${summary.items - summary.need_outcome} are accepted with the batch if you approve. Acceptance number ${summary.acceptance_number}: one sampled member not found correct fails the sample. Content hash \`${summary.content_sha256}\`.`,
    "",
    "A valid game identity is not proof of a physical release. Approval publishes the game identity and its SNES pairing only; it creates no release.",
    "",
    `## Members that need your outcome (${need.length})`,
    "",
    ...need.map((m) => memberMarkdown(m, n[m.qid])),
    `## Accepted with the batch on approval (${rest.length}, not sampled, no exception flag)`,
    "",
    ...rest.map((m) => `- ${m.title} (${m.qid})${m.info_flags.length ? `: info ${m.info_flags.join(", ")}` : ""}`),
    "",
    `## Held source records, not in the batch (${held().length})`,
    "",
    "No game exists for these; they can't be published until an editor resolves them.",
    "",
    ...held().map((h) => `- ${h.title} (${h.qid}): ${h.reason}`),
    "",
  ].join("\n");
  mkdirSync(dirname(o.out), { recursive: true });
  writeFileSync(o.out, md);
  if (/[A-Za-z]:\\|\\Users\\|\/Users\//.test(md)) fail("Stopping: the packet would contain a local path.");
  console.log(`${o.out}: ${need.length} members need an outcome, ${rest.length} accepted with the batch, ${held().length} held.`);
}

// ---------------------------------------------------------------------------
// The owner (editor B): interactive, typed by them
// ---------------------------------------------------------------------------

function reviewerEmail(o) {
  const email = typeof o.email === "string" ? o.email.trim().toLowerCase() : "";
  if (!/^[a-z0-9._+-]{1,64}@example\.test$/.test(email)) fail("--email must be a disposable test address ending in @example.test.");
  if (editorA()?.email === email) fail("Refusing: that is editor A.");
  return email;
}

function requireTerminal() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) fail("Run this yourself in an interactive terminal: everything is typed by you.");
}

/** A line typed without echo. */
function hidden(prompt) {
  return new Promise((resolve) => {
    const input = process.stdin;
    process.stdout.write(prompt);
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    let value = "";
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          input.setRawMode(false);
          input.pause();
          input.removeListener("data", onData);
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u0003") {
          input.setRawMode(false);
          process.stdout.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    input.on("data", onData);
  });
}

async function ask(prompt) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(prompt)).trim();
  } finally {
    rl.close();
  }
}

function userId(email) {
  const id = psql(`select id from auth.users where lower(email) = ${lit(email)};`);
  if (!id) fail("No account with that address on B1. Create it with reviewer-account first.");
  return id;
}

/** The reviewer's own session: their password, then a code from their own authenticator. */
async function ownerSession(email) {
  requireTerminal();
  const id = userId(email);
  if (editorA()?.id === id) fail("Refusing: that is editor A.");
  const session = await signIn(email, await hidden(`Password for ${email} (not shown): `));
  const user = await auth("/user", { token: session.access_token, method: "GET" });
  const factor = (user.json.factors ?? []).find((f) => f.factor_type === "totp" && f.status === "verified");
  if (!factor) fail(`No verified authenticator on this account. Add one under Settings → Security on ${PREVIEW} first.`);
  const elevated = await verifyFactor(session, factor.id, () => ask("6-digit code from your authenticator app: "));
  if (!elevated) fail("That code was refused. Nothing was changed.");
  return elevated;
}

/** Calls fn; when the database asks for a fresh second factor, asks the reviewer for a new code once. */
async function withRecentMfa(holder, fn, body) {
  let result = await rpc(holder.session, fn, body);
  if (!result.ok && /reauthentication required|mfa/i.test(result.error)) {
    console.log("Your second factor is more than 10 minutes old.");
    const again = await verifyFactor(holder.session, holder.session.factorId, () => ask("A new 6-digit code from your authenticator app: "));
    if (!again) return { ok: false, error: "that code was refused" };
    holder.session = again;
    result = await rpc(holder.session, fn, body);
  }
  return result;
}

async function cmdReviewerAccount(o) {
  const email = reviewerEmail(o);
  requireTerminal();
  if (psql(`select count(*) from auth.users where lower(email) = ${lit(email)};`) !== "0") fail("That address already has an account on B1.");
  const password = await hidden("Choose a password for your B1 reviewer account (12+ characters, not shown): ");
  if (password.length < 12 || Buffer.byteLength(password, "utf8") > 72) fail("The password must be at least 12 characters and at most 72 bytes.");
  if ((await hidden("Type it again: ")) !== password) fail("The two passwords differ. Nothing was created.");
  const created = await fetch(`${api}/auth/v1/admin/users`, {
    method: "POST",
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (!created.ok) fail(`The B1 Auth server refused the account (status ${created.status}). Nothing was created.`);
  console.log(`Created ${email} on B1, with no staff role and no authenticator.
Next, on ${PREVIEW}:
  1. Sign in with it, and choose a handle.
  2. Settings → Security: add an authenticator, scanning the code with your own authenticator app.
  3. Then: MGD_STACK=b1 node scripts/catalog-b1-review.mjs grant-reviewer --email ${email}`);
}

async function cmdReviewerPassword(o) {
  const email = reviewerEmail(o);
  requireTerminal();
  const id = userId(email);
  const password = await hidden("New password for your B1 reviewer account (12+ characters, not shown): ");
  console.log(`${[...password].length} characters received.`);
  if (password.length < 12 || Buffer.byteLength(password, "utf8") > 72) fail("The password must be at least 12 characters and at most 72 bytes. Nothing was changed.");
  if ((await hidden("Type it again: ")) !== password) fail("The two passwords differ. Nothing was changed.");
  const updated = await fetch(`${api}/auth/v1/admin/users/${id}`, {
    method: "PUT",
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!updated.ok) fail(`The B1 Auth server refused the change (status ${updated.status}). Nothing was changed.`);
  const session = await signIn(email, password);
  await auth("/logout", { token: session.access_token });
  console.log(`Password set, and it signs in. Sign in on ${PREVIEW} with ${email}.`);
}

function cmdGrantReviewer(o) {
  const email = reviewerEmail(o);
  const id = userId(email);
  if (editorA()?.id === id) fail("Refusing: that is editor A.");
  if (psql(`select count(*) from private.audit_events where actor_id = ${lit(id)} and action = 'catalog_record_created';`) !== "0") fail("Refusing: that account created catalog records, so it can't be their reviewer.");
  if (psql(`select count(*) from private.catalog_review_batches where created_by = ${lit(id)};`) !== "0") fail("Refusing: that account created a review batch.");
  if (!psql(`select coalesce(handle, '') from public.profiles where id = ${lit(id)};`)) fail(`Sign in on ${PREVIEW} and choose a handle first.`);
  if (psql(`select count(*) from auth.mfa_factors where user_id = ${lit(id)} and factor_type = 'totp' and status = 'verified';`) === "0") {
    fail(`Add your own authenticator under Settings → Security on ${PREVIEW} first.`);
  }
  if (psql(`select count(*) from public.staff_roles where user_id = ${lit(id)};`) !== "0") fail("That account already has a staff role.");
  // Test-stack account setup, as for editor A: catalog_editor only. Every decision stays the reviewer's.
  psql(`insert into public.staff_roles (user_id, role) values (${lit(id)}, 'catalog_editor');`);
  console.log(`${email} is a catalog editor on B1. Sign in again on ${PREVIEW} (Admin → Catalog), and review with:
  MGD_STACK=b1 node scripts/catalog-b1-review.mjs review --email ${email}`);
}

function cmdRevokeReviewer(o) {
  const email = reviewerEmail(o);
  const id = userId(email);
  const removed = psql(`with d as (delete from public.staff_roles where user_id = ${lit(id)} and role = 'catalog_editor' returning 1) select count(*) from d;`);
  console.log(removed === "0" ? "That account had no catalog editor role." : `${email} is no longer a catalog editor. Its history stays in the audit log.`);
}

async function cmdReview(o) {
  const email = reviewerEmail(o);
  const b = openBatch(o);
  if (b.status !== "open") fail("That batch is closed.");
  const holder = { session: await ownerSession(email) };
  const n = notes();
  for (;;) {
    const pending = members(b.id).filter((m) => (m.flags.length || m.sampled) && !m.outcome);
    const s = batchSummary(b.id);
    console.log(`\nBatch ${b.id.slice(0, 8)}: ${s.need_outcome - s.pending} of ${s.need_outcome} outcomes recorded, ${s.pending} pending.`);
    if (!pending.length) {
      console.log("Every member that needs an outcome has one. Decide with approve or reject.");
      return;
    }
    const m = pending[0];
    console.log(`\n${memberMarkdown(m, n[m.qid])}`);
    const choice = (await ask("Outcome: c = correct, i = incorrect, x = excluded, s = skip for now, q = quit: ")).toLowerCase();
    if (choice === "q") return;
    if (choice === "s") {
      console.log("Skipped: it stays pending, and the batch can't be approved until it has an outcome. Quitting so you can look it up.");
      return;
    }
    const outcome = { c: "correct", i: "incorrect", x: "excluded" }[choice];
    if (!outcome) {
      console.log("Not one of c, i, x, s or q. Nothing was recorded.");
      continue;
    }
    let critical = null;
    if (outcome !== "correct") {
      console.log(CRITICAL_ERRORS.map((c, k) => `  ${k + 1} = ${c}`).join("\n"));
      const pick = await ask("Critical error: its number, or 0 for none: ");
      if (pick !== "0") {
        critical = CRITICAL_ERRORS[Number(pick) - 1];
        if (!critical) {
          console.log("Not a listed number. Nothing was recorded.");
          continue;
        }
      }
    }
    // M14c-1: a correct outcome always needs the reviewer's own evidence of the game's physical
    // existence on the platform; the database refuses it otherwise, and carries it into the
    // pairing's basis at approval. A Wikidata listing is not that evidence.
    const note = await ask(outcome === "correct"
      ? `Physical evidence (20 to 500 characters: what you checked that shows a physical copy exists, and where${m.critical_flags.length ? "; and why the critical signal doesn't apply" : ""}): `
      : "Note (your evidence or reason; may be empty): ");
    if (outcome === "correct" && !evidenceNoteOk(note)) {
      console.log("That isn't evidence yet: at least 20 characters (10 of them letters or digits), at most 500, saying what you checked. Nothing was recorded.");
      continue;
    }
    const confirm = await ask(`Record "${outcome}"${critical ? ` with ${critical}` : ""} for ${m.title} (${m.qid})? Type yes: `);
    if (confirm !== "yes") {
      console.log("Not recorded.");
      continue;
    }
    const r = await withRecentMfa(holder, "record_batch_outcome", { p_batch: b.id, p_game: m.game_id, p_outcome: outcome, p_critical_error: critical, p_note: note || null });
    console.log(r.ok ? "Recorded." : `Refused: ${r.error}. Nothing was recorded.`);
  }
}

/**
 * M14c-3: a second, independent editor publishes a game's confirmed platform identities. One
 * game, the platforms they type, their reason, and the game's first 8 characters; the database
 * decides. Never run by an agent: every answer is typed by the editor.
 */
async function cmdPublish(o) {
  const email = reviewerEmail(o);
  requireTerminal();
  const game = typeof o.game === "string" ? o.game.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(game)) fail("--game must be a game's id.");
  const holder = { session: await ownerSession(email) };
  const read = await rpc(holder.session, "get_game_pairing_evidence", { p_game: game });
  if (!read.ok) fail(`Refused: ${read.error}. Nothing was published.`);
  if (!read.data) fail("No such game. Nothing was published.");
  // Printed text from the catalog: control characters removed, so it can't rewrite the terminal.
  const title = printable(psql(`select title from public.games where id = ${lit(game)};`));
  console.log(`\n${title} (${game.slice(0, 8)}), revision ${read.data.game.revision}, ${read.data.game.status}${read.data.game.identity_verified ? ", identity verified" : ""}.`);
  for (const p of describePairings(read.data)) console.log(`  ${p.slug}: ${p.name}, ${p.status}; ${p.physical}; ${p.standing}.`);
  const chosen = choosePlatforms(await ask("Platforms to publish (their short names, comma-separated; empty to stop): "), read.data);
  if (chosen.error) fail(chosen.error);
  const why = await ask("Your reason (recorded in the audit log): ");
  if (!why) fail("A reason is required. Nothing was published.");
  console.log(`Publishing makes ${title} public on ${chosen.slugs.join(", ")} as an identity: "No verified physical release recorded yet". No release is created.`);
  if (!confirmsGame(await ask(`Type the game's first 8 characters (${game.slice(0, 8)}) to publish: `), game)) fail("That didn't match. Nothing was published.");
  const ids = chosen.slugs.map((slug) => psql(`select id from public.platforms where slug = ${lit(slug)};`));
  if (ids.some((id) => !id)) fail("A platform wasn't found. Nothing was published.");
  // At the revision the editor was shown: if the game changed since, the database refuses.
  // At the evidence the editor was shown: refused if a platform was confirmed again since.
  const seenAt = verifiedAt(read.data, chosen.slugs);
  const result = reportPublish(await withRecentMfa(holder, "publish_game_identity_as_seen", {
    p_game: game, p_platforms: ids, p_reason: why, p_expected_revision: read.data.game.revision, p_expected_verified_at: seenAt,
  }));
  console.log(result.message);
  const after = await rpc(holder.session, "get_game_pairing_evidence", { p_game: game });
  if (after.ok && after.data) for (const p of describePairings(after.data)) console.log(`  ${p.slug}: ${p.status}.`);
  if (!result.ok) process.exit(1);
}

async function decide(o, fn) {
  const email = reviewerEmail(o);
  requireTerminal();
  const b = openBatch(o);
  const s = batchSummary(b.id);
  console.log(JSON.stringify(s, null, 2));
  if (fn === "approve_review_batch") {
    if (s.pending) fail(`${s.pending} members still need an outcome. Run review first.`);
  } else {
    console.log("\nRejecting closes the batch for good: its unchanged members can't be batched again without a real change (an audited edit or a new source record). Nothing is published.");
  }
  const holder = { session: await ownerSession(email) };
  if (fn === "approve_review_batch") {
    // M14c-3: what approving would do, as the database predicts it for this editor. Approval rechecks everything.
    const p = await rpc(holder.session, "get_batch_approval_preview", { p_batch: b.id, p_limit: 1 });
    if (!p.ok || !p.data) fail(`The approval preview was refused: ${p.error ?? "no batch"}. Nothing was changed.`);
    const c = p.data.counts;
    holder.seenApprovals = p.data.approvals.recorded;
    console.log(`\n${p.data.approvals.recorded} of ${p.data.approvals.required} approvals recorded. ${p.data.final
      ? `If you approve, and the database agrees when it checks again: ${c.publish} published as identities; ${c.await_publication} confirmed and left for another editor to publish (you reviewed them); ${c.reviewer_gone ?? 0} confirmed without a verifier (their reviewer's account is gone), which nobody can publish until they are confirmed again; ${c.identity_only} verified as identities only, unpublished, waiting for physical evidence; ${c.not_accepted} unchanged.`
      : "Your approval would be recorded, and the batch stays open: nothing is verified or published until the last approval."} No release is created.`);
  }
  const why = await ask("Your reason (recorded in the audit log): ");
  if (!why) fail("A reason is required. Nothing was changed.");
  const confirm = await ask(`Type the batch's first 8 characters (${b.id.slice(0, 8)}) to ${fn === "approve_review_batch" ? "approve" : "reject"} it: `);
  if (confirm !== b.id.slice(0, 8)) fail("That didn't match. Nothing was changed.");
  // M14c-3: an approval is sent with the approvals this editor was shown, and refused ("batch
  // changed") if another was recorded meanwhile, so nobody's approval is final without their seeing it.
  const r = fn === "approve_review_batch"
    ? await withRecentMfa(holder, "approve_review_batch_as_seen", { p_batch: b.id, p_reason: why, p_expected_approvals: holder.seenApprovals })
    : await withRecentMfa(holder, fn, { p_batch: b.id, p_reason: why });
  console.log(r.ok ? `Done: ${JSON.stringify(r.data)}` : `Refused: ${r.error}. Nothing was changed.`);
  console.log(JSON.stringify(batchSummary(b.id), null, 2));
}

const o = args(process.argv.slice(2));
const commands = {
  "editor-a": cmdEditorA, "create-batch": cmdCreateBatch, status: cmdStatus, packet: cmdPacket,
  "reviewer-account": cmdReviewerAccount, "reviewer-password": cmdReviewerPassword, "grant-reviewer": cmdGrantReviewer, "revoke-reviewer": cmdRevokeReviewer,
  review: cmdReview, approve: (x) => decide(x, "approve_review_batch"), reject: (x) => decide(x, "reject_review_batch"), publish: cmdPublish,
};
const command = commands[o._[0]];
if (!command) fail(`Usage: MGD_STACK=b1 node scripts/catalog-b1-review.mjs ${Object.keys(commands).join("|")}. See the header of this file.`);
try {
  await command(o);
} catch (error) {
  fail(`Stopped: ${error.message}`);
}
