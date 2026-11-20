-- PROPOSAL (M12c-B1, B1-M1): not a migration until reviewed and moved to supabase/migrations.
--
-- Independently verified game-platform pairings, and publishing a reviewed game identity
-- without a published physical release.
--
-- Invariants (enforced here, tested in 49_b1_identity_publication.test.sql):
--   I1  A pairing is published only with its game published, and either a published release on
--       it or an independent verification (verified_at) with recorded provenance.
--   I2  A game is published only with a published release (as before) or at least one
--       published, verified pairing.
--   I3  A pairing verification records who verified it, when, the game revision it attests
--       and its provenance, including an explicit physical-eligibility confirmation (R-2, R-8).
--       A Wikidata platform statement alone is never that confirmation.
--   I4  No self-review: whoever created the game or the pairing can't verify the pairing or
--       publish the identity. Pairing creators are recorded from now on (catalog_pairing_origins).
--   I5  Revision-sensitive: an identity is published only while the game's verification and
--       every named pairing's verification attest the game's current revision.
--   I6  Recent MFA (10 minutes) for verifying a pairing and publishing an identity.
--   I7  Identity publication never reads or writes a release. Releases keep every M11b and
--       M12c-A rule, and publish_release still publishes its game and pairing.
--   I8  Public reads show a published, verified pairing without releases, with release_count 0
--       ("No verified physical release yet"); nothing about who verified it or its provenance.
--
-- RLS: no table gets a new client grant. The new game_platforms columns have no column grant
-- (the table uses column grants), so anon and authenticated can't read them.
--
-- Rollback: 20261210100100_m12c_b1_m1_identity_publication.rollback.sql (forward). It refuses
-- while any game or pairing is published only as an identity: published records can't be
-- unpublished (guard_published_catalog_row), so those are excluded through the exclusion
-- tools first, with their history kept.

-- 1. Pairing verification columns.
alter table public.game_platforms
  add column verified_at timestamptz,
  add column verified_by uuid references public.profiles (id) on delete set null,
  add column verified_game_revision bigint,
  add column verification_basis jsonb,
  add constraint game_platforms_verification_complete check (
    (verified_at is null and verified_game_revision is null and verification_basis is null)
    or (verified_at is not null and verified_game_revision is not null and verification_basis is not null));

-- 2. Who created each pairing, for no-self-review. Private; written by trigger and backfill.
create table private.catalog_pairing_origins (
  game_id uuid not null,
  platform_id uuid not null,
  origin text not null check (origin in ('staff', 'submission', 'import', 'system', 'backfill')),
  creator_id uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (game_id, platform_id),
  foreign key (game_id, platform_id) references public.game_platforms (game_id, platform_id) on delete cascade
);
revoke all on private.catalog_pairing_origins from public, anon, authenticated, service_role;

create function private.record_pairing_origin()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
  v_role text := coalesce(pg_catalog.current_setting('role', true), 'none');
  v_origin text;
begin
  if v_role in ('authenticated', 'anon', 'service_role') then
    v_origin := case when new.submitted_by is not distinct from v_me then 'submission' else 'staff' end;
  elsif v_me is null and (session_user = 'catalog_importer' or v_role = 'catalog_importer') then
    v_origin := 'import';
  else
    v_origin := 'system';
  end if;
  insert into private.catalog_pairing_origins (game_id, platform_id, origin, creator_id)
  values (new.game_id, new.platform_id, v_origin, case when v_origin in ('staff', 'submission') then v_me end)
  on conflict (game_id, platform_id) do nothing;
  return null;
end;
$$;
revoke all on function private.record_pairing_origin() from public, anon, authenticated, service_role;
create trigger record_pairing_origin after insert on public.game_platforms
  for each row execute function private.record_pairing_origin();

-- Backfill, most specific first: an editor's set_game_platform audit row; else the creator of
-- the pairing's earliest release; else the game's origin. Unknown stays a creator-less backfill.
insert into private.catalog_pairing_origins (game_id, platform_id, origin, creator_id, created_at)
select gp.game_id, gp.platform_id,
       coalesce(a.origin, ro.origin, go.origin, 'backfill'),
       coalesce(a.creator_id, ro.creator_id, go.creator_id),
       gp.created_at
from public.game_platforms gp
left join lateral (
  select 'staff'::text as origin, e.actor_id as creator_id
  from private.audit_events e
  where e.action = 'catalog_record_created' and e.metadata ->> 'entity' = 'game_platform'
    and e.metadata ->> 'id' = gp.game_id::text and e.metadata ->> 'platform_id' = gp.platform_id::text
  order by e.occurred_at limit 1) a on true
left join lateral (
  select o.origin, o.creator_id
  from public.releases r join private.catalog_record_origins o on o.release_id = r.id
  where r.game_id = gp.game_id and r.platform_id = gp.platform_id
  order by r.created_at limit 1) ro on true
left join lateral (
  select o.origin, o.creator_id from private.catalog_record_origins o where o.game_id = gp.game_id limit 1) go on true
on conflict (game_id, platform_id) do nothing;

-- Existing published pairings carry a published release, so they need no identity
-- verification and get none: verified_at stays null, and I1 holds through their releases.

-- 3. Helpers.
create function private.pairing_created_by(p_me uuid, p_game uuid, p_platform uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_me is not null and exists (
    select 1 from private.catalog_pairing_origins o
    where o.game_id = p_game and o.platform_id = p_platform and o.creator_id = p_me)
$$;

create function private.game_has_identity_pairing(p_game uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (select 1 from public.game_platforms gp
                 where gp.game_id = p_game and gp.status = 'published' and gp.verified_at is not null)
$$;

-- A game a collector can find: a published, verified release on a published pairing (as
-- before), or a published, verified pairing. p_platforms limits both to those platforms.
create function private.catalog_game_listed(p_game uuid, p_platforms uuid[])
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
      select 1 from public.releases r
      join public.game_platforms gp on gp.game_id = r.game_id and gp.platform_id = r.platform_id and gp.status = 'published'
      where r.game_id = p_game and r.status = 'published' and r.verified_at is not null
        and (p_platforms is null or r.platform_id = any(p_platforms)))
    or exists (
      select 1 from public.game_platforms gp
      where gp.game_id = p_game and gp.status = 'published' and gp.verified_at is not null
        and (p_platforms is null or gp.platform_id = any(p_platforms)))
$$;

-- The provenance a pairing verification must carry (I3).
create function private.require_pairing_basis(p_basis jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_basis is null or pg_catalog.jsonb_typeof(p_basis) <> 'object'
     or pg_catalog.jsonb_typeof(p_basis -> 'source') <> 'string' or pg_catalog.char_length(p_basis ->> 'source') not between 1 and 60
     or pg_catalog.jsonb_typeof(p_basis -> 'reference') <> 'string' or pg_catalog.char_length(p_basis ->> 'reference') not between 1 and 300
     or p_basis ->> 'physical_eligibility' is distinct from 'confirmed'
     or (p_basis ? 'snapshot_sha256' and (p_basis ->> 'snapshot_sha256') !~ '^[0-9a-f]{64}$')
     or (p_basis ? 'note' and pg_catalog.char_length(p_basis ->> 'note') > 500)
     or exists (select 1 from pg_catalog.jsonb_object_keys(p_basis) k
                where k not in ('source', 'reference', 'physical_eligibility', 'snapshot_sha256', 'note', 'batch_id')) then
    raise exception 'invalid changes' using errcode = '22023';
  end if;
  return p_basis;
end;
$$;

revoke all on function private.pairing_created_by(uuid, uuid, uuid), private.game_has_identity_pairing(uuid),
  private.catalog_game_listed(uuid, uuid[]), private.require_pairing_basis(jsonb) from public, anon, authenticated, service_role;

-- 4. Publication invariants (I1, I2), replacing check_publication_of by exact signature.
CREATE OR REPLACE FUNCTION private.check_publication_of(p_game uuid, p_platform uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_published boolean;
begin
  v_published := exists (select 1 from public.games g where g.id = p_game and g.status = 'published');

  if p_platform is not null then
    if exists (
      select 1 from public.game_platforms gp
      where gp.game_id = p_game and gp.platform_id = p_platform and gp.status = 'published'
        and not (v_published
                 and (exists (select 1 from public.releases r where r.game_id = gp.game_id and r.platform_id = gp.platform_id and r.status = 'published')
                      -- B1-M1: an independently verified pairing is published without a release.
                      or gp.verified_at is not null))
    ) then
      raise exception 'a platform is published for a game only with a published release on it' using errcode = 'check_violation';
    end if;
    -- The reverse: a published release needs its pairing published.
    if exists (
      select 1 from public.releases r
      where r.game_id = p_game and r.platform_id = p_platform and r.status = 'published'
        and not exists (select 1 from public.game_platforms gp where gp.game_id = r.game_id and gp.platform_id = r.platform_id and gp.status = 'published')
    ) then
      raise exception 'a release can be published only with its game and platform' using errcode = 'check_violation';
    end if;
  end if;

  if v_published then
    -- B1-M1: or as a reviewed identity, with at least one published, verified pairing.
    if not (private.game_has_published_release(p_game) or private.game_has_identity_pairing(p_game)) then
      raise exception 'a game is published only with a published physical release' using errcode = 'check_violation';
    end if;
  elsif exists (select 1 from public.releases r where r.game_id = p_game and r.status = 'published')
     or exists (select 1 from public.game_platforms gp where gp.game_id = p_game and gp.status = 'published') then
    -- The reverse: nothing of an unpublished game stays published.
    raise exception 'a release can be published only with its game and platform' using errcode = 'check_violation';
  end if;

  -- Games cataloged through this one, if it's a compilation (D2).
  if exists (
    select 1
    from public.game_relations gr
    join public.games t on t.id = gr.target_game_id and t.status = 'published'
    where gr.source_game_id = p_game and gr.relation = 'contains'
      and not (private.game_has_published_release(t.id) or private.game_has_identity_pairing(t.id))
  ) then
    raise exception 'a game is published only with a published physical release' using errcode = 'check_violation';
  end if;
end;
$function$;

-- 5. Public reads (I8). A game's platforms: published, verified releases, or a published,
-- verified pairing with release_count 0.
CREATE OR REPLACE FUNCTION private.catalog_game_platforms_json(p_game uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'slug', p.slug, 'name', p.name, 'short_name', p.short_name, 'release_count', coalesce(x.n, 0)) order by p.name, p.slug), '[]')
  from public.game_platforms gp
  join public.platforms p on p.id = gp.platform_id
  left join (
    select r.platform_id, count(*)::integer as n
    from public.releases r
    where r.game_id = p_game and r.status = 'published' and r.verified_at is not null
    group by r.platform_id
  ) x on x.platform_id = gp.platform_id
  where gp.game_id = p_game and gp.status = 'published' and (x.n is not null or gp.verified_at is not null)
$function$;

CREATE OR REPLACE FUNCTION public.search_catalog(p_query text DEFAULT NULL::text, p_platforms text[] DEFAULT NULL::text[], p_limit integer DEFAULT 20, p_cursor text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
declare
  c_max_results constant integer := 200;
  c_zero constant uuid := '00000000-0000-0000-0000-000000000000';
  v_query text := pg_catalog.btrim(coalesce(p_query, ''));
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_platforms uuid[];
  v_slugs text[] := '{}';
  v_key text;
  v_compact text;
  v_pattern text;
  v_words tsquery;
  v_fuzzy boolean := false;
  v_latin boolean;
  v_browse boolean := false;
  v_code text;
  v_barcode text;
  v_hash text;
  v_cursor jsonb;
  c_n integer := 0;
  c_tier integer;
  c_score integer;
  c_sort text;
  c_game uuid;
  c_release uuid;
  v_take integer;
  v_row record;
  v_rows jsonb := '[]';
  v_count integer := 0;
  v_more boolean := false;
  -- The last row returned, in scalars: a record that a call never assigned has no
  -- fields, so reading it fails when a page is empty.
  l_tier integer;
  l_score integer;
  l_sort text;
  l_game uuid;
  l_release uuid;
  v_items jsonb;
  v_trgm_similarity text;
  v_trgm_word_similarity text;
begin
  if pg_catalog.char_length(v_query) > 100 then
    raise exception 'query too long' using errcode = '22023';
  end if;
  if p_platforms is not null and cardinality(p_platforms) > 10 then
    raise exception 'too many platforms' using errcode = '22023';
  end if;
  if p_platforms is not null and cardinality(p_platforms) > 0 then
    select coalesce(pg_catalog.array_agg(p.id order by p.slug), '{}'), coalesce(pg_catalog.array_agg(p.slug order by p.slug), '{}')
    into v_platforms, v_slugs
    from public.platforms p where p.slug = any(p_platforms);
  end if;

  if v_query = '' then
    if v_platforms is null then
      return pg_catalog.jsonb_build_object('status', 'empty', 'platforms', pg_catalog.to_jsonb(v_slugs), 'items', '[]'::jsonb, 'next_cursor', null);
    end if;
    v_browse := true;
  else
    v_key := private.catalog_search_key(v_query);
    if v_key is null or (pg_catalog.char_length(v_key) < 2 and pg_catalog.octet_length(v_key) = pg_catalog.char_length(v_key)) then
      return pg_catalog.jsonb_build_object('status', 'too_short', 'platforms', pg_catalog.to_jsonb(v_slugs), 'items', '[]'::jsonb, 'next_cursor', null);
    end if;
    v_compact := pg_catalog.replace(v_key, ' ', '');
    v_pattern := v_key || '%';
    select pg_catalog.to_tsquery('pg_catalog.simple', pg_catalog.string_agg(pg_catalog.quote_literal(t) || case when o = n then ':*' else '' end, ' & ' order by o))
    into v_words
    from (select t, o, count(*) over () as n from pg_catalog.unnest(pg_catalog.string_to_array(v_key, ' ')) with ordinality as x(t, o)) s;
    -- Latin queries of one or two characters match whole-title prefixes only, and
    -- similarity needs five, so a short query doesn't match most of the catalog.
    -- Scripts without Latin letters carry more per character.
    v_latin := pg_catalog.octet_length(v_key) = pg_catalog.char_length(v_key);
    if v_latin and pg_catalog.char_length(v_key) < 3 then
      v_words := null;
    end if;
    v_fuzzy := pg_catalog.char_length(v_key) >= case when v_latin then 5 else 2 end;
    v_code := pg_catalog.upper(pg_catalog.regexp_replace(v_query, '\s+', '', 'g'));
    if v_code !~ '^[A-Z0-9][A-Z0-9-]{2,39}$' or v_code !~ '[0-9-]' then
      v_code := null;
    end if;
    v_barcode := pg_catalog.regexp_replace(v_query, '[\s-]+', '', 'g');
    if v_barcode !~ '^[0-9]{8,14}$' then
      v_barcode := null;
    end if;
  end if;

  v_hash := pg_catalog.left(pg_catalog.md5(concat_ws('|', coalesce(v_key, ''), pg_catalog.array_to_string(v_slugs, ','), coalesce(v_code, ''), coalesce(v_barcode, ''), v_browse::text)), 12);
  if p_cursor is not null then
    v_cursor := private.catalog_cursor_decode(p_cursor);
    begin
      c_n := (v_cursor ->> 1)::integer;
      c_tier := (v_cursor ->> 2)::integer;
      c_score := (v_cursor ->> 3)::integer;
      c_sort := v_cursor ->> 4;
      c_game := (v_cursor ->> 5)::uuid;
      c_release := (v_cursor ->> 6)::uuid;
    exception when others then
      raise exception 'invalid cursor' using errcode = '22023';
    end;
    if v_cursor ->> 0 is distinct from v_hash or c_n is null or c_n < 1 or c_n >= c_max_results
       or c_tier is null or c_score is null or c_sort is null or c_game is null or c_release is null then
      raise exception 'invalid cursor' using errcode = '22023';
    end if;
  end if;
  v_take := least(v_limit, c_max_results - c_n);

  -- The trigram operators read their thresholds from settings any session can change,
  -- so fix them for this query and restore the caller's afterwards. Both are
  -- user-settable: no superuser, and nothing a hosted migration can't create.
  v_trgm_similarity := coalesce(pg_catalog.current_setting('pg_trgm.similarity_threshold', true), '0.3');
  v_trgm_word_similarity := coalesce(pg_catalog.current_setting('pg_trgm.word_similarity_threshold', true), '0.6');
  perform pg_catalog.set_config('pg_trgm.similarity_threshold', '0.5', true);
  perform pg_catalog.set_config('pg_trgm.word_similarity_threshold', '0.6', true);

  for v_row in
    -- One branch per condition, so each uses its own index; best removes repeats.
    with titles as (
      select g.id as game_id, g.search_key as k, g.search_words as w, null::text as matched, null::text as source
      from public.games g where v_key is not null and g.status = 'published' and g.search_key like v_pattern
      union all
      select g.id, g.search_key, g.search_words, null, null
      from public.games g where v_key is not null and g.status = 'published' and g.search_compact = v_compact
      union all
      select g.id, g.search_key, g.search_words, null, null
      from public.games g where v_words is not null and g.status = 'published' and g.search_words @@ v_words
      union all
      select g.id, g.search_key, g.search_words, null, null
      from public.games g where v_fuzzy and g.status = 'published'
        and v_key operator(extensions.%) g.search_key and extensions.similarity(v_key, g.search_key) >= 0.5
      union all
      select g.id, g.search_key, g.search_words, null, null
      from public.games g where v_fuzzy and g.status = 'published' and v_key operator(extensions.<%) g.search_key
      union all
      select a.game_id, a.search_key, a.search_words, a.title, 'alias'
      from public.game_aliases a where v_key is not null and a.search_key like v_pattern
      union all
      select a.game_id, a.search_key, a.search_words, a.title, 'alias'
      from public.game_aliases a where v_key is not null and a.search_compact = v_compact
      union all
      select a.game_id, a.search_key, a.search_words, a.title, 'alias'
      from public.game_aliases a where v_words is not null and a.search_words @@ v_words
      union all
      select a.game_id, a.search_key, a.search_words, a.title, 'alias'
      from public.game_aliases a where v_fuzzy
        and v_key operator(extensions.%) a.search_key and extensions.similarity(v_key, a.search_key) >= 0.5
      union all
      select a.game_id, a.search_key, a.search_words, a.title, 'alias'
      from public.game_aliases a where v_fuzzy and v_key operator(extensions.<%) a.search_key
      union all
      select r.game_id, r.local_title_key, null::tsvector, r.local_title, 'local_title'
      from public.releases r where v_key is not null and r.status = 'published' and r.verified_at is not null
        and r.local_title_key is not null and r.local_title_key like v_pattern
      union all
      select r.game_id, r.local_title_key, null::tsvector, r.local_title, 'local_title'
      from public.releases r where v_fuzzy and r.status = 'published' and r.verified_at is not null and r.local_title_key is not null
        and v_key operator(extensions.%) r.local_title_key and extensions.similarity(v_key, r.local_title_key) >= 0.5
      union all
      select r.game_id, r.local_title_key, null::tsvector, r.local_title, 'local_title'
      from public.releases r where v_fuzzy and r.status = 'published' and r.verified_at is not null and r.local_title_key is not null
        and v_key operator(extensions.<%) r.local_title_key
    ),
    -- Within a tier: the exact key first, then titles that add least to the query,
    -- and for similar titles, the most similar. Similarity is computed only there.
    scored as (
      select s.game_id, s.matched, s.source, s.tier,
        case
          when s.k = v_key then 1000
          when s.tier < 4 then 999 - least(abs(pg_catalog.char_length(s.k) - pg_catalog.char_length(v_key)), 998)
          else pg_catalog.floor(greatest(extensions.similarity(v_key, s.k), extensions.word_similarity(v_key, s.k)) * 1000)::integer
        end as score
      from (
        select t.*,
          case
            when t.k = v_key or pg_catalog.replace(t.k, ' ', '') = v_compact then 1
            when t.k like v_pattern then 2
            when t.w @@ v_words then 3
            else 4
          end as tier
        from titles t
      ) s
    ),
    best as (
      select distinct on (s.game_id) s.game_id, s.tier, s.score, s.matched, s.source
      from scored s
      order by s.game_id, s.tier, s.score desc, (s.source is not null), s.matched
    ),
    results as (
      -- An exact identifier: the release itself.
      select 0 as tier, 1000 as score, g.sort_title, g.id as game_id, r.id as release_id, null::text as matched, null::text as source,
        case when v_code is not null and pg_catalog.upper(r.product_code) = v_code then 'product_code' else 'barcode' end as identifier
      from public.releases r
      join public.game_platforms gp on gp.game_id = r.game_id and gp.platform_id = r.platform_id and gp.status = 'published'
      join public.games g on g.id = r.game_id and g.status = 'published'
      where r.status = 'published' and r.verified_at is not null
        and ((v_code is not null and pg_catalog.upper(r.product_code) = v_code) or (v_barcode is not null and r.barcode = v_barcode))
        and (v_platforms is null or r.platform_id = any(v_platforms))
      union all
      select b.tier, b.score, g.sort_title, g.id, null::uuid, b.matched, b.source, null::text
      from best b
      join public.games g on g.id = b.game_id and g.status = 'published'
      -- B1-M1: a published release, or a published, independently verified pairing.
      where private.catalog_game_listed(g.id, v_platforms)
      union all
      select 5, 0, g.sort_title, g.id, null::uuid, null::text, null::text, null::text
      from public.games g
      -- B1-M1: as above, on the platforms browsed.
      where v_browse and g.status = 'published' and private.catalog_game_listed(g.id, v_platforms)
    )
    select x.* from results x
    where p_cursor is null
       or (x.tier, -x.score, x.sort_title, x.game_id, coalesce(x.release_id, c_zero)) > (c_tier, -c_score, c_sort, c_game, c_release)
    order by x.tier, -x.score, x.sort_title, x.game_id, coalesce(x.release_id, c_zero)
    limit v_take + 1
  loop
    v_count := v_count + 1;
    if v_count > v_take then
      v_more := true;
      exit;
    end if;
    l_tier := v_row.tier;
    l_score := v_row.score;
    l_sort := v_row.sort_title;
    l_game := v_row.game_id;
    l_release := coalesce(v_row.release_id, c_zero);
    v_rows := v_rows || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'tier', v_row.tier, 'game_id', v_row.game_id, 'release_id', v_row.release_id,
      'matched', v_row.matched, 'source', v_row.source, 'identifier', v_row.identifier));
  end loop;
  perform pg_catalog.set_config('pg_trgm.similarity_threshold', v_trgm_similarity, true);
  perform pg_catalog.set_config('pg_trgm.word_similarity_threshold', v_trgm_word_similarity, true);

  select coalesce(pg_catalog.jsonb_agg(
      case when e ->> 'release_id' is not null then pg_catalog.jsonb_build_object(
        'kind', 'release',
        'match', 'code',
        'matched_identifier', e ->> 'identifier',
        'game', private.catalog_game_json(g),
        'release', pg_catalog.jsonb_build_object(
          'id', r.id,
          'platform', pg_catalog.jsonb_build_object('slug', p.slug, 'name', p.name, 'short_name', p.short_name),
          'region', pg_catalog.jsonb_build_object('code', rc.code, 'label', rc.label),
          'edition_name', r.edition_name,
          'variant_name', r.variant_name,
          'identifiers', pg_catalog.jsonb_build_object('product_code', r.product_code, 'barcode', r.barcode)))
      else pg_catalog.jsonb_build_object(
        'kind', 'game',
        'match', (array['exact', 'prefix', 'words', 'similar', 'browse'])[(e ->> 'tier')::integer],
        'matched', case when e ->> 'source' is null then null
                        else pg_catalog.jsonb_build_object('title', e ->> 'matched', 'source', e ->> 'source') end,
        'game', private.catalog_game_json(g),
        'platforms', private.catalog_game_platforms_json(g.id))
      end order by o), '[]')
  into v_items
  from pg_catalog.jsonb_array_elements(v_rows) with ordinality as x(e, o)
  join public.games g on g.id = (e ->> 'game_id')::uuid
  left join public.releases r on r.id = (e ->> 'release_id')::uuid
  left join public.platforms p on p.id = r.platform_id
  left join public.region_codes rc on rc.code = r.region_code;

  return pg_catalog.jsonb_build_object(
    'status', 'ok',
    'platforms', pg_catalog.to_jsonb(v_slugs),
    'items', v_items,
    'next_cursor', case when v_more and c_n + v_count - 1 < c_max_results then private.catalog_cursor_encode(pg_catalog.jsonb_build_array(
      v_hash, c_n + v_take, l_tier, l_score, l_sort, l_game, l_release)) end);
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_release_picker(p_game text, p_platform text DEFAULT NULL::text, p_region text DEFAULT NULL::text, p_release uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_game public.games;
  v_depth integer := 0;
  v_platform uuid;
  v_region text;
  v_selected uuid;
  v_platforms jsonb;
  v_regions jsonb;
  v_releases jsonb;
begin
  if p_game is null or pg_catalog.char_length(p_game) > 120 then
    return null;
  end if;
  if p_game ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select * into v_game from public.games g where g.id = p_game::uuid;
  else
    select * into v_game from public.games g where g.slug = p_game;
  end if;
  if not found then
    return null;
  end if;
  while v_game.status = 'merged' loop
    v_depth := v_depth + 1;
    if v_game.slug is null or v_depth > 10 then
      return null;
    end if;
    select * into v_game from public.games g where g.id = v_game.merged_into_id;
    if not found then
      return null;
    end if;
  end loop;
  if v_game.status <> 'published' then
    return null;
  end if;


  select r.id, r.platform_id, r.region_code into v_selected, v_platform, v_region
  from private.catalog_public_releases(v_game.id) r where r.id = p_release;
  if v_selected is null then
    select p.id into v_platform from public.platforms p
    where p.slug = p_platform and (exists (select 1 from private.catalog_public_releases(v_game.id) r where r.platform_id = p.id)
      -- B1-M1: a published, verified pairing with no published release yet.
      or exists (select 1 from public.game_platforms gp where gp.game_id = v_game.id and gp.platform_id = p.id
                 and gp.status = 'published' and gp.verified_at is not null));
    if v_platform is null then
      select min(r.platform_id::text)::uuid into v_platform from private.catalog_public_releases(v_game.id) r
      having count(distinct r.platform_id) = 1;
    end if;
    select rc.code into v_region from public.region_codes rc
    where rc.code = p_region and exists (select 1 from private.catalog_public_releases(v_game.id) r
                                          where r.region_code = rc.code and (v_platform is null or r.platform_id = v_platform));
  end if;

  v_platforms := private.catalog_game_platforms_json(v_game.id);
  if v_platforms = '[]' then
    return null;
  end if;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('code', rc.code, 'label', rc.label, 'release_count', x.n)
           order by rc.position), '[]')
  into v_regions
  from (select r.region_code, count(*)::integer as n from private.catalog_public_releases(v_game.id) r
        where v_platform is null or r.platform_id = v_platform group by r.region_code) x
  join public.region_codes rc on rc.code = x.region_code;

  select coalesce(pg_catalog.jsonb_agg(private.catalog_release_json(r)
           order by p.name, p.slug, rc.position, r.release_date nulls last, r.edition_kind nulls first,
                    r.edition_name nulls first, r.variant_name nulls first, r.id), '[]')
  into v_releases
  from private.catalog_public_releases(v_game.id) r
  join public.platforms p on p.id = r.platform_id
  join public.region_codes rc on rc.code = r.region_code
  where (v_platform is null or r.platform_id = v_platform) and (v_region is null or r.region_code = v_region);

  return pg_catalog.jsonb_build_object(
    'game', private.catalog_game_json(v_game) || pg_catalog.jsonb_build_object('aliases',
      (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'title', a.title, 'kind', a.kind, 'language_code', a.language_code, 'region_code', a.region_code)
        order by a.kind, a.title, a.id), '[]')
       from public.game_aliases a where a.game_id = v_game.id)),
    'platforms', v_platforms,
    'regions', v_regions,
    'selection', pg_catalog.jsonb_build_object(
      'platform', (select p.slug from public.platforms p where p.id = v_platform),
      'region', v_region,
      'release_id', v_selected),
    'releases', v_releases);
end;
$function$;

-- 6. Editor functions.
create function public.verify_game_platform(p_game uuid, p_platform uuid, p_basis jsonb, p_reason text, p_expected_game_revision bigint)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_reason text;
  v_game public.games;
  v_pair public.game_platforms;
  v_basis jsonb;
begin
  v_me := private.begin_catalog_edit();
  perform private.require_recent_mfa();                       -- I6
  v_reason := private.require_reason(p_reason);
  v_basis := private.require_pairing_basis(p_basis);         -- I3
  if p_expected_game_revision is null then
    raise exception 'invalid changes' using errcode = '22023';
  end if;
  select * into v_game from public.games g where g.id = p_game for update;
  if not found or v_game.status not in ('unverified', 'under_review', 'published') then
    raise exception 'record unavailable' using errcode = 'P0001';
  end if;
  if v_game.revision <> p_expected_game_revision then
    raise exception 'record changed' using errcode = 'P0001';
  end if;
  select * into v_pair from public.game_platforms gp where gp.game_id = p_game and gp.platform_id = p_platform for update;
  if not found or v_pair.status not in ('unverified', 'under_review', 'published') then
    raise exception 'record unavailable' using errcode = 'P0001';
  end if;
  -- I4: not the game's creator, not the pairing's creator.
  if private.created_by(v_me, null, array[p_game]) or private.pairing_created_by(v_me, p_game, p_platform) then
    raise exception 'own record' using errcode = 'P0001';
  end if;
  update public.game_platforms gp set
    verified_at = pg_catalog.clock_timestamp(), verified_by = v_me,
    verified_game_revision = v_game.revision, verification_basis = v_basis
  where gp.game_id = p_game and gp.platform_id = p_platform;
  perform private.record_catalog_audit(v_me, 'catalog_record_verified', 'game_platform', p_game, v_reason,
    pg_catalog.jsonb_build_object('platform_id', p_platform, 'game_revision', v_game.revision, 'basis', v_basis));
  return true;
end;
$$;

create function public.publish_game_identity(p_game uuid, p_platforms uuid[], p_reason text, p_expected_revision bigint)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_reason text;
  v_game public.games;
  v_platform uuid;
  v_pair public.game_platforms;
  v_slug text;
begin
  v_me := private.begin_catalog_edit();
  perform private.require_recent_mfa();                       -- I6
  v_reason := private.require_reason(p_reason);
  if p_expected_revision is null or p_platforms is null or pg_catalog.cardinality(p_platforms) = 0
     or pg_catalog.cardinality(p_platforms) > 20 then
    raise exception 'invalid changes' using errcode = '22023';
  end if;
  select * into v_game from public.games g where g.id = p_game for update;
  if not found or v_game.status not in ('unverified', 'under_review', 'published') then
    raise exception 'record unavailable' using errcode = 'P0001';
  end if;
  if v_game.revision <> p_expected_revision then
    raise exception 'record changed' using errcode = 'P0001';
  end if;
  if private.created_by(v_me, null, array[p_game]) then       -- I4
    raise exception 'own record' using errcode = 'P0001';
  end if;
  -- I5: the game's verification attests this revision (a published game is already public).
  if v_game.status <> 'published' and not private.verification_current('game', v_game.id, v_game.revision, v_game.verified_at) then
    raise exception 'game not verified' using errcode = 'P0001';
  end if;
  foreach v_platform in array p_platforms loop
    select * into v_pair from public.game_platforms gp where gp.game_id = p_game and gp.platform_id = v_platform for update;
    if not found or v_pair.status not in ('unverified', 'under_review', 'published') then
      raise exception 'record unavailable' using errcode = 'P0001';
    end if;
    if private.pairing_created_by(v_me, p_game, v_platform) then
      raise exception 'own record' using errcode = 'P0001';
    end if;
    if v_pair.verified_at is null or v_pair.verified_game_revision is distinct from v_game.revision then
      raise exception 'pairing not verified' using errcode = 'P0001';
    end if;
  end loop;

  -- I7: games and pairings only.
  if v_game.status <> 'published' then
    v_slug := coalesce(v_game.slug, private.assign_game_slug(v_game.title));
    update public.games g set status = 'published', slug = v_slug, submitted_by = null where g.id = p_game;
    perform private.record_catalog_audit(v_me, 'catalog_record_published', 'game', p_game, v_reason,
      pg_catalog.jsonb_build_object('slug', v_slug, 'identity', true, 'platforms', p_platforms, 'revision', v_game.revision)
      || private.provenance_note('game', p_game));
  end if;
  update public.game_platforms gp set status = 'published', submitted_by = null
  where gp.game_id = p_game and gp.platform_id = any (p_platforms) and gp.status <> 'published';
  foreach v_platform in array p_platforms loop
    perform private.record_catalog_audit(v_me, 'catalog_record_published', 'game_platform', p_game, v_reason,
      pg_catalog.jsonb_build_object('platform_id', v_platform, 'identity', true));
  end loop;
  return true;
end;
$$;

revoke all on function public.verify_game_platform(uuid, uuid, jsonb, text, bigint), public.publish_game_identity(uuid, uuid[], text, bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.verify_game_platform(uuid, uuid, jsonb, text, bigint), public.publish_game_identity(uuid, uuid[], text, bigint)
  to authenticated;
