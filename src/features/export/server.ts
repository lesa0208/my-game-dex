import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  EXPORT_FORMAT,
  EXPORT_MAX_COPIES,
  EXPORT_NOTICE,
  EXPORT_PAGE,
  EXPORT_VERSION,
  type Lookups,
  NOT_INCLUDED,
  PRESERVED_BATCH,
  shapeCopy,
  shapeFactors,
  shapePreferences,
  shapeProfile,
  shapeSubmission,
  shapeWish,
  SUBMISSIONS_MAX_PAGES,
  SUBMISSIONS_PAGE,
  EXPORT_MAX_WISHES,
  WISHLIST_PAGE,
} from "./format";

/**
 * Reads the signed-in person's data and yields it as JSON text, a page at a time
 * (M11a-4a). Every read is made with the person's own session and the publishable key,
 * through what the app already uses: get_my_account, the owner-only collection tables
 * (RLS), the catalog as they may read it, get_my_preserved_titles, my_catalog_submissions
 * and get_my_submission. No secret key, no Auth Admin call, nothing another account owns.
 *
 * The account id comes from the verified token (the caller passes it), and every
 * collection read also names it, on top of RLS. Pages are by id (keyset), so each copy
 * that exists throughout the export appears exactly once, two copies of one release as
 * two entries. Any failed read throws, and the caller ends the download unfinished:
 * a complete file ends with "complete": true.
 */

type Row = Record<string, unknown>;
type Client = SupabaseClient;

export class ExportTooLarge extends Error {}

const json = (value: unknown) => JSON.stringify(value);

function must<T>(result: { data: T | null; error: unknown }): T {
  if (result.error || result.data === null) throw new Error("export read failed");
  return result.data;
}

/** Every row of a query, in pages of at most 1,000 (PostgREST's max_rows). */
async function allRows(build: (from: number, to: number) => PromiseLike<{ data: Row[] | null; error: unknown }>): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const page = must(await build(from, from + 999));
    out.push(...page);
    if (page.length < 1000) return out;
    if (from > 1_000_000) throw new Error("export read too large");
  }
}

const byKey = (rows: Row[], key: string) => new Map(rows.map((r) => [String(r[key]), r]));

const RELEASE_COLUMNS =
  "id,game_id,platform_id,region_code,edition_name,edition_kind,variant_name,product_code,barcode,local_title,publisher_name,media_format_code,media_count,packaging,packaging_code,languages,release_date,release_date_precision,status";
const ITEM_COLUMNS =
  "id,release_id,claimed_game_id,claimed_platform_id,claimed_region_code,claimed_edition_kind,claimed_edition_name,completeness,overall_condition,box_condition,media_condition,manual_condition,visibility,record_status,invalidated_at,created_at,updated_at";

export async function* exportChunks(supabase: Client, account: { id: string; email: string | null }, now: Date): AsyncGenerator<string> {
  const me = account.id;
  const [accountRows, preferences, factors, platforms, regions, formats] = await Promise.all([
    supabase.rpc("get_my_account"),
    supabase.from("user_preferences").select("*").eq("user_id", me).maybeSingle(),
    supabase.auth.mfa.listFactors(),
    allRows((a, b) => supabase.from("platforms").select("id,slug,name,short_name").order("id").range(a, b)),
    allRows((a, b) => supabase.from("region_codes").select("code,label").order("code").range(a, b)),
    allRows((a, b) => supabase.from("media_formats").select("code,name").order("code").range(a, b)),
  ]);
  const profile = (must(accountRows) as Row[])[0];
  if (!profile || profile.id !== me) throw new Error("export read failed");
  if (preferences.error) throw new Error("export read failed");
  if (factors.error) throw new Error("export read failed");

  yield `{${json("format")}:${json(EXPORT_FORMAT)},${json("version")}:${EXPORT_VERSION},${json("exported_at")}:${json(now.toISOString())},${json("notice")}:${json(EXPORT_NOTICE)},`;
  yield `${json("account")}:${json({ id: me, email: account.email })},`;
  yield `${json("profile")}:${json(shapeProfile(profile))},`;
  yield `${json("preferences")}:${json(shapePreferences(preferences.data as Row | null))},`;
  yield `${json("authenticators")}:${json(shapeFactors((factors.data?.all ?? []) as unknown as Row[]))},`;

  const reference = { platforms: byKey(platforms, "id"), regions: byKey(regions, "code"), formats: byKey(formats, "code") };

  yield `${json("collection")}:[`;
  let last: string | null = null;
  let count = 0;
  for (;;) {
    let query = supabase.from("collection_items").select(ITEM_COLUMNS).eq("owner_id", me).order("id").limit(EXPORT_PAGE);
    if (last) query = query.gt("id", last);
    const items = must(await query) as Row[];
    if (items.length === 0) break;
    count += items.length;
    if (count > EXPORT_MAX_COPIES) throw new ExportTooLarge();
    const ids = items.map((i) => String(i.id));
    // M12a: an unidentified copy names no release, only a claimed game.
    const releaseIds = [...new Set(items.filter((i) => i.release_id != null).map((i) => String(i.release_id)))];

    const [priv, pieces, releases] = await Promise.all([
      allRows((a, b) => supabase.from("collection_item_private").select("item_id,acquired_on,purchase_price,currency,notes,storage_location").eq("owner_id", me).in("item_id", ids).order("item_id").range(a, b)),
      allRows((a, b) => supabase.from("collection_item_components").select("item_id,kind,label,condition").eq("owner_id", me).in("item_id", ids).order("item_id").order("kind").order("label").range(a, b)),
      releaseIds.length ? allRows((a, b) => supabase.from("releases").select(RELEASE_COLUMNS).in("id", releaseIds).order("id").range(a, b)) : Promise.resolve([] as Row[]),
    ]);
    const releaseMap = byKey(releases, "id");
    const gameIds = [...new Set([...releases.map((r) => String(r.game_id)), ...items.filter((i) => i.release_id == null).map((i) => String(i.claimed_game_id))])];
    const games = gameIds.length ? await allRows((a, b) => supabase.from("games").select("id,slug,title,kind,status").in("id", gameIds).order("id").range(a, b)) : [];

    // Copies whose release the catalog no longer shows them: excluded ones keep a title.
    const preserved = new Map<string, Row>();
    const hidden = items.filter((i) => !releaseMap.has(String(i.release_id)) && i.record_status === "invalid_preserved").map((i) => String(i.id));
    for (let i = 0; i < hidden.length; i += PRESERVED_BATCH) {
      const titles = must(await supabase.rpc("get_my_preserved_titles", { p_items: hidden.slice(i, i + PRESERVED_BATCH) })) as Record<string, Row>;
      for (const [id, value] of Object.entries(titles)) preserved.set(id, value);
    }

    const lookups: Lookups = { ...reference, releases: releaseMap, games: byKey(games, "id"), preserved };
    const privByItem = byKey(priv, "item_id");
    const piecesByItem = new Map<string, Row[]>();
    for (const p of pieces) piecesByItem.set(String(p.item_id), [...(piecesByItem.get(String(p.item_id)) ?? []), p]);

    const text = items.map((i) => json(shapeCopy(i, privByItem.get(String(i.id)), piecesByItem.get(String(i.id)) ?? [], lookups))).join(",");
    yield `${last ? "," : ""}${text}`;
    last = ids[ids.length - 1];
    if (items.length < EXPORT_PAGE) break;
  }
  yield "],";

  // M12 W2: the wishlist. The entries as stored, through the owner-only table (RLS and
  // the owner named), and how the catalog shows each now, through get_my_wishlist,
  // which reads only the caller's own entries. At most 10,000 of each.
  const wishes = await allRows((a, b) =>
    supabase.from("wishlist_items").select("id,release_id,game_id,platform_id,region_code,completeness,priority,note,created_at,updated_at").eq("owner_id", me).order("id").range(a, b),
  );
  if (wishes.length > EXPORT_MAX_WISHES) throw new ExportTooLarge();
  const shown = new Map<string, Row>();
  let cursor: string | null = null;
  for (let page = 0; wishes.length > 0; page += 1) {
    if (page * WISHLIST_PAGE > EXPORT_MAX_WISHES) throw new ExportTooLarge();
    const list = must(await supabase.rpc("get_my_wishlist", { p_sort: "added", p_limit: WISHLIST_PAGE, p_cursor: cursor })) as { items?: Row[]; next_cursor?: string | null };
    for (const item of list.items ?? []) shown.set(String(item.id), item);
    if (!list.next_cursor) break;
    cursor = list.next_cursor;
  }
  yield `${json("wishlist")}:[`;
  for (let i = 0; i < wishes.length; i += 500) {
    yield `${i ? "," : ""}${wishes.slice(i, i + 500).map((w) => json(shapeWish(w, shown.get(String(w.id)), reference))).join(",")}`;
  }
  yield "],";

  yield `${json("submissions")}:[`;
  let before: string | null = null;
  let first = true;
  for (let page = 0; ; page += 1) {
    if (page >= SUBMISSIONS_MAX_PAGES) throw new ExportTooLarge();
    const list = must(await supabase.rpc("my_catalog_submissions", { p_before: before, p_limit: SUBMISSIONS_PAGE })) as { items?: Row[]; next_before?: string | null };
    for (const item of list.items ?? []) {
      const detail = await supabase.rpc("get_my_submission", { p_submission: item.id });
      if (detail.error) throw new Error("export read failed");
      if (!detail.data) continue;
      yield `${first ? "" : ","}${json(shapeSubmission(detail.data as Row))}`;
      first = false;
    }
    if (!list.next_before) break;
    before = list.next_before;
  }
  yield "],";

  yield `${json("not_included")}:${json(NOT_INCLUDED)},${json("complete")}:true}`;
}
