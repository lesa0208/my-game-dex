-- M10c review fixes (forward only).
--
-- 1. A relation raises both games' revisions, so changing one that involves a
--    published game changes that game's record. It now needs a recent TOTP
--    verification when either game is published, not only when both are (D3).
-- 2. An excluded or merged game's aliases can no longer be removed. Every other
--    editor function already refused them. Restoring an exclusion brings its records
--    back as they were excluded, without a new verification, so nothing may change
--    them while they're excluded (D-7).
--
-- Both functions keep their signatures and grants.

create or replace function public.set_game_relation(
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
  -- Locked for update, as the relation raises both games' revisions.
  perform 1 from public.games g where g.id in (p_source, p_target) order by g.id for update;
  -- D3: a relation changes both games' records; when either is published, it needs a
  -- recent TOTP verification. Read again under the locks.
  if exists (select 1 from public.games g where g.id in (p_source, p_target) and g.status = 'published') then
    perform private.require_recent_mfa();
  end if;
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

create or replace function public.remove_game_alias(p_alias uuid, p_reason text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_reason text;
  v_alias public.game_aliases;
  v_status public.catalog_status;
begin
  v_me := private.begin_catalog_edit();
  v_reason := private.require_reason(p_reason);
  select a.* into v_alias from public.game_aliases a where a.id = p_alias;
  if not found then
    return false;
  end if;
  -- Locked for update, as removing the alias raises the game's revision.
  select g.status into v_status from public.games g where g.id = v_alias.game_id for update;
  -- An excluded or merged game stays as it was, as with adding an alias (D-7).
  if v_status in ('merged', 'excluded') then
    raise exception 'record unavailable' using errcode = 'P0001';
  end if;
  -- D3: a published game's aliases are public; changing them needs a recent TOTP verification.
  if v_status = 'published' then
    perform private.require_recent_mfa();
  end if;
  delete from public.game_aliases a where a.id = p_alias returning a.* into v_alias;
  if not found then
    return false;
  end if;
  perform private.record_catalog_audit(v_me, 'catalog_alias_removed', 'game', v_alias.game_id, v_reason,
    pg_catalog.jsonb_build_object('alias_id', v_alias.id, 'title', v_alias.title, 'kind', v_alias.kind,
      'language_code', v_alias.language_code, 'region_code', v_alias.region_code));
  return true;
end;
$$;
