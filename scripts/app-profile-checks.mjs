/**
 * M11a-3 app checks: the profile editor (display name, bio, handle, collection privacy),
 * the avatar workflow behind it, and the Settings pages, driven through the built app
 * over HTTP as a browser without JavaScript would, against the local test stack.
 *
 *   npm run build && npm run test-stack:run -- app:profile-checks
 *
 * Destructive, so it refuses a protected development stack. Throwaway accounts only;
 * nothing printed contains a token, key, password or address.
 */
import { randomBytes } from "node:crypto";

import {
  appErrorLines,
  appLog,
  Browser,
  check,
  createUser,
  decode,
  deleteUsers,
  formWith,
  isRedirect,
  location,
  psql,
  results,
  section,
  signInAs,
  startApp,
  stopApp,
  streamedRedirectTo,
} from "./app-harness.mjs";
import { stackStatus } from "./lib/stack.mjs";

const stack = stackStatus({ label: "the profile app checks" });
const api = stack.API_URL;
const publishable = stack.PUBLISHABLE_KEY ?? stack.ANON_KEY;
const anon = { apikey: publishable, Authorization: `Bearer ${publishable}` };
await startApp(3299);

const PROFILE = "/settings/profile";
const visible = (html) => decode(html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
const sql = (value) => `'${String(value).replace(/'/g, "''")}'`;
const stored = (id, column) => psql(`select coalesce(${column}, '<null>') from public.profiles where id = ${sql(id)};`);

/** A throwaway account with a handle (prefix pf_), signed in in its own browser. */
async function person({ mfa = false, role = null } = {}) {
  const user = await createUser({ prefix: "apppf", mfa: mfa || Boolean(role) });
  const browser = new Browser();
  await signInAs(browser, user, "/home");
  const welcome = await browser.get("/welcome");
  await browser.submit("/welcome", formWith(welcome.html, "handle"), { handle: `pf_${randomBytes(5).toString("hex")}` });
  if (role) psql(`insert into public.staff_roles (user_id, role) values (${sql(user.id)}, ${sql(role)});`);
  const handle = psql(`select handle from public.profiles where id = ${sql(user.id)};`);
  return { ...user, browser, handle };
}

/** Submits the name-and-bio form as the page renders it; returns the response and where it led. */
async function save(user, fields, headers = {}) {
  const page = await user.browser.get(PROFILE);
  const form = formWith(page.html, "display_name");
  if (!form) throw new Error("no profile form");
  const sent = await user.browser.submit(PROFILE, form, { display_name: "", bio: "", ...fields }, headers);
  return { ...sent, to: location(sent.response) };
}
const errorOf = (to) => new URL(to || "/", "http://x").searchParams.get("error");
const noticeOf = (to) => new URL(to || "/", "http://x").searchParams.get("notice");

try {
  section("Settings and the way to the profile");
  {
    const visitor = new Browser();
    const out = await visitor.get(PROFILE);
    check("the profile editor needs signing in", isRedirect(out.response) && location(out.response).endsWith(`/sign-in?next=${encodeURIComponent(PROFILE)}`), location(out.response));
    const a = await person();
    const settings = await a.browser.get("/settings");
    for (const [href, label] of [[PROFILE, "Profile"], ["/settings/account", "Account and password"], ["/settings/security", "Security"]]) {
      check(`settings link to ${label}`, settings.html.includes(`href="${href}"`) && visible(settings.html).includes(label));
    }
    check("settings show who's signed in", visible(settings.html).includes(`@${a.handle}`));
    const old = await a.browser.get("/profile");
    check("/profile sends you to the profile editor", streamedRedirectTo(old.html, PROFILE) || (isRedirect(old.response) && location(old.response).endsWith(PROFILE)));
    const page = await a.browser.get(PROFILE);
    const text = visible(page.html);
    check("the editor opens", page.response.status === 200 && Boolean(formWith(page.html, "display_name")) && Boolean(formWith(page.html, "bio")));
    check("it shows the current handle and its rules", text.includes(`Your handle is @${a.handle}`) && text.includes("30 days"));
    check("it says which fields are public", text.includes("Your handle, display name, bio and photo are public") && text.includes("including people who aren't signed in"));
    check("it shows the collection is private, and sharing comes later", text.includes("Private. Only you can see your collection.") && text.includes("Sharing your collection with others arrives in a later update"));
    check("the account page has its new name", visible((await a.browser.get("/settings/account")).html).includes("Account and password"));

    section("Display name and bio");
    let r = await save(a, { display_name: "  Mike the Collector  ", bio: "Retro handhelds.\r\nMostly boxed." });
    check("a display name and bio are saved", noticeOf(r.to) === "profile_saved" && stored(a.id, "display_name") === "Mike the Collector" && stored(a.id, "bio") === "Retro handhelds.\nMostly boxed.", r.to);
    let after = await a.browser.get(r.to);
    check("the page says so", visible(after.html).includes("Your profile is saved."));
    check("the public card shows them", visible(after.html).includes("Mike the Collector") && visible(after.html).includes("Mostly boxed."));
    const card = await fetch(`${api}/rest/v1/profiles?id=eq.${a.id}&select=display_name,bio`, { headers: anon }).then((x) => x.json());
    check("signed-out visitors can read them, as the page says", card[0]?.display_name === "Mike the Collector" && card[0]?.bio === "Retro handhelds.\nMostly boxed.");

    r = await save(a, { display_name: "   ", bio: "" });
    check("empty fields are saved as none", noticeOf(r.to) === "profile_saved" && stored(a.id, "display_name") === "<null>" && stored(a.id, "bio") === "<null>");
    check("with no display name, the card shows the handle", visible((await a.browser.get(PROFILE)).html).includes(`@${a.handle}`));

    await save(a, { display_name: "Kept Name", bio: "Kept bio" });
    const refusals = [
      ["a 51-character display name", { display_name: "x".repeat(51), bio: "Kept bio" }, "display_name_too_long"],
      ["a display name with a line break", { display_name: "Two\nLines", bio: "Kept bio" }, "display_name_characters"],
      ["a display name with a zero-width space", { display_name: "Kept​Name", bio: "Kept bio" }, "display_name_invisible"],
      ["a display name with a right-to-left override", { display_name: "Kept‮Name", bio: "Kept bio" }, "display_name_invisible"],
      ["a 501-character bio", { display_name: "Kept Name", bio: "y".repeat(501) }, "bio_too_long"],
      ["a bio with a joined emoji", { display_name: "Kept Name", bio: "Family 👨‍👩‍👧" }, "bio_invisible"],
      ["a huge display name", { display_name: "z".repeat(100_000), bio: "Kept bio" }, "display_name_too_long"],
    ];
    for (const [label, fields, code] of refusals) {
      r = await save(a, fields);
      check(`${label} is refused, saying why`, errorOf(r.to) === code && stored(a.id, "display_name") === "Kept Name" && stored(a.id, "bio") === "Kept bio", r.to);
    }
    after = await a.browser.get(`${PROFILE}?error=bio_too_long`);
    check("the error is shown and the field marked", visible(after.html).includes("Use up to 500 characters for your bio.") && /<textarea[^>]*aria-invalid="true"[^>]*aria-describedby="[^"]*page-error/.test(after.html));
    check("an unknown error code shows nothing", !/role="alert"[^>]*>\s*<p/.test((await a.browser.get(`${PROFILE}?error=%3Cscript%3E`)).html));

    section("The database's own rules");
    for (const name of ["My Game Dex", "mygamedex fan", "MyGameD3x", "G.A.M.E D.E.X", "The GameDex Team", "gamedex"]) {
      r = await save(a, { display_name: name, bio: "Kept bio" });
      check(`"${name}" as a display name is refused as the platform's`, errorOf(r.to) === "display_name_reserved" && stored(a.id, "display_name") === "Kept Name", r.to);
    }
    r = await save(a, { display_name: "Game Collector Dex", bio: "Kept bio" });
    check("a name merely using the words is allowed", noticeOf(r.to) === "profile_saved" && stored(a.id, "display_name") === "Game Collector Dex");
    r = await save(a, { display_name: "🎮".repeat(50), bio: `${"a".repeat(249)}\r\n${"b".repeat(250)}` });
    check("limits count characters as the database does (50 emoji, 500 with a line break)", noticeOf(r.to) === "profile_saved" && stored(a.id, "char_length(display_name)::text") === "50" && stored(a.id, "char_length(bio)::text") === "500", r.to);
    r = await save(a, { display_name: "ﬁsh ＧＡＭＥＲ", bio: "" });
    check("a display name is saved NFKC-normalized, as the database requires", noticeOf(r.to) === "profile_saved" && stored(a.id, "display_name") === "fish GAMER", r.to);

    section("Safe rendering");
    const hostile = `<script>alert(1)</script><img src=x onerror=alert(2)> "quoted" & 'single'`;
    r = await save(a, { display_name: "<b>Bold</b>", bio: hostile });
    check("markup is saved as plain text", noticeOf(r.to) === "profile_saved" && stored(a.id, "bio") === hostile);
    after = await a.browser.get(PROFILE);
    const withoutScripts = after.html.replace(/<script[\s\S]*?<\/script>/g, "");
    check("and shown escaped, never as markup", withoutScripts.includes("&lt;script&gt;alert(1)&lt;/script&gt;") && !withoutScripts.includes("<img src=x") && !withoutScripts.includes("<b>Bold</b>") && withoutScripts.includes("&lt;b&gt;Bold&lt;/b&gt;"));
    check("the account menu escapes it too", visible((await a.browser.get("/settings")).html).includes("<b>Bold</b>"));

    section("Only your own profile");
    const b = await person();
    await save(b, { display_name: "Person B", bio: "B's bio" });
    r = await save(a, { display_name: "From A", bio: "A", id: b.id, user_id: b.id, p_user_id: b.id, handle: "pf_taken", avatar_path: `${b.id}/00000000-0000-4000-8000-000000000000.webp`, collection_visibility: "public", account_status: "active" });
    check("extra fields naming someone else change nothing of theirs", stored(b.id, "display_name") === "Person B" && stored(b.id, "bio") === "B's bio");
    check("and change only the name and bio of yours", stored(a.id, "display_name") === "From A" && stored(a.id, "handle") === a.handle && stored(a.id, "avatar_path") === "<null>" && stored(a.id, "collection_visibility::text") === "private");
    check("B's editor shows only B", !visible((await b.browser.get(PROFILE)).html).includes("From A"));
    const viaApi = await fetch(`${api}/rest/v1/profiles?id=eq.${b.id}`, {
      method: "PATCH",
      headers: { apikey: publishable, Authorization: `Bearer ${await tokenOf(a)}`, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ display_name: "Hijacked" }),
    });
    check("A's own token can't change B's profile through the API either", viaApi.status < 500 && stored(b.id, "display_name") === "Person B", `status ${viaApi.status}`);

    const visitor2 = new Browser();
    const anonymous = await visitor2.submit(PROFILE, formWith((await a.browser.get(PROFILE)).html, "display_name"), { display_name: "Nobody", bio: "" });
    check("saving without a session changes nothing", isRedirect(anonymous.response) && location(anonymous.response).includes("/sign-in") && stored(a.id, "display_name") === "From A");
    r = await save(a, { display_name: "Cross Site", bio: "" }, { origin: "https://evil.example" });
    check("a save posted from another site is refused", !isRedirect(r.response) && stored(a.id, "display_name") === "From A", `status ${r.response.status}`);

    section("Public and private data");
    const columns = await fetch(`${api}/rest/v1/profiles?id=eq.${a.id}&select=collection_visibility`, { headers: anon });
    check("the collection's visibility isn't readable by others", !columns.ok);
    const signedInOther = await fetch(`${api}/rest/v1/profiles?id=eq.${a.id}&select=allow_search_indexing,account_status`, { headers: { apikey: publishable, Authorization: `Bearer ${await tokenOf(b)}` } });
    check("nor the account's other settings, even signed in", !signedInOther.ok);
    const cardRead = await fetch(`${api}/rest/v1/profiles?id=eq.${a.id}&select=id,handle,display_name,avatar_path,bio,country_code`, { headers: anon });
    check("the public card's six columns are readable signed out", cardRead.ok && (await cardRead.json()).length === 1);
    const hidden = [];
    for (const column of ["collection_visibility", "follow_approval_required", "allow_search_indexing", "account_status", "handle_changed_at", "handle_correction_until", "created_at", "updated_at"]) {
      if ((await fetch(`${api}/rest/v1/profiles?id=eq.${a.id}&select=${column}`, { headers: anon })).ok) hidden.push(column);
    }
    check("and no other column is", hidden.length === 0, hidden.join(","));
    const items = await fetch(`${api}/rest/v1/collection_items?select=id&limit=1`, { headers: anon });
    check("collection items aren't readable signed out", !items.ok || (await items.json()).length === 0);

    section("Handle");
    const settingsHandle = await a.browser.get(PROFILE);
    const corrected = `${a.handle}x`;
    const changed = await a.browser.submit(PROFILE, formWith(settingsHandle.html, "handle"), { handle: corrected });
    check("the handle can be corrected within a day, here", isRedirect(changed.response) && stored(a.id, "handle") === corrected);
    const afterHandle = visible((await a.browser.get(PROFILE)).html);
    check("then it shows when it can next change, and no form", afterHandle.includes("You can change it again on") && !formWith((await a.browser.get(PROFILE)).html, "handle"));
    const forced = await a.browser.submit(PROFILE, formWith(settingsHandle.html, "handle"), { handle: `${a.handle}y` });
    check("and a replayed form can't skip the cooldown", stored(a.id, "handle") === corrected, `status ${forced.response.status}`);
    a.handle = corrected;

    section("An account that isn't active");
    const s = await person();
    await save(s, { display_name: "Before", bio: "" });
    const form = formWith((await s.browser.get(PROFILE)).html, "display_name");
    psql(`update public.profiles set account_status = 'suspended' where id = ${sql(s.id)};`);
    const page2 = await s.browser.get(PROFILE);
    const nameInput = /<input[^>]*name="display_name"[^>]*>/.exec(page2.html)?.[0] ?? "";
    check("a suspended account sees its profile, and that it can't change it", page2.response.status === 200 && visible(page2.html).includes("This account isn't active") && /\sdisabled(=""|\s|>)/.test(nameInput), nameInput.replace(/class="[^"]*"/, "").slice(0, 300));
    r = await s.browser.submit(PROFILE, form, { display_name: "After", bio: "" });
    check("and a save is refused", errorOf(location(r.response)) === "not_active" && stored(s.id, "display_name") === "Before", location(r.response));
    check("a suspended account has no handle form", !formWith(page2.html, "handle"));
    psql(`update public.profiles set account_status = 'active' where id = ${sql(s.id)};`);

    section("Authenticators and staff");
    const m = await person({ mfa: true });
    r = await save(m, { display_name: "Has TOTP", bio: "" });
    check("an account with an authenticator edits its profile after verifying", noticeOf(r.to) === "profile_saved" && stored(m.id, "display_name") === "Has TOTP");
    const admin = await person({ role: "admin" });
    r = await save(admin, { display_name: "An Admin", bio: "" });
    check("an administrator edits their own profile like anyone", noticeOf(r.to) === "profile_saved" && stored(admin.id, "display_name") === "An Admin");
    check("staff get no way to edit someone else's here", !(await admin.browser.get(`${PROFILE}?user=${b.id}`)).html.includes("Person B"));
  }
} catch (error) {
  check(`the checks ran to the end (${error.message})`, false);
} finally {
  stopApp();
  await deleteUsers();
  psql("delete from private.handle_holds where kind = 'released' and handle like 'pf\\_%';");
  check("no handle holds are left behind", psql("select count(*) from private.handle_holds where handle like 'pf\\_%';") === "0");
  check("no test account is left behind", psql("select count(*) from auth.users where email like 'apppf-%';") === "0");
}

/** The access token in a browser's session cookie. Never printed. */
async function tokenOf(user) {
  const { readSession } = await import("./app-harness.mjs");
  return readSession(user.browser)?.session?.access_token ?? "";
}

// Expected: the cross-site post.
const expected = /Invalid Server Actions request/;
check("the app logged the cross-site refusal", expected.test(appLog()));
const errorLines = appErrorLines(expected);
check("the app logged no other errors", errorLines.length === 0, `${errorLines.length} lines`);
for (const line of errorLines.slice(0, 10)) console.log(`  ${line}`);
console.log(`\n${results.passed} passed, ${results.failed} failed`);
process.exit(results.failed === 0 ? 0 : 1);
