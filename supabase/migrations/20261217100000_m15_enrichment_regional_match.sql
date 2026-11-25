-- M15 submission enrichment, second step: regional titles, and an editor's confirmation.
--
-- The first real submission, "Joe & Mac 3" (SNES, PAL), showed the gap. Wikidata had the game
-- (Q4677160, Joe & Mac 2: Lost in the Tropics, whose European title is "Joe & Mac 3: Lost in the
-- Tropics") with its developer and its European release month, and the lookup stored it. But:
--   - it was graded "ambiguous", "different title": only an exact title counted as a match;
--   - the per-region release dates were dropped (only the earliest date was kept);
--   - it was shown only on the submission's review, never on the game's own record, which said
--     "Added by hand";
--   - an editor had no way to accept it: nothing could become the game's source.
--
-- What changes here (the matching itself is the server's: src/features/enrichment/match.ts):
--   - A candidate may now carry how it matched (match, matched_title, likely), its release dates
--     with their places, and the importer's own parsed record (payload). "single_match" means one
--     likely candidate (an exact title, a regional title or alias, or a title's main part); weaker
--     possibilities may be listed with it.
--   - The lookup's claim also gives the submission's region (for the regional release date and the
--     languages searched).
--   - get_submission_enrichment also returns the game, the region, the game's Wikidata link and
--     the editors' decisions, and finds catalog games (unpublished ones included) by the likely
--     match's other titles too. get_game_enrichment returns the same from the game's record.
--   - decide_submission_enrichment: a catalog editor (with MFA) confirms or rejects a candidate,
--     with their own reason, audited. Confirming stores the candidate exactly as the editor saw it
--     as the game's Wikidata source record and reference, the way an import stores one (an import
--     run naming the submission, a promoted provider record, title keys, the external reference),
--     and only while the provider is cleared for use. The game, its title, its verification, its
--     releases and its publication are untouched: what a source says stays a claim to check, never
--     evidence of a physical release.
--   - Lookups recorded before this migration, for submissions still waiting, are looked up again
--     (the earlier answer stays until the new one arrives).

alter type private.audit_action add value if not exists 'catalog_source_confirmed';
alter type private.audit_action add value if not exists 'catalog_source_rejected';

-- A record's history (get_catalog_record_history) shows these too.
create or replace function private.history_actions()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'catalog_record_created', 'catalog_record_updated', 'catalog_record_verified', 'catalog_record_published',
    'catalog_field_locked', 'catalog_field_unlocked', 'catalog_record_withdrawn', 'catalog_review_queued',
    'catalog_review_resolved', 'catalog_alias_added', 'catalog_alias_removed',
    'catalog_submission_created', 'catalog_submission_updated', 'catalog_submission_withdrawn',
    'catalog_submission_resubmitted', 'catalog_submission_review_started', 'catalog_submission_approved',
    'catalog_submission_changes_requested', 'catalog_submission_rejected',
    'catalog_release_excluded', 'catalog_exclusion_restored', 'catalog_release_merged',
    'catalog_source_confirmed', 'catalog_source_rejected'
  ]
$$;

-- An editor's decision per candidate, by Wikidata id: {"Q…": {"decision", "by", "at"}}.
alter table private.submission_enrichments
  add column decisions jsonb not null default '{}'
    check (jsonb_typeof(decisions) = 'object' and pg_column_size(decisions) <= 8192);

-- The importer's payload with every candidate makes rows larger: still bounded.
alter table private.submission_enrichments drop constraint if exists submission_enrichments_candidates_check;
alter table private.submission_enrichments
  add constraint submission_enrichments_candidates_check
    check (jsonb_typeof(candidates) = 'array' and jsonb_array_length(candidates) <= 10 and pg_column_size(candidates) <= 262144);

-- A changed title looks up again, and forgets the decisions on the old title's candidates. A
-- confirmed match stays: the game's source record and reference remain until an editor changes them.
create or replace function private.queue_submission_enrichment()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into private.submission_enrichments (submission_id) values (new.id) on conflict (submission_id) do nothing;
  else
    update private.submission_enrichments e set
      status = 'pending', attempts = 0, claim_id = null, claimed_at = null, last_attempt_at = null, looked_up_title = null, looked_up_platform = null,
      retrieved_at = null, candidates = '[]', labels = '{}',
      decisions = coalesce((select pg_catalog.jsonb_object_agg(d.key, d.value) from pg_catalog.jsonb_each(e.decisions) d
                            where d.value ->> 'decision' = 'confirmed'), '{}')
    where e.submission_id = new.id;
  end if;
  return null;
end;
$$;
revoke all on function private.queue_submission_enrichment() from public, anon, authenticated, service_role;

-- As before, and each claim also gives the submission's region code.
create or replace function public.claim_submission_enrichments(p_submission uuid default null, p_limit integer default 1)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_out jsonb;
begin
  with due as (
    select e.submission_id
    from private.submission_enrichments e
    join public.catalog_change_requests s on s.id = e.submission_id
    where (p_submission is null or e.submission_id = p_submission)
      and s.status in ('open', 'in_review', 'changes_requested')
      and e.status in ('pending', 'failed')
      and e.attempts < 5
      and (e.claimed_at is null or e.claimed_at < pg_catalog.now() - interval '2 minutes')
      and (e.status = 'pending' or e.last_attempt_at is null or e.last_attempt_at < pg_catalog.now() - interval '15 minutes')
    order by e.created_at
    limit least(greatest(coalesce(p_limit, 1), 1), 10)
    for update of e skip locked
  ), claimed as (
    update private.submission_enrichments e
    set claim_id = gen_random_uuid(), claimed_at = pg_catalog.now(), last_attempt_at = pg_catalog.now(), attempts = e.attempts + 1
    from due
    where e.submission_id = due.submission_id
    returning e.submission_id, e.claim_id
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'submission_id', c.submission_id, 'claim_id', c.claim_id,
           'title', s.details ->> 'title', 'platform', s.details -> 'platform' ->> 'slug',
           'region', s.details -> 'region' ->> 'code')), '[]'::jsonb)
  into v_out
  from claimed c join public.catalog_change_requests s on s.id = c.submission_id;
  return v_out;
end;
$$;

-- As before, with the new candidate fields validated when present. A result whose candidates say
-- whether they are likely must agree with its status: "single_match" is exactly one likely
-- candidate. A result without them (a server from before this migration) keeps the old rules.
create or replace function public.record_submission_enrichment(p_submission uuid, p_claim uuid, p_result jsonb)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text := p_result ->> 'status';
  v_candidates jsonb := coalesce(p_result -> 'candidates', '[]');
  v_labels jsonb := coalesce(p_result -> 'labels', '{}');
  v_graded boolean;
  v_likely integer;
  v_rows integer;
begin
  if p_submission is null or p_claim is null or p_result is null or pg_catalog.jsonb_typeof(p_result) <> 'object'
     or v_status is null or v_status not in ('failed', 'unsupported_platform', 'no_match', 'single_match', 'ambiguous')
     or pg_catalog.jsonb_typeof(v_candidates) <> 'array' or pg_catalog.jsonb_typeof(v_labels) <> 'object'
     or pg_catalog.jsonb_array_length(v_candidates) > 10 or pg_catalog.pg_column_size(v_candidates) > 262144
     or (v_status in ('single_match', 'ambiguous')) <> (pg_catalog.jsonb_array_length(v_candidates) > 0)
     or exists (select 1 from pg_catalog.jsonb_array_elements(v_candidates) c
                where pg_catalog.jsonb_typeof(c) <> 'object' or c ->> 'provider' is distinct from 'wikidata'
                   or coalesce(c ->> 'external_id', '') !~ '^Q[1-9][0-9]{0,11}$'
                   or coalesce(c ->> 'title', '') = '' or pg_catalog.char_length(c ->> 'title') > 400
                   or pg_catalog.jsonb_typeof(c -> 'titles') is distinct from 'array'
                   or pg_catalog.jsonb_typeof(c -> 'developers') is distinct from 'array'
                   or pg_catalog.jsonb_typeof(c -> 'publishers') is distinct from 'array'
                   or c ->> 'licence' is null or c ->> 'retrieved_at' is null
                   or (c ? 'likely' and pg_catalog.jsonb_typeof(c -> 'likely') <> 'boolean')
                   or (c ? 'match' and coalesce(c ->> 'match', '') not in ('exact', 'regional_title', 'main_title', 'partial'))
                   or (c ? 'matched_title' and pg_catalog.jsonb_typeof(c -> 'matched_title') not in ('string', 'null'))
                   or (c ? 'release_dates' and (pg_catalog.jsonb_typeof(c -> 'release_dates') <> 'array' or pg_catalog.jsonb_array_length(c -> 'release_dates') > 50))
                   or (c ? 'payload' and (pg_catalog.jsonb_typeof(c -> 'payload') <> 'object'
                                          or pg_catalog.pg_column_size(c -> 'payload') > 24576
                                          or c -> 'payload' ->> 'title' is distinct from c ->> 'title')))
     or exists (select 1 from pg_catalog.jsonb_each(v_labels) l
                where l.key !~ '^Q[1-9][0-9]{0,11}$' or pg_catalog.jsonb_typeof(l.value) <> 'string' or pg_catalog.char_length(l.value #>> '{}') > 200) then
    raise exception 'invalid enrichment' using errcode = '22023';
  end if;
  select pg_catalog.bool_or(c ? 'likely'), pg_catalog.count(*) filter (where c -> 'likely' = 'true'::jsonb)
  into v_graded, v_likely
  from pg_catalog.jsonb_array_elements(v_candidates) c;
  if coalesce(v_graded, false) then
    if v_status in ('single_match', 'ambiguous') and (v_status = 'single_match') <> (v_likely = 1) then
      raise exception 'invalid enrichment' using errcode = '22023';
    end if;
  elsif v_status = 'single_match' and pg_catalog.jsonb_array_length(v_candidates) <> 1 then
    raise exception 'invalid enrichment' using errcode = '22023';
  end if;
  update private.submission_enrichments e set
    status = v_status, claim_id = null, claimed_at = null,
    looked_up_title = nullif(pg_catalog.left(p_result ->> 'title', 200), ''),
    looked_up_platform = nullif(pg_catalog.left(p_result ->> 'platform', 60), ''),
    retrieved_at = coalesce((p_result ->> 'retrieved_at')::timestamptz, pg_catalog.now()),
    candidates = v_candidates, labels = v_labels
  where e.submission_id = p_submission and e.claim_id = p_claim;
  get diagnostics v_rows = row_count;
  return v_rows = 1;
exception
  when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then
    raise exception 'invalid enrichment' using errcode = '22023';
end;
$$;

-- As before, plus: the game, the release's region, the game's own Wikidata link, the decisions
-- (never who made them: a record names nobody above its history), candidates without their stored
-- payload, and catalog games found by the likely match's other titles (via_match).
create or replace function public.get_submission_enrichment(p_submission uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_req public.catalog_change_requests;
  v_row private.submission_enrichments;
  v_key text;
  v_keys text[];
begin
  perform private.require_active_staff('catalog_editor');
  select * into v_req from public.catalog_change_requests s where s.id = p_submission;
  select * into v_row from private.submission_enrichments e where e.submission_id = p_submission;
  if v_req.id is null or v_row.submission_id is null then
    return null;
  end if;
  v_key := private.catalog_search_key(v_req.details ->> 'title');
  -- The submitted title, and every title of a likely candidate: the same game under another name.
  select coalesce(pg_catalog.array_agg(distinct k), '{}') into v_keys from (
    select v_key as k
    union all
    select private.catalog_search_key(t)
    from pg_catalog.jsonb_array_elements(v_row.candidates) c
    cross join lateral pg_catalog.jsonb_array_elements_text(
      (case when pg_catalog.jsonb_typeof(c -> 'titles') = 'array' then c -> 'titles' else '[]' end)
      || (case when pg_catalog.jsonb_typeof(c -> 'ja_titles') = 'array' then c -> 'ja_titles' else '[]' end)
      || pg_catalog.jsonb_build_array(coalesce(c ->> 'title', ''))) t
    where coalesce(c -> 'likely' = 'true'::jsonb, v_row.status = 'single_match')
  ) x where k is not null;
  return pg_catalog.jsonb_build_object(
    'status', v_row.status, 'provider', v_row.provider, 'attempts', v_row.attempts,
    'looking_up', v_row.claimed_at is not null and v_row.claimed_at > pg_catalog.now() - interval '2 minutes',
    'looked_up_title', v_row.looked_up_title, 'looked_up_platform', v_row.looked_up_platform,
    'retrieved_at', v_row.retrieved_at,
    'candidates', coalesce((select pg_catalog.jsonb_agg(c.value - 'payload' order by c.ordinality)
                            from pg_catalog.jsonb_array_elements(v_row.candidates) with ordinality c), '[]'::jsonb),
    'labels', v_row.labels,
    'current_title', v_req.details ->> 'title',
    'game_id', v_req.game_id,
    'region', v_req.details -> 'region' ->> 'code',
    'linked_external_id', (select xr.external_id from private.external_references xr
                           where xr.provider_code = 'wikidata' and xr.game_id = v_req.game_id order by xr.external_id limit 1),
    'decisions', coalesce((select pg_catalog.jsonb_object_agg(d.key, pg_catalog.jsonb_build_object('decision', d.value ->> 'decision', 'at', d.value ->> 'at'))
                           from pg_catalog.jsonb_each(v_row.decisions) d), '{}'::jsonb),
    'catalog_items', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('external_id', x.external_id, 'game_id', g.id, 'title', g.title, 'status', g.status, 'slug', g.slug)
                                  order by x.external_id, g.title)
      from (
        select distinct pr.external_id, pr.matched_game_id as game_id from private.provider_records pr
        where pr.provider_code = 'wikidata' and pr.matched_game_id is not null
          and pr.external_id in (select c ->> 'external_id' from pg_catalog.jsonb_array_elements(v_row.candidates) c)
        union
        select xr.external_id, xr.game_id from private.external_references xr
        where xr.provider_code = 'wikidata' and xr.game_id is not null
          and xr.external_id in (select c ->> 'external_id' from pg_catalog.jsonb_array_elements(v_row.candidates) c)
      ) x
      join public.games g on g.id = x.game_id
      where g.id is distinct from v_req.game_id and g.status <> 'merged'), '[]'::jsonb),
    'title_matches', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('game_id', g.id, 'title', g.title, 'status', g.status, 'slug', g.slug, 'via', m.via, 'via_match', m.via_match) order by g.title)
      from (
        select g2.id, min(v.via) as via, pg_catalog.bool_and(v.k is distinct from v_key) as via_match from public.games g2
        cross join lateral (
          select 'title' as via, g2.search_key as k where g2.search_key = any (v_keys)
          union all
          select 'alias', a.search_key from public.game_aliases a where a.game_id = g2.id and a.search_key = any (v_keys)
          union all
          select 'source title', private.catalog_search_key(t) from private.provider_records pr, pg_catalog.jsonb_array_elements_text(
              case when pg_catalog.jsonb_typeof(pr.payload -> 'titles') = 'array' then pr.payload -> 'titles' else '[]' end
              || case when pg_catalog.jsonb_typeof(pr.payload -> 'ja_titles') = 'array' then pr.payload -> 'ja_titles' else '[]' end) t
            where pr.matched_game_id = g2.id and pr.entity_type = 'game' and private.catalog_search_key(t) = any (v_keys)
        ) v
        where pg_catalog.cardinality(v_keys) > 0 and g2.id is distinct from v_req.game_id and g2.status <> 'merged'
        group by g2.id
      ) m join public.games g on g.id = m.id), '[]'::jsonb)
  );
end;
$$;

-- The lookup behind a game created by a submission, for its record: the newest new-game
-- submission that created it. Catalog editors (with MFA). Null when the game has none.
create function public.get_game_enrichment(p_game uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_req public.catalog_change_requests;
  v_out jsonb;
begin
  perform private.require_active_staff('catalog_editor');
  select s.* into v_req from public.catalog_change_requests s
  join private.submission_enrichments e on e.submission_id = s.id
  where s.game_id = p_game and s.request_type = 'new_game' and s.created_game
  order by s.created_at desc limit 1;
  if v_req.id is null then
    return null;
  end if;
  v_out := public.get_submission_enrichment(v_req.id);
  return v_out || pg_catalog.jsonb_build_object('submission_id', v_req.id, 'submission_status', v_req.status);
end;
$$;

-- An editor's decision on one candidate of a submission's lookup: 'confirm' or 'reject', with the
-- editor's own reason (the audit contract: nothing supplies one for them). Catalog editors with
-- MFA, while the submission's game exists and isn't merged, rejected or excluded.
--
-- Confirming stores the candidate's stored record (what the editor was shown) as the game's
-- Wikidata source, as an import would: an import run naming the submission, a promoted provider
-- record matched to the game, its title keys and the external reference. Refused when the provider
-- isn't cleared for use, when the game already has a Wikidata source, or when the item is already
-- another game's source (a duplicate, to merge instead). Nothing else changes: the game's title,
-- verification, releases, pairings and publication stay as they are.
create function public.decide_submission_enrichment(p_submission uuid, p_external_id text, p_decision text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_reason text;
  v_req public.catalog_change_requests;
  v_row private.submission_enrichments;
  v_game public.games;
  v_candidate jsonb;
  v_payload jsonb;
  v_sha text;
  v_run uuid;
  v_record private.provider_records;
  v_platform uuid;
begin
  if p_decision is null or p_decision not in ('confirm', 'reject') or coalesce(p_external_id, '') !~ '^Q[1-9][0-9]{0,11}$' then
    raise exception 'invalid decision' using errcode = '22023';
  end if;
  v_me := private.begin_catalog_edit();
  v_reason := private.require_reason(p_reason);
  select * into v_req from public.catalog_change_requests s where s.id = p_submission for update;
  if v_req.id is null or v_req.request_type <> 'new_game' or not v_req.created_game or v_req.game_id is null then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  select * into v_game from public.games g where g.id = v_req.game_id for key share;
  if v_game.id is null or v_game.status in ('merged', 'rejected', 'excluded') or v_req.status in ('withdrawn', 'rejected', 'excluded', 'merged') then
    raise exception 'no longer open' using errcode = '55000';
  end if;
  select * into v_row from private.submission_enrichments e where e.submission_id = p_submission for update;
  if v_row.submission_id is null then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  select c into v_candidate from pg_catalog.jsonb_array_elements(v_row.candidates) c where c ->> 'external_id' = p_external_id limit 1;
  if v_candidate is null then
    raise exception 'unknown candidate' using errcode = '22023';
  end if;
  if v_row.decisions ? p_external_id then
    raise exception 'already decided' using errcode = '55000';
  end if;

  if p_decision = 'reject' then
    update private.submission_enrichments e
    set decisions = e.decisions || pg_catalog.jsonb_build_object(p_external_id, pg_catalog.jsonb_build_object('decision', 'rejected', 'by', v_me, 'at', pg_catalog.now()))
    where e.submission_id = p_submission;
    perform private.record_catalog_audit(v_me, 'catalog_source_rejected', 'game', v_game.id, v_reason,
      pg_catalog.jsonb_build_object('provider', 'wikidata', 'external_id', p_external_id, 'submission_id', p_submission,
                                    'revision', v_candidate -> 'revision', 'match', v_candidate ->> 'match'));
    return pg_catalog.jsonb_build_object('decision', 'rejected', 'game_id', v_game.id, 'external_id', p_external_id);
  end if;

  if exists (select 1 from pg_catalog.jsonb_each(v_row.decisions) d where d.value ->> 'decision' = 'confirmed') then
    raise exception 'already decided' using errcode = '55000';
  end if;
  if not exists (select 1 from private.external_providers p where p.code = 'wikidata' and p.commercial_use_cleared) then
    raise exception 'source not cleared' using errcode = '55000';
  end if;
  v_payload := v_candidate -> 'payload';
  if v_payload is null or pg_catalog.jsonb_typeof(v_payload) <> 'object' or v_payload ->> 'title' is null then
    -- A lookup stored before candidates kept the importer's record: look it up again first.
    raise exception 'look up again' using errcode = '55000';
  end if;
  if exists (select 1 from private.external_references xr where xr.provider_code = 'wikidata' and xr.game_id = v_game.id)
     or exists (select 1 from private.provider_records pr where pr.provider_code = 'wikidata' and pr.entity_type = 'game' and pr.matched_game_id = v_game.id) then
    raise exception 'already has a source' using errcode = '55000';
  end if;
  if exists (select 1 from private.external_references xr where xr.provider_code = 'wikidata' and xr.entity_type = 'game' and xr.external_id = p_external_id)
     or exists (select 1 from private.provider_records pr join public.games g on g.id = pr.matched_game_id
                where pr.provider_code = 'wikidata' and pr.entity_type = 'game' and pr.external_id = p_external_id and g.status <> 'merged') then
    raise exception 'already the source of another game' using errcode = '23505';
  end if;

  v_sha := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_payload::text, 'UTF8')), 'hex');
  v_platform := coalesce(v_req.platform_id, (select gp.platform_id from public.game_platforms gp where gp.game_id = v_game.id order by gp.created_at limit 1));
  insert into private.import_runs (provider_code, platform_id, source_name, source_sha256, source_fetched_at, status, finished_at, reason, stats)
  values ('wikidata', v_platform, 'submission-lookup:' || p_submission::text || ':' || p_external_id, v_sha,
          coalesce((v_candidate ->> 'retrieved_at')::timestamptz, v_row.retrieved_at, pg_catalog.now()), 'completed', pg_catalog.now(),
          pg_catalog.left(v_reason, 500), pg_catalog.jsonb_build_object('confirmed_by_editor', 1))
  returning id into v_run;
  insert into private.provider_records (provider_code, entity_type, external_id, payload, payload_sha256, import_run_id, status, match_notes, matched_game_id)
  values ('wikidata', 'game', p_external_id, v_payload, v_sha, v_run, 'promoted',
          pg_catalog.jsonb_build_object('confirmed_from_submission', p_submission, 'match', v_candidate ->> 'match', 'matched_title', v_candidate ->> 'matched_title',
                                        'revision', v_candidate -> 'revision', 'retrieved_at', v_candidate ->> 'retrieved_at'),
          v_game.id)
  on conflict do nothing
  returning * into v_record;
  if v_record.id is null then
    raise exception 'already the source of another game' using errcode = '23505';
  end if;
  insert into private.import_run_records (import_run_id, provider_record_id, position) values (v_run, v_record.id, 0);
  perform private.import_add_title_keys(v_game.id, v_record);
  insert into private.external_references (provider_code, external_id, game_id) values ('wikidata', p_external_id, v_game.id);
  update private.submission_enrichments e
  set decisions = e.decisions || pg_catalog.jsonb_build_object(p_external_id, pg_catalog.jsonb_build_object('decision', 'confirmed', 'by', v_me, 'at', pg_catalog.now()))
  where e.submission_id = p_submission;
  perform private.record_catalog_audit(v_me, 'catalog_source_confirmed', 'game', v_game.id, v_reason,
    pg_catalog.jsonb_build_object('provider', 'wikidata', 'external_id', p_external_id, 'submission_id', p_submission,
                                  'provider_record_id', v_record.id, 'revision', v_candidate -> 'revision', 'match', v_candidate ->> 'match'));
  return pg_catalog.jsonb_build_object('decision', 'confirmed', 'game_id', v_game.id, 'external_id', p_external_id, 'provider_record_id', v_record.id);
exception
  when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then
    raise exception 'invalid decision' using errcode = '22023';
end;
$$;

revoke all on function public.claim_submission_enrichments(uuid, integer) from public, anon, authenticated, service_role;
revoke all on function public.record_submission_enrichment(uuid, uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.get_submission_enrichment(uuid) from public, anon, authenticated, service_role;
revoke all on function public.get_game_enrichment(uuid) from public, anon, authenticated, service_role;
revoke all on function public.decide_submission_enrichment(uuid, text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.claim_submission_enrichments(uuid, integer) to service_role;
grant execute on function public.record_submission_enrichment(uuid, uuid, jsonb) to service_role;
grant execute on function public.get_submission_enrichment(uuid) to authenticated;
grant execute on function public.get_game_enrichment(uuid) to authenticated;
grant execute on function public.decide_submission_enrichment(uuid, text, text, text) to authenticated;

-- Lookups recorded before candidates were graded and kept the importer's record, for submissions
-- still waiting: look them up again. The earlier answer stays until the new one is recorded.
update private.submission_enrichments e
set status = 'pending', attempts = 0, claim_id = null, claimed_at = null
where e.status in ('single_match', 'ambiguous', 'no_match')
  and exists (select 1 from public.catalog_change_requests s where s.id = e.submission_id and s.status in ('open', 'in_review', 'changes_requested'))
  and (e.status = 'no_match' or exists (select 1 from pg_catalog.jsonb_array_elements(e.candidates) c where not (c ? 'payload')));
