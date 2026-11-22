/**
 * M12c-B1, finding 1 of the independent SQL review of 62267d6: batch approval under a
 * concurrent edit, with two real database sessions.
 *
 *   MGD_STACK=scratch node docs/proposals/m12c-b1/tests/concurrency/b1_concurrency_check.mjs [--demonstrate-defect]
 *
 * Needs the disposable scratch stack with the B1 drafts applied; it refuses any other stack,
 * because it commits its fixtures. Each scenario uses its own fictional records.
 *
 *   1. Edit first: session B edits a member game and holds its row lock; session A approves.
 *      A must wait for B, then fail with "batch stale", publishing nothing.
 *   2. Approval first: A approves and holds its locks; B's edit of a member must wait. After A
 *      commits, the member is published at its frozen revision, and B's edit lands after it.
 *   3. (--demonstrate-defect) Scenario 1 against the approval function as it was at 5c75321,
 *      installed under another name for the run and dropped afterwards: it publishes the
 *      game B changed after the stale check. That is the defect.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { stackName, stackStatus } from "../../../../../scripts/lib/stack.mjs";

if (stackName !== "scratch") {
  console.error("Refusing: this check commits fixtures and runs only on the scratch stack (MGD_STACK=scratch).");
  process.exit(2);
}
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");
const { DB_URL } = stackStatus({ label: "the B1 concurrency check" });
const connect = async () => {
  const c = new pg.Client({ connectionString: DB_URL });
  await c.connect();
  return c;
};

const U = (n) => `00000000-0000-0000-0000-0000000c0c0${n}`;
const EDITORS = { e1: U(1), e2: U(2), e3: U(3) };
const results = [];
const check = (label, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? `: ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function setupEditors(c) {
  await c.query("begin");
  for (const [name, id] of Object.entries(EDITORS)) {
    await c.query(
      `insert into auth.users (id, aud, role, email, email_confirmed_at, instance_id)
       values ($1, 'authenticated', 'authenticated', $2, now(), '00000000-0000-0000-0000-000000000000') on conflict (id) do nothing`,
      [id, `${name}-concurrency@example.test`],
    );
    await c.query(`update public.profiles set handle = $2::text, handle_changed_at = now() where id = $1 and handle::text is distinct from $2::text`, [id, `bc_${name}`]);
    await c.query(`insert into public.staff_roles (user_id, role) values ($1, 'catalog_editor') on conflict do nothing`, [id]);
    await c.query(`insert into auth.sessions (id, user_id, aal, factor_id, created_at, updated_at) values ($1, $1, 'aal2', $1, now(), now()) on conflict (id) do nothing`, [id]);
    await c.query(
      `insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
       select $1, $1, 'concurrency factor', 'totp', 'verified', now(), now() where not exists (select 1 from auth.mfa_factors where id = $1)`,
      [id],
    );
  }
  await c.query(`select private.record_provider_clearance('wikidata', true, 'https://www.wikidata.org/wiki/Wikidata:Licensing', encode(digest('terms', 'sha256'), 'hex'), 'B1 concurrency check')`);
  await c.query("commit");
}

/** A fresh TOTP verification for every editor, so "recent MFA" holds for the next minutes. */
async function refreshMfa(c) {
  for (const id of Object.values(EDITORS)) {
    await c.query(`delete from auth.mfa_amr_claims where session_id = $1`, [id]);
    await c.query(`insert into auth.mfa_amr_claims (id, session_id, authentication_method, created_at, updated_at) values (gen_random_uuid(), $1, 'totp', now(), now())`, [id]);
  }
}

/** Runs p_sql as an editor inside the client's current transaction. */
async function asEditor(c, editor, sql, params = []) {
  const id = EDITORS[editor];
  await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: id, role: "authenticated", aal: "aal2", session_id: id })]);
  await c.query(`set local role authenticated`);
  try {
    return await c.query(sql, params);
  } finally {
    await c.query(`reset role`).catch(() => {});
  }
}

/** A committed run of two clean games and an open batch with every sampled outcome recorded. */
async function setupBatch(c, tag) {
  await refreshMfa(c);
  const snap = (await c.query(`select encode(digest($1, 'sha256'), 'hex') as h`, [`conc-${tag}-${Date.now()}`])).rows[0].h;
  await c.query("begin");
  const run = (
    await c.query(
      `insert into private.import_runs (provider_code, platform_id, source_name, source_sha256, source_fetched_at, terms_sha256, status, finished_at, reason)
       values ('wikidata', (select id from public.platforms where slug = 'snes'), $1, $2, now(), encode(digest('terms', 'sha256'), 'hex'), 'completed', now(), 'B1 concurrency check')
       returning id`,
      [`b1-conc-${tag}`, snap],
    )
  ).rows[0].id;
  const games = [];
  for (let i = 1; i <= 2; i++) {
    const title = `Zqx Concurrent ${tag} ${i} ${snap.slice(0, 6)}`;
    const qid = `Q77${tag.length}${i}${parseInt(snap.slice(0, 6), 16)}`;
    const game = (
      await c.query(
        `insert into public.games (title, sort_title, kind, status, first_release_date, first_release_precision)
         values ($1, $1, 'game', 'under_review', '1993-02-0${i}', 'day') returning id`,
        [title],
      )
    ).rows[0].id;
    await c.query(`insert into public.game_platforms (game_id, platform_id, status) values ($1, (select id from public.platforms where slug = 'snes'), 'under_review')`, [game]);
    const payload = {
      title,
      source: { revision: 1 },
      risk_assessment: {
        contract: "mgd-risk-assessment", version: 1, assessor: "b1-concurrency", assessor_version: "1",
        source: { provider: "wikidata", external_id: qid, revision: 1, snapshot_sha256: snap },
        flags: [], critical: [],
      },
    };
    const record = (
      await c.query(
        `insert into private.provider_records (provider_code, entity_type, external_id, payload, payload_sha256, import_run_id, status, matched_game_id)
         values ('wikidata', 'game', $1, $2::jsonb, $5, $3, 'promoted', $4) returning id`,
        [qid, JSON.stringify(payload), run, game, createHash("sha256").update(JSON.stringify(payload)).digest("hex")],
      )
    ).rows[0].id;
    await c.query(`insert into private.import_run_records (import_run_id, provider_record_id, position) values ($1, $2, $3)`, [run, record, i]);
    games.push(game);
  }
  await c.query("commit");
  await c.query("begin");
  const batch = (
    await asEditor(c, "e1", `select public.create_review_batch($1, (select id from public.platforms where slug = 'snes'), 'Concurrency batch') as id`, [run])
  ).rows[0].id;
  await c.query("commit");
  const sampled = (await c.query(`select game_id from private.catalog_review_batch_items where batch_id = $1 and sampled order by game_id`, [batch])).rows.map((r) => r.game_id);
  for (const g of sampled) {
    await c.query("begin");
    await asEditor(c, "e2", `select public.record_batch_outcome($1, $2, 'correct', null, null)`, [batch, g]);
    await c.query("commit");
  }
  return { batch, games: [...games].sort() };
}

async function waitForLock(observer, pid, label) {
  for (let i = 0; i < 100; i++) {
    const r = await observer.query(`select wait_event_type from pg_stat_activity where pid = $1`, [pid]);
    if (r.rows[0]?.wait_event_type === "Lock") return true;
    await sleep(100);
  }
  check(`${label}: the session waited on a row lock`, false, "it never waited");
  return false;
}

/** Scenario 1, against approvalFn: B edits first and holds the lock; A approves. */
async function editFirst(admin, approvalFn, label) {
  const { batch, games } = await setupBatch(admin, label.replace(/\W/g, "").slice(0, 8));
  const target = games[games.length - 1]; // the last member in id order: A has already passed its checks when it reaches it
  const a = await connect();
  const b = await connect();
  try {
    const before = (await admin.query(`select revision from public.games where id = $1`, [target])).rows[0].revision;
    await b.query("begin");
    await b.query(`update public.games set summary = 'Concurrent edit during approval' where id = $1`, [target]);
    await a.query("begin");
    const approval = asEditor(a, "e3", `select ${approvalFn}($1, 'Concurrent approval')::text as r`, [batch]).then(
      (r) => ({ ok: true, value: r.rows[0].r }),
      (e) => ({ ok: false, error: e.message }),
    );
    const waited = await waitForLock(admin, a.processID, label);
    await b.query("commit");
    const outcome = await approval;
    if (outcome.ok) await a.query("commit");
    else await a.query("rollback");
    const after = (await admin.query(`select revision, status, verified_at is not null as verified from public.games where id = $1`, [target])).rows[0];
    const published = Number((await admin.query(`select count(*) from public.games where id = any($1) and status = 'published'`, [games])).rows[0].count);
    return { waited, outcome, before, after, published, batch };
  } finally {
    await a.end();
    await b.end();
  }
}

async function main() {
  const admin = await connect();
  try {
    const exists = (await admin.query(`select to_regprocedure('public.approve_review_batch(uuid,text)') is not null as ok`)).rows[0].ok;
    if (!exists) throw new Error("The B1 drafts aren't applied to this stack.");
    await setupEditors(admin);

    // 1. Edit first, with the fixed approval.
    {
      const r = await editFirst(admin, "public.approve_review_batch", "edit first");
      check("edit first: the approval waited for the editing session", r.waited);
      check("edit first: the approval fails with \"batch stale\"", !r.outcome.ok && /batch stale/.test(r.outcome.error), JSON.stringify(r.outcome));
      check("edit first: nothing in the batch was published", r.published === 0, `${r.published} published`);
      check("edit first: the edit itself stands", Number(r.after.revision) > Number(r.before), JSON.stringify(r));
      const open = (await admin.query(`select status from private.catalog_review_batches where id = $1`, [r.batch])).rows[0].status;
      check("edit first: the batch stays open, to be rejected and batched again", open === "open", open);
    }

    // 2. Approval first.
    {
      const { batch, games } = await setupBatch(admin, "apfirst");
      const target = games[0];
      const frozen = (await admin.query(`select frozen_game_revision from private.catalog_review_batch_items where batch_id = $1 and game_id = $2`, [batch, target])).rows[0].frozen_game_revision;
      const a = await connect();
      const b = await connect();
      try {
        await a.query("begin");
        const r = (await asEditor(a, "e3", `select public.approve_review_batch($1, 'Approval first')::text as r`, [batch])).rows[0].r;
        check("approval first: the approval succeeds while it holds its locks", r === '{"status": "approved", "published": 2, "awaiting_physical_evidence": 0, "awaiting_independent_publication": 0}', r);
        await b.query("begin");
        const edit = b.query(`update public.games set summary = 'Edit after approval' where id = $1`, [target]).then(() => "done", (e) => `error: ${e.message}`);
        const waited = await waitForLock(admin, b.processID, "approval first");
        check("approval first: the concurrent edit waits for the approval", waited);
        await a.query("commit");
        const e = await edit;
        await b.query(e === "done" ? "commit" : "rollback");
        const row = (await admin.query(
          `select g.status, g.revision, gp.verified_game_revision from public.games g join public.game_platforms gp on gp.game_id = g.id where g.id = $1`, [target])).rows[0];
        check("approval first: the member was published at its frozen revision", row.status === "published" && String(row.verified_game_revision) === String(frozen), JSON.stringify(row));
        check("approval first: the edit landed after the publication", e === "done" && Number(row.revision) > Number(frozen), `${e} ${JSON.stringify(row)}`);
      } finally {
        await a.end();
        await b.end();
      }
    }

    // 3. The defect, demonstrated against the function as it was before the fix.
    if (process.argv.includes("--demonstrate-defect")) {
      const old = execFileSync("git", ["show", "5c75321:docs/proposals/m12c-b1/20261210100300_m12c_b1_m2_review_batches.sql"], { cwd: root, encoding: "utf8" });
      const start = old.indexOf("create function public.approve_review_batch(");
      const end = old.indexOf("create function public.reject_review_batch(");
      const body = old.slice(start, end).replace("create function public.approve_review_batch(", "create function public.approve_review_batch_pre_fix(");
      await admin.query(body);
      await admin.query(`grant execute on function public.approve_review_batch_pre_fix(uuid, text) to authenticated`);
      try {
        const r = await editFirst(admin, "public.approve_review_batch_pre_fix", "pre-fix");
        console.log(`pre-fix: approval ${r.outcome.ok ? r.outcome.value : r.outcome.error}; the edited game: revision ${r.before} -> ${r.after.revision}, status ${r.after.status}`);
        check("pre-fix (5c75321): the old approval published a game changed after its stale check (the defect)",
          r.outcome.ok && r.after.status === "published" && Number(r.after.revision) > Number(r.before), JSON.stringify(r));
      } finally {
        await admin.query(`drop function public.approve_review_batch_pre_fix(uuid, text)`);
      }
    }
  } finally {
    await admin.end();
  }
  const failures = results.filter((x) => !x).length;
  console.log(`B1 concurrency: ${results.length - failures} of ${results.length} passed`);
  process.exitCode = failures ? 1 : 0;
}

main().catch((e) => {
  console.error(`Stopped: ${e.message}`);
  process.exitCode = 1;
});
