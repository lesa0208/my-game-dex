-- M12b Fast add: the signed-in owner's copies of several games at once, for "Owned"
-- on search results.
--
-- Design: docs/architecture/database-schema.md#collection-system (M12b)
-- - One call per results page, never one per result: up to 50 games, the most a page
--   shows (20) with room to spare. More is refused rather than silently cut short.
-- - The same rule as get_my_game_ownership (M12a): a copy counts when it isn't
--   invalid, whatever its catalog standing (confirmed, pending, not approved or
--   unidentified). Preserved copies don't count.
-- - Only the caller's own copies, through a live session. Signed out, or with an ended
--   session, the answer is empty, as get_my_game_ownership answers "not owned". A
--   definer, as get_my_game_ownership is, so that both read the same copies; it reads
--   nothing but the caller's own rows and the releases they name. Bounded by the page: the
--   games' releases, then the owner's copies of each, and their claims on those games.
-- - Nothing else changes: no table, grant or policy.

create function public.get_my_owned_games(p_games uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
begin
  if p_games is null or pg_catalog.cardinality(p_games) > 50 then
    raise exception 'too many games' using errcode = '22023';
  end if;
  if v_me is null or not (select private.session_is_live()) then
    return '{}'::jsonb;
  end if;
  -- Copies of the games' releases (releases by game, then the owner's copies of each),
  -- and the owner's claims on the games: each half reads only what the page asks about.
  return coalesce((
    select pg_catalog.jsonb_object_agg(x.game_id, x.copies)
    from (
      select y.game_id, count(*) as copies
      from (
        select r.game_id
        from public.releases r
        join public.collection_items c on c.release_id = r.id
        where r.game_id = any (p_games)
          and c.owner_id = v_me
          -- As get_my_game_ownership: a preserved copy, or one on a release in no state
          -- a copy can be counted in, is invalid and doesn't count.
          and c.record_status <> 'invalid_preserved'
          and r.status in ('published', 'rejected', 'unverified', 'under_review')
        union all
        select c.claimed_game_id
        from public.collection_items c
        where c.owner_id = v_me
          and c.release_id is null
          and c.claimed_game_id = any (p_games)
          and c.record_status <> 'invalid_preserved'
      ) y
      group by y.game_id
    ) x
  ), '{}'::jsonb);
end;
$$;

revoke all on function public.get_my_owned_games(uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.get_my_owned_games(uuid[]) to authenticated;
