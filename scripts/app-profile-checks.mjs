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
import { randomBytes, randomUUID } from "node:crypto";

import sharp from "sharp";

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
const secret = stack.SECRET_KEY ?? stack.SERVICE_ROLE_KEY;
const service = { apikey: secret, Authorization: `Bearer ${secret}` };
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
  await avatars();
} catch (error) {
  check(`the checks ran to the end (${error.message})`, false);
} finally {
  stopApp();
  // Storage files don't cascade from a deleted user (security-rls.md#account-deletion):
  // remove each test account's folder through the Storage API first.
  const ids = psql("select id from auth.users where email like 'apppf-%';").split("\n").filter(Boolean);
  let filesLeft = 0;
  for (const id of ids) {
    const paths = (await folder(id)) ?? [];
    if (paths.length) await fetch(`${api}/storage/v1/object/avatars`, { method: "DELETE", headers: { ...service, "Content-Type": "application/json" }, body: JSON.stringify({ prefixes: paths }) });
    filesLeft += ((await folder(id)) ?? [null]).length;
  }
  check("no test avatar file is left behind", filesLeft === 0, String(filesLeft));
  await deleteUsers();
  psql("delete from private.handle_holds where kind = 'released' and handle like 'pf\\_%';");
  check("no handle holds are left behind", psql("select count(*) from private.handle_holds where handle like 'pf\\_%';") === "0");
  check("no test account is left behind", psql("select count(*) from auth.users where email like 'apppf-%';") === "0");
}

// ---------------------------------------------------------------------------
// Avatars
// ---------------------------------------------------------------------------

function image(width = 300, height = 200, colour = { r: 200, g: 40, b: 90 }) { return sharp({ create: { width, height, channels: 3, background: colour } }); }
function publicFile(path) { return fetch(`${api}/storage/v1/object/public/avatars/${path}`); }
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
async function folder(userId) {
  const r = await fetch(`${api}/storage/v1/object/list/avatars`, { method: "POST", headers: { ...service, "Content-Type": "application/json" }, body: JSON.stringify({ prefix: `${userId}/`, limit: 100 }) });
  return r.ok ? (await r.json()).map((o) => `${userId}/${o.name}`).sort() : null;
}

/** Submits the photo form with a file, as a browser would. */
async function upload(user, bytes, { name = "photo.jpg", type = "image/jpeg", headers = {}, extra = {} } = {}) {
  // M11a-4a limits uploads to ten an hour; these checks upload more, so each starts afresh
  // (app-export-checks.mjs tests the limit itself).
  psql(`delete from private.request_slots where user_id = ${sql(user.id)} and kind = 'avatar_upload';`);
  const page = await user.browser.get(PROFILE);
  const form = formWith(page.html, "avatar");
  if (!form) throw new Error("no photo form");
  const sent = await user.browser.submit(PROFILE, form, { ...extra, avatar: new File([bytes], name, { type }) }, headers);
  return { ...sent, to: location(sent.response) };
}

/** Submits the "Remove photo" form. */
async function removePhoto(user, headers = {}) {
  const page = await user.browser.get(PROFILE);
  const match = [...page.html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/g)].find(([, inner]) => visible(inner).includes("Remove photo"));
  if (!match) throw new Error("no remove form");
  const hidden = {};
  for (const [input] of match[1].matchAll(/<input\b[^>]*>/g)) {
    const name = /\bname="([^"]*)"/.exec(input)?.[1];
    if (name && /type="hidden"/.test(input)) hidden[decode(name)] = decode(/\bvalue="([^"]*)"/.exec(input)?.[1] ?? "");
  }
  const sent = await user.browser.submit(PROFILE, { hidden }, {}, headers);
  return { ...sent, to: location(sent.response) };
}

async function avatars() {
  section("Photo: upload, replace, remove");
  const a = await person();
  const b = await person();
  let page = await a.browser.get(PROFILE);
  check("with no photo, the initial is shown and there's nothing to remove", visible(page.html).includes("No photo yet") && !visible(page.html).includes("Remove photo"));
  check("the file picker offers JPEG, PNG and WebP", /<input[^>]*accept="image\/jpeg,image\/png,image\/webp"/.test(page.html));
  check("no page carries the secret key", !page.html.includes(secret));

  const marker = "SECRET-GPS-MARKER";
  const jpeg = await image().withExif({ IFD0: { Copyright: marker, Artist: marker }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "51/1 30/1 0/1" } }).jpeg().toBuffer();
  check("the test photo really carries camera and location data", jpeg.includes(marker));
  let r = await upload(a, jpeg);
  const first = stored(a.id, "avatar_path");
  check("a JPEG is uploaded", noticeOf(r.to) === "avatar_saved" && new RegExp(`^${a.id}/[0-9a-f-]{36}\\.webp$`).test(first), r.to);
  const file = await publicFile(first);
  const bytes = Buffer.from(await file.arrayBuffer());
  const meta = await sharp(bytes).metadata();
  check("it's stored as a 512×512 WebP", file.ok && file.headers.get("content-type") === "image/webp" && meta.format === "webp" && meta.width === 512 && meta.height === 512, `${meta.format} ${meta.width}x${meta.height}`);
  check("without the camera or location data", !meta.exif && !meta.xmp && !meta.iptc && !bytes.includes(marker));
  page = await a.browser.get(r.to);
  check("the page shows it, and offers to replace or remove it", page.html.includes(`/storage/v1/object/public/avatars/${first}`) && visible(page.html).includes("Your photo is updated.") && visible(page.html).includes("Remove photo"));
  check("the settings page and account menu show it too", (await a.browser.get("/settings")).html.includes(first));

  r = await upload(a, await image(400, 400, { r: 20, g: 120, b: 220 }).png().toBuffer(), { name: "photo.png", type: "image/png" });
  const second = stored(a.id, "avatar_path");
  check("a PNG replaces it, under a new name", noticeOf(r.to) === "avatar_saved" && second !== first && second.startsWith(`${a.id}/`));
  check("the old file is removed from storage", !(await publicFile(first)).ok);
  check("the folder holds only the current photo", same(await folder(a.id), [second]));
  r = await upload(a, await image(64, 64).webp().toBuffer(), { name: "photo.webp", type: "image/webp" });
  const third = stored(a.id, "avatar_path");
  check("a WebP is accepted too", noticeOf(r.to) === "avatar_saved" && third !== second && same(await folder(a.id), [third]));

  section("Photo: what's refused");
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><script>alert(1)</script></svg>');
  const refused = [
    ["a text file claiming to be a PNG", Buffer.from("just text, not an image ".repeat(20)), "notes.png", "image/png", "avatar_type"],
    ["an SVG", svg, "photo.svg", "image/svg+xml", "avatar_type"],
    ["an SVG renamed and labelled as a JPEG", svg, "photo.jpg", "image/jpeg", "avatar_type"],
    ["a GIF", await image().gif().toBuffer(), "photo.gif", "image/gif", "avatar_type"],
    ["an HTML page labelled as a WebP", Buffer.from("<!doctype html><script>alert(1)</script>"), "x.webp", "image/webp", "avatar_type"],
    ["a JPEG cut off part way", (await image(800, 800).jpeg().toBuffer()).subarray(0, 600), "cut.jpg", "image/jpeg", "avatar_invalid"],
    ["JPEG markers followed by noise", Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(5000)]), "noise.jpg", "image/jpeg", "avatar_invalid"],
    ["a 16-pixel image", await image(16, 16).png().toBuffer(), "tiny.png", "image/png", "avatar_dimensions"],
    ["a 5000×40 image", await image(5000, 40).png().toBuffer(), "wide.png", "image/png", "avatar_dimensions"],
    ["a file just over 2 MB", Buffer.concat([await image().jpeg().toBuffer(), Buffer.alloc(2 * 1024 * 1024)]), "big.jpg", "image/jpeg", "avatar_too_large"],
    ["an empty file", Buffer.alloc(0), "empty.jpg", "image/jpeg", "avatar_missing"],
  ];
  for (const [label, body, name, type, code] of refused) {
    r = await upload(a, body, { name, type });
    check(`${label} is refused, saying why`, errorOf(r.to) === code && stored(a.id, "avatar_path") === third, r.to);
  }
  check("after all that, the current photo is untouched and alone", (await publicFile(third)).ok && same(await folder(a.id), [third]));
  page = await a.browser.get(`${PROFILE}?error=avatar_type`);
  check("the error is shown and the file field marked", visible(page.html).includes("Use a JPEG, PNG or WebP image") && /<input[^>]*type="file"[^>]*aria-invalid="true"/.test(page.html));
  r = await upload(a, await image(100, 100).png().toBuffer(), { name: "photo.jpg", type: "image/jpeg" });
  const fourth = stored(a.id, "avatar_path");
  check("a real PNG with a .jpg name and JPEG type is judged by its bytes, and accepted", noticeOf(r.to) === "avatar_saved" && fourth !== third);

  const huge = Buffer.concat([await image().jpeg().toBuffer(), randomBytes(3 * 1024 * 1024)]);
  r = await upload(a, huge);
  check("a request over the action's body limit is refused before the action runs", !r.to.includes("notice=") && !r.to.includes("error=") && r.response.status >= 400 && stored(a.id, "avatar_path") === fourth, `status ${r.response.status} ${r.to}`);
  check("and leaves nothing in storage", same(await folder(a.id), [fourth]));

  section("Photo: failures part way, and retrying");
  try {
    psql(`create function public.__pf_boom() returns trigger language plpgsql set search_path = '' as $$ begin raise exception 'secret internal detail'; end $$;
          create trigger __pf_boom before update of avatar_path on public.profiles for each row execute function public.__pf_boom();`);
    r = await upload(a, await image(200, 200).jpeg().toBuffer());
    check("a failed activation says the photo wasn't saved, and nothing more", errorOf(r.to) === "avatar_failed" && !visible((await a.browser.get(r.to)).html).includes("secret internal detail"), r.to);
    check("the new file is removed, and the current photo still works", same(await folder(a.id), [fourth]) && (await publicFile(fourth)).ok);
  } finally {
    psql("drop trigger if exists __pf_boom on public.profiles; drop function if exists public.__pf_boom();");
  }
  r = await upload(a, await image(200, 200).jpeg().toBuffer());
  const fifth = stored(a.id, "avatar_path");
  check("trying again then works", noticeOf(r.to) === "avatar_saved" && fifth !== fourth && same(await folder(a.id), [fifth]));

  // Leftovers from an earlier failure (an old file not removed, or a crash before
  // activation): one older than ten minutes goes with the next change, a recent one stays.
  const oldLeftover = `${a.id}/${randomUUID()}.webp`;
  const newLeftover = `${a.id}/${randomUUID()}.webp`;
  for (const path of [oldLeftover, newLeftover]) {
    await fetch(`${api}/storage/v1/object/avatars/${path}`, { method: "POST", headers: { ...service, "Content-Type": "image/webp" }, body: await image(64, 64).webp().toBuffer() });
  }
  psql(`update storage.objects set created_at = now() - interval '1 hour' where bucket_id = 'avatars' and name = ${sql(oldLeftover)};`);
  r = await upload(a, await image(120, 120).png().toBuffer(), { name: "p.png", type: "image/png" });
  const sixth = stored(a.id, "avatar_path");
  const after = await folder(a.id);
  check("the next change removes an old leftover file", noticeOf(r.to) === "avatar_saved" && !after.includes(oldLeftover) && !(await publicFile(oldLeftover)).ok);
  check("but not a recent one, which a change in progress may be about to use", after.includes(newLeftover) && after.includes(sixth) && after.length === 2, String(after.length));
  await fetch(`${api}/storage/v1/object/avatars`, { method: "DELETE", headers: { ...service, "Content-Type": "application/json" }, body: JSON.stringify({ prefixes: [newLeftover] }) });

  section("Photo: only your own");
  await upload(b, await image(90, 90).png().toBuffer(), { name: "b.png", type: "image/png" });
  const bPhoto = stored(b.id, "avatar_path");
  r = await upload(a, await image(91, 91).png().toBuffer(), { name: "a.png", type: "image/png", extra: { user_id: b.id, p_user_id: b.id, id: b.id, path: bPhoto } });
  const seventh = stored(a.id, "avatar_path");
  check("an upload naming someone else lands in your own folder", noticeOf(r.to) === "avatar_saved" && seventh.startsWith(`${a.id}/`) && seventh !== sixth);
  check("and leaves theirs alone", stored(b.id, "avatar_path") === bPhoto && (await publicFile(bPhoto)).ok && same(await folder(b.id), [bPhoto]));
  r = await upload(a, await image().jpeg().toBuffer(), { headers: { origin: "https://evil.example" } });
  check("an upload posted from another site is refused", !isRedirect(r.response) && stored(a.id, "avatar_path") === seventh, `status ${r.response.status}`);
  const visitor = new Browser();
  const pageForm = formWith((await a.browser.get(PROFILE)).html, "avatar");
  const outsider = await visitor.submit(PROFILE, pageForm, { avatar: new File([await image().jpeg().toBuffer()], "x.jpg", { type: "image/jpeg" }) });
  check("an upload without a session is sent to sign in, and changes nothing", location(outsider.response).includes("/sign-in") && stored(a.id, "avatar_path") === seventh);
  const direct = await fetch(`${api}/storage/v1/object/avatars/${a.id}/${randomUUID()}.webp`, { method: "POST", headers: { apikey: publishable, Authorization: `Bearer ${await tokenOf(a)}`, "Content-Type": "image/webp" }, body: await image(64, 64).webp().toBuffer() });
  check("the browser's own session still can't write to the bucket directly", !direct.ok && (await folder(a.id)).length === 1, `status ${direct.status}`);

  section("Photo: a session that has ended");
  const c = await person();
  await upload(c, await image(100, 100).png().toBuffer(), { name: "c.png", type: "image/png" });
  const cPhoto = stored(c.id, "avatar_path");
  const cForm = formWith((await c.browser.get(PROFILE)).html, "avatar");
  const cProfileForm = formWith((await c.browser.get(PROFILE)).html, "display_name");
  const elsewhere = await fetch(`${api}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: publishable, "Content-Type": "application/json" }, body: JSON.stringify({ email: c.email, password: c.password }) }).then((x) => x.json());
  await fetch(`${api}/auth/v1/logout?scope=global`, { method: "POST", headers: { apikey: publishable, Authorization: `Bearer ${elsewhere.access_token}` } });
  const stale = await c.browser.submit(PROFILE, cForm, { avatar: new File([await image(110, 110).png().toBuffer()], "c2.png", { type: "image/png" }) });
  check("after signing out everywhere, an old device's unexpired token can't change the photo", stored(c.id, "avatar_path") === cPhoto && !location(stale.response).includes("notice="), location(stale.response));
  await c.browser.submit(PROFILE, cProfileForm, { display_name: "After sign-out", bio: "" });
  // Accepted before the session-revocation checkpoint (PostgREST trusted the unexpired token).
  check("nor save the name and bio (the database checks the session is still Auth's)", stored(c.id, "display_name") !== "After sign-out");

  section("Photo: an account that isn't active");
  const bForm = formWith((await b.browser.get(PROFILE)).html, "avatar");
  psql(`update public.profiles set account_status = 'suspended' where id = ${sql(b.id)};`);
  r = await b.browser.submit(PROFILE, bForm, { avatar: new File([await image().jpeg().toBuffer()], "x.jpg", { type: "image/jpeg" }) });
  check("a suspended account can't upload", errorOf(location(r.response)) === "avatar_not_eligible" && stored(b.id, "avatar_path") === bPhoto, location(r.response));
  page = await b.browser.get(PROFILE);
  check("and its photo controls are disabled", /<input[^>]*type="file"[^>]*disabled/.test(page.html));
  psql(`update public.profiles set account_status = 'active' where id = ${sql(b.id)};`);

  section("Photo: removal");
  r = await removePhoto(a);
  check("removing the photo clears it", noticeOf(r.to) === "avatar_removed" && stored(a.id, "avatar_path") === "<null>", r.to);
  check("and removes its file from storage", !(await publicFile(seventh)).ok && (await folder(a.id)).length === 0);
  page = await a.browser.get(r.to);
  check("the page says so, shows the initial, and offers no removal", visible(page.html).includes("Your photo is removed") && visible(page.html).includes("No photo yet") && !visible(page.html).includes("Remove photo"));
  r = await removePhoto(b, { origin: "https://evil.example" });
  check("a removal posted from another site is refused", !isRedirect(r.response) && stored(b.id, "avatar_path") === bPhoto);
  const card = await fetch(`${api}/rest/v1/profiles?id=eq.${b.id}&select=avatar_path`, { headers: anon }).then((x) => x.json());
  check("a photo is public, as the page says: signed-out visitors see its path and file", card[0]?.avatar_path === bPhoto && (await publicFile(bPhoto)).ok);
}

/** The access token in a browser's session cookie. Never printed. */
async function tokenOf(user) {
  const { readSession } = await import("./app-harness.mjs");
  return readSession(user.browser)?.session?.access_token ?? "";
}

// Expected: the cross-site post.
const expected = /Invalid Server Actions request|Body exceeded|Invalid Refresh Token|__isAuthError: true|session_not_found/;
check("the app logged the cross-site refusal", expected.test(appLog()));
const errorLines = appErrorLines(expected);
check("the app logged no other errors", errorLines.length === 0, `${errorLines.length} lines`);
for (const line of errorLines.slice(0, 10)) console.log(`  ${line}`);
console.log(`\n${results.passed} passed, ${results.failed} failed`);
process.exit(results.failed === 0 ? 0 : 1);
