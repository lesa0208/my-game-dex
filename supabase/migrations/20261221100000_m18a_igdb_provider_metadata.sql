-- M18a: IGDB as an enrichment provider for existing game identities.
--
-- Design (docs/architecture/igdb-enrichment-m18a.md):
--   - IGDB is one more row in private.external_providers, not cleared until an operator records
--     clearance against the saved basis (record_provider_clearance), as for Wikidata.
--   - Its media (covers, screenshots) have a gate of their own: private.record_provider_media.
--     Text metadata can be cleared while media stay off. Clearing media needs the provider cleared.
--   - IGDB records are source claims in private.provider_records, staged by the existing
--     catalog_import.stage_records in an enrichment run (catalog_import.start_enrichment_run: no
--     platform). They are never applied by catalog_import.apply_record, which would match or
--     create games: apply_record now refuses them. An enrichment record can only be attached to an
--     existing, published game identity (catalog_import.attach_game_record), which links the IGDB
--     id in private.external_references beside the game's Wikidata id. One IGDB id per game, one
--     game per IGDB id. A record the matcher can't confirm is staged held (review_reason), and
--     stays unapplied.
--   - Nothing here writes a game's own fields (title, summary, dates), its aliases, platforms,
--     releases, verification or publication. Provider metadata is shown as provider metadata.
--   - public.get_game_provider_metadata(uuid[]) is the only public read: published games, the
--     provider cleared now, the latest attached record for the game's linked IGDB id, media only
--     when media are cleared.
--
-- Grants: the three new catalog_import functions to catalog_importer only; the public read to
-- anon and authenticated; the media gate to no client role or the importer (operators, in SQL).

-- ---------------------------------------------------------------------------
-- 1. The provider and its media gate
-- ---------------------------------------------------------------------------

alter table private.external_providers
  add column media_cleared boolean not null default false,
  add column media_note text check (media_note is null or char_length(media_note) between 1 and 1000),
  add column media_recorded_at timestamptz;

insert into private.external_providers (code, name, terms_url)
values ('igdb', 'IGDB', 'https://api-docs.igdb.com/')
on conflict (code) do nothing;

-- For operators working in SQL, after deciding how a provider's media may be shown. Clearing
-- false withdraws it at once: the public read stops returning the provider's images.
create function private.record_provider_media(p_code text, p_cleared boolean, p_note text)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_note text := private.require_reason(p_note);
  v_provider private.external_providers;
begin
  if p_cleared is null then
    raise exception 'invalid changes' using errcode = '22023';
  end if;
  select * into v_provider from private.external_providers p where p.code = p_code for update;
  if not found then
    raise exception 'record unavailable' using errcode = 'P0001';
  end if;
  if p_cleared and not v_provider.commercial_use_cleared then
    raise exception 'provider not cleared' using errcode = 'P0001';
  end if;
  update private.external_providers p set
    media_cleared = p_cleared,
    media_note = pg_catalog.left(v_note, 1000),
    media_recorded_at = pg_catalog.now()
  where p.code = p_code;
  perform private.record_audit(null, 'catalog_provider_cleared', null, v_note,
    pg_catalog.jsonb_build_object('provider', p_code, 'media_cleared', p_cleared));
end;
$$;

revoke all on function private.record_provider_media(text, boolean, text) from public, anon, authenticated, service_role, catalog_importer;

-- The providers whose records enrich existing identities and are never applied as games.
create function private.is_enrichment_provider(p_code text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_code = 'igdb';
$$;

revoke all on function private.is_enrichment_provider(text) from public, anon, authenticated, service_role, catalog_importer;

-- ---------------------------------------------------------------------------
-- 2. Enrichment runs, for the importer
-- ---------------------------------------------------------------------------

-- A running run needs a platform (M5b), except an enrichment run, which never pairs a platform.
alter table private.import_runs drop constraint import_runs_platform;
alter table private.import_runs add constraint import_runs_platform
  check (platform_id is not null or status <> 'running' or private.is_enrichment_provider(provider_code));

-- start_run with no platform: an enrichment run spans the games it enriches.
create function catalog_import.start_enrichment_run(
  p_provider text,
  p_source_name text,
  p_source_sha256 text,
  p_source_fetched_at timestamptz,
  p_terms_sha256 text,
  p_reason text,
  p_lease uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text := private.require_reason(p_reason);
  v_run private.import_runs;
begin
  if not private.is_enrichment_provider(p_provider) then
    raise exception 'invalid changes' using errcode = '22023';
  end if;
  perform private.import_require_clearance(p_provider, p_terms_sha256);
  if p_lease is null or p_source_sha256 is null or p_source_sha256 !~ '^[0-9a-f]{64}$' or p_source_fetched_at is null then
    raise exception 'invalid changes' using errcode = '22023';
  end if;
  if exists (select 1 from private.import_runs r where r.provider_code = p_provider and r.source_sha256 = p_source_sha256 and r.status = 'running') then
    raise exception 'snapshot already running' using errcode = 'P0001';
  end if;
  insert into private.import_runs (provider_code, platform_id, source_name, source_sha256, source_fetched_at, terms_sha256, reason, lease_id, lease_expires_at)
  values (p_provider, null, p_source_name, p_source_sha256, p_source_fetched_at, p_terms_sha256, v_reason, p_lease, pg_catalog.now() + interval '10 minutes')
  returning * into v_run;
  perform private.import_audit(v_run, 'started', pg_catalog.jsonb_build_object('enrichment', true, 'source_name', p_source_name));
  return v_run.id;
end;
$$;

-- What the matcher compares, for published games chosen by slug: title, aliases, platforms,
-- first release, the Wikidata id and the IGDB ids Wikidata states (P5794), and an IGDB id the
-- game is already linked to. Read-only: it comes before a run, whose snapshot (the provider's
-- answers for these games) is fetched from what it returns. Only published game data, the
-- Wikidata record (CC0) and links; nothing private about anyone.
create function catalog_import.enrichment_candidates(p_provider text, p_slugs text[])
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_enrichment_provider(p_provider) or p_slugs is null or pg_catalog.cardinality(p_slugs) > 200 then
    raise exception 'invalid changes' using errcode = '22023';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', g.id,
      'slug', g.slug,
      'title', g.title,
      'kind', g.kind,
      'first_release_date', g.first_release_date,
      'first_release_precision', g.first_release_precision,
      'platforms', coalesce((select pg_catalog.jsonb_agg(p.slug order by p.slug) from public.game_platforms gp
        join public.platforms p on p.id = gp.platform_id where gp.game_id = g.id), '[]'),
      'aliases', coalesce((select pg_catalog.jsonb_agg(a.title order by a.title) from public.game_aliases a where a.game_id = g.id), '[]'),
      'wikidata', (select x.external_id from private.external_references x
        where x.provider_code = 'wikidata' and x.entity_type = 'game' and x.game_id = g.id order by x.created_at limit 1),
      'wikidata_igdb', coalesce((select pr.payload -> 'source' -> 'external_ids' -> 'igdb' from private.provider_records pr
        where pr.provider_code = 'wikidata' and pr.entity_type = 'game' and pr.matched_game_id = g.id
        order by pr.created_at desc limit 1), '[]'),
      'linked', (select x.external_id from private.external_references x
        where x.provider_code = p_provider and x.entity_type = 'game' and x.game_id = g.id limit 1)
    ) order by g.slug)
    from public.games g
    where g.slug = any(p_slugs) and g.status = 'published' and g.merged_into_id is null
  ), '[]');
end;
$$;

-- Attaches the run's staged record for a provider id (the latest one not held) to an existing
-- published game: links the id beside the game's other ids and marks the record matched, with the
-- matcher's tier and notes. Refuses a held record, a game already linked to another id of this
-- provider, and an id already linked to another game. Writes nothing on the game. Run again
-- (resuming), an attached record is reported as skipped.
create function catalog_import.attach_game_record(
  p_run uuid,
  p_lease uuid,
  p_external_id text,
  p_game uuid,
  p_tier text,
  p_notes jsonb,
  p_checkpoint jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run private.import_runs := private.import_run_for(p_run, p_lease);
  v_record private.provider_records;
  v_status public.catalog_status;
  v_merged uuid;
  v_linked uuid;
begin
  if v_run.platform_id is not null or not private.is_enrichment_provider(v_run.provider_code)
     or p_tier is null or p_tier not in ('A', 'B')
     or p_notes is null or pg_catalog.jsonb_typeof(p_notes) <> 'object' or pg_catalog.pg_column_size(p_notes) > 8192
     or (p_checkpoint is not null and (pg_catalog.jsonb_typeof(p_checkpoint) <> 'object' or pg_catalog.pg_column_size(p_checkpoint) > 4096)) then
    raise exception 'invalid changes' using errcode = '22023';
  end if;
  select pr.* into v_record from private.provider_records pr
  join private.import_run_records x on x.provider_record_id = pr.id and x.import_run_id = p_run
  where pr.provider_code = v_run.provider_code and pr.entity_type = 'game' and pr.external_id = p_external_id
    and pr.review_reason is null
  order by (pr.status = 'fetched') desc, pr.created_at desc
  limit 1
  for update of pr;
  if not found then
    raise exception 'record unavailable' using errcode = 'P0001';
  end if;
  if v_record.status <> 'fetched' then
    return pg_catalog.jsonb_build_object('outcome', 'skipped', 'status', v_record.status, 'game_id', v_record.matched_game_id);
  end if;
  if v_record.payload ->> 'id' is distinct from v_record.external_id then
    raise exception 'invalid source entry' using errcode = '22023';
  end if;
  select g.status, g.merged_into_id into v_status, v_merged from public.games g where g.id = p_game for update;
  if not found or v_status <> 'published' or v_merged is not null then
    raise exception 'game unavailable' using errcode = 'P0001';
  end if;
  perform private.import_lock_source_id(v_record.provider_code, 'game', v_record.external_id);
  select x.game_id into v_linked from private.external_references x
  where x.provider_code = v_record.provider_code and x.entity_type = 'game' and x.external_id = v_record.external_id;
  if found and v_linked <> p_game then
    raise exception 'identity conflict: the id is linked to another game' using errcode = 'P0001';
  end if;
  if exists (select 1 from private.external_references x where x.provider_code = v_record.provider_code and x.entity_type = 'game'
             and x.game_id = p_game and x.external_id <> v_record.external_id) then
    raise exception 'identity conflict: the game is linked to another id' using errcode = 'P0001';
  end if;
  insert into private.external_references (provider_code, external_id, game_id)
  values (v_record.provider_code, v_record.external_id, p_game)
  on conflict (provider_code, entity_type, external_id) do nothing;
  update private.provider_records pr set status = 'matched', matched_game_id = p_game, match_tier = p_tier, match_notes = p_notes
  where pr.id = v_record.id;
  if p_checkpoint is not null then
    update private.import_runs r set checkpoint = p_checkpoint where r.id = p_run;
  end if;
  perform private.import_audit(v_run, 'attached', pg_catalog.jsonb_build_object('game_id', p_game, 'external_id', v_record.external_id, 'tier', p_tier));
  return pg_catalog.jsonb_build_object('outcome', 'attached', 'game_id', p_game);
end;
$$;

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'catalog_import.start_enrichment_run(text, text, text, timestamptz, text, text, uuid)',
    'catalog_import.enrichment_candidates(text, text[])',
    'catalog_import.attach_game_record(uuid, uuid, text, uuid, text, jsonb, jsonb)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
    execute format('grant execute on function %s to catalog_importer', v_signature);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. apply_record never applies an enrichment record
-- ---------------------------------------------------------------------------

-- Its current definition (20261220100000), with one refusal first: an enrichment provider's
-- record would otherwise go to import_apply_game, which matches by title or creates a game.
create or replace function catalog_import.apply_record(p_run uuid, p_lease uuid, p_record uuid, p_checkpoint jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run private.import_runs := private.import_run_for(p_run, p_lease);
  v_record private.provider_records;
  v_result jsonb;
begin
  if private.is_enrichment_provider(v_run.provider_code) then
    raise exception 'enrichment records are attached, never applied' using errcode = 'P0001';
  end if;
  if p_checkpoint is not null and (pg_catalog.jsonb_typeof(p_checkpoint) <> 'object' or pg_catalog.pg_column_size(p_checkpoint) > 4096) then
    raise exception 'invalid changes' using errcode = '22023';
  end if;
  select pr.* into v_record from private.provider_records pr
  join private.import_run_records x on x.provider_record_id = pr.id and x.import_run_id = p_run
  where pr.id = p_record for update of pr;
  if not found then
    raise exception 'record unavailable' using errcode = 'P0001';
  end if;
  if v_record.entity_type = 'release' and (v_record.review_reason is not null or v_record.status = 'ignored')
     and exists (select 1 from private.external_references r
                 where r.provider_code = v_record.provider_code and r.entity_type = 'release' and r.external_id = v_record.external_id) then
    -- The source now says an existing candidate isn't a release to import.
    v_result := private.import_reclassify(v_run, v_record);
  elsif v_record.review_reason is not null then
    -- Held for an editor, such as a Nintendo Power flash release: never applied.
    v_result := pg_catalog.jsonb_build_object('outcome', 'held', 'reason', v_record.review_reason);
  elsif v_record.entity_type = 'game' and v_record.status in ('promoted', 'matched') then
    -- M16: an unchanged game record seen by another platform's run: that platform's pairing only.
    v_result := private.import_pair_unchanged(v_run, v_record);
  elsif v_record.status not in ('fetched', 'needs_review') then
    v_result := pg_catalog.jsonb_build_object('outcome', 'skipped', 'status', v_record.status);
  elsif v_record.entity_type = 'game' then
    v_result := private.import_apply_game(v_run, v_record);
  else
    v_result := private.import_apply_release(v_run, v_record);
  end if;
  if p_checkpoint is not null then
    update private.import_runs r set checkpoint = p_checkpoint where r.id = p_run;
  end if;
  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. The public read
-- ---------------------------------------------------------------------------

create function private.provider_text_list(p_value jsonb, p_limit integer)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select case when pg_catalog.jsonb_typeof(p_value) = 'array' then coalesce((
    select pg_catalog.array_agg(pg_catalog.left(e.v, 120) order by e.o)
    from pg_catalog.jsonb_array_elements_text(p_value) with ordinality e(v, o)
    where e.o <= p_limit and pg_catalog.btrim(e.v) <> ''), '{}') else '{}' end;
$$;

-- An image as the provider identifies it: an id that builds its URL, and its size. Anything else is dropped.
create function private.provider_image(p_value jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case when pg_catalog.jsonb_typeof(p_value) = 'object' and (p_value ->> 'image_id') ~ '^[a-z0-9]{1,40}$'
    then pg_catalog.jsonb_build_object('image_id', p_value ->> 'image_id',
      'width', case when (p_value ->> 'width') ~ '^[0-9]{1,5}$' then (p_value ->> 'width')::integer end,
      'height', case when (p_value ->> 'height') ~ '^[0-9]{1,5}$' then (p_value ->> 'height')::integer end) end;
$$;

revoke all on function private.provider_text_list(jsonb, integer), private.provider_image(jsonb) from public, anon, authenticated, service_role, catalog_importer;

-- Provider metadata for published games, labelled with its provider: never the catalog's own facts.
create function public.get_game_provider_metadata(p_games uuid[])
returns table (
  game_id uuid,
  provider text,
  provider_name text,
  external_id text,
  slug text,
  url text,
  name text,
  summary text,
  genres text[],
  themes text[],
  developers text[],
  publishers text[],
  first_release_date text,
  platforms text[],
  cover jsonb,
  screenshots jsonb,
  fetched_at text,
  attached_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select g.id, p.code, p.name, x.external_id,
    pg_catalog.left(r.payload ->> 'slug', 200),
    case when (r.payload ->> 'url') ~ '^https://www\.igdb\.com/games/[a-z0-9-]{1,200}$' then r.payload ->> 'url' end,
    pg_catalog.left(r.payload ->> 'name', 300),
    pg_catalog.left(r.payload ->> 'summary', 4000),
    private.provider_text_list(r.payload -> 'genres', 12),
    private.provider_text_list(r.payload -> 'themes', 12),
    private.provider_text_list(r.payload -> 'developers', 8),
    private.provider_text_list(r.payload -> 'publishers', 8),
    case when (r.payload ->> 'first_release_date') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then r.payload ->> 'first_release_date' end,
    private.provider_text_list(r.payload -> 'platforms', 30),
    case when p.media_cleared then private.provider_image(r.payload -> 'cover') end,
    case when p.media_cleared and pg_catalog.jsonb_typeof(r.payload -> 'screenshots') = 'array' then coalesce((
      select pg_catalog.jsonb_agg(private.provider_image(s.v) order by s.o)
      from pg_catalog.jsonb_array_elements(r.payload -> 'screenshots') with ordinality s(v, o)
      where s.o <= 8 and private.provider_image(s.v) is not null), '[]') else '[]' end,
    pg_catalog.left(r.payload ->> 'fetched_at', 40),
    r.updated_at
  from public.games g
  join private.external_references x on x.game_id = g.id and x.entity_type = 'game' and private.is_enrichment_provider(x.provider_code)
  join private.external_providers p on p.code = x.provider_code and p.commercial_use_cleared
  join lateral (
    select pr.payload, pr.updated_at from private.provider_records pr
    where pr.provider_code = x.provider_code and pr.entity_type = 'game' and pr.external_id = x.external_id
      and pr.status = 'matched' and pr.matched_game_id = g.id
    order by pr.created_at desc limit 1
  ) r on true
  where g.id = any(p_games[1:200]) and g.status = 'published' and g.merged_into_id is null;
$$;

revoke all on function public.get_game_provider_metadata(uuid[]) from public, anon, authenticated, service_role, catalog_importer;
grant execute on function public.get_game_provider_metadata(uuid[]) to anon, authenticated;
