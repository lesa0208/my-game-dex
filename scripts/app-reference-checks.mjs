/**
 * M10d end-to-end checks: the read-only Reference, Imports and System sections of
 * /admin and the reclassification queue, in the built app, driven over HTTP against
 * the local stack. Forms are submitted the way a browser without JavaScript would;
 * outcomes are judged by the database. Covers who reaches each page, what each shows,
 * that nothing on them writes except resolving a queue item, and that no page shows a
 * key, address, lease or raw source data.
 *
 *   npm run build && npm run app:reference-checks
 *
 * Local only. Import history is written straight into the database as the importer
 * would leave it, then removed with every test account and the catalog fixture at the
 * end. Prints check names and statuses, never keys, tokens or cookies.
 */
import { randomBytes } from "node:crypto";

import {
  api,
  appErrorLines,
  Browser,
  check,
  createUser,
  decode,
  deleteUsers,
  formWith,
  location,
  psql,
  results,
  section,
  signInAs,
  startApp,
  stopApp,
} from "./app-harness.mjs";
import { installFixture, removeFixture } from "./catalog-fixture.mjs";

const plain = (html) => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
const visible = (html) => plain(html.replace(/<script[\s\S]*?<\/script>/g, " "));
const hrefs = (html) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => decode(m[1]));
const NOT_AVAILABLE = "This page isn't available";
const TAG = `Ref${randomBytes(3).toString("hex")}`;
const LEASE = "0190bbbb-0000-7000-8000-0000000d1e55";
const SECRET_PAYLOAD = `${TAG} payload only`;

async function person(role = null) {
  const user = await createUser({ prefix: "ref", mfa: Boolean(role) });
  const browser = new Browser();
  await signInAs(browser, user, "/home");
  const welcome = await browser.get("/welcome");
  const handle = `rf_${randomBytes(5).toString("hex")}`;
  await browser.submit("/welcome", formWith(welcome.html, "handle"), { handle });
  if (role) psql(`insert into public.staff_roles (user_id, role) values ('${user.id}', '${role}');`);
  return { ...user, handle, browser };
}
const unavailable = (page) => plain(page.html).includes(NOT_AVAILABLE) && !page.html.includes('aria-label="Admin sections"');
const adminNav = (html) => {
  const nav = /<nav aria-label="Admin sections">([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? "";
  return hrefs(nav);
};
/** Forms that would write (a POST, or a server action), other than the layout's sign-out and those named. */
const writingForms = (html, allowed = []) =>
  [...html.matchAll(/<form\b([^>]*)>/g)].map((m) => m[1]).filter((a) => (/method="post"/i.test(a) || /action="javascript:/.test(a)) && !a.includes('id="sign-out-form"') && !allowed.some((id) => a.includes(`id="${id}"`)));

const REFERENCE = ["/admin/reference", "/admin/reference/platforms", "/admin/reference/platforms/snes", "/admin/reference/formats", "/admin/reference/regions", "/admin/reference/requirements"];

let run1 = "";
let item = "";
let releaseId = "";
try {
  installFixture();
  // Import history as the importer leaves it: a completed run with each kind of entry, a
  // later run that queued one of its candidates for an editor, and a running one.
  releaseId = psql("select id from public.releases order by id limit 1;");
  const snes = psql("select id from public.platforms where slug = 'snes';");
  run1 = psql(`insert into private.import_runs (provider_code, platform_id, source_name, source_sha256, source_fetched_at, terms_sha256, status, checkpoint, stats, started_at, finished_at, reason)
    values ('no-intro', '${snes}', '${TAG} snapshot 1.dat', repeat('a', 64), now() - interval '2 days', repeat('c', 64), 'completed', '{"after": "${TAG}-checkpoint"}', '{"staged_new": 3}', now() - interval '2 days', now() - interval '2 days' + interval '1 hour', '${TAG} pilot') returning id;`);
  const run2 = psql(`insert into private.import_runs (provider_code, platform_id, source_name, source_sha256, source_fetched_at, status, started_at, finished_at, reason)
    values ('no-intro', '${snes}', '${TAG} snapshot 2.dat', repeat('b', 64), now() - interval '1 day', 'failed', now() - interval '1 day', now() - interval '1 day' + interval '5 minutes', '${TAG} second') returning id;`);
  psql(`insert into private.import_runs (provider_code, platform_id, source_name, source_sha256, source_fetched_at, status, started_at, reason, lease_id, lease_expires_at)
    values ('no-intro', '${snes}', '${TAG} snapshot 3.dat', repeat('d', 64), now(), 'running', now(), '${TAG} running', '${LEASE}', now() + interval '5 minutes');`);
  const rec = psql(`insert into private.provider_records (provider_code, entity_type, external_id, payload, payload_sha256, import_run_id, status, match_tier, match_notes, matched_release_id)
    values ('no-intro', 'release', '${TAG}-1', '{"title": "${TAG} Harbor", "secret": "${SECRET_PAYLOAD}"}', repeat('1', 64), '${run1}', 'promoted', 'A', '{}', '${releaseId}') returning id;`);
  psql(`insert into private.provider_records (provider_code, entity_type, external_id, payload, payload_sha256, import_run_id, status, match_notes)
    values ('no-intro', 'release', '${TAG}-2', '{"title": "${TAG} Broken"}', repeat('2', 64), '${run1}', 'failed', '{"error": "${TAG} unknown medium"}');`);
  psql(`insert into private.import_run_records (import_run_id, provider_record_id, position)
    select '${run1}', id, row_number() over (order by id) - 1 from private.provider_records where import_run_id = '${run1}';`);
  item = psql(`insert into private.catalog_reclassifications (release_id, provider_record_id, import_run_id, action, reason)
    values ('${releaseId}', '${rec}', '${run2}', 'queued', '${TAG} source now tags it a prototype') returning id;`);

  await startApp(3297);
  const editor = await person("catalog_editor");
  const admin = await person("admin");
  const moderator = await person("moderator");
  const collector = await person();

  section("Who reaches each section");
  const visitor = new Browser();
  for (const path of ["/admin/reference", "/admin/imports", "/admin/system", "/admin/catalog/reclassifications"]) {
    const page = await visitor.get(path);
    check(`a visitor opening ${path} is sent to sign in`, page.response.status === 307 || /sign-in/.test(location(page.response)) || /sign-in/.test(page.html));
  }
  for (const path of [...REFERENCE, "/admin/imports", `/admin/imports/runs/${run1}`, "/admin/system", "/admin/catalog/reclassifications"]) {
    check(`a collector gets the page that doesn't exist at ${path}`, unavailable(await collector.browser.get(path)));
  }
  for (const path of ["/admin/reference", "/admin/imports", "/admin/system", "/admin/catalog/reclassifications"]) {
    check(`so does a moderator at ${path}`, unavailable(await moderator.browser.get(path)));
  }
  for (const path of REFERENCE) {
    const page = await editor.browser.get(path);
    check(`a catalog editor reads ${path}`, page.response.status === 200 && !unavailable(page));
  }
  for (const path of ["/admin/imports", `/admin/imports/runs/${run1}`, "/admin/system"]) {
    check(`but not ${path}, which is for administrators (D8)`, unavailable(await editor.browser.get(path)));
  }
  const editorNav = adminNav((await editor.browser.get("/admin/reference")).html);
  check("an editor's navigation lists Reference, not Imports or System", editorNav.includes("/admin/reference") && !editorNav.includes("/admin/imports") && !editorNav.includes("/admin/system"));
  const adminHome = await admin.browser.get("/admin");
  const nav = adminNav(adminHome.html);
  check("an administrator's lists all three", ["/admin/reference", "/admin/imports", "/admin/system"].every((h) => nav.includes(h)));
  check("the overview's reclassification count links to the queue", hrefs(adminHome.html).includes("/admin/catalog/reclassifications"));

  section("Reference data, read-only (D5)");
  const platforms = await editor.browser.get("/admin/reference/platforms");
  check("the platforms list shows every platform, linked to its page", visible(platforms.html).includes("Super Nintendo Entertainment System") && hrefs(platforms.html).includes("/admin/reference/platforms/snes"));
  const handhelds = await editor.browser.get("/admin/reference/platforms?kind=handheld");
  check("a kind filter narrows it", visible(handhelds.html).includes("Game Boy") && !visible(handhelds.html).includes("Super Nintendo Entertainment System"));
  const query = await editor.browser.get("/admin/reference/platforms?q=sega");
  check("so does a name", visible(query.html).includes("Mega Drive") && !visible(query.html).includes("Super Nintendo Entertainment System"));
  const odd = await editor.browser.get("/admin/reference/platforms?kind=spaceship");
  check("an unknown kind is ignored", visible(odd.html).includes("Super Nintendo Entertainment System"));
  const snesPage = await editor.browser.get("/admin/reference/platforms/snes");
  check("a platform's page lists its media formats and hardware", visible(snesPage.html).includes("ROM cartridge") && visible(snesPage.html).includes("rom-cartridge"));
  check("an unknown platform is the page that doesn't exist", unavailable(await editor.browser.get("/admin/reference/platforms/no-such-console")));
  check("and so is a malformed one", unavailable(await editor.browser.get("/admin/reference/platforms/Bad%20Slug")));
  check("media formats list their platforms", visible((await editor.browser.get("/admin/reference/formats")).html).includes("Game Boy Game Pak"));
  const regions = await editor.browser.get("/admin/reference/regions?q=serbia");
  check("regions list each code, and markets can be searched", visible(regions.html).includes("NTSC-U/C") && visible(regions.html).includes("Serbia") && !visible(regions.html).includes("Germany"));
  check("hardware requirements list each with its platform", visible((await editor.browser.get("/admin/reference/requirements")).html).includes("Expansion Pak"));
  let readOnly = true;
  for (const path of REFERENCE) readOnly &&= writingForms((await admin.browser.get(path)).html).length === 0;
  check("no reference page has a form that writes: filters are GET", readOnly);

  section("Import monitoring, read-only (D8)");
  const imports = await admin.browser.get("/admin/imports");
  const importsText = visible(imports.html);
  check("sources show their clearance", importsText.includes("No-Intro") && importsText.includes("Not cleared: imports refused"));
  check("runs are listed newest first, each linked", importsText.indexOf(`${TAG} snapshot 3.dat`) < importsText.indexOf(`${TAG} snapshot 1.dat`) && hrefs(imports.html).includes(`/admin/imports/runs/${run1}`));
  const failedOnly = visible((await admin.browser.get("/admin/imports?status=failed")).html);
  check("a status filter narrows them", failedOnly.includes(`${TAG} snapshot 2.dat`) && !failedOnly.includes(`${TAG} snapshot 1.dat`));
  check("an unknown status is a plain message", visible((await admin.browser.get("/admin/imports?status=deleted")).html).includes("Check the filters"));
  check("there's no form that writes", writingForms(imports.html).length === 0, writingForms(imports.html).join(" | "));
  const runPage = await admin.browser.get(`/admin/imports/runs/${run1}`);
  const runText = visible(runPage.html);
  check("a run shows its report, staging counts and entries", runText.includes(`${TAG} pilot`) && runText.includes("New entries") && runText.includes(`${TAG} Harbor`));
  check("a failed entry says so, without the importer's error message (M10e)", runText.includes("Couldn't be applied") && !runText.includes(`${TAG} unknown medium`));
  check("a created candidate links to its release record", hrefs(runPage.html).includes(`/admin/catalog/releases/${releaseId}`));
  const failedEntries = visible((await admin.browser.get(`/admin/imports/runs/${run1}?status=failed`)).html);
  check("entries can be filtered by status", failedEntries.includes(`${TAG} Broken`) && !failedEntries.includes(`${TAG} Harbor`));
  const html = [imports.html, runPage.html].join("\n");
  check("no lease id, checkpoint or raw payload reaches the page", ![LEASE, `${TAG}-checkpoint`, SECRET_PAYLOAD].some((x) => html.includes(x)));
  check("an unknown run is the page that doesn't exist", unavailable(await admin.browser.get("/admin/imports/runs/01900000-0000-7000-8000-000000000999")));
  check("and so is a malformed id", unavailable(await admin.browser.get("/admin/imports/runs/not-a-run")));

  section("The system view, read-only (D7)");
  const system = await admin.browser.get("/admin/system");
  const systemText = visible(system.html);
  const latest = psql("select max(version) from supabase_migrations.schema_migrations;");
  check("it shows the latest migration and the importer's login state", systemText.includes(latest) && systemText.includes("Login disabled"));
  check("and the fixed policies, Dark Mode only among them", systemText.includes("Dark Mode only") && systemText.includes("No editable settings or feature flags"));
  check("no address, key or connection string is shown", ![api, "postgres://", "postgresql://", "54321", "54322", "service_role"].some((x) => systemText.includes(x)));
  check("and there's no form on it that writes", writingForms(system.html).length === 0);

  section("The reclassification queue: one audited write");
  const queue = await editor.browser.get("/admin/catalog/reclassifications");
  check("an editor sees the waiting item with its reason, next to the warning that the resolution is visible", visible(queue.html).includes(`${TAG} source now tags it a prototype`) && visible(queue.html).includes("Visible to other catalog staff."), visible(queue.html).slice(600, 1400));
  const form = formWith(queue.html, "resolution");
  check("with a form to resolve it", Boolean(form) && form.hidden.item_id === item);
  check("which the read-only checks above would have caught: it's the one form here that writes", writingForms(queue.html).length === 1);
  const before = psql(`select revision || '/' || status || '/' || updated_at from public.releases where id = '${releaseId}';`);
  const forged = await collector.browser.submit("/admin/catalog/reclassifications", form, { resolution: "Forged" });
  check("a collector's forged submission resolves nothing", psql(`select resolved_at is null from private.catalog_reclassifications where id = '${item}';`) === "t", String(forged.response.status));
  const empty = await editor.browser.submit("/admin/catalog/reclassifications", form, { resolution: "   " });
  check("without a resolution, nothing changes", location(empty.response).includes("error=reason") && psql(`select resolved_at is null from private.catalog_reclassifications where id = '${item}';`) === "t");
  const resolved = await editor.browser.submit("/admin/catalog/reclassifications", form, { resolution: `${TAG} checked, the release stands` });
  check("the editor resolves it", location(resolved.response).includes("notice=resolved")
    && psql(`select resolved_by || '/' || resolution from private.catalog_reclassifications where id = '${item}';`) === `${editor.id}/${TAG} checked, the release stands`);
  check("which is audited with its reason", psql(`select count(*) from private.audit_events where action = 'catalog_review_resolved' and actor_id = '${editor.id}' and reason = '${TAG} checked, the release stands';`) === "1");
  check("and changes no catalog record", psql(`select revision || '/' || status || '/' || updated_at from public.releases where id = '${releaseId}';`) === before);
  const again = await editor.browser.submit("/admin/catalog/reclassifications", form, { resolution: "Again" });
  check("it can't be resolved twice", location(again.response).includes("error=unavailable"));
  check("and leaves the queue", visible((await editor.browser.get("/admin/catalog/reclassifications")).html).includes("Nothing waiting"));
  check("the run's page shows administrators the resolution", visible((await admin.browser.get(`/admin/imports/runs/${run2}`)).html).includes(`${TAG} checked, the release stands`));

  const errors = appErrorLines();
  check("the app logged no errors", errors.length === 0, errors.join(" | "));
} catch (error) {
  check("the checks ran to the end", false, error.message);
} finally {
  stopApp();
  psql(`begin;
delete from private.catalog_reclassifications where reason like '${TAG}%';
delete from private.import_run_records where import_run_id in (select id from private.import_runs where source_name like '${TAG}%');
delete from private.provider_records where import_run_id in (select id from private.import_runs where source_name like '${TAG}%');
delete from private.import_runs where source_name like '${TAG}%';
commit;`);
  const ids = await deleteUsers();
  const list = ids.map((id) => `'${id}'`).join(",") || "null";
  psql(`begin; set local session_replication_role = replica; delete from private.audit_events where actor_id in (${list}) or target_profile_id in (${list}); commit;`);
  psql("delete from private.handle_holds where kind = 'released' and handle like 'rf\\_%';");
  removeFixture();
  check("no import row, account, hold or audit row is left behind",
    psql(`select (select count(*) from private.import_runs where source_name like '${TAG}%') + (select count(*) from private.provider_records where external_id like '${TAG}%')
      + (select count(*) from private.catalog_reclassifications where reason like '${TAG}%') + (select count(*) from auth.users where id in (${list}))
      + (select count(*) from private.handle_holds where handle like 'rf\\_%') + (select count(*) from private.audit_events where actor_id in (${list}));`) === "0");
  console.log(`\n${results.passed} passed, ${results.failed} failed`);
  process.exit(results.failed ? 1 : 0);
}
