// Run with: npm run collection:test. The collection's pure rules: copy ids, the add and
// edit forms' details, the list's URL parameters and the labels. scripts/app-*-checks.mjs
// test the running app.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  addErrorMessage,
  completenessLabel,
  componentField,
  conditionLabel,
  editErrorMessage,
  formatPrice,
  latestAcquisitionDate,
  pieceFieldValue,
  pieceStateLabel,
  priceInput,
  readCopyChanges,
  readCopyDetails,
  relinkErrorMessage,
  releaseLine,
  claimEdition,
  claimErrorMessage,
  claimLine,
  copyStatusLabel,
  EDITION_KIND_OPTIONS,
  EDITION_NAME_SUGGESTIONS,
  historyIdentityText,
  historySourceLabel,
  ownershipEntryLine,
  ownershipHeadline,
  ownershipStatusLabel,
} from "./details.ts";
import { editionKey, fastAddHref, OTHER, planFastAdd, UNSURE } from "./fast-add.ts";
import { collectionHref, copyHref, DEFAULT_PARAMS, moveHref, readCollectionParams, readMoveParams, readNotice } from "./list-params.ts";
import { keepingIdOnFailure, UNCONFIRMED } from "./retry.ts";
import { UUID_V7, uuidv7 } from "./uuid.ts";

test("copy ids are UUIDv7s carrying the time they were made", () => {
  const at = Date.parse("2026-11-11T12:34:56.789Z");
  const id = uuidv7(at);
  assert.match(id, UUID_V7);
  assert.equal(parseInt(id.slice(0, 8) + id.slice(9, 13), 16), at);
});

test("every copy id is new", () => {
  const ids = new Set(Array.from({ length: 1000 }, () => uuidv7()));
  assert.equal(ids.size, 1000);
});

const form = (values) => (name) => values[name] ?? "";
const pieces = [
  { kind: "insert", label: "Poster" },
  { kind: "map", label: "World map" },
];
const today = "2026-11-12";

test("an empty form adds a copy with nothing recorded", () => {
  assert.deepEqual(readCopyDetails(form({}), pieces, today), { details: {} });
});

test("completeness is sent only when chosen", () => {
  assert.deepEqual(readCopyDetails(form({ completeness: "complete", box_condition: "good" }), [], today), {
    details: { completeness: "complete", box_condition: "good" },
  });
  assert.ok("error" in readCopyDetails(form({ completeness: "boxed" }), [], today));
});

test("the physical-copy rules match the database", () => {
  for (const values of [
    { completeness: "loose", box_condition: "good" },
    { completeness: "loose", manual_condition: "fair" },
    { completeness: "complete", box_condition: "not_included" },
    { completeness: "sealed", media_condition: "mint" },
    { media_condition: "not_included" },
    { overall_condition: "not_included" },
  ]) {
    assert.ok("error" in readCopyDetails(form(values), [], today), JSON.stringify(values));
  }
  assert.deepEqual(readCopyDetails(form({ completeness: "loose", box_condition: "not_included", media_condition: "good" }), [], today), {
    details: { completeness: "loose", box_condition: "not_included", media_condition: "good" },
  });
});

test("private details are checked and normalized", () => {
  assert.ok("error" in readCopyDetails(form({ purchase_price: "10" }), [], today), "a price needs a currency");
  assert.deepEqual(readCopyDetails(form({ currency: "EUR" }), [], today), { details: {} }, "a preselected currency alone records nothing");
  assert.ok("error" in readCopyDetails(form({ purchase_price: "10.12345", currency: "EUR" }), [], today));
  assert.ok("error" in readCopyDetails(form({ purchase_price: "-1", currency: "EUR" }), [], today));
  assert.ok("error" in readCopyDetails(form({ acquired_on: "2026-11-13" }), [], today), "no future dates");
  assert.ok("error" in readCopyDetails(form({ acquired_on: "1969-12-31" }), [], today));
  assert.ok("error" in readCopyDetails(form({ notes: "n".repeat(5001) }), [], today));
  assert.ok("error" in readCopyDetails(form({ storage_location: "s".repeat(121) }), [], today));
  assert.deepEqual(
    readCopyDetails(form({ purchase_price: "24,5", currency: "eur", acquired_on: "2020-01-02", notes: "  From a fair\r\n", storage_location: "  Shelf A " }), [], today),
    { details: { acquired_on: "2020-01-02", purchase_price: "24.5", currency: "EUR", notes: "  From a fair\n", storage_location: "Shelf A" } },
  );
  assert.deepEqual(readCopyDetails(form({ currency: "EUR", notes: "   " }), [], today), { details: {} }, "a currency alone or blank notes record nothing");
});

test("only the release's listed pieces are recorded", () => {
  const result = readCopyDetails(form({ [componentField(0)]: "included", [componentField(1)]: "missing", [componentField(2)]: "included" }), pieces, today);
  assert.deepEqual(result, {
    details: {
      components: [
        { kind: "insert", label: "Poster", condition: null },
        { kind: "map", label: "World map", condition: "not_included" },
      ],
    },
  });
});

test("the latest acquisition date allows a day for time zones", () => {
  assert.equal(latestAcquisitionDate(Date.parse("2026-11-11T23:30:00Z")), "2026-11-12");
});

test("database errors become fixed messages, and only stale ids are replaced", () => {
  assert.equal(addErrorMessage("request conflict").renewId, true);
  assert.equal(addErrorMessage("invalid item id").renewId, true);
  assert.equal(addErrorMessage("release unavailable").renewId, false);
  assert.equal(addErrorMessage("account not active").text, "Your account can't add copies right now.");
  assert.equal(addErrorMessage('relation "collection_items" violates something').text, "The copy couldn't be added. Try again.");
});

test("refusals give the reason the form shows", () => {
  const reason = (values) => readCopyDetails(form(values), [], today).error;
  assert.match(reason({ completeness: "loose", box_condition: "good" }), /^A loose copy is the cartridge or disc only/);
  assert.equal(reason({ purchase_price: "10" }), "Choose the currency you paid in.");
  assert.match(reason({ acquired_on: "2999-01-01" }), /can't be in the future/);
  assert.equal(addErrorMessage("release unavailable").text, "This release can't be added to a collection.");
  assert.match(addErrorMessage("invalid item id").text, /^This page was open too long\./);
});

test("a request that fails on the way keeps the id, so a retry adds nothing new", async () => {
  const state = { status: "added", message: "Added to your collection.", itemId: uuidv7(), count: 1 };
  const lost = keepingIdOnFailure(async () => {
    throw new TypeError("Failed to fetch");
  });
  assert.deepEqual(await lost(state, new FormData()), { ...state, status: "error", message: UNCONFIRMED });

  const answered = { status: "already_added", message: "This copy was already added.", itemId: uuidv7(), count: 1 };
  assert.equal(await keepingIdOnFailure(async () => answered)(state, new FormData()), answered);
});

// ---------------------------------------------------------------------------
// My Collection (M6d)
// ---------------------------------------------------------------------------

test("list parameters accept only what the database does", () => {
  assert.deepEqual(readCollectionParams({}), DEFAULT_PARAMS);
  const params = readCollectionParams({ q: "  Starfall ", platform: "snes", completeness: "not_recorded", status: "owned", sort: "title", after: "abc_-1" });
  assert.deepEqual(params, { query: "Starfall", platform: "snes", completeness: "not_recorded", status: "owned", sort: "title", cursor: "abc_-1" });
  const hostile = readCollectionParams({ q: "x".repeat(300), platform: "SNES'; drop", completeness: "mint", status: "deleted", sort: "price", after: "a b" });
  assert.deepEqual(hostile, { ...DEFAULT_PARAMS, query: "x".repeat(100) });
  assert.deepEqual(readCollectionParams({ q: ["a", "b"] }).query, "a");
});

test("list URLs keep the view, without defaults", () => {
  assert.equal(collectionHref(DEFAULT_PARAMS), "/collection");
  const params = { ...DEFAULT_PARAMS, query: "star fall", platform: "snes", sort: "platform", cursor: "c1" };
  assert.equal(collectionHref(params), "/collection?q=star+fall&platform=snes&sort=platform&after=c1");
  assert.equal(collectionHref(DEFAULT_PARAMS, "removed"), "/collection?notice=removed");
  assert.equal(copyHref("0190", params), "/collection/0190?q=star+fall&platform=snes&sort=platform&after=c1");
  assert.deepEqual(readCollectionParams(new URL(`http://x${copyHref("0190", params)}`).searchParams), params);
  assert.equal(readNotice({ notice: "removed" }), "removed");
  assert.equal(readNotice({ notice: "<script>" }), null);
});

test("labels keep not recorded and not included apart", () => {
  assert.equal(completenessLabel(null), "Not recorded");
  assert.equal(conditionLabel(null), "Not recorded");
  assert.equal(conditionLabel("not_included"), "Not included");
  assert.equal(conditionLabel("very_good"), "Very good");
  assert.equal(pieceStateLabel({ recorded: false, condition: null }), "Not recorded");
  assert.equal(pieceStateLabel({ recorded: true, condition: null }), "Included");
  assert.equal(pieceStateLabel({ recorded: true, condition: "not_included" }), "Missing");
  assert.equal(pieceStateLabel({ recorded: true, condition: "good" }), "Included, good");
  assert.deepEqual(["", "included", "missing", "good"], [
    pieceFieldValue({ recorded: false, condition: null }),
    pieceFieldValue({ recorded: true, condition: null }),
    pieceFieldValue({ recorded: true, condition: "not_included" }),
    pieceFieldValue({ recorded: true, condition: "good" }),
  ]);
});

test("a release reads as only what the catalog records", () => {
  const release = { platform: { short_name: "SNES" }, region: { code: "ntsc-uc", label: "NTSC-U/C" }, edition_name: null, variant_name: null };
  assert.equal(releaseLine(release), "SNES · NTSC-U/C");
  assert.equal(releaseLine({ ...release, region: { code: "unknown", label: "Unknown" }, edition_name: "Collector's Edition" }), "SNES · Region unknown · Collector's Edition");
});

test("prices show as stored, and edit as typed", () => {
  assert.equal(priceInput("37.4200"), "37.42");
  assert.equal(priceInput("12.5000"), "12.50");
  assert.equal(priceInput("10.0000"), "10.00");
  assert.equal(priceInput("1.2345"), "1.2345");
  assert.equal(formatPrice({ amount: "37.4200", currency: "EUR" }), "€37.42");
  assert.equal(formatPrice({ amount: "5.0000", currency: "XYZ1" }), "5.00 XYZ1");
});

const listed = [
  { kind: "insert", label: "Poster", recorded: true, condition: null },
  { kind: "map", label: "World map", recorded: false, condition: null },
];
const unchanged = (values) => form({ component_0: "included", ...values });

test("editing sends every field, so an emptied one is cleared", () => {
  const result = readCopyChanges(unchanged({ completeness: "complete", notes: "Kept" }), listed, today);
  assert.deepEqual(result, {
    changes: {
      completeness: "complete", overall_condition: null, box_condition: null, media_condition: null, manual_condition: null,
      acquired_on: null, purchase_price: null, currency: null, notes: "Kept", storage_location: null,
    },
  });
  // A currency left selected without a price is cleared with it.
  assert.equal(readCopyChanges(unchanged({ currency: "EUR" }), listed, today).changes.currency, null);
});

test("editing applies the same rules as adding", () => {
  assert.equal(readCopyChanges(unchanged({ completeness: "loose", box_condition: "good" }), listed, today).error.startsWith("A loose copy"), true);
  assert.equal(readCopyChanges(unchanged({ purchase_price: "10" }), listed, today).error, "Choose the currency you paid in.");
  assert.ok("error" in readCopyChanges(unchanged({ acquired_on: "2999-01-01" }), listed, today));
});

test("pieces are sent only when they change, and grades are kept", () => {
  assert.equal("components" in readCopyChanges(unchanged({}), listed, today).changes, false);
  assert.deepEqual(readCopyChanges(form({}), listed, today).changes.components, [], "clearing every piece");
  assert.deepEqual(readCopyChanges(unchanged({ component_1: "missing" }), listed, today).changes.components, [
    { kind: "insert", label: "Poster", condition: null },
    { kind: "map", label: "World map", condition: "not_included" },
  ]);
  const graded = [{ ...listed[0], condition: "good" }];
  assert.equal("components" in readCopyChanges(form({ component_0: "good" }), graded, today).changes, false);
});

test("edit errors become fixed messages", () => {
  assert.equal(editErrorMessage("account not active"), "Your account can't edit copies right now. You can still remove them.");
  assert.equal(editErrorMessage("item unavailable"), "This copy isn't in your collection any more.");
  assert.equal(editErrorMessage('duplicate key value violates "x"'), "Your changes couldn't be saved. Try again.");
});

const ITEM = "0190f0a0-0000-7000-8000-000000000001";
const RELEASE = "0190f0a0-0000-7000-8000-0000000000aa";

test("the move flow's address keeps only well-formed steps", () => {
  assert.deepEqual(readMoveParams({ move_q: "  starfall ", move_game: "starfall-odyssey", move_to: RELEASE.toUpperCase() }), { query: "starfall", game: "starfall-odyssey", release: RELEASE });
  assert.deepEqual(readMoveParams({ move_q: "x".repeat(101), move_game: "../etc", move_to: "not-a-uuid" }), { query: null, game: null, release: null });
  assert.deepEqual(readMoveParams({}), { query: null, game: null, release: null });
});

test("move links keep how the collection list was left", () => {
  assert.equal(moveHref(ITEM, DEFAULT_PARAMS, { game: "starfall-odyssey" }), `/collection/${ITEM}?move_game=starfall-odyssey#move`);
  const filtered = { ...DEFAULT_PARAMS, platform: "snes" };
  const href = moveHref(ITEM, filtered, { game: "starfall-odyssey", release: RELEASE });
  assert.ok(href.startsWith(copyHref(ITEM, filtered)) && href.includes(`move_to=${RELEASE}`) && href.endsWith("#move"), href);
  assert.equal(moveHref(ITEM, DEFAULT_PARAMS, {}), `/collection/${ITEM}#move`);
});

test("relinking errors become fixed messages, and nothing else gets through", () => {
  assert.equal(relinkErrorMessage("other platform"), "A copy can only move to a release for the same platform. For another platform, add it as a new copy.");
  assert.equal(relinkErrorMessage("release unavailable"), "That release can't hold copies. Choose another one.");
  assert.equal(relinkErrorMessage('new row violates row-level security policy for table "x"'), "The copy couldn't be moved. Try again.");
});

test("an unidentified copy reads as what its owner claims, and 'not sure' where they didn't (M12a)", () => {
  const platform = { slug: "ps1", name: "PlayStation", short_name: "PS1" };
  assert.equal(claimLine({ platform, region: { code: "pal", label: "PAL" }, edition_kind: "reprint", edition_name: "Platinum" }), "PS1 · PAL · Platinum");
  assert.equal(claimLine({ platform, region: null, edition_kind: "reprint", edition_name: "Platinum" }), "PS1 · Region not sure · Platinum");
  assert.equal(claimLine({ platform, region: { code: "pal", label: "PAL" }, edition_kind: null, edition_name: null }), "PS1 · PAL · Edition not sure");
  assert.equal(claimLine({ platform, region: null, edition_kind: null, edition_name: null }), "PS1 · Region not sure · Edition not sure");
  assert.equal(claimEdition({ edition_kind: "collector", edition_name: null }), "Collector's edition", "a kind alone names the edition");
  assert.equal(claimEdition({ edition_kind: "nonsense", edition_name: null }), null, "an unknown kind isn't invented into a name");
  assert.equal(copyStatusLabel("unidentified"), "Not linked to a release");
});

test("claim errors become fixed messages, and nothing else gets through (M12a)", () => {
  assert.equal(claimErrorMessage("game unavailable").text, "This game can't be added to a collection right now.");
  assert.equal(claimErrorMessage("other platform").text, "A copy stays on its platform. For another platform, add it as a new copy.");
  assert.equal(claimErrorMessage("request conflict").renewId, true);
  assert.equal(claimErrorMessage('new row violates row-level security policy for table "x"').text, "The copy couldn't be saved. Try again.");
});

test("the list accepts the unidentified filter (M12a)", () => {
  assert.equal(readCollectionParams(new URLSearchParams("status=unidentified")).status, "unidentified");
});

// ---------------------------------------------------------------------------
// M12b: the fast add's steps, and the ownership wording
// ---------------------------------------------------------------------------

const rel = (id, region, kind, name, platform = "snes") => ({
  id,
  platform: { slug: platform },
  region: { code: region, label: region.toUpperCase() },
  edition: kind || name ? { kind, name } : null,
});
// A game on SNES: NTSC-U/C Standard and Greatest Hits, PAL Standard, and two PAL
// Platinum releases that only a variant tells apart.
const RELEASES = [
  rel("us", "ntsc-uc", "standard", "Standard"),
  rel("us-gh", "ntsc-uc", "reprint", "Greatest Hits"),
  rel("eu", "pal", "standard", "Standard"),
  rel("eu-p1", "pal", "reprint", "Platinum"),
  rel("eu-p2", "pal", "reprint", "Platinum"),
];
const REFERENCE = {
  platforms: [
    { slug: "snes", name: "Super Nintendo" },
    { slug: "nes", name: "NES" },
  ],
  regions: [
    { code: "ntsc-uc", label: "NTSC-U/C" },
    { code: "pal", label: "PAL" },
    { code: "ntsc-j", label: "NTSC-J" },
  ],
};
const picker = (over = {}) => ({
  platforms: [{ slug: "snes", name: "Super Nintendo", releaseCount: 5 }],
  regions: [
    { code: "ntsc-uc", label: "NTSC-U/C", releaseCount: 2 },
    { code: "pal", label: "PAL", releaseCount: 3 },
  ],
  selection: { platform: "snes", region: null, releaseId: null },
  releases: RELEASES,
  ...over,
});
const sel = (platform, region = null, edition = null, release = null) => ({ platform, region, edition, release });
const plan = (s, p = picker()) => planFastAdd(p, s, REFERENCE);
const PLATINUM = editionKey({ kind: "reprint", name: "Platinum" });

test("the fast add picks one published release only when the choices name exactly one (M12b)", () => {
  const p = plan(sel("snes", "pal", editionKey({ kind: "standard", name: "Standard" })));
  assert.equal(p.outcome.kind, "release");
  assert.equal(p.outcome.release.id, "eu");
  // Two PAL Platinum releases: the owner chooses; one is never picked for them.
  const two = plan(sel("snes", "pal", PLATINUM));
  assert.equal(two.outcome.kind, "choose");
  assert.deepEqual(
    two.outcome.releases.map((r) => r.id),
    ["eu-p1", "eu-p2"],
  );
  assert.equal(plan(sel("snes", "pal", PLATINUM, "eu-p2")).outcome.release.id, "eu-p2");
  // A release that doesn't match the choices isn't taken from the address.
  assert.equal(plan(sel("snes", "pal", PLATINUM, "us")).outcome.kind, "choose");
});

test("each step offers the catalog's choices for what's chosen so far (M12b)", () => {
  assert.equal(plan(sel(null)).platform.slug, "snes", "a game on one platform has it chosen");
  const pal = plan(sel("snes", "pal"));
  assert.deepEqual(
    pal.editions.map((e) => [e.name, e.count]),
    [
      ["Standard", 1],
      ["Platinum", 2],
    ],
    "the editions of PAL releases, with counts",
  );
  assert.equal(pal.outcome, null, "and nothing is added before the edition is chosen");
  assert.deepEqual(
    plan(sel("snes", "unsure")).editions.map((e) => e.name),
    ["Standard", "Greatest Hits", "Platinum"],
    "with the region not sure, every edition on the platform",
  );
  assert.equal(plan(sel("snes", "ntsc-j")).region.inCatalog, false, "a region the catalog lacks for the game is the owner's own");
  assert.deepEqual(plan(sel("snes", "ntsc-j")).editions, [], "with no catalog editions to offer");
  assert.equal(plan(sel("other")).choosingPlatform, true);
  assert.equal(plan(sel("snes", "other")).choosingRegion, true);
  assert.equal(plan(sel("psx")).platform, null, "an unknown platform is ignored");
  assert.equal(plan(sel("snes", "atlantis")).region, null, "and so is an unknown region");
});

test("anything that isn't one published release is added unidentified, with what the owner knows (M12b)", () => {
  const claim = (s) => {
    const p = plan(s);
    assert.equal(p.outcome.kind, "claim", JSON.stringify(s));
    return p.outcome.claim;
  };
  // The four combinations of region and edition, known or not.
  assert.deepEqual(claim(sel("snes", "ntsc-j", "other")), { platform: "snes", region: "ntsc-j", edition: "other" });
  assert.deepEqual(claim(sel("snes", "pal", "unsure")), { platform: "snes", region: "pal", edition: null });
  assert.deepEqual(claim(sel("snes", "unsure", PLATINUM)), { platform: "snes", region: null, edition: { kind: "reprint", name: "Platinum" } });
  assert.deepEqual(claim(sel("snes", "unsure", "unsure")), { platform: "snes", region: null, edition: null });
  // A platform the catalog doesn't list for the game: the owner's own pairing.
  const nes = plan(sel("nes", "pal", "unsure"));
  assert.equal(nes.platform.inCatalog, false);
  assert.deepEqual(nes.outcome.claim, { platform: "nes", region: "pal", edition: null });
  assert.deepEqual(nes.editions, [], "with no catalog editions, since the catalog has no releases there");
});

test("a release named in the address is added as itself (M12b)", () => {
  const p = plan(sel(null, null, null, "us-gh"), picker({ selection: { platform: "snes", region: "ntsc-uc", releaseId: "us-gh" } }));
  assert.equal(p.outcome.kind, "release");
  assert.equal(p.outcome.release.id, "us-gh");
  assert.equal(p.edition.name, "Greatest Hits", "with its steps shown as chosen");
});

test("the catalog's unknown region is never a claim's region (M12b)", () => {
  const p = picker({ regions: [{ code: "unknown", label: "UNKNOWN", releaseCount: 1 }], releases: [rel("u", "unknown", null, null)] });
  assert.deepEqual(planFastAdd(p, sel("snes", "unknown", "unsure"), REFERENCE).outcome.claim, { platform: "snes", region: null, edition: null });
  assert.equal(planFastAdd(p, sel("snes", "unknown", editionKey(null)), REFERENCE).outcome.release.id, "u", "but its release can be added as itself");
});

test("the fast add's addresses keep each step (M12b)", () => {
  assert.equal(fastAddHref("crash", {}), "/games/crash");
  assert.equal(fastAddHref("crash", { platform: "snes", region: "pal", edition: "reprint~Platinum" }), "/games/crash?platform=snes&region=pal&edition=reprint%7EPlatinum");
  assert.equal(editionKey(null), "~");
  assert.equal(UNSURE, "unsure");
  assert.equal(OTHER, "other");
});

test("ownership is worded per copy's standing, and preserved copies aren't counted (M12b)", () => {
  assert.equal(ownershipHeadline(0), "Not in your collection");
  assert.equal(ownershipHeadline(1), "Owned: Yes");
  assert.equal(ownershipHeadline(3), "Owned: 3 copies");
  assert.deepEqual(
    ["owned", "pending", "not_approved", "unidentified", "invalid"].map(ownershipStatusLabel),
    ["Confirmed", "Awaiting catalog approval", "Not approved", "Not linked to a release", "Preserved, not counted"],
  );
  const platform = { short_name: "PS1" };
  const pal = { code: "pal", label: "PAL" };
  assert.equal(ownershipEntryLine({ status: "owned", release_id: "r", platform, region: pal, edition_kind: "reprint", edition_name: "Platinum" }), "PS1 · PAL · Platinum");
  assert.equal(ownershipEntryLine({ status: "owned", release_id: "r", platform, region: pal, edition_kind: null, edition_name: null }), "PS1 · PAL");
  assert.equal(
    ownershipEntryLine({ status: "unidentified", release_id: null, platform, region: { code: "ntsc-uc", label: "NTSC-U/C" }, edition_kind: null, edition_name: null }),
    "PS1 · NTSC-U/C · Edition not sure",
  );
  assert.equal(
    ownershipEntryLine({ status: "unidentified", release_id: null, platform, region: null, edition_kind: "collector", edition_name: null }),
    "PS1 · Region not sure · Collector's edition",
  );
  assert.equal(copyStatusLabel("pending"), "Awaiting catalog approval", "a pending copy says what it's waiting for");
});

test("a copy's history says what it was and who changed it (M12b)", () => {
  const regions = new Map([["pal", "PAL"]]);
  assert.equal(historyIdentityText({ release_id: "r" }, regions), "Linked to a release in the catalog");
  assert.equal(
    historyIdentityText({ game_id: "g", platform_id: "p", region_code: "pal", edition_kind: "reprint", edition_name: null }, regions),
    "Not linked to a release: PAL · Reprint",
  );
  assert.equal(
    historyIdentityText({ game_id: "g", platform_id: "p", region_code: null, edition_kind: null, edition_name: null }, regions),
    "Not linked to a release: Region not sure · Edition not sure",
  );
  assert.equal(historyIdentityText(null, regions), "Not recorded");
  assert.deepEqual(["owner", "catalog", "maintenance"].map(historySourceLabel), ["You", "The catalog, when it merged a duplicate release", "Site maintenance"]);
});

test("edition choices are the database's types, and suggested names are only suggestions (M12b)", () => {
  assert.deepEqual(
    EDITION_KIND_OPTIONS.map((k) => k.value),
    ["standard", "limited", "collector", "reprint", "bundle", "promotional", "other"],
  );
  assert.ok(EDITION_NAME_SUGGESTIONS.includes("Platinum") && EDITION_NAME_SUGGESTIONS.includes("Greatest Hits"));
});
