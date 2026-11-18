-- M11b-1b: release identity and packaging vocabulary (MIG-2 and MIG-3 together).
--
-- Design: docs/architecture/physical-catalog-m11b.md, section 6, approved by the product
-- owner on 2026-11-18 with the packaging codes below.
--
-- 1. packaging_types: a controlled vocabulary defined by construction, never by disc
--    count. releases.packaging_code refers to it, defaulting to 'unclassified'. The
--    existing releases.packaging text is kept exactly as recorded. Nothing is classified.
-- 2. Both release identity indexes gain the media format, compare edition, variant and
--    product code conservatively, and compare packaging through a key that keeps the
--    exact historical text for every unclassified release.
-- 3. A preflight evaluates the exact final key, through the same functions the indexes
--    use, and aborts before any index is touched if existing releases would collide.
--    Nothing is merged, renamed, deleted or reclassified to make an index fit.
-- 4. The new indexes are built under temporary names, the old ones dropped by exact name
--    and the new ones renamed, in this migration's transaction: the index build holds a
--    lock that blocks writes until commit, so there is no window for a duplicate. The
--    names are kept because functions map them to friendly duplicate messages.
-- 5. A release trigger: for API sessions, a release newly published from review needs classified
--    packaging and a format its platform accepts for new publications (NES and SNES no
--    longer accept the generic rom-cartridge). Only a catalog editor can record 'unknown'.
--    Packaging never returns to 'unclassified', except on a collector's own open submission.
--    Existing published releases are untouched and stay editable.
-- 6. Exact-signature replacements of the functions that read or write packaging.
--
-- The key functions are used by unique indexes, so they must never be replaced in place:
-- a change needs new functions and new indexes.

-- ---------------------------------------------------------------------------
-- 1. Packaging vocabulary
-- ---------------------------------------------------------------------------

create table public.packaging_types (
  code text primary key check (code ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(code) <= 40),
  name text not null unique check (char_length(name) between 1 and 60),
  description text not null check (char_length(description) between 1 and 300),
  -- False for the two states that aren't a type: unclassified and unknown.
  is_type boolean not null,
  position smallint not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_updated_at before update on public.packaging_types
  for each row execute function private.set_updated_at();

alter table public.packaging_types enable row level security;
create policy packaging_types_read on public.packaging_types for select to anon, authenticated using (true);
revoke all on public.packaging_types from public, anon, authenticated, service_role;
grant select on public.packaging_types to anon, authenticated, service_role;

insert into public.packaging_types (code, name, description, is_type, position) values
  ('unclassified', 'Not yet classified',
   'No editor has determined the packaging. Every existing release starts here. A release can''t be newly published with it.', false, 1),
  ('unknown', 'Unknown',
   'An editor examined the evidence and the packaging can''t be established.', false, 2),
  ('cardboard-box', 'Cardboard box',
   'A folding paperboard carton. An inner tray, insert or sleeve is a component, not part of the type.', true, 10),
  ('jewel-case', 'Jewel case',
   'A standard-depth hinged plastic disc case, about 10 mm deep. It may hold a hinged tray for a second disc; the disc count is recorded separately.', true, 20),
  ('double-depth-jewel-case', 'Double-depth jewel case',
   'A hinged plastic disc case about twice the standard depth, with internal hinged trays. The disc count is recorded separately.', true, 30),
  ('plastic-case', 'Plastic case',
   'A moulded plastic case that isn''t a jewel case, such as a clamshell or keep case.', true, 40),
  ('paper-sleeve', 'Paper sleeve',
   'A paper or card sleeve or envelope, with no rigid case.', true, 50);

alter table public.releases
  add column packaging_code text not null default 'unclassified'
    references public.packaging_types (code) on delete restrict;

grant select (packaging_code) on public.releases to anon, authenticated;

-- Which (platform, format) pairs a release may newly be published with. Existing
-- releases keep their format. NES and SNES releases now name their cartridge shell.
alter table public.platform_media_formats
  add column accepts_new_publications boolean not null default true;

update public.platform_media_formats f set accepts_new_publications = false
from public.platforms p
where p.id = f.platform_id and p.slug in ('nes', 'snes') and f.media_format_code = 'rom-cartridge';

-- ---------------------------------------------------------------------------
-- 2. Comparison keys. Immutable, schema-qualified, null in and null out.
-- ---------------------------------------------------------------------------

-- Edition and variant labels: Unicode NFC, typographic apostrophes, quotes and dashes as
-- ASCII, other spaces as a space, runs of white space as one, trimmed, lower case.
-- Letters, digits, accents and punctuation are kept: "Edition" and "Édition", or
-- "Players' Choice" and "Players Choice", stay different.
create function private.release_label_key(p_label text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select nullif(pg_catalog.lower(pg_catalog.btrim(pg_catalog.regexp_replace(
    pg_catalog.translate(pg_catalog.normalize(p_label, 'NFC'),
      U&'\2018\2019\02BC\201C\201D\2010\2011\2012\2013\2014\2212\00A0\2007\202F\3000',
      U&'''''''""------    '),
    '\s+', ' ', 'g'))), '')
$$;

-- Product codes: Unicode NFC, surrounding white space removed, upper case. Hyphens,
-- slashes, dots and inner spaces stay significant, and a combined code is never split.
create function private.release_code_key(p_code text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select nullif(pg_catalog.upper(pg_catalog.regexp_replace(pg_catalog.normalize(p_code, 'NFC'), '^\s+|\s+$', '', 'g')), '')
$$;

-- Packaging identity: the code for a classified release; for an unclassified one, the code
-- and the exact historical text, so releases the old index kept apart stay apart.
create function private.release_packaging_key(p_code text, p_text text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case when p_code = 'unclassified'
    then 'unclassified' || pg_catalog.chr(31) || coalesce(p_text, '')
    else p_code end
$$;

revoke all on function private.release_label_key(text) from public, anon, authenticated, service_role;
revoke all on function private.release_code_key(text) from public, anon, authenticated, service_role;
revoke all on function private.release_packaging_key(text, text) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Preflight: the exact final keys, before any index changes
-- ---------------------------------------------------------------------------

do $$
declare
  v_published text;
  v_pending text;
begin
  select pg_catalog.string_agg(ids, '; ') into v_published from (
    select pg_catalog.string_agg(r.id::text, ',' order by r.id) as ids
    from public.releases r
    where r.status = 'published'
    group by r.game_id, r.platform_id, r.media_format_code, r.region_code,
      private.release_label_key(r.edition_name), private.release_label_key(r.variant_name),
      private.release_packaging_key(r.packaging_code, r.packaging), private.release_code_key(r.product_code)
    having pg_catalog.count(*) > 1
  ) c;
  select pg_catalog.string_agg(ids, '; ') into v_pending from (
    select pg_catalog.string_agg(r.id::text, ',' order by r.id) as ids
    from public.releases r
    where r.status in ('unverified', 'under_review') and r.submitted_by is not null
    group by r.submitted_by, r.game_id, r.platform_id, r.media_format_code, r.region_code,
      private.release_label_key(r.edition_name), private.release_label_key(r.variant_name),
      private.release_packaging_key(r.packaging_code, r.packaging), private.release_code_key(r.product_code)
    having pg_catalog.count(*) > 1
  ) c;
  if v_published is not null or v_pending is not null then
    raise exception 'M11b-1b preflight: releases would share an identity under the new key. Published: %. Pending submissions: %. Resolve them editorially; nothing was changed.',
      coalesce(v_published, 'none'), coalesce(v_pending, 'none');
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. The identity indexes, replaced under their existing names
-- ---------------------------------------------------------------------------

create unique index releases_published_identity_key_m11b1b on public.releases (
  game_id, platform_id, media_format_code, region_code,
  private.release_label_key(edition_name), private.release_label_key(variant_name),
  private.release_packaging_key(packaging_code, packaging), private.release_code_key(product_code)
) nulls not distinct
where status = 'published';

create unique index releases_pending_submission_key_m11b1b on public.releases (
  submitted_by, game_id, platform_id, media_format_code, region_code,
  private.release_label_key(edition_name), private.release_label_key(variant_name),
  private.release_packaging_key(packaging_code, packaging), private.release_code_key(product_code)
) nulls not distinct
where status in ('unverified', 'under_review') and submitted_by is not null;

drop index public.releases_published_identity_key;
drop index public.releases_pending_submission_key;
alter index public.releases_published_identity_key_m11b1b rename to releases_published_identity_key;
alter index public.releases_pending_submission_key_m11b1b rename to releases_pending_submission_key;

-- ---------------------------------------------------------------------------
-- 5. Packaging and format rules on releases
-- ---------------------------------------------------------------------------

create function private.guard_release_packaging_and_format()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  -- API sessions, including SECURITY DEFINER functions they call. Maintenance sessions
  -- (migrations, operators, fixtures) are exempt, as in the M7b-1 and M10c guards.
  v_client boolean := coalesce(pg_catalog.current_setting('role', true), 'none') in ('authenticated', 'anon');
  v_changed boolean := tg_op = 'INSERT' or new.packaging_code is distinct from old.packaging_code;
begin
  -- Packaging never returns to unclassified, except on a collector's own open submission.
  if tg_op = 'UPDATE' and old.packaging_code <> 'unclassified' and new.packaging_code = 'unclassified'
     and not (new.status = 'unverified' and new.submitted_by is not null) then
    raise exception 'packaging already classified' using errcode = 'P0001';
  end if;
  if v_client and v_changed and new.packaging_code = 'unknown' and not (select private.is_catalog_editor()) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  -- A new publication: inserted as published, or published from review. Restoring an
  -- exclusion (excluded to published) returns a release that was already published.
  if v_client and new.status = 'published' and (tg_op = 'INSERT' or old.status in ('unverified', 'under_review')) then
    if new.packaging_code = 'unclassified' then
      raise exception 'packaging classification required' using errcode = 'P0001';
    end if;
    if not exists (select 1 from public.platform_media_formats f
                   where f.platform_id = new.platform_id and f.media_format_code = new.media_format_code
                     and f.accepts_new_publications) then
      raise exception 'physical format unverified' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function private.guard_release_packaging_and_format() from public, anon, authenticated, service_role;

create trigger guard_release_packaging_and_format before insert or update on public.releases
  for each row execute function private.guard_release_packaging_and_format();

-- ---------------------------------------------------------------------------
-- 6. Functions that read or write packaging (exact signatures, behaviour otherwise unchanged)
-- ---------------------------------------------------------------------------

-- create_release: accepts packaging_code (a code from packaging_types); unclassified when not given.
CREATE OR REPLACE FUNCTION public.create_release(p_game uuid, p_platform uuid, p_media_format_code text, p_region_code text DEFAULT 'unknown'::text, p_details jsonb DEFAULT '{}'::jsonb, p_reason text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_me uuid;
  v_reason text;
  v_keys text[];
  v_row public.releases;
  v_id uuid;
begin
  v_me := private.begin_catalog_edit();
  v_reason := private.require_reason(p_reason);
  v_keys := private.change_keys(coalesce(p_details, '{}'), array[
    'barcode', 'edition_kind', 'edition_name', 'languages', 'local_title', 'media_count', 'media_playability', 'packaging',
    'packaging_code', 'product_code', 'publisher_name', 'rating_labels', 'region_unknown_confirmed', 'release_date', 'release_date_precision', 'variant_name'
  ]);

  perform 1 from public.games g where g.id = p_game and g.status not in ('merged', 'excluded') for share;
  if not found or not exists (select 1 from public.platforms p where p.id = p_platform) then
    raise exception 'record unavailable' using errcode = 'P0001';
  end if;

  v_row := pg_catalog.jsonb_populate_record(null::public.releases, coalesce(p_details, '{}'));
  if v_row.packaging_code is not null and not exists (select 1 from public.packaging_types t where t.code = v_row.packaging_code) then
    raise exception 'invalid changes' using errcode = '22023';
  end if;

  insert into public.game_platforms (game_id, platform_id, status)
  values (p_game, p_platform, 'under_review')
  on conflict (game_id, platform_id) do nothing;

  v_row := pg_catalog.jsonb_populate_record(null::public.releases, coalesce(p_details, '{}'));
  insert into public.releases (
    game_id, platform_id, region_code, region_unknown_confirmed, edition_name, edition_kind, variant_name, product_code,
    barcode, local_title, publisher_name, media_format_code, media_count, media_playability, packaging, packaging_code, languages,
    rating_labels, release_date, release_date_precision, status
  ) values (
    p_game, p_platform, coalesce(p_region_code, 'unknown'), coalesce(v_row.region_unknown_confirmed, false), v_row.edition_name,
    v_row.edition_kind, v_row.variant_name, v_row.product_code, v_row.barcode, v_row.local_title, v_row.publisher_name,
    p_media_format_code, v_row.media_count, coalesce(v_row.media_playability, 'unknown'), v_row.packaging, coalesce(v_row.packaging_code, 'unclassified'), v_row.languages,
    v_row.rating_labels, v_row.release_date, coalesce(v_row.release_date_precision, 'unknown'), 'under_review'
  )
  returning id into v_id;

  perform private.record_catalog_audit(v_me, 'catalog_record_created', 'release', v_id, v_reason,
    pg_catalog.jsonb_build_object('game_id', p_game, 'platform_id', p_platform, 'fields', v_keys));
  return v_id;
end;
$function$;

-- update_release: packaging_code is an editable, lockable identity field. Returning it to unclassified is refused by the release trigger.
CREATE OR REPLACE FUNCTION public.update_release(p_release uuid, p_changes jsonb, p_reason text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_me uuid;
  v_reason text;
  v_keys text[];
  v_old public.releases;
  v_new public.releases;
  v_changed text[];
  v_cleared boolean;
  v_status public.catalog_status;
begin
  v_me := private.begin_catalog_edit();
  v_reason := private.require_reason(p_reason);
  v_keys := private.change_keys(p_changes, array[
    'barcode', 'edition_kind', 'edition_name', 'languages', 'local_title', 'media_count', 'media_format_code', 'media_playability',
    'packaging', 'packaging_code', 'product_code', 'publisher_name', 'rating_labels', 'region_code', 'region_unknown_confirmed', 'release_date',
    'release_date_precision', 'variant_name'
  ]);
  v_status := private.lock_release_for_edit(p_release, v_reason);
  -- M10c (D3): changing a published release needs a recent TOTP verification.
  if v_status = 'published' then
    perform private.require_recent_mfa();
  end if;
  -- M10c (D-7): any change ends an unpublished release's verification.
  v_cleared := private.release_verification_ends(p_release);

  select * into v_old from public.releases r where r.id = p_release;
  v_new := pg_catalog.jsonb_populate_record(v_old, p_changes);
  if v_new.packaging_code is null or not exists (select 1 from public.packaging_types t where t.code = v_new.packaging_code) then
    raise exception 'invalid changes' using errcode = '22023';
  end if;
  -- Confirming an unknown region applies only while the region is unknown.
  if v_new.region_code <> 'unknown' then
    v_new.region_unknown_confirmed := false;
  end if;
  select coalesce(pg_catalog.array_agg(k order by k), '{}') into v_changed
  from unnest(array['barcode', 'edition_kind', 'edition_name', 'languages', 'local_title', 'media_count', 'media_format_code',
                    'media_playability', 'packaging', 'packaging_code', 'product_code', 'publisher_name', 'rating_labels', 'region_code',
                    'region_unknown_confirmed', 'release_date', 'release_date_precision', 'variant_name']) k
  where pg_catalog.to_jsonb(v_old) -> k is distinct from pg_catalog.to_jsonb(v_new) -> k;
  if cardinality(v_changed) = 0 then
    return false;
  end if;

  update public.releases r set
    region_code = v_new.region_code,
    region_unknown_confirmed = v_new.region_unknown_confirmed,
    edition_name = v_new.edition_name,
    edition_kind = v_new.edition_kind,
    variant_name = v_new.variant_name,
    product_code = v_new.product_code,
    barcode = v_new.barcode,
    local_title = v_new.local_title,
    publisher_name = v_new.publisher_name,
    media_format_code = v_new.media_format_code,
    media_count = v_new.media_count,
    media_playability = v_new.media_playability,
    packaging = v_new.packaging,
    packaging_code = v_new.packaging_code,
    languages = v_new.languages,
    rating_labels = v_new.rating_labels,
    release_date = v_new.release_date,
    release_date_precision = v_new.release_date_precision
  where r.id = p_release;

  perform private.record_catalog_audit(v_me, 'catalog_record_updated', 'release', p_release, v_reason,
    pg_catalog.jsonb_build_object('fields', v_changed, 'verification_cleared', v_cleared));
  return true;
end;
$function$;

-- submission_details: a collector may choose a packaging type or leave it unclassified. Only an editor can record unknown.
CREATE OR REPLACE FUNCTION private.submission_details(p_details jsonb)
 RETURNS releases
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare
  r public.releases;
  v_precision text;
begin
  if p_details is null or pg_catalog.jsonb_typeof(p_details) <> 'object'
     or exists (select 1 from pg_catalog.jsonb_each(p_details) e
                where e.key <> all (array['edition_name', 'edition_kind', 'variant_name', 'product_code', 'barcode', 'local_title',
                                          'publisher_name', 'media_count', 'packaging', 'packaging_code', 'release_date', 'release_date_precision'])
                   or pg_catalog.jsonb_typeof(e.value) not in ('string', 'number', 'null')) then
    raise exception 'invalid submission' using errcode = '22023';
  end if;
  r.edition_name := nullif(pg_catalog.btrim(p_details ->> 'edition_name'), '');
  r.edition_kind := nullif(p_details ->> 'edition_kind', '')::public.edition_kind;
  r.variant_name := nullif(pg_catalog.btrim(p_details ->> 'variant_name'), '');
  r.product_code := nullif(pg_catalog.btrim(p_details ->> 'product_code'), '');
  r.barcode := nullif(pg_catalog.btrim(p_details ->> 'barcode'), '');
  r.local_title := nullif(pg_catalog.btrim(p_details ->> 'local_title'), '');
  r.publisher_name := nullif(pg_catalog.btrim(p_details ->> 'publisher_name'), '');
  r.media_count := nullif(p_details ->> 'media_count', '')::smallint;
  r.packaging := nullif(pg_catalog.btrim(p_details ->> 'packaging'), '');
  r.packaging_code := coalesce(nullif(pg_catalog.btrim(p_details ->> 'packaging_code'), ''), 'unclassified');
  if r.packaging_code = 'unknown' or not exists (select 1 from public.packaging_types t where t.code = r.packaging_code) then
    raise exception 'invalid submission' using errcode = '22023';
  end if;
  r.release_date := nullif(p_details ->> 'release_date', '')::date;
  v_precision := nullif(p_details ->> 'release_date_precision', '');
  if r.release_date is null then
    if v_precision is not null and v_precision <> 'unknown' then
      raise exception 'invalid submission' using errcode = '22023';
    end if;
    r.release_date_precision := 'unknown';
  else
    r.release_date_precision := coalesce(v_precision, 'day')::public.date_precision;
    if r.release_date_precision = 'unknown' or r.release_date < date '1950-01-01' or r.release_date > pg_catalog.now()::date + 366 then
      raise exception 'invalid submission' using errcode = '22023';
    end if;
    -- Stored to the precision given: a year is its first day, a month its first day.
    if r.release_date_precision = 'year' then
      r.release_date := pg_catalog.make_date(pg_catalog.date_part('year', r.release_date)::int, 1, 1);
    elsif r.release_date_precision = 'month' then
      r.release_date := pg_catalog.make_date(pg_catalog.date_part('year', r.release_date)::int, pg_catalog.date_part('month', r.release_date)::int, 1);
    end if;
  end if;
  return r;
exception
  when invalid_text_representation or invalid_datetime_format or datetime_field_overflow or numeric_value_out_of_range then
    raise exception 'invalid submission' using errcode = '22023';
end;
$function$;

-- create_submitted_release: stores the submitted packaging_code.
CREATE OR REPLACE FUNCTION private.create_submitted_release(p_me uuid, p_game uuid, p_platform text, p_media_format text, p_region text, p_details jsonb, p_pieces jsonb, OUT release_id uuid, OUT platform_id uuid, OUT created_pairing boolean)
 RETURNS record
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_row public.releases;
  v_rows integer;
  v_constraint text;
begin
  select p.id into platform_id from public.platforms p where p.slug = p_platform;
  if platform_id is null
     or not exists (select 1 from public.platform_media_formats f where f.platform_id = create_submitted_release.platform_id and f.media_format_code = p_media_format)
     or not exists (select 1 from public.region_codes rc where rc.code = p_region) then
    raise exception 'invalid submission' using errcode = '22023';
  end if;
  v_row := private.submission_details(coalesce(p_details, '{}'));

  begin
    insert into public.game_platforms (game_id, platform_id, status, submitted_by)
    values (p_game, create_submitted_release.platform_id, 'unverified', p_me)
    on conflict on constraint game_platforms_pkey do nothing;
    get diagnostics v_rows = row_count;
    created_pairing := v_rows = 1;

    insert into public.releases (
      game_id, platform_id, region_code, region_unknown_confirmed, media_format_code, media_playability,
      edition_name, edition_kind, variant_name, product_code, barcode, local_title, publisher_name, media_count, packaging, packaging_code,
      release_date, release_date_precision, status, submitted_by
    ) values (
      p_game, create_submitted_release.platform_id, p_region, false, p_media_format, 'unknown',
      v_row.edition_name, v_row.edition_kind, v_row.variant_name, v_row.product_code, v_row.barcode, v_row.local_title,
      v_row.publisher_name, v_row.media_count, v_row.packaging, v_row.packaging_code, v_row.release_date, v_row.release_date_precision, 'unverified', p_me
    )
    returning id into release_id;

    perform private.set_submitted_pieces(release_id, coalesce(p_pieces, '[]'));
  exception
    when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint = 'releases_pending_submission_key' then
        raise exception 'already submitted' using errcode = 'P0001';
      end if;
      raise exception 'invalid submission' using errcode = '22023';
    when invalid_text_representation or check_violation or numeric_value_out_of_range or not_null_violation
      or string_data_right_truncation or foreign_key_violation then
      raise exception 'invalid submission' using errcode = '22023';
  end;
end;
$function$;

-- submit_release: the published-duplicate check uses the same comparison as releases_published_identity_key, including the media format.
CREATE OR REPLACE FUNCTION public.submit_release(p_game uuid, p_platform text, p_media_format text, p_region text, p_details jsonb DEFAULT '{}'::jsonb, p_components jsonb DEFAULT '[]'::jsonb, p_note text DEFAULT NULL::text, p_physical boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_me uuid;
  v_row public.releases;
  v_existing uuid;
  v_release uuid;
  v_platform uuid;
  v_pairing boolean;
  v_note text := nullif(pg_catalog.btrim(p_note), '');
  v_id uuid;
begin
  v_me := private.begin_submission(true);
  if not coalesce(p_physical, false) or pg_catalog.char_length(v_note) > 1000 then
    raise exception 'invalid submission' using errcode = '22023';
  end if;

  perform 1 from public.games g
  where g.id = p_game
    and (g.status = 'published' or (g.submitted_by = v_me and g.status = 'unverified'))
  for share;
  if not found then
    raise exception 'game unavailable' using errcode = 'P0001';
  end if;

  v_row := private.submission_details(coalesce(p_details, '{}'));
  select r.id into v_existing
  from public.releases r join public.platforms pl on pl.id = r.platform_id
  where r.status = 'published' and r.game_id = p_game and pl.slug = p_platform and r.media_format_code = p_media_format
    and r.region_code = p_region
    and private.release_label_key(r.edition_name) is not distinct from private.release_label_key(v_row.edition_name)
    and private.release_label_key(r.variant_name) is not distinct from private.release_label_key(v_row.variant_name)
    and private.release_packaging_key(r.packaging_code, r.packaging) = private.release_packaging_key(v_row.packaging_code, v_row.packaging)
    and private.release_code_key(r.product_code) is not distinct from private.release_code_key(v_row.product_code)
  limit 1;
  if v_existing is not null then
    return pg_catalog.jsonb_build_object('outcome', 'published_duplicate', 'release_id', v_existing);
  end if;

  select c.release_id, c.platform_id, c.created_pairing into v_release, v_platform, v_pairing
  from private.create_submitted_release(v_me, p_game, p_platform, p_media_format, p_region, p_details, p_components) c;

  insert into public.catalog_change_requests (request_type, submitted_by, game_id, release_id, platform_id, details, reason, physical_confirmed, created_game, created_pairing)
  values ('new_release', v_me, p_game, v_release, v_platform, private.submission_snapshot(v_release), v_note, true, false, v_pairing)
  returning id into v_id;
  perform private.record_audit(v_me, 'catalog_submission_created', null, 'Catalog submission',
    pg_catalog.jsonb_build_object('request_id', v_id, 'release_id', v_release, 'game_id', p_game));
  return pg_catalog.jsonb_build_object('outcome', 'submitted', 'submission_id', v_id, 'release_id', v_release, 'game_id', p_game);
end;
$function$;

-- update_my_submission: replacing the details replaces packaging_code too.
CREATE OR REPLACE FUNCTION public.update_my_submission(p_submission uuid, p_changes jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_me uuid;
  v_sub public.catalog_change_requests;
  v_release public.releases;
  v_row public.releases;
  v_year integer;
  v_constraint text;
begin
  v_me := private.begin_submission(false);
  if p_changes is null or pg_catalog.jsonb_typeof(p_changes) <> 'object'
     or exists (select 1 from pg_catalog.jsonb_object_keys(p_changes) k
                where k <> all (array['note', 'region', 'media_format', 'details', 'components', 'title', 'game_kind', 'first_release_year'])) then
    raise exception 'invalid submission' using errcode = '22023';
  end if;
  v_sub := private.lock_open_submission(v_me, p_submission);
  -- Already locked by the helper, in this transaction.
  select * into v_release from public.releases r where r.id = v_sub.release_id;

  if (p_changes ?| array['title', 'game_kind', 'first_release_year'])
     and (not v_sub.created_game or not exists (select 1 from public.games g where g.id = v_release.game_id and g.status = 'unverified' and g.submitted_by = v_me)) then
    raise exception 'invalid submission' using errcode = '22023';
  end if;
  if p_changes ? 'note' and pg_catalog.char_length(pg_catalog.btrim(p_changes ->> 'note')) > 1000 then
    raise exception 'invalid submission' using errcode = '22023';
  end if;

  begin
    if p_changes ?| array['title', 'game_kind', 'first_release_year'] then
      v_year := case when p_changes ? 'first_release_year' then nullif(p_changes ->> 'first_release_year', '')::integer end;
      if v_year is not null and v_year not between 1950 and pg_catalog.date_part('year', pg_catalog.now())::int + 1 then
        raise exception 'invalid submission' using errcode = '22023';
      end if;
      update public.games g set
        title = case when p_changes ? 'title' then pg_catalog.btrim(p_changes ->> 'title') else g.title end,
        sort_title = case when p_changes ? 'title' then pg_catalog.btrim(p_changes ->> 'title') else g.sort_title end,
        kind = case when p_changes ? 'game_kind' then (p_changes ->> 'game_kind')::public.game_kind else g.kind end,
        first_release_date = case when p_changes ? 'first_release_year' then case when v_year is null then null else pg_catalog.make_date(v_year, 1, 1) end else g.first_release_date end,
        first_release_precision = case when p_changes ? 'first_release_year' then case when v_year is null then 'unknown' else 'year' end::public.date_precision else g.first_release_precision end
      where g.id = v_release.game_id;
    end if;

    if p_changes ? 'region' and not exists (select 1 from public.region_codes rc where rc.code = p_changes ->> 'region') then
      raise exception 'invalid submission' using errcode = '22023';
    end if;
    if p_changes ? 'media_format' and not exists (select 1 from public.platform_media_formats f
                                                  where f.platform_id = v_release.platform_id and f.media_format_code = p_changes ->> 'media_format') then
      raise exception 'invalid submission' using errcode = '22023';
    end if;
    if p_changes ? 'details' then
      v_row := private.submission_details(p_changes -> 'details');
    end if;
    update public.releases r set
      region_code = case when p_changes ? 'region' then p_changes ->> 'region' else r.region_code end,
      media_format_code = case when p_changes ? 'media_format' then p_changes ->> 'media_format' else r.media_format_code end,
      edition_name = case when p_changes ? 'details' then v_row.edition_name else r.edition_name end,
      edition_kind = case when p_changes ? 'details' then v_row.edition_kind else r.edition_kind end,
      variant_name = case when p_changes ? 'details' then v_row.variant_name else r.variant_name end,
      product_code = case when p_changes ? 'details' then v_row.product_code else r.product_code end,
      barcode = case when p_changes ? 'details' then v_row.barcode else r.barcode end,
      local_title = case when p_changes ? 'details' then v_row.local_title else r.local_title end,
      publisher_name = case when p_changes ? 'details' then v_row.publisher_name else r.publisher_name end,
      media_count = case when p_changes ? 'details' then v_row.media_count else r.media_count end,
      packaging = case when p_changes ? 'details' then v_row.packaging else r.packaging end,
      packaging_code = case when p_changes ? 'details' then v_row.packaging_code else r.packaging_code end,
      release_date = case when p_changes ? 'details' then v_row.release_date else r.release_date end,
      release_date_precision = case when p_changes ? 'details' then v_row.release_date_precision else r.release_date_precision end
    where r.id = v_release.id;

    if p_changes ? 'components' then
      perform private.set_submitted_pieces(v_release.id, p_changes -> 'components');
    end if;
  exception
    when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint = 'releases_pending_submission_key' then
        raise exception 'already submitted' using errcode = 'P0001';
      end if;
      raise exception 'invalid submission' using errcode = '22023';
    when invalid_text_representation or check_violation or numeric_value_out_of_range or not_null_violation
      or string_data_right_truncation or foreign_key_violation or invalid_datetime_format or datetime_field_overflow then
      raise exception 'invalid submission' using errcode = '22023';
  end;

  update public.catalog_change_requests s set
    reason = case when p_changes ? 'note' then nullif(pg_catalog.btrim(p_changes ->> 'note'), '') else s.reason end,
    details = private.submission_snapshot(v_release.id)
  where s.id = v_sub.id;
  perform private.record_audit(v_me, 'catalog_submission_updated', null, 'Catalog submission',
    pg_catalog.jsonb_build_object('request_id', v_sub.id, 'release_id', v_release.id));
  return true;
end;
$function$;

-- submission_snapshot: includes packaging_code.
CREATE OR REPLACE FUNCTION private.submission_snapshot(p_release uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select pg_catalog.jsonb_build_object(
    'title', g.title, 'game_kind', g.kind,
    'first_release_year', case when g.first_release_precision = 'unknown' then null else pg_catalog.date_part('year', g.first_release_date)::int end,
    'platform', pg_catalog.jsonb_build_object('slug', pl.slug, 'name', pl.name, 'short_name', pl.short_name),
    'region', pg_catalog.jsonb_build_object('code', r.region_code, 'label', rc.label),
    'format', pg_catalog.jsonb_build_object('code', r.media_format_code, 'name', mf.name, 'category', mf.category),
    'edition_name', r.edition_name, 'edition_kind', r.edition_kind, 'variant_name', r.variant_name,
    'product_code', r.product_code, 'barcode', r.barcode, 'local_title', r.local_title, 'publisher_name', r.publisher_name,
    'media_count', r.media_count, 'packaging', r.packaging, 'packaging_code', r.packaging_code,
    'release_date', r.release_date, 'release_date_precision', r.release_date_precision,
    'components', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('kind', c.kind, 'label', c.label, 'quantity', c.quantity) order by c.kind, c.label)
                            from public.release_components c where c.release_id = r.id), '[]'::jsonb)
  )
  from public.releases r
  join public.games g on g.id = r.game_id
  join public.platforms pl on pl.id = r.platform_id
  join public.region_codes rc on rc.code = r.region_code
  join public.media_formats mf on mf.code = r.media_format_code
  where r.id = p_release
$function$;

-- catalog_release_json (release picker and staff record): includes packaging_code.
CREATE OR REPLACE FUNCTION private.catalog_release_json(p_release releases)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select pg_catalog.jsonb_build_object(
    'id', p_release.id,
    'platform', (select pg_catalog.jsonb_build_object('slug', p.slug, 'name', p.name, 'short_name', p.short_name)
                 from public.platforms p where p.id = p_release.platform_id),
    'region', (select pg_catalog.jsonb_build_object('code', rc.code, 'label', rc.label)
               from public.region_codes rc where rc.code = p_release.region_code),
    'markets', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('code', m.code, 'name', m.name) order by m.name), '[]')
                from public.release_markets rm join public.markets m on m.code = rm.market_code where rm.release_id = p_release.id),
    'edition', case when p_release.edition_name is null and p_release.edition_kind is null then null
                    else pg_catalog.jsonb_build_object('name', p_release.edition_name, 'kind', p_release.edition_kind) end,
    'variant_name', p_release.variant_name,
    'local_title', p_release.local_title,
    'publisher_name', p_release.publisher_name,
    'format', (select pg_catalog.jsonb_build_object('code', f.code, 'name', f.name, 'category', f.category)
               from public.media_formats f where f.code = p_release.media_format_code),
    'media_count', p_release.media_count,
    'media_playability', nullif(p_release.media_playability, 'unknown'),
    'packaging', p_release.packaging,
    'packaging_code', p_release.packaging_code,
    'identifiers', pg_catalog.jsonb_build_object('product_code', p_release.product_code, 'barcode', p_release.barcode),
    'languages', pg_catalog.to_jsonb(p_release.languages),
    'rating_labels', pg_catalog.to_jsonb(p_release.rating_labels),
    'release_date', private.catalog_date_json(p_release.release_date, p_release.release_date_precision),
    'components', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                       'kind', c.kind, 'label', c.label, 'quantity', c.quantity,
                       'format', (select f.name from public.media_formats f where f.code = c.media_format_code))
                     order by c.kind, c.label), '[]')
                   from public.release_components c where c.release_id = p_release.id),
    'requirements', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                         'code', h.requirement_code, 'label', hr.label, 'level', h.level, 'note', h.note)
                       order by hr.label), '[]')
                     from public.release_hardware_requirements h join public.hardware_requirements hr on hr.code = h.requirement_code
                     where h.release_id = p_release.id))
$function$;

-- merge_fields: packaging_code is compared and acknowledged like every other field.
CREATE OR REPLACE FUNCTION private.merge_fields(p_release uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select pg_catalog.jsonb_build_object(
    'game', pg_catalog.jsonb_build_object('id', g.id, 'title', g.title),
    'region_code', r.region_code,
    'region_unknown_confirmed', r.region_unknown_confirmed,
    'edition_name', r.edition_name,
    'edition_kind', r.edition_kind,
    'variant_name', r.variant_name,
    'product_code', r.product_code,
    'barcode', r.barcode,
    'local_title', r.local_title,
    'publisher_name', r.publisher_name,
    'media_count', r.media_count,
    'media_playability', r.media_playability,
    'packaging', r.packaging,
    'packaging_code', r.packaging_code,
    'languages', r.languages,
    'rating_labels', r.rating_labels,
    'release_date', r.release_date,
    'release_date_precision', r.release_date_precision,
    'components', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'kind', c.kind, 'label', c.label, 'quantity', c.quantity, 'media_format_code', c.media_format_code)
        order by c.kind, c.label), '[]') from public.release_components c where c.release_id = r.id),
    'markets', (select coalesce(pg_catalog.jsonb_agg(m.market_code order by m.market_code), '[]')
                from public.release_markets m where m.release_id = r.id),
    'hardware', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('code', h.requirement_code, 'level', h.level)
                 order by h.requirement_code), '[]') from public.release_hardware_requirements h where h.release_id = r.id))
  from public.releases r
  join public.games g on g.id = r.game_id
  where r.id = p_release
$function$;

-- get_my_collection_item: includes packaging_code.
CREATE OR REPLACE FUNCTION public.get_my_collection_item(p_item uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
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
      'media_count', r.media_count, 'packaging', r.packaging, 'packaging_code', r.packaging_code,
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
$function$;

-- get_my_preserved_release: includes packaging_code.
CREATE OR REPLACE FUNCTION public.get_my_preserved_release(p_item uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select pg_catalog.jsonb_build_object(
    'release', pg_catalog.jsonb_build_object(
      'id', (x.release).id,
      'platform', pg_catalog.jsonb_build_object('slug', pl.slug, 'name', pl.name, 'short_name', pl.short_name),
      'region', pg_catalog.jsonb_build_object('code', (x.release).region_code, 'label', rc.label),
      'edition_name', (x.release).edition_name, 'variant_name', (x.release).variant_name, 'local_title', (x.release).local_title,
      'format', pg_catalog.jsonb_build_object('code', (x.release).media_format_code, 'name', mf.name),
      'media_count', (x.release).media_count, 'packaging', (x.release).packaging, 'packaging_code', (x.release).packaging_code,
      'identifiers', pg_catalog.jsonb_build_object('product_code', (x.release).product_code, 'barcode', (x.release).barcode)),
    -- The slug only while the game is in the catalog, for choosing another release of it.
    'game', pg_catalog.jsonb_build_object('title', (x.game).title,
      'slug', case when (x.game).status = 'published' then (x.game).slug end),
    'components', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('kind', k.kind, 'label', k.label, 'quantity', k.quantity) order by k.kind, k.label)
      from public.release_components k where k.release_id = (x.release).id), '[]'),
    'exclusion', (
      select pg_catalog.jsonb_build_object('reason_code', e.reason_code, 'note', e.owner_note, 'excluded_at', e.excluded_at)
      from private.catalog_exclusions e where e.release_id = (x.release).id and e.restored_at is null))
  from private.my_preserved_releases(array[p_item]) x
  join public.platforms pl on pl.id = (x.release).platform_id
  left join public.region_codes rc on rc.code = (x.release).region_code
  left join public.media_formats mf on mf.code = (x.release).media_format_code
$function$;

-- get_submission_review: includes packaging_code.
CREATE OR REPLACE FUNCTION public.get_submission_review(p_request uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_me uuid := private.require_active_staff('catalog_editor');
  v_req public.catalog_change_requests;
  v_rel public.releases;
  v_game public.games;
  v_history jsonb;
  v_duplicates jsonb;
  v_similar jsonb;
begin
  select * into v_req from public.catalog_change_requests s
  where s.id = p_request and s.request_type in ('new_game', 'new_release');
  if not found then
    return null;
  end if;
  select * into v_rel from public.releases r where r.id = v_req.release_id;
  select * into v_game from public.games g where g.id = coalesce(v_rel.game_id, v_req.game_id);

  -- Every request on the same records: earlier and later rounds.
  with recursive back as (
    select s.id, s.previous_request_id from public.catalog_change_requests s where s.id = v_req.id
    union all
    select s.id, s.previous_request_id from public.catalog_change_requests s join back b on s.id = b.previous_request_id
  ), fwd as (
    select s.id from public.catalog_change_requests s where s.id = v_req.id
    union all
    select s.id from public.catalog_change_requests s join fwd f on s.previous_request_id = f.id
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'id', s.id, 'status', s.status, 'created_at', s.created_at, 'reviewed_at', s.reviewed_at,
           'reviewer_note', s.reviewer_note,
           'reviewer', (select pr.handle from public.profiles pr where pr.id = s.reviewed_by)
         ) order by s.id), '[]'::jsonb)
  into v_history
  from public.catalog_change_requests s
  where s.id in (select id from back union select id from fwd);

  -- Releases that may be the same physical product: on the same game and platform, or
  -- with the same product code or barcode anywhere.
  select coalesce(pg_catalog.jsonb_agg(d order by d ->> 'status', d ->> 'id'), '[]'::jsonb) into v_duplicates
  from (
    select pg_catalog.jsonb_build_object(
      'id', r.id, 'status', r.status, 'game_title', g.title, 'game_slug', case when g.status = 'published' then g.slug end,
      'platform', pl.short_name, 'region', r.region_code, 'format', r.media_format_code,
      'edition_name', r.edition_name, 'variant_name', r.variant_name, 'product_code', r.product_code, 'barcode', r.barcode,
      'same_product_code', r.product_code is not null and r.product_code = v_rel.product_code,
      'same_barcode', r.barcode is not null and r.barcode = v_rel.barcode,
      'request_id', (select a.id from public.catalog_change_requests a where a.release_id = r.id
                     and a.status in ('open', 'in_review', 'changes_requested'))
    ) d
    from public.releases r
    join public.games g on g.id = r.game_id
    join public.platforms pl on pl.id = r.platform_id
    where r.id <> v_rel.id and r.status not in ('merged')
      and ((r.game_id = v_rel.game_id and r.platform_id = v_rel.platform_id)
           or (v_rel.product_code is not null and r.product_code = v_rel.product_code)
           or (v_rel.barcode is not null and r.barcode = v_rel.barcode))
    limit 25
  ) x;

  -- For a new game, games with the same or a similar title.
  if v_req.created_game and v_game.id is not null then
    select coalesce(pg_catalog.jsonb_agg(d order by (d ->> 'similarity')::numeric desc), '[]'::jsonb) into v_similar
    from (
      select pg_catalog.jsonb_build_object('id', g.id, 'title', g.title, 'status', g.status,
               'slug', case when g.status = 'published' then g.slug end,
               'similarity', round(extensions.similarity(g.search_key, v_game.search_key)::numeric, 2)) d
      from public.games g
      where g.id <> v_game.id and g.status not in ('merged')
        and (g.search_compact = v_game.search_compact or extensions.similarity(g.search_key, v_game.search_key) >= 0.5)
      order by extensions.similarity(g.search_key, v_game.search_key) desc
      limit 10
    ) x;
  end if;

  return pg_catalog.jsonb_build_object(
    'request', pg_catalog.jsonb_build_object(
      'id', v_req.id, 'kind', v_req.request_type, 'status', v_req.status, 'version', v_req.version,
      'created_at', v_req.created_at, 'updated_at', v_req.updated_at, 'note', v_req.reason,
      'reviewer_note', v_req.reviewer_note, 'reviewed_at', v_req.reviewed_at,
      'reviewer', (select pr.handle from public.profiles pr where pr.id = v_req.reviewed_by),
      'created_game', v_req.created_game, 'details', v_req.details, 'previous_request_id', v_req.previous_request_id,
      'own', v_req.submitted_by is not distinct from v_me),
    'submitter', private.review_submitter(v_req.submitted_by),
    'release', case when v_rel.id is null then null else pg_catalog.jsonb_build_object(
      'id', v_rel.id, 'status', v_rel.status, 'revision', v_rel.revision, 'verified', v_rel.verified_at is not null,
      'platform', (select pg_catalog.jsonb_build_object('id', pl.id, 'slug', pl.slug, 'name', pl.name, 'short_name', pl.short_name)
                   from public.platforms pl where pl.id = v_rel.platform_id),
      'region_code', v_rel.region_code, 'region_unknown_confirmed', v_rel.region_unknown_confirmed,
      'media_format_code', v_rel.media_format_code, 'media_count', v_rel.media_count,
      'edition_name', v_rel.edition_name, 'edition_kind', v_rel.edition_kind, 'variant_name', v_rel.variant_name,
      'product_code', v_rel.product_code, 'barcode', v_rel.barcode, 'local_title', v_rel.local_title,
      'publisher_name', v_rel.publisher_name, 'packaging', v_rel.packaging, 'packaging_code', v_rel.packaging_code,
      'release_date', v_rel.release_date, 'release_date_precision', v_rel.release_date_precision,
      'components', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('kind', c.kind, 'label', c.label, 'quantity', c.quantity)
                                order by c.kind, c.label)
                              from public.release_components c where c.release_id = v_rel.id), '[]'::jsonb),
      'pairing_status', (select gp.status from public.game_platforms gp where gp.game_id = v_rel.game_id and gp.platform_id = v_rel.platform_id)
    ) end,
    'game', case when v_game.id is null then null else pg_catalog.jsonb_build_object(
      'id', v_game.id, 'title', v_game.title, 'kind', v_game.kind, 'status', v_game.status, 'revision', v_game.revision,
      'verified', v_game.verified_at is not null, 'slug', case when v_game.status = 'published' then v_game.slug end,
      'first_release_year', case when v_game.first_release_precision = 'unknown' then null
                                 else pg_catalog.date_part('year', v_game.first_release_date)::int end
    ) end,
    'history', v_history,
    'duplicates', v_duplicates,
    'similar_games', coalesce(v_similar, '[]'::jsonb)
  );
end;
$function$;

-- lockable_field: packaging_code can be locked against imports.
CREATE OR REPLACE FUNCTION private.lockable_field(p_entity text, p_field text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select case p_entity
    when 'game' then p_field = any (array['first_release_date', 'first_release_precision', 'kind', 'sort_title', 'summary', 'title'])
    when 'release' then p_field = any (array[
      'barcode', 'components', 'edition_kind', 'edition_name', 'languages', 'local_title', 'markets', 'media_count',
      'media_format_code', 'media_playability', 'packaging', 'packaging_code', 'product_code', 'publisher_name', 'rating_labels',
      'region_code', 'release_date', 'release_date_precision', 'requirements', 'variant_name'])
    else false
  end
$function$;

-- release_identity_fields: changing packaging_code ends an unpublished release's verification.
CREATE OR REPLACE FUNCTION private.release_identity_fields()
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select array['barcode', 'components', 'edition_kind', 'edition_name', 'media_count', 'media_format_code',
               'packaging', 'packaging_code', 'product_code', 'region_code', 'region_unknown_confirmed', 'variant_name']
$function$;
