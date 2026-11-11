-- M6b Collection: the functions the app uses to add, edit, remove and read the
-- signed-in user's physical copies.
--
-- Design: docs/architecture/security-rls.md#collection-system
-- Every function is SECURITY INVOKER: it runs with the caller's own rights, so the
-- owner-only policies, column grants, constraints and triggers on the tables apply
-- exactly as they would to a direct request. None of them grants anything a client
-- couldn't already do; they exist to write several rows atomically, to give fixed
-- error messages, and to return fixed response shapes. They can't call anything in
-- the private schema, which the caller can't reach.
--
-- Errors (SQLSTATE, message):
--   42501 'not permitted'         no signed-in user
--   P0001 'account not active'    adding or editing needs an active account
--   P0001 'item unavailable'      no such copy, or not the caller's
--   P0001 'release unavailable'   no such release, or one the caller may not use
--   P0001 'request conflict'      the id belongs to another request
--   P0001 'item preserved'        a preserved copy can't be edited (M7)
--   P0001 'component unavailable' the release doesn't list that piece
--   P0001 'collection limit reached'
--   22023 'invalid item id', 'invalid details', 'invalid filter', 'invalid cursor', 'query too long'

-- ---------------------------------------------------------------------------
-- 1. Writes
-- ---------------------------------------------------------------------------

-- Changes a copy and its owner-only details. Each key in p_changes that's present is
-- set, and null clears it; absent keys stay as they are. "components" replaces the
-- recorded pieces with the given list. Returns true.
--
-- Keys: completeness, overall_condition, box_condition, media_condition,
-- manual_condition, acquired_on (YYYY-MM-DD), purchase_price and currency (together),
-- notes, storage_location, components ([{kind, label, condition}]).
create function public.update_collection_item(p_item uuid, p_changes jsonb)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
  v_item public.collection_items;
  v_private public.collection_item_private;
  v_has_private boolean;
  v_acquired date;
  v_price numeric(14, 4);
  v_currency text;
  v_notes text;
  v_location text;
begin
  if v_me is null then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if p_changes is null or pg_catalog.jsonb_typeof(p_changes) <> 'object'
     or exists (select 1 from pg_catalog.jsonb_object_keys(p_changes) k
                where k <> all (array['completeness', 'overall_condition', 'box_condition', 'media_condition', 'manual_condition',
                                      'acquired_on', 'purchase_price', 'currency', 'notes', 'storage_location', 'components'])) then
    raise exception 'invalid details' using errcode = '22023';
  end if;

  -- First, because locking the row below also applies the update policy, which needs
  -- an active account.
  if not coalesce((select a.is_active from public.get_my_account() a), false) then
    raise exception 'account not active' using errcode = 'P0001';
  end if;
  select * into v_item from public.collection_items c where c.id = p_item and c.owner_id = v_me for update;
  if not found then
    raise exception 'item unavailable' using errcode = 'P0001';
  end if;
  if v_item.record_status = 'invalid_preserved' then
    raise exception 'item preserved' using errcode = 'P0001';
  end if;

  begin
    update public.collection_items c set
      completeness = case when p_changes ? 'completeness' then (p_changes ->> 'completeness')::public.completeness else c.completeness end,
      overall_condition = case when p_changes ? 'overall_condition' then (p_changes ->> 'overall_condition')::public.condition_grade else c.overall_condition end,
      box_condition = case when p_changes ? 'box_condition' then (p_changes ->> 'box_condition')::public.condition_grade else c.box_condition end,
      media_condition = case when p_changes ? 'media_condition' then (p_changes ->> 'media_condition')::public.condition_grade else c.media_condition end,
      manual_condition = case when p_changes ? 'manual_condition' then (p_changes ->> 'manual_condition')::public.condition_grade else c.manual_condition end
    where c.id = p_item;

    if p_changes ?| array['acquired_on', 'purchase_price', 'currency', 'notes', 'storage_location'] then
      select * into v_private from public.collection_item_private p where p.item_id = p_item;
      v_has_private := found;
      v_acquired := case when p_changes ? 'acquired_on' then (p_changes ->> 'acquired_on')::date else v_private.acquired_on end;
      if p_changes ? 'purchase_price' and p_changes ->> 'purchase_price' !~ '^[0-9]{1,10}(\.[0-9]{1,4})?$' then
        raise exception using errcode = '22P02';
      end if;
      v_price := case when p_changes ? 'purchase_price' then (p_changes ->> 'purchase_price')::numeric(14, 4) else v_private.purchase_price end;
      v_currency := case when p_changes ? 'currency' then p_changes ->> 'currency' else v_private.currency end;
      v_notes := case when p_changes ? 'notes' then nullif(p_changes ->> 'notes', '') else v_private.notes end;
      v_location := case when p_changes ? 'storage_location' then nullif(pg_catalog.btrim(p_changes ->> 'storage_location'), '') else v_private.storage_location end;

      if num_nonnulls(v_acquired, v_price, v_currency, v_notes, v_location) = 0 then
        delete from public.collection_item_private p where p.item_id = p_item;
      elsif v_has_private then
        update public.collection_item_private p
        set acquired_on = v_acquired, purchase_price = v_price, currency = v_currency, notes = v_notes, storage_location = v_location
        where p.item_id = p_item;
      else
        insert into public.collection_item_private (item_id, owner_id, acquired_on, purchase_price, currency, notes, storage_location)
        values (p_item, v_me, v_acquired, v_price, v_currency, v_notes, v_location);
      end if;
    end if;

    if p_changes ? 'components' then
      if pg_catalog.jsonb_typeof(p_changes -> 'components') <> 'array' or pg_catalog.jsonb_array_length(p_changes -> 'components') > 60
         or exists (select 1 from pg_catalog.jsonb_array_elements(p_changes -> 'components') e
                    where pg_catalog.jsonb_typeof(e) <> 'object'
                       or exists (select 1 from pg_catalog.jsonb_object_keys(e) k where k <> all (array['kind', 'label', 'condition']))) then
        raise exception using errcode = '22P02';
      end if;
      delete from public.collection_item_components c where c.item_id = p_item;
      insert into public.collection_item_components (item_id, owner_id, kind, label, condition)
      select p_item, v_me, x.kind, x.label, x.condition
      from pg_catalog.jsonb_to_recordset(p_changes -> 'components') as x(kind public.component_kind, label text, condition public.condition_grade);
    end if;
  exception
    when invalid_text_representation or invalid_datetime_format or datetime_field_overflow or check_violation
      or numeric_value_out_of_range or not_null_violation or unique_violation or string_data_right_truncation then
      raise exception 'invalid details' using errcode = '22023';
  end;
  return true;
end;
$$;

-- Adds one physical copy. p_item_id is a UUIDv7 the client generates once per copy it
-- means to add: sending the same request again returns the same copy instead of
-- adding another, so a retry or double click can't duplicate it. Adding another copy
-- on purpose uses a new id. A repeated request doesn't apply its details again.
-- Returns {item_id, created}.
create function public.add_collection_item(p_item_id uuid, p_release uuid, p_details jsonb default '{}')
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
  v_existing uuid;
  v_rows integer;
begin
  if v_me is null then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if p_item_id is null then
    raise exception 'invalid item id' using errcode = '22023';
  end if;
  if p_release is null then
    raise exception 'release unavailable' using errcode = 'P0001';
  end if;

  -- A repeat of a request that already succeeded.
  select c.release_id into v_existing from public.collection_items c where c.id = p_item_id and c.owner_id = v_me;
  if found then
    if v_existing = p_release then
      return pg_catalog.jsonb_build_object('item_id', p_item_id, 'created', false);
    end if;
    raise exception 'request conflict' using errcode = 'P0001';
  end if;

  if not coalesce((select a.is_active from public.get_my_account() a), false) then
    raise exception 'account not active' using errcode = 'P0001';
  end if;

  begin
    insert into public.collection_items (id, owner_id, release_id)
    values (p_item_id, v_me, p_release)
    on conflict (id) do nothing;
    get diagnostics v_rows = row_count;
  exception
    -- The insert policy refuses a release the caller may not use; a missing one fails its foreign key.
    when insufficient_privilege or foreign_key_violation then
      raise exception 'release unavailable' using errcode = 'P0001';
  end;

  if v_rows = 0 then
    -- The same request, committed concurrently, or an id already used elsewhere.
    select c.release_id into v_existing from public.collection_items c where c.id = p_item_id and c.owner_id = v_me;
    if found and v_existing = p_release then
      return pg_catalog.jsonb_build_object('item_id', p_item_id, 'created', false);
    end if;
    raise exception 'request conflict' using errcode = 'P0001';
  end if;

  if p_details is not null and p_details <> '{}'::jsonb then
    perform public.update_collection_item(p_item_id, p_details);
  end if;
  return pg_catalog.jsonb_build_object('item_id', p_item_id, 'created', true);
end;
$$;

-- Removes a copy, with its details and pieces. Allowed for a suspended account, and
-- for a preserved copy. Returns true.
create function public.remove_collection_item(p_item uuid)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
begin
  if v_me is null then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  delete from public.collection_items c where c.id = p_item and c.owner_id = v_me;
  if not found then
    raise exception 'item unavailable' using errcode = 'P0001';
  end if;
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Reads
-- ---------------------------------------------------------------------------
-- The catalog is read through its own RLS, as the caller: published records, and the
-- caller's own submissions (M7). A release the caller can no longer read appears as
-- null, and the copy's status says why.
--
-- Status, per copy (A1):
--   owned         active, release published: counts as an owned game
--   pending       active, release awaiting review (or being merged)
--   not_approved  active, release rejected
--   invalid       preserved: its release was excluded

-- One page of the caller's copies. Filters: a title (the game's or the release's local
-- title, ignoring case and accents), a platform slug, a completeness value or
-- 'not_recorded', and a status. Sorts: added (newest first), title, platform, or
-- acquired (most recent first, unknown dates last). Returns {items, next_cursor}.
-- A cursor belongs to the filters and sort that produced it.
--
-- Two steps: a lean query finds the page's ids, then the response is built for those
-- ids only. The page query is one statement per sort, so the planner can follow the
-- (owner_id, created_at, id) index for "added" and drop joins a sort doesn't need.
-- Only fixed fragments chosen by the sort go into it; every value is a parameter.
create function public.get_my_collection(
  p_query text default null,
  p_platform text default null,
  p_completeness text default null,
  p_status text default null,
  p_sort text default 'added',
  p_limit integer default 50,
  p_cursor text default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_sort text := coalesce(p_sort, 'added');
  v_query text;
  v_hash text;
  v_cursor jsonb;
  c_k1 text;
  c_k2 text;
  c_id uuid;
  v_keys text;
  v_order text;
  v_after text;
  v_ids uuid[];
  v_last_k1 text;
  v_last_k2 text;
  v_more boolean;
  v_items jsonb;
  v_next text;
begin
  if v_me is null then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_sort <> all (array['added', 'title', 'platform', 'acquired'])
     or p_completeness <> all (array['loose', 'incomplete', 'complete', 'sealed', 'not_recorded'])
     or p_status <> all (array['owned', 'pending', 'not_approved', 'invalid']) then
    raise exception 'invalid filter' using errcode = '22023';
  end if;
  if pg_catalog.char_length(p_query) > 100 then
    raise exception 'query too long' using errcode = '22023';
  end if;
  v_query := nullif(pg_catalog.regexp_replace(normalize(pg_catalog.lower(pg_catalog.btrim(coalesce(p_query, ''))), NFKD), '[̀-ͯ]', '', 'g'), '');
  v_hash := pg_catalog.md5(pg_catalog.jsonb_build_array(v_query, p_platform, p_completeness, p_status, v_sort)::text);

  if p_cursor is not null then
    begin
      v_cursor := pg_catalog.convert_from(pg_catalog.decode(pg_catalog.translate(p_cursor, '-_', '+/') ||
        pg_catalog.repeat('=', (4 - pg_catalog.length(p_cursor) % 4) % 4), 'base64'), 'UTF8')::jsonb;
      if pg_catalog.jsonb_typeof(v_cursor) <> 'array' or pg_catalog.jsonb_array_length(v_cursor) <> 4 or v_cursor ->> 0 is distinct from v_hash then
        raise exception using errcode = '22023';
      end if;
      c_k1 := v_cursor ->> 1;
      c_k2 := v_cursor ->> 2;
      c_id := (v_cursor ->> 3)::uuid;
      if c_id is null or c_k1 is null or (v_sort = 'platform' and c_k2 is null) then
        raise exception using errcode = '22023';
      end if;
      -- The keys must have the sort's types.
      case v_sort
        when 'added' then perform c_k1::timestamptz;
        when 'acquired' then perform c_k1::date;
        else null;
      end case;
    exception when others then
      raise exception 'invalid cursor' using errcode = '22023';
    end;
  end if;

  -- The sort's keys ($k1, $k2), order and position after the cursor.
  case v_sort
    when 'added' then
      v_keys := 'c.created_at::text, null::text';
      v_order := 'c.created_at desc, c.id desc';
      v_after := '(c.created_at, c.id) < ($6::timestamptz, $8)';
    when 'title' then
      v_keys := 'pg_catalog.lower(coalesce(g.sort_title, g.title, '''')), null::text';
      v_order := 'pg_catalog.lower(coalesce(g.sort_title, g.title, '''')), c.id';
      v_after := '(pg_catalog.lower(coalesce(g.sort_title, g.title, '''')), c.id) > ($6, $8)';
    when 'platform' then
      v_keys := 'pg_catalog.lower(coalesce(pl.name, '''')), pg_catalog.lower(coalesce(g.sort_title, g.title, ''''))';
      v_order := 'pg_catalog.lower(coalesce(pl.name, '''')), pg_catalog.lower(coalesce(g.sort_title, g.title, '''')), c.id';
      v_after := '(pg_catalog.lower(coalesce(pl.name, '''')), pg_catalog.lower(coalesce(g.sort_title, g.title, '''')), c.id) > ($6, $7, $8)';
    else
      v_keys := 'coalesce(pv.acquired_on, date ''0001-01-01'')::text, null::text';
      v_order := 'coalesce(pv.acquired_on, date ''0001-01-01'') desc, c.id desc';
      v_after := '(coalesce(pv.acquired_on, date ''0001-01-01''), c.id) < ($6::date, $8)';
  end case;

  -- $1 owner, $2 platform, $3 completeness, $4 status, $5 folded query, $6 to $8 the
  -- cursor, $9 the page size. Unused joins are removed by the planner.
  execute pg_catalog.format($q$
    select array_agg(x.id order by x.n) filter (where x.n <= $9),
           max(x.k1) filter (where x.n = $9), max(x.k2) filter (where x.n = $9),
           coalesce(bool_or(x.n > $9), false)
    from (
      select p.id, p.k1, p.k2, p.n
      from (
        select c.id, %1$s, row_number() over (order by %2$s)
        from public.collection_items c
        left join public.releases r on r.id = c.release_id
        left join public.games g on g.id = r.game_id
        left join public.platforms pl on pl.id = r.platform_id
        left join public.collection_item_private pv on pv.item_id = c.id
        where c.owner_id = $1
          and ($2 is null or pl.slug = $2)
          and ($3 is null or ($3 = 'not_recorded' and c.completeness is null) or c.completeness::text = $3)
          and ($4 is null or $4 = case
                when c.record_status = 'invalid_preserved' then 'invalid'
                when r.status = 'published' then 'owned'
                when r.status = 'rejected' then 'not_approved'
                when r.status is null then 'invalid'
                else 'pending'
              end)
          and ($5 is null
               or pg_catalog.strpos(pg_catalog.regexp_replace(normalize(pg_catalog.lower(coalesce(g.title, '')), NFKD), '[̀-ͯ]', '', 'g'), $5) > 0
               or pg_catalog.strpos(pg_catalog.regexp_replace(normalize(pg_catalog.lower(coalesce(r.local_title, '')), NFKD), '[̀-ͯ]', '', 'g'), $5) > 0)
          and ($8 is null or %3$s)
        order by %2$s
        limit $9 + 1
      ) p(id, k1, k2, n)
    ) x
  $q$, v_keys, v_order, v_after)
  into v_ids, v_last_k1, v_last_k2, v_more
  using v_me, p_platform, p_completeness, p_status, v_query, c_k1, c_k2, c_id, v_limit;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', c.id,
      'status', case
        when c.record_status = 'invalid_preserved' then 'invalid'
        when r.status = 'published' then 'owned'
        when r.status = 'rejected' then 'not_approved'
        when r.status is null then 'invalid'
        else 'pending'
      end,
      'added_at', c.created_at,
      'updated_at', c.updated_at,
      'completeness', c.completeness,
      'conditions', pg_catalog.jsonb_build_object('overall', c.overall_condition, 'box', c.box_condition, 'media', c.media_condition, 'manual', c.manual_condition),
      'copies_of_release', (select count(*) from public.collection_items x where x.owner_id = v_me and x.release_id = c.release_id),
      'game', case when g.id is null then null else pg_catalog.jsonb_build_object('id', g.id, 'slug', g.slug, 'title', g.title) end,
      'release', case when r.id is null then null else pg_catalog.jsonb_build_object(
        'id', r.id,
        'platform', pg_catalog.jsonb_build_object('slug', pl.slug, 'name', pl.name, 'short_name', pl.short_name),
        'region', pg_catalog.jsonb_build_object('code', r.region_code, 'label', rc.label),
        'edition_name', r.edition_name, 'variant_name', r.variant_name, 'local_title', r.local_title,
        'format', pg_catalog.jsonb_build_object('code', r.media_format_code, 'name', mf.name),
        'media_count', r.media_count) end,
      'acquired_on', pv.acquired_on,
      'price', case when pv.purchase_price is null then null else pg_catalog.jsonb_build_object('amount', pv.purchase_price::text, 'currency', pv.currency) end,
      'storage_location', pv.storage_location,
      'has_notes', pv.notes is not null
    ) order by pg_catalog.array_position(v_ids, c.id)), '[]'::jsonb)
  into v_items
  from public.collection_items c
  left join public.releases r on r.id = c.release_id
  left join public.games g on g.id = r.game_id
  left join public.platforms pl on pl.id = r.platform_id
  left join public.region_codes rc on rc.code = r.region_code
  left join public.media_formats mf on mf.code = r.media_format_code
  left join public.collection_item_private pv on pv.item_id = c.id
  where c.owner_id = v_me and c.id = any (coalesce(v_ids, '{}'));

  if v_more then
    v_next := pg_catalog.rtrim(pg_catalog.translate(pg_catalog.encode(pg_catalog.convert_to(
      pg_catalog.jsonb_build_array(v_hash, v_last_k1, v_last_k2, v_ids[v_limit])::text, 'UTF8'), 'base64'), E'+/\n', '-_'), '=');
  end if;
  return pg_catalog.jsonb_build_object('items', v_items, 'next_cursor', v_next);
end;
$$;

-- One of the caller's copies in full, including notes and the pieces its release
-- lists, or null. Pieces the release no longer lists are kept and marked unlisted.
create function public.get_my_collection_item(p_item uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'id', c.id,
    'status', case
      when c.record_status = 'invalid_preserved' then 'invalid'
      when r.status = 'published' then 'owned'
      when r.status = 'rejected' then 'not_approved'
      when r.status is null then 'invalid'
      else 'pending'
    end,
    'added_at', c.created_at,
    'updated_at', c.updated_at,
    'completeness', c.completeness,
    'conditions', pg_catalog.jsonb_build_object('overall', c.overall_condition, 'box', c.box_condition, 'media', c.media_condition, 'manual', c.manual_condition),
    'copies_of_release', (select count(*) from public.collection_items x where x.owner_id = c.owner_id and x.release_id = c.release_id),
    'game', case when g.id is null then null else pg_catalog.jsonb_build_object('id', g.id, 'slug', g.slug, 'title', g.title) end,
    'release', case when r.id is null then null else pg_catalog.jsonb_build_object(
      'id', r.id,
      'platform', pg_catalog.jsonb_build_object('slug', pl.slug, 'name', pl.name, 'short_name', pl.short_name),
      'region', pg_catalog.jsonb_build_object('code', r.region_code, 'label', rc.label),
      'edition_name', r.edition_name, 'variant_name', r.variant_name, 'local_title', r.local_title,
      'format', pg_catalog.jsonb_build_object('code', r.media_format_code, 'name', mf.name),
      'media_count', r.media_count, 'packaging', r.packaging,
      'identifiers', pg_catalog.jsonb_build_object('product_code', r.product_code, 'barcode', r.barcode)) end,
    'acquired_on', pv.acquired_on,
    'price', case when pv.purchase_price is null then null else pg_catalog.jsonb_build_object('amount', pv.purchase_price::text, 'currency', pv.currency) end,
    'storage_location', pv.storage_location,
    'notes', pv.notes,
    'components', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'kind', x.kind, 'label', x.label, 'quantity', x.quantity, 'listed', x.listed, 'recorded', x.recorded, 'condition', x.condition
      ) order by x.listed desc, x.kind, x.label)
      from (
        select coalesce(l.kind, m.kind) as kind, coalesce(l.label, m.label) as label, l.quantity,
               l.kind is not null as listed, m.kind is not null as recorded, m.condition
        from (select k.kind, k.label, k.quantity from public.release_components k where k.release_id = c.release_id) l
        full join (select k.kind, k.label, k.condition from public.collection_item_components k where k.item_id = c.id) m
          on m.kind = l.kind and m.label = l.label
      ) x
    ), '[]'::jsonb)
  )
  from public.collection_items c
  left join public.releases r on r.id = c.release_id
  left join public.games g on g.id = r.game_id
  left join public.platforms pl on pl.id = r.platform_id
  left join public.region_codes rc on rc.code = r.region_code
  left join public.media_formats mf on mf.code = r.media_format_code
  left join public.collection_item_private pv on pv.item_id = c.id
  where c.id = p_item and c.owner_id = (select auth.uid())
$$;

-- The caller's copies of one release, newest first, for "you have 2 copies" on the
-- game page. Returns {count, copies}, with up to 100 copies.
create function public.get_my_release_copies(p_release uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'count', (select count(*) from public.collection_items c where c.owner_id = (select auth.uid()) and c.release_id = p_release),
    'copies', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', x.id, 'added_at', x.created_at, 'completeness', x.completeness,
        'conditions', pg_catalog.jsonb_build_object('overall', x.overall_condition, 'box', x.box_condition, 'media', x.media_condition, 'manual', x.manual_condition)
      ) order by x.created_at desc, x.id desc)
      from (
        select c.* from public.collection_items c
        where c.owner_id = (select auth.uid()) and c.release_id = p_release
        order by c.created_at desc, c.id desc
        limit 100
      ) x
    ), '[]'::jsonb)
  )
$$;

-- What the caller's collection holds, by status, with a count for each platform.
-- Only "owned" counts as owned games (A1). Describes the caller only.
create function public.get_my_collection_summary()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with mine as (
    select
      case
        when c.record_status = 'invalid_preserved' then 'invalid'
        when r.status = 'published' then 'owned'
        when r.status = 'rejected' then 'not_approved'
        when r.status is null then 'invalid'
        else 'pending'
      end as status,
      r.platform_id
    from public.collection_items c
    left join public.releases r on r.id = c.release_id
    where c.owner_id = (select auth.uid())
  )
  select pg_catalog.jsonb_build_object(
    'total', (select count(*) from mine),
    'owned', (select count(*) from mine where status = 'owned'),
    'pending', (select count(*) from mine where status = 'pending'),
    'not_approved', (select count(*) from mine where status = 'not_approved'),
    'invalid', (select count(*) from mine where status = 'invalid'),
    'limit', 100000,
    'platforms', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('slug', pl.slug, 'name', pl.name, 'short_name', pl.short_name, 'count', x.n)
             order by pl.name)
      from (select m.platform_id, count(*) as n from mine m where m.platform_id is not null group by m.platform_id) x
      join public.platforms pl on pl.id = x.platform_id
    ), '[]'::jsonb)
  )
$$;

-- ---------------------------------------------------------------------------
-- 3. Grants: signed-in users only
-- ---------------------------------------------------------------------------

revoke all on function public.update_collection_item(uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.add_collection_item(uuid, uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.remove_collection_item(uuid) from public, anon, authenticated, service_role;
revoke all on function public.get_my_collection(text, text, text, text, text, integer, text) from public, anon, authenticated, service_role;
revoke all on function public.get_my_collection_item(uuid) from public, anon, authenticated, service_role;
revoke all on function public.get_my_release_copies(uuid) from public, anon, authenticated, service_role;
revoke all on function public.get_my_collection_summary() from public, anon, authenticated, service_role;

grant execute on function public.update_collection_item(uuid, jsonb) to authenticated;
grant execute on function public.add_collection_item(uuid, uuid, jsonb) to authenticated;
grant execute on function public.remove_collection_item(uuid) to authenticated;
grant execute on function public.get_my_collection(text, text, text, text, text, integer, text) to authenticated;
grant execute on function public.get_my_collection_item(uuid) to authenticated;
grant execute on function public.get_my_release_copies(uuid) to authenticated;
grant execute on function public.get_my_collection_summary() to authenticated;
