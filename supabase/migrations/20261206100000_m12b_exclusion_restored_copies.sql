-- M12b review: an exclusion's details tell restored copies from moved ones.
--
-- Design: docs/architecture/database-schema.md#catalog-exclusions (M12b)
-- - restore_exclusion makes the copies it restores active again without moving them, so
--   "active again where it is" no longer told a restored copy from one its owner changed
--   (a claim whose region or edition the owner edited stays on the same game): restored
--   copies were reported as moved.
-- - Each exclusion copy now records when the administrator restored it. restore_exclusion
--   sets it for exactly the copies it restores; nothing else changes (copies_restored,
--   notifications, audit, owners' copies).
-- - get_exclusion's copies are then four disjoint counts of copies_preserved:
--   still_preserved, moved (the owner changed it, never restored), restored (by the
--   administrator; it stays restored if its owner changes it afterwards) and removed
--   (deleted since; its record goes with it, as before).
-- - Exclusions restored before this: a copy still on the excluded release and active
--   can only have come back by the restoration, so it's marked restored. A claim can't be
--   told apart from one its owner edited in place, so it stays counted as moved.

alter table private.catalog_exclusion_copies add column restored_at timestamptz;

update private.catalog_exclusion_copies ec set restored_at = ex.restored_at
from private.catalog_exclusions ex, public.collection_items c
where ex.id = ec.exclusion_id and ex.restored_at is not null
  and c.id = ec.item_id and ec.claimed_game_id is null
  and c.release_id = ex.release_id and c.record_status = 'active';

CREATE OR REPLACE FUNCTION public.restore_exclusion(p_exclusion uuid, p_expected_version integer, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_me uuid;
  v_reason text;
  ex private.catalog_exclusions;
  v_locked uuid[];
  rel public.releases;
  v_blocker text;
  v_items uuid[];
  v_owners uuid[];
  v_prev jsonb;
  v_owner uuid;
  v_count integer;
  v_submitter uuid;
begin
  perform private.lock_catalog_edits();
  v_me := private.require_active_staff('admin');
  perform 1 from public.profiles p where p.id = v_me for key share;
  v_reason := private.require_reason(p_reason);
  if p_expected_version is null then
    raise exception 'invalid restoration' using errcode = '22023';
  end if;
  select * into ex from private.catalog_exclusions e where e.id = p_exclusion;
  if not found then
    raise exception 'exclusion unavailable' using errcode = 'P0001';
  end if;

  -- 1. Profiles first.
  v_locked := private.exclusion_profiles(v_me, ex.release_id, ex.id);
  perform 1 from public.profiles p where p.id = any (v_locked) order by p.id for key share;

  -- 2. The exclusion record, then the catalog rows.
  select * into ex from private.catalog_exclusions e where e.id = p_exclusion for update;
  if ex.version <> p_expected_version then
    raise exception 'request conflict' using errcode = 'P0001';
  end if;
  if ex.excluded_by = v_me then
    raise exception 'own exclusion' using errcode = 'P0001';
  end if;
  if private.exclusion_involves(v_me, ex.release_id, ex.cascade) then
    raise exception 'own submission' using errcode = 'P0001';
  end if;
  -- M10c (D-4): never a release, or a game it brings back, that the caller created.
  if private.created_by(v_me, array[ex.release_id], private.cascade_games(ex.cascade)) then
    raise exception 'own record' using errcode = 'P0001';
  end if;
  -- M10c (D-5): bringing anything back as published needs a recent TOTP verification.
  if ex.previous_status = 'published'
     or exists (select 1 from pg_catalog.jsonb_array_elements(ex.cascade) e where e ->> 'previous_status' = 'published') then
    perform private.require_recent_mfa();
  end if;
  rel := private.lock_exclusion_records(ex.release_id);
  v_blocker := private.restore_blocker(ex);
  if v_blocker is not null then
    raise exception '%', v_blocker using errcode = 'P0001';
  end if;

  -- 3. Anyone not locked before, without waiting.
  perform private.lock_new_profiles(v_locked, private.exclusion_profiles(v_me, ex.release_id, ex.id));

  -- 4. Only this exclusion's copies, still on the release and still preserved by it.
  select coalesce(pg_catalog.array_agg(x.id order by x.id), '{}'), coalesce(pg_catalog.array_agg(x.owner_id order by x.id), '{}')
  into v_items, v_owners
  from (
    select c.id, c.owner_id
    from public.collection_items c
    join private.catalog_exclusion_copies ec on ec.item_id = c.id and ec.exclusion_id = ex.id
    -- M12a: a claim it preserved, still that claim; a copy the owner has changed since is active, and left alone.
    where (case when ec.claimed_game_id is null then c.release_id = ex.release_id
                 else c.release_id is null and c.claimed_game_id = ec.claimed_game_id end)
      and c.record_status = 'invalid_preserved' and c.invalidated_at = ex.excluded_at
    order by c.id
    for update of c
  ) x;

  -- 5. Records first, the request last: the M7b-1 guard refuses changes to a record
  --    whose submission is active.
  update public.releases r set status = ex.previous_status where r.id = ex.release_id;
  update public.games g set status = (e ->> 'previous_status')::public.catalog_status
  from pg_catalog.jsonb_array_elements(ex.cascade) e
  where e ->> 'entity' = 'game' and g.id = (e ->> 'id')::uuid;
  update public.game_platforms gp set status = (e ->> 'previous_status')::public.catalog_status
  from pg_catalog.jsonb_array_elements(ex.cascade) e
  where e ->> 'entity' = 'pairing' and gp.game_id = (e ->> 'game_id')::uuid and gp.platform_id = (e ->> 'platform_id')::uuid;
  if ex.request_id is not null then
    v_prev := ex.previous_request;
    update public.catalog_change_requests s set
      status = (v_prev ->> 'status')::public.catalog_review_status,
      -- A reviewer whose account is gone stays gone.
      reviewed_by = (select p.id from public.profiles p where p.id = (v_prev ->> 'reviewed_by')::uuid),
      reviewed_at = (v_prev ->> 'reviewed_at')::timestamptz,
      reviewer_note = v_prev ->> 'reviewer_note'
    where s.id = ex.request_id
    returning s.submitted_by into v_submitter;
  end if;
  update public.collection_items c set record_status = 'active', invalidated_at = null
  where c.id = any (v_items);
  -- M12b: which copies the administrator restored, told apart from those their owners changed.
  update private.catalog_exclusion_copies ec set restored_at = pg_catalog.now()
  where ec.exclusion_id = ex.id and ec.item_id = any (v_items);
  update private.catalog_exclusions e set
    restored_at = pg_catalog.now(), restored_by = v_me, restore_reason = v_reason,
    copies_restored = pg_catalog.cardinality(v_items), version = e.version + 1
  where e.id = ex.id;

  -- 6. Each person whose copies came back, once, and the submitter.
  for v_owner, v_count in
    select x.o, count(x.i)::integer
    from (select o, i from rows from (pg_catalog.unnest(v_owners), pg_catalog.unnest(v_items)) as y(o, i)
          union all select v_submitter, null where v_submitter is not null) x
    group by x.o order by x.o
  loop
    perform private.notify(v_owner, null, 'catalog_exclusion', null,
      pg_catalog.jsonb_build_object('status', 'restored', 'exclusion_id', ex.id, 'copies', v_count));
  end loop;

  perform private.record_catalog_audit(v_me, 'catalog_exclusion_restored', 'release', ex.release_id, v_reason,
    pg_catalog.jsonb_build_object('exclusion_id', ex.id, 'restored_status', ex.previous_status, 'copies', pg_catalog.cardinality(v_items)));
  return pg_catalog.jsonb_build_object('copies', pg_catalog.cardinality(v_items));
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_exclusion(p_exclusion uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_me uuid;
  ex private.catalog_exclusions;
  v_blocker text;
begin
  v_me := private.require_active_staff('admin');
  select * into ex from private.catalog_exclusions e where e.id = p_exclusion;
  if not found then
    return null;
  end if;
  v_blocker := private.restore_blocker(ex);
  return pg_catalog.jsonb_build_object(
    'id', ex.id, 'version', ex.version,
    'excluded_at', ex.excluded_at, 'reason_code', ex.reason_code, 'staff_reason', ex.staff_reason, 'owner_note', ex.owner_note,
    'previous_status', ex.previous_status, 'request_id', ex.request_id,
    'release', private.release_label(ex.release_id),
    'cascade', private.describe_plan(pg_catalog.jsonb_build_object('release_id', ex.release_id, 'cascade', ex.cascade, 'blocking', '[]'::jsonb)) -> 'cascade',
    'copies_preserved', ex.copies_preserved, 'owners_affected', ex.owners_affected,
    'copies', pg_catalog.jsonb_build_object(
      'still_preserved', (select count(*) from private.catalog_exclusion_copies ec join public.collection_items c on c.id = ec.item_id
                          where ec.exclusion_id = ex.id and (case when ec.claimed_game_id is null then c.release_id = ex.release_id
                 else c.release_id is null and c.claimed_game_id = ec.claimed_game_id end)
                            and c.record_status = 'invalid_preserved' and c.invalidated_at = ex.excluded_at
                            and ec.restored_at is null),
      -- M12b: moved by its owner, never a copy the administrator restored.
      'moved', (select count(*) from private.catalog_exclusion_copies ec join public.collection_items c on c.id = ec.item_id
                where ec.exclusion_id = ex.id and ec.restored_at is null
                  and (not (case when ec.claimed_game_id is null then c.release_id = ex.release_id
                 else c.release_id is null and c.claimed_game_id = ec.claimed_game_id end)
                   or c.record_status <> 'invalid_preserved')),
      'restored', (select count(*) from private.catalog_exclusion_copies ec where ec.exclusion_id = ex.id and ec.restored_at is not null),
      'removed', ex.copies_preserved - (select count(*) from private.catalog_exclusion_copies ec where ec.exclusion_id = ex.id)),
    'restored_at', ex.restored_at, 'restore_reason', ex.restore_reason, 'copies_restored', ex.copies_restored,
    'own_exclusion', ex.excluded_by = v_me,
    'own_submission', private.exclusion_involves(v_me, ex.release_id, ex.cascade),
    'blocker', v_blocker);
end;
$function$;

