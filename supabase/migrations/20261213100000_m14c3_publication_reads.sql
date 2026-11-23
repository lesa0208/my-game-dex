-- M14c-3: what a batch approval would do, and which confirmed identities await publication.
--
-- Approval (approve_review_batch, M14c-1's version) and identity publication
-- (publish_game_identity, M14a's) are unchanged and stay the only writers. The admin panel adds
-- their forms, and needs two reads the existing ones can't give, for catalog editors and
-- administrators with a verified session (require_active_staff('catalog_editor')):
--
-- 1. public.get_batch_approval_preview: for an open batch, what approving it now would do to
--    each member, in approve_review_batch's own terms: verify its identity only (an unsampled
--    member: its pairing stays unconfirmed and unpublished), confirm its physical existence and
--    publish it (a member found correct, when the final approver isn't its reviewer), confirm
--    it and leave it for another editor to publish (the final approver reviewed it), or nothing
--    (found incorrect or excluded). Whether this approval would be the final one, so whether
--    anything is verified or published at all, and the sources whose right to publish it rests on.
-- 2. public.list_publication_queue: pairings with a recorded physical-evidence basis, and
--    pairings of verified games that still lack one, one page at a time, by state: ready for
--    independent publication, awaiting physical evidence, evidence outdated, verifier gone,
--    published, or blocked by the record's status. Ready, as publish_game_identity decides it
--    (the same conditions as get_game_pairing_evidence's), and whether the caller may publish it.
--
-- 3. public.approve_review_batch_as_seen and public.publish_game_identity_as_seen (found by the
--    M14c-3 review): the unchanged writers, called only if what the editor saw still holds
--    (the approvals recorded; each pairing's evidence time), checked under the same locks.
--
-- 1 and 2 are read-only and predictions: approval and publication recheck everything when they run
-- (recent MFA, revisions, staleness, evidence, rights, independence, locks), and decide.
-- People by handle only; no email address or account id.
-- Rollback: supabase/rollbacks/20261213100000_m14c3_publication_reads.rollback.sql.

-- The queue reads pairings with a basis; there are few, and this keeps finding them cheap.
create index game_platforms_physical_basis_idx on public.game_platforms (verified_at, game_id, platform_id) where verification_basis is not null;
-- And verified games, for the queue's other branch (verified identities still without evidence).
create index games_identity_verified_idx on public.games (verified_at, id) where verified_at is not null;

-- Why publish_game_identity would refuse a pairing now, in its order (null when it wouldn't);
-- get_game_pairing_evidence's publication.reason. Not the caller's own rules (see below).
create function private.identity_publication_block(p_game public.games, p_pairing public.game_platforms)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when p_pairing.status = 'published' then 'published'
    when p_game.status not in ('unverified', 'under_review', 'published') then 'game_unavailable'
    when p_pairing.status not in ('unverified', 'under_review') then 'pairing_unavailable'
    when p_game.status <> 'published'
         and not (p_game.verified_at is not null and private.verification_current('game', p_game.id, p_game.revision, p_game.verified_at)) then 'game_not_verified'
    when p_pairing.verified_at is null or p_pairing.verification_basis is null then 'physical_evidence_unconfirmed'
    when p_pairing.verified_by is null then 'verifier_gone'
    when p_pairing.verified_game_revision is distinct from p_game.revision then 'evidence_outdated'
  end
$$;

-- Why the caller couldn't publish a pairing the record allows (null when they could):
-- publish_game_identity's own-record rules.
create function private.identity_publication_own(p_me uuid, p_game uuid, p_platform uuid, p_verified_by uuid)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when p_verified_by = p_me then 'you_confirmed'
    when private.created_by(p_me, null, array[p_game]) or private.pairing_created_by(p_me, p_game, p_platform) then 'you_created'
  end
$$;
revoke all on function private.identity_publication_block(public.games, public.game_platforms), private.identity_publication_own(uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role;

-- 1. What approving a batch now would do.
--
-- effect, per member (as approve_review_batch's final approval treats it):
--   publish            found correct; confirmed, and published, if the final approver isn't its reviewer
--   await_publication  found correct and reviewed by the caller (who would be the final approver):
--                      confirmed, then published by another editor
--   reviewer_gone      found correct by an account since deleted: confirmed with no verifier, which
--                      publish_game_identity refuses until an editor confirms it again
--   confirm            found correct, when this approval isn't the final one: confirmed at the final
--                      approval, and published then unless that approver reviewed it
--   identity_only      not flagged and not sampled: its identity is verified; its pairing stays
--                      unconfirmed and unpublished until an editor confirms it with evidence
--   not_accepted       found incorrect or excluded (or, never in practice, without a source
--                      record, which approval skips): nothing changes
--   pending            needs an outcome first: the approval is refused
-- final: whether the caller's approval would be the last one required (only then is anything
-- verified or published). Members are listed by effect, then by their source record's title, at
-- most p_limit (1 to 200) of each; the counts cover them all.
create function public.get_batch_approval_preview(p_batch uuid, p_limit integer default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  b private.catalog_review_batches;
  v_limit integer := coalesce(p_limit, 50);
  v_approvals integer;
  v_final boolean;
begin
  v_me := private.require_active_staff('catalog_editor');
  if v_limit not between 1 and 200 then
    raise exception 'invalid changes' using errcode = '22023';
  end if;
  select * into b from private.catalog_review_batches x where x.id = p_batch;
  if not found then
    return null;
  end if;
  select count(*) into v_approvals from private.catalog_review_batch_approvals a where a.batch_id = b.id;
  v_final := v_approvals + 1 >= b.required_approvals;

  return (
    with m as (
      select i.game_id, g.title, coalesce(pr.payload ->> 'title', '') as sort_title,
             case
               when (i.sampled or pg_catalog.cardinality(i.flags) > 0) and i.outcome is null then 'pending'
               when i.outcome in ('incorrect', 'excluded') then 'not_accepted'
               -- Approval's loop joins the source record: a member without one is never touched.
               when pr.id is null then 'not_accepted'
               when i.outcome = 'correct' and not v_final then 'confirm'
               -- Its reviewer's account is gone: confirmed with no verifier, which publication
               -- refuses until someone confirms it again.
               when i.outcome = 'correct' and i.reviewed_by is null then 'reviewer_gone'
               when i.outcome = 'correct' and i.reviewed_by = v_me then 'await_publication'
               when i.outcome = 'correct' then 'publish'
               else 'identity_only' end as effect,
             private.review_person(i.reviewed_by, v_me) as reviewer,
             i.outcome = 'correct' and not private.evidence_note_ok(i.note) as evidence_missing
      from private.catalog_review_batch_items i
      join public.games g on g.id = i.game_id
      left join private.provider_records pr on pr.id = i.provider_record_id
      where i.batch_id = b.id),
    ranked as (select m.*, row_number() over (partition by m.effect order by m.sort_title, m.game_id) as n from m)
    select pg_catalog.jsonb_build_object(
      'batch', pg_catalog.jsonb_build_object('id', b.id, 'status', b.status, 'content_sha256', b.content_sha256, 'items', b.item_count),
      'approvals', pg_catalog.jsonb_build_object('recorded', v_approvals, 'required', b.required_approvals),
      'final', b.status = 'open' and v_final,
      'counts', (select pg_catalog.jsonb_object_agg(e, (select count(*) from m where m.effect = e))
                 from pg_catalog.unnest(array['publish', 'await_publication', 'reviewer_gone', 'confirm', 'identity_only', 'not_accepted', 'pending']) e),
      'evidence_missing', (select count(*) from m where m.evidence_missing),
      'members', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                     'game', pg_catalog.jsonb_build_object('id', r.game_id, 'title', r.title), 'effect', r.effect, 'reviewer', r.reviewer,
                     'evidence_missing', r.evidence_missing)
                   order by pg_catalog.array_position(array['publish', 'await_publication', 'reviewer_gone', 'confirm', 'identity_only', 'not_accepted', 'pending'], r.effect), r.sort_title, r.game_id), '[]'::jsonb)
                  from ranked r where r.n <= v_limit),
      -- The sources approval would publish from, and whether each may be published now (as
      -- require_publication_rights decides, without its lock).
      'sources', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                     'provider', s.provider_code, 'provider_name', (select ep.name from private.external_providers ep where ep.code = s.provider_code),
                     'cleared', s.terms_sha256 is not null and exists (
                       select 1 from private.external_providers p where p.code = s.provider_code
                         and ((p.commercial_use_cleared and p.terms_sha256 = s.terms_sha256) or (p.rights_survive_withdrawal and p.rights_terms_sha256 = s.terms_sha256))))
                   order by s.provider_code, s.terms_sha256), '[]'::jsonb)
                  from (select distinct pr.provider_code, src.terms_sha256
                        from private.catalog_review_batch_items i
                        join private.provider_records pr on pr.id = i.provider_record_id
                        join private.import_runs src on src.id = pr.import_run_id
                        where i.batch_id = b.id and (i.outcome = 'correct' or (i.outcome is null and pg_catalog.cardinality(i.flags) = 0 and not i.sampled))) s)));
end;
$$;

-- 2. The publication queue. p_state: ready, awaiting_evidence, evidence_outdated, verifier_gone,
-- published, blocked, or null (all). p_platform: a platform slug or null. Ordered by when the
-- evidence was recorded (the game's verification, for a pairing still without evidence), oldest
-- first, then game and platform id; the cursor is the last row's (at, game, platform), given
-- all three or none. p_limit: 1 to 100.
create function public.list_publication_queue(p_state text default 'ready', p_platform text default null,
  p_after_at timestamptz default null, p_after_game uuid default null, p_after_platform uuid default null, p_limit integer default 25)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_platform uuid;
  v_limit integer := coalesce(p_limit, 25);
  v_items jsonb;
  v_more boolean;
  v_counts jsonb;
begin
  v_me := private.require_active_staff('catalog_editor');
  if (p_state is not null and p_state not in ('ready', 'awaiting_evidence', 'evidence_outdated', 'verifier_gone', 'published', 'blocked'))
     or v_limit not between 1 and 100
     or pg_catalog.num_nulls(p_after_at, p_after_game, p_after_platform) not in (0, 3) then
    raise exception 'invalid changes' using errcode = '22023';
  end if;
  if p_platform is not null then
    select p.id into v_platform from public.platforms p where p.slug = p_platform;
    if v_platform is null then
      return pg_catalog.jsonb_build_object('status', 'unknown_platform', 'items', '[]'::jsonb, 'next_after', null, 'counts', '{}'::jsonb);
    end if;
  end if;

  -- One read of the candidates, for both the counts and the page: two branches, each found
  -- through its own index. Pairings that left review (excluded, rejected) are not in the queue.
  with c as (
    select gp.game_id, gp.platform_id
    from public.game_platforms gp
    where gp.verification_basis is not null and gp.status in ('unverified', 'under_review', 'published')
      and (v_platform is null or gp.platform_id = v_platform)
    union all
    -- A verified game whose pairing is still in review without evidence (as an unsampled batch
    -- member is left): awaiting physical evidence.
    select gp.game_id, gp.platform_id
    from public.games g
    join public.game_platforms gp on gp.game_id = g.id
    where g.verified_at is not null and g.status in ('unverified', 'under_review', 'published')
      and gp.status in ('unverified', 'under_review') and gp.verified_at is null and gp.verification_basis is null
      and (v_platform is null or gp.platform_id = v_platform)),
  q as (
    select gp.game_id, gp.platform_id, coalesce(gp.verified_at, g.verified_at) as at,
           case
             when gp.status = 'published' then 'published'
             when r.reason is null then 'ready'
             when r.reason = 'physical_evidence_unconfirmed' then 'awaiting_evidence'
             when r.reason in ('evidence_outdated', 'verifier_gone') then r.reason
             else 'blocked' end as state,
           r.reason
    from c
    join public.game_platforms gp on gp.game_id = c.game_id and gp.platform_id = c.platform_id
    join public.games g on g.id = gp.game_id
    cross join lateral (select private.identity_publication_block(g, gp) as reason) r),
  page as (
    select q.*, row_number() over (order by q.at, q.game_id, q.platform_id) as n from (
      select q.* from q
      where (p_state is null or q.state = p_state)
        and (p_after_at is null or (q.at, q.game_id, q.platform_id) > (p_after_at, p_after_game, p_after_platform))
      order by q.at, q.game_id, q.platform_id
      limit v_limit + 1) q)
  select (select pg_catalog.jsonb_object_agg(st, (select count(*) from q where q.state = st))
          from pg_catalog.unnest(array['ready', 'awaiting_evidence', 'evidence_outdated', 'verifier_gone', 'published', 'blocked']) st),
         pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'game', pg_catalog.jsonb_build_object('id', g.id, 'title', g.title, 'status', g.status, 'revision', g.revision, 'slug', g.slug),
           'platform', pg_catalog.jsonb_build_object('id', p.id, 'slug', p.slug, 'name', p.name, 'short_name', p.short_name),
           'pairing_status', gp.status,
           'state', pq.state,
           'reason', pq.reason,
           'at', pq.at,
           'physical', case when gp.verification_basis is null or gp.verified_at is null then null else pg_catalog.jsonb_build_object(
             'source', gp.verification_basis ->> 'source', 'reference', gp.verification_basis ->> 'reference',
             'note', gp.verification_basis ->> 'note', 'batch_id', gp.verification_basis ->> 'batch_id',
             'verified_at', gp.verified_at, 'current', gp.verified_game_revision is not distinct from g.revision,
             'verifier', private.review_person(gp.verified_by, v_me)) end,
           'releases', (select pg_catalog.jsonb_build_object('total', count(*), 'published', count(*) filter (where r.status = 'published' and r.verified_at is not null))
                        from public.releases r where r.game_id = gp.game_id and r.platform_id = gp.platform_id),
           'you', case when pq.state = 'ready' then private.identity_publication_own(v_me, gp.game_id, gp.platform_id, gp.verified_by) end)
           order by pq.at, pq.game_id, pq.platform_id) filter (where pq.n <= v_limit),
         count(pq.*) > v_limit
  into v_counts, v_items, v_more
  from page pq
  join public.games g on g.id = pq.game_id
  join public.game_platforms gp on gp.game_id = pq.game_id and gp.platform_id = pq.platform_id
  join public.platforms p on p.id = pq.platform_id;

  return pg_catalog.jsonb_build_object(
    'status', 'ok',
    'counts', v_counts,
    'items', coalesce(v_items, '[]'::jsonb),
    'next_after', case when v_more then pg_catalog.jsonb_build_object('at', v_items -> (v_limit - 1) -> 'at',
                                          'game', v_items -> (v_limit - 1) -> 'game' -> 'id', 'platform', v_items -> (v_limit - 1) -> 'platform' -> 'id') end);
end;
$$;

revoke all on function public.get_batch_approval_preview(uuid, integer), public.list_publication_queue(text, text, timestamptz, uuid, uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.get_batch_approval_preview(uuid, integer), public.list_publication_queue(text, text, timestamptz, uuid, uuid, integer)
  to authenticated;

-- 3. Deciding and publishing what the editor saw (found by the M14c-3 review).
--
-- approve_review_batch and publish_game_identity are unchanged. These two call them unchanged,
-- in the same transaction, after one more check made under the same row locks they take, so no
-- other transaction can change it in between:
--
-- * approve_review_batch_as_seen refuses ("batch changed") unless the batch has exactly the
--   approvals the editor saw. Without it, two editors who each saw "1 approval of 2 needed"
--   both submit "record my approval", and the second becomes the final approval, which verifies
--   and publishes, though that editor was told the batch would stay open.
-- * publish_game_identity_as_seen refuses ("record changed") unless each chosen pairing is still
--   verified exactly when the editor saw it verified. publish_game_identity checks the game's
--   revision, but confirming a pairing again (verify_game_platform) replaces its evidence
--   without changing the game's revision: the editor would publish evidence they never read.
--
-- Locks are taken in the writers' own order (the catalog edit lock, then the batch or the game,
-- then its pairings), so neither can deadlock against them.
create function public.approve_review_batch_as_seen(p_batch uuid, p_reason text, p_expected_approvals integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.begin_catalog_edit();
  if p_expected_approvals is null or p_expected_approvals < 0 then
    raise exception 'invalid changes' using errcode = '22023';
  end if;
  perform 1 from private.catalog_review_batches b where b.id = p_batch for update;
  if not found then
    raise exception 'record unavailable' using errcode = 'P0001';
  end if;
  if (select count(*) from private.catalog_review_batch_approvals a where a.batch_id = p_batch) <> p_expected_approvals then
    raise exception 'batch changed' using errcode = 'P0001';
  end if;
  return public.approve_review_batch(p_batch, p_reason);
end;
$$;

create function public.publish_game_identity_as_seen(p_game uuid, p_platforms uuid[], p_reason text, p_expected_revision bigint,
  p_expected_verified_at timestamptz[])
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  i integer;
  v_at timestamptz;
begin
  perform private.begin_catalog_edit();
  if p_platforms is null or p_expected_verified_at is null or pg_catalog.cardinality(p_platforms) not between 1 and 20
     or pg_catalog.cardinality(p_expected_verified_at) <> pg_catalog.cardinality(p_platforms) then
    raise exception 'invalid changes' using errcode = '22023';
  end if;
  perform 1 from public.games g where g.id = p_game for update;
  if not found then
    raise exception 'record unavailable' using errcode = 'P0001';
  end if;
  for i in 1 .. pg_catalog.cardinality(p_platforms) loop
    select gp.verified_at into v_at from public.game_platforms gp where gp.game_id = p_game and gp.platform_id = p_platforms[i] for update;
    if not found then
      raise exception 'record unavailable' using errcode = 'P0001';
    end if;
    if v_at is distinct from p_expected_verified_at[i] then
      raise exception 'record changed' using errcode = 'P0001';
    end if;
  end loop;
  return public.publish_game_identity(p_game, p_platforms, p_reason, p_expected_revision);
end;
$$;

revoke all on function public.approve_review_batch_as_seen(uuid, text, integer), public.publish_game_identity_as_seen(uuid, uuid[], text, bigint, timestamptz[])
  from public, anon, authenticated, service_role;
grant execute on function public.approve_review_batch_as_seen(uuid, text, integer), public.publish_game_identity_as_seen(uuid, uuid[], text, bigint, timestamptz[])
  to authenticated;
