-- M5a Catalog: catalog editor operations.
--
-- Design: docs/architecture/security-rls.md#catalog-editing
-- Clients can't write the catalog tables. Active catalog editors and administrators
-- change them only through these functions, and every change records an audit row
-- in the same transaction.
--
-- Locking. Each function first takes the staff-changes lock in shared mode, then
-- checks the caller. Staff-role and account-status changes take the same lock
-- exclusively (M4a). So editors don't wait for each other, but a revocation or
-- suspension and an edit can't overlap: whichever commits first is seen by the other,
-- and an edit after a revocation is refused. The caller's profile is then locked for
-- key share, before any catalog row, so a concurrent deletion of that account can't
-- deadlock with the edit (the M4b lesson). Rows are locked game first, then release,
-- then platform pairing.
--
-- Verification and publication are separate steps (M5 decision 1). Verification
-- attests a record's identity, so editing an identity field of an unpublished record
-- clears it, and editing a descriptive field doesn't. Editing a published record is a
-- correction and keeps it published: M5 has no unpublishing. Nothing here publishes
-- an imported record without an editor's call.
--
-- Every call needs the editor's own reason, which the audit row keeps (the M4 audit
-- contract). Nothing supplies one on the editor's behalf.

-- ---------------------------------------------------------------------------
-- 1. Helpers. None is reachable from the API.
-- ---------------------------------------------------------------------------

create function private.lock_catalog_edits()
returns void
language plpgsql
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended('staff-changes', 0));
end;
$$;

-- Lock, then check, each in its own statement, so the check sees every staff change
-- committed before the lock was granted.
create function private.begin_catalog_edit()
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_me uuid;
begin
  perform private.lock_catalog_edits();
  v_me := private.require_active_staff('catalog_editor');
  perform 1 from public.profiles p where p.id = v_me for key share;
  return v_me;
end;
$$;

create function private.record_catalog_audit(
  p_actor uuid,
  p_action private.audit_action,
  p_entity text,
  p_id uuid,
  p_reason text,
  p_details jsonb default '{}'
)
returns void
language plpgsql
set search_path = ''
as $$
begin
  perform private.record_audit(
    p_actor, p_action, null,
    p_reason,
    pg_catalog.jsonb_build_object('entity', p_entity, 'id', p_id) || coalesce(p_details, '{}')
  );
end;
$$;

-- The keys of a change set, which must all be allowed.
create function private.change_keys(p_changes jsonb, p_allowed text[])
returns text[]
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_keys text[];
begin
  if p_changes is null or pg_catalog.jsonb_typeof(p_changes) <> 'object' or pg_catalog.pg_column_size(p_changes) > 16384 then
    raise exception 'invalid changes' using errcode = '22023';
  end if;
  select coalesce(pg_catalog.array_agg(k order by k), '{}') into v_keys from pg_catalog.jsonb_object_keys(p_changes) k;
  if not v_keys operator(pg_catalog.<@) p_allowed then
    raise exception 'invalid changes' using errcode = '22023';
  end if;
  return v_keys;
end;
$$;

-- Lowercase ASCII words joined by hyphens, or null if nothing is left.
create function private.slugify(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(pg_catalog.btrim(pg_catalog.left(pg_catalog.btrim(pg_catalog.regexp_replace(
    pg_catalog.translate(pg_catalog.lower(p_text), 'àáâãäåāçćčèéêëēěìíîïīñńòóôõöøōùúûüūýÿžšß', 'aaaaaaaccceeeeeeiiiiinnooooooouuuuuyyzss'),
    '[^a-z0-9]+', '-', 'g'), '-'), 100), '-'), '')
$$;

-- A free slug for a game being published, from its title. A lock per base name makes
-- two publications with the same title pick different slugs.
create function private.assign_game_slug(p_title text)
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_base text := coalesce(private.slugify(p_title), 'game');
  v_slug text;
  v_n integer := 1;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('game-slug:' || v_base, 0));
  loop
    v_slug := case when v_n = 1 then v_base else v_base || '-' || v_n end;
    exit when not exists (select 1 from public.games g where g.slug = v_slug);
    v_n := v_n + 1;
  end loop;
  return v_slug;
end;
$$;

-- Locks a release for an edit and returns its status. Merged and excluded records
-- can't be edited. The reason is checked again, in case a caller skipped it.
create function private.lock_release_for_edit(p_release uuid, p_reason text)
returns public.catalog_status
language plpgsql
set search_path = ''
as $$
declare
  v_status public.catalog_status;
begin
  select r.status into v_status from public.releases r where r.id = p_release for update;
  if not found or v_status in ('merged', 'excluded') then
    raise exception 'record unavailable' using errcode = 'P0001';
  end if;
  if v_status = 'published' and p_reason is null then
    raise exception 'reason required' using errcode = '22023';
  end if;
  return v_status;
end;
$$;

-- The fields that identify a physical release, which verification attests: the
-- published identity, what verify_release requires, and the medium. Titles,
-- publisher, dates, languages, ratings, playability, markets and hardware
-- requirements describe it, and editing them keeps a verification.
create function private.release_identity_fields()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['barcode', 'components', 'edition_kind', 'edition_name', 'media_count', 'media_format_code',
               'packaging', 'product_code', 'region_code', 'region_unknown_confirmed', 'variant_name']
$$;

-- An identity field of an unpublished release has changed, so it must be verified again.
create function private.clear_release_verification(p_release uuid)
returns boolean
language plpgsql
set search_path = ''
as $$
begin
  update public.releases r set verified_at = null, verified_by = null
  where r.id = p_release and r.status <> 'published' and r.verified_at is not null;
  return found;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Games
-- ---------------------------------------------------------------------------

create function public.create_game(
  p_title text,
  p_kind public.game_kind,
  p_sort_title text default null,
  p_summary text default null,
  p_first_release_date date default null,
  p_first_release_precision public.date_precision default 'unknown',
  p_reason text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_reason text;
  v_id uuid;
begin
  v_me := private.begin_catalog_edit();
  v_reason := private.require_reason(p_reason);
  if p_kind is null then
    raise exception 'invalid changes' using errcode = '22023';
  end if;
  insert into public.games (title, sort_title, kind, summary, first_release_date, first_release_precision, status)
  values (p_title, coalesce(p_sort_title, p_title), p_kind, p_summary, p_first_release_date, coalesce(p_first_release_precision, 'unknown'), 'under_review')
  returning id into v_id;
  perform private.record_catalog_audit(v_me, 'catalog_record_created', 'game', v_id, v_reason);
  return v_id;
end;
$$;

create function public.update_game(p_game uuid, p_changes jsonb, p_reason text default null)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_reason text;
  v_keys text[];
  v_old public.games;
  v_new public.games;
  v_changed text[];
  v_clear boolean;
begin
  v_me := private.begin_catalog_edit();
  v_reason := private.require_reason(p_reason);
  v_keys := private.change_keys(p_changes, array['first_release_date', 'first_release_precision', 'kind', 'sort_title', 'summary', 'title']);

  select * into v_old from public.games g where g.id = p_game for update;
  if not found or v_old.status in ('merged', 'excluded') then
    raise exception 'record unavailable' using errcode = 'P0001';
  end if;
  if v_old.status = 'published' and v_reason is null then
    raise exception 'reason required' using errcode = '22023';
  end if;

  v_new := pg_catalog.jsonb_populate_record(v_old, p_changes);
  select coalesce(pg_catalog.array_agg(k order by k), '{}') into v_changed
  from unnest(v_keys) k
  where pg_catalog.to_jsonb(v_old) -> k is distinct from pg_catalog.to_jsonb(v_new) -> k;
  if cardinality(v_changed) = 0 then
    return false;
  end if;

  -- A game's identity is its title, kind and first release. Sort title and summary
  -- describe it.
  v_clear := v_old.status <> 'published' and v_old.verified_at is not null
    and v_changed operator(pg_catalog.&&) array['first_release_date', 'first_release_precision', 'kind', 'title'];

  if v_new.kind <> 'compilation' and exists (
    select 1 from public.game_relations gr where gr.source_game_id = p_game and gr.relation = 'contains'
  ) then
    raise exception 'a game that contains others must stay a compilation' using errcode = 'check_violation';
  end if;

  update public.games g set
    title = v_new.title,
    sort_title = v_new.sort_title,
    kind = v_new.kind,
    summary = v_new.summary,
    first_release_date = v_new.first_release_date,
    first_release_precision = v_new.first_release_precision,
    verified_at = case when v_clear then null else g.verified_at end,
    verified_by = case when v_clear then null else g.verified_by end
  where g.id = p_game;

  perform private.record_catalog_audit(v_me, 'catalog_record_updated', 'game', p_game, v_reason,
    pg_catalog.jsonb_build_object('fields', v_changed, 'verification_cleared', v_clear));
  return true;
end;
$$;

create function public.verify_game(p_game uuid, p_reason text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_reason text;
  v_game public.games;
begin
  v_me := private.begin_catalog_edit();
  v_reason := private.require_reason(p_reason);
  select * into v_game from public.games g where g.id = p_game for update;
  if not found or v_game.status not in ('unverified', 'under_review', 'published') then
    raise exception 'record unavailable' using errcode = 'P0001';
  end if;
  if v_game.verified_at is not null then
    return false;
  end if;
  update public.games g set verified_at = pg_catalog.now(), verified_by = v_me where g.id = p_game;
  perform private.record_catalog_audit(v_me, 'catalog_record_verified', 'game', p_game, v_reason);
  return true;
end;
$$;

-- Records that a game has, or may have, a physical release on a platform. The
-- pairing stays unpublished until a release on it is published.
create function public.set_game_platform(p_game uuid, p_platform uuid, p_reason text default null)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_reason text;
begin
  v_me := private.begin_catalog_edit();
  v_reason := private.require_reason(p_reason);
  perform 1 from public.games g where g.id = p_game and g.status not in ('merged', 'excluded') for share;
  if not found or not exists (select 1 from public.platforms p where p.id = p_platform) then
    raise exception 'record unavailable' using errcode = 'P0001';
  end if;
  insert into public.game_platforms (game_id, platform_id, status)
  values (p_game, p_platform, 'under_review')
  on conflict (game_id, platform_id) do nothing;
  if not found then
    return false;
  end if;
  perform private.record_catalog_audit(v_me, 'catalog_record_created', 'game_platform', p_game, v_reason,
    pg_catalog.jsonb_build_object('platform_id', p_platform));
  return true;
end;
$$;

-- Classifies two games (ADR-026). Always a deliberate editor decision, with a reason.
create function public.set_game_relation(
  p_source uuid,
  p_target uuid,
  p_relation public.game_relation_type,
  p_position smallint default null,
  p_note text default null,
  p_reason text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_reason text;
begin
  v_me := private.begin_catalog_edit();
  v_reason := private.require_reason(p_reason);
  if p_relation is null then
    raise exception 'invalid changes' using errcode = '22023';
  end if;
  if (select count(*) from public.games g where g.id in (p_source, p_target) and g.status not in ('merged', 'excluded')) <> 2 then
    raise exception 'record unavailable' using errcode = 'P0001';
  end if;
  perform 1 from public.games g where g.id in (p_source, p_target) order by g.id for share;
  insert into public.game_relations (source_game_id, target_game_id, relation, position, note)
  values (p_source, p_target, p_relation, p_position, p_note)
  on conflict (source_game_id, target_game_id, relation) do update
    set position = excluded.position, note = excluded.note
    where (public.game_relations.position, public.game_relations.note) is distinct from (excluded.position, excluded.note);
  if not found then
    return false;
  end if;
  perform private.record_catalog_audit(v_me, 'catalog_record_updated', 'game_relation', p_source, v_reason,
    pg_catalog.jsonb_build_object('target_id', p_target, 'relation', p_relation));
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Releases
-- ---------------------------------------------------------------------------

-- Creates a release candidate under review. Only what the editor provides is stored:
-- the region is 'unknown' unless given, and the edition stays empty until set.
create function public.create_release(
  p_game uuid,
  p_platform uuid,
  p_media_format_code text,
  p_region_code text default 'unknown',
  p_details jsonb default '{}',
  p_reason text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
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
    'product_code', 'publisher_name', 'rating_labels', 'region_unknown_confirmed', 'release_date', 'release_date_precision', 'variant_name'
  ]);

  perform 1 from public.games g where g.id = p_game and g.status not in ('merged', 'excluded') for share;
  if not found or not exists (select 1 from public.platforms p where p.id = p_platform) then
    raise exception 'record unavailable' using errcode = 'P0001';
  end if;

  insert into public.game_platforms (game_id, platform_id, status)
  values (p_game, p_platform, 'under_review')
  on conflict (game_id, platform_id) do nothing;

  v_row := pg_catalog.jsonb_populate_record(null::public.releases, coalesce(p_details, '{}'));
  insert into public.releases (
    game_id, platform_id, region_code, region_unknown_confirmed, edition_name, edition_kind, variant_name, product_code,
    barcode, local_title, publisher_name, media_format_code, media_count, media_playability, packaging, languages,
    rating_labels, release_date, release_date_precision, status
  ) values (
    p_game, p_platform, coalesce(p_region_code, 'unknown'), coalesce(v_row.region_unknown_confirmed, false), v_row.edition_name,
    v_row.edition_kind, v_row.variant_name, v_row.product_code, v_row.barcode, v_row.local_title, v_row.publisher_name,
    p_media_format_code, v_row.media_count, coalesce(v_row.media_playability, 'unknown'), v_row.packaging, v_row.languages,
    v_row.rating_labels, v_row.release_date, coalesce(v_row.release_date_precision, 'unknown'), 'under_review'
  )
  returning id into v_id;

  perform private.record_catalog_audit(v_me, 'catalog_record_created', 'release', v_id, v_reason,
    pg_catalog.jsonb_build_object('game_id', p_game, 'platform_id', p_platform, 'fields', v_keys));
  return v_id;
end;
$$;

create function public.update_release(p_release uuid, p_changes jsonb, p_reason text default null)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_reason text;
  v_keys text[];
  v_old public.releases;
  v_new public.releases;
  v_changed text[];
  v_cleared boolean;
begin
  v_me := private.begin_catalog_edit();
  v_reason := private.require_reason(p_reason);
  v_keys := private.change_keys(p_changes, array[
    'barcode', 'edition_kind', 'edition_name', 'languages', 'local_title', 'media_count', 'media_format_code', 'media_playability',
    'packaging', 'product_code', 'publisher_name', 'rating_labels', 'region_code', 'region_unknown_confirmed', 'release_date',
    'release_date_precision', 'variant_name'
  ]);
  perform private.lock_release_for_edit(p_release, v_reason);

  select * into v_old from public.releases r where r.id = p_release;
  v_new := pg_catalog.jsonb_populate_record(v_old, p_changes);
  -- Confirming an unknown region applies only while the region is unknown.
  if v_new.region_code <> 'unknown' then
    v_new.region_unknown_confirmed := false;
  end if;
  select coalesce(pg_catalog.array_agg(k order by k), '{}') into v_changed
  from unnest(array['barcode', 'edition_kind', 'edition_name', 'languages', 'local_title', 'media_count', 'media_format_code',
                    'media_playability', 'packaging', 'product_code', 'publisher_name', 'rating_labels', 'region_code',
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
    languages = v_new.languages,
    rating_labels = v_new.rating_labels,
    release_date = v_new.release_date,
    release_date_precision = v_new.release_date_precision
  where r.id = p_release;
  v_cleared := v_changed operator(pg_catalog.&&) private.release_identity_fields()
    and private.clear_release_verification(p_release);

  perform private.record_catalog_audit(v_me, 'catalog_record_updated', 'release', p_release, v_reason,
    pg_catalog.jsonb_build_object('fields', v_changed, 'verification_cleared', v_cleared));
  return true;
end;
$$;

-- Replaces the release's known markets. An empty array means none are known.
create function public.set_release_markets(p_release uuid, p_markets text[], p_reason text default null)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_reason text;
  v_old text[];
  v_new text[];
  v_cleared boolean;
begin
  v_me := private.begin_catalog_edit();
  v_reason := private.require_reason(p_reason);
  if cardinality(p_markets) > 250 or array_position(p_markets, null) is not null then
    raise exception 'invalid changes' using errcode = '22023';
  end if;
  perform private.lock_release_for_edit(p_release, v_reason);

  select coalesce(pg_catalog.array_agg(m.market_code order by m.market_code), '{}') into v_old
  from public.release_markets m where m.release_id = p_release;
  select coalesce(pg_catalog.array_agg(distinct x order by x), '{}') into v_new from unnest(coalesce(p_markets, '{}')) x;
  if v_old = v_new then
    return false;
  end if;

  delete from public.release_markets m where m.release_id = p_release and not (m.market_code = any (v_new));
  insert into public.release_markets (release_id, market_code)
  select p_release, x from unnest(v_new) x
  on conflict (release_id, market_code) do nothing;

  perform private.record_catalog_audit(v_me, 'catalog_record_updated', 'release', p_release, v_reason,
    pg_catalog.jsonb_build_object('fields', array['markets'], 'verification_cleared', false));
  return true;
end;
$$;

-- Replaces the release's components. Each is {kind, label, quantity, and for
-- game_media, media_format_code and platform_id}.
create function public.set_release_components(p_release uuid, p_components jsonb, p_reason text default null)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_reason text;
  v_old jsonb;
  v_new jsonb;
  v_cleared boolean;
begin
  v_me := private.begin_catalog_edit();
  v_reason := private.require_reason(p_reason);
  if p_components is null or pg_catalog.jsonb_typeof(p_components) <> 'array' or pg_catalog.jsonb_array_length(p_components) > 50
     or exists (select 1 from pg_catalog.jsonb_array_elements(p_components) e
                where pg_catalog.jsonb_typeof(e) <> 'object'
                   or not (select coalesce(pg_catalog.array_agg(k), '{}') from pg_catalog.jsonb_object_keys(e) k)
                          operator(pg_catalog.<@) array['kind', 'label', 'media_format_code', 'platform_id', 'quantity']) then
    raise exception 'invalid changes' using errcode = '22023';
  end if;
  perform private.lock_release_for_edit(p_release, v_reason);

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('kind', c.kind, 'label', c.label, 'quantity', c.quantity,
           'media_format_code', c.media_format_code, 'platform_id', c.platform_id) order by c.kind, c.label), '[]')
  into v_old from public.release_components c where c.release_id = p_release;
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('kind', x.kind, 'label', x.label, 'quantity', coalesce(x.quantity, 1),
           'media_format_code', x.media_format_code, 'platform_id', x.platform_id) order by x.kind, x.label), '[]')
  into v_new from pg_catalog.jsonb_to_recordset(p_components) as x(kind public.component_kind, label text, quantity smallint, media_format_code text, platform_id uuid);
  if v_old = v_new then
    return false;
  end if;

  delete from public.release_components c where c.release_id = p_release;
  insert into public.release_components (release_id, kind, label, quantity, media_format_code, platform_id)
  select p_release, x.kind, x.label, coalesce(x.quantity, 1), x.media_format_code, x.platform_id
  from pg_catalog.jsonb_to_recordset(p_components) as x(kind public.component_kind, label text, quantity smallint, media_format_code text, platform_id uuid);
  v_cleared := private.clear_release_verification(p_release);

  perform private.record_catalog_audit(v_me, 'catalog_record_updated', 'release', p_release, v_reason,
    pg_catalog.jsonb_build_object('fields', array['components'], 'verification_cleared', v_cleared));
  return true;
end;
$$;

-- Replaces the release's hardware requirements. Each is {requirement_code, level, note}.
create function public.set_release_requirements(p_release uuid, p_requirements jsonb, p_reason text default null)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_reason text;
  v_old jsonb;
  v_new jsonb;
  v_cleared boolean;
begin
  v_me := private.begin_catalog_edit();
  v_reason := private.require_reason(p_reason);
  if p_requirements is null or pg_catalog.jsonb_typeof(p_requirements) <> 'array' or pg_catalog.jsonb_array_length(p_requirements) > 20
     or exists (select 1 from pg_catalog.jsonb_array_elements(p_requirements) e
                where pg_catalog.jsonb_typeof(e) <> 'object'
                   or not (select coalesce(pg_catalog.array_agg(k), '{}') from pg_catalog.jsonb_object_keys(e) k)
                          operator(pg_catalog.<@) array['level', 'note', 'requirement_code']) then
    raise exception 'invalid changes' using errcode = '22023';
  end if;
  perform private.lock_release_for_edit(p_release, v_reason);

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('requirement_code', h.requirement_code, 'level', h.level, 'note', h.note)
           order by h.requirement_code), '[]')
  into v_old from public.release_hardware_requirements h where h.release_id = p_release;
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('requirement_code', x.requirement_code, 'level', x.level, 'note', x.note)
           order by x.requirement_code), '[]')
  into v_new from pg_catalog.jsonb_to_recordset(p_requirements) as x(requirement_code text, level public.requirement_level, note text);
  if v_old = v_new then
    return false;
  end if;

  delete from public.release_hardware_requirements h where h.release_id = p_release;
  insert into public.release_hardware_requirements (release_id, requirement_code, level, note)
  select p_release, x.requirement_code, x.level, x.note
  from pg_catalog.jsonb_to_recordset(p_requirements) as x(requirement_code text, level public.requirement_level, note text);

  perform private.record_catalog_audit(v_me, 'catalog_record_updated', 'release', p_release, v_reason,
    pg_catalog.jsonb_build_object('fields', array['requirements'], 'verification_cleared', false));
  return true;
end;
$$;

-- Confirms the physical identity of a release. It must be complete enough to publish:
-- an edition and medium count set, and an unknown region explicitly confirmed.
create function public.verify_release(p_release uuid, p_reason text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_reason text;
  v_release public.releases;
begin
  v_me := private.begin_catalog_edit();
  v_reason := private.require_reason(p_reason);
  select * into v_release from public.releases r where r.id = p_release for update;
  if not found or v_release.status not in ('unverified', 'under_review', 'published') then
    raise exception 'record unavailable' using errcode = 'P0001';
  end if;
  if v_release.verified_at is not null then
    return false;
  end if;
  if v_release.edition_name is null or v_release.edition_kind is null or v_release.media_count is null
     or (v_release.region_code = 'unknown' and not v_release.region_unknown_confirmed) then
    raise exception 'release incomplete' using errcode = '22023';
  end if;
  update public.releases r set verified_at = pg_catalog.now(), verified_by = v_me where r.id = p_release;
  perform private.record_catalog_audit(v_me, 'catalog_record_verified', 'release', p_release, v_reason);
  return true;
end;
$$;

-- Publishes a verified release. Its game, if verified and not yet public, and its
-- platform pairing are published in the same transaction (M5 decision 5). The
-- publication rules are checked again at commit.
create function public.publish_release(p_release uuid, p_reason text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_reason text;
  v_game_id uuid;
  v_game public.games;
  v_release public.releases;
  v_pairing public.catalog_status;
  v_slug text;
begin
  v_me := private.begin_catalog_edit();
  v_reason := private.require_reason(p_reason);

  select r.game_id into v_game_id from public.releases r where r.id = p_release;
  if not found then
    raise exception 'record unavailable' using errcode = 'P0001';
  end if;
  select * into v_game from public.games g where g.id = v_game_id for update;
  select * into v_release from public.releases r where r.id = p_release for update;
  if v_release.status = 'published' then
    return false;
  end if;
  if v_release.status not in ('unverified', 'under_review') then
    raise exception 'record unavailable' using errcode = 'P0001';
  end if;
  if v_release.verified_at is null then
    raise exception 'release not verified' using errcode = 'P0001';
  end if;

  select gp.status into v_pairing from public.game_platforms gp
  where gp.game_id = v_release.game_id and gp.platform_id = v_release.platform_id for update;
  if v_pairing not in ('unverified', 'under_review', 'published') then
    raise exception 'record unavailable' using errcode = 'P0001';
  end if;

  if v_game.status <> 'published' then
    if v_game.status not in ('unverified', 'under_review') then
      raise exception 'record unavailable' using errcode = 'P0001';
    end if;
    if v_game.verified_at is null then
      raise exception 'game not verified' using errcode = 'P0001';
    end if;
    v_slug := coalesce(v_game.slug, private.assign_game_slug(v_game.title));
    update public.games g set status = 'published', slug = v_slug, submitted_by = null where g.id = v_game.id;
    perform private.record_catalog_audit(v_me, 'catalog_record_published', 'game', v_game.id, v_reason,
      pg_catalog.jsonb_build_object('slug', v_slug, 'with_release_id', p_release));
  end if;

  if v_pairing <> 'published' then
    update public.game_platforms gp set status = 'published', submitted_by = null
    where gp.game_id = v_release.game_id and gp.platform_id = v_release.platform_id;
  end if;
  update public.releases r set status = 'published', submitted_by = null where r.id = p_release;

  perform private.record_catalog_audit(v_me, 'catalog_record_published', 'release', p_release, v_reason,
    pg_catalog.jsonb_build_object('game_id', v_release.game_id, 'platform_id', v_release.platform_id));
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Field locks: fields an import must never overwrite.
-- ---------------------------------------------------------------------------

create function private.lockable_field(p_entity text, p_field text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case p_entity
    when 'game' then p_field = any (array['first_release_date', 'first_release_precision', 'kind', 'sort_title', 'summary', 'title'])
    when 'release' then p_field = any (array[
      'barcode', 'components', 'edition_kind', 'edition_name', 'languages', 'local_title', 'markets', 'media_count',
      'media_format_code', 'media_playability', 'packaging', 'product_code', 'publisher_name', 'rating_labels',
      'region_code', 'release_date', 'release_date_precision', 'requirements', 'variant_name'])
    else false
  end
$$;

create function public.set_catalog_field_lock(p_entity text, p_id uuid, p_field text, p_locked boolean, p_reason text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_reason text;
begin
  v_me := private.begin_catalog_edit();
  v_reason := private.require_reason(p_reason);
  if p_locked is null or not coalesce(private.lockable_field(p_entity, p_field), false) then
    raise exception 'invalid changes' using errcode = '22023';
  end if;
  if p_entity = 'game' then
    perform 1 from public.games g where g.id = p_id for share;
  else
    perform 1 from public.releases r where r.id = p_id for share;
  end if;
  if not found then
    raise exception 'record unavailable' using errcode = 'P0001';
  end if;

  if p_locked then
    insert into private.catalog_field_locks (game_id, release_id, field_name, locked_by)
    values (case when p_entity = 'game' then p_id end, case when p_entity = 'release' then p_id end, p_field, v_me)
    on conflict (game_id, release_id, field_name) do nothing;
  else
    delete from private.catalog_field_locks l
    where l.field_name = p_field
      and l.game_id is not distinct from case when p_entity = 'game' then p_id end
      and l.release_id is not distinct from case when p_entity = 'release' then p_id end;
  end if;
  if not found then
    return false;
  end if;

  perform private.record_catalog_audit(v_me,
    case when p_locked then 'catalog_field_locked'::private.audit_action else 'catalog_field_unlocked'::private.audit_action end,
    p_entity, p_id, v_reason, pg_catalog.jsonb_build_object('field', p_field));
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Access
-- ---------------------------------------------------------------------------

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'private.lock_catalog_edits()',
    'private.begin_catalog_edit()',
    'private.record_catalog_audit(uuid, private.audit_action, text, uuid, text, jsonb)',
    'private.change_keys(jsonb, text[])',
    'private.slugify(text)',
    'private.assign_game_slug(text)',
    'private.lock_release_for_edit(uuid, text)',
    'private.clear_release_verification(uuid)',
    'private.release_identity_fields()',
    'private.lockable_field(text, text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
  end loop;

  foreach v_signature in array array[
    'public.create_game(text, public.game_kind, text, text, date, public.date_precision, text)',
    'public.update_game(uuid, jsonb, text)',
    'public.verify_game(uuid, text)',
    'public.set_game_platform(uuid, uuid, text)',
    'public.set_game_relation(uuid, uuid, public.game_relation_type, smallint, text, text)',
    'public.create_release(uuid, uuid, text, text, jsonb, text)',
    'public.update_release(uuid, jsonb, text)',
    'public.set_release_markets(uuid, text[], text)',
    'public.set_release_components(uuid, jsonb, text)',
    'public.set_release_requirements(uuid, jsonb, text)',
    'public.verify_release(uuid, text)',
    'public.publish_release(uuid, text)',
    'public.set_catalog_field_lock(text, uuid, text, boolean, text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
    execute format('grant execute on function %s to authenticated', v_signature);
  end loop;
end;
$$;
