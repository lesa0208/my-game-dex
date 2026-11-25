"use server";

import { refresh, updateTag } from "next/cache";
import { redirect } from "next/navigation";

import { stepUpHref } from "@/features/admin/form";
import { createSupabaseServerClient } from "@/features/auth/server";
import { CATALOG_TAG } from "@/features/catalog/queries";
import { UUID } from "@/features/collection/uuid";
import { getGameRecord, getReleaseRecord, type GameRecord, type ReleaseRecord } from "@/features/records/queries";
import { piecesEditable, readPieceCorrections, readReason, readReleaseCorrections, type ReleaseRecord as ReleaseFields } from "@/features/review/form";

import { editErrorMessage, readAlias, readGameFields, readLock, readMarkets, readRelation, readRequirements, type GameFields } from "./form";
import { getEditingOptions } from "./queries";

/**
 * Catalog editing (M10c). Each action checks the session itself; the database checks
 * the editor's role, who created the record, a recent TOTP verification where one is
 * needed, and the record's revision again. Revisions come from the page the editor
 * read, so a stale page is refused rather than acting on something they didn't see.
 *
 * A stale verification is never worked around: the action changes nothing and says
 * where to verify again (D3). The form keeps what was typed while the editor does,
 * and they submit again; nothing is replayed for them. Messages are fixed; nothing
 * from the database reaches the page.
 */

export type EditState = { status: "idle" | "error" | "stepup"; message: string | null; href?: string };

const UNAVAILABLE: EditState = { status: "error", message: "The catalog isn't available right now. Try again later." };
const UNCHANGED: EditState = { status: "error", message: "Nothing has changed." };

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}
const whole = (text: string) => (/^\d{1,18}$/.test(text) ? Number(text) : null);
const thisYear = () => new Date().getUTCFullYear();
const gamePath = (id: string) => `/admin/catalog/games/${id}`;
const releasePath = (id: string) => `/admin/catalog/releases/${id}`;

async function signedIn() {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;
  const { data: auth } = await supabase.auth.getClaims();
  return auth?.claims?.sub ? supabase : null;
}

/** The outcome of an RPC: step-up, a fixed message, or nothing on success. */
function failed(error: { message: string; code?: string } | null, back: string): EditState | null {
  if (!error) return null;
  if (error.message === "reauthentication required") return { status: "stepup", message: editErrorMessage(error.message), href: stepUpHref(back) };
  if (error.code === "23505") return { status: "error", message: editErrorMessage("already published") };
  return { status: "error", message: editErrorMessage(error.message) };
}

/** Lands on the page with a notice, after expiring the public catalog's cache if public content changed. */
function done(path: string, notice: string, publicChange: boolean): never {
  if (publicChange) updateTag(CATALOG_TAG);
  refresh();
  redirect(`${path}?notice=${notice}`);
}

function gameFields(g: GameRecord): GameFields {
  return {
    title: g.title,
    sort_title: g.sort_title,
    kind: g.kind,
    summary: g.summary,
    first_release_year: g.first_release ? Number(g.first_release.value.slice(0, 4)) : null,
  };
}

function releaseFields(r: ReleaseRecord): ReleaseFields {
  return {
    edition_name: r.edition?.name ?? null,
    edition_kind: r.edition?.kind ?? null,
    variant_name: r.variant_name,
    product_code: r.identifiers.product_code,
    barcode: r.identifiers.barcode,
    local_title: r.local_title,
    publisher_name: r.publisher_name,
    media_count: r.media_count,
    packaging: r.packaging,
    packaging_code: r.packaging_code ?? "unclassified",
    region_code: r.region?.code ?? "unknown",
    region_unknown_confirmed: r.region_unknown_confirmed,
    release_date: r.release_date?.value ?? null,
    release_date_precision: r.release_date?.precision ?? "unknown",
  };
}

/** The record the form was read from, at the revision it showed, or why not. */
async function currentGame(formData: FormData): Promise<{ game: GameRecord } | { state: EditState }> {
  const id = field(formData, "id");
  const revision = whole(field(formData, "revision"));
  if (!UUID.test(id) || revision === null) return { state: { status: "error", message: editErrorMessage("record unavailable") } };
  const outcome = await getGameRecord(id);
  if (!outcome.ok) return { state: outcome.reason === "refused" ? { status: "error", message: editErrorMessage(outcome.message) } : UNAVAILABLE };
  if (!outcome.data) return { state: { status: "error", message: editErrorMessage("record unavailable") } };
  if (outcome.data.revision !== revision) return { state: { status: "error", message: editErrorMessage("record changed") } };
  return { game: outcome.data };
}

async function currentRelease(formData: FormData): Promise<{ release: ReleaseRecord } | { state: EditState }> {
  const id = field(formData, "id");
  const revision = whole(field(formData, "revision"));
  if (!UUID.test(id) || revision === null) return { state: { status: "error", message: editErrorMessage("record unavailable") } };
  const outcome = await getReleaseRecord(id);
  if (!outcome.ok) return { state: outcome.reason === "refused" ? { status: "error", message: editErrorMessage(outcome.message) } : UNAVAILABLE };
  if (!outcome.data) return { state: { status: "error", message: editErrorMessage("record unavailable") } };
  if (outcome.data.revision !== revision) return { state: { status: "error", message: editErrorMessage("record changed") } };
  return { release: outcome.data };
}

// ---------------------------------------------------------------------------
// Games
// ---------------------------------------------------------------------------

/** Creates a game, in review. The editor who creates it can't verify or publish it (D2). */
export async function createGame(_state: EditState, formData: FormData): Promise<EditState> {
  const read = (name: string) => field(formData, name);
  const reason = readReason(read);
  if ("error" in reason) return { status: "error", message: reason.error };
  const fields = readGameFields(read, null, thisYear());
  if ("error" in fields) return { status: "error", message: fields.error };
  const supabase = await signedIn();
  if (!supabase) return UNAVAILABLE;
  const f = fields.value;
  const { data, error } = await supabase.rpc("create_game", {
    p_title: f.title,
    p_kind: f.kind,
    p_sort_title: f.sort_title,
    p_summary: f.summary ?? null,
    p_first_release_date: f.first_release_date ?? null,
    p_first_release_precision: f.first_release_precision ?? "unknown",
    p_reason: reason.value,
  });
  const problem = failed(error, "/admin/catalog/games/new");
  if (problem) return problem;
  if (typeof data !== "string" || !UUID.test(data)) return { status: "error", message: editErrorMessage(null) };
  done(gamePath(data), "created", false);
}

/** Saves a game's details, only what differs from the record as it is now. */
export async function editGame(_state: EditState, formData: FormData): Promise<EditState> {
  const read = (name: string) => field(formData, name);
  const reason = readReason(read);
  if ("error" in reason) return { status: "error", message: reason.error };
  const supabase = await signedIn();
  if (!supabase) return UNAVAILABLE;
  const current = await currentGame(formData);
  if ("state" in current) return current.state;
  const g = current.game;
  const changes = readGameFields(read, gameFields(g), thisYear());
  if ("error" in changes) return { status: "error", message: changes.error };
  if (Object.keys(changes.value).length === 0) return UNCHANGED;
  const { error } = await supabase.rpc("update_game", { p_game: g.id, p_changes: changes.value, p_reason: reason.value });
  const problem = failed(error, `${gamePath(g.id)}/edit`);
  if (problem) return problem;
  done(`${gamePath(g.id)}/edit`, "saved", g.status === "published");
}

/** Adds another title the game is known by. */
export async function addAlias(_state: EditState, formData: FormData): Promise<EditState> {
  const read = (name: string) => field(formData, name);
  const reason = readReason(read);
  if ("error" in reason) return { status: "error", message: reason.error };
  const options = await getEditingOptions();
  if (!options) return UNAVAILABLE;
  const alias = readAlias(read, options.regions.map((r) => r.code));
  if ("error" in alias) return { status: "error", message: alias.error };
  const supabase = await signedIn();
  if (!supabase) return UNAVAILABLE;
  const current = await currentGame(formData);
  if ("state" in current) return current.state;
  const g = current.game;
  const { error } = await supabase.rpc("add_game_alias", {
    p_game: g.id,
    p_title: alias.value.title,
    p_kind: alias.value.kind,
    p_language_code: alias.value.language,
    p_region_code: alias.value.region,
    p_reason: reason.value,
  });
  const problem = failed(error, `${gamePath(g.id)}/edit`);
  if (problem) return problem;
  done(`${gamePath(g.id)}/edit`, "alias_added", g.status === "published");
}

/** Removes one of the game's other titles. */
export async function removeAlias(_state: EditState, formData: FormData): Promise<EditState> {
  const read = (name: string) => field(formData, name);
  const reason = readReason(read);
  if ("error" in reason) return { status: "error", message: reason.error };
  const alias = field(formData, "alias_id");
  if (!UUID.test(alias)) return { status: "error", message: editErrorMessage("record unavailable") };
  const supabase = await signedIn();
  if (!supabase) return UNAVAILABLE;
  const current = await currentGame(formData);
  if ("state" in current) return current.state;
  const g = current.game;
  if (!g.aliases.some((a) => a.id === alias)) return { status: "error", message: editErrorMessage("record changed") };
  const { error } = await supabase.rpc("remove_game_alias", { p_alias: alias, p_reason: reason.value });
  const problem = failed(error, `${gamePath(g.id)}/edit`);
  if (problem) return problem;
  done(`${gamePath(g.id)}/edit`, "alias_removed", g.status === "published");
}

/** Relates the game to another: a remake, a remaster, or a compilation's contents. */
export async function setRelation(_state: EditState, formData: FormData): Promise<EditState> {
  const read = (name: string) => field(formData, name);
  const reason = readReason(read);
  if ("error" in reason) return { status: "error", message: reason.error };
  const supabase = await signedIn();
  if (!supabase) return UNAVAILABLE;
  const current = await currentGame(formData);
  if ("state" in current) return current.state;
  const g = current.game;
  const relation = readRelation(read, g.id);
  if ("error" in relation) return { status: "error", message: relation.error };
  const { data, error } = await supabase.rpc("set_game_relation", {
    p_source: g.id,
    p_target: relation.value.target,
    p_relation: relation.value.relation,
    p_position: relation.value.position,
    p_note: relation.value.note,
    p_reason: reason.value,
  });
  const problem = failed(error, `${gamePath(g.id)}/edit`);
  if (problem) return problem;
  if (data === false) return UNCHANGED;
  done(`${gamePath(g.id)}/edit`, "relation_saved", g.status === "published");
}

/** Adds a platform the game came out on, in review until a release on it is published. */
export async function addPlatform(_state: EditState, formData: FormData): Promise<EditState> {
  const read = (name: string) => field(formData, name);
  const reason = readReason(read);
  if ("error" in reason) return { status: "error", message: reason.error };
  const options = await getEditingOptions();
  if (!options) return UNAVAILABLE;
  const platform = options.platforms.find((p) => p.slug === field(formData, "platform"));
  if (!platform) return { status: "error", message: "Choose a platform from the list." };
  const supabase = await signedIn();
  if (!supabase) return UNAVAILABLE;
  const current = await currentGame(formData);
  if ("state" in current) return current.state;
  const g = current.game;
  const { data, error } = await supabase.rpc("set_game_platform", { p_game: g.id, p_platform: platform.id, p_reason: reason.value });
  const problem = failed(error, `${gamePath(g.id)}/edit`);
  if (problem) return problem;
  if (data === false) return { status: "error", message: "The game is already on that platform." };
  done(`${gamePath(g.id)}/edit`, "platform_added", false);
}

// ---------------------------------------------------------------------------
// Releases
// ---------------------------------------------------------------------------

const BLANK_RELEASE: ReleaseFields = {
  edition_name: null,
  edition_kind: null,
  variant_name: null,
  product_code: null,
  barcode: null,
  local_title: null,
  publisher_name: null,
  media_count: null,
  packaging: null,
  packaging_code: "unclassified",
  region_code: "",
  region_unknown_confirmed: false,
  release_date: null,
  release_date_precision: "unknown",
};

/** Creates a physical release of a game, in review. Its creator can't verify or publish it (D2). */
export async function createRelease(_state: EditState, formData: FormData): Promise<EditState> {
  const read = (name: string) => field(formData, name);
  const reason = readReason(read);
  if ("error" in reason) return { status: "error", message: reason.error };
  const game = field(formData, "game_id");
  if (!UUID.test(game)) return { status: "error", message: editErrorMessage("record unavailable") };
  const options = await getEditingOptions();
  if (!options) return UNAVAILABLE;
  const platform = options.platforms.find((p) => p.slug === field(formData, "platform"));
  if (!platform) return { status: "error", message: "Choose a platform from the list." };
  const format = field(formData, "format");
  if (!options.formats.some((f) => f.platform === platform.slug && f.code === format)) return { status: "error", message: "Choose a physical format this platform uses." };
  const fields = readReleaseCorrections(read, BLANK_RELEASE, options.regions.map((r) => r.code), thisYear());
  if ("error" in fields) return { status: "error", message: fields.error };
  const { region_code: region, ...details } = fields.value;
  const supabase = await signedIn();
  if (!supabase) return UNAVAILABLE;
  const { data, error } = await supabase.rpc("create_release", {
    p_game: game,
    p_platform: platform.id,
    p_media_format_code: format,
    p_region_code: region,
    p_details: Object.fromEntries(Object.entries(details).filter(([, v]) => v !== null && v !== false)),
    p_reason: reason.value,
  });
  const problem = failed(error, `/admin/catalog/releases/new?game=${game}`);
  if (problem) return problem;
  if (typeof data !== "string" || !UUID.test(data)) return { status: "error", message: editErrorMessage(null) };
  done(releasePath(data), "created", false);
}

/** Saves a release's details, only what differs from the record as it is now. */
export async function editRelease(_state: EditState, formData: FormData): Promise<EditState> {
  const read = (name: string) => field(formData, name);
  const reason = readReason(read);
  if ("error" in reason) return { status: "error", message: reason.error };
  const options = await getEditingOptions();
  if (!options) return UNAVAILABLE;
  const supabase = await signedIn();
  if (!supabase) return UNAVAILABLE;
  const current = await currentRelease(formData);
  if ("state" in current) return current.state;
  const r = current.release;
  const changes = readReleaseCorrections(read, releaseFields(r), options.regions.map((x) => x.code), thisYear());
  if ("error" in changes) return { status: "error", message: changes.error };
  if (Object.keys(changes.value).length === 0) return UNCHANGED;
  const { error } = await supabase.rpc("update_release", { p_release: r.id, p_changes: changes.value, p_reason: reason.value });
  const problem = failed(error, `${releasePath(r.id)}/edit`);
  if (problem) return problem;
  done(`${releasePath(r.id)}/edit`, "saved", r.status === "published");
}

/** Replaces what's listed in the box. */
export async function setPieces(_state: EditState, formData: FormData): Promise<EditState> {
  const read = (name: string) => field(formData, name);
  const reason = readReason(read);
  if ("error" in reason) return { status: "error", message: reason.error };
  const supabase = await signedIn();
  if (!supabase) return UNAVAILABLE;
  const current = await currentRelease(formData);
  if ("state" in current) return current.state;
  const r = current.release;
  if (!piecesEditable(r.components)) return { status: "error", message: "This release lists pieces this form can't show, so it can't change them." };
  const pieces = readPieceCorrections(read, whole(field(formData, "piece_rows")) ?? 0, r.components);
  if ("error" in pieces) return { status: "error", message: pieces.error };
  if (!pieces.value) return UNCHANGED;
  const { error } = await supabase.rpc("set_release_components", { p_release: r.id, p_components: pieces.value, p_reason: reason.value });
  const problem = failed(error, `${releasePath(r.id)}/edit`);
  if (problem) return problem;
  done(`${releasePath(r.id)}/edit`, "saved", r.status === "published");
}

/** Replaces the markets the release was sold in. */
export async function setMarkets(_state: EditState, formData: FormData): Promise<EditState> {
  const read = (name: string) => field(formData, name);
  const reason = readReason(read);
  if ("error" in reason) return { status: "error", message: reason.error };
  const options = await getEditingOptions();
  if (!options) return UNAVAILABLE;
  const supabase = await signedIn();
  if (!supabase) return UNAVAILABLE;
  const current = await currentRelease(formData);
  if ("state" in current) return current.state;
  const r = current.release;
  const markets = readMarkets(field(formData, "markets"), options.markets.map((m) => m.code), r.markets.map((m) => m.code));
  if ("error" in markets) return { status: "error", message: markets.error };
  if (!markets.value) return UNCHANGED;
  const { error } = await supabase.rpc("set_release_markets", { p_release: r.id, p_markets: markets.value, p_reason: reason.value });
  const problem = failed(error, `${releasePath(r.id)}/edit`);
  if (problem) return problem;
  done(`${releasePath(r.id)}/edit`, "saved", r.status === "published");
}

/** Replaces the hardware the release lists. */
export async function setRequirements(_state: EditState, formData: FormData): Promise<EditState> {
  const read = (name: string) => field(formData, name);
  const reason = readReason(read);
  if ("error" in reason) return { status: "error", message: reason.error };
  const options = await getEditingOptions();
  if (!options) return UNAVAILABLE;
  const supabase = await signedIn();
  if (!supabase) return UNAVAILABLE;
  const current = await currentRelease(formData);
  if ("state" in current) return current.state;
  const r = current.release;
  const allowed = options.requirements.filter((h) => h.platform === r.platform?.slug).map((h) => h.code);
  const list = readRequirements(read, whole(field(formData, "requirement_rows")) ?? 0, allowed,
    r.requirements.map((h) => ({ requirement_code: h.code, level: h.level, note: h.note })));
  if ("error" in list) return { status: "error", message: list.error };
  if (!list.value) return UNCHANGED;
  const { error } = await supabase.rpc("set_release_requirements", { p_release: r.id, p_requirements: list.value, p_reason: reason.value });
  const problem = failed(error, `${releasePath(r.id)}/edit`);
  if (problem) return problem;
  done(`${releasePath(r.id)}/edit`, "saved", r.status === "published");
}

// ---------------------------------------------------------------------------
// Locks, verification and publication
// ---------------------------------------------------------------------------

/** Locks a field against imports, or unlocks it. */
export async function setLock(_state: EditState, formData: FormData): Promise<EditState> {
  const read = (name: string) => field(formData, name);
  const reason = readReason(read);
  if ("error" in reason) return { status: "error", message: reason.error };
  const lock = readLock(read);
  if ("error" in lock) return { status: "error", message: lock.error };
  const supabase = await signedIn();
  if (!supabase) return UNAVAILABLE;
  const current = lock.value.entity === "game" ? await currentGame(formData) : await currentRelease(formData);
  if ("state" in current) return current.state;
  const id = "game" in current ? current.game.id : current.release.id;
  const back = `${lock.value.entity === "game" ? gamePath(id) : releasePath(id)}/edit`;
  const { data, error } = await supabase.rpc("set_catalog_field_lock", {
    p_entity: lock.value.entity,
    p_id: id,
    p_field: lock.value.field,
    p_locked: lock.value.locked,
    p_reason: reason.value,
  });
  const problem = failed(error, back);
  if (problem) return problem;
  if (data === false) return UNCHANGED;
  done(back, lock.value.locked ? "locked" : "unlocked", false);
}

/** Verifies a game or release at the revision the editor read. Never its creator's (D2). */
export async function verifyRecord(_state: EditState, formData: FormData): Promise<EditState> {
  const read = (name: string) => field(formData, name);
  const reason = readReason(read);
  if ("error" in reason) return { status: "error", message: reason.error };
  const entity = field(formData, "entity") === "game" ? "game" : "release";
  const id = field(formData, "id");
  const revision = whole(field(formData, "revision"));
  if (!UUID.test(id) || revision === null) return { status: "error", message: editErrorMessage("record unavailable") };
  const supabase = await signedIn();
  if (!supabase) return UNAVAILABLE;
  const back = entity === "game" ? gamePath(id) : releasePath(id);
  const { data, error } =
    entity === "game"
      ? await supabase.rpc("verify_game", { p_game: id, p_reason: reason.value, p_expected_revision: revision })
      : await supabase.rpc("verify_release", { p_release: id, p_reason: reason.value, p_expected_revision: revision });
  const problem = failed(error, back);
  if (problem) return problem;
  if (data === false) return { status: "error", message: "This record is already verified as it is." };
  done(back, "verified", false);
}

/**
 * M15: an editor confirms or rejects one Wikidata match a submission's lookup found, with their
 * own reason. Confirming makes it the game's source (decide_submission_enrichment); nothing is
 * verified or published. Back to the game's record or the submission's review, as it was asked from.
 */
export async function decideSourceMatch(_state: EditState, formData: FormData): Promise<EditState> {
  const read = (name: string) => field(formData, name);
  const reason = readReason(read);
  if ("error" in reason) return { status: "error", message: reason.error };
  const request = field(formData, "request_id");
  const qid = field(formData, "external_id");
  const decision = field(formData, "decision");
  const game = field(formData, "game_id");
  if (!UUID.test(request) || !UUID.test(game) || !/^Q[1-9][0-9]{0,11}$/.test(qid) || (decision !== "confirm" && decision !== "reject")) {
    return { status: "error", message: editErrorMessage("record unavailable") };
  }
  const supabase = await signedIn();
  if (!supabase) return UNAVAILABLE;
  const back = field(formData, "back") === "review" ? `/admin/catalog/${request}` : gamePath(game);
  const { error } = await supabase.rpc("decide_submission_enrichment", { p_submission: request, p_external_id: qid, p_decision: decision, p_reason: reason.value });
  if (error?.code === "23505") return { status: "error", message: editErrorMessage(error.message) };
  const problem = failed(error, back);
  if (problem) return problem;
  done(back, decision === "confirm" ? "source_confirmed" : "source_rejected", false);
}

/** Publishes a verified release at the revision the editor read, with its game if that isn't public yet. */
export async function publishRelease(_state: EditState, formData: FormData): Promise<EditState> {
  const read = (name: string) => field(formData, name);
  const reason = readReason(read);
  if ("error" in reason) return { status: "error", message: reason.error };
  const id = field(formData, "id");
  const revision = whole(field(formData, "revision"));
  if (!UUID.test(id) || revision === null) return { status: "error", message: editErrorMessage("record unavailable") };
  const supabase = await signedIn();
  if (!supabase) return UNAVAILABLE;
  const { data, error } = await supabase.rpc("publish_release", { p_release: id, p_reason: reason.value, p_expected_revision: revision });
  const problem = failed(error, releasePath(id));
  if (problem) return problem;
  if (data === false) return { status: "error", message: "This release is already published." };
  done(releasePath(id), "published", true);
}

// ---------------------------------------------------------------------------
// Without JavaScript: a form posts here, and a stale verification goes straight to
// step-up, coming back to the page. Nothing is replayed.
// ---------------------------------------------------------------------------

type Action = (state: EditState, formData: FormData) => Promise<EditState>;

async function plain(action: Action, formData: FormData): Promise<void> {
  const state = await action({ status: "idle", message: null }, formData);
  if (state.status === "stepup" && state.href) redirect(state.href);
}

export async function createGameFromForm(formData: FormData) { await plain(createGame, formData); }
export async function editGameFromForm(formData: FormData) { await plain(editGame, formData); }
export async function addAliasFromForm(formData: FormData) { await plain(addAlias, formData); }
export async function removeAliasFromForm(formData: FormData) { await plain(removeAlias, formData); }
export async function setRelationFromForm(formData: FormData) { await plain(setRelation, formData); }
export async function addPlatformFromForm(formData: FormData) { await plain(addPlatform, formData); }
export async function createReleaseFromForm(formData: FormData) { await plain(createRelease, formData); }
export async function editReleaseFromForm(formData: FormData) { await plain(editRelease, formData); }
export async function setPiecesFromForm(formData: FormData) { await plain(setPieces, formData); }
export async function setMarketsFromForm(formData: FormData) { await plain(setMarkets, formData); }
export async function setRequirementsFromForm(formData: FormData) { await plain(setRequirements, formData); }
export async function setLockFromForm(formData: FormData) { await plain(setLock, formData); }
export async function verifyRecordFromForm(formData: FormData) { await plain(verifyRecord, formData); }
export async function publishReleaseFromForm(formData: FormData) { await plain(publishRelease, formData); }
export async function decideSourceMatchFromForm(formData: FormData) { await plain(decideSourceMatch, formData); }
